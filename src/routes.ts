import {Router} from "express";
import {healthRouter} from "./app/health/health.routes";
import {orderRouter} from "./app/order/routes";
import {paymentRouter} from "./app/payment/routes";
import {agentRouter} from "./app/agent/routes";
import {assignmentRouter} from "./app/assignment/routes";
import {financeRouter} from "./app/finance/routes";

export const routes = Router();

routes.use("/health", healthRouter);
routes.use("/", orderRouter);
routes.use("/", paymentRouter);
routes.use("/", agentRouter);
routes.use("/", assignmentRouter);
routes.use("/", financeRouter);
