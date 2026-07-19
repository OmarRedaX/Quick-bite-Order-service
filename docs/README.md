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
