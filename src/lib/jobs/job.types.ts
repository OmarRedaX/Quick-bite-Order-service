/**
 * A scheduled background job. Anything added to the registry runs in the
 * worker process at the given cron cadence.
 *
 * The handler receives nothing — if it needs context (region, batch size, etc.)
 * it pulls from env or DI itself.
 */
export interface ScheduledJob {
    /** Stable id used in logs and metrics. e.g. `assignment-tick:eg`. */
    name: string;

    /**
     * Standard 5- or 6-field cron expression (node-cron syntax).
     *   "*\/10 * * * * *" — every 10 seconds (6-field form)
     *   "0 3 * * *"       — daily at 03:00 (5-field form)
     */
    cron: string;

    /** Optional timezone (IANA, e.g. "Africa/Cairo"). Defaults to UTC. */
    timezone?: string;

    /** The work. May be sync or async; throws are caught + logged by the scheduler. */
    handler: () => Promise<void> | void;
}
