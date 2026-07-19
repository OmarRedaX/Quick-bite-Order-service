import {Response} from "express";
import {PaginationMeta} from "./pagination/cursor-pagination";

export interface ApiResponse<T = unknown> {
    success: boolean;
    data?: T;
    meta?: object;
}

export function sendSuccess<T>(res: Response, data: T, statusCode = 200, meta?: object) {
    const body: ApiResponse<T> = {success: true, data};
    if (meta) body.meta = meta;
    res.status(statusCode).json(body);
}

export function sendPaginated<T>(res: Response, data: T[], meta: PaginationMeta) {
    res.status(200).json({success: true, data, meta});
}
