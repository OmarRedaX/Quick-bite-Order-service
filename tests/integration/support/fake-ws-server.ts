export interface EmittedWsEvent {
    room: string;
    event: string;
    payload: unknown;
}

/**
 * Stands in for the real socket.io Server that server.ts registers into the
 * DI container AFTER createApp() (it needs the http.Server, built later).
 * Every service that emits WS events resolves TOKENS.WsServer lazily via a
 * getter, so createApp()-only integration tests crash on the first emit
 * unless something is registered first — this is that something.
 */
export class FakeIoServer {
    emitted: EmittedWsEvent[] = [];

    to(room: string) {
        return {
            emit: (event: string, payload: unknown) => {
                this.emitted.push({room, event, payload});
            },
        };
    }

    reset(): void {
        this.emitted = [];
    }
}

export const fakeIoServer = new FakeIoServer();
