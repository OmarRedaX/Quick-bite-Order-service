import {Router} from "express";
import {authenticate} from "../../lib/auth/guard";
import {rbac, requireRestaurantMember, requireBranchAccess} from "../../lib/auth/rbac";
import {idempotency} from "../../lib/idempotency/idempotency";
import {withCache} from "../../lib/cache/withCache";
import {requireRegion} from "../../lib/sharding/region-resolver";
import {container} from "../../lib/di/container";
import {TOKENS} from "../../lib/di/tokens";
import {OrderController} from "./controller/order.controller";

export const orderRouter = Router();

const orderController = container.resolve<OrderController>(TOKENS.OrderController);

// ── Customer-facing ─────────────────────────────────────────────────────
orderRouter.post(
    "/orders",
    authenticate,
    requireRegion,
    idempotency({strict: true}),
    orderController.placeOrder,
);

orderRouter.get(
    "/orders/:publicId",
    authenticate,
    requireRegion,
    orderController.getOrder,
);

orderRouter.get(
    "/customer/orders",
    authenticate,
    requireRegion,
    orderController.listCustomerOrders,
);

// Customer-only cancel endpoint (status target is implicit: cancelled).
orderRouter.patch(
    "/customer/orders/:publicId/status",
    authenticate,
    requireRegion,
    idempotency({strict: true}),
    orderController.updateStatus,
);

// ── Restaurant-facing (path-scoped so middleware can guard) ─────────────
orderRouter.get(
    "/restaurants/:restaurantId/branches/:branchId/orders",
    authenticate,
    requireRegion,
    requireRestaurantMember("restaurantId"),
    requireBranchAccess("branchId"),
    rbac({resource: "orders", action: "read"}),
    withCache(10),
    orderController.listRestaurantOrders,
);

// Restaurant member status transitions (accept/reject/preparing/ready/cancelled).
// The status machine + the rbac() middleware enforce per-target permissions.
orderRouter.patch(
    "/restaurants/:restaurantId/branches/:branchId/orders/:publicId/status",
    authenticate,
    requireRegion,
    requireRestaurantMember("restaurantId"),
    requireBranchAccess("branchId"),
    idempotency({strict: true}),
    orderController.updateStatus,
);

// ── Admin override (any transition the matrix allows for `admin`) ───────
orderRouter.patch(
    "/admin/orders/:publicId/status",
    authenticate,
    requireRegion,
    rbac({resource: "orders", action: "cancel"}),
    idempotency({strict: true}),
    orderController.updateStatus,
);
