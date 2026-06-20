import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { activeSnapshotPath, auditPath, sessionStateDir } from "@gajae-code/coding-agent/gjc-runtime/session-layout";
import {
	AlreadyExistsError,
	appendJsonl,
	createJsonNoClobber,
	rebuildActiveSnapshot,
	writeActiveEntry,
} from "@gajae-code/coding-agent/gjc-runtime/state-writer";
import type { SkillActiveState } from "@gajae-code/coding-agent/skill-state/active-state";

const TEST_SESSION_ID = "test-session";

const tempRoots: string[] = [];
const WORKER_COUNT = 8;

async function tempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(process.cwd(), ".tmp-state-concurrency-fuzz-"));
	tempRoots.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempRoots.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

let priorSessionId: string | undefined;
beforeAll(() => {
	priorSessionId = process.env.GJC_SESSION_ID;
	process.env.GJC_SESSION_ID = TEST_SESSION_ID;
});
afterAll(() => {
	if (priorSessionId !== undefined) process.env.GJC_SESSION_ID = priorSessionId;
	else delete process.env.GJC_SESSION_ID;
});

async function readJson<T>(filePath: string): Promise<T> {
	return JSON.parse(await fs.readFile(filePath, "utf-8")) as T;
}

describe("gjc state no-lock concurrency fuzz", () => {
	it("preserves all per-skill active entries when concurrent writers rebuild the derived snapshot", async () => {
		const root = await tempDir();
		const nowIso = new Date("2026-06-03T00:00:00.000Z").toISOString();
		const skills = Array.from({ length: WORKER_COUNT }, (_, index) => `fuzz-skill-${index}`);

		await Promise.all(
			skills.map(async (skill, index) => {
				await writeActiveEntry(
					root,
					{ sessionId: TEST_SESSION_ID },
					skill,
					{
						skill,
						active: true,
						phase: `phase-${index}`,
						updated_at: nowIso,
						session_id: `session-${index}`,
					},
					{ cwd: root },
				);
				await rebuildActiveSnapshot(root, { sessionId: TEST_SESSION_ID }, { cwd: root });
			}),
		);

		await rebuildActiveSnapshot(root, { sessionId: TEST_SESSION_ID }, { cwd: root });
		const snapshot = await readJson<SkillActiveState>(activeSnapshotPath(root, TEST_SESSION_ID));
		const activeSkills = snapshot.active_skills ?? [];
		const bySkill = new Map(activeSkills.map(entry => [entry.skill, entry]));

		expect(activeSkills).toHaveLength(WORKER_COUNT);
		for (const [index, skill] of skills.entries()) {
			expect(bySkill.get(skill)).toMatchObject({
				skill,
				active: true,
				phase: `phase-${index}`,
				session_id: `session-${index}`,
			});
		}
	});

	it("allows exactly one O_EXCL claim winner when workers race the same team claim file", async () => {
		const root = await tempDir();
		const claimPath = path.relative(
			root,
			path.join(sessionStateDir(root, TEST_SESSION_ID), "team", "claims", "shared-task.json"),
		);
		const attempts = await Promise.all(
			Array.from({ length: WORKER_COUNT }, async (_, index) => {
				try {
					await createJsonNoClobber(
						claimPath,
						{
							task_id: "shared-task",
							worker_id: `worker-${index}`,
							claimed_at: `2026-06-03T00:00:0${index}.000Z`,
						},
						{ cwd: root },
					);
					return { ok: true as const, worker: `worker-${index}` };
				} catch (error) {
					if (error instanceof AlreadyExistsError) return { ok: false as const, alreadyExists: true };
					throw error;
				}
			}),
		);

		const winners = attempts.filter(result => result.ok);
		const losers = attempts.filter(result => !result.ok && result.alreadyExists);
		expect(winners).toHaveLength(1);
		expect(losers).toHaveLength(WORKER_COUNT - 1);

		const claim = await readJson<Record<string, unknown>>(path.join(root, claimPath));
		expect(claim.worker_id).toBe(winners[0]?.worker);
	});

	it("keeps concurrent audit JSONL appends complete and parseable", async () => {
		const root = await tempDir();
		const auditLogPath = path.relative(root, auditPath(root, TEST_SESSION_ID));
		const ids = Array.from({ length: WORKER_COUNT }, (_, index) => `audit-${index}`);

		await Promise.all(
			ids.map((id, index) =>
				appendJsonl(
					auditLogPath,
					{ id, event: "concurrency-fuzz", worker_id: `worker-${index}`, at: `2026-06-03T00:00:0${index}.000Z` },
					{ cwd: root },
				),
			),
		);

		const raw = await fs.readFile(path.join(root, auditLogPath), "utf-8");
		const lines = raw.trimEnd().split("\n");
		const parsed = lines.map(line => JSON.parse(line) as Record<string, unknown>);
		const seenIds = new Set(parsed.map(entry => entry.id));

		expect(lines).toHaveLength(WORKER_COUNT);
		for (const id of ids) expect(seenIds.has(id)).toBe(true);
		for (const entry of parsed) expect(entry.event).toBe("concurrency-fuzz");
	});
});
