# Business Logic — Payments Module

Owner module: `app/payment/`

Responsible for online payment initiation (Kashier v3 sessions), webhook handling, transactions ledger writes, and refund execution.

References:
- Kashier Payment Sessions: https://developers.kashier.io/payment/payment-sessions
- Kashier Webhooks: https://developers.kashier.io/webhooks/setup

---

## 1. Endpoints

| Endpoint                                        | Auth                                  |
| ----------------------------------------------- | ------------------------------------- |
| `POST /payments/init`                           | customer (idempotent, strict)         |
| `POST /payments/webhook/{provider}`             | none (HMAC verified)                  |
| `GET /payments/{paymentId}`                     | system_admin (or restaurant owner)    |
| `POST /payments/{paymentId}/refund`             | system_admin                          |

`{paymentId}` here is the `transactions.id` of a `charge` row (we call this a "payment" in the public API to avoid leaking ledger semantics).

---

## 2. POST /payments/init

### Request DTO

```ts
class InitPaymentRequestDTO {
  orderId: string;        // public_id (UUID)
}
```

Header: `Idempotency-Key` (strict).

### Algorithm

1. Resolve region; load order via `public_id`.
2. Authorize: caller must be the order's customer; order must exist and be `status = 'pending_payment'`.
3. If a `payment_session` row already exists for this order with `status IN ('initialized','pending')` → return its `redirectUrl` (idempotent at the domain level too).
4. Otherwise:
   - Build the Kashier session payload (amount in minor units, currency from order, return URLs from env, merchant order id = `public_id`).
   - Call `pkg/payments/kashier/kashier.client.ts → createSession(payload)`.
   - On success: insert `payment_sessions` row (`status='initialized'`, `provider_session_id`, `redirect_url`, `raw_init_payload`).
5. Return `{ redirectUrl, sessionId, expiresAt }`.

### Failure

- Kashier returns 5xx or times out (3 retries with backoff in the client) → 503 with retry-after. The order remains in `pending_payment`; client may retry init.
- Kashier returns 4xx (e.g. invalid currency) → 502 with provider message; alert raised.

---

## 3. POST /payments/webhook/{provider}

### Security

- Provider in path: only `kashier` accepted today.
- HMAC verification via `KASHIER_WEBHOOK_SECRET`. Signature header per Kashier spec. Any mismatch → 401 + alert + drop.

### Idempotency

- `INSERT INTO payment_webhook_events (provider_id, provider_event_id, signature, payload) VALUES (...) ON CONFLICT (provider_id, provider_event_id) DO NOTHING`.
- If `rowCount === 0` (already exists) → return **200** immediately (Kashier stops retrying).
- Otherwise continue processing.

### Processing (in one trx on the order's region)

1. Look up `payment_session` by `provider_session_id`.
2. Reconcile `status` based on Kashier event type:
   - `payment.success` / `capture.succeeded`:
     - `payment_session.status = 'captured'`.
     - Insert `transactions(type='charge', method='online', provider_id=kashier, provider_reference_id, status='succeeded', amount, currency, src_acc_id=customer, dst_acc_id=NULL, idempotency_key=event_id)`.
     - Update `orders.status='placed'`.
     - (No outbound events; clients are notified via WebSocket below.)
     - Publish WS to `branch:<id>` (`order.created`) and `customer:<id>` (`order.status_changed`).
   - `payment.failed`:
     - `payment_session.status = 'failed'`.
     - Insert `transactions(type='charge', status='failed', amount, ...)` (audit).
     - `orders.status` unchanged (stays `pending_payment`, eligible for retry).
     - Publish WS to customer with failure reason.
   - `refund.succeeded`:
     - Locate the original `transactions(type='refund', status='pending')` by `provider_reference_id` set at refund-init.
     - Update its `status='succeeded'`.
     - Mark original charge `is_refunded=true`, set `refunded_payment_id`.
     - Adjust `restaurant_balances` if the order was already delivered (debit by refunded amount, capped at current balance — surplus becomes a `transactions(type='adjustment')`).
3. Stamp `payment_webhook_events.processed_at = NOW()`. If anything threw, stamp `process_error` and rethrow → 500 → Kashier will retry.

### What we do NOT do

- We do not trust the webhook's "status=success" without verifying the HMAC.
- We do not modify money state if the webhook is a duplicate (caught by unique index).

---

## 4. GET /payments/{paymentId}

- Authorization:
  - `system_admin`: always.
  - Restaurant owner: only if the transaction belongs to one of their orders.
- Returns a `PaymentResponseDTO` with: id, orderId, type, method, provider, amount/currency, status, providerReferenceId, timestamps, refunds (if any).

---

## 5. POST /payments/{paymentId}/refund

- Admin-only.
- Body: `{ amount?: number, reason: string }`. If `amount` omitted → full refund.
- Validates: payment is a `charge`, status `succeeded`, not already fully refunded.
- Inserts `transactions(type='refund', method=originalMethod, provider_id=originalProvider, status='pending', amount, currency, src_acc_id=NULL, dst_acc_id=customer)` with a fresh idempotency key.
- Calls Kashier refund API (sync). On Kashier accept (HTTP 2xx) we keep `status='pending'` and wait for the webhook to flip it to `succeeded`.
- For COD, a refund is mostly a bookkeeping operation; the cash never reached the platform. We still write a `refund` row for audit and adjust the restaurant balance if needed.

---

## 6. Money model (recap)

- All amounts are integer minor units (piasters/halalas).
- `transactions.amount` is always **positive**. The direction is encoded by `(transaction_type, src_acc_id, dst_acc_id)`.
- A successful order generates **two** linked transactions on `delivered`:
  1. `charge` (online) or `cod_collection` — customer → restaurant.
  2. `commission` — restaurant → SYSTEM (src=ownerId, dst=NULL).
- A `payout` is restaurant → bank: src=NULL (system holds the funds), dst=ownerId. The corresponding negative effect on the restaurant balance happens in the same trx.
- A `refund` is SYSTEM → customer (online) or a void with no money movement (cod): we still insert a `refund` row for the audit trail.

---

## 7. RBAC

| Action                              | Role                                                    |
| ----------------------------------- | ------------------------------------------------------- |
| `POST /payments/init`               | `customer` (own order)                                  |
| `POST /payments/webhook/{provider}` | none (signature required)                               |
| `GET /payments/{id}`                | `system_admin`, `restaurant_user` (`payments:read`)     |
| `POST /payments/{id}/refund`        | `system_admin`                                          |

Seed permissions: `payments:read`. Mapped only to `owner`.

---

## 8. Invariants

1. Every `charge` row has at most one matching `refund` chain whose summed amount ≤ charge amount.
2. Webhooks are processed at-most-once **effectively**, at-least-once **delivered**.
3. A `charge` cannot be `succeeded` unless the matching `payment_session` is `captured`.
4. `payment_method='cod'` orders never have a `charge` — only `cod_collection`.
5. The `transactions.idempotency_key` unique constraint guarantees no double-credit on duplicated webhooks.

---

## 9. Failure modes & operator playbook

| Symptom                                  | Likely cause                                       | Action                                              |
| ---------------------------------------- | -------------------------------------------------- | --------------------------------------------------- |
| `payment_session.status='initialized'` for >30 min | customer abandoned / Kashier never confirmed | sweep job moves order to `cancelled` after 15 min |
| Kashier webhook spike of duplicates      | Kashier retries on slow webhook handler            | check handler latency; HMAC + unique constraint already de-dup |
| Webhook signature mismatch               | secret rotation drift                              | update `KASHIER_WEBHOOK_SECRET`; replay `payment_webhook_events` not yet processed |
| `transactions` insert blocks             | row lock on `restaurant_balances`                  | high contention — investigate concurrent payouts vs deliveries on the same restaurant |

---

## 10. Configuration (env)

```
KASHIER_BASE_URL=https://api.kashier.io
KASHIER_MERCHANT_ID=...
KASHIER_API_KEY=...
KASHIER_WEBHOOK_SECRET=...
KASHIER_RETURN_URL=https://app.quickbite.io/checkout/return
KASHIER_FAIL_URL=https://app.quickbite.io/checkout/failed
PAYMENT_SESSION_TIMEOUT_MIN=15
```

All added to `lib/config/env.ts` zod schema before any payment code is shipped.
