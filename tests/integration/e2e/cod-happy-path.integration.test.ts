import request from "supertest";
import {buildTestApp, resetTestDoubles} from "../support/app";
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

const idemKey = makeIdemKeyGenerator("e2e-cod");

const app = buildTestApp();

beforeEach(async () => {
    await truncateAllRegions(["eg", "ksa"]);
    await flushTestCache();
    resetTestDoubles();
});

/**
 * Full COD lifecycle, driven end to end through the real HTTP surface (and,
 * for assignment, the real tick function — same interface the assignment-tick
 * cron job calls in production; see AssignmentService.tickRegion): place ->
 * restaurant accept/preparing/ready -> agent online -> tick offers it ->
 * agent accepts -> picks up -> delivers -> settlement lands.
 */
describe("COD happy path (e2e)", () => {
    it("carries one order through its entire lifecycle with correct totals and settlement at the end", async () => {
        seedAll();

        const placed = await request(app)
            .post("/api/orders")
            .set("X-Region", "eg")
            .set("Idempotency-Key", idemKey())
            .set(authHeader(CUSTOMER))
            .send({branchId: BRANCH_ID, customerAddressId: ADDRESS_ID, paymentMethod: PaymentMethod.COD, items: [{productId: 1, quantity: 2}]});
        expect(placed.status).toBe(201);
        const publicId = placed.body.data.publicId;
        expect(placed.body.data.total).toBe(2300); // subtotal(1000) + deliveryFee(300) + serviceFee(1000)

        const restaurantPath = (suffix: string) => `/api/restaurants/${RESTAURANT_ID}/branches/${BRANCH_ID}/orders/${publicId}${suffix}`;

        const accepted = await request(app)
            .patch(restaurantPath("/status"))
            .set("X-Region", "eg")
            .set("Idempotency-Key", idemKey())
            .set(authHeader(MANAGER))
            .send({status: OrderStatus.ACCEPTED});
        expect(accepted.status).toBe(200);

        const preparing = await request(app)
            .patch(restaurantPath("/status"))
            .set("X-Region", "eg")
            .set("Idempotency-Key", idemKey())
            .set(authHeader(MANAGER))
            .send({status: OrderStatus.PREPARING});
        expect(preparing.status).toBe(200);

        const ready = await request(app)
            .patch(restaurantPath("/status"))
            .set("X-Region", "eg")
            .set("Idempotency-Key", idemKey())
            .set(authHeader(MANAGER))
            .send({status: OrderStatus.READY});
        expect(ready.status).toBe(200);

        const online = await request(app)
            .post("/api/agents/presence/online")
            .set("X-Region", "eg")
            .set(authHeader(AGENT))
            .send({lat: 30.05, lng: 31.24});
        expect(online.status).toBe(200);

        // Same call the assignment-tick cron job makes in production.
        const assignmentService = container.resolve<AssignmentService>(TOKENS.AssignmentService);
        const tick = await assignmentService.tickRegion("eg");
        expect(tick.offered).toBe(1);

        const accept = await request(app)
            .post(`/api/agents/orders/${publicId}/accept`)
            .set("X-Region", "eg")
            .set("Idempotency-Key", idemKey())
            .set(authHeader(AGENT));
        expect(accept.status).toBe(200);

        const picked = await request(app)
            .patch(`/api/agents/orders/${publicId}/status`)
            .set("X-Region", "eg")
            .set("Idempotency-Key", idemKey())
            .set(authHeader(AGENT))
            .send({status: "picked"});
        expect(picked.status).toBe(200);

        const delivered = await request(app)
            .patch(`/api/agents/orders/${publicId}/status`)
            .set("X-Region", "eg")
            .set("Idempotency-Key", idemKey())
            .set(authHeader(AGENT))
            .send({status: "delivered"});
        expect(delivered.status).toBe(200);

        const finalOrder = await db("eg")("orders").where({public_id: publicId}).first();
        expect(finalOrder.status).toBe(OrderStatus.DELIVERED);
        expect(Number(finalOrder.commission)).toBe(100); // floor(1000 * 1000bps / 10000)

        const txs: Array<{transaction_type: string; amount: number; status: string}> = await db("eg")("transactions").where({order_id: finalOrder.id});
        const byType = new Map(txs.map((t) => [t.transaction_type, t]));
        expect(byType.get(TransactionType.COD_COLLECTION)?.status).toBe(TransactionStatus.SUCCEEDED);
        expect(byType.get(TransactionType.COD_COLLECTION)?.amount).toBe(2300);
        expect(byType.get(TransactionType.COMMISSION)?.amount).toBe(100);
        expect(byType.get(TransactionType.SERVICE_FEE)?.amount).toBe(1000);
        expect(byType.get(TransactionType.DELIVERY_FEE)?.amount).toBe(300);

        const balance = await db("eg")("restaurant_balances").where({restaurant_id: RESTAURANT_ID, currency: "EGP"}).first();
        expect(Number(balance.balance)).toBe(1000 - 100); // subtotal - commission

        const earning = await db("eg")("agent_earnings").where({order_id: finalOrder.id}).first();
        expect(Number(earning.amount)).toBe(240); // 80% of the 300 delivery fee
    });
});
