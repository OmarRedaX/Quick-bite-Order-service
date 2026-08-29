# order-service

The **Orders & Payments** microservice of the QuickBite platform (a food-delivery marketplace — think customers ordering from restaurants, a restaurant dashboard managing orders, delivery agents fulfilling them, and admins overseeing all of it). This service owns the transactional truth of the system: order placement and lifecycle, online (Kashier) and cash-on-delivery payments, delivery assignment and agent earnings, restaurant balance/payouts, real-time WebSocket updates, and nightly cold-archival of prior-year data.

It does **not** own users, restaurants, branches, products, customer addresses, or the RBAC permission catalog — those live in a separate `core-service` and are consumed over sync HTTP or cached read-through projections. Four client apps talk to the platform: a customer app, a restaurant dashboard, a delivery agent app, and an admin dashboard — all of them hit `core-service` for catalog/auth data and this service for everything that happens after "place order."

This file is meant to let a newcomer understand the whole project — the domain, how a request actually flows through the system end to end, every module, every endpoint, the data model, and how to run it locally. For the line-by-line coding conventions this codebase follows, see [`CLAUDE.md`](./CLAUDE.md); for the original design rationale docs, see [`docs/`](./docs/README.md).

## Contents

- [Domain model — the order lifecycle](#domain-model--the-order-lifecycle)
- [How an order actually flows through the system](#how-an-order-actually-flows-through-the-system)
- [Modules, in depth](#modules-in-depth)
- [API reference](#api-reference)
- [WebSocket events](#websocket-events)
- [Architecture](#architecture)
- [Data model](#data-model)
- [Auth & RBAC](#auth--rbac)
- [Tech stack](#tech-stack)
- [Getting started](#getting-started)
- [Available scripts](#available-scripts)
- [Project structure](#project-structure)
- [Environment variables](#environment-variables)
- [Further reading](#further-reading)
- [Testing](#testing)

---

## Domain model — the order lifecycle

Every order is a state machine. Its `status` column can only move forward along the arrows below — there is no going back a step:

```
                 ┌─── pending_payment ───┐   (online payment only; skipped entirely for COD)
                 │           │           │
                 │  payment captured     │  payment never completes (15 min sweep, or
                 │  (Kashier webhook)    │  customer cancels within the window)
                 │           ▼           ▼
                 └──────► placed ───────────────► cancelled
                             │
              restaurant declines            restaurant accepts
                             │                       │
                             ▼                       ▼
                         rejected               accepted ───► cancelled (restaurant, with reason)
                                                     │
                                                     ▼
                                                preparing ───► cancelled (restaurant, with reason)
                                                     │
                                                     ▼
                                                  ready ───► cancelled (restaurant, with reason)
                                                     │
                                     auto-assignment worker claims an agent
                                                     ▼
                                                assigned ───► cancelled (admin only)
                                                     │
                                       agent confirms pickup at the branch
                                                     ▼
                                                  picked                 (no cancel from here —
                                                     │                    food is in transit)
                                       agent confirms drop-off
                                                     ▼
                                                delivered  (terminal — triggers money settlement)
```

| Status | Meaning | Who moves it |
| --- | --- | --- |
| `pending_payment` | Online order created, waiting on Kashier | system (webhook), customer (cancel within the window) |
| `placed` | In the restaurant's queue | system (transition only) |
| `accepted` | Restaurant will cook it | restaurant staff/manager/owner |
| `rejected` | Restaurant declined — terminal | restaurant |
| `preparing` | Actively being cooked | restaurant |
| `ready` | Food's ready — eligible for delivery assignment | restaurant |
| `assigned` | An agent has been matched | the auto-assignment worker, or admin override |
| `picked` | Agent has the food | the assigned agent |
| `delivered` | Customer has it — terminal, settles money | the assigned agent |
| `cancelled` | Cancelled before delivery | system / restaurant / customer / admin, depending on the current status |

The customer's cancel window is intentionally short (while `pending_payment` or `placed`, and no more than 60 seconds after placement) — past that, only the restaurant or an admin can cancel.

---

## How an order actually flows through the system

This is the story that ties every module together — worth reading before diving into any one piece.

1. **Placement — `app/order`.** A customer calls `POST /orders`. The service resolves which region (country) shard the order belongs to from the chosen branch, validates the branch is open and the restaurant is active (via `core-service`, cached), fetches live prices/stock for every line item in a single batched call, computes `subtotal + delivery_fee + service_fee = total` in integer minor units, reserves stock in `core-service`, and inserts the `orders` + `order_items` rows in one DB transaction on that region's hot shard. A COD order goes straight to `placed`; an online order goes to `pending_payment`.

2. **Payment (online only) — `app/payment`.** Still inside the same request, for an online order the order service hands off to `PaymentService.initOnlinePayment`, which creates a Kashier Payment Session and stores a `payment_sessions` row, returning a redirect URL to the client. There is no separate "init payment" endpoint to call — it's folded into order placement to keep the client flow to one round trip. When the customer pays, Kashier calls `POST /payments/webhook/kashier`: the handler verifies the HMAC signature, de-dupes by `(provider_id, provider_event_id)` (a duplicate webhook is a 200 no-op), writes a `charge` row to the `transactions` ledger, and flips the order to `placed`. A failed COD order never touches this module — `cod_collection` is written later, on delivery (see step 6).

3. **Restaurant workflow — `app/order`.** The restaurant dashboard drives `placed → accepted → preparing → ready` (or `rejected`/`cancelled`) via `PATCH /restaurants/:restaurantId/branches/:branchId/orders/:publicId/status`. Every transition is validated against the status machine for that actor, stamps the matching `<verb>_at` column in the same transaction, and broadcasts a `order.status_changed` WebSocket event to the customer and the branch.

4. **Assignment — `app/assignment`.** A background worker tick (every `ASSIGNMENT_TICK_SEC`, default 10s, one per region) scans for `ready` orders with no agent yet, geo-searches Redis for the nearest online, non-busy agents (`GEOSEARCH` against the region's presence set), and broadcasts a claimable offer to the top candidates over WebSocket. The offer and the eventual claim are both Redis `SETNX` locks (`offer:order:<id>`, `claim:order:<id>`) so exactly one agent can win a race, and the loser gets notified their offer was claimed elsewhere.

5. **Fulfillment — `app/agent`.** The winning agent calls `POST /agents/orders/:publicId/accept`, which atomically flips the order to `assigned` and marks the agent busy. From there the agent drives `assigned → picked → delivered` via `PATCH /agents/orders/:publicId/status`.

6. **Settlement — `app/agent` + `app/finance`.** The `delivered` transition is the one place money actually moves, all in a single transaction: it computes the platform commission, writes a `commission` transaction (and, for COD orders, the `cod_collection` transaction that was deferred from step 1), credits `restaurant_balances` with `subtotal - commission`, and writes an `agent_earnings` row for the delivery agent's share of the delivery fee. Every one of those inserts is idempotent (unique constraints on `idempotency_key` / `order_id`), so a retried request can never double-credit anyone.

7. **Payouts — `app/finance`.** Whenever operations actually wires money to a restaurant's bank account, an admin calls `POST /admin/restaurants/:restaurantId/payouts`, which locks the balance row, checks sufficient funds, writes a `payout` transaction, and debits the balance. The restaurant can read its running balance and payout history at any time.

8. **Everything is real-time.** Every status change and assignment event above is pushed over WebSocket to the relevant `customer:<id>`, `restaurant:<id>`, `branch:<id>`, and `agent:<id>` rooms the instant it happens, so none of the four client apps need to poll.

9. **Aging out.** Once an order's `created_at` rolls into a prior year, the [cold archival worker](#the-archival-worker-newest-addition) quietly moves it — and everything that hangs off it (items, transactions, payment sessions, webhook log, agent earning) — from the hot database to a per-region archive database, overnight, in batches, with no customer-visible downtime. Reads for that data keep working exactly the same; they're just transparently routed to wherever the row now lives.

---

## Modules, in depth

Every module under `src/app/<name>/` follows the same internal shape (see [Project structure](#project-structure)): `entity/` (plain classes), `dto/*.request.dto.ts` + `dto/*.response.dto.ts`, `repository/*.repo.ts` (exported functions, not classes — every function takes an optional `conn: Knex` so it composes into any transaction), `service/*.service.ts` (`@injectable`, holds the actual business logic), `controller/*.controller.ts` (`@injectable`, does *only* validate → call service → map to a response DTO → respond), `routes.ts`, `enums.ts`, `errors.ts`, `types.ts`.

### Orders (`app/order`)

Owns order placement, the status machine, and every order read path (customer history, restaurant lists, single-order lookup, admin overrides). See the [lifecycle](#domain-model--the-order-lifecycle) and [flow](#how-an-order-actually-flows-through-the-system) above for the detail; [`docs/business-logic/orders.md`](./docs/business-logic/orders.md) has the full transition matrix and invariants.

Notable design choices actually implemented:
- Stock is reserved in `core-service` *after* the local DB transaction commits — if the reservation then fails, the order is voided and stock release is attempted, logged loudly if it can't be.
- `GET /orders/:publicId` tries the hot cluster first; only `system_admin` or a restaurant `owner` get a retry against the archive cluster on a miss (a plain customer never pays that extra round trip — their orders are always recent).
- `GET /restaurants/:id/branches/:id/orders` is cached for 10 seconds (`withCache`) and invalidated explicitly on every status transition for that branch — it doesn't rely on the TTL alone.

### Payments (`app/payment`)

Owns Kashier v3 online payment sessions, the webhook that confirms them, and the `transactions` money ledger (every charge, commission, payout, and refund is one row here). See [`docs/business-logic/payments.md`](./docs/business-logic/payments.md).

- Online session creation is triggered automatically from inside `POST /orders` (`OrderService.placeOrder` calls `PaymentService.initOnlinePayment`) — there's no separate public "init payment" endpoint in the shipped implementation.
- The webhook handler is the only unauthenticated write endpoint in the service; it trusts nothing except a valid HMAC signature, and de-dupes via a unique index on `(provider_id, provider_event_id)` so Kashier's at-least-once retries are safe.
- Money is always integer minor units (piasters/halalas); `transactions.amount` is always positive, direction is encoded by `(transaction_type, src_acc_id, dst_acc_id)`.
- **Refunds are documented in the design docs but not yet implemented** in this codebase — there's no `POST /payments/:id/refund` endpoint or refund service method today.

### Assignment (`app/assignment`)

The background worker that matches a `ready` order to a nearby delivery agent, plus the admin override to force-assign one. See [`docs/business-logic/deliveries.md`](./docs/business-logic/deliveries.md) — there is deliberately no `deliveries` table or `app/delivery` module; delivery state lives entirely on the `orders` row, and "delivery business logic" is split between this module (matching) and `app/agent` (the agent-side actions).

- Candidate search is a single Redis `GEOSEARCH` against the region's presence geo-set, filtered to online + not-already-busy agents, ordered by distance.
- The offer and the claim are both `SETNX`-guarded Redis keys, which is what makes "first agent to accept wins" race-safe without a DB lock.
- Reassignment happens automatically (next worker tick, once an unclaimed offer expires) or immediately (an agent going offline while `assigned` releases their order back to `ready`). After `ASSIGNMENT_MAX_ATTEMPTS` rounds with no taker, the order sits in `ready` and raises an admin alert until `POST /admin/orders/:publicId/assign` unsticks it.

### Agents (`app/agent`)

Delivery-agent presence, their task list and earnings, and the in-flight order actions (accept/reject an offer, mark picked/delivered). See [`docs/business-logic/agents.md`](./docs/business-logic/agents.md).

- Presence has no database table at all — it's a 5-minute Redis TTL hash (`presence:meta:<region>:<agentId>`) plus a geo set the assignment worker searches. Stop pinging, and the agent silently goes offline.
- The `delivered` transition is where [settlement](#how-an-order-actually-flows-through-the-system) happens — the agent module and the finance module meet here in one transaction.

### Finance (`app/finance`)

Read views over a restaurant's running balance and payout history, plus the one admin write: recording a payout. See [`docs/business-logic/restaurant-finance.md`](./docs/business-logic/restaurant-finance.md).

- **Payouts are not a separate table** — they're a `transaction_type='payout'` row in the same `transactions` ledger everything else uses, which is what makes "balance = sum of everything that ever happened to this restaurant" auditable from one table.
- Balance reads never go through the cache — small, hot, single-row, and it has to be trustworthy for an owner deciding whether to trust the number.

### The archival worker (newest addition)

The only background job with no HTTP surface of its own — see the [dedicated section below](#the-cold-archival-worker) plus the [data model](#data-model).

---

## API reference

Every route is mounted under `/api`. Auth is a JWT in the `access_token` cookie (issued by `core-service`); region is resolved per-request from `?region=`, then the `X-Region` header, then a `region` cookie. All write endpoints that cost money or create resources require an `Idempotency-Key` header. See [`docs/api-contracts.md`](./docs/api-contracts.md) for full request/response bodies, headers, and error codes — this table is the map.

### Orders

| Method & path | Auth | Purpose |
| --- | --- | --- |
| `POST /orders` | customer | Place an order (COD or online). Idempotent (strict). |
| `GET /orders/:publicId` | customer (own) / restaurant member / admin | Order detail + items + status history. Archive fallback for admin/owner only. |
| `GET /customer/orders?year=` | customer | Paginated order history for one calendar year (hot or archive). |
| `PATCH /customer/orders/:publicId/status` | customer (own, within cancel window) | Cancel. Idempotent (strict). |
| `GET /restaurants/:restaurantId/branches/:branchId/orders?status=&from=&to=` | restaurant member (`orders:read`) / admin | Paginated order list for a branch. Cached 10s; hot/archive/straddle-merged depending on `from`/`to`. |
| `PATCH /restaurants/:restaurantId/branches/:branchId/orders/:publicId/status` | restaurant member (`orders:accept`/`orders:update`/`orders:cancel`) | Accept/reject/preparing/ready/cancel. Idempotent (strict). |
| `PATCH /admin/orders/:publicId/status` | admin | Any transition the state machine allows for admin. Idempotent (strict). |

### Payments

| Method & path | Auth | Purpose |
| --- | --- | --- |
| `POST /payments/webhook/kashier?region=` | none — HMAC-verified | Kashier payment confirmation. De-duped, at-least-once safe. |
| `GET /restaurants/:restaurantId/payments/:paymentId` | restaurant member (`payments:read`) / admin | One transaction's detail. |

### Assignment

| Method & path | Auth | Purpose |
| --- | --- | --- |
| `POST /admin/orders/:publicId/assign` | admin (`deliveries:assign`) | Force-assign a specific agent, bypassing distance/busy checks. Idempotent (strict). |

### Agents

| Method & path | Auth | Purpose |
| --- | --- | --- |
| `POST /agents/presence/online` | delivery agent | Go online at `{lat, lng}`. |
| `POST /agents/presence/ping` | delivery agent | Refresh presence TTL / position. |
| `POST /agents/presence/offline` | delivery agent | Go offline (blocked while `picked`). |
| `POST /agents/orders/:publicId/accept` | delivery agent (offered) | Claim a broadcast offer. Idempotent (strict). |
| `POST /agents/orders/:publicId/reject` | delivery agent (offered) | Decline an offer. |
| `PATCH /agents/orders/:publicId/status` | delivery agent (assigned) | `picked` or `delivered` (delivered runs settlement). Idempotent (strict). |
| `GET /agents/tasks?status=` | delivery agent | This agent's task list. |
| `GET /agents/earnings?from=&to=` | delivery agent | This agent's earnings history. |

### Finance

| Method & path | Auth | Purpose |
| --- | --- | --- |
| `GET /restaurants/:restaurantId/balance` | restaurant member (`finance:read`) / admin | Current running balance per currency. |
| `GET /restaurants/:restaurantId/payouts?from=&to=` | restaurant member (`finance:read`) / admin | Payout history. |
| `POST /admin/restaurants/:restaurantId/payouts` | admin | Record a payout. Idempotent (strict). |

### Health

| Method & path | Auth | Purpose |
| --- | --- | --- |
| `GET /health` | none | Pings every configured hot **and** archive shard; `200` if all reachable, else `503`. |

---

## WebSocket events

`socket.io`, mounted on the same HTTP server as the API, backed by `@socket.io/redis-adapter` so any worker process can deliver to a socket held by any other worker. Clients authenticate with the same JWT (cookie, `?token=`, or handshake `auth`), then `subscribe` to the rooms they're allowed to join. Full payload shapes are in [`docs/business-logic/orders.md`](./docs/business-logic/orders.md) §12 and [`agents.md`](./docs/business-logic/agents.md) §9.

| Event | Room(s) | When |
| --- | --- | --- |
| `order.created` | `branch:<id>` | A COD order is placed, or an online order's payment is captured |
| `order.status_changed` | `customer:<id>`, `branch:<id>` | Any status transition |
| `order.cancelled` | `customer:<id>`, `branch:<id>` | Order cancelled |
| `task.offered` | `agent:<id>` (each candidate) | Assignment worker broadcasts an offer |
| `offer.cancelled` | `agent:<id>` | This agent's offer was claimed by someone else, or expired |
| `task.assigned` | `agent:<id>` (the winner) | This agent won the claim |
| `task.cancelled` | `agent:<id>` | Their in-flight task was cancelled (admin) |
| `assignment.exhausted` | `admin:alerts` | An order ran out of assignment attempts and needs a manual push |

---

## Architecture

### Request composition

`app.ts` wires, in order: `helmet` → `cors` (credentialed) → JSON body parsing (raw body stashed for webhook HMAC verification) → `cookie-parser` → correlation-id middleware → region resolution → every module's router mounted under `/api` → the central error handler. `server.ts` boots that app on an `http.Server`, attaches the WebSocket server to the same server, pings every shard, connects to RabbitMQ, and starts the inbound `core.events` consumer. `worker.ts` is a second, separate process — no HTTP listener at all — that boots the same shared infra and hands control to a `node-cron` scheduler running the assignment tick, the outbox drain, and the nightly archival job.

### Region sharding

One Postgres cluster per country (`eg`, `ksa`, ...). A customer, the restaurant they're ordering from, and the agent delivering it are almost always in the same country, so country is the natural shard key — it gives high data locality and only rare, admin-only cross-shard reads. The column is called `region` (not `country`) so the router stays generic if a country ever needs sub-sharding later. Region is resolved per request (`?region=` → `X-Region` header → `region` cookie), never from the JWT — the same user can act in different regions across requests (e.g. an admin's fan-out view uses `region=all`).

### Caching (Redis)

- **Cross-service read-through cache** for data this service doesn't own but needs on the hot path — branch metadata, product price/stock, RBAC permissions — populated on demand from `core-service`, invalidated either by TTL or by an inbound `core.events` message.
- **Endpoint response cache** (`withCache(ttl)`) on a couple of read-heavy, poll-prone endpoints (the branch order list, the agent task list), always paired with an explicit `del()` on the write path that would make it stale — the cache is a safety net for misbehaving pollers, not the source of freshness (that's the WebSocket push).
- **Distributed locks** — assignment offers/claims and the archival worker's per-region lock are all the same primitive: Redis `SET key value NX EX ttl`.
- **Idempotency keys** — `{METHOD}:{path}:{key}` in Redis with a 24h TTL, backed by a durable Postgres table on the critical write paths (order placement, payment init, payouts) so a Redis flush can't silently lose idempotency guarantees.
- **Agent geo-presence** — a Redis geo set per region (`GEOADD`/`GEOSEARCH`) is what makes the assignment worker's "nearest 5 agents" query cheap; it's never persisted to Postgres.

### Messaging (RabbitMQ) — inbound only

This service never publishes synchronously to another service over the queue, and (per the original design docs) wasn't meant to publish *anything* outbound in this milestone — but the shipped code does include a transactional outbox (`lib/events/`) that drains to an `order.events` exchange for future consumers like an analytics service, alongside the one path the design explicitly called for:

- **Inbound**: consumes `core.events` (`product.#`, `branch.#`, `restaurant.#`, `rbac.#`) for cache invalidation — a product's price changes in core, this service's cached copy gets evicted. Delivery is at-least-once; a Redis `SETNX` dedupe on the event id makes replays a safe no-op. Poison messages land in a dead-letter queue instead of blocking the consumer forever.
- **Outbound**: `lib/events/outbox.repo.ts` writes an outbox row in the *same* DB transaction as the domain change it describes (so a crash between the two can't happen); a separate cron tick (`OUTBOUND_EVENTS_DRAIN_TICK_SEC`) claims a batch with `FOR UPDATE SKIP LOCKED` and publishes it, marking each row dispatched only after the broker confirms.

### Kashier integration

Online payments use Kashier's Payment Sessions API to start (called from inside order placement) and their Webhooks to confirm (`POST /payments/webhook/kashier`). The webhook's HMAC signature is verified before anything else happens; a verified but duplicate event (Kashier's own retries) is a 200 no-op thanks to the unique index on `(provider_id, provider_event_id)`. COD needs no external call at all — its money event is written directly by the settlement transaction when the order is marked `delivered`.

### The cold archival worker

`src/lib/jobs/archival.worker.ts`, scheduled by `registerArchivalJobs()` in `worker.ts`, one job per region (`ARCHIVAL_CRON`, default `0 3 * * *` UTC). Every run:

1. Walks tables in FK-safe order — `agent_earnings → payment_webhook_events → payment_sessions → transactions → order_items → orders` — children before the `orders` parent, so a crash mid-run never leaves an archived order whose line items or ledger rows didn't make it across yet.
2. Moves rows older than the current year in batches of `ARCHIVAL_BATCH_SIZE` (default 1000): insert into the archive cluster and commit, **then** delete from the hot cluster and commit. Archive-first means a crash between the two steps leaves a row in *both* places — safe, because a re-run just no-ops the re-insert (`ON CONFLICT DO NOTHING`) and still deletes it from hot — rather than in *neither*.
3. Is guarded by a Redis lock (`archival:<region>:lock`) so two worker processes booting at once can't race the same region; the lock always releases, even on error.
4. Respects `ARCHIVAL_MAX_RUNTIME_MIN` (default 60) — a run that's still going past budget stops cleanly and resumes on the next scheduled tick, rather than running forever.

Every order read that could touch prior-year data is archive-aware: `GET /customer/orders?year=` routes entirely to hot or entirely to archive (a calendar year can never straddle the boundary); `GET /restaurants/:id/branches/:id/orders?from=&to=` fans out to both clusters and merges the results in memory when the requested range straddles the boundary; `GET /orders/:publicId` tries hot first and only retries archive for `system_admin` or a restaurant `owner`.

### Failure modes (by design)

| If this is down | What happens |
| --- | --- |
| Postgres | Requests to that shard fail (503-ish); other shards unaffected |
| Redis | Cache misses fall through to the DB/core-client; idempotency falls back to its Postgres table; presence/assignment degrade (agents can't be matched) |
| Kashier | COD is entirely unaffected; online checkout fails cleanly, order stays retryable in `pending_payment` |
| `core-service` (sync) | Cached branches/products keep working; anything not yet cached fails |
| RabbitMQ | The consumer reconnects with backoff; cached cross-service data gradually goes stale until TTL/live-lookup covers the gap |

---

## Data model

Full schema, every index's justification, and the FK map live in [`docs/database-design.md`](./docs/database-design.md) — this is the shape to have in your head:

- **`orders`** — the header row. Native Postgres declarative partitioning by month on `created_at` (see [`npm run partitions:create`](#5-optional-pre-create-monthly-partitions)); a `public_id` UUID is the client-facing id, the internal `id` never leaves the service.
- **`order_items`** — line items, one INSERT of multiple rows per order, always fetched in bulk by `order_id` (never N+1).
- **`transactions`** — the single money ledger: every charge, COD collection, commission, payout, refund, and adjustment is one row here. Amount is always positive; direction comes from `(transaction_type, src_acc_id, dst_acc_id)`.
- **`payment_sessions`** — one row per Kashier checkout session, reconciled by the webhook.
- **`payment_webhook_events`** — raw inbound webhook log, unique on `(provider_id, provider_event_id)` — this is what makes webhook processing at-least-once-delivered but effectively-once-applied.
- **`payment_providers`** — small lookup table (`kashier`, etc.), replicated identically to every shard, not sharded itself.
- **`restaurant_balances`** — one row per `(restaurant_id, currency)`, the running total; only ever moved inside a locked transaction (`SELECT ... FOR UPDATE`).
- **`agent_earnings`** — one row per delivered order (unique on `order_id`), a snapshot of what that agent earned.
- **`events_outbox`** — the transactional outbox for outbound `order.events`.

There is deliberately **no `deliveries` table** (delivery state lives on `orders`) and **no `agent_presence` table** (presence is Redis-only, 5-minute relevance, no audit value).

**Money is always an integer in minor units** (piasters, halalas — never `DECIMAL`), with a sibling `currency` column, because decimal arithmetic returning as strings from the DB driver is an easy source of silent bugs, and integer math is exact.

**Every sharded table carries a `region` column** immediately after `id`, and every query against it goes through a connection already pinned to that region's shard (`db(region)` / `dbArchive(region)`) — there's no cross-shard `WHERE region = ?` filtering happening in application code, the connection itself is the shard boundary.

**Hot vs. archive**: each region has two physically separate Postgres databases with an identical schema. The hot one holds the current year; the [archival worker](#the-cold-archival-worker) moves everything older into the archive one overnight, keeping the hot database small enough that current-year queries stay fast without ever deleting historical data outright.

---

## Auth & RBAC

- Authentication is the exact same JWT contract as `core-service` — an `access_token` cookie, verified with the same secret, carrying `userId`, `role`, and (for restaurant users) `restaurantId` / `restaurantRole` / `branchIds`.
- This service keeps **no permission catalog of its own**. It extends `core-service`'s catalog with new permissions namespaced `orders:*`, `payments:*`, `deliveries:*`, `finance:*`, and resolves a role's permissions through a Redis-backed read-through cache of `core-service`'s RBAC endpoint (5-minute TTL, invalidated by an inbound `rbac.permissions_changed` event).
- `system_admin` bypasses permission checks entirely.
- Middleware handles two different questions:
  - **"Is this actor even in scope for this resource?"** — `requireRestaurantMember(:restaurantId)` and `requireBranchAccess(:branchId)` compare the JWT's own claims against the route's path params, no DB lookup needed.
  - **"Does this role have the permission?"** — `rbac({resource, action})` checks the cached permission projection.
- A third layer — **row-level ownership** (a customer can only ever see their own order; a restaurant user can only see orders for branches they're a member of) — lives in the *service*, not middleware, because it needs a DB lookup of the actual resource.

---

## Tech stack

| Concern | Library / Tool |
| --- | --- |
| Runtime | Node.js + TypeScript (strict, decorators on) |
| HTTP framework | `express` v5 |
| Validation | `class-validator` + `class-transformer` |
| DI | `tsyringe` |
| Env validation | `zod` |
| DB driver | `knex` over `pg` (no ORM) |
| Cache | `ioredis` |
| Auth | `jsonwebtoken` (same JWT contract as core-service) |
| WebSocket | `socket.io` + `@socket.io/redis-adapter` |
| Messaging | RabbitMQ via `amqplib` (inbound cache invalidation + an outbound transactional outbox) |
| Payments | Kashier v3 (Payment Sessions + Webhooks) |
| Background jobs | `node-cron` |

---

## Prerequisites

- Node.js 18+ and npm
- PostgreSQL reachable locally (or remotely) — **two databases per region**: one hot, one archive
- Redis
- RabbitMQ
- A running `core-service` instance (for auth JWT secrets, branch/product/address lookups, and the RBAC permission catalog) — order-service will boot without it, but most write endpoints and RBAC-gated reads will fail without it reachable

---

## Getting started

### 1. Install dependencies

```bash
npm install
```

### 2. Configure your environment

Copy the example file and fill in real values — **never commit `.env`**:

```bash
cp .env.example .env
```

At minimum you must set (these have no defaults and the app refuses to boot without them):

- `ACCESS_SECRET` / `REFRESH_SECRET` — must match core-service's JWT secrets exactly (same cookie, same signature).
- `REGIONS` — comma-separated region codes, e.g. `eg,ksa`. Every region needs a matching `DB_<region>_*` and `ARCHIVE_DB_<region>_*` block (see `.env.example` for the pattern).
- `RABBITMQ_URL`
- `CORE_SERVICE_BASE_URL` / `CORE_INTERNAL_API_KEY` — the internal `api-key` header value core-service expects. This must match what core-service is actually configured to accept, or every RBAC-gated / branch-lookup call will 401.
- `KASHIER_MERCHANT_ID` / `KASHIER_API_KEY` / `KASHIER_SECRET_KEY` / `KASHIER_RETURN_URL` / `KASHIER_FAIL_URL` / `KASHIER_WEBHOOK_URL` — from your own Kashier sandbox account.

Everything else has a sensible default (see `.env.example` for the full list, including the archival worker's `ARCHIVAL_*` settings).

> **Port note:** don't set `PORT` to a value on the browser/Node "bad ports" blocklist (e.g. `6000`, the X11 port) — `fetch()` and every browser will silently refuse to connect to it even though `curl` still works.

### 3. Create the databases

For every region in `REGIONS`, create both its hot and archive database (names come from `DB_<region>_NAME` / `ARCHIVE_DB_<region>_NAME` in your `.env`):

```sql
CREATE DATABASE order_service_eg;
CREATE DATABASE order_service_archive_eg;
CREATE DATABASE order_service_ksa;
CREATE DATABASE order_service_archive_ksa;
```

### 4. Run migrations

Hot cluster, all configured regions in one pass:

```bash
npm run migrate:all
```

Archive cluster (same migration set — hot and archive share an identical schema):

```bash
CLUSTER=archive npx tsx scripts/migrate-all.ts
```

Or per-region/per-cluster manually (`CLUSTER` defaults to `hot`):

```bash
REGION=eg npm run migrate
REGION=eg CLUSTER=archive npm run migrate
```

### 5. (Optional) Pre-create monthly partitions

`orders` is partitioned by `created_at`. New partitions for the next 12 months are pre-created by:

```bash
npm run partitions:create
```

Run this once after migrating, and monthly thereafter so the rolling window stays ahead of `NOW()` (rows outside all pre-created partitions still land safely in the `orders_default` catch-all).

> **Do this before real/test orders accumulate.** Postgres refuses to create a new partition for a month that already has matching rows sitting in `orders_default` (`ERROR: ... would be violated by some row`, `check_default_partition_contents`). On a fresh database right after migrating, `orders_default` is empty and this is a non-issue; if you place orders first and run this later, you'll need to move those rows into a proper partition manually (or just leave them in `orders_default` — it's a correctness no-op, only a minor performance one).

### 6. Start Redis, RabbitMQ, and core-service

All three need to be reachable before you start order-service.

### 7. Run it

Two separate processes:

```bash
npm run dev      # HTTP API on $PORT, with hot-reload
npm run worker   # background jobs: assignment tick, outbox drain, nightly archival
```

Or the production builds:

```bash
npm run build
npm run start          # node dist/server.js
npm run start:worker   # node dist/worker.js
```

### 8. Verify it's up

```bash
curl http://localhost:4000/api/health
```

Returns `200` with a per-shard ping (both hot **and** archive, every region) if everything is reachable, `503` if any shard isn't.

---

## Available scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | API server, hot-reloaded (`tsx watch src/server.ts`) |
| `npm run worker` | Background worker, hot-reloaded (`tsx watch src/worker.ts`) |
| `npm run build` | `tsc` compile to `dist/` |
| `npm run start` | Run the compiled API server |
| `npm run start:worker` | Run the compiled background worker |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run migrate` | `knex migrate:latest` for one region (`REGION=eg npm run migrate`) — cluster via `CLUSTER=hot\|archive`, defaults to `hot` |
| `npm run migrate:rollback` | Roll back the last migration batch for one region |
| `npm run migrate:status` | Show migration status for one region |
| `npm run migrate:make` | Scaffold a new migration file |
| `npm run migrate:all` | Run `migrate:latest` for **every** region in `REGIONS` (`CLUSTER=archive` for the archive cluster) |
| `npm run partitions:create` | Pre-create the next N months of `orders` partitions (`MONTHS_AHEAD`, `REGION` env overrides) |

---

## Project structure

```
order-service/
├── .env.example              # template — copy to .env, never commit .env
├── CLAUDE.md                  # conventions, layering rules, performance/sharding rules
├── docs/                      # architecture, schema, API contracts, business logic, build plan
├── scripts/
│   ├── migrate-all.ts         # runs migrate:latest across every region (hot or archive cluster)
│   └── create-partitions.ts   # pre-creates monthly `orders` partitions
├── play/                      # gitignored local smoke-test scripts — not part of the app
└── src/
    ├── app.ts                 # express composition (cors, helmet, json, cookie, correlation, routes, errorHandler)
    ├── server.ts               # HTTP API bootstrap: shard ping, WS attach, core-events consumer, graceful shutdown
    ├── worker.ts                # background worker bootstrap: registers assignment/outbox/archival jobs, starts the cron scheduler
    ├── routes.ts                # mounts every module router under /api
    │
    ├── app/                     # business modules — one folder per bounded context
    │   ├── health/                # GET /api/health — pings every hot + archive shard
    │   ├── order/                  # placement, lifecycle, status machine, customer/restaurant order lists
    │   ├── payment/                 # Kashier online sessions, COD, webhook processing, the money ledger
    │   ├── assignment/               # order → delivery-agent auto-assignment worker + manual/admin assign
    │   ├── agent/                     # agent presence (Redis GEO), tasks, earnings, delivery settlement
    │   └── finance/                    # restaurant running balance + payout recording
    │
    │   Each module follows the same skeleton: entity/ · dto/*.request.dto.ts ·
    │   dto/*.response.dto.ts · repository/*.repo.ts (exported functions, not
    │   classes) · service/*.service.ts (@injectable, business logic) ·
    │   controller/*.controller.ts (@injectable, validate → service → DTO →
    │   respond) · routes.ts · enums.ts · errors.ts · types.ts
    │
    ├── lib/                     # app-aware glue — may import pkg/ and env, never app/<module>/*
    │   ├── auth/                  # JWT guard, RBAC middleware, restaurant/branch membership checks
    │   ├── cache/                  # Redis client init + withCache(ttl) response-caching middleware
    │   ├── config/env.ts            # zod-validated env — the single source of truth for all config
    │   ├── core-client/             # sync HTTP client to core-service (branches, products, addresses, RBAC)
    │   ├── core-events/              # inbound RabbitMQ consumer — core.events → cache invalidation
    │   ├── correlation/               # X-Correlation-Id propagation
    │   ├── di/                        # tsyringe container + TOKENS symbol registry
    │   ├── error/                      # AppError + the central Express error handler
    │   ├── events/                      # outbound transactional outbox (order.events) + its drain job
    │   ├── http/                         # sendSuccess/sendPaginated + cursor-based pagination
    │   ├── idempotency/                   # Idempotency-Key middleware (Redis + DB fallback)
    │   ├── jobs/                           # generic cron job registry/scheduler + the archival worker
    │   │   ├── job-registry.ts / job.types.ts / scheduler.ts   # generic "register a cron job" infra
    │   │   ├── archival.worker.ts           # orchestrates one nightly archival run per region
    │   │   ├── archival.helpers.ts          # the per-table batch-move loop + JSON-column handling
    │   │   └── archival.types.ts            # ArchivalTableSpec / ArchivalRunResult types
    │   ├── knex/                             # db(region) (hot) / dbArchive(region) (archive) connections
    │   ├── logger/                            # structured JSON logger
    │   ├── messaging/                          # AMQP connection lifecycle
    │   ├── rbac/                                # read-through permission cache backed by core-service
    │   ├── sharding/                             # region resolver (query > JWT > header) + region list
    │   ├── validation/                            # validateBody(DTO, req.body)
    │   └── websocket/                              # socket.io server, channel auth, Redis adapter wiring
    │
    ├── pkg/                     # framework- and app-agnostic — no imports from lib/ or app/, no env
    │   ├── cache/                 # ICacheProvider interface + the ioredis implementation
    │   ├── messaging/               # IMessageBroker interface + the amqplib/RabbitMQ client
    │   ├── payments/                  # IPaymentProvider interface + the Kashier HTTP client
    │   └── utils/                      # money.ts (minor-unit helpers), time.ts (date helpers), retry.ts
    │
    └── migrations/               # knex migrations — raw SQL in up()/down(), snake_case tables/columns
```

See [`docs/folder-structure.md`](./docs/folder-structure.md) for the fully annotated version and the `pkg → lib → app` layering rules, and [`CLAUDE.md`](./CLAUDE.md) §3–§5 for the naming/module conventions every new file follows.

---

## Environment variables

The full, current list — with inline comments explaining each one — lives in [`.env.example`](./.env.example). A few patterns worth knowing:

- **Per-region shard config** is dynamic, not fixed keys in the schema: for every code in `REGIONS`, the app expects `DB_<region>_HOST/PORT/USERNAME/PASSWORD/NAME` (hot) and `ARCHIVE_DB_<region>_HOST/PORT/USERNAME/PASSWORD/NAME` (archive). Add a region to `REGIONS` and its two DB blocks, and it's live.
- **Region is never in the JWT.** It's resolved per-request from `?region=` query, then `X-Region` header, then a `region` cookie. `all` is preserved for specific admin fan-out reads; writes always resolve to one concrete region.
- Everything is validated by `zod` in `src/lib/config/env.ts` at process boot — a missing required var fails fast with a clear error instead of an obscure runtime crash later.

---

## Further reading

| Doc | Purpose |
| --- | --- |
| [`CLAUDE.md`](./CLAUDE.md) | The full conventions doc: layering rules, naming, response DTOs, performance/indexing rules, what's out of scope. |
| [`docs/README.md`](./docs/README.md) | Reading order for the rest of the docs. |
| [`docs/system-design.md`](./docs/system-design.md) | Architecture: regions, Redis layers, sync/async with core, Kashier, WebSocket. |
| [`docs/database-design.md`](./docs/database-design.md) | Full schema, FKs, indexes (each justified), sharding plan. |
| [`docs/api-contracts.md`](./docs/api-contracts.md) | Every endpoint's request/response DTOs and error codes. |
| [`docs/business-logic/`](./docs/business-logic) | One file per module: lifecycle, invariants, RBAC. |
| [`docs/implementation-plan.md`](./docs/implementation-plan.md) | The phased build order this service was actually built in. |

> Some of the `docs/` files describe the original design (written before/during implementation) and drift from the shipped code in a few small places — e.g. a standalone `POST /payments/init` was planned but the shipped flow folds it into order placement instead, and refunds are designed but not yet built. This README describes what's actually implemented; treat `docs/` as the design rationale, and the code (or this file) as the source of truth for current behavior.

## Testing

There's no automated test suite yet. `play/` holds gitignored, throwaway scripts used to manually verify behavior against a real running stack (Postgres/Redis/RabbitMQ/core-service) — see [`play/README.md`](./play/README.md) for what each one checks. They're a reference for how to exercise the service directly, not something to run in CI.
