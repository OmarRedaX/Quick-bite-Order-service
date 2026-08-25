 import {env} from "../config/env";

// Region codes are normalized to lowercase. Country codes from core may
// arrive uppercase ("EG") or from clients in either case; the router
// always works on lowercase.
const set = new Set(env.regions.map((r) => r.toLowerCase()));
export const REGIONS: ReadonlyArray<string> = env.regions;

export function normalizeRegion(candidate: string | undefined | null): string | undefined {
    return typeof candidate === "string" ? candidate.toLowerCase() : undefined;
}

export function isRegion(candidate: string | undefined | null): candidate is string {
    const norm = normalizeRegion(candidate);
    return !!norm && set.has(norm);
}

export function assertRegion(candidate: string | undefined | null): string {
    const norm = normalizeRegion(candidate);
    if (!norm || !set.has(norm)) {
        throw new Error(`Unknown region: "${candidate}". Known: ${env.regions.join(",")}`);
    }
    return norm;
}
