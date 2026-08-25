import "reflect-metadata";
import http from "http";
import {logger} from "./lib/logger/logger";
import {destroyAll, pingAll} from "./lib/knex/knex";
import {messageBroker} from "./lib/messaging/init";
import {startCoreEventsConsumer} from "./lib/core-events/consumer";
import {attachWsServer} from "./lib/websocket/ws-server";
import {container} from "./lib/di/container";
import {TOKENS} from "./lib/di/tokens";
import {startAll, stopAll} from "./lib/jobs/scheduler";
import {registerOrderModuleCoreEventHandlers} from "./app/order/core-events.handlers";
import {registerAssignmentJobs} from "./app/assignment/jobs";
import {registerOutboxDrainJobs} from "./lib/events/jobs";

/**
 * Background worker process. All it does is boot the shared infra and hand
 * control to the cron scheduler. Adding a new background job means: create
 * a `register({...})` call somewhere and import it here. No other wiring.
 */

// Socket.io needs an http.Server to attach to even if we don't listen on a
// real port. Bind to 0 → ephemeral port; the redis adapter does the real
// fan-out so this server never receives an HTTP request.
const noopServer = http.createServer();
const io = attachWsServer(noopServer);
container.registerInstance(TOKENS.WsServer, io);

// ── Job registrations ───────────────────────────────────────────────────
registerAssignmentJobs();
registerOutboxDrainJobs();
// registerOrderArchiveJobs
// (Future jobs land here: payouts sweep, archival, presence GC, etc.)

async function main() {
    noopServer.listen(0);

    const shards = await pingAll();
    for (const r of shards) {
        if (r.ok) logger.info("worker shard reachable", {region: r.region, cluster: r.cluster});
        else logger.warn("worker shard unreachable", {region: r.region, cluster: r.cluster, error: r.error});
    }

    registerOrderModuleCoreEventHandlers();
    messageBroker
        .connect()
        .then(() => startCoreEventsConsumer(messageBroker))
        .catch((err) => logger.warn("worker rabbitmq not reachable at boot", {err}));

    startAll();
}

async function shutdown() {
    logger.info("worker shutdown requested");
    await stopAll();
    try { await io.close(); } catch {}
    try { await messageBroker.close(); } catch {}
    try { await destroyAll(); } catch {}
    noopServer.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5_000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch((err) => {
    logger.error("worker boot failed", {error: (err as Error).message});
    process.exit(1);
});
