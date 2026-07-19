import {Router} from "express";
import {pingAll} from "../../lib/knex/knex";

export const healthRouter = Router();

healthRouter.get("/", async (_req, res) => {
    const shards = await pingAll();
    const allOk = shards.every((s) => s.ok);
    res.status(allOk ? 200 : 503).json({
        ok: allOk,
        shards,
    });
});
