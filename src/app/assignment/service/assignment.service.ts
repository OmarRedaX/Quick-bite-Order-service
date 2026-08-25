import {injectable, inject} from "tsyringe";
import {Server as IoServer} from "socket.io";
import {container} from "../../../lib/di/container";
import {TOKENS} from "../../../lib/di/tokens";
import {env} from "../../../lib/config/env";
import {db} from "../../../lib/knex/knex";
import {logger} from "../../../lib/logger/logger";
import {ICacheProvider} from "../../../pkg/cache/cache.interface";
import {getBranch} from "../../../lib/core-client/branch.client";
import {OrderEntity} from "../../order/entity/order.entity";
import {findOrderByPublicId, findReadyUnassigned, claimReadyOrderForAgent} from "../../order/repository/order.repo";
import {OrderStatusResponseDTO} from "../../order/dto/order.response.dto";
import {DeliveryTaskResponseDTO} from "../../agent/dto/agent.response.dto";
import {PresenceService} from "../../agent/service/presence.service";
import {
    OfferNotFoundOrExpiredError,
    NotInCandidateListError,
    OrderAlreadyClaimedError,
    OrderNotInReadyStateError,
} from "../../agent/errors";

interface OfferPayload {
    orderId: string;            // public_id
    branch: {id: number; lat: number; lng: number; name: string; addressText: string};
    dropoff: {lat: number; lng: number; addressText: string};
    total: number;
    currency: string;
    paymentMethod: string;
    expiresAt: string;
}

@injectable()
export class AssignmentService {
    constructor(
        @inject(TOKENS.CacheProvider) private readonly cache: ICacheProvider,
        @inject(TOKENS.PresenceService) private readonly presence: PresenceService,
    ) {}

    private get io(): IoServer {
        return container.resolve<IoServer>(TOKENS.WsServer);
    }

    static offerKey(orderPublicId: string): string {
        return `offer:order:${orderPublicId}`;
    }
    static claimKey(orderPublicId: string): string {
        return `claim:order:${orderPublicId}`;
    }
    static attemptsKey(orderPublicId: string): string {
        return `assign:attempts:${orderPublicId}`;
    }

    /** Worker entrypoint: process up to BATCH ready orders for a region. */
    async tickRegion(region: string): Promise<{processed: number; offered: number; skipped: number}> {
        const conn = db(region);
        const orders = await findReadyUnassigned(env.delivery.batch, conn);
        let offered = 0;
        let skipped = 0;
        for (const o of orders) {
            const result = await this.tryAssign(o, region).catch((err) => {
                logger.error("tryAssign failed", {publicId: o.publicId, error: (err as Error).message});
                return "error" as const;
            });
            if (result === "offered") offered++;
            else skipped++;
        }
        return {processed: orders.length, offered, skipped};
    }

    /**
     * Find candidates → broadcast `task.offered` → set offer marker. The
     * acceptance is owned by `claim()` (called from POST /agents/orders/:id/accept).
     */
    async tryAssign(order: OrderEntity, region: string): Promise<"offered" | "skipped" | "exhausted" | "no-candidates"> {
        // Already broadcasting? Don't double-offer until the current offer expires.
        if (await this.cache.exists(AssignmentService.offerKey(order.publicId))) return "skipped";

        // Cap reassignment attempts. Beyond the cap → admin alert; order stays ready.
        const attemptsRaw = await this.cache.get(AssignmentService.attemptsKey(order.publicId));
        const attempts = Number(attemptsRaw ?? 0);
        if (attempts >= env.delivery.maxAttempts) {
            this.io.to("admin:alerts").emit("assignment.exhausted", {orderId: order.publicId, attempts});
            // extend to update the orders table to alert the restaurat that the order cant be assigned or rely on created_At stamp
            return "exhausted";
        }

        // GEOSEARCH uses the snapshotted branch_lat/branch_lng on the order
        // — zero network calls on the hot path, audit-correct (the assignment
        // distance is always against the branch location at placement time).
        const candidates = await this.findCandidates(region, order.branchLng, order.branchLat);
        if (candidates.length === 0) {
            await this.cache.incr(AssignmentService.attemptsKey(order.publicId));
            await this.cache.expire(AssignmentService.attemptsKey(order.publicId), 3600);
            return "no-candidates";
        }

        // SETNX with TTL — concurrent worker ticks across multiple processes
        // can't both broadcast the same offer.
        const offerSet = await this.cache.trySet(
            AssignmentService.offerKey(order.publicId),
            candidates.join(","),
            env.delivery.offerTtlSec,
        );
        if (!offerSet) return "skipped";

        await this.cache.incr(AssignmentService.attemptsKey(order.publicId));
        await this.cache.expire(AssignmentService.attemptsKey(order.publicId), 3600);

        // Branch fetch (cache-first) is needed only for the offer payload's
        // human-readable name + addressText. One Redis hit per offer (not
        // per candidate). Failure → omit the display fields rather than block.
        const branch = await getBranch(order.branchId).catch(() => null);
        const expiresAt = new Date(Date.now() + env.delivery.offerTtlSec * 1000).toISOString();
        const payload: OfferPayload = {
            orderId: order.publicId,
            branch: {
                id: order.branchId,
                lat: order.branchLat,
                lng: order.branchLng,
                name: branch?.name ?? "",
                addressText: branch?.addressText ?? "",
            },
            dropoff: {lat: order.deliveryLat, lng: order.deliveryLng, addressText: order.deliveryAddressTextSnapshot},
            total: order.total,
            currency: order.currency,
            paymentMethod: order.paymentMethod,
            expiresAt,
        };

        for (const agentId of candidates) {
            this.io.to(`agent:${agentId}`).emit("task.offered", payload);
        }
        logger.info("assignment.broadcast", {publicId: order.publicId, candidates, attempts: attempts + 1});
        return "offered";
    }

    /**
     * Atomic claim. Returns the DeliveryTaskResponseDTO on success;
     * throws OrderAlreadyClaimedError if another agent won the race.
     */
    async claim(publicId: string, agentId: number, region: string): Promise<DeliveryTaskResponseDTO> {
        // Verify the agent was offered this order.
        const offered = await this.cache.get(AssignmentService.offerKey(publicId));
        if (!offered) throw OfferNotFoundOrExpiredError;
        const candidateIds = offered.split(",").map(Number);
        if (!candidateIds.includes(agentId)) throw NotInCandidateListError;

        // Atomic SETNX claim — first acceptor wins.
        const ok = await this.cache.trySet(
            AssignmentService.claimKey(publicId),
            String(agentId),
            env.delivery.claimTtlSec,
        );
        if (!ok) throw OrderAlreadyClaimedError;

        const conn = db(region);
        const trx = await conn.transaction();
        let updated: OrderEntity;
        try {
            const order = await findOrderByPublicId(publicId, trx);
            if (!order) {
                await this.cache.del(AssignmentService.claimKey(publicId));
                throw OrderNotInReadyStateError;
            }
            const claimed = await claimReadyOrderForAgent(publicId, agentId, trx);
            if (!claimed) {
                await this.cache.del(AssignmentService.claimKey(publicId));
                throw OrderNotInReadyStateError;
            }
            updated = claimed;
            await trx.commit();
        } catch (err) {
            await trx.rollback();
            await this.cache.del(AssignmentService.claimKey(publicId));
            throw err;
        }

        await this.presence.markBusy(region, agentId);

        // Fan out: winner -> task.assigned, losers -> offer.cancelled,
        // customer/branch -> order.status_changed.
        const losers = candidateIds.filter((id) => id !== agentId);
        const branch = await getBranch(updated.branchId).catch(() => null);
        const taskDto = DeliveryTaskResponseDTO.from(updated, branch ?? undefined);
        const statusDto = OrderStatusResponseDTO.from(updated);

        this.io.to(`agent:${agentId}`).emit("task.assigned", taskDto);
        for (const loser of losers) {
            this.io.to(`agent:${loser}`).emit("offer.cancelled", {orderId: publicId, reason: "claimed_by_other"});
        }
        this.io.to(`customer:${updated.customerId}`).emit("order.status_changed", statusDto);
        this.io.to(`branch:${updated.branchId}`).emit("order.status_changed", statusDto);

        // Drop the offer marker (claim TTL keeps the lock).
        await this.cache.del(AssignmentService.offerKey(publicId));

        return taskDto;
    }

    /** Caller already verified the agent is in the offer; just decrement. */
    async reject(publicId: string, agentId: number): Promise<void> {
        const offered = await this.cache.get(AssignmentService.offerKey(publicId));
        if (!offered) throw OfferNotFoundOrExpiredError;
        const candidateIds = offered.split(",").map(Number);
        if (!candidateIds.includes(agentId)) throw NotInCandidateListError;
        const remaining = candidateIds.filter((id) => id !== agentId);
        if (remaining.length === 0) {
            await this.cache.del(AssignmentService.offerKey(publicId));
        } else {
            const remainingTtl = await this.cache.ttl(AssignmentService.offerKey(publicId));
            await this.cache.set(
                AssignmentService.offerKey(publicId),
                remaining.join(","),
                Math.max(remainingTtl, 1),
            );
        }
    }

    /**
     * Admin override — bypasses the offer/candidate flow entirely. Force-claims
     * the order for the specified agent regardless of distance/busy state.
     */
    async adminAssign(publicId: string, agentId: number, region: string): Promise<DeliveryTaskResponseDTO> {
        const ok = await this.cache.trySet(
            AssignmentService.claimKey(publicId),
            String(agentId),
            env.delivery.claimTtlSec,
        );
        if (!ok) throw OrderAlreadyClaimedError;

        const conn = db(region);
        const trx = await conn.transaction();
        let updated: OrderEntity;
        try {
            const claimed = await claimReadyOrderForAgent(publicId, agentId, trx);
            if (!claimed) {
                await this.cache.del(AssignmentService.claimKey(publicId));
                throw OrderNotInReadyStateError;
            }
            updated = claimed;
            await trx.commit();
        } catch (err) {
            await trx.rollback();
            await this.cache.del(AssignmentService.claimKey(publicId));
            throw err;
        }

        await this.presence.markBusy(region, agentId);

        const branch = await getBranch(updated.branchId).catch(() => null);
        const taskDto = DeliveryTaskResponseDTO.from(updated, branch ?? undefined);
        const statusDto = OrderStatusResponseDTO.from(updated);
        this.io.to(`agent:${agentId}`).emit("task.assigned", taskDto);
        this.io.to(`customer:${updated.customerId}`).emit("order.status_changed", statusDto);
        this.io.to(`branch:${updated.branchId}`).emit("order.status_changed", statusDto);
        await this.cache.del(AssignmentService.offerKey(publicId));
        return taskDto;
    }

    /** GEOSEARCH + filter by presence:meta TTL + filter out busy agents. */
    private async findCandidates(region: string, lng: number, lat: number): Promise<number[]> {
        const overscan = env.delivery.candidates * 4;
        const raw = await this.cache.geosearchByRadius(
            PresenceService.geoKey(region),
            lng,
            lat,
            env.delivery.radiusMeters,
            overscan,
        );

        const result: number[] = [];
        for (const idStr of raw) {
            const agentId = Number(idStr);
            if (!Number.isFinite(agentId)) continue;
            if (!(await this.cache.exists(PresenceService.metaKey(region, agentId)))) continue;
            if (await this.cache.sismember(PresenceService.busyKey(region), idStr)) continue;
            result.push(agentId);
            if (result.length >= env.delivery.candidates) break;
        }
        return result;
    }
}
