import {Knex} from "knex";
import {TransactionEntity} from "../entity/transaction.entity";
import {TransactionType, TransactionMethod, TransactionStatus} from "../enums";
import {CreateTransactionInput} from "../types";

export const TRANSACTION_COLUMNS = [
    "id",
    "region",
    "order_id",
    "transaction_type",
    "method",
    "provider_id",
    "provider_reference_id",
    "status",
    "amount",
    "currency",
    "src_acc_id",
    "dst_acc_id",
    "is_refunded",
    "refunded_payment_id",
    "idempotency_key",
    "created_at",
    "updated_at",
] as const;

function toEntity(row: any): TransactionEntity {
    return new TransactionEntity({
        id: Number(row.id),
        region: row.region,
        orderId: row.order_id !== null && row.order_id !== undefined ? Number(row.order_id) : null,
        transactionType: row.transaction_type as TransactionType,
        method: row.method as TransactionMethod,
        providerId: row.provider_id !== null && row.provider_id !== undefined ? Number(row.provider_id) : null,
        providerReferenceId: row.provider_reference_id,
        status: row.status as TransactionStatus,
        amount: Number(row.amount),
        currency: row.currency,
        srcAccId: row.src_acc_id !== null && row.src_acc_id !== undefined ? Number(row.src_acc_id) : null,
        dstAccId: row.dst_acc_id !== null && row.dst_acc_id !== undefined ? Number(row.dst_acc_id) : null,
        isRefunded: !!row.is_refunded,
        refundedPaymentId: row.refunded_payment_id !== null && row.refunded_payment_id !== undefined ? Number(row.refunded_payment_id) : null,
        idempotencyKey: row.idempotency_key,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    });
}

export async function createTransaction(input: CreateTransactionInput, conn: Knex): Promise<TransactionEntity> {
    const [row] = await conn("transactions")
        .insert({
            region: input.region,
            order_id: input.orderId,
            transaction_type: input.transactionType,
            method: input.method,
            provider_id: input.providerId,
            provider_reference_id: input.providerReferenceId,
            status: input.status,
            amount: input.amount,
            currency: input.currency,
            src_acc_id: input.srcAccId,
            dst_acc_id: input.dstAccId,
            idempotency_key: input.idempotencyKey,
        })
        .returning(TRANSACTION_COLUMNS as unknown as string[]);
    return toEntity(row);
}

/**
 * Idempotent insert keyed off `idempotency_key`. Returns the inserted row, or
 * `undefined` if a row with that key already existed (the caller can then
 * decide to treat that as success without doing the side-effects again).
 *
 * Used for: commission and cod_collection writes during the `delivered`
 * settlement trx, so a re-run never double-charges/-credits.
 */
export async function createTransactionIdempotent(input: CreateTransactionInput, conn: Knex): Promise<TransactionEntity | undefined> {
    const rows = await conn("transactions")
        .insert({
            region: input.region,
            order_id: input.orderId,
            transaction_type: input.transactionType,
            method: input.method,
            provider_id: input.providerId,
            provider_reference_id: input.providerReferenceId,
            status: input.status,
            amount: input.amount,
            currency: input.currency,
            src_acc_id: input.srcAccId,
            dst_acc_id: input.dstAccId,
            idempotency_key: input.idempotencyKey,
        })
        .onConflict("idempotency_key")
        .ignore()
        .returning(TRANSACTION_COLUMNS as unknown as string[]);
    if (rows.length === 0) return undefined;
    return toEntity(rows[0]);
}

export async function findTransactionById(id: number, conn: Knex): Promise<TransactionEntity | undefined> {
    const row = await conn("transactions")
        .select(TRANSACTION_COLUMNS as unknown as string[])
        .where({id})
        .first();
    return row ? toEntity(row) : undefined;
}

export interface TransactionWithOwner {
    transaction: TransactionEntity;
    /** The owning order's restaurant id (NULL for txs not tied to an order, e.g. payouts). */
    restaurantId: number | null;
}

/**
 * Single round-trip: load the transaction and its order's restaurant_id so
 * the controller-level requireRestaurantMember middleware can be paired with
 * a service-level "this payment really belongs to that restaurant" check
 * without a second SQL.
 */
export async function findTransactionWithRestaurant(id: number, conn: Knex): Promise<TransactionWithOwner | undefined> {
    const row = await conn("transactions as t")
        .leftJoin("orders as o", "o.id", "t.order_id")
        .select([
            ...TRANSACTION_COLUMNS.map((c) => `t.${c} as ${c}`),
            "o.restaurant_id as _restaurant_id",
        ])
        .where("t.id", id)
        .first();
    if (!row) return undefined;
    return {
        transaction: toEntity(row),
        restaurantId: row._restaurant_id !== null && row._restaurant_id !== undefined ? Number(row._restaurant_id) : null,
    };
}

export async function findTransactionByIdempotencyKey(key: string, conn: Knex): Promise<TransactionEntity | undefined> {
    const row = await conn("transactions")
        .select(TRANSACTION_COLUMNS as unknown as string[])
        .where({idempotency_key: key})
        .first();
    return row ? toEntity(row) : undefined;
}

export async function findPayouts(
    filter: {ownerId: number; from: Date; to: Date},
    limit: number,
    conn: Knex,
): Promise<TransactionEntity[]> {
    const rows = await conn("transactions")
        .select(TRANSACTION_COLUMNS as unknown as string[])
        .where("transaction_type", "payout")
        .where("dst_acc_id", filter.ownerId)
        .where("created_at", ">=", filter.from)
        .where("created_at", "<", filter.to)
        .orderBy("created_at", "desc")
        .limit(limit);
    return rows.map(toEntity);
}

export async function findTransactionsByOrderIds(orderIds: number[], conn: Knex): Promise<TransactionEntity[]> {
    if (orderIds.length === 0) return [];
    const rows = await conn("transactions")
        .select(TRANSACTION_COLUMNS as unknown as string[])
        .whereIn("order_id", orderIds)
        .orderBy("id", "asc");
    return rows.map(toEntity);
}
