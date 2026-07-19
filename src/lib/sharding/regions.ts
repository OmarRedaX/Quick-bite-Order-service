 import {env} from "../config/env";

const set = new Set(env.regions);

export const REGIONS: ReadonlyArray<string> = env.regions;

export function isRegion(candidate: string | undefined | null): candidate is string {
    return typeof candidate === "string" && set.has(candidate);
}

export function assertRegion(candidate: string | undefined | null): string {
    if (!isRegion(candidate)) {
        throw new Error(`Unknown region: "${candidate}". Known: ${env.regions.join(",")}`);
    }
    return candidate;
}
