import "./mocks";
import type {Express} from "express";
import {createApp} from "../../../src/app";
import {container} from "../../../src/lib/di/container";
import {TOKENS} from "../../../src/lib/di/tokens";
import {PermissionCacheService} from "../../../src/lib/rbac/permission-cache.service";
import {coreClientStub, kashierProviderStub, messageBrokerStub} from "./mocks";
import {fakeIoServer} from "./fake-ws-server";

// server.ts is the only place TOKENS.WsServer normally gets registered (it
// needs the http.Server, created after createApp()). Every service that
// emits a WS event resolves it lazily via `container.resolve`, so any
// createApp()-only test crashes on the first emit unless something answers
// that token first.
container.registerInstance(TOKENS.WsServer, fakeIoServer as never);

let app: Express | undefined;

export function buildTestApp(): Express {
    if (!app) app = createApp();
    return app;
}

/** Call in beforeEach — clears every test double's recorded state and the in-process permission cache. */
export function resetTestDoubles(): void {
    coreClientStub.reset();
    kashierProviderStub.reset();
    messageBrokerStub.reset();
    fakeIoServer.reset();
    container.resolve<PermissionCacheService>(TOKENS.PermissionCacheService).invalidate();
}

export {coreClientStub, kashierProviderStub, messageBrokerStub, fakeIoServer};
