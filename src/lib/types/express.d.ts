declare namespace Express {
    interface Request {
        correlationId?: string;
        region?: string;
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
