export class AgentEarningEntity {
    id!: number;
    region!: string;
    agentId!: number;
    orderId!: number;
    amount!: number;
    currency!: string;
    earnedAt!: Date;

    constructor(data: Partial<AgentEarningEntity>) {
        Object.assign(this, data);
    }
}
