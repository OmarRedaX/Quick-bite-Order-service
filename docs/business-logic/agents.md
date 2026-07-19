# Business Logic — Agents Module

Owner module: `app/agent/`

Covers agent presence (online/offline/ping), the agent's task list, and earnings reads.

Delivery state transitions on a task live in the **Deliveries** module (PATCH `/deliveries/{id}/status`).

---

## 1. Presence model

The simplest model: **one row per agent** in `agent_presence` with `is_online`, `last_seen_at`, and last `lat/lng`. Historical presence is not retained here.

A small set of Redis keys backs the hot read paths (auto-assignment, dashboards):

| Key                                | Purpose                                          | Updated by                          |
| ---------------------------------- | ------------------------------------------------ | ----------------------------------- |
| `presence:geo:<region>` (geo set)  | All online agents' coordinates                   | online/offline/ping endpoints       |
| `presence:busy:<region>` (set)     | Agents with an active delivery                   | assignment service                  |
| `presence:meta:<region>:<agentId>` | last_seen_at, online flag                        | online/offline/ping                 |

The DB row is the durable source of truth; Redis is a cache + working set. A reconciliation worker every 60s clears stale agents from Redis whose `last_seen_at` is older than the threshold (`PRESENCE_STALE_SEC`, env, default 90s).

---

## 2. Endpoints

| Endpoint                                | Auth        |
| --------------------------------------- | ----------- |
| `POST /agents/presence/online`          | agent       |
| `POST /agents/presence/offline`         | agent       |
| `POST /agents/presence/ping`            | agent       |
| `GET /agents/tasks?status=`             | agent       |
| `GET /agents/earnings?from=&to=`        | agent       |

All authentication via the standard `authenticate` guard. The agent's `userId` is taken from the JWT.

### POST /agents/presence/online

Body:
```ts
class PresenceOnlineRequestDTO {
  lat: number;
  lng: number;
}
```

- UPSERT into `agent_presence` (`is_online=true`, `last_seen_at=NOW()`, `last_lat/last_lng`).
- Add to `presence:geo:<region>` and `presence:meta:<region>:<agentId>`.
- Remove from `presence:busy:<region>` if present (going online resets state — agent should not have an active delivery if they were just offline; defensive).
- Response: `{ ok: true }`.

### POST /agents/presence/offline

- UPDATE `is_online=false`, `last_seen_at=NOW()`.
- Remove from `presence:geo` and `presence:busy`.
- If agent has an active delivery (`assigned` or `accepted`) → trigger reassignment. (If `picked` → block: agent must complete the active task first → 409.)
- Response: `{ ok: true }`.

### POST /agents/presence/ping

Body: same as online.

- UPDATE `last_seen_at=NOW()`, `last_lat/last_lng` (only if `is_online=true`; otherwise no-op + 409 with hint to call online first).
- Update Redis `presence:geo` (GEOADD) + `presence:meta`.
- Response: `{ ok: true }`.

Frequency: clients ping every 30s while moving. If a customer's WebSocket subscribes to `delivery.position`, the ping payload is also fanned out to that customer's channel.

---

## 3. GET /agents/tasks?status=

- Lists deliveries assigned to the calling agent, optionally filtered by status (`assigned|accepted|picked|delivered`).
- Cursor pagination by `assigned_at DESC`.
- Response: `DeliveryTaskResponseDTO[]` with order summary (subtotal, item count) + customer drop-off summary.
- Backed by `idx_deliveries_agent_id_status_assigned_at`.
- Cached `withCache(5)` per-user; invalidated on every status transition for the agent.

---

## 4. GET /agents/earnings?from=&to=

- Sums and lists `agent_earnings` rows in the date range.
- Defaults: `from = first day of current month`, `to = NOW()`.
- Returns:
  ```ts
  class AgentEarningsResponseDTO {
    range: { from: string; to: string };
    totals: { count: number; sum: number; currency: string };
    items: Array<{
      orderPublicId: string;
      amount: number;
      currency: string;
      earnedAt: string;
    }>;
    nextCursor: string | null;
  }
  ```
- Backed by `idx_agent_earnings_agent_earned_at`.
- For older ranges (prior years) the query is routed to the archive cluster (Phase 7).

---

## 5. Auto-assignment integration

The Deliveries module's assignment service reads from `presence:geo:<region>` (Redis). Source of truth is `agent_presence` in Postgres. If Redis is cold/empty, the assignment service falls back to:

```sql
SELECT agent_id, ST_Distance(location, ST_MakePoint(?, ?)::geography) AS dist
FROM agent_presence
WHERE is_online = TRUE
  AND last_seen_at > NOW() - INTERVAL '90 seconds'
ORDER BY location <-> ST_MakePoint(?, ?)::geography
LIMIT 5;
```

(Uses the partial GIST index `idx_agent_presence_location_gist`.)

---

## 6. Invariants

1. `is_online=true` ⇒ Redis presence keys present.
2. `is_online=false` ⇒ Redis presence keys absent.
3. An agent in `presence:busy:<region>` always has a `deliveries` row in `('assigned','accepted','picked')`.
4. Going offline while in `picked` is forbidden.

---

## 7. RBAC

All endpoints are agent-self only — no role-based permission system here. The service asserts `req.user.role === 'delivery_agent'` and `req.user.userId === resourceAgentId`.

---

## 8. WebSocket events

| Event              | Channel        | Payload                                    |
| ------------------ | -------------- | ------------------------------------------ |
| `task.assigned`    | `agent:<id>`   | `DeliveryTaskResponseDTO`                  |
| `task.cancelled`   | `agent:<id>`   | `{ deliveryId, reason }`                   |
| `delivery.position`| `customer:<id>`| `{ deliveryId, lat, lng, ts }` (from ping) |
