export default async function teardown() {
    const {destroyAllShards} = require("../../src/lib/knex/shards")
    await destroyAllShards()

    const {closeRedisTestClient} = require("../helpers/redis")
    await closeRedisTestClient()
}
