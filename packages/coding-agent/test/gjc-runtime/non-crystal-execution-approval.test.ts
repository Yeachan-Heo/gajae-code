import { describe, expect, it, vi } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentTool, AgentToolContext } from "@gajae-code/agent-core";
import type { AssistantMessage } from "@gajae-code/ai/types";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { crystalSnapshotDigest } from "@gajae-code/coding-agent/gjc-runtime/deep-interview-crystallize";
import {
	authoritativeConversationSnapshot,
	runNativeDeepInterviewCommand,
} from "@gajae-code/coding-agent/gjc-runtime/deep-interview-runtime";
import {
	clearRalplanReviewerCapabilities,
	GJC_RALPLAN_REVIEWER_CAPABILITY_ENV,
	GJC_RALPLAN_REVIEWER_ID_ENV,
	GJC_RALPLAN_REVIEWER_ROLE_ENV,
	getOrCreateRalplanReviewerCapability,
	type RalplanReviewerRole,
} from "@gajae-code/coding-agent/gjc-runtime/ralplan-reviewer-capability";
import { runNativeRalplanCommand } from "@gajae-code/coding-agent/gjc-runtime/ralplan-runtime";
import { GJC_RESTRICTED_ROLE_AGENT_BASH_ENV } from "@gajae-code/coding-agent/gjc-runtime/restricted-role-agent-bash";
import {
	auditPath,
	modeStatePath,
	sessionPlansDir,
	sessionStateDir,
} from "@gajae-code/coding-agent/gjc-runtime/session-layout";
import {
	captureExecutionApprovalPresentation,
	DEEP_INTERVIEW_EXECUTION_APPROVAL_MAX_AGE_MS,
	deepInterviewExecutionApprovalRecordPath,
	type ExecutionApprovalStage,
	executionApprovalLineage,
	nonCrystalExecutionApprovalRecordPath,
	recordDeepInterviewExecutionApproval,
	recordNonCrystalExecutionApproval,
	runNativeStateCommand,
} from "@gajae-code/coding-agent/gjc-runtime/state-runtime";
import { isUltragoalAskBlocked } from "@gajae-code/coding-agent/gjc-runtime/ultragoal-guard";
import { createUltragoalPlan, getUltragoalPaths } from "@gajae-code/coding-agent/gjc-runtime/ultragoal-runtime";
import { initTheme } from "@gajae-code/coding-agent/modes/theme/theme";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { createTools, type ToolSession } from "@gajae-code/coding-agent/tools";
import { AskTool } from "@gajae-code/coding-agent/tools/ask";
import {
	formatRalplanUltragoalApprovalQuestion,
	guardToolForUltragoalAsk,
} from "@gajae-code/coding-agent/tools/ultragoal-ask-guard";
import { ExtensionToolWrapper } from "../../src/extensibility/extensions/wrapper";

let askInvocationCounter = 0;

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

async function withRalplanReviewer<T>(
	sessionId: string,
	role: RalplanReviewerRole,
	agentId: string,
	operation: () => Promise<T>,
): Promise<T> {
	const names = [
		GJC_RESTRICTED_ROLE_AGENT_BASH_ENV,
		GJC_RALPLAN_REVIEWER_ROLE_ENV,
		GJC_RALPLAN_REVIEWER_ID_ENV,
		GJC_RALPLAN_REVIEWER_CAPABILITY_ENV,
	] as const;
	const previous = new Map(names.map(name => [name, process.env[name]]));
	process.env[GJC_RESTRICTED_ROLE_AGENT_BASH_ENV] = "1";
	process.env[GJC_RALPLAN_REVIEWER_ROLE_ENV] = role;
	process.env[GJC_RALPLAN_REVIEWER_ID_ENV] = agentId;
	process.env[GJC_RALPLAN_REVIEWER_CAPABILITY_ENV] = getOrCreateRalplanReviewerCapability(sessionId, role, agentId);
	try {
		return await operation();
	} finally {
		for (const name of names) {
			const value = previous.get(name);
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
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
		clearRalplanReviewerCapabilities(manager.getSessionId());
		if (oldId === undefined) delete process.env.GJC_SESSION_ID;
		else process.env.GJC_SESSION_ID = oldId;
		if (oldFile === undefined) delete process.env.GJC_SESSION_FILE;
		else process.env.GJC_SESSION_FILE = oldFile;
		await fs.rm(cwd, { recursive: true, force: true });
	}
}

async function publish(cwd: string, sessionId: string, stage: ExecutionApprovalStage, version = 1) {
	if (stage === "ralplan") {
		await publishReviewedRalplanFinal(cwd, sessionId, "ordinary-plan", version);
		return JSON.parse(await fs.readFile(modeStatePath(cwd, sessionId, stage), "utf8"));
	}
	const result = await runNativeDeepInterviewCommand(
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
	);
	expect(result.status, result.stderr).toBe(0);
	return JSON.parse(await fs.readFile(modeStatePath(cwd, sessionId, stage), "utf8"));
}

async function publishReviewedRalplanFinal(
	cwd: string,
	sessionId: string,
	runId = "reviewed-current-final",
	stageN = 1,
) {
	const stages = [
		{
			stage: "planner",
			artifact: "# Planner\n\nImplement and test the approved repair.",
			extra: ["--planner-id", "1-Planner"],
		},
		{
			stage: "architect",
			artifact: "## Architectural Status\nCLEAR\n\n## Code Review Recommendation\nAPPROVE\n",
			extra: ["--architect-id", "2-Architect", "--lane-verdict", "CLEAR", "--architect-decision", "APPROVE"],
		},
		{
			stage: "critic",
			artifact: "## Verdict\n**OKAY**\n",
			extra: ["--critic-id", "3-Critic", "--lane-verdict", "OKAY"],
		},
		{
			stage: "final",
			artifact: `# Approved final plan ${stageN}\n\nImplement and test the approved repair.`,
			extra: [],
		},
	] as const;
	for (const row of stages) {
		await writeRalplanStage(cwd, sessionId, runId, row.stage, stageN, row.artifact, row.extra);
	}
	return JSON.parse(await fs.readFile(modeStatePath(cwd, sessionId, "ralplan"), "utf8"));
}

async function writeRalplanStage(
	cwd: string,
	sessionId: string,
	runId: string,
	stage: string,
	stageN: number,
	artifact: string,
	extra: readonly string[] = [],
) {
	const reviewerRole =
		(stage === "architect" || stage === "critic") && extra.includes("--lane-verdict") ? stage : undefined;
	const idFlag =
		reviewerRole === "architect" ? "--architect-id" : reviewerRole === "critic" ? "--critic-id" : undefined;
	const writeExtra = [...extra];
	if (idFlag && !writeExtra.includes(idFlag)) writeExtra.push(idFlag, `${reviewerRole}-test-agent`);
	const write = () =>
		runNativeRalplanCommand(
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
				"--session-id",
				sessionId,
				...writeExtra,
				"--json",
			],
			cwd,
		);
	const result = await (async () => {
		if (reviewerRole && idFlag) {
			const idIndex = writeExtra.indexOf(idFlag);
			const agentId = idIndex >= 0 ? writeExtra[idIndex + 1] : undefined;
			if (!agentId) throw new Error(`Ralplan ${stage} test write requires ${idFlag}`);
			return await withRalplanReviewer(sessionId, reviewerRole, agentId, write);
		}
		return await write();
	})();
	expect(result.status, result.stderr).toBe(0);
	return JSON.parse(result.stdout ?? "{}");
}

async function ask(
	cwd: string,
	manager: SessionManager,
	stage: ExecutionApprovalStage,
	id = "approve-report",
	consumeRalplan = true,
	guarded = false,
) {
	const label = "Approve execution via ultragoal";
	const toolCallId = `provider-${id}-${++askInvocationCounter}`;
	let question = "Approve this published artifact for execution?";
	if (stage === "ralplan") {
		try {
			const presentation = await captureExecutionApprovalPresentation(cwd, manager.getSessionId(), "ralplan");
			const formattedQuestion = formatRalplanUltragoalApprovalQuestion(presentation);
			if (formattedQuestion) question = formattedQuestion;
		} catch {
			// Forged and tampered approval cases must reach the guard to prove it fails closed.
		}
	}
	const workflowGate =
		stage === "deep-interview"
			? { stage: "deep-interview" as const, kind: "execution" as const }
			: { stage: "ralplan" as const, kind: "approval" as const };
	const args = {
		questions: [
			{
				id,
				question,
				options: [{ label: "Refine further" }, { label }, { label: "Stop here" }],
				recommended: 1,
				multi: false,
				workflowGate,
			},
		],
	};
	manager.appendMessage(assistant([{ type: "toolCall", id: toolCallId, name: "ask", arguments: args }]));
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
	const executable = guarded
		? (guardToolForUltragoalAsk(
				tool as AgentTool,
				() => cwd,
				() => ({ sessionId: manager.getSessionId() }),
			) as AskTool)
		: tool;
	const result = await executable.execute(toolCallId, args, undefined, undefined, context);
	manager.appendMessage({
		role: "toolResult",
		toolCallId,
		toolName: "ask",
		content: result.content,
		details: result.details,
		isError: false,
		timestamp: Date.now(),
	});
	manager.appendMessage(assistant([{ type: "text", text: "Approval recorded. Preparing the handoff." }]));
	await manager.flush();
	if (stage === "ralplan" && consumeRalplan) {
		const approval = await runNativeStateCommand(
			["approve-execution", "--mode", "ralplan", "--session-id", manager.getSessionId(), "--json"],
			cwd,
		);
		if (approval.status !== 0) throw new Error(approval.stderr || "Ralplan approval consume failed");
	}
}

function consume(cwd: string, sessionId: string) {
	return runNativeDeepInterviewCommand(["approve-execution", "--session-id", sessionId, "--json"], cwd);
}

async function handoff(cwd: string, sessionId: string, stage: ExecutionApprovalStage) {
	if (stage === "ralplan") {
		const recordPath = nonCrystalExecutionApprovalRecordPath(cwd, sessionId, stage);
		let consumed = false;
		try {
			consumed = (JSON.parse(await fs.readFile(recordPath, "utf8")) as { status?: string }).status === "consumed";
		} catch {
			// Let the native command return its fail-closed missing-record error.
		}
		if (!consumed) {
			const approval = await runNativeStateCommand(
				["approve-execution", "--mode", "ralplan", "--session-id", sessionId, "--json"],
				cwd,
			);
			if (approval.status !== 0) return approval;
		}
	}
	return runNativeStateCommand(
		["handoff", "--mode", stage, "--to", "ultragoal", "--session-id", sessionId, "--json"],
		cwd,
	);
}

async function approval(cwd: string, sessionId: string, stage: ExecutionApprovalStage) {
	return JSON.parse(await fs.readFile(nonCrystalExecutionApprovalRecordPath(cwd, sessionId, stage), "utf8"));
}

async function publishCrystal(cwd: string, sessionId: string) {
	const live = await authoritativeConversationSnapshot(cwd, sessionId);
	const source = { revision: live.revision, start: 0, end: live.messages.length - 1, messages: live.messages };
	const result = await runNativeDeepInterviewCommand(
		[
			"--crystallize",
			"--session-id",
			sessionId,
			"--slug",
			"historical-crystal",
			"--input",
			JSON.stringify({
				current_revision: live.revision,
				snapshot: { ...source, digest: crystalSnapshotDigest(source) },
				items: live.messages
					.filter(message => message.role === "user")
					.map(message => ({
						id: `requirement:${message.index}`,
						kind: "acceptance_criterion",
						classification: "confirmed",
						statement: message.content,
						anchor: { message_index: message.index, quote: message.content },
					})),
			}),
			"--json",
		],
		cwd,
	);
	expect(result.status, result.stderr).toBe(0);
}

describe("non-Crystal user-gated execution approval", () => {
	it("allows a same-session current-final Ralplan approval during an incomplete Ultragoal", async () => {
		await withSession(async (cwd, manager, sessionId) => {
			await createUltragoalPlan({ cwd, brief: "Implement the approved repair" });
			await publishReviewedRalplanFinal(cwd, sessionId);
			const presentation = await captureExecutionApprovalPresentation(cwd, sessionId, "ralplan");
			const paths = getUltragoalPaths(cwd, sessionId);
			const goalsBefore = await fs.readFile(paths.goalsPath, "utf8");
			const ledgerBefore = await fs.readFile(paths.ledgerPath, "utf8");

			expect(presentation.artifact_path).toContain("stage-01-final.md");
			await expect(ask(cwd, manager, "ralplan", "ultragoal-current-final", true, true)).resolves.toBeUndefined();

			const recordedApproval = await approval(cwd, sessionId, "ralplan");
			expect(recordedApproval).toMatchObject({
				status: "consumed",
				artifact_path: presentation.artifact_path,
				artifact_sha256: presentation.artifact_sha256,
			});
			expect(await isUltragoalAskBlocked(cwd, { sessionId })).toMatchObject({ active: true });
			expect(await fs.readFile(paths.goalsPath, "utf8")).toBe(goalsBefore);
			expect(await fs.readFile(paths.ledgerPath, "utf8")).toBe(ledgerBefore);
		});
	});

	it("consumes a Ralplan approval after reviewer capabilities are cleared", async () => {
		await withSession(async (cwd, manager, sessionId) => {
			await createUltragoalPlan({ cwd, brief: "Implement the approved repair" });
			await publishReviewedRalplanFinal(cwd, sessionId);
			await ask(cwd, manager, "ralplan", "approval-after-restart", false, true);
			clearRalplanReviewerCapabilities(sessionId);

			const result = await handoff(cwd, sessionId, "ralplan");
			expect(result.status, result.stderr).toBe(0);
			expect(JSON.parse(await fs.readFile(modeStatePath(cwd, sessionId, "ultragoal"), "utf8")).active).toBe(true);
		});
	});

	it("keeps built-in Ask approval through SDK extension-wrapper preflight", async () => {
		await withSession(async (cwd, _manager, sessionId) => {
			await createUltragoalPlan({ cwd, brief: "Implement the approved repair" });
			await publishReviewedRalplanFinal(cwd, sessionId);
			const presentation = await captureExecutionApprovalPresentation(cwd, sessionId, "ralplan");
			const question = formatRalplanUltragoalApprovalQuestion(presentation);
			if (!question) throw new Error("expected canonical Ralplan approval question");
			const session = {
				cwd,
				hasUI: true,
				settings: Settings.isolated(),
				getSessionId: () => sessionId,
				getSessionFile: () => null,
				getSessionSpawns: () => "*",
			} as unknown as ToolSession;
			const askFacade = (await createTools(session, ["ask"])).find(tool => tool.name === "ask");
			if (!askFacade) throw new Error("built-in Ask LazyAgentTool was not created");
			const extensionWrappedAsk = new ExtensionToolWrapper(
				askFacade as AgentTool,
				{
					hasHandlers: () => false,
					hasToolResultMediation: () => false,
				} as never,
			);
			const guarded = guardToolForUltragoalAsk(
				extensionWrappedAsk,
				() => cwd,
				() => ({ sessionId }),
				() => undefined,
				true,
			);
			const context = {
				hasUI: true,
				ui: { select: async () => "Stop here", editor: async () => undefined },
				abort: () => {},
			} as unknown as AgentToolContext;

			const result = await guarded.execute(
				"production-ask-facade",
				{
					questions: [
						{
							id: "ralplan-approval",
							question,
							options: [
								{ label: "Refine further" },
								{ label: "Approve execution via ultragoal" },
								{ label: "Stop here" },
							],
							recommended: 1,
							multi: false,
							workflowGate: { stage: "ralplan", kind: "approval" },
						},
					],
				},
				undefined,
				undefined,
				context,
			);
			expect(result.details?.question).toBe(question);
			expect(result.details?.selectedOptions).toEqual(["Stop here"]);
		});
	});

	it("does not present a second Ralplan approval after handoff begins", async () => {
		await withSession(async (cwd, _manager, sessionId) => {
			await createUltragoalPlan({ cwd, brief: "Implement the approved repair" });
			await publishReviewedRalplanFinal(cwd, sessionId);
			const handoffReady = await runNativeStateCommand(
				["write", "--mode", "ralplan", "--input", JSON.stringify({ current_phase: "handoff" }), "--json"],
				cwd,
			);
			expect(handoffReady.status, handoffReady.stderr).toBe(0);

			await expect(captureExecutionApprovalPresentation(cwd, sessionId, "ralplan")).rejects.toThrow(
				/execution approval requires an active final publication/,
			);
		});
	});

	it("requires runtime-recorded same-pass accepted reviews and an off admission target", async () => {
		for (const invalidJoin of ["missing", "rejected", "mismatched", "unapproved-architect"] as const) {
			await withSession(async (cwd, manager, sessionId) => {
				await createUltragoalPlan({ cwd, brief: "Implement the approved repair" });
				const runId = `invalid-review-join-${invalidJoin}`;
				if (invalidJoin !== "missing") {
					await writeRalplanStage(cwd, sessionId, runId, "planner", 1, "# Planner\n\nPlan the repair.");
					await writeRalplanStage(
						cwd,
						sessionId,
						runId,
						"architect",
						invalidJoin === "mismatched" ? 2 : 1,
						`## Architectural Status\nCLEAR\n\n## Code Review Recommendation\n${invalidJoin === "unapproved-architect" ? "COMMENT" : "APPROVE"}\n`,
						[
							"--lane-verdict",
							"CLEAR",
							"--architect-decision",
							invalidJoin === "unapproved-architect" ? "COMMENT" : "APPROVE",
						],
					);
					await writeRalplanStage(
						cwd,
						sessionId,
						runId,
						"critic",
						invalidJoin === "mismatched" ? 2 : 1,
						"## Verdict\n**OKAY**\n",
						["--lane-verdict", invalidJoin === "rejected" ? "ITERATE" : "OKAY"],
					);
				}
				await writeRalplanStage(cwd, sessionId, runId, "final", 1, "# Final plan\n\nPlan the repair.");

				await expect(ask(cwd, manager, "ralplan", `invalid-${invalidJoin}`, false, true)).rejects.toThrow(
					/Ultragoal try-harder nudge/,
				);
				expect(await Bun.file(nonCrystalExecutionApprovalRecordPath(cwd, sessionId, "ralplan")).exists()).toBe(
					false,
				);
			});
		}
	});

	it("refuses conflicting duplicate review decisions and enriches legacy review rows", async () => {
		await withSession(async (cwd, _manager, sessionId) => {
			await createUltragoalPlan({ cwd, brief: "Implement the approved repair" });
			const runId = "duplicate-review-provenance";
			await writeRalplanStage(cwd, sessionId, runId, "planner", 1, "# Planner\n\nPlan the repair.");
			const architectArtifact = "## Architectural Status\nCLEAR\n\n## Code Review Recommendation\nAPPROVE\n";
			await writeRalplanStage(cwd, sessionId, runId, "architect", 1, architectArtifact, [
				"--lane-verdict",
				"CLEAR",
				"--architect-decision",
				"APPROVE",
			]);
			const conflictingRetry = await withRalplanReviewer(
				sessionId,
				"architect",
				"architect-test-agent",
				async () =>
					await runNativeRalplanCommand(
						[
							"--write",
							"--stage",
							"architect",
							"--stage_n",
							"1",
							"--artifact",
							architectArtifact,
							"--run-id",
							"duplicate-review-provenance",
							"--session-id",
							sessionId,
							"--architect-id",
							"architect-test-agent",
							"--lane-verdict",
							"CLEAR",
							"--architect-decision",
							"REQUEST_CHANGES",
							"--json",
						],
						cwd,
					),
			);
			expect(conflictingRetry.status).toBe(2);
			expect(conflictingRetry.stderr).toContain("conflicting Architect decision");

			await writeRalplanStage(cwd, sessionId, runId, "critic", 1, "## Verdict\n**OKAY**\n", [
				"--lane-verdict",
				"OKAY",
			]);
			await writeRalplanStage(cwd, sessionId, runId, "final", 1, "# Final plan\n\nPlan the repair.");
			await expect(captureExecutionApprovalPresentation(cwd, sessionId, "ralplan")).resolves.toMatchObject({
				run_id: runId,
			});

			const legacyRunId = "legacy-review-provenance";
			await writeRalplanStage(cwd, sessionId, legacyRunId, "planner", 1, "# Planner\n\nPlan the repair.");
			await writeRalplanStage(cwd, sessionId, legacyRunId, "architect", 1, architectArtifact);
			await writeRalplanStage(cwd, sessionId, legacyRunId, "architect", 1, architectArtifact, [
				"--lane-verdict",
				"CLEAR",
				"--architect-decision",
				"APPROVE",
			]);
			await writeRalplanStage(cwd, sessionId, legacyRunId, "critic", 1, "## Verdict\n**OKAY**\n", [
				"--lane-verdict",
				"OKAY",
			]);
			await writeRalplanStage(cwd, sessionId, legacyRunId, "final", 1, "# Final plan\n\nPlan the repair.");
			const legacyIndexPath = path.join(sessionPlansDir(cwd, sessionId), "ralplan", legacyRunId, "index.jsonl");
			const legacyRows = (await fs.readFile(legacyIndexPath, "utf8"))
				.trim()
				.split("\n")
				.map(line => JSON.parse(line) as Record<string, unknown>);
			expect(legacyRows.filter(row => row.stage === "architect")).toHaveLength(2);
			expect(legacyRows.findLast(row => row.stage === "architect")).toMatchObject({
				lane_verdict: "CLEAR",
				architect_decision: "APPROVE",
				reviewed_planner: { stage_n: 1 },
			});
			await expect(captureExecutionApprovalPresentation(cwd, sessionId, "ralplan")).resolves.toMatchObject({
				run_id: legacyRunId,
			});
		});
	});

	it("refreshes the final review join after post-publication metadata enrichment", async () => {
		await withSession(async (cwd, _manager, sessionId) => {
			const runId = "late-review-metadata-enrichment";
			const architectArtifact = "## Architectural Status\nCLEAR\n\n## Code Review Recommendation\nAPPROVE\n";
			await writeRalplanStage(cwd, sessionId, runId, "planner", 1, "# Planner\n\nPlan the repair.");
			await writeRalplanStage(cwd, sessionId, runId, "architect", 1, architectArtifact);
			await writeRalplanStage(cwd, sessionId, runId, "critic", 1, "## Verdict\n**OKAY**\n", [
				"--lane-verdict",
				"OKAY",
			]);
			await writeRalplanStage(cwd, sessionId, runId, "final", 1, "# Final plan\n\nPlan the repair.");
			await expect(captureExecutionApprovalPresentation(cwd, sessionId, "ralplan")).rejects.toThrow(
				/verified same-pass Architect\/Critic review join/,
			);

			await writeRalplanStage(cwd, sessionId, runId, "architect", 1, architectArtifact, [
				"--lane-verdict",
				"CLEAR",
				"--architect-decision",
				"APPROVE",
			]);

			const presentation = await captureExecutionApprovalPresentation(cwd, sessionId, "ralplan");
			expect(presentation).toMatchObject({ run_id: runId });
		});
	});

	it("requires the exact current-final Ralplan approval prompt outside the Ultragoal guard", async () => {
		await withSession(async (cwd, _manager, sessionId) => {
			await publishReviewedRalplanFinal(cwd, sessionId);
			const presentation = await captureExecutionApprovalPresentation(cwd, sessionId, "ralplan");
			const question = formatRalplanUltragoalApprovalQuestion(presentation);
			if (!question) throw new Error("expected canonical Ralplan approval question");
			const select = vi.fn(async () => "Approve execution via ultragoal");
			const tool = new AskTool({
				cwd,
				hasUI: true,
				settings: Settings.isolated(),
				getSessionId: () => sessionId,
				getSessionFile: () => null,
				getSessionSpawns: () => "*",
			});
			const context = {
				hasUI: true,
				ui: { select, editor: async () => undefined },
				abort: () => {},
			} as unknown as AgentToolContext;
			const options = [
				{ label: "Refine further" },
				{ label: "Approve execution via ultragoal" },
				{ label: "Stop here" },
			];

			await expect(
				tool.execute(
					"generic-ralplan-approval-question",
					{
						questions: [
							{
								id: "ralplan-approval",
								question: "Approve this plan?",
								options,
								recommended: 1,
								multi: false,
								workflowGate: { stage: "ralplan", kind: "approval" },
							},
						],
					},
					undefined,
					undefined,
					context,
				),
			).rejects.toThrow(/exact question and options for the current final publication/);

			await expect(
				tool.execute(
					"extra-question-ralplan-approval",
					{
						questions: [
							{
								id: "ralplan-approval",
								question,
								options,
								recommended: 1,
								multi: false,
								workflowGate: { stage: "ralplan", kind: "approval" },
							},
							{ id: "unrelated", question: "Continue?", options: [{ label: "Yes" }] },
						],
					},
					undefined,
					undefined,
					context,
				),
			).rejects.toThrow(/must be the only question/);
			expect(select).not.toHaveBeenCalled();
			expect(await Bun.file(nonCrystalExecutionApprovalRecordPath(cwd, sessionId, "ralplan")).exists()).toBe(false);
		});
	});

	it("invalidates an earlier final review join when a Planner revision reopens planning", async () => {
		await withSession(async (cwd, _manager, sessionId) => {
			await createUltragoalPlan({ cwd, brief: "Implement the approved repair" });
			await publishReviewedRalplanFinal(cwd, sessionId);
			await writeRalplanStage(
				cwd,
				sessionId,
				"reviewed-current-final",
				"revision",
				2,
				"# Revised plan\n\nChange the repair.",
			);
			await writeRalplanStage(
				cwd,
				sessionId,
				"reviewed-current-final",
				"final",
				2,
				"# Revised final plan\n\nChange the repair.",
			);

			await expect(captureExecutionApprovalPresentation(cwd, sessionId, "ralplan")).rejects.toThrow(
				/verified same-pass Architect\/Critic review join/,
			);
		});
	});

	it("does not offer manual approval for a Ralplan autoresearch admission", async () => {
		await withSession(async (cwd, manager, sessionId) => {
			await fs.writeFile(path.join(cwd, ".gjc", "config.yml"), "gjc:\n  ralplan:\n    autoHandoff: autoresearch\n");
			await createUltragoalPlan({ cwd, brief: "Implement the approved repair" });
			const finalState = await publishReviewedRalplanFinal(cwd, sessionId);
			expect(finalState.auto_handoff).toMatchObject({ effectiveTarget: "autoresearch" });

			await expect(ask(cwd, manager, "ralplan", "autoresearch-is-not-manual-approval", false, true)).rejects.toThrow(
				/Ultragoal try-harder nudge/,
			);
			expect(await Bun.file(nonCrystalExecutionApprovalRecordPath(cwd, sessionId, "ralplan")).exists()).toBe(false);
		});
	});

	it("reserves the approval exception for the built-in Ask tool", async () => {
		await withSession(async (cwd, _manager, sessionId) => {
			await createUltragoalPlan({ cwd, brief: "Implement the approved repair" });
			await publishReviewedRalplanFinal(cwd, sessionId);
			const presentation = await captureExecutionApprovalPresentation(cwd, sessionId, "ralplan");
			const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "asked" }] }));
			const customAsk = {
				name: "ask",
				description: "Extension Ask tool",
				parameters: {},
				execute,
			} as unknown as AgentTool;
			const guarded = guardToolForUltragoalAsk(
				customAsk,
				() => cwd,
				() => ({ sessionId }),
			);
			const approvalQuestion = formatRalplanUltragoalApprovalQuestion(presentation);
			if (!approvalQuestion) throw new Error("expected canonical Ralplan approval question");
			const params = {
				questions: [
					{
						id: "custom-ask-approval",
						question: approvalQuestion,
						options: [
							{ label: "Refine further" },
							{ label: "Approve execution via ultragoal" },
							{ label: "Stop here" },
						],
						recommended: 1,
						multi: false,
						workflowGate: { stage: "ralplan", kind: "approval" },
					},
				],
			};

			await expect(guarded.execute("custom-ask-call", params)).rejects.toThrow(/Ultragoal try-harder nudge/);
			expect(execute).not.toHaveBeenCalled();
		});
	});

	it("does not return free-text Other answers through the Ultragoal approval exception", async () => {
		await withSession(async (cwd, _manager, sessionId) => {
			await createUltragoalPlan({ cwd, brief: "Implement the approved repair" });
			await publishReviewedRalplanFinal(cwd, sessionId);
			const presentation = await captureExecutionApprovalPresentation(cwd, sessionId, "ralplan");
			const question = formatRalplanUltragoalApprovalQuestion(presentation);
			if (!question) throw new Error("expected canonical Ralplan approval question");
			const tool = new AskTool({
				cwd,
				hasUI: true,
				settings: Settings.isolated(),
				getSessionId: () => sessionId,
				getSessionFile: () => null,
				getSessionSpawns: () => "*",
			});
			const guarded = guardToolForUltragoalAsk(
				tool as AgentTool,
				() => cwd,
				() => ({ sessionId }),
			) as AskTool;
			const select = vi.fn(async () => "Other (type your own)");
			const editor = vi.fn(async () => "Postgres");
			const context = {
				hasUI: true,
				ui: { select, editor },
				abort: () => {},
			} as unknown as AgentToolContext;

			await expect(
				guarded.execute(
					"free-text-approval-call",
					{
						questions: [
							{
								id: "approval",
								question,
								options: [
									{ label: "Refine further" },
									{ label: "Approve execution via ultragoal" },
									{ label: "Stop here" },
								],
								recommended: 1,
								multi: false,
								workflowGate: { stage: "ralplan", kind: "approval" },
							},
						],
					},
					undefined,
					undefined,
					context,
				),
			).rejects.toThrow(/accepts only the listed choices, not free text/);
			expect(select).toHaveBeenCalledTimes(1);
			expect(editor).toHaveBeenCalledTimes(1);
			expect(await Bun.file(nonCrystalExecutionApprovalRecordPath(cwd, sessionId, "ralplan")).exists()).toBe(false);
		});
	});

	it("does not let Ralplan approval labels bypass the guard without a current final", async () => {
		await withSession(async (cwd, manager, sessionId) => {
			await createUltragoalPlan({ cwd, brief: "Implement the approved repair" });

			await expect(ask(cwd, manager, "ralplan", "forged-current-final", false, true)).rejects.toThrow(
				/Ultragoal try-harder nudge/,
			);
			expect(await Bun.file(nonCrystalExecutionApprovalRecordPath(cwd, sessionId, "ralplan")).exists()).toBe(false);
		});
	});

	it("blocks ordinary Ask when a current Ralplan final exists during Ultragoal", async () => {
		await withSession(async (cwd, _manager, sessionId) => {
			await createUltragoalPlan({ cwd, brief: "Implement the approved repair" });
			await publishReviewedRalplanFinal(cwd, sessionId);
			const select = vi.fn(async () => "Continue");
			const tool = new AskTool({
				cwd,
				hasUI: true,
				settings: Settings.isolated(),
				getSessionId: () => sessionId,
				getSessionFile: () => null,
				getSessionSpawns: () => "*",
			});
			const guarded = guardToolForUltragoalAsk(
				tool as AgentTool,
				() => cwd,
				() => ({ sessionId }),
			) as AskTool;
			const context = {
				hasUI: true,
				ui: { select, editor: async () => undefined },
				abort: () => {},
			} as unknown as AgentToolContext;

			await expect(
				guarded.execute(
					"ordinary-ask",
					{ questions: [{ id: "ordinary", question: "Continue?", options: [{ label: "Continue" }] }] },
					undefined,
					undefined,
					context,
				),
			).rejects.toThrow(/try-harder nudge/);
			expect(select).not.toHaveBeenCalled();
		});
	});

	it("blocks mixed-purpose options even when a current Ralplan final exists", async () => {
		await withSession(async (cwd, _manager, sessionId) => {
			await createUltragoalPlan({ cwd, brief: "Implement the approved repair" });
			await publishReviewedRalplanFinal(cwd, sessionId);
			const select = vi.fn(async () => "Postgres");
			const tool = new AskTool({
				cwd,
				hasUI: true,
				settings: Settings.isolated(),
				getSessionId: () => sessionId,
				getSessionFile: () => null,
				getSessionSpawns: () => "*",
			});
			const guarded = guardToolForUltragoalAsk(
				tool as AgentTool,
				() => cwd,
				() => ({ sessionId }),
			) as AskTool;
			const context = {
				hasUI: true,
				ui: { select, editor: async () => undefined },
				abort: () => {},
			} as unknown as AgentToolContext;

			await expect(
				guarded.execute(
					"mixed-purpose-ask",
					{
						questions: [
							{
								id: "database-choice",
								question: "Which database should we use?",
								options: [
									{ label: "Postgres" },
									{ label: "SQLite" },
									{ label: "Approve execution via ultragoal" },
								],
								recommended: 1,
								multi: false,
								workflowGate: { stage: "ralplan", kind: "approval" },
							},
						],
					},
					undefined,
					undefined,
					context,
				),
			).rejects.toThrow(/Ultragoal try-harder nudge/);
			expect(select).not.toHaveBeenCalled();
			expect(await Bun.file(nonCrystalExecutionApprovalRecordPath(cwd, sessionId, "ralplan")).exists()).toBe(false);
		});
	});

	it("blocks an unrelated prompt even with canonical approval options", async () => {
		await withSession(async (cwd, _manager, sessionId) => {
			await createUltragoalPlan({ cwd, brief: "Implement the approved repair" });
			await publishReviewedRalplanFinal(cwd, sessionId);
			const select = vi.fn(async () => "Postgres");
			const tool = new AskTool({
				cwd,
				hasUI: true,
				settings: Settings.isolated(),
				getSessionId: () => sessionId,
				getSessionFile: () => null,
				getSessionSpawns: () => "*",
			});
			const guarded = guardToolForUltragoalAsk(
				tool as AgentTool,
				() => cwd,
				() => ({ sessionId }),
			) as AskTool;
			const context = {
				hasUI: true,
				ui: { select, editor: async () => undefined },
				abort: () => {},
			} as unknown as AgentToolContext;

			await expect(
				guarded.execute(
					"unrelated-approval-prompt",
					{
						questions: [
							{
								id: "database-choice",
								question: "Which database should we use?",
								options: [
									{ label: "Refine further" },
									{ label: "Approve execution via ultragoal" },
									{ label: "Stop here" },
								],
								recommended: 1,
								multi: false,
								workflowGate: { stage: "ralplan", kind: "approval" },
							},
						],
					},
					undefined,
					undefined,
					context,
				),
			).rejects.toThrow(/Ultragoal try-harder nudge/);
			expect(select).not.toHaveBeenCalled();
			expect(await Bun.file(nonCrystalExecutionApprovalRecordPath(cwd, sessionId, "ralplan")).exists()).toBe(false);
		});
	});

	it("blocks a tampered Ralplan final before presenting Ultragoal approval", async () => {
		await withSession(async (cwd, manager, sessionId) => {
			await createUltragoalPlan({ cwd, brief: "Implement the approved repair" });
			await publishReviewedRalplanFinal(cwd, sessionId);
			const presentation = await captureExecutionApprovalPresentation(cwd, sessionId, "ralplan");
			await fs.writeFile(presentation.artifact_path, "# Substituted plan\n");

			await expect(ask(cwd, manager, "ralplan", "tampered-current-final", false, true)).rejects.toThrow(
				/Ultragoal try-harder nudge/,
			);
			expect(await Bun.file(nonCrystalExecutionApprovalRecordPath(cwd, sessionId, "ralplan")).exists()).toBe(false);
		});
	});

	for (const stage of ["deep-interview", "ralplan"] as const) {
		it(`${stage}: real Ask and persistent continuation approve the published artifact before handoff`, async () => {
			await withSession(async (cwd, manager, sessionId) => {
				await publish(cwd, sessionId, stage);
				expect((await handoff(cwd, sessionId, stage)).status).toBe(2);
				await ask(cwd, manager, stage, "approve-report", false);
				expect((await approval(cwd, sessionId, stage)).status).toBe("pending");
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

		// SessionManager full rewrites replace the transcript inode (atomic rename); consent binds content.
		it(`${stage}: a SessionManager full rewrite after approval keeps consent valid at handoff`, async () => {
			await withSession(async (cwd, manager, sessionId) => {
				await publish(cwd, sessionId, stage);
				await ask(cwd, manager, stage, "approve-report", false);
				if (stage === "deep-interview") expect((await consume(cwd, sessionId)).status).toBe(0);
				const transcriptPath = manager.getSessionFile()!;
				const inodeBefore = (await fs.stat(transcriptPath)).ino;
				await manager.rewriteEntries();
				expect((await fs.stat(transcriptPath)).ino).not.toBe(inodeBefore);
				const result = await handoff(cwd, sessionId, stage);
				expect(result.status, result.stderr).toBe(0);
				expect(JSON.parse(await fs.readFile(modeStatePath(cwd, sessionId, "ultragoal"), "utf8")).active).toBe(true);
			});
		});

		// Records written before this change carry device/inode in transcript_boundary; they stay readable.
		if (stage === "ralplan")
			it("ralplan: a legacy record with device/inode boundary keys is accepted after a rewrite", async () => {
				await withSession(async (cwd, manager, sessionId) => {
					await publish(cwd, sessionId, stage);
					await ask(cwd, manager, stage, "approve-report", false);
					const recordPath = nonCrystalExecutionApprovalRecordPath(cwd, sessionId, stage);
					const original = await fs.readFile(recordPath, "utf8");
					const record = JSON.parse(original);
					record.transcript_boundary = { ...record.transcript_boundary, device: "1", inode: "1" };
					const legacy = JSON.stringify(record);
					await fs.writeFile(recordPath, legacy);
					// Re-seal the audit digest as the unpatched binary would have written it for this record.
					const sha = (text: string) => createHash("sha256").update(text).digest("hex");
					const audit = await fs.readFile(auditPath(cwd, sessionId), "utf8");
					expect(audit).toContain(sha(original));
					await fs.writeFile(auditPath(cwd, sessionId), audit.replaceAll(sha(original), sha(legacy)));
					await manager.rewriteEntries();
					const result = await handoff(cwd, sessionId, stage);
					expect(result.status, result.stderr).toBe(0);
				});
			});

		it(`${stage}: a new persisted user message invalidates consent`, async () => {
			await withSession(async (cwd, manager, sessionId) => {
				await publish(cwd, sessionId, stage);
				await ask(cwd, manager, stage, "approve-report", false);
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
				await ask(cwd, manager, stage, "approve-report", false);
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
				await ask(cwd, manager, stage, "approve-report", false);
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

		it(`${stage}: a repeated question label accepts a fresh gate only for a newer publication`, async () => {
			await withSession(async (cwd, manager, sessionId) => {
				await publish(cwd, sessionId, stage);
				await ask(cwd, manager, stage);
				if (stage === "deep-interview") expect((await consume(cwd, sessionId)).status).toBe(0);
				const previous = await approval(cwd, sessionId, stage);
				const record = async (gateId: string) => {
					const transcriptPath = manager.getSessionFile()!;
					const toolCallId = `provider-${gateId}`;
					manager.appendMessage(assistant([{ type: "toolCall", id: toolCallId, name: "ask", arguments: {} }]));
					await manager.flush();
					await recordNonCrystalExecutionApproval({
						cwd,
						sessionId,
						approvalStage: stage,
						questionId: previous.question_id,
						gateId,
						toolCallId,
						target: "ultragoal",
						selectedOptions: ["Approve execution via ultragoal"],
						transcriptPath,
						transcriptSha256: createHash("sha256")
							.update(await fs.readFile(transcriptPath))
							.digest("hex"),
						presentation: await captureExecutionApprovalPresentation(cwd, sessionId, stage),
					});
					manager.appendMessage({
						role: "toolResult",
						toolCallId,
						toolName: "ask",
						content: [{ type: "text", text: "Approve execution via ultragoal" }],
						details: {
							questions: [{ id: previous.question_id, selectedOptions: ["Approve execution via ultragoal"] }],
						},
						isError: false,
						timestamp: Date.now(),
					});
					await manager.flush();
				};
				await expect(record("fresh-gate-same-publication")).rejects.toThrow("replay");
				await publish(cwd, sessionId, stage, 2);
				await expect(record(previous.gate_id)).rejects.toThrow("replay");
				await record("fresh-gate-new-publication");
				const renewed = await approval(cwd, sessionId, stage);
				expect(renewed.question_id).toBe(previous.question_id);
				expect(renewed.gate_id).not.toBe(previous.gate_id);
				expect(renewed.artifact_sha256).not.toBe(previous.artifact_sha256);
				const consumed = await runNativeStateCommand(
					["approve-execution", "--mode", stage, "--session-id", sessionId, "--json"],
					cwd,
				);
				expect(consumed.status, consumed.stderr).toBe(0);
				const result = await handoff(cwd, sessionId, stage);
				expect(result.status, result.stderr).toBe(0);
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
	it("Crystal renewal accepts a repeated question label but rejects its consumed gate", async () => {
		await withSession(async (cwd, manager, sessionId) => {
			await publishCrystal(cwd, sessionId);
			await ask(cwd, manager, "deep-interview");
			expect((await consume(cwd, sessionId)).status).toBe(0);
			const recordPath = deepInterviewExecutionApprovalRecordPath(cwd, sessionId);
			const previous = JSON.parse(await fs.readFile(recordPath, "utf8"));
			manager.appendMessage({ role: "user", content: "Encrypt backups.", timestamp: Date.now() });
			await manager.flush();
			await publishCrystal(cwd, sessionId);
			const transcriptPath = manager.getSessionFile()!;
			const renewalToolCallId = "provider-renewed-crystal";
			manager.appendMessage(assistant([{ type: "toolCall", id: renewalToolCallId, name: "ask", arguments: {} }]));
			await manager.flush();
			const descriptor = {
				cwd,
				sessionId,
				questionId: previous.question_id,
				target: "ultragoal",
				selectedOptions: ["Approve execution via ultragoal"],
				transcriptPath,
				transcriptSha256: createHash("sha256")
					.update(await fs.readFile(transcriptPath))
					.digest("hex"),
				toolCallId: renewalToolCallId,
				presentation: await captureExecutionApprovalPresentation(cwd, sessionId, "deep-interview"),
			};
			await expect(
				recordDeepInterviewExecutionApproval({ ...descriptor, gateId: previous.gate_id }),
			).rejects.toThrow("already consumed");
			const renewed = await recordDeepInterviewExecutionApproval({ ...descriptor, gateId: "fresh-crystal-gate" });
			manager.appendMessage({
				role: "toolResult",
				toolCallId: renewalToolCallId,
				toolName: "ask",
				content: [{ type: "text", text: "Approve execution via ultragoal" }],
				details: {
					questions: [{ id: previous.question_id, selectedOptions: ["Approve execution via ultragoal"] }],
				},
				isError: false,
				timestamp: Date.now(),
			});
			await manager.flush();
			expect(renewed.record.question_id).toBe(previous.question_id);
			expect(renewed.record.crystal_spec_version).toBe(previous.crystal_spec_version + 1);
			expect(renewed.record.spec_sha256).not.toBe(previous.spec_sha256);
			const result = await consume(cwd, sessionId);
			expect(result.status, result.stderr).toBe(0);
		});
	});

	it("a replacement Ralplan run does not inherit consumed Crystal consent from a historical handoff", async () => {
		await withSession(async (cwd, manager, sessionId) => {
			await publishCrystal(cwd, sessionId);
			const planning = await runNativeStateCommand(
				["handoff", "--mode", "deep-interview", "--to", "ralplan", "--session-id", sessionId, "--json"],
				cwd,
			);
			expect(planning.status, planning.stderr).toBe(0);
			await publish(cwd, sessionId, "ralplan");
			expect(await executionApprovalLineage(cwd, sessionId, "ralplan")).toBe("crystal");
			await ask(cwd, manager, "ralplan", "approve-linked-crystal", false);
			const crystalApprovalPath = deepInterviewExecutionApprovalRecordPath(cwd, sessionId);
			const crystalApproval = await fs.readFile(crystalApprovalPath, "utf8");
			expect(JSON.parse(crystalApproval).status).toBe("pending");
			const indexPath = path.join(sessionStateDir(cwd, sessionId), "deep-interview-handoff-ralplan-audit.json");
			const oldIndex = await fs.readFile(indexPath, "utf8");
			const oldAudit = await fs.readFile(auditPath(cwd, sessionId), "utf8");
			await publishReviewedRalplanFinal(cwd, sessionId, "replacement-plan");
			expect(await executionApprovalLineage(cwd, sessionId, "ralplan")).toBe("ordinary");
			expect((await handoff(cwd, sessionId, "ralplan")).status).toBe(2);
			await ask(cwd, manager, "ralplan", "approve-independent-plan");
			const result = await handoff(cwd, sessionId, "ralplan");
			expect(result.status, result.stderr).toBe(0);
			expect(await fs.readFile(indexPath, "utf8")).toBe(oldIndex);
			expect((await fs.readFile(auditPath(cwd, sessionId), "utf8")).startsWith(oldAudit)).toBe(true);
			expect(await fs.readFile(crystalApprovalPath, "utf8")).toBe(crystalApproval);
		});
	});

	for (const damage of ["missing-upstream", "missing-audit", "missing-lineage", "wrong-timestamp"] as const) {
		it(`linked Ralplan refuses ${damage} instead of falling back to ordinary approval`, async () => {
			await withSession(async (cwd, manager, sessionId) => {
				await publishCrystal(cwd, sessionId);
				const planning = await runNativeStateCommand(
					["handoff", "--mode", "deep-interview", "--to", "ralplan", "--session-id", sessionId, "--json"],
					cwd,
				);
				expect(planning.status, planning.stderr).toBe(0);
				await publish(cwd, sessionId, "ralplan");
				if (damage === "missing-upstream") {
					await fs.rm(modeStatePath(cwd, sessionId, "deep-interview"));
				} else if (damage === "missing-audit") {
					await fs.rm(path.join(sessionStateDir(cwd, sessionId), "deep-interview-handoff-ralplan-audit.json"));
					const audit = await fs.readFile(auditPath(cwd, sessionId), "utf8");
					await fs.writeFile(
						auditPath(cwd, sessionId),
						audit
							.split("\n")
							.filter(line => !line || JSON.parse(line).verb !== "handoff")
							.join("\n"),
					);
				} else {
					const statePath = modeStatePath(cwd, sessionId, "ralplan");
					const state = JSON.parse(await fs.readFile(statePath, "utf8"));
					if (damage === "missing-lineage") {
						delete state.handoff_from;
						delete state.handoff_at;
						delete state.upstream_handoff_at;
					} else {
						state.handoff_at = "2026-01-01T00:00:00.000Z";
					}
					await fs.writeFile(statePath, JSON.stringify(state));
				}
				await expect(ask(cwd, manager, "ralplan")).rejects.toThrow();
				expect(await Bun.file(nonCrystalExecutionApprovalRecordPath(cwd, sessionId, "ralplan")).exists()).toBe(
					false,
				);
				expect((await handoff(cwd, sessionId, "ralplan")).status).toBe(2);
			});
		});
	}

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
