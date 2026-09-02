# QuickBite — Manual QA Test Guide

A scripted run-book for full-cycle manual testing of `core-service` + `order-service`. Hit the requests in order; the Postman collection auto-captures the tokens and IDs you need between steps.

> **Convention:** everything below assumes you've just run `npm run seed` from `order-service/` — so user 1 is admin, restaurant 1 is "Tasty Bites", branch 1 is Cairo (EG), branch 2 is Riyadh (KSA), and products 1–5 are pre-priced and in stock.

---

## 0. Prerequisites

| Component | Where | Expected |
|---|---|---|
| Postgres   | localhost:5432 | `postgres` / `postgres`; dbs: `quickbite_core`, `order_service_eg`, `order_service_ksa` (+ archives) |
| Redis      | localhost:6379 | no password |
| RabbitMQ   | localhost:5672 | guest / guest (UI on :15672 if enabled) |
| core-service | `http://localhost:3000` | `npm run dev` from `core-service/` |
| order-service API | `http://localhost:4000` | `npm run dev` from `order-service/` |
| order-service worker | (no port — runs crons + WS adapter) | `npm run worker` from `order-service/` |

### Bootstrap (run once, or after any schema change)

```powershell
# Core
cd core-service
npm install
npm run migrate

# Order
cd ..\order-service
npm install
npm run migrate:all                # both regions
npm run seed                       # clean + seed everything, recreate partitions
```

### Start the stack (3 separate terminals)

```powershell
# Terminal 1
cd core-service
npm run dev
```

```powershell
# Terminal 2
cd order-service
npm run dev
```

```powershell
# Terminal 3
cd order-service
npm run worker
```

> The **worker** is what runs the assignment-tick cron and the outbox drainer. Without it, orders go `ready` and never get offered to agents.

### Load Postman files

1. Postman → File → Import → drop these three files from `order-service/postman/`:
   - `QuickBite.postman_environment.json`
   - `core-service.postman_collection.json`
   - `order-service.postman_collection.json`
2. Set the environment dropdown (top-right) to **QuickBite Local**.

### Seeded accounts (passwords)

| Role | Email | Password |
|---|---|---|
| System admin    | `admin@quickbite.test`     | `Admin@1234` |
| Customer        | `customer@quickbite.test`  | `Customer@1234` |
| Restaurant owner | `owner@quickbite.test`    | `Owner@1234` |
| Branch manager (EG branch) | `manager@quickbite.test` | `Manager@1234` |
| Staff (EG branch) | `staff@quickbite.test`    | `Staff@1234` |
| Agent EG        | `agent.eg@quickbite.test`  | `Agent@1234` |
| Agent KSA       | `agent.ksa@quickbite.test` | `Agent@1234` |

---

## 1. Warm-up — health + auth (5 min)

1. **Core / Health → `GET /health`** — should be `{success: true, ...}`.
2. **Order / Health → `GET /health (all shards)`** — both shards report `ok: true`.
3. **Core / Auth → Login — customer** → token saved to `customerAccessToken`.
4. **Core / Auth → Login — owner** → `ownerAccessToken`.
5. **Core / Auth → Login — branch manager** → `managerAccessToken`.
6. **Core / Auth → Login — agent EG** → `agentEgAccessToken`.
7. **Core / Auth → Login — admin** → `adminAccessToken`.

> If a follow-up request returns 401, the access token's hour TTL probably expired or you forgot to re-run that login after the last seed.

Sanity:
- **Core / User → `GET /user/me (customer)`** → `{id: 2, email: "customer@quickbite.test", ...}`.
- **Core / User → `GET /user/me (owner)`** → `{id: 3, ...}`.

---

## 2. Pre-checkout browse (customer view)

1. **Core / Restaurant → `GET /restaurants`** — Tasty Bites appears, status `active`.
2. **Core / Branch → `GET /branches/nearby (Cairo)`** (`lat=30.05, lng=31.24`) — returns branch 1.
3. **Core / Branch → `GET /restaurants/:id/branches`** — both branches listed.
4. **Core / Product → `GET /branches/:id/products` (EG branch)** — 5 products with `isAvailable: true` and non-zero stock.
5. **Core / Customer Address → `GET /customer/addresses`** — two addresses (EG `id=1`, KSA `id=2`).

---

## 3. Full happy-path — COD order on EG, restaurant accept, agent deliver (~10 min)

This is the canonical end-to-end. Open a WS client (see §8) before step 3.4 if you want to verify broadcasts.

### 3.1 Customer places COD order
- **Order / Order — Customer → Place order — COD (customer, EG)**
- Body uses `branchId=1`, `addressId=1`, items = `2× Classic Burger + 1× Cola`.
- Expected `status: "placed"` (COD skips `pending_payment`).
- Postman test captures `orderPublicId`.
- Worker logs should show an outbox row drained → routing key `order.placed` published to RabbitMQ exchange `order.events`.

### 3.2 Restaurant sees the order
- **Order / Order — Restaurant → GET branch order list (manager)**
- Cache TTL is 10s; if your order doesn't show, wait 10s or change the query.

### 3.3 Restaurant accepts → preparing → ready
- **Order / Order — Restaurant → Accept order (manager)** → `status: "accepted"`.
- **Order / Order — Restaurant → Mark preparing (manager)** → `"preparing"`.
- **Order / Order — Restaurant → Mark ready (manager) → triggers assignment loop** → `"ready"`.

> The `ready` transition makes the order eligible for the assignment cron. The worker will pick it up on the next tick (default 10s).

### 3.4 Agent goes online, receives offer
- **Order / Agent → Presence ONLINE (agent EG)** — body sends a lat/lng *inside* the EG branch's delivery radius.
- Within 10s the worker fires `assignment-tick:eg`. The cron does a Redis GEOSEARCH around the branch, picks the agent (only one is online), SETNX's an `offer:order:<publicId>` key and emits the `task.offered` WS event on channel `agent:<agentUserId>`.
- (Watch the WS client — see §8.)

### 3.5 Agent accepts
- **Order / Agent → Accept offer (agent EG)** — order moves to `assigned`.
- WS broadcasts:
  - `task.assigned` → `agent:6`
  - `order.status_changed` → `customer:2` + `branch:1`

### 3.6 Agent picks up and delivers
- **Order / Agent → Mark PICKED (agent EG)** → `picked`.
- **Order / Agent → Mark DELIVERED (agent EG)** → `delivered` + settlement runs:
  - Transactions row inserted (type=`commission` for restaurant share)
  - `restaurant_balances` for currency=`EGP` gets credited
  - `agent_earnings` row inserted (80% of the order's `delivery_fee` by default — `AGENT_EARNING_SHARE_BPS=8000`)

### 3.7 Verify post-state
- **Order / Order — Customer → `GET /orders/:publicId`** — status `delivered`, full history populated.
- **Order / Agent → `GET /agents/earnings`** — one earning entry visible.
- **Order / Finance → `GET /restaurants/:id/balance`** — non-zero balance in EGP.

---

## 4. Full happy-path — ONLINE order on EG, Kashier session (~10 min)

Requires `KASHIER_*` env to be valid and the order-service publicly reachable (or ngrok'd) for the webhook to come back. Otherwise stop after 4.2 and verify the session was created.

### 4.1 Customer places ONLINE order
- **Order / Order — Customer → Place order — ONLINE (customer, EG)**
- Response includes `payment: { redirectUrl, providerSessionId, ... }`.
- Order is `pending_payment` until Kashier confirms.
- Postman captures `paymentRedirectUrl`.

### 4.2 Customer pays
- Copy `paymentRedirectUrl` into a browser, complete the test card flow.
- Kashier POSTs `/api/payments/webhook/kashier?region=eg` with a valid HMAC.
- The webhook handler flips the order `pending_payment → placed`, writes a `transactions` row, emits WS `order.created` to `branch:1` and `order.status_changed` to `customer:2`.

### 4.3 Same restaurant + agent lifecycle as §3.3 → 3.6.

---

## 5. Cancellation paths

| Scenario | Trigger | Expected |
|---|---|---|
| Customer cancels within 60s pre-accept | **Order / Order — Customer → Cancel order** | Order → `cancelled`. Stock released back via `core/internal/release-stock`. |
| Customer tries to cancel after manager accepts | Same request after step 3.3 | 403 / 409 — `CustomerCancelDeadlineMissedError`. |
| Restaurant cancels at `preparing` | **Order / Order — Restaurant → Cancel (restaurant) — preparing → cancelled** | Order → `cancelled`. WS `order.status_changed` to customer. |
| Restaurant rejects on `placed` | **Order / Order — Restaurant → Reject order (manager)** with `reason` | Order → `rejected`. Settlement does not run. |
| Admin override cancel | **Order / Order — Admin → Admin cancel order** | Works at any stage except `delivered`. |

---

## 6. Multi-region — KSA (no online gateway, COD only)

`ONLINE_PAYMENT_REGIONS=eg` in `.env`, so KSA falls back to COD-only.

1. Place a KSA COD order: **Order / Order — Customer → Place order — COD (customer, KSA)** (X-Region: `ksa`).
2. **Try the ONLINE variant pointing at KSA** (manually flip `paymentMethod` to `online` + change region/branch/address) — expect a 409 about online payment unavailable.
3. KSA agent flow uses **Agent KSA** instead of EG; orders for branch 2 only get offered to agents whose presence GEO is inside the KSA branch's radius.

---

## 7. RBAC checks (negative)

| What you do | Expected |
|---|---|
| Login as `staff`, then **PATCH branches/:id (owner)** | 403 — staff can't update branches. |
| Login as `staff`, then **POST /restaurants/:id/products (owner)** | 403 — `core:product:create` not granted. |
| Login as `manager`, then **PATCH branches/:id/status (admin)** | 403 — system_admin only. |
| Login as `manager`, then `Mark DELIVERED (agent EG)` | 403 — agent-only route (`requireAgent`). |
| Logged-in customer hits `POST /admin/restaurants/:id/payouts` | 403 — `finance:payout_create` requires system_admin. |
| Hit `/internal/branches/:id` without `api-key` header | 401 — internal guard. |

---

## 8. WebSocket smoke test (live updates)

The WS server listens on the same HTTP server as the API (path `/ws`, socket.io v4).

### Option A — `wscat` (quick check)
Authentication is via cookie or `?token=`. Easiest:

```powershell
# 1. Get a customer JWT (replace with your actual token)
$token = "PASTE_customerAccessToken_FROM_POSTMAN_ENV"

# 2. Connect (socket.io uses an HTTP upgrade, so we need socket.io-client; wscat won't speak the protocol).
#    Use the small Node smoke client below instead.
```

### Option B — minimal Node client (recommended)

```js
// smoke-ws.js
const {io} = require("socket.io-client");
const TOKEN = process.env.TOKEN; // customer or agent JWT

const sock = io("http://localhost:4000", {
    transports: ["websocket"],
    auth: {token: TOKEN},
});

sock.on("hello", (h) => {
    console.log("hello, allowed channels:", h.allowedChannels);
    // subscribe to your customer channel — id=2 for the seeded customer
    sock.emit("subscribe", "customer:2", (ack) => console.log("subscribed:", ack));
});
sock.onAny((event, payload) => console.log("→", event, payload));
sock.on("connect_error", (e) => console.error("WS err:", e.message));
```

```powershell
cd order-service
node smoke-ws.js     # set $env:TOKEN = "..." first
```

### Expected broadcasts (in order, for the §3 happy-path)

| Step | Channel | Event | Payload (compact) |
|---|---|---|---|
| Place order (COD) | `branch:1` | `order.created` | OrderSummaryResponseDTO |
| Accept | `customer:2`, `branch:1` | `order.status_changed` | `{publicId, status: "accepted", updatedAt}` |
| Preparing | same | `order.status_changed` | `status: "preparing"` |
| Ready | same | `order.status_changed` | `status: "ready"` |
| Assignment tick offers | `agent:6` | `task.offered` | `{orderId, branch, dropoff, total, currency, expiresAt}` |
| Agent accepts | `agent:6` | `task.assigned` | DeliveryTaskResponseDTO |
| (losing agents) | `agent:<id>` | `offer.cancelled` | `{orderId, reason: "claimed_by_other"}` |
| Pick / Deliver | `customer:2`, `branch:1` | `order.status_changed` | resp |
| Assignment exhausted (worst case) | `admin:alerts` | `assignment.exhausted` | `{orderId, attempts}` |

> `agent:6` because the EG agent's `users.id` is 6 after seed. The full mapping is in the seed script's printout.

---

## 9. RabbitMQ + outbox

The order-service writes one `events_outbox` row per `order.placed` transition (other event types are reserved but not yet emitted). The worker drains the outbox to the topic exchange `order.events`.

- Open RabbitMQ Management UI at `http://localhost:15672` (guest/guest if the management plugin is on).
- After placing a COD order you should see:
  - exchange `order.events` (durable, topic)
  - one message published with routing key `order.placed` (it's not queued anywhere unless you bind a consumer; that's fine — analytics-service will bind in a later milestone).
- Inbound from core: open the `order-service.core-events` queue. Edit a product's price via `PATCH /products/:id?branchId=` in core, and a `product.price.changed` message should pass through and be acked.

---

## 10. Reset between cycles

```powershell
cd order-service
npm run seed                       # full reset + reseed (ids restart at 1)

# OR — clean only, no seed
$env:CLEAN_ONLY="1"; npx tsx scripts/reset-and-seed.ts
```

This re-truncates everything except the RBAC catalog (roles/permissions/role_permissions stay), re-creates 12 months of `orders_*` partitions per region, and re-seeds the kashier `payment_providers` row on the EG shard. After it runs, **re-login each role in Postman** (the previous tokens still work until they expire at the 1h JWT TTL, but the user IDs are stable so it shouldn't matter).

---

## 11. Cheatsheet — endpoint order for one full cycle

The minimum requests to cover the entire system once:

1. Core / Auth — Login (`customer`, `owner`, `manager`, `agent EG`, `admin`).
2. Order / Order — Customer → **Place order — COD (customer, EG)**.
3. Order / Order — Restaurant → **Accept**, **Preparing**, **Ready** (manager).
4. Order / Agent → **Presence ONLINE (agent EG)**.
5. (Wait ~10s, or watch your WS client for `task.offered`.)
6. Order / Agent → **Accept offer**.
7. Order / Agent → **Mark PICKED**, **Mark DELIVERED**.
8. Order / Finance → **GET balance**, Order / Agent → **GET earnings**.
9. Order / Order — Customer → **GET /orders/:publicId** to see the final state + history.
10. (Optional) Order / Finance → **POST /admin/restaurants/:id/payouts** for the balance you just earned, then re-check balance.

Done. Repeat by running `npm run seed` and starting over from step 1.
