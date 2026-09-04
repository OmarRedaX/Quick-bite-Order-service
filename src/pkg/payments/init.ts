import {KashierClient} from "./kashier/kashier.client";
import {env} from "../../lib/config/env";

export const kashierProvider = new KashierClient({
    baseUrl: env.kashier.baseUrl,
    merchantId: env.kashier.merchantId,
    apiKey: env.kashier.apiKey,
    secretKey: env.kashier.secretKey,
    paymentType: env.kashier.paymentType,
    serverWebhookUrl: env.kashier.webhookUrl,
    merchantRedirect: env.kashier.returnUrl,
    failureRedirectEnabled: false,
    sessionTimeoutSec: env.payments.sessionTimeoutMin * 60,
});
