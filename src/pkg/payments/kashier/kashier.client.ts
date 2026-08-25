import {retry} from "../../utils/retry";
import {IPaymentProvider} from "../payment.interface";
import {CreateSessionInput, CreateSessionResult, VerifyWebhookInput} from "../types";
import {KashierCreateSessionRequest, KashierCreateSessionResponse} from "./types";
import {verifyWebhookSignature} from "./kashier.signature";

export interface KashierClientConfig {
    baseUrl: string;
    merchantId: string;
    apiKey: string;          // also doubles as webhook HMAC secret
    secretKey: string;       // Authorization header value
    paymentType: string;     // "credit"
    serverWebhookUrl: string;
    /** Success redirect URL the customer lands on after a successful payment. */
    merchantRedirect?: string;
    /** Whether Kashier should also redirect on failure (vs leaving the customer on Kashier's failure page). */
    failureRedirectEnabled?: boolean;
    /** seconds before a session expires; passed as expireAt ISO timestamp */
    sessionTimeoutSec: number;
}

export class KashierClient implements IPaymentProvider {
    constructor(private readonly cfg: KashierClientConfig) {}

    async createSession(input: CreateSessionInput): Promise<CreateSessionResult> {
        const expireAt = new Date(Date.now() + this.cfg.sessionTimeoutSec * 1000).toISOString();
        const body: KashierCreateSessionRequest = {
            merchantId: this.cfg.merchantId,
            paymentType: this.cfg.paymentType,
            amount: input.amount,
            currency: input.currency,
            order: input.merchantOrderId,
            type: "one-time",
            allowedMethods: input.allowedMethods ?? "card,wallet",
            enable3DS: true,
            serverWebhook: this.cfg.serverWebhookUrl,
            merchantRedirect: this.cfg.merchantRedirect,
            failureRedirect: this.cfg.failureRedirectEnabled ?? false,
            description: input.description,
            interactionSource: "ECOMMERCE",
            expireAt,
            customer: {reference: input.customerReference},
        };

        const response = await retry(
            async () => {
                const res = await fetch(`${this.cfg.baseUrl}/v3/payment/sessions`, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "api-key": this.cfg.apiKey,
                        "Authorization": this.cfg.secretKey,
                    },
                    body: JSON.stringify(body),
                });
                if (res.status >= 500) {
                    throw new Error(`kashier ${res.status}: ${await res.text().catch(() => "")}`);
                }
                if (!res.ok) {
                    // Non-retryable upstream error (4xx) — surface verbatim.
                    const text = await res.text().catch(() => "");
                    const err = new Error(`kashier ${res.status}: ${text}`);
                    (err as any).statusCode = res.status;
                    (err as any).retryable = false;
                    throw err;
                }
                return (await res.json()) as KashierCreateSessionResponse;
            },
            {
                attempts: 3,
                initialDelayMs: 200,
                maxDelayMs: 1500,
                isRetryable: (err) => (err as any)?.retryable !== false,
            },
        );

        if (!response?._id || !response?.sessionUrl) {
            throw new Error(`kashier: malformed session response: ${JSON.stringify(response)}`);
        }

        return {
            providerSessionId: response._id,
            redirectUrl: response.sessionUrl,
            rawResponse: response,
            expiresAt: response.expireAt ?? expireAt,
        };
    }

    verifyWebhook(input: VerifyWebhookInput): boolean {
        return verifyWebhookSignature(
            input.payload,
            input.signatureKeys,
            this.cfg.apiKey,
            input.signature,
        );
    }
}
