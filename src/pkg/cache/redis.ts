import Redis from "ioredis";
import type {ICacheProvider} from "./cache.interface";

export class RedisCacheProvider implements ICacheProvider {
    /**
     * Exposed so integrations that need the raw ioredis connection (e.g. the
     * socket.io redis adapter) can reuse it instead of opening another one.
     * The adapter still needs its own subscriber via `client.duplicate()` —
     * once ioredis is in subscribe mode it can't serve get/set.
     */
    constructor(public readonly client: Redis) {}

    // ── Strings ──────────────────────────────────────────────────────────

    async get(key: string): Promise<string | null> {
        return this.client.get(key);
    }

    async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
        if (ttlSeconds) {
            await this.client.set(key, value, "EX", ttlSeconds);
        } else {
            await this.client.set(key, value);
        }
    }

    async del(key: string): Promise<number> {
        return this.client.del(key);
    }

    async trySet(key: string, value: string, ttlSeconds?: number): Promise<boolean> {
        const res = ttlSeconds
            ? await this.client.set(key, value, "EX", ttlSeconds, "NX")
            : await this.client.set(key, value, "NX");
        return res === "OK";
    }

    async exists(key: string): Promise<boolean> {
        return (await this.client.exists(key)) === 1;
    }

    async incr(key: string): Promise<number> {
        return this.client.incr(key);
    }

    async expire(key: string, ttlSeconds: number): Promise<void> {
        await this.client.expire(key, ttlSeconds);
    }

    async ttl(key: string): Promise<number> {
        return this.client.ttl(key);
    }

    // ── Hashes ───────────────────────────────────────────────────────────

    async hsetWithTtl(
        key: string,
        fields: Record<string, string>,
        ttlSeconds?: number,
    ): Promise<void> {
        // HSET + EXPIRE in a single round-trip via MULTI. If we did them
        // sequentially, a crash between the two would leave a hash without a
        // TTL — i.e. an agent who silently became "permanently online".
        const tx = this.client.multi().hset(key, fields);
        if (ttlSeconds) tx.expire(key, ttlSeconds);
        await tx.exec();
    }

    // ── Sets ─────────────────────────────────────────────────────────────

    async sadd(key: string, member: string): Promise<void> {
        await this.client.sadd(key, member);
    }

    async srem(key: string, member: string): Promise<void> {
        await this.client.srem(key, member);
    }

    async sismember(key: string, member: string): Promise<boolean> {
        return (await this.client.sismember(key, member)) === 1;
    }

    // ── Geo / sorted sets ────────────────────────────────────────────────

    async geoadd(key: string, lng: number, lat: number, member: string): Promise<void> {
        await this.client.geoadd(key, lng, lat, member);
    }
    // delivery_agents

    async zrem(key: string, member: string): Promise<void> {
        await this.client.zrem(key, member);
    }

    async geosearchByRadius(
        key: string,
        fromLng: number,
        fromLat: number,
        radiusMeters: number,
        count: number,
    ): Promise<string[]> {
        const raw = (await this.client.geosearch(
            key,
            "FROMLONLAT",
            fromLng,
            fromLat,
            "BYRADIUS",
            radiusMeters,
            "m",
            "ASC",
            "COUNT",
            count,
        )) as string[];
        return raw;
    }
}
