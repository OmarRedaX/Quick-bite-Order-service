import {AppError} from "../error/AppError";

export const WsNoTokenError = new AppError("No token provided", 401);
