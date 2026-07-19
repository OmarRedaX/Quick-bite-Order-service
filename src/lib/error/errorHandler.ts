import type {Request, Response, NextFunction} from "express";
import {logger} from "../logger/logger";
import {AppError} from "./AppError";

export function errorHandler(
    err: Error,
    req: Request,
    res: Response,
    _next: NextFunction,
) {
    const appErr = err instanceof AppError ? err : new AppError(err.message ?? "Unknown error", 500, false);
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
