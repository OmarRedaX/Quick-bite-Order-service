import {ScheduledJob} from "./job.types";

/**
 * Module-level registry of scheduled jobs. Populated at module-load time by
 * `register(...)` calls; consumed by `scheduler.startAll()` at worker boot.
 *
 * Keep registrations side-effect-free at import time — the handler closures
 * resolve their dependencies (DI, env) when CALLED, not when registered.
 */
const jobs: ScheduledJob[] = [];

/** Add a job. Names must be unique; a duplicate name is a programmer error. */
export function register(job: ScheduledJob): void {
    if (jobs.some((j) => j.name === job.name)) {
        throw new Error(`duplicate scheduled job: ${job.name}`);
    }
    jobs.push(job);
}

/** Snapshot used by the scheduler. */
export function listJobs(): readonly ScheduledJob[] {
    return jobs;
}
