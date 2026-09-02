import type {Knex} from "knex";

/**
 * `service_fee` and `delivery_fee` were previously booked under the generic
 * `adjustment` type (disambiguated only via the `idempotency_key` prefix),
 * which collapsed routine restaurant→platform fee clawbacks into the same
 * bucket as irregular manual corrections. Splitting them out lets finance
 * reconciliation filter on `transaction_type` directly.
 */
export async function up(knex: Knex): Promise<void> {
    await knex.raw(`
        ALTER TABLE transactions DROP CONSTRAINT transactions_transaction_type_check
    `);
    await knex.raw(`
        ALTER TABLE transactions ADD CONSTRAINT transactions_transaction_type_check CHECK (
            transaction_type IN (
                'charge','refund','commission','payout','cod_collection',
                'service_fee','delivery_fee','adjustment'
            )
        )
    `);
}

export async function down(knex: Knex): Promise<void> {
    await knex.raw(`
        ALTER TABLE transactions DROP CONSTRAINT transactions_transaction_type_check
    `);
    await knex.raw(`
        ALTER TABLE transactions ADD CONSTRAINT transactions_transaction_type_check CHECK (
            transaction_type IN (
                'charge','refund','commission','payout','cod_collection','adjustment'
            )
        )
    `);
}
