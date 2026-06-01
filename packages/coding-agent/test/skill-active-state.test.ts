import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	CANONICAL_GJC_WORKFLOW_SKILLS,
	getSkillActiveStatePaths,
	listActiveSkills,
	normalizeSkillActiveState,
	readVisibleSkillActiveState,
	syncSkillActiveState,
} from "../src/skill-state/active-state";

async function withTempCwd(fn: (cwd: string) => Promise<void>): Promise<void> {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-skill-active-"));
	try {
		await fn(cwd);
	} finally {
		await fs.rm(cwd, { recursive: true, force: true });
	}
}

describe("GJC skill-active state", () => {
	it("normalizes legacy top-level active state into active skills", () => {
		const state = normalizeSkillActiveState({ active: true, skill: "deep-interview", phase: "intent-first" });
		expect(state?.active_skills).toEqual([
			expect.objectContaining({ skill: "deep-interview", phase: "intent-first", active: true }),
		]);
	});

	it("ignores inactive and blank entries while deduping by skill and session", () => {
		const active = listActiveSkills({
			active_skills: [
				{ skill: "", active: true },
				{ skill: "team", active: false },
				{ skill: "ralplan", phase: "draft", session_id: "sess-a" },
				{ skill: "ralplan", phase: "review", session_id: "sess-a" },
				{ skill: "ralplan", phase: "root" },
			],
		});
		expect(active).toEqual([
			expect.objectContaining({ skill: "ralplan", phase: "review", session_id: "sess-a" }),
			expect.objectContaining({ skill: "ralplan", phase: "root" }),
		]);
	});

	it("writes root and session copies under .gjc/state", async () => {
		await withTempCwd(async cwd => {
			await syncSkillActiveState({
				cwd,
				skill: "team",
				phase: "running",
				active: true,
				sessionId: "sess-a",
				nowIso: "2026-05-27T00:00:00.000Z",
			});

			const paths = getSkillActiveStatePaths(cwd, "sess-a");
			expect(await fs.readFile(paths.rootPath, "utf8")).toContain("team");
			expect(paths.sessionPath).toBeDefined();
			expect(await fs.readFile(paths.sessionPath ?? "", "utf8")).toContain("running");
		});
	});

	it("encodes session ids before using them as state path segments", async () => {
		await withTempCwd(async cwd => {
			const paths = getSkillActiveStatePaths(cwd, "../escape/session");
			expect(paths.sessionPath).toBe(
				path.join(cwd, ".gjc", "state", "sessions", "%2E%2E%2Fescape%2Fsession", "skill-active-state.json"),
			);
		});
	});

	it("filters root fallback entries to the current session", async () => {
		await withTempCwd(async cwd => {
			await syncSkillActiveState({ cwd, skill: "team", active: true, phase: "running", sessionId: "sess-a" });
			await syncSkillActiveState({
				cwd,
				skill: "deep-interview",
				active: true,
				phase: "intent",
				sessionId: "sess-b",
			});

			const visible = await readVisibleSkillActiveState(cwd, "sess-b");
			expect(visible?.active_skills?.map(entry => entry.skill)).toEqual(["deep-interview"]);
		});
	});

	it("clears only the matching session entry", async () => {
		await withTempCwd(async cwd => {
			await syncSkillActiveState({ cwd, skill: "team", active: true, sessionId: "sess-a" });
			await syncSkillActiveState({ cwd, skill: "team", active: true, sessionId: "sess-b" });
			await syncSkillActiveState({ cwd, skill: "team", active: false, sessionId: "sess-a" });

			const sessionA = await readVisibleSkillActiveState(cwd, "sess-a");
			const sessionB = await readVisibleSkillActiveState(cwd, "sess-b");
			expect(sessionA).toBeNull();
			expect(sessionB?.active_skills?.map(entry => entry.session_id)).toEqual(["sess-b"]);
		});
	});

	it("does not derive a stale flag for aged entries without explicit deactivation", async () => {
		await withTempCwd(async cwd => {
			await syncSkillActiveState({
				cwd,
				skill: "team",
				active: true,
				sessionId: "sess-old",
				nowIso: "2000-01-01T00:00:00.000Z",
			});

			const visible = await readVisibleSkillActiveState(cwd, "sess-old");
			const entry = visible?.active_skills?.[0];
			expect(entry?.skill).toBe("team");
			expect(entry?.stale).toBeUndefined();
		});
	});

	it("normalizes and preserves HUD summaries during root/session merge", async () => {
		await withTempCwd(async cwd => {
			await syncSkillActiveState({
				cwd,
				skill: "deep-interview",
				active: true,
				phase: "interviewing",
				sessionId: "sess-hud",
				nowIso: new Date().toISOString(),
				hud: {
					version: 1,
					summary: "round\tone",
					chips: [{ label: "ambiguity\n", value: "15%", priority: 10, severity: "success" }],
					details: Array.from({ length: 20 }, (_, index) => ({ label: `d${index}`, value: "x" })),
				},
			});

			const visible = await readVisibleSkillActiveState(cwd, "sess-hud");
			const entry = visible?.active_skills?.[0];
			expect(entry?.hud?.summary).toBe("round one");
			expect(entry?.hud?.chips?.[0]).toEqual({
				label: "ambiguity",
				value: "15%",
				priority: 10,
				severity: "success",
			});
			expect(entry?.hud?.details?.length).toBe(12);
		});
	});

	it("keeps the canonical GJC workflow skill set intentionally small", () => {
		expect(CANONICAL_GJC_WORKFLOW_SKILLS).toEqual(["deep-interview", "ralplan", "ultragoal", "team"]);
	});
});
