import {buildTestApp, coreClientStub, messageBrokerStub, resetTestDoubles} from "../support/app";
import {truncateAllRegions} from "../../helpers/db";
import {flushTestCache} from "../../helpers/redis";
import {insertOrder} from "../../helpers/fixtures";
import {db} from "../../../src/lib/knex/knex";
import {env} from "../../../src/lib/config/env";
import {insertOutboxEvent} from "../../../src/lib/events/outbox.repo";
import {drainOutboxForRegion} from "../../../src/lib/events/outbox-drain";
import {startCoreEventsConsumer} from "../../../src/lib/core-events/consumer";
import {registerOrderModuleCoreEventHandlers} from "../../../src/app/order/core-events.handlers";
import {cacheProvider} from "../../../src/lib/cache/init";
import {container} from "../../../src/lib/di/container";
import {TOKENS} from "../../../src/lib/di/tokens";
import {PermissionCacheService} from "../../../src/lib/rbac/permission-cache.service";

buildTestApp(); // wires the DI container

beforeAll(() => {
    // registerHandler() throws "already registered" on a second call for the
    // same event type — the consumer's handler map is a true module-level
    // singleton for the lifetime of this test file, so this can only run once.
    registerOrderModuleCoreEventHandlers();
});

beforeEach(async () => {
    await truncateAllRegions(["eg", "ksa"]);
    await flushTestCache();
    resetTestDoubles(); // clears messageBrokerStub's registered consumers too
    // re-register the consumer every test, since resetTestDoubles() just wiped it.
    await startCoreEventsConsumer(messageBrokerStub);
});

function deliverCoreEvent(eventId: string, eventType: string, payload: unknown) {
    return messageBrokerStub.deliver(env.rabbit.queue, {
        routingKey: eventType,
        body: Buffer.from(JSON.stringify({eventId, eventType, occurredAt: new Date().toISOString(), payload}), "utf8"),
    });
}

describe("drainOutboxForRegion", () => {
    it("publishes every undispatched row to the order.events exchange and marks them dispatched", async () => {
        const order = await insertOrder({region: "eg"});
        await insertOutboxEvent(db("eg"), {aggregateType: "order", aggregateId: order.publicId, eventType: "order.placed", payload: {orderId: order.publicId}});

        await drainOutboxForRegion("eg");

        expect(messageBrokerStub.published).toHaveLength(1);
        expect(messageBrokerStub.published[0].exchange).toBe(env.outboundEvents.exchange);
        expect(messageBrokerStub.published[0].routingKey).toBe("order.placed");
        const envelope = JSON.parse(messageBrokerStub.published[0].body.toString("utf8"));
        expect(envelope.aggregateId).toBe(order.publicId);

        const row = await db("eg")("events_outbox").where({aggregate_id: order.publicId}).first();
        expect(row.dispatched_at).not.toBeNull();
    });

    it("is a no-op when there is nothing to drain", async () => {
        await drainOutboxForRegion("eg");
        expect(messageBrokerStub.published).toHaveLength(0);
    });

    it("marks a row failed (with an incremented attempt count) and stops the batch when publish throws", async () => {
        const order1 = await insertOrder({region: "eg"});
        const order2 = await insertOrder({region: "eg"});
        await insertOutboxEvent(db("eg"), {aggregateType: "order", aggregateId: order1.publicId, eventType: "order.placed", payload: {}});
        await insertOutboxEvent(db("eg"), {aggregateType: "order", aggregateId: order2.publicId, eventType: "order.placed", payload: {}});

        const spy = jest.spyOn(messageBrokerStub, "publish").mockRejectedValueOnce(new Error("broker unreachable"));
        await drainOutboxForRegion("eg");
        spy.mockRestore();

        const row1 = await db("eg")("events_outbox").where({aggregate_id: order1.publicId}).first();
        expect(row1.dispatched_at).toBeNull();
        expect(Number(row1.attempts)).toBe(1);
        expect(row1.last_error).toContain("broker unreachable");

        // The batch bails out after the first failure — the second row is
        // never attempted this pass (still holds its FOR UPDATE SKIP LOCKED
        // eligibility for the next drain).
        const row2 = await db("eg")("events_outbox").where({aggregate_id: order2.publicId}).first();
        expect(row2.dispatched_at).toBeNull();
        expect(Number(row2.attempts)).toBe(0);
    });

    it("only drains the region it's asked to (ksa rows are untouched by an eg drain)", async () => {
        const order = await insertOrder({region: "ksa"});
        await insertOutboxEvent(db("ksa"), {aggregateType: "order", aggregateId: order.publicId, eventType: "order.placed", payload: {}});

        await drainOutboxForRegion("eg");
        expect(messageBrokerStub.published).toHaveLength(0);

        await drainOutboxForRegion("ksa");
        expect(messageBrokerStub.published).toHaveLength(1);
    });
});

describe("inbound core-events consumer (cache invalidation)", () => {
    it("branch.deactivated invalidates the branch cache and sets the reject-new-orders flag", async () => {
        await cacheProvider.set("core:branch:5", JSON.stringify({id: 5, isActive: true}), 3600);

        await deliverCoreEvent("evt-branch-deactivated-1", "branch.deactivated", {branchId: 5});

        expect(await cacheProvider.get("core:branch:5")).toBeNull();
        expect(await cacheProvider.get("branch:reject-new-orders:5")).toBe("1");
    });

    it("branch.updated invalidates the branch cache and clears the reject flag", async () => {
        await cacheProvider.set("core:branch:6", JSON.stringify({id: 6}), 3600);
        await cacheProvider.set("branch:reject-new-orders:6", "1", 3600);

        await deliverCoreEvent("evt-branch-updated-1", "branch.updated", {branchId: 6});

        expect(await cacheProvider.get("core:branch:6")).toBeNull();
        expect(await cacheProvider.get("branch:reject-new-orders:6")).toBeNull();
    });

    it("product.price.changed merges the new price into the product's cache entry", async () => {
        await deliverCoreEvent("evt-price-1", "product.price.changed", {branchId: 20, productId: 7, newPrice: 999});
        const cached = JSON.parse((await cacheProvider.get("core:branch:20:product:7"))!);
        expect(cached.price).toBe(999);
    });

    it("product.stock.changed merges stock/availability without clobbering an existing price entry", async () => {
        await cacheProvider.set("core:branch:20:product:8", JSON.stringify({productId: 8, price: 500}), 3600);
        await deliverCoreEvent("evt-stock-1", "product.stock.changed", {branchId: 20, productId: 8, newStock: 3, isAvailable: true});
        const cached = JSON.parse((await cacheProvider.get("core:branch:20:product:8"))!);
        expect(cached).toEqual({price: 500, productId: 8, stock: 3, isAvailable: true});
    });

    it("restaurant.suspended invalidates the restaurant cache", async () => {
        await cacheProvider.set("core:restaurant:10", JSON.stringify({id: 10}), 3600);
        await deliverCoreEvent("evt-restaurant-1", "restaurant.suspended", {restaurantId: 10});
        expect(await cacheProvider.get("core:restaurant:10")).toBeNull();
    });

    it("dedupes a redelivered eventId — the handler runs only once", async () => {
        await deliverCoreEvent("evt-dedupe-1", "product.price.changed", {branchId: 30, productId: 1, newPrice: 100});
        // Same eventId redelivered with a different payload — a real duplicate
        // always carries the identical payload; using a different one here is
        // exactly what proves the second delivery never re-ran the handler
        // rather than "happened to converge on the same cached value".
        await deliverCoreEvent("evt-dedupe-1", "product.price.changed", {branchId: 30, productId: 1, newPrice: 999});

        const cached = JSON.parse((await cacheProvider.get("core:branch:30:product:1"))!);
        expect(cached.price).toBe(100);
    });

    it("acks and ignores an event type with no registered handler", async () => {
        await expect(deliverCoreEvent("evt-unknown-1", "some.unknown.event", {})).resolves.toBeUndefined();
    });

    it("rbac.permissions_changed clears the in-process permission cache for that role, forcing a re-fetch", async () => {
        const perms = container.resolve<PermissionCacheService>(TOKENS.PermissionCacheService);

        coreClientStub.seedPermissions("branch_manager", ["orders:read"]);
        expect(await perms.getPermissions("branch_manager")).toEqual(["orders:read"]);

        // core-service's permissions changed, but the in-process cache (1h TTL)
        // would keep serving the old list until invalidated.
        coreClientStub.seedPermissions("branch_manager", ["orders:read", "orders:accept"]);
        expect(await perms.getPermissions("branch_manager")).toEqual(["orders:read"]); // still cached

        await deliverCoreEvent("evt-rbac-1", "rbac.permissions_changed", {role: "branch_manager"});

        expect(await perms.getPermissions("branch_manager")).toEqual(["orders:read", "orders:accept"]); // re-fetched
    });
});
