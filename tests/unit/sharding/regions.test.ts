import {AppError} from "../../../src/lib/error/AppError";
import {
    REGIONS,
    normalizeRegion,
    isRegion,
    assertRegion,
} from "../../../src/lib/sharding/regions";

// REGIONS comes from env.regions, driven by REGIONS=eg,ksa in .env.test
// (tests/setup-env.ts). Asserted here so the rest of this file's expectations
// are legible without needing to cross-reference the env file.
describe("REGIONS", () => {
    it("is populated from env.regions", () => {
        expect(REGIONS).toEqual(["eg", "ksa"]);
    });
});

describe("normalizeRegion", () => {
    it("lowercases a region candidate", () => {
        expect(normalizeRegion("EG")).toBe("eg");
        expect(normalizeRegion("Ksa")).toBe("ksa");
    });

    it("returns undefined for non-string input", () => {
        expect(normalizeRegion(undefined)).toBeUndefined();
        expect(normalizeRegion(null)).toBeUndefined();
    });
});

describe("isRegion", () => {
    it("returns true for a known region, case-insensitively", () => {
        expect(isRegion("eg")).toBe(true);
        expect(isRegion("EG")).toBe(true);
        expect(isRegion("ksa")).toBe(true);
    });

    it("returns false for an unknown region", () => {
        expect(isRegion("us")).toBe(false);
    });

    it("returns false for undefined/null/empty", () => {
        expect(isRegion(undefined)).toBe(false);
        expect(isRegion(null)).toBe(false);
        expect(isRegion("")).toBe(false);
    });
});

describe("assertRegion", () => {
    it("returns the normalized region for a known candidate", () => {
        expect(assertRegion("EG")).toBe("eg");
        expect(assertRegion("ksa")).toBe("ksa");
    });

    it("throws a 400 AppError for an unknown region", () => {
        expect(() => assertRegion("us")).toThrow(AppError);
        try {
            assertRegion("us");
            throw new Error("expected assertRegion to throw");
        } catch (err) {
            expect(err).toBeInstanceOf(AppError);
            expect((err as AppError).statusCode).toBe(400);
            expect((err as AppError).message).toContain("us");
        }
    });

    it("throws for undefined/null/empty candidates", () => {
        expect(() => assertRegion(undefined)).toThrow(AppError);
        expect(() => assertRegion(null)).toThrow(AppError);
        expect(() => assertRegion("")).toThrow(AppError);
    });
});
