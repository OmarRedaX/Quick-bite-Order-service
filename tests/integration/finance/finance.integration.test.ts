import request from "supertest";
import {buildTestApp, coreClientStub, resetTestDoubles} from "../support/app";
import {OWNER, OTHER_OWNER, ADMIN, makeIdemKeyGenerator} from "../support/scenario";
import {truncateAllRegions} from "../../helpers/db";
import {flushTestCache} from "../../helpers/redis";
import {authHeader, insertOrder} from "../../helpers/fixtures";
import {db} from "../../../src/lib/knex/knex";

const app = buildTestApp();

const idemKey = makeIdemKeyGenerator("finance");

beforeEach(async () => {
    await truncateAllRegions(["eg", "ksa"]);
    await flushTestCache();
    resetTestDoubles();
});

describe("GET /api/restaurants/:restaurantId/balance", () => {
    it("returns the restaurant's balances per currency", async () => {
        coreClientStub.seedPermissions("owner", ["finance:read"]);
        await db("eg")("restaurant_balances").insert({restaurant_id: 10, region: "eg", currency: "EGP", balance: 5000});

        const res = await request(app).get("/api/restaurants/10/balance").set("X-Region", "eg").set(authHeader(OWNER));
        expect(res.status).toBe(200);
        expect(res.body.data.balances).toEqual([{currency: "EGP", balance: 5000}]);
    });

    it("returns an empty balances array when the restaurant has no balance rows yet", async () => {
        coreClientStub.seedPermissions("owner", ["finance:read"]);
        const res = await request(app).get("/api/restaurants/10/balance").set("X-Region", "eg").set(authHeader(OWNER));
        expect(res.status).toBe(200);
        expect(res.body.data.balances).toEqual([]);
    });

    it("denies a restaurant member of a different restaurant", async () => {
        coreClientStub.seedPermissions("owner", ["finance:read"]);
        const res = await request(app).get("/api/restaurants/10/balance").set("X-Region", "eg").set(authHeader(OTHER_OWNER));
        expect(res.status).toBe(403);
    });

    it("denies a member lacking finance:read permission", async () => {
        coreClientStub.seedPermissions("owner", []);
        const res = await request(app).get("/api/restaurants/10/balance").set("X-Region", "eg").set(authHeader(OWNER));
        expect(res.status).toBe(403);
    });
});

describe("POST /api/admin/restaurants/:restaurantId/payouts", () => {
    it("is admin-only: a restaurant owner (even with finance:payout_create seeded) is rejected by the hard role check", async () => {
        coreClientStub.seedPermissions("owner", ["finance:payout_create"]);
        await insertOrder({region: "eg", restaurantId: 10, restaurantOwnerId: OWNER.userId});
        await db("eg")("restaurant_balances").insert({restaurant_id: 10, region: "eg", currency: "EGP", balance: 10000});

        const res = await request(app)
            .post("/api/admin/restaurants/10/payouts")
            .set("X-Region", "eg")
            .set("Idempotency-Key", idemKey())
            .set(authHeader(OWNER))
            .send({amount: 1000, currency: "EGP", providerReferenceId: "bank-ref-1"});
        expect(res.status).toBe(403);
    });

    it("records the payout, decrements the balance, and returns the payout DTO", async () => {
        await insertOrder({region: "eg", restaurantId: 10, restaurantOwnerId: OWNER.userId});
        await db("eg")("restaurant_balances").insert({restaurant_id: 10, region: "eg", currency: "EGP", balance: 10000});

        const res = await request(app)
            .post("/api/admin/restaurants/10/payouts")
            .set("X-Region", "eg")
            .set("Idempotency-Key", idemKey())
            .set(authHeader(ADMIN))
            .send({amount: 4000, currency: "EGP", providerReferenceId: "bank-ref-1"});
        expect(res.status).toBe(201);
        expect(res.body.data.amount).toBe(4000);
        expect(res.body.data.status).toBe("succeeded");

        const balance = await db("eg")("restaurant_balances").where({restaurant_id: 10, currency: "EGP"}).first();
        expect(Number(balance.balance)).toBe(6000);

        const tx = await db("eg")("transactions").where({provider_reference_id: "bank-ref-1"}).first();
        expect(tx.transaction_type).toBe("payout");
        expect(Number(tx.dst_acc_id)).toBe(OWNER.userId);
    });

    it("rejects a payout larger than the current balance with 409, leaving the balance untouched", async () => {
        await insertOrder({region: "eg", restaurantId: 10, restaurantOwnerId: OWNER.userId});
        await db("eg")("restaurant_balances").insert({restaurant_id: 10, region: "eg", currency: "EGP", balance: 1000});

        const res = await request(app)
            .post("/api/admin/restaurants/10/payouts")
            .set("X-Region", "eg")
            .set("Idempotency-Key", idemKey())
            .set(authHeader(ADMIN))
            .send({amount: 5000, currency: "EGP", providerReferenceId: "bank-ref-2"});
        expect(res.status).toBe(409);
        expect(res.body.error).toBe("InsufficientBalance");

        const balance = await db("eg")("restaurant_balances").where({restaurant_id: 10, currency: "EGP"}).first();
        expect(Number(balance.balance)).toBe(1000);
    });

    it("returns 404 for a restaurant that has never placed an order (no owner to resolve)", async () => {
        const res = await request(app)
            .post("/api/admin/restaurants/999/payouts")
            .set("X-Region", "eg")
            .set("Idempotency-Key", idemKey())
            .set(authHeader(ADMIN))
            .send({amount: 100, currency: "EGP", providerReferenceId: "bank-ref-3"});
        expect(res.status).toBe(404);
    });

    it("is idempotent under a repeated Idempotency-Key: the balance is only decremented once", async () => {
        await insertOrder({region: "eg", restaurantId: 10, restaurantOwnerId: OWNER.userId});
        await db("eg")("restaurant_balances").insert({restaurant_id: 10, region: "eg", currency: "EGP", balance: 10000});
        const key = idemKey();
        const body = {amount: 2000, currency: "EGP", providerReferenceId: "bank-ref-4"};

        const first = await request(app).post("/api/admin/restaurants/10/payouts").set("X-Region", "eg").set("Idempotency-Key", key).set(authHeader(ADMIN)).send(body);
        expect(first.status).toBe(201);
        const second = await request(app).post("/api/admin/restaurants/10/payouts").set("X-Region", "eg").set("Idempotency-Key", key).set(authHeader(ADMIN)).send(body);
        expect(second.status).toBe(200);

        const balance = await db("eg")("restaurant_balances").where({restaurant_id: 10, currency: "EGP"}).first();
        expect(Number(balance.balance)).toBe(8000);
    });
});

describe("GET /api/restaurants/:restaurantId/payouts", () => {
    it("lists prior payouts for the restaurant's owner", async () => {
        coreClientStub.seedPermissions("owner", ["finance:read"]);
        await insertOrder({region: "eg", restaurantId: 10, restaurantOwnerId: OWNER.userId});
        await db("eg")("restaurant_balances").insert({restaurant_id: 10, region: "eg", currency: "EGP", balance: 5000});
        await request(app)
            .post("/api/admin/restaurants/10/payouts")
            .set("X-Region", "eg")
            .set("Idempotency-Key", idemKey())
            .set(authHeader(ADMIN))
            .send({amount: 1000, currency: "EGP", providerReferenceId: "bank-ref-list-1"});

        const res = await request(app).get("/api/restaurants/10/payouts").set("X-Region", "eg").set(authHeader(OWNER));
        expect(res.status).toBe(200);
        expect(res.body.data).toHaveLength(1);
        expect(res.body.data[0].providerReferenceId).toBe("bank-ref-list-1");
    });
});
