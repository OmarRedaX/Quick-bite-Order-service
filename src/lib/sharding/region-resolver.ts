import type {Request, Response, NextFunction} from "express";
import {isRegion, normalizeRegion} from "./regions";
import {RegionNotResolvedError} from "./errors";

/**
 * Reads the region from `X-Region` header first, then falls back to the
 * `?region=` query string. The query fallback exists because external
 * callers we don't control (e.g. Kashier webhooks) can put a query string
 * on the URL but can't add custom headers.
 *
 * "all" is preserved for admin fan-out reads; routes that need a single
 * shard should additionally use `requireConcreteRegion`.
 */
export function resolveRegion(req: Request, _res: Response, next: NextFunction) {
    const headerRaw = req.headers["x-region"];
    const headerValue = Array.isArray(headerRaw) ? headerRaw[0] : headerRaw;
    const queryValue = typeof req.query.region === "string" ? req.query.region : undefined;
    const norm = normalizeRegion(headerValue ?? queryValue);
    if (norm === "all") {
        req.region = "all";
    } else if (norm && isRegion(norm)) {
        req.region = norm;
    }
    next();
}

export function requireRegion(req: Request, _res: Response, next: NextFunction) {
    if (!req.region) throw RegionNotResolvedError;
    next();
}

/**
 * Stricter than `requireRegion`: rejects `req.region === "all"` so that
 * single-shard endpoints (writes, lookups by id) never silently fan out.
 */
export function requireConcreteRegion(req: Request, _res: Response, next: NextFunction) {
    if (!req.region || req.region === "all") throw RegionNotResolvedError;
    next();
}
