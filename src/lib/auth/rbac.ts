import {Request, Response, NextFunction} from "express";
import {TOKENS} from "../di/tokens";
import {container} from "../di/container";
import {PermissionCacheService} from "../rbac/permission-cache.service";
import {NotAuthenticated} from "./errors";

const SYSTEM_ADMIN = "system_admin";
const RESTAURANT_USER = "restaurant_user";
const DELIVERY_AGENT = "delivery_agent";

/**
 * Gate routes that may only be called by users with the `delivery_agent`
 * system role. Same shape as requireRestaurantMember — guarantees the actor
 * before the controller has to think about it.
 */
export function requireAgent(req: Request, res: Response, next: NextFunction) {
    if (!req.user) return res.status(401).json({error: "User not authenticated"});
    if (req.user.role !== DELIVERY_AGENT) return res.status(403).json({error: "Agent role required"});
    next();
}

/**
 * Gate routes that may only be called by `system_admin` — a hard role
 * check, not a permission-catalog lookup. Use this instead of
 * `rbac({resource, action})` for a route that's genuinely meant to be
 * platform-admin-only: `rbac()`'s catalog check can't express "admin only"
 * on its own, because any permission a `restaurant_user` role happens to
 * hold (e.g. `owner`'s blanket grant of every seeded permission) still
 * passes it. `finance:payout_create` is a real example — it's seeded for
 * `owner` too, so `rbac({resource:"finance", action:"payout_create"})`
 * alone lets a restaurant owner create payouts on their own restaurant,
 * which contradicts this route's "admin-only" intent.
 */
export function requireSystemAdmin(req: Request, res: Response, next: NextFunction) {
    if (!req.user) return res.status(401).json({error: "User not authenticated"});
    if (req.user.role !== SYSTEM_ADMIN) return res.status(403).json({error: "system_admin role required"});
    next();
}

export interface RBACOptions {
    resource: string;
    action: string;
    allowSystemAdmin?: boolean; // default true
}

export function rbac(options: RBACOptions) {
    return async (req: Request, res: Response, next: NextFunction) => {
        try {
            if (!req.user) throw NotAuthenticated;
            const {resource, action, allowSystemAdmin = true} = options;

            if (allowSystemAdmin && req.user.role === SYSTEM_ADMIN) {
                return next();
            }

            if (req.user.role === RESTAURANT_USER) {
                const cache = container.resolve<PermissionCacheService>(TOKENS.PermissionCacheService);
                const permissions = await cache.getPermissions(req.user.restaurantRole!);
                if (!cache.hasPermission(permissions, resource, action)) {
                    return res.status(403).json({error: "Permission denied"});
                }
                return next();
            }

            return res.status(403).json({error: "Permission denied"});
        } catch (err) {
            next(err);
        }
    };
}

export function requireRestaurantMember(paramName: string = "restaurantId") {
    return (req: Request, res: Response, next: NextFunction) => {
        const restaurantId = Number(req.params[paramName]);
        if (!restaurantId) return res.status(400).json({error: `missing ${paramName}`});
        if (req.user?.role === SYSTEM_ADMIN) return next();
        if (Number(req.user?.restaurantId) !== restaurantId) {
            return res.status(403).json({error: "Permission denied"});
        }
        next();
    };
}

export function requireBranchAccess(paramName: string = "branchId") {
    return (req: Request, res: Response, next: NextFunction) => {
        if (req.user?.role === SYSTEM_ADMIN) return next();
        if (req.user?.restaurantRole === "owner") return next();

        const branchId =
            Number(req.params[paramName]) || Number(req.query[paramName]);
        if (!branchId) return next();

        const userBranchIds = req.user?.branchIds ?? [];
        if (!userBranchIds.includes(branchId)) {
            return res.status(403).json({error: "You do not have access to this branch"});
        }
        next();
    };
}
