import {register} from "../../lib/jobs/job-registry";
import {container} from "../../lib/di/container";
import {TOKENS} from "../../lib/di/tokens";
import {env} from "../../lib/config/env";
import {logger} from "../../lib/logger/logger";
import {AssignmentService} from "./service/assignment.service";

/**
 * Registers one assignment-tick job per configured region. Each fires every
 * ASSIGNMENT_TICK_SEC seconds — translated to a 6-field cron expression
 * (`*\/N * * * * *`). Per-region jobs let one region's slow tick not block
 * another's.
 *
 * Idempotent: safe to call once per process boot.
 */
export function registerAssignmentJobs(): void {
    const everyNSec = `*/${env.delivery.assignmentTickSec} * * * * *`;
    for (const region of env.regions) {
        register({
            name: `assignment-tick:${region}`,
            cron: everyNSec,
            handler: async () => {
                const assignmentService = container.resolve<AssignmentService>(TOKENS.AssignmentService);
                const result = await assignmentService.tickRegion(region);
                if (result.processed > 0) {
                    logger.info("assignment.tick", {region, ...result});
                }
            },
        });
    }
}
