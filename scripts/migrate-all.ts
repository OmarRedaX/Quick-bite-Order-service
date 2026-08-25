/**
 * Runs `knex migrate:latest` against every configured hot-cluster region.
 *
 *   npx tsx scripts/migrate-all.ts
 *   CLUSTER=archive npx tsx scripts/migrate-all.ts
 */
import {spawnSync} from "child_process";
import {env} from "../src/lib/config/env";

const cluster = (process.env.CLUSTER ?? "hot") as "hot" | "archive";

function run(region: string) {
    console.log(`[${cluster}/${region}] migrate:latest`);
    const res = spawnSync(
        "npx",
        ["knex", "--knexfile", "src/lib/knex/knexfile.ts", "migrate:latest"],
        {
            stdio: "inherit",
            shell: true,
            env: {...process.env, REGION: region, CLUSTER: cluster},
        },
    );
    if (res.status !== 0) {
        process.exit(res.status ?? 1);
    }
}

for (const region of env.regions) {
    run(region);
}
