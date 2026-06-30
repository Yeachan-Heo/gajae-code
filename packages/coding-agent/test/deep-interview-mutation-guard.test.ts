import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentTool } from "@gajae-code/agent-core";
import {
	activeSnapshotPath,
	modeStatePath,
	sessionStateDir,
} from "@gajae-code/coding-agent/gjc-runtime/session-layout";
import { runNativeStateCommand } from "@gajae-code/coding-agent/gjc-runtime/state-runtime";
import {
	assertDeepInterviewMutationRawPathsAllowed,
	DEEP_INTERVIEW_MUTATION_BLOCK_MESSAGE,
	getDeepInterviewMutationDecision,
	RALPLAN_MUTATION_BLOCK_MESSAGE,
	ULTRAGOAL_GOAL_PLANNING_MUTATION_BLOCK_MESSAGE,
} from "@gajae-code/coding-agent/skill-state/deep-interview-mutation-guard";
import { ToolError } from "@gajae-code/coding-agent/tools/tool-errors";
import { logger } from "@gajae-code/utils";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-deep-interview-guard-"));
	tempRoots.push(root);
	return root;
}

async function writeActiveDeepInterview(cwd: string, sessionId = "session-a", phase = "interviewing"): Promise<void> {
	const now = new Date().toISOString();
	const sessionDir = sessionStateDir(cwd, sessionId);
	await fs.mkdir(sessionDir, { recursive: true });
	const activeState = {
		version: 1,
		active: true,
		skill: "deep-interview",
		phase,
		updated_at: now,
		active_skills: [
			{
				skill: "deep-interview",
				phase,
				active: true,
				updated_at: now,
				session_id: sessionId,
			},
		],
	};
	await Bun.write(activeSnapshotPath(cwd, sessionId), `${JSON.stringify(activeState, null, 2)}\n`);
	await Bun.write(
		modeStatePath(cwd, sessionId, "deep-interview"),
		`${JSON.stringify({ active: true, current_phase: phase, session_id: sessionId }, null, 2)}\n`,
	);
}

async function writeActiveSkill(
	cwd: string,
	skill: "deep-interview" | "ralplan" | "ultragoal" | "team",
	phase: string,
	sessionId = "session-a",
): Promise<void> {
	const now = new Date().toISOString();
	const sessionDir = sessionStateDir(cwd, sessionId);
	await fs.mkdir(sessionDir, { recursive: true });
	const activeState = {
		version: 1,
		active: true,
		skill,
		phase,
		updated_at: now,
		active_skills: [{ skill, phase, active: true, updated_at: now, session_id: sessionId }],
	};
	await Bun.write(activeSnapshotPath(cwd, sessionId), `${JSON.stringify(activeState, null, 2)}\n`);
	await Bun.write(
		modeStatePath(cwd, sessionId, skill),
		`${JSON.stringify({ active: true, current_phase: phase, session_id: sessionId }, null, 2)}\n`,
	);
}

function tool(name: string, extra: Record<string, unknown> = {}): AgentTool {
	return {
		name,
		label: name,
		description: name,
		parameters: {} as never,
		execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
		...extra,
	} as AgentTool;
}

function parseStateCommandJson(stdout: string | undefined): Record<string, unknown> {
	if (!stdout) throw new Error("missing state command stdout");
	return JSON.parse(stdout) as Record<string, unknown>;
}

afterEach(async () => {
	await Promise.all(tempRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe("deep-interview mutation guard", () => {
	it("blocks product write/edit/ast_edit targets while deep-interview is active", async () => {
		const cwd = await makeTempRoot();
		await writeActiveDeepInterview(cwd);

		for (const [name, args, extra = {}] of [
			["write", { path: "packages/coding-agent/src/foo.ts", content: "x" }],
			["edit", { path: "src/foo.ts", edits: [{ old_text: "a", new_text: "b" }] }],
			[
				"edit",
				{ input: "*** Begin Patch\n*** Update File: src/foo.ts\n@@\n-a\n+b\n*** End Patch\n" },
				{ mode: "apply_patch", customWireName: "apply_patch" },
			],
			["ast_edit", { paths: ["packages/**"], ops: [{ pat: "foo", out: "bar" }] }],
		] as const) {
			const decision = await getDeepInterviewMutationDecision({
				cwd,
				sessionId: "session-a",
				tool: tool(name, extra),
				args,
			});
			expect(decision.blocked).toBe(true);
			expect(decision.reason).toBe("phase-boundary");
			expect(decision.message).toBe(DEEP_INTERVIEW_MUTATION_BLOCK_MESSAGE);
			expect(decision.message).toContain("handoff/spec before code edits");
		}
	});

	it("blocks direct planning artifact tools and canonical workflow state targets", async () => {
		const cwd = await makeTempRoot();
		await writeActiveDeepInterview(cwd);

		for (const rawPath of [".gjc/specs/deep-interview-x.md", ".gjc/plans/plan.md"]) {
			const decision = await getDeepInterviewMutationDecision({
				cwd,
				sessionId: "session-a",
				tool: tool("write"),
				args: { path: rawPath, content: "x" },
			});
			expect(decision.blocked).toBe(true);
			expect(decision.reason).toBe("gjc-target");
			expect(decision.message).toContain("runtime-owned");
		}

		const blockedCases: Array<[string, AgentTool, unknown]> = [
			["write active", tool("write"), { path: ".gjc/state/skill-active-state.json", content: "{}" }],
			[
				"write session active legacy",
				tool("write"),
				{ path: ".gjc/state/sessions/session-a/skill-active-state.json", content: "{}" },
			],
			[
				"write session active generated",
				tool("write"),
				{ path: ".gjc/_session-session-a/state/skill-active-state.json", content: "{}" },
			],
			...(["deep-interview", "ralplan", "ultragoal", "team"] as const).map(
				skill =>
					[
						`write ${skill}`,
						tool("write"),
						{ path: `.gjc/state/sessions/session-a/${skill}-state.json`, content: "{}" },
					] as [string, AgentTool, unknown],
			),
			...(["deep-interview", "ralplan", "ultragoal", "team"] as const).map(
				skill =>
					[
						`write generated ${skill}`,
						tool("write"),
						{ path: `.gjc/_session-session-a/state/${skill}-state.json`, content: "{}" },
					] as [string, AgentTool, unknown],
			),
			[
				"apply_patch state",
				tool("edit", { mode: "apply_patch", customWireName: "apply_patch" }),
				{
					input: "*** Begin Patch\n*** Update File: .gjc/state/team-state.json\n@@\n-a\n+b\n*** End Patch\n",
				},
			],
			[
				"vim state",
				tool("edit", { mode: "vim" }),
				{ file: "src/foo.ts", steps: [{ kbd: [":edit .gjc/state/sessions/session-a/ralplan-state.json<CR>"] }] },
			],
			[
				"ast_edit state",
				tool("ast_edit"),
				{ paths: [".gjc/state/**/team-state.json"], ops: [{ pat: "foo", out: "bar" }] },
			],
		];

		for (const [, targetTool, args] of blockedCases) {
			const decision = await getDeepInterviewMutationDecision({
				cwd,
				sessionId: "session-a",
				tool: targetTool,
				args,
			});
			expect(decision.blocked).toBe(true);
			if (decision.reason === "workflow-state-target" || decision.reason === "gjc-target") {
				expect(decision.message).toContain("runtime-owned");
			} else {
				expect(decision.message).toBe(DEEP_INTERVIEW_MUTATION_BLOCK_MESSAGE);
			}
		}
	});

	it("allows neutral temp scratch but blocks in-project / non-temp writes during active deep-interview", async () => {
		const cwd = await makeTempRoot();
		await writeActiveDeepInterview(cwd);

		// Neutral temp scratch outside the project tree stays writable so specs can be
		// staged and fed to `gjc deep-interview --write --spec <path>`.
		for (const rawPath of [path.join(os.tmpdir(), "deep-interview-scratch.md"), "/tmp/deep-interview-scratch.md"]) {
			const decision = await getDeepInterviewMutationDecision({
				cwd,
				sessionId: "session-a",
				tool: tool("write"),
				args: { path: rawPath, content: "x" },
			});
			expect(decision.blocked).toBe(false);
		}

		// In-project and unresolvable targets remain blocked at the phase boundary.
		for (const rawPath of ["agent://123", "product/archive.zip:product.ts", "data.sqlite:rows:1", "src/product.ts"]) {
			const decision = await getDeepInterviewMutationDecision({
				cwd,
				sessionId: "session-a",
				tool: tool("write"),
				args: { path: rawPath, content: "x" },
			});
			expect(decision.blocked).toBe(true);
			expect(decision.message).toBe(DEEP_INTERVIEW_MUTATION_BLOCK_MESSAGE);
		}

		for (const rawPath of [".gjc/specs-evil/plan.md", ".gjc/stateful/data.json"]) {
			const decision = await getDeepInterviewMutationDecision({
				cwd,
				sessionId: "session-a",
				tool: tool("write"),
				args: { path: rawPath, content: "x" },
			});
			expect(decision.blocked).toBe(true);
			expect(decision.message).toContain("runtime-owned");
		}

		const mixed = await getDeepInterviewMutationDecision({
			cwd,
			sessionId: "session-a",
			tool: tool("ast_edit"),
			args: { paths: [".gjc/state/deep-interview-state.json", "packages/**"], ops: [{ pat: "foo", out: "bar" }] },
		});
		expect(mixed.blocked).toBe(true);
	});

	it("allows read-only bash during active deep-interview when no mutation target is extracted", async () => {
		const cwd = await makeTempRoot();
		await writeActiveDeepInterview(cwd);

		for (const command of [
			"git status --short",
			"rg deep-interview packages/coding-agent/src",
			"cat packages/coding-agent/package.json",
			"sed -n '1,80p' packages/coding-agent/src/skill-state/deep-interview-mutation-guard.ts",
			"bun test packages/coding-agent/test/deep-interview-mutation-guard.test.ts",
		]) {
			const decision = await getDeepInterviewMutationDecision({
				cwd,
				sessionId: "session-a",
				tool: tool("bash"),
				args: { command },
			});
			expect(decision.blocked).toBe(false);
			expect(decision.targets).toEqual([]);
		}
	});

	it("never blocks bash during active deep-interview, even targeting .gjc or product code", async () => {
		const cwd = await makeTempRoot();
		await writeActiveDeepInterview(cwd);

		for (const command of [
			"rm .gjc/state/deep-interview-state.json",
			"mkdir -p .gjc/specs",
			"cp source.md .gjc/specs/deep-interview-x.md",
			"sed -i 's/a/b/' .gjc/plans/plan.md",
			"cat source.md > .gjc/specs/deep-interview-x.md",
			"tee src/product.ts",
			"cat <<EOF > src/product.ts\nx\nEOF",
		]) {
			const decision = await getDeepInterviewMutationDecision({
				cwd,
				sessionId: "session-a",
				tool: tool("bash"),
				args: { command },
			});
			expect(decision.blocked).toBe(false);
			expect(decision.targets).toEqual([]);
		}
	});

	it("blocks vim file-switches into .gjc", async () => {
		const cwd = await makeTempRoot();
		await writeActiveDeepInterview(cwd);

		const decision = await getDeepInterviewMutationDecision({
			cwd,
			sessionId: "session-a",
			tool: tool("edit", { mode: "vim" }),
			args: {
				file: "packages/coding-agent/src/product.ts",
				steps: [{ kbd: [":edit .gjc/specs/deep-interview-x.md<CR>", "iunsafe"] }],
			},
		});

		expect(decision.blocked).toBe(true);
		expect(decision.message).toContain("runtime-owned");
	});

	it("does not block after deep-interview reaches a terminal phase", async () => {
		const cwd = await makeTempRoot();
		await writeActiveDeepInterview(cwd, "session-a", "complete");

		const decision = await getDeepInterviewMutationDecision({
			cwd,
			sessionId: "session-a",
			tool: tool("write"),
			args: { path: "src/product.ts", content: "x" },
		});
		expect(decision.blocked).toBe(false);
	});

	it("allows direct work after the deep-interview suitability gate clears seeded state", async () => {
		const cwd = await makeTempRoot();
		const sessionId = "session-a";
		await writeActiveDeepInterview(cwd, sessionId);

		const beforeClear = await getDeepInterviewMutationDecision({
			cwd,
			sessionId,
			tool: tool("write"),
			args: { path: "src/product.ts", content: "x" },
		});
		expect(beforeClear.blocked).toBe(true);

		const clear = await runNativeStateCommand(
			["clear", "--mode", "deep-interview", "--session-id", sessionId, "--force", "--json"],
			cwd,
		);
		expect(clear.status).toBe(0);
		expect(parseStateCommandJson(clear.stdout)).toMatchObject({
			ok: true,
			skill: "deep-interview",
			active: false,
			current_phase: "complete",
		});

		const afterClear = await getDeepInterviewMutationDecision({
			cwd,
			sessionId,
			tool: tool("write"),
			args: { path: "src/product.ts", content: "x" },
		});
		expect(afterClear.blocked).toBe(false);
	});

	it("allows writes and logs when deep-interview mode state is invalid", async () => {
		const cwd = await makeTempRoot();
		await writeActiveDeepInterview(cwd);
		await Bun.write(
			modeStatePath(cwd, "session-a", "deep-interview"),
			JSON.stringify({ active: "yes", current_phase: "interviewing", session_id: "session-a" }),
		);
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		try {
			const decision = await getDeepInterviewMutationDecision({
				cwd,
				sessionId: "session-a",
				tool: tool("write"),
				args: { path: "src/product.ts", content: "x" },
			});
			expect(decision.blocked).toBe(false);
			expect(warn).toHaveBeenCalledTimes(1);
			expect(String(warn.mock.calls[0]?.[0] ?? "")).toContain("gjc skill-state: invalid mode-state at");
		} finally {
			warn.mockRestore();
		}
	});

	it("allows writes and logs when deep-interview mode state is corrupt JSON", async () => {
		const cwd = await makeTempRoot();
		await writeActiveDeepInterview(cwd);
		await Bun.write(modeStatePath(cwd, "session-a", "deep-interview"), "{");
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		try {
			const decision = await getDeepInterviewMutationDecision({
				cwd,
				sessionId: "session-a",
				tool: tool("write"),
				args: { path: "src/product.ts", content: "x" },
			});
			expect(decision.blocked).toBe(false);
			expect(warn).toHaveBeenCalledTimes(1);
			expect(String(warn.mock.calls[0]?.[0] ?? "")).toContain("invalid JSON");
		} finally {
			warn.mockRestore();
		}
	});

	it("guards deferred ast_edit apply targets unless force override is explicit", async () => {
		const cwd = await makeTempRoot();
		await writeActiveDeepInterview(cwd);

		for (const rawPaths of [["src/product.ts"], [".gjc/specs/deep-interview-x.md"], []]) {
			await expect(
				assertDeepInterviewMutationRawPathsAllowed({
					cwd,
					sessionId: "session-a",
					rawPaths,
				}),
			).rejects.toBeInstanceOf(ToolError);
		}
		await expect(
			assertDeepInterviewMutationRawPathsAllowed({
				cwd,
				sessionId: "session-a",
				rawPaths: ["src/product.ts"],
				forceOverride: true,
			}),
		).resolves.toBeUndefined();
	});

	it("blocks product mutation during active ralplan and allows neutral temp scratch", async () => {
		const cwd = await makeTempRoot();
		await writeActiveSkill(cwd, "ralplan", "planner");

		const blocked = await getDeepInterviewMutationDecision({
			cwd,
			sessionId: "session-a",
			tool: tool("write"),
			args: { path: "src/product.ts", content: "x" },
		});
		expect(blocked.blocked).toBe(true);
		expect(blocked.reason).toBe("phase-boundary");
		expect(blocked.message).toBe(RALPLAN_MUTATION_BLOCK_MESSAGE);

		const temp = await getDeepInterviewMutationDecision({
			cwd,
			sessionId: "session-a",
			tool: tool("write"),
			args: { path: "/tmp/ralplan-scratch.md", content: "x" },
		});
		expect(temp.blocked).toBe(false);

		const gjcBash = await getDeepInterviewMutationDecision({
			cwd,
			sessionId: "session-a",
			tool: tool("bash"),
			args: { command: "gjc ralplan --write --stage planner --stage_n 1 --artifact /tmp/plan.md" },
		});
		expect(gjcBash.blocked).toBe(false);
	});

	it("blocks product mutation only during the ultragoal goal-planning phase", async () => {
		const cwd = await makeTempRoot();
		await writeActiveSkill(cwd, "ultragoal", "goal-planning");

		const planning = await getDeepInterviewMutationDecision({
			cwd,
			sessionId: "session-a",
			tool: tool("write"),
			args: { path: "src/product.ts", content: "x" },
		});
		expect(planning.blocked).toBe(true);
		expect(planning.reason).toBe("phase-boundary");
		expect(planning.message).toBe(ULTRAGOAL_GOAL_PLANNING_MUTATION_BLOCK_MESSAGE);

		await writeActiveSkill(cwd, "ultragoal", "active");
		const executing = await getDeepInterviewMutationDecision({
			cwd,
			sessionId: "session-a",
			tool: tool("write"),
			args: { path: "src/product.ts", content: "x" },
		});
		expect(executing.blocked).toBe(false);
	});

	it("does not block product mutation while team is active", async () => {
		const cwd = await makeTempRoot();
		await writeActiveSkill(cwd, "team", "running");

		const decision = await getDeepInterviewMutationDecision({
			cwd,
			sessionId: "session-a",
			tool: tool("write"),
			args: { path: "src/product.ts", content: "x" },
		});
		expect(decision.blocked).toBe(false);
	});

	it("keeps blocking ralplan at the pre-approval terminal phases (final, handoff)", async () => {
		const cwd = await makeTempRoot();
		for (const phase of ["final", "handoff"]) {
			await writeActiveSkill(cwd, "ralplan", phase);
			const decision = await getDeepInterviewMutationDecision({
				cwd,
				sessionId: "session-a",
				tool: tool("write"),
				args: { path: "src/product.ts", content: "x" },
			});
			expect(decision.blocked).toBe(true);
			expect(decision.message).toBe(RALPLAN_MUTATION_BLOCK_MESSAGE);
		}
	});

	it("keeps blocking deep-interview through its handoff phase but releases on complete", async () => {
		const cwd = await makeTempRoot();
		await writeActiveSkill(cwd, "deep-interview", "handoff");
		const handoff = await getDeepInterviewMutationDecision({
			cwd,
			sessionId: "session-a",
			tool: tool("write"),
			args: { path: "src/product.ts", content: "x" },
		});
		expect(handoff.blocked).toBe(true);

		await writeActiveSkill(cwd, "deep-interview", "complete");
		const complete = await getDeepInterviewMutationDecision({
			cwd,
			sessionId: "session-a",
			tool: tool("write"),
			args: { path: "src/product.ts", content: "x" },
		});
		expect(complete.blocked).toBe(false);
	});

	it("re-blocks when a planning skill is re-activated after an executor goal completes (skill return)", async () => {
		const cwd = await makeTempRoot();
		// ultragoal finished executing -> not blocked.
		await writeActiveSkill(cwd, "ultragoal", "complete");
		const afterComplete = await getDeepInterviewMutationDecision({
			cwd,
			sessionId: "session-a",
			tool: tool("write"),
			args: { path: "src/product.ts", content: "x" },
		});
		expect(afterComplete.blocked).toBe(false);

		// Returning to ralplan re-activates the planning posture.
		await writeActiveSkill(cwd, "ralplan", "planner");
		const afterReturn = await getDeepInterviewMutationDecision({
			cwd,
			sessionId: "session-a",
			tool: tool("write"),
			args: { path: "src/product.ts", content: "x" },
		});
		expect(afterReturn.blocked).toBe(true);
		expect(afterReturn.message).toBe(RALPLAN_MUTATION_BLOCK_MESSAGE);
	});

	it("follows the current skill after a handoff demotes the prior planning skill", async () => {
		const cwd = await makeTempRoot();
		const sessionId = "session-a";
		const now = new Date().toISOString();
		const sessionDir = sessionStateDir(cwd, sessionId);
		await fs.mkdir(sessionDir, { recursive: true });
		// A real handoff demotes the prior planning skill to active:false and promotes the
		// executor. The demoted deep-interview entry must not keep blocking the executor.
		await Bun.write(
			activeSnapshotPath(cwd, sessionId),
			`${JSON.stringify(
				{
					version: 1,
					active: true,
					skill: "ultragoal",
					phase: "active",
					updated_at: now,
					active_skills: [
						{ skill: "ultragoal", phase: "active", active: true, updated_at: now, session_id: sessionId },
						{
							skill: "deep-interview",
							phase: "handoff",
							active: false,
							updated_at: now,
							session_id: sessionId,
							handoff_to: "ultragoal",
						},
					],
				},
				null,
				2,
			)}\n`,
		);
		await Bun.write(
			modeStatePath(cwd, sessionId, "ultragoal"),
			`${JSON.stringify({ active: true, current_phase: "active", session_id: sessionId }, null, 2)}\n`,
		);
		await Bun.write(
			modeStatePath(cwd, sessionId, "deep-interview"),
			`${JSON.stringify({ active: false, current_phase: "handoff", session_id: sessionId }, null, 2)}\n`,
		);

		const decision = await getDeepInterviewMutationDecision({
			cwd,
			sessionId,
			tool: tool("write"),
			args: { path: "src/product.ts", content: "x" },
		});
		expect(decision.blocked).toBe(false);
	});

	it("never blocks bash during a planning phase, including compound/redirected/newline commands", async () => {
		const cwd = await makeTempRoot();
		await writeActiveSkill(cwd, "ralplan", "planner");

		for (const command of [
			"gjc ralplan --write --stage planner --artifact /tmp/p.md ; tee src/product.ts",
			"gjc state read && echo x > .gjc/state/foo.json",
			"gjc ralplan --write --stage planner --artifact /tmp/p.md\ntouch src/product.ts",
			"gjc state read\nrm .gjc/state/foo.json",
			"gjc ralplan --write --stage planner --artifact /tmp/p.md",
		]) {
			const decision = await getDeepInterviewMutationDecision({
				cwd,
				sessionId: "session-a",
				tool: tool("bash"),
				args: { command },
			});
			expect(decision.blocked).toBe(false);
		}
	});

	it("selects the most-recently-updated workflow skill when several are momentarily active", async () => {
		const cwd = await makeTempRoot();
		const sessionId = "session-a";
		const sessionDir = sessionStateDir(cwd, sessionId);
		await fs.mkdir(sessionDir, { recursive: true });
		const older = new Date(Date.now() - 60_000).toISOString();
		const newer = new Date().toISOString();
		// Stale ralplan `final` (older) coexists with a newer ultragoal executor; the
		// newer executor must win so product mutation is allowed.
		await Bun.write(
			activeSnapshotPath(cwd, sessionId),
			`${JSON.stringify(
				{
					version: 1,
					active: true,
					skill: "ralplan",
					phase: "final",
					updated_at: older,
					active_skills: [
						{ skill: "ralplan", phase: "final", active: true, updated_at: older, session_id: sessionId },
						{ skill: "ultragoal", phase: "active", active: true, updated_at: newer, session_id: sessionId },
					],
				},
				null,
				2,
			)}\n`,
		);
		await Bun.write(
			modeStatePath(cwd, sessionId, "ralplan"),
			`${JSON.stringify({ active: true, current_phase: "final", session_id: sessionId }, null, 2)}\n`,
		);
		await Bun.write(
			modeStatePath(cwd, sessionId, "ultragoal"),
			`${JSON.stringify({ active: true, current_phase: "active", session_id: sessionId }, null, 2)}\n`,
		);

		const decision = await getDeepInterviewMutationDecision({
			cwd,
			sessionId,
			tool: tool("write"),
			args: { path: "src/product.ts", content: "x" },
		});
		expect(decision.blocked).toBe(false);
	});

	it("blocks a temp symlink whose real target is inside the project tree", async () => {
		const cwd = await makeTempRoot();
		await writeActiveDeepInterview(cwd);
		await fs.mkdir(path.join(cwd, "src"), { recursive: true });
		const linkDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-guard-symlink-"));
		tempRoots.push(linkDir);
		const link = path.join(linkDir, "into-repo");
		await fs.symlink(path.join(cwd, "src"), link);

		const decision = await getDeepInterviewMutationDecision({
			cwd,
			sessionId: "session-a",
			tool: tool("write"),
			args: { path: path.join(link, "product.ts"), content: "x" },
		});
		expect(decision.blocked).toBe(true);
	});

	it("blocks .gjc raw paths in deferred ast_edit apply even with no planning skill or forceOverride", async () => {
		const cwd = await makeTempRoot();
		await expect(
			assertDeepInterviewMutationRawPathsAllowed({ cwd, rawPaths: [".gjc/specs/x.md"] }),
		).rejects.toBeInstanceOf(ToolError);
		await expect(
			assertDeepInterviewMutationRawPathsAllowed({
				cwd,
				rawPaths: [".gjc/state/ralplan-state.json"],
				forceOverride: true,
			}),
		).rejects.toBeInstanceOf(ToolError);
	});
});
