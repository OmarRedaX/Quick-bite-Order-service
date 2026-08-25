import {injectable, inject} from "tsyringe";
import {Server as IoServer} from "socket.io";
import {container} from "../../../lib/di/container";
import {TOKENS} from "../../../lib/di/tokens";
import {db} from "../../../lib/knex/knex";
import {env} from "../../../lib/config/env";
import {logger} from "../../../lib/logger/logger";
import {ICacheProvider} from "../../../pkg/cache/cache.interface";
import {getBranch} from "../../../lib/core-client/branch.client";
import {OrderEntity} from "../../order/entity/order.entity";
import {OrderStatus, PaymentMethod} from "../../order/enums";
import {findOrderByPublicId, updateOrderStatus, updateOrderCommission} from "../../order/repository/order.repo";
import {OrderStatusResponseDTO} from "../../order/dto/order.response.dto";
import {createTransactionIdempotent} from "../../payment/repository/transaction.repo";
import {TransactionType, TransactionMethod, TransactionStatus} from "../../payment/enums";
import {upsertIncrement} from "../../finance/repository/restaurant-balance.repo";
import {insertEarning} from "../repository/agent-earning.repo";
import {PresenceService} from "./presence.service";
import {NotYourTaskError} from "../errors";
import {OrderNotFoundError, invalidStatusTransitionError} from "../../order/errors";
import {AssignmentService} from "../../assignment/service/assignment.service";
import {insertOutboxEvent} from "../../../lib/events/outbox.repo";
import {EVENT_TYPES} from "../../../lib/events/event-types";

/**
 * Single trx that runs on the `delivered` transition. Handles:
 *   1. COD: insert cod_collection / succeeded (if not already there).
 *   2. Commission: compute + write commission tx, fill orders.commission.
 *      (Phase 4 turns the commission part on; Phase 3 leaves it at 0 if
 *      `commissionBps` is 0/missing.)
 *   3. Restaurant balance: += (subtotal - commission).
 *   4. Agent earning: floor(delivery_fee × AGENT_EARNING_SHARE_BPS / 10000).
 *   5. orders.status = delivered, delivered_at = now().
 *
 * After-commit: free the agent in Redis, drop the claim lock, WS.
 */
@injectable()
export class SettlementService {
    constructor(
        @inject(TOKENS.PresenceService) private readonly presence: PresenceService,
        @inject(TOKENS.CacheProvider) private readonly cache: ICacheProvider,
    ) {}

    private get io(): IoServer {
        return container.resolve<IoServer>(TOKENS.WsServer);
    }

    async settleDelivered(publicId: string, agentId: number, region: string): Promise<OrderEntity> {
        const conn = db(region);

        // Pre-trx fetch (read-only) so we can pull commissionBps from core's cache
        // without holding row locks across an HTTP call.
        const order = await findOrderByPublicId(publicId, conn);
        if (!order) throw OrderNotFoundError;
        if (order.deliveryAgentId !== agentId) throw NotYourTaskError;
        // Guards against a duplicate "mark delivered" call re-crediting the
        // restaurant balance: the transaction/earning inserts below are
        // idempotent via unique keys, but upsertIncrement is a running total
        // and is NOT — re-running this on an already-delivered order would
        // silently double-credit it.
        if (order.status !== OrderStatus.PICKED) throw invalidStatusTransitionError(order.status, OrderStatus.DELIVERED);

        // Branch fetch is cached in core's read-through; failure => commission stays 0.
        let commissionBps = 0;
        try {
            const branch = await getBranch(order.branchId);
            commissionBps = Number(branch.commissionBps ?? 0);
        } catch (err) {
            logger.warn("settlement: branch fetch failed; commission set to 0", {publicId, error: (err as Error).message});
        }
        const commission = Math.floor((order.subtotal * commissionBps) / 10000);
        const earning = Math.floor((order.deliveryFee * env.delivery.agentEarningShareBps) / 10000);

        const trx = await conn.transaction();
        let updated: OrderEntity;
        try {
            // Stamp commission FIRST so subsequent writes see the right number.
            await updateOrderCommission(publicId, commission, trx);

            // For COD, write the charge transaction now (succeeded; the agent took the cash).
            if (order.paymentMethod === PaymentMethod.COD) {
                await createTransactionIdempotent({
                    region,
                    orderId: order.id,
                    transactionType: TransactionType.COD_COLLECTION,
                    method: TransactionMethod.COD,
                    providerId: null,
                    providerReferenceId: null,
                    status: TransactionStatus.SUCCEEDED,
                    amount: order.total,
                    currency: order.currency,
                    srcAccId: order.customerId,
                    dstAccId: order.restaurantOwnerId,
                    idempotencyKey: `cod-collect:${order.publicId}`,
                }, trx);
            }

            // Commission: src=restaurant owner, dst=NULL (platform — no user record).
            if (commission > 0) {
                await createTransactionIdempotent({
                    region,
                    orderId: order.id,
                    transactionType: TransactionType.COMMISSION,
                    method: TransactionMethod.SYSTEM,
                    providerId: null,
                    providerReferenceId: null,
                    status: TransactionStatus.SUCCEEDED,
                    amount: commission,
                    currency: order.currency,
                    srcAccId: order.restaurantOwnerId,
                    dstAccId: null,
                    idempotencyKey: `commission:${order.publicId}`,
                }, trx);
            }

            // Service fee: customer paid it as part of `total`. For COD the
            // cod_collection above credits `total` to the restaurant owner;
            // the service fee is owed back to the platform. Book the
            // restaurant → platform transfer explicitly so finance reconciles.
            if (order.serviceFee > 0) {
                await createTransactionIdempotent({
                    region,
                    orderId: order.id,
                    transactionType: TransactionType.ADJUSTMENT,
                    method: TransactionMethod.SYSTEM,
                    providerId: null,
                    providerReferenceId: null,
                    status: TransactionStatus.SUCCEEDED,
                    amount: order.serviceFee,
                    currency: order.currency,
                    srcAccId: order.restaurantOwnerId,
                    dstAccId: null,
                    idempotencyKey: `service-fee:${order.publicId}`,
                }, trx);
            }

            // Delivery fee: same story — customer paid it inside `total`, it's
            // not the restaurant's money. Book restaurant → platform; the
            // agent's share is paid out separately via agent_earnings.
            if (order.deliveryFee > 0) {
                await createTransactionIdempotent({
                    region,
                    orderId: order.id,
                    transactionType: TransactionType.ADJUSTMENT,
                    method: TransactionMethod.SYSTEM,
                    providerId: null,
                    providerReferenceId: null,
                    status: TransactionStatus.SUCCEEDED,
                    amount: order.deliveryFee,
                    currency: order.currency,
                    srcAccId: order.restaurantOwnerId,
                    dstAccId: null,
                    idempotencyKey: `delivery-fee:${order.publicId}`,
                }, trx);
            }

            // Restaurant balance: net of commission.
            const netToRestaurant = order.subtotal - commission;
            if (netToRestaurant !== 0) {
                await upsertIncrement({
                    restaurantId: order.restaurantId,
                    region,
                    currency: order.currency,
                    delta: netToRestaurant,
                }, trx);
            }

            // Agent earning. UNIQUE(order_id) makes this idempotent.
            await insertEarning({
                region,
                agentId: order.deliveryAgentId!,
                orderId: order.id,
                amount: earning,
                currency: order.currency,
            }, trx);

            // Finally flip status to delivered.
            updated = await updateOrderStatus(publicId, OrderStatus.DELIVERED, "delivered_at", trx);

            // Transactional outbox — order.delivered for analytics + future consumers.
            // Same trx so a publish never escapes a rolled-back settlement.
            await insertOutboxEvent(trx, {
                aggregateType: "order",
                aggregateId: updated.publicId,
                eventType: EVENT_TYPES.ORDER_DELIVERED,
                payload: {
                    orderId: updated.publicId,
                    region: updated.region,
                    restaurantId: Number(updated.restaurantId),
                    branchId: Number(updated.branchId),
                    customerId: Number(updated.customerId),
                    deliveryAgentId: agentId,
                    total: updated.total,
                    subtotal: updated.subtotal,
                    deliveryFee: updated.deliveryFee,
                    commission,
                    currency: updated.currency,
                    paymentMethod: updated.paymentMethod,
                    deliveredAt: updated.deliveredAt?.toISOString() ?? new Date().toISOString(),
                },
            });

            await trx.commit();
        } catch (err) {
            await trx.rollback();
            throw err;
        }

        // After-commit Redis + WS — never publish state we then roll back.
        await this.presence.clearBusy(region, agentId);
        await this.cache.del(AssignmentService.claimKey(publicId));

        const statusDto = OrderStatusResponseDTO.from(updated);
        this.io.to(`customer:${updated.customerId}`).emit("order.status_changed", statusDto);
        this.io.to(`branch:${updated.branchId}`).emit("order.status_changed", statusDto);

        return updated;
    }
}
