import {createHmac} from "crypto";
import {
    buildSignaturePayload,
    computeWebhookSignature,
    verifyWebhookSignature,
} from "../../../src/pkg/payments/kashier/kashier.signature";

const API_KEY = "test-kashier-api-key";

describe("buildSignaturePayload", () => {
    it("sorts fields alphabetically and URL-encodes values", () => {
        const payload = buildSignaturePayload(
            {orderId: "order 1", amount: 100, currency: "EGP"},
            ["currency", "amount", "orderId"],
        );
        expect(payload).toBe("amount=100&currency=EGP&orderId=order%201");
    });

    it("stringifies numbers verbatim (no trailing zero normalization)", () => {
        const payload = buildSignaturePayload({amount: 16.3}, ["amount"]);
        expect(payload).toBe("amount=16.3");
    });

    it("treats a missing or null field as an empty string", () => {
        const payload = buildSignaturePayload({a: null}, ["a", "b"]);
        expect(payload).toBe("a=&b=");
    });

    it("only signs the requested keys, ignoring extra data fields", () => {
        const payload = buildSignaturePayload(
            {a: "1", b: "2", c: "3"},
            ["a", "c"],
        );
        expect(payload).toBe("a=1&c=3");
    });
});

describe("computeWebhookSignature", () => {
    it("matches a manually computed HMAC-SHA256 digest", () => {
        const data = {orderId: "abc", amount: 100};
        const keys = ["orderId", "amount"];
        const expected = createHmac("sha256", API_KEY)
            .update("amount=100&orderId=abc", "utf8")
            .digest("hex");
        expect(computeWebhookSignature(data, keys, API_KEY)).toBe(expected);
    });

    it("produces a different digest for a different API key", () => {
        const data = {orderId: "abc"};
        const sigA = computeWebhookSignature(data, ["orderId"], "key-a");
        const sigB = computeWebhookSignature(data, ["orderId"], "key-b");
        expect(sigA).not.toBe(sigB);
    });
});

describe("verifyWebhookSignature", () => {
    const data = {orderId: "abc", amount: "100"};
    const keys = ["orderId", "amount"];

    it("accepts a correctly computed signature", () => {
        const sig = computeWebhookSignature(data, keys, API_KEY);
        expect(verifyWebhookSignature(data, keys, API_KEY, sig)).toBe(true);
    });

    it("rejects a tampered payload signed with the original signature", () => {
        const sig = computeWebhookSignature(data, keys, API_KEY);
        const tampered = {...data, amount: "999"};
        expect(verifyWebhookSignature(tampered, keys, API_KEY, sig)).toBe(false);
    });

    it("rejects a signature computed with the wrong API key", () => {
        const sig = computeWebhookSignature(data, keys, "wrong-key");
        expect(verifyWebhookSignature(data, keys, API_KEY, sig)).toBe(false);
    });

    it("rejects a garbage/non-hex signature without throwing", () => {
        expect(verifyWebhookSignature(data, keys, API_KEY, "not-hex-!!")).toBe(false);
    });

    it("rejects a missing signature", () => {
        expect(verifyWebhookSignature(data, keys, API_KEY, "")).toBe(false);
        expect(verifyWebhookSignature(data, keys, API_KEY, undefined as unknown as string)).toBe(false);
    });

    it("rejects a signature of a different length than expected (avoids timingSafeEqual throwing)", () => {
        const sig = computeWebhookSignature(data, keys, API_KEY);
        expect(verifyWebhookSignature(data, keys, API_KEY, sig.slice(0, -2))).toBe(false);
    });
});
