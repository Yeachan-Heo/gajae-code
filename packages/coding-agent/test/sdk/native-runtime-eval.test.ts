import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { liveVmContextCount } from "../../src/eval/js/context-manager";
import { createEmbeddedAgentSession } from "../../src/sdk/embedding";
import {
	consentEmbeddedDisconnect,
	currentEmbeddedResumeOperation,
	type NativeEmbeddedOpenResult,
	prepareEmbeddedDisconnect,
	reconcileEmbeddedResumeCheckpoint,
	resolveEmbeddedResumeCheckpoint,
	terminateEmbeddedAgentSession,
} from "../../src/sdk/native-embedding";
import { type NativeInvocationResult, NativeRuntimeRefusal } from "../../src/sdk/native-lifecycle";
import { AuthStorage } from "../../src/session/auth-storage";
import { nativeResumeBinding } from "../../src/session/native-resume";
import { getOwnerMembershipEvidence } from "../../src/session/owner-group";
import type { ReconcileResult } from "../../src/session/resume-operation";

type Opened = Extract<NativeEmbeddedOpenResult, { kind: "opened" }>;
// An uncertain owner must not disappear merely because this test's stack unwound.
const retainedFixtures: Array<{ opened: Opened; auth: AuthStorage }> = [];

async function bounded<T>(label: string, completion: Promise<T>): Promise<T> {
	const timeout = Promise.withResolvers<never>();
	const timer = setTimeout(() => timeout.reject(new Error(`Timed out: ${label}`)), 15_000);
	try {
		return await Promise.race([completion, timeout.promise]);
	} finally {
		clearTimeout(timer);
	}
}

function evidenceReplacer(_key: string, item: unknown): unknown {
	if (item instanceof Error)
		return { name: item.name, message: item.message, stack: item.stack, cause: item.cause };
	return typeof item === "bigint" ? String(item) : item;
}

function reconciliationEvidence(result: ReconcileResult) {
	return {
		// ReconcileResult stores the classifier's reason on outcome, not on the wrapper.
		reason: "reason" in result.outcome ? result.outcome.reason : result.refusal ?? null,
		...result,
	};
}

async function fixture() {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gjc-native-eval-")));
	const cwd = path.join(root, "project");
	const agentDir = path.join(root, "agent");
	await fs.mkdir(cwd);
	const auth = await AuthStorage.create(path.join(agentDir, "auth.db"));
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Missing bundled fixture model");
	auth.setRuntimeApiKey(model.provider, "test-only-key");
	await Bun.write(
		path.join(agentDir, "config.yml"),
		JSON.stringify({
			recipe: { enabled: false },
			compaction: { enabled: false },
			retry: { enabled: false },
			eval: { js: true, py: false },
			tools: { discoveryMode: "off" },
			modelRoles: { default: `${model.provider}/${model.id}` },
		}),
	);
	const opening = await bounded(
		`native open; retained fixture ${root}`,
		createEmbeddedAgentSession({
			cwd,
			agentDir,
			authStorage: auth,
			model,
			storage: { directory: path.join(root, "sessions") },
			native: { create: true, ownerPolicy: { kind: "exclusive_native" } },
			asyncJobs: "none",
			disableExtensionDiscovery: true,
			extensions: [],
			skills: [],
			rules: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMcpAutoload: false,
			enableLsp: false,
			skipPythonPreflight: true,
			deferOptionalModelRefresh: true,
			deferMemoryBackendStartup: true,
			notificationHostModeSupported: false,
			sdkHostModeSupported: false,
			toolNames: ["eval"],
		}),
	);
	if (opening.kind !== "opened") throw new Error(`Expected native open, got ${opening.kind}; retained ${root}`);
	const opened: Opened = opening;
	const session = opened.result.session;
	const manager = session.sessionManager;
	const vmContextsBefore = liveVmContextCount();
	const transport = createMockModel({
		responses: [
			{
				content: [
					{
						type: "toolCall",
						id: "native-eval-addition",
						name: "eval",
						arguments: { cells: [{ language: "js", code: "1 + 2", timeout: 5 }] },
					},
				],
			},
			{ content: ["The eval result is 3."] },
			{ content: ["Ordinary continuation completed."] },
		],
	});
	// Only provider transport is fake. EvalTool, its executor, and worker-entry.ts
	// (or the compile-discovered worker entry) are the real production path.
	session.agent.streamFn = transport.stream;
	const evidencePath = path.join(root, "native-eval-evidence.json");
	const observations: Record<string, unknown> = {};
	let retirementAttempted = false;
	let retired = false;

	async function capture(label: string, value: unknown, reconciliation?: ReconcileResult): Promise<void> {
		const op = currentEmbeddedResumeOperation(opened.handle);
		const binding = nativeResumeBinding(op);
		const close = manager.getStrictCloseState();
		const membership = close.kind === "closed" ? undefined : manager.getOwnerMembership();
		const last = binding.lastEvidence;
		const observation = {
			value,
			reconciliation: reconciliation ? reconciliationEvidence(reconciliation) : undefined,
			op: {
				id: op.op,
				memberToken: op.memberToken,
				authorityKey: op.authorityKey,
				epoch: op.epoch,
				CB: op.CB,
				plan: op.plan,
				g0: op.g0,
				durabilityDebt: op.durabilityDebt,
				policy: {
					kind: op.policy.kind,
					memberKind: op.policy.memberKind,
					rev: op.policy.rev,
					authorityKey: op.policy.authorityKey,
					epoch: op.policy.epoch,
				},
			},
			manifest: op.manifest,
			binding: {
				ledger: [...binding.ledger.values()],
				residentTip: binding.residentTip,
				durabilityState: binding.durabilityState,
				attempts: binding.attempts,
				lastError: binding.lastError,
				proofs: binding.proofs,
				publicationSuccessions: binding.publicationSuccessions,
				lastEvidence: last
					? {
							residentSuffix: last.residentSuffix,
							residentTip: last.residentTip,
							debt: last.debt,
							generation: last.generation,
							durabilityState: last.durabilityState,
							lastError: last.lastError,
							completionRefusal: last.completionRefusal,
							readiness: {
								writer: last.readiness.writer,
								localContextCurrent: last.readiness.localContextCurrent,
								persistError: last.readiness.persistError,
							},
						}
					: undefined,
			},
			// A readable tail_unambiguous reducer is not positive durability evidence.
			onDisk: session.sessionFile ? resolveEmbeddedResumeCheckpoint(session.sessionFile) : null,
			retainedEffects: {
				owner: membership ? getOwnerMembershipEvidence(membership) : null,
				close,
				disposeResources: session.getDisposeResourceState(),
				lifecycle: { ...session.sessionLifecycle },
				streaming: session.isStreaming,
				evalRunning: session.isEvalRunning,
				pendingPythonMessages: session.hasPendingPythonMessages,
				queued: session.getQueuedMessages(),
				liveVmContexts: liveVmContextCount(),
			},
			providerCalls: transport.calls.map(call => ({
				messages: call.context.messages.map(message => ({
					role: message.role,
					content: message.content,
					...(message.role === "toolResult"
						? {
								toolCallId: message.toolCallId,
								toolName: message.toolName,
								isError: message.isError,
								details: message.details,
							}
						: {}),
				})),
				toolNames: call.context.tools?.map(tool => tool.name),
			})),
		};
		// Snapshot only the documented diagnostic data. Native issuer state and
		// provider schemas may contain functions and are not structured-cloneable.
		observations[label] = JSON.parse(JSON.stringify(observation, evidenceReplacer));
		await Bun.write(
			evidencePath,
			JSON.stringify(
				{ root, sessionFile: session.sessionFile, observations },
				evidenceReplacer,
				2,
			),
		);
	}

	async function prompt(label: string, text: string): Promise<NativeInvocationResult<void>> {
		try {
			const result = await bounded(label, opened.runtime.prompt.prompt(text, { expandPromptTemplates: false }));
			await capture(label, result, result.reconciliation);
			if (result.kind === "applied") {
				await bounded(`${label} idle`, session.waitForIdle());
				await capture(`${label}-idle`, result, result.reconciliation);
			}
			return result;
		} catch (error) {
			await capture(`${label}-error`, error, error instanceof NativeRuntimeRefusal ? error.reconciliation : undefined);
			throw error;
		}
	}

	async function retire(): Promise<void> {
		retirementAttempted = true;
		const op = currentEmbeddedResumeOperation(opened.handle);
		const observed = await bounded(
			"read-only teardown preflight",
			reconcileEmbeddedResumeCheckpoint(opened.handle, { op, mode: "verifyReadOnly" }),
		);
		await capture("teardown-preflight", observed, observed);
		// Do not repair, abort, raw-dispose, or delete an uncertain fixture to turn a
		// refusal into success. TERM may repair only the ordinary known own suffix.
		if (observed.outcome.kind === "unknown" || session.isStreaming || session.isEvalRunning)
			throw new Error(`Unsafe native eval teardown; retained owner and evidence: ${evidencePath}`);
		const preparation = await bounded("disconnect preparation", prepareEmbeddedDisconnect(opened.handle, op));
		await capture("disconnect-preparation", preparation);
		if (!preparation.inventory) throw new Error("Missing native work inventory");
		expect(preparation.inventory.blockers).toEqual([]);
		const consent = consentEmbeddedDisconnect(opened.handle, preparation, {
			stopAndJoin: true,
			work: { inventory: preparation.inventory, targets: [], timeoutMs: 5_000 },
		});
		if (!consent) throw new Error("Missing native termination consent");
		const terminated = await bounded(
			"native retirement",
			terminateEmbeddedAgentSession(opened.handle, { op, consent }),
		);
		await capture("termination", terminated, terminated);
		expect(terminated.receipt.terminalDisposition.kind).toBe("retired");
		expect(terminated.receipt.routing.closeOutcome).toBe("closed");
		expect(manager.getStrictCloseState()).toEqual({ kind: "closed" });
		expect(session.getDisposeResourceState()).toBe("settled");
		expect(liveVmContextCount()).toBe(vmContextsBefore);
		retired = true;
	}

	async function cleanup(passed: boolean): Promise<void> {
		try {
			if (!retirementAttempted) await retire();
		} catch (error) {
			await capture("teardown-error", error, error instanceof NativeRuntimeRefusal ? error.reconciliation : undefined);
			throw error;
		} finally {
			if (retired) {
				auth.close();
				if (passed) await fs.rm(root, { recursive: true, force: true });
				else process.stderr.write(`Retained native eval evidence: ${evidencePath}\n`);
			} else {
				retainedFixtures.push({ opened, auth });
				process.stderr.write(`Retained native eval owner, auth, workers and evidence: ${evidencePath}\n`);
			}
		}
	}
	return { opened, transport, prompt, capture, retire, cleanup, vmContextsBefore };
}

describe("native runtime real eval continuation", () => {
	it("reconciles a real JS eval result, admits the next ordinary prompt, and retires cleanly", async () => {
		// Never substitute the test-only non-interruptible inline fallback for a Worker.
		expect(process.env.GAJAE_CODE_JS_EVAL_INLINE_WORKER).not.toBe("1");
		const f = await fixture();
		let passed = false;
		let failure: unknown;
		try {
			const first = await f.prompt("eval-turn", "Evaluate 1 + 2 with the eval tool, then report the result.");
			expect(first.kind).toBe("applied");
			expect(f.transport.calls).toHaveLength(2);
			const toolResults = f.transport.calls[1]!.context.messages.filter(message => message.role === "toolResult");
			expect(toolResults).toHaveLength(1);
			expect(toolResults[0]).toMatchObject({
				toolCallId: "native-eval-addition",
				toolName: "eval",
				isError: false,
				content: [expect.objectContaining({ type: "text", text: expect.stringMatching(/^3(?:\n|$)/) })],
				details: {
					language: "js",
					cells: [expect.objectContaining({ code: "1 + 2", status: "complete", exitCode: 0, output: "3" })],
				},
			});
			const session = f.opened.result.session;
			expect(liveVmContextCount()).toBe(f.vmContextsBefore + 1);
			expect(session.agent.state.messages).toContainEqual(
				expect.objectContaining({ role: "assistant", content: [{ type: "text", text: "The eval result is 3." }] }),
			);

			// No intervening flush, repair, selection, raw prompt, or fresh session:
			// the native facade must reconcile its own actual eval turn correctly.
			const next = await f.prompt("ordinary-continuation", "Reply normally without using any tools.");
			expect(next.kind).toBe("applied");
			expect(f.transport.calls).toHaveLength(3);
			expect(f.transport.calls[2]!.context.messages).toContainEqual(
				expect.objectContaining({
					role: "user",
					content: [{ type: "text", text: "Reply normally without using any tools." }],
				}),
			);
			expect(session.agent.state.messages).toContainEqual(
				expect.objectContaining({ role: "assistant", content: [{ type: "text", text: "Ordinary continuation completed." }] }),
			);
			const users = session.sessionManager
				.getEntries()
				.filter(entry => entry.type === "message" && entry.message.role === "user");
			expect(users).toHaveLength(2);
			await f.retire();
			passed = true;
		} catch (error) {
			failure = error;
			await f.capture("test-failure", error, error instanceof NativeRuntimeRefusal ? error.reconciliation : undefined);
			throw error;
		} finally {
			try {
				await f.cleanup(passed);
			} catch (cleanupError) {
				if (failure !== undefined)
					throw new AggregateError([failure, cleanupError], "Native eval regression and unsafe teardown; evidence retained");
				throw cleanupError;
			}
		}
	}, 90_000);
});
