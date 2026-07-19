import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	acquireLifecycleLock,
	appendLifecycleEvent,
	createLaneName,
	isCleanupEligible,
	type LaneRecord,
	ownershipMatches,
	parseNormalizedPurpose,
	readLaneRecord,
	writeLaneRecord,
} from "@gajae-code/coding-agent/gjc-runtime/git-lifecycle";

const tempDirs: string[] = [];

async function makeGitCommonDir(): Promise<string> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-git-lifecycle-"));
	tempDirs.push(directory);
	return path.join(directory, ".git");
}

function record(overrides: Partial<LaneRecord> = {}): LaneRecord {
	return {
		version: 1,
		laneId: "dev-runtime-a1",
		state: "gc_eligible",
		repositoryId: "repo-123",
		realm: "windows",
		branch: "dev/runtime-api--gjc-a1",
		worktreeToken: "DEV)runtime-api__gjc-a1",
		worktreePath: "D:\\worktrees\\repo\\DEV)runtime-api__gjc-a1",
		agent: "gjc",
		sessionId: "session-123",
		createdAt: "2026-07-18T00:00:00.000Z",
		updatedAt: "2026-07-18T00:00:00.000Z",
		cleanupEvidence: {
			mergeCommit: "abc123",
			gcApprovedAt: "2026-07-18T00:01:00.000Z",
			retentionApprovedAt: "2026-07-18T00:02:00.000Z",
			explicitCleanupRequestedAt: "2026-07-18T00:03:00.000Z",
		},
		...overrides,
	};
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

describe("git lifecycle names", () => {
	it("normalizes names and creates branch and visual worktree tokens", () => {
		const name = createLaneName({
			type: "dev",
			scope: "Git Runtime",
			purpose: "lane_foundation",
			agent: "GJC",
			id: "A1",
		});
		expect(name).toEqual({
			branch: "dev/git-runtime-lane-foundation--gjc-a1",
			worktreeToken: "DEV)git-runtime-lane-foundation__gjc-a1",
			scope: "git-runtime",
			purpose: "lane-foundation",
		});
		expect(parseNormalizedPurpose("Purpose Name")).toBe("purpose-name");
	});

	it("rejects unsafe, reserved, overlong, and case-colliding names", () => {
		expect(() => createLaneName({ type: "dev", scope: "con", purpose: "api", agent: "gjc", id: "a1" })).toThrow(
			"reserved",
		);
		expect(() =>
			createLaneName({ type: "dev", scope: "git", purpose: "api/escape", agent: "gjc", id: "a1" }),
		).toThrow("lowercase");
		expect(() =>
			createLaneName({
				type: "dev",
				scope: "git",
				purpose: "api",
				agent: "gjc",
				id: "a1",
				existingBranches: ["DEV/GIT-API--GJC-A1"],
			}),
		).toThrow("case-insensitively");
		expect(() =>
			createLaneName({
				type: "dev",
				scope: "git",
				purpose: "api",
				agent: "gjc",
				id: "a1",
				existingWorktreeTokens: ["dev)GIT-API__GJC-A1"],
			}),
		).toThrow("case-insensitively");
		expect(() =>
			createLaneName({ type: "dev", scope: "x".repeat(100), purpose: "y".repeat(100), agent: "gjc", id: "a1" }),
		).toThrow("length");
	});
});

describe("git lifecycle registry", () => {
	it("atomically persists state records and appends auditable events", async () => {
		const gitCommonDir = await makeGitCommonDir();
		const planned = record({ state: "planned" });
		await writeLaneRecord(gitCommonDir, planned);
		await writeLaneRecord(gitCommonDir, { ...planned, state: "active", updatedAt: "2026-07-18T00:04:00.000Z" });
		expect(await readLaneRecord(gitCommonDir, planned.laneId)).toMatchObject({ state: "active", version: 1 });
		await appendLifecycleEvent(gitCommonDir, {
			version: 1,
			laneId: planned.laneId,
			at: planned.updatedAt,
			type: "activated",
			state: "active",
		});
		const root = path.join(gitCommonDir, "gjc", "lifecycle", "v1");
		expect(await fs.readFile(path.join(root, "events.jsonl"), "utf8")).toContain('"type":"activated"');
		expect((await fs.readdir(path.join(root, "records"))).every(entry => !entry.endsWith(".tmp"))).toBe(true);
	});
	it("fails closed when a record filename and lane ID disagree", async () => {
		const gitCommonDir = await makeGitCommonDir();
		const mismatched = record({ laneId: "other-lane" });
		const records = path.join(gitCommonDir, "gjc", "lifecycle", "v1", "records");
		await fs.mkdir(records, { recursive: true });
		await fs.writeFile(path.join(records, "dev-runtime-a1.json"), JSON.stringify(mismatched));
		await expect(readLaneRecord(gitCommonDir, "dev-runtime-a1")).rejects.toThrow("identity");
	});

	it("uses exclusive create-file locks", async () => {
		const gitCommonDir = await makeGitCommonDir();
		const lock = await acquireLifecycleLock(gitCommonDir, "dev-runtime-a1");
		await expect(acquireLifecycleLock(gitCommonDir, "dev-runtime-a1")).rejects.toThrow("already held");
		await lock.release();
		await (await acquireLifecycleLock(gitCommonDir, "dev-runtime-a1")).release();
	});
});

describe("managed ownership and cleanup eligibility", () => {
	it("requires exact registry ownership, including the Windows realm", () => {
		const managed = record();
		expect(ownershipMatches(managed, managed)).toBe(true);
		expect(ownershipMatches(managed, { ...managed, realm: "wsl" })).toBe(false);
		expect(ownershipMatches(managed, { ...managed, worktreePath: "D:\\worktrees\\repo\\same-name" })).toBe(false);
	});

	it("fails closed without every cleanup evidence field and succeeds only with explicit evidence", () => {
		const managed = record();
		expect(isCleanupEligible(managed, { ...managed, realm: "wsl" })).toBe(false);
		expect(isCleanupEligible(record({ cleanupEvidence: { mergeCommit: "abc123" } }), managed)).toBe(false);
		expect(isCleanupEligible(record({ state: "retention" }), managed)).toBe(false);
		expect(isCleanupEligible(managed, managed)).toBe(true);
	});
});
