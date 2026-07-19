import {Router} from "express";
import {healthRouter} from "./app/health/health.routes";

export const routes = Router();

routes.use("/health", healthRouter);
// Domain modules register here in later phases:
//   routes.use('/orders', orderRouter);
//   routes.use('/payments', paymentRouter);
//   ...
