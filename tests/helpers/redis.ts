import Redis from "ioredis"
import {env} from "../../src/lib/config/env"

const client = new Redis({
    host: env.redis.host,
    port: env.redis.port,
    password: env.redis.password || undefined,
    lazyConnect: true,
})

async function deleteByPattern(pattern: string): Promise<void> {
    if (client.status !== "ready") await client.connect()
    const keys = await client.keys(pattern)
    if (keys.length > 0) {
        await client.del(...keys)
    }
}

export async function flushIdempotencyCache(): Promise<void> {
    await deleteByPattern("idempotency:*")
}

// withCache() (src/lib/cache/withCache.ts) keys every cached GET response as
// `<region>:<method>:<originalUrl>[:<userId>]` — region-prefixed, unlike
// core-service's flat `GET:*`. `*:GET:*` covers every region.
export async function flushHttpCache(): Promise<void> {
    await deleteByPattern("*:GET:*")
}

// Agent presence (presence.service.ts): presence:meta:<region>:<agentId>,
// presence:geo:<region> (a GEO set), presence:busy:<region> (a set).
export async function flushPresence(): Promise<void> {
    await deleteByPattern("presence:*")
}

// Read-through core-client cache (branch.client.ts) + core-data-cache.service's
// reject-new-orders flag + the rbac.permissions_changed-invalidated bits that
// happen to live outside PermissionCacheService's in-process map: core:branch:*,
// core:branch:*:product:*, core:restaurant:*, branch:reject-new-orders:*. Without
// this, a branch/product seeded via CoreClientStub in one test can be served
// stale from a PRIOR test's real-Redis cache entry (1h TTL) even after
// coreClientStub.reset() clears the stub's own in-memory map — found live: a
// "branch not accepting orders" test failed (got 201, not 409) because
// getBranch() served the stale cached branch from an EARLIER test's seed
// instead of ever re-calling the freshly-reset stub.
export async function flushCoreDataCache(): Promise<void> {
    await deleteByPattern("core:*")
    await deleteByPattern("branch:reject-new-orders:*")
}

// core-events consumer dedupe markers (core-events:dedupe:<eventId>, 24h TTL —
// see src/lib/core-events/consumer.ts). Without this, a test-literal eventId
// string (e.g. "evt-branch-deactivated-1") that was already delivered by an
// earlier test run stays "seen" in real Redis across entirely separate `jest`
// invocations, so a handler that should fire again gets silently skipped —
// found live: the outbox/core-events suite passed in isolation but failed
// when the full integration suite ran it a second time against warm Redis.
export async function flushCoreEventsDedupe(): Promise<void> {
    await deleteByPattern("core-events:dedupe:*")
}

// Assignment offers/claims (assignment.service.ts): offer:order:<publicId>,
// claim:order:<publicId>.
export async function flushAssignmentState(): Promise<void> {
    await deleteByPattern("offer:*")
    await deleteByPattern("claim:*")
}

export async function flushTestCache(): Promise<void> {
    await flushIdempotencyCache()
    await flushHttpCache()
    await flushPresence()
    await flushAssignmentState()
    await flushCoreDataCache()
    await flushCoreEventsDedupe()
}

export async function closeRedisTestClient(): Promise<void> {
    if (client.status !== "end") await client.quit()
}
