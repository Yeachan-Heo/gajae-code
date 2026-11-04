import { describe, expect, it, vi } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolContext } from "@gajae-code/agent-core";
import type { AssistantMessage } from "@gajae-code/ai/types";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { crystalSnapshotDigest } from "@gajae-code/coding-agent/gjc-runtime/deep-interview-crystallize";
import {
	authoritativeConversationSnapshot,
	runNativeDeepInterviewCommand,
} from "@gajae-code/coding-agent/gjc-runtime/deep-interview-runtime";
import { runNativeRalplanCommand } from "@gajae-code/coding-agent/gjc-runtime/ralplan-runtime";
import {
	activeSnapshotPath,
	auditPath,
	modeStatePath,
	sessionSpecsDir,
	sessionStateDir,
	transactionJournalPath,
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
	revokeNonCrystalExecutionApproval,
	runNativeStateCommand,
} from "@gajae-code/coding-agent/gjc-runtime/state-runtime";
import {
	isPathIdentityWithin,
	isSamePathIdentity,
	physicalPathIdentity,
} from "@gajae-code/coding-agent/gjc-runtime/state-writer";
import { initTheme } from "@gajae-code/coding-agent/modes/theme/theme";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { AskTool } from "@gajae-code/coding-agent/tools/ask";

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

/**
 * `aliasCwd` launches the session from a symlink alias of the workspace (macOS
 * `/tmp` -> `/private/tmp`, #7562): the transcript header and the returned cwd
 * spell the alias while the transcript file itself lives at its physical path.
 * The alias lives under a different parent than its target, so `..` from the
 * alias and `..` from the physical root name different directories.
 */
async function withSession(
	fn: (cwd: string, manager: SessionManager, sessionId: string) => Promise<void>,
	options: { aliasCwd?: boolean } = {},
) {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ordinary-execution-approval-")));
	const aliasParent = options.aliasCwd
		? await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ordinary-execution-alias-")))
		: undefined;
	const cwd = aliasParent ? path.join(aliasParent, "project") : root;
	if (aliasParent) await fs.symlink(root, cwd);
	const oldId = process.env.GJC_SESSION_ID;
	const oldFile = process.env.GJC_SESSION_FILE;
	const manager = SessionManager.create(cwd, SessionManager.explicitDestination(path.join(root, ".gjc", "sessions")));
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
		if (aliasParent) await fs.rm(aliasParent, { recursive: true, force: true });
		await fs.rm(root, { recursive: true, force: true });
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

async function ask(
	cwd: string,
	manager: SessionManager,
	stage: ExecutionApprovalStage,
	id = "approve-report",
	consumeRalplan = true,
) {
	const label = "Approve execution via ultragoal";
	const toolCallId = `provider-${id}-${++askInvocationCounter}`;
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
	const result = await tool.execute(toolCallId, args, undefined, undefined, context);
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

function pathWithin(root: string, filePath: string): boolean {
	const relative = path.relative(root, path.resolve(filePath));
	return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function aliasPath(filePath: string, realRoot: string, aliasRoot: string): string {
	if (pathWithin(aliasRoot, filePath)) return filePath;
	if (!pathWithin(realRoot, filePath)) return filePath;
	return path.join(aliasRoot, path.relative(realRoot, filePath));
}

async function writeAliasEraApproval(
	realRoot: string,
	aliasRoot: string,
	sessionId: string,
	record: Record<string, unknown>,
): Promise<void> {
	const aliasedRecord = { ...record };
	// Base wrote workflow-root-derived paths using cwd's alias spelling. The
	// SessionManager-owned transcript path remains canonical and keeps its own
	// strict transcript identity checks.
	for (const key of ["state_path", "artifact_path"] as const) {
		const value = aliasedRecord[key];
		if (typeof value === "string") aliasedRecord[key] = aliasPath(value, realRoot, aliasRoot);
	}
	const recordPath = nonCrystalExecutionApprovalRecordPath(aliasRoot, sessionId, "ralplan");
	const content = `${JSON.stringify(aliasedRecord)}\n`;
	const digest = createHash("sha256").update(content).digest("hex");
	await fs.writeFile(recordPath, content);

	const auditFile = auditPath(aliasRoot, sessionId);
	const auditLines = (await fs.readFile(auditFile, "utf8")).split(/\r?\n/);
	let approvalRowUpdated = false;
	for (let index = auditLines.length - 1; index >= 0; index--) {
		const line = auditLines[index];
		if (!line) continue;
		const row = JSON.parse(line);
		if (Array.isArray(row.paths)) {
			row.paths = row.paths.map((value: unknown) =>
				typeof value === "string" ? aliasPath(value, realRoot, aliasRoot) : value,
			);
		}
		if (
			!approvalRowUpdated &&
			row.owner === "gjc-runtime" &&
			row.verb === "approve-execution" &&
			row.skill === "ralplan" &&
			row.ordinary_approval_status === aliasedRecord.status
		) {
			row.ordinary_approval_sha256 = digest;
			row.mutation_id = `ralplan:ordinary-execution-approval:${String(aliasedRecord.status)}:${digest}`;
			approvalRowUpdated = true;
		}
		auditLines[index] = JSON.stringify(row);
	}
	if (!approvalRowUpdated) throw new Error("alias-era ordinary approval audit row was not found");
	await fs.writeFile(auditFile, auditLines.join("\n"));
}

async function withAliasEraRalplanApproval(
	fn: (realRoot: string, aliasRoot: string, manager: SessionManager, sessionId: string) => Promise<void>,
) {
	await withSession(
		async (aliasRoot, manager, sessionId) => {
			const realRoot = await fs.realpath(aliasRoot);
			await publish(aliasRoot, sessionId, "ralplan");
			await ask(aliasRoot, manager, "ralplan", "approve-before-upgrade", false);
			const record = await approval(aliasRoot, sessionId, "ralplan");
			expect(record.status).toBe("pending");
			await writeAliasEraApproval(realRoot, aliasRoot, sessionId, record);
			const aliasEraRecord = await approval(realRoot, sessionId, "ralplan");
			for (const key of ["state_path", "artifact_path"] as const)
				expect(aliasEraRecord[key].startsWith(aliasRoot)).toBe(true);
			const audit = await fs.readFile(auditPath(realRoot, sessionId), "utf8");
			const approvalRow = audit
				.split(/\r?\n/)
				.filter(Boolean)
				.map(line => JSON.parse(line))
				.find(row => row.verb === "approve-execution" && row.skill === "ralplan");
			expect(approvalRow.paths).toContain(nonCrystalExecutionApprovalRecordPath(aliasRoot, sessionId, "ralplan"));
			await fn(realRoot, aliasRoot, manager, sessionId);
		},
		{ aliasCwd: true },
	);
}

async function publishCrystal(cwd: string, sessionId: string) {
	const result = await crystallize(cwd, sessionId);
	expect(result.status, result.stderr).toBe(0);
}

async function crystallize(cwd: string, sessionId: string) {
	const live = await authoritativeConversationSnapshot(cwd, sessionId);
	const source = { revision: live.revision, start: 0, end: live.messages.length - 1, messages: live.messages };
	return runNativeDeepInterviewCommand(
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
}

describe("non-Crystal user-gated execution approval", () => {
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
	for (const writer of ["physical", "alias"] as const) {
		it(`ordinary interview -> Ralplan approval authenticates from an alias session cwd (writer: ${writer}) (#7562)`, async () => {
			await withSession(
				async (cwd, manager, sessionId) => {
					const physical = await fs.realpath(cwd);
					expect(physical).not.toBe(cwd);
					const writerCwd = writer === "physical" ? physical : cwd;
					await publish(writerCwd, sessionId, "deep-interview");
					const planning = await runNativeStateCommand(
						["handoff", "--mode", "deep-interview", "--to", "ralplan", "--session-id", sessionId, "--json"],
						writerCwd,
					);
					expect(planning.status, planning.stderr).toBe(0);
					await publish(writerCwd, sessionId, "ralplan");
					const audit = await fs.readFile(
						path.join(sessionStateDir(physical, sessionId), "deep-interview-handoff-ralplan-audit.json"),
						"utf8",
					);
					expect(audit).toContain(modeStatePath(physical, sessionId, "deep-interview"));
					expect(audit).not.toContain(cwd);
					expect(await executionApprovalLineage(cwd, sessionId, "ralplan")).toBe("ordinary");
					// The Ask tool runs with the session's alias cwd, as on macOS `/tmp`.
					await ask(cwd, manager, "ralplan", "approve-report", false);
					expect((await approval(cwd, sessionId, "ralplan")).status).toBe("pending");
					const result = await handoff(cwd, sessionId, "ralplan");
					expect(result.status, result.stderr).toBe(0);
					expect(
						JSON.parse(await fs.readFile(modeStatePath(physical, sessionId, "ultragoal"), "utf8")).active,
					).toBe(true);
				},
				{ aliasCwd: true },
			);
		});
	}

	/**
	 * Publish an interview -> Ralplan lineage the way a writer from before #7562
	 * did under an alias cwd: workflow-root canonicalization is disabled for
	 * `aliasRoot` only, so every audit, receipt, and checksum spells the alias
	 * while the bytes land at the physical target.
	 */
	async function asPreCanonicalWriter(aliasRoot: string, write: () => Promise<void>) {
		const realpath = fs.realpath;
		const spy = vi
			.spyOn(fs, "realpath")
			.mockImplementation((async (target: string, ...rest: unknown[]) =>
				path.resolve(String(target)) === aliasRoot
					? aliasRoot
					: (realpath as (...args: unknown[]) => Promise<string>)(target, ...rest)) as typeof fs.realpath);
		try {
			await write();
		} finally {
			spy.mockRestore();
		}
	}

	async function publishPreCanonicalAliasLineage(aliasRoot: string, sessionId: string) {
		await asPreCanonicalWriter(aliasRoot, async () => {
			await publish(aliasRoot, sessionId, "deep-interview");
			const planning = await runNativeStateCommand(
				["handoff", "--mode", "deep-interview", "--to", "ralplan", "--session-id", sessionId, "--json"],
				aliasRoot,
			);
			expect(planning.status, planning.stderr).toBe(0);
			await publish(aliasRoot, sessionId, "ralplan");
		});
	}

	function handoffAuditFiles(physical: string, sessionId: string): string[] {
		return [
			path.join(sessionStateDir(physical, sessionId), "deep-interview-handoff-ralplan-audit.json"),
			auditPath(physical, sessionId),
		];
	}

	it("alias-spelled handoff audits and receipts written before #7562 still authenticate", async () => {
		await withSession(
			async (cwd, manager, sessionId) => {
				const physical = await fs.realpath(cwd);
				expect(path.dirname(physical)).not.toBe(path.dirname(cwd));
				await publishPreCanonicalAliasLineage(cwd, sessionId);
				const [index] = handoffAuditFiles(physical, sessionId);
				const audit = await fs.readFile(index!, "utf8");
				expect(audit).toContain(modeStatePath(cwd, sessionId, "deep-interview"));
				expect(audit).not.toContain(physical);
				await ask(cwd, manager, "ralplan", "approve-report", false);
				const result = await handoff(cwd, sessionId, "ralplan");
				expect(result.status, result.stderr).toBe(0);
				expect(JSON.parse(await fs.readFile(modeStatePath(physical, sessionId, "ultragoal"), "utf8")).active).toBe(
					true,
				);
			},
			{ aliasCwd: true },
		);
	});

	it("an ordinary interview final published before #7562 under an alias approves from that alias", async () => {
		await withSession(
			async (cwd, manager, sessionId) => {
				const physical = await fs.realpath(cwd);
				await asPreCanonicalWriter(cwd, async () => {
					await publish(cwd, sessionId, "deep-interview");
				});
				const state = JSON.parse(await fs.readFile(modeStatePath(physical, sessionId, "deep-interview"), "utf8"));
				expect(state.spec_path.startsWith(`${cwd}${path.sep}`)).toBe(true);
				await ask(cwd, manager, "deep-interview", "approve-report", false);
				const consumed = await consume(cwd, sessionId);
				expect(consumed.status, consumed.stderr).toBe(0);
				const result = await handoff(cwd, sessionId, "deep-interview");
				expect(result.status, result.stderr).toBe(0);
				expect(JSON.parse(await fs.readFile(modeStatePath(physical, sessionId, "ultragoal"), "utf8")).active).toBe(
					true,
				);
			},
			{ aliasCwd: true },
		);
	});

	/**
	 * An alias session authenticated its managed (agent-dir) transcript; a
	 * project transcript under the alias never passed the no-follow reader.
	 */
	async function withAliasCrystalSession(
		fn: (cwd: string, physical: string, manager: SessionManager, sessionId: string) => Promise<void>,
	) {
		await withSession(
			async cwd => {
				const physical = await fs.realpath(cwd);
				const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "alias-crystal-agent-"));
				const oldAgentDir = process.env.GJC_CODING_AGENT_DIR;
				const oldSessionFile = process.env.GJC_SESSION_FILE;
				const oldSessionId = process.env.GJC_SESSION_ID;
				process.env.GJC_CODING_AGENT_DIR = agentDir;
				delete process.env.GJC_SESSION_FILE;
				delete process.env.GJC_SESSION_ID;
				const manager = SessionManager.create(cwd);
				try {
					const sessionId = manager.getSessionId();
					process.env.GJC_SESSION_ID = sessionId;
					manager.appendMessage({ role: "user", content: "Build a report.", timestamp: Date.now() });
					await manager.ensureOnDisk();
					await manager.flush();
					await fn(cwd, physical, manager, sessionId);
				} finally {
					await manager.close();
					if (oldAgentDir === undefined) delete process.env.GJC_CODING_AGENT_DIR;
					else process.env.GJC_CODING_AGENT_DIR = oldAgentDir;
					process.env.GJC_SESSION_FILE = oldSessionFile;
					process.env.GJC_SESSION_ID = oldSessionId;
					await fs.rm(agentDir, { recursive: true, force: true });
				}
			},
			{ aliasCwd: true },
		);
	}

	it("a Crystal approval recorded before #7562 under an alias is consumed through that alias", async () => {
		await withAliasCrystalSession(async (cwd, physical, manager, sessionId) => {
			await asPreCanonicalWriter(cwd, async () => {
				await publishCrystal(cwd, sessionId);
				await ask(cwd, manager, "deep-interview");
			});
			const record = JSON.parse(
				await fs.readFile(deepInterviewExecutionApprovalRecordPath(physical, sessionId), "utf8"),
			);
			expect(record.status).toBe("pending");
			expect(record.state_path).toBe(modeStatePath(cwd, sessionId, "deep-interview"));
			expect(record.spec_path.startsWith(`${cwd}${path.sep}`)).toBe(true);
			const consumed = await consume(cwd, sessionId);
			expect(consumed.status, consumed.stderr).toBe(0);
			const after = JSON.parse(
				await fs.readFile(deepInterviewExecutionApprovalRecordPath(physical, sessionId), "utf8"),
			);
			expect(after.status).toBe("consumed");
			const result = await handoff(cwd, sessionId, "deep-interview");
			expect(result.status, result.stderr).toBe(0);
			expect(JSON.parse(await fs.readFile(modeStatePath(physical, sessionId, "ultragoal"), "utf8")).active).toBe(
				true,
			);
		});
	});

	it("a Ralplan-stage Crystal approval recorded before #7562 under an alias hands off through that alias", async () => {
		await withAliasCrystalSession(async (cwd, physical, manager, sessionId) => {
			await asPreCanonicalWriter(cwd, async () => {
				await publishCrystal(cwd, sessionId);
				const planning = await runNativeStateCommand(
					["handoff", "--mode", "deep-interview", "--to", "ralplan", "--session-id", sessionId, "--json"],
					cwd,
				);
				expect(planning.status, planning.stderr).toBe(0);
				await publish(cwd, sessionId, "ralplan");
				await ask(cwd, manager, "ralplan", "approve-linked-crystal", false);
			});
			const record = JSON.parse(
				await fs.readFile(deepInterviewExecutionApprovalRecordPath(physical, sessionId), "utf8"),
			);
			expect(record.status).toBe("pending");
			expect(record.approval_stage).toBe("ralplan");
			expect(record.ralplan_state_path).toBe(modeStatePath(cwd, sessionId, "ralplan"));
			const consumed = await consume(cwd, sessionId);
			expect(consumed.status, consumed.stderr).toBe(0);
			const result = await runNativeStateCommand(
				["handoff", "--mode", "ralplan", "--to", "ultragoal", "--session-id", sessionId, "--json"],
				cwd,
			);
			expect(result.status, result.stderr).toBe(0);
			expect(JSON.parse(await fs.readFile(modeStatePath(physical, sessionId, "ultragoal"), "utf8")).active).toBe(
				true,
			);
		});
	});

	it("a pending Crystal journal recorded under an alias before its files exist resumes through that alias", async () => {
		await withAliasCrystalSession(async (cwd, physical, _manager, sessionId) => {
			const slug = "historical-crystal";
			const aliasSpec = path.join(sessionSpecsDir(cwd, sessionId), `deep-interview-${slug}-v1.md`);
			const aliasIndex = path.join(sessionSpecsDir(cwd, sessionId), "deep-interview-index.jsonl");
			const aliasState = modeStatePath(cwd, sessionId, "deep-interview");
			// A pre-#7562 writer began the journal (destinations recorded, none written) and stopped.
			const mutationId = `crystal:${sessionId}:1:${createHash("sha256").update(`${slug}\0${aliasSpec}`).digest("hex")}`;
			const journalFile = transactionJournalPath(physical, sessionId, mutationId);
			const now = new Date().toISOString();
			await fs.mkdir(path.dirname(journalFile), { recursive: true });
			await fs.writeFile(
				journalFile,
				JSON.stringify({
					version: 1,
					mutation_id: mutationId,
					status: "pending",
					created_at: now,
					updated_at: now,
					paths: [aliasSpec, aliasIndex, aliasState],
					steps: [],
				}),
			);
			for (const destination of [aliasSpec, aliasIndex, aliasState])
				expect(await Bun.file(destination).exists()).toBe(false);
			await publishCrystal(cwd, sessionId);
			// The publication completed under the writer's own mutation id; no second journal was minted.
			expect(await Bun.file(journalFile).exists()).toBe(false);
			const remaining = await fs.readdir(path.dirname(journalFile)).catch(() => [] as string[]);
			expect(remaining.filter(name => name.endsWith(".json"))).toEqual([]);
			const state = JSON.parse(await fs.readFile(modeStatePath(physical, sessionId, "deep-interview"), "utf8"));
			expect(await isSamePathIdentity(state.spec_path, aliasSpec)).toBe(true);
			expect(await Bun.file(state.spec_path).exists()).toBe(true);
		});
	});

	it("a pending Crystal journal whose recorded destinations name a foreign root is refused", async () => {
		await withAliasCrystalSession(async (cwd, physical, _manager, sessionId) => {
			const foreign = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "foreign-crystal-root-")));
			try {
				const slug = "historical-crystal";
				const foreignSpec = path.join(sessionSpecsDir(foreign, sessionId), `deep-interview-${slug}-v1.md`);
				const mutationId = `crystal:${sessionId}:1:${createHash("sha256").update(`${slug}\0${foreignSpec}`).digest("hex")}`;
				const journalFile = transactionJournalPath(physical, sessionId, mutationId);
				const now = new Date().toISOString();
				await fs.mkdir(path.dirname(journalFile), { recursive: true });
				await fs.writeFile(
					journalFile,
					JSON.stringify({
						version: 1,
						mutation_id: mutationId,
						status: "pending",
						created_at: now,
						updated_at: now,
						paths: [
							foreignSpec,
							path.join(sessionSpecsDir(foreign, sessionId), "deep-interview-index.jsonl"),
							modeStatePath(foreign, sessionId, "deep-interview"),
						],
						steps: [],
					}),
				);
				const result = await crystallize(cwd, sessionId);
				expect(result.status).toBe(2);
				expect(result.stderr).toContain("pending Crystal transaction journal identity mismatch");
				expect(await Bun.file(modeStatePath(physical, sessionId, "deep-interview")).exists()).toBe(false);
			} finally {
				await fs.rm(foreign, { recursive: true, force: true });
			}
		});
	});

	it("a Crystal published before #7562 under an alias approves and re-publishes from that alias", async () => {
		await withAliasCrystalSession(async (cwd, physical, manager, sessionId) => {
			await asPreCanonicalWriter(cwd, async () => {
				await publishCrystal(cwd, sessionId);
			});
			const statePath = modeStatePath(physical, sessionId, "deep-interview");
			const state = JSON.parse(await fs.readFile(statePath, "utf8"));
			expect(state.spec_path.startsWith(`${cwd}${path.sep}`)).toBe(true);
			const index = await fs.readFile(
				path.join(sessionSpecsDir(physical, sessionId), "deep-interview-index.jsonl"),
				"utf8",
			);
			expect(index).toContain(cwd);
			expect(index).not.toContain(physical);
			// Replaying the same Crystal reads the alias-spelled index and spec path.
			await publishCrystal(cwd, sessionId);
			await ask(cwd, manager, "deep-interview");
			const consumed = await consume(cwd, sessionId);
			expect(consumed.status, consumed.stderr).toBe(0);
			// A new Crystal version is indexed beside the alias-era rows.
			manager.appendMessage({ role: "user", content: "Encrypt backups.", timestamp: Date.now() });
			await manager.flush();
			await publishCrystal(cwd, sessionId);
			const renewed = JSON.parse(await fs.readFile(statePath, "utf8"));
			expect(renewed.spec_path).not.toBe(state.spec_path);
			expect(renewed.spec_path.startsWith(`${sessionSpecsDir(physical, sessionId)}${path.sep}`)).toBe(true);
		});
	});

	it("path identity equates alias spellings, including not-yet-created files, and nothing else (#7562)", async () => {
		await withSession(
			async (cwd, _manager, sessionId) => {
				const physical = await fs.realpath(cwd);
				const specsDir = sessionSpecsDir(physical, sessionId);
				await fs.mkdir(specsDir, { recursive: true });
				await fs.mkdir(`${specsDir}-evil`, { recursive: true });
				await fs.writeFile(path.join(specsDir, "spec.md"), "inside");
				await fs.writeFile(path.join(`${specsDir}-evil`, "spec.md"), "sibling");
				await fs.writeFile(path.join(physical, ".gjc", "spec.md"), "outside");
				const aliasSpecs = sessionSpecsDir(cwd, sessionId);

				// Identity: realpath of the deepest existing ancestor plus the missing tail.
				const pending = path.join(aliasSpecs, "not-yet", "journal-target.json");
				expect(await physicalPathIdentity(pending)).toBe(path.join(specsDir, "not-yet", "journal-target.json"));
				expect(await isSamePathIdentity(pending, path.join(specsDir, "not-yet", "journal-target.json"))).toBe(true);
				expect(await isSamePathIdentity(path.join(aliasSpecs, "spec.md"), path.join(specsDir, "spec.md"))).toBe(
					true,
				);
				expect(await isSamePathIdentity(path.join(aliasSpecs, "spec.md"), path.join(specsDir, "other.md"))).toBe(
					false,
				);
				expect(await isSamePathIdentity(undefined, path.join(specsDir, "spec.md"))).toBe(false);

				// Containment is decided on identities.
				expect(await isPathIdentityWithin(path.join(aliasSpecs, "spec.md"), specsDir)).toBe(true);
				expect(await isPathIdentityWithin(pending, specsDir)).toBe(true);
				expect(await isPathIdentityWithin(aliasSpecs, specsDir)).toBe(false);
				expect(await isPathIdentityWithin(path.join(aliasSpecs, "..", "spec.md"), specsDir)).toBe(false);
				expect(await isPathIdentityWithin(path.join(cwd, ".gjc", "spec.md"), specsDir)).toBe(false);
				expect(await isPathIdentityWithin(path.join(`${aliasSpecs}-evil`, "spec.md"), specsDir)).toBe(false);

				// A retired alias and a foreign root keep distinct identities.
				const retired = path.join(path.dirname(cwd), "retired-alias");
				await fs.symlink(physical, retired);
				const retiredSpec = path.join(sessionSpecsDir(retired, sessionId), "spec.md");
				expect(await isSamePathIdentity(retiredSpec, path.join(specsDir, "spec.md"))).toBe(true);
				await fs.rm(retired);
				expect(await isSamePathIdentity(retiredSpec, path.join(specsDir, "spec.md"))).toBe(false);
				expect(await isPathIdentityWithin(retiredSpec, specsDir)).toBe(false);
				const foreign = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "foreign-specs-root-")));
				try {
					await fs.writeFile(path.join(foreign, "spec.md"), "foreign");
					expect(await isPathIdentityWithin(path.join(foreign, "spec.md"), specsDir)).toBe(false);
					const foreignTwin = path.join(sessionSpecsDir(foreign, sessionId), "spec.md");
					expect(await isSamePathIdentity(foreignTwin, path.join(specsDir, "spec.md"))).toBe(false);
				} finally {
					await fs.rm(foreign, { recursive: true, force: true });
				}
			},
			{ aliasCwd: true },
		);
	});

	it("an alias-spelled lineage whose recorded root no longer exists is refused (#7562)", async () => {
		await withSession(
			async (cwd, manager, sessionId) => {
				const physical = await fs.realpath(cwd);
				const retired = path.join(path.dirname(cwd), "retired-alias");
				await fs.symlink(physical, retired);
				await publishPreCanonicalAliasLineage(retired, sessionId);
				await fs.rm(retired);
				await expect(ask(cwd, manager, "ralplan", "approve-report", false)).rejects.toThrow();
				const result = await handoff(cwd, sessionId, "ralplan");
				expect(result.status).toBe(2);
				expect(result.stderr).toContain("execution handoff cannot authenticate Deep Interview approval lineage");
				expect(await Bun.file(modeStatePath(physical, sessionId, "ultragoal")).exists()).toBe(false);
			},
			{ aliasCwd: true },
		);
	});

	it("an alias-spelled receipt that names a different workflow file is refused (#7562)", async () => {
		await withSession(
			async (cwd, manager, sessionId) => {
				const physical = await fs.realpath(cwd);
				await publishPreCanonicalAliasLineage(cwd, sessionId);
				// Re-point the caller receipt at the existing Ralplan state file.
				for (const file of handoffAuditFiles(physical, sessionId)) {
					const tampered = (await fs.readFile(file, "utf8"))
						.split("\n")
						.map(line => {
							if (!line.trim()) return line;
							const record = JSON.parse(line);
							if (record.verb !== "handoff" || !record.caller_receipt) return line;
							record.caller_receipt.storage_path = modeStatePath(cwd, sessionId, "ralplan");
							return JSON.stringify(record);
						})
						.join("\n");
					await fs.writeFile(file, tampered);
				}
				await expect(ask(cwd, manager, "ralplan", "approve-report", false)).rejects.toThrow();
				const result = await handoff(cwd, sessionId, "ralplan");
				expect(result.status).toBe(2);
				expect(result.stderr).toContain("does not match its sanctioned receipts");
				expect(await Bun.file(modeStatePath(physical, sessionId, "ultragoal")).exists()).toBe(false);
			},
			{ aliasCwd: true },
		);
	});

	it("an alias-spelled handoff audit whose caller receipt is missing is refused (#7562)", async () => {
		await withSession(
			async (cwd, manager, sessionId) => {
				const physical = await fs.realpath(cwd);
				await publishPreCanonicalAliasLineage(cwd, sessionId);
				for (const file of handoffAuditFiles(physical, sessionId)) {
					const stripped = (await fs.readFile(file, "utf8"))
						.split("\n")
						.map(line => {
							if (!line.trim()) return line;
							const record = JSON.parse(line);
							if (record.verb !== "handoff") return line;
							delete record.caller_receipt;
							return JSON.stringify(record);
						})
						.join("\n");
					await fs.writeFile(file, stripped);
				}
				await expect(ask(cwd, manager, "ralplan", "approve-report", false)).rejects.toThrow();
				const result = await handoff(cwd, sessionId, "ralplan");
				expect(result.status).toBe(2);
				expect(result.stderr).toContain("does not match its sanctioned receipts");
				expect(await Bun.file(modeStatePath(physical, sessionId, "ultragoal")).exists()).toBe(false);
			},
			{ aliasCwd: true },
		);
	});

	it("a pending handoff journal recorded under an alias before #7562 is recovered through that alias", async () => {
		await withSession(
			async (cwd, _manager, sessionId) => {
				const physical = await fs.realpath(cwd);
				const handoffArgs = ["handoff", "--mode", "deep-interview", "--to", "ralplan", "--session-id", sessionId];
				await asPreCanonicalWriter(cwd, async () => {
					await publish(cwd, sessionId, "deep-interview");
					const planning = await runNativeStateCommand([...handoffArgs, "--json"], cwd);
					expect(planning.status, planning.stderr).toBe(0);
				});
				const caller = JSON.parse(await fs.readFile(modeStatePath(physical, sessionId, "deep-interview"), "utf8"));
				const mutationId = caller.receipt.mutation_id as string;
				expect(mutationId.startsWith("deep-interview:handoff:ralplan:")).toBe(true);
				const journalFile = transactionJournalPath(physical, sessionId, mutationId);
				// The pre-#7562 writer stopped before it removed its alias-spelled journal.
				const now = new Date().toISOString();
				await fs.mkdir(path.dirname(journalFile), { recursive: true });
				await fs.writeFile(
					journalFile,
					JSON.stringify({
						version: 1,
						mutation_id: mutationId,
						status: "pending",
						created_at: now,
						updated_at: now,
						caller: "deep-interview",
						callee: "ralplan",
						paths: [
							modeStatePath(cwd, sessionId, "ralplan"),
							modeStatePath(cwd, sessionId, "deep-interview"),
							activeSnapshotPath(cwd, sessionId),
						],
						steps: ["callee-mode-state", "caller-mode-state"],
					}),
				);
				const retry = await runNativeStateCommand([...handoffArgs, "--json"], cwd);
				expect(retry.status, retry.stderr).toBe(0);
				expect(await Bun.file(journalFile).exists()).toBe(false);

				// The same journal naming a foreign root's files is still refused.
				const foreign = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "foreign-handoff-root-")));
				try {
					await fs.writeFile(
						journalFile,
						JSON.stringify({
							version: 1,
							mutation_id: mutationId,
							status: "pending",
							created_at: now,
							updated_at: now,
							caller: "deep-interview",
							callee: "ralplan",
							paths: [
								modeStatePath(foreign, sessionId, "ralplan"),
								modeStatePath(foreign, sessionId, "deep-interview"),
								activeSnapshotPath(foreign, sessionId),
							],
							steps: ["callee-mode-state", "caller-mode-state"],
						}),
					);
					const refused = await runNativeStateCommand([...handoffArgs, "--json"], cwd);
					expect(refused.status).toBe(2);
					expect(refused.stderr).toContain("handoff recovery journal identity mismatch");
				} finally {
					await fs.rm(foreign, { recursive: true, force: true });
				}
			},
			{ aliasCwd: true },
		);
	});

	it("relative user inputs resolve against the alias cwd, not its physical parent (#7562)", async () => {
		await withSession(
			async (cwd, _manager, sessionId) => {
				const aliasParent = path.dirname(cwd);
				expect(aliasParent).not.toBe(path.dirname(await fs.realpath(cwd)));
				await fs.writeFile(path.join(aliasParent, "spec.md"), "# Alias spec\n\nRead from beside the alias.\n");
				await fs.writeFile(path.join(aliasParent, "array.json"), "[]");

				const written = await runNativeDeepInterviewCommand(
					[
						"--write",
						"--stage",
						"final",
						"--slug",
						"alias-spec",
						"--spec",
						"../spec.md",
						"--session-id",
						sessionId,
						"--json",
					],
					cwd,
				);
				expect(written.status, written.stderr).toBe(0);
				const specPath = JSON.parse(written.stdout!).spec_path as string;
				expect(await fs.readFile(specPath, "utf8")).toContain("Read from beside the alias.");

				const crystallize = await runNativeDeepInterviewCommand(
					["--crystallize", "--input", "@../array.json", "--slug", "alias-crystal", "--session-id", sessionId],
					cwd,
				);
				expect(crystallize.status).toBe(2);
				expect(crystallize.stderr).toContain("crystallize input must be a JSON object");

				const staged = await runNativeDeepInterviewCommand(
					["stage", "--input", "@../array.json", "--session-id", sessionId],
					cwd,
				);
				expect(staged.stderr).toContain("--input must be a JSON object");

				const state = await runNativeStateCommand(
					["read", "--mode", "deep-interview", "--input", "@../array.json", "--session-id", sessionId],
					cwd,
				);
				expect(state.status).toBe(2);
				expect(state.stderr).toContain("--input must be a JSON object");
			},
			{ aliasCwd: true },
		);
	});

	it("a handoff audit recorded under a foreign root is refused with the named root mismatch (#7562)", async () => {
		await withSession(async (cwd, manager, sessionId) => {
			const foreign = await fs.mkdtemp(path.join(os.tmpdir(), "foreign-approval-root-"));
			try {
				await publish(foreign, sessionId, "deep-interview");
				const planning = await runNativeStateCommand(
					["handoff", "--mode", "deep-interview", "--to", "ralplan", "--session-id", sessionId, "--json"],
					foreign,
				);
				expect(planning.status, planning.stderr).toBe(0);
				await publish(foreign, sessionId, "ralplan");
				// Transplant the foreign root's lineage state into this workspace byte-for-byte.
				await fs.cp(sessionStateDir(foreign, sessionId), sessionStateDir(cwd, sessionId), { recursive: true });
				await expect(ask(cwd, manager, "ralplan")).rejects.toThrow();
				expect(await Bun.file(nonCrystalExecutionApprovalRecordPath(cwd, sessionId, "ralplan")).exists()).toBe(
					false,
				);
				const ralplanPath = modeStatePath(cwd, sessionId, "ralplan");
				const ralplan = JSON.parse(await fs.readFile(ralplanPath, "utf8"));
				const result = await handoff(cwd, sessionId, "ralplan");
				expect(result.status).toBe(2);
				expect(result.stderr).toContain("execution handoff cannot authenticate Deep Interview approval lineage");
				expect(result.stderr).toContain(
					`does not match workflow root path ${modeStatePath(await fs.realpath(cwd), sessionId, "deep-interview")}`,
				);
				expect(ralplan.handoff_from).toBe("deep-interview");
				expect(await Bun.file(modeStatePath(cwd, sessionId, "ultragoal")).exists()).toBe(false);
			} finally {
				await fs.rm(foreign, { recursive: true, force: true });
			}
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
			const replacement = await runNativeRalplanCommand(
				[
					"--write",
					"--stage",
					"final",
					"--stage_n",
					"1",
					"--artifact",
					"# Independent replacement plan",
					"--run-id",
					"replacement-plan",
					"--session-id",
					sessionId,
					"--json",
				],
				cwd,
			);
			expect(replacement.status, replacement.stderr).toBe(0);
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

	it("ralplan: alias-era pending approval can be consumed from the physical workflow root (#7562)", async () => {
		await withAliasEraRalplanApproval(async (realRoot, _aliasRoot, _manager, sessionId) => {
			const result = await runNativeStateCommand(
				["approve-execution", "--mode", "ralplan", "--session-id", sessionId, "--json"],
				realRoot,
			);
			expect(result.status, result.stderr).toBe(0);
			expect((await approval(realRoot, sessionId, "ralplan")).status).toBe("consumed");
		});
	});

	it("ralplan: alias-era pending approval is consumed and handed off through the alias (#7562)", async () => {
		await withAliasEraRalplanApproval(async (realRoot, aliasRoot, _manager, sessionId) => {
			const result = await runNativeStateCommand(
				["approve-execution", "--mode", "ralplan", "--session-id", sessionId, "--json"],
				aliasRoot,
			);
			expect(result.status, result.stderr).toBe(0);
			expect((await approval(aliasRoot, sessionId, "ralplan")).status).toBe("consumed");
			const handed = await handoff(aliasRoot, sessionId, "ralplan");
			expect(handed.status, handed.stderr).toBe(0);
			expect(JSON.parse(await fs.readFile(modeStatePath(realRoot, sessionId, "ultragoal"), "utf8")).active).toBe(
				true,
			);
		});
	});

	it("ralplan: alias-era pending approval for a superseded final is refused (#7562)", async () => {
		await withAliasEraRalplanApproval(async (realRoot, aliasRoot, _manager, sessionId) => {
			await publish(aliasRoot, sessionId, "ralplan", 2);
			const result = await runNativeStateCommand(
				["approve-execution", "--mode", "ralplan", "--session-id", sessionId, "--json"],
				aliasRoot,
			);
			expect(result.status).toBe(2);
			expect(result.stderr).toContain("stale");
			expect((await approval(realRoot, sessionId, "ralplan")).status).toBe("pending");
			expect(await Bun.file(modeStatePath(realRoot, sessionId, "ultragoal")).exists()).toBe(false);
		});
	});

	it("ralplan: alias-era pending approval can be renewed from the physical workflow root (#7562)", async () => {
		await withAliasEraRalplanApproval(async (realRoot, _aliasRoot, manager, sessionId) => {
			const previous = await approval(realRoot, sessionId, "ralplan");
			await publish(realRoot, sessionId, "ralplan", 2);
			const transcriptPath = manager.getSessionFile()!;
			const toolCallId = "provider-alias-era-renewal";
			manager.appendMessage(assistant([{ type: "toolCall", id: toolCallId, name: "ask", arguments: {} }]));
			await manager.flush();
			await recordNonCrystalExecutionApproval({
				cwd: realRoot,
				sessionId,
				approvalStage: "ralplan",
				questionId: previous.question_id,
				gateId: "alias-era-renewed-gate",
				target: "ultragoal",
				selectedOptions: ["Approve execution via ultragoal"],
				transcriptPath,
				transcriptSha256: createHash("sha256")
					.update(await fs.readFile(transcriptPath))
					.digest("hex"),
				toolCallId,
				presentation: await captureExecutionApprovalPresentation(realRoot, sessionId, "ralplan"),
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
			expect((await approval(realRoot, sessionId, "ralplan")).gate_id).toBe("alias-era-renewed-gate");
		});
	});

	it("ralplan: alias-era pending approval can be revoked from the physical workflow root (#7562)", async () => {
		await withAliasEraRalplanApproval(async (realRoot, _aliasRoot, _manager, sessionId) => {
			await revokeNonCrystalExecutionApproval(realRoot, sessionId, "ralplan");
			expect((await approval(realRoot, sessionId, "ralplan")).status).toBe("revoked");
		});
	});

	it("ralplan: alias-aware approval validation still rejects a distinct physical root (#7562)", async () => {
		await withAliasEraRalplanApproval(async (realRoot, aliasRoot, _manager, sessionId) => {
			const foreignRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "approval-foreign-")));
			try {
				const record = await approval(realRoot, sessionId, "ralplan");
				const copyIntoForeignRoot = async (aliasPath: string) => {
					const relative = path.relative(aliasRoot, aliasPath);
					expect(pathWithin(aliasRoot, aliasPath)).toBe(true);
					const target = path.join(foreignRoot, relative);
					await fs.mkdir(path.dirname(target), { recursive: true });
					await fs.copyFile(aliasPath, target);
					return target;
				};
				const foreignRecord = {
					...record,
					state_path: await copyIntoForeignRoot(record.state_path),
					artifact_path: await copyIntoForeignRoot(record.artifact_path),
				};
				await writeAliasEraApproval(realRoot, aliasRoot, sessionId, foreignRecord);
				const result = await runNativeStateCommand(
					["approve-execution", "--mode", "ralplan", "--session-id", sessionId, "--json"],
					realRoot,
				);
				expect(result.status).toBe(2);
				expect(result.stderr).toContain("stale");
			} finally {
				await fs.rm(foreignRoot, { recursive: true, force: true });
			}
		});
	});
});
