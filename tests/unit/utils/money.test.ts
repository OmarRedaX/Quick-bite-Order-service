import {toMinor, fromMinor, sumMinor, multiplyMinor} from "../../../src/pkg/utils/money";

describe("toMinor", () => {
    it("converts major units to minor units", () => {
        expect(toMinor(15)).toBe(1500);
        expect(toMinor(15.5)).toBe(1550);
    });

    it("rounds to the nearest minor unit for floating-point-noisy input", () => {
        expect(toMinor(19.999)).toBe(2000);
        expect(toMinor(0.1 + 0.2)).toBe(30); // 0.1+0.2 === 0.30000000000000004 in JS
    });

    it("handles zero and negative amounts", () => {
        expect(toMinor(0)).toBe(0);
        expect(toMinor(-5)).toBe(-500);
    });
});

describe("fromMinor", () => {
    it("converts minor units back to major units", () => {
        expect(fromMinor(1500)).toBe(15);
        expect(fromMinor(1550)).toBe(15.5);
    });

    it("round-trips with toMinor for exact values", () => {
        expect(fromMinor(toMinor(42.75))).toBe(42.75);
    });
});

describe("sumMinor", () => {
    it("sums a list of minor-unit values", () => {
        expect(sumMinor([100, 200, 300])).toBe(600);
    });

    it("returns 0 for an empty list", () => {
        expect(sumMinor([])).toBe(0);
    });

    it("handles negative values (e.g. refund adjustments)", () => {
        expect(sumMinor([500, -200])).toBe(300);
    });
});

describe("multiplyMinor", () => {
    it("multiplies a unit price by a quantity", () => {
        expect(multiplyMinor(250, 3)).toBe(750);
    });

    it("returns 0 for zero quantity", () => {
        expect(multiplyMinor(250, 0)).toBe(0);
    });
});
