# order-service

The **Orders & Payments** microservice of the QuickBite platform. Owns the transactional truth of the system: order placement and lifecycle, online (Kashier) and cash-on-delivery payments, delivery assignment and agent earnings, restaurant balance/payouts, real-time WebSocket updates, and nightly cold-archival of prior-year data.

It does **not** own users, restaurants, branches, products, or the RBAC permission catalog — those live in `core-service` and are consumed over sync HTTP or cached read-through projections.

For the full architectural rationale and coding conventions, see [`CLAUDE.md`](./CLAUDE.md) and [`docs/`](./docs/README.md) — this file is the practical "clone it and run it" guide.

---

## Tech stack

| Concern         | Library / Tool                                |
| ---------------- | ---------------------------------------------- |
| Runtime          | Node.js + TypeScript (strict, decorators on)   |
| HTTP framework   | `express` v5                                   |
| Validation       | `class-validator` + `class-transformer`        |
| DI               | `tsyringe`                                     |
| Env validation   | `zod`                                          |
| DB driver        | `knex` over `pg` (no ORM)                      |
| Cache            | `ioredis`                                      |
| Auth             | `jsonwebtoken` (same JWT contract as core-service) |
| WebSocket        | `socket.io` + `@socket.io/redis-adapter`       |
| Messaging        | RabbitMQ via `amqplib` (inbound from core only) |
| Payments         | Kashier v3 (Payment Sessions + Webhooks)       |
| Background jobs  | `node-cron`                                    |

---

## Architecture at a glance

- **Region-sharded Postgres.** One "hot" Postgres cluster per region (`eg`, `ksa`, ...) holds the current year's data. A parallel **archive** cluster per region holds everything older. The shard key is called `region` in code (it's a country code today).
- **Cold archival worker** (background process, runs nightly): walks `agent_earnings → payment_webhook_events → payment_sessions → transactions → order_items → orders` in batches, moving rows whose timestamp is before the current year from hot to archive, guarded by a Redis lock so only one worker instance runs per region at a time. Reads for prior-year data (`GET /customer/orders?year=`, restaurant order history, admin/owner order lookups) transparently route to the archive cluster.
- **Redis** backs caching (`withCache`), distributed locks (assignment claims, the archival lock), idempotency keys, and agent geo-presence (`GEOADD`/`GEOSEARCH`).
- **RabbitMQ** is inbound-only in this service: it consumes `core.events` (product/branch/restaurant/RBAC changes) for cache invalidation, and drains its own transactional outbox to publish `order.events` for downstream consumers (e.g. analytics). It never calls another service synchronously through the queue.
- **WebSocket** (`socket.io`, Redis-adapter-backed) pushes order/delivery status changes to `customer:<id>`, `restaurant:<id>`, `branch:<id>`, and `agent:<id>` rooms.
- **Two processes**: the HTTP API (`server.ts`) and a separate background worker (`worker.ts`) that runs the assignment tick, the outbox drain, and the archival job. Both need Postgres, Redis, and RabbitMQ reachable to boot.

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

| Script                  | What it does                                                  |
| ------------------------ | -------------------------------------------------------------- |
| `npm run dev`            | API server, hot-reloaded (`tsx watch src/server.ts`)           |
| `npm run worker`         | Background worker, hot-reloaded (`tsx watch src/worker.ts`)    |
| `npm run build`          | `tsc` compile to `dist/`                                       |
| `npm run start`          | Run the compiled API server                                    |
| `npm run start:worker`   | Run the compiled background worker                              |
| `npm run typecheck`      | `tsc --noEmit`                                                  |
| `npm run migrate`        | `knex migrate:latest` for one region (`REGION=eg npm run migrate`) — cluster via `CLUSTER=hot|archive`, defaults to `hot` |
| `npm run migrate:rollback` | Roll back the last migration batch for one region             |
| `npm run migrate:status` | Show migration status for one region                            |
| `npm run migrate:make`   | Scaffold a new migration file                                   |
| `npm run migrate:all`    | Run `migrate:latest` for **every** region in `REGIONS` (`CLUSTER=archive` for the archive cluster) |
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
    │   ├── health/               # GET /api/health — pings every hot + archive shard
    │   ├── order/                 # placement, lifecycle, status machine, customer/restaurant order lists
    │   ├── payment/                # Kashier online sessions, COD, webhook processing, the money ledger
    │   ├── assignment/             # order → delivery-agent auto-assignment worker + manual/admin assign
    │   ├── agent/                  # agent presence (Redis GEO), tasks, earnings, delivery settlement
    │   └── finance/                 # restaurant running balance + payout recording
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

## Modules

| Module | What it owns |
| ------ | ------------- |
| **Orders** (`app/order`) | Placement (stock reserve → order + items → outbox), status machine, customer order history, restaurant order lists, admin overrides. |
| **Payments** (`app/payment`) | Kashier v3 online sessions, COD, webhook processing (idempotent via a unique `(provider_id, provider_event_id)` log), the `transactions` money ledger, refunds. |
| **Assignment** (`app/assignment`) | The background tick that finds ready/unassigned orders, geo-searches nearby online agents (Redis `GEOSEARCH`), and broadcasts claimable offers; manual/admin assignment. |
| **Agents** (`app/agent`) | Delivery-agent presence (Redis GEO + TTL), task list, earnings, and settlement (balance + commission write) on `delivered`. |
| **Finance** (`app/finance`) | Restaurant running balance and payout recording — payouts are a `transaction_type`, not a separate table. |
| **Archival worker** (`lib/jobs/archival.worker.ts`) | *Newest addition.* The only background worker with no HTTP surface — see below. |

### Cold archival worker

Every night (`ARCHIVAL_CRON`, default `0 3 * * *` UTC, one job per region), it moves every row whose timestamp is before the current year from the hot cluster to that region's archive cluster, keeping the hot database small so current-year queries stay fast:

1. Walks tables in FK-safe order — `agent_earnings → payment_webhook_events → payment_sessions → transactions → order_items → orders` — so a crash mid-run never leaves an archived order whose line items or ledger rows didn't make it across yet.
2. Moves rows in batches of `ARCHIVAL_BATCH_SIZE` (default 1000): insert into archive and commit, **then** delete from hot and commit. Archive-first means a crash between the two steps leaves the row in both places (safe — a re-run just no-ops the re-insert via `ON CONFLICT DO NOTHING` and still deletes it from hot) rather than in neither.
3. Is guarded by a Redis lock (`archival:<region>:lock`, `trySet`/SETNX) so two worker processes booting at once can't race the same region; the lock is always released, even on error.
4. Respects `ARCHIVAL_MAX_RUNTIME_MIN` (default 60) — if a run is still going past its budget it stops cleanly and picks up where it left off on the next scheduled tick.

Reads transparently follow the data: `GET /customer/orders?year=` routes entirely to hot or entirely to archive depending on the requested year; `GET /restaurants/:id/branches/:id/orders?from=&to=` fans out to both clusters and merges in memory when the requested range straddles the archive boundary; `GET /orders/:publicId` tries hot first and only retries on archive for `system_admin` or a restaurant `owner` — plain customer order-tracking never pays the extra round-trip.

---

## Environment variables

The full, current list — with inline comments explaining each one — lives in [`.env.example`](./.env.example). A few patterns worth knowing:

- **Per-region shard config** is dynamic, not fixed keys in the schema: for every code in `REGIONS`, the app expects `DB_<region>_HOST/PORT/USERNAME/PASSWORD/NAME` (hot) and `ARCHIVE_DB_<region>_HOST/PORT/USERNAME/PASSWORD/NAME` (archive). Add a region to `REGIONS` and its two DB blocks, and it's live.
- **Region is never in the JWT.** It's resolved per-request from `?region=` query, then `X-Region` header, then a `region` cookie. `all` is preserved for specific admin fan-out reads; writes always resolve to one concrete region.
- Everything is validated by `zod` in `src/lib/config/env.ts` at process boot — a missing required var fails fast with a clear error instead of an obscure runtime crash later.

---

## Further reading

| Doc | Purpose |
| --- | ------- |
| [`CLAUDE.md`](./CLAUDE.md) | The full conventions doc: layering rules, naming, response DTOs, performance/indexing rules, what's out of scope. |
| [`docs/README.md`](./docs/README.md) | Reading order for the rest of the docs. |
| [`docs/system-design.md`](./docs/system-design.md) | Architecture: regions, Redis layers, sync/async with core, Kashier, WebSocket. |
| [`docs/database-design.md`](./docs/database-design.md) | Full schema, FKs, indexes (each justified), sharding plan. |
| [`docs/api-contracts.md`](./docs/api-contracts.md) | Every endpoint's request/response DTOs and error codes. |
| [`docs/business-logic/`](./docs/business-logic) | One file per module: lifecycle, invariants, RBAC. |
| [`docs/implementation-plan.md`](./docs/implementation-plan.md) | The phased build order this service was actually built in. |

## Testing

There's no automated test suite yet. `play/` holds gitignored, throwaway scripts used to manually verify behavior against a real running stack (Postgres/Redis/RabbitMQ/core-service) — see [`play/README.md`](./play/README.md) for what each one checks. They're a reference for how to exercise the service directly, not something to run in CI.
