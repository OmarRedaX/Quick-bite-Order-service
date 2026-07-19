# Folder Structure — `order-service`

Mirrors `core-service` exactly. The differences are documented inline.

---

## Tree (target end state)

```
order-service/
├── .env
├── .gitignore
├── package.json
├── tsconfig.json
├── CLAUDE.md
├── docs/
│   ├── api-contracts.md
│   ├── business-logic/
│   │   ├── orders.md
│   │   ├── payments.md
│   │   ├── deliveries.md
│   │   ├── agents.md
│   │   ├── restaurant-finance.md
│   │   └── rbac.md
│   ├── database-design.md
│   ├── folder-structure.md
│   ├── implementation-plan.md
│   └── system-design.md
└── src/
    ├── app.ts                       # express composition (cors, helmet, json, cookie, correlation, routes, errorHandler)
    ├── server.ts                    # bootstrap: HTTP server + WebSocket attach + archival worker start + graceful shutdown
    ├── routes.ts                    # mounts all module routers under /api
    │
    ├── app/                         # business modules
    │   ├── health/
    │   │   └── health.routes.ts
    │   │
    │   ├── order/
    │   │   ├── controller/order.controller.ts
    │   │   ├── service/order.service.ts
    │   │   ├── service/order-status.service.ts        # status machine helpers
    │   │   ├── repository/order.repo.ts
    │   │   ├── repository/order-item.repo.ts
    │   │   ├── entity/order.entity.ts
    │   │   ├── entity/order-item.entity.ts
    │   │   ├── dto/order.request.dto.ts
    │   │   ├── dto/order.response.dto.ts
    │   │   ├── dto/order-item.response.dto.ts
    │   │   ├── enums.ts
    │   │   ├── errors.ts
    │   │   └── routes.ts
    │   │
    │   ├── payment/
    │   │   ├── controller/payment.controller.ts
    │   │   ├── controller/webhook.controller.ts        # /payments/webhook/:provider (no auth)
    │   │   ├── service/payment.service.ts
    │   │   ├── service/kashier-webhook.service.ts
    │   │   ├── repository/payment-session.repo.ts
    │   │   ├── repository/transaction.repo.ts
    │   │   ├── repository/payment-webhook-event.repo.ts
    │   │   ├── repository/payment-provider.repo.ts
    │   │   ├── entity/payment-session.entity.ts
    │   │   ├── entity/transaction.entity.ts
    │   │   ├── dto/payment.request.dto.ts
    │   │   ├── dto/payment.response.dto.ts
    │   │   ├── dto/transaction.response.dto.ts
    │   │   ├── enums.ts
    │   │   ├── errors.ts
    │   │   └── routes.ts
    │   │
    │   ├── delivery/
    │   │   ├── controller/delivery.controller.ts
    │   │   ├── service/delivery.service.ts
    │   │   ├── service/assignment.service.ts          # auto + manual + reassign logic
    │   │   ├── repository/delivery.repo.ts
    │   │   ├── entity/delivery.entity.ts
    │   │   ├── dto/delivery.request.dto.ts
    │   │   ├── dto/delivery.response.dto.ts
    │   │   ├── enums.ts
    │   │   ├── errors.ts
    │   │   └── routes.ts
    │   │
    │   ├── agent/
    │   │   ├── controller/agent.controller.ts
    │   │   ├── controller/presence.controller.ts
    │   │   ├── service/agent.service.ts
    │   │   ├── service/presence.service.ts
    │   │   ├── service/earning.service.ts
    │   │   ├── repository/agent-presence.repo.ts
    │   │   ├── repository/agent-earning.repo.ts
    │   │   ├── entity/agent-presence.entity.ts
    │   │   ├── entity/agent-earning.entity.ts
    │   │   ├── dto/presence.request.dto.ts
    │   │   ├── dto/agent.response.dto.ts
    │   │   ├── enums.ts
    │   │   ├── errors.ts
    │   │   └── routes.ts
    │   │
    │   └── restaurant-finance/
    │       ├── controller/finance.controller.ts
    │       ├── service/finance.service.ts
    │       ├── repository/restaurant-balance.repo.ts
    │       ├── entity/restaurant-balance.entity.ts
    │       ├── dto/finance.response.dto.ts
    │       ├── errors.ts
    │       └── routes.ts
    │
    ├── lib/                          # app-aware glue
    │   ├── auth/
    │   │   ├── guard.ts             # authenticate (JWT cookie) — shared shape with core
    │   │   ├── rbac.ts              # rbac(), requireRestaurantMember, requireBranchAccess
    │   │   ├── errors.ts
    │   │   └── jwt.ts               # verifyAccessToken (same secret as core)
    │   ├── cache/
    │   │   ├── init.ts
    │   │   └── withCache.ts
    │   ├── config/
    │   │   └── env.ts               # zod-validated; adds region list + Kashier + WS config
    │   ├── correlation/
    │   │   └── correlationId.ts
    │   ├── core-client/             # NEW: sync HTTP client to core-service (base in Phase 0)
    │   │   ├── core-client.ts       # base fetch wrapper: retry, correlation, HMAC, errors
    │   │   ├── branch.client.ts     # endpoint wrappers — added in module phases
    │   │   ├── product.client.ts
    │   │   ├── permission.client.ts
    │   │   └── address.client.ts
    │   ├── core-events/             # NEW: inbound async from core-service (RabbitMQ)
    │   │   ├── consumer.ts           # AMQP consumer: declare queue, bind patterns, prefetch, manual-ack loop
    │   │   # dedupe lives in Redis (SETNX on `core-events:dedupe:<eventId>`); no SQL table
    │   │   └── handlers/             # one file per event_type, registered in a dispatch map
    │   │       ├── product-stock-changed.handler.ts
    │   │       ├── product-price-changed.handler.ts
    │   │       ├── branch-deactivated.handler.ts
    │   │       ├── branch-updated.handler.ts
    │   │       ├── restaurant-suspended.handler.ts
    │   │       └── rbac-permissions-changed.handler.ts
    │   ├── messaging/                # NEW: AMQP lifecycle
    │   │   ├── init.ts               # single connection; channel-per-consumer
    │   │   └── topology.ts           # exchange/queue/DLQ declarations (idempotent)
    │   ├── di/
    │   │   ├── container.ts
    │   │   └── tokens.ts
    │   ├── error/
    │   │   ├── AppError.ts
    │   │   └── errorHandler.ts
    │   ├── http/
    │   │   ├── response.ts          # sendSuccess, sendPaginated
    │   │   └── pagination/
    │   │       ├── cursor-pagination.ts
    │   │       └── parse-query.ts
    │   ├── idempotency/
    │   │   ├── idempotency.ts       # middleware (Redis + DB fallback)
    │   │   └── idempotency-store.ts # the DB-backed durable store
    │   ├── jobs/                    # NEW: background workers (Phase 7 only)
    │   │   └── archival.worker.ts   # nightly: moves rows older than current year to archive cluster
    │   ├── knex/
    │   │   ├── knex.ts              # db(region) → Knex (hot); dbArchive(region) (archive cluster)
    │   │   ├── knexfile.ts          # base config; per-region resolved at runtime
    │   │   └── shards.ts            # region → connection config (hot + archive)
    │   ├── logger/
    │   │   └── logger.ts
    │   ├── sharding/                # NEW: region resolver
    │   │   ├── region-resolver.ts   # request → region (X-Region header only; "all" allowed for admin fan-out reads)
    │   │   └── regions.ts           # canonical list + helpers
    │   ├── types/
    │   │   └── express.d.ts         # extends Request: user, correlationId, region
    │   ├── utils/
    │   │   └── cookie.ts
    │   ├── validation/
    │   │   └── validate.ts
    │   └── websocket/                # socket.io + @socket.io/redis-adapter (scaffold in Phase 0)
    │       ├── ws-server.ts          # attach socket.io to http.Server on /ws; wire Redis adapter + auth middleware
    │       ├── ws-auth.ts            # JWT verify + permitted-channel (room) derivation
    │       └── errors.ts             # WsNoTokenError, etc.
    │
    ├── pkg/                          # framework-agnostic, app-agnostic
    │   ├── cache/
    │   │   ├── cache.interface.ts
    │   │   └── redis.ts
    │   ├── messaging/                 # NEW: broker interface + RabbitMQ client
    │   │   ├── message-broker.interface.ts  # IMessageBroker: connect, consume, publish
    │   │   └── rabbitmq/
    │   │       ├── rabbitmq.client.ts # amqplib wrapper: connection, channels, consumer loop
    │   │       └── rabbitmq.types.ts  # internal types for bindings, DLQ args, etc.
    │   ├── payments/                  # NEW: provider interface + Kashier client
    │   │   ├── payment.interface.ts   # IPaymentProvider: createSession, refund, verifyWebhook
    │   │   └── kashier/
    │   │       ├── kashier.client.ts  # raw HTTP client for Kashier v3
    │   │       ├── kashier.types.ts   # provider-side request/response types
    │   │       └── kashier.signature.ts # HMAC verify
    │   └── utils/
    │       ├── time.ts
    │       ├── money.ts               # NEW: minor-unit helpers (toMinor, fromMinor, sumMinor)
    │       └── retry.ts               # NEW: exponential backoff helper
    │
    └── migrations/                   # knex migrations (raw SQL inside `up`/`down`)
        ├── 20260418000010_create_payment_providers.ts
        ├── 20260418000020_create_orders.ts
        ├── 20260418000030_create_order_items.ts
        ├── 20260418000040_create_payment_sessions.ts
        ├── 20260418000050_create_transactions.ts
        ├── 20260418000060_create_restaurant_balances.ts
        ├── 20260418000070_create_deliveries.ts
        ├── 20260418000080_create_agent_presence.ts
        ├── 20260418000090_create_agent_earnings.ts
        ├── 20260418000100_create_idempotency_keys.ts
        ├── 20260418000110_create_payment_webhook_events.ts
        # (no core_inbound_events migration — dedupe is Redis SETNX)
```

---

## Layer rules (enforced by reading)

```
       app/  ── may import lib, pkg
       lib/  ── may import pkg, env; may NOT import app/<module>/* (except via DI tokens at boot)
       pkg/  ── pure providers, NO imports from lib or app, NO env, NO global singletons
```

### What goes in `pkg/`

- **Provider implementations** that could be swapped (Redis, Kashier, future Stripe).
- **Pure utilities** with no Express, no env, no DI dependency.
- A `pkg/` file should be unit-testable with **only** its inputs.

Examples in this service:
- `pkg/cache/redis.ts` — Redis client wrapper.
- `pkg/payments/kashier/kashier.client.ts` — raw Kashier HTTP client.
- `pkg/utils/money.ts` — minor-unit helpers.

### What goes in `lib/`

- **App glue**: middleware, DI container, env-driven config, Express extensions, shared service infra (idempotency, WS server, AMQP consumer loop for inbound core events).
- May import `pkg/` and `lib/config/env`, but never `app/<module>/*` directly. The DI container is the single allowed exception (`lib/di/container.ts` registers concrete classes from `app/`).

Examples:
- `lib/idempotency/idempotency.ts` — middleware that pulls the cache provider from DI.
- `lib/jobs/archival.worker.ts` — nightly job that copies year-old rows to the archive cluster, then deletes from hot.
- `lib/sharding/region-resolver.ts` — Express middleware mapping requests to a region.
- `lib/websocket/ws-server.ts` — WS server attached to the HTTP server.

### What goes in `app/<module>/`

- Business logic, state machines, RBAC enforcement choices, error definitions, request/response DTOs.
- One module per bounded context. Cross-module calls go through services (never another module's repository).

---

## Per-module file conventions

Same as core-service. Recap:

| File                                  | Purpose                                                                 |
| ------------------------------------- | ----------------------------------------------------------------------- |
| `controller/<m>.controller.ts`        | `@injectable()`. Validates body via `validateBody`, calls service, maps to **Response DTO**, calls `sendSuccess`/`sendPaginated`. |
| `service/<m>.service.ts`              | `@injectable()`. Orchestrates repos and other services. Throws `AppError`. |
| `repository/<m>.repo.ts`              | Exported **functions** (not classes). Each takes optional `conn: Knex`. Has `<MODULE>_COLUMNS` const + `toEntity(row)`. |
| `entity/<m>.entity.ts`                | Plain class. Constructor takes `Partial<Entity>`. No DB knowledge. |
| `dto/<m>.request.dto.ts`              | class-validator-decorated request shapes. |
| `dto/<m>.response.dto.ts`             | Response payload shape. Static `from(entity, ...)` factory. **Money in minor units; ts in ISO 8601.** |
| `enums.ts`                            | string enums whose values match DB CHECK constraint values. |
| `errors.ts`                           | Exported `AppError` instances (not classes). |
| `routes.ts`                           | Resolves the controller from DI; wires middleware. |

---

## Comparison to core-service

| Concept                        | core-service       | order-service                                  |
| ------------------------------ | ------------------ | ---------------------------------------------- |
| `app/` modules                 | yes                | yes (same shape)                               |
| `lib/` glue                    | yes                | yes + `core-client/`, `core-events/`, `messaging/`, `sharding/`, `websocket/`, `jobs/` |
| `pkg/` agnostic providers      | yes (`cache`, `email`, `utils`) | yes (`cache`, `messaging`, `payments`, `utils`) |
| `migrations/`                  | yes                | yes                                            |
| `dto/` files                   | request only       | **request + response**                         |
| `db` export                    | singleton          | **`db(region)` function** (+ `dbArchive(region)` in Phase 7) |
| WebSocket                      | no                 | yes (`lib/websocket/`, scaffold in Phase 0)    |
| Sharding (per country)         | no                 | yes (`lib/sharding/`)                          |
| Async to other services        | no                 | **inbound only** via RabbitMQ (`lib/core-events/`); no outbound |
| Cross-service HTTP client      | no                 | yes (`lib/core-client/`, base in Phase 0)      |
| Read replicas                  | no                 | no (deferred)                                  |
