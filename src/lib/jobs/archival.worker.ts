import {register} from "./job-registry";
import {ArchivalRunResult, ArchivalTableResult, ArchivalTableSpec} from "./archival.types";
import {archivalLockKey, moveTableBatches} from "./archival.helpers";
import {db, dbArchive} from "../knex/knex";
import {cacheProvider} from "../cache/init";
import {env} from "../config/env";
import {logger} from "../logger/logger";

/**
 * Table walk order matches docs/implementation-plan.md Phase 5: children
 * before the `orders` parent, so a crash mid-run never leaves an archived
 * order whose line items / ledger rows didn't make it across yet.
 *
 * Column lists are literal here (not imported from `app/*` repos) per the
 * `lib/` layering rule in CLAUDE.md — `lib/` may not depend on `app/<module>`
 * except through DI at boot. Keep these in sync with the corresponding
 * `<TABLE>_COLUMNS` repo constants if a migration changes a table's shape.
 */
const TABLE_SPECS: ArchivalTableSpec[] = [
    {
        table: "agent_earnings",
        timestampColumn: "earned_at",
        conflictColumns: ["id"],
        columns: ["id", "region", "agent_id", "order_id", "amount", "currency", "earned_at"],
    },
    {
        table: "payment_webhook_events",
        timestampColumn: "received_at",
        conflictColumns: ["id"],
        columns: [
            "id", "region", "provider_id", "provider_event_id", "signature",
            "payload", "received_at", "processed_at", "process_error",
        ],
        jsonColumns: ["payload"],
    },
    {
        table: "payment_sessions",
        timestampColumn: "created_at",
        conflictColumns: ["id"],
        columns: [
            "id", "region", "order_id", "provider_id", "provider_session_id",
            "redirect_url", "amount", "currency", "status",
            "raw_init_payload", "raw_last_payload", "created_at", "updated_at",
        ],
        jsonColumns: ["raw_init_payload", "raw_last_payload"],
    },
    {
        table: "transactions",
        timestampColumn: "created_at",
        conflictColumns: ["id"],
        columns: [
            "id", "region", "order_id", "transaction_type", "method", "provider_id",
            "provider_reference_id", "status", "amount", "currency", "src_acc_id",
            "dst_acc_id", "is_refunded", "refunded_payment_id", "idempotency_key",
            "created_at", "updated_at",
        ],
    },
    {
        table: "order_items",
        timestampColumn: "created_at",
        conflictColumns: ["id"],
        columns: [
            "id", "region", "order_id", "product_id", "quantity", "unit_price_snapshot",
            "name_snapshot", "image_url_snapshot", "line_total", "created_at",
        ],
    },
    {
        // `orders` is partitioned by RANGE(created_at); its PK is the composite
        // (id, created_at), so the conflict target must include both columns.
        table: "orders",
        timestampColumn: "created_at",
        conflictColumns: ["id", "created_at"],
        columns: [
            "id", "region", "public_id", "country_code", "restaurant_id", "restaurant_owner_id",
            "branch_id", "customer_id", "customer_address_id", "delivery_lat", "delivery_lng",
            "delivery_address_text_snapshot", "branch_lat", "branch_lng", "status", "subtotal",
            "delivery_fee", "service_fee", "total", "commission", "currency", "payment_method",
            "delivery_agent_id", "created_at", "updated_at", "accepted_at", "rejected_at",
            "ready_at", "assigned_at", "picked_at", "delivered_at", "cancelled_at",
        ],
    },
];

/**
 * Runs one archival pass for a region. Guarded by a Redis SETNX lock so two
 * worker processes booting at once never race the same shard. Returns null
 * if another run already holds the lock (skipped, not an error).
 */
export async function runArchivalForRegion(region: string): Promise<ArchivalRunResult | null> {
    const lockTtlSec = env.archival.maxRuntimeMin * 60 + 60; // small buffer over the runtime budget
    const acquired = await cacheProvider.trySet(archivalLockKey(region), String(process.pid), lockTtlSec);
    if (!acquired) {
        logger.debug("archival.skipped (lock held)", {region});
        return null;
    }

    const startedAt = new Date();
    const deadline = startedAt.getTime() + env.archival.maxRuntimeMin * 60 * 1000;
    const hotConn = db(region);
    const archiveConn = dbArchive(region);
    const perTable: ArchivalTableResult[] = [];
    let totalMoved = 0;
    let timedOut = false;

    try {
        for (const spec of TABLE_SPECS) {
            if (Date.now() >= deadline) {
                timedOut = true;
                break;
            }
            const result = await moveTableBatches(region, hotConn, archiveConn, spec, deadline);
            perTable.push(result);
            totalMoved += result.moved;
            if (Date.now() >= deadline) timedOut = true;
        }
    } finally {
        await cacheProvider.del(archivalLockKey(region));
    }

    const result: ArchivalRunResult = {
        region,
        startedAt: startedAt.toISOString(),
        durationMs: Date.now() - startedAt.getTime(),
        totalMoved,
        perTable,
        timedOut,
    };
    logger.info("archival.run", result as unknown as Record<string, unknown>);
    return result;
}

/**
 * Registers one nightly archival job per configured region. Idempotent:
 * safe to call once per process boot.
 */
export function registerArchivalJobs(): void {
    for (const region of env.regions) {
        register({
            name: `archival:${region}`,
            cron: env.archival.cron,
            timezone: env.archival.timezone,
            handler: async () => {
                await runArchivalForRegion(region);
            },
        });
    }
}
