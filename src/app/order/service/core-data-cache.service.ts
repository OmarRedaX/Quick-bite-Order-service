import {inject, injectable} from "tsyringe";
import {TOKENS} from "../../../lib/di/tokens";
import {ICacheProvider} from "../../../pkg/cache/cache.interface";
import {logger} from "../../../lib/logger/logger";
import {toSeconds} from "../../../pkg/utils/time";
import {
    ProductStockChangedPayload,
    ProductPriceChangedPayload,
    BranchEventPayload,
    RestaurantSuspendedPayload,
} from "../core-events.types";

/**
 * Owns the order-service projection of core data cached in Redis.
 *
 * Responsibilities:
 *   - Cache writes / invalidations driven by inbound core-events.
 *   - Reject-orders flag for branches that go offline (read on placement).
 *
 * Read-throughs live in `lib/core-client/branch.client.ts` (`getBranch`,
 * `getBranchesByIds`, `getBranchProducts`) — they share the same Redis keys
 * this service writes to (`core:branch:<id>`, `core:branch:<bid>:product:<pid>`),
 * so an inbound event invalidates / merges the read-through cache entry too.
 */
const PRODUCT_CACHE_TTL = toSeconds(1, "h");
const BRANCH_REJECT_FLAG_TTL = toSeconds(7, "d");

function productKey(branchId: number, productId: number): string {
    return `core:branch:${branchId}:product:${productId}`;
}
function branchKey(branchId: number): string {
    return `core:branch:${branchId}`;
}
function restaurantKey(restaurantId: number): string {
    return `core:restaurant:${restaurantId}`;
}
function rejectFlagKey(branchId: number): string {
    return `branch:reject-new-orders:${branchId}`;
}

@injectable()
export class CoreDataCacheService {
    constructor(@inject(TOKENS.CacheProvider) private readonly cache: ICacheProvider) {}

    isBranchRejectingOrders = async (branchId: number): Promise<boolean> => {
        const flag = await this.cache.get(rejectFlagKey(branchId));
        return flag === "1";
    };

    handleProductStockChanged = async (payload: unknown): Promise<void> => {
        const p = payload as ProductStockChangedPayload;
        if (!p?.branchId || !p?.productId) return;
        await this.upsertProductStock(p);
    };

    handleProductPriceChanged = async (payload: unknown): Promise<void> => {
        const p = payload as ProductPriceChangedPayload;
        if (!p?.branchId || !p?.productId) return;
        await this.upsertProductPrice(p);
    };

    handleBranchUpdated = async (payload: unknown): Promise<void> => {
        const p = payload as BranchEventPayload;
        if (!p?.branchId) return;
        await this.cache.del(branchKey(p.branchId));
        await this.cache.del(rejectFlagKey(p.branchId));
        logger.debug("branch.updated -> invalidated", {branchId: p.branchId});
    };

    handleBranchDeactivated = async (payload: unknown): Promise<void> => {
        const p = payload as BranchEventPayload;
        if (!p?.branchId) return;
        await this.cache.del(branchKey(p.branchId));
        await this.cache.set(rejectFlagKey(p.branchId), "1", BRANCH_REJECT_FLAG_TTL);
        logger.info("branch.deactivated -> reject-new-orders flag set", {branchId: p.branchId});
    };

    handleRestaurantSuspended = async (payload: unknown): Promise<void> => {
        const p = payload as RestaurantSuspendedPayload;
        if (!p?.restaurantId) return;
        await this.cache.del(restaurantKey(p.restaurantId));
        logger.info("restaurant.suspended -> cache invalidated", {restaurantId: p.restaurantId});
    };

    private upsertProductStock = async (p: ProductStockChangedPayload): Promise<void> => {
        const existing = await this.cache.get(productKey(p.branchId, p.productId));
        const merged = existing ? JSON.parse(existing) : {};
        if (p.newStock !== undefined) merged.stock = p.newStock;
        if (p.isAvailable !== undefined) merged.isAvailable = p.isAvailable;
        merged.productId = p.productId;
        await this.cache.set(productKey(p.branchId, p.productId), JSON.stringify(merged), PRODUCT_CACHE_TTL);
        logger.debug("product.stock.changed -> upserted", {branchId: p.branchId, productId: p.productId, newStock: p.newStock});
    };

    private upsertProductPrice = async (p: ProductPriceChangedPayload): Promise<void> => {
        const existing = await this.cache.get(productKey(p.branchId, p.productId));
        const merged = existing ? JSON.parse(existing) : {};
        merged.price = p.newPrice;
        merged.productId = p.productId;
        await this.cache.set(productKey(p.branchId, p.productId), JSON.stringify(merged), PRODUCT_CACHE_TTL);
        logger.debug("product.price.changed -> upserted", {branchId: p.branchId, productId: p.productId, newPrice: p.newPrice});
    };
}
