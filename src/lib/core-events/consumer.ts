import {IMessageBroker, ConsumeMessage} from "../../pkg/messaging/message-broker.interface";
import {env} from "../config/env";
import {logger} from "../logger/logger";
import {cacheProvider} from "../cache/init";
import {CoreEventEnvelope, CoreEventHandler} from "./types";

// Safety window for redelivery (consumer restart, nack-requeue, ops DLQ replay).
// Longer than realistic redelivery lag, short enough to keep Redis bounded.
// Safe to expire: all handlers are idempotent cache invalidations.
const DEDUPE_TTL_SEC = 24 * 60 * 60;

const handlers = new Map<string, CoreEventHandler>();

export function registerHandler(eventType: string, handler: CoreEventHandler) {
    if (handlers.has(eventType)) {
        throw new Error(`Handler already registered for ${eventType}`);
    }
    handlers.set(eventType, handler);
}

export function listRegisteredHandlers(): string[] {
    return Array.from(handlers.keys());
}

const topology = {
    exchange: env.rabbit.exchange,
    queue: env.rabbit.queue,
    bindingKeys: env.rabbit.bindings,
    deadLetterExchange: env.rabbit.dlx,
    deadLetterQueue: env.rabbit.dlq,
    prefetch: env.rabbit.prefetch,
};

export async function startCoreEventsConsumer(broker: IMessageBroker): Promise<void> {
    await broker.declareTopology(topology);
    await broker.consume(topology, handleMessage);
    logger.info("core-events consumer started", {
        queue: env.rabbit.queue,
        bindings: env.rabbit.bindings,
    });
}

async function handleMessage(msg: ConsumeMessage): Promise<void> {
    const envelope = parseEnvelope(msg);
    if (!envelope) return msg.nack(false);

    // Dedupe via Redis SETNX. Returns false if we've already processed this eventId.
    const fresh = await cacheProvider.trySet(
        `core-events:dedupe:${envelope.eventId}`,
        "1",
        DEDUPE_TTL_SEC,
    );
    if (!fresh) {
        msg.ack();
        return;
    }

    const handler = handlers.get(envelope.eventType);
    if (!handler) {
        logger.warn("core-events: no handler, acking", {
            eventType: envelope.eventType,
            eventId: envelope.eventId,
        });
        msg.ack();
        return;
    }

    try {
        await handler(envelope.payload);
        msg.ack();
    } catch (err) {
        logger.error("core-events: handler failed, sending to DLQ", {
            eventType: envelope.eventType,
            eventId: envelope.eventId,
            error: (err as Error).message,
        });
        msg.nack(false);
    }
}

function parseEnvelope(msg: ConsumeMessage): CoreEventEnvelope | null {
    try {
        const env = JSON.parse(msg.body.toString("utf8")) as CoreEventEnvelope;
        if (!env.eventId || !env.eventType) return null;
        return env;
    } catch {
        return null;
    }
}
