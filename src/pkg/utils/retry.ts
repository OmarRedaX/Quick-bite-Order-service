export interface RetryOptions {
    attempts: number;       // total tries including the first
    initialDelayMs: number;
    maxDelayMs: number;
    isRetryable?: (err: unknown) => boolean;
}

export async function retry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
    let delay = opts.initialDelayMs;
    let lastErr: unknown;

    for (let i = 0; i < opts.attempts; i++) {
        try {
            return await fn();
        } catch (err) {
            lastErr = err;
            if (opts.isRetryable && !opts.isRetryable(err)) throw err;
            if (i === opts.attempts - 1) break;
            await new Promise((r) => setTimeout(r, delay));
            delay = Math.min(delay * 2, opts.maxDelayMs);
        }
    }
    throw lastErr;
}
