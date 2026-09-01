# order-service

The **Orders & Payments** microservice of the QuickBite platform — a food-delivery marketplace. This service owns order placement and lifecycle, online (Kashier) and cash-on-delivery payments, delivery agent assignment and earnings, restaurant balance and payouts, real-time order/delivery updates over WebSocket, and nightly archival of prior-year data to a separate cold-storage database. It does **not** own users, restaurants, branches, products, customer addresses, or the RBAC permission catalog — those belong to a separate `core-service` and are consumed over sync HTTP or a cached read-through projection.

Everything in this document was verified against the actual code in this repository (not the design docs in `docs/`, which describe the original plan and drift from the shipped implementation in a couple of places — noted inline where relevant).

## Contents

- [Tech Stack](#tech-stack)
- [Features](#features)
- [Project Structure](#project-structure)
- [Database Schema / ERD](#database-schema--erd)
- [Prerequisites](#prerequisites)
- [Installation & Setup](#installation--setup)
- [Environment Variables](#environment-variables)
- [Running the App](#running-the-app)
- [Running Migrations](#running-migrations)
- [API Endpoints](#api-endpoints)
- [Further Reading](#further-reading)
- [Testing](#testing)

---

## Tech Stack

Read directly from `package.json` and the code that uses each dependency.

| Concern | Library | Notes |
| --- | --- | --- |
| Runtime | Node.js + TypeScript | strict mode, decorators enabled (`experimentalDecorators`, `emitDecoratorMetadata`) |
| HTTP framework | `express` v5 | |
| Request validation | `class-validator` + `class-transformer` | request DTOs only — response DTOs are plain classes with a static `from()` factory |
| Dependency injection | `tsyringe` | container in `src/lib/di/container.ts`, symbol tokens in `src/lib/di/tokens.ts` |
| Env validation | `zod` | `src/lib/config/env.ts` — the process refuses to boot if a required var is missing |
| Database driver | `knex` over `pg` | **no ORM** — query builder + raw SQL only |
| Cache / locks / presence | `ioredis` | |
| Auth | `jsonwebtoken` | verifies the same JWT `core-service` issues (shared secret) |
| Password hashing | `bcrypt` | listed as a dependency; **not referenced anywhere in `src/`** — this service doesn't handle credentials, that's core-service's job |
| Real-time | `socket.io` + `@socket.io/redis-adapter` | WS server attached to the same HTTP server; Redis adapter fans messages out across worker processes |
| Message broker | RabbitMQ via `amqplib` (+ `amqp-connection-manager`) | inbound consumer for `core-service` events, plus an outbound transactional outbox |
| Payments | Kashier v3 (Payment Sessions + Webhooks) | custom HTTP client in `src/pkg/payments/kashier/`, not an npm SDK |
| Background jobs | `node-cron` | drives the assignment tick, the outbox drain, and the archival worker |
| IDs | `uuid` | client-facing order ids (`public_id`) |
| Misc | `helmet`, `cors`, `cookie-parser`, `dotenv` | standard Express hardening/config middleware |

Dev tooling: `typescript`, `tsx` (dev/watch runner), `ts-node` (used by the Knex CLI), `vitest` (test runner). No lint config in `package.json` — see [Testing](#testing).

---

## Features

Everything below is implemented and reachable through a documented endpoint or background job — not aspirational.

- **Order placement** (`POST /orders`) — validates the branch/products/stock and customer address against `core-service` (cached), computes totals in integer minor units, reserves stock, and writes the order + line items in one DB transaction. Supports both `cod` and `online` payment methods.
- **A full order status lifecycle**, enforced per-actor:

  ```
                   ┌─── pending_payment ───┐   (online only)
                   │           │           │
                   │  payment captured     │  payment times out / customer cancels
                   │           ▼           ▼
                   └──────► placed ───────────────► cancelled
                               │
                restaurant declines            restaurant accepts
                               │                       │
                               ▼                       ▼
                           rejected               accepted ─► cancelled (restaurant)
                                                       │
                                                       ▼
                                                  preparing ─► cancelled (restaurant)
                                                       │
                                                       ▼
                                                    ready ─► cancelled (restaurant)
                                                       │
                                       auto-assignment worker claims an agent
                                                       ▼
                                                  assigned ─► cancelled (admin only)
                                                       │
                                         agent confirms pickup
                                                       ▼
                                                    picked   (no cancel from here on)
                                                       │
                                         agent confirms drop-off
                                                       ▼
                                                  delivered   (terminal — settles money)
  ```

- **Online payments via Kashier v3** — a payment session is created automatically as part of order placement (`OrderService.placeOrder` → `PaymentService.initOnlinePayment`; there is no separate `POST /payments/init` endpoint in the shipped code, unlike what `docs/business-logic/payments.md` originally planned). Confirmation arrives via an HMAC-verified webhook (`POST /payments/webhook/kashier`), de-duplicated by a unique index on `(provider_id, provider_event_id)` so Kashier's at-least-once retries are safe.
- **Cash on delivery** — no external call at all; the `cod_collection` ledger entry is written directly by the settlement transaction when the order is marked `delivered`.
- **A single money ledger** (`transactions`) for every charge, COD collection, commission, payout, and adjustment — amounts are always positive integers in minor units; direction is encoded by `(transaction_type, src_acc_id, dst_acc_id)`.
- **Automatic delivery assignment** — a background worker tick (`ASSIGNMENT_TICK_SEC`, default 10s, per region) finds `ready` orders, geo-searches Redis for nearby online agents, and broadcasts a claimable offer; the offer and the claim are both `SETNX`-guarded so exactly one agent wins a race. Falls back to an admin-forced assignment endpoint if no agent claims it within the retry budget.
- **Delivery agent presence** — entirely in Redis (a 5-minute TTL hash + a geo set), no database table, no audit requirement.
- **Money settlement on delivery** — one transaction that computes the platform commission, credits the restaurant's running balance, and records the agent's earning — all idempotent via unique constraints, so a retried request can never double-credit anyone.
- **Restaurant finance** — a running balance per `(restaurant, currency)` and admin-recorded payouts (payouts are a `transaction_type`, not a separate table).
- **Real-time updates** over Socket.IO (`@socket.io/redis-adapter`-backed, so any worker process can deliver to a socket held by any other) — every status change, offer, and claim is pushed to the relevant customer/restaurant/branch/agent room instantly.
- **Region-sharded Postgres** — one "hot" cluster per country (`eg`, `ksa`, ...), resolved per request from `?region=` → `X-Region` header → a `region` cookie, never from the JWT.
- **Nightly cold-archival worker** — moves every row older than the current year (across 6 tables, FK-safe order, batched, Redis-locked, crash-safe) from each region's hot cluster to a parallel archive cluster. Order reads transparently follow the data — see [`docs/business-logic`](./docs/business-logic) and the module comments in `src/lib/jobs/archival.worker.ts` for the full mechanics.
- **Inbound event consumption** — a RabbitMQ consumer binds to `core-service`'s `core.events` exchange (`product.#`, `branch.#`, `restaurant.#`, `rbac.#`) and invalidates the corresponding Redis cache entries, with `SETNX`-based dedupe and a dead-letter queue for poison messages.
- **Outbound transactional outbox** — domain events are written to an `events_outbox` table in the same transaction as the change that produced them, then drained to a RabbitMQ exchange by a separate cron tick with `FOR UPDATE SKIP LOCKED` batching and publisher-confirm-gated dispatch.
- **Idempotency** — every write endpoint that costs money or creates a resource requires an `Idempotency-Key` header, backed by Redis with a Postgres fallback table on the most critical paths (order placement, payouts).
- **JWT auth shared with `core-service`**, and RBAC resolved through a Redis-cached read-through projection of `core-service`'s permission catalog rather than a local copy.
- **zod-validated configuration** — a missing required environment variable fails the process at boot with a clear error instead of an obscure runtime crash later.

**Not yet implemented** (present in the design docs, absent from the code): a `POST /payments/:id/refund` endpoint and any refund service logic.

---

## Project Structure

Excludes `node_modules/`, `dist/` (build output, gitignored), and `.git/`. There is no `coverage/` directory (no test runner configured yet).

```
order-service/
├── .env.example              # template for .env — every var this service reads, with placeholders
├── CLAUDE.md                  # coding conventions & layering rules this codebase follows
├── package.json / package-lock.json
├── tsconfig.json
├── docs/                      # design docs — architecture, schema, API contracts, business logic, build plan
│   └── business-logic/          # one file per module: lifecycle, invariants, RBAC
├── scripts/                   # one-off / operational scripts, run with `npx tsx`
│   ├── migrate-all.ts           # runs `migrate:latest` across every region (hot or archive cluster)
│   └── create-partitions.ts     # pre-creates monthly `orders` partitions
├── play/                      # gitignored local smoke-test scripts — not part of the shipped app
└── src/
    ├── app.ts                 # Express composition: helmet, cors, json (raw body kept for webhook HMAC), cookies, correlation id, region resolver, routes, error handler
    ├── server.ts                # HTTP API process: boots the app, attaches the WS server, pings every shard, connects RabbitMQ, starts the inbound event consumer
    ├── worker.ts                 # background worker process: no HTTP listener — registers the assignment/outbox/archival cron jobs and starts the scheduler
    ├── routes.ts                 # mounts every module's router under /api
    │
    ├── app/                     # business modules — one folder per bounded context
    │   ├── health/                 # GET /api/health
    │   ├── order/                   # placement, status machine, customer/restaurant order reads
    │   ├── payment/                   # Kashier sessions, webhook processing, the transactions ledger
    │   ├── assignment/                 # the auto-assignment worker + admin override
    │   ├── agent/                       # presence, task list, earnings, in-flight order actions
    │   └── finance/                      # restaurant balance reads + payout recording
    │
    │       Each module repeats the same skeleton:
    │       controller/<m>.controller.ts   — @injectable; validate → call service → map to response DTO → respond
    │       service/<m>.service.ts         — @injectable; the actual business logic, throws AppError
    │       repository/<m>.repo.ts         — exported functions (not classes), each takes an optional `conn: Knex`
    │       entity/<m>.entity.ts           — plain class, no DB knowledge
    │       dto/<m>.request.dto.ts         — class-validator-decorated request shapes
    │       dto/<m>.response.dto.ts        — response payload shape, static from(entity) factory
    │       enums.ts / errors.ts / types.ts / routes.ts
    │
    ├── lib/                     # app-aware glue — may import pkg/ and env, never app/<module>/* directly
    │   ├── auth/                   # JWT guard, RBAC middleware, restaurant/branch membership checks
    │   ├── cache/                   # Redis client init + withCache(ttl) response-caching middleware
    │   ├── config/env.ts             # zod-validated env — the single source of truth for all configuration
    │   ├── core-client/              # sync HTTP client to core-service (branches, products, addresses, RBAC)
    │   ├── core-events/               # inbound RabbitMQ consumer: core.events → cache invalidation handlers
    │   ├── correlation/                # X-Correlation-Id propagation middleware
    │   ├── di/                          # tsyringe container + TOKENS symbol registry
    │   ├── error/                        # AppError + the central Express error handler
    │   ├── events/                        # outbound transactional outbox (order.events) + its drain job
    │   ├── http/                           # sendSuccess/sendPaginated + cursor-based pagination helpers
    │   ├── idempotency/                     # Idempotency-Key middleware (Redis + Postgres fallback)
    │   ├── jobs/                             # generic cron job registry/scheduler + the archival worker
    │   │   ├── job-registry.ts, job.types.ts, scheduler.ts     # generic "register a cron job" infra
    │   │   ├── archival.worker.ts              # orchestrates one nightly archival run per region
    │   │   ├── archival.helpers.ts             # the per-table batch-move loop + JSON-column handling
    │   │   └── archival.types.ts               # ArchivalTableSpec / ArchivalRunResult types
    │   ├── knex/                                # db(region) (hot) / dbArchive(region) (archive) connections
    │   ├── logger/                               # structured JSON logger
    │   ├── messaging/                             # AMQP connection lifecycle
    │   ├── rbac/                                   # read-through permission cache backed by core-service
    │   ├── sharding/                                # region resolver (query > header > cookie) + region list
    │   ├── validation/                               # validateBody(DTO, req.body)
    │   └── websocket/                                 # socket.io server, channel auth, Redis adapter wiring
    │
    ├── pkg/                     # framework- and app-agnostic — no imports from lib/ or app/, no env access
    │   ├── cache/                  # ICacheProvider interface + the ioredis implementation
    │   ├── messaging/                # IMessageBroker interface + the amqplib/RabbitMQ client
    │   ├── payments/                   # IPaymentProvider interface + the Kashier HTTP client
    │   └── utils/                        # money.ts (minor-unit helpers), time.ts (date helpers), retry.ts
    │
    └── migrations/               # knex migrations — raw SQL inside up()/down(), snake_case tables/columns
```

See [`docs/folder-structure.md`](./docs/folder-structure.md) for the (partially aspirational — some module names there differ from what actually shipped) fully annotated version, and [`CLAUDE.md`](./CLAUDE.md) §3–§5 for the naming/module conventions every file follows.

---

## Database Schema / ERD

This service uses **plain Knex migrations with raw SQL** — there is no ORM, no schema file, and no seed script (`src/migrations/`, 9 files, one table each; `scripts/` has no seeding utility). The tables below are every entity actually created by those migrations, read directly from their `CREATE TABLE` statements.

```mermaid
erDiagram
    ORDERS ||--o{ ORDER_ITEMS : "has line items"
    ORDERS ||--o{ PAYMENT_SESSIONS : "has checkout sessions"
    ORDERS ||--o{ TRANSACTIONS : "generates"
    ORDERS ||--o| AGENT_EARNINGS : "settles to"
    PAYMENT_PROVIDERS ||--o{ PAYMENT_SESSIONS : "processes"
    PAYMENT_PROVIDERS ||--o{ TRANSACTIONS : "processes"
    PAYMENT_PROVIDERS ||--o{ PAYMENT_WEBHOOK_EVENTS : "sends"

    ORDERS {
        bigint id PK
        text region
        uuid public_id
        text country_code
        bigint restaurant_id "core-service FK, logical"
        bigint restaurant_owner_id "core-service FK, logical"
        bigint branch_id "core-service FK, logical"
        bigint customer_id "core-service FK, logical"
        bigint customer_address_id "core-service FK, logical"
        decimal delivery_lat
        decimal delivery_lng
        text delivery_address_text_snapshot
        decimal branch_lat
        decimal branch_lng
        text status
        int subtotal
        int delivery_fee
        int service_fee
        int total
        int commission
        text currency
        text payment_method
        bigint delivery_agent_id "core-service FK, logical"
        timestamp created_at PK
        timestamp updated_at
        timestamp accepted_at
        timestamp rejected_at
        timestamp ready_at
        timestamp assigned_at
        timestamp picked_at
        timestamp delivered_at
        timestamp cancelled_at
    }

    ORDER_ITEMS {
        bigint id PK
        text region
        bigint order_id "FK to orders.id, app-enforced"
        bigint product_id "core-service FK, logical"
        int quantity
        int unit_price_snapshot
        text name_snapshot
        text image_url_snapshot
        int line_total
        timestamp created_at
    }

    PAYMENT_PROVIDERS {
        int id PK
        text name UK
        boolean is_enabled
        smallint priority
    }

    PAYMENT_SESSIONS {
        bigint id PK
        text region
        bigint order_id "FK to orders.id, app-enforced"
        int provider_id FK
        text provider_session_id UK
        text redirect_url
        int amount
        text currency
        text status
        jsonb raw_init_payload
        jsonb raw_last_payload
        timestamp created_at
        timestamp updated_at
    }

    TRANSACTIONS {
        bigint id PK
        text region
        bigint order_id "FK to orders.id, nullable, app-enforced"
        text transaction_type
        text method
        int provider_id "FK, nullable"
        text provider_reference_id
        text status
        int amount
        text currency
        bigint src_acc_id "core-service user id, logical"
        bigint dst_acc_id "core-service user id, logical"
        boolean is_refunded
        bigint refunded_payment_id
        text idempotency_key UK
        timestamp created_at
        timestamp updated_at
    }

    PAYMENT_WEBHOOK_EVENTS {
        bigint id PK
        text region
        int provider_id FK
        text provider_event_id UK
        text signature
        jsonb payload
        timestamp received_at
        timestamp processed_at
        text process_error
    }

    RESTAURANT_BALANCES {
        bigint restaurant_id PK "core-service FK, logical"
        text region
        text currency PK
        int balance
        timestamp updated_at
    }

    AGENT_EARNINGS {
        bigint id PK
        text region
        bigint agent_id "core-service FK, logical"
        bigint order_id "FK to orders.id, UK, app-enforced"
        int amount
        text currency
        timestamp earned_at
    }

    EVENTS_OUTBOX {
        bigint id PK
        text aggregate_type
        text aggregate_id
        text event_type
        uuid event_id UK
        jsonb payload
        timestamp created_at
        timestamp dispatched_at
        int attempts
        text last_error
    }
```

Notes that don't fit in a diagram:

- **`orders` is partitioned** (native Postgres `PARTITION BY RANGE (created_at)`, monthly), which is *why* its primary key is the composite `(id, created_at)` rather than just `id` — Postgres requires the partition key inside the PK. `npm run partitions:create` pre-creates the next 12 months; anything outside the pre-created range still lands safely in a catch-all `orders_default` partition.
- **No FK constraints to `orders`** from `order_items`, `payment_sessions`, `transactions`, or `agent_earnings` — Postgres foreign keys must target a table's full unique key, and `orders`' key includes the partition column, so these relationships are enforced in application code instead (every write to these tables happens inside the same service that wrote the order). This is a deliberate, documented trade-off, not an oversight — see the comment at the top of each migration file.
- **Cross-service references** (columns that logically point at rows this database doesn't contain, owned instead by `core-service`): `orders.restaurant_id`/`restaurant_balances.restaurant_id` → `restaurants`; `orders.customer_id`/`orders.restaurant_owner_id`/`orders.delivery_agent_id`/`transactions.src_acc_id`/`transactions.dst_acc_id`/`agent_earnings.agent_id` → `users`; `orders.customer_address_id` → `customer_addresses`; `orders.branch_id` → `restaurant_branches`; `order_items.product_id` → `products`. These are validated at write time via a sync HTTP call to `core-service` (cached), never a DB-level FK, since the two services have separate databases.
- **Money is always an integer in minor units** (piasters, halalas), never `DECIMAL` — decimal values coming back from the `pg` driver as strings is an easy source of silent bugs; integer math is exact.
- **Every table carries a `region` column** and lives on a connection already pinned to that region's shard — there's no cross-region filtering happening at the SQL level, the connection itself is the shard boundary. `payment_providers` is the one exception: a small, identical lookup table replicated to every shard.
- **Hot vs. archive**: every table above exists twice per region — once in the "hot" database (current year) and once in a separate "archive" database with an identical schema, populated by the nightly archival worker. `events_outbox` and `payment_providers` are the exceptions (outbox is drained and deleted, not archived; providers are a small replicated lookup).

---

## Prerequisites

- **Node.js 18+** and npm
- **PostgreSQL** reachable locally or remotely — **two databases per region**: one "hot", one "archive" (no Docker Compose file is present in this repo — provision Postgres/Redis/RabbitMQ yourself, or point the env vars at existing instances)
- **Redis**
- **RabbitMQ**
- A running **`core-service`** instance — this service depends on it for JWT secrets, branch/product/address lookups, and the RBAC permission catalog. `order-service` will boot without it reachable, but most write endpoints and RBAC-gated reads will fail until it is.

---

## Installation & Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Copy and configure the environment file

```bash
cp .env.example .env
```

Then fill in `.env` with real values — **never commit it** (`.env` is gitignored; `.env.example` is not). See [Environment Variables](#environment-variables) below for what every value means. At minimum, these have no default and the app will not boot without them:

- `ACCESS_SECRET` / `REFRESH_SECRET` — must match `core-service`'s JWT secrets exactly.
- `REGIONS` — comma-separated region codes (e.g. `eg,ksa`); each one needs its own `DB_<region>_*` and `ARCHIVE_DB_<region>_*` block.
- `RABBITMQ_URL`
- `CORE_SERVICE_BASE_URL` / `CORE_INTERNAL_API_KEY` — must match what `core-service` is actually configured to accept on its internal `api-key` header.
- `KASHIER_MERCHANT_ID` / `KASHIER_API_KEY` / `KASHIER_SECRET_KEY` / `KASHIER_RETURN_URL` / `KASHIER_FAIL_URL` / `KASHIER_WEBHOOK_URL` — from your own Kashier sandbox account.

> **Port note:** don't set `PORT` to a value on the Node/browser "bad ports" blocklist (e.g. `6000`, the X11 port) — `fetch()` and every browser silently refuse to connect to it even though `curl` still works.

### 3. Create the databases

For every region in `REGIONS`, create both its hot and archive database:

```sql
CREATE DATABASE order_service_eg;
CREATE DATABASE order_service_archive_eg;
CREATE DATABASE order_service_ksa;
CREATE DATABASE order_service_archive_ksa;
```

(Database names are whatever you set for `DB_<region>_NAME` / `ARCHIVE_DB_<region>_NAME` — the ones above match `.env.example`.)

### 4. Run migrations

See [Running Migrations](#running-migrations) below — do this before starting the app.

### 5. Start Redis, RabbitMQ, and core-service

All three need to be reachable before `order-service` will function correctly (see [Prerequisites](#prerequisites)).

### 6. Run it

See [Running the App](#running-the-app) below.

---

## Environment Variables

Every variable below is read (via `zod`) in `src/lib/config/env.ts`, which is the **only** place `process.env` is read for application configuration — confirmed by searching the whole `src/` tree. Two scripts read a couple of extra, invocation-only variables that are **not** part of `.env`: `scripts/migrate-all.ts` and `src/lib/knex/knexfile.ts` read `CLUSTER` (`hot`/`archive`, defaults `hot`) and `REGION`, and `scripts/create-partitions.ts` also reads `MONTHS_AHEAD` — all three are meant to be passed on the command line per-invocation (`REGION=eg CLUSTER=archive npm run migrate`), not stored in `.env`.

The full file, with a one-line comment on every variable:

```bash
# Example environment file for order-service.
#
# Copy this to `.env` (gitignored — never commit `.env`) and fill in real
# values for your machine:
#
#   cp .env.example .env
#
# Every variable below is read by src/lib/config/env.ts (zod-validated at
# boot — the process refuses to start if a required one is missing).

PORT=4000
NODE_ENV=development

# Must match core-service's JWT secrets exactly — this service verifies the
# same access-token cookie core-service issues.
ACCESS_SECRET=replace-with-a-long-random-secret
REFRESH_SECRET=replace-with-a-long-random-secret
ACCESS_EXPIRES_IN=3600
REFRESH_EXPIRES_IN=604800

CORS_ORIGINS=http://localhost:3000

# Comma-separated shard/region codes. Every region listed here needs a
# matching DB_<region>_* and ARCHIVE_DB_<region>_* block below.
REGIONS=eg,ksa

DB_POOL_MAX=10
DB_MIGRATION_DIRECTORY=src/migrations
DB_MIGRATION_EXTENSION=ts

# ── Hot cluster (current-year data) — one block per region in REGIONS ──────
DB_eg_HOST=localhost
DB_eg_PORT=5432
DB_eg_USERNAME=postgres
DB_eg_PASSWORD=replace-with-your-postgres-password
DB_eg_NAME=order_service_eg

DB_ksa_HOST=localhost
DB_ksa_PORT=5432
DB_ksa_USERNAME=postgres
DB_ksa_PASSWORD=replace-with-your-postgres-password
DB_ksa_NAME=order_service_ksa

# ── Archive cluster (prior-year data, moved nightly by the archival worker)
# Can point at the same Postgres instance as the hot cluster in local dev —
# just needs to be a separate database per region.
ARCHIVE_DB_eg_HOST=localhost
ARCHIVE_DB_eg_PORT=5432
ARCHIVE_DB_eg_USERNAME=postgres
ARCHIVE_DB_eg_PASSWORD=replace-with-your-postgres-password
ARCHIVE_DB_eg_NAME=order_service_archive_eg

ARCHIVE_DB_ksa_HOST=localhost
ARCHIVE_DB_ksa_PORT=5432
ARCHIVE_DB_ksa_USERNAME=postgres
ARCHIVE_DB_ksa_PASSWORD=replace-with-your-postgres-password
ARCHIVE_DB_ksa_NAME=order_service_archive_ksa

REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=

RABBITMQ_URL=amqp://guest:guest@localhost:5672
RABBITMQ_CORE_EVENTS_EXCHANGE=core.events
RABBITMQ_CORE_EVENTS_QUEUE=order-service.core-events
RABBITMQ_CORE_EVENTS_BINDINGS="product.#,branch.#,restaurant.#,rbac.#"
RABBITMQ_CORE_EVENTS_DLX=core.events.dlx
RABBITMQ_CORE_EVENTS_DLQ=order-service.core-events.dlq
RABBITMQ_PREFETCH=32

# Outbound: order.events exchange consumed by analytics-service & friends
RABBITMQ_ORDER_EVENTS_EXCHANGE=order.events
OUTBOUND_EVENTS_DRAIN_TICK_SEC=2
OUTBOUND_EVENTS_BATCH_SIZE=100

# core-service — this service's sync HTTP dependency for users/restaurants/
# branches/products/RBAC. CORE_INTERNAL_API_KEY must match the value
# core-service expects on the `api-key` header for internal routes.
# CORE_HTTP_TIMEOUT_MS bounds each individual attempt at reaching it — see
# the core-service-unavailable pattern below.
CORE_SERVICE_BASE_URL=http://localhost:3000
CORE_INTERNAL_API_KEY=replace-with-core-services-internal-api-key
CORE_HTTP_TIMEOUT_MS=5000

WS_HEARTBEAT_SEC=30

# Kashier v3 sandbox credentials — get these from your own Kashier sandbox
# account, never reuse someone else's. No defaults; the app will not boot
# without them.
KASHIER_MERCHANT_ID=your-kashier-merchant-id
KASHIER_API_KEY=your-kashier-api-key
KASHIER_SECRET_KEY=your-kashier-secret-key
KASHIER_RETURN_URL=https://example.com/checkout/success
KASHIER_FAIL_URL=https://example.com/checkout/failure
# Must be a publicly-reachable https URL (e.g. an ngrok tunnel to :4000) —
# Kashier's create-session API rejects http/localhost redirect and webhook
# URLs even against the test sandbox.
KASHIER_WEBHOOK_URL=https://example.com/api/payments/webhook/kashier?region=eg
KASHIER_BASE_URL=https://test-api.kashier.io
KASHIER_FEP_BASE_URL=https://test-fep.kashier.io
KASHIER_PAYMENT_TYPE=credit
PAYMENT_SESSION_TIMEOUT_MIN=15
# Regions that accept online (Kashier) payments; every other region is COD-only.
ONLINE_PAYMENT_REGIONS=eg

# ── Deliveries / agents ─────────────────────────────────────────────────────
PRESENCE_STALE_SEC=300
ASSIGNMENT_TICK_SEC=10
ASSIGNMENT_RADIUS_METERS=5000
ASSIGNMENT_CANDIDATES=5
ASSIGNMENT_OFFER_TTL_SEC=30
ASSIGNMENT_CLAIM_TTL_SEC=300
ASSIGNMENT_MAX_ATTEMPTS=3
ASSIGNMENT_BATCH=20
AGENT_EARNING_SHARE_BPS=8000

# ── Cold archival worker (nightly, moves prior-year rows hot -> archive) ───
ARCHIVAL_CRON=0 3 * * *
ARCHIVAL_TIMEZONE=UTC
ARCHIVAL_BATCH_SIZE=1000
ARCHIVAL_MAX_RUNTIME_MIN=60
```

This exact content lives in [`.env.example`](./.env.example) at the repo root — copy it, don't retype it.

A couple of patterns worth knowing:

- **Per-region shard config is dynamic**, not fixed keys in the zod schema: for every code in `REGIONS`, the app expects `DB_<region>_HOST/PORT/USERNAME/PASSWORD/NAME` (hot) and `ARCHIVE_DB_<region>_HOST/PORT/USERNAME/PASSWORD/NAME` (archive). Add a region to `REGIONS` and its two DB blocks, and it's live — no code change.
- **Region is never in the JWT.** It's resolved per request from `?region=` query, then the `X-Region` header, then a `region` cookie.
- **core-service unavailable is one stable, documented contract**: `503 { "error": "Core service unavailable" }`. It covers every way a core-service call can fail to get a good answer — connection refused, DNS failure, a request that runs past `CORE_HTTP_TIMEOUT_MS`, and core-service itself responding with a 5xx — all translated at the `core-client` boundary (`src/lib/core-client/core-client.ts`), never leaked as a raw network exception. Up to 3 attempts, 50ms→100ms backoff, and only that specific failure is retried — a real 4xx from core-service (`src/lib/core-client/errors.ts`'s `coreUpstreamError`) is returned as-is, not retried, not folded into 503.

---

## Running the App

Two independent processes — both need Postgres (hot **and** archive), Redis, and RabbitMQ reachable to start cleanly.

```bash
npm run dev      # HTTP API on $PORT, hot-reloaded (tsx watch src/server.ts)
npm run worker   # background jobs, hot-reloaded (tsx watch src/worker.ts):
                  #   assignment tick, outbox drain, nightly archival
```

Production builds:

```bash
npm run build           # tsc compile to dist/
npm run start            # node dist/server.js
npm run start:worker     # node dist/worker.js
```

Verify the API is up and every shard is reachable:

```bash
curl http://localhost:4000/api/health
```

Returns `200` with a per-shard ping (both hot **and** archive, every region) if everything is reachable, `503` if any shard isn't.

Every `package.json` script:

| Script | Command | What it does |
| --- | --- | --- |
| `npm run dev` | `tsx watch src/server.ts` | API server, hot-reloaded |
| `npm run worker` | `tsx watch src/worker.ts` | Background worker, hot-reloaded |
| `npm run build` | `tsc` | Compiles `src/` to `dist/` |
| `npm run start` | `node dist/server.js` | Runs the compiled API server |
| `npm run start:worker` | `node dist/worker.js` | Runs the compiled background worker |
| `npm run typecheck` | `tsc --noEmit` | Type-checks without emitting |
| `npm run migrate` | `knex --knexfile src/lib/knex/knexfile.ts migrate:latest` | Applies migrations for one region/cluster (see below) |
| `npm run migrate:rollback` | `knex ... migrate:rollback` | Rolls back the last migration batch for one region/cluster |
| `npm run migrate:status` | `knex ... migrate:status` | Shows migration status for one region/cluster |
| `npm run migrate:make` | `knex ... migrate:make` | Scaffolds a new migration file |
| `npm run migrate:all` | `tsx scripts/migrate-all.ts` | Runs `migrate:latest` for **every** region in `REGIONS` |
| `npm run partitions:create` | `tsx scripts/create-partitions.ts` | Pre-creates the next N months of `orders` partitions |

There is no `npm run lint` or `npm test` script defined in `package.json` — see [Testing](#testing).

No Dockerfile or `docker-compose.yml` exists in this repository; there's no containerized way to run this service or its dependencies today.

---

## Running Migrations

This project uses **Knex's own migration CLI** directly (`knex --knexfile src/lib/knex/knexfile.ts ...`) — there's no Prisma/TypeORM/Sequelize involved, and every migration is raw SQL inside `up()`/`down()` (see `src/migrations/`). `src/lib/knex/knexfile.ts` picks the target database from two env vars read at invocation time, **not** from `.env`: `REGION` (required) and `CLUSTER` (`hot` or `archive`, defaults to `hot`).

**Apply migrations** — one region/cluster at a time:

```bash
REGION=eg npm run migrate                     # hot cluster, region eg
REGION=eg CLUSTER=archive npm run migrate      # archive cluster, region eg
```

**Every configured region at once** (`scripts/migrate-all.ts` loops `env.regions` and shells out to the command above for each):

```bash
npm run migrate:all                            # hot cluster, every region
CLUSTER=archive npx tsx scripts/migrate-all.ts  # archive cluster, every region
```

Both clusters need migrating — the archive cluster runs the exact same migration set as hot (identical schema), and the [archival worker](#features) has nowhere to write until it's migrated.

**Roll back the last batch:**

```bash
REGION=eg npm run migrate:rollback
```

**Check status:**

```bash
REGION=eg npm run migrate:status
```

**Scaffold a new migration:**

```bash
npm run migrate:make -- create_something
```

**Seeding**: there is no seed script or `seeds/` directory in this repository. The one piece of seed-like data is inline in a migration itself — `src/migrations/20260506000010_create_payment_providers.ts` conditionally inserts a `kashier` row into `payment_providers` when `REGION=eg` at migration time (other regions get no payment provider row, i.e. COD-only, unless a future migration or manual insert adds one).

**Partitioning** (`orders` is partitioned by month on `created_at`) is a separate concern from migrations — run `npm run partitions:create` after migrating (see [Installation & Setup](#4-run-migrations) and the callout in the original setup guide about running it *before* real data accumulates, to avoid `check_default_partition_contents` errors).

---

## API Endpoints

Every route is mounted under `/api` (see `src/routes.ts`). Auth is a JWT in the `access_token` cookie; region is resolved from `?region=` → `X-Region` header → `region` cookie. Write endpoints that create resources or move money require an `Idempotency-Key` header. This table is built directly from the `routes.ts` file in each module — see [`docs/api-contracts.md`](./docs/api-contracts.md) for full request/response bodies and error codes.

### Orders (`src/app/order/routes.ts`)

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `POST` | `/orders` | customer | Place an order (COD or online). Idempotent (strict). |
| `GET` | `/orders/:publicId` | customer (own) / restaurant member / admin | Order detail + items + status history. |
| `GET` | `/customer/orders` | customer | Paginated order history, `?year=`. |
| `PATCH` | `/customer/orders/:publicId/status` | customer (own, within cancel window) | Cancel. Idempotent (strict). |
| `GET` | `/restaurants/:restaurantId/branches/:branchId/orders` | restaurant member (`orders:read`) / admin | Paginated order list, `?status=&from=&to=`. Cached 10s. |
| `PATCH` | `/restaurants/:restaurantId/branches/:branchId/orders/:publicId/status` | restaurant member | Accept/reject/preparing/ready/cancel. Idempotent (strict). |
| `PATCH` | `/admin/orders/:publicId/status` | admin | Any transition the state machine allows for admin. Idempotent (strict). |

### Payments (`src/app/payment/routes.ts`)

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `POST` | `/payments/webhook/kashier` | none — HMAC-verified | Kashier payment confirmation, `?region=`. |
| `GET` | `/restaurants/:restaurantId/payments/:paymentId` | restaurant member (`payments:read`) / admin | One transaction's detail. |

### Assignment (`src/app/assignment/routes.ts`)

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `POST` | `/admin/orders/:publicId/assign` | admin (`deliveries:assign`) | Force-assign a specific agent. Idempotent (strict). |

### Agents (`src/app/agent/routes.ts`)

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `POST` | `/agents/presence/online` | delivery agent | Go online at `{lat, lng}`. |
| `POST` | `/agents/presence/ping` | delivery agent | Refresh presence TTL / position. |
| `POST` | `/agents/presence/offline` | delivery agent | Go offline (blocked while `picked`). |
| `POST` | `/agents/orders/:publicId/accept` | delivery agent (offered) | Claim a broadcast offer. Idempotent (strict). |
| `POST` | `/agents/orders/:publicId/reject` | delivery agent (offered) | Decline an offer. |
| `PATCH` | `/agents/orders/:publicId/status` | delivery agent (assigned) | `picked` or `delivered` (delivered runs settlement). Idempotent (strict). |
| `GET` | `/agents/tasks` | delivery agent | This agent's task list, `?status=`. |
| `GET` | `/agents/earnings` | delivery agent | This agent's earnings history, `?from=&to=`. |

### Finance (`src/app/finance/routes.ts`)

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/restaurants/:restaurantId/balance` | restaurant member (`finance:read`) / admin | Current running balance per currency. |
| `GET` | `/restaurants/:restaurantId/payouts` | restaurant member (`finance:read`) / admin | Payout history, `?from=&to=`. |
| `POST` | `/admin/restaurants/:restaurantId/payouts` | admin | Record a payout. Idempotent (strict). |

### Health (`src/app/health/health.routes.ts`)

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/health` | none | Pings every configured hot **and** archive shard; `200` if all reachable, else `503`. |

### WebSocket events

Not HTTP, but the other half of this service's client-facing surface: `socket.io`, mounted on the same HTTP server, authenticated with the same JWT. Clients subscribe to rooms (`customer:<id>`, `restaurant:<id>`, `branch:<id>`, `agent:<id>`) and receive:

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

Full payload shapes: [`docs/business-logic/orders.md`](./docs/business-logic/orders.md) §12 and [`docs/business-logic/agents.md`](./docs/business-logic/agents.md) §9.

---

## Further Reading

| Doc | Purpose |
| --- | --- |
| [`CLAUDE.md`](./CLAUDE.md) | The full conventions doc: layering rules, naming, response DTOs, performance/indexing rules, what's out of scope. |
| [`docs/README.md`](./docs/README.md) | Reading order for the rest of the docs. |
| [`docs/system-design.md`](./docs/system-design.md) | Architecture rationale: regions, Redis layers, sync/async with core, Kashier, WebSocket. |
| [`docs/database-design.md`](./docs/database-design.md) | Full schema, FKs, indexes (each justified), sharding plan. |
| [`docs/api-contracts.md`](./docs/api-contracts.md) | Every endpoint's request/response DTOs and error codes. |
| [`docs/business-logic/`](./docs/business-logic) | One file per module: lifecycle, invariants, RBAC. |
| [`docs/implementation-plan.md`](./docs/implementation-plan.md) | The phased build order this service was actually built in. |

Some `docs/` files describe the original design (written before/during implementation) and drift from the shipped code in a couple of small, already-noted places (standalone payment-init, refunds). Treat `docs/` as design rationale, and this README (or the code itself) as the source of truth for current behavior.

## Testing

`npm test` runs [`vitest`](https://vitest.dev) against `tests/` — currently just `tests/core-client.test.ts`, covering the core-service-unavailable contract described above (success, a real 4xx, 5xx→503, connection-refused→503, timeout→503, retry-then-recover, and that an unrelated/programming error is neither retried nor folded into 503). No lint configuration exists in `package.json` yet. `play/` holds gitignored, throwaway scripts used to manually verify behavior against a real running stack (Postgres/Redis/RabbitMQ/core-service) — see [`play/README.md`](./play/README.md) for what each one checks. They're a reference for how to exercise the service directly, not something wired into CI.

No `LICENSE` file exists in this repository, so no license is stated here.
