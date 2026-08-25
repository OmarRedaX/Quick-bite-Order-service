import {Knex} from "knex";
import {OrderItemEntity} from "../entity/order-item.entity";
import {InsertOrderItemInput} from "../types";

export const ORDER_ITEM_COLUMNS = [
    "id",
    "region",
    "order_id",
    "product_id",
    "quantity",
    "unit_price_snapshot",
    "name_snapshot",
    "image_url_snapshot",
    "line_total",
    "created_at",
] as const;

function toEntity(row: any): OrderItemEntity {
    return new OrderItemEntity({
        id: Number(row.id),
        region: row.region,
        orderId: Number(row.order_id),
        productId: Number(row.product_id),
        quantity: Number(row.quantity),
        unitPriceSnapshot: Number(row.unit_price_snapshot),
        nameSnapshot: row.name_snapshot,
        imageUrlSnapshot: row.image_url_snapshot,
        lineTotal: Number(row.line_total),
        createdAt: row.created_at,
    });
}

export async function bulkInsertItems(inputs: InsertOrderItemInput[], conn: Knex): Promise<OrderItemEntity[]> {
    if (inputs.length === 0) return [];
    const rows = await conn("order_items")
        .insert(inputs.map((i) => ({
            region: i.region,
            order_id: i.orderId,
            product_id: i.productId,
            quantity: i.quantity,
            unit_price_snapshot: i.unitPriceSnapshot,
            name_snapshot: i.nameSnapshot,
            image_url_snapshot: i.imageUrlSnapshot,
            line_total: i.lineTotal,
        })))
        .returning(ORDER_ITEM_COLUMNS as unknown as string[]);
    return rows.map(toEntity);
}

export async function findItemsByOrderIds(orderIds: number[], conn: Knex): Promise<OrderItemEntity[]> {
    if (orderIds.length === 0) return [];
    const rows = await conn("order_items")
        .select(ORDER_ITEM_COLUMNS as unknown as string[])
        .whereIn("order_id", orderIds)
        .orderBy("id", "asc");
    return rows.map(toEntity);
}

export async function countItemsByOrderIds(orderIds: number[], conn: Knex): Promise<Map<number, number>> {
    const out = new Map<number, number>();
    if (orderIds.length === 0) return out;
    const rows = await conn("order_items")
        .select("order_id")
        .count<{order_id: string; count: string}[]>("* as count")
        .whereIn("order_id", orderIds)
        .groupBy("order_id");
    for (const r of rows) out.set(Number(r.order_id), Number(r.count));
    return out;
}
