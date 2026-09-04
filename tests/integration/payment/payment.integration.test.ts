import request from "supertest";
import {buildTestApp, coreClientStub, kashierProviderStub, fakeIoServer, resetTestDoubles} from "../support/app";
import {OWNER, OTHER_OWNER, ADMIN} from "../support/scenario";
import {truncateAllRegions} from "../../helpers/db";
import {flushTestCache} from "../../helpers/redis";
import {authHeader, insertOrder} from "../../helpers/fixtures";
import {db} from "../../../src/lib/knex/knex";
import {createSession} from "../../../src/app/payment/repository/payment-session.repo";
import {createTransaction} from "../../../src/app/payment/repository/transaction.repo";
import {OrderStatus, PaymentMethod} from "../../../src/app/order/enums";
import {PaymentSessionStatus, PAYMENT_PROVIDER_IDS, PaymentProviderName, TransactionType, TransactionMethod, TransactionStatus} from "../../../src/app/payment/enums";
import {container} from "../../../src/lib/di/container";
import {TOKENS} from "../../../src/lib/di/tokens";
import {PaymentService} from "../../../src/app/payment/service/payment.service";

const app = buildTestApp();

beforeEach(async () => {
    await truncateAllRegions(["eg", "ksa"]);
    await flushTestCache();
    resetTestDoubles();
});

async function seedPendingPaymentOrder() {
    const order = await insertOrder({
        region: "eg",
        restaurantId: 10,
        restaurantOwnerId: OWNER.userId,
        status: OrderStatus.PENDING_PAYMENT,
        paymentMethod: PaymentMethod.ONLINE,
        total: 1500,
        currency: "EGP" as never,
    });
    const conn = db("eg");
    const session = await createSession(
        {
            region: "eg",
            orderId: order.id,
            providerId: PAYMENT_PROVIDER_IDS[PaymentProviderName.KASHIER],
            providerSessionId: "kashier-sess-1",
            redirectUrl: "https://checkout.kashier.io/kashier-sess-1",
            amount: order.total,
            currency: order.currency,
            status: PaymentSessionStatus.INITIALIZED,
            rawInitPayload: {},
        },
        conn,
    );
    return {order, session};
}

function webhookBody(overrides: Partial<Record<string, unknown>> = {}, event: string = "pay") {
    return {
        event,
        data: {
            merchantOrderId: overrides.merchantOrderId,
            kashierOrderId: "kashier-order-1",
            transactionId: overrides.transactionId ?? "txn-1",
            status: overrides.status ?? "SUCCESS",
            amount: overrides.amount ?? 15,
            currency: "EGP",
            signatureKeys: ["amount", "currency", "merchantOrderId", "transactionId"],
            ...overrides,
        },
    };
}

describe("POST /api/payments/webhook/kashier", () => {
    it("flips a pending_payment order to placed on a successful capture and records the charge", async () => {
        const {order} = await seedPendingPaymentOrder();
        kashierProviderStub.nextVerifyWebhookResult = true;

        const res = await request(app)
            .post("/api/payments/webhook/kashier?region=eg")
            .set("x-kashier-signature", "any-signature")
            .send(webhookBody({merchantOrderId: order.publicId}));

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);

        const updatedOrder = await db("eg")("orders").where({public_id: order.publicId}).first();
        expect(updatedOrder.status).toBe(OrderStatus.PLACED);

        const txs = await db("eg")("transactions").where({order_id: order.id});
        expect(txs).toHaveLength(1);
        expect(txs[0].status).toBe(TransactionStatus.SUCCEEDED);
        expect(txs[0].transaction_type).toBe(TransactionType.CHARGE);

        const session = await db("eg")("payment_sessions").where({order_id: order.id}).first();
        expect(session.status).toBe(PaymentSessionStatus.CAPTURED);

        const outboxTypes = (await db("eg")("events_outbox").where({aggregate_id: order.publicId})).map((r: {event_type: string}) => r.event_type);
        expect(outboxTypes).toEqual(expect.arrayContaining(["payment.completed", "order.placed"]));

        expect(fakeIoServer.emitted.some((e) => e.event === "order.created" && e.room === `branch:${order.branchId}`)).toBe(true);
        expect(fakeIoServer.emitted.some((e) => e.event === "order.status_changed" && e.room === `customer:${order.customerId}`)).toBe(true);
    });

    it("records a failed charge and leaves the order in pending_payment on a FAILED capture", async () => {
        const {order} = await seedPendingPaymentOrder();
        kashierProviderStub.nextVerifyWebhookResult = true;

        const res = await request(app)
            .post("/api/payments/webhook/kashier?region=eg")
            .set("x-kashier-signature", "any-signature")
            .send(webhookBody({merchantOrderId: order.publicId, status: "FAILED", transactionId: "txn-failed-1"}));

        expect(res.status).toBe(200);

        const updatedOrder = await db("eg")("orders").where({public_id: order.publicId}).first();
        expect(updatedOrder.status).toBe(OrderStatus.PENDING_PAYMENT);

        const txs = await db("eg")("transactions").where({order_id: order.id});
        expect(txs).toHaveLength(1);
        expect(txs[0].status).toBe(TransactionStatus.FAILED);
    });

    it("rejects a webhook with an invalid signature", async () => {
        const {order} = await seedPendingPaymentOrder();
        kashierProviderStub.nextVerifyWebhookResult = false;

        const res = await request(app)
            .post("/api/payments/webhook/kashier?region=eg")
            .set("x-kashier-signature", "forged")
            .send(webhookBody({merchantOrderId: order.publicId}));

        expect(res.status).toBe(401);
        const updatedOrder = await db("eg")("orders").where({public_id: order.publicId}).first();
        expect(updatedOrder.status).toBe(OrderStatus.PENDING_PAYMENT);
    });

    it("rejects a webhook with no signature header", async () => {
        const {order} = await seedPendingPaymentOrder();
        const res = await request(app)
            .post("/api/payments/webhook/kashier?region=eg")
            .send(webhookBody({merchantOrderId: order.publicId}));
        expect(res.status).toBe(401);
    });

    it("rejects a request with no body at all (no rawBody captured) before ever checking the signature", async () => {
        // No `.send(...)` and no JSON content-type -> express.json()'s verify
        // callback never runs, so `req.rawBody` is never set at all (distinct
        // from an empty-but-present JSON body, which errorHandler's
        // SyntaxError branch — error-handling.integration.test.ts — covers).
        const res = await request(app).post("/api/payments/webhook/kashier?region=eg").set("x-kashier-signature", "sig");
        expect(res.status).toBe(400);
        expect(res.body.error).toBe("MalformedWebhook");
    });

    it("rejects a malformed payload (missing required webhook fields)", async () => {
        const res = await request(app)
            .post("/api/payments/webhook/kashier?region=eg")
            .set("x-kashier-signature", "any-signature")
            .send({event: "pay", data: {}});
        expect(res.status).toBe(400);
    });

    it("requires a concrete region", async () => {
        const res = await request(app)
            .post("/api/payments/webhook/kashier")
            .set("x-kashier-signature", "any-signature")
            .send(webhookBody({merchantOrderId: "11111111-1111-1111-1111-111111111111"}));
        expect(res.status).toBe(400);
    });

    it("is idempotent under a replayed webhook with the same transactionId (processed once)", async () => {
        const {order} = await seedPendingPaymentOrder();
        kashierProviderStub.nextVerifyWebhookResult = true;
        const body = webhookBody({merchantOrderId: order.publicId, transactionId: "txn-replay-1"});

        const first = await request(app).post("/api/payments/webhook/kashier?region=eg").set("x-kashier-signature", "sig").send(body);
        expect(first.status).toBe(200);

        const second = await request(app).post("/api/payments/webhook/kashier?region=eg").set("x-kashier-signature", "sig").send(body);
        expect(second.status).toBe(200);

        const txs = await db("eg")("transactions").where({order_id: order.id});
        expect(txs).toHaveLength(1); // not double-charged

        const outboxRows = await db("eg")("events_outbox").where({aggregate_id: order.publicId, event_type: "payment.completed"});
        expect(outboxRows).toHaveLength(1); // not double-published

        const webhookEvents = await db("eg")("payment_webhook_events").where({provider_event_id: "txn-replay-1"});
        expect(webhookEvents).toHaveLength(1);
    });
});

describe("GET /api/restaurants/:restaurantId/payments/:paymentId", () => {
    async function seedChargeTransaction(restaurantId: number, restaurantOwnerId: number) {
        const order = await insertOrder({region: "eg", restaurantId, restaurantOwnerId});
        const conn = db("eg");
        const tx = await createTransaction(
            {
                region: "eg",
                orderId: order.id,
                transactionType: TransactionType.CHARGE,
                method: TransactionMethod.ONLINE,
                providerId: PAYMENT_PROVIDER_IDS[PaymentProviderName.KASHIER],
                providerReferenceId: "txn-ref-1",
                status: TransactionStatus.SUCCEEDED,
                amount: order.total,
                currency: order.currency,
                srcAccId: order.customerId,
                dstAccId: order.restaurantOwnerId,
                idempotencyKey: null,
            },
            conn,
        );
        return {order, tx};
    }

    it("lets a restaurant member with payments:read view a payment on their own restaurant", async () => {
        coreClientStub.seedPermissions("owner", ["payments:read"]);
        const {tx} = await seedChargeTransaction(10, OWNER.userId);
        const res = await request(app)
            .get(`/api/restaurants/10/payments/${tx.id}`)
            .set("X-Region", "eg")
            .set(authHeader(OWNER));
        expect(res.status).toBe(200);
        expect(res.body.data.id).toBe(tx.id);
    });

    it("returns 403 when the payment does not actually belong to the caller's restaurant", async () => {
        coreClientStub.seedPermissions("owner", ["payments:read"]);
        const {tx} = await seedChargeTransaction(10, OWNER.userId); // belongs to restaurant 10

        const res = await request(app)
            .get(`/api/restaurants/11/payments/${tx.id}`) // OTHER_OWNER is a member of restaurant 11
            .set("X-Region", "eg")
            .set(authHeader(OTHER_OWNER));
        expect(res.status).toBe(403);
    });

    it("returns 404 for a nonexistent payment id", async () => {
        coreClientStub.seedPermissions("owner", ["payments:read"]);
        const res = await request(app).get("/api/restaurants/10/payments/999999").set("X-Region", "eg").set(authHeader(OWNER));
        expect(res.status).toBe(404);
    });

    it("returns 400 for a non-numeric payment id", async () => {
        coreClientStub.seedPermissions("owner", ["payments:read"]);
        const res = await request(app).get("/api/restaurants/10/payments/not-a-number").set("X-Region", "eg").set(authHeader(OWNER));
        expect(res.status).toBe(400);
    });

    it("lets system_admin view any payment regardless of restaurant membership", async () => {
        const {tx} = await seedChargeTransaction(10, OWNER.userId);
        const res = await request(app).get(`/api/restaurants/10/payments/${tx.id}`).set("X-Region", "eg").set(authHeader(ADMIN));
        expect(res.status).toBe(200);
    });
});

describe("kashier-webhook.service.ts reconcile()'s no-op branches", () => {
    it("acks and ignores a non-'pay' event (e.g. 'refund') without touching the order", async () => {
        const {order} = await seedPendingPaymentOrder();
        kashierProviderStub.nextVerifyWebhookResult = true;

        const res = await request(app)
            .post("/api/payments/webhook/kashier?region=eg")
            .set("x-kashier-signature", "sig")
            .send(webhookBody({merchantOrderId: order.publicId}, "refund"));
        expect(res.status).toBe(200);

        const updatedOrder = await db("eg")("orders").where({public_id: order.publicId}).first();
        expect(updatedOrder.status).toBe(OrderStatus.PENDING_PAYMENT);
        expect(await db("eg")("transactions").where({order_id: order.id})).toHaveLength(0);
    });

    it("acks and ignores a webhook for a merchantOrderId that doesn't match any order", async () => {
        kashierProviderStub.nextVerifyWebhookResult = true;
        const res = await request(app)
            .post("/api/payments/webhook/kashier?region=eg")
            .set("x-kashier-signature", "sig")
            .send(webhookBody({merchantOrderId: "99999999-9999-9999-9999-999999999999"}));
        expect(res.status).toBe(200);
    });

    it("acks and ignores a webhook for an order with no active payment session", async () => {
        const order = await insertOrder({region: "eg", status: OrderStatus.PENDING_PAYMENT, paymentMethod: PaymentMethod.ONLINE});
        kashierProviderStub.nextVerifyWebhookResult = true;
        const res = await request(app)
            .post("/api/payments/webhook/kashier?region=eg")
            .set("x-kashier-signature", "sig")
            .send(webhookBody({merchantOrderId: order.publicId}));
        expect(res.status).toBe(200);
        expect(await db("eg")("transactions").where({order_id: order.id})).toHaveLength(0);
    });

    it("books the CHARGE without re-firing order.placed when a SUCCESS webhook resolves against an order that isn't pending_payment", async () => {
        // Contrived-but-real branch: reconcile() finds an active (initialized)
        // session AND an order not in pending_payment. Constructed directly
        // rather than through two webhook calls, because a real successful
        // webhook always flips its own session out of "active" (to captured)
        // as part of the same reconciliation — so two webhooks in sequence
        // can never land here; only a *second, independent* active session
        // against an already-placed order can.
        const order = await insertOrder({region: "eg", status: OrderStatus.PLACED, paymentMethod: PaymentMethod.ONLINE, total: 1250});
        await createSession(
            {
                region: "eg",
                orderId: order.id,
                providerId: PAYMENT_PROVIDER_IDS[PaymentProviderName.KASHIER],
                providerSessionId: "kashier-second-sess",
                redirectUrl: "https://checkout.kashier.io/kashier-second-sess",
                amount: order.total,
                currency: order.currency,
                status: PaymentSessionStatus.INITIALIZED,
                rawInitPayload: {},
            },
            db("eg"),
        );
        kashierProviderStub.nextVerifyWebhookResult = true;

        const res = await request(app)
            .post("/api/payments/webhook/kashier?region=eg")
            .set("x-kashier-signature", "sig")
            .send(webhookBody({merchantOrderId: order.publicId, transactionId: "txn-late-charge"}));
        expect(res.status).toBe(200);

        const charges = await db("eg")("transactions").where({order_id: order.id, transaction_type: TransactionType.CHARGE});
        expect(charges).toHaveLength(1);

        const placedEvents = await db("eg")("events_outbox").where({aggregate_id: order.publicId, event_type: "order.placed"});
        expect(placedEvents).toHaveLength(0); // order was already placed — reconcile() never re-fires it
    });
});

describe("PaymentService.initOnlinePayment — existing-session idempotency", () => {
    it("returns the existing active session's DTO instead of creating a second Kashier session", async () => {
        const order = await insertOrder({region: "eg", status: OrderStatus.PENDING_PAYMENT, paymentMethod: PaymentMethod.ONLINE, total: 1250});
        const conn = db("eg");
        const existingSession = await createSession(
            {
                region: "eg",
                orderId: order.id,
                providerId: PAYMENT_PROVIDER_IDS[PaymentProviderName.KASHIER],
                providerSessionId: "kashier-existing-sess",
                redirectUrl: "https://checkout.kashier.io/kashier-existing-sess",
                amount: order.total,
                currency: order.currency,
                status: PaymentSessionStatus.INITIALIZED,
                rawInitPayload: {},
            },
            conn,
        );

        const paymentService = container.resolve<PaymentService>(TOKENS.PaymentService);
        const result = await paymentService.initOnlinePayment(order);

        expect(result.session.id).toBe(existingSession.id);
        expect(result.dto.providerSessionId).toBe("kashier-existing-sess");
        expect(kashierProviderStub.sessionsCreated).toHaveLength(0); // no new Kashier session minted
    });
});
