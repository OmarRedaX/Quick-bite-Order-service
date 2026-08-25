declare namespace Express {
    interface Request {
        correlationId?: string;
        region?: string;
        rawBody?: Buffer;
        user?: {
            userId: number;
            role: string;
            email: string;
            restaurantId?: number;
            restaurantRole?: string;
            branchIds?: number[];
        };
    }
}
