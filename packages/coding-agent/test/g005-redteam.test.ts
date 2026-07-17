import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentTool } from "@gajae-code/agent-core";
import { activeEntryPath, activeStateDir, modeStatePath } from "../src/gjc-runtime/session-layout";
import { writeActiveEntry } from "../src/gjc-runtime/state-writer";
import {
	invalidateVisibleSkillActiveStateCache,
	readVisibleSkillActiveState,
	type SkillActiveEntry,
} from "../src/skill-state/active-state";
import { getDeepInterviewMutationDecision } from "../src/skill-state/deep-interview-mutation-guard";

async function withTempCwd(fn: (cwd: string) => Promise<void>): Promise<void> {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-g005-redteam-"));
	try {
		await fn(cwd);
	} finally {
		invalidateVisibleSkillActiveStateCache(cwd);
		await fs.rm(cwd, { recursive: true, force: true });
	}
}

async function writeExternalActiveEntry(cwd: string, sessionId: string, entry: SkillActiveEntry): Promise<string> {
	const dir = activeStateDir(cwd, sessionId);
	await fs.mkdir(dir, { recursive: true });
	const filePath = activeEntryPath(cwd, sessionId, entry.skill);
	await fs.writeFile(filePath, `${JSON.stringify(entry, null, 2)}\n`, "utf8");
	return filePath;
}

async function writeExternalModeState(
	cwd: string,
	sessionId: string,
	skill: string,
	currentPhase: string,
): Promise<string> {
	const filePath = modeStatePath(cwd, sessionId, skill);
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(
		filePath,
		`${JSON.stringify({ active: true, current_phase: currentPhase, session_id: sessionId }, null, 2)}\n`,
		"utf8",
	);
	return filePath;
}
function tool(name: string): AgentTool {
	return {
		name,
		label: name,
		description: name,
		parameters: {} as never,
		execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
	};
}

function activeSkillNames(state: Awaited<ReturnType<typeof readVisibleSkillActiveState>>): string[] {
	return state?.active_skills?.map(entry => entry.skill) ?? [];
}

describe("G005 red-team skill-state cache freshness", () => {
	it("security tier reflects an externally added active-entry file without explicit invalidation", async () => {
		await withTempCwd(async cwd => {
			const sessionId = "sess-add";
			expect(await readVisibleSkillActiveState(cwd, sessionId, { tier: "security" })).toBeNull();

			await writeExternalActiveEntry(cwd, sessionId, {
				skill: "team",
				phase: "running",
				active: true,
				session_id: sessionId,
				updated_at: "2026-07-06T00:00:00.000Z",
			});

			const visible = await readVisibleSkillActiveState(cwd, sessionId, { tier: "security" });
			expect(activeSkillNames(visible)).toEqual(["team"]);
			expect(visible?.active_skills?.[0]?.phase).toBe("running");
		});
	});

	it("security tier reflects an externally removed active-entry file without explicit invalidation", async () => {
		await withTempCwd(async cwd => {
			const sessionId = "sess-remove";
			const filePath = await writeExternalActiveEntry(cwd, sessionId, {
				skill: "team",
				phase: "running",
				active: true,
				session_id: sessionId,
				updated_at: "2026-07-06T00:00:00.000Z",
			});
			expect(activeSkillNames(await readVisibleSkillActiveState(cwd, sessionId, { tier: "security" }))).toEqual([
				"team",
			]);

			await fs.rm(filePath);

			expect(await readVisibleSkillActiveState(cwd, sessionId, { tier: "security" })).toBeNull();
		});
	});

	it("security tier detects ralplan mode-state phase changes", async () => {
		await withTempCwd(async cwd => {
			const sessionId = "sess-ralplan-phase";
			await writeExternalActiveEntry(cwd, sessionId, {
				skill: "ralplan",
				phase: "entry-phase",
				active: true,
				session_id: sessionId,
				updated_at: "2026-07-06T00:00:00.000Z",
			});
			await writeExternalModeState(cwd, sessionId, "ralplan", "handoff");
			expect(
				(await readVisibleSkillActiveState(cwd, sessionId, { tier: "security" }))?.active_skills?.[0]?.phase,
			).toBe("handoff");

			await writeExternalModeState(cwd, sessionId, "ralplan", "complete");

			expect(
				(await readVisibleSkillActiveState(cwd, sessionId, { tier: "security" }))?.active_skills?.[0]?.phase,
			).toBe("complete");
		});
	});

	it("HUD tier serves stale state inside 500ms, then refreshes after TTL", async () => {
		await withTempCwd(async cwd => {
			const sessionId = "sess-hud-stale";
			await writeExternalActiveEntry(cwd, sessionId, {
				skill: "team",
				phase: "first",
				active: true,
				session_id: sessionId,
				updated_at: "2026-07-06T00:00:00.000Z",
			});
			expect((await readVisibleSkillActiveState(cwd, sessionId, { tier: "hud" }))?.active_skills?.[0]?.phase).toBe(
				"first",
			);

			await writeExternalActiveEntry(cwd, sessionId, {
				skill: "team",
				phase: "second-after-external-change",
				active: true,
				session_id: sessionId,
				updated_at: "2026-07-06T00:00:01.000Z",
			});

			expect((await readVisibleSkillActiveState(cwd, sessionId, { tier: "hud" }))?.active_skills?.[0]?.phase).toBe(
				"first",
			);
			await Bun.sleep(550);
			expect((await readVisibleSkillActiveState(cwd, sessionId, { tier: "hud" }))?.active_skills?.[0]?.phase).toBe(
				"second-after-external-change",
			);
		});
	});

	it("local writeActiveEntry invalidates cache so the next security read is immediate", async () => {
		await withTempCwd(async cwd => {
			const sessionId = "sess-local-write";
			expect(await readVisibleSkillActiveState(cwd, sessionId, { tier: "security" })).toBeNull();

			await writeActiveEntry(cwd, sessionId, "team", {
				skill: "team",
				phase: "local-write-visible",
				active: true,
				session_id: sessionId,
				updated_at: "2026-07-06T00:00:00.000Z",
			});

			expect(
				(await readVisibleSkillActiveState(cwd, sessionId, { tier: "security" }))?.active_skills?.[0]?.phase,
			).toBe("local-write-visible");
		});
	});

	it("mutation guard sees fresh external deep-interview activation and blocks product writes", async () => {
		await withTempCwd(async cwd => {
			const sessionId = "sess-guard";
			expect(await readVisibleSkillActiveState(cwd, sessionId, { tier: "security" })).toBeNull();

			await writeExternalActiveEntry(cwd, sessionId, {
				skill: "deep-interview",
				phase: "questions",
				active: true,
				session_id: sessionId,
				updated_at: "2026-07-06T00:00:00.000Z",
			});
			await writeExternalModeState(cwd, sessionId, "deep-interview", "questions");

			const decision = await getDeepInterviewMutationDecision({
				cwd,
				sessionId,
				tool: tool("write"),
				args: { path: "src/product.ts", content: "mutate" },
			});

			expect(decision.blocked).toBe(true);
			expect(decision.reason).toBe("phase-boundary");
		});
	});
});
