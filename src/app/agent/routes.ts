import {Router} from "express";
import {authenticate} from "../../lib/auth/guard";
import {requireAgent} from "../../lib/auth/rbac";
import {requireRegion} from "../../lib/sharding/region-resolver";
import {idempotency} from "../../lib/idempotency/idempotency";
import {container} from "../../lib/di/container";
import {TOKENS} from "../../lib/di/tokens";
import {AgentController} from "./controller/agent.controller";

export const agentRouter = Router();

const ctrl = container.resolve<AgentController>(TOKENS.AgentController);

// Presence — online + ping share the same UPSERT handler; offline is its own
// thing because it has the "can't go offline while picked" rule.
agentRouter.post("/agents/presence/online",  authenticate, requireAgent, requireRegion, ctrl.presenceUpsert);
agentRouter.post("/agents/presence/ping",    authenticate, requireAgent, requireRegion, ctrl.presenceUpsert);
agentRouter.post("/agents/presence/offline", authenticate, requireAgent, requireRegion, ctrl.offline);

// Offers
agentRouter.post("/agents/orders/:publicId/accept", authenticate, requireAgent, requireRegion, idempotency({strict: true}), ctrl.accept);
agentRouter.post("/agents/orders/:publicId/reject", authenticate, requireAgent, requireRegion, ctrl.reject);

// In-flight transitions (picked / delivered)
agentRouter.patch("/agents/orders/:publicId/status", authenticate, requireAgent, requireRegion, idempotency({strict: true}), ctrl.transition);

// Reads
agentRouter.get("/agents/tasks", authenticate, requireAgent, requireRegion, ctrl.tasks);
agentRouter.get("/agents/earnings", authenticate, requireAgent, requireRegion, ctrl.earnings);
