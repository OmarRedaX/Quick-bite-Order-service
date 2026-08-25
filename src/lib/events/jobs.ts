import {register} from "../jobs/job-registry";
import {env} from "../config/env";
import {logger} from "../logger/logger";
import {messageBroker} from "../messaging/init";
import {drainOutboxForRegion} from "./outbox-drain";

/**
 * Registers one outbox-drain job per region. Each fires every
 * OUTBOUND_EVENTS_DRAIN_TICK_SEC seconds. Per-region jobs prevent one slow
 * region from blocking another's events.
 *
 * Also asserts the outbound exchange exists (idempotent).
 */
export function registerOutboxDrainJobs(): void {
    const everyNSec = `*/${env.outboundEvents.drainTickSec} * * * * *`;

    messageBroker
        .connect()
        .then(() =>
            messageBroker.declareTopology({
                exchange: env.outboundEvents.exchange,
                queue: "__outbox-drain-noop__",
                bindingKeys: [],
                prefetch: 1,
            }).catch((err) =>
                logger.warn("outbound exchange declare failed (will retry on first publish)", {
                    error: (err as Error).message,
                }),
            ),
        )
        .catch(() => {});

    for (const region of env.regions) {
        register({
            name: `outbox-drain:${region}`,
            cron: everyNSec,
            handler: async () => {
                try {
                    await drainOutboxForRegion(region);
                } catch (err) {
                    logger.error("outbox-drain failed", {region, error: (err as Error).message});
                }
            },
        });
    }
}
