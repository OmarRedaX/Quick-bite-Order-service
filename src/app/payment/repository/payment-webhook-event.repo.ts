import {Knex} from "knex";
import {PaymentWebhookEventEntity} from "../entity/payment-webhook-event.entity";
import {RecordWebhookInput} from "../types";

export const WEBHOOK_EVENT_COLUMNS = [
    "id",
    "region",
    "provider_id",
    "provider_event_id",
    "signature",
    "payload",
    "received_at",
    "processed_at",
    "process_error",
] as const;

function toEntity(row: any): PaymentWebhookEventEntity {
    return new PaymentWebhookEventEntity({
        id: Number(row.id),
        region: row.region,
        providerId: Number(row.provider_id),
        providerEventId: row.provider_event_id,
        signature: row.signature,
        payload: row.payload,
        receivedAt: row.received_at,
        processedAt: row.processed_at,
        processError: row.process_error,
    });
}

/**
 * Returns the inserted row, or `undefined` if a row with the same
 * (provider_id, provider_event_id) already exists. Caller MUST treat
 * `undefined` as "duplicate, ack the webhook with 200 and skip processing".
 */
export async function recordWebhookOrSkip(input: RecordWebhookInput, conn: Knex): Promise<PaymentWebhookEventEntity | undefined> {
    const rows = await conn("payment_webhook_events")
        .insert({
            region: input.region,
            provider_id: input.providerId,
            provider_event_id: input.providerEventId,
            signature: input.signature,
            payload: JSON.stringify(input.payload),
        })
        .onConflict(["provider_id", "provider_event_id"])
        .ignore()
        .returning(WEBHOOK_EVENT_COLUMNS as unknown as string[]);
    if (rows.length === 0) return undefined;
    return toEntity(rows[0]);
}

export async function markWebhookProcessed(id: number, error: string | null, conn: Knex): Promise<void> {
    await conn("payment_webhook_events")
        .where({id})
        .update({
            processed_at: conn.fn.now(),
            process_error: error,
        });
}
