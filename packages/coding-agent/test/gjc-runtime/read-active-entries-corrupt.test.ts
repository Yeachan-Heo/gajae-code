import { afterAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { logger } from "@gajae-code/utils";
import { activeEntryPath } from "../../src/gjc-runtime/session-layout";
import { readActiveEntries } from "../../src/gjc-runtime/state-writer";
import { readVisibleSkillActiveState } from "../../src/skill-state/active-state";

const SID = "session-corrupt-active-entry";
const tempRoots: string[] = [];

async function tempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-corrupt-active-entry-"));
	tempRoots.push(dir);
	return dir;
}

async function writeEntry(root: string, skill: string, content: string): Promise<void> {
	const filePath = activeEntryPath(root, SID, skill);
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, content);
}

afterAll(async () => {
	await Promise.all(tempRoots.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

// Regression: an interrupted / rename-crashed write on exFAT or a network volume
// can leave a per-skill active-state file (`.gjc/_session-*/state/active/<skill>.json`)
// zero-filled or truncated. `JSON.parse` of a leading NUL byte throws the JSC error
// `JSON Parse error: Unrecognized token ''`, which used to propagate out of
// readActiveEntries -> readVisibleSkillActiveState -> buildSubskillInjection and
// surface as "Failed to load skill: JSON Parse error: Unrecognized token ''",
// permanently blocking every `/skill:` invocation. The read path must fail open.
describe("readActiveEntries: corrupt per-skill entry files (issue: Failed to load skill)", () => {
	it("skips a NUL-corrupted entry, keeps valid entries, and warns once", async () => {
		const root = await tempDir();
		await writeEntry(root, "team", JSON.stringify({ skill: "team", active: true, session_id: SID }));
		await writeEntry(root, "ultragoal", "\u0000"); // exFAT zero-fill

		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		try {
			const entries = await readActiveEntries(root, { sessionId: SID });
			expect(entries.map(e => e.skill)).toEqual(["team"]);
			expect(warn).toHaveBeenCalledTimes(1);
			const message = String(warn.mock.calls[0]?.[0] ?? "");
			expect(message).toContain("skipping corrupt active-state entry");
			expect(message).toContain(activeEntryPath(root, SID, "ultragoal"));
		} finally {
			warn.mockRestore();
		}
	});

	it("does not throw for a fully zero-filled or truncated entry", async () => {
		const root = await tempDir();
		await writeEntry(root, "ralplan", "\u0000".repeat(64)); // zero-filled cluster
		await writeEntry(root, "ultragoal", '{"skill":'); // truncated mid-write

		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		try {
			await expect(readActiveEntries(root, { sessionId: SID })).resolves.toEqual([]);
			expect(warn).toHaveBeenCalledTimes(2);
		} finally {
			warn.mockRestore();
		}
	});

	it("readVisibleSkillActiveState (the /skill: load path) fails open, still surfacing valid state", async () => {
		const root = await tempDir();
		await writeEntry(
			root,
			"team",
			JSON.stringify({ skill: "team", active: true, phase: "running", session_id: SID }),
		);
		await writeEntry(root, "ultragoal", "\u0000"); // corrupt sibling entry

		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		try {
			const state = await readVisibleSkillActiveState(root, SID);
			expect(state).not.toBeNull();
			expect(state?.active_skills?.map(e => e.skill)).toContain("team");
		} finally {
			warn.mockRestore();
		}
	});
});
