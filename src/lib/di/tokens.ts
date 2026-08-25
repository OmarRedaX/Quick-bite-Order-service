export const TOKENS = {
    // infra
    Logger: Symbol.for("Logger"),
    CacheProvider: Symbol.for("CacheProvider"),
    MessageBroker: Symbol.for("MessageBroker"),
    CoreClient: Symbol.for("CoreClient"),
    WsServer: Symbol.for("WsServer"),
    PermissionCacheService: Symbol.for("PermissionCacheService"),
    CoreDataCacheService: Symbol.for("CoreDataCacheService"),

    // app: order
    OrderService: Symbol.for("OrderService"),
    OrderController: Symbol.for("OrderController"),

    // app: payment
    KashierProvider: Symbol.for("KashierProvider"),
    PaymentService: Symbol.for("PaymentService"),
    KashierWebhookService: Symbol.for("KashierWebhookService"),
    PaymentController: Symbol.for("PaymentController"),
    WebhookController: Symbol.for("WebhookController"),

    // app: agent (presence + accept/reject + tasks + earnings)
    PresenceService: Symbol.for("PresenceService"),
    AgentService: Symbol.for("AgentService"),
    AgentController: Symbol.for("AgentController"),

    // app: assignment (broadcast worker + claim service)
    AssignmentService: Symbol.for("AssignmentService"),
    AssignmentController: Symbol.for("AssignmentController"),

    // app: settlement (delivered → balance + earnings + commission)
    SettlementService: Symbol.for("SettlementService"),

    // app: finance (balance + payouts)
    FinanceService: Symbol.for("FinanceService"),
    FinanceController: Symbol.for("FinanceController"),
};
