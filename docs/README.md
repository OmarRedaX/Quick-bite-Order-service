# `order-service` documentation

Read in this order on your first pass.

| # | Doc                                                      | Purpose                                                                        |
| - | -------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 1 | [`../CLAUDE.md`](../CLAUDE.md)                           | Project guidelines, layering, naming, performance/sharding rules.              |
| 2 | [`system-design.md`](./system-design.md)                 | Architecture: regions, Redis layers, sync/async with core, Kashier, WebSocket. |
| 3 | [`database-design.md`](./database-design.md)             | Full schema, FKs, indexes (each justified), sharding plan, migration order.    |
| 4 | [`folder-structure.md`](./folder-structure.md)           | Annotated tree; `pkg`/`lib`/`app` boundary rules.                              |
| 5 | [`api-contracts.md`](./api-contracts.md)                 | Every endpoint's request/response DTOs, headers, error codes, WS protocol.     |
| 6 | [`business-logic/orders.md`](./business-logic/orders.md) | Order lifecycle, status machine, cancellation rules.                           |
| 7 | [`business-logic/payments.md`](./business-logic/payments.md) | Online/COD, Kashier session lifecycle, webhook handling, refunds.          |
| 8 | [`business-logic/deliveries.md`](./business-logic/deliveries.md) | Assignment algorithm, settlement on delivered, reassignment.           |
| 9 | [`business-logic/agents.md`](./business-logic/agents.md) | Presence model, task list, earnings.                                           |
|10 | [`business-logic/restaurant-finance.md`](./business-logic/restaurant-finance.md) | Balance/payout reads, admin payout recording.                |
|11 | [`business-logic/rbac.md`](./business-logic/rbac.md)     | Permissions seeded in core, per-endpoint mapping, cached resolution.            |
|12 | [`implementation-plan.md`](./implementation-plan.md)     | Sequenced build order with acceptance gates.                                   |

## Local setup (verified)

See the root [`README.md`](../README.md) for the full step-by-step (including `.env.example`). Quick recap:

1. Create the per-region Postgres databases named in `.env` — hot (`DB_<region>_NAME`) and archive (`ARCHIVE_DB_<region>_NAME`) — for every region listed in `REGIONS`.
2. Apply migrations per region: `REGION=eg npm run migrate` (repeat per region), or `npm run migrate:all` to run every configured region's **hot** cluster in one pass. The **archive** cluster runs the identical migration set — `CLUSTER=archive npx tsx scripts/migrate-all.ts` — needed before the archival worker (Phase 5) has anywhere to write.
3. `KASHIER_MERCHANT_ID`, `KASHIER_API_KEY`, `KASHIER_SECRET_KEY`, `KASHIER_RETURN_URL`, `KASHIER_FAIL_URL`, `KASHIER_WEBHOOK_URL` have no defaults in `env.ts` — the app will not boot without them. Kashier's session API also rejects non-`https` redirect/webhook URLs, even against the test sandbox.
4. `npm run dev` (API) and `npm run worker` (assignment-tick + outbox-drain + nightly archival cron jobs) are separate processes; both need Postgres (hot **and** archive), Redis, and RabbitMQ reachable to start cleanly.
5. `GET /api/health` pings every configured hot **and** archive shard and returns `503` if any one of them is unreachable.
6. The archival worker's own knobs (`ARCHIVAL_CRON`, `ARCHIVAL_TIMEZONE`, `ARCHIVAL_BATCH_SIZE`, `ARCHIVAL_MAX_RUNTIME_MIN`) all have defaults — see `.env.example` — so no extra config is required to get it running, only the migrated archive databases from step 2.
