import jwt from "jsonwebtoken";
import {env} from "../config/env";
import {NotAuthenticated} from "./errors";

export interface JWTPayload {
    userId: number;
    role: string;
    email: string;
    restaurantId?: number;
    restaurantRole?: string;
    branchIds?: number[];
}

export function verifyAccessToken(token: string): JWTPayload {
    try {
        const decoded = jwt.verify(token, env.jwt.accessSecret) as jwt.JwtPayload & JWTPayload;
        return {
            userId: decoded.userId,
            role: decoded.role,
            email: decoded.email,
            restaurantId: decoded.restaurantId,
            restaurantRole: decoded.restaurantRole,
            branchIds: decoded.branchIds,
        };
    } catch {
        throw NotAuthenticated;
    }
}

export function verifyRefreshToken(token: string): JWTPayload {
    try {
        const decoded = jwt.verify(token, env.jwt.refreshSecret) as jwt.JwtPayload & JWTPayload;
        return {
            userId: decoded.userId,
            role: decoded.role,
            email: decoded.email,
            restaurantId: decoded.restaurantId,
            restaurantRole: decoded.restaurantRole,
            branchIds: decoded.branchIds,
        };
    } catch {
        throw NotAuthenticated;
    }
}
