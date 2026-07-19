import express from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import helmet from "helmet";
import {env} from "./lib/config/env";
import {routes} from "./routes";
import {correlationId} from "./lib/correlation/correlationId";
import {resolveRegion} from "./lib/sharding/region-resolver";
import {errorHandler} from "./lib/error/errorHandler";

export function createApp() {
    const app = express();
    app.use(helmet());
    app.use(cors({origin: env.cors.origins, credentials: true}));
    app.set("query parser", "extended");
    app.use(express.json());
    app.use(cookieParser());
    app.use(correlationId);
    app.use(resolveRegion);
    app.use("/api", routes);
    app.use(errorHandler);
    return app;
}
