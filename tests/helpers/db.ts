import {getHotShard} from "../../src/lib/knex/shards"

// `payment_providers` is seeded once by a region-conditional migration
// (20260506000010_create_payment_providers.ts — eg gets a `kashier` row,
// ksa gets none) and never reseeded. Truncating it would silently delete
// that seed data for the rest of the run — the exact mistake core-service's
// own `truncateAll()` made with its RBAC catalog tables. `orders`/
// `order_items`'s monthly partition children are safe to list alongside
// their parent: TRUNCATE accepts a parent and its own (already-empty)
// partition in the same statement without error.
const PRESERVED_TABLES = ["payment_providers"]

export async function truncateAll(region: string): Promise<void> {
    const db = getHotShard(region)
    const result = await db.raw<{rows: {tablename: string}[]}>(`
        SELECT tablename FROM pg_tables
        WHERE schemaname = 'public'
        AND tablename NOT IN ('knex_migrations', 'knex_migrations_lock')`)

    const tableNames = result.rows
        .map((r) => r.tablename)
        .filter((name) => !PRESERVED_TABLES.includes(name))
        .map((name) => `"${name}"`)
        .join(", ")

    if (tableNames.length === 0) return
    await db.raw(`TRUNCATE TABLE ${tableNames} RESTART IDENTITY CASCADE`)
}

export async function truncateAllRegions(regions: string[]): Promise<void> {
    for (const region of regions) {
        await truncateAll(region)
    }
}
