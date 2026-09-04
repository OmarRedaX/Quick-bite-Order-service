import {ConsumeMessage, ConsumerOptions, IMessageBroker} from "../../src/pkg/messaging/message-broker.interface"

type Handler = (msg: ConsumeMessage) => Promise<void>

// Mirrors core-service's EmailStub/message-broker-stub pattern: mocked in via
// `jest.mock("../../../src/lib/messaging/init", () => ({messageBroker: messageBrokerStub}))`
// before importing createApp(), so no real RabbitMQ is needed for the
// app-level integration suite. (pkg/messaging/rabbitmq.client.ts itself still
// gets its own dedicated test against a real local RabbitMQ — see
// testing-implementation-plan.md Phase 3 — this stub is only for tests that
// exercise the app through createApp().)
export class MessageBrokerStub implements IMessageBroker {
    published: Array<{exchange: string; routingKey: string; body: Buffer}> = []
    topologies: ConsumerOptions[] = []
    private handlers = new Map<string, Handler>()

    async connect(): Promise<void> {}
    async close(): Promise<void> {}

    async declareTopology(opts: ConsumerOptions): Promise<void> {
        this.topologies.push(opts)
    }

    async consume(opts: ConsumerOptions, handler: Handler): Promise<void> {
        this.handlers.set(opts.queue, handler)
    }

    async publish(exchange: string, routingKey: string, body: Buffer): Promise<void> {
        this.published.push({exchange, routingKey, body})
    }

    /** Test-only: invoke a previously-registered consumer directly, as if a message arrived on `queue`. */
    async deliver(queue: string, msg: Omit<ConsumeMessage, "ack" | "nack">): Promise<void> {
        const handler = this.handlers.get(queue)
        if (!handler) throw new Error(`MessageBrokerStub: no consumer registered for queue "${queue}"`)
        await handler({
            ...msg,
            ack: () => {},
            nack: () => {},
        })
    }

    reset(): void {
        this.published = []
        this.topologies = []
        this.handlers.clear()
    }
}

export const messageBrokerStub = new MessageBrokerStub()
