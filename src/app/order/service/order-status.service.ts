import {OrderStatus, StatusActor} from "../enums";
import {invalidStatusTransitionError, ReasonRequiredError, CancellationWindowExpiredError} from "../errors";
import {AssertTransitionContext, AssertTransitionResult} from "../types";

interface TransitionRule {
    actors: StatusActor[];
    stamp: string | null;
    requiresReason?: boolean;
}

/**
 * Status machine. Each entry is `from -> to -> rule`. Anything not listed is
 * a forbidden transition and returns 409 InvalidStatusTransition.
 *
 * `assigned` and `delivered` are NOT exposed on the public PATCH /orders/{id}/status
 * endpoint — they are written by the assignment / delivery services as part of
 * Phase 3+. Listing them here keeps the table honest as those phases land.
 */
const TRANSITIONS: Record<string, Record<string, TransitionRule>> = {
    [OrderStatus.PENDING_PAYMENT]: {
        [OrderStatus.PLACED]:    {actors: [StatusActor.SYSTEM], stamp: null},
        [OrderStatus.CANCELLED]: {actors: [StatusActor.CUSTOMER, StatusActor.SYSTEM], stamp: "cancelled_at"},
    },
    [OrderStatus.PLACED]: {
        [OrderStatus.ACCEPTED]:  {actors: [StatusActor.RESTAURANT_MEMBER], stamp: "accepted_at"},
        [OrderStatus.REJECTED]:  {actors: [StatusActor.RESTAURANT_MEMBER], stamp: "rejected_at", requiresReason: true},
        [OrderStatus.CANCELLED]: {actors: [StatusActor.CUSTOMER, StatusActor.RESTAURANT_MEMBER, StatusActor.SYSTEM, StatusActor.ADMIN], stamp: "cancelled_at", requiresReason: true},
    },
    [OrderStatus.ACCEPTED]: {
        [OrderStatus.PREPARING]: {actors: [StatusActor.RESTAURANT_MEMBER], stamp: null},
        [OrderStatus.CANCELLED]: {actors: [StatusActor.RESTAURANT_MEMBER, StatusActor.ADMIN], stamp: "cancelled_at", requiresReason: true},
    },
    [OrderStatus.PREPARING]: {
        [OrderStatus.READY]:     {actors: [StatusActor.RESTAURANT_MEMBER], stamp: "ready_at"},
        [OrderStatus.CANCELLED]: {actors: [StatusActor.RESTAURANT_MEMBER, StatusActor.ADMIN], stamp: "cancelled_at", requiresReason: true},
    },
    [OrderStatus.READY]: {
        [OrderStatus.ASSIGNED]:  {actors: [StatusActor.SYSTEM], stamp: "assigned_at"},
        [OrderStatus.CANCELLED]: {actors: [StatusActor.RESTAURANT_MEMBER, StatusActor.ADMIN], stamp: "cancelled_at", requiresReason: true},
    },
    [OrderStatus.ASSIGNED]: {
        [OrderStatus.PICKED]:    {actors: [StatusActor.AGENT], stamp: "picked_at"},
        [OrderStatus.CANCELLED]: {actors: [StatusActor.ADMIN], stamp: "cancelled_at", requiresReason: true},
    },
    [OrderStatus.PICKED]: {
        [OrderStatus.DELIVERED]: {actors: [StatusActor.AGENT], stamp: "delivered_at"},
    },
};

/**
 * Customer cancellation has a tight window: until accepted_at is set OR within
 * 60 seconds of placed_at (proxied via created_at on a placed order).
 */
const CUSTOMER_CANCEL_WINDOW_MS = 60 * 1000;

/**
 * Validates a status transition. Throws AppError on illegal transition / missing
 * permissions / missing reason / customer cancel window expired.
 */
export function assertTransition(from: OrderStatus, to: OrderStatus, ctx: AssertTransitionContext): AssertTransitionResult {
    const allowed = TRANSITIONS[from]?.[to];
    if (!allowed) {
        throw invalidStatusTransitionError(from, to);
    }
    if (!allowed.actors.includes(ctx.actor)) {
        throw invalidStatusTransitionError(from, to);
    }
    if (allowed.requiresReason && (!ctx.reason || ctx.reason.trim().length === 0)) {
        throw ReasonRequiredError;
    }
    if (ctx.actor === StatusActor.CUSTOMER && to === OrderStatus.CANCELLED && from === OrderStatus.PLACED) {
        if (ctx.acceptedAt) throw CancellationWindowExpiredError;
        if (ctx.placedAt && Date.now() - ctx.placedAt.getTime() > CUSTOMER_CANCEL_WINDOW_MS) {
            throw CancellationWindowExpiredError;
        }
    }
    return {stamp: allowed.stamp};
}
