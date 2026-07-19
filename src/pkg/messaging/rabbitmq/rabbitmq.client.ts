import amqp from "amqp-connection-manager";
import type {
    AmqpConnectionManager,
    ChannelWrapper,
} from "amqp-connection-manager";
import type {ConfirmChannel, ConsumeMessage as AmqpConsumeMessage} from "amqplib";
import type {
    ConsumeMessage,
    ConsumerOptions,
    IMessageBroker,
} from "../message-broker.interface";
import type {RabbitMQConfig} from "./rabbitmq.types";

/**
 * Mental model
 * ------------
 *   - 1 TCP connection -> many cheap virtual "channels".
 *   - Each channel here is a ChannelWrapper: it auto-reconnects and replays
 *     its `setup(ch)` function every time the underlying channel reopens.
 *   - We keep ONE long-lived publisher channel and open extra channels for
 *     declaring topology and for consuming. One channel = one purpose.
 */
export class RabbitMQClient implements IMessageBroker {
    private connection: AmqpConnectionManager | null = null;
    private publishChannel: ChannelWrapper | null = null;

    constructor(private readonly config: RabbitMQConfig) {}

    // Open the TCP connection + the long-lived publisher channel. Idempotent.
    async connect(): Promise<void> {
        if (this.connection) return;

        const reconnectSec = Math.max(1, Math.round(this.config.reconnectInitialMs / 1000));
        this.connection = amqp.connect([this.config.url], {reconnectTimeInSeconds: reconnectSec});

        // Typing the setup arg as ConfirmChannel turns on publisher confirms
        // automatically (broker acks every publish).
        this.publishChannel = this.connection.createChannel({
            json: false,
            setup: async (_ch: ConfirmChannel) => {
                /* publisher channel needs no setup */
            },
        });
        await this.publishChannel.waitForConnect();
    }

    // Tear everything down. Already-closed errors are fine -> swallow them.
    async close(): Promise<void> {
        await this.publishChannel?.close().catch(() => {});
        await this.connection?.close().catch(() => {});
        this.publishChannel = null;
        this.connection = null;
    }

    // Make sure the exchanges/queues/bindings exist.
    // Strategy: open a throwaway channel, let its setup run the asserts, close it.
    async declareTopology(opts: ConsumerOptions): Promise<void> {
        await this.connect();
        const ch = this.connection!.createChannel({
            json: false,
            setup: (c: ConfirmChannel) => assertTopology(c, opts),
        });
        await ch.waitForConnect(); // wait for setup to finish
        await ch.close();
    }

    // Open a long-lived consumer channel.
    // Everything inside `setup` re-runs on every reconnect, so topology and
    // the consumer registration are restored automatically after broker restarts.
    async consume(
        opts: ConsumerOptions,
        handler: (msg: ConsumeMessage) => Promise<void>,
    ): Promise<void> {
        await this.connect();
        const ch = this.connection!.createChannel({
            json: false,
            setup: async (c: ConfirmChannel) => {
                await assertTopology(c, opts);
                await c.prefetch(opts.prefetch); // max in-flight unacked messages
                await c.consume(
                    opts.queue,
                    (raw) => handleMessage(c, raw, handler),
                    {noAck: false}, // we'll ack/nack manually
                );
            },
        });
        await ch.waitForConnect();
    }

    // Publish through the long-lived publisher channel.
    // persistent:true -> survives broker restart (when paired with a durable queue).
    async publish(exchange: string, routingKey: string, body: Buffer): Promise<void> {
        await this.connect();
        await this.publishChannel!.publish(exchange, routingKey, body, {
            persistent: true,
            contentType: "application/json",
        });
    }
}

// ---------- helpers ----------

// "assert" = create if missing, else verify settings match. Always idempotent.
async function assertTopology(ch: ConfirmChannel, opts: ConsumerOptions): Promise<void> {
    await ch.assertExchange(opts.exchange, "topic", {durable: true});

    // Optional dead-letter setup: rejected/expired messages land here.
    if (opts.deadLetterExchange && opts.deadLetterQueue) {
        await ch.assertExchange(opts.deadLetterExchange, "topic", {durable: true});
        await ch.assertQueue(opts.deadLetterQueue, {durable: true});
        await ch.bindQueue(opts.deadLetterQueue, opts.deadLetterExchange, "#"); // catch-all
    }

    const queueArgs: Record<string, string> = {};
    if (opts.deadLetterExchange) queueArgs["x-dead-letter-exchange"] = opts.deadLetterExchange;

    await ch.assertQueue(opts.queue, {durable: true, arguments: queueArgs});
    for (const key of opts.bindingKeys) {
        await ch.bindQueue(opts.queue, opts.exchange, key);
    }
}

// Wrap the raw amqplib message in our broker-agnostic shape, run the handler,
// ack on success / nack on throw.
async function handleMessage(
    ch: ConfirmChannel,
    raw: AmqpConsumeMessage | null,
    handler: (msg: ConsumeMessage) => Promise<void>,
): Promise<void> {
    if (!raw) return; // null = consumer cancelled by the broker

    const msg: ConsumeMessage = {
        routingKey: raw.fields.routingKey,
        body: raw.content,
        ack: () => ch.ack(raw),
        nack: (requeue = false) => ch.nack(raw, false, requeue),
    };

    try {
        await handler(msg);
    } catch (err) {
        console.error("[rabbitmq] handler threw:", (err as Error).message);
        msg.nack(false); // false => no requeue, goes to DLQ if configured
    }
}
