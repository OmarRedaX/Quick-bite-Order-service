import {PaymentSessionStatus} from "../enums";

export class PaymentSessionEntity {
    id!: number;
    region!: string;
    orderId!: number;
    providerId!: number;
    providerSessionId!: string;
    redirectUrl!: string;
    amount!: number;
    currency!: string;
    status!: PaymentSessionStatus;
    rawInitPayload!: unknown;
    rawLastPayload!: unknown | null;
    createdAt!: Date;
    updatedAt!: Date;

    constructor(data: Partial<PaymentSessionEntity>) {
        Object.assign(this, data);
    }
}
