import {IPaymentProvider} from "../../src/pkg/payments/payment.interface"
import {CreateSessionInput, CreateSessionResult, VerifyWebhookInput} from "../../src/pkg/payments/types"

// Kashier is the one real third-party payment gateway in this service —
// mirrors core-service's EmailStub. Mocked in via:
//
//   jest.mock("../../../src/pkg/payments/init", () => ({kashierProvider: kashierProviderStub}))
//
// before importing createApp(). `verifyWebhook`'s return is directly
// controllable so both the valid-signature and forged-signature webhook
// paths are testable without computing a real HMAC.
export class KashierProviderStub implements IPaymentProvider {
    sessionsCreated: CreateSessionInput[] = []
    webhookVerifications: VerifyWebhookInput[] = []

    /** Defaults to accepting every session creation; override per-test if a create failure needs testing. */
    nextSessionResult: CreateSessionResult | (() => CreateSessionResult) = () => ({
        providerSessionId: `kashier-session-${this.sessionsCreated.length + 1}`,
        redirectUrl: "https://test-fep.kashier.io/session/stub",
        rawResponse: {stub: true},
        expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    })

    /** Controls verifyWebhook's return for every call until reset — defaults to "valid". */
    nextVerifyWebhookResult = true

    async createSession(input: CreateSessionInput): Promise<CreateSessionResult> {
        this.sessionsCreated.push(input)
        return typeof this.nextSessionResult === "function" ? this.nextSessionResult() : this.nextSessionResult
    }

    verifyWebhook(input: VerifyWebhookInput): boolean {
        this.webhookVerifications.push(input)
        return this.nextVerifyWebhookResult
    }

    reset(): void {
        this.sessionsCreated = []
        this.webhookVerifications = []
        this.nextVerifyWebhookResult = true
    }
}

export const kashierProviderStub = new KashierProviderStub()
