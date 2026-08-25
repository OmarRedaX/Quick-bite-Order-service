import type {Knex} from "knex";

/**
 * Local mirror of a Kashier (or other provider) payment session. Created at
 * online checkout; reconciled when the provider's webhook fires.
 *
 * No FK to orders — orders is partitioned (FK targets must include the
 * partition key on PG). Integrity is enforced in code; lookups by
 * order_id are still indexed.
 */
export async function up(knex: Knex): Promise<void> {
    await knex.raw(`
        CREATE TABLE payment_sessions (
            id              BIGSERIAL PRIMARY KEY,
            region          TEXT NOT NULL,
            order_id        BIGINT NOT NULL,
            provider_id     INT NOT NULL,
            provider_session_id TEXT NOT NULL,
            redirect_url    TEXT NOT NULL,
            amount          INT NOT NULL,
            currency        TEXT NOT NULL,
            status          TEXT NOT NULL CHECK (status IN (
                                'initialized','pending','authorized','captured','failed','expired','cancelled'
                            )),
            raw_init_payload  JSONB NOT NULL,
            raw_last_payload  JSONB NULL,
            created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
            updated_at      TIMESTAMP NOT NULL DEFAULT NOW(),

            CONSTRAINT uq_payment_sessions_provider_session_id UNIQUE (provider_session_id)
        );
    `);

    // supports webhook lookup by Kashier session id
    await knex.raw(`CREATE INDEX idx_payment_sessions_provider_session_id ON payment_sessions (provider_session_id)`);
    // supports order -> session lookup (latest active session for an order)
    await knex.raw(`CREATE INDEX idx_payment_sessions_order_id ON payment_sessions (order_id)`);
}

export async function down(knex: Knex): Promise<void> {
    await knex.raw(`DROP TABLE IF EXISTS payment_sessions`);
}
