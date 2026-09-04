import request from "supertest";
import {buildTestApp, coreClientStub, fakeIoServer, resetTestDoubles} from "../support/app";
import {ADMIN, AGENT as AGENT_FIXTURE, MANAGER, BRANCH_ID, seedBranch, makeIdemKeyGenerator} from "../support/scenario";
import {truncateAllRegions} from "../../helpers/db";
import {flushTestCache} from "../../helpers/redis";
import {authHeader, insertOrder} from "../../helpers/fixtures";
import {container} from "../../../src/lib/di/container";
import {TOKENS} from "../../../src/lib/di/tokens";
import {AssignmentService} from "../../../src/app/assignment/service/assignment.service";
import {PresenceService} from "../../../src/app/agent/service/presence.service";
import {cacheProvider} from "../../../src/lib/cache/init";
import {OrderStatus} from "../../../src/app/order/enums";
import {env} from "../../../src/lib/config/env";
import {db} from "../../../src/lib/knex/knex";

const app = buildTestApp(); // wires the DI container (with core-client/kashier/messaging mocked)

const idemKey = makeIdemKeyGenerator("assignment-admin");

// This file works with the agent purely as an id (Redis keys, DB columns,
// distance math) — never through authHeader() — so a numeric alias reads
// cleaner here than threading `.userId` through every call site.
const AGENT = AGENT_FIXTURE.userId;
const BRANCH_LAT = 30.05;
const BRANCH_LNG = 31.24;

let assignmentService: AssignmentService;
let presenceService: PresenceService;

beforeEach(async () => {
    await truncateAllRegions(["eg", "ksa"]);
    await flushTestCache();
    resetTestDoubles();
    assignmentService = container.resolve<AssignmentService>(TOKENS.AssignmentService);
    presenceService = container.resolve<PresenceService>(TOKENS.PresenceService);

    seedBranch(); // BRANCH_ID=20, lat/lng default to BRANCH_LAT/BRANCH_LNG above
});

describe("AssignmentService.tryAssign (one tick's worth of matching logic)", () => {
    it("no online agent -> no-candidates, and bumps the retry-attempt counter", async () => {
        const order = await insertOrder({region: "eg", status: OrderStatus.READY, branchId: BRANCH_ID, branchLat: BRANCH_LAT, branchLng: BRANCH_LNG});
        const result = await assignmentService.tryAssign(order, "eg");
        expect(result).toBe("no-candidates");

        const attempts = await cacheProvider.get(AssignmentService.attemptsKey(order.publicId));
        expect(attempts).toBe("1");
    });

    it("one online agent inside the radius -> offered, and broadcasts task.offered to that agent", async () => {
        await presenceService.upsert("eg", AGENT, BRANCH_LAT, BRANCH_LNG);
        const order = await insertOrder({region: "eg", status: OrderStatus.READY, branchId: BRANCH_ID, branchLat: BRANCH_LAT, branchLng: BRANCH_LNG});

        const result = await assignmentService.tryAssign(order, "eg");
        expect(result).toBe("offered");

        const offer = await cacheProvider.get(AssignmentService.offerKey(order.publicId));
        expect(offer).toBe(String(AGENT));

        const emitted = fakeIoServer.emitted.find((e) => e.event === "task.offered" && e.room === `agent:${AGENT}`);
        expect(emitted).toBeDefined();
        expect((emitted!.payload as {orderId: string}).orderId).toBe(order.publicId);
    });

    it("does not re-offer while an offer is already active (skipped)", async () => {
        await presenceService.upsert("eg", AGENT, BRANCH_LAT, BRANCH_LNG);
        const order = await insertOrder({region: "eg", status: OrderStatus.READY, branchId: BRANCH_ID, branchLat: BRANCH_LAT, branchLng: BRANCH_LNG});

        await assignmentService.tryAssign(order, "eg");
        fakeIoServer.reset();
        const second = await assignmentService.tryAssign(order, "eg");
        expect(second).toBe("skipped");
        expect(fakeIoServer.emitted).toHaveLength(0);
    });

    it("excludes a busy agent from candidates even if online and in range", async () => {
        await presenceService.upsert("eg", AGENT, BRANCH_LAT, BRANCH_LNG);
        await presenceService.markBusy("eg", AGENT);
        const order = await insertOrder({region: "eg", status: OrderStatus.READY, branchId: BRANCH_ID, branchLat: BRANCH_LAT, branchLng: BRANCH_LNG});

        const result = await assignmentService.tryAssign(order, "eg");
        expect(result).toBe("no-candidates");
    });

    it("excludes an agent outside the configured radius", async () => {
        await presenceService.upsert("eg", AGENT, BRANCH_LAT + 5, BRANCH_LNG + 5); // far away
        const order = await insertOrder({region: "eg", status: OrderStatus.READY, branchId: BRANCH_ID, branchLat: BRANCH_LAT, branchLng: BRANCH_LNG});

        const result = await assignmentService.tryAssign(order, "eg");
        expect(result).toBe("no-candidates");
    });

    it("stops offering and alerts admins once max reassignment attempts are exhausted", async () => {
        const order = await insertOrder({region: "eg", status: OrderStatus.READY, branchId: BRANCH_ID, branchLat: BRANCH_LAT, branchLng: BRANCH_LNG});
        await cacheProvider.set(AssignmentService.attemptsKey(order.publicId), String(env.delivery.maxAttempts), 3600);

        const result = await assignmentService.tryAssign(order, "eg");
        expect(result).toBe("exhausted");

        const alert = fakeIoServer.emitted.find((e) => e.event === "assignment.exhausted" && e.room === "admin:alerts");
        expect(alert).toBeDefined();
        expect((alert!.payload as {orderId: string}).orderId).toBe(order.publicId);
    });
});

describe("AssignmentService.tickRegion", () => {
    it("processes every ready-unassigned order in the region in one pass", async () => {
        await presenceService.upsert("eg", AGENT, BRANCH_LAT, BRANCH_LNG);
        await insertOrder({region: "eg", status: OrderStatus.READY, branchId: BRANCH_ID, branchLat: BRANCH_LAT, branchLng: BRANCH_LNG});
        await insertOrder({region: "eg", status: OrderStatus.READY, branchId: BRANCH_ID, branchLat: BRANCH_LAT + 10, branchLng: BRANCH_LNG + 10}); // out of range
        await insertOrder({region: "eg", status: OrderStatus.ACCEPTED}); // not ready -> excluded entirely

        const result = await assignmentService.tickRegion("eg");
        expect(result.processed).toBe(2);
        expect(result.offered).toBe(1);
        expect(result.skipped).toBe(1);
    });
});

describe("AssignmentService.claim / reject via the offer+candidate flow", () => {
    it("claim() is atomic: a second claim attempt for the same order fails once the first has the lock", async () => {
        await presenceService.upsert("eg", AGENT, BRANCH_LAT, BRANCH_LNG);
        const order = await insertOrder({region: "eg", status: OrderStatus.READY, branchId: BRANCH_ID, branchLat: BRANCH_LAT, branchLng: BRANCH_LNG});
        await assignmentService.tryAssign(order, "eg");

        const winner = await assignmentService.claim(order.publicId, AGENT, "eg");
        expect(winner.orderId).toBe(order.publicId);

        await expect(assignmentService.claim(order.publicId, AGENT, "eg")).rejects.toMatchObject({statusCode: 404}); // offer already dropped after the winning claim
    });

    it("claim() rejects with OrderNotInReadyState when the offered order no longer exists", async () => {
        const phantomPublicId = "22222222-2222-2222-2222-222222222222";
        await cacheProvider.trySet(AssignmentService.offerKey(phantomPublicId), String(AGENT), 30);

        await expect(assignmentService.claim(phantomPublicId, AGENT, "eg")).rejects.toMatchObject({statusCode: 409});

        const claimStillHeld = await cacheProvider.exists(AssignmentService.claimKey(phantomPublicId));
        expect(claimStillHeld).toBe(false); // released back after the failed claim
    });

    it("claim() rejects with OrderNotInReadyState when the order changed state before the claim ran (lost the DB-level race)", async () => {
        const order = await insertOrder({region: "eg", status: OrderStatus.ASSIGNED, deliveryAgentId: 999}); // already claimed by someone else at the DB level
        await cacheProvider.trySet(AssignmentService.offerKey(order.publicId), String(AGENT), 30);

        await expect(assignmentService.claim(order.publicId, AGENT, "eg")).rejects.toMatchObject({statusCode: 409});
    });
});

describe("POST /api/admin/orders/:publicId/assign", () => {
    it("force-assigns an order to the given agent, bypassing distance/busy state, when the caller is system_admin", async () => {
        const order = await insertOrder({region: "eg", status: OrderStatus.READY});

        const res = await request(app)
            .post(`/api/admin/orders/${order.publicId}/assign`)
            .set("X-Region", "eg")
            .set("Idempotency-Key", idemKey())
            .set(authHeader(ADMIN))
            .send({agentId: AGENT});
        expect(res.status).toBe(200);
        expect(res.body.data.orderId).toBe(order.publicId);

        const updated = await db("eg")("orders").where({public_id: order.publicId}).first();
        expect(updated.status).toBe(OrderStatus.ASSIGNED);
        expect(Number(updated.delivery_agent_id)).toBe(AGENT);

        expect(fakeIoServer.emitted.some((e) => e.event === "task.assigned" && e.room === `agent:${AGENT}`)).toBe(true);
    });

    it("requires deliveries:assign (or system_admin) — a caller without it is denied", async () => {
        const order = await insertOrder({region: "eg", status: OrderStatus.READY});
        coreClientStub.seedPermissions("branch_manager", []); // no deliveries:assign

        const res = await request(app)
            .post(`/api/admin/orders/${order.publicId}/assign`)
            .set("X-Region", "eg")
            .set("Idempotency-Key", idemKey())
            .set(authHeader(MANAGER))
            .send({agentId: AGENT});
        expect(res.status).toBe(403);
    });

    it("returns 409 when the order is already claimed", async () => {
        const order = await insertOrder({region: "eg", status: OrderStatus.READY});
        await cacheProvider.trySet(AssignmentService.claimKey(order.publicId), "999", 300);

        const res = await request(app)
            .post(`/api/admin/orders/${order.publicId}/assign`)
            .set("X-Region", "eg")
            .set("Idempotency-Key", idemKey())
            .set(authHeader(ADMIN))
            .send({agentId: AGENT});
        expect(res.status).toBe(409);
    });

    it("rejects a missing/invalid agentId with 400", async () => {
        const order = await insertOrder({region: "eg", status: OrderStatus.READY});
        const res = await request(app)
            .post(`/api/admin/orders/${order.publicId}/assign`)
            .set("X-Region", "eg")
            .set("Idempotency-Key", idemKey())
            .set(authHeader(ADMIN))
            .send({});
        expect(res.status).toBe(400);
    });
});
