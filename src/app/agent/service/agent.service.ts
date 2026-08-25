import {injectable, inject} from "tsyringe";
import {Server as IoServer} from "socket.io";
import {container} from "../../../lib/di/container";
import {TOKENS} from "../../../lib/di/tokens";
import {db} from "../../../lib/knex/knex";
import {getBranch, getBranchesByIds} from "../../../lib/core-client/branch.client";
import {OrderStatus} from "../../order/enums";
import {findOrderByPublicId, findAgentTasks, updateOrderStatus} from "../../order/repository/order.repo";
import {OrderStatusResponseDTO} from "../../order/dto/order.response.dto";
import {AssignmentService} from "../../assignment/service/assignment.service";
import {SettlementService} from "./settlement.service";
import {DeliveryTaskResponseDTO, AgentEarningsResponseDTO} from "../dto/agent.response.dto";
import {listByAgent, sumByAgent} from "../repository/agent-earning.repo";
import {NotYourTaskError, OrderNotInAssignedStateError, InvalidAgentTransitionError} from "../errors";
import {OrderNotFoundError} from "../../order/errors";

const TASK_LIST_LIMIT = 50;

@injectable()
export class AgentService {
    constructor(
        @inject(TOKENS.AssignmentService) private readonly assignment: AssignmentService,
        @inject(TOKENS.SettlementService) private readonly settlement: SettlementService,
    ) {}

    private get io(): IoServer {
        return container.resolve<IoServer>(TOKENS.WsServer);
    }

    async accept(publicId: string, agentId: number, region: string): Promise<DeliveryTaskResponseDTO> {
        return this.assignment.claim(publicId, agentId, region);
    }

    async reject(publicId: string, agentId: number): Promise<void> {
        await this.assignment.reject(publicId, agentId);
    }

    /** picked / delivered transitions for the assigned agent. */
    async transition(publicId: string, agentId: number, region: string, target: OrderStatus): Promise<DeliveryTaskResponseDTO> {
        if (target === OrderStatus.DELIVERED) {
            const updated = await this.settlement.settleDelivered(publicId, agentId, region);
            const branch = await getBranch(updated.branchId).catch(() => null);
            return DeliveryTaskResponseDTO.from(updated, branch ?? undefined);
        }

        if (target !== OrderStatus.PICKED) {
            throw InvalidAgentTransitionError;
        }

        const conn = db(region);
        const order = await findOrderByPublicId(publicId, conn);
        if (!order) throw OrderNotFoundError;
        if (order.deliveryAgentId !== agentId) throw NotYourTaskError;
        if (order.status !== OrderStatus.ASSIGNED) throw OrderNotInAssignedStateError;

        const trx = await conn.transaction();
        let updated;
        try {
            updated = await updateOrderStatus(publicId, OrderStatus.PICKED, "picked_at", trx);
            await trx.commit();
        } catch (err) {
            await trx.rollback();
            throw err;
        }
        const statusDto = OrderStatusResponseDTO.from(updated);
        this.io.to(`customer:${updated.customerId}`).emit("order.status_changed", statusDto);
        this.io.to(`branch:${updated.branchId}`).emit("order.status_changed", statusDto);
        const branch = await getBranch(updated.branchId).catch(() => null);
        return DeliveryTaskResponseDTO.from(updated, branch ?? undefined);
    }

    async listTasks(agentId: number, region: string, statusFilter?: string): Promise<DeliveryTaskResponseDTO[]> {
        const conn = db(region);
        const statuses = statusFilter ? [statusFilter] : [OrderStatus.ASSIGNED, OrderStatus.PICKED];
        const orders = await findAgentTasks(agentId, statuses, TASK_LIST_LIMIT, conn);
        // Single batch lookup for branch enrichment — at most one network
        // round-trip regardless of how many unique branches the agent has
        // tasks at. Cache hits per branch are also served from this call.
        const branchMap = await getBranchesByIds(orders.map((o) => o.branchId));
        const enriched = new Map<number, {lat: number; lng: number; name: string; addressText: string}>();
        for (const [id, b] of branchMap) {
            enriched.set(id, {lat: b.lat, lng: b.lng, name: b.name, addressText: b.addressText});
        }
        return orders.map((o) => DeliveryTaskResponseDTO.from(o, enriched.get(o.branchId)));
    }

    async earnings(agentId: number, region: string, from: Date, to: Date): Promise<AgentEarningsResponseDTO> {
        const conn = db(region);
        const items = await listByAgent(agentId, {from, to}, 100, conn);
        const sum = await sumByAgent(agentId, {from, to}, conn);
        return AgentEarningsResponseDTO.from(from, to, items, sum);
    }
}
