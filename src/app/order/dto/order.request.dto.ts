import {Type} from "class-transformer";
import {
    ArrayMinSize,
    IsEnum,
    IsInt,
    IsOptional,
    IsString,
    Max,
    MaxLength,
    Min,
    ValidateNested,
} from "class-validator";
import {OrderStatus, PaymentMethod} from "../enums";

export class OrderItemInputDTO {
    @IsInt()
    @Min(1)
    productId!: number;

    @IsInt()
    @Min(1)
    @Max(50)
    quantity!: number;
}

export class CreateOrderRequestDTO {
    @IsInt()
    @Min(1)
    branchId!: number;

    @IsInt()
    @Min(1)
    customerAddressId!: number;

    @IsEnum(PaymentMethod)
    paymentMethod!: PaymentMethod;

    @ArrayMinSize(1)
    @ValidateNested({each: true})
    @Type(() => OrderItemInputDTO)
    items!: OrderItemInputDTO[];
}

export class UpdateOrderStatusRequestDTO {
    @IsEnum(OrderStatus)
    status!: OrderStatus;

    @IsOptional()
    @IsString()
    @MaxLength(500)
    reason?: string;
}
