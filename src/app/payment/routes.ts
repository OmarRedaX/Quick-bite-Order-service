import {Router} from "express";
import {authenticate} from "../../lib/auth/guard";
import {rbac, requireRestaurantMember} from "../../lib/auth/rbac";
import {requireConcreteRegion} from "../../lib/sharding/region-resolver";
import {container} from "../../lib/di/container";
import {TOKENS} from "../../lib/di/tokens";
import {PaymentController} from "./controller/payment.controller";
import {WebhookController} from "./controller/webhook.controller";

export const paymentRouter = Router();

const paymentController = container.resolve<PaymentController>(TOKENS.PaymentController);
const webhookController = container.resolve<WebhookController>(TOKENS.WebhookController);

// Public webhook — verified by HMAC inside the controller; no auth middleware.
// Region comes from `?region=eg` (Kashier can't set custom headers).
paymentRouter.post(
    "/payments/webhook/kashier",
    requireConcreteRegion,
    webhookController.kashier,
);

// Restaurant-scoped read. requireRestaurantMember + rbac handle the auth;
// the service only verifies the payment actually belongs to this restaurant.
paymentRouter.get(
    "/restaurants/:restaurantId/payments/:paymentId",
    authenticate,
    requireConcreteRegion,
    requireRestaurantMember("restaurantId"),
    rbac({resource: "payments", action: "read"}),
    paymentController.getById,
);
