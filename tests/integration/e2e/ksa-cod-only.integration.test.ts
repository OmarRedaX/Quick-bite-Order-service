import request from "supertest";
import {buildTestApp, coreClientStub, resetTestDoubles} from "../support/app";
import {truncateAllRegions} from "../../helpers/db";
import {flushTestCache} from "../../helpers/redis";
import {authHeader} from "../../helpers/fixtures";
import {db} from "../../../src/lib/knex/knex";
import {container} from "../../../src/lib/di/container";
import {TOKENS} from "../../../src/lib/di/tokens";
import {AssignmentService} from "../../../src/app/assignment/service/assignment.service";
import {OrderStatus, PaymentMethod} from "../../../src/app/order/enums";
import {TransactionType} from "../../../src/app/payment/enums";
import {BRANCH_ID, RESTAURANT_ID, ADDRESS_ID, MANAGER, CUSTOMER, AGENT, makeIdemKeyGenerator} from "../support/scenario";

const app = buildTestApp();
const idemKey = makeIdemKeyGenerator("e2e-ksa-cod");

// ONLINE_PAYMENT_REGIONS=eg in .env.test — ksa has no payment_providers row
// either (see 20260506000010_create_payment_providers.ts's per-region seed:
// only "eg" gets a Kashier row), so this is enforced at two independent
// layers; this suite exercises the app-level env gate order.service.ts checks
// before ever touching the payment_providers table.
function seedKsaBranch() {
    coreClientStub.seedBranch(BRANCH_ID, {
        id: BRANCH_ID,
        restaurantId: RESTAURANT_ID,
        restaurantOwnerId: 601,
        restaurantStatus: "active",
        region: "KSA",
        isActive: true,
        acceptOrders: true,
        deliveryFee: 300,
        commissionBps: 1000,
        currency: "SAR",
        lat: 24.7,
        lng: 46.7,
        name: "Riyadh Branch",
        addressText: "1 Branch St",
    });
    coreClientStub.seedAddress(ADDRESS_ID, {
        id: ADDRESS_ID,
        userId: CUSTOMER.userId,
        label: "Home",
        country: "Saudi Arabia",
        city: "Riyadh",
        street: "King Fahd Rd",
        building: "5",
        apartmentNumber: "3",
        lat: 24.71,
        lng: 46.71,
    });
    coreClientStub.seedBranchProduct(BRANCH_ID, 1, {productId: 1, name: "Shawarma", imageUrl: null, price: 500, stock: 10, isAvailable: true});
    coreClientStub.seedPermissions("branch_manager", ["orders:accept", "orders:reject", "orders:cancel", "orders:update"]);
}

beforeEach(async () => {
    await truncateAllRegions(["eg", "ksa"]);
    await flushTestCache();
    resetTestDoubles();
    seedKsaBranch();
});

describe("KSA COD-only enforcement (e2e)", () => {
    it("rejects ONLINE payment with 409, reserving no stock", async () => {
        const res = await request(app)
            .post("/api/orders")
            .set("X-Region", "ksa")
            .set("Idempotency-Key", idemKey())
            .set(authHeader(CUSTOMER))
            .send({branchId: BRANCH_ID, customerAddressId: ADDRESS_ID, paymentMethod: PaymentMethod.ONLINE, items: [{productId: 1, quantity: 1}]});
        expect(res.status).toBe(409);
        expect(res.body.error).toBe("OnlinePaymentNotAvailableInRegion");
        expect(coreClientStub.calls.some((c) => c.path.includes("reserve-stock"))).toBe(false);
    });

    it("carries a COD order through the full lifecycle to delivery and settlement in ksa", async () => {
        const placed = await request(app)
            .post("/api/orders")
            .set("X-Region", "ksa")
            .set("Idempotency-Key", idemKey())
            .set(authHeader(CUSTOMER))
            .send({branchId: BRANCH_ID, customerAddressId: ADDRESS_ID, paymentMethod: PaymentMethod.COD, items: [{productId: 1, quantity: 1}]});
        expect(placed.status).toBe(201);
        const publicId = placed.body.data.publicId;

        const restaurantPath = (suffix: string) => `/api/restaurants/${RESTAURANT_ID}/branches/${BRANCH_ID}/orders/${publicId}${suffix}`;
        for (const status of [OrderStatus.ACCEPTED, OrderStatus.PREPARING, OrderStatus.READY]) {
            const res = await request(app)
                .patch(restaurantPath("/status"))
                .set("X-Region", "ksa")
                .set("Idempotency-Key", idemKey())
                .set(authHeader(MANAGER))
                .send({status});
            expect(res.status).toBe(200);
        }

        await request(app).post("/api/agents/presence/online").set("X-Region", "ksa").set(authHeader(AGENT)).send({lat: 24.7, lng: 46.7});
        const assignmentService = container.resolve<AssignmentService>(TOKENS.AssignmentService);
        await assignmentService.tickRegion("ksa");

        await request(app).post(`/api/agents/orders/${publicId}/accept`).set("X-Region", "ksa").set("Idempotency-Key", idemKey()).set(authHeader(AGENT));
        await request(app).patch(`/api/agents/orders/${publicId}/status`).set("X-Region", "ksa").set("Idempotency-Key", idemKey()).set(authHeader(AGENT)).send({status: "picked"});
        const delivered = await request(app)
            .patch(`/api/agents/orders/${publicId}/status`)
            .set("X-Region", "ksa")
            .set("Idempotency-Key", idemKey())
            .set(authHeader(AGENT))
            .send({status: "delivered"});
        expect(delivered.status).toBe(200);

        const finalOrder = await db("ksa")("orders").where({public_id: publicId}).first();
        expect(finalOrder.status).toBe(OrderStatus.DELIVERED);

        const txTypes = (await db("ksa")("transactions").where({order_id: finalOrder.id})).map((t: {transaction_type: string}) => t.transaction_type);
        expect(txTypes).toContain(TransactionType.COD_COLLECTION);

        const balance = await db("ksa")("restaurant_balances").where({restaurant_id: RESTAURANT_ID, currency: "SAR"}).first();
        expect(Number(balance.balance)).toBeGreaterThan(0);
    });
});
