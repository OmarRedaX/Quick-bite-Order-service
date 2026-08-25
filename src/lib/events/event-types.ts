/**
 * Outbound event type constants emitted by order-service.
 * Routing keys consumed by analytics-service and any future subscribers.
 *
 * Naming: <aggregate>.<past-tense-verb>.
 */
export const EVENT_TYPES = {
    ORDER_PLACED: "order.placed",
    ORDER_ACCEPTED: "order.accepted",
    ORDER_REJECTED: "order.rejected",
    ORDER_DELIVERED: "order.delivered",
    ORDER_CANCELLED: "order.cancelled",
    PAYMENT_COMPLETED: "payment.completed",
    PAYMENT_FAILED: "payment.failed",
} as const;

export type EventType = (typeof EVENT_TYPES)[keyof typeof EVENT_TYPES];
