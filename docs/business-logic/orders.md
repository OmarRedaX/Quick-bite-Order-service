# Business Logic — Orders Module

Owner module: `app/order/`

Responsible for the customer-facing order placement, the order header lifecycle, and the read paths used by customers, restaurants, and admins.

---

## 1. Status machine

```
        ┌──── pending_payment ──── (online only)
        │           │
        │           │ payment captured (Kashier webhook)
        │           ▼
        └──────► placed ────► accepted ────► preparing ────► ready ────► assigned ────► picked ────► delivered
                    │             │              │              │            │             │
                    │             │              │              │            │             │
                    │             ▼              ▼              ▼            ▼             ▼
                    │          rejected      cancelled      cancelled    cancelled     (terminal)
                    │
                    └──► cancelled (customer cancels before restaurant accepts)
```

### State definitions

| Status            | Meaning                                                                            | Who can move it                                                  |
| ----------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `pending_payment` | Online order created; awaiting Kashier confirmation                                | system (webhook), customer (cancel within 15 min)                |
| `placed`          | Restaurant has the order in its queue                                              | system (transition only)                                         |
| `accepted`        | Restaurant accepted; cooking will start                                            | restaurant (manager/staff/owner)                                 |
| `rejected`        | Restaurant declined                                                                | restaurant — terminal; triggers refund (online) or void (cod)    |
| `preparing`       | Active cooking                                                                     | restaurant                                                       |
| `ready`           | Food ready for pickup; eligible for delivery assignment                            | restaurant                                                       |
| `assigned`        | Delivery row created and a delivery agent assigned                                 | system (assignment service) / system_admin (manual)              |
| `picked`          | Agent confirmed pickup at the branch                                               | delivery agent                                                   |
| `delivered`       | Customer received order; money settles                                             | delivery agent — terminal                                        |
| `cancelled`       | Cancelled before delivery                                                          | system / restaurant (with reason) / customer (limited window)    |

### Transition rules

- Single endpoint `PATCH /orders/{orderId}/status` updates restaurant-side state. Body: `{ status }`. Service validates the requested target is **legal from current status** and **allowed for the actor**.
- Forbidden transitions return **409**.
- Each transition stamps the corresponding `<verb>_at` column inside the same trx.
- Each transition publishes a WebSocket event to `customer:<id>`, `branch:<id>`, and (where relevant) `agent:<id>`.

### Allowed transitions matrix (target by current)

| from \ to        | accepted | rejected | preparing | ready | assigned | picked | delivered | cancelled |
| ---------------- | -------- | -------- | --------- | ----- | -------- | ------ | --------- | --------- |
| `placed`         | ✅ rest  | ✅ rest  |           |       |          |        |           | ✅ cust*  |
| `accepted`       |          |          | ✅ rest   |       |          |        |           | ✅ rest   |
| `preparing`      |          |          |           | ✅ rest|          |        |           | ✅ rest   |
| `ready`          |          |          |           |       | ✅ system|        |           | ✅ rest   |
| `assigned`       |          |          |           |       |          | ✅ ag  |           | ✅ admin  |
| `picked`         |          |          |           |       |          |        | ✅ ag     |           |

\* customer cancel window: until `accepted_at` is set OR within 60s of `placed`.

---

## 2. POST /orders — placement (the most critical path)

### Inputs (request DTO)

```ts
class CreateOrderRequestDTO {
  branchId: number;             // required, validated against core-cached branch metadata
  customerAddressId: number;    // required, validated via core-client
  paymentMethod: 'online' | 'cod';
  items: Array<{ productId: number; quantity: number }>;  // required, non-empty
}
```

Header: `Idempotency-Key` (required, `idempotency({strict: true})` middleware).

### Algorithm

1. **Resolve region**. From `X-Region` / `?region=` / cookie, or derived from the chosen `branchId` via the cached branch metadata. The order goes to the **branch's region (country)** shard. With country-level shards, the customer is almost always in the same country as the branch.
2. **Validate branch** via cache then `core-client`. If branch is `accept_orders=false` or restaurant `status != 'active'` → 409 `BranchNotAcceptingOrders`.
3. **Validate address** via `core-client`. Capture `lat/lng/address_text` for the snapshot.
4. **Fetch product prices/stock** for the requested items in **a single batch call** to `core-client.getBranchProducts(branchId, productIds)`. If any product is missing, unavailable, or `stock < quantity` → 409 with offending product list.
5. **Compute money**:
   - `subtotal = Σ unitPrice × quantity` (all in minor units).
   - `delivery_fee = branch.deliveryFee` (cached).
   - `service_fee = floor(subtotal × platform_service_rate)` — config-driven, currently 0.
   - `total = subtotal + delivery_fee + service_fee`.
6. **In one trx on the branch's region**:
   - Insert `orders` with `status = paymentMethod === 'online' ? 'pending_payment' : 'placed'`.
   - Insert `order_items` (one INSERT … VALUES … with multiple rows).
   - **No `cod_collection` transaction is written here.** For COD the `transactions(type='cod_collection', status='succeeded')` row is written by the settlement trx on `delivered` (parallels how the `charge` row for online is written by the Kashier webhook on capture, not at order time). One transaction row per terminal money event — no `pending` rows that have to be flipped.
   - Decrement product stock via `core-client.reserveStock(branchId, items)` — **out-of-trx**, after commit. If reserve fails, we void the order (status=`cancelled`, reason=`out_of_stock_post_commit`). This is acceptable: stock was last verified seconds ago.
7. **Commit**.
8. For `online`: hand off to payment service to create a Kashier session (separate endpoint `POST /payments/init`, or auto-trigger from the same controller — see §3).
9. Publish WS `order.created` to `branch:<branchId>` (only for COD; online waits for capture).
10. Return the `OrderResponseDTO`.

### Concurrency / race conditions

- Two simultaneous orders racing the same last unit of stock: handled in `core-service` reserveStock (atomic decrement; returns 409 if any item underflows).
- Idempotency: same key + same body within 24h → returns the original response. Same key + **different** body → 409 `IdempotencyConflict` (we hash the request body).

### Failure modes

- Kashier creation fails after order insert → order remains in `pending_payment`. The customer can retry `POST /payments/init` (also idempotent) or the order auto-cancels after 15 min via a background sweep job.

---

## 3. POST /orders — online vs COD execution

The simplest UX is to keep `POST /orders` and `POST /payments/init` as **two separate calls** — the order returns its `publicId`, the client then calls `POST /payments/init { orderId }`. This keeps endpoints small and idempotent independently.

(An alternate endpoint `POST /orders/with-payment` could combine both for a single round-trip; deferred unless mobile asks.)

---

## 4. GET /orders/{orderId}

- `orderId` here is the **public_id** (UUID).
- Lookup is by `public_id` index, single shard.
- Region resolution: same priority (`?region=` / `X-Region` / cookie). A customer reading an order in their own country passes `X-Region` (set by the gateway) or the server derives it from the order's `public_id` only if we ever add a region prefix — today we require the region to be supplied.
- Authorization: customer == `order.customer_id`; restaurant user must own the restaurant or be a member of `branch_id`; admin sees all.
- Response includes:
  - Order header (DTO).
  - Items.
  - Latest delivery (if any).
  - Payment summary (status of latest `transaction(type='charge'|'cod_collection')`).
- All in **one** repository call (single SQL with joins). No N+1.

---

## 5. GET /customer/orders?year=YYYY

- Cursor-paginated.
- Defaults `year` to the current year if omitted.
- For current year → query `orders` on customer's home shard via `idx_orders_customer_id_created_at`.
- For historical years → route to the **archive cluster** (Phase 7) for the same region. Same indexes, same shape.
- Cross-country lookup is not optimized for in this milestone (extremely rare).

---

## 6. GET /restaurants/:restaurantId/branches/:branchId/orders

- Both ids are **path params** (not query) so existing middleware does the heavy lifting:
  - `requireRestaurantMember("restaurantId")` — JWT's `restaurantId` must equal the path's, or the actor is `system_admin`.
  - `requireBranchAccess("branchId")` — non-owners are constrained to `branchIds` from their JWT.
- Filters (query): `status`, `from`, `to`. Pagination: cursor.
- Repo query filters by **both** `restaurant_id` and `branch_id` (not just `branch_id`) so a tenant can never read another tenant's row even if they guess a `branchId`. Backed by `idx_orders_branch_status_created_at`; the additional `restaurant_id` predicate is satisfied by the row check, not an index seek.
- `withCache(10)` keyed `<region>:GET:/restaurants/:rid/branches/:bid/orders?status=...`.
- Cache invalidated on every status transition for that branch.

---

## 7. PATCH endpoints by actor

Status transitions are split by actor / route prefix so existing RBAC + branch-membership middleware can guard each path:

| Actor                | Path                                                                              |
| -------------------- | --------------------------------------------------------------------------------- |
| customer (cancel)    | `PATCH /customer/orders/:publicId/status`                                         |
| restaurant member    | `PATCH /restaurants/:restaurantId/branches/:branchId/orders/:publicId/status`     |
| delivery agent       | `PATCH /agents/orders/:publicId/status`                                           |
| system admin         | `PATCH /admin/orders/:publicId/status`                                            |

The server still inspects `currentStatus` against `assertTransition(from, to, actorContext)`. Path-prefix middleware gives us "you can't reach this code unless you have the right role/branch"; `assertTransition` gives us "the requested target is legal from the current state for that actor".

Side effects per transition (all stamp the corresponding `<verb>_at` column inside the same trx):
- `accepted` → WS to customer + branch.
- `rejected` → trigger refund (online); WS.
- `preparing` → WS.
- `ready` → WS; the assignment worker picks it up on its next tick.
- `assigned` → written by `assignment.service` on a successful claim — **not** reachable from any of the PATCH endpoints.
- `picked` → written by the agent PATCH; WS.
- `delivered` → written by the agent PATCH; **runs the settlement trx** (Restaurant-finance.md §7); WS.
- `cancelled` → stamp `cancelled_at`, body must include `reason`. If online & captured → trigger refund. (COD has nothing to undo.)

---

## 8. Invariants

1. `total = subtotal + delivery_fee + service_fee` always.
2. `commission ≤ subtotal`.
3. The status sequence is monotonic (no jumping back).
4. `delivered_at IS NOT NULL` ⇒ all dependent rows: `transactions(type='charge', status='succeeded')` exists, `restaurant_balances` updated, `agent_earnings` row exists.
5. `pending_payment` orders older than 15 min are cancelled by a background sweep.
6. A customer cannot read another customer's order, even with the public_id.
7. A restaurant user cannot read orders for branches they aren't a member of (unless owner).

---

## 9. Cancellation policy (codified)

- **Customer cancellation**: allowed only while `status IN ('pending_payment', 'placed')` AND no more than 60s after `placed_at`. After that, the customer can't cancel; they must call support.
- **Restaurant cancellation**: allowed at any time before `picked`. Requires a `reason`. Triggers refund/void.
- **System cancellation**: timeouts (`pending_payment` > 15 min); failed assignment after max retries (see Deliveries module).

---

## 10. Refund handling on cancellation

- If the order was online and a `transaction(type='charge', status='succeeded')` exists → call payment service's `refund(orderId, amount=total)`. This is async (Kashier processes; we get a webhook).
- If COD: nothing to do for the money side — we only write `cod_collection` on `delivered`, so a cancelled COD order produces no transaction rows. The cancellation alone is the audit trail.

---

## 11. RBAC

| Action                                                                                | Roles allowed                                                          |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `POST /orders`                                                                        | `customer`                                                             |
| `GET /orders/{id}`                                                                    | `customer` (own), `restaurant_user` (member of branch), `system_admin` |
| `GET /customer/orders`                                                                | `customer`                                                             |
| `GET /restaurants/:rid/branches/:bid/orders`                                          | `restaurant_user` member of `:rid`, branch-allowed for `:bid` (`orders:read`); `system_admin` bypasses |
| `PATCH /restaurants/:rid/branches/:bid/orders/:id/status` → accept/reject             | `orders:accept`                                                        |
| `PATCH /restaurants/:rid/branches/:bid/orders/:id/status` → preparing/ready           | `orders:update`                                                        |
| `PATCH /restaurants/:rid/branches/:bid/orders/:id/status` → cancelled                 | `orders:cancel`                                                        |
| `PATCH /customer/orders/:id/status` → cancelled                                       | `customer` (own, within cancel window)                                 |
| `PATCH /agents/orders/:id/status` → picked / delivered                                | `delivery_agent` assigned to that order                                |
| `PATCH /admin/orders/:id/status` (any target the state machine allows for `admin`)    | `system_admin`                                                         |

Permission seed (added to core's RBAC seed migration):

```
orders:read, orders:accept, orders:update, orders:cancel
```

Mapped to roles:

- `owner` → all four.
- `branch_manager` → all four.
- `staff` → `orders:read`, `orders:update`, `orders:accept` (no cancel).

---

## 12. WebSocket events emitted

| Event             | Channel                        | Payload (response DTO)                              |
| ----------------- | ------------------------------ | --------------------------------------------------- |
| `order.created`   | `branch:<id>`                  | `OrderSummaryResponseDTO`                           |
| `order.status_changed` | `customer:<id>`, `branch:<id>` | `{ orderId, status, ts }`                       |
| `order.cancelled` | `customer:<id>`, `branch:<id>` | `{ orderId, reason, ts }`                           |
