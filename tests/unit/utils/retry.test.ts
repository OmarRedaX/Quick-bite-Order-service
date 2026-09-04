import {retry} from "../../../src/pkg/utils/retry";

// setTimeout is stubbed to fire immediately so these tests run instantly and
// deterministically while still letting us assert on the delay values retry()
// actually requested (its exponential-backoff math).
let setTimeoutSpy: jest.SpyInstance;

beforeEach(() => {
    setTimeoutSpy = jest
        .spyOn(global, "setTimeout")
        .mockImplementation(((cb: () => void) => {
            cb();
            return 0 as unknown as NodeJS.Timeout;
        }) as unknown as typeof setTimeout);
});

afterEach(() => {
    setTimeoutSpy.mockRestore();
});

describe("retry", () => {
    it("returns the result on first success without delaying", async () => {
        const fn = jest.fn().mockResolvedValue("ok");
        const result = await retry(fn, {attempts: 3, initialDelayMs: 10, maxDelayMs: 100});
        expect(result).toBe("ok");
        expect(fn).toHaveBeenCalledTimes(1);
        expect(setTimeoutSpy).not.toHaveBeenCalled();
    });

    it("retries after a failure and returns the eventual success", async () => {
        const fn = jest
            .fn()
            .mockRejectedValueOnce(new Error("first fails"))
            .mockResolvedValueOnce("ok");
        const result = await retry(fn, {attempts: 3, initialDelayMs: 10, maxDelayMs: 100});
        expect(result).toBe("ok");
        expect(fn).toHaveBeenCalledTimes(2);
        expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
    });

    it("throws the last error once attempts are exhausted", async () => {
        const err1 = new Error("fail 1");
        const err2 = new Error("fail 2");
        const fn = jest
            .fn()
            .mockRejectedValueOnce(err1)
            .mockRejectedValueOnce(err2);
        await expect(
            retry(fn, {attempts: 2, initialDelayMs: 10, maxDelayMs: 100}),
        ).rejects.toBe(err2);
        expect(fn).toHaveBeenCalledTimes(2);
    });

    it("does not delay before the final (non-retried) attempt", async () => {
        const fn = jest.fn().mockRejectedValue(new Error("always fails"));
        await expect(
            retry(fn, {attempts: 3, initialDelayMs: 10, maxDelayMs: 100}),
        ).rejects.toThrow("always fails");
        expect(fn).toHaveBeenCalledTimes(3);
        expect(setTimeoutSpy).toHaveBeenCalledTimes(2); // only between attempts, not after the last
    });

    it("rethrows immediately (no further attempts) when isRetryable returns false", async () => {
        const nonRetryable = new Error("programming error");
        const fn = jest.fn().mockRejectedValue(nonRetryable);
        await expect(
            retry(fn, {
                attempts: 5,
                initialDelayMs: 10,
                maxDelayMs: 100,
                isRetryable: (err) => (err as Error).message !== "programming error",
            }),
        ).rejects.toBe(nonRetryable);
        expect(fn).toHaveBeenCalledTimes(1);
        expect(setTimeoutSpy).not.toHaveBeenCalled();
    });

    it("doubles the delay each attempt, capped at maxDelayMs", async () => {
        const fn = jest.fn().mockRejectedValue(new Error("always fails"));
        await expect(
            retry(fn, {attempts: 4, initialDelayMs: 10, maxDelayMs: 35}),
        ).rejects.toThrow();
        const delays = setTimeoutSpy.mock.calls.map((call) => call[1]);
        expect(delays).toEqual([10, 20, 35]); // 10 -> 20 -> 40 capped to 35
    });
});
