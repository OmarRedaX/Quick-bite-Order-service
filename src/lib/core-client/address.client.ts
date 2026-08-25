import {coreClient} from "./core-client";
import {CoreEnvelope, CoreCustomerAddress} from "./types";

export async function getCustomerAddress(addressId: number, correlationId?: string): Promise<CoreCustomerAddress> {
    const res = await coreClient.request<CoreEnvelope<CoreCustomerAddress>>({
        method: "GET",
        path: `/api/customer/addresses/internal/${addressId}`,
        correlationId,
    });
    return res.data;
}

/**
 * Compose a flat address string from the structured address pieces, used as
 * `delivery_address_text_snapshot` on the order.
 */
export function flattenAddress(a: CoreCustomerAddress): string {
    const parts = [a.building, a.street, a.city, a.country].filter(Boolean);
    return parts.join(", ");
}
