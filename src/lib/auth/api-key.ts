import type {Request, Response, NextFunction} from "express";
import {env} from "../config/env";

// Guards internal, service-to-service routes (today: analytics-service's
// backfill command reading order history). Mirrors core-service's
// lib/auth/api-key.ts exactly — same header, same 500-if-unconfigured /
// 401-if-mismatched shape.
export function requireInternalApiKey(req: Request, res: Response, next: NextFunction) {
    if (!env.internal.apiKey) {
        return res.status(500).json({error: "Internal api key not configured"});
    }
    if (req.headers["api-key"] != env.internal.apiKey) {
        return res.status(401).json({error: "Invalid api key"});
    }
    next();
}
