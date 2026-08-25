export interface CoreEnvelope<T> {
    success: boolean;
    data: T;
}

export interface CoreClientRequest {
    method: "GET" | "POST" | "PATCH" | "DELETE";
    path: string;
    body?: unknown;
    correlationId?: string;
    idempotencyKey?: string;
}

// ── branch ───────────────────────────────────────────────────────────────
export interface CoreBranchMetadata {
    id: number;
    restaurantId: number;
    restaurantOwnerId: number;
    restaurantStatus: string;
    region: string;       // country code
    isActive: boolean;
    acceptOrders: boolean;
    deliveryFee: number;
    commissionBps: number;
    currency: string;
    lat: number;
    lng: number;
    name: string;
    addressText: string;
}

export interface CoreBranchProduct {
    productId: number;
    name: string;
    imageUrl: string | null;
    price: number;
    stock: number;
    isAvailable: boolean;
}

export interface ReserveStockItem {
    productId: number;
    quantity: number;
}

export interface ReserveStockApplied {
    productId: number;
    newStock: number;
}

export interface ReserveStockResult {
    ok: true;
    applied: ReserveStockApplied[];
}

// ── address ──────────────────────────────────────────────────────────────
export interface CoreCustomerAddress {
    id: number;
    userId: number;
    label: string;
    country: string;
    city: string;
    street: string;
    building: string;
    apartmentNumber: string;
    lat: number;
    lng: number;
}

// ── rbac ─────────────────────────────────────────────────────────────────
export interface RolePermissionsResponse {
    role: string;
    permissions: string[];
}
