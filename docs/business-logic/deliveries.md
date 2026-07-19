# Business Logic — Deliveries Module

Owner module: `app/delivery/`

Responsible for converting a `ready` order into a delivery (assignment), tracking the delivery lifecycle, and supporting reassignment.

---

## 1. Delivery status machine

```
assigned ─► accepted ─► picked ─► delivered (terminal)
   │           │           │
   │           ▼           ▼
   │        rejected    cancelled
   │           │
   ▼           ▼
reassigned (creates new row)
```

| Status        | Meaning                                                  | Who writes |
| ------------- | -------------------------------------------------------- | ---------- |
| `assigned`    | Delivery row created; agent notified                     | system / system_admin (manual) |
| `accepted`    | Agent accepted the task                                  | agent      |
| `rejected`    | Agent declined the task → triggers reassignment          | agent      |
| `picked`      | Agent confirmed pickup at branch                         | agent      |
| `delivered`   | Agent confirmed handoff at customer location             | agent → terminal; triggers money settlement |
| `cancelled`   | Order was cancelled while in delivery → release agent    | system     |
| `reassigned`  | Agent rejected or timed out; superseded by new row       | system     |

`orders.delivery_agent_id` mirrors the **current** delivery's agent (denormalized for the agent task list).

---

## 2. POST /deliveries/assign/{orderId}

Two callers:
1. **System** (auto): triggered when `orders.status` becomes `ready`.
2. **Admin** (manual): admin can force-assign or override.

### Algorithm (auto)

1. Resolve region from order.
2. Validate order is `ready` and has no active delivery (no row with `status IN ('assigned','accepted','picked')`).
3. **Find candidate agents** — `lib/sharding`-aware:
   - Read from Redis geo set `presence:geo:<region>` (built by presence pings).
   - `GEOSEARCH` within `ASSIGNMENT_RADIUS_METERS` (env, default 5000m) of the branch coords.
   - Filter to agents with no active delivery (a Redis set `presence:busy:<region>` is maintained on assignment/release).
   - Sort by distance, take top `K` (env, default 5).
4. For each candidate (in order):
   - In a trx:
     - SELECT agent_presence FOR UPDATE; verify `is_online=TRUE`, `last_seen_at > NOW() - 90s`.
     - Insert `deliveries` row (`status='assigned'`).
     - Update `orders.status='assigned'`, `delivery_agent_id`, `assigned_at`.
     - Mark agent busy in Redis.
     - Commit.
   - Push WS to `agent:<id>` with the task. Wait for `accepted` or timeout.
   - **Acceptance window**: agent has `AGENT_ACCEPT_TIMEOUT_SEC` (env, default 30s) to accept. If no accept → mark this delivery `rejected`, mark agent free in Redis (lightly penalize), retry next candidate.
5. If all candidates fail → fall through to **broadcast mode**: WS push to all online agents in radius; first to claim wins (claim is `PATCH /deliveries/{id}/status accept`, atomic).
6. If broadcast also fails after `MAX_REASSIGNMENT_ATTEMPTS` (env, default 3) → publish `assignment.unassigned_alert` WS to admin channel; order stays `ready`.

### Algorithm (manual)

- Admin specifies `agentId` in body.
- Skip candidate scoring; insert `deliveries` directly.
- All other side effects identical.

### Idempotency

- The `deliveries` table is the natural idempotency: an order with an active delivery cannot be re-assigned. Returns 409 if requested.

---

## 3. POST /deliveries/reassign/{orderId}

- Marks the active `deliveries` row `status='reassigned'`, `reassigned_at`.
- Calls the assignment algorithm again. New `deliveries` row references `reassigned_from = old_id`.
- Limits: `MAX_REASSIGNMENT_ATTEMPTS` total per order (counted via the chain). Beyond that → 409 + admin alert.

---

## 4. PATCH /deliveries/{deliveryId}/status

Single endpoint for agent actions. Body: `{ status }`. Allowed transitions per actor:

| Current  | Target     | Actor   |
| -------- | ---------- | ------- |
| assigned | accepted   | agent   |
| assigned | rejected   | agent   |
| accepted | picked     | agent   |
| picked   | delivered  | agent   |

Anything else → 409.

### Side effects

- `accepted` → stamp `accepted_at`; WS to customer + branch.
- `rejected` → stamp `rejected_at`; trigger reassignment.
- `picked` → stamp `picked_at`; mirror to `orders.status='picked'`, `picked_at`; WS to customer + branch.
- `delivered` → stamp `delivered_at`; **money settlement trx** (see §5); mirror to `orders.status='delivered'`, `delivered_at`; WS to all parties.

---

## 5. Settlement on `delivered`

In the same DB trx as the status flip:

1. SELECT `restaurant_balances` FOR UPDATE for `(restaurant_id, currency)`.
2. Compute `commission = floor(subtotal × branch.commissionRate)`. Update `orders.commission`.
3. For online: ensure the `transactions(type='charge', status='succeeded')` exists (must, by design).
4. For COD: flip `transactions(type='cod_collection')` from `pending` → `succeeded`.
5. Insert `transactions(type='commission', method='system', status='succeeded', amount=commission, src=ownerId, dst=NULL)`.
6. Update `restaurant_balances.balance += subtotal - commission`.
7. Compute `agentEarning = base_fee + per_km × distance_km` (env-configurable rate; today simply `branch.delivery_fee × agentShareRate`).
8. Insert `agent_earnings(agent_id, order_id, delivery_id, amount, currency)` (unique on `delivery_id` makes it idempotent).
9. (No outbound events; clients are notified via WebSocket.)

All in one trx. Failure rolls back the whole thing — no partial settlement.

---

## 6. Cancellation while in delivery

- If order is cancelled while delivery is `assigned` or `accepted`:
  - Mark delivery `cancelled`.
  - Release agent in Redis.
  - WS to agent (`task.cancelled`).
- If cancelled after `picked`: this is a complex policy decision (food already with agent). For now, **forbidden** by the order-status validator (must be `delivered` or returned via a separate "issue" flow not in scope).

---

## 7. RBAC

| Action                                          | Role                                              |
| ----------------------------------------------- | ------------------------------------------------- |
| `POST /deliveries/assign/{orderId}` (manual)    | `system_admin`                                    |
| `POST /deliveries/reassign/{orderId}`           | `system_admin`                                    |
| `PATCH /deliveries/{id}/status` (accept/pickup/deliver) | the assigned `delivery_agent`             |

Permission `deliveries:assign` (admin-only). Agents are not RBAC-permissioned for their own task — ownership check in service.

---

## 8. Invariants

1. An order has at most one active delivery (`status IN ('assigned','accepted','picked')`).
2. `deliveries.status='delivered'` implies `agent_earnings(delivery_id)` exists.
3. `deliveries.status='delivered'` implies `restaurant_balances.balance` was incremented atomically.
4. Reassignment chain length ≤ `MAX_REASSIGNMENT_ATTEMPTS`.
5. `delivery.agent_id` matches the actor on every PATCH (no agent can act on another agent's delivery).

---

## 9. Performance notes

- Assignment radius scan must come from **Redis** in steady state. Postgres GIST is the fallback if Redis is empty/cold.
- The Redis geo set is updated on every presence ping (write-through). Online/offline transitions add/remove the agent.
- `idx_deliveries_agent_id_status_assigned_at` covers the agent task list query.
- The denormalized `orders.delivery_agent_id` covers the simpler "what's my current task" customer-side lookup.

---

## 10. WebSocket events emitted

| Event             | Channel              | Payload (response DTO)                              |
| ----------------- | -------------------- | --------------------------------------------------- |
| `task.assigned`   | `agent:<id>`         | `DeliveryTaskResponseDTO`                           |
| `task.cancelled`  | `agent:<id>`         | `{ deliveryId, reason }`                            |
| `delivery.status_changed` | `customer:<id>`, `branch:<id>` | `{ orderId, status, ts, agent: { id, name, phone? } }` |
