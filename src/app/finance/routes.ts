import {Router} from "express";
import {authenticate} from "../../lib/auth/guard";
import {rbac, requireRestaurantMember} from "../../lib/auth/rbac";
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

// Admin-only write. requireRestaurantMember would block non-admins anyway, but
// rbac covers admin bypass + future operator role.
financeRouter.post(
    "/admin/restaurants/:restaurantId/payouts",
    authenticate,
    requireRegion,
    rbac({resource: "finance", action: "payout_create"}),
    idempotency({strict: true}),
    ctrl.createPayout,
);
