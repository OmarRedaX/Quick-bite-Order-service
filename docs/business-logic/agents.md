# Business Logic — Agents Module

Owner module: `app/agent/`

Covers agent presence, the agent's task list, accept/reject of broadcast offers, and earnings reads.

The order's status transitions on a task (`picked`, `delivered`) live in the **Order** module behind the same `PATCH /orders/:publicId/status` endpoint, scoped by the new route pattern `/restaurants/:restaurantId/branches/:branchId/...` for restaurant-side calls. Agent-side calls go through `/agents/orders/:publicId/status`.

---

## 1. Presence model — Redis only

There is **no `agent_presence` table.** Presence has a 5-minute relevance window and no audit value, so it lives entirely in Redis. Schema is documented in `database-design.md` §8. Recap:

| Key                                  | Purpose                                                | TTL    |
| ------------------------------------ | ------------------------------------------------------ | ------ |
| `presence:meta:<region>:<agentId>`   | hash `{lat, lng, lastSeenAt}` — existence = "online"   | 300 s  |
| `presence:geo:<region>`              | geo set used by the assignment GEOSEARCH               | none   |
| `presence:busy:<region>`             | set of agent ids holding an active assignment          | none   |

A ping refreshes the TTL → if pings stop the agent silently goes offline.

---

## 2. Endpoints

| Endpoint                                                      | Auth                  |
| ------------------------------------------------------------- | --------------------- |
| `POST /agents/presence/online`                                | agent                 |
| `POST /agents/presence/ping`                                  | agent                 |
| `POST /agents/presence/offline`                               | agent                 |
| `GET /agents/tasks?status=`                                   | agent                 |
| `GET /agents/earnings?from=&to=`                              | agent                 |
| `POST /agents/orders/:publicId/accept`                        | agent (the offered one) |
| `POST /agents/orders/:publicId/reject`                        | agent (the offered one) |
| `PATCH /agents/orders/:publicId/status`                       | agent (the assigned one) |

Authentication: standard `authenticate` guard; the JWT carries `userId`. There is no separate `agentId` — the user IS the agent. The `requireAgent` guard asserts `req.user.role === 'delivery_agent'`.

### POST /agents/presence/online

Body:
```ts
class PresenceOnlineRequestDTO {
  lat: number;
  lng: number;
}
```

- `HSET presence:meta:<region>:<userId> lat lng lastSeenAt` + `EXPIRE 300`.
- `GEOADD presence:geo:<region> lng lat <userId>`.
- `SREM presence:busy:<region> <userId>` defensively (going online resets state).
- Response: `{ ok: true }`.

### POST /agents/presence/ping

Same body. Same Redis writes (UPSERT — refreshes the TTL). Response: `{ ok: true }`.

Frequency: clients ping every 30–60s and on meaningful location changes.

### POST /agents/presence/offline

- `DEL presence:meta:<region>:<userId>` + `ZREM presence:geo:<region> <userId>`.
- If the agent currently holds an order in status `picked` → 409 `OfflineWhilePickedForbidden` (would orphan in-flight food). For `assigned`, the order is released to the assignment worker on the next tick.
- `SREM presence:busy:<region> <userId>`.
- Response: `{ ok: true }`.

---

## 3. POST /agents/orders/:publicId/accept

Triggered by the agent in response to a `task.offered` WS event.

1. Fetch order; assert status is `ready` and `delivery_agent_id IS NULL`.
2. Verify the calling agent appears in the candidate list (`GET offer:order:<orderId>` → comma-separated ids).
3. **Atomic claim**: `SET claim:order:<orderId> <agentId> NX EX 300`. If `NX` fails → another agent already accepted → 409 `OrderAlreadyClaimed`.
4. In a DB trx:
   - `UPDATE orders SET status='assigned', delivery_agent_id=<agentId>, assigned_at=now() WHERE public_id=? AND status='ready' AND delivery_agent_id IS NULL`. RETURNING. If 0 rows → release the SETNX claim and return 409.
   - Commit.
5. Redis: `SADD presence:busy:<region> <agentId>`, `DEL offer:order:<orderId>`.
6. WS:
   - `agent:<winnerId>:task.assigned` → full `DeliveryTaskResponseDTO`.
   - `agent:<loserId>:offer.cancelled` for every other id in the candidate list → `{ orderId, reason: "claimed_by_other" }`.
   - `customer:<customerId>:order.status_changed` and `branch:<branchId>:order.status_changed` → `OrderStatusResponseDTO`.
7. Return the `DeliveryTaskResponseDTO`.

## 4. POST /agents/orders/:publicId/reject

- Verify the agent is in the candidate list.
- Remove this agent's id from the comma-separated list at `offer:order:<orderId>` (if it's the last one, delete the key).
- Bump `assign:attempts:<orderId>` so the worker knows this round failed.
- Response: `{ ok: true }`. No DB writes — the worker re-broadcasts on its next tick if the offer key has expired.

## 5. PATCH /agents/orders/:publicId/status

Body: `{ status: 'picked' | 'delivered' }`. Reuses the order status machine (`assertTransition`):
- `assigned → picked` (agent only).
- `picked → delivered` (agent only) → **runs the settlement trx**.

Side effects of `delivered` (one trx — see Restaurant-finance.md §7):
- For COD: insert `transactions(type='cod_collection', status='succeeded')` (no pending row at placement time — see Orders.md §3).
- Compute `commission = floor(subtotal × branch.commissionBps / 10000)`. `UPDATE orders SET commission=?` in the same trx.
- Insert `transactions(type='commission', status='succeeded', src_acc_id=restaurantOwnerId, dst_acc_id=NULL, amount=commission)`.
- `INSERT INTO restaurant_balances ... ON CONFLICT (restaurant_id, currency) DO UPDATE SET balance = restaurant_balances.balance + EXCLUDED.balance` for `(subtotal - commission)`.
- Insert `agent_earnings(agent_id, order_id, amount, currency)` where `amount = floor(order.delivery_fee × AGENT_EARNING_SHARE_BPS / 10000)`. Unique on `order_id` makes this idempotent.
- Redis: `SREM presence:busy:<region> <agentId>`.
- WS: `customer:<id>` and `branch:<id>` `order.status_changed`.

---

## 6. GET /agents/tasks?status=

- Lists `orders WHERE delivery_agent_id = <userId> [AND status=...]`.
- Cursor pagination by `assigned_at DESC`.
- Backed by `idx_orders_delivery_agent_id_status` (partial WHERE `delivery_agent_id IS NOT NULL`).

## 7. GET /agents/earnings?from=&to=

- `SELECT ... FROM agent_earnings WHERE agent_id = <userId> AND earned_at BETWEEN ? AND ?`.
- Defaults: `from = first day of current month`, `to = NOW()`.
- Cursor pagination by `earned_at DESC`.
- Backed by `idx_agent_earnings_agent_earned_at`.

---

## 8. RBAC

All endpoints are agent-self only. Service asserts `req.user.role === 'delivery_agent'` and that the called-out resource belongs to this agent (e.g., the order being accepted/picked/delivered has `delivery_agent_id = req.user.userId` for status moves).

---

## 9. WebSocket events

| Event                  | Channel              | Payload                                                |
| ---------------------- | -------------------- | ------------------------------------------------------ |
| `task.offered`         | `agent:<id>`         | `{ orderId, branch:{id,lat,lng,name,addressText}, dropoff:{lat,lng,addressText}, total, currency, expiresAt }` |
| `offer.cancelled`      | `agent:<id>`         | `{ orderId, reason }` (`claimed_by_other`, `expired`)  |
| `task.assigned`        | `agent:<id>`         | `DeliveryTaskResponseDTO`                              |
| `task.cancelled`       | `agent:<id>`         | `{ orderId, reason }` (admin/customer cancel)          |
| `order.status_changed` | `customer:<id>`, `branch:<id>` | `OrderStatusResponseDTO`                       |
