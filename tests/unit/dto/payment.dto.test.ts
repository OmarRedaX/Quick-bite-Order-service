import "reflect-metadata";
import {
    PaymentInitResponseDTO,
    PaymentResponseDTO,
} from "../../../src/app/payment/dto/payment.response.dto";
import {PaymentSessionEntity} from "../../../src/app/payment/entity/payment-session.entity";
import {TransactionEntity} from "../../../src/app/payment/entity/transaction.entity";
import {
    PaymentSessionStatus,
    TransactionType,
    TransactionMethod,
    TransactionStatus,
    PaymentProviderName,
    PAYMENT_PROVIDER_IDS,
} from "../../../src/app/payment/enums";

describe("PaymentInitResponseDTO.from", () => {
    it("maps a payment session to its public shape, stringifying the numeric id", () => {
        const session = new PaymentSessionEntity({
            id: 123,
            region: "eg",
            orderId: 1,
            providerId: PAYMENT_PROVIDER_IDS[PaymentProviderName.KASHIER],
            providerSessionId: "kashier-sess-1",
            redirectUrl: "https://checkout.kashier.io/sess-1",
            amount: 1250,
            currency: "EGP",
            status: PaymentSessionStatus.INITIALIZED,
            rawInitPayload: {},
            rawLastPayload: null,
            createdAt: new Date(),
            updatedAt: new Date(),
        });
        const dto = PaymentInitResponseDTO.from(session, "2026-01-01T10:15:00.000Z");
        expect(dto).toEqual({
            sessionId: "123",
            providerSessionId: "kashier-sess-1",
            redirectUrl: "https://checkout.kashier.io/sess-1",
            amount: 1250,
            currency: "EGP",
            expiresAt: "2026-01-01T10:15:00.000Z",
        });
        expect(typeof dto.sessionId).toBe("string");
    });
});

function buildTransaction(overrides: Partial<TransactionEntity> = {}): TransactionEntity {
    return new TransactionEntity({
        id: 1,
        region: "eg",
        orderId: 5,
        transactionType: TransactionType.CHARGE,
        method: TransactionMethod.ONLINE,
        providerId: PAYMENT_PROVIDER_IDS[PaymentProviderName.KASHIER],
        providerReferenceId: "kashier-ref-1",
        status: TransactionStatus.SUCCEEDED,
        amount: 1250,
        currency: "EGP",
        srcAccId: null,
        dstAccId: null,
        isRefunded: false,
        refundedPaymentId: null,
        idempotencyKey: "idem-1",
        createdAt: new Date("2026-01-01T10:00:00.000Z"),
        updatedAt: new Date("2026-01-01T10:00:00.000Z"),
        ...overrides,
    });
}

describe("PaymentResponseDTO.from", () => {
    it("resolves the Kashier provider id to its public provider name", () => {
        const dto = PaymentResponseDTO.from(buildTransaction());
        expect(dto.provider).toBe(PaymentProviderName.KASHIER);
    });

    it("resolves the COD provider id to its public provider name", () => {
        const dto = PaymentResponseDTO.from(
            buildTransaction({providerId: PAYMENT_PROVIDER_IDS[PaymentProviderName.COD]}),
        );
        expect(dto.provider).toBe(PaymentProviderName.COD);
    });

    it("maps a null providerId to a null provider", () => {
        const dto = PaymentResponseDTO.from(buildTransaction({providerId: null}));
        expect(dto.provider).toBeNull();
    });

    it("maps an unknown providerId to a null provider rather than throwing", () => {
        const dto = PaymentResponseDTO.from(buildTransaction({providerId: 999}));
        expect(dto.provider).toBeNull();
    });

    it("does not leak internal-only fields (srcAccId, dstAccId, idempotencyKey)", () => {
        const keys = Object.keys(PaymentResponseDTO.from(buildTransaction()));
        expect(keys).not.toContain("srcAccId");
        expect(keys).not.toContain("dstAccId");
        expect(keys).not.toContain("idempotencyKey");
    });

    it("surfaces refund linkage fields", () => {
        const dto = PaymentResponseDTO.from(
            buildTransaction({isRefunded: true, refundedPaymentId: 42}),
        );
        expect(dto.isRefunded).toBe(true);
        expect(dto.refundedPaymentId).toBe(42);
    });
});
