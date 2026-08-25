import {Knex} from "knex";
import {PaymentSessionEntity} from "../entity/payment-session.entity";
import {PaymentSessionStatus} from "../enums";
import {CreateSessionRowInput, UpdateSessionRowInput} from "../types";

export const PAYMENT_SESSION_COLUMNS = [
    "id",
    "region",
    "order_id",
    "provider_id",
    "provider_session_id",
    "redirect_url",
    "amount",
    "currency",
    "status",
    "raw_init_payload",
    "raw_last_payload",
    "created_at",
    "updated_at",
] as const;

function toEntity(row: any): PaymentSessionEntity {
    return new PaymentSessionEntity({
        id: Number(row.id),
        region: row.region,
        orderId: Number(row.order_id),
        providerId: Number(row.provider_id),
        providerSessionId: row.provider_session_id,
        redirectUrl: row.redirect_url,
        amount: Number(row.amount),
        currency: row.currency,
        status: row.status as PaymentSessionStatus,
        rawInitPayload: row.raw_init_payload,
        rawLastPayload: row.raw_last_payload,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    });
}

export async function createSession(input: CreateSessionRowInput, conn: Knex): Promise<PaymentSessionEntity> {
    const [row] = await conn("payment_sessions")
        .insert({
            region: input.region,
            order_id: input.orderId,
            provider_id: input.providerId,
            provider_session_id: input.providerSessionId,
            redirect_url: input.redirectUrl,
            amount: input.amount,
            currency: input.currency,
            status: input.status,
            raw_init_payload: JSON.stringify(input.rawInitPayload),
        })
        .returning(PAYMENT_SESSION_COLUMNS as unknown as string[]);
    return toEntity(row);
}

export async function findSessionByProviderId(providerSessionId: string, conn: Knex): Promise<PaymentSessionEntity | undefined> {
    const row = await conn("payment_sessions")
        .select(PAYMENT_SESSION_COLUMNS as unknown as string[])
        .where({provider_session_id: providerSessionId})
        .first();
    return row ? toEntity(row) : undefined;
}

export async function findActiveSessionByOrderId(orderId: number, conn: Knex): Promise<PaymentSessionEntity | undefined> {
    const row = await conn("payment_sessions")
        .select(PAYMENT_SESSION_COLUMNS as unknown as string[])
        .where("order_id", orderId)
        .whereIn("status", [PaymentSessionStatus.INITIALIZED, PaymentSessionStatus.PENDING])
        .orderBy("id", "desc")
        .first();
    return row ? toEntity(row) : undefined;
}

export async function updateSession(id: number, input: UpdateSessionRowInput, conn: Knex): Promise<PaymentSessionEntity> {
    const update: Record<string, unknown> = {
        status: input.status,
        updated_at: conn.fn.now(),
    };
    if (input.rawLastPayload !== undefined) {
        update.raw_last_payload = JSON.stringify(input.rawLastPayload);
    }
    const [row] = await conn("payment_sessions")
        .where({id})
        .update(update)
        .returning(PAYMENT_SESSION_COLUMNS as unknown as string[]);
    return toEntity(row);
}
