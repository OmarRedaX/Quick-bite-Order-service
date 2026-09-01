import {Router} from "express";
import {authenticate} from "../../lib/auth/guard";
import {rbac, requireRestaurantMember, requireSystemAdmin} from "../../lib/auth/rbac";
import {requireRegion} from "../../lib/sharding/region-resolver";
import {idempotency} from "../../lib/idempotency/idempotency";
import {container} from "../../lib/di/container";
import {TOKENS} from "../../lib/di/tokens";
import {FinanceController} from "./controller/finance.controller";

export const financeRouter = Router();

const ctrl = container.resolve<FinanceController>(TOKENS.FinanceController);

// Restaurant-scoped reads. requireRestaurantMember pins :restaurantId to the
// JWT's restaurantId; system_admin bypasses.
financeRouter.get(
    "/restaurants/:restaurantId/balance",
    authenticate,
    requireRegion,
    requireRestaurantMember("restaurantId"),
    rbac({resource: "finance", action: "read"}),
    ctrl.getBalance,
);

financeRouter.get(
    "/restaurants/:restaurantId/payouts",
    authenticate,
    requireRegion,
    requireRestaurantMember("restaurantId"),
    rbac({resource: "finance", action: "read"}),
    ctrl.listPayouts,
);

// Admin-only write, enforced by role — not the permission catalog.
// `finance:payout_create` is seeded for `owner` too (owner gets every
// seeded permission), so `rbac({resource:"finance", action:"payout_create"})`
// alone would let a restaurant owner create payouts on their own
// restaurant, contradicting the "admin-only" intent below. requireSystemAdmin
// is a hard role check with no catalog involved.
financeRouter.post(
    "/admin/restaurants/:restaurantId/payouts",
    authenticate,
    requireRegion,
    requireSystemAdmin,
    idempotency({strict: true}),
    ctrl.createPayout,
);
