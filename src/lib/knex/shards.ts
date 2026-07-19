import knex, {Knex} from "knex";
import {env, ShardConfig} from "../config/env";
import {assertRegion} from "../sharding/regions";

type Cluster = "hot" | "archive";

function buildConfig(shard: ShardConfig): Knex.Config {
    return {
        client: "pg",
        connection: {
            host: shard.host,
            port: shard.port,
            user: shard.username,
            password: shard.password,
            database: shard.name,
        },
        pool: {
            min: 0,
            max: env.db.poolMax,
        },
        migrations: {
            directory: env.db.migrationDirectory,
            extension: env.db.migrationExtension,
        },
    };
}

const hotByRegion = new Map<string, Knex>();
const archiveByRegion = new Map<string, Knex>();

export function getHotShard(region: string): Knex {
    assertRegion(region);
    let conn = hotByRegion.get(region);
    if (!conn) {
        conn = knex(buildConfig(env.hotShards[region]));
        hotByRegion.set(region, conn);
    }
    return conn;
}

export function getArchiveShard(region: string): Knex {
    assertRegion(region);
    let conn = archiveByRegion.get(region);
    if (!conn) {
        conn = knex(buildConfig(env.archiveShards[region]));
        archiveByRegion.set(region, conn);
    }
    return conn;
}

export async function destroyAllShards(): Promise<void> {
    await Promise.all([...hotByRegion.values()].map((c) => c.destroy()));
    await Promise.all([...archiveByRegion.values()].map((c) => c.destroy()));
    hotByRegion.clear();
    archiveByRegion.clear();
}

export function listConfiguredRegions(cluster: Cluster): string[] {
    return Object.keys(cluster === "hot" ? env.hotShards : env.archiveShards);
}
