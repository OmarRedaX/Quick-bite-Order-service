import {Router} from "express";
import {authenticate} from "../../lib/auth/guard";
import {rbac} from "../../lib/auth/rbac";
import {requireRegion} from "../../lib/sharding/region-resolver";
import {idempotency} from "../../lib/idempotency/idempotency";
import {container} from "../../lib/di/container";
import {TOKENS} from "../../lib/di/tokens";
import {AssignmentController} from "./controller/assignment.controller";

export const assignmentRouter = Router();

const ctrl = container.resolve<AssignmentController>(TOKENS.AssignmentController);

// Admin override — force-assigns regardless of distance / busy state.
// rbac{deliveries:assign} or system_admin (admin always bypasses).
assignmentRouter.post(
    "/admin/orders/:publicId/assign",
    authenticate,
    requireRegion,
    rbac({resource: "deliveries", action: "assign"}),
    idempotency({strict: true}),
    ctrl.adminAssign,
);
