/**
 * Cache + ephemeral-state interface backing every Redis interaction in this
 * service. Anything that wants to talk to Redis goes through here so the
 * underlying client (currently ioredis) is swappable and so we can mock the
 * whole surface in tests with one fake.
 *
 * Implementations MUST be safe to call concurrently and MUST treat unknown
 * keys as no-op (e.g. `del` returns 0, `expire` returns silently).
 */
export interface ICacheProvider {
    // ── Strings ──────────────────────────────────────────────────────────

    /** GET — returns the value or null if the key does not exist. */
    get(key: string): Promise<string | null>;

    /**
     * SET with optional TTL (in seconds). Always overwrites; use `trySet`
     * when you need set-if-absent semantics.
     */
    set(key: string, value: string, ttlSeconds?: number): Promise<void>;

    /** DEL — returns the number of keys actually removed (0 or 1). */
    del(key: string): Promise<number>;

    /**
     * Atomic set-if-absent (SET ... NX [EX ttl]). Returns true if the key
     * was newly written, false if it already existed.
     *
     * Used for distributed locks (e.g. `claim:order:<id>`) and for webhook /
     * core-event dedupe (e.g. `core-events:dedupe:<eventId>`).
     */
    trySet(key: string, value: string, ttlSeconds?: number): Promise<boolean>;

    /** EXISTS — true iff the key is currently set. */
    exists(key: string): Promise<boolean>;

    /** Atomic INCR. Returns the new (post-increment) value. */
    incr(key: string): Promise<number>;

    /**
     * EXPIRE — set or refresh the TTL on an existing key (seconds).
     * No-op if the key does not exist.
     */
    expire(key: string, ttlSeconds: number): Promise<void>;

    /**
     * TTL — remaining lifetime in seconds. Returns -1 if the key exists with
     * no expiry, -2 if the key does not exist.
     */
    ttl(key: string): Promise<number>;

    // ── Hashes ───────────────────────────────────────────────────────────

    /**
     * HSET multiple fields and (optionally) refresh the hash key's TTL in a
     * single round-trip. The TTL applies to the whole hash, not individual
     * fields. Used by `presence.service` to write `{lat, lng, lastSeenAt}`
     * with the 5-minute "online" window.
     */
    hsetWithTtl(key: string, fields: Record<string, string>, ttlSeconds?: number): Promise<void>;

    // ── Sets ─────────────────────────────────────────────────────────────

    /** SADD — add a member to a set. No-op if already a member. */
    sadd(key: string, member: string): Promise<void>;

    /** SREM — remove a member from a set. No-op if not a member. */
    srem(key: string, member: string): Promise<void>;

    /** SISMEMBER — true iff `member` is in the set. */
    sismember(key: string, member: string): Promise<boolean>;

    // ── Geo / sorted sets ────────────────────────────────────────────────

    /**
     * GEOADD — UPSERT a (lng, lat) point under `member`. Re-adding an
     * existing member updates its position. Used by `presence.service`
     * for the per-region agent geo set.
     */
    geoadd(key: string, lng: number, lat: number, member: string): Promise<void>;

    /** ZREM — remove a member from a sorted/geo set. */
    zrem(key: string, member: string): Promise<void>;

    /**
     * GEOSEARCH FROMLONLAT BYRADIUS … ASC COUNT N — nearest-neighbor radius
     * scan. Returns up to `count` member ids ordered by distance ascending.
     * Used by `assignment.service` to pick agent candidates within
     * `ASSIGNMENT_RADIUS_METERS` of a branch.
     */
    geosearchByRadius(
        key: string,
        fromLng: number,
        fromLat: number,
        radiusMeters: number,
        count: number,
    ): Promise<string[]>;
}
