# Database Design — `order_service`

Postgres 15+, sharded per region. PostGIS enabled (for delivery agent presence + geospatial assignment).

This document specifies every table this service owns, its columns, FKs (in-shard only — see §Cross-service references), indexes (each justified by a query), and the sharding plan.

The schema diverges from the rough draft in `img_2.png` per project guidance:
- **No `payouts` table.** Payouts are recorded as a row in `transactions` with `transaction_type='payout'`.
- **Money columns are `INT` minor units**, not `DECIMAL` (see CLAUDE.md §7).
- `src_acc_id` / `dst_acc_id` reference `core_service.users.id` (logical, no FK). For restaurants, use the **owner user id**. For platform-side rows (commission, refund-from-platform), `src_acc_id` is `NULL` to denote SYSTEM.
- **No `incentives` tables.**
- **No `events_outbox` table.** This service does not emit outbound async events in this milestone (no analytics consumer; no other consumer needs it). Async with core-service is inbound-only — see `docs/system-design.md` §5.
- **No `customer_order_index` table.** With country-level shards (one DB per country), customers ordering across regions are rare; if/when needed, the cross-region history view will be implemented as a fan-out at the controller level. Removed to keep the milestone surface area small.
- New tables added: `idempotency_keys`, `payment_sessions`, `payment_webhook_events`, `restaurant_balances`, `agent_earnings`. **No `deliveries` table** — delivery state lives on the `orders` row (`delivery_agent_id`, status ∈ `{assigned, picked, delivered, cancelled}`, the `assigned_at / picked_at / delivered_at / cancelled_at` stamps). **No `agent_presence` table** — presence is Redis-only (see §8) since it has a 5-minute relevance window and no audit value. **No `core_inbound_events`** — inbound-event dedupe lives in Redis (`core-events:dedupe:<eventId>`, SETNX, 24h TTL), not SQL.

---

## 0. Conventions

- Every table has `id BIGSERIAL PRIMARY KEY` unless noted.
- Every sharded table has `region TEXT NOT NULL` immediately after `id`.
- `created_at`, `updated_at` are `TIMESTAMP NOT NULL DEFAULT NOW()` for hot rows. Status-transition timestamps (`accepted_at`, `picked_at`, etc.) are `TIMESTAMP NULL` until the transition happens.
- Money columns are `INT NOT NULL` storing minor units. A `currency` column lives next to them or on the parent (`orders.currency`).
- Enum-like columns are `TEXT NOT NULL CHECK(col IN ('a','b'))` (matches core-service convention). Native PG `ENUM` is reserved for `currency_enum` which already exists in core.
- Index naming: `idx_<table>_<col>[_<col>]`. Constraint naming: `fk_<table>_<col>`, `uq_<table>_<col>`.
- Every FK has a supporting btree index (Postgres does not auto-index FK columns).

---

## 1. Cross-service references (logical, no DB FK)

| Logical reference         | Where in this service                                | Source of truth     |
| ------------------------- | ---------------------------------------------------- | ------------------- |
| `users.id`                | `orders.customer_id`, `orders.restaurant_owner_id`, `orders.delivery_agent_id`, `transactions.src_acc_id`, `transactions.dst_acc_id`, `agent_earnings.agent_id` | `core-service.users` |
| `customer_addresses.id`   | `orders.customer_address_id`                         | `core-service.customer_addresses` |
| `restaurants.id`          | `orders.restaurant_id`, `restaurant_balances.restaurant_id` | `core-service.restaurants` |
| `restaurant_branches.id`  | `orders.branch_id`                                   | `core-service.restaurant_branches` |
| `products.id`             | `order_items.product_id`                             | `core-service.products` |

These are validated **at write time** via the `core-client` (sync HTTP) when the data is not already proven (e.g. by JWT claims or a recent cache hit). For repeatedly hot lookups (branch metadata, product price/stock), we maintain a Redis read-through cache populated from `core-service`.

We snapshot critical fields at order time (`order_items.name_snapshot`, `unit_price_snapshot`, `image_url_snapshot`) so historical orders remain readable even after the source row changes or is deleted.

---

## 2. Sharding plan

### Shard key: country

The shard key is the **country code**: `eg`, `ksa`, ... — one Postgres cluster per country. The DB column is named `region` so the router stays generic if we ever sub-shard a country later, but in this milestone `region == country code`.

### Resolution

For every request, the region is resolved (in order):
1. Path/query: explicit `?region=` (admin endpoints; `region=all` permitted on fan-out reads only).
2. Header: `X-Region` (gateway-supplied or client-supplied on guest checkout).
3. Cookie: `region=<code>`.
4. For customer order placement: derived from the chosen `branchId` — branches are tied to a country in `core-service`.

Region is **not** a JWT claim (we dropped it — keeps tokens stateless per shard decision).

A `lib/sharding/router.ts` returns a `Knex` instance for the resolved region. All repository functions accept the connection as the last argument (already the convention in core-service for `trx`, we extend it):

```ts
export async function findOrderById(id: number, conn: Knex): Promise<OrderEntity | undefined> { ... }
```

There is no fallback "global" connection in business code. Migrations iterate over the configured regions list.

### Read replicas

Not introduced in this milestone. All reads and writes go to the primary per region. We will revisit when traffic justifies adding replicas.

### Cross-shard reads

Forbidden in the hot path. The only handled case is:
1. **System-admin global views** (e.g. all pending orders across countries) — fan-out at the controller level, sequential, with hard pagination per shard. With ~2 countries today (`eg`, `ksa`) this is cheap.

### Tables that ARE sharded

`orders`, `order_items`, `transactions`, `restaurant_balances`, `agent_earnings`, `idempotency_keys`, `payment_sessions`, `payment_webhook_events`.

### Tables that ARE NOT sharded (replicated to every shard, or live once)

`payment_providers` — small lookup, replicated. Treat as read-only seed.

### Cold archive (Phase 7)

A separate Postgres cluster per region (`order_service_archive`) holds rows older than the current year. Same schema as the hot DB. The archival worker copies and deletes — see `docs/implementation-plan.md` Phase 7.

---

## 3. Tables

### 3.1 `orders`

Primary write target of this service. Holds the order header.

```sql
CREATE TABLE orders (
    id              BIGSERIAL PRIMARY KEY,
    region          TEXT NOT NULL,                                -- shard key
    public_id       UUID NOT NULL UNIQUE,                         -- client-facing id
    country_code    TEXT NOT NULL,
    restaurant_id   BIGINT NOT NULL,                              -- logical FK -> core.restaurants.id
    branch_id       BIGINT NOT NULL,                              -- logical FK -> core.restaurant_branches.id
    customer_id     BIGINT NOT NULL,                              -- logical FK -> core.users.id
    customer_address_id BIGINT NOT NULL,                          -- logical FK -> core.customer_addresses.id
    -- delivery snapshot (so the address survives after the customer edits/deletes it)
    delivery_lat    DECIMAL(10,7) NOT NULL,
    delivery_lng    DECIMAL(10,7) NOT NULL,
    delivery_address_text_snapshot TEXT NOT NULL,
    -- status machine
    status          TEXT NOT NULL CHECK (status IN (
                        'pending_payment','placed','accepted','rejected',
                        'preparing','ready','assigned','picked','delivered','cancelled'
                    )),
    -- money (minor units)
    subtotal        INT NOT NULL,
    delivery_fee    INT NOT NULL,
    service_fee     INT NOT NULL,
    total           INT NOT NULL,                                 -- subtotal + delivery_fee + service_fee
    commission      INT NOT NULL DEFAULT 0,                       -- platform cut, computed at delivery
    currency        TEXT NOT NULL,                                -- 'EGP','SAR'
    payment_method  TEXT NOT NULL CHECK (payment_method IN ('online','cod')),
    -- delivery
    delivery_agent_id BIGINT,                                     -- nullable until assigned
    -- timestamps
    created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMP NOT NULL DEFAULT NOW(),
    accepted_at     TIMESTAMP NULL,
    rejected_at     TIMESTAMP NULL,
    ready_at        TIMESTAMP NULL,
    assigned_at     TIMESTAMP NULL,
    picked_at       TIMESTAMP NULL,
    delivered_at    TIMESTAMP NULL,
    cancelled_at    TIMESTAMP NULL
);

-- supports GET /orders/{publicId}                               (customer & restaurant lookup)
CREATE INDEX idx_orders_public_id ON orders (public_id);
-- supports GET /customer/orders?year=YYYY                       (customer history, current year hot)
CREATE INDEX idx_orders_customer_id_created_at ON orders (customer_id, created_at DESC);
-- supports GET /restaurant/orders?branchId=&status=&from=&to=   (most queried — restaurant ops dashboard)
CREATE INDEX idx_orders_branch_status_created_at ON orders (branch_id, status, created_at DESC);
-- supports DELIVERY assignment scan for pending assignment in a region
CREATE INDEX idx_orders_status_created_at ON orders (status, created_at) WHERE status IN ('ready','assigned');
-- supports GET /agents/tasks?status=
CREATE INDEX idx_orders_delivery_agent_id_status ON orders (delivery_agent_id, status) WHERE delivery_agent_id IS NOT NULL;
```

Notes:
- `public_id` (UUID) is what we expose. The bigint `id` stays internal.
- `total` is denormalized for read efficiency; recomputed and asserted at insert and on any line-item change.
- We store `delivery_address_text_snapshot` and lat/lng on the order so the order remains coherent if the user later deletes the saved address.

---

### 3.2 `order_items`

```sql
CREATE TABLE order_items (
    id                  BIGSERIAL PRIMARY KEY,
    region              TEXT NOT NULL,
    order_id            BIGINT NOT NULL,
    product_id          BIGINT NOT NULL,                          -- logical FK -> core.products.id
    quantity            INT NOT NULL CHECK (quantity > 0),
    unit_price_snapshot INT NOT NULL,                             -- minor units, frozen at order time
    name_snapshot       TEXT NOT NULL,
    image_url_snapshot  TEXT NULL,
    line_total          INT NOT NULL,                             -- quantity * unit_price_snapshot
    created_at          TIMESTAMP NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_order_items_order_id FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
);

-- supports GET /orders/{orderId} expansion (single batch fetch via whereIn for lists)
CREATE INDEX idx_order_items_order_id ON order_items (order_id);
-- (no product_id index — we never query items by product in this service; analytics service will)
```

---

### 3.3 `payment_providers` (lookup, NOT sharded — same data on every shard)

```sql
CREATE TABLE payment_providers (
    id          INT PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,                              -- 'kashier','cod'
    is_enabled  BOOLEAN NOT NULL DEFAULT TRUE,
    priority    SMALLINT NOT NULL DEFAULT 100
);

-- seeded:
-- (1, 'kashier', true, 10)
-- (2, 'cod',     true, 20)
```

No indexes beyond PK + the unique on `name`. Tiny lookup table.

---

### 3.4 `payment_sessions` (Kashier session lifecycle)

A Kashier "Payment Session" is created before redirecting the customer. We store the local mirror so we can correlate webhook events.

```sql
CREATE TABLE payment_sessions (
    id              BIGSERIAL PRIMARY KEY,
    region          TEXT NOT NULL,
    order_id        BIGINT NOT NULL,
    provider_id     INT NOT NULL,                                 -- FK to payment_providers (logically — providers replicated)
    provider_session_id TEXT NOT NULL,                            -- Kashier's session id
    redirect_url    TEXT NOT NULL,
    amount          INT NOT NULL,                                 -- minor units
    currency        TEXT NOT NULL,
    status          TEXT NOT NULL CHECK (status IN (
                        'initialized','pending','authorized','captured','failed','expired','cancelled'
                    )),
    raw_init_payload  JSONB NOT NULL,                             -- what we sent to Kashier
    raw_last_payload  JSONB NULL,                                 -- last update from Kashier
    created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMP NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_payment_sessions_order_id FOREIGN KEY (order_id) REFERENCES orders(id),
    CONSTRAINT uq_payment_sessions_provider_session_id UNIQUE (provider_session_id)
);

-- supports webhook lookup by Kashier session id
CREATE INDEX idx_payment_sessions_provider_session_id ON payment_sessions (provider_session_id);
-- supports order -> session lookup
CREATE INDEX idx_payment_sessions_order_id ON payment_sessions (order_id);
```

---

### 3.5 `transactions`

The money ledger. Every money movement is one row. Includes payments, refunds, commissions, and **payouts** (so we don't need a separate `payouts` table).

```sql
CREATE TABLE transactions (
    id                  BIGSERIAL PRIMARY KEY,
    region              TEXT NOT NULL,
    order_id            BIGINT NULL,                              -- nullable for payouts not tied to an order
    transaction_type    TEXT NOT NULL CHECK (transaction_type IN (
                            'charge','refund','commission','payout','cod_collection','adjustment'
                        )),
    method              TEXT NOT NULL CHECK (method IN ('online','cod','bank_transfer','system')),
    provider_id         INT NULL,                                 -- nullable for non-provider tx (e.g. commission)
    provider_reference_id TEXT NULL,                              -- Kashier txn id / bank ref
    status              TEXT NOT NULL CHECK (status IN ('pending','succeeded','failed','reversed')),
    amount              INT NOT NULL,                             -- minor units, always positive
    currency            TEXT NOT NULL,
    -- accounting (logical user ids in core)
    src_acc_id          BIGINT NULL,                              -- NULL => SYSTEM (platform)
    dst_acc_id          BIGINT NULL,                              -- NULL => SYSTEM
    -- refund linkage
    is_refunded         BOOLEAN NOT NULL DEFAULT FALSE,
    refunded_payment_id BIGINT NULL,
    -- idempotency from upstream (e.g. webhook event id)
    idempotency_key     TEXT NULL,
    created_at          TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMP NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_transactions_order_id FOREIGN KEY (order_id) REFERENCES orders(id),
    CONSTRAINT fk_transactions_refunded_payment_id FOREIGN KEY (refunded_payment_id) REFERENCES transactions(id),
    CONSTRAINT uq_transactions_idempotency_key UNIQUE (idempotency_key)
);

-- supports GET /payments/{id} (admin lookup)
-- (PK lookup via id is the public id for transactions; no extra index needed)

-- supports order detail expansion (1 round trip per order's tx ledger)
CREATE INDEX idx_transactions_order_id ON transactions (order_id);
-- supports webhook idempotency lookup by provider reference
CREATE INDEX idx_transactions_provider_reference_id ON transactions (provider_reference_id) WHERE provider_reference_id IS NOT NULL;
-- supports restaurant payout history: GET /restaurant/payouts?from=&to=
CREATE INDEX idx_transactions_dst_acc_type_created_at ON transactions (dst_acc_id, transaction_type, created_at DESC) WHERE transaction_type = 'payout';
-- supports finance reconciliation by status + type
CREATE INDEX idx_transactions_type_status_created_at ON transactions (transaction_type, status, created_at DESC);
```

Why no separate `payouts` table:
- Same columns are needed (amount, currency, src/dst, provider ref, status, timestamps).
- One ledger to query; no JOIN; payout history is a filter on `transaction_type='payout'`.
- The unique constraint on `idempotency_key` lets us safely re-record a payout from an admin retry.

---

### 3.6 `restaurant_balances`

One row per (restaurant, currency) — restaurants may operate in multiple regions/currencies, but for now (single currency per restaurant) it's effectively one row per restaurant.

```sql
CREATE TABLE restaurant_balances (
    restaurant_id   BIGINT NOT NULL,
    region          TEXT NOT NULL,
    currency        TEXT NOT NULL,
    balance         INT NOT NULL DEFAULT 0,                       -- minor units
    updated_at      TIMESTAMP NOT NULL DEFAULT NOW(),
    PRIMARY KEY (restaurant_id, currency)
);

-- balance is incremented on order delivered (subtotal - commission), decremented on payout.
-- single-row lookup by (restaurant_id, currency) is the only query — PK suffices.
```

Updates use `SELECT ... FOR UPDATE` inside the same transaction as the delivery state transition or payout insert.

---

### 3.7 ~~`deliveries`~~ — removed

Delivery state lives on the `orders` row. Per the agreed schema (`docs/img_2.png`) there is **no separate `deliveries` table** and no `DeliveryEntity`.

What `orders` already carries that a delivery row would have carried:

| Concern             | Column on `orders`              |
| ------------------- | ------------------------------- |
| Current assignee    | `delivery_agent_id`             |
| Phase of delivery   | `status` ∈ `{assigned, picked, delivered, cancelled}` |
| Assignment moment   | `assigned_at`                   |
| Pickup moment       | `picked_at`                     |
| Drop-off moment     | `delivered_at`                  |
| Drop-off coords     | `delivery_lat`, `delivery_lng`, `delivery_address_text_snapshot` |
| Pickup coords       | resolvable from cached `core:branch:<id>` (lat/lng) — not snapshotted on the order |

Reassignment **overwrites** `delivery_agent_id` — losing per-attempt history is the explicit trade-off for the simpler schema. If we ever need an audit trail we'll add an append-only `order_status_log` (or similar) instead of resurrecting `deliveries`.

`agent_earnings` (§3.9) keys on `order_id`, not a delivery id; one earning row per delivered order.

---

### 3.8 ~~`agent_presence`~~ — removed (Redis-only)

There is **no `agent_presence` table**. Presence has a 5-minute relevance window (an agent who hasn't pinged in 5 min is treated as offline) and no audit value, so persisting it to Postgres adds operational cost for no benefit. The Redis key schema is documented in §8.

The Postgres GIST fallback that older drafts mentioned is removed too: if Redis is cold the assignment worker simply finds no candidates this tick and tries again on the next tick (still ≤ a few seconds later). No PostGIS extension is required for this service.

---

### 3.9 `agent_earnings`

A per-delivered-order snapshot for reporting. Could be derived from `transactions` but a denormalized table makes the agent's earnings list cheap.

```sql
CREATE TABLE agent_earnings (
    id          BIGSERIAL PRIMARY KEY,
    region      TEXT NOT NULL,
    agent_id    BIGINT NOT NULL,                                   -- logical FK -> core.users.id (delivery_agent role)
    order_id    BIGINT NOT NULL,                                   -- one earning per delivered order
    amount      INT NOT NULL,                                      -- minor units; today = floor(order.delivery_fee × AGENT_EARNING_SHARE_BPS / 10000)
    currency    TEXT NOT NULL,                                     -- mirrors the order's currency
    earned_at   TIMESTAMP NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_agent_earnings_order_id UNIQUE (order_id)        -- idempotent settlement (one row per delivered order)
);

-- supports GET /agents/earnings?from=&to=
CREATE INDEX idx_agent_earnings_agent_earned_at ON agent_earnings (agent_id, earned_at DESC);
```

Inserted in the same transaction as `orders.status='delivered'`. The unique on `order_id` makes the settlement idempotent — re-running a `delivered` settlement (e.g., on retry) doesn't double-pay.

`order_id` is **not** a hard FK because `orders` is partitioned and Postgres won't enforce a FK pointing into a partitioned table efficiently; we rely on application-level integrity (the only writer is the settlement trx).

---

### 3.10 `idempotency_keys`

Belt-and-suspenders durability for critical write paths. Redis handles the hot path; this table is the source of truth if Redis is lost or evicts the key.

```sql
CREATE TABLE idempotency_keys (
    key_hash        BYTEA PRIMARY KEY,                            -- sha256 of (method + path + key)
    region          TEXT NOT NULL,
    user_id         BIGINT NOT NULL,
    request_fingerprint BYTEA NOT NULL,                           -- sha256 of request body
    response_status INT NOT NULL,
    response_body   JSONB NOT NULL,
    created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
    expires_at      TIMESTAMP NOT NULL                            -- 24h TTL
);

-- supports cleanup
CREATE INDEX idx_idempotency_keys_expires_at ON idempotency_keys (expires_at);
```

Used only by `POST /orders` and `POST /payments/init`. Looked up after a Redis miss; if request fingerprint doesn't match the original, return 409 (idempotency conflict).

---

### 3.11 `payment_webhook_events`

Raw webhook log for audit and replay.

```sql
CREATE TABLE payment_webhook_events (
    id              BIGSERIAL PRIMARY KEY,
    region          TEXT NOT NULL,
    provider_id     INT NOT NULL,
    provider_event_id TEXT NOT NULL,                              -- de-dup key from provider
    signature       TEXT NOT NULL,
    payload         JSONB NOT NULL,
    received_at     TIMESTAMP NOT NULL DEFAULT NOW(),
    processed_at    TIMESTAMP NULL,
    process_error   TEXT NULL,

    CONSTRAINT uq_payment_webhook_events_provider_event_id UNIQUE (provider_id, provider_event_id)
);

-- supports replay/audit by order via session lookup; no additional index needed beyond the unique.
```

Webhook handler:
1. Verify signature.
2. Try `INSERT ... ON CONFLICT DO NOTHING`. If conflict → already processed (or in flight), return 200 immediately.
3. Otherwise, in a transaction: parse payload, advance order/session/transaction state, set `processed_at`. (No outbox event — see §0 — the WebSocket fan-out is enough for clients.)

---

### 3.12 ~~`core_inbound_events`~~ — removed

Dedupe for core-event messages lives in **Redis**, not SQL. One `SET core-events:dedupe:<eventId> "1" NX EX 86400` per message.

Rationale:
- The only thing this table did for correctness was dedupe. Redis SETNX gives the same guarantee in one round-trip, no table, no migration, no per-shard insert on every broker message.
- Every registered consumer handler is an idempotent cache invalidation (`cache.del(key)`). If dedupe expires and a handler re-runs, the operation is a no-op. Safe.
- Failures still go to the DLQ — that's the observability path, not a `process_error` column.

Consumer flow (in `lib/core-events/consumer.ts`):
1. Receive message from `order-service.core-events`.
2. `cache.trySet("core-events:dedupe:<eventId>", "1", 86400)` → if not fresh, ack + skip.
3. Dispatch by `eventType` to the registered handler.
4. On success → ack. On failure → nack (no requeue) → message flows to DLQ.

---

## 4. FK / relationship map (in-shard)

```
orders ──(id)── order_items
orders ──(id)── transactions
orders ──(id)── payment_sessions
orders ──(id)── agent_earnings              (logical, no FK — orders is partitioned)
transactions ──(id)── transactions          (refunded_payment_id self-ref)
```

Logical (cross-service):

```
core.users         ← orders.customer_id, orders.restaurant_owner_id, orders.delivery_agent_id
core.users         ← transactions.src_acc_id, dst_acc_id, agent_earnings.agent_id
core.restaurants   ← orders.restaurant_id, restaurant_balances.restaurant_id
core.restaurant_branches ← orders.branch_id
core.customer_addresses  ← orders.customer_address_id
core.products      ← order_items.product_id
```

---

## 5. Index summary (every index is justified)

| Table                  | Index                                              | Supports                                            |
| ---------------------- | -------------------------------------------------- | --------------------------------------------------- |
| `orders`               | `idx_orders_public_id`                             | `GET /orders/{publicId}`                            |
| `orders`               | `idx_orders_customer_id_created_at`                | `GET /customer/orders?year=...`                     |
| `orders`               | `idx_orders_branch_status_created_at`              | `GET /restaurant/orders?branchId&status&from&to`    |
| `orders`               | `idx_orders_status_created_at` (partial)           | Auto-assignment scan for ready orders               |
| `orders`               | `idx_orders_delivery_agent_id_status` (partial)    | `GET /agents/tasks?status=`                         |
| `order_items`          | `idx_order_items_order_id`                         | Item batch fetch                                    |
| `payment_sessions`     | `idx_payment_sessions_provider_session_id`         | Webhook lookup                                      |
| `payment_sessions`     | `idx_payment_sessions_order_id`                    | Order detail                                        |
| `transactions`         | `idx_transactions_order_id`                        | Order ledger expansion                              |
| `transactions`         | `idx_transactions_provider_reference_id` (partial) | Webhook de-dup at txn level                         |
| `transactions`         | `idx_transactions_dst_acc_type_created_at` (partial) | `GET /restaurant/payouts?from&to`                |
| `transactions`         | `idx_transactions_type_status_created_at`          | Admin reconciliation                                |
| `agent_earnings`       | `idx_agent_earnings_agent_earned_at`               | `GET /agents/earnings?from&to`                      |
| `agent_earnings`       | `uq_agent_earnings_order_id`                       | Idempotent `delivered` settlement (one row per order) |
| `restaurant_balances`  | PK `(restaurant_id, currency)`                     | `GET /restaurants/:rid/balance` + `FOR UPDATE` on settlement / payout |
| `idempotency_keys`     | `idx_idempotency_keys_expires_at`                  | TTL cleanup                                         |

No speculative indexes. No `CREATE INDEX` lands without a query path comment in the migration.

---

## 6. Migration plan (file order)

Each migration creates a single coherent unit. Order matters because of FK dependencies (in-shard).

1. `20260418000020_create_orders.ts`                   — `orders` + indexes.
2. `20260418000030_create_order_items.ts`              — `order_items` + FK + index.
3. `20260506000010_create_payment_providers.ts`        — region-gated seed (`eg → kashier`; nothing on `ksa`). COD is **not** a provider — it's a `payment_method` value.
4. `20260506000040_create_payment_sessions.ts`         — `payment_sessions` + indexes.
5. `20260506000050_create_transactions.ts`             — `transactions` + indexes.
6. `20260506000110_create_payment_webhook_events.ts`   — `payment_webhook_events`.
7. `20260507000060_create_restaurant_balances.ts`      — `restaurant_balances`.
8. `20260507000090_create_agent_earnings.ts`           — `agent_earnings` + indexes.

(Core-event dedupe is Redis. Agent presence is Redis — no migration. `idempotency_keys` will land alongside the table-backed durability hook in a later phase if/when we need it; today the Redis idempotency middleware suffices.)

All migrations run in **every region**. There is no global database for this service.

The cold archive cluster (final phase) runs the same migration set against `order_service_archive` per region — same schema, different cluster.

---

## 8. Presence & assignment state (Redis-only)

There is no Postgres table for agent presence or for per-order assignment offers. Both are ephemeral and live in Redis. All keys are namespaced by region so the schema is shard-aware.

### Keys

| Key                                            | Type     | TTL       | Purpose                                                                                 | Written by                                  |
| ---------------------------------------------- | -------- | --------- | --------------------------------------------------------------------------------------- | ------------------------------------------- |
| `presence:meta:<region>:<agentId>`             | hash     | 300 s     | `lat`, `lng`, `lastSeenAt`. Existence = "online and fresh"                              | `presence.service` on online/ping           |
| `presence:geo:<region>`                        | geo set  | none      | Geospatial index of online agents (`GEOADD` on every ping)                              | `presence.service`                          |
| `presence:busy:<region>`                       | set      | none      | Set of agent ids that currently hold an active assignment                               | `assignment.service` on claim, settlement   |
| `offer:order:<orderId>`                        | string   | 30 s      | "Pending offer" marker — stores the comma-separated candidate agent ids                 | `assignment.service` on broadcast           |
| `claim:order:<orderId>`                        | string   | 5 min     | First-to-`SETNX` wins the order; loser sees the key and returns 409                     | `agent.service` on accept                   |
| `assign:attempts:<orderId>`                    | string   | 1 h       | Increments per assignment attempt; `MAX_REASSIGNMENT_ATTEMPTS` enforced from this       | `assignment.service` on each broadcast      |

### Lifecycle invariants

1. `presence:meta:*` TTL is the freshness cutoff. We don't read `lastSeenAt` ourselves — if the key is gone, the agent is considered offline. No sweeper job.
2. `presence:geo:*` is best-effort: it can hold an entry whose `presence:meta:*` has already expired. The assignment scan filters by `EXISTS presence:meta:*` to weed those out.
3. `presence:busy:<region>` membership ⇒ the agent has an `orders` row whose `delivery_agent_id = agentId` and `status ∈ {assigned, picked}`. The settlement trx (`delivered`) `SREM`s the agent.
4. Going offline removes the agent from `presence:geo` + drops `presence:meta`. Forbidden if the agent appears in `presence:busy` AND their order is `picked` (would orphan in-flight food).
5. `offer:order:*` and `claim:order:*` are independent: an offer can expire while the claim still holds (the claim is the source of truth that the agent has the order).

### Why no SQL fallback

Earlier drafts had a Postgres GIST fallback (`agent_presence` + PostGIS) for "Redis cold" scenarios. It is removed:
- A cold Redis means assignment is delayed by one worker tick (≤ 10s in steady state) — acceptable.
- The fallback added a column type (`GEOGRAPHY`), an extension dependency, and a code branch tested almost never in practice.
- If Redis durability becomes a real concern we'll switch to Redis Cluster with AOF, not back to a SQL mirror.

---

## 9. Open questions / future work

- **Multi-currency restaurants**: when a restaurant operates in multiple regions/currencies, decide whether to keep one row per (restaurant, currency) in `restaurant_balances` or one row per region.
- **Geo-fencing for delivery radius**: today we only filter by branch's `delivery_radius` (in core). If we move that to this service, add a PostGIS column on a snapshot.
- **Refunds policy**: partial refunds need `refund_amount` ≤ original charge — enforce with a check trigger, deferred for now.
- **Cross-region history**: with country-level shards, a customer ordering across countries is rare. If/when needed, fan out at the controller level instead of maintaining a `customer_order_index`.
