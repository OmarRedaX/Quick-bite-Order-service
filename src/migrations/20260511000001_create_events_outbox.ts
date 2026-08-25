import type {Knex} from "knex";

/**
 * Transactional outbox for outbound events (order.placed, order.delivered, …).
 * One row is inserted in the SAME trx as the domain mutation that produced it
 * (e.g. orders insert). A background worker drains this table to RabbitMQ with
 * publisher confirms, then sets dispatched_at. This guarantees at-least-once
 * publish even if the broker is down at write time.
 *
 * Per-shard table — runs in every region's hot DB. No `region` column needed
 * because each shard owns its own outbox; cross-shard ordering is not a goal.
 */
export async function up(knex: Knex): Promise<void> {
    await knex.raw(`
        CREATE TABLE events_outbox (
            id              BIGSERIAL PRIMARY KEY,
            aggregate_type  TEXT NOT NULL,
            aggregate_id    TEXT NOT NULL,
            event_type      TEXT NOT NULL,
            event_id        UUID NOT NULL UNIQUE,
            payload         JSONB NOT NULL,
            created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
            dispatched_at   TIMESTAMP NULL,
            attempts        INT NOT NULL DEFAULT 0,
            last_error      TEXT NULL
        );

        -- supports drainer scan: undispatched rows ordered by id
        CREATE INDEX idx_events_outbox_pending ON events_outbox (id) WHERE dispatched_at IS NULL;
    `);
}

export async function down(knex: Knex): Promise<void> {
    await knex.raw(`DROP TABLE IF EXISTS events_outbox`);
}
