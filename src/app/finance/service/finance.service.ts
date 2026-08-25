import {injectable} from "tsyringe";
import {db} from "../../../lib/knex/knex";
import {findByRestaurant, decrementIfSufficient} from "../repository/restaurant-balance.repo";
import {findOwnerIdForRestaurant} from "../../order/repository/order.repo";
import {createTransaction, findPayouts} from "../../payment/repository/transaction.repo";
import {TransactionType, TransactionMethod, TransactionStatus} from "../../payment/enums";
import {RestaurantBalanceResponseDTO, PayoutResponseDTO} from "../dto/finance.response.dto";
import {CreatePayoutRequestDTO} from "../dto/finance.request.dto";
import {InsufficientBalanceError, RestaurantNotFoundError} from "../errors";

@injectable()
export class FinanceService {
    async getBalance(restaurantId: number, region: string): Promise<RestaurantBalanceResponseDTO> {
        const conn = db(region);
        const rows = await findByRestaurant(restaurantId, conn);
        return RestaurantBalanceResponseDTO.from(restaurantId, rows);
    }

    async listPayouts(
        restaurantId: number,
        region: string,
        from: Date,
        to: Date,
        limit: number,
    ): Promise<PayoutResponseDTO[]> {
        const conn = db(region);
        const ownerId = await findOwnerIdForRestaurant(restaurantId, conn);
        if (!ownerId) return [];
        const rows = await findPayouts({ownerId, from, to}, limit, conn);
        return rows.map(PayoutResponseDTO.from);
    }

    /**
     * Admin-only. Records an externally-completed bank transfer and decrements
     * the balance atomically. Idempotent on `idempotency_key` (set by the
     * idempotency middleware via the `Idempotency-Key` header).
     */
    async recordPayout(
        body: CreatePayoutRequestDTO,
        region: string,
        idempotencyKey: string,
    ): Promise<PayoutResponseDTO> {
        const conn = db(region);
        const ownerId = await findOwnerIdForRestaurant(body.restaurantId, conn);
        if (!ownerId) throw RestaurantNotFoundError;

        const trx = await conn.transaction();
        try {
            const decremented = await decrementIfSufficient(
                {restaurantId: body.restaurantId, currency: body.currency, amount: body.amount},
                trx,
            );
            if (!decremented) {
                await trx.rollback();
                throw InsufficientBalanceError;
            }
            const tx = await createTransaction({
                region,
                orderId: null,
                transactionType: TransactionType.PAYOUT,
                method: TransactionMethod.BANK_TRANSFER,
                providerId: null,
                providerReferenceId: body.providerReferenceId,
                status: TransactionStatus.SUCCEEDED,
                amount: body.amount,
                currency: body.currency,
                srcAccId: null,           // platform → restaurant: no platform user record
                dstAccId: ownerId,
                idempotencyKey,
            }, trx);
            await trx.commit();
            return PayoutResponseDTO.from(tx);
        } catch (err) {
            // If trx is already rolled back (InsufficientBalance) this is a no-op.
            try { await trx.rollback(); } catch {}
            throw err;
        }
    }
}
