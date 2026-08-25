export enum OrderStatus {
    PENDING_PAYMENT = "pending_payment",
    PLACED = "placed",
    ACCEPTED = "accepted",
    REJECTED = "rejected",
    PREPARING = "preparing",
    READY = "ready",
    ASSIGNED = "assigned",
    PICKED = "picked",
    DELIVERED = "delivered",
    CANCELLED = "cancelled",
}

export enum PaymentMethod {
    ONLINE = "online",
    COD = "cod",
}

export enum Currency {
    EGP = "EGP",
    SAR = "SAR",
}

/**
 * Roles allowed to drive a status transition. Resolved from JWT + endpoint.
 * Kept narrow on purpose — restaurant_member covers owner / branch_manager / staff.
 */
export enum StatusActor {
    CUSTOMER = "customer",
    RESTAURANT_MEMBER = "restaurant_member",
    AGENT = "agent",
    SYSTEM = "system",
    ADMIN = "admin",
}
