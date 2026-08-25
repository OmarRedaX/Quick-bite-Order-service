/**
 * Kashier-specific request / response shapes (verbatim names per
 * https://developers.kashier.io/payment/payment-sessions ).
 *
 * Only the fields we actually send / consume.
 */

export interface KashierCreateSessionRequest {
    merchantId: string;
    paymentType: string;          // e.g. "credit"
    amount: string;               // major units, "18.40"
    currency: string;             // "EGP"
    order: string;                // merchant order ref (we pass our publicId)
    type: "one-time";
    allowedMethods: string;       // "card,wallet"
    enable3DS: boolean;
    serverWebhook: string;
    merchantRedirect?: string;
    failureRedirect?: boolean;
    description?: string;
    interactionSource?: "ECOMMERCE";
    expireAt?: string;
    customer: {reference: string; email?: string};
}

export interface KashierCreateSessionResponse {
    _id: string;
    status: string;
    sessionUrl: string;
    expireAt?: string;
    paymentParams?: {
        order?: string;
        amount?: string;
        currency?: string;
        hash?: string;
        [k: string]: unknown;
    };
    [k: string]: unknown;
}

/** Inbound webhook envelope fields we care about. */
export interface KashierWebhookEnvelope {
    event: "pay" | "refund" | "authorize" | "void" | "capture";
    data: KashierWebhookData;
}

export interface KashierWebhookData {
    merchantOrderId: string;
    kashierOrderId: string;
    orderReference?: string;
    transactionId: string;
    status: "SUCCESS" | "FAILED";
    method?: string;
    amount: number;
    currency: string;
    /** alphabetically-sorted list of fields used to compute the signature */
    signatureKeys: string[];
    [k: string]: unknown;
}
