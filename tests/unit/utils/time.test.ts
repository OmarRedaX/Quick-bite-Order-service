import {toMs, toSeconds, currentUtcYear, startOfUtcYear} from "../../../src/pkg/utils/time";

describe("toMs", () => {
    it.each([
        [5, "s", 5000],
        [2, "m", 120000],
        [3, "h", 10800000],
        [1, "d", 86400000],
    ] as const)("converts %p%s to %p ms", (value, unit, expected) => {
        expect(toMs(value, unit)).toBe(expected);
    });

    it("handles zero", () => {
        expect(toMs(0, "h")).toBe(0);
    });
});

describe("toSeconds", () => {
    it("converts a duration to seconds via milliseconds", () => {
        expect(toSeconds(2, "m")).toBe(120);
        expect(toSeconds(1, "h")).toBe(3600);
    });

    it("agrees with toMs / 1000", () => {
        expect(toSeconds(7, "d")).toBe(toMs(7, "d") / 1000);
    });
});

describe("currentUtcYear", () => {
    it("returns the UTC year of the current instant", () => {
        const fixed = new Date(Date.UTC(2030, 5, 1));
        jest.useFakeTimers().setSystemTime(fixed);
        expect(currentUtcYear()).toBe(2030);
        jest.useRealTimers();
    });
});

describe("startOfUtcYear", () => {
    it("returns Jan 1 00:00:00 UTC for the given year", () => {
        const date = startOfUtcYear(2027);
        expect(date.toISOString()).toBe("2027-01-01T00:00:00.000Z");
    });

    it("is unaffected by the process's local timezone", () => {
        const date = startOfUtcYear(2000);
        expect(date.getUTCFullYear()).toBe(2000);
        expect(date.getUTCMonth()).toBe(0);
        expect(date.getUTCDate()).toBe(1);
        expect(date.getUTCHours()).toBe(0);
    });
});
