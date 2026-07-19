# API Contracts — `order-service`

All endpoints are mounted under `/api`. Authentication via JWT in cookie `access_token` (same as core-service). Cross-cutting headers, conventions, error envelope, response envelope, and per-endpoint request/response DTOs follow.

---

## 0. Conventions

### Headers (in)

| Header                | Required where                            | Notes                                      |
| --------------------- | ----------------------------------------- | ------------------------------------------ |
| `Cookie: access_token` | All authenticated endpoints              | Issued by core-service `/api/auth/login`   |
| `Idempotency-Key`     | All `POST` / `PATCH` write endpoints      | Strict on order create, payment init, payouts |
| `X-Region`            | Required for every request (admin may pass `all` for fan-out reads) | `eg`, `ksa`, ... (one per country) |
| `X-CorrelationId`     | Propagated; auto-generated otherwise      | Returned on all responses                  |

### Headers (out)

| Header               | Always present                                        |
| -------------------- | ----------------------------------------------------- |
| `X-CorrelationId`    | Request id (echoed if provided, generated otherwise)  |
| `X-Cache: HIT|MISS`  | Endpoints behind `withCache`                          |

### Response envelope

```jsonc
// success (single)
{ "success": true, "data": <DTO>, "meta": { ... }? }

// success (paginated)
{ "success": true, "data": [<DTO>, ...], "meta": { "nextCursor": "...", "hasMore": true, "count": 20 } }

// error
{ "error": "<message>" }
```

HTTP status codes:
- 200 OK — success
- 201 Created — POST that created a resource
- 400 — validation error
- 401 — not authenticated
- 403 — not authorized
- 404 — not found
- 409 — conflict (idempotency mismatch, illegal status transition, insufficient balance, stock)
- 422 — semantic invalid (rare; we mostly use 400)
- 503 — upstream unavailable (core-service / Kashier)

### Money

Always integer minor units, with a sibling `currency` field (e.g. `"EGP"`, `"SAR"`).

### Timestamps

ISO 8601 UTC strings, e.g. `"2026-04-16T15:42:11.123Z"`.

### IDs

- Public order id: UUID string (`publicId`).
- Other public ids: bigint serialized as JSON number.
- Internal ids never leave this service.

### Pagination (cursor)

Query: `?cursor=<opaque>&limit=20&sortBy=createdAt&sortOrder=desc`
Response meta: `{ nextCursor, hasMore, count }`.

### Filters

`?filter[<field>][<op>]=<value>` — same shape as core-service. Allowed ops: `eq, gt, lt, gte, lte, like, in`.

---

## 1. Orders

### 1.1 POST /api/orders — place order

Headers: `Cookie: access_token`, `Idempotency-Key` (strict).

**Request body**

```ts
class CreateOrderRequestDTO {
  @IsInt() @Min(1)
  branchId!: number;

  @IsInt() @Min(1)
  customerAddressId!: number;

  @IsEnum(PaymentMethod)
  paymentMethod!: 'online' | 'cod';

  @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => OrderItemInputDTO)
  items!: OrderItemInputDTO[];
}

class OrderItemInputDTO {
  @IsInt() @Min(1)
  productId!: number;

  @IsInt() @Min(1) @Max(50)
  quantity!: number;
}
```

**Response 201**

```ts
class OrderResponseDTO {
  publicId: string;            // UUID
  status: OrderStatus;         // 'pending_payment' | 'placed' | ...
  paymentMethod: 'online' | 'cod';
  branch: { id: number; name: string };           // joined snapshot
  restaurant: { id: number; name: string };       // joined snapshot
  customerAddress: { lat: number; lng: number; addressText: string };
  subtotal: number;
  deliveryFee: number;
  serviceFee: number;
  total: number;
  currency: string;
  items: OrderItemResponseDTO[];
  createdAt: string;
  // online only:
  payment?: { sessionId: string; redirectUrl: string };  // present if paymentMethod=='online' and init succeeded
}

class OrderItemResponseDTO {
  productId: number;
  name: string;
  imageUrl?: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
}
```

**Errors**

| Status | Body                                                                 |
| ------ | -------------------------------------------------------------------- |
| 400    | `{ "error": "items: array must contain at least 1 element" }`        |
| 401    | `{ "error": "User not authenticated" }`                              |
| 403    | `{ "error": "User not authorised" }`                                 |
| 409    | `{ "error": "BranchNotAcceptingOrders" }`                            |
| 409    | `{ "error": "OutOfStock", "details": [{ "productId": 1, "requested": 3, "available": 1 }] }` |
| 409    | `{ "error": "IdempotencyConflict" }`                                 |
| 503    | `{ "error": "Core service unavailable" }`                            |

---

### 1.2 GET /api/orders/{publicId}

**Path params**: `publicId` (UUID).

**Auth**: customer (own), restaurant_user (member), system_admin.

**Response 200**

```ts
class OrderDetailResponseDTO extends OrderResponseDTO {
  delivery?: DeliverySummaryResponseDTO;
  paymentSummary: {
    method: 'online' | 'cod';
    status: 'pending' | 'authorized' | 'captured' | 'failed' | 'refunded';
    amount: number;
    currency: string;
    refundedAmount: number;
  };
  history: Array<{ status: OrderStatus; ts: string }>;
}

class DeliverySummaryResponseDTO {
  id: number;
  status: DeliveryStatus;
  agent?: { id: number; name: string; phone?: string; lastLat?: number; lastLng?: number; lastSeenAt?: string };
  assignedAt: string;
  acceptedAt?: string;
  pickedAt?: string;
  deliveredAt?: string;
}
```

---

### 1.3 GET /api/customer/orders?year=YYYY

**Query**: `year`, `cursor`, `limit`, `sortBy=createdAt`, `sortOrder=desc`.

**Auth**: customer.

**Response 200** (paginated)

```ts
class OrderSummaryResponseDTO {
  publicId: string;
  status: OrderStatus;
  total: number;
  currency: string;
  itemsCount: number;
  restaurant: { id: number; name: string };
  branchId: number;
  createdAt: string;
}
```

---

### 1.4 GET /api/restaurant/orders

**Query**: `branchId` (required), `status?`, `from?` (ISO), `to?` (ISO), pagination, filters.

**Auth**: restaurant_user with `orders:read` + `requireBranchAccess('branchId')`.

**Response 200**: paginated `OrderSummaryResponseDTO[]`.

---

### 1.5 PATCH /api/orders/{orderId}/status

**Path**: `orderId` (publicId).

**Headers**: `Idempotency-Key` (strict).

**Auth**: depends on requested target — restaurant_user (with the right permission) for accept/reject/preparing/ready/cancel; customer for cancel-within-window; admin always.

**Request body**

```ts
class UpdateOrderStatusRequestDTO {
  @IsEnum(OrderStatus)
  status!: 'accepted' | 'rejected' | 'preparing' | 'ready' | 'cancelled';

  @IsOptional() @IsString() @MaxLength(500)
  reason?: string;  // required for rejected/cancelled
}
```

**Response 200**

```ts
class OrderStatusResponseDTO {
  publicId: string;
  status: OrderStatus;
  updatedAt: string;
}
```

**Errors**

| Status | Body                                                  |
| ------ | ----------------------------------------------------- |
| 409    | `{ "error": "InvalidStatusTransition", "from": "...", "to": "..." }` |
| 409    | `{ "error": "CancellationWindowExpired" }`            |

---

## 2. Payments

### 2.1 POST /api/payments/init

**Headers**: `Cookie`, `Idempotency-Key` (strict).

**Request**

```ts
class InitPaymentRequestDTO {
  @IsUUID()
  orderId!: string;
}
```

**Response 200**

```ts
class PaymentInitResponseDTO {
  sessionId: string;            // our payment_sessions.id
  providerSessionId: string;    // Kashier's
  redirectUrl: string;
  expiresAt: string;
  amount: number;
  currency: string;
}
```

**Errors**

| Status | Body                                          |
| ------ | --------------------------------------------- |
| 404    | `{ "error": "OrderNotFound" }`                |
| 409    | `{ "error": "OrderNotPendingPayment" }`       |
| 503    | `{ "error": "Payment provider unavailable" }` |

---

### 2.2 POST /api/payments/webhook/{provider}

**Path**: `provider` ∈ `{ "kashier" }`.

**Headers**: provider-specific signature header (Kashier sends in `x-kashier-signature` or similar — verified in code).

**Body**: provider-defined raw payload, kept as-is in `payment_webhook_events.payload`.

**Response**: always **200** (we ack on duplicates; only return non-200 if signature is bad or DB write throws).

**Errors**

| Status | Body                                  |
| ------ | ------------------------------------- |
| 401    | `{ "error": "InvalidSignature" }`     |
| 500    | (rare) — Kashier will retry           |

---

### 2.3 GET /api/payments/{paymentId}

**Auth**: `payments:read` (restaurant owner) or system_admin.

**Response 200**

```ts
class PaymentResponseDTO {
  id: number;
  orderPublicId: string;
  type: 'charge' | 'refund' | 'commission' | 'cod_collection' | 'payout' | 'adjustment';
  method: 'online' | 'cod' | 'bank_transfer' | 'system';
  provider?: 'kashier';
  providerReferenceId?: string;
  status: 'pending' | 'succeeded' | 'failed' | 'reversed';
  amount: number;
  currency: string;
  isRefunded: boolean;
  refundedPaymentId?: number;
  createdAt: string;
  updatedAt: string;
}
```

---

### 2.4 POST /api/payments/{paymentId}/refund

**Auth**: system_admin.

**Headers**: `Idempotency-Key` (strict).

**Request**

```ts
class RefundRequestDTO {
  @IsOptional() @IsInt() @Min(1)
  amount?: number;  // omit → full refund

  @IsString() @MinLength(1) @MaxLength(500)
  reason!: string;
}
```

**Response 202** (accepted; final state via webhook):

```ts
{ "refundId": number, "status": "pending", "amount": number, "currency": string }
```

---

## 3. Deliveries

### 3.1 POST /api/deliveries/assign/{orderId}

**Auth**: system_admin (or system internal).

**Request**

```ts
class AssignDeliveryRequestDTO {
  @IsOptional() @IsInt() @Min(1)
  agentId?: number;  // present → manual assignment to specific agent
}
```

**Response 201**

```ts
class DeliveryResponseDTO {
  id: number;
  orderPublicId: string;
  agent: { id: number; name: string; phone?: string };
  status: DeliveryStatus;
  pickup: { lat: number; lng: number };
  dropoff: { lat: number; lng: number };
  distanceMeters: number | null;
  assignedAt: string;
}
```

**Errors**

| Status | Body                                          |
| ------ | --------------------------------------------- |
| 409    | `{ "error": "OrderNotReady" }`                |
| 409    | `{ "error": "OrderAlreadyHasActiveDelivery" }`|
| 409    | `{ "error": "NoEligibleAgents" }`             |

---

### 3.2 POST /api/deliveries/reassign/{orderId}

**Auth**: system_admin.

**Response 201**: `DeliveryResponseDTO` (the new row).

**Errors**

| Status | Body                                              |
| ------ | ------------------------------------------------- |
| 409    | `{ "error": "MaxReassignmentAttemptsReached" }`   |

---

### 3.3 PATCH /api/deliveries/{deliveryId}/status

**Auth**: delivery_agent (must own the delivery).

**Request**

```ts
class UpdateDeliveryStatusRequestDTO {
  @IsEnum(DeliveryStatus)
  status!: 'accepted' | 'rejected' | 'picked' | 'delivered';

  @IsOptional() @IsString() @MaxLength(500)
  reason?: string;
}
```

**Response 200**

```ts
class DeliveryStatusResponseDTO {
  id: number;
  status: DeliveryStatus;
  updatedAt: string;
}
```

---

## 4. Agents

### 4.1 POST /api/agents/presence/online

**Auth**: delivery_agent.

**Request**

```ts
class PresenceOnlineRequestDTO {
  @IsNumber() lat!: number;
  @IsNumber() lng!: number;
}
```

**Response 200**: `{ "ok": true }`.

### 4.2 POST /api/agents/presence/offline

Empty body. Response 200 `{ "ok": true }` or 409 `AgentInActiveDelivery`.

### 4.3 POST /api/agents/presence/ping

Same body as `online`. Response 200 `{ "ok": true }` or 409 `NotOnline`.

### 4.4 GET /api/agents/tasks?status=

**Query**: `status?`, pagination.

**Response 200**: paginated `DeliveryTaskResponseDTO[]`.

```ts
class DeliveryTaskResponseDTO {
  deliveryId: number;
  orderPublicId: string;
  status: DeliveryStatus;
  pickup: { branchName: string; lat: number; lng: number; addressText: string };
  dropoff: { lat: number; lng: number; addressText: string };
  itemsCount: number;
  total: number;
  currency: string;
  paymentMethod: 'online' | 'cod';
  earningEstimate?: number;
  assignedAt: string;
}
```

### 4.5 GET /api/agents/earnings?from=&to=

**Response 200**: `AgentEarningsResponseDTO` (see Agents.md).

---

## 5. Restaurant Finance

### 5.1 GET /api/restaurant/balance

**Auth**: `finance:read`.

**Response 200**

```ts
class RestaurantBalanceResponseDTO {
  restaurantId: number;
  balances: Array<{ currency: string; balance: number }>;
  asOf: string;
}
```

### 5.2 GET /api/restaurant/payouts?from=&to=

**Auth**: `finance:read`.

**Response 200**: paginated `PayoutResponseDTO[]`.

```ts
class PayoutResponseDTO {
  id: number;
  amount: number;
  currency: string;
  status: 'pending' | 'succeeded' | 'failed' | 'reversed';
  providerReferenceId?: string;
  createdAt: string;
}
```

### 5.3 POST /api/restaurant/payouts (admin)

**Auth**: system_admin. **Headers**: `Idempotency-Key` (strict).

**Request**

```ts
class CreatePayoutRequestDTO {
  @IsInt() @Min(1)         restaurantId!: number;
  @IsInt() @Min(1)         amount!: number;
  @IsEnum(Currency)        currency!: 'EGP' | 'SAR';
  @IsString() @MinLength(1) providerReferenceId!: string;
  @IsOptional() @IsString() note?: string;
}
```

**Response 201**: `PayoutResponseDTO`.

**Errors**: 409 `InsufficientBalance`, 409 `IdempotencyConflict`.

---

## 6. WebSocket protocol (socket.io)

### 6.1 Connect

```ts
const socket = io("wss://<host>", {
    path: "/ws",
    auth: { token: "<jwt>" },   // or ?token=, or Cookie: access_token
    transports: ["websocket"],
});
```

Connection middleware validates the JWT. Rejected handshakes receive a `connect_error` with the reason; invalid token = `"Unauthorized"`.

### 6.2 Client → Server events

```ts
socket.emit("subscribe",   "branch:42", (ack) => { /* { ok: true } | { ok: false, error } */ });
socket.emit("unsubscribe", "branch:42");
```

Allowed rooms are derived from the JWT at connect time. Forbidden rooms return `{ ok: false, error: "not permitted" }` — connection stays open.

### 6.3 Server → Client events

```ts
// emitted once at connect
socket.on("hello", ({ allowedChannels }) => { /* list of rooms the user may join */ });

// emitted when a subscribe succeeds
socket.on("subscribed", ({ channel }) => { /* ... */ });

// domain events
socket.on("order.status_changed", (payload) => {
    // { orderPublicId, status, updatedAt }
});
socket.on("delivery.position",    (payload) => { /* ... */ });
socket.on("task.assigned",        (payload) => { /* ... */ });
```

Server emits with `io.to("<room>").emit("<event.name>", payload)`. Heartbeat is handled by socket.io (`pingInterval = WS_HEARTBEAT_SEC`); clients don't send manual pings.

### 6.4 Channels & permitted events (full table)

| Channel format            | Subscriber                                | Events                                                                                                                                                                |
| ------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `customer:<userId>`       | the customer                              | `order.status_changed`, `delivery.position`, `payment.failed`, `payment.captured`                                                                                     |
| `restaurant:<restId>`     | restaurant owner                          | `order.created`, `order.cancelled`                                                                                                                                    |
| `branch:<branchId>`       | restaurant manager / staff (member)       | `order.created`, `order.status_changed`, `order.cancelled`, `delivery.assigned`                                                                                       |
| `agent:<agentId>`         | the agent                                 | `task.assigned`, `task.cancelled`                                                                                                                                     |

Payload shapes for events follow the response DTOs already defined (e.g. `order.status_changed.payload === { orderPublicId, status, updatedAt }`).

---

## 7. Health

### 7.1 GET /api/health

No auth. Returns 200 `OK` if DB ping succeeds, 500 otherwise. Mirrors core-service.

---

## 8. Internal endpoints (not for clients)

This service exposes **no** internal HTTP endpoints for inter-service traffic.

Async traffic from `core-service` (cache invalidation) arrives over **RabbitMQ**, not HTTP. See `system-design.md` §5 for topology, `database-design.md` §3.12 for the dedupe log. Message envelope:

```jsonc
{
  "eventId": "<uuid, stable across broker redeliveries>",
  "eventType": "product.stock.changed",
  "occurredAt": "2026-04-16T15:00:00.000Z",
  "payload": { /* event-specific */ }
}
```

This service does **not** emit any outbound events to anyone in this milestone.

---

## 9. Error codes (canonical)

| Code                              | HTTP | Module        |
| --------------------------------- | ---- | ------------- |
| `OrderNotFound`                   | 404  | orders        |
| `OrderNotPendingPayment`          | 409  | orders        |
| `BranchNotAcceptingOrders`        | 409  | orders        |
| `OutOfStock`                      | 409  | orders        |
| `IdempotencyConflict`             | 409  | shared        |
| `InvalidStatusTransition`         | 409  | orders        |
| `CancellationWindowExpired`       | 409  | orders        |
| `OrderNotReady`                   | 409  | deliveries    |
| `OrderAlreadyHasActiveDelivery`   | 409  | deliveries    |
| `NoEligibleAgents`                | 409  | deliveries    |
| `MaxReassignmentAttemptsReached`  | 409  | deliveries    |
| `AgentInActiveDelivery`           | 409  | agents        |
| `NotOnline`                       | 409  | agents        |
| `InsufficientBalance`             | 409  | finance       |
| `InvalidSignature`                | 401  | payments      |
| `Core service unavailable`        | 503  | shared        |
| `Payment provider unavailable`    | 503  | payments      |
| `User not authenticated`          | 401  | shared        |
| `User not authorised`             | 403  | shared        |

All thrown via `errors.ts` files in each module — no ad-hoc strings.
