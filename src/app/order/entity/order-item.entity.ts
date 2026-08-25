export class OrderItemEntity {
    id!: number;
    region!: string;
    orderId!: number;
    productId!: number;
    quantity!: number;
    unitPriceSnapshot!: number;
    nameSnapshot!: string;
    imageUrlSnapshot!: string | null;
    lineTotal!: number;
    createdAt!: Date;

    constructor(data: Partial<OrderItemEntity>) {
        Object.assign(this, data);
    }
}
