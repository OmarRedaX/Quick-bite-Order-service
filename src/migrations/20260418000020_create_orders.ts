import type {Knex} from "knex";

/**
 * Hot order header table. Native Postgres declarative partitioning by
 * RANGE(created_at), monthly. Per-month partitions are created by
 * `scripts/create-partitions.ts` and rolled forward by the same script
 * scheduled monthly. Phase 7 will detach prior-year partitions and copy
 * them to the archive cluster.
 *
 * Notes:
 *  - PK includes the partition key, so it's (id, created_at).
 *  - public_id is indexed but NOT globally unique (Postgres can't enforce
 *    a global UNIQUE that doesn't include the partition key). UUIDv4 is
 *    collision-resistant and we own all writes.
 *  - id is BIGINT with a manual sequence. BIGSERIAL on a partitioned
 *    parent doesn't propagate the sequence DEFAULT to children cleanly,
 *    so we wire it explicitly.
 */
export async function up(knex: Knex): Promise<void> {
    await knex.raw(`CREATE SEQUENCE IF NOT EXISTS orders_id_seq AS BIGINT`);

    await knex.raw(`
        CREATE TABLE orders (
            id              BIGINT NOT NULL DEFAULT nextval('orders_id_seq'),
            region          TEXT NOT NULL,
            public_id       UUID NOT NULL,
            country_code    TEXT NOT NULL,
            restaurant_id   BIGINT NOT NULL,
            restaurant_owner_id BIGINT NOT NULL,             -- snapshot at placement; used as transactions.dst_acc_id
            branch_id       BIGINT NOT NULL,
            customer_id     BIGINT NOT NULL,
            customer_address_id BIGINT NOT NULL,

            delivery_lat    DECIMAL(10,7) NOT NULL,
            delivery_lng    DECIMAL(10,7) NOT NULL,
            delivery_address_text_snapshot TEXT NOT NULL,

            -- pickup snapshot (denormalised from core's branch row at placement
            -- time so the assignment worker's distance calc never has to touch
            -- core / Redis on the hot path)
            branch_lat      DECIMAL(10,7) NOT NULL,
            branch_lng      DECIMAL(10,7) NOT NULL,

            status          TEXT NOT NULL CHECK (status IN (
                                'pending_payment','placed','accepted','rejected',
                                'preparing','ready','assigned','picked','delivered','cancelled'
                            )),

            subtotal        INT NOT NULL,
            delivery_fee    INT NOT NULL,
            service_fee     INT NOT NULL,
            total           INT NOT NULL,
            commission      INT NOT NULL DEFAULT 0,
            currency        TEXT NOT NULL,
            payment_method  TEXT NOT NULL CHECK (payment_method IN ('online','cod')),

            delivery_agent_id BIGINT,

            created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
            updated_at      TIMESTAMP NOT NULL DEFAULT NOW(),
            accepted_at     TIMESTAMP NULL,
            rejected_at     TIMESTAMP NULL,
            ready_at        TIMESTAMP NULL,
            assigned_at     TIMESTAMP NULL,
            picked_at       TIMESTAMP NULL,
            delivered_at    TIMESTAMP NULL,
            cancelled_at    TIMESTAMP NULL,

            PRIMARY KEY (id, created_at)
        ) PARTITION BY RANGE (created_at);
    `);

    await knex.raw(`ALTER SEQUENCE orders_id_seq OWNED BY orders.id`);

    // supports GET /orders/{publicId}
    await knex.raw(`CREATE INDEX idx_orders_public_id ON orders (public_id)`);
    // supports GET /customer/orders?year=YYYY
    await knex.raw(`CREATE INDEX idx_orders_customer_id_created_at ON orders (customer_id, created_at DESC)`);
    // supports GET /restaurant/orders?branchId=&status=&from=&to=
    await knex.raw(`CREATE INDEX idx_orders_branch_status_created_at ON orders (branch_id, status, created_at DESC)`);
    // supports auto-assignment scan for ready orders
    await knex.raw(`CREATE INDEX idx_orders_status_created_at ON orders (status, created_at) WHERE status IN ('ready','assigned')`);
    // supports GET /agents/tasks?status=
    await knex.raw(`CREATE INDEX idx_orders_delivery_agent_id_status ON orders (delivery_agent_id, status) WHERE delivery_agent_id IS NOT NULL`);

    // Default catch-all partition so inserts outside the pre-created month range
    // never fail; the partition-create script keeps the rolling 12-month window.
    await knex.raw(`CREATE TABLE orders_default PARTITION OF orders DEFAULT`);
}

export async function down(knex: Knex): Promise<void> {
    await knex.raw(`DROP TABLE IF EXISTS orders CASCADE`);
    await knex.raw(`DROP SEQUENCE IF EXISTS orders_id_seq`);
}
