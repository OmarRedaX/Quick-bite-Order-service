export type CoreEventHandler = (payload: unknown) => Promise<void>;

export interface CoreEventEnvelope {
    eventId: string;
    eventType: string;
    occurredAt: string;
    payload: unknown;
}
