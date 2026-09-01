import type {Request, Response, NextFunction} from "express";
import {logger} from "../logger/logger";
import {AppError} from "./AppError";

/**
 * express.json()'s body-parser throws its own SyntaxError on malformed JSON
 * — before any route handler runs, so a route's own try/catch (e.g. the
 * Kashier webhook's parseEnvelope) never gets a chance to turn it into an
 * AppError. Recognized here instead, so any endpoint that receives a
 * non-JSON body with a JSON content-type gets a clean 400, not a 500 —
 * especially important for webhooks: a payment processor retry-storms or
 * flags an endpoint that answers malformed input with 5xx.
 */
function isBodyParserSyntaxError(err: Error): boolean {
    return err instanceof SyntaxError && (err as SyntaxError & {type?: string}).type === "entity.parse.failed";
}

export function errorHandler(
    err: Error,
    req: Request,
    res: Response,
    _next: NextFunction,
) {
    const appErr = isBodyParserSyntaxError(err)
        ? new AppError("Malformed request body", 400, true)
        : err instanceof AppError
          ? err
          : new AppError(err?.message ?? "Unknown error", 500, false);
    const operational = appErr.isOperational;

    logger.error(appErr.message, {
        statusCode: appErr.statusCode,
        stack: appErr.stack,
        operational,
        path: req.originalUrl,
        method: req.method,
        correlationId: req.correlationId,
    });

    if (operational) {
        return res.status(appErr.statusCode).json({error: appErr.message});
    }
    return res.status(500).json({error: "Something went wrong"});
}
