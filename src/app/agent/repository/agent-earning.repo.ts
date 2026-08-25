import {Knex} from "knex";
import {AgentEarningEntity} from "../entity/agent-earning.entity";
import {InsertAgentEarningInput, EarningsRange} from "../types";

const AGENT_EARNING_COLUMNS = [
    "id",
    "region",
    "agent_id",
    "order_id",
    "amount",
    "currency",
    "earned_at",
] as const;

function toEntity(row: any): AgentEarningEntity {
    return new AgentEarningEntity({
        id: Number(row.id),
        region: row.region,
        agentId: Number(row.agent_id),
        orderId: Number(row.order_id),
        amount: Number(row.amount),
        currency: row.currency,
        earnedAt: row.earned_at,
    });
}

/**
 * Inserts a single earning row. The unique on `order_id` makes this idempotent —
 * a re-run of the settlement trx hits ON CONFLICT and silently no-ops.
 */
export async function insertEarning(
    input: InsertAgentEarningInput,
    conn: Knex,
): Promise<AgentEarningEntity | null> {
    const rows = await conn("agent_earnings")
        .insert({
            region: input.region,
            agent_id: input.agentId,
            order_id: input.orderId,
            amount: input.amount,
            currency: input.currency,
        })
        .onConflict("order_id")
        .ignore()
        .returning(AGENT_EARNING_COLUMNS as unknown as string[]);
    if (rows.length === 0) return null;
    return toEntity(rows[0]);
}

export async function listByAgent(
    agentId: number,
    range: EarningsRange,
    limit: number,
    conn: Knex,
): Promise<AgentEarningEntity[]> {
    const rows = await conn("agent_earnings")
        .select(AGENT_EARNING_COLUMNS as unknown as string[])
        .where("agent_id", agentId)
        .where("earned_at", ">=", range.from)
        .where("earned_at", "<", range.to)
        .orderBy("earned_at", "desc")
        .limit(limit);
    return rows.map(toEntity);
}

export async function sumByAgent(
    agentId: number,
    range: EarningsRange,
    conn: Knex,
): Promise<number> {
    const row = await conn("agent_earnings")
        .where("agent_id", agentId)
        .where("earned_at", ">=", range.from)
        .where("earned_at", "<", range.to)
        .sum<{sum: string | null}>({sum: "amount"})
        .first();
    return Number(row?.sum ?? 0);
}
