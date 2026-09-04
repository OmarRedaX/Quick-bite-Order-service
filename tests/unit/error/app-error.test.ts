import {AppError} from "../../../src/lib/error/AppError";

describe("AppError", () => {
    it("defaults statusCode to 500 and isOperational to true", () => {
        const err = new AppError("boom");
        expect(err.message).toBe("boom");
        expect(err.statusCode).toBe(500);
        expect(err.isOperational).toBe(true);
        expect(err).toBeInstanceOf(Error);
    });

    it("accepts an explicit statusCode and isOperational flag", () => {
        const err = new AppError("not found", 404, false);
        expect(err.statusCode).toBe(404);
        expect(err.isOperational).toBe(false);
    });

    it("chains an underlying cause via the native Error options", () => {
        const cause = new Error("network down");
        const err = new AppError("core-service unavailable", 503, true, {cause});
        expect(err.cause).toBe(cause);
    });

    it("captures a stack trace starting at the message, excluding the AppError constructor frame itself", () => {
        const err = new AppError("boom");
        expect(err.stack).toMatch(/^Error: boom/);
        expect(err.stack).not.toContain("at new AppError");
    });
});
