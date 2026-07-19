import {AppError} from "../error/AppError";

export function coreUnavailableError(status: number): AppError {
    return new AppError(`core-service ${status}`, 503);
}

export function coreUpstreamError(status: number, body: string): AppError {
    return new AppError(`core-service ${status}: ${body}`, status);
}
