import "reflect-metadata";
import {validateBody} from "../../../src/lib/validation/validate";
import {
    CreateOrderRequestDTO,
    UpdateOrderStatusRequestDTO,
} from "../../../src/app/order/dto/order.request.dto";
import {
    OrderResponseDTO,
    OrderItemResponseDTO,
    OrderSummaryResponseDTO,
    OrderStatusResponseDTO,
    OrderDetailResponseDTO,
} from "../../../src/app/order/dto/order.response.dto";
import {OrderEntity} from "../../../src/app/order/entity/order.entity";
import {OrderItemEntity} from "../../../src/app/order/entity/order-item.entity";
import {OrderStatus, PaymentMethod, Currency} from "../../../src/app/order/enums";

const validCreateBody = {
    branchId: 1,
    customerAddressId: 1,
    paymentMethod: PaymentMethod.COD,
    items: [{productId: 1, quantity: 2}],
};

describe("CreateOrderRequestDTO", () => {
    it("accepts a valid body", async () => {
        const dto = await validateBody(CreateOrderRequestDTO, validCreateBody);
        expect(dto.items).toHaveLength(1);
        expect(dto.items[0]).toBeInstanceOf(Object);
    });

    it("rejects an empty items array", async () => {
        await expect(
            validateBody(CreateOrderRequestDTO, {...validCreateBody, items: []}),
        ).rejects.toMatchObject({statusCode: 400});
    });

    it("rejects a paymentMethod outside the enum", async () => {
        await expect(
            validateBody(CreateOrderRequestDTO, {...validCreateBody, paymentMethod: "bitcoin"}),
        ).rejects.toMatchObject({statusCode: 400});
    });

    it.each([0, -1])("rejects branchId <= 0 (%p)", async (branchId) => {
        await expect(
            validateBody(CreateOrderRequestDTO, {...validCreateBody, branchId}),
        ).rejects.toMatchObject({statusCode: 400});
    });

    it("rejects a non-integer branchId", async () => {
        await expect(
            validateBody(CreateOrderRequestDTO, {...validCreateBody, branchId: 1.5}),
        ).rejects.toMatchObject({statusCode: 400});
    });

    it.each([0, 51])("rejects item quantity outside [1,50] (%p)", async (quantity) => {
        await expect(
            validateBody(CreateOrderRequestDTO, {
                ...validCreateBody,
                items: [{productId: 1, quantity}],
            }),
        ).rejects.toMatchObject({statusCode: 400});
    });

    it.each([1, 50])("accepts item quantity at the boundary (%p)", async (quantity) => {
        const dto = await validateBody(CreateOrderRequestDTO, {
            ...validCreateBody,
            items: [{productId: 1, quantity}],
        });
        expect(dto.items[0].quantity).toBe(quantity);
    });

    it("rejects a nested item missing productId", async () => {
        await expect(
            validateBody(CreateOrderRequestDTO, {
                ...validCreateBody,
                items: [{quantity: 1}],
            }),
        ).rejects.toMatchObject({statusCode: 400});
    });
});

describe("UpdateOrderStatusRequestDTO", () => {
    it("accepts a valid status with no reason", async () => {
        const dto = await validateBody(UpdateOrderStatusRequestDTO, {
            status: OrderStatus.ACCEPTED,
        });
        expect(dto.status).toBe(OrderStatus.ACCEPTED);
        expect(dto.reason).toBeUndefined();
    });

    it("accepts an optional reason", async () => {
        const dto = await validateBody(UpdateOrderStatusRequestDTO, {
            status: OrderStatus.REJECTED,
            reason: "out of stock",
        });
        expect(dto.reason).toBe("out of stock");
    });

    it("rejects a status outside the enum", async () => {
        await expect(
            validateBody(UpdateOrderStatusRequestDTO, {status: "teleported"}),
        ).rejects.toMatchObject({statusCode: 400});
    });

    it("rejects a reason over 500 characters", async () => {
        await expect(
            validateBody(UpdateOrderStatusRequestDTO, {
                status: OrderStatus.REJECTED,
                reason: "x".repeat(501),
            }),
        ).rejects.toMatchObject({statusCode: 400});
    });

    it("accepts a reason at exactly 500 characters", async () => {
        const dto = await validateBody(UpdateOrderStatusRequestDTO, {
            status: OrderStatus.REJECTED,
            reason: "x".repeat(500),
        });
        expect(dto.reason).toHaveLength(500);
    });
});

function buildOrder(overrides: Partial<OrderEntity> = {}): OrderEntity {
    return new OrderEntity({
        id: 1,
        region: "eg",
        publicId: "11111111-1111-1111-1111-111111111111",
        countryCode: "EG",
        restaurantId: 10,
        restaurantOwnerId: 99,
        branchId: 20,
        customerId: 30,
        customerAddressId: 40,
        deliveryLat: 30.1,
        deliveryLng: 31.2,
        deliveryAddressTextSnapshot: "123 Test St",
        branchLat: 30.0,
        branchLng: 31.0,
        status: OrderStatus.PLACED,
        subtotal: 1000,
        deliveryFee: 200,
        serviceFee: 50,
        total: 1250,
        commission: 100,
        currency: Currency.EGP,
        paymentMethod: PaymentMethod.COD,
        deliveryAgentId: null,
        createdAt: new Date("2026-01-01T10:00:00.000Z"),
        updatedAt: new Date("2026-01-01T10:00:00.000Z"),
        acceptedAt: null,
        rejectedAt: null,
        readyAt: null,
        assignedAt: null,
        pickedAt: null,
        deliveredAt: null,
        cancelledAt: null,
        ...overrides,
    });
}

function buildItem(overrides: Partial<OrderItemEntity> = {}): OrderItemEntity {
    return new OrderItemEntity({
        id: 1,
        region: "eg",
        orderId: 1,
        productId: 5,
        quantity: 2,
        unitPriceSnapshot: 500,
        nameSnapshot: "Burger",
        imageUrlSnapshot: "https://example.com/burger.png",
        lineTotal: 1000,
        createdAt: new Date("2026-01-01T10:00:00.000Z"),
        ...overrides,
    });
}

describe("OrderItemResponseDTO.from", () => {
    it("maps an item entity to its public shape", () => {
        const dto = OrderItemResponseDTO.from(buildItem());
        expect(dto).toEqual({
            productId: 5,
            name: "Burger",
            imageUrl: "https://example.com/burger.png",
            quantity: 2,
            unitPrice: 500,
            lineTotal: 1000,
        });
    });
});

describe("OrderResponseDTO.from", () => {
    it("maps an order + items to the public response shape", () => {
        const order = buildOrder();
        const items = [buildItem()];
        const dto = OrderResponseDTO.from(order, items);

        expect(dto.publicId).toBe(order.publicId);
        expect(dto.status).toBe(OrderStatus.PLACED);
        expect(dto.branch).toEqual({id: 20});
        expect(dto.restaurant).toEqual({id: 10});
        expect(dto.customerAddress).toEqual({
            lat: 30.1,
            lng: 31.2,
            addressText: "123 Test St",
        });
        expect(dto.createdAt).toBe("2026-01-01T10:00:00.000Z");
        expect(dto.items).toHaveLength(1);
        expect(dto.payment).toBeUndefined();
    });

    it("does not leak internal-only fields (region, restaurantOwnerId, customerId, commission)", () => {
        const dto = OrderResponseDTO.from(buildOrder(), []);
        const keys = Object.keys(dto);
        expect(keys).not.toContain("region");
        expect(keys).not.toContain("restaurantOwnerId");
        expect(keys).not.toContain("customerId");
        expect(keys).not.toContain("commission");
    });

    it("includes payment info only when provided", () => {
        const payment = {
            sessionId: "1",
            providerSessionId: "prov-1",
            redirectUrl: "https://pay.example.com/session/1",
            expiresAt: "2026-01-01T10:15:00.000Z",
        };
        const dto = OrderResponseDTO.from(buildOrder(), [], payment);
        expect(dto.payment).toEqual(payment);
    });
});

describe("OrderSummaryResponseDTO.from", () => {
    it("maps order + itemsCount without full item detail", () => {
        const dto = OrderSummaryResponseDTO.from(buildOrder(), 3);
        expect(dto.itemsCount).toBe(3);
        expect(dto).not.toHaveProperty("items");
    });
});

describe("OrderStatusResponseDTO.from", () => {
    it("maps only the id/status/updatedAt fields", () => {
        const order = buildOrder({status: OrderStatus.ACCEPTED});
        const dto = OrderStatusResponseDTO.from(order);
        expect(dto).toEqual({
            publicId: order.publicId,
            status: OrderStatus.ACCEPTED,
            updatedAt: "2026-01-01T10:00:00.000Z",
        });
    });
});

describe("OrderDetailResponseDTO.from", () => {
    it("includes an ordered history entry per reached status", () => {
        const order = buildOrder({
            status: OrderStatus.DELIVERED,
            acceptedAt: new Date("2026-01-01T10:05:00.000Z"),
            readyAt: new Date("2026-01-01T10:20:00.000Z"),
            assignedAt: new Date("2026-01-01T10:22:00.000Z"),
            pickedAt: new Date("2026-01-01T10:30:00.000Z"),
            deliveredAt: new Date("2026-01-01T10:45:00.000Z"),
        });
        const dto = OrderDetailResponseDTO.from(order, []);
        expect(dto.history.map((h) => h.status)).toEqual([
            OrderStatus.PLACED,
            OrderStatus.ACCEPTED,
            OrderStatus.READY,
            OrderStatus.ASSIGNED,
            OrderStatus.PICKED,
            OrderStatus.DELIVERED,
        ]);
    });

    it("emits both pending_payment and placed history for an online order", () => {
        const order = buildOrder({paymentMethod: PaymentMethod.ONLINE});
        const dto = OrderDetailResponseDTO.from(order, []);
        expect(dto.history.map((h) => h.status)).toEqual([
            OrderStatus.PENDING_PAYMENT,
            OrderStatus.PLACED,
        ]);
    });

    it("omits history entries for timestamps that were never set", () => {
        const dto = OrderDetailResponseDTO.from(buildOrder(), []);
        expect(dto.history).toEqual([{status: OrderStatus.PLACED, ts: "2026-01-01T10:00:00.000Z"}]);
    });
});
