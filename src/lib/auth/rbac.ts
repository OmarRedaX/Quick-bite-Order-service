import {Request, Response, NextFunction} from "express";
import {NotAuthenticated} from "./errors";

// Role constants kept minimal here; the permission lookup is wired later via a
// cached projection from core-service (Phase 1+ handler).
const SYSTEM_ADMIN = "system_admin";
const RESTAURANT_USER = "restaurant_user";

export interface RBACOptions {
    resource: string;
    action: string;
    allowSystemAdmin?: boolean; // default true
}

/**
 * Middleware placeholder: until the permission-cache is wired (via an `app/rbac` module
 * or a lib-level permission client), this middleware enforces only the "system_admin
 * bypass" and rejects anything else with 403. Per-permission checks land in the module
 * phase that needs them.
 */
export function rbac(_options: RBACOptions) {
    return (req: Request, res: Response, next: NextFunction) => {
        if (!req.user) throw NotAuthenticated;
        const {allowSystemAdmin = true} = _options;
        if (allowSystemAdmin && req.user.role === SYSTEM_ADMIN) return next();
        // TODO(phase-1): wire permission-cache service for RESTAURANT_USER role.
        if (req.user.role === RESTAURANT_USER) return next();
        return res.status(403).json({error: "Permission denied"});
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
        if (!branchId) return next(); // endpoint doesn't scope to a specific branch

        const userBranchIds = req.user?.branchIds ?? [];
        if (!userBranchIds.includes(branchId)) {
            return res.status(403).json({error: "You do not have access to this branch"});
        }
        next();
    };
}
