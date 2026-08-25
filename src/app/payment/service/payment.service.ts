import {injectable, inject} from "tsyringe";
import {TOKENS} from "../../../lib/di/tokens";
import {db} from "../../../lib/knex/knex";
import {logger} from "../../../lib/logger/logger";
import {fromMinor} from "../../../pkg/utils/money";
import {toMs} from "../../../pkg/utils/time";
import {env} from "../../../lib/config/env";
import {IPaymentProvider} from "../../../pkg/payments/payment.interface";
import {OrderEntity} from "../../order/entity/order.entity";
import {UnAuthorisedError} from "../../../lib/auth/errors";
import {
    createSession,
    findActiveSessionByOrderId,
} from "../repository/payment-session.repo";
import {findTransactionWithRestaurant} from "../repository/transaction.repo";
import {PaymentSessionEntity} from "../entity/payment-session.entity";
import {PaymentSessionStatus, PaymentProviderName, PAYMENT_PROVIDER_IDS} from "../enums";
import {PaymentInitResponseDTO, PaymentResponseDTO} from "../dto/payment.response.dto";
import {
    PaymentNotFoundError,
    PaymentProviderUnavailableError,
} from "../errors";

interface InitOnlinePaymentResult {
    session: PaymentSessionEntity;
    expiresAt: string;
    dto: PaymentInitResponseDTO;
}

@injectable()
export class PaymentService {
    constructor(@inject(TOKENS.KashierProvider) private readonly kashier: IPaymentProvider) {}

    /**
     * Called from OrderService.placeOrder for online orders, AFTER the order
     * row has been committed.
     *
     * Idempotent at the domain level: if an active session exists for this
     * order (initialized/pending), we return its redirectUrl rather than
     * minting a second one.
     */
    async initOnlinePayment(order: OrderEntity): Promise<InitOnlinePaymentResult> {
        const conn = db(order.region);
        const sessionTtlMs = toMs(env.payments.sessionTimeoutMin, "m");

        const existing = await findActiveSessionByOrderId(order.id, conn);
        if (existing) {
            // Session already alive — surface it as-is. Kashier's iframe enforces its own expireAt.
            const expiresAt = new Date(existing.createdAt.getTime() + sessionTtlMs).toISOString();
            return {
                session: existing,
                expiresAt,
                dto: PaymentInitResponseDTO.from(existing, expiresAt),
            };
        }

        let providerResp;
        try {
            providerResp = await this.kashier.createSession({
                merchantOrderId: order.publicId,
                amount: fromMinor(order.total).toFixed(2),
                currency: order.currency,
                description: `QuickBite order ${order.publicId}`,
                allowedMethods: "card,wallet",
                customerReference: String(order.customerId),
            });
        } catch (err) {
            logger.error("kashier createSession failed", {
                orderPublicId: order.publicId,
                error: (err as Error).message,
            });
            throw PaymentProviderUnavailableError;
        }

        const session = await createSession({
            region: order.region,
            orderId: order.id,
            providerId: PAYMENT_PROVIDER_IDS[PaymentProviderName.KASHIER],
            providerSessionId: providerResp.providerSessionId,
            redirectUrl: providerResp.redirectUrl,
            amount: order.total,
            currency: order.currency,
            status: PaymentSessionStatus.INITIALIZED,
            rawInitPayload: providerResp.rawResponse,
        }, conn);

        const expiresAt = providerResp.expiresAt
            ?? new Date(Date.now() + sessionTtlMs).toISOString();

        return {
            session,
            expiresAt,
            dto: PaymentInitResponseDTO.from(session, expiresAt),
        };
    }

    /**
     * GET /restaurants/:restaurantId/payments/:paymentId.
     *
     * Auth split between layers:
     *   - middleware (`requireRestaurantMember` + `rbac`) gates the request to
     *     members of the restaurant in the URL with `payments:read`;
     *     `system_admin` bypasses both.
     *   - this method just enforces "the payment actually belongs to that
     *     restaurant" so a member can't peek into a sibling restaurant by id.
     *
     * Single SQL via JOIN — no N+1.
     */
    async getById(paymentId: number, restaurantId: number, region: string): Promise<PaymentResponseDTO> {
        const conn = db(region);
        const found = await findTransactionWithRestaurant(paymentId, conn);
        if (!found) throw PaymentNotFoundError;

        if (found.restaurantId !== null && found.restaurantId !== restaurantId) {
            // The middleware verified the caller's right to see "restaurantId",
            // but the transaction belongs to a different restaurant.
            throw UnAuthorisedError;
        }

        return PaymentResponseDTO.from(found.transaction);
    }
}
