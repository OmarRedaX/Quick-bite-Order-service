import {randomUUID} from "crypto";
import {injectable, inject} from "tsyringe";
import {Server as IoServer} from "socket.io";
import {container} from "../../../lib/di/container";
import {TOKENS} from "../../../lib/di/tokens";
import {db} from "../../../lib/knex/knex";
import {assertRegion} from "../../../lib/sharding/regions";
import {ICacheProvider} from "../../../pkg/cache/cache.interface";
import {logger} from "../../../lib/logger/logger";
import {UnAuthorisedError} from "../../../lib/auth/errors";
import {sumMinor, multiplyMinor} from "../../../pkg/utils/money";
import {PaginationParams, FilterParams} from "../../../lib/http/pagination/cursor-pagination";
import {
    getBranch,
    getBranchProducts,
    reserveStock as coreReserveStock,
    releaseStock as coreReleaseStock,
} from "../../../lib/core-client/branch.client";
import {CoreBranchProduct} from "../../../lib/core-client/types";
import {getCustomerAddress, flattenAddress} from "../../../lib/core-client/address.client";
import {CoreDataCacheService} from "./core-data-cache.service";
import {PaymentService} from "../../payment/service/payment.service";
import {assertTransition} from "./order-status.service";
import {OrderEntity} from "../entity/order.entity";
import {OrderItemEntity} from "../entity/order-item.entity";
import {OrderStatus, PaymentMethod, Currency, StatusActor} from "../enums";
import {ActorContext, OrderLineDraft, UnavailableItem} from "../types";
import {
    OrderNotFoundError,
    BranchNotAcceptingOrdersError,
    OnlinePaymentNotAvailableError,
    outOfStockError,
} from "../errors";
import {env} from "../../../lib/config/env";
import {
    OrderResponseDTO,
    OrderDetailResponseDTO,
    OrderSummaryResponseDTO,
    OrderStatusResponseDTO,
} from "../dto/order.response.dto";
import {CreateOrderRequestDTO, UpdateOrderStatusRequestDTO} from "../dto/order.request.dto";
import {
    createOrder,
    findOrderByPublicId,
    updateOrderStatus,
    findOrdersByCustomer,
    findOrdersByRestaurantBranch,
} from "../repository/order.repo";
import {
    bulkInsertItems,
    findItemsByOrderIds,
    countItemsByOrderIds,
} from "../repository/order-item.repo";
import {insertOutboxEvent} from "../../../lib/events/outbox.repo";
import {EVENT_TYPES} from "../../../lib/events/event-types";

const SERVICE_FEE_MINOR = 1000; // 10.00 EGP / SAR — paid to the platform.

const RESTAURANT_ORDERS_CACHE_PREFIX = (region: string, branchId: number) =>
    `${region}:GET:/api/restaurant/orders?branchId=${branchId}`;

@injectable()
export class OrderService {
    constructor(
        @inject(TOKENS.CacheProvider) private readonly cache: ICacheProvider,
        @inject(TOKENS.CoreDataCacheService) private readonly coreData: CoreDataCacheService,
        @inject(TOKENS.PaymentService) private readonly paymentService: PaymentService,
    ) {}

    // Lazy access — WsServer is registered after the DI container builds the
    // routes (it depends on the http.Server, which is created in server.ts).
    private get io(): IoServer {
        return container.resolve<IoServer>(TOKENS.WsServer);
    }

    async placeOrder(actor: ActorContext, body: CreateOrderRequestDTO, region: string | undefined, correlationId?: string): Promise<OrderResponseDTO> {
        // 1. Branch metadata (drives shard region + accept flag + currency + delivery fee)
        const branch = await getBranch(body.branchId, correlationId);
        if (!branch.isActive || !branch.acceptOrders) throw BranchNotAcceptingOrdersError;
        if (branch.restaurantStatus !== "active") throw BranchNotAcceptingOrdersError;
        if (await this.coreData.isBranchRejectingOrders(body.branchId)) throw BranchNotAcceptingOrdersError;

        // Branch country may arrive uppercase ("EG"); shard router is lowercase.
        const resolvedRegion = assertRegion(region ?? branch.region);

        // Online gateway is enabled per-region (env-driven). Anything else falls
        // back to COD-only — fail fast before we touch stock.
        if (body.paymentMethod === PaymentMethod.ONLINE && !env.payments.onlineRegions.has(resolvedRegion)) {
            throw OnlinePaymentNotAvailableError;
        }

        // 2. Address (snapshot lat/lng + flat text)
        const address = await getCustomerAddress(body.customerAddressId, correlationId);
        if (Number(address.userId) !== Number(actor.userId)) throw UnAuthorisedError;

        // 3. Products (single batch)
        const productIds = body.items.map((i) => i.productId);
        const products = await getBranchProducts(body.branchId, productIds, correlationId);
        const orderLineDrafts = this.buildOrderLineDrafts(body.items, products);

        // 4. Money
        const subtotal = sumMinor(orderLineDrafts.map((l) => l.lineTotal));
        const total = subtotal + branch.deliveryFee + SERVICE_FEE_MINOR;

        // 5. Reserve stock FIRST. If anything below this point fails, we MUST release.
        // Reserve is atomic on the core side (FOR UPDATE + 409 on underflow) so we
        // can't oversell. Using the publicId as the idempotency key means a retry
        // never double-reserves.
        const publicId = randomUUID();
        await coreReserveStock(
            body.branchId,
            body.items.map((i) => ({productId: i.productId, quantity: i.quantity})),
            publicId,
            correlationId,
        );

        // 6. Trx on the branch's region
        const conn = db(resolvedRegion);
        const trx = await conn.transaction();
        let order: OrderEntity;
        let items: OrderItemEntity[];
        try {
            order = await createOrder({
                region: resolvedRegion,
                publicId,
                countryCode: branch.region,
                restaurantId: Number(branch.restaurantId),
                restaurantOwnerId: Number(branch.restaurantOwnerId),
                branchId: Number(branch.id),
                customerId: actor.userId,
                customerAddressId: Number(address.id),
                deliveryLat: Number(address.lat),
                deliveryLng: Number(address.lng),
                deliveryAddressTextSnapshot: flattenAddress(address),
                branchLat: Number(branch.lat),
                branchLng: Number(branch.lng),
                status: body.paymentMethod === PaymentMethod.ONLINE ? OrderStatus.PENDING_PAYMENT : OrderStatus.PLACED,
                subtotal,
                deliveryFee: branch.deliveryFee,
                serviceFee: SERVICE_FEE_MINOR,
                total,
                currency: branch.currency as Currency,
                paymentMethod: body.paymentMethod,
            }, trx);

            items = await bulkInsertItems(
                orderLineDrafts.map((l) => ({
                    region: resolvedRegion,
                    orderId: order.id,
                    productId: l.productId,
                    quantity: l.quantity,
                    unitPriceSnapshot: l.unitPrice,
                    nameSnapshot: l.name,
                    imageUrlSnapshot: l.imageUrl,
                    lineTotal: l.lineTotal,
                })),
                trx,
            );

            // Transactional outbox — only COD lands as `placed` here.
            // ONLINE orders start as `pending_payment` and emit `order.placed`
            // from the Kashier webhook after capture (see kashier-webhook.service.ts).
            if (order.status === OrderStatus.PLACED) {
                await insertOutboxEvent(trx, {
                    aggregateType: "order",
                    aggregateId: order.publicId,
                    eventType: EVENT_TYPES.ORDER_PLACED,
                    payload: buildOrderPlacedPayload(order, items),
                });
            }

            await trx.commit();
        } catch (err) {
            await trx.rollback();
            await this.releaseStockSafe(body.branchId, body.items, publicId, correlationId);
            throw err;
        }

        // 7. Online → init Kashier session. Rollback on failure (void order +
        // release stock) so the customer is never stranded.
        let paymentInfo;
        if (body.paymentMethod === PaymentMethod.ONLINE) {
            try {
                const result = await this.paymentService.initOnlinePayment(order);
                paymentInfo = {
                    sessionId: result.dto.sessionId,
                    providerSessionId: result.dto.providerSessionId,
                    redirectUrl: result.dto.redirectUrl,
                    expiresAt: result.dto.expiresAt,
                };
            } catch (err) {
                logger.warn("payment init failed; voiding order", {publicId: order.publicId, error: (err as Error).message});
                await this.voidOrderSafe(resolvedRegion, order.publicId);
                await this.releaseStockSafe(body.branchId, body.items, order.publicId, correlationId);
                throw err;
            }
        }

        // 8. Cache + WS
        await this.invalidateBranchOrdersCache(resolvedRegion, branch.id);
        if (body.paymentMethod === PaymentMethod.COD) {
            this.io
                .to(`branch:${branch.id}`)
                .emit("order.created", OrderSummaryResponseDTO.from(order, items.length));
        }

        return OrderResponseDTO.from(order, items, paymentInfo);
    }

    private async voidOrderSafe(region: string, publicId: string): Promise<void> {
        try {
            const trx = await db(region).transaction();
            try {
                await updateOrderStatus(publicId, OrderStatus.CANCELLED, "cancelled_at", trx);
                await trx.commit();
            } catch (e) {
                await trx.rollback();
                throw e;
            }
        } catch (err) {
            logger.error("voidOrderSafe failed (order remains in pending_payment)", {publicId, error: (err as Error).message});
        }
    }

    async getOrder(actor: ActorContext, region: string, publicId: string): Promise<OrderDetailResponseDTO> {
        const conn = db(region);
        const order = await findOrderByPublicId(publicId, conn);
        if (!order) throw OrderNotFoundError;

        this.assertReadAccess(actor, order);

        const items = await findItemsByOrderIds([order.id], conn);
        return OrderDetailResponseDTO.from(order, items);
    }

    async listCustomerOrders(actor: ActorContext, region: string, year: number, pagination: PaginationParams) {
        const yearStart = new Date(Date.UTC(year, 0, 1));
        const yearEnd = new Date(Date.UTC(year + 1, 0, 1));
        const conn = db(region);
        const result = await findOrdersByCustomer({customerId: actor.userId, yearStart, yearEnd}, pagination, conn);
        const counts = await countItemsByOrderIds(result.data.map((o) => o.id), conn);
        return {
            data: result.data.map((o) => OrderSummaryResponseDTO.from(o, counts.get(o.id) ?? 0)),
            meta: result.meta,
        };
    }

    async listRestaurantOrders(
        _actor: ActorContext,
        region: string,
        restaurantId: number,
        branchId: number,
        status: OrderStatus | undefined,
        from: Date | undefined,
        to: Date | undefined,
        filters: FilterParams[],
        pagination: PaginationParams,
    ) {
        const conn = db(region);
        const result = await findOrdersByRestaurantBranch(
            {restaurantId, branchId, status, from, to},
            pagination,
            filters,
            conn,
        );
        const counts = await countItemsByOrderIds(result.data.map((o) => o.id), conn);
        return {
            data: result.data.map((o) => OrderSummaryResponseDTO.from(o, counts.get(o.id) ?? 0)),
            meta: result.meta,
        };
    }

    async updateStatus(actor: ActorContext, region: string, publicId: string, body: UpdateOrderStatusRequestDTO): Promise<OrderStatusResponseDTO> {
        const conn = db(region);
        const order = await findOrderByPublicId(publicId, conn);
        if (!order) throw OrderNotFoundError;

        const statusActor = this.resolveStatusActor(actor, order);
        const {stamp} = assertTransition(order.status, body.status, {
            actor: statusActor,
            reason: body.reason,
            placedAt: order.createdAt,
            acceptedAt: order.acceptedAt,
        });

        const trx = await conn.transaction();
        let updated: OrderEntity;
        try {
            updated = await updateOrderStatus(order.publicId, body.status, stamp, trx);

            // Transactional outbox — pick the matching event type for the
            // new status. Same trx as the status update so we can't publish
            // a state we then roll back.
            const eventType = OUTBOX_EVENT_FOR_STATUS[body.status];
            if (eventType) {
                await insertOutboxEvent(trx, {
                    aggregateType: "order",
                    aggregateId: updated.publicId,
                    eventType,
                    payload: buildOrderTransitionPayload(updated, body.reason, statusActor),
                });
            }

            await trx.commit();
        } catch (err) {
            await trx.rollback();
            throw err;
        }

        await this.invalidateBranchOrdersCache(region, order.branchId);

        const payload = OrderStatusResponseDTO.from(updated);
        this.io.to(`customer:${updated.customerId}`).emit("order.status_changed", payload);
        this.io.to(`branch:${updated.branchId}`).emit("order.status_changed", payload);

        return payload;
    }

    // ── private helpers ──────────────────────────────────────────────────
    private buildOrderLineDrafts(
        requested: Array<{productId: number; quantity: number}>,
        products: CoreBranchProduct[],
    ): OrderLineDraft[] {
        const byProduct = new Map<number, CoreBranchProduct>();
        for (const p of products) byProduct.set(Number(p.productId), p);

        const unavailableItems: UnavailableItem[] = [];
        const drafts: OrderLineDraft[] = [];

        for (const it of requested) {
            const p = byProduct.get(it.productId);
            if (!p || !p.isAvailable) {
                unavailableItems.push({productId: it.productId, requested: it.quantity, available: 0});
                continue;
            }
            if (p.stock < it.quantity) {
                unavailableItems.push({productId: it.productId, requested: it.quantity, available: p.stock});
                continue;
            }
            drafts.push({
                productId: it.productId,
                quantity: it.quantity,
                unitPrice: p.price,
                lineTotal: multiplyMinor(p.price, it.quantity),
                name: p.name,
                imageUrl: p.imageUrl,
            });
        }
        if (unavailableItems.length > 0) throw outOfStockError(unavailableItems);
        return drafts;
    }

    private async releaseStockSafe(
        branchId: number,
        items: Array<{productId: number; quantity: number}>,
        idempotencyKey: string,
        correlationId?: string,
    ): Promise<void> {
        try {
            await coreReleaseStock(branchId, items, idempotencyKey, correlationId);
        } catch (err) {
            // Log loudly but do not mask the original error; release-stock failure
            // is observability/alerting territory, not a customer-facing error.
            logger.error("releaseStock failed after order placement rollback", {
                branchId,
                error: (err as Error).message,
            });
        }
    }

    private assertReadAccess(actor: ActorContext, order: OrderEntity) {
        if (actor.role === "system_admin") return;
        if (Number(actor.userId) === Number(order.customerId)) return;

        if (actor.role === "restaurant_user") {
            if (Number(actor.restaurantId) !== Number(order.restaurantId)) throw UnAuthorisedError;
            if (actor.restaurantRole === "owner") return;
            const branchIds = actor.branchIds ?? [];
            if (branchIds.includes(Number(order.branchId))) return;
        }
        throw UnAuthorisedError;
    }

    private resolveStatusActor(actor: ActorContext, order: OrderEntity): StatusActor {
        if (actor.role === "system_admin") return StatusActor.ADMIN;
        if (actor.role === "delivery_agent" && Number(actor.userId) === Number(order.deliveryAgentId)) return StatusActor.AGENT;
        if (actor.role === "restaurant_user") {
            if (Number(actor.restaurantId) !== Number(order.restaurantId)) throw UnAuthorisedError;
            if (actor.restaurantRole !== "owner") {
                const branchIds = actor.branchIds ?? [];
                if (!branchIds.includes(Number(order.branchId))) throw UnAuthorisedError;
            }
            return StatusActor.RESTAURANT_MEMBER;
        }
        if (Number(actor.userId) === Number(order.customerId)) return StatusActor.CUSTOMER;
        throw UnAuthorisedError;
    }

    private async invalidateBranchOrdersCache(region: string, branchId: number) {
        try {
            await this.cache.del(RESTAURANT_ORDERS_CACHE_PREFIX(region, branchId));
        } catch {}
    }
}

// ─── Outbox payload builders ─────────────────────────────────────────────────
// Kept as module-level helpers (not class methods) so they're easy to unit-test
// in isolation and don't drag a `this` context into the trx callback.

const OUTBOX_EVENT_FOR_STATUS: Partial<Record<OrderStatus, string>> = {
    [OrderStatus.ACCEPTED]: EVENT_TYPES.ORDER_ACCEPTED,
    [OrderStatus.REJECTED]: EVENT_TYPES.ORDER_REJECTED,
    [OrderStatus.CANCELLED]: EVENT_TYPES.ORDER_CANCELLED,
};

/** Matches analytics-service contract (docs/api-contracts.md — order.placed payload). */
function buildOrderPlacedPayload(order: OrderEntity, items: OrderItemEntity[]) {
    return {
        orderId: order.publicId,
        region: order.region,
        countryCode: order.countryCode,
        restaurantId: Number(order.restaurantId),
        branchId: Number(order.branchId),
        customerId: Number(order.customerId),
        status: order.status,
        paymentMethod: order.paymentMethod,
        subtotal: order.subtotal,
        deliveryFee: order.deliveryFee,
        serviceFee: order.serviceFee,
        total: order.total,
        currency: order.currency,
        items: items.map((i) => ({
            productId: Number(i.productId),
            quantity: i.quantity,
            unitPrice: i.unitPriceSnapshot,
            lineTotal: i.lineTotal,
        })),
        placedAt: order.createdAt.toISOString(),
    };
}

function buildOrderTransitionPayload(order: OrderEntity, reason: string | undefined, actor: StatusActor) {
    return {
        orderId: order.publicId,
        region: order.region,
        restaurantId: Number(order.restaurantId),
        branchId: Number(order.branchId),
        customerId: Number(order.customerId),
        status: order.status,
        reason: reason ?? null,
        actor,
        occurredAt: order.updatedAt.toISOString(),
    };
}
