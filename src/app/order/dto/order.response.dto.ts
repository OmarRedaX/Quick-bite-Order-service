import {OrderEntity} from "../entity/order.entity";
import {OrderItemEntity} from "../entity/order-item.entity";
import {OrderStatus, PaymentMethod} from "../enums";

export class OrderItemResponseDTO {
    productId!: number;
    name!: string;
    imageUrl!: string | null;
    quantity!: number;
    unitPrice!: number;
    lineTotal!: number;

    static from(item: OrderItemEntity): OrderItemResponseDTO {
        const dto = new OrderItemResponseDTO();
        dto.productId = item.productId;
        dto.name = item.nameSnapshot;
        dto.imageUrl = item.imageUrlSnapshot;
        dto.quantity = item.quantity;
        dto.unitPrice = item.unitPriceSnapshot;
        dto.lineTotal = item.lineTotal;
        return dto;
    }
}

export interface OrderResponsePaymentInfo {
    sessionId: string;
    providerSessionId: string;
    redirectUrl: string;
    expiresAt: string;
}

export class OrderResponseDTO {
    publicId!: string;
    status!: OrderStatus;
    paymentMethod!: PaymentMethod;
    branch!: {id: number};
    restaurant!: {id: number};
    customerAddress!: {lat: number; lng: number; addressText: string};
    subtotal!: number;
    deliveryFee!: number;
    serviceFee!: number;
    total!: number;
    currency!: string;
    items!: OrderItemResponseDTO[];
    createdAt!: string;
    payment?: OrderResponsePaymentInfo;

    static from(order: OrderEntity, items: OrderItemEntity[], payment?: OrderResponsePaymentInfo): OrderResponseDTO {
        const dto = new OrderResponseDTO();
        dto.publicId = order.publicId;
        dto.status = order.status;
        dto.paymentMethod = order.paymentMethod;
        dto.branch = {id: Number(order.branchId)};
        dto.restaurant = {id: Number(order.restaurantId)};
        dto.customerAddress = {
            lat: Number(order.deliveryLat),
            lng: Number(order.deliveryLng),
            addressText: order.deliveryAddressTextSnapshot,
        };
        dto.subtotal = order.subtotal;
        dto.deliveryFee = order.deliveryFee;
        dto.serviceFee = order.serviceFee;
        dto.total = order.total;
        dto.currency = order.currency;
        dto.items = items.map(OrderItemResponseDTO.from);
        dto.createdAt = order.createdAt.toISOString();
        if (payment) dto.payment = payment;
        return dto;
    }
}

export class OrderSummaryResponseDTO {
    publicId!: string;
    status!: OrderStatus;
    total!: number;
    currency!: string;
    itemsCount!: number;
    restaurant!: {id: number};
    branchId!: number;
    createdAt!: string;

    static from(order: OrderEntity, itemsCount: number): OrderSummaryResponseDTO {
        const dto = new OrderSummaryResponseDTO();
        dto.publicId = order.publicId;
        dto.status = order.status;
        dto.total = order.total;
        dto.currency = order.currency;
        dto.itemsCount = itemsCount;
        dto.restaurant = {id: Number(order.restaurantId)};
        dto.branchId = Number(order.branchId);
        dto.createdAt = order.createdAt.toISOString();
        return dto;
    }
}

export class OrderStatusResponseDTO {
    publicId!: string;
    status!: OrderStatus;
    updatedAt!: string;

    static from(order: OrderEntity): OrderStatusResponseDTO {
        const dto = new OrderStatusResponseDTO();
        dto.publicId = order.publicId;
        dto.status = order.status;
        dto.updatedAt = order.updatedAt.toISOString();
        return dto;
    }
}

export class OrderDetailResponseDTO {
    publicId!: string;
    status!: OrderStatus;
    paymentMethod!: PaymentMethod;
    branch!: {id: number};
    restaurant!: {id: number};
    customerAddress!: {lat: number; lng: number; addressText: string};
    subtotal!: number;
    deliveryFee!: number;
    serviceFee!: number;
    total!: number;
    currency!: string;
    items!: OrderItemResponseDTO[];
    createdAt!: string;
    history!: Array<{status: OrderStatus; ts: string}>;

    static from(order: OrderEntity, items: OrderItemEntity[]): OrderDetailResponseDTO {
        const dto = new OrderDetailResponseDTO();
        const base = OrderResponseDTO.from(order, items);
        Object.assign(dto, base);
        dto.history = buildHistory(order);
        return dto;
    }
}

function buildHistory(order: OrderEntity): Array<{status: OrderStatus; ts: string}> {
    const out: Array<{status: OrderStatus; ts: string}> = [];
    const push = (status: OrderStatus, ts: Date | null | undefined) => {
        if (ts) out.push({status, ts: ts.toISOString()});
    };

    if (order.paymentMethod === PaymentMethod.ONLINE) {
        push(OrderStatus.PENDING_PAYMENT, order.createdAt);
        push(OrderStatus.PLACED, order.createdAt);
    } else {
        push(OrderStatus.PLACED, order.createdAt);
    }
    push(OrderStatus.ACCEPTED, order.acceptedAt);
    push(OrderStatus.REJECTED, order.rejectedAt);
    push(OrderStatus.READY, order.readyAt);
    push(OrderStatus.ASSIGNED, order.assignedAt);
    push(OrderStatus.PICKED, order.pickedAt);
    push(OrderStatus.DELIVERED, order.deliveredAt);
    push(OrderStatus.CANCELLED, order.cancelledAt);

    return out;
}
