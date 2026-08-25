/**
 * Provider-agnostic types for the IPaymentProvider interface.
 * Provider-specific shapes (e.g. Kashier's session response) live in the
 * concrete provider folder.
 */

export interface CreateSessionInput {
    /** merchant-side reference id (we use the order publicId UUID) */
    merchantOrderId: string;
    /** amount in MAJOR units as a string, e.g. "18.40" */
    amount: string;
    /** ISO 4217 currency code, e.g. "EGP" */
    currency: string;
    /** human-readable description shown to the customer */
    description?: string;
    /** allowed payment methods, comma-separated, e.g. "card,wallet" */
    allowedMethods?: string;
    /** opaque merchant-side customer id passed through to the provider */
    customerReference: string;
}

export interface CreateSessionResult {
    /** provider's internal session id */
    providerSessionId: string;
    /** URL the customer is redirected/iframed to */
    redirectUrl: string;
    /** echo of what we sent + provider-added fields, persisted as raw_init_payload */
    rawResponse: unknown;
    /** ISO timestamp when the session expires; provider may not return it */
    expiresAt?: string;
}

export interface VerifyWebhookInput {
    /** raw signed query string ("k=v&k=v") OR object whose keys are listed in signatureKeys */
    payload: Record<string, unknown>;
    /** the value of signatureKeys[] from the inbound payload */
    signatureKeys: string[];
    /** the provider's signature header (hex-encoded HMAC-SHA256) */
    signature: string;
}
