import jwt from "jsonwebtoken";
import {env} from "../../../src/lib/config/env";
import {verifyAccessToken, verifyRefreshToken, JWTPayload} from "../../../src/lib/auth/jwt";
import {NotAuthenticated} from "../../../src/lib/auth/errors";

const BASE_PAYLOAD: JWTPayload = {
    userId: 42,
    role: "customer",
    email: "diner@example.com",
};

function signAccess(payload: object, opts?: jwt.SignOptions) {
    return jwt.sign(payload, env.jwt.accessSecret, opts);
}

function signRefresh(payload: object, opts?: jwt.SignOptions) {
    return jwt.sign(payload, env.jwt.refreshSecret, opts);
}

describe("verifyAccessToken", () => {
    it("round-trips a token signed with the access secret", () => {
        const token = signAccess(BASE_PAYLOAD);
        const decoded = verifyAccessToken(token);
        expect(decoded).toEqual(BASE_PAYLOAD);
    });

    it("carries optional restaurant/branch claims through when present", () => {
        const payload: JWTPayload = {
            ...BASE_PAYLOAD,
            role: "restaurant_member",
            restaurantId: 7,
            restaurantRole: "branch_manager",
            branchIds: [1, 2, 3],
        };
        const decoded = verifyAccessToken(signAccess(payload));
        expect(decoded).toEqual(payload);
    });

    it("throws NotAuthenticated for an expired token", () => {
        const token = signAccess(BASE_PAYLOAD, {expiresIn: -10});
        expect(() => verifyAccessToken(token)).toThrow(NotAuthenticated);
    });

    it("throws NotAuthenticated for a token signed with the wrong secret", () => {
        const token = jwt.sign(BASE_PAYLOAD, "some-other-secret");
        expect(() => verifyAccessToken(token)).toThrow(NotAuthenticated);
    });

    it("throws NotAuthenticated for a token signed with the refresh secret", () => {
        const token = signRefresh(BASE_PAYLOAD);
        expect(() => verifyAccessToken(token)).toThrow(NotAuthenticated);
    });

    it("throws NotAuthenticated for a malformed token string", () => {
        expect(() => verifyAccessToken("not-a-jwt")).toThrow(NotAuthenticated);
    });
});

describe("verifyRefreshToken", () => {
    it("round-trips a token signed with the refresh secret", () => {
        const token = signRefresh(BASE_PAYLOAD);
        const decoded = verifyRefreshToken(token);
        expect(decoded).toEqual(BASE_PAYLOAD);
    });

    it("throws NotAuthenticated for a token signed with the access secret", () => {
        const token = signAccess(BASE_PAYLOAD);
        expect(() => verifyRefreshToken(token)).toThrow(NotAuthenticated);
    });

    it("throws NotAuthenticated for an expired refresh token", () => {
        const token = signRefresh(BASE_PAYLOAD, {expiresIn: -10});
        expect(() => verifyRefreshToken(token)).toThrow(NotAuthenticated);
    });
});
