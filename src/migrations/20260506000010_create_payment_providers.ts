import type {Knex} from "knex";

/**
 * Lookup of payment providers (real third-party gateways) for the local shard.
 * COD is NOT a provider — it's a `payment_method` value on `orders`. This
 * table only holds entries for actual external processors.
 *
 * Per-region seeding is driven by `process.env.REGION` so that, for example,
 * Egypt gets Kashier while a region without a configured gateway has no
 * rows here at all (and therefore can only accept COD orders).
 *
 * Seed map:
 *   region=eg  -> kashier
 *   region=ksa -> (none, COD-only for now)
 */
export async function up(knex: Knex): Promise<void> {
    await knex.raw(`
        CREATE TABLE payment_providers (
            id          INT PRIMARY KEY,
            name        TEXT NOT NULL UNIQUE,
            is_enabled  BOOLEAN NOT NULL DEFAULT TRUE,
            priority    SMALLINT NOT NULL DEFAULT 100
        );
    `);

    const region = (process.env.REGION ?? "").toLowerCase();
    if (region === "eg") {
        await knex("payment_providers").insert({id: 1, name: "kashier", is_enabled: true, priority: 10});
    }
}

export async function down(knex: Knex): Promise<void> {
    await knex.raw(`DROP TABLE IF EXISTS payment_providers`);
}
