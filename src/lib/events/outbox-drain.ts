import {db} from "../knex/knex";
import {env} from "../config/env";
import {logger} from "../logger/logger";
import {messageBroker} from "../messaging/init";
import {claimBatch, markDispatched, markFailed} from "./outbox.repo";

/**
 * One pass over a single region's outbox: claim a batch with FOR UPDATE
 * SKIP LOCKED, publish each row to the order.events exchange, mark dispatched.
 *
 * A publish failure marks the row as failed, bumps attempts, and bails out of
 * the batch (the broker is probably sick — don't hold the lock on the rest).
 *
 * SKIP LOCKED makes this safe to run concurrently across multiple workers in
 * the same region.
 */
export async function drainOutboxForRegion(region: string): Promise<void> {
    const conn = db(region);
    const trx = await conn.transaction();
    try {
        const rows = await claimBatch(trx, env.outboundEvents.batchSize);
        if (rows.length === 0) {
            await trx.commit();
            return;
        }

        for (const row of rows) {
            const envelope = {
                eventId: row.event_id,
                eventType: row.event_type,
                occurredAt: new Date().toISOString(),
                aggregateType: row.aggregate_type,
                aggregateId: row.aggregate_id,
                region,
                payload: row.payload,
            };
            try {
                await messageBroker.publish(
                    env.outboundEvents.exchange,
                    row.event_type,
                    Buffer.from(JSON.stringify(envelope), "utf8"),
                );
                await markDispatched(trx, row.id);
            } catch (err) {
                const msg = describeError(err);
                await markFailed(trx, row.id, msg);
                logger.error("outbox publish failed", {region, id: row.id, error: msg});
                break;
            }
        }

        await trx.commit();
    } catch (err) {
        await trx.rollback();
        throw err;
    }
}

function describeError(err: unknown): string {
    if (err instanceof Error && err.message) return err.message;
    try {
        return JSON.stringify(err);
    } catch {
        return String(err);
    }
}
