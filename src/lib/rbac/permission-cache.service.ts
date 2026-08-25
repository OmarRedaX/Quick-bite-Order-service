import {injectable} from "tsyringe";
import {toMs} from "../../pkg/utils/time";
import {logger} from "../logger/logger";
import {getPermissionsByRole} from "../core-client/rbac.client";

// Trivial inbound shape — kept inline because this is the only consumer.
// (Module-specific event payloads live under their owning module.)
type RbacPermissionsChangedPayload = {role?: string};

/**
 * In-process cache of permissions per restaurantRole. Source is core-service's
 * `GET /api/internal/rbac/permissions?role=...` (HTTP, via core-client).
 *
 * Mirrors core-service's `PermissionCacheService` (Map + TTL). Invalidation on
 * `rbac.permissions_changed` events clears the entry so the next request
 * re-fetches.
 */
@injectable()
export class PermissionCacheService {
    private cache: Map<string, {permissions: string[]; cachedAt: number}> = new Map();
    private readonly TTL = toMs(1, "h");

    getPermissions = async (roleName: string): Promise<string[]> => {
        const cached = this.cache.get(roleName);
        if (cached && Date.now() - cached.cachedAt < this.TTL) {
            return cached.permissions;
        }
        const permissions = await getPermissionsByRole(roleName);
        this.cache.set(roleName, {permissions, cachedAt: Date.now()});
        return permissions;
    };

    hasPermission = (permissions: string[], resource: string, action: string): boolean => {
        return permissions.includes(`${resource}:${action}`);
    };

    invalidate = (roleName?: string): void => {
        if (roleName) this.cache.delete(roleName);
        else this.cache.clear();
    };

    /**
     * Thin handler entry point — wired into the core-events consumer registry.
     */
    handlePermissionsChanged = async (payload: unknown): Promise<void> => {
        const p = payload as RbacPermissionsChangedPayload | undefined;
        this.invalidate(p?.role);
        logger.info("rbac.permissions_changed -> permission cache cleared", {role: p?.role ?? "*"});
    };
}
