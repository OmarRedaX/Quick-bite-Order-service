export class RestaurantBalanceEntity {
    restaurantId!: number;
    region!: string;
    currency!: string;
    balance!: number;
    updatedAt!: Date;

    constructor(data: Partial<RestaurantBalanceEntity>) {
        Object.assign(this, data);
    }
}
