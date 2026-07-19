# System Design — `order-service`

This document explains the architectural decisions behind the Orders & Payments microservice, how it fits into QuickBite, and the trade-offs taken.

The system context (see `img.png`, `img_1.png`):

```
[Customer App] [Restaurant Dashboard] [Delivery App] [Admin Dashboard]
        \           |           |          /
         \          |           |         /
          \         v           v        /
           +────►  CORE-SERVICE (users, restaurants, branches, products, RBAC, auth)
                       │              │
                  sync HTTP    async via RabbitMQ (core → order: cache invalidation only)
                       │              │
                       v              v
                  ORDER-SERVICE (this) ◄──── WebSocket ──── all client apps
                  / │ │ \
                 /  │ │  \
       Postgres ◄──┘ │  └──► Redis (cache + presence + pubsub)
       (sharded                  
        per country)             
                       │
                       └────► Kashier (payment provider, sync init + async webhook)

       Postgres archive cluster (sharded per country, cold) — populated by Phase 7 archival worker

(future) Analytics service — out of scope
```

---

## 1. Service boundaries

### What this service owns

- The **lifecycle and state** of every order, payment, transaction, and delivery.
- The **money ledger** for restaurants (balances, payouts, commissions, refunds).
- **Real-time** order/delivery updates to all four client apps.

### What it does NOT own

- Users, auth tokens, RBAC permission catalog, restaurants, branches, products, customer addresses → `core-service`.
- Analytics aggregations, dashboards, KPIs → future analytics service.
- Image hosting / CDN → core-service uploads, S3 + CDN.

### Why split orders out from core?

1. **Different write profile.** Core is read-heavy (browse menus). This service is the high-write, money-critical path. Separating lets us scale and optimize independently.
2. **Stronger isolation.** Money and order data live in their own DB cluster; a noisy menu-browsing query cannot starve checkout.
3. **Per-region sharding fits orders** (locality is real — a customer orders in their city), but doesn't fit the global product catalog.
4. **Independent failure domain.** A core-service incident doesn't have to take down customer order placement (we degrade gracefully via cache).

---

## 2. Sharding strategy

### Shard key: country

One Postgres cluster per country: `eg`, `ksa`, ... The DB column and code identifier is `region` so the router stays generic if we ever sub-shard a country (e.g. `eg-cai`, `eg-alx`) — but in this milestone `region == country code`.

### Why country (and not customer_id, restaurant_id, order_id)?

| Candidate    | Locality | Hot-spot risk                  | Cross-shard reads                             |
| ------------ | -------- | ------------------------------ | --------------------------------------------- |
| customer_id  | poor     | low                            | restaurant view of all its orders → fan-out   |
| restaurant_id| poor     | very high (one big chain)      | customer order history → fan-out              |
| order_id     | none     | low                            | every read is fan-out                         |
| **country**  | **high** | medium (peak meal hours)       | rare; only system-admin global views          |

A customer in Egypt orders from a restaurant in Egypt, fulfilled by an agent in Egypt. The restaurant dashboard for any branch in Egypt reads only Egyptian orders. **All three actors are co-located in the same country.** That makes country the natural shard key.

The hot-spot risk during meal times is mitigated by:
- **Redis caching** of the read-heavy "pending orders" list per branch.
- **Horizontal scaling** of the order-service stateless tier per region.
- (Read replicas are not introduced in this milestone; revisit when traffic justifies it.)

### Resolving the region per request

Region comes from the **`X-Region` header only** (see `lib/sharding/region-resolver.ts`). Not in the JWT, not in the URL, not a cookie. `X-Region: all` is permitted for admin fan-out reads; writes must resolve a concrete region.

For `POST /orders`, if no `X-Region` is supplied, the service derives the region from the chosen `branchId` via cached branch metadata. Otherwise the endpoint returns **400** immediately.

### Cross-shard reads

Only one pattern exists, outside the hot path:

1. **System admin global views** — fan-out controller that calls each shard sequentially or in parallel up to a fan-out cap. Pagination is per-shard with a merged "tagged cursor" (shard:cursor). With ~2 countries today (`eg`, `ksa`) this is cheap.

A customer who has ordered in multiple countries is rare; we don't optimize for it in this milestone.

### What lives outside shards

- `payment_providers` table — small, replicated to every shard.
- Migrations — same code runs against every shard cluster.
- The Kashier provider account — a single tenant in Kashier (or one per region — TBD per Kashier contract).

---

## 3. Caching layers (Redis)

### Layer A — Read-through cache for cross-service data

The hot lookups we don't want to bounce to `core-service` on every request:

| Key pattern                         | Source                  | TTL  | Invalidation                          |
| ----------------------------------- | ----------------------- | ---- | ------------------------------------- |
| `core:branch:<branchId>`            | `core-service.GET /branches/:id` | 60s  | TTL only (low write rate)             |
| `core:product:price:<branchId>:<productId>` | `core-service.GET /branches/:id/products/:id` | 30s  | invalidated by inbound core webhook `product.price.changed` (and `product.stock.changed`) |
| `core:restaurant:<id>`              | `core-service.GET /restaurants/:id` | 5m   | TTL                                   |
| `core:rbac:perms:<roleName>`        | `core-service.GET /rbac/permissions?role=` | 5m   | invalidated on permission change      |

This is the same pattern as `core-service`'s `withCache`, but for cross-service calls instead of DB queries.

### Layer B — Endpoint cache (`withCache` middleware)

Same as core. Used for:
- `GET /restaurant/orders?branchId=&status=pending` (per-branch, 10s TTL — pending orders churn fast but the polling rate is high).
- `GET /agents/tasks?status=` (per-agent, 5s TTL).

For these, we **also** publish via WebSocket on state change so clients don't actually rely on polling — but the cache absorbs misbehaving clients.

### Layer C — Idempotency cache

`idempotency:{METHOD}:{path}:{key}` — 24h TTL. Backed by `idempotency_keys` table for durability on the critical paths.

### Layer D — Agent presence cache

`presence:<region>:<agentId>` — written on `POST /agents/presence/ping` (write-through to Redis + Postgres). Auto-assignment reads the geo set from Redis (`GEOADD presence:geo:<region>`) instead of Postgres for the hot scan.

### Layer E — WebSocket fan-out (socket.io Redis adapter)

Services emit via `io.to("<room>").emit(event, payload)`. The `@socket.io/redis-adapter` uses Redis pub/sub under the hood to deliver the message to whichever worker currently holds the target socket. Rooms are the channels: `customer:<userId>`, `branch:<branchId>`, `agent:<agentId>`, etc. No per-region fanout channel and no sticky load balancer — any worker can serve any client on reconnect.

---

## 4. Synchronous communication with `core-service`

### Use cases

1. **Validate an entity exists** when not in cache (a previously unseen branch on `POST /orders`).
2. **Fetch fresh price/stock** at order time if cache TTL elapsed.
3. **Check RBAC permissions** on first call after deploy.
4. **Lookup a customer's address** for delivery snapshot.

### Implementation: `lib/core-client/`

- Thin HTTP client over `fetch` with retry (3 tries, exponential backoff, capped at 500ms).
- All calls are **idempotent GETs** — never mutates core via this client.
- On core-service failure: degrade per call.
  - Branch validation: must succeed (we can't accept an order without it). Return 503.
  - Permission lookup: serve stale cache up to 1h. After that, deny.
  - Address fetch: must succeed.
- All calls forward `X-CorrelationId` for tracing.

### Why not just import core's code?

Hard service boundary. Two databases. Two deploy lifecycles. Sharing code beyond DTO type definitions would create an implicit dependency we'd regret.

---

## 5. Asynchronous communication

This service does **not** emit outbound async events to anyone in this milestone:
- No analytics service exists yet — its async integration is out of scope.
- Nothing else needs at-least-once delivery from us today (everything client-facing is delivered via WebSocket; webhooks from Kashier come **into** us).

The only async path is **inbound from `core-service`** for cache invalidation and authorization invalidation.

### Transport: RabbitMQ

| Component            | Name                                      | Owner                            |
| -------------------- | ----------------------------------------- | -------------------------------- |
| Topic exchange       | `core.events` (durable)                   | declared by core; defensively redeclared here |
| Consumer queue       | `order-service.core-events` (durable)     | this service                     |
| Bindings             | `product.#`, `branch.#`, `restaurant.#`, `rbac.#` | this service              |
| Dead-letter exchange | `core.events.dlx`                         | this service                     |
| Dead-letter queue    | `order-service.core-events.dlq`           | this service                     |
| Prefetch             | 32 messages per channel                   | this service                     |

The consumer declares its own queue, bindings, and DLQ at startup (idempotent). Core only declares the exchange.

### Events consumed (routing key = `eventType`)

| Event                          | Trigger in core            | Action in order-service                                                              |
| ------------------------------ | -------------------------- | ------------------------------------------------------------------------------------ |
| `product.stock.changed`        | core stock decrement       | invalidate `core:product:price:<branchId>:<productId>` and `core:product:stock:*` keys |
| `product.price.changed`        | menu price edit            | invalidate `core:product:price:<branchId>:<productId>`                                |
| `branch.updated`               | branch metadata change     | invalidate `core:branch:<branchId>`                                                   |
| `branch.deactivated`           | branch turned off          | invalidate `core:branch:<branchId>` + reject new orders to that branch                |
| `restaurant.suspended`         | restaurant suspended       | invalidate `core:restaurant:<id>` + flag pending orders for that restaurant for review |
| `rbac.permissions_changed`     | role/permission edited     | invalidate `core:rbac:perms:<roleName>`                                                |

### Message envelope

```jsonc
{
  "eventId": "<uuid, stable across broker redeliveries>",
  "eventType": "product.stock.changed",
  "occurredAt": "2026-04-16T15:00:00.000Z",
  "payload": { /* event-specific */ }
}
```

### Consumer flow

1. Receive message.
2. Redis `SET core-events:dedupe:<eventId> "1" NX EX 86400` — set-if-absent with 24h TTL.
3. If already set → already processed → **ack** and return.
4. Otherwise dispatch to the handler registered for `eventType`.
5. On success → **ack**.
6. On failure → **nack with requeue=false** (message flows to DLQ). Alert on DLQ depth; replay manually after the underlying bug is fixed. The dedupe key stays set — ops explicitly delete it if they want the replay to re-run the handler.

Delivery semantics: **at-least-once**. Dedupe is by `event_id` via Redis SETNX. The 24h TTL is a safety window for realistic redelivery (consumer restart, nack-requeue, ops DLQ replay); all handlers are idempotent cache invalidations, so an expired key re-running the handler is harmless.

### Authentication

AMQP credentials per-service, per-vhost. No HMAC on the wire — the broker is the trust boundary.

### Reliability requirement on `core-service`

Core **uses a transactional outbox**. The service layer inserts a row into `events_outbox` in the same DB trx as the domain write (repos never publish or insert outbox rows themselves). A **separate worker process** (`core-service/src/worker.ts`, scheduled by `croner`) drains the outbox: `SELECT ... FOR UPDATE SKIP LOCKED`, publish to RabbitMQ with **publisher confirms**, stamp `dispatched_at` only after the broker acks. `SKIP LOCKED` makes N workers safe to run in parallel for HA.

Publishing directly in the request path without an outbox loses events on crash between DB commit and broker publish — that path is not acceptable.

### Why RabbitMQ (not HTTP webhook)?

- **Decouples core's request lifecycle from our availability.** If this service is down, events queue up; core's write path isn't blocked.
- **Back-pressure for free.** Bursts buffer in the broker.
- **Future consumers without coupling.** When an analytics service ships, it binds its own queue to `core.events` with its own routing patterns — no change to the producer.
- **Standard retry/DLQ model.** We don't have to build retry semantics ourselves.

### What we do NOT do

- We do **not** emit anything outbound from this service. No `events_outbox` here.
- We do **not** fan out WebSocket events via RabbitMQ — that's Redis pub/sub (Layer E of §3), different trade-offs (low latency, ephemeral, same-region).

---

## 6. Kashier v3 integration

We integrate per the official docs — Payment Sessions to start, Webhook to confirm. (URLs: `https://developers.kashier.io/payment/payment-sessions`, `https://developers.kashier.io/webhooks/setup`.)

### Init flow (online payment)

```
client                  order-service                     Kashier
  │  POST /orders          │                                │
  │ ─────────────────────► │                                │
  │                        │ create order (status='pending_payment')
  │                        │ commit                         │
  │                        │ POST /payments/init            │
  │ ─────────────────────► │                                │
  │                        │ create payment_session row     │
  │                        │ POST Kashier /sessions ─────► │
  │                        │ ◄─── { sessionId, redirectUrl }│
  │                        │ store provider_session_id      │
  │  { redirectUrl }       │                                │
  │ ◄───────────────────── │                                │
  │ ──── redirect ─────────────────────────────────────► hosted payment page
  │                                                          │
  │                                            ◄─── customer pays ─── │
  │                        │ ◄─── webhook ──── │             │
  │                        │ verify HMAC sig   │             │
  │                        │ insert payment_webhook_events (uniq → de-dup)
  │                        │ update payment_session.status   │
  │                        │ insert transaction (charge, succeeded)
  │                        │ update order.status='placed'    │
  │                        │ publish ws (order placed)       │
  │                        │ commit                          │
```

### COD flow

- Order created with `payment_method='cod'`, status goes straight to `placed`.
- A `transaction` row of type `cod_collection` with `status='pending'` is inserted at order creation.
- On `delivery.delivered`, the transaction status flips to `succeeded`. Restaurant balance is updated as part of that same trx.

### Webhook security

- Verify HMAC with `KASHIER_WEBHOOK_SECRET` from env.
- Reject if signature missing/invalid: 401 + log alert.
- Reject duplicates via the `uq_payment_webhook_events_provider_event_id` unique index → return 200 for duplicates so Kashier stops retrying.

### Configurability via `payment_providers`

- `is_enabled` lets ops disable a provider without code changes.
- `priority` is reserved for future multi-provider orchestration; today only Kashier is online.

### Refunds

- `POST /payments/{id}/refund` (admin only) → calls Kashier refund API → inserts a `transaction(transaction_type='refund', status='pending')` → flips to `succeeded` on webhook.
- Original charge gets `is_refunded=true` and `refunded_payment_id` pointer.

---

## 7. WebSocket layer

### Protocol

- `socket.io` server, mounted on the same HTTP server as Express (`server.ts`) at path `/ws`.
- Clients connect via the socket.io protocol: `auth: { token }` in the handshake, or `?token=` query, or the `access_token` cookie.
- Server middleware verifies the JWT, stashes the user on `socket.data.user`, and computes the rooms (== channels) they may join: customer → `customer:<userId>`; restaurant user → `restaurant:<restaurantId>` + `branch:<branchId>` per branch; agent → `agent:<agentId>`.
- Client emits `subscribe(channelName, ack)` / `unsubscribe(channelName)`. The server checks the allowed set; ack returns `{ ok: true }` or `{ ok: false, error }`.
- Events are named socket.io events (e.g. `order.status_changed`); payload shape is documented per event.

### Channels & events

| Channel                   | Events                                             | Subscribers                  |
| ------------------------- | -------------------------------------------------- | ---------------------------- |
| `customer:<userId>`       | `order.status_changed`, `delivery.position`        | the customer themselves      |
| `restaurant:<restId>`     | `order.placed`, `order.cancelled`                  | restaurant owners            |
| `branch:<branchId>`       | `order.placed`, `order.status_changed`, `delivery.assigned` | branch staff & managers     |
| `agent:<agentId>`         | `task.assigned`, `task.cancelled`                  | the agent themselves         |

### Fan-out

WS workers use **socket.io** with the `@socket.io/redis-adapter`. Any worker calling `io.to("customer:42").emit(event, payload)` automatically fans out through Redis pub/sub to every other worker; whichever one holds the target socket delivers it. No sticky load balancer required, no per-region fanout channel — socket.io rooms are the abstraction.

### Why not Server-Sent Events?

- Bi-directional commands (`subscribe`, `unsubscribe`, agent location pings) make WS the right shape.
- Mobile network resilience is similar; WS with proper heartbeat works fine.

### Why not socket.io?

- Adds a heavy abstraction over a simple need.
- We don't want polling fallback; modern clients have WS.
- Less library risk in the long run.

---

## 8. High availability

- **Stateless service tier** with autoscaling per region.
- **Redis** with at least one replica per region.
- **Kashier outage**: COD is unaffected; online checkout returns a clear "payment temporarily unavailable" + retains the order in `pending_payment` for 15 min. The init endpoint is idempotent so a retry produces the same session.
- **Core-service outage**: cached branch/product data lets us serve `GET` paths and accept orders that hit cached branches. New restaurants/branches not yet cached are unservable; we surface that as 503.
- **Inbound core webhook delivery down**: cache TTLs eventually expire and reads fall back to live core-client lookups; some staleness window during the outage is acceptable.

(Read replicas are deliberately not introduced in this milestone — single primary per region. We will revisit when load data justifies it.)

---

## 9. Strong consistency for money

Money paths are wrapped in `db.transaction()` with `SELECT ... FOR UPDATE` on `restaurant_balances` rows where they participate. Specifically:

- `delivery.delivered`:
  - Lock `restaurant_balances` row.
  - Insert `transactions(type='charge'|'cod_collection', status='succeeded')` if not already.
  - Insert `transactions(type='commission', status='succeeded')` (platform cut).
  - Update `restaurant_balances.balance += subtotal - commission`.
  - Insert `agent_earnings`.
  - Commit.

- `payout` (admin-recorded):
  - Lock `restaurant_balances` row.
  - Validate balance ≥ amount, else 409.
  - Insert `transactions(type='payout', status='succeeded', dst_acc_id=ownerId, src_acc_id=NULL)`.
  - Decrement `restaurant_balances.balance`.
  - Commit.

The unique on `transactions.idempotency_key` and the partial uniques on webhook events guarantee no double-recording even on retries.

---

## 10. Archival & retention

PRD §9: only the **current year** of orders is queryable from hot DB; older lives in cold storage.

Plan (Phase 7 in the implementation plan):
1. A **separate Postgres archive cluster per region** (`order_service_archive`) runs the same schema as the hot DB.
2. A nightly archival worker per region copies rows older than the current year into the archive cluster (in batches), validates the copy, then deletes from hot.
3. The customer/restaurant API gates by `year=YYYY` — current year hits hot DB, older hits the archive cluster (the same `region` shard router resolves which connection to use, with a `cluster='archive'|'hot'` flag).
4. Logs retention is a devops concern — out of scope for this milestone.

---

## 11. Failure modes & graceful degradation

| Failure                  | Behavior                                                               |
| ------------------------ | ---------------------------------------------------------------------- |
| Postgres primary down    | Writes and reads fail with 503; managed failover restores within seconds |
| Redis down               | Cache misses → DB; idempotency falls back to `idempotency_keys` table; WS pub/sub paused (sockets stay open) |
| Kashier down             | COD unaffected; online checkout returns 503 with retry-after; user can still place a COD order |
| Core-service sync down   | New orders to uncached branches fail; cached branches still work; permission lookups serve stale cache up to 1h |
| RabbitMQ down             | Consumer loop reconnects with backoff; core's outbox accumulates until broker recovers; cached values gradually go stale (TTL + live core-client read cushion the window) |
| WS worker crash          | Client reconnects automatically (socket.io-client); reconnect can land on any worker; missed events recoverable via REST poll |

---

## 12. Security summary

- All endpoints require auth except `POST /payments/webhook/{provider}` (HMAC-validated) and `GET /health`.
- RBAC enforced via `rbac()` middleware (same shape as core); permissions resolved through cached projection from core.
- Cross-region tampering: every authenticated request's resolved region (from `?region=` / `X-Region` / cookie) is asserted against the resource's region — a customer in region A cannot read order details for a region B order they don't own.
- Webhook secrets in env; never logged.
- Idempotency keys are user-scoped (the lookup includes `user_id`) so one user can't replay another user's response.
