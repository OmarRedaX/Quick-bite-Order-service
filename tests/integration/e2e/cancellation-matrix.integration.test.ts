import request from "supertest";
import {buildTestApp, coreClientStub, resetTestDoubles} from "../support/app";
import {truncateAllRegions} from "../../helpers/db";
import {flushTestCache} from "../../helpers/redis";
import {authHeader, insertOrder} from "../../helpers/fixtures";
import {OrderStatus} from "../../../src/app/order/enums";
import {RESTAURANT_ID, BRANCH_ID, MANAGER, CUSTOMER, ADMIN, seedAll, makeIdemKeyGenerator} from "../support/scenario";
import {db} from "../../../src/lib/knex/knex";

/** Seeds one order_item row so a release-stock call has real items to carry. */
async function seedOrderItem(region: string, orderId: number) {
    await db(region)("order_items").insert({
        region,
        order_id: orderId,
        product_id: 1,
        quantity: 2,
        unit_price_snapshot: 500,
        name_snapshot: "Burger",
        image_url_snapshot: null,
        line_total: 1000,
    });
}

function findReleaseStockCall() {
    return coreClientStub.calls.find((c) => c.path.includes("release-stock"));
}

const idemKey = makeIdemKeyGenerator("e2e-cancellation");

const app = buildTestApp();

beforeEach(async () => {
    await truncateAllRegions(["eg", "ksa"]);
    await flushTestCache();
    resetTestDoubles();
    seedAll();
});

describe("Cancellation matrix (e2e)", () => {
    it("customer cancels within the deadline -> 200 cancelled and releases the reserved stock", async () => {
        const order = await insertOrder({region: "eg", customerId: CUSTOMER.userId, restaurantId: RESTAURANT_ID, branchId: BRANCH_ID, status: OrderStatus.PLACED});
        await seedOrderItem("eg", order.id);

        const res = await request(app)
            .patch(`/api/customer/orders/${order.publicId}/status`)
            .set("X-Region", "eg")
            .set("Idempotency-Key", idemKey())
            .set(authHeader(CUSTOMER))
            .send({status: OrderStatus.CANCELLED, reason: "changed my mind"});
        expect(res.status).toBe(200);
        expect(res.body.data.status).toBe(OrderStatus.CANCELLED);

        // `placed` never reached the kitchen (cooking hasn't started), so the
        // stock reserved at placement must be released back to core-service.
        const releaseCall = findReleaseStockCall();
        expect(releaseCall).toBeDefined();
        expect(releaseCall!.path).toBe(`/api/internal/branches/${BRANCH_ID}/release-stock`);
        expect(releaseCall!.idempotencyKey).toBe(order.publicId);
        expect((releaseCall!.body as {items: Array<{productId: number; quantity: number}>}).items).toEqual([
            {productId: 1, quantity: 2},
        ]);
    });

    it("customer cancellation past the deadline -> 409", async () => {
        const order = await insertOrder({
            region: "eg",
            customerId: CUSTOMER.userId,
            status: OrderStatus.PLACED,
            createdAt: new Date(Date.now() - 5 * 60_000),
        });
        const res = await request(app)
            .patch(`/api/customer/orders/${order.publicId}/status`)
            .set("X-Region", "eg")
            .set("Idempotency-Key", idemKey())
            .set(authHeader(CUSTOMER))
            .send({status: OrderStatus.CANCELLED, reason: "too late"});
        expect(res.status).toBe(409);
        expect(res.body.error).toBe("CancellationWindowExpired");
    });

    it("restaurant cancels at preparing (with a reason) -> 200, and does NOT release stock (cooking already started)", async () => {
        const order = await insertOrder({region: "eg", restaurantId: RESTAURANT_ID, branchId: BRANCH_ID, status: OrderStatus.PREPARING, acceptedAt: new Date()});
        await seedOrderItem("eg", order.id);

        const res = await request(app)
            .patch(`/api/restaurants/${RESTAURANT_ID}/branches/${BRANCH_ID}/orders/${order.publicId}/status`)
            .set("X-Region", "eg")
            .set("Idempotency-Key", idemKey())
            .set(authHeader(MANAGER))
            .send({status: OrderStatus.CANCELLED, reason: "kitchen equipment failure"});
        expect(res.status).toBe(200);
        expect(res.body.data.status).toBe(OrderStatus.CANCELLED);

        // Regression guard for the from-status boundary: `preparing` means
        // active cooking, so the reserved stock is already spent — it must
        // NOT be released back, unlike a cancellation from an earlier stage.
        expect(findReleaseStockCall()).toBeUndefined();
    });

    it("restaurant rejects at placed (with a reason) -> 200, and releases the reserved stock", async () => {
        const order = await insertOrder({region: "eg", restaurantId: RESTAURANT_ID, branchId: BRANCH_ID, status: OrderStatus.PLACED});
        await seedOrderItem("eg", order.id);

        const res = await request(app)
            .patch(`/api/restaurants/${RESTAURANT_ID}/branches/${BRANCH_ID}/orders/${order.publicId}/status`)
            .set("X-Region", "eg")
            .set("Idempotency-Key", idemKey())
            .set(authHeader(MANAGER))
            .send({status: OrderStatus.REJECTED, reason: "out of stock"});
        expect(res.status).toBe(200);
        expect(res.body.data.status).toBe(OrderStatus.REJECTED);

        // `rejected` only happens from `placed` — before cooking starts — so
        // this is also a release-eligible transition, same as `cancelled`.
        expect(findReleaseStockCall()).toBeDefined();
    });

    it.each([
        [OrderStatus.PLACED, undefined, true],
        [OrderStatus.ACCEPTED, "accepted_at" as const, true],
        [OrderStatus.PREPARING, "accepted_at" as const, false],
        [OrderStatus.READY, "accepted_at" as const, false],
        [OrderStatus.ASSIGNED, "assigned_at" as const, false],
    ])("admin can override-cancel at %s (any non-delivered stage), releasing stock only if from-status is %s", async (status, stampField, shouldRelease) => {
        const order = await insertOrder({
            region: "eg",
            branchId: BRANCH_ID,
            status,
            acceptedAt: stampField === "accepted_at" ? new Date() : null,
            assignedAt: stampField === "assigned_at" ? new Date() : null,
        });
        await seedOrderItem("eg", order.id);

        const res = await request(app)
            .patch(`/api/admin/orders/${order.publicId}/status`)
            .set("X-Region", "eg")
            .set("Idempotency-Key", idemKey())
            .set(authHeader(ADMIN))
            .send({status: OrderStatus.CANCELLED, reason: "admin override"});
        expect(res.status).toBe(200);
        expect(res.body.data.status).toBe(OrderStatus.CANCELLED);

        // Admin cancellation follows the same from-status rule as any other
        // actor — release eligibility is governed by the order's prior
        // status (pre-kitchen), not by who triggered the transition.
        if (shouldRelease) {
            expect(findReleaseStockCall()).toBeDefined();
        } else {
            expect(findReleaseStockCall()).toBeUndefined();
        }
    });

    it("admin cannot cancel an already-delivered order (terminal state)", async () => {
        const order = await insertOrder({region: "eg", status: OrderStatus.DELIVERED, deliveredAt: new Date()});
        const res = await request(app)
            .patch(`/api/admin/orders/${order.publicId}/status`)
            .set("X-Region", "eg")
            .set("Idempotency-Key", idemKey())
            .set(authHeader(ADMIN))
            .send({status: OrderStatus.CANCELLED, reason: "admin override"});
        expect(res.status).toBe(409);
    });
});
