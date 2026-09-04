import type {Response} from "express";
import {setAuthCookie} from "../../../src/lib/utils/cookie";

function fakeResponse() {
    return {cookie: jest.fn()} as unknown as Response;
}

describe("setAuthCookie", () => {
    it("sets the access_token cookie with httpOnly/lax/path defaults", () => {
        const res = fakeResponse();
        setAuthCookie(res, "jwt-token-value", 3600);
        expect(res.cookie).toHaveBeenCalledWith("access_token", "jwt-token-value", {
            httpOnly: true,
            sameSite: "lax",
            maxAge: 3600 * 1000,
            path: "/",
        });
    });

    it("converts the maxAge from seconds to milliseconds", () => {
        const res = fakeResponse();
        setAuthCookie(res, "t", 60);
        expect(res.cookie).toHaveBeenCalledWith(
            "access_token",
            "t",
            expect.objectContaining({maxAge: 60000}),
        );
    });
});
