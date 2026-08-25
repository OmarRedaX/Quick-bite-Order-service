import {AppError} from "../../lib/error/AppError";

export const InsufficientBalanceError = new AppError("InsufficientBalance", 409);
export const RestaurantNotFoundError  = new AppError("RestaurantNotFound", 404);
