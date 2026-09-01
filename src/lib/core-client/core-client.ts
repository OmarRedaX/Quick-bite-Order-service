import {env} from "../config/env";
import {AppError} from "../error/AppError";
import {retry} from "../../pkg/utils/retry";
import {coreServiceUnavailableError, coreUpstreamError} from "./errors";
import {CoreClientRequest} from "./types";

export class CoreClient {
    constructor(
        private readonly baseUrl: string,
        private readonly apiKey: string,
        private readonly timeoutMs: number,
    ) {}

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
                let res: Response;
                try {
                    // AbortSignal.timeout makes fetch() itself reject once the
                    // timeout fires — same catch block as connection-refused/DNS
                    // failures below, so a hung core-service degrades exactly
                    // the same documented way as a fully-down one.
                    res = await fetch(url, {
                        method: req.method,
                        headers,
                        body: req.body ? JSON.stringify(req.body) : undefined,
                        signal: AbortSignal.timeout(this.timeoutMs),
                    });
                } catch (cause) {
                    // Anything fetch() itself throws — connection refused, DNS
                    // failure, or the timeout above firing — means core-service
                    // couldn't be reached at all, not that it answered badly.
                    // Translate it at this boundary into the same stable,
                    // documented contract as a 5xx response, never let the raw
                    // transport exception escape past this client.
                    throw coreServiceUnavailableError(cause);
                }
                if (res.status >= 500) throw coreServiceUnavailableError(new Error(`core-service responded ${res.status}`));
                if (!res.ok) throw coreUpstreamError(res.status, await res.text().catch(() => ""));
                if (res.status === 204) return undefined as T;
                return (await res.json()) as T;
            },
            {
                attempts: 3,
                initialDelayMs: 50,
                maxDelayMs: 500,
                // Only retry the availability failure this client itself
                // classifies as such (503, thrown exclusively by
                // coreServiceUnavailableError above) — never an arbitrary
                // AppError (e.g. a real 4xx from coreUpstreamError) and never
                // an unrelated/programming error (e.g. a JSON.parse throw from
                // a malformed response body), which should fail fast and
                // surface as-is instead of being retried blind.
                isRetryable: (err) => err instanceof AppError && err.statusCode === 503,
            },
        );
    }
}

export const coreClient = new CoreClient(env.core.baseUrl, env.core.internalApiKey, env.core.httpTimeoutMs);
