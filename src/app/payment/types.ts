import {PaymentSessionStatus, TransactionType, TransactionMethod, TransactionStatus} from "./enums";

export interface CreateSessionRowInput {
    region: string;
    orderId: number;
    providerId: number;
    providerSessionId: string;
    redirectUrl: string;
    amount: number;
    currency: string;
    status: PaymentSessionStatus;
    rawInitPayload: unknown;
}

export interface UpdateSessionRowInput {
    status: PaymentSessionStatus;
    rawLastPayload?: unknown;
}

export interface CreateTransactionInput {
    region: string;
    orderId: number | null;
    transactionType: TransactionType;
    method: TransactionMethod;
    providerId: number | null;
    providerReferenceId: string | null;
    status: TransactionStatus;
    amount: number;
    currency: string;
    srcAccId: number | null;
    dstAccId: number | null;
    idempotencyKey: string | null;
}

export interface RecordWebhookInput {
    region: string;
    providerId: number;
    providerEventId: string;
    signature: string;
    payload: unknown;
}
