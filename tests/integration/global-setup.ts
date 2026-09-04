import {config} from "dotenv"
import path from "path"

config({path: path.resolve(__dirname, "../../.env.test"), override: true})

import {spawnSync} from "child_process"

const ROOT = path.resolve(__dirname, "../..")

function run(command: string, args: string[], region: string, extraEnv: Record<string, string> = {}) {
    const res = spawnSync(command, args, {
        cwd: ROOT,
        stdio: "inherit",
        shell: true,
        env: {...process.env, REGION: region, ...extraEnv},
    })
    if (res.status !== 0) {
        throw new Error(`"${command} ${args.join(" ")}" failed for region "${region}" (exit ${res.status})`)
    }
}

// Provisions the hot-cluster test DB for every region exactly the way a real
// deployment provisions its own: migrate, then pre-create the month
// partitions `orders`/`order_items` need before any insert. Reuses the real
// scripts/*.ts entry points (not reimplemented here) so the test DB is
// bootstrapped the same way README.md's manual setup bootstraps the dev one.
// Archive-cluster migration is skipped — nothing in the current test suite
// exercises the archival worker's destination DB yet (see
// testing-implementation-plan.md Phase 0).
export default async function globalSetup() {
    const {env} = require("../../src/lib/config/env")

    for (const region of env.regions as string[]) {
        run("npx", ["knex", "--knexfile", "src/lib/knex/knexfile.ts", "migrate:latest"], region)
        run("npx", ["tsx", "scripts/create-partitions.ts"], region, {MONTHS_AHEAD: "2"})
    }
}
