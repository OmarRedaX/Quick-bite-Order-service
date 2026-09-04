import {coreClientStub} from "./app";

// Shared actor/location fixtures for the integration suite. Extracted in the
// Phase 7 test-quality pass — every module's test file had independently
// hand-rolled near-identical copies of these (same userIds, same branch
// seed shape), which is exactly the "duplicated-fixture extraction into
// tests/helpers/fixtures.ts" item Phase 7's checklist calls out. This lives
// under tests/integration/support/ (not tests/helpers/) because it depends
// on coreClientStub, an integration-only concept — tests/helpers/fixtures.ts
// stays infra-agnostic (used by both unit and integration tests).

export const BRANCH_ID = 20;
export const RESTAURANT_ID = 10;
export const ADDRESS_ID = 40;

export const CUSTOMER = {userId: 501, role: "customer", email: "cust@test.com"};
export const OTHER_CUSTOMER = {userId: 502, role: "customer", email: "cust2@test.com"};
export const OWNER = {userId: 601, role: "restaurant_user", email: "owner@test.com", restaurantId: RESTAURANT_ID, restaurantRole: "owner"};
export const OTHER_OWNER = {userId: 611, role: "restaurant_user", email: "owner2@test.com", restaurantId: 11, restaurantRole: "owner"};
export const MANAGER = {userId: 602, role: "restaurant_user", email: "mgr@test.com", restaurantId: RESTAURANT_ID, restaurantRole: "branch_manager", branchIds: [BRANCH_ID]};
export const STAFF_OTHER_BRANCH = {userId: 603, role: "restaurant_user", email: "staff2@test.com", restaurantId: RESTAURANT_ID, restaurantRole: "staff", branchIds: [21]};
export const AGENT = {userId: 701, role: "delivery_agent", email: "agent@test.com"};
export const OTHER_AGENT = {userId: 702, role: "delivery_agent", email: "agent2@test.com"};
export const ADMIN = {userId: 1, role: "system_admin", email: "admin@test.com"};

/**
 * Idempotency-Key values must be unique per logical write within a test file
 * (the middleware caches the first response verbatim for any repeat), but a
 * shared literal counter across files would make failures harder to place —
 * each call site gets its own counter closure, tagged with a prefix that
 * shows up in request logs/failure output (e.g. "test-idem-order-3").
 */
export function makeIdemKeyGenerator(prefix: string): () => string {
    let counter = 0;
    return () => {
        counter += 1;
        return `test-idem-${prefix}-${counter}`;
    };
}

export function seedBranch(overrides: Partial<Record<string, unknown>> = {}): void {
    coreClientStub.seedBranch(BRANCH_ID, {
        id: BRANCH_ID,
        restaurantId: RESTAURANT_ID,
        restaurantOwnerId: OWNER.userId,
        restaurantStatus: "active",
        region: "EG",
        isActive: true,
        acceptOrders: true,
        deliveryFee: 300,
        commissionBps: 1000,
        currency: "EGP",
        lat: 30.05,
        lng: 31.24,
        name: "Downtown Branch",
        addressText: "1 Branch St",
        ...overrides,
    });
}

export function seedAddress(userId: number = CUSTOMER.userId): void {
    coreClientStub.seedAddress(ADDRESS_ID, {
        id: ADDRESS_ID,
        userId,
        label: "Home",
        country: "Egypt",
        city: "Cairo",
        street: "Tahrir St",
        building: "5",
        apartmentNumber: "3",
        lat: 30.05,
        lng: 31.24,
    });
}

/** productId 1 (Burger, plenty of stock) and productId 2 (Fries, stock 1 — for insufficient-stock tests). */
export function seedProducts(): void {
    coreClientStub.seedBranchProduct(BRANCH_ID, 1, {productId: 1, name: "Burger", imageUrl: null, price: 500, stock: 10, isAvailable: true});
    coreClientStub.seedBranchProduct(BRANCH_ID, 2, {productId: 2, name: "Fries", imageUrl: null, price: 150, stock: 1, isAvailable: true});
}

export function seedAll(customerId: number = CUSTOMER.userId): void {
    seedBranch();
    seedAddress(customerId);
    seedProducts();
    // Full branch_manager permission set — the e2e flows drive a manager
    // through accept/preparing/ready/reject/cancel in one run. Individual
    // module tests that need a *narrower* permission set (or none, to prove
    // a 403) call coreClientStub.seedPermissions() themselves afterward,
    // which simply overwrites this — last write wins, see CoreClientStub.
    coreClientStub.seedPermissions("branch_manager", ["orders:accept", "orders:reject", "orders:cancel", "orders:update"]);
}
