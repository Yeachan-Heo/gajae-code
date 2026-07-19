import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { withFileLock } from "@gajae-code/coding-agent/config/file-lock";
import { writeCurrentSessionGoalModeState } from "@gajae-code/coding-agent/gjc-runtime/goal-mode-request";
import {
	resolveSessionIdFromSources,
	SessionResolutionError,
} from "@gajae-code/coding-agent/gjc-runtime/session-resolution";
import { validateCliReplay } from "@gajae-code/coding-agent/gjc-runtime/ultragoal-evidence";
import type { Goal } from "@gajae-code/coding-agent/goals/state";

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "harness-final-qa-"));
	tempDirs.push(dir);
	return dir;
}

async function writeActiveGoal(sessionFile: string, goal: Record<string, unknown>): Promise<void> {
	const timestamp = new Date().toISOString();
	await Bun.write(
		sessionFile,
		`${JSON.stringify({ type: "session", version: 3, id: "session", timestamp, cwd: path.dirname(sessionFile) })}\n${JSON.stringify({ type: "mode_change", id: "goal", parentId: null, timestamp, mode: "goal", data: { goal } })}\n`,
	);
}

describe("harness final QA regressions", () => {
	test("rejects path-component session IDs from every explicit boundary source", () => {
		for (const sources of [
			{ flagValue: "../../escape" },
			{ payloadSessionId: "a/b" },
			{ envSessionId: "a\\b" },
			{ flagValue: "." },
			{ flagValue: ".." },
		]) {
			expect(() => resolveSessionIdFromSources(sources)).toThrow(SessionResolutionError);
		}
	});

	test("serializes independent same-process lock callers", async () => {
		const dir = await tempDir();
		const lockedFile = path.join(dir, "state.json");
		const events: string[] = [];
		let releaseFirst: (() => void) | undefined;
		const first = withFileLock(lockedFile, async () => {
			events.push("first");
			await new Promise<void>(resolve => (releaseFirst = resolve));
		});
		while (!releaseFirst) await Bun.sleep(1);
		const second = withFileLock(lockedFile, async () => events.push("second"));
		releaseFirst();
		await Promise.all([first, second]);
		expect(events).toEqual(["first", "second"]);
	});

	test("rejects replay invariant bypasses that lack four characters of stdout evidence", async () => {
		const cases: Array<{ type: "substring" | "regex"; value: string; message?: string }> = [
			{ type: "regex", value: ".*" },
			{ type: "regex", value: "(?=x)" },
			{ type: "substring", value: "x" },
			{ type: "substring", value: " \t ", message: "must be a non-empty string" },
			{ type: "regex", value: "[\\s\\S]*" },
			{ type: "regex", value: "[^]*" },
			{ type: "regex", value: "^" },
			{ type: "regex", value: "(?:)" },
		];
		for (const invariant of cases) {
			await expect(
				validateCliReplay(
					process.cwd(),
					{
						kind: "cli-replay",
						schemaVersion: 1,
						replaySafe: true,
						command: ["bun", "-e", 'console.log("x reliable replay evidence")'],
						recordedStdout: "recorded\n",
						invariants: [invariant],
					},
					"replay",
					{ live: false },
				),
			).rejects.toThrow(invariant.message ?? "must be a meaningful positive invariant that matches stdout");
		}
	});

	test("matches durable provenance, uses exact trimmed legacy identity, and preserves unproven active goals", async () => {
		const dir = await tempDir();
		const sessionFile = path.join(dir, "session.jsonl");
		const existingGoal = {
			id: "goal-1",
			objective: "Original wording",
			status: "active",
			tokensUsed: 0,
			timeUsedSeconds: 0,
			createdAt: 1,
			updatedAt: 1,
			provenance: { source: "ultragoal" as const, runId: "run-1", goalId: "aggregate" },
		} satisfies Goal;
		await writeActiveGoal(sessionFile, existingGoal);
		expect(
			await writeCurrentSessionGoalModeState({
				sessionFile,
				objective: "Reworded objective",
				provenance: existingGoal.provenance,
			}),
		).toEqual({ status: "existing_goal", goal: existingGoal });
		expect(
			await writeCurrentSessionGoalModeState({
				sessionFile,
				objective: "New plan objective",
				provenance: { source: "ultragoal", runId: "run-2", goalId: "aggregate" },
			}),
		).toMatchObject({ status: "updated", goal: { objective: "New plan objective" } });

		const legacySessionFile = path.join(dir, "legacy-session.jsonl");
		const legacyGoal = { ...existingGoal, objective: "  Original wording  ", provenance: undefined };
		await writeActiveGoal(legacySessionFile, legacyGoal);
		expect(
			await writeCurrentSessionGoalModeState({
				sessionFile: legacySessionFile,
				objective: "Original wording",
				provenance: existingGoal.provenance,
			}),
		).toEqual({ status: "existing_goal", goal: legacyGoal });
		expect(
			await writeCurrentSessionGoalModeState({
				sessionFile: legacySessionFile,
				objective: "Legacy rewording",
				provenance: existingGoal.provenance,
			}),
		).toEqual({ status: "existing_goal", goal: legacyGoal });

		const userSessionFile = path.join(dir, "user-session.jsonl");
		const userGoal = { ...existingGoal, provenance: { source: "user" as const } };
		await writeActiveGoal(userSessionFile, userGoal);
		expect(
			await writeCurrentSessionGoalModeState({
				sessionFile: userSessionFile,
				objective: "A different ultragoal objective",
				provenance: { source: "ultragoal", runId: "run-2", goalId: "aggregate" },
			}),
		).toEqual({ status: "existing_goal", goal: userGoal });
	});
});
