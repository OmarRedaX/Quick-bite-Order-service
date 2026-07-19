import {Request, Response, NextFunction} from "express";
import {ICacheProvider} from "../../pkg/cache/cache.interface";
import {container} from "../di/container";
import {TOKENS} from "../di/tokens";
import {toSeconds} from "../../pkg/utils/time";

const TTL = toSeconds(1, "d");

interface IdempotencyOptions {
    strict?: boolean;
}

// Phase 0 implementation: Redis-only. DB-backed durable store is activated in
// Phase 1 when the `idempotency_keys` table lands.
export function idempotency(options: IdempotencyOptions = {}) {
    const {strict = false} = options;

    return async (req: Request, res: Response, next: NextFunction) => {
        if (!["POST", "PATCH", "PUT"].includes(req.method)) return next();

        const idempotencyKey = req.headers["idempotency-key"];

        if (typeof idempotencyKey !== "string" || idempotencyKey.length === 0) {
            if (strict) {
                return res.status(400).json({error: "Missing Idempotency-Key header"});
            }
            return next();
        }

        try {
            const cacheProvider = container.resolve<ICacheProvider>(TOKENS.CacheProvider);
            const key = `idempotency:${req.method}:${req.originalUrl}:${idempotencyKey}`;

            const cached = await cacheProvider.get(key);
            if (cached) {
                return res.status(200).json(JSON.parse(cached));
            }

            const originalJson = res.json.bind(res);
            res.json = ((body: unknown) => {
                cacheProvider.set(key, JSON.stringify(body), TTL).catch(() => {});
                return originalJson(body);
            }) as Response["json"];

            next();
        } catch {
            if (strict) {
                return res.status(503).json({error: "Idempotency service unavailable"});
            }
            next();
        }
    };
}
