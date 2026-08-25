import {
    CreateSessionInput,
    CreateSessionResult,
    VerifyWebhookInput,
} from "./types";

/**
 * Provider-agnostic payment interface. Concrete implementations (Kashier,
 * Stripe, etc.) live under pkg/payments/<provider>/. The pkg/ layer never
 * imports lib/ or app/ — it stays framework- and DB-free.
 */
export interface IPaymentProvider {
    createSession(input: CreateSessionInput): Promise<CreateSessionResult>;
    verifyWebhook(input: VerifyWebhookInput): boolean;
}
