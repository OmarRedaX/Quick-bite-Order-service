import {RestaurantBalanceEntity} from "../entity/restaurant-balance.entity";
import {TransactionEntity} from "../../payment/entity/transaction.entity";

export class RestaurantBalanceResponseDTO {
    restaurantId!: number;
    balances!: Array<{currency: string; balance: number}>;
    asOf!: string;

    static from(restaurantId: number, rows: RestaurantBalanceEntity[]): RestaurantBalanceResponseDTO {
        const dto = new RestaurantBalanceResponseDTO();
        dto.restaurantId = restaurantId;
        dto.balances = rows.map((r) => ({currency: r.currency, balance: r.balance}));
        dto.asOf = new Date().toISOString();
        return dto;
    }
}

export class PayoutResponseDTO {
    id!: number;
    amount!: number;
    currency!: string;
    status!: string;
    providerReferenceId!: string | null;
    createdAt!: string;

    static from(t: TransactionEntity): PayoutResponseDTO {
        const dto = new PayoutResponseDTO();
        dto.id = t.id;
        dto.amount = t.amount;
        dto.currency = t.currency;
        dto.status = t.status;
        dto.providerReferenceId = t.providerReferenceId;
        dto.createdAt = t.createdAt.toISOString();
        return dto;
    }
}
