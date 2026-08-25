# Business Logic — Restaurant Finance Module

Owner module: `app/restaurant-finance/`

Read views over a restaurant's running balance and payout history.

The **writes** that change the balance live in the Deliveries module (settlement on delivered) and the Payments module (refunds, payout recording). This module is read-only (with one admin-only write: record-payout).

---

## 1. Endpoints

| Endpoint                                                                  | Auth                                                                  |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `GET /restaurants/:restaurantId/balance`                                  | `requireRestaurantMember(:restaurantId)` + `rbac(finance:read)`        |
| `GET /restaurants/:restaurantId/payouts?from=&to=`                        | `requireRestaurantMember(:restaurantId)` + `rbac(finance:read)`        |
| `POST /admin/restaurants/:restaurantId/payouts`                           | `system_admin`                                                         |

The path-level `requireRestaurantMember` middleware means a restaurant_user can never read another tenant's balance even if the JWT is forged on the role bit — the JWT `restaurantId` claim must match the path. `system_admin` bypasses both middlewares.

---

## 2. GET /restaurant/balance

- Resolves the restaurant from the JWT (`req.user.restaurantId`).
- Reads `restaurant_balances` row(s) for that restaurant.
- Response:
  ```ts
  class RestaurantBalanceResponseDTO {
    restaurantId: number;
    balances: Array<{ currency: string; balance: number }>;
    asOf: string;  // ISO ts
  }
  ```
- No cache: the balance is small, single-row, hot, but **must be fresh** for owner/admin trust. Read from primary.

---

## 3. GET /restaurant/payouts?from=&to=

- Filters `transactions` where `transaction_type='payout'` and `dst_acc_id=ownerId`.
- Defaults: `from = 90 days ago`, `to = NOW()`.
- Cursor pagination by `created_at DESC`.
- Backed by `idx_transactions_dst_acc_type_created_at` (partial on `payout`).
- Response item: `PayoutResponseDTO { id, amount, currency, status, providerReferenceId, createdAt }`.

---

## 4. POST /admin/restaurants/:restaurantId/payouts (admin)

### Request DTO

```ts
class CreatePayoutRequestDTO {
  restaurantId: number;
  amount: number;          // minor units
  currency: string;
  providerReferenceId: string;  // bank transfer ref
  note?: string;
}
```

Header: `Idempotency-Key` (strict).

### Algorithm

1. Validate `restaurantId` exists via `core-client.getRestaurant` → also gives us `ownerId`.
2. In a trx (region of restaurant):
   - SELECT `restaurant_balances` for `(restaurantId, currency)` `FOR UPDATE`. If no row exists → 409 `InsufficientBalance`.
   - If `balance < amount` → 409 `InsufficientBalance`.
   - Insert `transactions(type='payout', method='bank_transfer', status='succeeded', amount, currency, src_acc_id=NULL, dst_acc_id=ownerId, provider_reference_id, idempotency_key=<header>)`. `src_acc_id=NULL` because the source is the platform itself (no platform user in core); the `transaction_type='payout'` is enough to identify it.
   - `UPDATE restaurant_balances SET balance = balance - ?, updated_at=now() WHERE restaurant_id=? AND currency=?`.
   - Commit.
3. Return `PayoutResponseDTO`.

### Why not auto-trigger bank transfer?

Out of scope. The platform records payouts that operations executes externally. If/when an automated payout API is integrated, the flow changes to: insert `pending` → call provider → flip to `succeeded` on webhook. The schema already supports this (status enum includes `pending`).

---

## 5. RBAC

- `finance:read` permission added to RBAC. Mapped to `owner` and `branch_manager`.
- `system_admin` always allowed (bypass via the `rbac` middleware).

---

## 6. Invariants

1. `restaurant_balances.balance` never goes negative (enforced by the FOR UPDATE check + trx).
2. The sum of positive deltas (delivered settlements) minus payouts equals the current balance — auditable from `transactions` alone.
3. A payout is recorded only after the bank transfer cleared (operator's responsibility); schema does not enforce this.

---

## 7. Settlement formula (for reference — implementation lives in Deliveries module)

```
on order delivered:
  delta_balance = order.subtotal - commission
  commission    = floor(order.subtotal × branch.commission_rate)
```

`commission_rate` is a property of the branch (`restaurant_branches.commission` in core, integer percent or basis points — TBD with core team; for now treated as **basis points / 10000**).

---

## 8. Reports view (read DTO shape)

For owner dashboards (future, not in this milestone, but the API supports it):

- `GET /restaurant/finance/summary?period=month` would aggregate from `transactions` filtered by `restaurantId` and a date range, returning:
  - Gross sales (sum of `charge` + `cod_collection` succeeded).
  - Commission paid (sum of `commission`).
  - Refunds (sum of `refund` succeeded).
  - Net deposits (gross - commission - refunds).
  - Payouts (sum of `payout`).

This is a single SQL query with `SUM(...) FILTER (WHERE ...)` per category. Not implemented now; documented so the schema is shown to support it cheaply.
