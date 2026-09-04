import {CoreClient} from "../../../src/lib/core-client/core-client";
import {AppError} from "../../../src/lib/error/AppError";

// Isolated from env.ts / the real core-service on purpose — CoreClient takes
// baseUrl/apiKey/timeoutMs as constructor args specifically so this doesn't
// need real env vars or a live dependency to test its own contract.
function makeClient(timeoutMs = 5000) {
    return new CoreClient("http://core.internal", "test-api-key", timeoutMs);
}

function jsonResponse(status: number, body: unknown, ok = status >= 200 && status < 300) {
    return {
        status,
        ok,
        json: () => Promise.resolve(body),
        text: () => Promise.resolve(JSON.stringify(body)),
    } as Response;
}

describe("CoreClient — translate-at-the-boundary error contract", () => {
    let fetchMock: jest.Mock;
    let originalFetch: typeof fetch;

    beforeEach(() => {
        originalFetch = global.fetch;
        fetchMock = jest.fn();
        global.fetch = fetchMock as unknown as typeof fetch;
    });

    afterEach(() => {
        global.fetch = originalFetch;
    });

    it("returns parsed JSON on success, one fetch call", async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(200, {ok: true}));

        const result = await makeClient().request({method: "GET", path: "/x"});

        expect(result).toEqual({ok: true});
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("core-service 4xx surfaces as its own status, not 503, and is not retried", async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(404, {error: "not found"}));

        const err = await makeClient()
            .request({method: "GET", path: "/x"})
            .catch((e) => e);

        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).statusCode).toBe(404);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("core-service 5xx -> stable 503 'Core service unavailable' contract, retried to exhaustion", async () => {
        fetchMock.mockResolvedValue(jsonResponse(502, {error: "bad gateway"}));

        const err = await makeClient()
            .request({method: "GET", path: "/x"})
            .catch((e) => e);

        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).statusCode).toBe(503);
        expect((err as AppError).message).toBe("Core service unavailable");
        expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it("connection refused -> same stable 503 contract, retried to exhaustion, cause preserved", async () => {
        const networkErr = new TypeError("fetch failed");
        fetchMock.mockRejectedValue(networkErr);

        const err = (await makeClient()
            .request({method: "GET", path: "/x"})
            .catch((e) => e)) as AppError;

        expect(err).toBeInstanceOf(AppError);
        expect(err.statusCode).toBe(503);
        expect(err.message).toBe("Core service unavailable");
        expect(err.cause).toBe(networkErr);
        expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it("timeout/aborted request -> same stable 503 contract", async () => {
        const timeoutErr = new DOMException("The operation was aborted due to timeout", "TimeoutError");
        fetchMock.mockRejectedValue(timeoutErr);

        const err = (await makeClient(50)
            .request({method: "GET", path: "/x"})
            .catch((e) => e)) as AppError;

        expect(err).toBeInstanceOf(AppError);
        expect(err.statusCode).toBe(503);
        expect(err.message).toBe("Core service unavailable");
        expect(err.cause).toBe(timeoutErr);
    });

    it("recovers if a later attempt succeeds after transient availability failures", async () => {
        fetchMock
            .mockRejectedValueOnce(new TypeError("fetch failed"))
            .mockResolvedValueOnce(jsonResponse(200, {ok: true}));

        const result = await makeClient().request({method: "GET", path: "/x"});

        expect(result).toEqual({ok: true});
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("an unrelated programming error (bad JSON body) is not retried and is not wrapped as 503", async () => {
        const parseErr = new SyntaxError("Unexpected token in JSON");
        fetchMock.mockResolvedValue({
            status: 200,
            ok: true,
            json: () => Promise.reject(parseErr),
            text: () => Promise.resolve(""),
        } as Response);

        const err = await makeClient()
            .request({method: "GET", path: "/x"})
            .catch((e) => e);

        expect(err).toBe(parseErr);
        expect(err).not.toBeInstanceOf(AppError);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});
