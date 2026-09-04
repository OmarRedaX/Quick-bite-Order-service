import request from "supertest";
import {buildTestApp, coreClientStub, kashierProviderStub, fakeIoServer, resetTestDoubles} from "../support/app";
import {
    BRANCH_ID,
    RESTAURANT_ID,
    ADDRESS_ID,
    CUSTOMER,
    OTHER_CUSTOMER,
    OWNER,
    MANAGER,
    STAFF_OTHER_BRANCH,
    ADMIN,
    seedBranch,
    seedAddress,
    seedProducts,
    seedAll,
    makeIdemKeyGenerator,
} from "../support/scenario";
import {truncateAllRegions} from "../../helpers/db";
import {flushTestCache} from "../../helpers/redis";
import {authHeader} from "../../helpers/fixtures";
import {insertOrder} from "../../helpers/fixtures";
import {OrderStatus, PaymentMethod} from "../../../src/app/order/enums";
import {db} from "../../../src/lib/knex/knex";

const app = buildTestApp();

const idemKey = makeIdemKeyGenerator("order");

beforeEach(async () => {
    await truncateAllRegions(["eg", "ksa"]);
    await flushTestCache();
    resetTestDoubles();
});

describe("POST /api/orders", () => {
    it("places a COD order, computes totals, persists items, and broadcasts order.created to the branch room", async () => {
        seedAll();
        const res = await request(app)
            .post("/api/orders")
            .set("X-Region", "eg")
            .set("Idempotency-Key", idemKey())
            .set(authHeader(CUSTOMER))
            .send({
                branchId: BRANCH_ID,
                customerAddressId: ADDRESS_ID,
                paymentMethod: PaymentMethod.COD,
                items: [{productId: 1, quantity: 2}],
            });

        expect(res.status).toBe(201);
        expect(res.body.data.status).toBe(OrderStatus.PLACED);
        expect(res.body.data.subtotal).toBe(1000); // 500 * 2
        expect(res.body.data.deliveryFee).toBe(300);
        expect(res.body.data.serviceFee).toBe(1000);
        expect(res.body.data.total).toBe(1000 + 300 + 1000);
        expect(res.body.data.items).toHaveLength(1);
        expect(res.body.data.payment).toBeUndefined();

        const row = await db("eg")("orders").where({public_id: res.body.data.publicId}).first();
        expect(row).toBeDefined();
        expect(row.status).toBe(OrderStatus.PLACED);

        const items = await db("eg")("order_items").where({order_id: row.id});
        expect(items).toHaveLength(1);
        expect(items[0].quantity).toBe(2);

        const outboxRows = await db("eg")("events_outbox").where({aggregate_id: res.body.data.publicId});
        expect(outboxRows).toHaveLength(1);
        expect(outboxRows[0].event_type).toBe("order.placed");

        const created = fakeIoServer.emitted.find((e) => e.event === "order.created");
        expect(created).toBeDefined();
        expect(created!.room).toBe(`branch:${BRANCH_ID}`);
    });

    it("places an ONLINE order in eg (online-enabled region), returns payment redirect info, and does not broadcast order.created yet", async () => {
        seedAll();
        const res = await request(app)
            .post("/api/orders")
            .set("X-Region", "eg")
            .set("Idempotency-Key", idemKey())
            .set(authHeader(CUSTOMER))
            .send({
                branchId: BRANCH_ID,
                customerAddressId: ADDRESS_ID,
                paymentMethod: PaymentMethod.ONLINE,
                items: [{productId: 1, quantity: 1}],
            });

        expect(res.status).toBe(201);
        expect(res.body.data.status).toBe(OrderStatus.PENDING_PAYMENT);
        expect(res.body.data.payment).toBeDefined();
        expect(res.body.data.payment.redirectUrl).toContain("kashier");
        expect(kashierProviderStub.sessionsCreated).toHaveLength(1);
        expect(fakeIoServer.emitted.find((e) => e.event === "order.created")).toBeUndefined();
    });

    it("rejects ONLINE payment in ksa (COD-only region) with 409, without touching stock", async () => {
        coreClientStub.seedBranch(BRANCH_ID, {
            id: BRANCH_ID,
            restaurantId: RESTAURANT_ID,
            restaurantOwnerId: OWNER.userId,
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
        seedAddress(CUSTOMER.userId);
        seedProducts();

        const res = await request(app)
            .post("/api/orders")
            .set("X-Region", "ksa")
            .set("Idempotency-Key", idemKey())
            .set(authHeader(CUSTOMER))
            .send({
                branchId: BRANCH_ID,
                customerAddressId: ADDRESS_ID,
                paymentMethod: PaymentMethod.ONLINE,
                items: [{productId: 1, quantity: 1}],
            });

        expect(res.status).toBe(409);
        expect(res.body.error).toBe("OnlinePaymentNotAvailableInRegion");
        expect(coreClientStub.calls.some((c) => c.path.includes("reserve-stock"))).toBe(false);
    });

    it("accepts COD in ksa (COD-only region)", async () => {
        coreClientStub.seedBranch(BRANCH_ID, {
            id: BRANCH_ID,
            restaurantId: RESTAURANT_ID,
            restaurantOwnerId: OWNER.userId,
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
        seedAddress(CUSTOMER.userId);
        seedProducts();

        const res = await request(app)
            .post("/api/orders")
            .set("X-Region", "ksa")
            .set("Idempotency-Key", idemKey())
            .set(authHeader(CUSTOMER))
            .send({
                branchId: BRANCH_ID,
                customerAddressId: ADDRESS_ID,
                paymentMethod: PaymentMethod.COD,
                items: [{productId: 1, quantity: 1}],
            });

        expect(res.status).toBe(201);
        expect(res.body.data.status).toBe(OrderStatus.PLACED);
    });

    it("rejects when the branch is not accepting orders", async () => {
        seedBranch({acceptOrders: false});
        seedAddress(CUSTOMER.userId);
        seedProducts();

        const res = await request(app)
            .post("/api/orders")
            .set("X-Region", "eg")
            .set("Idempotency-Key", idemKey())
            .set(authHeader(CUSTOMER))
            .send({branchId: BRANCH_ID, customerAddressId: ADDRESS_ID, paymentMethod: PaymentMethod.COD, items: [{productId: 1, quantity: 1}]});

        expect(res.status).toBe(409);
        expect(res.body.error).toBe("BranchNotAcceptingOrders");
    });

    it("rejects ordering more than available stock with 409 and reserves nothing", async () => {
        seedAll();
        const res = await request(app)
            .post("/api/orders")
            .set("X-Region", "eg")
            .set("Idempotency-Key", idemKey())
            .set(authHeader(CUSTOMER))
            .send({branchId: BRANCH_ID, customerAddressId: ADDRESS_ID, paymentMethod: PaymentMethod.COD, items: [{productId: 2, quantity: 5}]});

        expect(res.status).toBe(409);
        expect(res.body.error).toContain("OutOfStock");
    });

    it("rejects ordering a product core-service doesn't return for this branch (unlisted/discontinued) with 409 OutOfStock", async () => {
        seedBranch();
        seedAddress(CUSTOMER.userId);
        seedProducts(); // seeds productId 1 and 2 only

        const res = await request(app)
            .post("/api/orders")
            .set("X-Region", "eg")
            .set("Idempotency-Key", idemKey())
            .set(authHeader(CUSTOMER))
            .send({branchId: BRANCH_ID, customerAddressId: ADDRESS_ID, paymentMethod: PaymentMethod.COD, items: [{productId: 999, quantity: 1}]});

        expect(res.status).toBe(409);
        expect(res.body.error).toContain("OutOfStock");
    });

    it("rejects ordering a product marked unavailable with 409 OutOfStock", async () => {
        seedBranch();
        seedAddress(CUSTOMER.userId);
        coreClientStub.seedBranchProduct(BRANCH_ID, 1, {productId: 1, name: "Burger", imageUrl: null, price: 500, stock: 10, isAvailable: false});

        const res = await request(app)
            .post("/api/orders")
            .set("X-Region", "eg")
            .set("Idempotency-Key", idemKey())
            .set(authHeader(CUSTOMER))
            .send({branchId: BRANCH_ID, customerAddressId: ADDRESS_ID, paymentMethod: PaymentMethod.COD, items: [{productId: 1, quantity: 1}]});

        expect(res.status).toBe(409);
        expect(res.body.error).toContain("OutOfStock");
    });

    it("voids the order and releases stock when Kashier session creation fails after the order row is committed", async () => {
        seedAll();
        kashierProviderStub.nextSessionResult = () => {
            throw new Error("kashier createSession down");
        };

        const res = await request(app)
            .post("/api/orders")
            .set("X-Region", "eg")
            .set("Idempotency-Key", idemKey())
            .set(authHeader(CUSTOMER))
            .send({branchId: BRANCH_ID, customerAddressId: ADDRESS_ID, paymentMethod: PaymentMethod.ONLINE, items: [{productId: 1, quantity: 1}]});

        expect(res.status).toBe(503);
        expect(res.body.error).toBe("Payment provider unavailable");

        // Order was committed (status pending_payment) before the payment-init
        // call, so placeOrder's catch path must void it rather than leave a
        // customer-visible order stuck with no way to ever pay for it.
        const rows = await db("eg")("orders").select("public_id", "status");
        expect(rows).toHaveLength(1);
        expect(rows[0].status).toBe(OrderStatus.CANCELLED);

        expect(coreClientStub.calls.some((c) => c.path.includes("release-stock"))).toBe(true);
    });

    it("rejects placing an order against another customer's address", async () => {
        seedBranch();
        seedAddress(OTHER_CUSTOMER.userId); // address belongs to a different customer
        seedProducts();

        const res = await request(app)
            .post("/api/orders")
            .set("X-Region", "eg")
            .set("Idempotency-Key", idemKey())
            .set(authHeader(CUSTOMER))
            .send({branchId: BRANCH_ID, customerAddressId: ADDRESS_ID, paymentMethod: PaymentMethod.COD, items: [{productId: 1, quantity: 1}]});

        expect(res.status).toBe(403);
    });

    it("requires authentication", async () => {
        const res = await request(app).post("/api/orders").set("X-Region", "eg").send({});
        expect(res.status).toBe(401);
    });

    it("requires a region", async () => {
        const res = await request(app)
            .post("/api/orders")
            .set(authHeader(CUSTOMER))
            .set("Idempotency-Key", idemKey())
            .send({branchId: BRANCH_ID, customerAddressId: ADDRESS_ID, paymentMethod: PaymentMethod.COD, items: [{productId: 1, quantity: 1}]});
        expect(res.status).toBe(400);
    });

    it("requires an Idempotency-Key header (strict)", async () => {
        seedAll();
        const res = await request(app)
            .post("/api/orders")
            .set("X-Region", "eg")
            .set(authHeader(CUSTOMER))
            .send({branchId: BRANCH_ID, customerAddressId: ADDRESS_ID, paymentMethod: PaymentMethod.COD, items: [{productId: 1, quantity: 1}]});
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/Idempotency-Key/);
    });

    it("replays the cached response for a repeated Idempotency-Key instead of creating a second order", async () => {
        seedAll();
        const key = idemKey();
        const body = {branchId: BRANCH_ID, customerAddressId: ADDRESS_ID, paymentMethod: PaymentMethod.COD, items: [{productId: 1, quantity: 1}]};

        const first = await request(app).post("/api/orders").set("X-Region", "eg").set("Idempotency-Key", key).set(authHeader(CUSTOMER)).send(body);
        expect(first.status).toBe(201);

        const second = await request(app).post("/api/orders").set("X-Region", "eg").set("Idempotency-Key", key).set(authHeader(CUSTOMER)).send(body);
        expect(second.status).toBe(200);
        expect(second.body.data.publicId).toBe(first.body.data.publicId);

        const rows = await db("eg")("orders").select("id");
        expect(rows).toHaveLength(1);
    });

    it("rejects an empty items array with 400 (request DTO validation)", async () => {
        seedAll();
        const res = await request(app)
            .post("/api/orders")
            .set("X-Region", "eg")
            .set("Idempotency-Key", idemKey())
            .set(authHeader(CUSTOMER))
            .send({branchId: BRANCH_ID, customerAddressId: ADDRESS_ID, paymentMethod: PaymentMethod.COD, items: []});
        expect(res.status).toBe(400);
    });
});

describe("GET /api/orders/:publicId", () => {
    it("lets the owning customer read their own order", async () => {
        const order = await insertOrder({region: "eg", customerId: CUSTOMER.userId, branchId: BRANCH_ID, restaurantId: RESTAURANT_ID});
        const res = await request(app).get(`/api/orders/${order.publicId}`).set("X-Region", "eg").set(authHeader(CUSTOMER));
        expect(res.status).toBe(200);
        expect(res.body.data.publicId).toBe(order.publicId);
    });

    it("forbids a different customer from reading it", async () => {
        const order = await insertOrder({region: "eg", customerId: CUSTOMER.userId});
        const res = await request(app).get(`/api/orders/${order.publicId}`).set("X-Region", "eg").set(authHeader(OTHER_CUSTOMER));
        expect(res.status).toBe(403);
    });

    it("lets the restaurant owner read any order on their restaurant", async () => {
        const order = await insertOrder({region: "eg", customerId: CUSTOMER.userId, restaurantId: RESTAURANT_ID, branchId: 999});
        const res = await request(app).get(`/api/orders/${order.publicId}`).set("X-Region", "eg").set(authHeader(OWNER));
        expect(res.status).toBe(200);
    });

    it("lets a branch member read an order on their own branch but not a sibling branch", async () => {
        const ownBranchOrder = await insertOrder({region: "eg", restaurantId: RESTAURANT_ID, branchId: 20});
        const otherBranchOrder = await insertOrder({region: "eg", restaurantId: RESTAURANT_ID, branchId: 999});

        const ok = await request(app).get(`/api/orders/${ownBranchOrder.publicId}`).set("X-Region", "eg").set(authHeader(MANAGER));
        expect(ok.status).toBe(200);

        const forbidden = await request(app).get(`/api/orders/${otherBranchOrder.publicId}`).set("X-Region", "eg").set(authHeader(MANAGER));
        expect(forbidden.status).toBe(403);
    });

    it("lets system_admin read any order", async () => {
        const order = await insertOrder({region: "eg"});
        const res = await request(app).get(`/api/orders/${order.publicId}`).set("X-Region", "eg").set(authHeader(ADMIN));
        expect(res.status).toBe(200);
    });

    it("returns 404 for a well-formed but nonexistent id", async () => {
        const res = await request(app)
            .get("/api/orders/11111111-1111-1111-1111-111111111111")
            .set("X-Region", "eg")
            .set(authHeader(CUSTOMER));
        expect(res.status).toBe(404);
    });

    it("returns 404 for a malformed (non-UUID) id rather than hitting the DB", async () => {
        const res = await request(app).get("/api/orders/not-a-uuid").set("X-Region", "eg").set(authHeader(CUSTOMER));
        expect(res.status).toBe(404);
    });
});

describe("GET /api/customer/orders (pagination)", () => {
    it("paginates the customer's own orders newest-first with a working nextCursor", async () => {
        for (let i = 0; i < 3; i++) {
            await insertOrder({region: "eg", customerId: CUSTOMER.userId, createdAt: new Date(Date.now() - (3 - i) * 60_000)});
        }
        const page1 = await request(app).get("/api/customer/orders?limit=2").set("X-Region", "eg").set(authHeader(CUSTOMER));
        expect(page1.status).toBe(200);
        expect(page1.body.data).toHaveLength(2);
        expect(page1.body.meta.hasMore).toBe(true);
        expect(page1.body.meta.nextCursor).toBeTruthy();

        const page2 = await request(app)
            .get(`/api/customer/orders?limit=2&cursor=${encodeURIComponent(page1.body.meta.nextCursor)}`)
            .set("X-Region", "eg")
            .set(authHeader(CUSTOMER));
        expect(page2.status).toBe(200);
        expect(page2.body.data).toHaveLength(1);
        expect(page2.body.meta.hasMore).toBe(false);

        const seenIds = new Set([...page1.body.data, ...page2.body.data].map((o: {publicId: string}) => o.publicId));
        expect(seenIds.size).toBe(3);
    });

    it("does not return another customer's orders", async () => {
        await insertOrder({region: "eg", customerId: OTHER_CUSTOMER.userId});
        const res = await request(app).get("/api/customer/orders").set("X-Region", "eg").set(authHeader(CUSTOMER));
        expect(res.status).toBe(200);
        expect(res.body.data).toHaveLength(0);
    });
});

describe("GET /api/restaurants/:restaurantId/branches/:branchId/orders", () => {
    it("allows a branch member with orders:read to list; caches the response (X-Cache MISS then HIT)", async () => {
        coreClientStub.seedPermissions("branch_manager", ["orders:read"]);
        await insertOrder({region: "eg", restaurantId: RESTAURANT_ID, branchId: BRANCH_ID});

        const first = await request(app)
            .get(`/api/restaurants/${RESTAURANT_ID}/branches/${BRANCH_ID}/orders`)
            .set("X-Region", "eg")
            .set(authHeader(MANAGER));
        expect(first.status).toBe(200);
        expect(first.headers["x-cache"]).toBe("MISS");
        expect(first.body.data).toHaveLength(1);

        const second = await request(app)
            .get(`/api/restaurants/${RESTAURANT_ID}/branches/${BRANCH_ID}/orders`)
            .set("X-Region", "eg")
            .set(authHeader(MANAGER));
        expect(second.headers["x-cache"]).toBe("HIT");
    });

    it("denies a branch member without orders:read permission", async () => {
        coreClientStub.seedPermissions("branch_manager", []); // no orders:read
        const res = await request(app)
            .get(`/api/restaurants/${RESTAURANT_ID}/branches/${BRANCH_ID}/orders`)
            .set("X-Region", "eg")
            .set(authHeader(MANAGER));
        expect(res.status).toBe(403);
    });

    it("denies a staff member scoped to a different branch", async () => {
        coreClientStub.seedPermissions("staff", ["orders:read"]);
        const res = await request(app)
            .get(`/api/restaurants/${RESTAURANT_ID}/branches/${BRANCH_ID}/orders`)
            .set("X-Region", "eg")
            .set(authHeader(STAFF_OTHER_BRANCH));
        expect(res.status).toBe(403);
    });

    it("denies a user from a different restaurant entirely", async () => {
        const res = await request(app)
            .get(`/api/restaurants/999/branches/${BRANCH_ID}/orders`)
            .set("X-Region", "eg")
            .set(authHeader(MANAGER));
        expect(res.status).toBe(403);
    });
});

describe("PATCH status transitions", () => {
    it("lets the customer cancel their own order within the cancellation window", async () => {
        const order = await insertOrder({region: "eg", customerId: CUSTOMER.userId, status: OrderStatus.PLACED});
        const res = await request(app)
            .patch(`/api/customer/orders/${order.publicId}/status`)
            .set("X-Region", "eg")
            .set("Idempotency-Key", idemKey())
            .set(authHeader(CUSTOMER))
            .send({status: OrderStatus.CANCELLED, reason: "changed my mind"});
        expect(res.status).toBe(200);
        expect(res.body.data.status).toBe(OrderStatus.CANCELLED);

        const statusChanged = fakeIoServer.emitted.find((e) => e.event === "order.status_changed" && e.room === `customer:${CUSTOMER.userId}`);
        expect(statusChanged).toBeDefined();
        expect((statusChanged!.payload as {status: string}).status).toBe(OrderStatus.CANCELLED);
    });

    it("returns 403 when a customer tries to update an order that isn't theirs", async () => {
        const order = await insertOrder({region: "eg", customerId: OTHER_CUSTOMER.userId, status: OrderStatus.PLACED});
        const res = await request(app)
            .patch(`/api/customer/orders/${order.publicId}/status`)
            .set("X-Region", "eg")
            .set("Idempotency-Key", idemKey())
            .set(authHeader(CUSTOMER))
            .send({status: OrderStatus.CANCELLED, reason: "not mine"});
        expect(res.status).toBe(403);
    });

    it("rejects a customer cancellation after the cancel window has expired", async () => {
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

    it("rejects a customer trying to cancel an already-accepted order", async () => {
        const order = await insertOrder({region: "eg", customerId: CUSTOMER.userId, status: OrderStatus.ACCEPTED, acceptedAt: new Date()});
        const res = await request(app)
            .patch(`/api/customer/orders/${order.publicId}/status`)
            .set("X-Region", "eg")
            .set("Idempotency-Key", idemKey())
            .set(authHeader(CUSTOMER))
            .send({status: OrderStatus.CANCELLED, reason: "too late"});
        expect(res.status).toBe(409);
        expect(res.body.error).toContain("InvalidStatusTransition");
    });

    it("lets a restaurant member with orders:accept permission accept a placed order", async () => {
        coreClientStub.seedPermissions("branch_manager", ["orders:accept"]);
        const order = await insertOrder({region: "eg", restaurantId: RESTAURANT_ID, branchId: BRANCH_ID, status: OrderStatus.PLACED});
        const res = await request(app)
            .patch(`/api/restaurants/${RESTAURANT_ID}/branches/${BRANCH_ID}/orders/${order.publicId}/status`)
            .set("X-Region", "eg")
            .set("Idempotency-Key", idemKey())
            .set(authHeader(MANAGER))
            .send({status: OrderStatus.ACCEPTED});
        expect(res.status).toBe(200);
        expect(res.body.data.status).toBe(OrderStatus.ACCEPTED);
    });

    it("denies a restaurant member lacking orders:accept from accepting", async () => {
        coreClientStub.seedPermissions("branch_manager", []);
        const order = await insertOrder({region: "eg", restaurantId: RESTAURANT_ID, branchId: BRANCH_ID, status: OrderStatus.PLACED});
        const res = await request(app)
            .patch(`/api/restaurants/${RESTAURANT_ID}/branches/${BRANCH_ID}/orders/${order.publicId}/status`)
            .set("X-Region", "eg")
            .set("Idempotency-Key", idemKey())
            .set(authHeader(MANAGER))
            .send({status: OrderStatus.ACCEPTED});
        expect(res.status).toBe(403);
    });

    it("requires a reason when rejecting a placed order", async () => {
        coreClientStub.seedPermissions("branch_manager", ["orders:reject"]);
        const order = await insertOrder({region: "eg", restaurantId: RESTAURANT_ID, branchId: BRANCH_ID, status: OrderStatus.PLACED});
        const missing = await request(app)
            .patch(`/api/restaurants/${RESTAURANT_ID}/branches/${BRANCH_ID}/orders/${order.publicId}/status`)
            .set("X-Region", "eg")
            .set("Idempotency-Key", idemKey())
            .set(authHeader(MANAGER))
            .send({status: OrderStatus.REJECTED});
        expect(missing.status).toBe(400);

        const withReason = await request(app)
            .patch(`/api/restaurants/${RESTAURANT_ID}/branches/${BRANCH_ID}/orders/${order.publicId}/status`)
            .set("X-Region", "eg")
            .set("Idempotency-Key", idemKey())
            .set(authHeader(MANAGER))
            .send({status: OrderStatus.REJECTED, reason: "out of stock"});
        expect(withReason.status).toBe(200);
    });

    it("lets system_admin cancel via the admin override endpoint regardless of restaurant membership", async () => {
        const order = await insertOrder({region: "eg", status: OrderStatus.ACCEPTED, acceptedAt: new Date()});
        const res = await request(app)
            .patch(`/api/admin/orders/${order.publicId}/status`)
            .set("X-Region", "eg")
            .set("Idempotency-Key", idemKey())
            .set(authHeader(ADMIN))
            .send({status: OrderStatus.CANCELLED, reason: "admin override"});
        expect(res.status).toBe(200);
        expect(res.body.data.status).toBe(OrderStatus.CANCELLED);
    });

    it("rejects an illegal transition (e.g. delivered -> placed)", async () => {
        const order = await insertOrder({region: "eg", customerId: CUSTOMER.userId, status: OrderStatus.DELIVERED, deliveredAt: new Date()});
        const res = await request(app)
            .patch(`/api/customer/orders/${order.publicId}/status`)
            .set("X-Region", "eg")
            .set("Idempotency-Key", idemKey())
            .set(authHeader(CUSTOMER))
            .send({status: OrderStatus.PLACED});
        expect(res.status).toBe(409);
    });
});

describe("GET /api/internal/orders/history", () => {
    it("requires the internal api key", async () => {
        const res = await request(app).get("/api/internal/orders/history?region=eg&year=2026");
        expect(res.status).toBe(401);
    });

    it("returns placed-or-later orders for the (region, year), excluding pending_payment, with their line items grouped in", async () => {
        const placed = await insertOrder({region: "eg", status: OrderStatus.PLACED, createdAt: new Date(2026, 1, 1)});
        await db("eg")("order_items").insert({
            region: "eg",
            order_id: placed.id,
            product_id: 1,
            quantity: 2,
            unit_price_snapshot: 500,
            name_snapshot: "Burger",
            image_url_snapshot: null,
            line_total: 1000,
        });
        await insertOrder({region: "eg", status: OrderStatus.PENDING_PAYMENT, createdAt: new Date(2026, 1, 2)});

        const res = await request(app)
            .get("/api/internal/orders/history?region=eg&year=2026")
            .set("api-key", "test-internal-api-key");
        expect(res.status).toBe(200);
        expect(res.body.data).toHaveLength(1);
        expect(res.body.data[0].orderId).toBe(placed.publicId);
        expect(res.body.data[0].items).toEqual([
            {productId: 1, quantity: 2, unitPrice: 500, lineTotal: 1000},
        ]);
    });

    it("requires a wrong api-key be rejected with 401", async () => {
        const res = await request(app)
            .get("/api/internal/orders/history?region=eg&year=2026")
            .set("api-key", "not-the-right-key");
        expect(res.status).toBe(401);
    });
});
