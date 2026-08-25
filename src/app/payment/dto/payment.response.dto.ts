import {TransactionEntity} from "../entity/transaction.entity";
import {PaymentSessionEntity} from "../entity/payment-session.entity";
import {TransactionType, TransactionMethod, TransactionStatus, PaymentProviderName, PAYMENT_PROVIDER_IDS} from "../enums";

/**
 * Returned in the `payment` field of OrderResponseDTO when the order's
 * paymentMethod is "online" and Kashier successfully created a session.
 */
export class PaymentInitResponseDTO {
    sessionId!: string;          // our payment_sessions.id (numeric → string for JSON safety)
    providerSessionId!: string;  // Kashier's _id
    redirectUrl!: string;
    amount!: number;
    currency!: string;
    expiresAt!: string;          // ISO

    static from(session: PaymentSessionEntity, expiresAt: string): PaymentInitResponseDTO {
        const dto = new PaymentInitResponseDTO();
        dto.sessionId = String(session.id);
        dto.providerSessionId = session.providerSessionId;
        dto.redirectUrl = session.redirectUrl;
        dto.amount = session.amount;
        dto.currency = session.currency;
        dto.expiresAt = expiresAt;
        return dto;
    }
}

const PROVIDER_NAME_BY_ID = new Map<number, PaymentProviderName>([
    [PAYMENT_PROVIDER_IDS[PaymentProviderName.KASHIER], PaymentProviderName.KASHIER],
    [PAYMENT_PROVIDER_IDS[PaymentProviderName.COD], PaymentProviderName.COD],
]);

export class PaymentResponseDTO {
    id!: number;
    orderId!: number | null;
    type!: TransactionType;
    method!: TransactionMethod;
    provider!: PaymentProviderName | null;
    providerReferenceId!: string | null;
    status!: TransactionStatus;
    amount!: number;
    currency!: string;
    isRefunded!: boolean;
    refundedPaymentId!: number | null;
    createdAt!: string;
    updatedAt!: string;

    static from(tx: TransactionEntity): PaymentResponseDTO {
        const dto = new PaymentResponseDTO();
        dto.id = tx.id;
        dto.orderId = tx.orderId;
        dto.type = tx.transactionType;
        dto.method = tx.method;
        dto.provider = tx.providerId !== null ? PROVIDER_NAME_BY_ID.get(tx.providerId) ?? null : null;
        dto.providerReferenceId = tx.providerReferenceId;
        dto.status = tx.status;
        dto.amount = tx.amount;
        dto.currency = tx.currency;
        dto.isRefunded = tx.isRefunded;
        dto.refundedPaymentId = tx.refundedPaymentId;
        dto.createdAt = tx.createdAt.toISOString();
        dto.updatedAt = tx.updatedAt.toISOString();
        return dto;
    }
}
