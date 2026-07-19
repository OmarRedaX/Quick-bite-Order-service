export interface RabbitMQConfig {
    url: string;
    reconnectInitialMs: number; // first backoff, doubles up to reconnectMaxMs
    reconnectMaxMs: number;
}
