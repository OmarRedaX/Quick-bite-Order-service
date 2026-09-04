import request from "supertest";
import {buildTestApp, kashierProviderStub, resetTestDoubles} from "../support/app";
import {truncateAllRegions} from "../../helpers/db";
import {flushTestCache} from "../../helpers/redis";
import {authHeader} from "../../helpers/fixtures";
import {db} from "../../../src/lib/knex/knex";
import {container} from "../../../src/lib/di/container";
import {TOKENS} from "../../../src/lib/di/tokens";
import {AssignmentService} from "../../../src/app/assignment/service/assignment.service";
import {OrderStatus, PaymentMethod} from "../../../src/app/order/enums";
import {TransactionType, TransactionStatus} from "../../../src/app/payment/enums";
import {BRANCH_ID, RESTAURANT_ID, ADDRESS_ID, MANAGER, CUSTOMER, AGENT, seedAll, makeIdemKeyGenerator} from "../support/scenario";

const idemKey = makeIdemKeyGenerator("e2e-online-kashier");

const app = buildTestApp();

beforeEach(async () => {
    await truncateAllRegions(["eg", "ksa"]);
    await flushTestCache();
    resetTestDoubles();
});

/**
 * ONLINE/Kashier lifecycle: place (pending_payment, session created via the
 * stub) -> simulated successful webhook flips it to placed and books the
 * charge -> same restaurant/agent lifecycle as the COD path from `placed`
 * onward, ending in the same settlement shape (minus cod_collection, since
 * the customer already paid online).
 */
describe("ONLINE/Kashier happy path (e2e)", () => {
    it("creates a payment session at placement, then a successful webhook advances it through delivery", async () => {
        seedAll();

        const placed = await request(app)
            .post("/api/orders")
            .set("X-Region", "eg")
            .set("Idempotency-Key", idemKey())
            .set(authHeader(CUSTOMER))
            .send({branchId: BRANCH_ID, customerAddressId: ADDRESS_ID, paymentMethod: PaymentMethod.ONLINE, items: [{productId: 1, quantity: 2}]});
        expect(placed.status).toBe(201);
        expect(placed.body.data.status).toBe(OrderStatus.PENDING_PAYMENT);
        expect(placed.body.data.payment.redirectUrl).toBeTruthy();
        const publicId = placed.body.data.publicId;
        expect(kashierProviderStub.sessionsCreated).toHaveLength(1);

        kashierProviderStub.nextVerifyWebhookResult = true;
        const webhook = await request(app)
            .post("/api/payments/webhook/kashier?region=eg")
            .set("x-kashier-signature", "sig")
            .send({
                event: "pay",
                data: {
                    merchantOrderId: publicId,
                    kashierOrderId: "kashier-order-e2e-1",
                    transactionId: "txn-e2e-1",
                    status: "SUCCESS",
                    amount: 23,
                    currency: "EGP",
                    signatureKeys: ["amount", "currency", "merchantOrderId", "transactionId"],
                },
            });
        expect(webhook.status).toBe(200);

        const afterWebhook = await db("eg")("orders").where({public_id: publicId}).first();
        expect(afterWebhook.status).toBe(OrderStatus.PLACED);

        const restaurantPath = (suffix: string) => `/api/restaurants/${RESTAURANT_ID}/branches/${BRANCH_ID}/orders/${publicId}${suffix}`;
        for (const status of [OrderStatus.ACCEPTED, OrderStatus.PREPARING, OrderStatus.READY]) {
            const res = await request(app)
                .patch(restaurantPath("/status"))
                .set("X-Region", "eg")
                .set("Idempotency-Key", idemKey())
                .set(authHeader(MANAGER))
                .send({status});
            expect(res.status).toBe(200);
        }

        await request(app).post("/api/agents/presence/online").set("X-Region", "eg").set(authHeader(AGENT)).send({lat: 30.05, lng: 31.24});
        const assignmentService = container.resolve<AssignmentService>(TOKENS.AssignmentService);
        await assignmentService.tickRegion("eg");

        await request(app).post(`/api/agents/orders/${publicId}/accept`).set("X-Region", "eg").set("Idempotency-Key", idemKey()).set(authHeader(AGENT));
        await request(app).patch(`/api/agents/orders/${publicId}/status`).set("X-Region", "eg").set("Idempotency-Key", idemKey()).set(authHeader(AGENT)).send({status: "picked"});
        const delivered = await request(app)
            .patch(`/api/agents/orders/${publicId}/status`)
            .set("X-Region", "eg")
            .set("Idempotency-Key", idemKey())
            .set(authHeader(AGENT))
            .send({status: "delivered"});
        expect(delivered.status).toBe(200);

        const finalOrder = await db("eg")("orders").where({public_id: publicId}).first();
        expect(finalOrder.status).toBe(OrderStatus.DELIVERED);

        const txs: Array<{transaction_type: string; status: string}> = await db("eg")("transactions").where({order_id: finalOrder.id});
        const types = txs.map((t) => t.transaction_type);
        expect(types).toContain(TransactionType.CHARGE); // from the webhook
        expect(types).not.toContain(TransactionType.COD_COLLECTION); // customer already paid online
        expect(types).toEqual(expect.arrayContaining([TransactionType.COMMISSION, TransactionType.SERVICE_FEE, TransactionType.DELIVERY_FEE]));

        const charge = txs.find((t) => t.transaction_type === TransactionType.CHARGE)!;
        expect(charge.status).toBe(TransactionStatus.SUCCEEDED);

        const balance = await db("eg")("restaurant_balances").where({restaurant_id: RESTAURANT_ID, currency: "EGP"}).first();
        expect(Number(balance.balance)).toBe(1000 - 100); // subtotal - commission, same math as the COD path

        const earning = await db("eg")("agent_earnings").where({order_id: finalOrder.id}).first();
        expect(Number(earning.amount)).toBe(240);
    });
});
