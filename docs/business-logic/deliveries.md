# Business Logic — Deliveries (assignment & lifecycle)

There is **no `deliveries` table** and no separate `app/delivery/` module. Delivery state lives on the `orders` row and the user-facing actions live in:
- `app/agent/` — presence + accept/reject/picked/delivered (see `agents.md`).
- `app/order/` — restaurant + customer status transitions (see `orders.md`).
- `app/assignment/` — the broadcast-to-N-candidates assignment service + its background worker (this file).

This file covers ONLY the assignment algorithm (broadcast offer + claim) and the in-flight order's life on the `orders` row.

---

## 1. Order status that this module owns

| Status      | Set by                          | Triggered by                                  |
| ----------- | ------------------------------- | --------------------------------------------- |
| `assigned`  | `assignment.service` (claim)    | first agent to call `POST /agents/orders/:id/accept` |
| `picked`    | `agent.service`                 | `PATCH /agents/orders/:id/status` with `picked` |
| `delivered` | `agent.service` (settlement)    | `PATCH /agents/orders/:id/status` with `delivered` |
| `cancelled` (from `assigned`) | admin only       | `PATCH /restaurants/:rid/branches/:bid/orders/:id/status` |

`picked → cancelled` is forbidden for everyone (food is in transit; resolve via a future "issue" flow).

---

## 2. Assignment — broadcast to top N candidates

### Trigger

A background worker (`src/worker.ts`, registered as `npm run worker`) ticks every `ASSIGNMENT_TICK_SEC` (env, default 10s). Per region:

```sql
SELECT id, public_id, branch_id, restaurant_id, total, currency,
       delivery_lat, delivery_lng, delivery_address_text_snapshot
FROM orders
WHERE status = 'ready'
  AND delivery_agent_id IS NULL
ORDER BY created_at ASC
LIMIT BATCH;
```

For each row: `assignment.service.tryAssign(order)`. Backed by `idx_orders_status_created_at` (partial WHERE `status IN ('ready','assigned')`).

### Algorithm

1. **Skip if there's a live offer**: `EXISTS offer:order:<orderId>` → already broadcast within the last 30s, leave it for the agents to act on.
2. **Skip if attempts exhausted**: `assign:attempts:<orderId> >= MAX_REASSIGNMENT_ATTEMPTS` → emit `admin:alerts:assignment.exhausted` WS, leave the order in `ready`. Operator unsticks via `POST /admin/orders/:publicId/assign`.
3. **Find candidates**:
   ```
   GEOSEARCH presence:geo:<region> FROMLONLAT <branch.lng> <branch.lat>
             BYRADIUS <ASSIGNMENT_RADIUS_METERS> m ASC COUNT (5*OVERSCAN)
   ```
   For each returned `agentId`:
   - Drop if `EXISTS presence:meta:<region>:<agentId>` returns 0 (TTL expired but geo entry stale).
   - Drop if `SISMEMBER presence:busy:<region> <agentId>` returns 1 (currently holds an order).
   - Take the first 5 survivors by distance.
4. **No candidates** → bump `assign:attempts:<orderId>`, emit metric, return.
5. **Broadcast** the offer:
   - `SET offer:order:<orderId> "<id1>,<id2>,..." EX 30 NX` (the NX ensures we don't overwrite a live offer).
   - WS `agent:<id>:task.offered` to each candidate with the offer payload (orderId, branch coords + name + address, dropoff coords + address, total, currency, expiresAt = now + 30s).
   - `INCR assign:attempts:<orderId>` with TTL 1h.

### Claim — see `agents.md` §3 (`POST /agents/orders/:publicId/accept`)

The first acceptor wins via `SET claim:order:<orderId> <agentId> NX EX 300`. Losers are notified `offer.cancelled` reason `claimed_by_other`.

### Reassignment

- Triggered automatically by the next worker tick once `offer:order:*` has expired (no acceptance) AND `claim:order:*` does not exist.
- Triggered immediately by an agent calling `POST /agents/presence/offline` while holding an order in `assigned` (not `picked`):
  - The order is reset: `UPDATE orders SET delivery_agent_id=NULL, status='ready', assigned_at=NULL WHERE public_id=? AND status='assigned'`.
  - `SREM presence:busy:<region> <agentId>`, `DEL claim:order:<orderId>`.
  - Worker picks it up on the next tick.
- `MAX_REASSIGNMENT_ATTEMPTS` (env, default 3) caps the total broadcast rounds. After the cap, admin alert.

### Admin override

`POST /admin/orders/:publicId/assign` (body `{ agentId }`) skips the broadcast entirely:
- Verifies the agent exists in core via `core-client.getAgent`.
- Force-claims regardless of distance/busy state (admin assumes the responsibility).
- Same DB writes + WS as the normal claim.

---

## 3. Settlement on `delivered`

Triggered by `PATCH /agents/orders/:publicId/status` with `delivered`. Same trx, in this order:

1. `SELECT restaurant_balances WHERE restaurant_id=? AND currency=? FOR UPDATE` (or insert a zero row first, then re-select).
2. Compute `commission = floor(subtotal × branch.commissionBps / 10000)`. `UPDATE orders SET status='delivered', delivered_at=now(), commission=?`.
3. **Charge transaction**:
   - For online: a `charge / succeeded` row was already written by the Kashier webhook — no-op here.
   - For COD: insert `transactions(type='cod_collection', method='cash', status='succeeded', amount=order.total, src_acc_id=order.customer_id, dst_acc_id=order.restaurant_owner_id, idempotency_key='cod-collect:' || order.public_id)` — unique on `idempotency_key` makes this safe.
4. **Commission transaction**: insert `transactions(type='commission', method='system', status='succeeded', amount=commission, src_acc_id=order.restaurant_owner_id, dst_acc_id=NULL, idempotency_key='commission:' || order.public_id)`.
5. **Restaurant balance**: `INSERT INTO restaurant_balances (restaurant_id, region, currency, balance) VALUES (?, ?, ?, ?) ON CONFLICT (restaurant_id, currency) DO UPDATE SET balance = restaurant_balances.balance + EXCLUDED.balance, updated_at=now()` for `subtotal - commission`.
6. **Agent earning**: insert `agent_earnings(agent_id, order_id, amount, currency)` with `amount = floor(order.delivery_fee × AGENT_EARNING_SHARE_BPS / 10000)`. Unique on `order_id` → idempotent.
7. Commit.
8. After-commit: `SREM presence:busy:<region> <agentId>`, `DEL claim:order:<orderId>`. WS to customer + branch.

Failure rolls back the whole thing — no partial settlement.

---

## 4. Cancellation while in delivery

- `assigned → cancelled` (admin only): clear `delivery_agent_id`, stamp `cancelled_at`, `SREM presence:busy`, `DEL claim:order:*`. WS `task.cancelled` to the agent.
- `picked → cancelled`: forbidden. Out-of-scope for this milestone.

---

## 5. Invariants

1. An order in `assigned` always has `delivery_agent_id NOT NULL`.
2. An order in `delivered` always has `agent_earnings(order_id)`, `restaurant_balances` updated, and (for COD) one `cod_collection / succeeded` transaction.
3. `presence:busy:<region>` membership ⇔ the agent has an `orders` row in `(assigned, picked)`.
4. `MAX_REASSIGNMENT_ATTEMPTS` cap — beyond that the order stays `ready` until admin override.
5. The settlement trx is the only writer to `restaurant_balances.balance`'s positive side (payouts are the negative side).

---

## 6. WebSocket events emitted

(Full table is in `agents.md` §9; restating here for the reader who arrived via this doc.)

| Event                  | Channel                        | Payload                                              |
| ---------------------- | ------------------------------ | ---------------------------------------------------- |
| `task.offered`         | `agent:<id>` × N candidates    | offer payload                                        |
| `offer.cancelled`      | `agent:<id>` × losers / on offline | `{ orderId, reason }`                            |
| `task.assigned`        | `agent:<id>` (winner)          | `DeliveryTaskResponseDTO`                            |
| `task.cancelled`       | `agent:<id>`                   | `{ orderId, reason }`                                |
| `order.status_changed` | `customer:<id>`, `branch:<id>` | `OrderStatusResponseDTO`                             |
| `assignment.exhausted` | `admin:alerts`                 | `{ orderId, attempts }`                              |
