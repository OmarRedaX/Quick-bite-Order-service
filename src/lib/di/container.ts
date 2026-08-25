import "reflect-metadata";
import {container} from "tsyringe";
import {TOKENS} from "./tokens";
import {Logger} from "../logger/logger";
import {cacheProvider} from "../cache/init";
import {messageBroker} from "../messaging/init";
import {coreClient} from "../core-client/core-client";
import {PermissionCacheService} from "../rbac/permission-cache.service";
import {CoreDataCacheService} from "../../app/order/service/core-data-cache.service";
import {OrderService} from "../../app/order/service/order.service";
import {OrderController} from "../../app/order/controller/order.controller";
import {env} from "../config/env";
import {KashierClient} from "../../pkg/payments/kashier/kashier.client";
import {PaymentService} from "../../app/payment/service/payment.service";
import {KashierWebhookService} from "../../app/payment/service/kashier-webhook.service";
import {PaymentController} from "../../app/payment/controller/payment.controller";
import {WebhookController} from "../../app/payment/controller/webhook.controller";
import {PresenceService} from "../../app/agent/service/presence.service";
import {SettlementService} from "../../app/agent/service/settlement.service";
import {AgentService} from "../../app/agent/service/agent.service";
import {AgentController} from "../../app/agent/controller/agent.controller";
import {AssignmentService} from "../../app/assignment/service/assignment.service";
import {AssignmentController} from "../../app/assignment/controller/assignment.controller";
import {FinanceService} from "../../app/finance/service/finance.service";
import {FinanceController} from "../../app/finance/controller/finance.controller";

// Infrastructure
container.registerSingleton<Logger>(TOKENS.Logger, Logger);
container.registerInstance(TOKENS.CacheProvider, cacheProvider);
container.registerInstance(TOKENS.MessageBroker, messageBroker);
container.registerInstance(TOKENS.CoreClient, coreClient);
container.registerSingleton<PermissionCacheService>(TOKENS.PermissionCacheService, PermissionCacheService);
container.registerSingleton<CoreDataCacheService>(TOKENS.CoreDataCacheService, CoreDataCacheService);

// pkg providers (constructed eagerly with env config)
const kashierClient = new KashierClient({
    baseUrl: env.kashier.baseUrl,
    merchantId: env.kashier.merchantId,
    apiKey: env.kashier.apiKey,
    secretKey: env.kashier.secretKey,
    paymentType: env.kashier.paymentType,
    serverWebhookUrl: env.kashier.webhookUrl,
    merchantRedirect: env.kashier.returnUrl,
    failureRedirectEnabled: false,
    sessionTimeoutSec: env.payments.sessionTimeoutMin * 60,
});
container.registerInstance(TOKENS.KashierProvider, kashierClient);

// Domain: order
container.registerSingleton<OrderService>(TOKENS.OrderService, OrderService);
container.registerSingleton<OrderController>(TOKENS.OrderController, OrderController);

// Domain: payment
container.registerSingleton<PaymentService>(TOKENS.PaymentService, PaymentService);
container.registerSingleton<KashierWebhookService>(TOKENS.KashierWebhookService, KashierWebhookService);
container.registerSingleton<PaymentController>(TOKENS.PaymentController, PaymentController);
container.registerSingleton<WebhookController>(TOKENS.WebhookController, WebhookController);

// Domain: agent + assignment + settlement (Phase 3)
container.registerSingleton<PresenceService>(TOKENS.PresenceService, PresenceService);
container.registerSingleton<AssignmentService>(TOKENS.AssignmentService, AssignmentService);
container.registerSingleton<SettlementService>(TOKENS.SettlementService, SettlementService);
container.registerSingleton<AgentService>(TOKENS.AgentService, AgentService);
container.registerSingleton<AgentController>(TOKENS.AgentController, AgentController);
container.registerSingleton<AssignmentController>(TOKENS.AssignmentController, AssignmentController);

// Domain: finance (Phase 4)
container.registerSingleton<FinanceService>(TOKENS.FinanceService, FinanceService);
container.registerSingleton<FinanceController>(TOKENS.FinanceController, FinanceController);

export {container};
