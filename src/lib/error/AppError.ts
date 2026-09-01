export class AppError extends Error {
    statusCode: number;
    isOperational: boolean;

    // `options` passes straight through to the native `Error` constructor —
    // today just `{cause}`, so a boundary that translates a low-level
    // exception (e.g. a fetch() network failure) into a stable AppError can
    // still chain the original error for logs/observability without
    // exposing it to the client.
    constructor(message: string, statusCode: number = 500, isOperational: boolean = true, options?: ErrorOptions) {
        super(message, options);
        this.statusCode = statusCode;
        this.isOperational = isOperational;

        Error.captureStackTrace(this, this.constructor);
    }
}
