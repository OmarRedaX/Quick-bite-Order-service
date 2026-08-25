/**
 * Pre-creates monthly partitions for the `orders` table for the next N months
 * (default 12) on every configured region's hot cluster.
 *
 *   npx tsx scripts/create-partitions.ts                      # all regions, 12 months
 *   REGION=eg npx tsx scripts/create-partitions.ts            # single region
 *   MONTHS_AHEAD=24 npx tsx scripts/create-partitions.ts      # custom horizon
 *
 * Run this manually after migrations land, and (in prod) on a monthly cron so
 * the rolling window stays ahead of `NOW()`.
 */
import {db} from "../src/lib/knex/knex";
import {env} from "../src/lib/config/env";

const MONTHS_AHEAD = Number(process.env.MONTHS_AHEAD ?? 12);

function pad(n: number): string {
    return String(n).padStart(2, "0");
}

interface MonthRange {
    name: string;       // orders_2026_05
    fromIso: string;    // 2026-05-01
    toIso: string;      // 2026-06-01 (exclusive upper bound)
}

function monthRanges(start: Date, count: number): MonthRange[] {
    const ranges: MonthRange[] = [];
    const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
    for (let i = 0; i < count; i++) {
        const next = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
        ranges.push({
            name: `orders_${cursor.getUTCFullYear()}_${pad(cursor.getUTCMonth() + 1)}`,
            fromIso: `${cursor.getUTCFullYear()}-${pad(cursor.getUTCMonth() + 1)}-01`,
            toIso: `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-01`,
        });
        cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    }
    return ranges;
}

function isSafeIdentifier(name: string): boolean {
    return /^[a-z_][a-z0-9_]{0,62}$/.test(name);
}

function isSafeDate(d: string): boolean {
    return /^\d{4}-\d{2}-\d{2}$/.test(d);
}

async function ensurePartitions(region: string, ranges: MonthRange[]) {
    const conn = db(region);
    for (const r of ranges) {
        if (!isSafeIdentifier(r.name) || !isSafeDate(r.fromIso) || !isSafeDate(r.toIso)) {
            throw new Error(`Refusing to inline unsafe partition spec: ${JSON.stringify(r)}`);
        }
        const sql = `CREATE TABLE IF NOT EXISTS ${r.name} PARTITION OF orders FOR VALUES FROM ('${r.fromIso}') TO ('${r.toIso}')`;
        await conn.raw(sql);
        console.log(`[${region}] ensured partition ${r.name} (${r.fromIso} -> ${r.toIso})`);
    }
}

async function main() {
    const requested = process.env.REGION;
    const regions = requested ? [requested] : env.regions;
    const ranges = monthRanges(new Date(), MONTHS_AHEAD);

    for (const region of regions) {
        await ensurePartitions(region, ranges);
    }
}

main()
    .then(() => process.exit(0))
    .catch((err) => {
        console.error(err);
        process.exit(1);
    });
