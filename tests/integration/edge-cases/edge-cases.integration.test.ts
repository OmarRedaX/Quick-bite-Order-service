import request from "supertest";
import {buildTestApp, coreClientStub, resetTestDoubles} from "../support/app";
import {CUSTOMER, MANAGER, makeIdemKeyGenerator} from "../support/scenario";
import {truncateAllRegions} from "../../helpers/db";
import {flushTestCache} from "../../helpers/redis";
import {authHeader, insertOrder} from "../../helpers/fixtures";
import {db} from "../../../src/lib/knex/knex";
import {coreServiceUnavailableError} from "../../../src/lib/core-client/errors";
import {OrderStatus} from "../../../src/app/order/enums";

const app = buildTestApp();

const idemKey = makeIdemKeyGenerator("edge");

beforeEach(async () => {
    await truncateAllRegions(["eg", "ksa"]);
    await flushTestCache();
    resetTestDoubles();
});

describe("wrong-region id access", () => {
    it("querying an eg order's publicId under X-Region: ksa returns 404, not a cross-shard leak", async () => {
        const order = await insertOrder({region: "eg", customerId: CUSTOMER.userId});

        const wrongRegion = await request(app).get(`/api/orders/${order.publicId}`).set("X-Region", "ksa").set(authHeader(CUSTOMER));
        expect(wrongRegion.status).toBe(404);

        const rightRegion = await request(app).get(`/api/orders/${order.publicId}`).set("X-Region", "eg").set(authHeader(CUSTOMER));
        expect(rightRegion.status).toBe(200);
    });
});

describe("core-service unavailable mid-flow", () => {
    it("surfaces CoreClient's 503 contract cleanly through placeOrder (getBranch is the first coreClient call)", async () => {
        coreClientStub.failNextRequestWith = coreServiceUnavailableError(new Error("connect ECONNREFUSED"));

        const res = await request(app)
            .post("/api/orders")
            .set("X-Region", "eg")
            .set("Idempotency-Key", idemKey())
            .set(authHeader(CUSTOMER))
            .send({branchId: 20, customerAddressId: 40, paymentMethod: "cod", items: [{productId: 1, quantity: 1}]});

        expect(res.status).toBe(503);
        expect(res.body.error).toBe("Core service unavailable");
        // A 503 is operational (AppError), not the generic-500 programming-error
        // path exercised in error-handling.integration.test.ts — distinct branch.
    });

    it("surfaces the same 503 contract through the RBAC permission lookup path", async () => {
        coreClientStub.failNextRequestWith = coreServiceUnavailableError(new Error("timeout"));

        const res = await request(app)
            .get("/api/restaurants/10/branches/20/orders")
            .set("X-Region", "eg")
            .set(authHeader(MANAGER));
        expect(res.status).toBe(503);
        expect(res.body.error).toBe("Core service unavailable");
    });
});

describe("pagination boundaries", () => {
    it("reports hasMore=false and a null cursor when the result count exactly equals the limit", async () => {
        for (let i = 0; i < 3; i++) {
            await insertOrder({region: "eg", customerId: CUSTOMER.userId, createdAt: new Date(Date.now() - (3 - i) * 1000)});
        }
        const res = await request(app).get("/api/customer/orders?limit=3").set("X-Region", "eg").set(authHeader(CUSTOMER));
        expect(res.status).toBe(200);
        expect(res.body.data).toHaveLength(3);
        expect(res.body.meta.hasMore).toBe(false);
        expect(res.body.meta.nextCursor).toBeNull();
    });

    it("reports an empty page with hasMore=false and a null cursor when there is nothing to list", async () => {
        const res = await request(app).get("/api/customer/orders?limit=20").set("X-Region", "eg").set(authHeader(CUSTOMER));
        expect(res.status).toBe(200);
        expect(res.body.data).toEqual([]);
        expect(res.body.meta).toEqual({nextCursor: null, hasMore: false, count: 0});
    });

    it("caps a limit above MAX_LIMIT (100) rather than returning everything", async () => {
        const res = await request(app).get("/api/customer/orders?limit=99999").set("X-Region", "eg").set(authHeader(CUSTOMER));
        expect(res.status).toBe(200); // would 500 if the raw value were passed straight to SQL LIMIT unbounded
    });
});

describe("partition-boundary order dates", () => {
    // `orders.created_at` is `TIMESTAMP` (no timezone) — Postgres stores naive
    // local digits, and node-pg's driver serializes a bound `Date` parameter
    // using the *Node process's local timezone* components, not UTC (same
    // caveat `cursor-pagination.ts`'s own `formatNaiveTimestampCursor` comment
    // documents for reads). Building these via the local Date constructor
    // (not a "Z"-suffixed ISO string) is what makes the digits actually
    // landing in Postgres match the exact boundary this test means to hit —
    // found live: the first version of this test used UTC ISO strings and
    // landed an "end of September" order in the *October* partition instead,
    // shifted by the dev machine's own UTC+3 (Africa/Cairo) offset.
    const endOfSeptember = new Date(2026, 8, 30, 23, 59, 59, 999);
    const startOfOctober = new Date(2026, 9, 1, 0, 0, 0, 0);

    it("routes an order dated at the exact last instant of a month into that month's own partition, not the default catch-all", async () => {
        const order = await insertOrder({region: "eg", customerId: CUSTOMER.userId, createdAt: endOfSeptember});

        const partition = await db("eg").raw("SELECT tableoid::regclass::text AS partition FROM orders WHERE public_id = ?", [order.publicId]);
        expect(partition.rows[0].partition).toBe("orders_2026_09");
    });

    it("routes an order dated at the exact first instant of the next month into that partition", async () => {
        const order = await insertOrder({region: "eg", customerId: CUSTOMER.userId, createdAt: startOfOctober});

        const partition = await db("eg").raw("SELECT tableoid::regclass::text AS partition FROM orders WHERE public_id = ?", [order.publicId]);
        expect(partition.rows[0].partition).toBe("orders_2026_10");
    });

    it("a customer-orders query spanning the month boundary returns both rows", async () => {
        await insertOrder({region: "eg", customerId: CUSTOMER.userId, status: OrderStatus.PLACED, createdAt: endOfSeptember});
        await insertOrder({region: "eg", customerId: CUSTOMER.userId, status: OrderStatus.PLACED, createdAt: startOfOctober});

        const res = await request(app).get("/api/customer/orders?year=2026&limit=50").set("X-Region", "eg").set(authHeader(CUSTOMER));
        expect(res.status).toBe(200);
        expect(res.body.data).toHaveLength(2);
    });
});
