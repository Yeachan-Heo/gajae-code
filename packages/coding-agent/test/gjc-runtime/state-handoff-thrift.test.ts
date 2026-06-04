import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import type { Skill } from "@gajae-code/coding-agent/extensibility/skills";
import { runNativeDeepInterviewCommand } from "@gajae-code/coding-agent/gjc-runtime/deep-interview-runtime";
import { runNativeRalplanCommand } from "@gajae-code/coding-agent/gjc-runtime/ralplan-runtime";
import { runNativeStateCommand } from "@gajae-code/coding-agent/gjc-runtime/state-runtime";
import { createUltragoalPlan, runNativeUltragoalCommand } from "@gajae-code/coding-agent/gjc-runtime/ultragoal-runtime";
import { SKILL_PROMPT_MESSAGE_TYPE } from "@gajae-code/coding-agent/session/messages";
import type { ToolSession } from "@gajae-code/coding-agent/tools";
import { SkillTool } from "@gajae-code/coding-agent/tools/skill";

const roots: string[] = [];

async function tempDir(prefix = "gjc-handoff-thrift-"): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	roots.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
	delete process.env.GJC_SESSION_ID;
});

function scrub(text: string): string {
	return text
		.replaceAll(/\/var\/folders\/[^\n"]+/g, "/tmp/SCRUBBED")
		.replaceAll(/\/private\/var\/[^\n"]+/g, "/tmp/SCRUBBED")
		.replaceAll(/\/tmp\/gjc-[^\n"]+/g, "/tmp/SCRUBBED")
		.replaceAll(/[0-9a-f]{64}/g, "<sha256>")
		.replaceAll(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, "<iso>");
}

function assertKeys(value: Record<string, unknown>, keys: readonly string[]): void {
	for (const key of keys) expect(value, `missing ${key}`).toHaveProperty(key);
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, JSON.stringify(value, null, 2));
}

function passingQualityGate(): string {
	return JSON.stringify({
		architectReview: {
			architectureStatus: "CLEAR",
			productStatus: "CLEAR",
			codeStatus: "CLEAR",
			recommendation: "APPROVE",
			evidence: "reviewed",
			commands: ["architect-review"],
			blockers: [],
		},
		executorQa: {
			status: "passed",
			e2eStatus: "passed",
			redTeamStatus: "passed",
			evidence: "qa passed",
			e2eCommands: ["bun test:e2e"],
			redTeamCommands: ["bun test:red-team"],
			blockers: [],
		},
		iteration: {
			status: "passed",
			evidence: "complete",
			fullRerun: true,
			rerunCommands: ["bun test:e2e"],
			blockers: [],
		},
	});
}

async function makeSkill(name: string, content: string): Promise<Skill> {
	const dir = await tempDir(`skill-tool-${name}-`);
	const filePath = path.join(dir, "SKILL.md");
	await fs.writeFile(filePath, content);
	return { name, description: `${name} skill`, filePath, baseDir: dir, source: "test", content };
}

describe("CONSUMER/KEY-FIELD MATRIX for compact handoff payloads", () => {
	it("goldens and asserts every preserved consumer key field", async () => {
		delete process.env.GJC_SESSION_ID;
		const root = await tempDir();

		const ralplanReceipt = await runNativeRalplanCommand(
			["--write", "--stage", "final", "--stage_n", "2", "--artifact", "# Final", "--run-id", "run-b", "--json"],
			root,
		);
		expect(ralplanReceipt.status).toBe(0);
		const ralplanReceiptPayload = JSON.parse(ralplanReceipt.stdout ?? "{}") as Record<string, unknown>;
		assertKeys(ralplanReceiptPayload, [
			"run_id",
			"path",
			"stage",
			"stage_n",
			"sha256",
			"created_at",
			"pending_approval_path",
		]);
		expect(scrub(ralplanReceipt.stdout ?? "")).toMatchInlineSnapshot(`
			"{
			  "run_id": "run-b",
			  "path": "/tmp/SCRUBBED",
			  "stage": "final",
			  "stage_n": 2,
			  "sha256": "<sha256>",
			  "created_at": "<iso>",
			  "pending_approval_path": "/tmp/SCRUBBED"
			}
			"
			`);

		const ralplanSeed = await runNativeRalplanCommand(["--json", "scope the work"], root);
		expect(ralplanSeed.status).toBe(0);
		expect(scrub(ralplanSeed.stdout ?? "")).toMatchInlineSnapshot(`
			"{"ok":true,"skill":"ralplan","mode":"short","state_path":"/tmp/SCRUBBED","run_id":"run-b","handoff":"/skill:ralplan"}
			"
			`);

		const deepSeed = await runNativeDeepInterviewCommand(
			["--standard", "--threshold", "0.05", "--threshold-source", "flag:explicit", "--json", "clarify this idea"],
			root,
		);
		expect(deepSeed.status).toBe(0);
		const deepSeedPayload = JSON.parse(deepSeed.stdout ?? "{}") as Record<string, unknown>;
		assertKeys(deepSeedPayload, ["state_path", "handoff"]);
		expect(deepSeedPayload.handoff).toBe("/skill:deep-interview");
		expect(scrub(deepSeed.stdout ?? "")).toMatchInlineSnapshot(`
			"{"skill":"deep-interview","resolution":"standard","threshold":0.05,"threshold_source":"flag:explicit","idea":"clarify this idea","state_path":"/tmp/SCRUBBED","handoff":"/skill:deep-interview"}
			"
			`);

		const deepWrite = await runNativeDeepInterviewCommand(
			["--write", "--stage", "final", "--slug", "matrix", "--spec", "# Spec", "--deliberate", "--json"],
			root,
		);
		expect(deepWrite.status).toBe(0);
		const deepWritePayload = JSON.parse(deepWrite.stdout ?? "{}") as Record<string, unknown>;
		assertKeys(deepWritePayload, ["path", "sha256", "spec_path", "sha", "state_path", "handoff"]);
		expect(deepWritePayload.spec_path).toBe(deepWritePayload.path);
		expect(deepWritePayload.sha).toBe(deepWritePayload.sha256);
		expect(deepWritePayload.spec_path).toBeTruthy();
		expect(deepWritePayload.sha).toBeTruthy();
		const handoff = deepWritePayload.handoff as Record<string, unknown>;
		assertKeys(handoff, ["to", "run_id", "state_path"]);
		expect(scrub(deepWrite.stdout ?? "")).toMatchInlineSnapshot(`
			"{"skill":"deep-interview","stage":"final","slug":"matrix","path":"/tmp/SCRUBBED","sha256":"<sha256>","spec_path":"/tmp/SCRUBBED","sha":"<sha256>","created_at":"<iso>","state_path":"/tmp/SCRUBBED","handoff":{"to":"ralplan","mode":"deliberate","state_path":"/tmp/SCRUBBED","run_id":"run-b"}}
			"
			`);

		await writeJson(path.join(root, ".gjc/state/deep-interview-state.json"), {
			skill: "deep-interview",
			version: 1,
			active: true,
			current_phase: "interviewing",
		});
		const stateHandoff = await runNativeStateCommand(
			["handoff", "--mode", "deep-interview", "--to", "ralplan", "--json"],
			root,
		);
		expect(stateHandoff.status).toBe(0);
		const statePayload = JSON.parse(stateHandoff.stdout ?? "{}") as Record<string, unknown>;
		assertKeys(statePayload, ["ok", "from", "to", "handoff_at", "phases", "receipts", "paths"]);
		expect(statePayload.state).toBeUndefined();
		expect(scrub(stateHandoff.stdout ?? "")).toMatchInlineSnapshot(`
			"{"ok":true,"from":"deep-interview","to":"ralplan","handoff_at":"<iso>","phases":{"from":"handoff","to":"planner"},"receipts":{"from":{"mutation_id":"deep-interview:handoff:ralplan:<iso>","status":"fresh","content_sha256":{"algorithm":"sha256","value":"<sha256>","covered_path":"/tmp/SCRUBBED","computed_at":"<iso>"}},"to":{"mutation_id":"deep-interview:handoff:ralplan:<iso>","status":"fresh","content_sha256":{"algorithm":"sha256","value":"<sha256>","covered_path":"/tmp/SCRUBBED","computed_at":"<iso>"}}},"paths":{"from":"/tmp/SCRUBBED","to":"/tmp/SCRUBBED","active_state":"/tmp/SCRUBBED"}}
			"
			`);

		await createUltragoalPlan({ cwd: root, brief: "Ship the compact output" });
		const ultragoalHandoff = await runNativeUltragoalCommand(["complete-goals"], root);
		expect(ultragoalHandoff.status).toBe(0);
		expect(ultragoalHandoff.stdout).toContain("objective=");
		expect(ultragoalHandoff.stdout).toContain("next-action=execute-goal");
		expect(scrub(ultragoalHandoff.stdout ?? "")).toMatchInlineSnapshot(`
			"ultragoal next-action=execute-goal goal-id=G001
			objective=Ship the compact output
			gjc-objective=Complete the durable ultragoal plan in .gjc/ultragoal/goals.json, including later accepted/appended stories, under the original brief constraints; use .gjc/ultragoal/ledger.jsonl as the audit trail.
			checkpoint requires=architectReview:CLEAR+APPROVE,executorQa:passed
			"
			`);
		const checkpoint = await runNativeUltragoalCommand(
			[
				"checkpoint",
				"--goal-id",
				"G001",
				"--status",
				"blocked",
				"--evidence",
				"waiting",
				"--quality-gate-json",
				passingQualityGate(),
			],
			root,
		);
		expect(checkpoint.status).toBe(0);
		expect(checkpoint.stdout).toContain("goal-id=G001");
		expect(checkpoint.stdout).toContain("status=blocked");
		expect(checkpoint.stdout).toMatchInlineSnapshot(`
		  "ultragoal checkpoint goal-id=G001 status=blocked
		  "
		`);

		const skill = await makeSkill("ralplan", "---\nname: ralplan\n---\n# Ralplan\nBody");
		const captured: Array<{ message: { customType: string; content: unknown }; options?: unknown }> = [];
		const session: ToolSession = {
			cwd: root,
			hasUI: false,
			skills: [skill],
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated(),
			sendCustomMessage: async (message, options) => {
				captured.push({ message, options });
			},
		};
		const tool = SkillTool.createIf(session)!;
		const skillResult = await tool.execute("call", { name: "ralplan", args: "review" });
		const skillPayload = JSON.parse(
			skillResult.content[0]?.type === "text" ? skillResult.content[0].text : "{}",
		) as Record<string, unknown>;
		assertKeys(skillPayload, ["callee", "path", "args", "lineCount"]);
		expect(captured[0]?.message.customType).toBe(SKILL_PROMPT_MESSAGE_TYPE);
		expect(captured[0]?.message.content).toContain("# Ralplan");
		expect(scrub(skillResult.content[0]?.type === "text" ? skillResult.content[0].text : "")).toMatchInlineSnapshot(
			`"{"callee":"ralplan","path":"/tmp/SCRUBBED","args":"review","lineCount":2}"`,
		);
	});

	it("documents the ralplan receipt-only guideline for role agents", async () => {
		const skillDoc = await fs.readFile(
			path.join(process.cwd(), "packages/coding-agent/src/defaults/gjc/skills/ralplan/SKILL.md"),
			"utf-8",
		);
		expect(skillDoc).toContain("RECEIPT-ONLY guideline");
		expect(skillDoc).toContain("planner");
		expect(skillDoc).toContain("architect");
		expect(skillDoc).toContain("critic");
		expect(skillDoc).toContain("gjc ralplan --write");
		expect(skillDoc).toContain("run_id");
		expect(skillDoc).toContain("path");
		expect(skillDoc).toContain("sha256");
		expect(skillDoc).toContain("verdict/status");
	});
});
