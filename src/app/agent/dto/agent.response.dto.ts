import {OrderEntity} from "../../order/entity/order.entity";
import {OrderStatus, Currency} from "../../order/enums";
import {AgentEarningEntity} from "../entity/agent-earning.entity";

/**
 * Compact view of an order shaped for the courier app — only the fields a
 * driver needs to do the job. We deliberately omit customer PII (name, phone)
 * and item-level details until pickup; both are looked up via separate calls
 * if/when the driver app needs them.
 */
export class DeliveryTaskResponseDTO {
    orderId!: string;             // public_id
    status!: OrderStatus;
    pickup!: {
        branchId: number;
        lat: number | null;
        lng: number | null;
        name: string | null;
        addressText: string | null;
    };
    dropoff!: {lat: number; lng: number; addressText: string};
    total!: number;
    currency!: Currency;
    paymentMethod!: string;
    assignedAt!: string | null;
    pickedAt!: string | null;
    deliveredAt!: string | null;

    static from(
        order: OrderEntity,
        branch?: {lat: number; lng: number; name: string; addressText: string},
    ): DeliveryTaskResponseDTO {
        const dto = new DeliveryTaskResponseDTO();
        dto.orderId = order.publicId;
        dto.status = order.status;
        dto.pickup = {
            branchId: order.branchId,
            lat: branch ? branch.lat : null,
            lng: branch ? branch.lng : null,
            name: branch ? branch.name : null,
            addressText: branch ? branch.addressText : null,
        };
        dto.dropoff = {
            lat: order.deliveryLat,
            lng: order.deliveryLng,
            addressText: order.deliveryAddressTextSnapshot,
        };
        dto.total = order.total;
        dto.currency = order.currency;
        dto.paymentMethod = order.paymentMethod;
        dto.assignedAt = order.assignedAt ? order.assignedAt.toISOString() : null;
        dto.pickedAt = order.pickedAt ? order.pickedAt.toISOString() : null;
        dto.deliveredAt = order.deliveredAt ? order.deliveredAt.toISOString() : null;
        return dto;
    }
}

export class AgentEarningItemDTO {
    orderId!: number;
    amount!: number;
    currency!: string;
    earnedAt!: string;

    static from(e: AgentEarningEntity): AgentEarningItemDTO {
        const dto = new AgentEarningItemDTO();
        dto.orderId = e.orderId;
        dto.amount = e.amount;
        dto.currency = e.currency;
        dto.earnedAt = e.earnedAt.toISOString();
        return dto;
    }
}

export class AgentEarningsResponseDTO {
    range!: {from: string; to: string};
    totals!: {count: number; sum: number; currency: string | null};
    items!: AgentEarningItemDTO[];

    static from(
        from: Date,
        to: Date,
        items: AgentEarningEntity[],
        sum: number,
    ): AgentEarningsResponseDTO {
        const dto = new AgentEarningsResponseDTO();
        dto.range = {from: from.toISOString(), to: to.toISOString()};
        dto.totals = {
            count: items.length,
            sum,
            currency: items[0]?.currency ?? null,
        };
        dto.items = items.map(AgentEarningItemDTO.from);
        return dto;
    }
}
