export interface InsertAgentEarningInput {
    region: string;
    agentId: number;
    orderId: number;
    amount: number;
    currency: string;
}

export interface EarningsRange {
    from: Date;
    to: Date;
}

/** Hash payload stored at presence:meta:<region>:<agentId> */
export interface PresenceMeta {
    lat: number;
    lng: number;
    lastSeenAt: number; // unix ms
}
