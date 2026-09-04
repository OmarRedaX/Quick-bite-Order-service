import "reflect-metadata";
import {validateBody} from "../../../src/lib/validation/validate";
import {PresenceLocationRequestDTO} from "../../../src/app/agent/dto/agent.request.dto";
import {
    DeliveryTaskResponseDTO,
    AgentEarningItemDTO,
    AgentEarningsResponseDTO,
} from "../../../src/app/agent/dto/agent.response.dto";
import {OrderEntity} from "../../../src/app/order/entity/order.entity";
import {OrderStatus, PaymentMethod, Currency} from "../../../src/app/order/enums";
import {AgentEarningEntity} from "../../../src/app/agent/entity/agent-earning.entity";

describe("PresenceLocationRequestDTO", () => {
    it("accepts a valid lat/lng pair", async () => {
        const dto = await validateBody(PresenceLocationRequestDTO, {lat: 30.05, lng: 31.24});
        expect(dto.lat).toBe(30.05);
        expect(dto.lng).toBe(31.24);
    });

    it.each([90, -90])("accepts latitude at the boundary (%p)", async (lat) => {
        await expect(
            validateBody(PresenceLocationRequestDTO, {lat, lng: 0}),
        ).resolves.toBeInstanceOf(PresenceLocationRequestDTO);
    });

    it.each([90.0001, -90.0001])("rejects latitude outside [-90,90] (%p)", async (lat) => {
        await expect(
            validateBody(PresenceLocationRequestDTO, {lat, lng: 0}),
        ).rejects.toMatchObject({statusCode: 400});
    });

    it.each([180, -180])("accepts longitude at the boundary (%p)", async (lng) => {
        await expect(
            validateBody(PresenceLocationRequestDTO, {lat: 0, lng}),
        ).resolves.toBeInstanceOf(PresenceLocationRequestDTO);
    });

    it.each([180.0001, -180.0001])("rejects longitude outside [-180,180] (%p)", async (lng) => {
        await expect(
            validateBody(PresenceLocationRequestDTO, {lat: 0, lng}),
        ).rejects.toMatchObject({statusCode: 400});
    });

    it("rejects non-numeric coordinates", async () => {
        await expect(
            validateBody(PresenceLocationRequestDTO, {lat: "north", lng: 0}),
        ).rejects.toMatchObject({statusCode: 400});
    });
});

function buildOrder(overrides: Partial<OrderEntity> = {}): OrderEntity {
    return new OrderEntity({
        id: 1,
        region: "eg",
        publicId: "22222222-2222-2222-2222-222222222222",
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
        status: OrderStatus.ASSIGNED,
        subtotal: 1000,
        deliveryFee: 200,
        serviceFee: 50,
        total: 1250,
        commission: 100,
        currency: Currency.EGP,
        paymentMethod: PaymentMethod.COD,
        deliveryAgentId: 77,
        createdAt: new Date("2026-01-01T10:00:00.000Z"),
        updatedAt: new Date("2026-01-01T10:00:00.000Z"),
        acceptedAt: null,
        rejectedAt: null,
        readyAt: null,
        assignedAt: new Date("2026-01-01T10:10:00.000Z"),
        pickedAt: null,
        deliveredAt: null,
        cancelledAt: null,
        ...overrides,
    });
}

describe("DeliveryTaskResponseDTO.from", () => {
    it("fills pickup fields from the branch when provided", () => {
        const branch = {lat: 30.0, lng: 31.0, name: "Downtown Branch", addressText: "Branch St"};
        const dto = DeliveryTaskResponseDTO.from(buildOrder(), branch);
        expect(dto.pickup).toEqual({branchId: 20, lat: 30.0, lng: 31.0, name: "Downtown Branch", addressText: "Branch St"});
    });

    it("nulls pickup lat/lng/name/addressText when branch is not provided", () => {
        const dto = DeliveryTaskResponseDTO.from(buildOrder());
        expect(dto.pickup).toEqual({branchId: 20, lat: null, lng: null, name: null, addressText: null});
    });

    it("omits customer PII, exposing only dropoff coordinates and address text", () => {
        const dto = DeliveryTaskResponseDTO.from(buildOrder());
        expect(dto.dropoff).toEqual({lat: 30.1, lng: 31.2, addressText: "123 Test St"});
        expect(Object.keys(dto)).not.toContain("customerId");
    });

    it("nulls lifecycle timestamps that have not happened yet", () => {
        const dto = DeliveryTaskResponseDTO.from(buildOrder());
        expect(dto.assignedAt).toBe("2026-01-01T10:10:00.000Z");
        expect(dto.pickedAt).toBeNull();
        expect(dto.deliveredAt).toBeNull();
    });
});

describe("AgentEarningItemDTO.from", () => {
    it("maps an earning entity to its public shape", () => {
        const entity = new AgentEarningEntity({
            id: 1,
            region: "eg",
            agentId: 5,
            orderId: 9,
            amount: 160,
            currency: "EGP",
            earnedAt: new Date("2026-01-02T12:00:00.000Z"),
        });
        const dto = AgentEarningItemDTO.from(entity);
        expect(dto).toEqual({orderId: 9, amount: 160, currency: "EGP", earnedAt: "2026-01-02T12:00:00.000Z"});
    });
});

describe("AgentEarningsResponseDTO.from", () => {
    const from = new Date("2026-01-01T00:00:00.000Z");
    const to = new Date("2026-01-31T23:59:59.999Z");

    it("summarizes totals and currency from the item list", () => {
        const items = [
            new AgentEarningEntity({id: 1, region: "eg", agentId: 5, orderId: 1, amount: 100, currency: "EGP", earnedAt: from}),
            new AgentEarningEntity({id: 2, region: "eg", agentId: 5, orderId: 2, amount: 200, currency: "EGP", earnedAt: from}),
        ];
        const dto = AgentEarningsResponseDTO.from(from, to, items, 300);
        expect(dto.range).toEqual({from: from.toISOString(), to: to.toISOString()});
        expect(dto.totals).toEqual({count: 2, sum: 300, currency: "EGP"});
        expect(dto.items).toHaveLength(2);
    });

    it("reports a null currency and zero count for an empty item list", () => {
        const dto = AgentEarningsResponseDTO.from(from, to, [], 0);
        expect(dto.totals).toEqual({count: 0, sum: 0, currency: null});
        expect(dto.items).toEqual([]);
    });
});
