import {injectable, inject} from "tsyringe";
import {TOKENS} from "../../../lib/di/tokens";
import {env} from "../../../lib/config/env";
import {db} from "../../../lib/knex/knex";
import {ICacheProvider} from "../../../pkg/cache/cache.interface";
import {OrderStatus} from "../../order/enums";
import {OfflineWhilePickedForbidden} from "../errors";

/**
 * Redis-only agent presence. The 5-minute TTL on `presence:meta:*` is the
 * "online" signal — if pings stop the key vanishes and the agent is treated
 * as offline. There is NO Postgres mirror.
 *
 * Key schema (region-namespaced — see database-design.md §8):
 *   presence:meta:<region>:<agentId>     hash {lat,lng,lastSeenAt}, TTL = PRESENCE_STALE_SEC
 *   presence:geo:<region>                geo set (GEOADD on every ping)
 *   presence:busy:<region>               set of agent ids currently holding an assignment
 *
 * Key names are exposed as static helpers so other services (assignment,
 * settlement) can read/write the same Redis state without duplicating the
 * naming convention.
 */
@injectable()
export class PresenceService {
    constructor(@inject(TOKENS.CacheProvider) private readonly cache: ICacheProvider) {}

    static metaKey(region: string, agentId: number): string {
        return `presence:meta:${region}:${agentId}`;
    }

    static geoKey(region: string): string {
        return `presence:geo:${region}`;
    }

    static busyKey(region: string): string {
        return `presence:busy:${region}`;
    }

    /** Online and ping share the same write path — UPSERT + extend TTL. */
    async upsert(region: string, agentId: number, lat: number, lng: number): Promise<void> {
        const ttl = env.delivery.presenceStaleSec;
        await this.cache.hsetWithTtl(
            PresenceService.metaKey(region, agentId),
            {lat: String(lat), lng: String(lng), lastSeenAt: String(Date.now())},
            ttl,
        );
        await this.cache.geoadd(PresenceService.geoKey(region), lng, lat, String(agentId));
    }

    /**
     * Reject if the agent is currently holding an order in `picked` (food in
     * transit). For `assigned`, we reset the order to `ready` so the worker
     * re-broadcasts on the next tick.
     */
    async goOffline(region: string, agentId: number): Promise<void> {
        const conn = db(region);
        const stuck = await conn("orders")
            .select("public_id", "status")
            .where({delivery_agent_id: agentId, status: OrderStatus.PICKED})
            .first();
        if (stuck) throw OfflineWhilePickedForbidden;

        await conn("orders")
            .where({delivery_agent_id: agentId, status: OrderStatus.ASSIGNED})
            .update({delivery_agent_id: null, status: OrderStatus.READY, assigned_at: null, updated_at: conn.fn.now()});

        await this.cache.del(PresenceService.metaKey(region, agentId));
        await this.cache.zrem(PresenceService.geoKey(region), String(agentId));
        await this.cache.srem(PresenceService.busyKey(region), String(agentId));
    }

    async markBusy(region: string, agentId: number): Promise<void> {
        await this.cache.sadd(PresenceService.busyKey(region), String(agentId));
    }

    async clearBusy(region: string, agentId: number): Promise<void> {
        await this.cache.srem(PresenceService.busyKey(region), String(agentId));
    }
}
