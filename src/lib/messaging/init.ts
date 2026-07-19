import {RabbitMQClient} from "../../pkg/messaging/rabbitmq/rabbitmq.client";
import {env} from "../config/env";

export const messageBroker = new RabbitMQClient({
    url: env.rabbit.url,
    reconnectInitialMs: 500,
    reconnectMaxMs: 15_000,
});
