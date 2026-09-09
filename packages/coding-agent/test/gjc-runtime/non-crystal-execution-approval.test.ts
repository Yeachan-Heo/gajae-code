import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolContext } from "@gajae-code/agent-core";
import type { AssistantMessage } from "@gajae-code/ai/types";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { runNativeDeepInterviewCommand } from "@gajae-code/coding-agent/gjc-runtime/deep-interview-runtime";
import { runNativeRalplanCommand } from "@gajae-code/coding-agent/gjc-runtime/ralplan-runtime";
import { modeStatePath } from "@gajae-code/coding-agent/gjc-runtime/session-layout";
import {
	DEEP_INTERVIEW_EXECUTION_APPROVAL_MAX_AGE_MS,
	type ExecutionApprovalStage,
	nonCrystalExecutionApprovalRecordPath,
	runNativeStateCommand,
} from "@gajae-code/coding-agent/gjc-runtime/state-runtime";
import { initTheme } from "@gajae-code/coding-agent/modes/theme/theme";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { AskTool } from "@gajae-code/coding-agent/tools/ask";

function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "approval-test",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: content.some(part => part.type === "toolCall") ? "toolUse" : "stop",
		timestamp: Date.now(),
	};
}

async function withSession(fn: (cwd: string, manager: SessionManager, sessionId: string) => Promise<void>) {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ordinary-execution-approval-"));
	const oldId = process.env.GJC_SESSION_ID;
	const oldFile = process.env.GJC_SESSION_FILE;
	const manager = SessionManager.create(cwd, SessionManager.explicitDestination(path.join(cwd, ".gjc", "sessions")));
	try {
		await initTheme(false);
		process.env.GJC_SESSION_ID = manager.getSessionId();
		manager.appendMessage({ role: "user", content: "Build a report.", timestamp: Date.now() });
		await manager.ensureOnDisk();
		await manager.flush();
		process.env.GJC_SESSION_FILE = manager.getSessionFile()!;
		await fs.writeFile(path.join(cwd, ".gjc", "config.yml"), "gjc:\n  ralplan:\n    autoHandoff: off\n");
		await fn(cwd, manager, manager.getSessionId());
	} finally {
		await manager.close();
		if (oldId === undefined) delete process.env.GJC_SESSION_ID;
		else process.env.GJC_SESSION_ID = oldId;
		if (oldFile === undefined) delete process.env.GJC_SESSION_FILE;
		else process.env.GJC_SESSION_FILE = oldFile;
		await fs.rm(cwd, { recursive: true, force: true });
	}
}

async function publish(cwd: string, sessionId: string, stage: ExecutionApprovalStage, version = 1) {
	const result =
		stage === "deep-interview"
			? await runNativeDeepInterviewCommand(
					[
						"--write",
						"--stage",
						"final",
						"--slug",
						`ordinary-${version}`,
						"--spec",
						`# Report specification ${version}\n\nBuild a report.`,
						"--session-id",
						sessionId,
						"--json",
					],
					cwd,
				)
			: await runNativeRalplanCommand(
					[
						"--write",
						"--stage",
						"final",
						"--stage_n",
						String(version),
						"--artifact",
						`# Report plan ${version}\n\nImplement and test the report.`,
						"--run-id",
						"ordinary-plan",
						"--session-id",
						sessionId,
						"--json",
					],
					cwd,
				);
	expect(result.status, result.stderr).toBe(0);
	return JSON.parse(await fs.readFile(modeStatePath(cwd, sessionId, stage), "utf8"));
}

async function ask(cwd: string, manager: SessionManager, stage: ExecutionApprovalStage, id = "approve-report") {
	const label = "Approve execution via ultragoal";
	const workflowGate =
		stage === "deep-interview"
			? { stage: "deep-interview" as const, kind: "execution" as const }
			: { stage: "ralplan" as const, kind: "approval" as const };
	const args = {
		questions: [
			{
				id,
				question: "Approve this published artifact for execution?",
				options: [{ label }, { label: "Keep planning" }],
				workflowGate,
			},
		],
	};
	manager.appendMessage(assistant([{ type: "toolCall", id, name: "ask", arguments: args }]));
	await manager.flush();
	const tool = new AskTool({
		cwd,
		hasUI: true,
		settings: Settings.isolated(),
		getSessionId: () => manager.getSessionId(),
		getSessionFile: () => manager.getSessionFile() ?? null,
		getSessionSpawns: () => "*",
	});
	const context = { hasUI: true, ui: { select: async () => label }, abort: () => {} } as unknown as AgentToolContext;
	const result = await tool.execute(id, args, undefined, undefined, context);
	manager.appendMessage({
		role: "toolResult",
		toolCallId: id,
		toolName: "ask",
		content: result.content,
		details: result.details,
		isError: false,
		timestamp: Date.now(),
	});
	manager.appendMessage(assistant([{ type: "text", text: "Approval recorded. Preparing the handoff." }]));
	await manager.flush();
}

function consume(cwd: string, sessionId: string) {
	return runNativeDeepInterviewCommand(["approve-execution", "--session-id", sessionId, "--json"], cwd);
}

function handoff(cwd: string, sessionId: string, stage: ExecutionApprovalStage) {
	return runNativeStateCommand(
		["handoff", "--mode", stage, "--to", "ultragoal", "--session-id", sessionId, "--json"],
		cwd,
	);
}

async function approval(cwd: string, sessionId: string, stage: ExecutionApprovalStage) {
	return JSON.parse(await fs.readFile(nonCrystalExecutionApprovalRecordPath(cwd, sessionId, stage), "utf8"));
}

describe("non-Crystal user-gated execution approval", () => {
	for (const stage of ["deep-interview", "ralplan"] as const) {
		it(`${stage}: real Ask and persistent continuation approve the published artifact before handoff`, async () => {
			await withSession(async (cwd, manager, sessionId) => {
				await publish(cwd, sessionId, stage);
				expect((await handoff(cwd, sessionId, stage)).status).toBe(2);
				await ask(cwd, manager, stage);
				expect((await approval(cwd, sessionId, stage)).status).toBe(stage === "ralplan" ? "consumed" : "pending");
				expect(await Bun.file(modeStatePath(cwd, sessionId, "ultragoal")).exists()).toBe(false);
				if (stage === "deep-interview") {
					const result = await consume(cwd, sessionId);
					expect(result.status, result.stderr).toBe(0);
					expect((await consume(cwd, sessionId)).status).toBe(2);
				}
				const result = await handoff(cwd, sessionId, stage);
				expect(result.status, result.stderr).toBe(0);
				expect(JSON.parse(await fs.readFile(modeStatePath(cwd, sessionId, "ultragoal"), "utf8")).active).toBe(true);
			});
		});

		it(`${stage}: a new persisted user message invalidates consent`, async () => {
			await withSession(async (cwd, manager, sessionId) => {
				await publish(cwd, sessionId, stage);
				await ask(cwd, manager, stage);
				manager.appendMessage({ role: "user", content: "Change the report requirements.", timestamp: Date.now() });
				await manager.flush();
				const result =
					stage === "deep-interview" ? await consume(cwd, sessionId) : await handoff(cwd, sessionId, stage);
				expect(result.status).toBe(2);
				expect(result.stderr).toContain("transcript");
			});
		});

		it(`${stage}: changed or missing published artifacts cannot mint approval`, async () => {
			await withSession(async (cwd, manager, sessionId) => {
				await publish(cwd, sessionId, stage);
				await ask(cwd, manager, stage);
				const record = await approval(cwd, sessionId, stage);
				await fs.writeFile(record.artifact_path, "# substituted artifact\n");
				const result =
					stage === "deep-interview" ? await consume(cwd, sessionId) : await handoff(cwd, sessionId, stage);
				expect(result.status).toBe(2);
				await fs.rm(record.artifact_path);
				await expect(ask(cwd, manager, stage, "missing-artifact")).rejects.toThrow();
			});
		});

		it(`${stage}: altered approval record and stale publication fail closed`, async () => {
			await withSession(async (cwd, manager, sessionId) => {
				await publish(cwd, sessionId, stage);
				await ask(cwd, manager, stage);
				const recordPath = nonCrystalExecutionApprovalRecordPath(cwd, sessionId, stage);
				const original = await fs.readFile(recordPath, "utf8");
				await fs.writeFile(recordPath, JSON.stringify({ ...JSON.parse(original), gate_id: "forged" }));
				let result =
					stage === "deep-interview" ? await consume(cwd, sessionId) : await handoff(cwd, sessionId, stage);
				expect(result.status).toBe(2);
				expect(result.stderr).toContain("provenance");
				await fs.writeFile(recordPath, original);
				await publish(cwd, sessionId, stage, 2);
				result = stage === "deep-interview" ? await consume(cwd, sessionId) : await handoff(cwd, sessionId, stage);
				expect(result.status).toBe(2);
				expect(result.stderr).toContain("stale");
			});
		});

		it(`${stage}: a consumed answer cannot be replayed with a fresh question`, async () => {
			await withSession(async (cwd, manager, sessionId) => {
				await publish(cwd, sessionId, stage);
				await ask(cwd, manager, stage);
				if (stage === "deep-interview") expect((await consume(cwd, sessionId)).status).toBe(0);
				await expect(ask(cwd, manager, stage, "replayed-answer")).rejects.toThrow("replay");
			});
		});
	}

	it("ordinary interview refuses expired user consent without altering authority evidence", async () => {
		await withSession(async (cwd, manager, sessionId) => {
			await publish(cwd, sessionId, "deep-interview");
			await ask(cwd, manager, "deep-interview");
			const originalNow = Date.now;
			const expiredNow = originalNow() + DEEP_INTERVIEW_EXECUTION_APPROVAL_MAX_AGE_MS + 1;
			Date.now = () => expiredNow;
			try {
				const result = await consume(cwd, sessionId);
				expect(result.status).toBe(2);
				expect(result.stderr).toContain("expired");
			} finally {
				Date.now = originalNow;
			}
		});
	});
	it("malformed Crystal state never falls back to ordinary interview approval", async () => {
		await withSession(async (cwd, manager, sessionId) => {
			await publish(cwd, sessionId, "deep-interview");
			const statePath = modeStatePath(cwd, sessionId, "deep-interview");
			const state = JSON.parse(await fs.readFile(statePath, "utf8"));
			state.state.crystal = { lifecycle: "ready" };
			await fs.writeFile(statePath, JSON.stringify(state));
			await expect(ask(cwd, manager, "deep-interview")).rejects.toThrow();
			expect(await Bun.file(nonCrystalExecutionApprovalRecordPath(cwd, sessionId, "deep-interview")).exists()).toBe(
				false,
			);
		});
	});

	it("standalone Ralplan retains artifact-bound consent across its sanctioned final-to-handoff phase write", async () => {
		await withSession(async (cwd, manager, sessionId) => {
			await publish(cwd, sessionId, "ralplan");
			await ask(cwd, manager, "ralplan");
			const phase = await runNativeStateCommand(
				[
					"write",
					"--mode",
					"ralplan",
					"--session-id",
					sessionId,
					"--input",
					JSON.stringify({ current_phase: "handoff" }),
					"--json",
				],
				cwd,
			);
			expect(phase.status, phase.stderr).toBe(0);
			const result = await handoff(cwd, sessionId, "ralplan");
			expect(result.status, result.stderr).toBe(0);
		});
	});

	it("ordinary interview planning handoff requires a fresh Ralplan final approval, not a Crystal", async () => {
		await withSession(async (cwd, manager, sessionId) => {
			await publish(cwd, sessionId, "deep-interview");
			const planning = await runNativeStateCommand(
				["handoff", "--mode", "deep-interview", "--to", "ralplan", "--session-id", sessionId, "--json"],
				cwd,
			);
			expect(planning.status, planning.stderr).toBe(0);
			const admitted = JSON.parse(await fs.readFile(modeStatePath(cwd, sessionId, "ralplan"), "utf8"));
			const published = await publish(cwd, sessionId, "ralplan");
			expect(admitted.run_id).toBeUndefined();
			expect(published.handoff_from).toBe("deep-interview");
			expect(published.handoff_at).toBe(admitted.handoff_at);
			expect(published.upstream_handoff_at).toBe(admitted.upstream_handoff_at);
			expect((await handoff(cwd, sessionId, "ralplan")).status).toBe(2);
			await ask(cwd, manager, "ralplan");
			const result = await handoff(cwd, sessionId, "ralplan");
			expect(result.status, result.stderr).toBe(0);
		});
	});
	for (const firstStage of ["planner", "final"] as const) {
		it(`Ralplan ${firstStage} establishes incoming lineage once and clears it when replacing the run`, async () => {
			await withSession(async (cwd, _manager, sessionId) => {
				await publish(cwd, sessionId, "deep-interview");
				const planning = await runNativeStateCommand(
					["handoff", "--mode", "deep-interview", "--to", "ralplan", "--session-id", sessionId, "--json"],
					cwd,
				);
				expect(planning.status, planning.stderr).toBe(0);
				const statePath = modeStatePath(cwd, sessionId, "ralplan");
				const admitted = JSON.parse(await fs.readFile(statePath, "utf8"));
				for (const runId of ["initial-run", "replacement-run"]) {
					const result = await runNativeRalplanCommand(
						[
							"--write",
							"--stage",
							firstStage,
							"--stage_n",
							"1",
							"--artifact",
							`# ${runId}`,
							"--run-id",
							runId,
							"--session-id",
							sessionId,
							"--json",
						],
						cwd,
					);
					expect(result.status, result.stderr).toBe(0);
					const state = JSON.parse(await fs.readFile(statePath, "utf8"));
					expect(state.run_id).toBe(runId);
					for (const field of ["handoff_from", "handoff_at", "upstream_handoff_at"]) {
						if (runId === "initial-run") expect(state[field]).toEqual(admitted[field]);
						else expect(state).not.toHaveProperty(field);
					}
				}
			});
		});
	}
});
