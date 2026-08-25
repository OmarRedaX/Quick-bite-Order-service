export enum PaymentSessionStatus {
    INITIALIZED = "initialized",
    PENDING = "pending",
    AUTHORIZED = "authorized",
    CAPTURED = "captured",
    FAILED = "failed",
    EXPIRED = "expired",
    CANCELLED = "cancelled",
}

export enum TransactionType {
    CHARGE = "charge",
    REFUND = "refund",
    COMMISSION = "commission",
    PAYOUT = "payout",
    COD_COLLECTION = "cod_collection",
    ADJUSTMENT = "adjustment",
}

export enum TransactionMethod {
    ONLINE = "online",
    COD = "cod",
    BANK_TRANSFER = "bank_transfer",
    SYSTEM = "system",
}

export enum TransactionStatus {
    PENDING = "pending",
    SUCCEEDED = "succeeded",
    FAILED = "failed",
    REVERSED = "reversed",
}

export enum PaymentProviderName {
    KASHIER = "kashier",
    COD = "cod",
}

export const PAYMENT_PROVIDER_IDS = {
    [PaymentProviderName.KASHIER]: 1,
    [PaymentProviderName.COD]: 2,
} as const;
