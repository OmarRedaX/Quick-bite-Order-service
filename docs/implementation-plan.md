# Implementation Plan — `order-service`

Sequenced build order. **Every module is built end-to-end (migration → entity → DTOs → repo → service → controller → routes → mount) before the next module begins.** That keeps every checkpoint shippable and testable.

Acceptance for each phase: the relevant endpoints respond with the documented contract on a local Postgres + Redis stack, idempotency works, RBAC denies the right calls, and (where applicable) WebSocket clients receive the documented events.

> **Parallel work on `core-service`.** This service depends on new endpoints, new RBAC permissions, a new API-key / HMAC auth guard, and an outbound webhook publisher on `core-service`. Each phase below has a **"Core-service changes required"** section. Do not start a phase until its core-service counterpart is in place.

---

## Phase 0 — Scaffolding (no business logic)

Goal: a runnable Express app with the same conventions as `core-service` plus the new infra (country sharding, WS server, core-client, RabbitMQ consumer for inbound core events). No domain modules yet. Anything later phases might need is installed here so they only write business code.

### 0.1 Project bootstrap

1. `package.json` — copy core's deps; add `ws` and `amqplib`. No new lockfile beyond what's required.
2. `tsconfig.json` — copy core verbatim.
3. `.env` & `.env.example`:
   ```
   PORT=4000
   ACCESS_SECRET=...                  # MUST match core
   REFRESH_SECRET=...
   DB_MIGRATION_DIRECTORY=src/migrations
   DB_MIGRATION_EXTENSION=ts
   REGIONS=eg,ksa
   DB_eg_HOST=localhost
   DB_eg_PORT=5432
   DB_eg_USERNAME=postgres
   DB_eg_PASSWORD=...
   DB_eg_NAME=order_service_eg
   DB_ksa_HOST=...
   DB_ksa_PORT=5432
   DB_ksa_USERNAME=postgres
   DB_ksa_PASSWORD=...
   DB_ksa_NAME=order_service_ksa
   DB_POOL_MAX=10
   # archive cluster — same shape, separate hosts; used starting Phase 7
   ARCHIVE_DB_eg_HOST=...
   ARCHIVE_DB_eg_NAME=order_service_archive_eg
   ARCHIVE_DB_ksa_HOST=...
   ARCHIVE_DB_ksa_NAME=order_service_archive_ksa
   REDIS_HOST=localhost
   REDIS_PORT=6379
   # RabbitMQ (inbound core events)
   RABBITMQ_URL=amqp://order-service:<secret>@localhost:5672/quickbite
   RABBITMQ_CORE_EVENTS_EXCHANGE=core.events
   RABBITMQ_CORE_EVENTS_QUEUE=order-service.core-events
   RABBITMQ_CORE_EVENTS_BINDINGS="product.#,branch.#,restaurant.#,rbac.#"
   RABBITMQ_CORE_EVENTS_DLX=core.events.dlx
   RABBITMQ_CORE_EVENTS_DLQ=order-service.core-events.dlq
   RABBITMQ_PREFETCH=32
   # core-service integration
   CORE_SERVICE_BASE_URL=http://localhost:3000
   CORE_INTERNAL_API_KEY=...            # sent on every outbound sync call to core
   # kashier
   KASHIER_BASE_URL=https://api.kashier.io
   KASHIER_MERCHANT_ID=...
   KASHIER_API_KEY=...
   KASHIER_WEBHOOK_SECRET=...
   KASHIER_RETURN_URL=https://app.quickbite.io/checkout/return
   KASHIER_FAIL_URL=https://app.quickbite.io/checkout/failed
   PAYMENT_SESSION_TIMEOUT_MIN=15
   # deliveries/assignment
   ASSIGNMENT_RADIUS_METERS=5000
   AGENT_ACCEPT_TIMEOUT_SEC=30
   MAX_REASSIGNMENT_ATTEMPTS=3
   PRESENCE_STALE_SEC=90
   # websocket
   WS_HEARTBEAT_SEC=30
   ```
4. `src/lib/config/env.ts` — zod schema covering all of the above; parses `REGIONS` and pulls the per-region DB triples.

### 0.2 Copy-from-core infra (verbatim unless noted)

5. `src/lib/error/AppError.ts`, `errorHandler.ts`.
6. `src/lib/logger/logger.ts`.
7. `src/lib/correlation/correlationId.ts`.
8. `src/lib/http/response.ts`, `pagination/cursor-pagination.ts`, `pagination/parse-query.ts`.
9. `src/lib/validation/validate.ts`.
10. `src/lib/types/express.d.ts` — **extend** Request with `region?: string` and `user?` (no `region` claim on `user`).
11. `src/pkg/cache/cache.interface.ts`, `redis.ts`.
12. `src/pkg/utils/time.ts`. **Add** `money.ts` (`toMinor`, `fromMinor`, `sumMinor`) and `retry.ts` (exponential backoff).
13. `src/lib/cache/init.ts`, `withCache.ts`.
14. `src/lib/auth/guard.ts`, `rbac.ts`, `errors.ts`, `jwt.ts` — copy core. JWT secrets match so tokens issued by core are accepted here.
15. `src/lib/idempotency/idempotency.ts` — copy core. Leave the DB-fallback hook disabled until the `idempotency_keys` table lands in Phase 1.
16. `src/lib/di/tokens.ts`, `container.ts` — empty bootstrap; tokens and registrations are added by later phases.

### 0.3 New infra (sharding, core-client, RabbitMQ consumer, WS)

17. `src/lib/sharding/regions.ts` — canonical country list (from env), helpers `isRegion(s)`.
18. `src/lib/sharding/region-resolver.ts` — Express middleware that sets `req.region` from the **`X-Region` header** only (no path/query/cookie/JWT fallback). `req.region = "all"` is allowed only for admin fan-out reads; writes require a concrete region. `requireRegion` throws `RegionNotResolvedError` (400) when unresolved.
19. `src/lib/knex/shards.ts` — builds `Map<region, Knex>` lazily for the **hot** cluster, and a parallel `Map<region, Knex>` for the **archive** cluster (will be consumed only in Phase 7; functions created now to avoid re-wiring later).
20. `src/lib/knex/knex.ts` — exports `db(region: string): Knex` and `dbArchive(region: string): Knex`. Exports `pingAll()` for health.
21. `src/lib/knex/knexfile.ts` — base config; wraps a script `npm run migrate:all` that iterates regions.
22. `src/lib/core-client/core-client.ts` — **base** `fetch` wrapper:
    - Sets `api-key: ${env.core.internalApiKey}` header on every request.
    - Forwards `X-CorrelationId`.
    - Retries 3x with exponential backoff on 5xx / network errors, capped at 500ms.
    - Translates non-2xx to `AppError`.
    - **Does not** yet import any endpoint wrappers — those (branch/product/permission/address clients) are added in their respective module phases. This file is the only addition in Phase 0.
23. `src/pkg/messaging/message-broker.interface.ts` — `IMessageBroker { connect, consume, close, declareTopology, publish }`. App-agnostic.
    `src/pkg/messaging/rabbitmq/rabbitmq.client.ts` — wraps `amqp-connection-manager`: auto-reconnect, publish buffering on disconnect, topology re-declaration on reconnect. No hand-rolled backoff loop.
24. `src/lib/messaging/init.ts` — singleton broker instance (`amqp-connection-manager`-based `RabbitMQClient`). Topology (`core.events` exchange, `order-service.core-events` durable queue with DLX args, bindings, DLQ) is declared inline by `startCoreEventsConsumer` at boot — no separate `topology.ts`.
25. `src/lib/core-events/consumer.ts` — the AMQP consumer loop:
    - On each message: `cache.trySet("core-events:dedupe:<eventId>", "1", 86400)` — SETNX in Redis.
    - If not fresh (key already exists) → ack, skip.
    - Else dispatch to a registry: `handlers[eventType](payload)`. Registry starts empty; modules register handlers in later phases.
    - On success → ack.
    - On handler throw → nack with `requeue=false` (message flows to DLQ).
26. `src/lib/core-events/types.ts` — `CoreEventEnvelope`, `CoreEventHandler` type alias `(payload) => Promise<void>`. No SQL log repo.
27. `src/lib/websocket/` — **socket.io scaffold**:
    - `ws-server.ts` — `attachWsServer(httpServer)` mounts a socket.io server on `/ws`, installs `@socket.io/redis-adapter` using the shared `redisClient` (+ a duplicate for the subscriber). Auth middleware validates the JWT handshake and stashes `socket.data.user` + `socket.data.allowed`.
    - `ws-auth.ts` — JWT verify + permitted-room derivation (`customer:<userId>`, `restaurant:<restaurantId>`, `branch:<branchId>` per branch, `agent:<agentId>`).
    - `errors.ts` — `WsNoTokenError` etc.
    - Services emit via `io.to(room).emit(event, payload)`; the Redis adapter does cross-worker fan-out. The `io` instance is registered at `TOKENS.WsServer` from `server.ts`.
28. `src/app/health/health.routes.ts` — `GET /api/health` calls `pingAll()` (hot clusters only for now).
29. `src/routes.ts` — mounts `/api/health`. (No inbound HTTP webhook route — core→order traffic is RabbitMQ.)
30. `src/app.ts`, `src/server.ts` — copy core. `server.ts` additionally:
    - Calls `pingAll()` at boot.
    - Attaches the socket.io server to the shared `http.Server`, registers `TOKENS.WsServer`.
    - Connects to RabbitMQ and starts the `core-events` consumer (`startCoreEventsConsumer` declares topology inline).

### 0.4 No migrations in Phase 0

Phase 0 creates no tables. Core-event dedupe lives in Redis; all domain tables land in the phase that consumes them.

### 0.5 `core-service` changes required before Phase 0 ships

These belong on `core-service` and must land before this service's Phase 0 is considered complete.

1. **Seed new RBAC permissions** (new migration in `core-service/src/migrations/`):

   ```sql
   INSERT INTO permissions (resource, action, created_at) VALUES
     -- Orders
     ('orders',     'read',   NOW()),
     ('orders',     'accept', NOW()),
     ('orders',     'update',        NOW()),
     ('orders',     'cancel',        NOW()),
     -- Payments
     ('payments',   'read',          NOW()),
     ('payments',   'refund',        NOW()),
     -- Deliveries (admin-only)
     ('deliveries', 'assign',        NOW()),
     -- Finance
     ('finance',    'read',          NOW()),
     ('finance',    'payout_create', NOW())
   ON CONFLICT (resource, action) DO NOTHING;
   ```

   Role mapping (extend the existing seed):

   - `owner` → all of the above.
   - `branch_manager` → `orders:read, orders:accept, orders:update, orders:cancel, finance:read`.
   - `staff` → `orders:read, orders:update, orders:accept`.
   - `payments:refund` and `finance:payout_create` are admin-bypassed today; seeded for future extensibility.
2. **Add `restaurant_branches.delivery_fee INT NOT NULL DEFAULT 0`** (minor units of the branch currency) in core. This service reads it via `GET /api/internal/branches/:id` at checkout.
3. **Internal API-key auth guard** (for sync HTTP calls **from** this service **to** core):

   - New env on core: `INTERNAL_API_KEY=<secret>` (single shared secret). Matched by `CORE_INTERNAL_API_KEY` on this service's side.
   - New middleware `src/lib/auth/api-key.ts` that compares the `api-key` request header against `env.internal.apiKey` (plain equality — the broker/gateway is the trust boundary).
   - Each domain module mounts its own internal routes inline in its `routes.ts` under the `/internal/...` prefix, guarded by `requireInternalApiKey`. There is **no** dedicated `app/internal/` module.
4. **Transactional outbox on core** (`src/lib/events/` in core):

   - New env on core: `RABBITMQ_URL`, `RABBITMQ_CORE_EVENTS_EXCHANGE=core.events`, `OUTBOX_DRAIN_CRON="* * * * * *"`, `OUTBOX_BATCH_SIZE=50`.
   - New migration: `events_outbox` table on core's DB (`id, aggregate_type, aggregate_id, event_type, event_id, payload JSONB, created_at, dispatched_at, attempts, last_error`).
   - **Service layer** (never repo) writes the outbox row in the same DB transaction as the domain write. Repos never call `insertOutboxEvent`.
   - The drain lives in a **separate worker process** (`src/worker.ts`), not in the API. `croner` schedules `drainOutbox()`; `drainOutbox` claims a batch with `FOR UPDATE SKIP LOCKED`, publishes with **publisher confirms**, stamps `dispatched_at` on broker ACK. SKIP LOCKED makes N workers safe in parallel.
   - The `core.events` topic exchange is declared by the worker at boot.
5. **Secrets hygiene**: `KASHIER_WEBHOOK_SECRET` (this service), `INTERNAL_API_KEY` (one shared secret between core and order-service today), and RabbitMQ credentials are three different secrets with three different lifecycles. Do not conflate them.

### Acceptance (Phase 0)

- `npm run dev` starts, `GET /api/health` returns OK against every configured shard.
- On boot, the `core-events` consumer declares the queue + bindings + DLQ and begins consuming. Publishing a test message to `core.events` with routing key `product.test` (unregistered type) is consumed, logged as "no handler, acking", and acked — unknown types are not sent to DLQ.
- Killing RabbitMQ and restarting this service: `amqp-connection-manager` reconnects automatically and re-declares topology; no crash.
- On the core side, `npm run worker:dev` boots the outbox worker; inserting a row into `events_outbox` is drained within ~1s and shows up in this service as a Redis dedupe key `core-events:dedupe:<eventId>`.
- A socket.io client connects to `ws://localhost:4000` with `path: "/ws", auth: {token}`, emits `subscribe(channel, ack)`, and a server-side `io.to(channel).emit(event, payload)` reaches the client.

---

## Phase 1 — Orders module (the spine)

### Migrations

- `20260418000020_create_orders.ts`
- `20260418000030_create_order_items.ts`
- `20260418000100_create_idempotency_keys.ts`

### Code

1. Migrations above (each in every region).
2. Entities: `OrderEntity`, `OrderItemEntity`.
3. Request DTOs: `CreateOrderRequestDTO`, `UpdateOrderStatusRequestDTO`, query DTOs (or use `parsePaginationQuery`).
4. Response DTOs: `OrderResponseDTO`, `OrderItemResponseDTO`, `OrderSummaryResponseDTO`, `OrderDetailResponseDTO`, `OrderStatusResponseDTO`.
5. Repos:
   - `order.repo.ts` — `createOrder`, `findOrderByPublicId`, `findOrdersByCustomer`, `findOrdersByBranch`, `updateOrderStatus`, `setDeliveryAgent`. Each accepts `conn: Knex`.
   - `order-item.repo.ts` — `bulkInsertItems`, `findItemsByOrderIds(orderIds[])` (batch — guards against N+1).
   - `idempotency-store.ts` — `tryGet`, `store`. Activate the DB-fallback hook in `lib/idempotency/idempotency.ts` now that the table exists.
6. `order-status.service.ts` — pure helper: `assertTransition(from, to, actor)` table-driven from `enums.ts`.
7. `order.service.ts` —
   - `placeOrder(...)` per Orders.md §2 (validate via core-client cached → compute money → trx → after-commit reserveStock).
   - `getOrder(...)`: by publicId; ownership check; loads items batch + payment summary (joins).
   - `listCustomerOrders(...)`, `listRestaurantOrders(...)` with cursor pagination.
   - `updateStatus(...)`: validates transition, stamps timestamp, publishes WS (WS publisher is wired; events are emitted but the client wiring test moves to Phase 6).
8. `order.controller.ts` — wire `validateBody`, `sendSuccess`/`sendPaginated`, response DTOs.
9. `routes.ts` — `authenticate`, `idempotency({strict:true})` on `POST /orders`, `withCache(10)` on `GET /restaurant/orders` per branch+status.
10. Register controller + service in DI container. Mount in `src/routes.ts`.
11. **Core-client endpoint wrappers added now**:
    - `branch.client.ts` — `getBranch`, `getBranchProducts(branchId, productIds[])`, `reserveStock(branchId, items[])`.
    - `address.client.ts` — `getCustomerAddress(id)`.
12. **Register core-event handlers** (in the Phase 0 consumer registry):
    - `product.stock.changed` → invalidate `core:product:price:*` and `core:product:stock:*` for the affected branch+product.
    - `product.price.changed` → invalidate `core:product:price:<branchId>:<productId>`.
    - `branch.updated` / `branch.deactivated` → invalidate `core:branch:<branchId>`; `branch.deactivated` additionally sets a Redis flag that the orders service checks to reject new orders to that branch.
    - `restaurant.suspended` → invalidate `core:restaurant:<id>`; mark pending orders for that restaurant for review.

### Core-service changes required

All of the following go under `/api/internal/*` (guarded by the API-key middleware from Phase 0) unless noted.

- `GET /api/internal/branches/:id` — branch metadata: `{ id, region, restaurantId, restaurantStatus, acceptOrders, isActive, deliveryFee, commissionBps, currency, lat, lng, name, addressText }`. Lives on the branch module's router (inline internal route).
- `GET /api/internal/branches/:id/products?ids=1,2,3` — batch price + stock + availability + name + image URL for the requested product IDs. Lives on the product module's router.
- `POST /api/internal/branches/:id/reserve-stock` — body `{ items: [{ productId, quantity }] }`. Atomic decrement inside one core-service DB trx; returns 409 with offending items on underflow. Idempotent via `Idempotency-Key`. Lives on the product module's router.
- `GET /api/internal/customer-addresses/:id` — returns `{ id, userId, lat, lng, addressText, city, country, building, apartmentNumber, label }` for the delivery snapshot. Lives on the customer-address module's router.
- `GET /api/internal/agents/:id` — returns `{ id, name, phone }` for an agent. Lives on the user module's router.
- `GET /api/internal/rbac/permissions?role=<name>` — returns the permission list for a role (used by the RBAC cache). Lives on the rbac module's router.
- **Wire outbox inserts in the service layer** (never the repo): in the same DB trx as every mutation to `products`, `product_branch_details`, `restaurant_branches`, `restaurants` and `role_permissions`, the owning service calls `insertOutboxEvent(trx, ...)` with the corresponding `event_type` — `product.stock.changed`, `product.price.changed`, `branch.updated`, `branch.deactivated`, `restaurant.suspended`, `rbac.permissions_changed`. The worker process drains and publishes to `core.events`.

### Acceptance

- `POST /orders` with COD creates an order, returns 201, items are persisted.
- Same idempotency key returns the same response; different body → 409.
- `PATCH /orders/{id}/status` accept→preparing→ready works; reject from preparing fails; customer cancel after `accepted_at + 60s` fails.
- `GET /restaurant/orders?branchId=&status=placed` returns expected list; `EXPLAIN` shows index usage.
- Triggering `product.stock.changed` in core (service mutation → outbox insert in same trx → worker drains → `core.events`) is consumed here and deletes the right Redis keys. Replay of the same `eventId` is a no-op (dedupe via Redis SETNX on `core-events:dedupe:<eventId>`).

---

## Phase 2 — Payments module

### Migrations

- `20260418000010_create_payment_providers.ts` (with seed `kashier`, `cod`).
- `20260418000040_create_payment_sessions.ts`.
- `20260418000050_create_transactions.ts`.
- `20260418000110_create_payment_webhook_events.ts`.

### Code

1. Kashier provider in `pkg/`:
   - `pkg/payments/payment.interface.ts` (`createSession`, `refund`, `verifyWebhook`).
   - `pkg/payments/kashier/kashier.client.ts` — HTTP client for Kashier v3.
   - `pkg/payments/kashier/kashier.signature.ts` — HMAC.
   - `pkg/payments/kashier/kashier.types.ts` — provider DTOs.
2. Entities: `PaymentSessionEntity`, `TransactionEntity`, `PaymentProviderEntity`.
3. Request DTOs: `InitPaymentRequestDTO`, `RefundRequestDTO`.
4. Response DTOs: `PaymentInitResponseDTO`, `PaymentResponseDTO`.
5. Repos: `payment-session.repo.ts`, `transaction.repo.ts`, `payment-webhook-event.repo.ts`, `payment-provider.repo.ts`.
6. `kashier-webhook.service.ts` — verify signature, dedupe by `(provider_id, provider_event_id)`, advance session/transaction/order in trx.
7. `payment.service.ts` — `init`, `getById`, `refund`.
8. Controllers: `payment.controller.ts` (auth'd) and `webhook.controller.ts` (no auth).
9. `routes.ts` — `/payments/init`, `/payments/webhook/:provider` (no auth), `/payments/:id`, `/payments/:id/refund`. Idempotency strict on init and refund.
10. **Cross-module update** in Orders: on `paymentMethod='online'`, optionally invoke `payment.service.init` to attach the `redirectUrl` on the `POST /orders` response. Clients may also call `POST /payments/init` separately.

### Core-service changes required

- None strictly required for this phase. If we want core to be notified of `payment.refunded` or `payment.captured` later, that's a separate change; we don't emit anything outbound in this milestone.

### Acceptance

- `POST /payments/init` creates a Kashier session (mock in tests), persists `payment_sessions`.
- Webhook end-to-end: signed payload → order moves to `placed`, transaction recorded. Duplicate webhook → 200 with no side effect.
- Refund flow: POST → Kashier mock 2xx → transaction `pending` → simulated webhook → `succeeded`, charge marked `is_refunded`.

---

## Phase 3 — Deliveries module

### Migrations

- `20260418000060_create_restaurant_balances.ts`.
- `20260418000070_create_deliveries.ts`.

### Code

1. Entities: `DeliveryEntity`, `RestaurantBalanceEntity`.
2. Request DTOs: `AssignDeliveryRequestDTO`, `UpdateDeliveryStatusRequestDTO`.
3. Response DTOs: `DeliveryResponseDTO`, `DeliveryStatusResponseDTO`, `DeliverySummaryResponseDTO`.
4. Repos: `delivery.repo.ts`, `restaurant-balance.repo.ts` (with `forUpdate` helper).
5. `assignment.service.ts` — implements Deliveries.md §2 algorithm. Uses a **Postgres-only** candidate scan in this phase (Redis presence layer arrives in Phase 4).
6. `delivery.service.ts` — `assign`, `reassign`, `updateStatus`. `delivered` runs the **settlement trx** (see Restaurant-finance.md §7 / Deliveries.md §5).
7. Controller + routes.
8. **Cross-module hook**: `order.service.updateStatus` for target `ready` enqueues `assignment.service.tryAssign(orderId)` in-process after commit.

### Core-service changes required

- `GET /api/internal/users/:id?role=delivery_agent` (or a dedicated `GET /api/internal/agents/:id`) — returns `{ id, name, phone }` for display on the customer app when a delivery is assigned. Same API-key guard.

### Acceptance

- Order moved to `ready` triggers a delivery assignment (manual path with `agentId` works; auto path uses Postgres GIST until Phase 4).
- Agent flow `accept → picked → delivered` works.
- On `delivered`: `restaurant_balances.balance` increases by `subtotal - commission`; `transactions(commission)` row exists; `agent_earnings` row will be inserted in Phase 4 (stubbed here).
- COD: pending `cod_collection` flips to `succeeded`.
- Reassignment increments the chain; `MAX_REASSIGNMENT_ATTEMPTS` enforced.

---

## Phase 4 — Agents module

### Migrations

- `20260418000080_create_agent_presence.ts` (PostGIS extension + table + partial GIST index).
- `20260418000090_create_agent_earnings.ts`.

### Code

1. Entities: `AgentPresenceEntity`, `AgentEarningEntity`.
2. Request DTOs: `PresenceOnlineRequestDTO` (lat, lng); reuse for ping.
3. Response DTOs: `AgentEarningsResponseDTO`, `DeliveryTaskResponseDTO`.
4. Repos: `agent-presence.repo.ts` (UPSERT), `agent-earning.repo.ts`.
5. `presence.service.ts` — UPSERT Postgres; **also** maintain Redis (`presence:geo:<region>`, `presence:meta:<region>:<agentId>`, `presence:busy`).
6. `earning.service.ts` — list + sum.
7. `agent.service.ts` — task list (via `delivery.repo`).
8. Controllers + routes.
9. **Plug Redis presence into `assignment.service`**: switch the candidate scan to Redis with Postgres fallback. Add `agent_earnings` insert into the `delivered` settlement trx from Phase 3.
10. Stale-presence cleanup inside the request path only (no background worker yet — Phase 7 covers workers).

### Core-service changes required

- Confirm `delivery_agent` as a `system_role` (already exists per `core-service`'s seed).
- Nothing new — all agent identity lookups use the `GET /api/internal/agents/:id` added in Phase 3.

### Acceptance

- Presence ping updates both Postgres and Redis.
- Going offline rejects if the agent is in an active delivery.
- `GET /agents/tasks` and `/agents/earnings` work; cursor pagination respected.
- Auto-assignment reads from Redis in the hot path; Postgres fallback works when Redis is cold.

---

## Phase 5 — Restaurant Finance module

No new migrations.

### Code

1. Entities reuse `RestaurantBalanceEntity` and `TransactionEntity`.
2. DTOs: `RestaurantBalanceResponseDTO`, `PayoutResponseDTO`, `CreatePayoutRequestDTO`.
3. Repos: extend `transaction.repo.ts` with `findPayouts(restaurantId, from, to, paginationParams)`.
4. `finance.service.ts` — `getBalance`, `listPayouts`, `recordPayout` (admin).
5. Controller + routes for `/restaurant/balance`, `/restaurant/payouts`.
6. Idempotency strict on `POST /restaurant/payouts`.

### Core-service changes required

- The `finance:read` permission must already be seeded (from Phase 0 core seed). Mapped to `owner` and `branch_manager`.

### Acceptance

- Owner and manager can read balance + payouts; staff cannot.
- Admin can record a payout; balance decrements; same idempotency key returns the same payout.
- Payout > balance → 409 `InsufficientBalance`.

---

## Phase 6 — WebSocket event wiring

The WS server, hub, auth, and publisher already exist from Phase 0. This phase wires **events** from existing services into that publisher.

1. **In `order.service`**:
   - `placeOrder` → `branch:<id>:order.created` (COD) after commit; for online this is deferred until `payment.captured` in the webhook service.
   - `updateStatus` → `customer:<id>` and `branch:<id>` `order.status_changed`.
2. **In `payment.service` / `kashier-webhook.service`**:
   - On `captured`: `customer:<id>:order.status_changed` (to `placed`) and `branch:<id>:order.created`.
   - On `failed`: `customer:<id>:payment.failed`.
3. **In `delivery.service`**:
   - `assign` → `agent:<id>:task.assigned`.
   - `updateStatus` → `customer:<id>` and `branch:<id>` `delivery.status_changed`.
4. **In `presence.service`**:
   - During `ping`, if the agent has an active delivery, publish `customer:<id>:delivery.position`.
5. **Channel-permission guards**:
   - Harden `ws-auth.ts` permitted-channel computation against new channels (admin alert channel).

### Core-service changes required

- None — WS is end-user facing, not inter-service.

### Acceptance

- A customer client connects, subscribes to `customer:<id>`, places a COD order, and receives `order.created` without polling.
- A branch client receives `order.created` events for its branch only.
- An unauthorized channel subscription closes the socket with the documented code.

---

## Phase 7 — Cold archival worker (the only background worker)

### Goal

Every night, move rows whose `created_at` is in a **prior year** from the hot cluster to the archive cluster per region. Keep the hot DB small enough that current-year queries stay fast.

### Migrations

- None in the hot cluster. The archive cluster runs the same migration set as the hot cluster (hot cluster schema == archive cluster schema). Run `npm run migrate:all --cluster=archive` once per region.

### Code

1. `lib/jobs/archival.worker.ts` — one instance per region, scheduled nightly (simple `setInterval` + guard on a Redis lock `archival:<region>:lock` to avoid duplicate runs if multiple processes start):
   - Walk tables in FK-safe order: `agent_earnings → deliveries → payment_webhook_events → payment_sessions → transactions → order_items → orders`.
   - For each table, loop in batches of 1000 rows where `created_at < date_trunc('year', NOW())`:
     - Begin trx on hot + trx on archive.
     - `SELECT ... FROM hot WHERE id IN (...)` / `INSERT ... INTO archive` / `DELETE FROM hot WHERE id IN (...)`.
     - Commit archive first, then hot (so a crash mid-move leaves the row in both places, which is safer than in neither; a re-run then re-inserts with `ON CONFLICT DO NOTHING`).
   - Respect a max runtime per night (env `ARCHIVAL_MAX_RUNTIME_MIN`, default 60).
   - Emit structured log lines per batch (rows moved, table, region, duration).
2. **Read-path routing** updates:
   - `GET /customer/orders?year=YYYY` and `GET /restaurant/orders?from&to`: if the requested range is entirely in prior years → route reads to `dbArchive(region)` instead of `db(region)`. If the range straddles the boundary → split the query in the service, merge results in the DTO layer (rare path; document the fan-out).
   - `GET /orders/{publicId}`: try hot first; if not found and the request is for an admin or owner, retry on archive. Keep this path off the critical customer-order-tracking flow.
3. Archive-cluster knex connections registered in `lib/knex/shards.ts` (slot already reserved since Phase 0).

### Core-service changes required

- None.

### Acceptance

- Seed 5,000 orders in the hot cluster, half of them dated prior year.
- Run the archival worker once.
- Hot cluster has only current-year rows; archive cluster has the prior-year rows.
- `GET /customer/orders?year=<priorYear>` returns rows from the archive cluster; `EXPLAIN` shows it's hitting the archive.
- Re-running the worker is a no-op (nothing left to move; logs say `moved=0`).
- Killing the worker mid-batch and restarting it does not duplicate rows (archive inserts use `ON CONFLICT DO NOTHING`).

---

## Build cadence summary

```
Phase 0  Scaffolding (WS base, core-client base, inbound core webhook route)
Phase 1  Orders                      ───►  COD orders end-to-end
Phase 2  Payments + Kashier          ───►  online orders end-to-end
Phase 3  Deliveries + settlement     ───►  full money flow on delivered
Phase 4  Agents + presence           ───►  auto-assignment on Redis
Phase 5  Restaurant finance          ───►  owner/admin financial views
Phase 6  WebSocket event wiring      ───►  real-time everywhere
Phase 7  Cold archival worker        ───►  hot DB stays small
```

Each phase is shippable. No phase mixes modules. No phase is started until the previous phase's acceptance is checked AND the matching **"Core-service changes required"** for that phase (listed inline above) are in place.
