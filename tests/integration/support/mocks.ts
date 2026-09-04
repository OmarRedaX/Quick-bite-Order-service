import {coreClientStub} from "../../helpers/core-client-stub";
import {kashierProviderStub} from "../../helpers/kashier-stub";
import {messageBrokerStub} from "../../helpers/message-broker-stub";

// ts-jest does not hoist jest.mock() the way babel-jest does — TypeScript's
// CommonJS emit keeps require() calls in the exact textual order they were
// written, so these registrations only take effect for files that import
// this module (or ./app, which imports this first) BEFORE anything that
// transitively pulls in the real core-client/kashier/messaging modules
// (i.e. before importing createApp()). See tests/helpers/*-stub.ts headers.
jest.mock("../../../src/lib/core-client/core-client", () => ({coreClient: coreClientStub}));
jest.mock("../../../src/pkg/payments/init", () => ({kashierProvider: kashierProviderStub}));
jest.mock("../../../src/lib/messaging/init", () => ({messageBroker: messageBrokerStub}));

export {coreClientStub, kashierProviderStub, messageBrokerStub};
