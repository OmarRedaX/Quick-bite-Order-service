import Redis from "ioredis";
import {RedisCacheProvider} from "../../pkg/cache/redis";
import {env} from "../config/env";

/**
 * Single ioredis connection shared by the cache provider (for get/set/del)
 * and — via duplicate() — the socket.io redis adapter (which needs a
 * separate subscriber connection).
 */
export const redisClient = new Redis({
    host: env.redis.host,
    port: env.redis.port,
    password: env.redis.password,
    lazyConnect: true,
    maxRetriesPerRequest: 3,
});

redisClient.on("error", (err) => console.error("Redis Error:", err.message));
redisClient.connect().catch((err) => console.error("Redis Connect Error:", err.message));

export const cacheProvider = new RedisCacheProvider(redisClient);
