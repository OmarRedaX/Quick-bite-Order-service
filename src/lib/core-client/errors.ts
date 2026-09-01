import {AppError} from "../error/AppError";

// The single, stable, documented shape (docs/api-contracts.md: `503 { "error":
// "Core service unavailable" }`) for every way core-service can fail to be
// reached — a real 5xx response, connection refused, DNS failure, or a
// timed-out/aborted request. All of those mean the same thing to a caller:
// "I couldn't get a good answer from core-service right now." A fresh
// instance per call (never a shared singleton) so concurrent requests never
// step on each other's `cause`; the original low-level failure (if any) is
// chained via `cause` for logs, never exposed to the client.
export function coreServiceUnavailableError(cause?: unknown): AppError {
    return new AppError("Core service unavailable", 503, true, cause !== undefined ? {cause} : undefined);
}

// A response core-service actually sent, just not a success — a real 4xx/
// non-5xx status with its own meaning. Distinct from "unavailable": this is
// core-service reachable and answering, just declining the request.
export function coreUpstreamError(status: number, body: string): AppError {
    return new AppError(`core-service ${status}: ${body}`, status);
}
