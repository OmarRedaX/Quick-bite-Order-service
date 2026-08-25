import type {Knex} from "knex";

/**
 * Raw inbound webhook log for audit + replay. Unique on (provider_id,
 * provider_event_id) gives at-most-once processing semantics: a duplicate
 * INSERT … ON CONFLICT DO NOTHING returns 0 rows and we ack the request 200.
 */
export async function up(knex: Knex): Promise<void> {
    await knex.raw(`
        CREATE TABLE payment_webhook_events (
            id                BIGSERIAL PRIMARY KEY,
            region            TEXT NOT NULL,
            provider_id       INT NOT NULL,
            provider_event_id TEXT NOT NULL,
            signature         TEXT NOT NULL,
            payload           JSONB NOT NULL,
            received_at       TIMESTAMP NOT NULL DEFAULT NOW(),
            processed_at      TIMESTAMP NULL,
            process_error     TEXT NULL,

            CONSTRAINT uq_payment_webhook_events_provider_event_id UNIQUE (provider_id, provider_event_id)
        );
    `);
}

export async function down(knex: Knex): Promise<void> {
    await knex.raw(`DROP TABLE IF EXISTS payment_webhook_events`);
}
