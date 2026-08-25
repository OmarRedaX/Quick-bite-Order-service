import {OrderStatus, PaymentMethod, Currency, StatusActor} from "./enums";

// ── repo inputs ──────────────────────────────────────────────────────────
export interface CreateOrderInput {
    region: string;
    publicId: string;
    countryCode: string;
    restaurantId: number;
    restaurantOwnerId: number;
    branchId: number;
    customerId: number;
    customerAddressId: number;
    deliveryLat: number;
    deliveryLng: number;
    deliveryAddressTextSnapshot: string;
    branchLat: number;
    branchLng: number;
    status: OrderStatus;
    subtotal: number;
    deliveryFee: number;
    serviceFee: number;
    total: number;
    currency: Currency;
    paymentMethod: PaymentMethod;
}

export interface InsertOrderItemInput {
    region: string;
    orderId: number;
    productId: number;
    quantity: number;
    unitPriceSnapshot: number;
    nameSnapshot: string;
    imageUrlSnapshot: string | null;
    lineTotal: number;
}

// ── repo filters ─────────────────────────────────────────────────────────
export interface ListCustomerOrdersFilter {
    customerId: number;
    yearStart: Date;
    yearEnd: Date;
}

export interface ListRestaurantOrdersFilter {
    restaurantId: number;
    branchId: number;
    status?: OrderStatus;
    from?: Date;
    to?: Date;
}

export interface ListResult<T> {
    data: T[];
    meta: {
        nextCursor: string | null;
        hasMore: boolean;
        count: number;
    };
}

// ── service-level helpers ────────────────────────────────────────────────
export interface ActorContext {
    userId: number;
    role: string;
    restaurantId?: number;
    restaurantRole?: string;
    branchIds?: number[];
}

export interface UnavailableItem {
    productId: number;
    requested: number;
    available: number;
}

export interface OrderLineDraft {
    productId: number;
    quantity: number;
    unitPrice: number;
    lineTotal: number;
    name: string;
    imageUrl: string | null;
}

export interface AssertTransitionContext {
    actor: StatusActor;
    reason?: string;
    /** required when actor === customer to enforce the cancel window */
    placedAt?: Date | null;
    acceptedAt?: Date | null;
}

export interface AssertTransitionResult {
    /** Postgres column to stamp inside the same trx (null = no stamp) */
    stamp: string | null;
}

