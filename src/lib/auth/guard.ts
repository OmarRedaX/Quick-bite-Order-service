import {NextFunction, Request, Response} from "express";
import {verifyAccessToken} from "./jwt";
import {NotAuthenticated} from "./errors";

/**
 * Cookie first (browser clients), falling back to `Authorization: Bearer
 * <token>` for callers that can't set cookies — service-to-service calls,
 * mobile clients, Postman/curl. Same precedence core-service and
 * analytics-service use.
 */
function extractToken(req: Request): string | undefined {
    if (req.cookies?.access_token) return req.cookies.access_token;
    const header = req.headers.authorization;
    if (header?.startsWith("Bearer ")) return header.slice("Bearer ".length).trim();
    return undefined;
}

export function authenticate(req: Request, res: Response, next: NextFunction) {
    const token = extractToken(req);
    if (!token) throw NotAuthenticated;

    req.user = verifyAccessToken(token);
    next();
}
