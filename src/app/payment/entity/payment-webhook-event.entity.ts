export class PaymentWebhookEventEntity {
    id!: number;
    region!: string;
    providerId!: number;
    providerEventId!: string;
    signature!: string;
    payload!: unknown;
    receivedAt!: Date;
    processedAt!: Date | null;
    processError!: string | null;

    constructor(data: Partial<PaymentWebhookEventEntity>) {
        Object.assign(this, data);
    }
}
