import "reflect-metadata";
import {validateBody} from "../../../src/lib/validation/validate";
import {CreatePayoutRequestDTO} from "../../../src/app/finance/dto/finance.request.dto";
import {
    RestaurantBalanceResponseDTO,
    PayoutResponseDTO,
} from "../../../src/app/finance/dto/finance.response.dto";
import {RestaurantBalanceEntity} from "../../../src/app/finance/entity/restaurant-balance.entity";
import {TransactionEntity} from "../../../src/app/payment/entity/transaction.entity";
import {TransactionType, TransactionMethod, TransactionStatus} from "../../../src/app/payment/enums";

const validPayoutBody = {
    restaurantId: 1,
    amount: 5000,
    currency: "EGP",
    providerReferenceId: "ref-123",
};

describe("CreatePayoutRequestDTO", () => {
    it("accepts a valid payout request", async () => {
        const dto = await validateBody(CreatePayoutRequestDTO, validPayoutBody);
        expect(dto.amount).toBe(5000);
    });

    it.each([0, -1])("rejects a non-positive amount (%p)", async (amount) => {
        await expect(
            validateBody(CreatePayoutRequestDTO, {...validPayoutBody, amount}),
        ).rejects.toMatchObject({statusCode: 400});
    });

    it("rejects a currency shorter than 2 characters", async () => {
        await expect(
            validateBody(CreatePayoutRequestDTO, {...validPayoutBody, currency: "E"}),
        ).rejects.toMatchObject({statusCode: 400});
    });

    it("rejects a currency longer than 8 characters", async () => {
        await expect(
            validateBody(CreatePayoutRequestDTO, {...validPayoutBody, currency: "TOOLONGCUR"}),
        ).rejects.toMatchObject({statusCode: 400});
    });

    it("rejects an empty providerReferenceId", async () => {
        await expect(
            validateBody(CreatePayoutRequestDTO, {...validPayoutBody, providerReferenceId: ""}),
        ).rejects.toMatchObject({statusCode: 400});
    });

    it("rejects a note over 500 characters", async () => {
        await expect(
            validateBody(CreatePayoutRequestDTO, {...validPayoutBody, note: "x".repeat(501)}),
        ).rejects.toMatchObject({statusCode: 400});
    });

    it("accepts an omitted note", async () => {
        const dto = await validateBody(CreatePayoutRequestDTO, validPayoutBody);
        expect(dto.note).toBeUndefined();
    });
});

describe("RestaurantBalanceResponseDTO.from", () => {
    it("maps balance rows for a restaurant, one entry per currency", () => {
        const rows = [
            new RestaurantBalanceEntity({restaurantId: 1, region: "eg", currency: "EGP", balance: 15000, updatedAt: new Date()}),
            new RestaurantBalanceEntity({restaurantId: 1, region: "ksa", currency: "SAR", balance: 8000, updatedAt: new Date()}),
        ];
        const dto = RestaurantBalanceResponseDTO.from(1, rows);
        expect(dto.restaurantId).toBe(1);
        expect(dto.balances).toEqual([
            {currency: "EGP", balance: 15000},
            {currency: "SAR", balance: 8000},
        ]);
        expect(typeof dto.asOf).toBe("string");
    });

    it("returns an empty balances array with no rows", () => {
        const dto = RestaurantBalanceResponseDTO.from(1, []);
        expect(dto.balances).toEqual([]);
    });
});

describe("PayoutResponseDTO.from", () => {
    it("maps a payout transaction to its public shape", () => {
        const tx = new TransactionEntity({
            id: 1,
            region: "eg",
            orderId: null,
            transactionType: TransactionType.PAYOUT,
            method: TransactionMethod.BANK_TRANSFER,
            providerId: null,
            providerReferenceId: "bank-ref-1",
            status: TransactionStatus.SUCCEEDED,
            amount: 5000,
            currency: "EGP",
            srcAccId: null,
            dstAccId: null,
            isRefunded: false,
            refundedPaymentId: null,
            idempotencyKey: null,
            createdAt: new Date("2026-02-01T00:00:00.000Z"),
            updatedAt: new Date("2026-02-01T00:00:00.000Z"),
        });
        const dto = PayoutResponseDTO.from(tx);
        expect(dto).toEqual({
            id: 1,
            amount: 5000,
            currency: "EGP",
            status: TransactionStatus.SUCCEEDED,
            providerReferenceId: "bank-ref-1",
            createdAt: "2026-02-01T00:00:00.000Z",
        });
    });

    it("does not leak internal-only fields (srcAccId, dstAccId, idempotencyKey)", () => {
        const tx = new TransactionEntity({
            id: 2,
            region: "eg",
            orderId: null,
            transactionType: TransactionType.PAYOUT,
            method: TransactionMethod.BANK_TRANSFER,
            providerId: null,
            providerReferenceId: null,
            status: TransactionStatus.PENDING,
            amount: 1000,
            currency: "EGP",
            srcAccId: 7,
            dstAccId: 8,
            isRefunded: false,
            refundedPaymentId: null,
            idempotencyKey: "idem-key",
            createdAt: new Date(),
            updatedAt: new Date(),
        });
        const keys = Object.keys(PayoutResponseDTO.from(tx));
        expect(keys).not.toContain("srcAccId");
        expect(keys).not.toContain("dstAccId");
        expect(keys).not.toContain("idempotencyKey");
    });
});
