/**
 * Inbound core-event payload shapes consumed by the order module's cache
 * projections (CoreDataCacheService). Mirrors what core-service emits via
 * its outbox — do not change without coordinating with
 * core-service/src/lib/events/event-types.ts.
 *
 * Cross-cutting infra event payloads (e.g. rbac.permissions_changed, which
 * lib/rbac/permission-cache.service.ts owns) stay inline in their consumers.
 */

export interface ProductStockChangedPayload {
    branchId: number;
    productId: number;
    newStock?: number;
    isAvailable?: boolean;
}

export interface ProductPriceChangedPayload {
    branchId: number;
    productId: number;
    newPrice: number;
}

export interface BranchEventPayload {
    branchId: number;
}

export interface RestaurantSuspendedPayload {
    restaurantId: number;
}
