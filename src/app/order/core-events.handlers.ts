import {container} from "../../lib/di/container";
import {TOKENS} from "../../lib/di/tokens";
import {CoreDataCacheService} from "./service/core-data-cache.service";
import {PermissionCacheService} from "../../lib/rbac/permission-cache.service";
import {registerHandler} from "../../lib/core-events/consumer";

/**
 * Thin wrappers — each handler delegates to a service method that owns the
 * full action (cache update, side-effects, downstream HTTP, etc.). The
 * consumer registry stays a clean event-type → service-method table.
 */
export function registerOrderModuleCoreEventHandlers() {
    const coreData = container.resolve<CoreDataCacheService>(TOKENS.CoreDataCacheService);
    const perms = container.resolve<PermissionCacheService>(TOKENS.PermissionCacheService);

    registerHandler("product.stock.changed",     coreData.handleProductStockChanged);
    registerHandler("product.price.changed",     coreData.handleProductPriceChanged);
    registerHandler("branch.updated",            coreData.handleBranchUpdated);
    registerHandler("branch.deactivated",        coreData.handleBranchDeactivated);
    registerHandler("restaurant.suspended",      coreData.handleRestaurantSuspended);
    registerHandler("rbac.permissions_changed",  perms.handlePermissionsChanged);
}
