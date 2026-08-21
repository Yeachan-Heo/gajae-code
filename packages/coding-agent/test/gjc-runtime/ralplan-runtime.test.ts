import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	evaluateRalplanIterationCap,
	evaluateRalplanReviewLaneBudget,
	PLANNING_STUCK_MARKER,
	RALPLAN_DEFAULT_MAX_ITERATIONS,
	RALPLAN_DEFAULT_MAX_REVIEW_PASSES_PER_LANE,
	resolveRalplanAutoHandoff,
	resolveRalplanMaxIterations,
	resolveRalplanMaxReviewPassesPerLane,
	runNativeRalplanCommand,
} from "@gajae-code/coding-agent/gjc-runtime/ralplan-runtime";
import {
	GJC_RALPLAN_ARTIFACT_ENV,
	GJC_RESTRICTED_ROLE_AGENT_BASH_ENV,
} from "@gajae-code/coding-agent/gjc-runtime/restricted-role-agent-bash";
import {
	activeEntryPath,
	activeSnapshotPath,
	modeStatePath,
	sessionPlansDir,
} from "@gajae-code/coding-agent/gjc-runtime/session-layout";
import { runNativeStateCommand } from "@gajae-code/coding-agent/gjc-runtime/state-runtime";
import { readVisibleSkillActiveState } from "@gajae-code/coding-agent/skill-state/active-state";
import { getAgentDir, setAgentDir } from "@gajae-code/utils";
import { YAML } from "bun";

const TEST_SESSION_ID = "test-session";
const tempRoots: string[] = [];
let previousGjcSessionId: string | undefined;

const ralplanStatePath = (root: string) => modeStatePath(root, TEST_SESSION_ID, "ralplan");
const ralplanRunDir = (root: string, runId: string) =>
	path.join(sessionPlansDir(root, TEST_SESSION_ID), "ralplan", runId);
const ralplanPlanPath = (root: string, runId: string, ...parts: string[]) =>
	path.join(ralplanRunDir(root, runId), ...parts);
const CONFIG_ROOT_CONFIG_PROBE = path.join(import.meta.dir, "..", "fixtures", "config-root-settings-probe.ts");

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
async function seedProjectRalplanMaxIterations(root: string, maxIterations = 5): Promise<void> {
	// Project config beats any user-layer configuration, making the cap
	// scenarios hermetic regardless of the developer's ~/.gjc config.
	await fs.mkdir(path.join(root, ".gjc"), { recursive: true });
	await fs.writeFile(
		path.join(root, ".gjc", "config.yml"),
		YAML.stringify({ gjc: { ralplan: { maxIterations } } }, null, 2),
		"utf-8",
	);
}

afterEach(async () => {
	await Promise.all(tempRoots.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function writeRalplanArtifact(
	root: string,
	runId: string,
	stage: string,
	stageN: number,
	artifact: string,
	json = true,
) {
	return await runNativeRalplanCommand(
		[
			"--write",
			"--stage",
			stage,
			"--stage_n",
			String(stageN),
			"--artifact",
			artifact,
			"--run-id",
			runId,
			...(json ? ["--json"] : []),
		],
		root,
	);
}

async function writeRalplanLaneVerdictArtifact(
	root: string,
	runId: string,
	stage: "architect" | "critic",
	stageN: number,
	artifact: string,
	verdict: string,
) {
	return await runNativeRalplanCommand(
		[
			"--write",
			"--stage",
			stage,
			"--stage_n",
			String(stageN),
			"--artifact",
			artifact,
			"--run-id",
			runId,
			"--lane-verdict",
			verdict,
			"--json",
		],
		root,
	);
}

async function readRalplanHudChips(root: string): Promise<Array<{ label: string; value?: string; severity?: string }>> {
	const active = JSON.parse(await fs.readFile(activeSnapshotPath(root, TEST_SESSION_ID), "utf-8")) as {
		active_skills?: Array<{
			skill: string;
			hud?: { chips?: Array<{ label: string; value?: string; severity?: string }> };
		}>;
	};
	return active.active_skills?.find(entry => entry.skill === "ralplan")?.hud?.chips ?? [];
}

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

	it("keeps role-subagent writes in the seeded owner session", async () => {
		const root = await tempDir();
		const ownerSessionId = "owner-session";
		const childSessionId = "planner-subagent-session";
		const seed = await runNativeRalplanCommand(
			["--session-id", ownerSessionId, "--json", "plan without fragmenting artifacts"],
			root,
		);
		expect(seed.status).toBe(0);
		const seedReceipt = JSON.parse(seed.stdout ?? "{}") as { session_id: string; run_id: string };
		expect(seedReceipt).toMatchObject({ session_id: ownerSessionId, run_id: ownerSessionId });

		const previousSessionId = process.env.GJC_SESSION_ID;
		process.env.GJC_SESSION_ID = childSessionId;
		try {
			const result = await runNativeRalplanCommand(
				[
					"--write",
					"--stage",
					"planner",
					"--stage_n",
					"1",
					"--artifact",
					"# Owner-scoped plan",
					"--run-id",
					seedReceipt.run_id,
					"--json",
				],
				root,
			);
			expect(result.status).toBe(0);
			expect(JSON.parse(result.stdout ?? "{}")).toMatchObject({
				session_id: ownerSessionId,
				run_id: seedReceipt.run_id,
			});
		} finally {
			process.env.GJC_SESSION_ID = previousSessionId;
		}

		const ownerArtifact = path.join(
			sessionPlansDir(root, ownerSessionId),
			"ralplan",
			seedReceipt.run_id,
			"stage-01-planner.md",
		);
		const childArtifact = path.join(
			sessionPlansDir(root, childSessionId),
			"ralplan",
			seedReceipt.run_id,
			"stage-01-planner.md",
		);
		expect(await fs.readFile(ownerArtifact, "utf-8")).toBe("# Owner-scoped plan\n");
		expect(existsSync(childArtifact)).toBe(false);
		expect(existsSync(modeStatePath(root, childSessionId, "ralplan"))).toBe(false);
	});

	it("rejects an explicit session that conflicts with an existing run owner", async () => {
		const root = await tempDir();
		const ownerSessionId = "owner-session";
		const childSessionId = "critic-subagent-session";
		const seed = await runNativeRalplanCommand(
			["--session-id", ownerSessionId, "--json", "preserve immutable run ownership"],
			root,
		);
		const { run_id: runId } = JSON.parse(seed.stdout ?? "{}") as { run_id: string };

		const result = await runNativeRalplanCommand(
			[
				"--write",
				"--session-id",
				childSessionId,
				"--run-id",
				runId,
				"--stage",
				"critic",
				"--stage_n",
				"1",
				"--artifact",
				"# Critic",
				"--json",
			],
			root,
		);

		expect(result.status).toBe(2);
		expect(result.stderr).toContain(`run ${runId} is owned by session ${ownerSessionId}, not ${childSessionId}`);
		expect(existsSync(modeStatePath(root, childSessionId, "ralplan"))).toBe(false);
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

	it("--artifact-env reads artifact markdown from the sanctioned env var", async () => {
		const root = await tempDir();
		const previous = process.env[GJC_RALPLAN_ARTIFACT_ENV];
		process.env[GJC_RALPLAN_ARTIFACT_ENV] =
			'# Critic Review\n\nMentions `"studio"`, `use client`, $VALUE, and backslashes: C:\\tmp.\n';
		try {
			const result = await runNativeRalplanCommand(
				[
					"--write",
					"--stage",
					"critic",
					"--stage_n",
					"3",
					"--artifact-env",
					GJC_RALPLAN_ARTIFACT_ENV,
					"--run-id",
					"env-run",
				],
				root,
			);
			expect(result.status).toBe(0);
			const content = await fs.readFile(ralplanPlanPath(root, "env-run", "stage-03-critic.md"), "utf-8");
			expect(content).toContain('Mentions `"studio"`, `use client`, $VALUE');
			expect(content).toContain("C:\\tmp");
		} finally {
			if (previous === undefined) {
				delete process.env[GJC_RALPLAN_ARTIFACT_ENV];
			} else {
				process.env[GJC_RALPLAN_ARTIFACT_ENV] = previous;
			}
		}
	});

	it("--artifact-env rejects arbitrary env variable names", async () => {
		const root = await tempDir();
		const result = await runNativeRalplanCommand(
			["--write", "--stage", "critic", "--stage_n", "3", "--artifact-env", "HOME", "--run-id", "bad-env-run"],
			root,
		);
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("--artifact-env must be GJC_RALPLAN_ARTIFACT");
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
		expect(payload.auto_handoff).toMatchObject({ configuredTarget: "off", effectiveTarget: "off" });
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

	it("disposition stage fails closed on open conflicts and accepts authoritative same-pass receipts", async () => {
		const root = await tempDir();
		const runId = "disp-run";
		const planner = await writeRalplanArtifact(root, runId, "planner", 1, "# plan");
		expect(planner.status).toBe(0);
		const architect = await writeRalplanArtifact(root, runId, "architect", 1, "# architect remove field");
		expect(architect.status).toBe(0);
		const critic = await writeRalplanArtifact(root, runId, "critic", 1, "# critic keep field");
		expect(critic.status).toBe(0);
		const archReceipt = JSON.parse(architect.stdout ?? "{}") as { path: string; sha256: string };
		const critReceipt = JSON.parse(critic.stdout ?? "{}") as { path: string; sha256: string };

		const findings = [
			{
				findingId: "arch-1",
				targetId: "contract.field",
				action: "remove",
				severity: "block",
				evidence: "redundant with session identity",
				sourceRole: "architect",
				sourceReceipt: {
					stage: "architect",
					stageN: 1,
					path: archReceipt.path,
					sha256: archReceipt.sha256,
				},
			},
			{
				findingId: "crit-1",
				targetId: "contract.field",
				action: "add",
				severity: "watch",
				evidence: "needed for multi-repo binding",
				sourceRole: "critic",
				sourceReceipt: {
					stage: "critic",
					stageN: 1,
					path: critReceipt.path,
					sha256: critReceipt.sha256,
				},
			},
		];

		const openPath = path.join(root, "open-disposition.json");
		await fs.writeFile(
			openPath,
			JSON.stringify({
				schema: "ralplan.review_conflicts.v1",
				plannerStageN: 1,
				findings,
				dispositions: [],
			}),
		);
		const open = await runNativeRalplanCommand(
			["--write", "--stage", "disposition", "--stage_n", "1", "--artifact", openPath, "--run-id", runId],
			root,
		);
		expect(open.status).toBe(2);
		expect(open.stderr).toContain("Join blocked");

		const closedPath = path.join(root, "closed-disposition.json");
		await fs.writeFile(
			closedPath,
			JSON.stringify({
				schema: "ralplan.review_conflicts.v1",
				plannerStageN: 1,
				findings,
				dispositions: [
					{
						conflictId: "conflict:contract.field:arch-1:crit-1",
						choice: "accept_architect",
						rationale: "Field duplicates existing session identity.",
						decisionOwner: "ralplan-leader",
						affectedSections: ["## Contracts"],
					},
				],
			}),
		);
		const closed = await runNativeRalplanCommand(
			["--write", "--stage", "disposition", "--stage_n", "1", "--artifact", closedPath, "--run-id", runId, "--json"],
			root,
		);
		expect(closed.status).toBe(0);
		const payload = JSON.parse(closed.stdout ?? "{}") as { path: string; stage: string };
		expect(payload.stage).toBe("disposition");
		const body = await fs.readFile(payload.path, "utf-8");
		expect(body).toContain("ralplan.review_conflicts.v1");
		expect(body).toContain("dispositioned");
	});

	it("disposition stage rejects stage_n / plannerStageN mismatch and spoofed receipts", async () => {
		const root = await tempDir();
		const runId = "disp-spoof";
		const architect = await writeRalplanArtifact(root, runId, "architect", 1, "# architect");
		expect(architect.status).toBe(0);
		const critic = await writeRalplanArtifact(root, runId, "critic", 1, "# critic");
		expect(critic.status).toBe(0);
		const archReceipt = JSON.parse(architect.stdout ?? "{}") as { path: string; sha256: string };
		const critReceipt = JSON.parse(critic.stdout ?? "{}") as { path: string; sha256: string };

		const findings = [
			{
				findingId: "arch-1",
				targetId: "contract.field",
				action: "remove",
				severity: "block",
				evidence: "evidence",
				sourceRole: "architect",
				sourceReceipt: {
					stage: "architect",
					stageN: 1,
					path: archReceipt.path,
					sha256: archReceipt.sha256,
				},
			},
			{
				findingId: "crit-1",
				targetId: "contract.field",
				action: "add",
				severity: "watch",
				evidence: "evidence",
				sourceRole: "critic",
				sourceReceipt: {
					stage: "critic",
					stageN: 1,
					path: critReceipt.path,
					sha256: critReceipt.sha256,
				},
			},
		];
		const dispositions = [
			{
				conflictId: "conflict:contract.field:arch-1:crit-1",
				choice: "accept_architect",
				rationale: "ok",
				decisionOwner: "ralplan-leader",
				affectedSections: ["## Contracts"],
			},
		];

		// CLI --stage_n 2 vs plannerStageN 1 (wrong pass).
		const mismatchPath = path.join(root, "stage-mismatch.json");
		await fs.writeFile(
			mismatchPath,
			JSON.stringify({
				schema: "ralplan.review_conflicts.v1",
				plannerStageN: 1,
				findings,
				dispositions,
			}),
		);
		const mismatch = await runNativeRalplanCommand(
			["--write", "--stage", "disposition", "--stage_n", "2", "--artifact", mismatchPath, "--run-id", runId],
			root,
		);
		expect(mismatch.status).toBe(2);
		expect(mismatch.stderr).toMatch(/plannerStageN=1 does not match CLI --stage_n=2/);

		// Spoofed receipt path/hash not in index.
		const spoofPath = path.join(root, "spoofed-receipt.json");
		await fs.writeFile(
			spoofPath,
			JSON.stringify({
				schema: "ralplan.review_conflicts.v1",
				plannerStageN: 1,
				findings: [
					{
						...findings[0],
						sourceReceipt: {
							stage: "architect",
							stageN: 1,
							path: "/tmp/spoofed-architect.md",
							sha256: "deadbeef",
						},
					},
					findings[1],
				],
				dispositions,
			}),
		);
		const spoofed = await runNativeRalplanCommand(
			["--write", "--stage", "disposition", "--stage_n", "1", "--artifact", spoofPath, "--run-id", runId],
			root,
		);
		expect(spoofed.status).toBe(2);
		expect(spoofed.stderr).toMatch(/does not match indexed architect stage 1/);
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
			["intent", "2"],
			["architect", "3"],
			["critic", "4"],
			["revision", "5"],
			["post-interview", "6"],
			["adr", "7"],
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
	it("uses one pre-persist ledger snapshot without claiming cross-process exclusivity", async () => {
		const root = await tempDir();
		const runId = "sequential-snapshot";
		const indexPath = path.join(ralplanRunDir(root, runId), "index.jsonl");
		const artifactPath = path.join(ralplanRunDir(root, runId), "stage-01-planner.md");
		const originalReadFile = fs.readFile;
		let prePersistLedgerReads = 0;
		const readSpy = spyOn(fs, "readFile").mockImplementation(async (...args: any[]) => {
			const target = typeof args[0] === "string" ? args[0] : String(args[0]);
			if (path.resolve(target) === indexPath && !existsSync(artifactPath)) prePersistLedgerReads += 1;
			return await (originalReadFile as (...readArgs: any[]) => Promise<any>)(...args);
		});
		try {
			// One invocation only: the documented sequence is intentionally not a
			// cross-process admission claim, lock, or CAS test.
			const result = await writeRalplanArtifact(root, runId, "planner", 1, "# plan");
			expect(result.status).toBe(0);
		} finally {
			readSpy.mockRestore();
		}
		expect(prePersistLedgerReads).toBe(1);
	});
});

describe("native gjc ralplan runtime — persisted role-agent state", () => {
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

	it("records review-lane ids in run state and echoes per-lane state", async () => {
		const root = await tempDir();
		const architect = await runNativeRalplanCommand(
			[
				"--write",
				"--stage",
				"architect",
				"--stage_n",
				"1",
				"--artifact",
				"# Architecture review",
				"--run-id",
				"persisted-review-roles",
				"--architect-id",
				"0-Architect",
				"--architect-resumable",
				"true",
				"--json",
			],
			root,
		);
		expect(architect.status).toBe(0);
		expect(JSON.parse(architect.stdout ?? "{}").architect_state).toEqual({
			architect_id: "0-Architect",
			architect_resumable: true,
		});

		const critic = await runNativeRalplanCommand(
			[
				"--write",
				"--stage",
				"critic",
				"--stage_n",
				"1",
				"--artifact",
				"# Critic review",
				"--run-id",
				"persisted-review-roles",
				"--critic-id",
				"0-Critic",
				"--json",
			],
			root,
		);
		expect(critic.status).toBe(0);
		expect(JSON.parse(critic.stdout ?? "{}").critic_state).toEqual({ critic_id: "0-Critic" });

		const state = await readState(root);
		expect(state.architect_id).toBe("0-Architect");
		expect(state.architect_resumable).toBe(true);
		expect(state.critic_id).toBe("0-Critic");
		expect("critic_resumable" in state).toBe(false);
	});

	it("rejects reviewer metadata on the wrong review stage with exit 2", async () => {
		const root = await tempDir();
		const architectOnCritic = await runNativeRalplanCommand(
			[
				"--write",
				"--stage",
				"critic",
				"--stage_n",
				"1",
				"--artifact",
				"x",
				"--run-id",
				"wrong-architect-stage",
				"--architect-id",
				"0-Architect",
			],
			root,
		);
		expect(architectOnCritic.status).toBe(2);
		expect(architectOnCritic.stderr).toContain("--architect-id is only valid with --stage architect");

		const criticOnArchitect = await runNativeRalplanCommand(
			[
				"--write",
				"--stage",
				"architect",
				"--stage_n",
				"1",
				"--artifact",
				"x",
				"--run-id",
				"wrong-critic-stage",
				"--critic-resumable",
				"false",
			],
			root,
		);
		expect(criticOnArchitect.status).toBe(2);
		expect(criticOnArchitect.stderr).toContain("--critic-resumable is only valid with --stage critic");
	});

	it("rejects invalid review-lane ids and resumable values with exit 2", async () => {
		const root = await tempDir();
		const invalidArchitectId = await runNativeRalplanCommand(
			[
				"--write",
				"--stage",
				"architect",
				"--stage_n",
				"1",
				"--artifact",
				"x",
				"--run-id",
				"invalid-architect-id",
				"--architect-id",
				"invalid id",
			],
			root,
		);
		expect(invalidArchitectId.status).toBe(2);
		expect(invalidArchitectId.stderr).toContain("invalid --architect-id");

		const invalidCriticResumable = await runNativeRalplanCommand(
			[
				"--write",
				"--stage",
				"critic",
				"--stage_n",
				"1",
				"--artifact",
				"x",
				"--run-id",
				"invalid-critic-resumable",
				"--critic-resumable",
				"maybe",
			],
			root,
		);
		expect(invalidCriticResumable.status).toBe(2);
		expect(invalidCriticResumable.stderr).toContain("invalid --critic-resumable");
	});

	it("records fallback metadata on a critic write", async () => {
		const root = await tempDir();
		const result = await runNativeRalplanCommand(
			[
				"--write",
				"--stage",
				"critic",
				"--stage_n",
				"2",
				"--artifact",
				"# Fresh critic review",
				"--run-id",
				"critic-fallback",
				"--critic-id",
				"1-CriticFresh",
				"--critic-resumable",
				"false",
				"--fallback-reason",
				"context_unavailable",
				"--fallback-attempted-id",
				"0-CriticOld",
				"--fallback-stage-n",
				"2",
				"--fallback-receipt-path",
				".gjc/plans/ralplan/critic-fallback/stage-02-critic.md",
				"--json",
			],
			root,
		);
		expect(result.status).toBe(0);
		expect(JSON.parse(result.stdout ?? "{}").critic_state).toEqual({
			critic_id: "1-CriticFresh",
			critic_resumable: false,
			critic_fallback_reason: "context_unavailable",
			critic_fallback_attempted_id: "0-CriticOld",
			critic_fallback_stage_n: 2,
			critic_fallback_receipt_path: ".gjc/plans/ralplan/critic-fallback/stage-02-critic.md",
		});
		const state = await readState(root);
		expect(state.critic_id).toBe("1-CriticFresh");
		expect(state.critic_resumable).toBe(false);
		expect(state.critic_fallback_reason).toBe("context_unavailable");
		expect(state.critic_fallback_attempted_id).toBe("0-CriticOld");
		expect(state.critic_fallback_stage_n).toBe(2);
		expect(state.critic_fallback_receipt_path).toBe(".gjc/plans/ralplan/critic-fallback/stage-02-critic.md");
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
describe("ralplan automatic handoff admission (#3398)", () => {
	it("defaults to off when project and user config.yml files are absent", async () => {
		const root = await tempDir();
		const userDir = await tempDir();
		const previousAgentDir = getAgentDir();
		const previousAgentOverride = process.env.GJC_CODING_AGENT_DIR;
		try {
			setAgentDir(userDir);
			expect(await resolveRalplanAutoHandoff(root)).toEqual({
				configuredTarget: "off",
				effectiveTarget: "off",
				degradationReason: null,
				source: "default",
			});
		} finally {
			setAgentDir(previousAgentDir);
			if (previousAgentOverride === undefined) delete process.env.GJC_CODING_AGENT_DIR;
			else process.env.GJC_CODING_AGENT_DIR = previousAgentOverride;
		}
	});

	it("rejects malformed project config.yml rather than falling through to user config.yml", async () => {
		const root = await tempDir();
		const userDir = await tempDir();
		const projectPath = path.join(root, ".gjc", "config.yml");
		const previousAgentDir = getAgentDir();
		const previousAgentOverride = process.env.GJC_CODING_AGENT_DIR;
		try {
			setAgentDir(userDir);
			await fs.writeFile(
				path.join(userDir, "config.yml"),
				YAML.stringify({ gjc: { ralplan: { autoHandoff: "ultragoal" } } }, null, 2),
				"utf-8",
			);
			await fs.mkdir(path.dirname(projectPath), { recursive: true });
			await fs.writeFile(projectPath, "{invalid: [yaml", "utf-8");

			await expect(resolveRalplanAutoHandoff(root)).rejects.toThrow(
				`invalid ralplan settings at ${projectPath}: malformed YAML`,
			);
		} finally {
			setAgentDir(previousAgentDir);
			if (previousAgentOverride === undefined) delete process.env.GJC_CODING_AGENT_DIR;
			else process.env.GJC_CODING_AGENT_DIR = previousAgentOverride;
		}
	});

	it("rejects malformed agent config.yml instead of treating automatic handoff as off", async () => {
		const root = await tempDir();
		const home = await tempDir();
		const configDir = ".test-gjc";
		const agentDir = await tempDir();
		const agentConfigPath = path.join(agentDir, "config.yml");
		await fs.mkdir(path.dirname(agentConfigPath), { recursive: true });
		await fs.writeFile(agentConfigPath, "{invalid: [yaml", "utf-8");

		const proc = Bun.spawn([process.execPath, CONFIG_ROOT_CONFIG_PROBE, "--ralplan-auto-handoff"], {
			cwd: root,
			env: { ...process.env, HOME: home, GJC_CONFIG_DIR: configDir, GJC_CODING_AGENT_DIR: agentDir },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);

		expect(await proc.exited).not.toBe(0);
		expect(stderr).toContain(`invalid ralplan settings at ${agentConfigPath}: malformed YAML`);
	});
	it("rejects an invalid configured automatic handoff target in project config.yml", async () => {
		const root = await tempDir();
		const projectPath = path.join(root, ".gjc", "config.yml");
		await fs.mkdir(path.dirname(projectPath), { recursive: true });
		await fs.writeFile(projectPath, YAML.stringify({ gjc: { ralplan: { autoHandoff: "later" } } }, null, 2), "utf-8");

		await expect(resolveRalplanAutoHandoff(root)).rejects.toThrow(
			`invalid ralplan settings at ${projectPath}: expected gjc.ralplan.autoHandoff to be one of off, ultragoal`,
		);
	});
	it("rejects invalid final admission config before writing final artifacts", async () => {
		const root = await tempDir();
		await fs.mkdir(path.join(root, ".gjc"), { recursive: true });
		await fs.writeFile(
			path.join(root, ".gjc", "config.yml"),
			YAML.stringify({ gjc: { ralplan: { autoHandoff: "later" } } }, null, 2),
			"utf-8",
		);

		const result = await writeRalplanArtifact(root, "invalid-final-admission", "final", 1, "# final");
		expect(result.status).toBe(2);
		expect(existsSync(ralplanPlanPath(root, "invalid-final-admission", "stage-01-final.md"))).toBe(false);
		expect(existsSync(ralplanPlanPath(root, "invalid-final-admission", "pending-approval.md"))).toBe(false);
		expect(existsSync(ralplanPlanPath(root, "invalid-final-admission", "index.jsonl"))).toBe(false);
	});
	it("resolves ultragoal and a usable team target from project config.yml", async () => {
		const root = await tempDir();
		await fs.mkdir(path.join(root, ".gjc"), { recursive: true });
		await fs.writeFile(
			path.join(root, ".gjc", "config.yml"),
			YAML.stringify({ gjc: { ralplan: { autoHandoff: "ultragoal" } } }, null, 2),
			"utf-8",
		);
		expect(await resolveRalplanAutoHandoff(root)).toMatchObject({
			configuredTarget: "ultragoal",
			effectiveTarget: "ultragoal",
			source: path.join(root, ".gjc", "config.yml"),
		});
	});

	it("persists a final admission and returns it on an identical final dedupe", async () => {
		const root = await tempDir();
		await fs.mkdir(path.join(root, ".gjc"), { recursive: true });
		await fs.writeFile(
			path.join(root, ".gjc", "config.yml"),
			YAML.stringify({ gjc: { ralplan: { autoHandoff: "ultragoal" } } }, null, 2),
			"utf-8",
		);
		const args = ["--write", "--stage", "final", "--stage_n", "1", "--artifact", "# final", "--json"];
		const first = await runNativeRalplanCommand(args, root);
		const second = await runNativeRalplanCommand(args, root);
		expect(JSON.parse(first.stdout ?? "{}").auto_handoff).toMatchObject({
			configuredTarget: "ultragoal",
			effectiveTarget: "ultragoal",
		});
		expect(JSON.parse(second.stdout ?? "{}")).toMatchObject({
			deduplicated: true,
			auto_handoff: { configuredTarget: "ultragoal", effectiveTarget: "ultragoal" },
		});
		const state = JSON.parse(await fs.readFile(ralplanStatePath(root), "utf-8"));
		expect(state.auto_handoff).toMatchObject({ configuredTarget: "ultragoal", effectiveTarget: "ultragoal" });
		expect((await readRalplanHudChips(root)).find(chip => chip.label === "handoff")).toMatchObject({
			value: "ultragoal→ultragoal",
		});
	});
	it("overlays a later durable PLANNING-STUCK marker on final dedupe", async () => {
		const root = await tempDir();
		const runId = "final-then-stuck";
		await fs.mkdir(path.join(root, ".gjc"), { recursive: true });
		await fs.writeFile(
			path.join(root, ".gjc", "config.yml"),
			YAML.stringify({ gjc: { ralplan: { autoHandoff: "ultragoal", maxIterations: 1 } } }, null, 2),
			"utf-8",
		);

		expect((await writeRalplanArtifact(root, runId, "final", 1, "# final")).status).toBe(0);
		expect((await writeRalplanArtifact(root, runId, "planner", 1, "# plan")).status).toBe(3);
		expect((await writeRalplanArtifact(root, runId, "revision", 2, "# blocked")).status).toBe(3);

		const deduplicated = JSON.parse((await writeRalplanArtifact(root, runId, "final", 1, "# final")).stdout ?? "{}");
		expect(deduplicated).toMatchObject({
			deduplicated: true,
			auto_handoff: {
				configuredTarget: "ultragoal",
				effectiveTarget: "off",
				degradationReason: "planning_stuck",
			},
		});
	});
	it("uses the final ledger admission after state loss and config changes", async () => {
		const root = await tempDir();
		const runId = "durable-final-admission";
		await fs.mkdir(path.join(root, ".gjc"), { recursive: true });
		await fs.writeFile(
			path.join(root, ".gjc", "config.yml"),
			YAML.stringify({ gjc: { ralplan: { autoHandoff: "ultragoal" } } }, null, 2),
			"utf-8",
		);
		expect((await writeRalplanArtifact(root, runId, "final", 1, "# final")).status).toBe(0);

		await fs.rm(ralplanStatePath(root));
		expect((await writeRalplanArtifact(root, "another-run", "planner", 1, "# other")).status).toBe(0);
		await fs.writeFile(
			path.join(root, ".gjc", "config.yml"),
			YAML.stringify({ gjc: { ralplan: { autoHandoff: "off" } } }, null, 2),
			"utf-8",
		);
		const retry = JSON.parse((await writeRalplanArtifact(root, runId, "final", 1, "# final")).stdout ?? "{}");
		expect(retry).toMatchObject({
			deduplicated: true,
			auto_handoff: { configuredTarget: "ultragoal", effectiveTarget: "ultragoal" },
		});
	});

	it("makes persisted PLANNING-STUCK dominate automatic handoff", async () => {
		const root = await tempDir();
		await fs.mkdir(path.join(root, ".gjc"), { recursive: true });
		await fs.writeFile(
			path.join(root, ".gjc", "config.yml"),
			YAML.stringify({ gjc: { ralplan: { autoHandoff: "ultragoal", maxIterations: 1 } } }, null, 2),
			"utf-8",
		);
		expect((await writeRalplanArtifact(root, "stuck-ledger", "planner", 1, "# plan")).status).toBe(0);
		expect((await writeRalplanArtifact(root, "stuck-ledger", "revision", 2, "# blocked")).status).toBe(3);
		await fs.rm(ralplanStatePath(root));
		const final = JSON.parse(
			(await writeRalplanArtifact(root, "stuck-ledger", "final", 2, "# best effort")).stdout ?? "{}",
		);
		expect(final.auto_handoff).toMatchObject({
			configuredTarget: "ultragoal",
			effectiveTarget: "off",
			degradationReason: "planning_stuck",
		});
		expect((await readRalplanHudChips(root)).find(chip => chip.label === "handoff")).toMatchObject({
			value: "ultragoal→off:planning_stuck",
			severity: "blocked",
		});
	});
	it("fails closed when an existing ledger cannot be read for automatic handoff", async () => {
		const root = await tempDir();
		const runId = "unreadable-handoff-ledger";
		const indexPath = path.join(ralplanRunDir(root, runId), "index.jsonl");
		await fs.mkdir(path.join(root, ".gjc"), { recursive: true });
		await fs.writeFile(
			path.join(root, ".gjc", "config.yml"),
			YAML.stringify({ gjc: { ralplan: { autoHandoff: "ultragoal" } } }, null, 2),
			"utf-8",
		);
		expect((await writeRalplanArtifact(root, runId, "planner", 1, "# plan")).status).toBe(0);

		const originalReadFile = fs.readFile;
		let indexReads = 0;
		const injectedError = Object.assign(new Error("EIO: injected unreadable ledger"), { code: "EIO" });
		const readSpy = spyOn(fs, "readFile").mockImplementation(async (...args: any[]) => {
			const target = typeof args[0] === "string" ? args[0] : String(args[0]);
			if (path.resolve(target) === indexPath && ++indexReads === 2) throw injectedError;
			return await (originalReadFile as (...readArgs: any[]) => Promise<any>)(...args);
		});
		try {
			const final = JSON.parse(
				(await writeRalplanArtifact(root, runId, "final", 2, "# best effort")).stdout ?? "{}",
			);
			expect(final.auto_handoff).toMatchObject({
				configuredTarget: "ultragoal",
				effectiveTarget: "off",
				degradationReason: "planning_stuck",
			});
		} finally {
			readSpy.mockRestore();
		}
		expect(indexReads).toBeGreaterThanOrEqual(2);
	});
});
describe("ralplan consensus iteration cap (#3165)", () => {
	it("evaluateRalplanIterationCap allows openers up to max and rejects the next", () => {
		const rows = [
			{ stage: "planner", stageN: 1 },
			{ stage: "architect", stageN: 1 },
			{ stage: "critic", stageN: 1 },
			{ stage: "revision", stageN: 2 },
			{ stage: "revision", stageN: 3 },
			{ stage: "revision", stageN: 4 },
			{ stage: "revision", stageN: 5 },
		];
		expect(evaluateRalplanIterationCap({ rows, stage: "revision" })).toMatchObject({
			allowed: false,
			currentIterations: 5,
			projectedIterations: 6,
			maxIterations: RALPLAN_DEFAULT_MAX_ITERATIONS,
		});
		expect(evaluateRalplanIterationCap({ rows, stage: "final" }).allowed).toBe(true);
		expect(evaluateRalplanIterationCap({ rows, stage: "architect" }).allowed).toBe(true);
		expect(
			evaluateRalplanIterationCap({
				rows: [{ stage: "planner", stageN: 1 }],
				stage: "revision",
				maxIterations: 2,
			}).allowed,
		).toBe(true);
		expect(
			evaluateRalplanIterationCap({
				rows: [
					{ stage: "planner", stageN: 1 },
					{ stage: "revision", stageN: 2 },
				],
				stage: "revision",
				maxIterations: 2,
			}).allowed,
		).toBe(false);
		// Floor from on-disk openers wins over an empty/under-counted index.
		expect(
			evaluateRalplanIterationCap({
				rows: [],
				stage: "revision",
				maxIterations: 5,
				iterationFloor: 5,
			}),
		).toMatchObject({
			allowed: false,
			currentIterations: 5,
			projectedIterations: 6,
		});
		expect(
			evaluateRalplanIterationCap({
				rows: [{ stage: "planner", stageN: 1 }],
				stage: "revision",
				maxIterations: 5,
				iterationFloor: 3,
			}).allowed,
		).toBe(true);
	});

	it("rejects a 6th revision opener with PLANNING-STUCK and still allows final", async () => {
		const root = await tempDir();
		await seedProjectRalplanMaxIterations(root);
		const runId = "cap-run";
		const write = async (stage: string, stageN: number, body: string) =>
			runNativeRalplanCommand(
				["--write", "--stage", stage, "--stage_n", String(stageN), "--artifact", body, "--run-id", runId, "--json"],
				root,
			);

		expect((await write("planner", 1, "# p1")).status).toBe(0);
		expect((await write("architect", 1, "# a1")).status).toBe(0);
		expect((await write("critic", 1, "Verdict: ITERATE")).status).toBe(0);
		for (let n = 2; n <= 5; n++) {
			expect((await write("revision", n, `# r${n}`)).status).toBe(0);
			expect((await write("architect", n, `# a${n}`)).status).toBe(0);
			expect((await write("critic", n, "Verdict: ITERATE")).status).toBe(0);
		}

		const stuck = await write("revision", 6, "# r6 perpetual iterate");
		expect(stuck.status).toBe(3);
		expect(stuck.stdout).toContain(PLANNING_STUCK_MARKER);
		expect(stuck.stderr).toContain(PLANNING_STUCK_MARKER);
		const payload = JSON.parse(stuck.stdout ?? "{}");
		expect(payload).toMatchObject({
			ok: false,
			planning_stuck: true,
			marker: PLANNING_STUCK_MARKER,
			max_iterations: 5,
			projected_iteration: 6,
		});

		const final = await write("final", 6, "# best effort pending approval");
		expect(final.status).toBe(0);
		expect(final.stdout).toContain("pending_approval_path");
	});

	it("honors project config.yml maxIterations=2 and resets budget on new run_id", async () => {
		const root = await tempDir();
		await fs.mkdir(path.join(root, ".gjc"), { recursive: true });
		await fs.writeFile(
			path.join(root, ".gjc", "config.yml"),
			YAML.stringify({ gjc: { ralplan: { maxIterations: 2 } } }, null, 2),
			"utf-8",
		);

		const write = async (runId: string, stage: string, stageN: number, body: string) =>
			runNativeRalplanCommand(
				["--write", "--stage", stage, "--stage_n", String(stageN), "--artifact", body, "--run-id", runId, "--json"],
				root,
			);

		expect((await write("run-a", "planner", 1, "# p")).status).toBe(0);
		expect((await write("run-a", "revision", 2, "# r2")).status).toBe(0);
		const stuck = await write("run-a", "revision", 3, "# r3");
		expect(stuck.status).toBe(3);
		expect(JSON.parse(stuck.stdout ?? "{}").max_iterations).toBe(2);

		// Fresh run_id must not inherit the stuck budget.
		expect((await write("run-b", "planner", 1, "# p-b")).status).toBe(0);
		expect((await write("run-b", "revision", 2, "# r2-b")).status).toBe(0);
	});

	it("dedupes an identical revision write at the cap without PLANNING-STUCK", async () => {
		const root = await tempDir();
		const runId = "dedupe-cap";
		const write = async (stage: string, stageN: number, body: string) =>
			runNativeRalplanCommand(
				["--write", "--stage", stage, "--stage_n", String(stageN), "--artifact", body, "--run-id", runId, "--json"],
				root,
			);

		expect((await write("planner", 1, "# p")).status).toBe(0);
		for (let n = 2; n <= 5; n++) {
			expect((await write("revision", n, `# r${n}`)).status).toBe(0);
		}
		const first = await write("revision", 5, "# r5");
		expect(first.status).toBe(0);
		const payload = JSON.parse(first.stdout ?? "{}");
		expect(payload.deduplicated).toBe(true);
		expect(payload.planning_stuck).toBeUndefined();
	});
	it("fails closed when index.jsonl is emptied after max openers (ledger wipe)", async () => {
		const root = await tempDir();
		await seedProjectRalplanMaxIterations(root);
		const runId = "wipe-cap";
		const write = async (stage: string, stageN: number, body: string) =>
			runNativeRalplanCommand(
				["--write", "--stage", stage, "--stage_n", String(stageN), "--artifact", body, "--run-id", runId, "--json"],
				root,
			);

		expect((await write("planner", 1, "# p")).status).toBe(0);
		for (let n = 2; n <= 5; n++) {
			expect((await write("revision", n, `# r${n}`)).status).toBe(0);
		}

		const indexPath = path.join(ralplanRunDir(root, runId), "index.jsonl");
		await fs.writeFile(indexPath, "", "utf-8");

		const stuck = await write("revision", 6, "# after wipe");
		expect(stuck.status).toBe(3);
		const payload = JSON.parse(stuck.stdout ?? "{}");
		expect(payload.planning_stuck).toBe(true);
		expect(payload.reason).toContain("on-disk openers");
		// Non-openers still escalate after untrusted ledger.
		expect((await write("final", 6, "# final after wipe")).status).toBe(0);
	});

	it("fails closed when index.jsonl is truncated under on-disk openers", async () => {
		const root = await tempDir();
		await seedProjectRalplanMaxIterations(root);
		const runId = "trunc-cap";
		const write = async (stage: string, stageN: number, body: string) =>
			runNativeRalplanCommand(
				["--write", "--stage", stage, "--stage_n", String(stageN), "--artifact", body, "--run-id", runId, "--json"],
				root,
			);

		expect((await write("planner", 1, "# p")).status).toBe(0);
		for (let n = 2; n <= 5; n++) {
			expect((await write("revision", n, `# r${n}`)).status).toBe(0);
		}

		const indexPath = path.join(ralplanRunDir(root, runId), "index.jsonl");
		const full = await fs.readFile(indexPath, "utf-8");
		const firstLine = full.split(/\r?\n/).find(line => line.trim().length > 0) ?? "";
		await fs.writeFile(indexPath, `${firstLine}\n`, "utf-8");

		const stuck = await write("revision", 6, "# after truncate");
		expect(stuck.status).toBe(3);
		expect(JSON.parse(stuck.stdout ?? "{}").planning_stuck).toBe(true);
	});

	it("fails closed when index.jsonl is only malformed lines while openers exist on disk", async () => {
		const root = await tempDir();
		await seedProjectRalplanMaxIterations(root);
		const runId = "malformed-cap";
		const write = async (stage: string, stageN: number, body: string) =>
			runNativeRalplanCommand(
				["--write", "--stage", stage, "--stage_n", String(stageN), "--artifact", body, "--run-id", runId, "--json"],
				root,
			);

		expect((await write("planner", 1, "# p")).status).toBe(0);
		for (let n = 2; n <= 5; n++) {
			expect((await write("revision", n, `# r${n}`)).status).toBe(0);
		}

		const indexPath = path.join(ralplanRunDir(root, runId), "index.jsonl");
		await fs.writeFile(indexPath, '{not-json\nnot a row\n{"stage":1}\n', "utf-8");

		const stuck = await write("revision", 6, "# after malformed");
		expect(stuck.status).toBe(3);
		expect(JSON.parse(stuck.stdout ?? "{}").planning_stuck).toBe(true);
		// architect/critic remain allowed (not openers)
		expect((await write("architect", 6, "# a")).status).toBe(0);
		expect((await write("critic", 6, "Verdict: ITERATE")).status).toBe(0);
	});

	it("fails closed when index is deleted but opener stage files remain", async () => {
		const root = await tempDir();
		await seedProjectRalplanMaxIterations(root);
		const runId = "delete-index-cap";
		const write = async (stage: string, stageN: number, body: string) =>
			runNativeRalplanCommand(
				["--write", "--stage", stage, "--stage_n", String(stageN), "--artifact", body, "--run-id", runId, "--json"],
				root,
			);

		expect((await write("planner", 1, "# p")).status).toBe(0);
		for (let n = 2; n <= 5; n++) {
			expect((await write("revision", n, `# r${n}`)).status).toBe(0);
		}

		await fs.rm(path.join(ralplanRunDir(root, runId), "index.jsonl"), { force: true });

		const stuck = await write("revision", 6, "# after delete index");
		expect(stuck.status).toBe(3);
		expect(JSON.parse(stuck.stdout ?? "{}").planning_stuck).toBe(true);
	});

	it("clean new run_id still allows openers after another run is ledger-stuck", async () => {
		const root = await tempDir();
		await seedProjectRalplanMaxIterations(root);
		const write = async (runId: string, stage: string, stageN: number, body: string) =>
			runNativeRalplanCommand(
				["--write", "--stage", stage, "--stage_n", String(stageN), "--artifact", body, "--run-id", runId, "--json"],
				root,
			);

		expect((await write("run-old", "planner", 1, "# p")).status).toBe(0);
		for (let n = 2; n <= 5; n++) {
			expect((await write("run-old", "revision", n, `# r${n}`)).status).toBe(0);
		}
		await fs.writeFile(path.join(ralplanRunDir(root, "run-old"), "index.jsonl"), "", "utf-8");
		expect((await write("run-old", "revision", 6, "# stuck")).status).toBe(3);

		// Fresh run is independent even while the old run remains at cap under wipe.
		expect((await write("run-new", "planner", 1, "# p-new")).status).toBe(0);
		expect((await write("run-new", "revision", 2, "# r2-new")).status).toBe(0);
	});
});

describe("ralplan review lane budget", () => {
	it("enforces independent per-lane passes, resets on a revision, and defaults invalid overrides", () => {
		const initialArchitect = evaluateRalplanReviewLaneBudget({ rows: [], stage: "architect" });
		const initialCritic = evaluateRalplanReviewLaneBudget({ rows: [], stage: "critic" });
		expect(initialArchitect).toMatchObject({
			allowed: true,
			lane: "architect",
			currentPasses: 0,
			projectedPasses: 1,
			maxReviewPassesPerLane: RALPLAN_DEFAULT_MAX_REVIEW_PASSES_PER_LANE,
		});
		expect(initialCritic.allowed).toBe(true);

		const firstIteration = [
			{ stage: "planner", stageN: 1 },
			{ stage: "architect", stageN: 2 },
		];
		expect(evaluateRalplanReviewLaneBudget({ rows: firstIteration, stage: "architect" })).toMatchObject({
			allowed: false,
			lane: "architect",
			currentPasses: 1,
			projectedPasses: 2,
		});
		expect(evaluateRalplanReviewLaneBudget({ rows: firstIteration, stage: "critic" })).toMatchObject({
			allowed: true,
			lane: "critic",
			currentPasses: 0,
		});

		const afterRevision = [...firstIteration, { stage: "revision", stageN: 3 }];
		expect(evaluateRalplanReviewLaneBudget({ rows: afterRevision, stage: "architect" })).toMatchObject({
			allowed: true,
			currentPasses: 0,
			projectedPasses: 1,
		});
		for (const stage of ["planner", "revision", "post-interview", "adr", "final"]) {
			expect(evaluateRalplanReviewLaneBudget({ rows: firstIteration, stage })).toMatchObject({
				allowed: true,
				finalSlot: false,
			});
		}

		const overrideRows = [...firstIteration, { stage: "architect", stageN: 3 }];
		expect(
			evaluateRalplanReviewLaneBudget({ rows: firstIteration, stage: "architect", maxReviewPassesPerLane: 2 }),
		).toMatchObject({ allowed: true, projectedPasses: 2, finalSlot: true });
		expect(
			evaluateRalplanReviewLaneBudget({ rows: overrideRows, stage: "architect", maxReviewPassesPerLane: 2 }),
		).toMatchObject({ allowed: false, projectedPasses: 3, finalSlot: false });
		for (const maxReviewPassesPerLane of [0, 11, 2.5, "3"]) {
			expect(
				evaluateRalplanReviewLaneBudget({ rows: firstIteration, stage: "architect", maxReviewPassesPerLane }),
			).toMatchObject({ allowed: false, maxReviewPassesPerLane: 1 });
		}
	});

	it("fails closed from missing, malformed, and truncated lane ledgers while intact rows do not over-refuse", async () => {
		const root = await tempDir();
		const writeRunArtifact = async (runId: string, fileName: string, content = "# architect\n") => {
			const runDir = ralplanRunDir(root, runId);
			await fs.mkdir(runDir, { recursive: true });
			await fs.writeFile(path.join(runDir, fileName), content, "utf-8");
			return runDir;
		};

		await writeRunArtifact("absent", "stage-01-architect.md");
		const absent = await writeRalplanArtifact(root, "absent", "architect", 2, "# new architect");
		expect(absent.status).toBe(3);
		expect(JSON.parse(absent.stdout ?? "{}")).toMatchObject({ lane: "architect", passes: 1, projected_passes: 2 });

		for (const [runId, index] of [
			["empty", ""],
			["malformed", "{not-json\nnot a row\n"],
		] as const) {
			const runDir = await writeRunArtifact(runId, "stage-01-architect.md");
			await fs.writeFile(path.join(runDir, "index.jsonl"), index, "utf-8");
			const result = await writeRalplanArtifact(root, runId, "architect", 2, `# ${runId} retry`);
			expect(result.status).toBe(3);
			expect(JSON.parse(result.stdout ?? "{}").reason).toContain("ledger under-count");
		}

		const truncatedDir = await writeRunArtifact("truncated", "stage-02-architect.md");
		await fs.writeFile(path.join(truncatedDir, "index.jsonl"), '{"stage":"planner","stage_n":1}\n', "utf-8");
		const truncated = await writeRalplanArtifact(root, "truncated", "architect", 3, "# truncated retry");
		expect(truncated.status).toBe(3);
		expect(JSON.parse(truncated.stdout ?? "{}")).toMatchObject({ passes: 1, projected_passes: 2 });

		const mixedDir = await writeRunArtifact("mixed", "stage-02-architect.md");
		await fs.writeFile(path.join(mixedDir, "stage-03-architect.md"), "# another architect\n", "utf-8");
		await fs.writeFile(
			path.join(mixedDir, "index.jsonl"),
			'{"stage":"planner","stage_n":1}\nnot-json\n{"stage":"architect","stage_n":2}\n',
			"utf-8",
		);
		const mixed = await writeRalplanArtifact(root, "mixed", "architect", 4, "# mixed retry");
		expect(mixed.status).toBe(3);
		expect(JSON.parse(mixed.stdout ?? "{}").reason).toContain("ledger under-count");

		const intactRows = [
			{ stage: "planner", stageN: 1 },
			{ stage: "architect", stageN: 2 },
			{ stage: "revision", stageN: 3 },
			{ stage: "architect", stageN: 4 },
		];
		expect(
			evaluateRalplanReviewLaneBudget({
				rows: intactRows,
				stage: "architect",
				onDiskLaneCounts: { architect: 2, critic: 0 },
			}),
		).toMatchObject({ allowed: false, currentPasses: 1, projectedPasses: 2 });
	});

	it("fails visibly instead of admitting a lane pass when the on-disk floor cannot be read", async () => {
		const root = await tempDir();
		const runId = "lane-floor-readdir-failure";
		const runDir = ralplanRunDir(root, runId);
		const indexPath = path.join(runDir, "index.jsonl");
		const nextArtifactPath = path.join(runDir, "stage-02-architect.md");
		const indexBefore = '{"stage":"planner","stage_n":1}\n';
		await fs.mkdir(runDir, { recursive: true });
		await fs.writeFile(path.join(runDir, "stage-01-architect.md"), "# existing architect pass\n", "utf-8");
		await fs.writeFile(indexPath, indexBefore, "utf-8");

		const injectedError = Object.assign(new Error("EIO: injected lane-floor readdir failure"), { code: "EIO" });
		const readdirSpy = spyOn(fs, "readdir").mockRejectedValue(injectedError);
		try {
			const result = await writeRalplanArtifact(root, runId, "architect", 2, "# extra architect pass");
			expect(result.status).toBe(1);
			expect(result.stderr).toContain(injectedError.message);
		} finally {
			readdirSpy.mockRestore();
		}

		expect(existsSync(nextArtifactPath)).toBe(false);
		expect(await fs.readFile(indexPath, "utf-8")).toBe(indexBefore);
	});
});

describe("ralplan crash-gap dedupe repair", () => {
	it("repairs an identical on-disk retry without consuming a second lane pass", async () => {
		const root = await tempDir();
		const runId = "repair-identical";
		const runDir = ralplanRunDir(root, runId);
		await fs.mkdir(runDir, { recursive: true });
		await fs.writeFile(path.join(runDir, "stage-02-architect.md"), "# artifact C\n", "utf-8");

		const result = await writeRalplanArtifact(root, runId, "architect", 2, "# artifact C");
		expect(result.status).toBe(0);
		const payload = JSON.parse(result.stdout ?? "{}");
		expect(payload.deduplicated).toBe(true);
		expect(payload.review_budget_warning).toBeUndefined();
		expect(result.stdout).not.toContain(PLANNING_STUCK_MARKER);
		const indexLines = (await fs.readFile(path.join(runDir, "index.jsonl"), "utf-8"))
			.trim()
			.split("\n")
			.filter(Boolean);
		expect(indexLines).toHaveLength(1);
		const repairedRow = JSON.parse(indexLines[0]);
		expect(repairedRow).toMatchObject({
			stage: "architect",
			stage_n: 2,
			path: path.join(runDir, "stage-02-architect.md"),
		});
		const repairedDecision = evaluateRalplanReviewLaneBudget({
			rows: [{ stage: repairedRow.stage, stageN: repairedRow.stage_n }],
			stage: "architect",
			onDiskLaneCounts: { architect: 1, critic: 0 },
		});
		expect(repairedDecision).toMatchObject({ currentPasses: 1, projectedPasses: 2 });
		expect(repairedDecision.ledgerNote).toBeUndefined();
	});

	it("does not apply stale critic metadata while repairing a crash gap", async () => {
		const root = await tempDir();
		const staleRunId = "stale-critic-metadata";
		const activeRunId = "active-critic-metadata";
		const staleRunDir = ralplanRunDir(root, staleRunId);
		expect((await writeRalplanArtifact(root, staleRunId, "planner", 1, "# stale plan")).status).toBe(0);
		await fs.writeFile(path.join(staleRunDir, "stage-02-critic.md"), "# stale critique\n", "utf-8");
		expect((await writeRalplanArtifact(root, activeRunId, "planner", 1, "# active plan")).status).toBe(0);
		const stateBefore = JSON.parse(await fs.readFile(ralplanStatePath(root), "utf-8"));
		expect(stateBefore.run_id).toBe(activeRunId);

		const repaired = await runNativeRalplanCommand(
			[
				"--write",
				"--stage",
				"critic",
				"--stage_n",
				"2",
				"--artifact",
				"# stale critique",
				"--run-id",
				staleRunId,
				"--critic-id",
				"0-StaleCritic",
				"--critic-resumable",
				"false",
				"--fallback-reason",
				"context_unavailable",
				"--fallback-attempted-id",
				"1-StaleCritic",
				"--fallback-stage-n",
				"2",
				"--fallback-receipt-path",
				".gjc/plans/ralplan/stale-critic-metadata/stage-02-critic.md",
				"--json",
			],
			root,
		);

		expect(repaired.status).toBe(0);
		const payload = JSON.parse(repaired.stdout ?? "{}");
		expect(payload.deduplicated).toBe(true);
		expect(payload.critic_state).toBeUndefined();
		expect(JSON.parse(await fs.readFile(ralplanStatePath(root), "utf-8"))).toEqual(stateBefore);
	});

	it("does not apply stale architect metadata while repairing a crash gap", async () => {
		const root = await tempDir();
		const staleRunId = "stale-architect-metadata";
		const activeRunId = "active-architect-metadata";
		const staleRunDir = ralplanRunDir(root, staleRunId);
		expect((await writeRalplanArtifact(root, staleRunId, "planner", 1, "# stale plan")).status).toBe(0);
		await fs.writeFile(path.join(staleRunDir, "stage-02-architect.md"), "# stale architecture\n", "utf-8");
		expect((await writeRalplanArtifact(root, activeRunId, "planner", 1, "# active plan")).status).toBe(0);
		const stateBefore = JSON.parse(await fs.readFile(ralplanStatePath(root), "utf-8"));
		expect(stateBefore.run_id).toBe(activeRunId);

		const repaired = await runNativeRalplanCommand(
			[
				"--write",
				"--stage",
				"architect",
				"--stage_n",
				"2",
				"--artifact",
				"# stale architecture",
				"--run-id",
				staleRunId,
				"--architect-id",
				"0-StaleArchitect",
				"--architect-resumable",
				"true",
				"--json",
			],
			root,
		);

		expect(repaired.status).toBe(0);
		const payload = JSON.parse(repaired.stdout ?? "{}");
		expect(payload.deduplicated).toBe(true);
		expect(payload.architect_state).toBeUndefined();
		expect(JSON.parse(await fs.readFile(ralplanStatePath(root), "utf-8"))).toEqual(stateBefore);
	});

	it("applies active critic metadata while repairing a crash gap", async () => {
		const root = await tempDir();
		const runId = "active-critic-repair";
		const runDir = ralplanRunDir(root, runId);
		expect((await writeRalplanArtifact(root, runId, "planner", 1, "# plan")).status).toBe(0);
		await fs.writeFile(path.join(runDir, "stage-02-critic.md"), "# critique\n", "utf-8");

		const repaired = await runNativeRalplanCommand(
			[
				"--write",
				"--stage",
				"critic",
				"--stage_n",
				"2",
				"--artifact",
				"# critique",
				"--run-id",
				runId,
				"--critic-id",
				"0-ActiveCritic",
				"--critic-resumable",
				"true",
				"--json",
			],
			root,
		);

		expect(repaired.status).toBe(0);
		expect(JSON.parse(repaired.stdout ?? "{}")).toMatchObject({
			deduplicated: true,
			critic_state: { critic_id: "0-ActiveCritic", critic_resumable: true },
		});
		expect(JSON.parse(await fs.readFile(ralplanStatePath(root), "utf-8"))).toMatchObject({
			run_id: runId,
			critic_id: "0-ActiveCritic",
			critic_resumable: true,
		});
	});

	it("refuses a different-content crash-gap retry without touching the artifact or ledger", async () => {
		const root = await tempDir();
		const runId = "repair-conflict";
		const runDir = ralplanRunDir(root, runId);
		const artifactPath = path.join(runDir, "stage-02-architect.md");
		await fs.mkdir(runDir, { recursive: true });
		await fs.writeFile(artifactPath, "# original\n", "utf-8");

		const result = await writeRalplanArtifact(root, runId, "architect", 2, "# different");
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("refusing to overwrite ralplan architect stage 2");
		expect(await fs.readFile(artifactPath, "utf-8")).toBe("# original\n");
		await expect(fs.readFile(path.join(runDir, "index.jsonl"), "utf-8")).rejects.toThrow();
	});

	it("fails a crash-gap probe read without replacing the artifact or ledger", async () => {
		const root = await tempDir();
		const runId = "repair-read-failure";
		const runDir = ralplanRunDir(root, runId);
		const artifactPath = path.join(runDir, "stage-02-final.md");
		const indexPath = path.join(runDir, "index.jsonl");
		const artifactBefore = "# existing final\n";
		const indexBefore = '{"stage":"planner","stage_n":1}\n';
		await fs.mkdir(runDir, { recursive: true });
		await fs.writeFile(artifactPath, artifactBefore, "utf-8");
		await fs.writeFile(indexPath, indexBefore, "utf-8");

		const originalReadFile = fs.readFile;
		const injectedError = Object.assign(new Error("EIO: injected crash-gap artifact read failure"), { code: "EIO" });
		const readSpy = spyOn(fs, "readFile").mockImplementation(async (...args: any[]) => {
			const target = typeof args[0] === "string" ? args[0] : String(args[0]);
			if (path.resolve(target) === artifactPath) throw injectedError;
			return await (originalReadFile as (...readArgs: any[]) => Promise<any>)(...args);
		});
		try {
			const result = await writeRalplanArtifact(root, runId, "final", 2, "# replacement final");
			expect(result.status).toBe(1);
			expect(result.stderr).toContain(injectedError.message);
		} finally {
			readSpy.mockRestore();
		}

		expect(await fs.readFile(artifactPath, "utf-8")).toBe(artifactBefore);
		expect(await fs.readFile(indexPath, "utf-8")).toBe(indexBefore);
	});

	it("repairs a final-stage crash gap and recreates pending-approval.md", async () => {
		const root = await tempDir();
		const runId = "repair-final-no-ledger";
		const runDir = ralplanRunDir(root, runId);
		const artifactPath = path.join(runDir, "stage-02-final.md");
		const pendingApprovalPath = path.join(runDir, "pending-approval.md");
		await fs.mkdir(runDir, { recursive: true });
		await fs.writeFile(artifactPath, "# recovered final\n", "utf-8");

		const repaired = await writeRalplanArtifact(root, runId, "final", 2, "# recovered final");
		expect(repaired.status).toBe(0);
		const repairedPayload = JSON.parse(repaired.stdout ?? "{}");
		expect(repairedPayload).toMatchObject({
			deduplicated: true,
			pending_approval_path: pendingApprovalPath,
			auto_handoff: {
				configuredTarget: "off",
				effectiveTarget: "off",
				degradationReason: "admission_unavailable",
				source: "ledger",
			},
		});
		expect(await fs.readFile(pendingApprovalPath, "utf-8")).toBe("# recovered final\n");
		const repairedRows = (await fs.readFile(path.join(runDir, "index.jsonl"), "utf-8"))
			.trim()
			.split("\n")
			.map(line => JSON.parse(line));
		expect(repairedRows).toEqual([
			expect.objectContaining({
				stage: "final",
				stage_n: 2,
				path: artifactPath,
				auto_handoff: {
					configuredTarget: "off",
					effectiveTarget: "off",
					degradationReason: "admission_unavailable",
					source: "ledger",
				},
			}),
		]);
	});

	it("recreates a missing pending approval for ledger-backed final dedupe and refuses a mismatch", async () => {
		const root = await tempDir();
		const runId = "repair-final-ledger";
		const pendingApprovalPath = ralplanPlanPath(root, runId, "pending-approval.md");
		expect((await writeRalplanArtifact(root, runId, "final", 2, "# ledger final")).status).toBe(0);
		await fs.rm(pendingApprovalPath);

		const recreated = await writeRalplanArtifact(root, runId, "final", 2, "# ledger final");
		expect(recreated.status).toBe(0);
		expect(JSON.parse(recreated.stdout ?? "{}")).toMatchObject({
			deduplicated: true,
			pending_approval_path: pendingApprovalPath,
		});
		expect(await fs.readFile(pendingApprovalPath, "utf-8")).toBe("# ledger final\n");

		await fs.writeFile(pendingApprovalPath, "# stale pending\n", "utf-8");
		const mismatch = await writeRalplanArtifact(root, runId, "final", 2, "# ledger final");
		expect(mismatch.status).toBe(2);
		expect(mismatch.stderr).toContain("pending approval content mismatch");
		expect(await fs.readFile(pendingApprovalPath, "utf-8")).toBe("# stale pending\n");
	});

	it("does not consume a raised-budget second slot while repairing a crash gap", async () => {
		const root = await tempDir();
		const runId = "repair-raised-budget";
		const runDir = ralplanRunDir(root, runId);
		await fs.mkdir(path.join(root, ".gjc"), { recursive: true });
		await fs.writeFile(
			path.join(root, ".gjc", "config.yml"),
			YAML.stringify({ gjc: { ralplan: { maxReviewPassesPerLane: 2 } } }, null, 2),
			"utf-8",
		);
		await fs.mkdir(runDir, { recursive: true });
		await fs.writeFile(path.join(runDir, "stage-02-architect.md"), "# repaired\n", "utf-8");

		expect((await writeRalplanArtifact(root, runId, "architect", 2, "# repaired")).status).toBe(0);
		const newPass = await writeRalplanArtifact(root, runId, "architect", 3, "# genuinely new");
		expect(newPass.status).toBe(0);
		expect(JSON.parse(newPass.stdout ?? "{}").review_budget_warning).toEqual({
			lane: "architect",
			passes: 2,
			max: 2,
		});
	});

	it("deduplicates a repaired short row before consuming a raised-budget slot", async () => {
		const root = await tempDir();
		const runId = "repair-short-row";
		const runDir = ralplanRunDir(root, runId);
		await fs.mkdir(path.join(root, ".gjc"), { recursive: true });
		await fs.writeFile(
			path.join(root, ".gjc", "config.yml"),
			YAML.stringify({ gjc: { ralplan: { maxReviewPassesPerLane: 2 } } }, null, 2),
			"utf-8",
		);
		await fs.mkdir(runDir, { recursive: true });
		await fs.writeFile(path.join(runDir, "stage-02-architect.md"), "# short row\n", "utf-8");
		await fs.writeFile(path.join(runDir, "index.jsonl"), '{"stage":"architect","stage_n":2}\n', "utf-8");

		const repaired = await writeRalplanArtifact(root, runId, "architect", 2, "# short row");
		expect(repaired.status).toBe(0);
		expect(JSON.parse(repaired.stdout ?? "{}").deduplicated).toBe(true);
		const repairedRows = (await fs.readFile(path.join(runDir, "index.jsonl"), "utf-8"))
			.trim()
			.split("\n")
			.map(line => JSON.parse(line));
		expect(repairedRows).toHaveLength(2);
		expect(repairedRows.filter(row => typeof row.path === "string" && typeof row.sha256 === "string")).toHaveLength(
			1,
		);
		expect(
			evaluateRalplanReviewLaneBudget({
				rows: repairedRows.map(row => ({ stage: row.stage, stageN: row.stage_n })),
				stage: "architect",
				maxReviewPassesPerLane: 2,
				onDiskLaneCounts: { architect: 1, critic: 0 },
			}),
		).toMatchObject({ allowed: true, currentPasses: 1, projectedPasses: 2, finalSlot: true });

		const newPass = await writeRalplanArtifact(root, runId, "architect", 3, "# genuinely new");
		expect(newPass.status).toBe(0);
		expect(JSON.parse(newPass.stdout ?? "{}").review_budget_warning).toEqual({
			lane: "architect",
			passes: 2,
			max: 2,
		});
		const persistedRows = (await fs.readFile(path.join(runDir, "index.jsonl"), "utf-8"))
			.trim()
			.split("\n")
			.map(line => JSON.parse(line));
		expect(persistedRows.filter(row => row.stage === "architect" && row.stage_n === 3)).toHaveLength(1);
	});
});

describe("ralplan review lane budget config.yml", () => {
	it("resolves nested config.yml with project-over-user precedence", async () => {
		const root = await tempDir();
		const userDir = await tempDir();
		const previousAgentDir = getAgentDir();
		const previousAgentOverride = process.env.GJC_CODING_AGENT_DIR;
		try {
			setAgentDir(userDir);
			await fs.writeFile(
				path.join(userDir, "config.yml"),
				YAML.stringify({ gjc: { ralplan: { maxReviewPassesPerLane: 2 } } }, null, 2),
				"utf-8",
			);
			await fs.mkdir(path.join(root, ".gjc"), { recursive: true });
			const projectPath = path.join(root, ".gjc", "config.yml");
			await fs.writeFile(
				projectPath,
				YAML.stringify({ gjc: { ralplan: { maxReviewPassesPerLane: 3 } } }, null, 2),
				"utf-8",
			);
			expect(await resolveRalplanMaxReviewPassesPerLane(root)).toEqual({
				maxReviewPassesPerLane: 3,
				source: projectPath,
			});

			await fs.writeFile(
				projectPath,
				YAML.stringify({ gjc: { ralplan: { maxReviewPassesPerLane: 4 } } }, null, 2),
				"utf-8",
			);
			expect(await resolveRalplanMaxReviewPassesPerLane(root)).toEqual({
				maxReviewPassesPerLane: 4,
				source: projectPath,
			});
		} finally {
			setAgentDir(previousAgentDir);
			if (previousAgentOverride === undefined) delete process.env.GJC_CODING_AGENT_DIR;
			else process.env.GJC_CODING_AGENT_DIR = previousAgentOverride;
		}
	});

	it("rejects malformed project config.yml instead of falling through to a user override", async () => {
		const root = await tempDir();
		const userDir = await tempDir();
		const previousAgentDir = getAgentDir();
		const previousAgentOverride = process.env.GJC_CODING_AGENT_DIR;
		try {
			setAgentDir(userDir);
			await fs.writeFile(
				path.join(userDir, "config.yml"),
				YAML.stringify({ gjc: { ralplan: { maxReviewPassesPerLane: 2 } } }, null, 2),
				"utf-8",
			);
			await fs.mkdir(path.join(root, ".gjc"), { recursive: true });
			const projectPath = path.join(root, ".gjc", "config.yml");
			await fs.writeFile(projectPath, "{invalid: [yaml", "utf-8");

			await expect(resolveRalplanMaxReviewPassesPerLane(root)).rejects.toThrow(projectPath);
		} finally {
			setAgentDir(previousAgentDir);
			if (previousAgentOverride === undefined) delete process.env.GJC_CODING_AGENT_DIR;
			else process.env.GJC_CODING_AGENT_DIR = previousAgentOverride;
		}
	});

	it("rejects an invalid present project value rather than defaulting", async () => {
		const root = await tempDir();
		const projectPath = path.join(root, ".gjc", "config.yml");
		await fs.mkdir(path.dirname(projectPath), { recursive: true });
		await fs.writeFile(
			projectPath,
			YAML.stringify({ gjc: { ralplan: { maxReviewPassesPerLane: 99 } } }, null, 2),
			"utf-8",
		);

		await expect(resolveRalplanMaxReviewPassesPerLane(root)).rejects.toThrow(projectPath);
	});
});

describe("ralplan review lane budget replays", () => {
	it("refuses only the pathological same-iteration lane retries and preserves final escalation", async () => {
		const root = await tempDir();
		await seedProjectRalplanMaxIterations(root);
		const runId = "pathological-replay";
		const sequence = [
			["planner", "planner"],
			["a1", "architect"],
			["c1", "critic"],
			["a2", "architect"],
			["rev2", "revision"],
			["c2", "critic"],
			["a3", "architect"],
			["rev3", "revision"],
			["c3", "critic"],
			["a4", "architect"],
			["rev4", "revision"],
			["c4", "critic"],
			["a5", "architect"],
			["a6", "architect"],
			["rev5", "revision"],
			["c5", "critic"],
			["a7", "architect"],
			["rev6", "revision"],
			["c6", "critic"],
			["a8", "architect"],
		] as const;
		const results = new Map<string, Awaited<ReturnType<typeof writeRalplanArtifact>>>();
		for (const [index, [label, stage]] of sequence.entries()) {
			results.set(label, await writeRalplanArtifact(root, runId, stage, index + 1, `# ${label}`));
		}
		const refusals = [...results.entries()].filter(([, result]) => result.status === 3).map(([label]) => label);
		expect(refusals).toEqual(["a2", "a6", "rev6", "c6", "a8"]);
		for (const [label, result] of results) {
			expect(result.status).toBe(refusals.includes(label) ? 3 : 0);
		}
		for (const label of ["a2", "a6", "c6", "a8"]) {
			const payload = JSON.parse(results.get(label)?.stdout ?? "{}");
			expect(payload).toMatchObject({ planning_stuck: true, marker: PLANNING_STUCK_MARKER });
			expect(["architect", "critic"]).toContain(payload.lane);
			expect(typeof payload.passes).toBe("number");
			expect(typeof payload.max_review_passes_per_lane).toBe("number");
		}
		const openerPayload = JSON.parse(results.get("rev6")?.stdout ?? "{}");
		expect(openerPayload).toMatchObject({ planning_stuck: true, max_iterations: 5, projected_iteration: 6 });

		const final = await writeRalplanArtifact(root, runId, "final", sequence.length + 1, "# best effort final");
		expect(final.status).toBe(0);
		expect(JSON.parse(final.stdout ?? "{}").pending_approval_path).toBeDefined();
	});

	it("keeps healthy t3code and browser-use shaped replays free of warnings and stuck signals", async () => {
		const root = await tempDir();
		const replay = async (runId: string, stages: readonly string[]) => {
			const results = [];
			for (const [index, stage] of stages.entries()) {
				results.push(await writeRalplanArtifact(root, runId, stage, index + 1, `# ${stage} ${index + 1}`));
			}
			return results;
		};
		const t3code = await replay("healthy-t3code", [
			"planner",
			"architect",
			"critic",
			"revision",
			"architect",
			"critic",
			"final",
		]);
		const browserUse = await replay("healthy-browser-use", ["planner", "architect", "critic", "final"]);
		for (const result of [...t3code, ...browserUse]) {
			expect(result.status).toBe(0);
			expect(result.stdout).not.toContain(PLANNING_STUCK_MARKER);
			expect(JSON.parse(result.stdout ?? "{}").review_budget_warning).toBeUndefined();
		}
	});
});

describe("ralplan review lane budget rigor and receipts", () => {
	it("does not parse or demote a justified critic blocker, while exhausted openers remain visibly stuck", async () => {
		const root = await tempDir();
		await seedProjectRalplanMaxIterations(root);
		const runId = "rigor-preserved";
		expect((await writeRalplanArtifact(root, runId, "planner", 1, "# initial plan")).status).toBe(0);
		const critic = await writeRalplanArtifact(
			root,
			runId,
			"critic",
			2,
			"Verdict: ITERATE\n\nNew blocker: a newly discovered integration boundary requires a revision.\n",
		);
		expect(critic.status).toBe(0);
		expect((await writeRalplanArtifact(root, runId, "revision", 3, "# justified revision")).status).toBe(0);
		for (let stageN = 4; stageN <= 6; stageN++) {
			expect((await writeRalplanArtifact(root, runId, "revision", stageN, `# revision ${stageN}`)).status).toBe(0);
		}
		const stuck = await writeRalplanArtifact(root, runId, "revision", 7, "# unresolved issue remains");
		expect(stuck.status).toBe(3);
		expect(stuck.stdout).toContain(PLANNING_STUCK_MARKER);
		expect(stuck.stderr).toContain(PLANNING_STUCK_MARKER);
		expect((await writeRalplanArtifact(root, runId, "final", 8, "# escalated final")).status).toBe(0);
	});

	it("warns only on a raised-budget final slot and returns lane-specific stuck receipts", async () => {
		const root = await tempDir();
		const runId = "warning-json";
		await fs.mkdir(path.join(root, ".gjc"), { recursive: true });
		await fs.writeFile(
			path.join(root, ".gjc", "config.yml"),
			YAML.stringify({ gjc: { ralplan: { maxReviewPassesPerLane: 2 } } }, null, 2),
			"utf-8",
		);
		expect((await writeRalplanArtifact(root, runId, "planner", 1, "# plan")).status).toBe(0);
		expect((await writeRalplanArtifact(root, runId, "architect", 2, "# architect one")).status).toBe(0);
		const second = await writeRalplanArtifact(root, runId, "architect", 3, "# architect two");
		expect(second.status).toBe(0);
		expect(JSON.parse(second.stdout ?? "{}").review_budget_warning).toEqual({ lane: "architect", passes: 2, max: 2 });
		const third = await writeRalplanArtifact(root, runId, "architect", 4, "# architect three");
		expect(third.status).toBe(3);
		const stuckPayload = JSON.parse(third.stdout ?? "{}");
		expect(stuckPayload).toMatchObject({
			ok: false,
			planning_stuck: true,
			marker: PLANNING_STUCK_MARKER,
			lane: "architect",
			passes: 2,
			projected_passes: 3,
			max_review_passes_per_lane: 2,
		});
		expect(stuckPayload.iteration).toBeUndefined();
		expect(stuckPayload.max_iterations).toBeUndefined();

		const textRoot = await tempDir();
		const textRunId = "warning-text";
		await fs.mkdir(path.join(textRoot, ".gjc"), { recursive: true });
		await fs.writeFile(
			path.join(textRoot, ".gjc", "config.yml"),
			YAML.stringify({ gjc: { ralplan: { maxReviewPassesPerLane: 2 } } }, null, 2),
			"utf-8",
		);
		expect((await writeRalplanArtifact(textRoot, textRunId, "planner", 1, "# plan")).status).toBe(0);
		expect((await writeRalplanArtifact(textRoot, textRunId, "architect", 2, "# architect one")).status).toBe(0);
		const textSecond = await writeRalplanArtifact(textRoot, textRunId, "architect", 3, "# architect two", false);
		expect(textSecond.status).toBe(0);
		expect(textSecond.stdout).toContain("Warning: ralplan architect review budget final slot used (2/2).");
		const textThird = await writeRalplanArtifact(textRoot, textRunId, "architect", 4, "# architect three", false);
		expect(textThird.status).toBe(3);
		expect(textThird.stdout).toBe(`${PLANNING_STUCK_MARKER}\n`);
		expect(textThird.stderr).toContain("Stop re-invoking the architect review lane");

		const defaultRoot = await tempDir();
		const defaultResult = await writeRalplanArtifact(
			defaultRoot,
			"default-no-warning",
			"architect",
			1,
			"# default pass",
		);
		expect(defaultResult.status).toBe(0);
		expect(JSON.parse(defaultResult.stdout ?? "{}").review_budget_warning).toBeUndefined();
	});
});

describe("ralplan HUD lane verdict carriage", () => {
	it("composes current-lane pass counts and the latest lane verdict", async () => {
		const root = await tempDir();
		const runId = "hud-composition";
		expect((await writeRalplanArtifact(root, runId, "planner", 1, "# plan")).status).toBe(0);

		const architect = await writeRalplanLaneVerdictArtifact(root, runId, "architect", 2, "# architecture", "BLOCK");
		expect(architect.status).toBe(0);
		expect(JSON.parse(architect.stdout ?? "{}").lane_verdict).toEqual({ lane: "architect", verdict: "BLOCK" });

		const critic = await writeRalplanLaneVerdictArtifact(root, runId, "critic", 3, "# critique", "iterate");
		expect(critic.status).toBe(0);
		expect(JSON.parse(critic.stdout ?? "{}").lane_verdict).toEqual({ lane: "critic", verdict: "ITERATE" });
		expect(JSON.parse(await fs.readFile(ralplanStatePath(root), "utf-8"))).toMatchObject({
			last_review_verdict: "ITERATE",
			last_review_verdict_lane: "critic",
			last_review_verdict_stage_n: 3,
		});

		const chips = await readRalplanHudChips(root);
		expect(chips.find(chip => chip.label === "arch")?.value).toBe("1/1");
		expect(chips.find(chip => chip.label === "crit")?.value).toBe("1/1");
		expect(chips.find(chip => chip.label === "verdict")?.value).toBe("ITERATE");
	});

	it("applies a riding lane verdict while repairing an identical crash-gap artifact", async () => {
		const root = await tempDir();
		const runId = "hud-crash-gap-verdict";
		const runDir = ralplanRunDir(root, runId);
		expect((await writeRalplanArtifact(root, runId, "planner", 1, "# plan")).status).toBe(0);
		await fs.mkdir(runDir, { recursive: true });
		await fs.writeFile(path.join(runDir, "stage-02-architect.md"), "# architecture\n", "utf-8");

		const repaired = await writeRalplanLaneVerdictArtifact(root, runId, "architect", 2, "# architecture", "WATCH");
		expect(repaired.status).toBe(0);
		expect(JSON.parse(repaired.stdout ?? "{}")).toMatchObject({
			deduplicated: true,
			lane_verdict: { lane: "architect", verdict: "WATCH" },
		});
		expect(JSON.parse(await fs.readFile(ralplanStatePath(root), "utf-8"))).toMatchObject({
			last_review_verdict: "WATCH",
			last_review_verdict_lane: "architect",
			last_review_verdict_stage_n: 2,
		});
	});

	it("does not carry a stale crash-gap lane verdict into another active run", async () => {
		const root = await tempDir();
		const staleRunId = "hud-stale-repair";
		const activeRunId = "hud-active-run";
		const staleRunDir = ralplanRunDir(root, staleRunId);
		expect((await writeRalplanArtifact(root, staleRunId, "planner", 1, "# stale plan")).status).toBe(0);
		await fs.writeFile(path.join(staleRunDir, "stage-02-architect.md"), "# stale architecture\n", "utf-8");
		expect((await writeRalplanArtifact(root, activeRunId, "planner", 1, "# active plan")).status).toBe(0);

		const repaired = await writeRalplanLaneVerdictArtifact(
			root,
			staleRunId,
			"architect",
			2,
			"# stale architecture",
			"BLOCK",
		);
		expect(repaired.status).toBe(0);
		expect(JSON.parse(repaired.stdout ?? "{}").lane_verdict).toBeUndefined();
		const state = JSON.parse(await fs.readFile(ralplanStatePath(root), "utf-8"));
		expect(state.run_id).toBe(activeRunId);
		for (const key of ["last_review_verdict", "last_review_verdict_lane", "last_review_verdict_stage_n"]) {
			expect(Object.hasOwn(state, key)).toBe(false);
		}

		const verdictlessActiveWrite = await writeRalplanArtifact(
			root,
			activeRunId,
			"architect",
			2,
			"# active architecture",
		);
		expect(verdictlessActiveWrite.status).toBe(0);
		const chips = await readRalplanHudChips(root);
		expect(chips.some(chip => chip.value === "BLOCK")).toBe(false);
		expect(chips.find(chip => chip.label === "verdict")).toBeUndefined();
	});

	it("preserves the run-state lane verdict through a state write followed by a verdict-less artifact write", async () => {
		const root = await tempDir();
		const runId = "hud-state-then-artifact";
		expect((await writeRalplanArtifact(root, runId, "planner", 1, "# plan")).status).toBe(0);
		expect(
			(await writeRalplanLaneVerdictArtifact(root, runId, "architect", 2, "# architecture", "BLOCK")).status,
		).toBe(0);
		expect(
			(
				await runNativeStateCommand(
					["write", "--mode", "ralplan", "--input", JSON.stringify({ verdict: "ITERATE" })],
					root,
				)
			).status,
		).toBe(0);
		expect((await writeRalplanArtifact(root, runId, "critic", 3, "# critique")).status).toBe(0);

		const state = JSON.parse(await fs.readFile(ralplanStatePath(root), "utf-8"));
		expect(state).toMatchObject({ last_review_verdict: "BLOCK", verdict: "ITERATE" });
		expect((await readRalplanHudChips(root)).find(chip => chip.label === "verdict")?.value).toBe("BLOCK");
	});
	it("keeps a lane verdict visible after artifact-then-state write order", async () => {
		const root = await tempDir();
		const runId = "state-after-artifact";
		expect((await writeRalplanArtifact(root, runId, "planner", 1, "# plan")).status).toBe(0);
		expect((await writeRalplanLaneVerdictArtifact(root, runId, "critic", 2, "# critique", "ITERATE")).status).toBe(0);
		expect(
			(
				await runNativeStateCommand(
					["write", "--mode", "ralplan", "--input", JSON.stringify({ marker: "after-artifact" })],
					root,
				)
			).status,
		).toBe(0);
		expect((await readRalplanHudChips(root)).find(chip => chip.label === "verdict")?.value).toBe("ITERATE");
	});

	it("prefers a run-scoped lane verdict over a stale legacy ralplan verdict", async () => {
		const root = await tempDir();
		const runId = "state-lane-precedence";
		expect((await writeRalplanArtifact(root, runId, "planner", 1, "# plan")).status).toBe(0);
		expect(
			(
				await runNativeStateCommand(
					["write", "--mode", "ralplan", "--input", JSON.stringify({ verdict: "ITERATE" })],
					root,
				)
			).status,
		).toBe(0);
		expect((await writeRalplanLaneVerdictArtifact(root, runId, "critic", 2, "# critique", "OKAY")).status).toBe(0);
		expect(
			(
				await runNativeStateCommand(
					["write", "--mode", "ralplan", "--input", JSON.stringify({ marker: "verdict-less" })],
					root,
				)
			).status,
		).toBe(0);

		const state = JSON.parse(await fs.readFile(ralplanStatePath(root), "utf-8"));
		expect(state).toMatchObject({ verdict: "ITERATE", last_review_verdict: "OKAY" });
		const verdict = (await readRalplanHudChips(root)).find(chip => chip.label === "verdict");
		expect(verdict?.value).toBe("OKAY");
		expect(verdict?.severity).toBe("success");
	});

	it("uses the resolved per-lane budget as the review-pass denominator", async () => {
		const root = await tempDir();
		const runId = "hud-budget-denominator";
		await fs.mkdir(path.join(root, ".gjc"), { recursive: true });
		await fs.writeFile(
			path.join(root, ".gjc", "config.yml"),
			YAML.stringify({ gjc: { ralplan: { maxReviewPassesPerLane: 3 } } }, null, 2),
			"utf-8",
		);
		expect((await writeRalplanArtifact(root, runId, "planner", 1, "# plan")).status).toBe(0);
		expect(
			(await writeRalplanLaneVerdictArtifact(root, runId, "architect", 2, "# architecture", "CLEAR")).status,
		).toBe(0);
		expect((await readRalplanHudChips(root)).find(chip => chip.label === "arch")?.value).toBe("1/3");
	});

	it("keeps artifact HUDs within six chips and omits lane counts on the final path", async () => {
		const root = await tempDir();
		const runId = "hud-chip-cap";
		expect((await writeRalplanArtifact(root, runId, "planner", 1, "# plan")).status).toBe(0);
		expect(
			(await writeRalplanLaneVerdictArtifact(root, runId, "architect", 2, "# architecture", "CLEAR")).status,
		).toBe(0);
		expect((await writeRalplanLaneVerdictArtifact(root, runId, "critic", 3, "# critique", "OKAY")).status).toBe(0);
		const reviewChips = await readRalplanHudChips(root);
		expect(reviewChips).toHaveLength(6);
		expect(reviewChips.map(chip => chip.label)).toEqual(["stage", "iter", "stages", "arch", "crit", "verdict"]);

		const final = await writeRalplanArtifact(root, runId, "final", 4, "# final");
		expect(final.status).toBe(0);
		expect(JSON.parse(final.stdout ?? "{}").auto_handoff).toMatchObject({
			configuredTarget: "off",
			effectiveTarget: "off",
			degradationReason: null,
		});
		const finalChips = await readRalplanHudChips(root);
		expect(finalChips.length).toBeLessThanOrEqual(6);
		expect(finalChips.map(chip => chip.label)).toEqual(["pending", "stage", "iter", "stages", "verdict", "handoff"]);
		expect(finalChips.find(chip => chip.label === "handoff")?.value).toBe("off→off");
	});

	it("rejects invalid, wrong-lane, and non-lane --lane-verdict values", async () => {
		const root = await tempDir();
		const write = async (stage: string, verdict: string) =>
			await runNativeRalplanCommand(
				[
					"--write",
					"--stage",
					stage,
					"--stage_n",
					"1",
					"--artifact",
					"# artifact",
					"--run-id",
					"hud-invalid-verdict",
					"--lane-verdict",
					verdict,
					"--json",
				],
				root,
			);
		for (const [stage, verdict] of [
			["architect", "NOPE"],
			["architect", "OKAY"],
			["planner", "CLEAR"],
		] as const) {
			const result = await write(stage, verdict);
			expect(result.status).toBe(2);
			expect(result.stderr).toContain("--lane-verdict");
		}
	});

	it("clears both verdict sources when a new run starts and rebuilds HUD state", async () => {
		const root = await tempDir();
		const runOne = "hud-reset-one";
		const runTwo = "hud-reset-two";
		expect((await writeRalplanArtifact(root, runOne, "planner", 1, "# plan one")).status).toBe(0);
		expect(
			(await writeRalplanLaneVerdictArtifact(root, runOne, "critic", 2, "# critique one", "ITERATE")).status,
		).toBe(0);
		expect(
			(
				await runNativeStateCommand(
					["write", "--mode", "ralplan", "--input", JSON.stringify({ verdict: "BLOCK" })],
					root,
				)
			).status,
		).toBe(0);

		expect((await writeRalplanArtifact(root, runTwo, "planner", 1, "# plan two")).status).toBe(0);
		expect((await readRalplanHudChips(root)).some(chip => chip.label === "verdict")).toBe(false);
		const switchedState = JSON.parse(await fs.readFile(ralplanStatePath(root), "utf-8"));
		for (const key of ["verdict", "last_review_verdict", "last_review_verdict_lane", "last_review_verdict_stage_n"]) {
			expect(Object.hasOwn(switchedState, key)).toBe(false);
		}

		expect(
			(
				await runNativeStateCommand(
					["write", "--mode", "ralplan", "--input", JSON.stringify({ marker: "verdict-less-rebuild" })],
					root,
				)
			).status,
		).toBe(0);
		expect((await readRalplanHudChips(root)).some(chip => chip.label === "verdict")).toBe(false);
	});
});
describe("native gjc ralplan runtime — session agent directory threading", () => {
	it("the session agent directory reaches the strict settings resolution", async () => {
		const cwd = await tempDir();
		const defaultAgentDir = await tempDir();
		const tenantAgentDir = await tempDir();
		// Project config must not shadow the agent layers under test.
		await fs.mkdir(path.join(cwd, ".gjc"), { recursive: true });
		await fs.writeFile(path.join(cwd, ".gjc", "config.yml"), YAML.stringify({ theme: { dark: "red" } }, null, 2));
		await fs.writeFile(
			path.join(defaultAgentDir, "config.yml"),
			YAML.stringify({ gjc: { ralplan: { maxIterations: 7, maxReviewPassesPerLane: 5 } } }, null, 2),
		);
		await fs.writeFile(
			path.join(tenantAgentDir, "config.yml"),
			YAML.stringify({ gjc: { ralplan: { maxIterations: 9, maxReviewPassesPerLane: 3 } } }, null, 2),
		);

		// An SDK session with an INJECTED settings instance passes its agent
		// directory through: the process-global agent layer holds 7, the
		// injected profile holds 9 and must win.
		const previousAgentDir = getAgentDir();
		setAgentDir(defaultAgentDir);
		try {
			const { maxIterations, source } = await resolveRalplanMaxIterations(cwd, tenantAgentDir);
			expect(maxIterations).toBe(9);
			expect(source).toContain(tenantAgentDir);
			// The per-lane review-pass cap must use the same session profile.
			const reviewPasses = await resolveRalplanMaxReviewPassesPerLane(cwd, tenantAgentDir);
			expect(reviewPasses.maxReviewPassesPerLane).toBe(3);
			expect(reviewPasses.source).toContain(tenantAgentDir);
		} finally {
			setAgentDir(previousAgentDir);
		}
	});
});
