import {AppError} from "../error/AppError";

export const RegionNotResolvedError = new AppError(
    "Region not resolved. Provide ?region= or X-Region header, or authenticate.",
    400,
);

export function unknownRegionError(candidate: string | null | undefined, known: readonly string[]): AppError {
    return new AppError(`Unknown region: "${candidate}". Known: ${known.join(",")}`, 400);
}
