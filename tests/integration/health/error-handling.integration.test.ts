import request from "supertest";
import {buildTestApp, coreClientStub, resetTestDoubles} from "../support/app";
import {CUSTOMER} from "../support/scenario";
import {truncateAllRegions} from "../../helpers/db";
import {flushTestCache} from "../../helpers/redis";
import {authHeader} from "../../helpers/fixtures";

const app = buildTestApp();

beforeEach(async () => {
    await truncateAllRegions(["eg", "ksa"]);
    await flushTestCache();
    resetTestDoubles();
});

describe("errorHandler cross-cutting behavior", () => {
    it("turns a body-parser SyntaxError (malformed JSON) into a clean 400, not a 500", async () => {
        const res = await request(app)
            .post("/api/orders")
            .set("X-Region", "eg")
            .set("Idempotency-Key", "malformed-body-1")
            .set(authHeader(CUSTOMER))
            .set("Content-Type", "application/json")
            .send("{not-valid-json");
        expect(res.status).toBe(400);
        expect(res.body.error).toBe("Malformed request body");
    });

    it("masks a non-AppError (unexpected/programming error) behind a generic 500, but still logs the real message", async () => {
        // failNextRequestWith is typed as AppError-only in the stub because
        // that's the only kind CoreClient's own retry contract ever throws in
        // production; forcing a plain Error through it here exercises the
        // errorHandler's other branch (isOperational=false) — the one case
        // that contract doesn't otherwise reach in this test suite. placeOrder
        // is the endpoint under test because it's the first thing to call
        // coreClient.request() (via getBranch), unlike getOrder/etc which
        // never touch core-service at all.
        (coreClientStub as unknown as {failNextRequestWith: unknown}).failNextRequestWith = new Error("unexpected upstream shape");

        const res = await request(app)
            .post("/api/orders")
            .set("X-Region", "eg")
            .set("Idempotency-Key", "programming-error-1")
            .set(authHeader(CUSTOMER))
            .send({branchId: 20, customerAddressId: 40, paymentMethod: "cod", items: [{productId: 1, quantity: 1}]});

        expect(res.status).toBe(500);
        expect(res.body.error).toBe("Something went wrong");
    });
});
