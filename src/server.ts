import "reflect-metadata";
import http from "http";
import {createApp} from "./app";
import {env} from "./lib/config/env";
import {logger} from "./lib/logger/logger";
import {destroyAll, pingAll} from "./lib/knex/knex";
import {messageBroker} from "./lib/messaging/init";
import {startCoreEventsConsumer} from "./lib/core-events/consumer";
import {attachWsServer} from "./lib/websocket/ws-server";
import {container} from "./lib/di/container";
import {TOKENS} from "./lib/di/tokens";

const app = createApp();
const server = http.createServer(app);

const io = attachWsServer(server);
container.registerInstance(TOKENS.WsServer, io);

server.listen(env.port, async () => {
    logger.info(`order-service listening on :${env.port}`);

    // shard ping at boot (non-fatal; logs per shard)
    try {
        const result = await pingAll();
        for (const r of result) {
            if (r.ok) logger.info("shard reachable", {region: r.region, cluster: r.cluster});
            else logger.warn("shard unreachable", {region: r.region, cluster: r.cluster, error: r.error});
        }
    } catch (err) {
        logger.error("shard ping failed", {error: (err as Error).message});
    }

    messageBroker
        .connect()
        .then(() => startCoreEventsConsumer(messageBroker))
        .catch((err) => {
            logger.warn("rabbitmq not reachable at boot — will retry", {err});
        });
});

async function shutdown() {
    logger.info("shutdown requested");
    server.close(async () => {
        try {
            await io.close();
        } catch {}
        try {
            await messageBroker.close();
        } catch (err) {
            logger.warn("broker close error", {error: (err as Error).message});
        }
        try {
            await destroyAll();
        } catch (err) {
            logger.warn("db destroy error", {error: (err as Error).message});
        }
        process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
