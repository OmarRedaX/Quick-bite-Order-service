import {Request, Response, NextFunction} from "express";
import {ICacheProvider} from "../../pkg/cache/cache.interface";
import {container} from "../di/container";
import {TOKENS} from "../di/tokens";

export function withCache(ttl = 3600, userScoped = false) {
    return async (req: Request, res: Response, next: NextFunction) => {
        try {
            const cacheProvider = container.resolve<ICacheProvider>(TOKENS.CacheProvider);
            let key = `${req.method}:${req.originalUrl}`;
            if (userScoped) key = `${key}:${req.user?.userId}`;
            if (req.region) key = `${req.region}:${key}`;

            const cached = await cacheProvider.get(key);
            if (cached) {
                res.setHeader("X-Cache", "HIT");
                return res.status(200).json(JSON.parse(cached));
            }

            const originalJson = res.json.bind(res);
            res.json = ((body: unknown) => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    cacheProvider.set(key, JSON.stringify(body), ttl).catch(() => {});
                }
                res.setHeader("X-Cache", "MISS");
                return originalJson(body);
            }) as Response["json"];
            next();
        } catch (err) {
            next(err);
        }
    };
}
