import type {Request, Response, NextFunction} from "express";
import {v4 as uuidv4} from "uuid";

export function correlationId(req: Request, res: Response, next: NextFunction) {
    const incoming = req.headers["x-correlationid"] || req.headers["x-correlation-id"];
    const id = typeof incoming === "string" && incoming.length > 0 ? incoming : uuidv4();
    req.correlationId = id;
    res.setHeader("X-CorrelationId", id);
    next();
}
