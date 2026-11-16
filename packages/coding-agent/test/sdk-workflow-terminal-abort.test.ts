import { expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createMockModel, registerMockApi } from "@gajae-code/ai/providers/mock";
import { resetSettingsForTest, Settings } from "../src/config/settings";
import { initializeExtensions } from "../src/modes/runtime-init";
import type { WorkflowGateEmitter } from "../src/modes/shared/agent-wire/workflow-gate-broker";
import { createAgentSession } from "../src/sdk";
import { startFixtureBrokerWithLeaseForTest } from "../src/sdk/broker/ensure";
import { readSdkBrokerDiscovery, SdkClient } from "../src/sdk/client";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";
import { getAskAnswerSource } from "../src/tools/ask-answer-registry";
import {
	cleanupFixtureRoot,
	createFixtureBrokerEnvironment,
	createFixtureRootCleanup,
	type FixtureRootCleanup,
	registerFixtureRuntime,
	withFixtureBrokerEnvironment,
} from "./helpers/fixture-broker-cleanup";

const NOTIFICATION_ENV_KEYS = ["GJC_NOTIFY", "GJC_NOTIFICATIONS", "GJC_NOTIFICATIONS_TOKEN"] as const;

async function waitFor(predicate: () => boolean | Promise<boolean>, label: string): Promise<void> {
	const deadline = Date.now() + 4_000;
	while (!(await predicate())) {
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
		await Bun.sleep(10);
	}
}

// Cross-repo regression: Heyaaz/gajae-bot#224. PR #7523 already repairs the
// workflow-gate abort links; exercise the actual broker reply, not just AskTool.
for (const notifications of [false, true]) {
	for (const scope of ["turn", "owned"] as const) {
		test(`${notifications ? "notification bus" : "SDK-only"}: terminal ${scope} abort replies for a pending interview question`, async () => {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-workflow-abort-"));
			const agentDir = path.join(root, "agent");
			const savedEnv = NOTIFICATION_ENV_KEYS.map(key => [key, process.env[key]] as const);
			let cleanup: FixtureRootCleanup | undefined;
			const failures: unknown[] = [];
			let client: SdkClient | undefined;
			let operator: SdkClient | undefined;
			let emitter: WorkflowGateEmitter | undefined;
			let stopObserving: (() => void) | undefined;
			try {
				for (const key of NOTIFICATION_ENV_KEYS) delete process.env[key];
				if (notifications) process.env.GJC_NOTIFICATIONS = "1";
				const started = await withFixtureBrokerEnvironment(() =>
					startFixtureBrokerWithLeaseForTest({
						agentDir,
						env: createFixtureBrokerEnvironment(root, agentDir),
					}),
				);
				cleanup = createFixtureRootCleanup(root, agentDir, started.lease);
				registerMockApi();
				const mock = createMockModel({
					responses: [
						{
							content: [
								{
									type: "toolCall",
									id: "pending-ask",
									name: "ask",
									arguments: {
										questions: [
											{
												id: "scope",
												question: "Round 0 | Topology confirmation\n\nWhich scope?",
												options: [{ label: "SDK" }],
												workflowGate: { stage: "deep-interview", kind: "question" },
												deepInterview: {
													round: 0,
													component: "review-topology",
													dimension: "topology",
													ambiguity: 1,
													intent_contract: {
														items: [
															{
																id: "artifact:sdk",
																category: "artifact",
																statement: "SDK terminal abort",
															},
														],
														confirmation_options: ["SDK"],
													},
												},
											},
										],
									},
								},
							],
							stopReason: "toolUse",
						},
					],
				});
				const authStorage = await AuthStorage.create(path.join(agentDir, "auth.db"));
				authStorage.setRuntimeApiKey(mock.model.provider, "test-key");
				registerFixtureRuntime(cleanup, {
					key: "auth",
					requiredOwner: "runtime",
					dispose: async () => authStorage.close(),
				});
				const sessionManager = SessionManager.create(root, path.join(root, "sessions"));
				await sessionManager.ensureOnDisk();
				const settings = await Settings.init({ cwd: root, agentDir });
				settings.set("compaction.enabled", false);
				settings.set("todo.enabled", false);
				settings.set("todo.reminders", false);
				const { session } = await createAgentSession({
					cwd: root,
					agentDir,
					sessionManager,
					authStorage,
					model: mock.model,
					settings,
					hasUI: false,
					toolNames: ["ask"],
					disableExtensionDiscovery: true,
					skills: [],
					contextFiles: [],
					promptTemplates: [],
					slashCommands: [],
					enableMCP: false,
					enableLsp: false,
				});
				registerFixtureRuntime(cleanup, {
					key: `session:${session.sessionId}`,
					requiredOwner: "runtime-and-broker",
					shutdown: async () => void (await session.extensionRunner?.emit({ type: "session_shutdown" })),
					dispose: () => session.dispose(),
				});
				await initializeExtensions(session, { reportSendError: () => {}, reportRuntimeError: () => {} });
				const endpointFile = Bun.file(path.join(root, ".gjc", "state", "sdk", `${session.sessionId}.json`));
				const endpointDeadline = Date.now() + 4_000;
				while (!(await endpointFile.exists())) {
					if (Date.now() > endpointDeadline) throw new Error("SDK endpoint missing");
					await Bun.sleep(10);
				}
				const endpoint = (await endpointFile.json()) as { url: string; token: string };
				client = await SdkClient.connect(endpoint.url, endpoint.token, { timeoutMs: 3_000, reconnectAttempts: 0 });
				const discovery = await readSdkBrokerDiscovery(agentDir);
				if (!discovery) throw new Error("Missing fixture broker");
				operator = await SdkClient.connect(discovery.url, discovery.token, {
					timeoutMs: 3_000,
					reconnectAttempts: 0,
				});
				// Endpoint publication can precede the durable broker registration.
				await waitFor(async () => {
					const listed = (await operator!.global("session.list", { resolveSessionId: session.sessionId })) as {
						result: { sessions: Array<{ sessionId: string; live: boolean }> };
					};
					return listed.result.sessions.some(row => row.sessionId === session.sessionId && row.live);
				}, "broker host registration");
				const abort = (key: string) =>
					operator!.global(
						"session.control",
						{
							sessionId: session.sessionId,
							operation: "turn.abort",
							input: { mode: "terminal", scope, operator: true },
							confirm: true,
						},
						{ idempotencyKey: key },
					);
				expect(await abort("initial-idle")).toMatchObject({
					ok: true,
					result: { turn: "no_active_turn", terminal: "terminal_no_effect" },
				});

				let asked = false;
				let gateId: string | undefined;
				let questionSignal: AbortSignal | undefined;
				emitter = session.getWorkflowGateEmitter();
				stopObserving = emitter?.onGateEmitted?.(gate => {
					if (gate.context?.stage_state?.question_id === "scope") {
						gateId = gate.gate_id;
						asked = true;
					}
				});
				const source = getAskAnswerSource(session.sessionId);
				if (source?.awaitAnswerRequest) {
					const original = source.awaitAnswerRequest.bind(source);
					vi.spyOn(source, "awaitAnswerRequest").mockImplementation((request, signal) => {
						questionSignal = signal;
						asked = true;
						return original(request, signal);
					});
				}
				await client.control("skill.invoke", { name: "deep-interview", args: "Fix SDK terminal abort" });
				await waitFor(() => asked, "pending interview question");
				expect(mock.calls).toHaveLength(1);
				if (!notifications) {
					expect(gateId).toBeDefined();
					expect(emitter?.listPendingGates?.().map(gate => gate.gate_id)).toContain(gateId);
				}

				// Like the CLI, the submitting client disconnects after acknowledgement.
				// A different ordinary client must not gain ownership of its live turn.
				await client.close();
				client = await SdkClient.connect(endpoint.url, endpoint.token, { timeoutMs: 3_000, reconnectAttempts: 0 });
				expect(
					await client.control("turn.abort", { mode: "terminal", scope }, { idempotencyKey: "outsider" }),
				).toMatchObject({
					ok: true,
					result: { turn: "no_active_turn", terminal: "terminal_no_effect" },
				});
				if (questionSignal) expect(questionSignal.aborted).toBe(false);
				if (gateId) expect(emitter?.listPendingGates?.().map(gate => gate.gate_id)).toContain(gateId);

				// The broker serializes concurrent controls for this session. Only the first
				// request stops work; the second must not fabricate a second stopped result.
				const keys = ["stop-question", "concurrent-stop"];
				const results = await Promise.all(keys.map(abort));
				expect(results).toEqual(
					expect.arrayContaining([
						expect.objectContaining({ ok: true, result: expect.objectContaining({ turn: "stopped" }) }),
						expect.objectContaining({
							ok: true,
							result: expect.objectContaining({ turn: "no_active_turn", terminal: "terminal_no_effect" }),
						}),
					]),
				);
				const stoppedIndex = results.findIndex(
					result => (result as { result?: { turn?: string } }).result?.turn === "stopped",
				);
				expect(await abort(keys[stoppedIndex]!)).toMatchObject({ ok: true, result: { turn: "stopped" } });
				expect(await abort("repeat-stop")).toMatchObject({
					ok: true,
					result: { turn: "no_active_turn", terminal: "terminal_no_effect" },
				});
				await session.waitForIdle();
				expect(mock.calls).toHaveLength(1);
				if (questionSignal) expect(questionSignal.aborted).toBe(true);
				if (gateId) {
					expect(emitter?.listPendingGates?.().map(gate => gate.gate_id)).not.toContain(gateId);
					await expect(
						client.control(
							"workflow.gate_answer",
							{ id: gateId, response: { selected: ["SDK"] } },
							{
								idempotencyKey: "late-answer",
							},
						),
					).rejects.toMatchObject({ code: "resource_gone" });
				}
			} catch (error) {
				failures.push(error);
			} finally {
				// Also release the exact fixture's wait if the cancellation regression returns:
				// cleanup must not mask the missing broker reply with a disposal timeout.
				for (const release of [
					() => emitter?.fence?.(),
					() => stopObserving?.(),
					() => client?.close(),
					() => operator?.close(),
					() => vi.restoreAllMocks(),
					() => (cleanup ? cleanupFixtureRoot(cleanup) : fs.rm(root, { recursive: true, force: true })),
					() => resetSettingsForTest(),
				]) {
					try {
						await release();
					} catch (error) {
						failures.push(error);
					}
				}
				for (const [key, value] of savedEnv) {
					if (value === undefined) delete process.env[key];
					else process.env[key] = value;
				}
			}
			if (failures.length === 1) throw failures[0];
			if (failures.length > 1) throw new AggregateError(failures, "Workflow abort fixture failed");
		}, 30_000);
	}
}
