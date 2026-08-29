import {Knex} from "knex";
import {ArchivalTableResult, ArchivalTableSpec} from "./archival.types";
import {env} from "../config/env";
import {logger} from "../logger/logger";

/** Redis lock key guarding one region's archival run against concurrent workers. */
export function archivalLockKey(region: string): string {
    return `archival:${region}:lock`;
}

/**
 * JSONB columns come back from `pg` already parsed into JS objects; knex
 * requires them re-stringified before they can be re-inserted.
 */
export function stringifyJsonColumns(
    row: Record<string, unknown>,
    jsonColumns?: string[],
): Record<string, unknown> {
    if (!jsonColumns || jsonColumns.length === 0) return row;
    const out = {...row};
    for (const col of jsonColumns) {
        if (out[col] !== null && out[col] !== undefined) out[col] = JSON.stringify(out[col]);
    }
    return out;
}

/**
 * Moves one table's prior-year rows in batches of `ARCHIVAL_BATCH_SIZE`.
 * Per batch: insert into archive (commit), then delete from hot (commit) —
 * archive-first so a crash between the two leaves the row in both places
 * (safe; a re-run just no-ops the re-insert via ON CONFLICT DO NOTHING and
 * still deletes from hot) rather than in neither.
 */
export async function moveTableBatches(
    region: string,
    hotConn: Knex,
    archiveConn: Knex,
    spec: ArchivalTableSpec,
    deadline: number,
): Promise<ArchivalTableResult> {
    let moved = 0;
    let batches = 0;

    while (Date.now() < deadline) {
        const batchStart = Date.now();
        const rows: Record<string, unknown>[] = await hotConn(spec.table)
            .select(spec.columns as unknown as string[])
            .whereRaw(`${spec.timestampColumn} < date_trunc('year', NOW())`)
            .orderBy("id", "asc")
            .limit(env.archival.batchSize);

        if (rows.length === 0) break;

        const archiveRows = rows.map((row) => stringifyJsonColumns(row, spec.jsonColumns));
        const ids = rows.map((row) => row.id);

        const archiveTrx = await archiveConn.transaction();
        try {
            await archiveTrx(spec.table).insert(archiveRows).onConflict(spec.conflictColumns).ignore();
            await archiveTrx.commit();
        } catch (err) {
            await archiveTrx.rollback();
            throw err;
        }

        const hotTrx = await hotConn.transaction();
        try {
            await hotTrx(spec.table).whereIn("id", ids as (string | number)[]).delete();
            await hotTrx.commit();
        } catch (err) {
            await hotTrx.rollback();
            throw err;
        }

        moved += rows.length;
        batches += 1;
        logger.info("archival.batch", {region, table: spec.table, rows: rows.length, ms: Date.now() - batchStart});

        if (rows.length < env.archival.batchSize) break;
    }

    return {table: spec.table, moved, batches};
}
