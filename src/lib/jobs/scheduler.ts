import cron, {ScheduledTask} from "node-cron";
import {logger} from "../logger/logger";
import {listJobs} from "./job-registry";

const tasks: ScheduledTask[] = [];

/**
 * Boot every registered job. Each handler invocation is wrapped so a thrown
 * error doesn't tear down the cron task — the next tick still runs.
 *
 * Concurrent invocations of the same job are dropped: if a tick is still
 * running when the next fires, that tick is skipped (logged at debug).
 */
export function startAll(): void {
    const running = new Set<string>();
    for (const job of listJobs()) {
        if (!cron.validate(job.cron)) {
            throw new Error(`invalid cron expression for job ${job.name}: ${job.cron}`);
        }
        const task = cron.schedule(
            job.cron,
            async () => {
                if (running.has(job.name)) {
                    logger.debug("job skipped (previous tick still running)", {job: job.name});
                    return;
                }
                running.add(job.name);
                const start = Date.now();
                try {
                    await job.handler();
                } catch (err) {
                    logger.error("job failed", {job: job.name, error: (err as Error).message});
                } finally {
                    running.delete(job.name);
                    logger.debug("job tick", {job: job.name, ms: Date.now() - start});
                }
            },
            {timezone: job.timezone},
        );
        tasks.push(task);
        logger.info("job scheduled", {name: job.name, cron: job.cron});
    }
}

/** Stop all scheduled tasks. Called from the worker's SIGINT/SIGTERM handler. */
export async function stopAll(): Promise<void> {
    for (const t of tasks) {
        try {
            await t.stop();
        } catch {}
    }
    tasks.length = 0;
}
