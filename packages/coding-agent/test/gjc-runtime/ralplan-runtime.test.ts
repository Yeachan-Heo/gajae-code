import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { runNativeRalplanCommand } from "@gajae-code/coding-agent/gjc-runtime/ralplan-runtime";
import { GJC_RESTRICTED_ROLE_AGENT_BASH_ENV } from "@gajae-code/coding-agent/gjc-runtime/restricted-role-agent-bash";
import {
	activeEntryPath,
	activeSnapshotPath,
	modeStatePath,
	sessionPlansDir,
} from "@gajae-code/coding-agent/gjc-runtime/session-layout";
import { readVisibleSkillActiveState } from "@gajae-code/coding-agent/skill-state/active-state";

const TEST_SESSION_ID = "test-session";
const tempRoots: string[] = [];
let previousGjcSessionId: string | undefined;

const ralplanStatePath = (root: string) => modeStatePath(root, TEST_SESSION_ID, "ralplan");
const ralplanRunDir = (root: string, runId: string) =>
	path.join(sessionPlansDir(root, TEST_SESSION_ID), "ralplan", runId);
const ralplanPlanPath = (root: string, runId: string, ...parts: string[]) =>
	path.join(ralplanRunDir(root, runId), ...parts);

beforeAll(() => {
	previousGjcSessionId = process.env.GJC_SESSION_ID;
	process.env.GJC_SESSION_ID = TEST_SESSION_ID;
});

afterAll(() => {
	if (previousGjcSessionId === undefined) {
		delete process.env.GJC_SESSION_ID;
	} else {
		process.env.GJC_SESSION_ID = previousGjcSessionId;
	}
});

async function tempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(process.cwd(), ".tmp-ralplan-runtime-"));
	tempRoots.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempRoots.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("native gjc ralplan runtime — consensus handoff", () => {
	it("accepts the documented flag surface without rejecting --interactive/--deliberate", async () => {
		const root = await tempDir();
		const result = await runNativeRalplanCommand(["--interactive", "--deliberate", "make state native"], root);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("ralplan seed run_id=");
		const state = JSON.parse(await fs.readFile(ralplanStatePath(root), "utf-8"));
		expect(state.mode).toBe("deliberate");
		expect(state.interactive).toBe(true);
		expect(state.task).toBe("make state native");
	});

	it("emits receipt-only json for consensus handoff", async () => {
		const root = await tempDir();
		const result = await runNativeRalplanCommand(["--json", "--deliberate", "make state native"], root);
		expect(result.status).toBe(0);
		const payload = JSON.parse(result.stdout ?? "{}");
		expect(payload).toMatchObject({
			ok: true,
			skill: "ralplan",
			mode: "deliberate",
			handoff: "/skill:ralplan",
		});
		expect(typeof payload.run_id).toBe("string");
		expect(payload.state_path).toBe(ralplanStatePath(root));
		expect(payload.task).toBeUndefined();
	});

	it("rejects corrupt ralplan state before consensus handoff seeding", async () => {
		const root = await tempDir();
		const statePath = ralplanStatePath(root);
		await fs.mkdir(path.dirname(statePath), { recursive: true });
		await fs.writeFile(statePath, "{broken json", "utf-8");

		const result = await runNativeRalplanCommand(["--json", "make state native"], root);

		expect(result.status).toBe(2);
		expect(result.stderr).toContain("existing ralplan state is corrupt or tampered");
		expect(await fs.readFile(statePath, "utf-8")).toBe("{broken json");
	});

	it("reuses a valid active run id during consensus handoff seeding", async () => {
		const root = await tempDir();
		const statePath = ralplanStatePath(root);
		await fs.mkdir(path.dirname(statePath), { recursive: true });
		await fs.writeFile(
			statePath,
			JSON.stringify({ skill: "ralplan", active: true, current_phase: "planner", run_id: "existing-run" }),
			"utf-8",
		);

		const result = await runNativeRalplanCommand(["--json", "continue existing"], root);

		expect(result.status).toBe(0);
		const payload = JSON.parse(result.stdout ?? "{}") as { run_id: string };
		expect(payload.run_id).toBe("existing-run");
		const state = JSON.parse(await fs.readFile(statePath, "utf-8")) as { run_id: string; task: string };
		expect(state.run_id).toBe("existing-run");
		expect(state.task).toBe("continue existing");
	});

	it("--architect openai-code seeds the kind into state", async () => {
		const root = await tempDir();
		const result = await runNativeRalplanCommand(
			["--architect", "openai-code", "--critic", "openai-code", "scope a refactor"],
			root,
		);
		expect(result.status).toBe(0);
		const state = JSON.parse(await fs.readFile(ralplanStatePath(root), "utf-8"));
		expect(state.architect_kind).toBe("openai-code");
		expect(state.critic_kind).toBe("openai-code");
	});

	it("syncs ralplan HUD chips for the active run", async () => {
		const root = await tempDir();
		await runNativeRalplanCommand(["--deliberate", "task"], root);
		const active = JSON.parse(await fs.readFile(activeSnapshotPath(root, TEST_SESSION_ID), "utf-8"));
		const entry = (
			active.active_skills as Array<{
				skill: string;
				phase?: string;
				hud?: { chips?: Array<{ label: string; value?: string }> };
			}>
		).find(e => e.skill === "ralplan");
		expect(entry).toBeTruthy();
		expect(entry?.phase).toBe("planner");
		const chips = entry?.hud?.chips ?? [];
		expect(chips.some(c => c.label === "stage" && c.value === "planner")).toBe(true);
		expect(chips.some(c => c.label === "iter" && c.value === "1")).toBe(true);
	});

	it("visible HUD prefers canonical final over a stale active-state snapshot", async () => {
		const root = await tempDir();
		await runNativeRalplanCommand(["--deliberate", "--json", "task"], root);
		const statePath = ralplanStatePath(root);
		const runId = (JSON.parse(await fs.readFile(statePath, "utf-8")) as { run_id: string }).run_id;
		await runNativeRalplanCommand(
			["--write", "--stage", "revision", "--stage_n", "4", "--artifact", "# revision", "--run-id", runId],
			root,
		);
		const snapshotPath = activeSnapshotPath(root, TEST_SESSION_ID);
		const staleSnapshot = JSON.parse(await fs.readFile(snapshotPath, "utf-8")) as {
			active_skills?: Array<{
				skill: string;
				phase?: string;
				hud?: { chips?: Array<{ label: string; value?: string }> };
			}>;
		};
		await runNativeRalplanCommand(
			["--write", "--stage", "final", "--stage_n", "6", "--artifact", "# final", "--run-id", runId],
			root,
		);
		await fs.writeFile(snapshotPath, `${JSON.stringify(staleSnapshot, null, 2)}\n`, "utf-8");
		await fs.writeFile(
			activeEntryPath(root, TEST_SESSION_ID, "ralplan"),
			`${JSON.stringify(
				{
					skill: "ralplan",
					active: true,
					phase: "revision",
					hud: { version: 1, chips: [{ label: "stage", value: "revision" }] },
				},
				null,
				2,
			)}\n`,
			"utf-8",
		);

		const visible = await readVisibleSkillActiveState(root);
		const entry = visible?.active_skills?.find(item => item.skill === "ralplan");
		expect(entry?.phase).toBe("final");
		expect(entry?.hud?.chips?.some(chip => chip.label === "stage" && chip.value === "final")).toBe(true);
	});

	it("visible HUD prefers canonical inactive handoff over stale active entries", async () => {
		const root = await tempDir();
		await runNativeRalplanCommand(["--deliberate", "--json", "task"], root);
		const statePath = ralplanStatePath(root);
		const runId = (JSON.parse(await fs.readFile(statePath, "utf-8")) as { run_id: string }).run_id;
		await runNativeRalplanCommand(
			["--write", "--stage", "revision", "--stage_n", "4", "--artifact", "# revision", "--run-id", runId],
			root,
		);
		const snapshotPath = activeSnapshotPath(root, TEST_SESSION_ID);
		const staleSnapshot = JSON.parse(await fs.readFile(snapshotPath, "utf-8"));
		await fs.writeFile(
			statePath,
			`${JSON.stringify({ skill: "ralplan", active: false, current_phase: "handoff", run_id: runId, version: 2 }, null, 2)}\n`,
			"utf-8",
		);
		await fs.writeFile(snapshotPath, `${JSON.stringify(staleSnapshot, null, 2)}\n`, "utf-8");
		await fs.writeFile(
			activeEntryPath(root, TEST_SESSION_ID, "ralplan"),
			`${JSON.stringify(
				{
					skill: "ralplan",
					active: true,
					phase: "revision",
					hud: { version: 1, chips: [{ label: "stage", value: "revision" }] },
				},
				null,
				2,
			)}\n`,
			"utf-8",
		);

		const visible = await readVisibleSkillActiveState(root);
		const entry = visible?.active_skills?.find(item => item.skill === "ralplan");
		expect(entry?.phase).toBe("handoff");
		expect(entry?.hud?.chips?.some(chip => chip.label === "stage" && chip.value === "handoff")).toBe(true);
	});

	it("rejects unknown --architect kinds with exit 2", async () => {
		const root = await tempDir();
		const result = await runNativeRalplanCommand(["--architect", "nope", "task"], root);
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("unknown --architect kind");
	});

	it("rejects missing task description with exit 2", async () => {
		const root = await tempDir();
		const result = await runNativeRalplanCommand(["--deliberate"], root);
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("requires a task description");
	});

	it("rejects unknown free-form flags with exit 2", async () => {
		const root = await tempDir();
		const result = await runNativeRalplanCommand(["--no-such-flag", "task"], root);
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("unknown flag");
	});
});

describe("native gjc ralplan runtime — --write artifact path", () => {
	it("persists an inline artifact under .gjc/plans/ralplan/<run-id>/", async () => {
		const root = await tempDir();
		const result = await runNativeRalplanCommand(
			[
				"--write",
				"--stage",
				"planner",
				"--stage_n",
				"1",
				"--artifact",
				"# Plan body",
				"--run-id",
				"test-run-1",
				"--json",
			],
			root,
		);
		expect(result.status).toBe(0);
		const payload = JSON.parse(result.stdout ?? "{}");
		expect(payload.run_id).toBe("test-run-1");
		expect(payload.stage).toBe("planner");
		expect(payload.stage_n).toBe(1);
		expect(typeof payload.sha256).toBe("string");
		const filePath = ralplanPlanPath(root, "test-run-1", "stage-01-planner.md");
		const content = await fs.readFile(filePath, "utf-8");
		expect(content).toBe("# Plan body\n");
		const indexLine = (await fs.readFile(ralplanPlanPath(root, "test-run-1", "index.jsonl"), "utf-8")).trim();
		expect(JSON.parse(indexLine).sha256).toBe(payload.sha256);
	});

	it("--artifact <file> reads contents from disk", async () => {
		const root = await tempDir();
		const artifactPath = path.join(root, "draft.md");
		await fs.writeFile(artifactPath, "# Draft\nbody\n");
		const result = await runNativeRalplanCommand(
			["--write", "--stage", "architect", "--stage_n", "2", "--artifact", artifactPath, "--run-id", "file-run"],
			root,
		);
		expect(result.status).toBe(0);
		const content = await fs.readFile(ralplanPlanPath(root, "file-run", "stage-02-architect.md"), "utf-8");
		expect(content).toBe("# Draft\nbody\n");
	});

	it("restricted role-agent bash treats --artifact paths as inline text", async () => {
		const root = await tempDir();
		const artifactPath = path.join(root, "secret.md");
		await fs.writeFile(artifactPath, "# Secret\nshould-not-be-read\n");
		const previous = process.env[GJC_RESTRICTED_ROLE_AGENT_BASH_ENV];
		process.env[GJC_RESTRICTED_ROLE_AGENT_BASH_ENV] = "1";
		try {
			const result = await runNativeRalplanCommand(
				[
					"--write",
					"--stage",
					"architect",
					"--stage_n",
					"2",
					"--artifact",
					artifactPath,
					"--run-id",
					"restricted-file-run",
				],
				root,
			);
			expect(result.status).toBe(0);
			const content = await fs.readFile(
				ralplanPlanPath(root, "restricted-file-run", "stage-02-architect.md"),
				"utf-8",
			);
			expect(content).toBe(`${artifactPath}\n`);
		} finally {
			if (previous === undefined) {
				delete process.env[GJC_RESTRICTED_ROLE_AGENT_BASH_ENV];
			} else {
				process.env[GJC_RESTRICTED_ROLE_AGENT_BASH_ENV] = previous;
			}
		}
	});

	it("final stage emits pending-approval.md alongside the stage artifact", async () => {
		const root = await tempDir();
		const result = await runNativeRalplanCommand(
			[
				"--write",
				"--stage",
				"final",
				"--stage_n",
				"6",
				"--artifact",
				"# Final Plan",
				"--run-id",
				"final-run",
				"--json",
			],
			root,
		);
		expect(result.status).toBe(0);
		const payload = JSON.parse(result.stdout ?? "{}");
		expect(typeof payload.pending_approval_path).toBe("string");
		const pendingApproval = await fs.readFile(ralplanPlanPath(root, "final-run", "pending-approval.md"), "utf-8");
		expect(pendingApproval).toBe("# Final Plan\n");
	});

	it("rejects unknown --stage with exit 2", async () => {
		const root = await tempDir();
		const result = await runNativeRalplanCommand(
			["--write", "--stage", "nope", "--stage_n", "1", "--artifact", "x"],
			root,
		);
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("unknown --stage");
	});

	it("rejects out-of-range --stage_n with exit 2", async () => {
		const root = await tempDir();
		const result = await runNativeRalplanCommand(
			["--write", "--stage", "planner", "--stage_n", "1000", "--artifact", "x"],
			root,
		);
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("invalid --stage_n");
	});

	it("rejects malformed non-integer --stage_n like '1.5' or '1abc' with exit 2", async () => {
		const root = await tempDir();
		for (const bad of ["1.5", "1abc", "0", "-1", "abc"]) {
			const result = await runNativeRalplanCommand(
				["--write", "--stage", "planner", "--stage_n", bad, "--artifact", "x"],
				root,
			);
			expect(result.status, `expected rejection for ${bad}`).toBe(2);
			expect(result.stderr).toContain("invalid --stage_n");
		}
	});

	it("rejects --run-id with traversal characters with exit 2", async () => {
		const root = await tempDir();
		const result = await runNativeRalplanCommand(
			["--write", "--stage", "planner", "--stage_n", "1", "--artifact", "x", "--run-id", "../escape"],
			root,
		);
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("invalid path component");
	});

	it("appends index.jsonl entries instead of overwriting", async () => {
		const root = await tempDir();
		await runNativeRalplanCommand(
			["--write", "--stage", "planner", "--stage_n", "1", "--artifact", "p1", "--run-id", "multi"],
			root,
		);
		await runNativeRalplanCommand(
			["--write", "--stage", "architect", "--stage_n", "2", "--artifact", "a2", "--run-id", "multi"],
			root,
		);
		const indexLines = (await fs.readFile(ralplanPlanPath(root, "multi", "index.jsonl"), "utf-8")).trim().split("\n");
		expect(indexLines.length).toBe(2);
		expect(JSON.parse(indexLines[0]).stage).toBe("planner");
		expect(JSON.parse(indexLines[1]).stage).toBe("architect");
	});

	it("keeps multiple --write calls in the same run when no --run-id is supplied", async () => {
		const root = await tempDir();
		const first = await runNativeRalplanCommand(
			["--write", "--stage", "planner", "--stage_n", "1", "--artifact", "p1", "--json"],
			root,
		);
		expect(first.status).toBe(0);
		const firstPayload = JSON.parse(first.stdout ?? "{}") as { run_id: string };

		const second = await runNativeRalplanCommand(
			["--write", "--stage", "architect", "--stage_n", "2", "--artifact", "a2", "--json"],
			root,
		);
		expect(second.status).toBe(0);
		const secondPayload = JSON.parse(second.stdout ?? "{}") as { run_id: string };

		// Without explicit --run-id, both writes should target the same auto-generated run.
		expect(secondPayload.run_id).toBe(firstPayload.run_id);

		const indexLines = (await fs.readFile(ralplanPlanPath(root, firstPayload.run_id, "index.jsonl"), "utf-8"))
			.trim()
			.split("\n");
		expect(indexLines.length).toBe(2);
		expect(JSON.parse(indexLines[0]).stage).toBe("planner");
		expect(JSON.parse(indexLines[1]).stage).toBe("architect");
	});

	it("ralplan consensus handoff seeds run_id that subsequent --write calls reuse", async () => {
		const root = await tempDir();
		const handoff = await runNativeRalplanCommand(["--deliberate", "--json", "task"], root);
		expect(handoff.status).toBe(0);
		const handoffPayload = JSON.parse(handoff.stdout ?? "{}") as { run_id: string };
		expect(typeof handoffPayload.run_id).toBe("string");

		const write = await runNativeRalplanCommand(
			["--write", "--stage", "planner", "--stage_n", "1", "--artifact", "# Plan", "--json"],
			root,
		);
		expect(write.status).toBe(0);
		const writePayload = JSON.parse(write.stdout ?? "{}") as { run_id: string };
		expect(writePayload.run_id).toBe(handoffPayload.run_id);
	});
});

describe("native gjc ralplan runtime — run-state phase coherence", () => {
	const readPhase = async (root: string): Promise<string> => {
		const raw = await fs.readFile(ralplanStatePath(root), "utf-8");
		return (JSON.parse(raw) as { current_phase?: string }).current_phase ?? "";
	};

	it("advances current_phase to track each stage written after seeding", async () => {
		const root = await tempDir();
		const handoff = await runNativeRalplanCommand(["--deliberate", "--json", "task"], root);
		const runId = (JSON.parse(handoff.stdout ?? "{}") as { run_id: string }).run_id;
		expect(await readPhase(root)).toBe("planner");

		for (const [stage, stageN] of [
			["planner", "1"],
			["architect", "2"],
			["critic", "3"],
			["revision", "4"],
			["post-interview", "5"],
			["adr", "6"],
		] as const) {
			const result = await runNativeRalplanCommand(
				["--write", "--stage", stage, "--stage_n", stageN, "--artifact", `# ${stage}`, "--run-id", runId],
				root,
			);
			expect(result.status).toBe(0);
			expect(await readPhase(root)).toBe(stage);
		}
	});

	it("advances current_phase to final on the final stage write", async () => {
		const root = await tempDir();
		await runNativeRalplanCommand(["--deliberate", "--json", "task"], root);
		const runId = (
			JSON.parse(await fs.readFile(ralplanStatePath(root), "utf-8")) as {
				run_id: string;
			}
		).run_id;
		await runNativeRalplanCommand(
			["--write", "--stage", "adr", "--stage_n", "5", "--artifact", "# adr", "--run-id", runId],
			root,
		);
		expect(await readPhase(root)).toBe("adr");
		await runNativeRalplanCommand(
			["--write", "--stage", "final", "--stage_n", "6", "--artifact", "# final", "--run-id", runId],
			root,
		);
		expect(await readPhase(root)).toBe("final");
	});

	it("does not regress a handed-off run-state phase on a stray --write (chain guard intact)", async () => {
		const root = await tempDir();
		const statePath = ralplanStatePath(root);
		await fs.mkdir(path.dirname(statePath), { recursive: true });
		await fs.writeFile(
			statePath,
			JSON.stringify({
				skill: "ralplan",
				active: true,
				current_phase: "handoff",
				run_id: "locked-run",
				version: 2,
			}),
			"utf-8",
		);
		const result = await runNativeRalplanCommand(
			["--write", "--stage", "planner", "--stage_n", "1", "--artifact", "# Plan", "--run-id", "locked-run"],
			root,
		);
		expect(result.status).toBe(0);
		expect(await readPhase(root)).toBe("handoff");
	});

	it("doctor reports active-state phase drift from canonical final", async () => {
		const root = await tempDir();
		await runNativeRalplanCommand(["--deliberate", "--json", "task"], root);
		const statePath = ralplanStatePath(root);
		const runId = (JSON.parse(await fs.readFile(statePath, "utf-8")) as { run_id: string }).run_id;
		await runNativeRalplanCommand(
			["--write", "--stage", "revision", "--stage_n", "4", "--artifact", "# revision", "--run-id", runId],
			root,
		);
		const snapshotPath = activeSnapshotPath(root, TEST_SESSION_ID);
		const staleSnapshot = JSON.parse(await fs.readFile(snapshotPath, "utf-8"));
		await runNativeRalplanCommand(
			["--write", "--stage", "final", "--stage_n", "6", "--artifact", "# final", "--run-id", runId],
			root,
		);
		await fs.writeFile(snapshotPath, `${JSON.stringify(staleSnapshot, null, 2)}\n`, "utf-8");
		await fs.writeFile(
			activeEntryPath(root, TEST_SESSION_ID, "ralplan"),
			`${JSON.stringify({ skill: "ralplan", active: true, phase: "revision" }, null, 2)}\n`,
			"utf-8",
		);

		const result = await runNativeRalplanCommand(["doctor", "--json"], root);
		expect(result.status).toBe(1);
		const parsed = JSON.parse(result.stdout ?? "{}") as {
			problems?: Array<{ type: string; skill?: string; path: string; message: string }>;
		};
		const driftProblems = (parsed.problems ?? []).filter(
			problem =>
				problem.type === "stale_active_state" &&
				problem.skill === "ralplan" &&
				problem.message.includes("differs from canonical mode-state phase final"),
		);
		expect(driftProblems.some(problem => problem.path.endsWith(path.join("active", "ralplan.json")))).toBe(true);
		expect(driftProblems.some(problem => problem.path.endsWith("skill-active-state.json"))).toBe(true);
	});

	it("doctor reports drift from canonical inactive handoff", async () => {
		const root = await tempDir();
		await runNativeRalplanCommand(["--deliberate", "--json", "task"], root);
		const statePath = ralplanStatePath(root);
		const runId = (JSON.parse(await fs.readFile(statePath, "utf-8")) as { run_id: string }).run_id;
		await runNativeRalplanCommand(
			["--write", "--stage", "revision", "--stage_n", "4", "--artifact", "# revision", "--run-id", runId],
			root,
		);
		const snapshotPath = activeSnapshotPath(root, TEST_SESSION_ID);
		const staleSnapshot = JSON.parse(await fs.readFile(snapshotPath, "utf-8"));
		await fs.writeFile(
			statePath,
			`${JSON.stringify({ skill: "ralplan", active: false, current_phase: "handoff", run_id: runId, version: 2 }, null, 2)}\n`,
			"utf-8",
		);
		await fs.writeFile(snapshotPath, `${JSON.stringify(staleSnapshot, null, 2)}\n`, "utf-8");
		await fs.writeFile(
			activeEntryPath(root, TEST_SESSION_ID, "ralplan"),
			`${JSON.stringify({ skill: "ralplan", active: true, phase: "revision" }, null, 2)}\n`,
			"utf-8",
		);

		const result = await runNativeRalplanCommand(["doctor", "--json"], root);
		expect(result.status).toBe(1);
		const parsed = JSON.parse(result.stdout ?? "{}") as {
			problems?: Array<{ type: string; skill?: string; path: string; message: string }>;
		};
		const driftProblems = (parsed.problems ?? []).filter(
			problem =>
				problem.type === "stale_active_state" &&
				problem.skill === "ralplan" &&
				problem.message.includes("differs from canonical mode-state phase handoff"),
		);
		expect(driftProblems.some(problem => problem.path.endsWith(path.join("active", "ralplan.json")))).toBe(true);
		expect(driftProblems.some(problem => problem.path.endsWith("skill-active-state.json"))).toBe(true);
	});
});

describe("native gjc ralplan runtime — duplicate --write guard", () => {
	const runDir = ralplanRunDir;

	it("treats an identical repeated write as a deterministic no-op", async () => {
		const root = await tempDir();
		const args = ["--write", "--stage", "planner", "--stage_n", "1", "--artifact", "# Plan", "--run-id", "dup-run"];
		const first = await runNativeRalplanCommand([...args, "--json"], root);
		expect(first.status).toBe(0);
		expect((JSON.parse(first.stdout ?? "{}") as { deduplicated?: boolean }).deduplicated).toBeUndefined();

		const second = await runNativeRalplanCommand([...args, "--json"], root);
		expect(second.status).toBe(0);
		const payload = JSON.parse(second.stdout ?? "{}") as { deduplicated?: boolean; sha256: string };
		expect(payload.deduplicated).toBe(true);
		expect(payload.sha256).toBe((JSON.parse(first.stdout ?? "{}") as { sha256: string }).sha256);

		const indexLines = (await fs.readFile(path.join(runDir(root, "dup-run"), "index.jsonl"), "utf-8"))
			.trim()
			.split("\n")
			.filter(Boolean);
		expect(indexLines.length).toBe(1);
		const content = await fs.readFile(path.join(runDir(root, "dup-run"), "stage-01-planner.md"), "utf-8");
		expect(content).toBe("# Plan\n");
	});

	it("refuses to clobber an existing (stage, stage_n) with different content", async () => {
		const root = await tempDir();
		const first = await runNativeRalplanCommand(
			["--write", "--stage", "planner", "--stage_n", "1", "--artifact", "v1", "--run-id", "conflict-run"],
			root,
		);
		expect(first.status).toBe(0);

		const second = await runNativeRalplanCommand(
			["--write", "--stage", "planner", "--stage_n", "1", "--artifact", "v2", "--run-id", "conflict-run"],
			root,
		);
		expect(second.status).toBe(2);
		expect(second.stderr).toContain("refusing to overwrite ralplan planner stage 1");

		const indexLines = (await fs.readFile(path.join(runDir(root, "conflict-run"), "index.jsonl"), "utf-8"))
			.trim()
			.split("\n")
			.filter(Boolean);
		expect(indexLines.length).toBe(1);
		const content = await fs.readFile(path.join(runDir(root, "conflict-run"), "stage-01-planner.md"), "utf-8");
		expect(content).toBe("v1\n");
	});

	it("allows the same stage at a new stage_n (revision passes are not duplicates)", async () => {
		const root = await tempDir();
		await runNativeRalplanCommand(
			["--write", "--stage", "planner", "--stage_n", "1", "--artifact", "first", "--run-id", "multi-pass"],
			root,
		);
		const second = await runNativeRalplanCommand(
			["--write", "--stage", "planner", "--stage_n", "4", "--artifact", "second", "--run-id", "multi-pass"],
			root,
		);
		expect(second.status).toBe(0);
		const indexLines = (await fs.readFile(path.join(runDir(root, "multi-pass"), "index.jsonl"), "utf-8"))
			.trim()
			.split("\n")
			.filter(Boolean);
		expect(indexLines.length).toBe(2);
	});

	it("collapses concurrent identical writes to a single index.jsonl row (#660 TOCTOU)", async () => {
		const root = await tempDir();
		const args = ["--write", "--stage", "planner", "--stage_n", "1", "--artifact", "# Plan", "--run-id", "race-run"];

		// The command-level dedup (findExistingStageArtifact) and the ledger append
		// are not under one lock, so racing identical writes can both observe an
		// empty index and both append. The shared appendJsonlIdempotent primitive
		// serializes the append, so exactly one row survives regardless of the race.
		const results = await Promise.all(Array.from({ length: 6 }, () => runNativeRalplanCommand([...args], root)));
		for (const result of results) {
			expect(result.status).toBe(0);
		}

		const indexLines = (await fs.readFile(path.join(runDir(root, "race-run"), "index.jsonl"), "utf-8"))
			.trim()
			.split("\n")
			.filter(Boolean);
		expect(indexLines.length).toBe(1);
		expect(JSON.parse(indexLines[0]).stage).toBe("planner");
	});
});

describe("native gjc ralplan runtime — persisted Planner state", () => {
	const statePath = (root: string) => ralplanStatePath(root);

	async function readState(root: string): Promise<Record<string, unknown>> {
		const raw = await fs.readFile(statePath(root), "utf-8");
		return JSON.parse(raw) as Record<string, unknown>;
	}

	it("records planner id + resumable into run state and echoes planner_state", async () => {
		const root = await tempDir();
		const result = await runNativeRalplanCommand(
			[
				"--write",
				"--stage",
				"planner",
				"--stage_n",
				"1",
				"--artifact",
				"# Plan",
				"--run-id",
				"pp-run",
				"--planner-id",
				"0-Planner",
				"--planner-resumable",
				"true",
				"--json",
			],
			root,
		);
		expect(result.status).toBe(0);
		const payload = JSON.parse(result.stdout ?? "{}");
		expect(payload.planner_state).toEqual({
			planner_subagent_id: "0-Planner",
			planner_resumable: true,
		});
		const state = await readState(root);
		expect(state.planner_subagent_id).toBe("0-Planner");
		expect(state.planner_resumable).toBe(true);
		expect(state.run_id).toBe("pp-run");
	});

	it("accepts --planner-resumable false", async () => {
		const root = await tempDir();
		const result = await runNativeRalplanCommand(
			[
				"--write",
				"--stage",
				"revision",
				"--stage_n",
				"2",
				"--artifact",
				"# Rev",
				"--run-id",
				"pp-false",
				"--planner-resumable",
				"false",
				"--json",
			],
			root,
		);
		expect(result.status).toBe(0);
		const state = await readState(root);
		expect(state.planner_resumable).toBe(false);
	});

	it("omits planner fields when no planner flags are supplied (existing writes unaffected)", async () => {
		const root = await tempDir();
		const result = await runNativeRalplanCommand(
			["--write", "--stage", "planner", "--stage_n", "1", "--artifact", "# Plan", "--run-id", "plain", "--json"],
			root,
		);
		expect(result.status).toBe(0);
		const payload = JSON.parse(result.stdout ?? "{}");
		expect(payload.planner_state).toBeUndefined();
		const state = await readState(root);
		expect("planner_subagent_id" in state).toBe(false);
		expect("planner_resumable" in state).toBe(false);
	});

	it("rejects corrupt ralplan state before persisting an active run id", async () => {
		const root = await tempDir();
		await fs.mkdir(path.dirname(statePath(root)), { recursive: true });
		await fs.writeFile(statePath(root), "{broken json", "utf-8");

		const result = await runNativeRalplanCommand(
			["--write", "--stage", "planner", "--stage_n", "1", "--artifact", "# Plan", "--run-id", "corrupt", "--json"],
			root,
		);

		expect(result.status).toBe(2);
		expect(result.stderr).toContain("existing ralplan state is corrupt or tampered");
		expect(await fs.readFile(statePath(root), "utf-8")).toBe("{broken json");
	});

	it("rejects corrupt ralplan state before applying planner metadata", async () => {
		const root = await tempDir();
		await fs.mkdir(path.dirname(statePath(root)), { recursive: true });
		await fs.writeFile(statePath(root), "{broken json", "utf-8");

		const result = await runNativeRalplanCommand(
			[
				"--write",
				"--stage",
				"planner",
				"--stage_n",
				"1",
				"--artifact",
				"# Plan",
				"--run-id",
				"corrupt-planner",
				"--planner-id",
				"0-Planner",
				"--json",
			],
			root,
		);

		expect(result.status).toBe(2);
		expect(result.stderr).toContain("existing ralplan state is corrupt or tampered");
		expect(await fs.readFile(statePath(root), "utf-8")).toBe("{broken json");
	});

	it("records fallback metadata together with a fresh planner id", async () => {
		const root = await tempDir();
		const result = await runNativeRalplanCommand(
			[
				"--write",
				"--stage",
				"revision",
				"--stage_n",
				"3",
				"--artifact",
				"# Rev",
				"--run-id",
				"pp-fb",
				"--planner-id",
				"1-PlannerFresh",
				"--fallback-reason",
				"context_unavailable",
				"--fallback-attempted-id",
				"0-PlannerOld",
				"--fallback-stage-n",
				"3",
				"--fallback-receipt-path",
				".gjc/plans/ralplan/pp-fb/stage-03-revision.md",
				"--json",
			],
			root,
		);
		expect(result.status).toBe(0);
		const state = await readState(root);
		expect(state.planner_fallback_reason).toBe("context_unavailable");
		expect(state.planner_fallback_attempted_id).toBe("0-PlannerOld");
		expect(state.planner_fallback_stage_n).toBe(3);
		expect(state.planner_fallback_receipt_path).toBe(".gjc/plans/ralplan/pp-fb/stage-03-revision.md");
		expect(state.planner_subagent_id).toBe("1-PlannerFresh");
	});

	it("rejects invalid --planner-resumable with exit 2", async () => {
		const root = await tempDir();
		const result = await runNativeRalplanCommand(
			[
				"--write",
				"--stage",
				"planner",
				"--stage_n",
				"1",
				"--artifact",
				"x",
				"--run-id",
				"bad-bool",
				"--planner-resumable",
				"yes",
			],
			root,
		);
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("invalid --planner-resumable");
	});

	it("rejects invalid --planner-id with exit 2", async () => {
		const root = await tempDir();
		const result = await runNativeRalplanCommand(
			[
				"--write",
				"--stage",
				"planner",
				"--stage_n",
				"1",
				"--artifact",
				"x",
				"--run-id",
				"bad-id",
				"--planner-id",
				"bad id!",
			],
			root,
		);
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("invalid --planner-id");
	});

	it("rejects unknown --fallback-reason with exit 2", async () => {
		const root = await tempDir();
		const result = await runNativeRalplanCommand(
			[
				"--write",
				"--stage",
				"revision",
				"--stage_n",
				"2",
				"--artifact",
				"x",
				"--run-id",
				"bad-reason",
				"--fallback-reason",
				"because",
			],
			root,
		);
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("invalid --fallback-reason");
	});

	it("requires --fallback-reason when other fallback flags are present", async () => {
		const root = await tempDir();
		const result = await runNativeRalplanCommand(
			[
				"--write",
				"--stage",
				"revision",
				"--stage_n",
				"2",
				"--artifact",
				"x",
				"--run-id",
				"missing-reason",
				"--fallback-attempted-id",
				"0-Old",
			],
			root,
		);
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("--fallback-reason is required");
	});

	it("does not persist an artifact when planner flags are invalid (fail-fast)", async () => {
		const root = await tempDir();
		const result = await runNativeRalplanCommand(
			[
				"--write",
				"--stage",
				"planner",
				"--stage_n",
				"1",
				"--artifact",
				"# Plan",
				"--run-id",
				"no-side-effect",
				"--planner-resumable",
				"maybe",
			],
			root,
		);
		expect(result.status).toBe(2);
		const filePath = ralplanPlanPath(root, "no-side-effect", "stage-01-planner.md");
		await expect(fs.readFile(filePath, "utf-8")).rejects.toThrow();
	});

	it("requires --fallback-attempted-id alongside --fallback-reason", async () => {
		const root = await tempDir();
		const result = await runNativeRalplanCommand(
			[
				"--write",
				"--stage",
				"revision",
				"--stage_n",
				"2",
				"--artifact",
				"x",
				"--run-id",
				"fb-missing-id",
				"--fallback-reason",
				"context_unavailable",
				"--fallback-stage-n",
				"2",
			],
			root,
		);
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("--fallback-attempted-id is required");
	});

	it("requires --fallback-stage-n alongside --fallback-reason", async () => {
		const root = await tempDir();
		const result = await runNativeRalplanCommand(
			[
				"--write",
				"--stage",
				"revision",
				"--stage_n",
				"2",
				"--artifact",
				"x",
				"--run-id",
				"fb-missing-stage",
				"--fallback-reason",
				"context_unavailable",
				"--fallback-attempted-id",
				"0-Old",
			],
			root,
		);
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("--fallback-stage-n is required");
	});

	it("rejects a planner flag supplied without a value (missing value at EOF)", async () => {
		const root = await tempDir();
		const result = await runNativeRalplanCommand(
			[
				"--write",
				"--stage",
				"planner",
				"--stage_n",
				"1",
				"--artifact",
				"# Plan",
				"--run-id",
				"eof-flag",
				"--planner-id",
			],
			root,
		);
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("missing value for --planner-id");
	});
});

describe("native gjc ralplan runtime — post-clear re-activation (#644)", () => {
	const readState = async (root: string): Promise<{ active?: unknown; current_phase?: unknown; run_id?: unknown }> => {
		const raw = await fs.readFile(ralplanStatePath(root), "utf-8");
		return JSON.parse(raw);
	};

	it("re-asserts active:true and resets phase out of terminal lock when a new run_id is written after a clear", async () => {
		const root = await tempDir();
		await runNativeRalplanCommand(["--deliberate", "task"], root);
		const statePath = ralplanStatePath(root);
		const seeded = await readState(root);
		expect(seeded.active).toBe(true);

		// Simulate `gjc state ralplan clear`: active -> false, phase -> complete.
		await fs.writeFile(statePath, JSON.stringify({ ...seeded, active: false, current_phase: "complete" }), "utf-8");

		// A subsequent --write with a NEW run_id starts a fresh run and must re-arm the skill.
		const result = await runNativeRalplanCommand(
			["--write", "--stage", "planner", "--stage_n", "1", "--artifact", "# Plan", "--run-id", "new-run-after-clear"],
			root,
		);
		expect(result.status).toBe(0);

		const after = await readState(root);
		expect(after.run_id).toBe("new-run-after-clear");
		expect(after.active).toBe(true);
		expect(after.current_phase).toBe("planner");
	});

	it("re-asserts active:true on a same-run continuation write at the current phase", async () => {
		const root = await tempDir();
		const statePath = ralplanStatePath(root);
		await fs.mkdir(path.dirname(statePath), { recursive: true });
		await fs.writeFile(
			statePath,
			JSON.stringify({
				skill: "ralplan",
				active: false,
				current_phase: "planner",
				run_id: "same-run-continuation",
				version: 2,
			}),
			"utf-8",
		);

		const result = await runNativeRalplanCommand(
			[
				"--write",
				"--stage",
				"planner",
				"--stage_n",
				"1",
				"--artifact",
				"# Plan",
				"--run-id",
				"same-run-continuation",
			],
			root,
		);
		expect(result.status).toBe(0);

		const after = await readState(root);
		expect(after.run_id).toBe("same-run-continuation");
		expect(after.active).toBe(true);
		expect(after.current_phase).toBe("planner");
	});

	it("does not re-arm a cleared run on a stray same-run-id --write (demote-on-clear preserved)", async () => {
		const root = await tempDir();
		await runNativeRalplanCommand(["--deliberate", "task"], root);
		const statePath = ralplanStatePath(root);
		const seeded = await readState(root);
		const seededRunId = seeded.run_id as string;

		await fs.writeFile(statePath, JSON.stringify({ ...seeded, active: false, current_phase: "complete" }), "utf-8");

		// A stray --write reusing the SAME (cleared) run_id must not silently re-arm a finished run.
		const result = await runNativeRalplanCommand(
			["--write", "--stage", "planner", "--stage_n", "1", "--artifact", "# Plan", "--run-id", seededRunId],
			root,
		);
		expect(result.status).toBe(0);

		const after = await readState(root);
		expect(after.active).toBe(false);
		expect(after.current_phase).toBe("complete");
	});
});
