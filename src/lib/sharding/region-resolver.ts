import type {Request, Response, NextFunction} from "express";
import {isRegion} from "./regions";
import {RegionNotResolvedError} from "./errors";

/**
 * Reads the region from the `X-Region` header only. "all" is preserved for
 * admin fan-out reads; writes must resolve to one concrete region.
 */
export function resolveRegion(req: Request, _res: Response, next: NextFunction) {
    const raw = req.headers["x-region"]; // x-region: eg
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (value && (value === "all" || isRegion(value))) {
        req.region = value;
    }
    next();
}

export function requireRegion(req: Request, _res: Response, next: NextFunction) {
    if (!req.region) throw RegionNotResolvedError;
    next();
}
