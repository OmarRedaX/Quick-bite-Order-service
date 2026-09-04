import request from "supertest";
import {buildTestApp, fakeIoServer, resetTestDoubles} from "../support/app";
import {BRANCH_ID, RESTAURANT_ID, CUSTOMER, AGENT, OTHER_AGENT, seedBranch, makeIdemKeyGenerator} from "../support/scenario";
import {truncateAllRegions} from "../../helpers/db";
import {flushTestCache} from "../../helpers/redis";
import {authHeader, insertOrder} from "../../helpers/fixtures";
import {db} from "../../../src/lib/knex/knex";
import {cacheProvider} from "../../../src/lib/cache/init";
import {AssignmentService} from "../../../src/app/assignment/service/assignment.service";
import {PresenceService} from "../../../src/app/agent/service/presence.service";
import {OrderStatus, PaymentMethod} from "../../../src/app/order/enums";
import {TransactionType, TransactionStatus} from "../../../src/app/payment/enums";

const app = buildTestApp();

const idemKey = makeIdemKeyGenerator("agent");

beforeEach(async () => {
    await truncateAllRegions(["eg", "ksa"]);
    await flushTestCache();
    resetTestDoubles();
});

describe("POST /api/agents/presence/online + ping", () => {
    it("upserts presence meta and the geo set", async () => {
        const res = await request(app)
            .post("/api/agents/presence/online")
            .set("X-Region", "eg")
            .set(authHeader(AGENT))
            .send({lat: 30.05, lng: 31.24});
        expect(res.status).toBe(200);

        const metaExists = await cacheProvider.exists(PresenceService.metaKey("eg", AGENT.userId));
        expect(metaExists).toBe(true);

        const nearby = await cacheProvider.geosearchByRadius(PresenceService.geoKey("eg"), 31.24, 30.05, 1000, 10);
        expect(nearby).toContain(String(AGENT.userId));
    });

    it("requires the delivery_agent role", async () => {
        const res = await request(app)
            .post("/api/agents/presence/online")
            .set("X-Region", "eg")
            .set(authHeader({userId: 501, role: "customer", email: "c@test.com"}))
            .send({lat: 30.05, lng: 31.24});
        expect(res.status).toBe(403);
    });

    it("validates lat/lng boundaries", async () => {
        const res = await request(app)
            .post("/api/agents/presence/ping")
            .set("X-Region", "eg")
            .set(authHeader(AGENT))
            .send({lat: 999, lng: 31.24});
        expect(res.status).toBe(400);
    });
});

describe("POST /api/agents/presence/offline", () => {
    it("forbids going offline while holding a picked order", async () => {
        await insertOrder({region: "eg", deliveryAgentId: AGENT.userId, status: OrderStatus.PICKED});
        const res = await request(app).post("/api/agents/presence/offline").set("X-Region", "eg").set(authHeader(AGENT));
        expect(res.status).toBe(409);
        expect(res.body.error).toBe("OfflineWhilePickedForbidden");
    });

    it("resets an assigned order back to ready and clears presence", async () => {
        await cacheProvider.hsetWithTtl(PresenceService.metaKey("eg", AGENT.userId), {lat: "30", lng: "31", lastSeenAt: String(Date.now())}, 300);
        const order = await insertOrder({region: "eg", deliveryAgentId: AGENT.userId, status: OrderStatus.ASSIGNED, assignedAt: new Date()});

        const res = await request(app).post("/api/agents/presence/offline").set("X-Region", "eg").set(authHeader(AGENT));
        expect(res.status).toBe(200);

        const updated = await db("eg")("orders").where({public_id: order.publicId}).first();
        expect(updated.status).toBe(OrderStatus.READY);
        expect(updated.delivery_agent_id).toBeNull();

        const meta = await cacheProvider.exists(PresenceService.metaKey("eg", AGENT.userId));
        expect(meta).toBe(false);
    });
});

describe("POST /api/agents/orders/:publicId/accept", () => {
    it("claims the order when the agent is in the offer's candidate list", async () => {
        seedBranch();
        const order = await insertOrder({region: "eg", status: OrderStatus.READY, branchId: BRANCH_ID, restaurantId: RESTAURANT_ID, customerId: CUSTOMER.userId});
        await cacheProvider.trySet(AssignmentService.offerKey(order.publicId), `${OTHER_AGENT.userId},${AGENT.userId}`, 30);

        const res = await request(app)
            .post(`/api/agents/orders/${order.publicId}/accept`)
            .set("X-Region", "eg")
            .set("Idempotency-Key", idemKey())
            .set(authHeader(AGENT));
        expect(res.status).toBe(200);
        expect(res.body.data.orderId).toBe(order.publicId);

        const updated = await db("eg")("orders").where({public_id: order.publicId}).first();
        expect(updated.status).toBe(OrderStatus.ASSIGNED);
        expect(Number(updated.delivery_agent_id)).toBe(AGENT.userId);

        expect(fakeIoServer.emitted.some((e) => e.event === "task.assigned" && e.room === `agent:${AGENT.userId}`)).toBe(true);
        expect(fakeIoServer.emitted.some((e) => e.event === "offer.cancelled" && e.room === `agent:${OTHER_AGENT.userId}`)).toBe(true);

        const offerStillSet = await cacheProvider.exists(AssignmentService.offerKey(order.publicId));
        expect(offerStillSet).toBe(false);
    });

    it("returns 403 when the agent was not among the offered candidates", async () => {
        const order = await insertOrder({region: "eg", status: OrderStatus.READY});
        await cacheProvider.trySet(AssignmentService.offerKey(order.publicId), `${OTHER_AGENT.userId}`, 30);

        const res = await request(app)
            .post(`/api/agents/orders/${order.publicId}/accept`)
            .set("X-Region", "eg")
            .set("Idempotency-Key", idemKey())
            .set(authHeader(AGENT));
        expect(res.status).toBe(403);
    });

    it("returns 404 when there is no active offer (expired or never offered)", async () => {
        const order = await insertOrder({region: "eg", status: OrderStatus.READY});
        const res = await request(app)
            .post(`/api/agents/orders/${order.publicId}/accept`)
            .set("X-Region", "eg")
            .set("Idempotency-Key", idemKey())
            .set(authHeader(AGENT));
        expect(res.status).toBe(404);
    });

    it("returns 409 when another agent already claimed the order (race)", async () => {
        const order = await insertOrder({region: "eg", status: OrderStatus.READY});
        await cacheProvider.trySet(AssignmentService.offerKey(order.publicId), `${AGENT.userId}`, 30);
        await cacheProvider.trySet(AssignmentService.claimKey(order.publicId), String(OTHER_AGENT.userId), 300);

        const res = await request(app)
            .post(`/api/agents/orders/${order.publicId}/accept`)
            .set("X-Region", "eg")
            .set("Idempotency-Key", idemKey())
            .set(authHeader(AGENT));
        expect(res.status).toBe(409);
    });

    it("requires an Idempotency-Key header", async () => {
        const order = await insertOrder({region: "eg", status: OrderStatus.READY});
        await cacheProvider.trySet(AssignmentService.offerKey(order.publicId), `${AGENT.userId}`, 30);
        const res = await request(app).post(`/api/agents/orders/${order.publicId}/accept`).set("X-Region", "eg").set(authHeader(AGENT));
        expect(res.status).toBe(400);
    });
});

describe("POST /api/agents/orders/:publicId/reject", () => {
    it("removes the rejecting agent from the candidate list, keeping the offer alive for the rest", async () => {
        const order = await insertOrder({region: "eg", status: OrderStatus.READY});
        await cacheProvider.trySet(AssignmentService.offerKey(order.publicId), `${AGENT.userId},${OTHER_AGENT.userId}`, 30);

        const res = await request(app).post(`/api/agents/orders/${order.publicId}/reject`).set("X-Region", "eg").set(authHeader(AGENT));
        expect(res.status).toBe(200);

        const remaining = await cacheProvider.get(AssignmentService.offerKey(order.publicId));
        expect(remaining).toBe(String(OTHER_AGENT.userId));
    });

    it("clears the offer entirely when the last candidate rejects", async () => {
        const order = await insertOrder({region: "eg", status: OrderStatus.READY});
        await cacheProvider.trySet(AssignmentService.offerKey(order.publicId), `${AGENT.userId}`, 30);

        const res = await request(app).post(`/api/agents/orders/${order.publicId}/reject`).set("X-Region", "eg").set(authHeader(AGENT));
        expect(res.status).toBe(200);

        const exists = await cacheProvider.exists(AssignmentService.offerKey(order.publicId));
        expect(exists).toBe(false);
    });
});

describe("PATCH /api/agents/orders/:publicId/status", () => {
    it("transitions an assigned order to picked for the assigned agent", async () => {
        const order = await insertOrder({region: "eg", status: OrderStatus.ASSIGNED, deliveryAgentId: AGENT.userId, assignedAt: new Date()});
        const res = await request(app)
            .patch(`/api/agents/orders/${order.publicId}/status`)
            .set("X-Region", "eg")
            .set("Idempotency-Key", idemKey())
            .set(authHeader(AGENT))
            .send({status: "picked"});
        expect(res.status).toBe(200);

        const updated = await db("eg")("orders").where({public_id: order.publicId}).first();
        expect(updated.status).toBe(OrderStatus.PICKED);
    });

    it("returns 403 when a different agent than the assigned one tries to pick up", async () => {
        const order = await insertOrder({region: "eg", status: OrderStatus.ASSIGNED, deliveryAgentId: OTHER_AGENT.userId});
        const res = await request(app)
            .patch(`/api/agents/orders/${order.publicId}/status`)
            .set("X-Region", "eg")
            .set("Idempotency-Key", idemKey())
            .set(authHeader(AGENT))
            .send({status: "picked"});
        expect(res.status).toBe(403);
    });

    it("settles a delivered COD order: books cod_collection/commission/fees, credits the restaurant balance, and pays the agent's earning share", async () => {
        seedBranch();
        const order = await insertOrder({
            region: "eg",
            status: OrderStatus.PICKED,
            deliveryAgentId: AGENT.userId,
            branchId: BRANCH_ID,
            restaurantId: RESTAURANT_ID,
            restaurantOwnerId: 601,
            paymentMethod: PaymentMethod.COD,
            subtotal: 1000,
            deliveryFee: 300,
            serviceFee: 100,
            total: 1400,
        });

        const res = await request(app)
            .patch(`/api/agents/orders/${order.publicId}/status`)
            .set("X-Region", "eg")
            .set("Idempotency-Key", idemKey())
            .set(authHeader(AGENT))
            .send({status: "delivered"});
        expect(res.status).toBe(200);

        const updated = await db("eg")("orders").where({public_id: order.publicId}).first();
        expect(updated.status).toBe(OrderStatus.DELIVERED);
        expect(Number(updated.commission)).toBe(100); // floor(1000 * 1000bps / 10000) = 100

        const txs: Array<{transaction_type: string; amount: number; status: string}> = await db("eg")("transactions").where({order_id: order.id});
        const byType = new Map(txs.map((t) => [t.transaction_type, t]));
        expect(byType.get(TransactionType.COD_COLLECTION)?.amount).toBe(1400); // full order.total — the agent collected it in cash
        expect(byType.get(TransactionType.COMMISSION)?.amount).toBe(100);
        expect(byType.get(TransactionType.SERVICE_FEE)?.amount).toBe(100);
        expect(byType.get(TransactionType.DELIVERY_FEE)?.amount).toBe(300);
        expect(byType.get(TransactionType.COD_COLLECTION)?.status).toBe(TransactionStatus.SUCCEEDED);

        const balance = await db("eg")("restaurant_balances").where({restaurant_id: RESTAURANT_ID, currency: "EGP"}).first();
        expect(Number(balance.balance)).toBe(1000 - 100); // subtotal - commission

        // AGENT_EARNING_SHARE_BPS=8000 (80%) of delivery_fee=300 -> 240
        const earning = await db("eg")("agent_earnings").where({order_id: order.id}).first();
        expect(Number(earning.amount)).toBe(240);
        expect(Number(earning.agent_id)).toBe(AGENT.userId);

        const claimExists = await cacheProvider.exists(AssignmentService.claimKey(order.publicId));
        expect(claimExists).toBe(false);
    });

    it("returns 409 when settling an order that is not in picked state", async () => {
        const order = await insertOrder({region: "eg", status: OrderStatus.ASSIGNED, deliveryAgentId: AGENT.userId});
        const res = await request(app)
            .patch(`/api/agents/orders/${order.publicId}/status`)
            .set("X-Region", "eg")
            .set("Idempotency-Key", idemKey())
            .set(authHeader(AGENT))
            .send({status: "delivered"});
        expect(res.status).toBe(409);
    });

    it("rejects an unrecognized status value", async () => {
        const order = await insertOrder({region: "eg", status: OrderStatus.ASSIGNED, deliveryAgentId: AGENT.userId});
        const res = await request(app)
            .patch(`/api/agents/orders/${order.publicId}/status`)
            .set("X-Region", "eg")
            .set("Idempotency-Key", idemKey())
            .set(authHeader(AGENT))
            .send({status: "cancelled"});
        expect(res.status).toBe(400);
    });
});

describe("GET /api/agents/tasks", () => {
    it("lists the agent's assigned + picked orders, enriched with branch info", async () => {
        seedBranch();
        const assigned = await insertOrder({region: "eg", status: OrderStatus.ASSIGNED, deliveryAgentId: AGENT.userId, branchId: BRANCH_ID, assignedAt: new Date()});
        const picked = await insertOrder({region: "eg", status: OrderStatus.PICKED, deliveryAgentId: AGENT.userId, branchId: BRANCH_ID, assignedAt: new Date(Date.now() - 1000), pickedAt: new Date()});
        await insertOrder({region: "eg", status: OrderStatus.DELIVERED, deliveryAgentId: AGENT.userId, branchId: BRANCH_ID, deliveredAt: new Date()});

        const res = await request(app).get("/api/agents/tasks").set("X-Region", "eg").set(authHeader(AGENT));
        expect(res.status).toBe(200);
        const ids = res.body.data.map((t: {orderId: string}) => t.orderId);
        expect(ids).toEqual(expect.arrayContaining([assigned.publicId, picked.publicId]));
        expect(ids).not.toContain(undefined);
        expect(res.body.data[0].pickup.name).toBe("Downtown Branch");
    });

    it("does not include another agent's tasks", async () => {
        await insertOrder({region: "eg", status: OrderStatus.ASSIGNED, deliveryAgentId: OTHER_AGENT.userId});
        const res = await request(app).get("/api/agents/tasks").set("X-Region", "eg").set(authHeader(AGENT));
        expect(res.status).toBe(200);
        expect(res.body.data).toHaveLength(0);
    });
});

describe("GET /api/agents/earnings", () => {
    it("summarizes earnings within the requested date range", async () => {
        const from = "2026-01-01T00:00:00.000Z";
        const to = "2026-12-31T23:59:59.999Z";
        const order = await insertOrder({region: "eg", deliveryAgentId: AGENT.userId});
        await db("eg")("agent_earnings").insert({
            region: "eg",
            agent_id: AGENT.userId,
            order_id: order.id,
            amount: 240,
            currency: "EGP",
            earned_at: new Date("2026-06-15T00:00:00.000Z"),
        });

        const res = await request(app)
            .get(`/api/agents/earnings?from=${from}&to=${to}`)
            .set("X-Region", "eg")
            .set(authHeader(AGENT));
        expect(res.status).toBe(200);
        expect(res.body.data.totals).toEqual({count: 1, sum: 240, currency: "EGP"});
    });
});
