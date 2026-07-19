import {AppError} from "../error/AppError";

export const RegionNotResolvedError = new AppError(
    "Region not resolved. Provide ?region= or X-Region header, or authenticate.",
    400,
);
