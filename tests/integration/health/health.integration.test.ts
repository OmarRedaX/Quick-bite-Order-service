import request from "supertest";
import {buildTestApp} from "../support/app";

// First integration test to exercise global-setup.ts's real migrate +
// partition-creation flow end to end (Jest's globalSetup only runs once a
// matching *integration.test.ts file exists — see testing-implementation-plan.md
// Phase 1's progress log). A green run here is the proof that both regions'
// hot-cluster test databases are actually migrated and reachable.
describe("GET /api/health", () => {
    it("reports ok:true with both regions' hot shards reachable", async () => {
        const res = await request(buildTestApp()).get("/api/health");
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        const hotShards = res.body.shards.filter((s: {cluster: string}) => s.cluster === "hot");
        expect(hotShards.map((s: {region: string}) => s.region).sort()).toEqual(["eg", "ksa"]);
        expect(hotShards.every((s: {ok: boolean}) => s.ok)).toBe(true);
    });

    it("also pings the archive shards (best-effort, included in the same report)", async () => {
        const res = await request(buildTestApp()).get("/api/health");
        const archiveShards = res.body.shards.filter((s: {cluster: string}) => s.cluster === "archive");
        expect(archiveShards).toHaveLength(2);
    });
});
