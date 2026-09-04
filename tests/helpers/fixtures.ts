import jwt from "jsonwebtoken"
import {randomUUID} from "crypto"
import {env} from "../../src/lib/config/env"
import {JWTPayload} from "../../src/lib/auth/jwt"
import {db} from "../../src/lib/knex/knex"
import {findOrderByPublicId} from "../../src/app/order/repository/order.repo"
import {OrderEntity} from "../../src/app/order/entity/order.entity"
import {OrderStatus, PaymentMethod, Currency} from "../../src/app/order/enums"

// Order-service verifies JWTs signed with its own ACCESS_SECRET — in
// production that secret is shared with core-service (whichever service
// issues the login token), but this service's own test suite never needs a
// live core-service to mint one: sign directly with the same secret
// env.ts reads from .env.test.
export function signAccessToken(payload: JWTPayload): string {
    return jwt.sign(payload, env.jwt.accessSecret, {expiresIn: Number(env.jwt.accessExpiresIn)})
}

export function authHeader(payload: JWTPayload): {Authorization: string} {
    return {Authorization: `Bearer ${signAccessToken(payload)}`}
}

// Infra-agnostic fixtures only, shared by unit and integration tests alike
// (mirrors core-service's tests/helpers/fixtures.ts convention of thin
// wrappers around real db(...) calls, not a factory abstraction layer). The
// integration-only actor/branch/product scenario fixtures (CUSTOMER, OWNER,
// seedBranch, seedAll, ...) — which need CoreClientStub and so can't live
// here — are in tests/integration/support/scenario.ts instead.

let orderFixtureSeq = 0

export interface InsertOrderOptions {
    region: string
    publicId?: string
    countryCode?: string
    restaurantId?: number
    restaurantOwnerId?: number
    branchId?: number
    customerId?: number
    customerAddressId?: number
    deliveryLat?: number
    deliveryLng?: number
    deliveryAddressText?: string
    branchLat?: number
    branchLng?: number
    status?: OrderStatus
    subtotal?: number
    deliveryFee?: number
    serviceFee?: number
    total?: number
    commission?: number
    currency?: Currency
    paymentMethod?: PaymentMethod
    deliveryAgentId?: number | null
    createdAt?: Date
    acceptedAt?: Date | null
    readyAt?: Date | null
    assignedAt?: Date | null
    pickedAt?: Date | null
    deliveredAt?: Date | null
    cancelledAt?: Date | null
}

/**
 * Seeds an `orders` row directly via SQL (bypassing OrderService.placeOrder,
 * which requires the full core-client branch/product/address round-trip).
 * Used by every module downstream of order placement — agent, assignment,
 * finance, payment — that only needs *an order in a given state* to exist,
 * not the placement flow itself (that flow gets its own dedicated coverage
 * in the order module's integration tests and Phase 4's E2E flows).
 * Returns the same OrderEntity shape order.repo.ts's own reads produce, by
 * reading the row back through findOrderByPublicId rather than duplicating
 * its snake_case -> camelCase mapping here.
 */
export async function insertOrder(opts: InsertOrderOptions): Promise<OrderEntity> {
    orderFixtureSeq += 1
    const n = orderFixtureSeq
    const conn = db(opts.region)
    const publicId = opts.publicId ?? randomUUID()
    const subtotal = opts.subtotal ?? 1000
    const deliveryFee = opts.deliveryFee ?? 200
    const serviceFee = opts.serviceFee ?? 100

    const [{public_id}] = await conn("orders")
        .insert({
            region: opts.region,
            public_id: publicId,
            country_code: opts.countryCode ?? opts.region.toUpperCase(),
            restaurant_id: opts.restaurantId ?? 1000 + n,
            restaurant_owner_id: opts.restaurantOwnerId ?? 9000 + n,
            branch_id: opts.branchId ?? 2000 + n,
            customer_id: opts.customerId ?? 3000 + n,
            customer_address_id: opts.customerAddressId ?? 4000 + n,
            delivery_lat: opts.deliveryLat ?? 30.05,
            delivery_lng: opts.deliveryLng ?? 31.24,
            delivery_address_text_snapshot: opts.deliveryAddressText ?? "123 Test St, Cairo",
            branch_lat: opts.branchLat ?? 30.05,
            branch_lng: opts.branchLng ?? 31.24,
            status: opts.status ?? OrderStatus.PLACED,
            subtotal,
            delivery_fee: deliveryFee,
            service_fee: serviceFee,
            total: opts.total ?? subtotal + deliveryFee + serviceFee,
            commission: opts.commission ?? 0,
            currency: opts.currency ?? Currency.EGP,
            payment_method: opts.paymentMethod ?? PaymentMethod.COD,
            delivery_agent_id: opts.deliveryAgentId ?? null,
            ...(opts.createdAt ? {created_at: opts.createdAt, updated_at: opts.createdAt} : {}),
            accepted_at: opts.acceptedAt ?? null,
            ready_at: opts.readyAt ?? null,
            assigned_at: opts.assignedAt ?? null,
            picked_at: opts.pickedAt ?? null,
            delivered_at: opts.deliveredAt ?? null,
            cancelled_at: opts.cancelledAt ?? null,
        })
        .returning(["public_id"])

    return (await findOrderByPublicId(public_id, conn))!
}
