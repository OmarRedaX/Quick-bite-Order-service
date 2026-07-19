import {env} from "../config/env";
import {AppError} from "../error/AppError";
import {retry} from "../../pkg/utils/retry";
import {coreUnavailableError, coreUpstreamError} from "./errors";
import {CoreClientRequest} from "./types";

export class CoreClient {
    constructor(private readonly baseUrl: string, private readonly apiKey: string) {}

    async request<T>(req: CoreClientRequest): Promise<T> {
        const url = new URL(req.path, this.baseUrl);

        const headers: Record<string, string> = {
            "Content-Type": "application/json",
            "api-key": this.apiKey,
        };
        if (req.correlationId) headers["X-CorrelationId"] = req.correlationId;
        if (req.idempotencyKey) headers["Idempotency-Key"] = req.idempotencyKey;

        return retry(
            async () => {
                const res = await fetch(url, {
                    method: req.method,
                    headers,
                    body: req.body ? JSON.stringify(req.body) : undefined,
                });
                if (res.status >= 500) throw coreUnavailableError(res.status);
                if (!res.ok) throw coreUpstreamError(res.status, await res.text().catch(() => ""));
                if (res.status === 204) return undefined as T;
                return (await res.json()) as T;
            },
            {
                attempts: 3,
                initialDelayMs: 50,
                maxDelayMs: 500,
                isRetryable: (err) => !(err instanceof AppError) || err.statusCode === 503,
            },
        );
    }
}

export const coreClient = new CoreClient(env.core.baseUrl, env.core.internalApiKey);
