import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentSideConnection } from "@agentclientprotocol/sdk";
import { Agent, type AgentTool, type RunSettlementProof } from "@gajae-code/agent-core";
import { closeModelCache, getBundledModel } from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { NotificationServer } from "@gajae-code/natives";
import { logger } from "@gajae-code/utils";
import * as z from "zod/v4";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { ExtensionRunner } from "../src/extensibility/extensions/runner";
import type {
	ExtensionActions,
	ExtensionAPI,
	ExtensionContextActions,
	ExtensionUIContext,
} from "../src/extensibility/extensions/types";

test("extension API cannot set the private recovery bypass", () => {
	const api = undefined as ExtensionAPI | undefined;
	if (api) {
		// @ts-expect-error The recovery bypass is private to SDK-correlated session runs.
		void api.sendUserMessage("unauthorized", { skipPostPromptRecoveryWait: true });
		// @ts-expect-error Raw SDK ownership tokens are not part of the public extension surface.
		void api.sendUserMessage("unauthorized", { sdkRunToken: "raw-token" });
		// @ts-expect-error The branded SDK capability is private to the trusted host adapter.
		void api.sendUserMessage("unauthorized", { sdkRunCapability: {} });
	}
	expect("skipPostPromptRecoveryWait" in ({} as Record<string, unknown>)).toBe(false);
});

test("the SDK capability module is not package-importable", () => {
	const packageJson = JSON.parse(fs.readFileSync(path.resolve(import.meta.dir, "../package.json"), "utf8")) as {
		exports?: Record<string, unknown>;
	};
	expect(packageJson.exports?.["./session/sdk-run-capability"]).toBeNull();
	expect(packageJson.exports?.["./session/sdk-run-capability.js"]).toBeNull();
});

async function firePreflightAccept(options?: {
	onPreflightAccepted?: () => void;
	onPreflightAcceptCommit?: () => void | Promise<void>;
}): Promise<void> {
	if (options?.onPreflightAcceptCommit) await options.onPreflightAcceptCommit();
	else options?.onPreflightAccepted?.();
}

import { createAcpReverseConnection } from "../src/modes/acp/acp-agent";
import { ExtensionUiController } from "../src/modes/controllers/extension-ui-controller";
import { buildAskGateAnswerSchema as buildDeepInterviewAskGateAnswerSchema } from "../src/modes/shared/agent-wire/deep-interview-gate";
import {
	BrokerWorkflowGateEmitter,
	FileGateStore,
	MemoryGateStore,
	type WorkflowGateEmitter,
} from "../src/modes/shared/agent-wire/workflow-gate-broker";
import {
	buildAskGateAnswerSchema,
	buildAskGateStageState,
	validateAskGateStageState,
} from "../src/modes/shared/agent-wire/workflow-gate-types";
import type { InteractiveModeContext } from "../src/modes/types";
import { AcpSdkAdapter } from "../src/sdk/acp/adapter";
import { brokerOwnerForTest } from "../src/sdk/broker/ensure";
import { SessionIndex } from "../src/sdk/broker/session-index";
import { formatPromptSettlementDiagnostic, PresentationArbiter } from "../src/sdk/bus";
import { getTelegramFileSink } from "../src/sdk/bus/attachment-registry";
import { reconciliationStorePath } from "../src/sdk/bus/reconciliation-store";
import type { NotificationSessionController } from "../src/sdk/bus/session-control";
import { SdkClient } from "../src/sdk/client";
import { SessionSdkHost } from "../src/sdk/host";
import { createSdkRunCapability } from "../src/sdk/host/sdk-run-capability";
import type { SessionAttachment } from "../src/sdk/router/session-router";
import { createAgentSession } from "../src/sdk/session";
import {
	attachLifecycleStartupCapability,
	normalizeSdkStartupFailure,
	SdkStartupCapability,
	SdkStartupRollbackTracker,
	sanitizeSdkStartupMessage,
} from "../src/sdk/startup-capability";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import type {
	ClientBridgePermissionOption,
	ClientBridgePermissionOutcome,
	ClientBridgePermissionToolCall,
} from "../src/session/client-bridge";
import * as sessionSdkRunCapability from "../src/session/sdk-run-capability";
import { readSdkRunCapability } from "../src/session/sdk-run-capability";
import { SessionManager } from "../src/session/session-manager";

type CapturedSendUserMessage = (
	content: Parameters<ExtensionActions["sendUserMessage"]>[0],
	options?: NonNullable<Parameters<ExtensionActions["sendUserMessage"]>[1]> & { sdkRunCapability?: unknown },
) => void | Promise<void>;
type InternalCapturedOptions = NonNullable<Parameters<ExtensionActions["sendUserMessage"]>[1]> & {
	sdkRunCapability?: unknown;
	sdkRunToken?: unknown;
};
type CapturedSendCall = [Parameters<ExtensionActions["sendUserMessage"]>[0], InternalCapturedOptions?];

function captureInternalSend(
	sent: CapturedSendCall[],
	content: CapturedSendCall[0],
	options?: InternalCapturedOptions,
): void {
	if (options && typeof options.sdkRunToken === "string") {
		const { sdkRunToken, ...publicOptions } = options;
		sent.push([content, { ...publicOptions, sdkRunCapability: createSdkRunCapability(sdkRunToken) }]);
		return;
	}
	sent.push([content, options]);
}

import { getAskAnswerSource, registerAskAnswerSource } from "../src/tools/ask-answer-registry";
import { startProductionSdkHost } from "./helpers/sdk-production-host";
import { createOrchestrationNotificationsExtension } from "./helpers/telegram-topic-test";

test("SDK capability construction is not exported from the general session module", () => {
	expect("createSdkRunCapability" in sessionSdkRunCapability).toBe(false);
});

type SdkPermissionProvider =
	NonNullable<ExtensionContextActions["setSdkPermissionProvider"]> extends (provider: infer T) => void ? T : never;

const dirs: string[] = [];
const sockets: WebSocket[] = [];
afterEach(async () => {
	await Promise.all(sockets.splice(0).map(closeSocket));
	for (const dir of dirs) await brokerOwnerForTest(dir)?.stop();
	if (process.platform === "win32") {
		Bun.gc(true);
		await Bun.sleep(50);
	}
	for (const dir of dirs.splice(0)) await removeTempDir(dir);
	delete process.env.GJC_SDK_DISABLE;
	delete process.env.GJC_NOTIFICATIONS;
	delete process.env.GJC_LIFECYCLE_TEST_TOKEN;
	delete process.env.GJC_LIFECYCLE_TEST_SECRET;
	delete process.env.GJC_LIFECYCLE_TEST_API_KEY;
});

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
	const deadline = Date.now() + 15_000;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
		await Bun.sleep(20);
	}
}
function pauseNextReconciliationCommit(
	sessionFile: string,
	sessionId: string,
): {
	started: Promise<void>;
	release: () => void;
	restore: () => void;
	arm: () => void;
} {
	const target = reconciliationStorePath(sessionFile, sessionId);
	const started = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const realRename = fsPromises.rename.bind(fsPromises);
	let armed = false;
	let paused = false;
	const rename = spyOn(fsPromises, "rename").mockImplementation(async (from, to) => {
		if (armed && !paused && String(to) === target) {
			paused = true;
			started.resolve();
			await release.promise;
		}
		await realRename(from, to);
	});
	return {
		started: started.promise,
		release: () => release.resolve(),
		restore: () => rename.mockRestore(),
		arm: () => {
			armed = true;
		},
	};
}

/**
 * Fail the next durable reconciliation commit to `sessionFile`/`sessionId` at its
 * atomic rename, i.e. after the temp write succeeded. This is the shape of a real
 * persistence failure (#4743): the publication's promise rejects and the store
 * records the failure, so a teardown drain that consumes either one silently
 * reports a lost write as cleanly drained.
 */
function failNextReconciliationCommit(
	sessionFile: string,
	sessionId: string,
): { failed: Promise<void>; restore: () => void; arm: () => void } {
	const target = reconciliationStorePath(sessionFile, sessionId);
	const failed = Promise.withResolvers<void>();
	const realRename = fsPromises.rename.bind(fsPromises);
	let armed = false;
	let thrown = false;
	const rename = spyOn(fsPromises, "rename").mockImplementation(async (from, to) => {
		if (armed && !thrown && String(to) === target) {
			thrown = true;
			failed.resolve();
			throw Object.assign(new Error("injected reconciliation rename failure"), { code: "EACCES" });
		}
		await realRename(from, to);
	});
	return {
		failed: failed.promise,
		restore: () => rename.mockRestore(),
		arm: () => {
			armed = true;
		},
	};
}

/**
 * Capture process-level unhandled rejections for the duration of a teardown
 * assertion. The repo treats an unhandled rejection as process-killing
 * (`src/modes/components/session-selector.ts`), so a durable-write failure must
 * never produce one.
 */
function captureUnhandledRejections(): { seen: unknown[]; restore: () => void } {
	const seen: unknown[] = [];
	const listener = (reason: unknown): void => {
		seen.push(reason);
	};
	process.on("unhandledRejection", listener);
	return { seen, restore: () => void process.off("unhandledRejection", listener) };
}

async function closeSocket(socket: WebSocket): Promise<void> {
	if (socket.readyState === WebSocket.CLOSED) return;
	const { promise, resolve } = Promise.withResolvers<void>();
	socket.addEventListener("close", () => resolve(), { once: true });
	socket.close();
	await Promise.race([promise, Bun.sleep(500)]);
}

async function removeTempDir(dir: string): Promise<void> {
	for (let attempt = 0; ; attempt++) {
		try {
			await fs.promises.rm(dir, { recursive: true, force: true });
			return;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (attempt >= 20 || (code !== "EBUSY" && code !== "EPERM" && code !== "EACCES" && code !== "ENOTEMPTY"))
				throw error;
			if (process.platform === "win32") Bun.gc(true);
			await Bun.sleep(100);
		}
	}
}

function start(
	ctx: Record<string, unknown>,
	settings?: Settings,
	sendUserMessage: CapturedSendUserMessage = async () => {},
	forwardPreflightCallbacks = false,
	commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>(),
	lifecycle?: { startupCapability: SdkStartupCapability; lifecycleRequired: true },
	autoStart = true,
	ensureTelegramDaemon?: (input: { settings: Settings }) => Promise<"attached" | "blocked">,
	controller?: NotificationSessionController,
	ensureProviderDaemon?: (provider: "discord" | "slack", settings: Settings) => Promise<unknown>,
): Map<string, (event: unknown, context: unknown) => unknown> {
	const handlers = new Map<string, (event: unknown, context: unknown) => unknown>();
	const api = {
		on: (event: string, handler: (event: unknown, context: unknown) => unknown) => handlers.set(event, handler),
		registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) =>
			commands.set(name, command),
		getThinkingLevel: () =>
			typeof ctx.getThinkingLevel === "function" ? (ctx.getThinkingLevel as () => unknown)() : undefined,
		sendUserMessage: (
			content: Parameters<ExtensionActions["sendUserMessage"]>[0],
			options?: Parameters<ExtensionActions["sendUserMessage"]>[1],
		) => {
			if (forwardPreflightCallbacks) return Promise.resolve(sendUserMessage(content, options));
			const { onPreflightAccepted, onPreflightAcceptCommit, ...delivery } = options ?? {};
			const submission = sendUserMessage(content, Object.keys(delivery).length > 0 ? delivery : undefined);
			// The returned chain adopts `submission` only once the durable fence
			// resolves; mark it handled immediately so an early preflight rejection
			// is not surfaced as an unhandled rejection by the test runtime. The
			// default harness stub resolves to undefined, so guard the call.
			if (typeof submission?.catch === "function") submission.catch(() => {});
			// Prefer awaitable durable fence; fall back to legacy sync accept for older mocks.
			if (onPreflightAcceptCommit) {
				return Promise.resolve(onPreflightAcceptCommit()).then(() => {
					onPreflightAccepted?.();
					return submission;
				});
			}
			onPreflightAccepted?.();
			return Promise.resolve(submission);
		},
	} as never;
	if (lifecycle) attachLifecycleStartupCapability(api, lifecycle.startupCapability);
	const effectiveSettings =
		settings ??
		(lifecycle ? ({ get: () => undefined, getAgentDir: () => ctx.cwd } as unknown as Settings) : undefined);
	createOrchestrationNotificationsExtension(
		api,
		effectiveSettings
			? {
					settings: effectiveSettings,
					ensureTelegramDaemon,
					ensureProviderDaemon,
					controller,
					terminalAbortSeams: {
						getTerminalTurnEpoch: () =>
							(ctx as { getTerminalTurnEpoch?: () => number | undefined }).getTerminalTurnEpoch?.(),
						cancelPendingPreflightForTerminalAbort: () =>
							(
								ctx as { cancelPendingPreflightForTerminalAbort?: () => void }
							).cancelPendingPreflightForTerminalAbort?.(),
						captureTerminalAbortSteeringSnapshot: () =>
							(
								ctx as { captureTerminalAbortSteeringSnapshot?: () => number | undefined }
							).captureTerminalAbortSteeringSnapshot?.(),
						discardTerminalAbortSteeringSnapshot: (token: number) =>
							(
								ctx as { discardTerminalAbortSteeringSnapshot?: (token: number) => void }
							).discardTerminalAbortSteeringSnapshot?.(token),
						rebindTerminalAbortSteeringSnapshot: (token: number) =>
							(
								ctx as { rebindTerminalAbortSteeringSnapshot?: (token: number) => void }
							).rebindTerminalAbortSteeringSnapshot?.(token),
						abortPromptAndWaitWithTerminal: (handle, seamOptions) =>
							(
								ctx as {
									abortPromptAndWait?: (
										handle: string,
										options: { graceMs: number; terminal?: { scope: string } },
									) => Promise<unknown>;
								}
							).abortPromptAndWait?.(handle, seamOptions) as unknown as Promise<RunSettlementProof>,
					},
				}
			: undefined,
	);
	if (autoStart) void handlers.get("session_start")?.({ type: "session_start" }, ctx);
	return handlers;
}

function context(
	cwd: string,
	sessionId: string,
	kind: "main" | "sub" = "main",
	live: { idle?: boolean; counts?: { steering: number; followUp: number; nextTurn: number } } = {},
	workflowGate?: WorkflowGateEmitter,
): Record<string, unknown> {
	return {
		cwd,
		sessionMetadata: { kind, taskDepth: kind === "sub" ? 1 : 0 },
		...(workflowGate ? { workflowGate } : {}),
		sessionManager: {
			getSessionId: () => sessionId,
			getCwd: () => cwd,
			getSessionName: () => "SDK wiring",
			getUsageStatistics: () => ({ input: 1, output: 2, cacheRead: 0, cacheWrite: 0, premiumRequests: 0, cost: 0 }),
			getBranch: () => [],
		},
		getContextUsage: () => ({ tokens: 3, contextWindow: 100, percent: 3 }),
		model: { provider: "fixture-provider", id: "reasoning-model" },
		getThinkingLevel: () => "low",
		getActivePromptHandle: () => undefined,
		modelRegistry: {
			getAll: () => [
				{
					provider: "fixture-provider",
					id: "non-reasoning-model",
					name: "Non-reasoning Model",
					contextWindow: 64_000,
					maxTokens: 4_096,
					reasoning: false,
				},
				{
					provider: "fixture-provider",
					id: "reasoning-model",
					name: "Reasoning Model",
					contextWindow: 128_000,
					maxTokens: 8_192,
					reasoning: true,
					thinking: {
						minLevel: "minimal",
						maxLevel: "high",
						mode: "effort",
						defaultLevel: "high",
						levels: ["high", "minimal", "high"],
					},
				},
			],
			getActiveProviders: () => [{ provider: "fixture-provider", connectionKind: "credential" }],
		},
		getSystemPrompt: () => ["test"],
		isIdle: () => live.idle ?? true,
		hasPendingMessages: () => {
			const counts = live.counts ?? { steering: 0, followUp: 0, nextTurn: 0 };
			return counts.steering + counts.followUp + counts.nextTurn > 0;
		},
		getPendingMessageCounts: () => live.counts ?? { steering: 0, followUp: 0, nextTurn: 0 },
		getTranscript: () => [
			{
				id: "entry-1",
				role: "assistant",
				textSummary: "Fixture transcript",
				ts: "2026-01-01T00:00:00.000Z",
				body: "Fixture transcript body",
			},
		],
		getTranscriptBody: (entryId: string) => (entryId === "entry-1" ? "Fixture transcript body" : undefined),
		getGoalState: () => ({ enabled: true, goal: { id: "goal-1", objective: "Fixture goal", status: "active" } }),
		getTodoState: () => [{ name: "Fixture", tasks: [{ content: "Fixture todo", status: "pending" }] }],
		getQueuedMessages: () => [{ id: "queue-1", text: "Fixture queued", mode: "followUp" }],
		cycleModel: async () => ({ model: { id: "fixture-model" }, thinkingLevel: "low" }),
		cycleThinkingLevel: () => "high",
		setQueueMode: (queue: string, mode: unknown) =>
			(queue === "steering" && mode === "all") ||
			(queue === "follow_up" && mode === "one-at-a-time") ||
			(queue === "interrupt" && mode === "wait"),
		getSkillState: () => [{ name: "fixture-skill" }],
		getConfigItems: () => [{ key: "fixture.config", value: true }],
		getBranchCandidates: () => [{ id: "branch-1" }],
		getExtensions: () => [{ path: "fixture-extension" }],
		getArtifact: () => undefined,
		getJobs: () => undefined,
		sdkBindings: () => [
			"cycleModel",
			"cycleThinkingLevel",
			"setQueueMode",
			"getSkillState",
			"getConfigItems",
			"getBranchCandidates",
			"getExtensions",
		],
		clearContext: async () => true,
	};
}

test("prompt settlement diagnostics are bounded and redact raw resource labels", () => {
	const now = 100_000_000;
	const labels = Array.from({ length: 10 }, (_, index) => `secret-provider-tool-label-${index}`);
	const diagnostic = formatPromptSettlementDiagnostic(
		{
			status: "unfenced",
			reason: "resources_pending",
			pending: labels.map((label, index) => ({
				id: String(index),
				kind: index % 2 === 0 ? "provider_iterator" : "tool",
				label,
				registeredAt: index === 0 ? now + 1_000 : index === 1 ? now - 100_000_000 : now - index,
			})),
		},
		now,
	);
	const parsed = JSON.parse(diagnostic) as {
		reason: string;
		pending: Array<{ kind: string; labelHash: string; ageMs: number }>;
		omitted: number;
	};

	expect(parsed.reason).toBe("resources_pending");
	expect(parsed.pending).toHaveLength(8);
	expect(parsed.omitted).toBe(2);
	expect(parsed.pending[0]?.ageMs).toBe(0);
	expect(parsed.pending[1]?.ageMs).toBe(86_400_000);
	expect(parsed.pending.every(entry => /^[0-9a-f]{16}$/.test(entry.labelHash))).toBe(true);
	expect(labels.every(label => !diagnostic.includes(label))).toBe(true);
	expect(new TextEncoder().encode(diagnostic).byteLength).toBeLessThanOrEqual(2_048);
});
test("shared ask-gate schema and stage-state authority preserves generic producer inputs", () => {
	const labels = Array.from({ length: 33 }, (_, index) => (index === 32 ? "option-0" : `option-${index}`));
	const question = { id: "generic-ask", multi: true, allowEmpty: false };
	expect(buildAskGateAnswerSchema(question, labels)).toEqual(buildDeepInterviewAskGateAnswerSchema(question, labels));
	const state = buildAskGateStageState(question, labels);
	expect(() => validateAskGateStageState(state)).not.toThrow();
	expect(state.options).toEqual(labels);
});

test("lifecycle startup production secret collection redacts before normalization and truncation", () => {
	const bare = "bare-secret-value";
	const overlap = "bare-secret-value-plus";
	const nfkc = "secret０";
	const names = ["GJC_LIFECYCLE_TEST_TOKEN", "GJC_LIFECYCLE_TEST_SECRET", "GJC_LIFECYCLE_TEST_API_KEY"] as const;
	const previous = names.map(name => process.env[name]);
	try {
		process.env.GJC_LIFECYCLE_TEST_TOKEN = bare;
		process.env.GJC_LIFECYCLE_TEST_SECRET = overlap;
		process.env.GJC_LIFECYCLE_TEST_API_KEY = nfkc;
		const failure = new SdkStartupCapability().normalizeFailure(
			"startup",
			"failed",
			new Error(`${overlap} ${nfkc.normalize("NFKC")} ${"x".repeat(600)}`),
		);
		expect(failure.message).not.toContain(bare);
		expect(failure.message).not.toContain(overlap);
		expect(failure.message).not.toContain(nfkc.normalize("NFKC"));
		expect(failure.message).toContain("[redacted-secret]");
		expect(new TextEncoder().encode(failure.message).byteLength).toBeLessThanOrEqual(512);
	} finally {
		names.forEach((name, index) => {
			const value = previous[index];
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		});
	}
});

test("lifecycle SDK startup capability settles once and sanitizes public failure details", async () => {
	const capability = new SdkStartupCapability();
	const secret = "token=top-secret";
	const unsafe = new Error(`\u0000 https://example.test/bootstrap?${secret} bearer credential\n${"x".repeat(600)}`);
	const failure = normalizeSdkStartupFailure("startup", "failed", unsafe);

	expect(sanitizeSdkStartupMessage(unsafe)).toBe(failure.message);
	expect(failure).toMatchObject({ phase: "startup", reason: "failed" });
	expect(failure.message).toContain("[redacted-url]");
	expect(failure.message).toContain("[redacted-secret]");
	expect(failure.message).not.toContain("top-secret");
	expect(failure.message).not.toContain("credential");
	expect(new TextEncoder().encode(failure.message).byteLength).toBeLessThanOrEqual(512);

	expect(capability.settleFailure(failure)).toEqual({ status: "failed", failure });
	expect(capability.settleStarted()).toEqual({ status: "failed", failure });
	expect(capability.result).toEqual({ status: "failed", failure });
	expect(await capability.promise).toEqual({ status: "failed", failure });
	const started = new SdkStartupCapability();
	expect(started.settleStarted()).toEqual({ status: "started" });
	expect(started.settleFailure(failure)).toEqual({ status: "started" });
	expect(await started.promise).toEqual({ status: "started" });
});

test("lifecycle teardown swallows dual owner failures without surfacing an extension error and retains exact retry authority", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-lifecycle-cleanup-proof-"));
	dirs.push(cwd);
	const sessionId = `cleanup-proof-${Date.now()}`;
	const tracker = new SdkStartupRollbackTracker();
	const capability = new SdkStartupCapability(tracker, "immediate", "cleanup-proof-marker");
	const stop = spyOn(SessionSdkHost.prototype, "stop").mockRejectedValueOnce(new Error("host stop failed"));
	const nativeStop = (NotificationServer.prototype as unknown as { stopAndWait: () => Promise<void> }).stopAndWait;
	(NotificationServer.prototype as unknown as { stopAndWait: () => Promise<void> }).stopAndWait = async () => {
		throw new Error("server stop failed");
	};
	const errorSpy = spyOn(logger, "error").mockImplementation(() => {});
	let restored = false;
	try {
		const sessionContext = context(cwd, sessionId);
		const handlers = start(sessionContext, undefined, () => {}, false, new Map(), {
			startupCapability: capability,
			lifecycleRequired: true,
		});
		await expect(capability.promise).resolves.toEqual({ status: "started" });

		// Drive the production session_shutdown handler through a real ExtensionRunner
		// so the onError seam proves the retained owner-release failure is NOT surfaced
		// as an extension error (which the UI would render red).
		const shutdownExt = {
			path: "test-shutdown-ext",
			handlers: new Map([
				[
					"session_shutdown",
					[
						async () => {
							await handlers.get("session_shutdown")!({ type: "session_shutdown" }, sessionContext);
						},
					],
				],
			]),
		};
		const runner = new ExtensionRunner([shutdownExt as never], {} as never, cwd, {} as never, {} as never);
		runner.initialize({} as never, {} as never);
		const surfaced: Array<{ event: string }> = [];
		runner.onError(error => surfaced.push(error));
		await expect(runner.emit({ type: "session_shutdown" })).resolves.toBeUndefined();
		expect(surfaced).toEqual([]);

		// The failure is still recorded as a high-severity breadcrumb carrying the
		// original owner-release identity, with the exact shared prefix.
		const breadcrumbs = errorSpy.mock.calls.map(args => String(args[0]));
		expect(
			breadcrumbs.some(
				message =>
					message.startsWith("notifications: SDK notification runtime cleanup failed: ") &&
					message.includes(`SDK notification runtime ${sessionId} owner release failed`),
			),
		).toBe(true);
		expect(tracker.result).toEqual({
			endpointGeneration: 1,
			fenced: false,
			runtimeRemoved: true,
			hostStopped: false,
			brokerRegistrationReleased: false,
		});

		stop.mockRestore();
		(NotificationServer.prototype as unknown as { stopAndWait: () => Promise<void> }).stopAndWait = nativeStop;
		restored = true;
		await expect(
			handlers.get("session_shutdown")!({ type: "session_shutdown" }, sessionContext),
		).resolves.toBeUndefined();
		expect(tracker.result).toEqual({
			endpointGeneration: 1,
			fenced: true,
			runtimeRemoved: true,
			hostStopped: true,
			brokerRegistrationReleased: true,
		});
	} finally {
		errorSpy.mockRestore();
		if (!restored) {
			stop.mockRestore();
			(NotificationServer.prototype as unknown as { stopAndWait: () => Promise<void> }).stopAndWait = nativeStop;
		}
	}
}, 60_000);
test("lifecycle cleanup fences same-id startup and preserves proven owner release across retry", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-lifecycle-cleanup-retry-"));
	dirs.push(cwd);
	const sessionId = `cleanup-retry-${Date.now()}`;
	const tracker = new SdkStartupRollbackTracker();
	const capability = new SdkStartupCapability(tracker, "immediate", "cleanup-retry-marker");
	const hostStop = spyOn(SessionSdkHost.prototype, "stop");
	const serverStart = spyOn(NotificationServer.prototype, "start");
	const nativeStop = (NotificationServer.prototype as unknown as { stopAndWait: () => Promise<void> }).stopAndWait;
	let serverStopAttempts = 0;
	(NotificationServer.prototype as unknown as { stopAndWait: () => Promise<void> }).stopAndWait = async function (
		this: NotificationServer,
	): Promise<void> {
		serverStopAttempts++;
		if (serverStopAttempts === 1) throw new Error("server stop failed");
		await nativeStop.call(this);
	};
	const errorSpy = spyOn(logger, "error").mockImplementation(() => {});
	try {
		const sessionContext = context(cwd, sessionId);
		const handlers = start(sessionContext, undefined, () => {}, false, new Map(), {
			startupCapability: capability,
			lifecycleRequired: true,
		});
		await expect(capability.promise).resolves.toEqual({ status: "started" });
		await expect(
			handlers.get("session_shutdown")!({ type: "session_shutdown" }, sessionContext),
		).resolves.toBeUndefined();
		expect(hostStop).toHaveBeenCalledTimes(1);
		expect(tracker.result).toMatchObject({ fenced: false, hostStopped: false, brokerRegistrationReleased: true });
		const breadcrumbs = errorSpy.mock.calls.map(args => String(args[0]));
		expect(
			breadcrumbs.some(
				message =>
					message.startsWith("notifications: SDK notification runtime cleanup failed: ") &&
					message.includes(`SDK notification runtime ${sessionId} owner release failed`),
			),
		).toBe(true);

		await handlers.get("session_start")!({ type: "session_start" }, sessionContext);
		expect(hostStop).toHaveBeenCalledTimes(1);
		expect(serverStart).toHaveBeenCalledTimes(1);
		expect(serverStopAttempts).toBe(1);

		await handlers.get("session_shutdown")!({ type: "session_shutdown" }, sessionContext);
		expect(hostStop).toHaveBeenCalledTimes(1);
		expect(serverStopAttempts).toBe(2);
		expect(tracker.result).toMatchObject({ fenced: true, hostStopped: true, brokerRegistrationReleased: true });
	} finally {
		hostStop.mockRestore();
		errorSpy.mockRestore();
		serverStart.mockRestore();
		(NotificationServer.prototype as unknown as { stopAndWait: () => Promise<void> }).stopAndWait = nativeStop;
	}
}, 60_000);

test("a blocked Telegram ownership race preserves the canonical endpoint and withholds adapters", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-telegram-sibling-isolation-"));
	dirs.push(cwd);
	const agentDir = path.join(cwd, "agent");
	const sessionId = `telegram-sibling-isolation-${Date.now()}`;
	const base = Settings.isolated({
		"notifications.enabled": true,
		"notifications.telegram.botToken": "123456:token",
		"notifications.telegram.chatId": "42",
		"notifications.discord.enabled": true,
		"notifications.discord.botToken": "discord-token",
		"notifications.discord.applicationId": "discord-app",
		"notifications.discord.guildId": "discord-guild",
		"notifications.discord.parentChannelId": "discord-parent",
	});
	const settings = new Proxy(base, {
		get(target, prop) {
			if (prop === "getAgentDir") return () => agentDir;
			const value = Reflect.get(target, prop, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	}) as Settings;
	const lifecycleRequestId = "telegram-sibling-capability-marker";
	const capability = new SdkStartupCapability(new SdkStartupRollbackTracker(), "immediate", lifecycleRequestId);
	const sessionContext = context(cwd, sessionId);
	const handlers = start(
		sessionContext,
		settings,
		() => {},
		false,
		new Map(),
		{ startupCapability: capability, lifecycleRequired: true },
		false,
		async () => "blocked",
		undefined,
		async () => "attached",
	);
	const previousLifecycleRequestId = process.env.GJC_LIFECYCLE_REQUEST_ID;
	process.env.GJC_LIFECYCLE_REQUEST_ID = "ambient-marker-must-not-win";
	try {
		await handlers.get("session_start")!({ type: "session_start" }, sessionContext);
	} finally {
		if (previousLifecycleRequestId === undefined) delete process.env.GJC_LIFECYCLE_REQUEST_ID;
		else process.env.GJC_LIFECYCLE_REQUEST_ID = previousLifecycleRequestId;
	}
	await expect(capability.promise).resolves.toEqual({ status: "started" });
	const defaultEndpoint = path.join(cwd, ".gjc", "state", "sdk", `${sessionId}.json`);
	const chatStateRoot = path.join(cwd, ".gjc", "state", "chat");
	const chatEndpoint = path.join(chatStateRoot, "sdk", `${sessionId}.json`);
	// No durable foreign-owner state exists up front, so the session publishes
	// its canonical endpoint immediately; the ownership race discovered by the
	// background ensure degrades to withheld notification adapters and never
	// republishes or blocks the session (fail-closed daemon isolation).
	expect(fs.existsSync(defaultEndpoint)).toBe(true);
	expect(fs.existsSync(chatEndpoint)).toBe(false);
	const stateRoot = path.join(cwd, ".gjc", "state");
	const sessions = (await new SessionIndex(agentDir).open()).listSessions().sessions;
	expect(sessions).toContainEqual(
		expect.objectContaining({
			sessionId,
			locator: { cwd: path.resolve(cwd), worktreeRoot: null, stateRoot },
			endpointMtimeMs: fs.statSync(defaultEndpoint).mtimeMs,
			lifecycleRequestId,
		}),
	);
	await handlers.get("session_shutdown")!({ type: "session_shutdown" }, sessionContext);
	const stoppedIndex = await new SessionIndex(agentDir).open();
	await stoppedIndex.refresh();
	expect(stoppedIndex.listSessions().sessions.find(session => session.sessionId === sessionId)).toMatchObject({
		lifecycleRequestId,
		terminal: true,
	});
}, 60_000);

test("production SDK host starts exactly one instrumented server (no duplicate auto-host)", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-single-host-"));
	dirs.push(cwd);
	const serverStart = spyOn(NotificationServer.prototype, "start");
	let host: Awaited<ReturnType<typeof startProductionSdkHost>> | undefined;
	try {
		host = await startProductionSdkHost(cwd, { acceptPromptPreflightWithoutExecution: true });
		// Exactly one SDK server is started: the fixture's explicit instrumented
		// notifications extension. The session must NOT auto-add a second host that
		// could race and overwrite the endpoint (dropping onSdkRequest).
		expect(serverStart).toHaveBeenCalledTimes(1);
		// And exactly one endpoint file exists for the session.
		const sdkDir = path.join(cwd, ".gjc", "state", "sdk");
		const endpointFiles = fs.readdirSync(sdkDir).filter(name => name.endsWith(".json"));
		expect(endpointFiles).toEqual([`${host.sessionId}.json`]);
	} finally {
		serverStart.mockRestore();
		await host?.stop();
	}
}, 60_000);

test("lifecycle session shutdown disposes the exact endpoint once", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-lifecycle-once-"));
	dirs.push(cwd);
	const sessionId = `cleanup-once-${Date.now()}`;
	const tracker = new SdkStartupRollbackTracker();
	const capability = new SdkStartupCapability(tracker, "immediate", "cleanup-once-marker");
	const stop = spyOn(SessionSdkHost.prototype, "stop");
	try {
		const sessionContext = context(cwd, sessionId);
		const handlers = start(sessionContext, undefined, () => {}, false, new Map(), {
			startupCapability: capability,
			lifecycleRequired: true,
		});
		await expect(capability.promise).resolves.toEqual({ status: "started" });
		await handlers.get("session_shutdown")!({ type: "session_shutdown" }, sessionContext);
		await handlers.get("session_shutdown")!({ type: "session_shutdown" }, sessionContext);
		expect(stop).toHaveBeenCalledTimes(1);
		expect(tracker.result.fenced).toBe(true);
	} finally {
		stop.mockRestore();
	}
}, 60_000);

test("lifecycle rollback proof only fences the exact started endpoint generation", () => {
	const tracker = new SdkStartupRollbackTracker();
	tracker.recordGeneration(7);
	tracker.recordStop(8, { runtimeRemoved: true, hostStopped: true, brokerRegistrationReleased: true });
	expect(tracker.result).toEqual({
		endpointGeneration: 7,
		fenced: false,
		runtimeRemoved: false,
		hostStopped: false,
		brokerRegistrationReleased: false,
	});
	tracker.recordStop(7, { runtimeRemoved: true, hostStopped: true, brokerRegistrationReleased: true });
	expect(tracker.result).toEqual({
		endpointGeneration: 7,
		fenced: true,
		runtimeRemoved: true,
		hostStopped: true,
		brokerRegistrationReleased: true,
	});
});

test("lifecycle startup settles failure when native callback registration throws before host start", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-prestart-failure-"));
	dirs.push(cwd);
	const sessionId = "prestart-failure";
	const capability = new SdkStartupCapability(undefined, "immediate", "prestart-failure-marker");
	const hook = spyOn(NotificationServer.prototype, "onSdkFrame").mockImplementation(() => {
		throw new Error("token=prestart-secret");
	});
	try {
		start(context(cwd, sessionId), undefined, () => {}, false, new Map(), {
			startupCapability: capability,
			lifecycleRequired: true,
		});
		const result = await capability.promise;
		expect(result.status).toBe("failed");
		if (result.status !== "failed") throw new Error("Expected lifecycle startup failure.");
		expect(result.failure.message).toContain("[redacted-secret]");
		expect(fs.existsSync(path.join(cwd, ".gjc", "state", "sdk", `${sessionId}.json`))).toBe(false);
	} finally {
		hook.mockRestore();
	}
});

test("session_start swallows startup plus owner-release failure without surfacing an extension error", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-startup-cleanup-double-failure-"));
	dirs.push(cwd);
	const sessionId = `startup-cleanup-double-failure-${Date.now()}`;
	// `mockRejectedValueOnce` on a shared prototype is a one-shot global: a peer
	// test scheduled concurrently in the same shard can consume the single
	// rejection, after which this test's own `start`/`stop` resolve, startup
	// never sets `suppressExtensionError`, and the error surfaces. Scope the
	// rejection to this test's first call instead so shard composition cannot
	// steal it.
	let serverStartRejected = false;
	const serverStartImpl = NotificationServer.prototype.start;
	const serverStart = spyOn(NotificationServer.prototype, "start").mockImplementation(async function (
		this: NotificationServer,
		...args: Parameters<NotificationServer["start"]>
	) {
		if (!serverStartRejected) {
			serverStartRejected = true;
			throw new Error("server start failed");
		}
		return await serverStartImpl.apply(this, args);
	});
	let hostStopRejected = false;
	const hostStopImpl = SessionSdkHost.prototype.stop;
	const hostStop = spyOn(SessionSdkHost.prototype, "stop").mockImplementation(async function (
		this: SessionSdkHost,
		...args: Parameters<SessionSdkHost["stop"]>
	) {
		if (!hostStopRejected) {
			hostStopRejected = true;
			throw new Error("host stop failed");
		}
		return await hostStopImpl.apply(this, args);
	});
	const errorSpy = spyOn(logger, "error").mockImplementation(() => {});
	let restored = false;
	try {
		const sessionContext = context(cwd, sessionId);
		const handlers = start(sessionContext, undefined, () => {}, false, new Map(), undefined, false);
		const startupExt = {
			path: "test-startup-ext",
			handlers: new Map([
				[
					"session_start",
					[
						async () => {
							await handlers.get("session_start")!({ type: "session_start" }, sessionContext);
						},
					],
				],
			]),
		};
		const runner = new ExtensionRunner([startupExt as never], {} as never, cwd, {} as never, {} as never);
		runner.initialize({} as never, {} as never);
		const surfaced: Array<{ event: string }> = [];
		runner.onError(error => surfaced.push(error));

		await expect(runner.emit({ type: "session_start" })).resolves.toBeUndefined();
		expect(surfaced).toEqual([]);
		expect(serverStart).toHaveBeenCalledTimes(1);
		expect(hostStop).toHaveBeenCalledTimes(2);
		const breadcrumbs = errorSpy.mock.calls.map(args => String(args[0]));
		expect(
			breadcrumbs.some(
				message =>
					message.startsWith("notifications: SDK notification runtime cleanup failed: ") &&
					message.includes(`SDK notification runtime ${sessionId} owner release failed`),
			),
		).toBe(true);

		serverStart.mockRestore();
		hostStop.mockRestore();
		restored = true;
		await expect(
			handlers.get("session_shutdown")!({ type: "session_shutdown" }, sessionContext),
		).resolves.toBeUndefined();
	} finally {
		errorSpy.mockRestore();
		if (!restored) {
			serverStart.mockRestore();
			hostStop.mockRestore();
		}
	}
}, 60_000);

test("lifecycle startup reports an actionable error when native capability registration is missing", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-missing-capability-callback-"));
	dirs.push(cwd);
	const capability = new SdkStartupCapability(undefined, "immediate", "missing-capability-marker");
	const prototype = NotificationServer.prototype as unknown as { onNegotiatedCapabilities?: unknown };
	const original = prototype.onNegotiatedCapabilities;
	try {
		prototype.onNegotiatedCapabilities = undefined;
		start(context(cwd, "missing-capability-callback"), undefined, () => {}, false, new Map(), {
			startupCapability: capability,
			lifecycleRequired: true,
		});
		const result = await capability.promise;
		expect(result).toMatchObject({
			status: "failed",
			failure: { phase: "startup", reason: "failed" },
		});
		if (result.status === "failed") {
			expect(result.failure.message).toContain("onNegotiatedCapabilities");
			expect(result.failure.message).toContain("out of date");
		}
		expect(fs.existsSync(path.join(cwd, ".gjc", "state", "sdk", "missing-capability-callback.json"))).toBe(false);
	} finally {
		prototype.onNegotiatedCapabilities = original;
	}
});

test("lifecycle startup settles native capability incompatibility before constructing the host", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-native-incompatible-"));
	dirs.push(cwd);
	const capability = new SdkStartupCapability(undefined, "immediate", "native-incompatible-marker");
	const original = (NotificationServer.prototype as unknown as { retireIfUnclaimed?: unknown }).retireIfUnclaimed;
	try {
		(NotificationServer.prototype as unknown as { retireIfUnclaimed?: unknown }).retireIfUnclaimed = undefined;
		start(context(cwd, "native-incompatible"), undefined, () => {}, false, new Map(), {
			startupCapability: capability,
			lifecycleRequired: true,
		});
		const result = await capability.promise;
		expect(result).toMatchObject({
			status: "failed",
			failure: { phase: "startup", reason: "failed" },
		});
		if (result.status === "failed")
			expect(result.failure.message).toContain("required workflow arbitration methods are missing");
		expect(fs.existsSync(path.join(cwd, ".gjc", "state", "sdk", "native-incompatible.json"))).toBe(false);
	} finally {
		(NotificationServer.prototype as unknown as { retireIfUnclaimed?: unknown }).retireIfUnclaimed = original;
	}
});

test("SDK broker registration records an absolute lifecycle scope", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-host-locator-"));
	const cwd = path.relative(process.cwd(), root);
	const agentDir = path.join(root, "agent");
	const sessionId = `locator-${Date.now()}`;
	dirs.push(root);
	process.env.GJC_NOTIFICATIONS = "1";
	start(context(cwd, sessionId), {
		get: () => undefined,
		getAgentDir: () => agentDir,
	} as unknown as Settings);
	try {
		await waitFor(() => {
			const indexPath = path.join(agentDir, "sdk", "sessions", "index.jsonl");
			return fs.existsSync(indexPath) && fs.readFileSync(indexPath, "utf8").includes(sessionId);
		}, "SDK broker registration");
		const sessions = (await new SessionIndex(agentDir).open()).listSessions().sessions;
		// Locator v2 records a canonical absolute cwd, so a relative launch path
		// is resolved AND realpath-canonicalized (macOS maps /var to /private/var).
		const registered = sessions.find(session => session.sessionId === sessionId);
		expect(registered).toBeDefined();
		expect(path.isAbsolute(registered!.locator.cwd)).toBe(true);
		expect(fs.realpathSync(registered!.locator.cwd)).toBe(fs.realpathSync(path.resolve(cwd)));
	} finally {
		await brokerOwnerForTest(agentDir)?.stop();
	}
}, 60_000);

test("ExtensionRunner forwards SDK permission providers into its production context", () => {
	let installed: SdkPermissionProvider;

	const runner = new ExtensionRunner([], {} as never, process.cwd(), {} as never, {} as never);
	runner.initialize(
		{} as ExtensionActions,
		{
			setSdkPermissionProvider: provider => {
				installed = provider;
			},
		} as ExtensionContextActions,
	);
	const provider = async (): Promise<ClientBridgePermissionOutcome> => ({ outcome: "cancelled" });
	runner.createContext().setSdkPermissionProvider?.(provider);
	expect(installed === provider).toBe(true);
});

test("interactive extension context advertises typed SDK controls and forwards permission providers", async () => {
	let contextActions: ExtensionContextActions | undefined;
	let installed: SdkPermissionProvider;
	let selected: { provider: string; id: string; thinkingLevel: string } | undefined;
	const targetModel = { provider: "runtime-provider", id: "runtime-model" };

	let mode: "prompt" | "allow" | "deny" = "prompt";
	const runner = {
		initialize(
			_actions: ExtensionActions,
			actions: ExtensionContextActions,
			_commands: unknown,
			_ui: ExtensionUIContext,
		): void {
			contextActions = actions;
		},
	};
	const controller = new ExtensionUiController({
		session: {
			extensionRunner: runner,
			setSdkPermissionProvider: (provider: typeof installed) => {
				installed = provider;
			},
			setSdkPermissionMode: (next: typeof mode) => {
				mode = next;
			},
			get sdkPermissionMode() {
				return mode;
			},
			modelRegistry: {
				find: (provider: string, id: string) =>
					provider === targetModel.provider && id === targetModel.id ? targetModel : undefined,
			},
			setDefaultModelSelection: async (model: typeof targetModel, thinkingLevel: string) => {
				selected = { ...model, thinkingLevel };
				return { provider: model.provider, modelId: model.id, thinkingLevel };
			},
		},
	} as unknown as InteractiveModeContext);
	controller.initializeHookRunner({} as ExtensionUIContext, false);
	const provider = async (): Promise<ClientBridgePermissionOutcome> => ({ outcome: "cancelled" });
	contextActions?.setSdkPermissionProvider?.(provider);
	expect(installed === provider).toBe(true);
	expect(await contextActions?.sdkControl?.("permission_mode.set", { mode: "deny" })).toEqual({
		changed: true,
		mode: "deny",
	});
	expect(
		await contextActions?.sdkControl?.("model.set", {
			id: "runtime-provider/runtime-model",
			thinkingLevel: "high",
		}),
	).toEqual({ provider: "runtime-provider", modelId: "runtime-model", thinkingLevel: "high" });
	expect(selected).toEqual({ provider: "runtime-provider", id: "runtime-model", thinkingLevel: "high" });
	await expect(
		contextActions?.sdkControl?.("model.set", {
			id: "runtime-provider/runtime-model",
			thinkingLevel: "inherit",
		}),
	).rejects.toMatchObject({ code: "invalid_input" });
});

test("interactive SDK control routes synthetic gajae-code selections to session-scoped activation", async () => {
	let contextActions: ExtensionContextActions | undefined;
	let activated: { name: string; options: unknown } | undefined;
	let thinkingLevel: string | undefined;
	const runner = {
		initialize(
			_actions: ExtensionActions,
			actions: ExtensionContextActions,
			_commands: unknown,
			_ui: ExtensionUIContext,
		): void {
			contextActions = actions;
		},
	};
	const controller = new ExtensionUiController({
		session: {
			extensionRunner: runner,
			modelRegistry: {
				find: () => undefined,
				getModelProfiles: () =>
					new Map([["codex-eco", { name: "codex-eco", requiredProviders: [], modelMapping: {} }]]),
				getError: () => undefined,
			},
			setDefaultModelProfileForControl: async (name: string, options?: unknown) => {
				activated = { name, options };
				thinkingLevel = "off";
				return { changed: true, id: name };
			},
			getActiveModelProfile: () => undefined,
			get thinkingLevel() {
				return thinkingLevel;
			},
		},
	} as unknown as InteractiveModeContext);
	controller.initializeHookRunner({} as ExtensionUIContext, false);

	expect(
		await contextActions?.sdkControl?.("model.set", {
			id: "gajae-code/codex-eco",
			thinkingLevel: "off",
		}),
	).toEqual({ provider: "gajae-code", modelId: "codex-eco", thinkingLevel: "off" });
	expect(activated).toEqual({
		name: "codex-eco",
		options: { persistDefault: false, thinkingLevelOverride: "off" },
	});

	await expect(
		contextActions?.sdkControl?.("model.set", { id: "gajae-code/codex-eco", thinkingLevel: "high" }),
	).rejects.toMatchObject({ code: "invalid_input" });
});
test("interactive SDK controls reject Broker-owned session handoff", async () => {
	let contextActions: ExtensionContextActions | undefined;
	const runner = {
		initialize(
			_actions: ExtensionActions,
			actions: ExtensionContextActions,
			_commands: unknown,
			_ui: ExtensionUIContext,
		): void {
			contextActions = actions;
		},
	};
	const controller = new ExtensionUiController({
		session: { extensionRunner: runner },
	} as unknown as InteractiveModeContext);
	controller.initializeHookRunner({} as ExtensionUIContext, false);
	await expect(
		contextActions?.sdkControl?.("session.handoff", { target: "preserve failing test" }),
	).rejects.toMatchObject({ code: "operation_prohibited" });
});

test("startup records identity before an early lifecycle event and publishes it only after NotificationServer starts", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-host-identity-startup-"));
	dirs.push(cwd);
	const sessionId = `identity-startup-${Date.now()}`;
	const prototype = NotificationServer.prototype as unknown as {
		start: () => Promise<unknown>;
		pushFrame: (frame: string) => void;
	};
	const startServer = prototype.start;
	const pushFrame = prototype.pushFrame;
	let started = false;
	let identityDelivered = false;
	let emitEarlyLifecycle = () => {};
	prototype.start = async function (this: typeof prototype): Promise<unknown> {
		const endpoint = await startServer.call(this);
		started = true;
		emitEarlyLifecycle();
		return endpoint;
	};
	prototype.pushFrame = function (this: typeof prototype, frame: string): void {
		if ((JSON.parse(frame) as { type?: string }).type === "identity_header") {
			expect(started).toBe(true);
			identityDelivered = true;
		}
		pushFrame.call(this, frame);
	};
	process.env.GJC_NOTIFICATIONS = "1";
	const sessionContext = context(cwd, sessionId);
	const handlers = start(sessionContext);
	emitEarlyLifecycle = () => {
		void handlers.get("agent_start")?.({ type: "agent_start" }, sessionContext);
	};
	try {
		await waitFor(() => identityDelivered, "startup identity delivery");
		const endpointFile = path.join(cwd, ".gjc", "state", "sdk", `${sessionId}.json`);
		const endpoint = JSON.parse(fs.readFileSync(endpointFile, "utf8")) as { url: string; token: string };
		const frames: Record<string, unknown>[] = [];
		const socket = new WebSocket(`${endpoint.url}/?token=${encodeURIComponent(endpoint.token)}`);
		sockets.push(socket);
		socket.addEventListener("message", event => frames.push(JSON.parse(String(event.data))));
		await new Promise<void>((resolve, reject) => {
			socket.addEventListener("open", () => resolve(), { once: true });
			socket.addEventListener("error", () => reject(new Error("WS error")), { once: true });
		});
		socket.send(JSON.stringify({ type: "event_replay", id: "identity-order", sinceGeneration: 1, sinceSeq: 0 }));
		await waitFor(() => frames.some(frame => frame.id === "identity-order"), "identity replay");
		const replay = frames.find(frame => frame.id === "identity-order")!;
		const events = replay.events as Array<Record<string, unknown>>;
		expect(events.map(event => event.payload)).toEqual(
			expect.arrayContaining([
				// Telegram is not configured in this harness, so the session correctly
				// declares itself ineligible. Eligibility tracks configuration only;
				// `isTelegramSessionEligible` owns that rule and is covered directly in
				// notifications-config.test.ts.
				expect.objectContaining({ type: "identity_header", sessionId, telegramTopicsEnabled: false }),
				expect.objectContaining({ type: "activity", sessionId, state: "busy" }),
			]),
		);
		expect(
			events.findIndex(event => (event.payload as { type?: string } | undefined)?.type === "identity_header"),
		).toBeLessThan(events.findIndex(event => (event.payload as { type?: string } | undefined)?.type === "activity"));
	} finally {
		prototype.start = startServer;
		prototype.pushFrame = pushFrame;
	}
	await handlers.get("session_shutdown")!({ type: "session_shutdown" }, sessionContext);
});

test("serializes concurrent /notify on across overlapping replacement startups", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-host-notify-startup-"));
	dirs.push(cwd);
	const sessionId = `notify-startup-${Date.now()}`;
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const messages: Array<{ message: string; level: string }> = [];
	const sessionContext = {
		...context(cwd, sessionId),
		ui: { notify: (message: string, level: string) => messages.push({ message, level }) },
	};

	const prototype = NotificationServer.prototype as unknown as { start: () => Promise<unknown> };
	const startServer = prototype.start;
	const startReached = Promise.withResolvers<void>();
	const allowStart = Promise.withResolvers<void>();
	prototype.start = async function (this: typeof prototype): Promise<unknown> {
		startReached.resolve();
		await allowStart.promise;
		return await startServer.call(this);
	};
	const handlers = start(sessionContext, undefined, () => {}, false, commands);
	process.env.GJC_NOTIFICATIONS = "1";
	try {
		const notify = commands.get("notify");
		expect(notify).toBeDefined();
		const firstEnable = notify!.handler("on", sessionContext);
		const secondEnable = notify!.handler("on", sessionContext);
		await startReached.promise;
		expect(messages).toEqual([]);
		expect(getAskAnswerSource(sessionId)).toBeUndefined();
		allowStart.resolve();
		await Promise.all([firstEnable, secondEnable]);

		expect(getAskAnswerSource(sessionId)).toBeDefined();
		// Both startups serialize behind the single controller queue and converge
		// to enabled: the first startup is no longer reported as failed once its
		// server start completes (activeRuntimeId is claimed at start settlement).
		expect(messages).toEqual([
			{ message: "Notifications enabled for this session.", level: "info" },
			{ message: "Notifications enabled for this session.", level: "info" },
		]);
	} finally {
		allowStart.resolve();
		prototype.start = startServer;
		await handlers.get("session_shutdown")!({ type: "session_shutdown" }, sessionContext);
	}
});

test("/notify on refuses a startup result for a rotated runtime identity", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-host-notify-rotation-"));
	dirs.push(cwd);
	const initialSessionId = `notify-rotation-a-${Date.now()}`;
	let currentSessionId = initialSessionId;
	const nextSessionId = `notify-rotation-b-${Date.now()}`;
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const messages: Array<{ message: string; level: string }> = [];
	const sessionContext = context(cwd, currentSessionId) as Record<string, unknown> & {
		sessionManager: { getSessionId: () => string };
		ui?: { notify: (message: string, level: string) => void };
	};
	sessionContext.sessionManager.getSessionId = () => currentSessionId;
	sessionContext.ui = { notify: (message: string, level: string) => messages.push({ message, level }) };
	const prototype = NotificationServer.prototype as unknown as { start: () => Promise<unknown> };
	const startServer = prototype.start;
	const startReached = Promise.withResolvers<void>();
	const allowStart = Promise.withResolvers<void>();
	prototype.start = async function (this: typeof prototype): Promise<unknown> {
		startReached.resolve();
		await allowStart.promise;
		return await startServer.call(this);
	};
	const handlers = start(sessionContext, undefined, () => {}, false, commands);
	process.env.GJC_NOTIFICATIONS = "1";
	try {
		const enabling = commands.get("notify")!.handler("on", sessionContext);
		await startReached.promise;
		currentSessionId = nextSessionId;
		allowStart.resolve();
		await enabling;
		await waitFor(() => messages.length === 1, "rotated notify result");
		expect(messages).toEqual([
			{
				message: "Notifications were not enabled because the active session changed during startup.",
				level: "warning",
			},
		]);
		expect(getAskAnswerSource(initialSessionId)).toBeUndefined();
	} finally {
		prototype.start = startServer;
		currentSessionId = initialSessionId;
		await handlers.get("session_shutdown")!({ type: "session_shutdown" }, sessionContext);
	}
});

test("/notify on fences teardown and permits a later same-ID replacement runtime", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-host-notify-teardown-"));
	dirs.push(cwd);
	const sessionId = `notify-teardown-${Date.now()}`;
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const messages: Array<{ message: string; level: string }> = [];
	const sessionContext = {
		...context(cwd, sessionId),
		ui: { notify: (message: string, level: string) => messages.push({ message, level }) },
	};
	const prototype = NotificationServer.prototype as unknown as { start: () => Promise<unknown> };
	const startServer = prototype.start;
	const startReached = Promise.withResolvers<void>();
	const allowStart = Promise.withResolvers<void>();
	prototype.start = async function (this: typeof prototype): Promise<unknown> {
		startReached.resolve();
		await allowStart.promise;
		return await startServer.call(this);
	};
	const handlers = start(sessionContext, undefined, () => {}, false, commands);
	process.env.GJC_NOTIFICATIONS = "1";
	try {
		const enabling = commands.get("notify")!.handler("on", sessionContext);
		await startReached.promise;
		const shuttingDown = handlers.get("session_shutdown")!({ type: "session_shutdown" }, sessionContext);
		expect(
			await Promise.race([Promise.resolve(shuttingDown).then(() => true), Bun.sleep(100).then(() => false)]),
		).toBe(true);
		allowStart.resolve();
		await enabling;
		expect(messages).toHaveLength(1);
		expect([
			{ message: "Notifications failed to start for this session.", level: "error" },
			{
				message: "Notifications were not enabled because daemon ownership could not be proved.",
				level: "warning",
			},
		]).toContainEqual(messages[0]);
		expect(getAskAnswerSource(sessionId)).toBeUndefined();
		for (let attempt = 0; attempt < 3 && getAskAnswerSource(sessionId) === undefined; attempt++) {
			await commands.get("notify")!.handler("on", sessionContext);
			if (getAskAnswerSource(sessionId) === undefined) await Bun.sleep(20);
		}
		expect(messages.at(-1)).toEqual({ message: "Notifications enabled for this session.", level: "info" });
		expect(getAskAnswerSource(sessionId)).toBeDefined();
		await handlers.get("session_shutdown")!({ type: "session_shutdown" }, sessionContext);
	} finally {
		prototype.start = startServer;
	}
});

test("SDK host replays file attachment data as base64 while passing raw bytes to N-API", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-host-file-replay-"));
	dirs.push(cwd);
	const sessionId = `sdk-file-replay-${Date.now()}`;
	const bytes = Buffer.from([0, 1, 2, 253, 254, 255]);
	const attachmentPath = path.join(cwd, "replay.bin");
	fs.writeFileSync(attachmentPath, bytes);
	process.env.GJC_NOTIFICATIONS = "1";
	const handlers = start(context(cwd, sessionId));
	const nativePrototype = NotificationServer.prototype as unknown as {
		pushFileAttachmentUnchecked?: (
			sessionId: string,
			name: string,
			mime: string | undefined,
			data: Buffer,
			caption: string | undefined,
		) => void;
	};
	const originalPushFileAttachmentUnchecked = nativePrototype.pushFileAttachmentUnchecked;
	let nativeData: Buffer | undefined;
	nativePrototype.pushFileAttachmentUnchecked = (_sessionId, _name, _mime, data) => {
		nativeData = data;
	};
	try {
		const endpointFile = path.join(cwd, ".gjc", "state", "sdk", `${sessionId}.json`);
		await waitFor(() => fs.existsSync(endpointFile), "SDK endpoint");
		await waitFor(() => getTelegramFileSink(sessionId) !== undefined, "file attachment sink");
		const endpoint = JSON.parse(fs.readFileSync(endpointFile, "utf8")) as { url: string; token: string };
		const frames: Record<string, unknown>[] = [];
		const socket = new WebSocket(`${endpoint.url}/?token=${encodeURIComponent(endpoint.token)}`);
		sockets.push(socket);
		socket.addEventListener("message", event => frames.push(JSON.parse(String(event.data))));
		await new Promise<void>((resolve, reject) => {
			socket.addEventListener("open", () => resolve(), { once: true });
			socket.addEventListener("error", () => reject(new Error("WS error")), { once: true });
		});
		socket.send(JSON.stringify({ type: "event_replay", id: "file-attach", sinceGeneration: 1, sinceSeq: 0 }));
		await waitFor(
			() => frames.some(frame => frame.type === "event_replay_result" && frame.id === "file-attach"),
			"file attachment subscriber replay",
		);
		const attachmentReplay = frames.find(
			frame => frame.type === "event_replay_result" && frame.id === "file-attach",
		)!;
		const attachmentCursor = Number(attachmentReplay.lastSeq);

		await expect(getTelegramFileSink(sessionId)!({ path: attachmentPath })).resolves.toEqual({ ok: true });
		await waitFor(() => nativeData !== undefined, "raw N-API file attachment");
		expect(nativeData).toBeInstanceOf(Buffer);
		expect(nativeData).toEqual(bytes);
		await waitFor(
			() =>
				frames.some(
					frame =>
						frame.type === "event" &&
						(frame.payload as Record<string, unknown> | undefined)?.type === "file_attachment" &&
						typeof frame.seq === "number" &&
						frame.seq > attachmentCursor,
				),
			"live positioned file attachment",
		);
		const liveAttachment = frames.find(
			frame =>
				frame.type === "event" &&
				(frame.payload as Record<string, unknown> | undefined)?.type === "file_attachment" &&
				typeof frame.seq === "number" &&
				frame.seq > attachmentCursor,
		)!;

		socket.send(
			JSON.stringify({
				type: "event_replay",
				id: "file-replay",
				sinceGeneration: attachmentReplay.generation,
				sinceSeq: attachmentCursor,
			}),
		);
		await waitFor(
			() => frames.some(frame => frame.type === "event_replay_result" && frame.id === "file-replay"),
			"file replay",
		);
		const replay = frames.find(frame => frame.type === "event_replay_result" && frame.id === "file-replay");
		const replayedAttachment = (replay?.events as Record<string, unknown>[]).find(
			frame => (frame.payload as Record<string, unknown> | undefined)?.type === "file_attachment",
		);
		expect(replayedAttachment).toEqual(liveAttachment);
		expect(liveAttachment).toMatchObject({
			type: "event",
			kind: "file_attachment",
			generation: attachmentReplay.generation,
			payload: expect.objectContaining({
				type: "file_attachment",
				sessionId,
				name: "replay.bin",
				data: bytes.toString("base64"),
			}),
		});
	} finally {
		if (originalPushFileAttachmentUnchecked) {
			nativePrototype.pushFileAttachmentUnchecked = originalPushFileAttachmentUnchecked;
		} else {
			delete nativePrototype.pushFileAttachmentUnchecked;
		}
		await handlers.get("session_shutdown")!({ type: "session_shutdown" }, context(cwd, sessionId));
	}
});

test("SDK host replays event frames over direct v3 ingress and routes queries through the v2 control-command seam", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-host-"));
	dirs.push(cwd);
	const sessionId = `sdk-${Date.now()}`;
	process.env.GJC_NOTIFICATIONS = "1";
	const handlers = start(context(cwd, sessionId));
	const endpointFile = path.join(cwd, ".gjc", "state", "sdk", `${sessionId}.json`);
	await waitFor(() => fs.existsSync(endpointFile), "SDK endpoint");
	const endpoint = JSON.parse(fs.readFileSync(endpointFile, "utf8")) as { url: string; token: string };
	const frames: Record<string, unknown>[] = [];
	const socket = new WebSocket(`${endpoint.url}/?token=${encodeURIComponent(endpoint.token)}`);
	sockets.push(socket);
	socket.addEventListener("message", event => frames.push(JSON.parse(String(event.data))));
	await new Promise<void>((resolve, reject) => {
		socket.addEventListener("open", () => resolve(), { once: true });
		socket.addEventListener("error", () => reject(new Error("WS error")), { once: true });
	});
	const sessionContext = context(cwd, sessionId);
	await handlers.get("agent_start")?.({ type: "agent_start" }, sessionContext);
	await handlers.get("agent_end")?.({ type: "agent_end" }, sessionContext);
	socket.send(JSON.stringify({ type: "event_replay", id: "replay-1", sinceGeneration: 1, sinceSeq: 0 }));
	await waitFor(
		() => frames.some(frame => frame.type === "event_replay_result" && frame.id === "replay-1"),
		"event replay response",
	);
	const replay = frames.find(frame => frame.type === "event_replay_result" && frame.id === "replay-1");
	expect(replay).toMatchObject({ type: "event_replay_result", id: "replay-1", ok: true, generation: 1 });
	const replayEvents = replay?.events as Array<Record<string, unknown>>;
	expect(replayEvents.length).toBeGreaterThanOrEqual(4);
	expect(replayEvents.map(event => event.seq)).toEqual(replayEvents.map((_event, index) => index + 1));
	expect(replayEvents.slice(0, 2)).toEqual([
		expect.objectContaining({ type: "event", name: "session_ready", sessionId }),
		expect.objectContaining({ payload: expect.objectContaining({ type: "identity_header", sessionId }) }),
	]);
	expect(replayEvents).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ type: "event", name: "session_ready", sessionId }),
			expect.objectContaining({ payload: expect.objectContaining({ type: "identity_header", sessionId }) }),
			expect.objectContaining({ payload: expect.objectContaining({ type: "activity", sessionId, state: "busy" }) }),
			expect.objectContaining({ payload: expect.objectContaining({ type: "activity", sessionId, state: "idle" }) }),
		]),
	);
	await Bun.sleep(100);
	socket.send(
		JSON.stringify({
			type: "control_command",
			sessionId,
			token: endpoint.token,
			requestId: "q1",
			command: { type: "query_request", id: "q1", query: "session.metadata" },
		}),
	);
	await waitFor(
		() =>
			frames.some(
				frame => frame.type === "control_command_result" && frame.requestId === "q1" && frame.status === "ok",
			),
		"query response",
	);
	const query = JSON.parse(
		String(
			frames.find(
				frame => frame.type === "control_command_result" && frame.requestId === "q1" && frame.status === "ok",
			)?.message,
		),
	);
	expect(query).toMatchObject({ type: "query_response", id: "q1", ok: true, page: { items: [{ sessionId }] } });
	socket.send(
		JSON.stringify({
			type: "control_command",
			sessionId,
			token: endpoint.token,
			requestId: "q2",
			command: { type: "query_request", id: "q2", query: "usage.get" },
		}),
	);
	await waitFor(
		() =>
			frames.some(
				frame => frame.type === "control_command_result" && frame.requestId === "q2" && frame.status === "ok",
			),
		"usage response",
	);
	const usage = JSON.parse(
		String(
			frames.find(
				frame => frame.type === "control_command_result" && frame.requestId === "q2" && frame.status === "ok",
			)?.message,
		),
	);
	expect(usage).toMatchObject({
		type: "query_response",
		id: "q2",
		ok: true,
		page: { items: [{ input: 1, output: 2 }] },
	});

	socket.send(
		JSON.stringify({
			type: "control_command",
			sessionId,
			token: endpoint.token,
			requestId: "q3",
			command: { type: "query_request", id: "q3", query: "transcript.list" },
		}),
	);
	await waitFor(
		() =>
			frames.some(
				frame => frame.type === "control_command_result" && frame.requestId === "q3" && frame.status === "ok",
			),
		"transcript response",
	);
	const transcript = JSON.parse(
		String(
			frames.find(
				frame => frame.type === "control_command_result" && frame.requestId === "q3" && frame.status === "ok",
			)?.message,
		),
	);
	expect(transcript).toMatchObject({
		type: "query_response",
		id: "q3",
		ok: true,
		page: { items: [{ id: "entry-1", role: "assistant", textSummary: "Fixture transcript" }] },
	});
	socket.send(
		JSON.stringify({
			type: "control_command",
			sessionId,
			token: endpoint.token,
			requestId: "c1",
			command: { type: "control_request", id: "c1", operation: "not.real", input: {} },
		}),
	);
	await waitFor(
		() =>
			frames.some(
				frame => frame.type === "control_command_result" && frame.requestId === "c1" && frame.status === "ok",
			),
		"control response",
	);
	const control = JSON.parse(
		String(
			frames.find(
				frame => frame.type === "control_command_result" && frame.requestId === "c1" && frame.status === "ok",
			)?.message,
		),
	);
	expect(control).toMatchObject({
		type: "control_response",
		id: "c1",
		ok: false,
		error: { code: "unknown_operation" },
	});
});

test("SDK host preserves positioned live order and replay parity for every attached direct subscriber", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-live-events-"));
	dirs.push(cwd);
	const sessionId = `sdk-${Date.now()}`;
	process.env.GJC_NOTIFICATIONS = "1";
	const handlers = start(context(cwd, sessionId));
	const endpointFile = path.join(cwd, ".gjc", "state", "sdk", `${sessionId}.json`);
	await waitFor(() => fs.existsSync(endpointFile), "SDK endpoint");
	const endpoint = JSON.parse(fs.readFileSync(endpointFile, "utf8")) as { url: string; token: string };
	const clients = await Promise.all([
		SdkClient.connect(endpoint.url, endpoint.token),
		SdkClient.connect(endpoint.url, endpoint.token),
	]);
	try {
		const liveEvents: Record<string, unknown>[][] = [[], []];
		for (const [index, client] of clients.entries()) {
			client.onFrame(frame => {
				if (frame.type === "event") liveEvents[index]!.push(frame);
			});
		}
		// Authoritative attachment: replay completes before the terminal event exists.
		const replays = (await Promise.all(
			clients.map(client => client.request({ type: "event_replay", sinceGeneration: 1, sinceSeq: 0 })),
		)) as Array<{ ok: boolean; generation: number; lastSeq: number }>;
		expect(replays.every(replay => replay.ok)).toBe(true);
		expect(new Set(replays.map(replay => replay.generation))).toEqual(new Set([replays[0]!.generation]));
		expect(new Set(replays.map(replay => replay.lastSeq))).toEqual(new Set([replays[0]!.lastSeq]));
		const sessionContext = context(cwd, sessionId);
		await handlers.get("agent_start")?.({ type: "agent_start" }, sessionContext);
		await handlers.get("agent_end")?.({ type: "agent_end" }, sessionContext);
		// Both already-attached subscribers must receive the later positioned terminal
		// event live before any further query, replay, or reconnect is issued.
		await waitFor(
			() =>
				liveEvents.every((events, index) =>
					events.some(event => {
						const payload = event.payload as Record<string, unknown> | undefined;
						return (
							payload?.type === "agent_end" &&
							typeof event.seq === "number" &&
							event.seq > replays[index]!.lastSeq
						);
					}),
				),
			"live positioned terminal events",
		);

		const liveLifecycle = liveEvents.map((events, index) =>
			events.filter(event => {
				const payloadType = (event.payload as Record<string, unknown> | undefined)?.type;
				return (
					(payloadType === "agent_start" || payloadType === "agent_end") &&
					typeof event.seq === "number" &&
					event.seq > replays[index]!.lastSeq
				);
			}),
		);
		for (const [index, lifecycle] of liveLifecycle.entries()) {
			expect(lifecycle.map(event => (event.payload as Record<string, unknown>).type)).toEqual([
				"agent_start",
				"agent_end",
			]);
			const seqs = lifecycle.map(event => Number(event.seq));
			expect(seqs).toEqual([...seqs].sort((left, right) => left - right));
			expect(new Set(seqs).size).toBe(seqs.length);
			expect(lifecycle).toEqual(
				lifecycle.map(() =>
					expect.objectContaining({
						type: "event",
						generation: replays[index]!.generation,
						payload: expect.objectContaining({ sessionId }),
					}),
				),
			);
		}
		expect(liveLifecycle[1]).toEqual(liveLifecycle[0]);

		const postLiveReplays = (await Promise.all(
			clients.map((client, index) =>
				client.request({
					type: "event_replay",
					sinceGeneration: replays[index]!.generation,
					sinceSeq: replays[index]!.lastSeq,
				}),
			),
		)) as Array<{ events: Record<string, unknown>[] }>;
		for (const [index, replay] of postLiveReplays.entries()) {
			const replayLifecycle = replay.events.filter(event => {
				const payloadType = (event.payload as Record<string, unknown> | undefined)?.type;
				return payloadType === "agent_start" || payloadType === "agent_end";
			});
			expect(replayLifecycle).toEqual(liveLifecycle[index]);
		}
	} finally {
		await Promise.all(clients.map(client => client.close()));
	}
});

test("SDK host preserves ordered prompt image blocks in the host payload", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-prompt-images-"));
	dirs.push(cwd);
	const sessionId = `sdk-prompt-images-${Date.now()}`;
	const sent: CapturedSendCall[] = [];
	const sessionContext = context(cwd, sessionId);
	const handlers = start(sessionContext, undefined, (...args) => {
		captureInternalSend(sent, args[0], args[1]);
	});
	const endpointFile = path.join(cwd, ".gjc", "state", "sdk", `${sessionId}.json`);
	await waitFor(() => fs.existsSync(endpointFile), "SDK endpoint");
	const endpoint = JSON.parse(fs.readFileSync(endpointFile, "utf8")) as { url: string; token: string };
	const frames: Record<string, unknown>[] = [];
	const socket = new WebSocket(`${endpoint.url}/?token=${encodeURIComponent(endpoint.token)}`);
	sockets.push(socket);
	socket.addEventListener("message", event => frames.push(JSON.parse(String(event.data))));
	await new Promise<void>((resolve, reject) => {
		socket.addEventListener("open", () => resolve(), { once: true });
		socket.addEventListener("error", () => reject(new Error("WS error")), { once: true });
	});

	const prompt = async (requestId: string, input: Record<string, unknown>) => {
		socket.send(
			JSON.stringify({
				type: "control_command",
				sessionId,
				token: endpoint.token,
				requestId,
				command: { type: "control_request", id: requestId, operation: "turn.prompt", input },
			}),
		);
		await waitFor(
			() => frames.some(frame => frame.type === "control_command_result" && frame.requestId === requestId),
			`${requestId} response`,
		);
	};

	await prompt("text-and-images", {
		text: "Compare these screenshots.",
		images: [{ data: "cG5nLWJ5dGVz", mimeType: "image/png" }, { data: "ZGVmYXVsdC1taW1l" }],
	});
	await handlers.get("agent_start")?.({ type: "agent_start" }, sessionContext);
	await handlers.get("agent_end")?.({ type: "agent_end" }, sessionContext);
	await prompt("images-only", {
		text: "",
		images: [{ data: "d2VicC1ieXRlcw", mimeType: "image/webp" }],
	});

	expect(sent).toEqual([
		[
			[
				{ type: "text", text: "Compare these screenshots." },
				{ type: "image", data: "cG5nLWJ5dGVz", mimeType: "image/png" },
				{ type: "image", data: "ZGVmYXVsdC1taW1l", mimeType: "image/jpeg" },
			],
			{ preflightSignal: expect.any(AbortSignal) },
		],
		[
			[{ type: "image", data: "d2VicC1ieXRlcw", mimeType: "image/webp" }],
			{ preflightSignal: expect.any(AbortSignal) },
		],
	]);
});

test("SDK host correlates follow-up acknowledgements with the later agent start", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-follow-up-correlation-"));
	dirs.push(cwd);
	const sessionId = `sdk-follow-up-correlation-${Date.now()}`;
	const sent: CapturedSendCall[] = [];
	const sessionContext = context(cwd, sessionId);
	const handlers = start(sessionContext, undefined, (...args) => {
		captureInternalSend(sent, args[0], args[1]);
	});
	const endpointFile = path.join(cwd, ".gjc", "state", "sdk", `${sessionId}.json`);
	await waitFor(() => fs.existsSync(endpointFile), "SDK endpoint");
	const endpoint = JSON.parse(fs.readFileSync(endpointFile, "utf8")) as { url: string; token: string };
	const frames: Record<string, unknown>[] = [];
	const socket = new WebSocket(`${endpoint.url}/?token=${encodeURIComponent(endpoint.token)}`);
	sockets.push(socket);
	socket.addEventListener("message", event => frames.push(JSON.parse(String(event.data))));
	await new Promise<void>((resolve, reject) => {
		socket.addEventListener("open", () => resolve(), { once: true });
		socket.addEventListener("error", () => reject(new Error("WS error")), { once: true });
	});
	void handlers.get("agent_start")?.({ type: "agent_start" }, sessionContext);
	await Bun.sleep(10);
	expect(frames.some(frame => frame.type === "agent_start" && frame.commandId !== undefined)).toBe(false);
	socket.send(
		JSON.stringify({
			type: "control_request",
			id: "follow-up-correlation",
			operation: "turn.follow_up",
			input: { text: "queued follow-up" },
		}),
	);
	await waitFor(
		() => frames.some(frame => frame.type === "control_response" && frame.id === "follow-up-correlation"),
		"follow-up acknowledgement",
	);
	const acknowledgement = frames.find(
		frame => frame.type === "control_response" && frame.id === "follow-up-correlation",
	) as { result?: { commandId?: string; turnId?: string } };
	const commandId = acknowledgement.result?.commandId;
	const turnId = acknowledgement.result?.turnId;
	expect(acknowledgement).toMatchObject({
		ok: true,
		result: { accepted: true, commandId: expect.any(String), turnId: expect.any(String) },
	});
	if (typeof commandId !== "string" || typeof turnId !== "string") throw new Error("missing follow-up correlation");
	const sentOptions = sent[0]?.[1];
	const sdkRunToken = readSdkRunCapability(sentOptions?.sdkRunCapability);
	expect(sent).toEqual([
		[
			"queued follow-up",
			{
				deliverAs: "followUp",
				preflightSignal: expect.any(AbortSignal),
				sdkRunCapability: expect.any(Object),
			},
		],
	]);
	expect("sdkRunToken" in (sentOptions ?? {})).toBe(false);
	if (typeof sdkRunToken !== "string") throw new Error("missing SDK follow-up run token");
	void handlers.get("agent_end")?.({ type: "agent_end", messages: [], stopReason: "completed" }, sessionContext);
	await Bun.sleep(10);
	expect(frames.some(frame => frame.type === "agent_start" && frame.commandId === commandId)).toBe(false);
	void handlers.get("agent_start")?.({ type: "agent_start", sdkRunToken }, sessionContext);
	await waitFor(
		() => frames.some(frame => frame.type === "agent_start" && frame.commandId === commandId),
		"correlated agent start",
	);
	expect(frames).toEqual(
		expect.arrayContaining([expect.objectContaining({ type: "agent_start", sessionId, commandId, turnId })]),
	);
	await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, sessionContext);
});

test("SDK host directly delivers correlated lifecycle frames for an accepted prompt", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-prompt-success-"));
	dirs.push(cwd);
	const sessionId = `sdk-prompt-success-${Date.now()}`;
	const sessionContext = context(cwd, sessionId);
	const handlers = start(sessionContext);
	const endpointFile = path.join(cwd, ".gjc", "state", "sdk", `${sessionId}.json`);
	await waitFor(() => fs.existsSync(endpointFile), "SDK endpoint");
	const endpoint = JSON.parse(fs.readFileSync(endpointFile, "utf8")) as { url: string; token: string };
	const frames: Record<string, unknown>[] = [];
	const socket = new WebSocket(`${endpoint.url}/?token=${encodeURIComponent(endpoint.token)}`);
	sockets.push(socket);
	socket.addEventListener("message", event => frames.push(JSON.parse(String(event.data))));
	await new Promise<void>((resolve, reject) => {
		socket.addEventListener("open", () => resolve(), { once: true });
		socket.addEventListener("error", () => reject(new Error("WS error")), { once: true });
	});
	const observerFrames: Record<string, unknown>[] = [];
	const observer = new WebSocket(`${endpoint.url}/?token=${encodeURIComponent(endpoint.token)}`);
	sockets.push(observer);
	observer.addEventListener("message", event => observerFrames.push(JSON.parse(String(event.data))));
	await new Promise<void>((resolve, reject) => {
		observer.addEventListener("open", () => resolve(), { once: true });
		observer.addEventListener("error", () => reject(new Error("observer WS error")), { once: true });
	});
	socket.send(
		JSON.stringify({
			type: "control_request",
			id: "prompt-success",
			operation: "turn.prompt",
			input: { text: "accepted prompt" },
		}),
	);
	await waitFor(
		() => frames.some(frame => frame.type === "control_response" && frame.id === "prompt-success"),
		"accepted prompt acknowledgement",
	);
	const acknowledgement = frames.find(frame => frame.type === "control_response" && frame.id === "prompt-success") as {
		result?: { commandId?: unknown; turnId?: unknown };
	};
	const promptCommandId = acknowledgement.result?.commandId;
	const promptTurnId = acknowledgement.result?.turnId;
	if (typeof promptCommandId !== "string" || typeof promptTurnId !== "string")
		throw new Error("missing accepted prompt correlation");
	expect(acknowledgement).toMatchObject({
		ok: true,
		result: { accepted: true, commandId: expect.any(String), turnId: expect.any(String) },
	});
	await handlers.get("agent_start")?.({ type: "agent_start" }, sessionContext);
	await handlers.get("message_update")?.(
		{
			type: "message_update",
			message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
			assistantMessageEvent: { type: "text_delta", delta: "hi" },
		},
		sessionContext,
	);
	await handlers.get("tool_execution_start")?.(
		{
			type: "tool_execution_start",
			toolCallId: "tool-read-1",
			toolName: "read",
			args: { path: "README.md" },
		},
		sessionContext,
	);
	await handlers.get("tool_execution_update")?.(
		{
			type: "tool_execution_update",
			toolCallId: "tool-read-1",
			toolName: "read",
			args: { path: "README.md" },
			partialResult: { content: [{ type: "text", text: "reading" }] },
		},
		sessionContext,
	);
	await handlers.get("tool_execution_end")?.(
		{
			type: "tool_execution_end",
			toolCallId: "tool-read-1",
			toolName: "read",
			result: { content: [{ type: "text", text: "# Gajae-Code" }] },
			isError: false,
		},
		sessionContext,
	);
	socket.send(
		JSON.stringify({
			type: "control_request",
			id: "prompt-while-busy",
			operation: "turn.prompt",
			input: { text: "must not steer" },
		}),
	);
	await waitFor(
		() => frames.some(frame => frame.type === "control_response" && frame.id === "prompt-while-busy"),
		"busy prompt rejection",
	);
	expect(frames.find(frame => frame.type === "control_response" && frame.id === "prompt-while-busy")).toMatchObject({
		ok: false,
		error: { code: "busy" },
	});
	await handlers.get("agent_end")?.(
		{
			type: "agent_end",
			messages: [
				{
					role: "assistant",
					content: [{ type: "text", text: "final answer" }],
					stopReason: "stop",
				},
			],
		} as never,
		sessionContext,
	);
	await waitFor(
		() => frames.some(frame => frame.type === "agent_start") && frames.some(frame => frame.type === "agent_end"),
		"correlated accepted prompt lifecycle",
	);
	expect(frames.find(frame => frame.type === "agent_end")).toMatchObject({ finalText: "final answer" });
	const promptResultId = "prompt-success-result";
	socket.send(
		JSON.stringify({
			type: "query_request",
			id: promptResultId,
			query: "turn.result",
			input: {
				kind: "prompt",
				commandId: promptCommandId,
				turnId: promptTurnId,
			},
		}),
	);
	await waitFor(() => frames.some(frame => frame.id === promptResultId), "persisted prompt result content");
	expect(frames.find(frame => frame.id === promptResultId)).toMatchObject({
		ok: true,
		result: {
			status: "terminal_ok",
			content: { text: "final answer", byteLength: 12, truncated: false },
		},
	});
	const checkpointId = "prompt-success-checkpoint";
	socket.send(
		JSON.stringify({
			type: "query_request",
			id: checkpointId,
			query: "session.checkpoint",
		}),
	);
	await waitFor(() => frames.some(frame => frame.id === checkpointId), "production runtime atomic checkpoint");
	expect(frames.find(frame => frame.id === checkpointId)).toMatchObject({
		ok: true,
		result: {
			checkpointToken: expect.any(String),
			checkpoint: {
				revision: 1,
				generation: expect.any(Number),
				seq: expect.any(Number),
				idle: true,
			},
		},
	});
	await waitFor(
		() =>
			frames.some(
				frame =>
					frame.type === "event" &&
					frame.kind === "message_update" &&
					(frame.payload as { event?: { assistantMessageEvent?: { delta?: unknown } } })?.event
						?.assistantMessageEvent?.delta === "hi",
			),
		"correlated assistant message event",
	);
	await waitFor(
		() =>
			frames.some(frame => frame.type === "event" && frame.kind === "tool_execution_start") &&
			frames.some(frame => frame.type === "event" && frame.kind === "tool_execution_update") &&
			frames.some(frame => frame.type === "event" && frame.kind === "tool_execution_end"),
		"correlated tool lifecycle events",
	);
	observer.send(JSON.stringify({ type: "event_replay", id: "observer-replay", sinceSeq: 0 }));
	await waitFor(
		() => observerFrames.some(frame => frame.type === "event_replay_result" && frame.id === "observer-replay"),
		"observer event replay",
	);
	const observerReplay = observerFrames.find(
		frame => frame.type === "event_replay_result" && frame.id === "observer-replay",
	) as { events?: Array<Record<string, unknown>> };
	const correlation = {
		commandId: promptCommandId,
		turnId: promptTurnId,
	};
	expect(frames.filter(frame => frame.type === "agent_start")).toEqual([
		expect.objectContaining({ type: "agent_start", sessionId, ...correlation }),
	]);
	expect(frames.filter(frame => frame.type === "agent_end" || frame.type === "agent_failed")).toEqual([
		expect.objectContaining({ type: "agent_end", sessionId, ...correlation }),
	]);
	expect(observerFrames.some(frame => frame.type === "agent_start" || frame.type === "agent_end")).toBe(false);
	expect(observerFrames.some(frame => frame.type === "event" && frame.kind === "message_update")).toBe(false);
	expect(
		observerFrames.some(
			frame =>
				frame.type === "event" &&
				(frame.kind === "tool_execution_start" ||
					frame.kind === "tool_execution_update" ||
					frame.kind === "tool_execution_end"),
		),
	).toBe(false);
	expect(observerReplay.events?.some(frame => frame.kind === "message_update")).toBe(false);
	await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, sessionContext);
});

test("SDK host buffers synchronous pre-ack start and end until after acknowledgement", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-prompt-pre-ack-end-"));
	dirs.push(cwd);
	const sessionId = `sdk-prompt-pre-ack-end-${Date.now()}`;
	const sessionContext = context(cwd, sessionId);
	let handlers!: Map<string, (event: unknown, context: unknown) => unknown>;
	handlers = start(
		sessionContext,
		undefined,
		async (_content, options) => {
			await firePreflightAccept(options);
			void handlers.get("agent_start")?.({ type: "agent_start" }, sessionContext);
			void handlers.get("agent_end")?.({ type: "agent_end" }, sessionContext);
		},
		true,
	);
	const endpointFile = path.join(cwd, ".gjc", "state", "sdk", `${sessionId}.json`);
	await waitFor(() => fs.existsSync(endpointFile), "SDK endpoint");
	const endpoint = JSON.parse(fs.readFileSync(endpointFile, "utf8")) as { url: string; token: string };
	const frames: Record<string, unknown>[] = [];
	const socket = new WebSocket(`${endpoint.url}/?token=${encodeURIComponent(endpoint.token)}`);
	sockets.push(socket);
	socket.addEventListener("message", event => frames.push(JSON.parse(String(event.data))));
	await new Promise<void>((resolve, reject) => {
		socket.addEventListener("open", () => resolve(), { once: true });
		socket.addEventListener("error", () => reject(new Error("WS error")), { once: true });
	});
	socket.send(
		JSON.stringify({
			type: "control_request",
			id: "pre-ack-end",
			operation: "turn.prompt",
			input: { text: "finish synchronously" },
		}),
	);
	await waitFor(
		() =>
			frames.some(frame => frame.type === "control_response" && frame.id === "pre-ack-end") &&
			frames.some(frame => frame.type === "agent_end"),
		"pre-ack end lifecycle",
	);
	const acknowledgementIndex = frames.findIndex(
		frame => frame.type === "control_response" && frame.id === "pre-ack-end",
	);
	const acknowledgement = frames[acknowledgementIndex] as { result?: { commandId?: unknown; turnId?: unknown } };
	const correlation = { commandId: acknowledgement.result?.commandId, turnId: acknowledgement.result?.turnId };
	const startFrames = frames.filter(frame => frame.type === "agent_start");
	const terminalFrames = frames.filter(frame => frame.type === "agent_end" || frame.type === "agent_failed");
	expect(acknowledgement).toMatchObject({
		ok: true,
		result: { accepted: true, commandId: expect.any(String), turnId: expect.any(String) },
	});
	expect(acknowledgementIndex).toBeLessThan(frames.findIndex(frame => frame.type === "agent_start"));
	expect(startFrames).toEqual([expect.objectContaining({ type: "agent_start", sessionId, ...correlation })]);
	expect(terminalFrames).toEqual([expect.objectContaining({ type: "agent_end", sessionId, ...correlation })]);
	await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, sessionContext);
});

test("SDK host buffers synchronous pre-ack accepted failure until after acknowledgement", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-prompt-pre-ack-failed-"));
	dirs.push(cwd);
	const sessionId = `sdk-prompt-pre-ack-failed-${Date.now()}`;
	const sessionContext = context(cwd, sessionId);
	let handlers!: Map<string, (event: unknown, context: unknown) => unknown>;
	handlers = start(
		sessionContext,
		undefined,
		async (_content, options) => {
			await firePreflightAccept(options);
			void handlers.get("agent_start")?.({ type: "agent_start" }, sessionContext);
			throw Object.assign(new Error("synchronous accepted failure"), { code: "unavailable" });
		},
		true,
	);
	const endpointFile = path.join(cwd, ".gjc", "state", "sdk", `${sessionId}.json`);
	await waitFor(() => fs.existsSync(endpointFile), "SDK endpoint");
	const endpoint = JSON.parse(fs.readFileSync(endpointFile, "utf8")) as { url: string; token: string };
	const frames: Record<string, unknown>[] = [];
	const socket = new WebSocket(`${endpoint.url}/?token=${encodeURIComponent(endpoint.token)}`);
	sockets.push(socket);
	socket.addEventListener("message", event => frames.push(JSON.parse(String(event.data))));
	await new Promise<void>((resolve, reject) => {
		socket.addEventListener("open", () => resolve(), { once: true });
		socket.addEventListener("error", () => reject(new Error("WS error")), { once: true });
	});
	socket.send(
		JSON.stringify({
			type: "control_request",
			id: "pre-ack-failed",
			operation: "turn.prompt",
			input: { text: "fail synchronously" },
		}),
	);
	await waitFor(
		() =>
			frames.some(frame => frame.type === "control_response" && frame.id === "pre-ack-failed") &&
			frames.some(frame => frame.type === "agent_failed"),
		"pre-ack accepted failure lifecycle",
	);
	const acknowledgementIndex = frames.findIndex(
		frame => frame.type === "control_response" && frame.id === "pre-ack-failed",
	);
	const acknowledgement = frames[acknowledgementIndex] as { result?: { commandId?: unknown; turnId?: unknown } };
	const correlation = { commandId: acknowledgement.result?.commandId, turnId: acknowledgement.result?.turnId };
	const startFrames = frames.filter(frame => frame.type === "agent_start");
	const terminalFrames = frames.filter(frame => frame.type === "agent_end" || frame.type === "agent_failed");
	expect(acknowledgement).toMatchObject({
		ok: true,
		result: { accepted: true, commandId: expect.any(String), turnId: expect.any(String) },
	});
	expect(acknowledgementIndex).toBeLessThan(frames.findIndex(frame => frame.type === "agent_start"));
	expect(startFrames).toEqual([expect.objectContaining({ type: "agent_start", sessionId, ...correlation })]);
	expect(terminalFrames).toEqual([
		expect.objectContaining({
			type: "agent_failed",
			sessionId,
			...correlation,
			error: { code: "unavailable", message: "Prompt submission failed." },
		}),
	]);
	await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, sessionContext);
});

test("SDK host replays an accepted prompt terminal after its requester disconnects", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-prompt-disconnect-replay-"));
	dirs.push(cwd);
	const sessionId = `sdk-prompt-disconnect-replay-${Date.now()}`;
	const sessionContext = context(cwd, sessionId);
	const handlers = start(sessionContext);
	const endpointFile = path.join(cwd, ".gjc", "state", "sdk", `${sessionId}.json`);
	await waitFor(() => fs.existsSync(endpointFile), "SDK endpoint");
	const endpoint = JSON.parse(fs.readFileSync(endpointFile, "utf8")) as { url: string; token: string };
	const frames: Record<string, unknown>[] = [];
	const requester = new WebSocket(`${endpoint.url}/?token=${encodeURIComponent(endpoint.token)}`);
	sockets.push(requester);
	requester.addEventListener("message", event => frames.push(JSON.parse(String(event.data))));
	await new Promise<void>((resolve, reject) => {
		requester.addEventListener("open", () => resolve(), { once: true });
		requester.addEventListener("error", () => reject(new Error("requester WS error")), { once: true });
	});
	requester.send(
		JSON.stringify({
			type: "control_request",
			id: "disconnect-prompt",
			operation: "turn.prompt",
			input: { text: "recover my terminal" },
		}),
	);
	await waitFor(
		() => frames.some(frame => frame.type === "control_response" && frame.id === "disconnect-prompt"),
		"accepted prompt acknowledgement",
	);
	const acknowledgement = frames.find(
		frame => frame.type === "control_response" && frame.id === "disconnect-prompt",
	) as {
		result?: { commandId?: unknown; turnId?: unknown };
	};
	const correlation = { commandId: acknowledgement.result?.commandId, turnId: acknowledgement.result?.turnId };
	await handlers.get("agent_start")?.({ type: "agent_start" }, sessionContext);
	await waitFor(
		() => frames.some(frame => frame.type === "agent_start" && frame.commandId === correlation.commandId),
		"correlated agent start",
	);
	const requesterClosed = new Promise<void>(resolve =>
		requester.addEventListener("close", () => resolve(), { once: true }),
	);
	requester.close();
	await requesterClosed;
	await handlers.get("agent_end")?.({ type: "agent_end" }, sessionContext);
	const recoveryFrames: Record<string, unknown>[] = [];
	const recovery = new WebSocket(`${endpoint.url}/?token=${encodeURIComponent(endpoint.token)}`);
	sockets.push(recovery);
	recovery.addEventListener("message", event => recoveryFrames.push(JSON.parse(String(event.data))));
	await new Promise<void>((resolve, reject) => {
		recovery.addEventListener("open", () => resolve(), { once: true });
		recovery.addEventListener("error", () => reject(new Error("recovery WS error")), { once: true });
	});
	// The terminalization claim is durable and lands asynchronously after the
	// lifecycle event is published to the ring, so poll the ring until the
	// correlated terminal appears instead of racing its first snapshot.
	const pollReplay = () =>
		recovery.send(JSON.stringify({ type: "event_replay", id: "disconnect-replay", sinceGeneration: 1, sinceSeq: 0 }));
	pollReplay();
	await waitFor(() => {
		const results = recoveryFrames.filter(
			frame => frame.type === "event_replay_result" && frame.id === "disconnect-replay",
		);
		const events =
			(results.at(-1) as { events?: Array<{ payload?: Record<string, unknown> }> } | undefined)?.events ?? [];
		const terminal = events.find(
			event => event.payload?.commandId === correlation.commandId && event.payload?.type === "agent_end",
		);
		if (terminal) return true;
		pollReplay();
		return false;
	}, "disconnected prompt replay");
	const replay = recoveryFrames
		.filter(frame => frame.type === "event_replay_result" && frame.id === "disconnect-replay")
		.at(-1) as {
		events?: Array<{ payload?: Record<string, unknown> }>;
	};
	const lifecycle = replay.events?.filter(
		event =>
			event.payload?.commandId === correlation.commandId &&
			(event.payload?.type === "agent_start" || event.payload?.type === "agent_end"),
	);
	expect(lifecycle).toEqual([
		expect.objectContaining({ payload: { type: "agent_start", sessionId, ...correlation } }),
		expect.objectContaining({
			payload: {
				type: "agent_end",
				sessionId,
				...correlation,
				outcome: { kind: "stopped", reason: "end_turn", provenance: "agent" },
			},
		}),
	]);
	await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, sessionContext);
});

test("SDK host serializes concurrent prompt admission and replays correlated lifecycle", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-prompt-concurrent-"));
	dirs.push(cwd);
	const sessionId = `sdk-prompt-concurrent-${Date.now()}`;
	const submissions: string[] = [];
	const preflightStarted = Promise.withResolvers<void>();
	const releasePreflight = Promise.withResolvers<void>();
	const sessionContext = context(cwd, sessionId);
	const handlers = start(
		sessionContext,
		undefined,
		async (content, options) => {
			submissions.push(String(content));
			preflightStarted.resolve();
			await releasePreflight.promise;
			await firePreflightAccept(options);
		},
		true,
	);

	const endpointFile = path.join(cwd, ".gjc", "state", "sdk", `${sessionId}.json`);
	await waitFor(() => fs.existsSync(endpointFile), "SDK endpoint");
	const endpoint = JSON.parse(fs.readFileSync(endpointFile, "utf8")) as { url: string; token: string };
	const firstFrames: Record<string, unknown>[] = [];
	const secondFrames: Record<string, unknown>[] = [];
	const first = new WebSocket(`${endpoint.url}/?token=${encodeURIComponent(endpoint.token)}`);
	const second = new WebSocket(`${endpoint.url}/?token=${encodeURIComponent(endpoint.token)}`);
	sockets.push(first, second);
	first.addEventListener("message", event => firstFrames.push(JSON.parse(String(event.data))));
	second.addEventListener("message", event => secondFrames.push(JSON.parse(String(event.data))));
	await Promise.all(
		[first, second].map(
			socket =>
				new Promise<void>((resolve, reject) => {
					socket.addEventListener("open", () => resolve(), { once: true });
					socket.addEventListener("error", () => reject(new Error("WS error")), { once: true });
				}),
		),
	);
	first.send(
		JSON.stringify({
			type: "control_request",
			id: "first-prompt",
			operation: "turn.prompt",
			input: { text: "accepted once" },
			idempotencyKey: "concurrent-prompt",
		}),
	);
	await preflightStarted.promise;

	second.send(
		JSON.stringify({
			type: "control_request",
			id: "conflicting-prompt",
			operation: "turn.prompt",
			input: { text: "must fail closed" },
			idempotencyKey: "concurrent-prompt",
		}),
	);
	releasePreflight.resolve();
	await waitFor(
		() => secondFrames.some(frame => frame.type === "control_response" && frame.id === "conflicting-prompt"),
		"serialized conflicting prompt response",
	);
	await waitFor(
		() => firstFrames.some(frame => frame.type === "control_response" && frame.id === "first-prompt"),
		"accepted prompt response",
	);
	expect(submissions).toEqual(["accepted once"]);
	expect(
		secondFrames.find(frame => frame.type === "control_response" && frame.id === "conflicting-prompt"),
	).toMatchObject({
		ok: false,
		error: { code: "busy" },
	});
	const acknowledgement = firstFrames.find(
		frame => frame.type === "control_response" && frame.id === "first-prompt",
	) as {
		result?: { commandId?: unknown; turnId?: unknown };
	};
	const correlation = { commandId: acknowledgement.result?.commandId, turnId: acknowledgement.result?.turnId };
	await handlers.get("agent_start")?.({ type: "agent_start" }, sessionContext);
	await handlers.get("agent_end")?.({ type: "agent_end" }, sessionContext);
	await waitFor(
		() => firstFrames.some(frame => frame.type === "agent_end" && frame.commandId === correlation.commandId),
		"accepted prompt terminal",
	);
	await handlers.get("agent_end")?.({ type: "agent_end" }, sessionContext);
	expect(
		firstFrames.filter(frame => frame.type === "agent_end" && frame.commandId === correlation.commandId),
	).toHaveLength(1);
	expect(secondFrames.some(frame => frame.type === "agent_start" || frame.type === "agent_end")).toBe(false);
	first.close();
	const recoveryFrames: Record<string, unknown>[] = [];
	const recovery = new WebSocket(`${endpoint.url}/?token=${encodeURIComponent(endpoint.token)}`);
	sockets.push(recovery);
	recovery.addEventListener("message", event => recoveryFrames.push(JSON.parse(String(event.data))));
	await new Promise<void>((resolve, reject) => {
		recovery.addEventListener("open", () => resolve(), { once: true });
		recovery.addEventListener("error", () => reject(new Error("recovery WS error")), { once: true });
	});
	recovery.send(JSON.stringify({ type: "event_replay", id: "prompt-recovery", sinceGeneration: 1, sinceSeq: 0 }));
	await waitFor(
		() => recoveryFrames.some(frame => frame.type === "event_replay_result" && frame.id === "prompt-recovery"),
		"prompt lifecycle recovery",
	);
	const replay = recoveryFrames.find(
		frame => frame.type === "event_replay_result" && frame.id === "prompt-recovery",
	) as {
		events?: Array<{ payload?: Record<string, unknown> }>;
	};
	const replayedLifecycle = replay.events?.filter(
		event =>
			event.payload?.commandId === correlation.commandId &&
			(event.payload?.type === "agent_start" || event.payload?.type === "agent_end"),
	);
	expect(replayedLifecycle).toEqual([
		expect.objectContaining({ payload: { type: "agent_start", sessionId, ...correlation } }),
		expect.objectContaining({
			payload: {
				type: "agent_end",
				sessionId,
				...correlation,
				outcome: { kind: "stopped", reason: "end_turn", provenance: "agent" },
			},
		}),
	]);
	await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, sessionContext);
});

test("SDK host delivers accepted prompt failures after their acknowledgement", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-prompt-terminal-"));
	dirs.push(cwd);
	const sessionId = `sdk-prompt-terminal-${Date.now()}`;
	const handlers = start(context(cwd, sessionId), undefined, () =>
		Promise.reject(Object.assign(new Error("prompt failed after preflight"), { code: "unavailable" })),
	);
	const endpointFile = path.join(cwd, ".gjc", "state", "sdk", `${sessionId}.json`);
	await waitFor(() => fs.existsSync(endpointFile), "SDK endpoint");
	const endpoint = JSON.parse(fs.readFileSync(endpointFile, "utf8")) as { url: string; token: string };
	const frames: Record<string, unknown>[] = [];
	const socket = new WebSocket(`${endpoint.url}/?token=${encodeURIComponent(endpoint.token)}`);
	sockets.push(socket);
	socket.addEventListener("message", event => frames.push(JSON.parse(String(event.data))));
	await new Promise<void>((resolve, reject) => {
		socket.addEventListener("open", () => resolve(), { once: true });
		socket.addEventListener("error", () => reject(new Error("WS error")), { once: true });
	});
	socket.send(
		JSON.stringify({
			type: "control_request",
			id: "prompt-terminal",
			operation: "turn.prompt",
			input: { text: "fail after acknowledgement" },
		}),
	);
	await waitFor(
		() =>
			frames.some(frame => frame.type === "control_response" && frame.id === "prompt-terminal") &&
			frames.some(frame => frame.type === "agent_failed"),
		"accepted prompt terminal failure",
	);
	const acknowledgementIndex = frames.findIndex(
		frame => frame.type === "control_response" && frame.id === "prompt-terminal",
	);
	const failureIndex = frames.findIndex(frame => frame.type === "agent_failed");
	expect(acknowledgementIndex).toBeGreaterThanOrEqual(0);
	expect(failureIndex).toBeGreaterThan(acknowledgementIndex);
	const acknowledgement = frames[acknowledgementIndex] as { result?: { commandId?: unknown; turnId?: unknown } };
	expect(frames[failureIndex]).toMatchObject({
		type: "agent_failed",
		commandId: acknowledgement.result?.commandId,
		turnId: acknowledgement.result?.turnId,
		error: { code: "unavailable", message: "Prompt submission failed." },
	});
	await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, context(cwd, sessionId));
});

test("SDK host terminalizes a cancelled preflight and releases prompt authority", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-prompt-preflight-cancelled-"));
	dirs.push(cwd);
	const sessionId = `sdk-prompt-preflight-cancelled-${Date.now()}`;
	const preflightStarted = Promise.withResolvers<void>();
	const releasePreflight = Promise.withResolvers<void>();
	let aborted = false;
	const abort = () => {
		aborted = true;
	};
	const handlers = start(
		{ ...context(cwd, sessionId), abort },
		undefined,
		async (content, options) => {
			if (content === "cancel during preflight") {
				preflightStarted.resolve();
				await releasePreflight.promise;
				if (aborted) {
					throw Object.assign(new Error("Prompt preflight was cancelled before execution."), { code: "busy" });
				}
			}
			await firePreflightAccept(options);
		},
		true,
	);
	const endpointFile = path.join(cwd, ".gjc", "state", "sdk", `${sessionId}.json`);
	await waitFor(() => fs.existsSync(endpointFile), "SDK endpoint");
	const endpoint = JSON.parse(fs.readFileSync(endpointFile, "utf8")) as { url: string; token: string };
	const frames: Record<string, unknown>[] = [];
	const socket = new WebSocket(`${endpoint.url}/?token=${encodeURIComponent(endpoint.token)}`);
	sockets.push(socket);
	socket.addEventListener("message", event => frames.push(JSON.parse(String(event.data))));
	await new Promise<void>((resolve, reject) => {
		socket.addEventListener("open", () => resolve(), { once: true });
		socket.addEventListener("error", () => reject(new Error("WS error")), { once: true });
	});
	socket.send(
		JSON.stringify({
			type: "control_request",
			id: "cancelled-preflight",
			operation: "turn.prompt",
			input: { text: "cancel during preflight" },
		}),
	);
	await preflightStarted.promise;
	abort();
	releasePreflight.resolve();
	await waitFor(
		() => frames.some(frame => frame.type === "control_response" && frame.id === "cancelled-preflight"),
		"cancelled preflight response",
	);
	expect(frames.find(frame => frame.type === "control_response" && frame.id === "cancelled-preflight")).toMatchObject({
		ok: false,
		error: { code: "busy", message: "Prompt preflight was cancelled before execution." },
	});
	expect(frames.some(frame => frame.type === "agent_failed")).toBe(false);

	socket.send(
		JSON.stringify({
			type: "control_request",
			id: "replacement-prompt",
			operation: "turn.prompt",
			input: { text: "replacement prompt" },
		}),
	);
	await waitFor(
		() => frames.some(frame => frame.type === "control_response" && frame.id === "replacement-prompt"),
		"replacement prompt response",
	);
	expect(frames.find(frame => frame.type === "control_response" && frame.id === "replacement-prompt")).toMatchObject({
		ok: true,
		result: { accepted: true, commandId: expect.any(String), turnId: expect.any(String) },
	});
	await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, context(cwd, sessionId));
});

test("SDK host cancels canonical skill invocation before agent start and fences late acceptance", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-skill-preflight-cancelled-"));
	dirs.push(cwd);
	const sessionId = `sdk-skill-preflight-cancelled-${Date.now()}`;
	const preflightStarted = Promise.withResolvers<void>();
	const releasePreflight = Promise.withResolvers<void>();
	let executionStarted = false;
	const sessionContext = context(cwd, sessionId);
	const baseBindings = sessionContext.sdkBindings as () => string[];
	sessionContext.sdkBindings = () => [...baseBindings(), "invokeSkill"];
	sessionContext.invokeSkill = async (
		name: string,
		args: string | undefined,
		options?: {
			onSkillPrepared?: (meta: { name: string; path: string }) => void;
			onPreflightAcceptCommit?: () => void | Promise<void>;
			preflightSignal?: AbortSignal;
		},
	) => {
		expect(name).toBe("fixture-skill");
		expect(args).toBe("cancel before start");
		preflightStarted.resolve();
		const cancelled = Promise.withResolvers<never>();
		const onAbort = () =>
			cancelled.reject(
				Object.assign(new Error("Skill preflight was cancelled before execution."), { code: "busy" }),
			);
		options?.preflightSignal?.addEventListener("abort", onAbort, { once: true });
		try {
			await Promise.race([releasePreflight.promise, cancelled.promise]);
		} finally {
			options?.preflightSignal?.removeEventListener("abort", onAbort);
		}
		options?.onSkillPrepared?.({ name, path: "/fixture/SKILL.md" });
		await options?.onPreflightAcceptCommit?.();
		if (options?.preflightSignal?.aborted)
			throw Object.assign(new Error("Skill preflight was cancelled before execution."), { code: "busy" });
		executionStarted = true;
		return { name, path: "/fixture/SKILL.md", args };
	};
	const handlers = start(sessionContext);
	const endpointFile = path.join(cwd, ".gjc", "state", "sdk", `${sessionId}.json`);
	await waitFor(() => fs.existsSync(endpointFile), "SDK endpoint");
	const endpoint = JSON.parse(fs.readFileSync(endpointFile, "utf8")) as { url: string; token: string };
	const frames: Record<string, unknown>[] = [];
	const socket = new WebSocket(`${endpoint.url}/?token=${encodeURIComponent(endpoint.token)}`);
	sockets.push(socket);
	socket.addEventListener("message", event => frames.push(JSON.parse(String(event.data))));
	await new Promise<void>((resolve, reject) => {
		socket.addEventListener("open", () => resolve(), { once: true });
		socket.addEventListener("error", () => reject(new Error("WS error")), { once: true });
	});
	socket.send(
		JSON.stringify({
			type: "control_request",
			id: "skill-preflight",
			operation: "skill.invoke",
			input: { name: "fixture-skill", args: "cancel before start" },
		}),
	);
	await preflightStarted.promise;
	socket.send(
		JSON.stringify({
			type: "control_request",
			id: "abort-skill-preflight",
			operation: "turn.abort",
			input: {},
		}),
	);
	await waitFor(
		() =>
			frames.some(frame => frame.type === "control_response" && frame.id === "skill-preflight") &&
			frames.some(frame => frame.type === "control_response" && frame.id === "abort-skill-preflight"),
		"skill preflight cancellation responses",
	);
	expect(frames.find(frame => frame.type === "control_response" && frame.id === "skill-preflight")).toMatchObject({
		ok: false,
		error: { code: "busy", message: "Skill preflight was cancelled before execution." },
	});
	expect(
		frames.find(frame => frame.type === "control_response" && frame.id === "abort-skill-preflight"),
	).toMatchObject({
		ok: true,
		result: { aborted: true, disposition: "preflight_cancelled" },
	});
	releasePreflight.resolve();
	await Promise.resolve();
	await Promise.resolve();
	expect(executionStarted).toBe(false);
	expect(frames.some(frame => frame.type === "agent_start")).toBe(false);
	await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, sessionContext);
});

test("SDK host waits for accepted handleless skill settlement before publishing cancellation", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-skill-accepted-handleless-cancel-"));
	dirs.push(cwd);
	const sessionId = `sdk-skill-accepted-handleless-cancel-${Date.now()}`;
	const acceptedWithoutHandle = Promise.withResolvers<void>();
	const abortObserved = Promise.withResolvers<void>();
	const releaseSettlement = Promise.withResolvers<void>();
	let executionStarted = false;
	const sessionContext = context(cwd, sessionId);
	const baseBindings = sessionContext.sdkBindings as () => string[];
	sessionContext.sdkBindings = () => [...baseBindings(), "invokeSkill"];
	sessionContext.invokeSkill = async (
		name: string,
		args: string | undefined,
		options?: {
			onSkillPrepared?: (meta: { name: string; path: string }) => void;
			onPreflightAcceptCommit?: () => void | Promise<void>;
			preflightSignal?: AbortSignal;
		},
	) => {
		options?.onSkillPrepared?.({ name, path: "/fixture/SKILL.md" });
		await options?.onPreflightAcceptCommit?.();
		acceptedWithoutHandle.resolve();
		options?.preflightSignal?.addEventListener("abort", () => abortObserved.resolve(), { once: true });
		await releaseSettlement.promise;
		if (options?.preflightSignal?.aborted)
			throw Object.assign(new Error("Skill preflight was cancelled before execution."), { code: "busy" });
		executionStarted = true;
		return { name, path: "/fixture/SKILL.md", args };
	};
	const handlers = start(sessionContext);
	const endpointFile = path.join(cwd, ".gjc", "state", "sdk", `${sessionId}.json`);
	await waitFor(() => fs.existsSync(endpointFile), "SDK endpoint");
	const endpoint = JSON.parse(fs.readFileSync(endpointFile, "utf8")) as { url: string; token: string };
	const frames: Record<string, unknown>[] = [];
	const socket = new WebSocket(`${endpoint.url}/?token=${encodeURIComponent(endpoint.token)}`);
	sockets.push(socket);
	socket.addEventListener("message", event => frames.push(JSON.parse(String(event.data))));
	await new Promise<void>((resolve, reject) => {
		socket.addEventListener("open", () => resolve(), { once: true });
		socket.addEventListener("error", () => reject(new Error("WS error")), { once: true });
	});
	socket.send(
		JSON.stringify({
			type: "control_request",
			id: "accepted-handleless-skill",
			operation: "skill.invoke",
			input: { name: "fixture-skill", args: "cancel after acceptance" },
		}),
	);
	await acceptedWithoutHandle.promise;
	await waitFor(
		() => frames.some(frame => frame.type === "control_response" && frame.id === "accepted-handleless-skill"),
		"accepted handleless skill response",
	);
	const acceptedFrame = frames.find(
		frame => frame.type === "control_response" && frame.id === "accepted-handleless-skill",
	) as { result?: { commandId?: string; turnId?: string } } | undefined;
	const acceptedCommandId = acceptedFrame?.result?.commandId;
	const acceptedTurnId = acceptedFrame?.result?.turnId;
	expect(acceptedFrame).toMatchObject({
		ok: true,
		result: { accepted: true, commandId: expect.any(String), turnId: expect.any(String) },
	});

	socket.send(
		JSON.stringify({
			type: "control_request",
			id: "abort-accepted-handleless-skill",
			operation: "turn.abort",
			input: {},
		}),
	);
	await abortObserved.promise;
	await Bun.sleep(20);
	expect(
		frames.some(frame => frame.type === "control_response" && frame.id === "abort-accepted-handleless-skill"),
	).toBe(false);
	expect(
		frames.some(
			frame =>
				(frame.type === "agent_end" || frame.type === "agent_failed") &&
				frame.commandId === acceptedFrame?.result?.commandId &&
				frame.turnId === acceptedFrame?.result?.turnId,
		),
	).toBe(false);

	releaseSettlement.resolve();
	await waitFor(
		() => frames.some(frame => frame.type === "control_response" && frame.id === "abort-accepted-handleless-skill"),
		"accepted handleless cancellation response",
	);
	await waitFor(
		() =>
			frames.some(
				frame =>
					frame.type === "agent_end" && frame.commandId === acceptedCommandId && frame.turnId === acceptedTurnId,
			),
		"accepted handleless cancellation terminal",
	);
	expect(
		frames.find(frame => frame.type === "control_response" && frame.id === "abort-accepted-handleless-skill"),
	).toMatchObject({
		ok: true,
		result: { aborted: true, disposition: "cancelled" },
	});
	expect(
		frames.find(
			frame =>
				frame.type === "agent_end" && frame.commandId === acceptedCommandId && frame.turnId === acceptedTurnId,
		),
	).toMatchObject({
		outcome: { kind: "stopped", reason: "cancelled", provenance: "client_cancel" },
	});
	expect(executionStarted).toBe(false);
	await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, sessionContext);
});
test("SDK host waits for durable prompt acceptance before completing concurrent cancellation", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-prompt-durable-accept-cancel-"));
	dirs.push(cwd);
	const sessionId = `sdk-prompt-durable-accept-cancel-${Date.now()}`;
	const sessionFile = path.join(cwd, "session.jsonl");
	const sessionContext = context(cwd, sessionId);
	const sessionManager = sessionContext.sessionManager as Record<string, unknown>;
	sessionContext.sessionManager = {
		...sessionManager,
		getSessionFile: () => sessionFile,
	};
	let executionStarted = false;
	const abortObserved = Promise.withResolvers<void>();
	const handlers = start(
		sessionContext,
		undefined,
		async (_content, options) => {
			const signal = options?.preflightSignal;
			const onAbort = () => abortObserved.resolve();
			if (signal?.aborted) onAbort();
			else signal?.addEventListener("abort", onAbort, { once: true });
			try {
				await options?.onPreflightAcceptCommit?.();
			} finally {
				signal?.removeEventListener("abort", onAbort);
			}
			if (signal?.aborted)
				throw Object.assign(new Error("Prompt preflight was cancelled before execution."), { code: "busy" });
			executionStarted = true;
		},
		true,
		new Map(),
		undefined,
		false,
	);
	await handlers.get("session_start")?.({ type: "session_start" }, sessionContext);
	const pausedCommit = pauseNextReconciliationCommit(sessionFile, sessionId);
	try {
		const endpointFile = path.join(cwd, ".gjc", "state", "sdk", `${sessionId}.json`);
		await waitFor(() => fs.existsSync(endpointFile), "SDK endpoint");
		const endpoint = JSON.parse(fs.readFileSync(endpointFile, "utf8")) as { url: string; token: string };
		const frames: Record<string, unknown>[] = [];
		const socket = new WebSocket(`${endpoint.url}/?token=${encodeURIComponent(endpoint.token)}`);
		sockets.push(socket);
		socket.addEventListener("message", event => frames.push(JSON.parse(String(event.data))));
		await new Promise<void>((resolve, reject) => {
			socket.addEventListener("open", () => resolve(), { once: true });
			socket.addEventListener("error", () => reject(new Error("WS error")), { once: true });
		});

		pausedCommit.arm();
		socket.send(
			JSON.stringify({
				type: "control_request",
				id: "durable-prompt-acceptance",
				operation: "turn.prompt",
				input: { text: "cancel while durable prompt acceptance is pending" },
			}),
		);
		await pausedCommit.started;
		socket.send(
			JSON.stringify({
				type: "control_request",
				id: "abort-durable-prompt-acceptance",
				operation: "turn.abort",
				input: {},
			}),
		);
		await abortObserved.promise;
		expect(frames.some(frame => frame.type === "control_response" && frame.id === "durable-prompt-acceptance")).toBe(
			false,
		);
		expect(
			frames.some(frame => frame.type === "control_response" && frame.id === "abort-durable-prompt-acceptance"),
		).toBe(false);
		expect(frames.some(frame => frame.type === "agent_end" || frame.type === "agent_failed")).toBe(false);

		pausedCommit.release();
		await waitFor(
			() => frames.some(frame => frame.type === "control_response" && frame.id === "durable-prompt-acceptance"),
			"durable prompt acceptance response",
		);
		await waitFor(
			() =>
				frames.some(frame => frame.type === "control_response" && frame.id === "abort-durable-prompt-acceptance"),
			"durable prompt abort response",
		);
		await waitFor(
			() =>
				frames.some(
					frame =>
						frame.type === "agent_end" &&
						typeof frame.commandId === "string" &&
						typeof frame.turnId === "string" &&
						(frame.outcome as { kind?: unknown; reason?: unknown } | undefined)?.kind === "stopped" &&
						(frame.outcome as { kind?: unknown; reason?: unknown } | undefined)?.reason === "cancelled",
				),
			"durable prompt cancellation terminal",
		);
		expect(
			frames.find(frame => frame.type === "control_response" && frame.id === "durable-prompt-acceptance"),
		).toMatchObject({
			ok: true,
			result: { accepted: true, commandId: expect.any(String), turnId: expect.any(String) },
		});
		expect(
			frames.find(frame => frame.type === "control_response" && frame.id === "abort-durable-prompt-acceptance"),
		).toMatchObject({
			ok: true,
			result: { aborted: true, disposition: "preflight_cancelled" },
		});
		expect(executionStarted).toBe(false);
		expect(frames.some(frame => frame.type === "agent_start" || frame.type === "agent_failed")).toBe(false);
	} finally {
		pausedCommit.release();
		pausedCommit.restore();
		await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, sessionContext);
	}
}, 30_000);

test("SDK host waits for durable skill acceptance before completing concurrent cancellation", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-skill-durable-accept-cancel-"));
	dirs.push(cwd);
	const sessionId = `sdk-skill-durable-accept-cancel-${Date.now()}`;
	const sessionFile = path.join(cwd, "session.jsonl");
	const sessionContext = context(cwd, sessionId);
	const sessionManager = sessionContext.sessionManager as Record<string, unknown>;
	sessionContext.sessionManager = {
		...sessionManager,
		getSessionFile: () => sessionFile,
	};
	const baseBindings = sessionContext.sdkBindings as () => string[];
	sessionContext.sdkBindings = () => [...baseBindings(), "invokeSkill"];
	let executionStarted = false;
	const abortObserved = Promise.withResolvers<void>();
	sessionContext.invokeSkill = async (
		name: string,
		args: string | undefined,
		options?: {
			onSkillPrepared?: (meta: { name: string; path: string; cleanedArgs?: string }) => void;
			onPreflightAcceptCommit?: () => void | Promise<void>;
			preflightSignal?: AbortSignal;
		},
	) => {
		options?.onSkillPrepared?.({ name, path: "/fixture/SKILL.md", cleanedArgs: args });
		const signal = options?.preflightSignal;
		const onAbort = () => abortObserved.resolve();
		if (signal?.aborted) onAbort();
		else signal?.addEventListener("abort", onAbort, { once: true });
		try {
			await options?.onPreflightAcceptCommit?.();
		} finally {
			signal?.removeEventListener("abort", onAbort);
		}
		if (signal?.aborted)
			throw Object.assign(new Error("Skill preflight was cancelled before execution."), { code: "busy" });
		executionStarted = true;
		return { name, path: "/fixture/SKILL.md", args };
	};
	const handlers = start(sessionContext, undefined, () => {}, false, new Map(), undefined, false);
	await handlers.get("session_start")?.({ type: "session_start" }, sessionContext);
	const pausedCommit = pauseNextReconciliationCommit(sessionFile, sessionId);
	try {
		const endpointFile = path.join(cwd, ".gjc", "state", "sdk", `${sessionId}.json`);
		await waitFor(() => fs.existsSync(endpointFile), "SDK endpoint");
		const endpoint = JSON.parse(fs.readFileSync(endpointFile, "utf8")) as { url: string; token: string };
		const frames: Record<string, unknown>[] = [];
		const socket = new WebSocket(`${endpoint.url}/?token=${encodeURIComponent(endpoint.token)}`);
		sockets.push(socket);
		socket.addEventListener("message", event => frames.push(JSON.parse(String(event.data))));
		await new Promise<void>((resolve, reject) => {
			socket.addEventListener("open", () => resolve(), { once: true });
			socket.addEventListener("error", () => reject(new Error("WS error")), { once: true });
		});

		pausedCommit.arm();
		socket.send(
			JSON.stringify({
				type: "control_request",
				id: "durable-skill-acceptance",
				operation: "skill.invoke",
				input: { name: "fixture-skill", args: "cancel while durable skill acceptance is pending" },
			}),
		);
		await pausedCommit.started;
		socket.send(
			JSON.stringify({
				type: "control_request",
				id: "abort-durable-skill-acceptance",
				operation: "turn.abort",
				input: {},
			}),
		);
		await abortObserved.promise;
		expect(frames.some(frame => frame.type === "control_response" && frame.id === "durable-skill-acceptance")).toBe(
			false,
		);
		expect(
			frames.some(frame => frame.type === "control_response" && frame.id === "abort-durable-skill-acceptance"),
		).toBe(false);
		expect(frames.some(frame => frame.type === "agent_end" || frame.type === "agent_failed")).toBe(false);

		pausedCommit.release();
		await waitFor(
			() => frames.some(frame => frame.type === "control_response" && frame.id === "durable-skill-acceptance"),
			"durable skill acceptance response",
		);
		await waitFor(
			() => frames.some(frame => frame.type === "control_response" && frame.id === "abort-durable-skill-acceptance"),
			"durable skill abort response",
		);
		await waitFor(
			() =>
				frames.some(
					frame =>
						frame.type === "agent_end" &&
						typeof frame.commandId === "string" &&
						typeof frame.turnId === "string" &&
						(frame.outcome as { kind?: unknown; reason?: unknown } | undefined)?.kind === "stopped" &&
						(frame.outcome as { kind?: unknown; reason?: unknown } | undefined)?.reason === "cancelled",
				),
			"durable skill cancellation terminal",
		);
		expect(
			frames.find(frame => frame.type === "control_response" && frame.id === "durable-skill-acceptance"),
		).toMatchObject({
			ok: true,
			result: { accepted: true, commandId: expect.any(String), turnId: expect.any(String) },
		});
		expect(
			frames.find(frame => frame.type === "control_response" && frame.id === "abort-durable-skill-acceptance"),
		).toMatchObject({
			ok: true,
			result: { aborted: true, disposition: "preflight_cancelled" },
		});
		expect(executionStarted).toBe(false);
		expect(frames.some(frame => frame.type === "agent_start" || frame.type === "agent_failed")).toBe(false);
	} finally {
		pausedCommit.release();
		pausedCommit.restore();
		await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, sessionContext);
	}
}, 60_000);

test("SDK host rolls back canonical skill ownership when durable acceptance fails", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-skill-acceptance-failed-"));
	dirs.push(cwd);
	const sessionId = `sdk-skill-acceptance-failed-${Date.now()}`;
	const sessionFile = path.join(cwd, "session.jsonl");
	const sessionContext = context(cwd, sessionId);
	const sessionManager = sessionContext.sessionManager as Record<string, unknown>;
	sessionContext.sessionManager = {
		...sessionManager,
		getSessionFile: () => sessionFile,
	};
	const baseBindings = sessionContext.sdkBindings as () => string[];
	sessionContext.sdkBindings = () => [...baseBindings(), "invokeSkill"];
	let executionCount = 0;
	sessionContext.invokeSkill = async (
		name: string,
		args: string | undefined,
		options?: {
			onSkillPrepared?: (meta: { name: string; path: string; cleanedArgs?: string }) => void;
			onPreflightAcceptCommit?: () => void | Promise<void>;
		},
	) => {
		options?.onSkillPrepared?.({ name, path: "/fixture/SKILL.md", cleanedArgs: args });
		await options?.onPreflightAcceptCommit?.();
		executionCount++;
		return { name, path: "/fixture/SKILL.md", args };
	};
	const storeDirectory = path.dirname(reconciliationStorePath(sessionFile, sessionId));
	fs.rmSync(storeDirectory, { recursive: true, force: true });
	fs.writeFileSync(storeDirectory, "block reconciliation persistence");
	const handlers = start(sessionContext, undefined, () => {}, false, new Map(), undefined, false);
	await handlers.get("session_start")?.({ type: "session_start" }, sessionContext);
	const endpointFile = path.join(cwd, ".gjc", "state", "sdk", `${sessionId}.json`);
	await waitFor(() => fs.existsSync(endpointFile), "SDK endpoint");

	const endpoint = JSON.parse(fs.readFileSync(endpointFile, "utf8")) as { url: string; token: string };
	const frames: Record<string, unknown>[] = [];
	const socket = new WebSocket(`${endpoint.url}/?token=${encodeURIComponent(endpoint.token)}`);
	sockets.push(socket);
	socket.addEventListener("message", event => frames.push(JSON.parse(String(event.data))));
	await new Promise<void>((resolve, reject) => {
		socket.addEventListener("open", () => resolve(), { once: true });
		socket.addEventListener("error", () => reject(new Error("WS error")), { once: true });
	});

	const clientRef = "skill-acceptance-failure-ref";
	socket.send(
		JSON.stringify({
			type: "control_request",
			id: "skill-acceptance-failed",
			operation: "skill.invoke",
			input: { name: "fixture-skill", args: "persist", clientRef },
		}),
	);
	await waitFor(
		() => frames.some(frame => frame.type === "control_response" && frame.id === "skill-acceptance-failed"),
		"failed skill acceptance response",
	);
	expect(
		frames.find(frame => frame.type === "control_response" && frame.id === "skill-acceptance-failed"),
	).toMatchObject({
		ok: false,
		error: {
			code: "unavailable",
			message: "Skill reconciliation state is unavailable; retry after restart.",
		},
	});
	expect(executionCount).toBe(0);
	expect(frames.some(frame => frame.type === "agent_start")).toBe(false);

	fs.unlinkSync(storeDirectory);
	socket.send(
		JSON.stringify({
			type: "control_request",
			id: "skill-acceptance-retry",
			operation: "skill.invoke",
			input: { name: "fixture-skill", args: "retry", clientRef },
		}),
	);
	await waitFor(
		() => frames.some(frame => frame.type === "control_response" && frame.id === "skill-acceptance-retry"),
		"retried skill acceptance response",
	);
	expect(
		frames.find(frame => frame.type === "control_response" && frame.id === "skill-acceptance-retry"),
	).toMatchObject({
		ok: true,
		result: {
			accepted: true,
			name: "fixture-skill",
			args: "retry",
			clientRef,
		},
	});
	expect(executionCount).toBe(1);
	await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, sessionContext);
});
test("session_shutdown awaits a late reconciliation publication before teardown can remove it", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-skill-late-publication-"));
	dirs.push(cwd);
	const sessionId = `sdk-skill-late-publication-${Date.now()}`;
	const sessionFile = path.join(cwd, "session.jsonl");
	const sessionContext = context(cwd, sessionId);
	const sessionManager = sessionContext.sessionManager as Record<string, unknown>;
	sessionContext.sessionManager = {
		...sessionManager,
		getSessionFile: () => sessionFile,
	};
	const baseBindings = sessionContext.sdkBindings as () => string[];
	sessionContext.sdkBindings = () => [...baseBindings(), "invokeSkill"];
	// Hold the skill run open after its durable acceptance: the harness controls
	// exactly when the fire-and-forget agent_end reconciliation publication is
	// enqueued, so the paused rename below is provably that late publication.
	const resumeExecution = Promise.withResolvers<void>();
	let executionCount = 0;
	sessionContext.invokeSkill = async (
		_name: string,
		args: string | undefined,
		options?: {
			onSkillPrepared?: (meta: { name: string; path: string; cleanedArgs?: string }) => void;
			onPreflightAcceptCommit?: () => void | Promise<void>;
		},
	) => {
		options?.onSkillPrepared?.({ name: "fixture-skill", path: "/fixture/SKILL.md", cleanedArgs: args });
		await options?.onPreflightAcceptCommit?.();
		await resumeExecution.promise;
		executionCount++;
		return { name: "fixture-skill", path: "/fixture/SKILL.md", args };
	};
	const storePath = reconciliationStorePath(sessionFile, sessionId);
	const pausedCommit = pauseNextReconciliationCommit(sessionFile, sessionId);
	const handlers = start(sessionContext, undefined, () => {}, false, new Map(), undefined, false);
	await handlers.get("session_start")?.({ type: "session_start" }, sessionContext);
	const endpointFile = path.join(cwd, ".gjc", "state", "sdk", `${sessionId}.json`);
	await waitFor(() => fs.existsSync(endpointFile), "SDK endpoint");
	const endpoint = JSON.parse(fs.readFileSync(endpointFile, "utf8")) as { url: string; token: string };
	const frames: Record<string, unknown>[] = [];
	const socket = new WebSocket(`${endpoint.url}/?token=${encodeURIComponent(endpoint.token)}`);
	sockets.push(socket);
	socket.addEventListener("message", event => frames.push(JSON.parse(String(event.data))));
	await new Promise<void>((resolve, reject) => {
		socket.addEventListener("open", () => resolve(), { once: true });
		socket.addEventListener("error", () => reject(new Error("WS error")), { once: true });
	});
	socket.send(
		JSON.stringify({
			type: "control_request",
			id: "skill-late-publication",
			operation: "skill.invoke",
			input: { name: "fixture-skill", args: "hold", clientRef: "skill-late-publication-ref" },
		}),
	);
	await waitFor(
		() => frames.some(frame => frame.type === "control_response" && frame.id === "skill-late-publication"),
		"accepted skill response",
	);
	expect(
		frames.find(frame => frame.type === "control_response" && frame.id === "skill-late-publication"),
	).toMatchObject({ ok: true, result: { accepted: true } });
	// The acceptance publication has settled; the next commit to this store file
	// is the late fire-and-forget agent_end transition. Arm the pause, then let
	// the run resolve so that publication starts and is held mid-rename.
	pausedCommit.arm();
	resumeExecution.resolve();
	await pausedCommit.started;
	// Teardown must not report the session stopped while a durable publication it
	// admitted is still between its temp write and atomic rename: an external
	// cleanup owner removing the state tree at that instant fails the rename with
	// ENOENT (#4743).
	let shutdownSettled = false;
	const shutdown = Promise.resolve(
		handlers.get("session_shutdown")?.({ type: "session_shutdown" }, sessionContext),
	).then(
		() => {
			shutdownSettled = true;
		},
		() => {
			shutdownSettled = true;
		},
	);
	await Bun.sleep(300);
	expect(shutdownSettled).toBe(false);
	pausedCommit.release();
	await shutdown;
	expect(shutdownSettled).toBe(true);
	expect(executionCount).toBe(1);
	const persisted = JSON.parse(fs.readFileSync(storePath, "utf8")) as {
		records: Array<{ kind: string; status?: string }>;
	};
	expect(persisted.records.some(record => record.kind === "skill")).toBe(true);
	pausedCommit.restore();
}, 60_000);
test("session_shutdown joins a still-executing skill before teardown can race its publication (#4743)", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-skill-teardown-join-"));
	dirs.push(cwd);
	const sessionId = `sdk-skill-teardown-join-${Date.now()}`;
	const sessionFile = path.join(cwd, "session.jsonl");
	const sessionContext = context(cwd, sessionId);
	const sessionManager = sessionContext.sessionManager as Record<string, unknown>;
	sessionContext.sessionManager = {
		...sessionManager,
		getSessionFile: () => sessionFile,
	};
	const baseBindings = sessionContext.sdkBindings as () => string[];
	sessionContext.sdkBindings = () => [...baseBindings(), "invokeSkill"];
	// The skill is ACCEPTED and still executing when shutdown begins; nothing has
	// been resolved yet, so an empty-queue drain would return immediately and the
	// late agent_end publication would race teardown (#4743 major 1).
	const resumeExecution = Promise.withResolvers<void>();
	sessionContext.invokeSkill = async (
		_name: string,
		args: string | undefined,
		options?: {
			onSkillPrepared?: (meta: { name: string; path: string; cleanedArgs?: string }) => void;
			onPreflightAcceptCommit?: () => void | Promise<void>;
		},
	) => {
		options?.onSkillPrepared?.({ name: "fixture-skill", path: "/fixture/SKILL.md", cleanedArgs: args });
		await options?.onPreflightAcceptCommit?.();
		await resumeExecution.promise;
		return { name: "fixture-skill", path: "/fixture/SKILL.md", args };
	};
	const storePath = reconciliationStorePath(sessionFile, sessionId);
	const handlers = start(sessionContext, undefined, () => {}, false, new Map(), undefined, false);
	await handlers.get("session_start")?.({ type: "session_start" }, sessionContext);
	const endpointFile = path.join(cwd, ".gjc", "state", "sdk", `${sessionId}.json`);
	await waitFor(() => fs.existsSync(endpointFile), "SDK endpoint");
	const endpoint = JSON.parse(fs.readFileSync(endpointFile, "utf8")) as { url: string; token: string };
	const frames: Record<string, unknown>[] = [];
	const socket = new WebSocket(`${endpoint.url}/?token=${encodeURIComponent(endpoint.token)}`);
	sockets.push(socket);
	socket.addEventListener("message", event => frames.push(JSON.parse(String(event.data))));
	await new Promise<void>((resolve, reject) => {
		socket.addEventListener("open", () => resolve(), { once: true });
		socket.addEventListener("error", () => reject(new Error("WS error")), { once: true });
	});
	socket.send(
		JSON.stringify({
			type: "control_request",
			id: "skill-teardown-join",
			operation: "skill.invoke",
			input: { name: "fixture-skill", args: "hold", clientRef: "skill-teardown-join-ref" },
		}),
	);
	await waitFor(
		() => frames.some(frame => frame.type === "control_response" && frame.id === "skill-teardown-join"),
		"accepted skill response",
	);
	expect(frames.find(frame => frame.type === "control_response" && frame.id === "skill-teardown-join")).toMatchObject({
		ok: true,
		result: { accepted: true },
	});
	// Shutdown begins while the execution is still pending: it must NOT settle
	// before the skill (and its terminal publication) settles.
	let shutdownSettled = false;
	const shutdown = Promise.resolve(
		handlers.get("session_shutdown")?.({ type: "session_shutdown" }, sessionContext),
	).finally(() => {
		shutdownSettled = true;
	});
	await Bun.sleep(500);
	expect(shutdownSettled).toBe(false);
	resumeExecution.resolve();
	await shutdown;
	expect(shutdownSettled).toBe(true);
	// The terminal publication won the race: the durable document carries the
	// skill record, and teardown never removed the publication's destination.
	const persisted = JSON.parse(fs.readFileSync(storePath, "utf8")) as {
		records: Array<{ kind: string; status?: string }>;
	};
	expect(persisted.records.some(record => record.kind === "skill")).toBe(true);
}, 60_000);
test("session_shutdown bounds a hung reconciliation publication and reports the drain timeout (#4743)", async () => {
	process.env.GJC_SDK_RECONCILIATION_DRAIN_TIMEOUT_MS = "250";
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-drain-deadline-"));
	dirs.push(cwd);
	const sessionId = `sdk-drain-deadline-${Date.now()}`;
	const sessionFile = path.join(cwd, "session.jsonl");
	const sessionContext = context(cwd, sessionId);
	const sessionManager = sessionContext.sessionManager as Record<string, unknown>;
	sessionContext.sessionManager = {
		...sessionManager,
		getSessionFile: () => sessionFile,
	};
	const baseBindings = sessionContext.sdkBindings as () => string[];
	sessionContext.sdkBindings = () => [...baseBindings(), "invokeSkill"];
	const resumeExecution = Promise.withResolvers<void>();
	sessionContext.invokeSkill = async (
		_name: string,
		args: string | undefined,
		options?: {
			onSkillPrepared?: (meta: { name: string; path: string; cleanedArgs?: string }) => void;
			onPreflightAcceptCommit?: () => void | Promise<void>;
		},
	) => {
		options?.onSkillPrepared?.({ name: "fixture-skill", path: "/fixture/SKILL.md", cleanedArgs: args });
		await options?.onPreflightAcceptCommit?.();
		await resumeExecution.promise;
		return { name: "fixture-skill", path: "/fixture/SKILL.md", args };
	};
	// Hold the terminal publication's rename FOREVER: an unbounded drain would
	// hang session_shutdown indefinitely (#4743 major 2).
	const pausedCommit = pauseNextReconciliationCommit(sessionFile, sessionId);
	const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
	try {
		const handlers = start(sessionContext, undefined, () => {}, false, new Map(), undefined, false);
		await handlers.get("session_start")?.({ type: "session_start" }, sessionContext);
		const endpointFile = path.join(cwd, ".gjc", "state", "sdk", `${sessionId}.json`);
		await waitFor(() => fs.existsSync(endpointFile), "SDK endpoint");
		const endpoint = JSON.parse(fs.readFileSync(endpointFile, "utf8")) as { url: string; token: string };
		const frames: Record<string, unknown>[] = [];
		const socket = new WebSocket(`${endpoint.url}/?token=${encodeURIComponent(endpoint.token)}`);
		sockets.push(socket);
		socket.addEventListener("message", event => frames.push(JSON.parse(String(event.data))));
		await new Promise<void>((resolve, reject) => {
			socket.addEventListener("open", () => resolve(), { once: true });
			socket.addEventListener("error", () => reject(new Error("WS error")), { once: true });
		});
		socket.send(
			JSON.stringify({
				type: "control_request",
				id: "skill-drain-deadline",
				operation: "skill.invoke",
				input: { name: "fixture-skill", args: "hold", clientRef: "skill-drain-deadline-ref" },
			}),
		);
		await waitFor(
			() => frames.some(frame => frame.type === "control_response" && frame.id === "skill-drain-deadline"),
			"accepted skill response",
		);
		// The publication is armed and held mid-rename; shutdown begins with the
		// rename still never released.
		pausedCommit.arm();
		resumeExecution.resolve();
		await pausedCommit.started;
		const shutdownStarted = Date.now();
		// The deadline expiry is CALLER-VISIBLE, not merely logged: teardown rejects
		// with the coded reconciliation failure so the lifecycle owner is never told
		// the session shut down cleanly over a non-quiescent store (#4743).
		const shutdownFailure = await Promise.resolve(
			handlers.get("session_shutdown")?.({ type: "session_shutdown" }, sessionContext),
		).then(
			() => undefined,
			(error: unknown) => error,
		);
		const elapsed = Date.now() - shutdownStarted;
		// Bounded: the 250ms deadline (not an infinite hang) released teardown.
		expect(elapsed).toBeLessThan(5_000);
		expect((shutdownFailure as { code?: string } | undefined)?.code).toBe("sdk_reconciliation_teardown_failed");
		expect(
			((shutdownFailure as { failures?: unknown[] } | undefined)?.failures ?? []).map(
				failure => (failure as { code?: string }).code,
			),
		).toContain("reconciliation_drain_timeout");
		// Observable: the expiry surfaced as a drain-timeout warning rather than a
		// silent pretend-drain.
		expect(warnSpy.mock.calls.some(call => String(call[0]).includes("reconciliation drain timed out"))).toBe(true);
	} finally {
		warnSpy.mockRestore();
		pausedCommit.release();
		pausedCommit.restore();
		delete process.env.GJC_SDK_RECONCILIATION_DRAIN_TIMEOUT_MS;
	}
}, 60_000);

test("session_shutdown propagates a rejected reconciliation publication without an unhandled rejection (#4743)", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-drain-publish-failure-"));
	dirs.push(cwd);
	const sessionId = `sdk-drain-publish-failure-${Date.now()}`;
	const sessionFile = path.join(cwd, "session.jsonl");
	const sessionContext = context(cwd, sessionId);
	const sessionManager = sessionContext.sessionManager as Record<string, unknown>;
	sessionContext.sessionManager = { ...sessionManager, getSessionFile: () => sessionFile };
	const baseBindings = sessionContext.sdkBindings as () => string[];
	sessionContext.sdkBindings = () => [...baseBindings(), "invokeSkill"];
	const resumeExecution = Promise.withResolvers<void>();
	sessionContext.invokeSkill = async (
		_name: string,
		args: string | undefined,
		options?: {
			onSkillPrepared?: (meta: { name: string; path: string; cleanedArgs?: string }) => void;
			onPreflightAcceptCommit?: () => void | Promise<void>;
		},
	) => {
		options?.onSkillPrepared?.({ name: "fixture-skill", path: "/fixture/SKILL.md", cleanedArgs: args });
		await options?.onPreflightAcceptCommit?.();
		await resumeExecution.promise;
		return { name: "fixture-skill", path: "/fixture/SKILL.md", args };
	};
	const failedCommit = failNextReconciliationCommit(sessionFile, sessionId);
	const unhandled = captureUnhandledRejections();
	const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
	const errorSpy = spyOn(logger, "error").mockImplementation(() => {});
	try {
		const handlers = start(sessionContext, undefined, () => {}, false, new Map(), undefined, false);
		await handlers.get("session_start")?.({ type: "session_start" }, sessionContext);
		const endpointFile = path.join(cwd, ".gjc", "state", "sdk", `${sessionId}.json`);
		await waitFor(() => fs.existsSync(endpointFile), "SDK endpoint");
		const endpoint = JSON.parse(fs.readFileSync(endpointFile, "utf8")) as { url: string; token: string };
		const frames: Record<string, unknown>[] = [];
		const socket = new WebSocket(`${endpoint.url}/?token=${encodeURIComponent(endpoint.token)}`);
		sockets.push(socket);
		socket.addEventListener("message", event => frames.push(JSON.parse(String(event.data))));
		await new Promise<void>((resolve, reject) => {
			socket.addEventListener("open", () => resolve(), { once: true });
			socket.addEventListener("error", () => reject(new Error("WS error")), { once: true });
		});
		socket.send(
			JSON.stringify({
				type: "control_request",
				id: "skill-publish-failure",
				operation: "skill.invoke",
				input: { name: "fixture-skill", args: "hold", clientRef: "skill-publish-failure-ref" },
			}),
		);
		await waitFor(
			() => frames.some(frame => frame.type === "control_response" && frame.id === "skill-publish-failure"),
			"accepted skill response",
		);
		// The acceptance write has committed; the NEXT commit is the terminal
		// agent_end publication, and it is made to fail at its atomic rename.
		failedCommit.arm();
		resumeExecution.resolve();
		await failedCommit.failed;
		const shutdownFailure = await Promise.resolve(
			handlers.get("session_shutdown")?.({ type: "session_shutdown" }, sessionContext),
		).then(
			() => undefined,
			(error: unknown) => error,
		);
		// A committed publication that never reached disk is state loss: teardown
		// must report it instead of resolving as cleanly drained.
		expect((shutdownFailure as { code?: string } | undefined)?.code).toBe("sdk_reconciliation_teardown_failed");
		expect(
			((shutdownFailure as { failures?: unknown[] } | undefined)?.failures ?? []).map(
				failure => (failure as { code?: string }).code,
			),
		).toContain("reconciliation_persist_failed");
		// The producer rejection is reported exactly once even though the store's
		// failure window observes the same coded error.
		expect(
			((shutdownFailure as { failures?: unknown[] } | undefined)?.failures ?? []).filter(
				failure => (failure as { code?: string }).code === "reconciliation_persist_failed",
			),
		).toHaveLength(1);
		// The tracking handler must not leave a derived rejected promise behind: an
		// unhandled rejection is process-killing in this repo.
		await Bun.sleep(50);
		expect(unhandled.seen).toEqual([]);
	} finally {
		errorSpy.mockRestore();
		warnSpy.mockRestore();
		unhandled.restore();
		failedCommit.restore();
	}
}, 60_000);
test("a recovered reconciliation publication lets a later teardown drain report success (#4743)", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-drain-recovery-"));
	dirs.push(cwd);
	const sessionId = `sdk-drain-recovery-${Date.now()}`;
	const sessionFile = path.join(cwd, "session.jsonl");
	const sessionContext = context(cwd, sessionId);
	const sessionManager = sessionContext.sessionManager as Record<string, unknown>;
	sessionContext.sessionManager = { ...sessionManager, getSessionFile: () => sessionFile };
	const baseBindings = sessionContext.sdkBindings as () => string[];
	sessionContext.sdkBindings = () => [...baseBindings(), "invokeSkill"];
	const resumeFirst = Promise.withResolvers<void>();
	let invocations = 0;
	sessionContext.invokeSkill = async (
		_name: string,
		args: string | undefined,
		options?: {
			onSkillPrepared?: (meta: { name: string; path: string; cleanedArgs?: string }) => void;
			onPreflightAcceptCommit?: () => void | Promise<void>;
		},
	) => {
		invocations++;
		options?.onSkillPrepared?.({ name: "fixture-skill", path: "/fixture/SKILL.md", cleanedArgs: args });
		await options?.onPreflightAcceptCommit?.();
		if (invocations === 1) await resumeFirst.promise;
		return { name: "fixture-skill", path: "/fixture/SKILL.md", args };
	};
	const failedCommit = failNextReconciliationCommit(sessionFile, sessionId);
	const unhandled = captureUnhandledRejections();
	const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
	const errorSpy = spyOn(logger, "error").mockImplementation(() => {});
	try {
		const handlers = start(sessionContext, undefined, () => {}, false, new Map(), undefined, false);
		await handlers.get("session_start")?.({ type: "session_start" }, sessionContext);
		const endpointFile = path.join(cwd, ".gjc", "state", "sdk", `${sessionId}.json`);
		await waitFor(() => fs.existsSync(endpointFile), "SDK endpoint");
		const endpoint = JSON.parse(fs.readFileSync(endpointFile, "utf8")) as { url: string; token: string };
		const frames: Record<string, unknown>[] = [];
		const socket = new WebSocket(`${endpoint.url}/?token=${encodeURIComponent(endpoint.token)}`);
		sockets.push(socket);
		socket.addEventListener("message", event => frames.push(JSON.parse(String(event.data))));
		await new Promise<void>((resolve, reject) => {
			socket.addEventListener("open", () => resolve(), { once: true });
			socket.addEventListener("error", () => reject(new Error("WS error")), { once: true });
		});
		socket.send(
			JSON.stringify({
				type: "control_request",
				id: "skill-recovery-first",
				operation: "skill.invoke",
				input: { name: "fixture-skill", args: "first", clientRef: "skill-recovery-first-ref" },
			}),
		);
		await waitFor(
			() => frames.some(frame => frame.type === "control_response" && frame.id === "skill-recovery-first"),
			"first accepted skill response",
		);
		failedCommit.arm();
		resumeFirst.resolve();
		await failedCommit.failed;
		// The failure window closes with the failing publication; the store is
		// writable again, so a subsequent publication persists and the teardown
		// drain reports quiescence rather than staying poisoned by the past failure.
		socket.send(
			JSON.stringify({
				type: "control_request",
				id: "skill-recovery-second",
				operation: "skill.invoke",
				input: { name: "fixture-skill", args: "second", clientRef: "skill-recovery-second-ref" },
			}),
		);
		await waitFor(
			() => frames.some(frame => frame.type === "control_response" && frame.id === "skill-recovery-second"),
			"second accepted skill response",
		);
		// The first teardown still reports the earlier lost write: a publication that
		// never reached disk is state loss even though a later one succeeded, and
		// evidence is retained until an owner is actually told about it.
		const firstShutdown = await Promise.resolve(
			handlers.get("session_shutdown")?.({ type: "session_shutdown" }, sessionContext),
		).then(
			() => undefined,
			(error: unknown) => error,
		);
		expect((firstShutdown as { code?: string } | undefined)?.code).toBe("sdk_reconciliation_teardown_failed");
		// Recovery: the store kept working after the failure, so the later
		// publication is durably on disk.
		const persisted = JSON.parse(fs.readFileSync(reconciliationStorePath(sessionFile, sessionId), "utf8")) as {
			records: Array<{ kind: string; clientRef?: string; status?: string }>;
		};
		expect(
			persisted.records.some(
				record => record.clientRef === "skill-recovery-second-ref" && record.status === "terminal_ok",
			),
		).toBe(true);
		// The retained-runtime retry drains clean: reported evidence is not replayed,
		// so teardown converges instead of failing forever.
		await expect(
			Promise.resolve(handlers.get("session_shutdown")?.({ type: "session_shutdown" }, sessionContext)),
		).resolves.toBeUndefined();
		await Bun.sleep(50);
		expect(unhandled.seen).toEqual([]);
	} finally {
		errorSpy.mockRestore();
		warnSpy.mockRestore();
		unhandled.restore();
		failedCommit.restore();
	}
}, 60_000);
test("SDK host terminalizes a never-resolving preflight on abort and fences late acceptance", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-prompt-preflight-never-"));
	dirs.push(cwd);
	const sessionId = `sdk-prompt-preflight-never-${Date.now()}`;
	const preflightStarted = Promise.withResolvers<void>();
	const neverPreflight = Promise.withResolvers<void>();
	let latePreflightAccepted: (() => void) | undefined;
	const handlers = start(
		{ ...context(cwd, sessionId), abort: () => {} },
		undefined,
		async (content, options) => {
			if (content !== "never resolve") return;
			latePreflightAccepted = options?.onPreflightAcceptCommit
				? () => void options.onPreflightAcceptCommit?.()
				: options?.onPreflightAccepted;
			preflightStarted.resolve();
			const cancelled = Promise.withResolvers<never>();
			const onAbort = () =>
				cancelled.reject(
					Object.assign(new Error("Prompt preflight was cancelled before execution."), { code: "busy" }),
				);
			options?.preflightSignal?.addEventListener("abort", onAbort, { once: true });
			try {
				await Promise.race([neverPreflight.promise, cancelled.promise]);
			} finally {
				options?.preflightSignal?.removeEventListener("abort", onAbort);
			}
		},
		true,
	);
	const endpointFile = path.join(cwd, ".gjc", "state", "sdk", `${sessionId}.json`);
	await waitFor(() => fs.existsSync(endpointFile), "SDK endpoint");
	const endpoint = JSON.parse(fs.readFileSync(endpointFile, "utf8")) as { url: string; token: string };
	const frames: Record<string, unknown>[] = [];
	const socket = new WebSocket(`${endpoint.url}/?token=${encodeURIComponent(endpoint.token)}`);
	sockets.push(socket);
	socket.addEventListener("message", event => frames.push(JSON.parse(String(event.data))));
	await new Promise<void>((resolve, reject) => {
		socket.addEventListener("open", () => resolve(), { once: true });
		socket.addEventListener("error", () => reject(new Error("WS error")), { once: true });
	});
	socket.send(
		JSON.stringify({
			type: "control_request",
			id: "never-preflight",
			operation: "turn.prompt",
			input: { text: "never resolve" },
		}),
	);
	await preflightStarted.promise;
	socket.send(
		JSON.stringify({ type: "control_request", id: "abort-never-preflight", operation: "turn.abort", input: {} }),
	);
	await waitFor(
		() =>
			frames.some(frame => frame.type === "control_response" && frame.id === "never-preflight") &&
			frames.some(frame => frame.type === "control_response" && frame.id === "abort-never-preflight"),
		"never-resolving preflight terminal response",
	);
	const promptResponses = frames.filter(frame => frame.type === "control_response" && frame.id === "never-preflight");
	expect(promptResponses).toHaveLength(1);
	expect(promptResponses[0]).toMatchObject({
		ok: false,
		error: { code: "busy", message: "Prompt preflight was cancelled before execution." },
	});
	expect(
		frames.find(frame => frame.type === "control_response" && frame.id === "abort-never-preflight"),
	).toMatchObject({
		ok: true,
		result: { aborted: true },
	});
	latePreflightAccepted?.();
	await Promise.resolve();
	expect(frames.filter(frame => frame.type === "control_response" && frame.id === "never-preflight")).toHaveLength(1);
	expect(frames.some(frame => frame.type === "agent_failed" || frame.type === "agent_start")).toBe(false);
	await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, context(cwd, sessionId));
});

test("terminal abort cancels a pending prompt preflight (never accepts)", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-terminal-preflight-"));
	dirs.push(cwd);
	const sessionId = `sdk-terminal-preflight-${Date.now()}`;
	const live = { idle: true };
	const neverPreflight = Promise.withResolvers<never>();
	const deliveries: Parameters<ExtensionActions["sendUserMessage"]>[] = [];
	const sessionContext = {
		...context(cwd, sessionId, "main", live),
		sessionManager: {
			...(context(cwd, sessionId, "main", live).sessionManager as Record<string, unknown>),
			getSessionFile: () => path.join(cwd, ".gjc", "state", "sdk", `${sessionId}.jsonl`),
		},
		getTerminalTurnEpoch: () => 1,
	};
	const handlers = start(
		sessionContext,
		undefined,
		async (content, options) => {
			deliveries.push([content, options]);
			if (content === "never resolve") {
				await neverPreflight.promise;
			}
			await firePreflightAccept(options);
		},
		true,
	);
	const endpointFile = path.join(cwd, ".gjc", "state", "sdk", `${sessionId}.json`);
	await waitFor(() => fs.existsSync(endpointFile), "SDK endpoint");
	const endpoint = JSON.parse(fs.readFileSync(endpointFile, "utf8")) as { url: string; token: string };
	const frames: Record<string, unknown>[] = [];
	const socket = new WebSocket(`${endpoint.url}/?token=${encodeURIComponent(endpoint.token)}`);
	sockets.push(socket);
	socket.addEventListener("message", event => frames.push(JSON.parse(String(event.data))));
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	socket.addEventListener("open", () => resolve(), { once: true });
	socket.addEventListener("error", () => reject(new Error("socket error")), { once: true });
	await promise;
	socket.send(
		JSON.stringify({
			type: "control_request",
			id: "term-prompt",
			operation: "turn.prompt",
			input: { text: "never resolve", images: [] },
		}),
	);
	await waitFor(() => deliveries.length > 0, "prompt preflight started");
	socket.send(
		JSON.stringify({
			type: "control_request",
			id: "term-abort",
			operation: "turn.abort",
			input: { mode: "terminal" },
			idempotencyKey: "term-abort-key-1",
		}),
	);
	await waitFor(
		() =>
			frames.some(frame => frame.type === "control_response" && frame.id === "term-abort") &&
			frames.some(frame => frame.type === "control_response" && frame.id === "term-prompt"),
		"terminal abort + cancelled preflight responses",
	);
	// The preflight is cancelled (never accepted), so the prompt never starts.
	const promptResponse = frames.find(frame => frame.type === "control_response" && frame.id === "term-prompt");
	expect(promptResponse).toMatchObject({ ok: false });
	expect(frames.some(frame => frame.type === "agent_failed" || frame.type === "agent_start")).toBe(false);
	await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, context(cwd, sessionId));
});

test("SDK host abort-and-prompt cancels a never-resolving preflight before replacement submission", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-abort-prompt-never-preflight-"));
	dirs.push(cwd);
	const sessionId = `sdk-abort-prompt-never-preflight-${Date.now()}`;
	const live = { idle: true };
	const preflightStarted = Promise.withResolvers<void>();
	const neverPreflight = Promise.withResolvers<never>();
	const abortSettled = Promise.withResolvers<void>();
	const deliveries: Parameters<ExtensionActions["sendUserMessage"]>[] = [];
	let abortStarted = false;
	const sessionContext = {
		...context(cwd, sessionId, "main", live),
		abort: () => {
			abortStarted = true;
			return abortSettled.promise;
		},
	};
	const handlers = start(
		sessionContext,
		undefined,
		async (content, options) => {
			deliveries.push([content, options]);
			if (content === "never resolve") {
				preflightStarted.resolve();
				await neverPreflight.promise;
			}
			await firePreflightAccept(options);
		},
		true,
	);
	const endpointFile = path.join(cwd, ".gjc", "state", "sdk", `${sessionId}.json`);
	await waitFor(() => fs.existsSync(endpointFile), "SDK endpoint");
	const endpoint = JSON.parse(fs.readFileSync(endpointFile, "utf8")) as { url: string; token: string };
	const frames: Record<string, unknown>[] = [];
	const socket = new WebSocket(`${endpoint.url}/?token=${encodeURIComponent(endpoint.token)}`);
	sockets.push(socket);
	socket.addEventListener("message", event => frames.push(JSON.parse(String(event.data))));
	await new Promise<void>((resolve, reject) => {
		socket.addEventListener("open", () => resolve(), { once: true });
		socket.addEventListener("error", () => reject(new Error("WS error")), { once: true });
	});
	socket.send(
		JSON.stringify({
			type: "control_request",
			id: "never-preflight-abort-and-prompt",
			operation: "turn.prompt",
			input: { text: "never resolve" },
		}),
	);
	await preflightStarted.promise;
	socket.send(
		JSON.stringify({
			type: "control_request",
			id: "abort-and-prompt-never-preflight",
			operation: "turn.abort_and_prompt",
			input: { text: "replacement" },
		}),
	);
	await waitFor(() => abortStarted, "abort-and-prompt abort prelude");
	await waitFor(
		() => frames.some(frame => frame.type === "control_response" && frame.id === "never-preflight-abort-and-prompt"),
		"never-resolving preflight cancellation",
	);
	expect(deliveries).toHaveLength(1);
	expect(
		frames.find(frame => frame.type === "control_response" && frame.id === "never-preflight-abort-and-prompt"),
	).toMatchObject({
		ok: false,
		error: { code: "busy", message: "Prompt preflight was cancelled before execution." },
	});

	live.idle = true;
	abortSettled.resolve();
	await waitFor(
		() => frames.some(frame => frame.type === "control_response" && frame.id === "abort-and-prompt-never-preflight"),
		"abort-and-prompt replacement response",
	);
	expect(deliveries.map(([content]) => content)).toEqual(["never resolve", "replacement"]);
	expect(
		frames.find(frame => frame.type === "control_response" && frame.id === "abort-and-prompt-never-preflight"),
	).toMatchObject({
		ok: true,
		result: { accepted: true, commandId: expect.any(String), turnId: expect.any(String) },
	});
	await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, sessionContext);
});

test("SDK host waits for asynchronous abort unwind before delivering an abort-and-prompt replacement", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-abort-prompt-"));
	dirs.push(cwd);
	const sessionId = `sdk-abort-prompt-${Date.now()}`;
	const live = { idle: false };
	const abortStarted = Promise.withResolvers<void>();
	const abortSettled = Promise.withResolvers<void>();
	const deliveries: Parameters<ExtensionActions["sendUserMessage"]>[] = [];
	const sessionContext = {
		...context(cwd, sessionId, "main", live),
		abort: () => {
			abortStarted.resolve();
			return abortSettled.promise;
		},
	};
	const handlers = start(
		sessionContext,
		undefined,
		async (content, options) => {
			deliveries.push([content, options]);
			await firePreflightAccept(options);
		},
		true,
	);
	const endpointFile = path.join(cwd, ".gjc", "state", "sdk", `${sessionId}.json`);
	await waitFor(() => fs.existsSync(endpointFile), "SDK endpoint");
	const endpoint = JSON.parse(fs.readFileSync(endpointFile, "utf8")) as { url: string; token: string };
	const frames: Record<string, unknown>[] = [];
	const socket = new WebSocket(`${endpoint.url}/?token=${encodeURIComponent(endpoint.token)}`);
	sockets.push(socket);
	socket.addEventListener("message", event => frames.push(JSON.parse(String(event.data))));
	await new Promise<void>((resolve, reject) => {
		socket.addEventListener("open", () => resolve(), { once: true });
		socket.addEventListener("error", () => reject(new Error("WS error")), { once: true });
	});
	void handlers.get("agent_start")?.({ type: "agent_start" }, sessionContext);
	socket.send(
		JSON.stringify({
			type: "control_request",
			id: "abort-and-prompt",
			operation: "turn.abort_and_prompt",
			input: { text: "replacement" },
		}),
	);
	await abortStarted.promise;
	await Bun.sleep(25);
	expect(deliveries).toHaveLength(0);
	expect(frames.some(frame => frame.type === "control_response" && frame.id === "abort-and-prompt")).toBe(false);
	live.idle = true;
	void handlers.get("agent_end")?.({ type: "agent_end", messages: [] }, sessionContext);
	abortSettled.resolve();
	await waitFor(
		() => frames.some(frame => frame.type === "control_response" && frame.id === "abort-and-prompt"),
		"abort-and-prompt response after abort unwind",
	);
	expect(deliveries).toHaveLength(1);
	expect(deliveries[0]?.[0]).toBe("replacement");
	expect(deliveries[0]?.[1]).not.toHaveProperty("deliverAs");
	expect(frames.find(frame => frame.type === "control_response" && frame.id === "abort-and-prompt")).toMatchObject({
		ok: true,
		result: { accepted: true, commandId: expect.any(String), turnId: expect.any(String) },
	});
	await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, sessionContext);
});
test("SDK host turn.abort terminal mode returns no-effect with no active turn", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-terminal-noop-"));
	dirs.push(cwd);
	const sessionId = `sdk-terminal-noop-${Date.now()}`;
	const sessionContext = {
		...context(cwd, sessionId),
		// Provide a file-backed session so the terminal abort has a reconciliation
		// owner (the no-store gate only fires for genuinely store-less sessions).
		sessionManager: {
			...(context(cwd, sessionId).sessionManager as Record<string, unknown>),
			getSessionFile: () => path.join(cwd, ".gjc", "state", "sdk", `${sessionId}.jsonl`),
		},
	};
	const handlers = start(sessionContext, undefined, () => {}, true);
	const endpointFile = path.join(cwd, ".gjc", "state", "sdk", `${sessionId}.json`);
	await waitFor(() => fs.existsSync(endpointFile), "SDK endpoint");
	const endpoint = (await Bun.file(endpointFile).json()) as { url: string; token: string };
	const frames: Record<string, unknown>[] = [];
	const socket = new WebSocket(`${endpoint.url}/?token=${encodeURIComponent(endpoint.token)}`);
	sockets.push(socket);
	socket.addEventListener("message", event => frames.push(JSON.parse(String(event.data))));
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	socket.addEventListener("open", () => resolve(), { once: true });
	socket.addEventListener("error", () => reject(new Error("WS error")), { once: true });
	await promise;
	socket.send(
		JSON.stringify({
			type: "control_request",
			id: "terminal-noop",
			operation: "turn.abort",
			input: { mode: "terminal" },
			idempotencyKey: "terminal-noop-key",
		}),
	);
	await waitFor(
		() => frames.some(frame => frame.type === "control_response" && frame.id === "terminal-noop"),
		"terminal abort no-effect response",
	);
	expect(frames.find(frame => frame.type === "control_response" && frame.id === "terminal-noop")).toMatchObject({
		ok: true,
		result: {
			selection: "turn",
			turn: "no_active_turn",
			terminal: "terminal_no_effect",
		},
	});
	// No agent turn ever started.
	expect(frames.some(frame => frame.type === "agent_start")).toBe(false);
	await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, sessionContext);
});
test("terminal abort from a queued requester never cancels another connection's pending preflight", async () => {
	// Review thread P1: two connections submit prompts before either receives a
	// run handle. The queued requester's terminal abort rejects its own
	// wrapper preflight but must NOT invoke the session-wide preflight seam —
	// it cancels the session's single controller captured by the OTHER
	// connection's active preflight, failing an unrelated prompt.
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-preflight-scope-"));
	dirs.push(cwd);
	const sessionId = `sdk-preflight-scope-${Date.now()}`;
	let sessionPreflightCancelled = 0;
	const neverPreflight = Promise.withResolvers<never>();
	const deliveries: unknown[][] = [];
	const handlers = start(
		{
			...context(cwd, sessionId),
			cancelPendingPreflightForTerminalAbort: () => {
				sessionPreflightCancelled += 1;
			},
		},
		undefined,
		async (content, options) => {
			deliveries.push([content, options]);
			if (content === "conn-a pending prompt") {
				await neverPreflight.promise;
			}
			await firePreflightAccept(options);
		},
		true,
	);
	const endpointFile = path.join(cwd, ".gjc", "state", "sdk", `${sessionId}.json`);
	await waitFor(() => fs.existsSync(endpointFile), "SDK endpoint");
	const endpoint = JSON.parse(fs.readFileSync(endpointFile, "utf8")) as { url: string; token: string };
	const connect = async () => {
		const frames: Record<string, unknown>[] = [];
		const socket = new WebSocket(`${endpoint.url}/?token=${encodeURIComponent(endpoint.token)}`);
		sockets.push(socket);
		socket.addEventListener("message", event => frames.push(JSON.parse(String(event.data))));
		await new Promise<void>((resolve, reject) => {
			socket.addEventListener("open", () => resolve(), { once: true });
			socket.addEventListener("error", () => reject(new Error("WS error")), { once: true });
		});
		return { socket, frames };
	};
	const connA = await connect();
	const connB = await connect();
	// Conn A's prompt enters preflight and stays there (never resolves).
	connA.socket.send(
		JSON.stringify({
			type: "control_request",
			id: "scope-prompt-a",
			operation: "turn.prompt",
			input: { text: "conn-a pending prompt", images: [] },
		}),
	);
	await waitFor(() => deliveries.length === 1, "conn-a preflight started");
	// Conn B terminal-aborts while conn A's preflight is still pending: the
	// aborting requester has no admission of its own yet, so only conn A's
	// preflight could be hit by the session-wide seam.
	connB.socket.send(
		JSON.stringify({
			type: "control_request",
			id: "scope-abort-b",
			operation: "turn.abort",
			input: { mode: "terminal" },
			idempotencyKey: "scope-abort-b-key",
		}),
	);
	await waitFor(
		() => connB.frames.some(frame => frame.type === "control_response" && frame.id === "scope-abort-b"),
		"queued requester abort response",
	);
	// The session-wide seam was never invoked while another connection's
	// preflight was pending: conn A's prompt must still be able to complete.
	expect(sessionPreflightCancelled).toBe(0);
	neverPreflight.resolve();
	await waitFor(
		() => connA.frames.some(frame => frame.type === "control_response" && frame.id === "scope-prompt-a"),
		"conn-a prompt response after preflight release",
	);
	expect(connA.frames.find(f => f.type === "control_response" && f.id === "scope-prompt-a")).toMatchObject({
		ok: true,
	});
	await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, context(cwd, sessionId));
});

test("full-bus terminal replay advances a finalized row through the stored replay payload hash", async () => {
	// Review thread P2: the full-bus no-effect finalization must store the
	// replay-shaped payload hash alongside the original response hash — a
	// same-key retry delivers the replay envelope, and the delivery observer
	// only advances a pending row when the written response matches either
	// stored hash. Without replayPayloadHash the written replay stays durably
	// pending forever.
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-fullbus-replay-hash-"));
	dirs.push(cwd);
	const sessionId = `sdk-fullbus-replay-hash-${Date.now()}`;
	const sessionFile = path.join(cwd, ".gjc", "state", "sdk", `${sessionId}.jsonl`);
	const handlers = start(
		{
			...context(cwd, sessionId),
			sessionManager: {
				...(context(cwd, sessionId).sessionManager as Record<string, unknown>),
				getSessionFile: () => sessionFile,
			},
			getTerminalTurnEpoch: () => 1,
		},
		undefined,
		() => {},
		true,
	);
	const endpointFile = path.join(cwd, ".gjc", "state", "sdk", `${sessionId}.json`);
	await waitFor(() => fs.existsSync(endpointFile), "SDK endpoint");
	const endpoint = JSON.parse(fs.readFileSync(endpointFile, "utf8")) as { url: string; token: string };
	const frames: Record<string, unknown>[] = [];
	const socket = new WebSocket(`${endpoint.url}/?token=${encodeURIComponent(endpoint.token)}`);
	sockets.push(socket);
	socket.addEventListener("message", event => frames.push(JSON.parse(String(event.data))));
	await new Promise<void>((resolve, reject) => {
		socket.addEventListener("open", () => resolve(), { once: true });
		socket.addEventListener("error", () => reject(new Error("WS error")), { once: true });
	});
	// Idle abort: durable no-effect reservation, finalized to plain no_effect.
	socket.send(
		JSON.stringify({
			type: "control_request",
			id: "fh-abort-1",
			operation: "turn.abort",
			input: { mode: "terminal" },
			idempotencyKey: "fh-key-1",
		}),
	);
	await waitFor(
		() => frames.some(frame => frame.type === "control_response" && frame.id === "fh-abort-1"),
		"first abort response",
	);
	expect(frames.find(f => f.type === "control_response" && f.id === "fh-abort-1")).toMatchObject({
		ok: true,
		result: { turn: "no_active_turn", terminal: "terminal_no_effect" },
	});
	// The finalized row stores BOTH the original and the replay-shaped hash.
	const storeFile = reconciliationStorePath(sessionFile, sessionId);
	await waitFor(() => fs.existsSync(storeFile), "durable store file");
	const row = JSON.parse(fs.readFileSync(storeFile, "utf8")).terminalScopes?.find(
		(scope: { idempotencyKeyHash?: string }) => scope.idempotencyKeyHash,
	);
	expect(row).toMatchObject({ turnDisposition: "no_effect", responsePayloadHash: expect.any(String) });
	expect(typeof row.replayPayloadHash).toBe("string");
	// Same-key retry: the replay is delivered and the written response advances
	// the pending row to sent (its hash matches the stored replay-shaped hash).
	socket.send(
		JSON.stringify({
			type: "control_request",
			id: "fh-abort-2",
			operation: "turn.abort",
			input: { mode: "terminal" },
			idempotencyKey: "fh-key-1",
		}),
	);
	await waitFor(
		() => frames.some(frame => frame.type === "control_response" && frame.id === "fh-abort-2"),
		"retry abort response",
	);
	expect(frames.find(f => f.type === "control_response" && f.id === "fh-abort-2")).toMatchObject({
		ok: true,
		result: expect.objectContaining({ turn: "no_active_turn", terminal: "terminal_no_effect" }),
	});
	const sentDeadline = Date.now() + 15_000;
	let advancedRow: { responseState?: string } | undefined;
	while (Date.now() < sentDeadline) {
		const doc = JSON.parse(fs.readFileSync(storeFile, "utf8")) as {
			terminalScopes?: Array<{ idempotencyKeyHash?: string; responseState?: string }>;
		};
		advancedRow = doc.terminalScopes?.find(scope => scope.idempotencyKeyHash);
		if (advancedRow?.responseState === "sent") break;
		await Bun.sleep(20);
	}
	expect(advancedRow?.responseState).toBe("sent");
	await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, context(cwd, sessionId));
});

test("terminal abort durable replay after restart never cancels a NEW unrelated pending preflight", async () => {
	// A successful durable row replayed after the in-memory dispatch entry
	// expires/restart returns stopped/stopped_owned/no_effect WITH `stored`; the
	// admission predicate must treat EVERY stored-carrying replay as a
	// non-admission — cancelling the requester's unrelated in-preflight prompt
	// there would give an idempotency replay real effects (review thread P1).
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-terminal-replay-"));
	dirs.push(cwd);
	const sessionId = `sdk-terminal-replay-${Date.now()}`;
	const sessionFile = path.join(cwd, ".gjc", "state", "sdk", `${sessionId}.jsonl`);
	const makeContext = () => ({
		...context(cwd, sessionId),
		sessionManager: {
			...(context(cwd, sessionId).sessionManager as Record<string, unknown>),
			getSessionFile: () => sessionFile,
		},
		getTerminalTurnEpoch: () => 1,
	});
	// Host #1: file-backed store. The first abort (no active turn) durably
	// reserves a no-effect row for the key.
	const handlersA = start(makeContext(), undefined, () => {}, true);
	const endpointFile = path.join(cwd, ".gjc", "state", "sdk", `${sessionId}.json`);
	await waitFor(() => fs.existsSync(endpointFile), "SDK endpoint (host A)");
	const endpointA = (await Bun.file(endpointFile).json()) as { url: string; token: string };
	const framesA: Record<string, unknown>[] = [];
	const socketA = new WebSocket(`${endpointA.url}/?token=${encodeURIComponent(endpointA.token)}`);
	socketA.addEventListener("message", event => framesA.push(JSON.parse(String(event.data))));
	sockets.push(socketA);
	const { promise: promiseA, resolve: resolveA, reject: rejectA } = Promise.withResolvers<void>();
	socketA.addEventListener("open", () => resolveA(), { once: true });
	socketA.addEventListener("error", () => rejectA(new Error("WS error (host A)")), { once: true });
	await promiseA;
	socketA.send(
		JSON.stringify({
			type: "control_request",
			id: "replay-abort-1",
			operation: "turn.abort",
			input: { mode: "terminal" },
			idempotencyKey: "mq-key-1",
		}),
	);
	await waitFor(
		() => framesA.some(frame => frame.type === "control_response" && frame.id === "replay-abort-1"),
		"host A abort response",
	);
	expect(framesA.find(f => f.type === "control_response" && f.id === "replay-abort-1")).toMatchObject({
		ok: true,
		result: { selection: "turn", turn: "no_active_turn", terminal: "terminal_no_effect" },
	});
	// The durable no-effect reservation is written to the reconciliation store
	// (a sibling of the transcript, derived path).
	expect(fs.existsSync(reconciliationStorePath(sessionFile, sessionId))).toBe(true);
	await handlersA.get("session_shutdown")?.({ type: "session_shutdown" }, makeContext());
	await closeSocket(socketA);
	// Shutdown may leave the endpoint file behind; remove it so host B's
	// waitFor below observes a FRESH endpoint (token/port) instead of A's stale
	// one — otherwise the reconnect would hang on a dead server.
	fs.rmSync(endpointFile, { force: true });
	await Bun.sleep(25);

	// Host #2: FRESH in-memory dispatch (restart) over the SAME durable store.
	let sessionPreflightCancelled = 0;
	const ctxB = {
		...makeContext(),
		cancelPendingPreflightForTerminalAbort: () => {
			sessionPreflightCancelled += 1;
		},
	};
	const neverPreflight = Promise.withResolvers<never>();
	const deliveries: unknown[][] = [];
	const handlersB = start(
		ctxB,
		undefined,
		async (content, options) => {
			deliveries.push([content, options]);
			if (content === "unrelated pending prompt") {
				await neverPreflight.promise;
			}
			await firePreflightAccept(options);
		},
		true,
	);
	await waitFor(() => fs.existsSync(endpointFile), "SDK endpoint (host B)");
	const endpointB = (await Bun.file(endpointFile).json()) as { url: string; token: string };
	const framesB: Record<string, unknown>[] = [];
	const socketB = new WebSocket(`${endpointB.url}/?token=${encodeURIComponent(endpointB.token)}`);
	socketB.addEventListener("message", event => framesB.push(JSON.parse(String(event.data))));
	sockets.push(socketB);
	const { promise: promiseB, resolve: resolveB, reject: rejectB } = Promise.withResolvers<void>();
	socketB.addEventListener("open", () => resolveB(), { once: true });
	socketB.addEventListener("error", () => rejectB(new Error("WS error (host B)")), { once: true });
	await promiseB;
	await waitFor(() => framesB.some(frame => frame.type === "hello"), "host B hello");
	// A NEW unrelated prompt enters PREFLIGHT (never resolves) on the SAME
	// connection while the replay lands.
	socketB.send(
		JSON.stringify({
			type: "control_request",
			id: "new-prompt",
			operation: "turn.prompt",
			input: { text: "unrelated pending prompt", images: [] },
		}),
	);
	await waitFor(() => deliveries.length > 0, "new prompt preflight started");
	socketB.send(
		JSON.stringify({
			type: "control_request",
			id: "replay-abort-2",
			operation: "turn.abort",
			input: { mode: "terminal" },
			idempotencyKey: "mq-key-1",
		}),
	);
	// Host B's store hydration (restart recovery) can stall on file I/O under
	// load; give the replay response a longer observation window than the
	// shared 15s waitFor before failing.
	const replayDeadline = Date.now() + 30_000;
	while (!framesB.some(frame => frame.type === "control_response" && frame.id === "replay-abort-2")) {
		if (Date.now() > replayDeadline) throw new Error("Timed out waiting for replay abort response (host B)");
		await Bun.sleep(20);
	}
	const replay = framesB.find(f => f.type === "control_response" && f.id === "replay-abort-2")!;
	expect(replay).toMatchObject({ ok: true, result: { terminal: "terminal_no_effect", replay: expect.any(Object) } });
	// The stored-carrying replay is a NON-admission: neither the connection-level
	// waiter cancel nor the session preflight seam may fire, and the prompt stays
	// pending (no response, no cancellation).
	await Bun.sleep(100);
	expect(sessionPreflightCancelled).toBe(0);
	expect(framesB.some(f => f.type === "control_response" && f.id === "new-prompt")).toBe(false);
	// Releasing the preflight completes the prompt normally — it was never
	// cancelled by the replay.
	neverPreflight.resolve();
	await waitFor(
		() => framesB.some(frame => frame.type === "control_response" && frame.id === "new-prompt"),
		"new prompt response after preflight release",
	);
	expect(framesB.find(f => f.type === "control_response" && f.id === "new-prompt")).toMatchObject({ ok: true });
	await handlersB.get("session_shutdown")?.({ type: "session_shutdown" }, ctxB);
}, 20_000);

test("SDK host turn.abort terminal mode finalizes an accepted-but-not-started prompt as cancelled", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-terminal-fence-"));
	dirs.push(cwd);
	const sessionId = `sdk-terminal-fence-${Date.now()}`;
	const live = { idle: true };
	const deliveries: Parameters<ExtensionActions["sendUserMessage"]>[] = [];
	const sessionContext = {
		...context(cwd, sessionId, "main", live),
		// File-backed reconciliation owner so the terminal abort reaches the
		// fence path (and fails closed there) instead of the no-store gate.
		sessionManager: {
			...(context(cwd, sessionId, "main", live).sessionManager as Record<string, unknown>),
			getSessionFile: () => path.join(cwd, ".gjc", "state", "sdk", `${sessionId}.jsonl`),
		},
		// The initial-marker seam: a stable epoch so the marker is written
		// before the fence attempts (and fails closed) on the missing seam.
		getTerminalTurnEpoch: () => 1,
	};
	const handlers = start(
		sessionContext,
		undefined,
		async (content, options) => {
			deliveries.push([content, options]);
			await firePreflightAccept(options);
		},
		true,
	);
	const endpointFile = path.join(cwd, ".gjc", "state", "sdk", `${sessionId}.json`);
	await waitFor(() => fs.existsSync(endpointFile), "SDK endpoint");
	const endpoint = (await Bun.file(endpointFile).json()) as { url: string; token: string };
	const frames: Record<string, unknown>[] = [];
	const socket = new WebSocket(`${endpoint.url}/?token=${encodeURIComponent(endpoint.token)}`);
	sockets.push(socket);
	socket.addEventListener("message", event => frames.push(JSON.parse(String(event.data))));
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	socket.addEventListener("open", () => resolve(), { once: true });
	socket.addEventListener("error", () => reject(new Error("WS error")), { once: true });
	await promise;
	socket.send(
		JSON.stringify({
			type: "control_request",
			id: "terminal-prompt",
			operation: "turn.prompt",
			input: { text: "terminalize me" },
		}),
	);
	await waitFor(() => deliveries.length === 1, "terminal prompt accepted");
	void handlers.get("agent_start")?.({ type: "agent_start" }, sessionContext);
	// The fixture harness fires agent_start without binding an exact run handle,
	// so the prompt is accepted-but-not-started: terminal abort must cancel the
	// in-flight session preflight and FINALIZE the accepted prompt as a pre-run
	// cancellation (no_active_turn / terminal_no_effect) instead of terminalizing
	// with no run handle (which would wrongly fence the connection).
	socket.send(
		JSON.stringify({
			type: "control_request",
			id: "terminal-abort",
			operation: "turn.abort",
			input: { mode: "terminal" },
			idempotencyKey: "terminal-abort-key",
		}),
	);
	await waitFor(
		() => frames.some(frame => frame.type === "control_response" && frame.id === "terminal-abort"),
		"terminal abort uncertainty response",
	);
	expect(frames.find(frame => frame.type === "control_response" && frame.id === "terminal-abort")).toMatchObject({
		ok: true,
		result: {
			selection: "turn",
			turn: "no_active_turn",
			terminal: "terminal_no_effect",
		},
	});
	await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, sessionContext);
});

test("SDK session switches rotate endpoint authority before publishing the replacement host", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-host-switch-"));
	dirs.push(cwd);
	const sessionA = `sdk-switch-a-${Date.now()}`;
	const sessionB = `sdk-switch-b-${Date.now()}`;
	let activeSessionId = sessionA;
	const ctx = {
		...context(cwd, sessionA),
		sessionManager: {
			getSessionId: () => activeSessionId,
			getSessionName: () => "SDK switch",
			getUsageStatistics: () => ({ input: 1, output: 2, cacheRead: 0, cacheWrite: 0, premiumRequests: 0, cost: 0 }),
		},
	};
	const handlers = start(ctx);
	const endpointAPath = path.join(cwd, ".gjc", "state", "sdk", `${sessionA}.json`);
	await waitFor(() => fs.existsSync(endpointAPath), "session A endpoint");
	const endpointA = JSON.parse(fs.readFileSync(endpointAPath, "utf8")) as { url: string; token: string };
	const clientA = new WebSocket(`${endpointA.url}/?token=${encodeURIComponent(endpointA.token)}`);
	sockets.push(clientA);
	await new Promise<void>((resolve, reject) => {
		clientA.addEventListener("open", () => resolve(), { once: true });
		clientA.addEventListener("error", () => reject(new Error("session A WebSocket error")), { once: true });
	});

	activeSessionId = sessionB;
	await handlers.get("session_switch")?.(
		{
			type: "session_switch",
			reason: "new",
			previousSessionFile: path.join(cwd, "sessions", `ts_${sessionA}.jsonl`),
		},
		ctx,
	);
	const endpointBPath = path.join(cwd, ".gjc", "state", "sdk", `${sessionB}.json`);
	await waitFor(() => !fs.existsSync(endpointAPath) && fs.existsSync(endpointBPath), "rotated session endpoint");
	const endpointB = JSON.parse(fs.readFileSync(endpointBPath, "utf8")) as { url: string; token: string };
	expect(endpointB.token).not.toBe(endpointA.token);
	await waitFor(() => clientA.readyState === WebSocket.CLOSED, "session A client close");

	const staleTokenClient = new WebSocket(`${endpointB.url}/?token=${encodeURIComponent(endpointA.token)}`);
	sockets.push(staleTokenClient);
	await Promise.race([
		new Promise<void>(resolve => {
			staleTokenClient.addEventListener("close", () => resolve(), { once: true });
			staleTokenClient.addEventListener("error", () => resolve(), { once: true });
		}),
		Bun.sleep(1_000).then(() => {
			throw new Error("stale session token was not rejected by the replacement host");
		}),
	]);
	await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, ctx);
});

for (const eventType of ["session_switch", "session_branch"] as const) {
	test(`SDK ${eventType} rotation fails closed when predecessor release is uncertain`, async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `gjc-sdk-rotate-fail-${eventType}-`));
		dirs.push(cwd);
		const sessionA = `rotate-fail-a-${Date.now()}`;
		const sessionB = `rotate-fail-b-${Date.now()}`;
		let activeSessionId = sessionA;
		const ctx = {
			...context(cwd, sessionA),
			sessionManager: {
				getSessionId: () => activeSessionId,
				getSessionName: () => "SDK rotate",
				getUsageStatistics: () => ({
					input: 1,
					output: 2,
					cacheRead: 0,
					cacheWrite: 0,
					premiumRequests: 0,
					cost: 0,
				}),
			},
		};
		// Fail A's owner release exactly once so the rotate-time stopSession(prevId)
		// throws the retained-retry AggregateError.
		const stop = spyOn(SessionSdkHost.prototype, "stop").mockRejectedValueOnce(new Error("host stop failed"));
		try {
			const startupCapability = new SdkStartupCapability(undefined, "immediate", "rotation-failure-marker");
			const handlers = start(ctx, undefined, () => {}, false, new Map(), {
				startupCapability,
				lifecycleRequired: true,
			});
			await expect(startupCapability.promise).resolves.toEqual({ status: "started" });
			const endpointAPath = path.join(cwd, ".gjc", "state", "sdk", `${sessionA}.json`);
			await waitFor(() => fs.existsSync(endpointAPath), "session A endpoint");

			activeSessionId = sessionB;
			// A retained predecessor cleanup must fail closed and rethrow before any
			// successor endpoint can publish.
			const rotationEvent = {
				type: eventType,
				reason: "new",
				previousSessionFile: path.join(cwd, "sessions", `ts_${sessionA}.jsonl`),
			};
			await expect(handlers.get(eventType)!(rotationEvent, ctx)).rejects.toThrow(
				`SDK notification runtime ${sessionA} owner release failed`,
			);

			// The failed predecessor release quarantines B: no successor endpoint is published.
			const endpointBPath = path.join(cwd, ".gjc", "state", "sdk", `${sessionB}.json`);
			expect(fs.existsSync(endpointBPath)).toBe(false);

			// With the mock restored, A's retained cleanup can still complete.
			stop.mockRestore();
			await expect(
				handlers.get("session_shutdown")!(
					{ type: "session_shutdown" },
					{ ...ctx, sessionManager: { ...ctx.sessionManager, getSessionId: () => sessionA } },
				),
			).resolves.toBeUndefined();

			await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, ctx);
		} finally {
			stop.mockRestore();
		}
	});
}

test("SDK host binds session query and control seams and excludes uninstalled resources", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-host-bindings-"));
	dirs.push(cwd);
	const sessionId = `sdk-bindings-${Date.now()}`;
	start(context(cwd, sessionId));
	const endpointFile = path.join(cwd, ".gjc", "state", "sdk", `${sessionId}.json`);
	await waitFor(() => fs.existsSync(endpointFile), "SDK endpoint");
	const endpoint = JSON.parse(fs.readFileSync(endpointFile, "utf8")) as { url: string; token: string };
	const frames: Record<string, unknown>[] = [];
	const socket = new WebSocket(`${endpoint.url}/?token=${encodeURIComponent(endpoint.token)}`);
	sockets.push(socket);
	socket.addEventListener("message", event => frames.push(JSON.parse(String(event.data))));
	await new Promise<void>((resolve, reject) => {
		socket.addEventListener("open", () => resolve(), { once: true });
		socket.addEventListener("error", () => reject(new Error("WS error")), { once: true });
	});
	const request = async (requestId: string, command: Record<string, unknown>): Promise<Record<string, unknown>> => {
		socket.send(JSON.stringify({ type: "control_command", sessionId, token: endpoint.token, requestId, command }));
		await waitFor(
			() => frames.some(frame => frame.type === "control_command_result" && frame.requestId === requestId),
			`${requestId} response`,
		);
		return JSON.parse(
			String(
				frames.find(frame => frame.type === "control_command_result" && frame.requestId === requestId)?.message,
			),
		) as Record<string, unknown>;
	};
	for (const [query, expected] of [
		["Q11", { name: "fixture-skill" }],
		["Q13", { key: "fixture.config" }],
		["Q16", { id: "branch-1" }],
		["Q22", { path: "fixture-extension" }],
	] as const) {
		const response = await request(`query-${query}`, { type: "query_request", id: `query-${query}`, query });
		expect(response).toMatchObject({ ok: true, page: { items: [expect.objectContaining(expected)] } });
	}
	const activeProviders = await request("query-Q29", {
		type: "query_request",
		id: "query-Q29",
		query: "Q29",
	});
	expect(activeProviders).toEqual({
		type: "query_response",
		id: "query-Q29",
		ok: true,
		page: {
			items: [{ provider: "fixture-provider", connectionKind: "credential" }],
			complete: true,
			revision: "1",
		},
	});
	for (const query of ["Q10", "models.list/current", "models.list", "models.current"]) {
		const response = await request(`query-${query}`, {
			type: "query_request",
			id: `query-${query}`,
			query,
		});
		expect(response).toMatchObject({
			ok: true,
			page: {
				items: [
					{
						provider: "fixture-provider",
						id: "non-reasoning-model",
						name: "Non-reasoning Model",
						contextWindow: 64_000,
						maxTokens: 4_096,
						reasoning: false,
						thinking: { validLevels: ["off"] },
						current: false,
					},
					{
						provider: "fixture-provider",
						id: "reasoning-model",
						name: "Reasoning Model",
						contextWindow: 128_000,
						maxTokens: 8_192,
						reasoning: true,
						thinking: {
							validLevels: ["off", "minimal", "high"],
							minLevel: "minimal",
							maxLevel: "high",
							mode: "effort",
							defaultLevel: "high",
							levels: ["high", "minimal", "high"],
						},
						current: true,
						currentThinkingLevel: "low",
					},
				],
			},
		});
	}
	for (const [operation, input, confirm] of [
		["model.cycle", {}, false],
		["thinking.cycle", {}, false],
		["queue.steering_mode.set", { mode: "all" }, false],
		["context.clear", {}, true],
	] as const) {
		const response = await request(`control-${operation}`, {
			type: "control_request",
			id: `control-${operation}`,
			operation,
			input,
			...(confirm ? { confirm } : {}),
		});
		expect(response).toMatchObject({ ok: true });
	}
	const capabilities = await request("capabilities", {
		type: "query_request",
		id: "capabilities",
		query: "runtime.capabilities",
	});
	expect(capabilities).toMatchObject({
		ok: true,
		page: { items: [expect.objectContaining({ operations: expect.arrayContaining(["config.patch"]) })] },
	});

	for (const query of ["Q24", "Q25"]) {
		const response = await request(`excluded-${query}`, {
			type: "query_request",
			id: `excluded-${query}`,
			query,
			input: { artifactId: "missing" },
		});
		expect(response).toMatchObject({ ok: false, error: { code: "resource_gone" } });
	}
});

test("SDK host routes pure ACP permission prompts through a live reverse provider", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-permission-provider-"));
	dirs.push(cwd);
	const sessionId = `sdk-permission-provider-${Date.now()}`;
	let permissionProvider:
		| ((
				toolCall: ClientBridgePermissionToolCall,
				options: ClientBridgePermissionOption[],
				signal?: AbortSignal,
		  ) => Promise<ClientBridgePermissionOutcome>)
		| undefined;
	const ctx = {
		...context(cwd, sessionId),
		setSdkPermissionProvider: (provider: typeof permissionProvider) => {
			permissionProvider = provider;
		},
	};
	process.env.GJC_NOTIFICATIONS = "1";
	start(ctx);
	const endpointFile = path.join(cwd, ".gjc", "state", "sdk", `${sessionId}.json`);
	await waitFor(() => fs.existsSync(endpointFile), "SDK endpoint");
	const endpoint = JSON.parse(fs.readFileSync(endpointFile, "utf8")) as { url: string; token: string };
	const socket = new WebSocket(`${endpoint.url}/?token=${encodeURIComponent(endpoint.token)}`);
	sockets.push(socket);
	const frames: Record<string, unknown>[] = [];
	socket.addEventListener("message", event => frames.push(JSON.parse(String(event.data))));
	await new Promise<void>((resolve, reject) => {
		socket.addEventListener("open", () => resolve(), { once: true });
		socket.addEventListener("error", () => reject(new Error("WS error")), { once: true });
	});
	await waitFor(() => frames.some(frame => frame.type === "hello"), "SDK hello");
	const connectionId = String(frames.find(frame => frame.type === "hello")?.connectionId);
	socket.send(
		JSON.stringify({
			type: "register_provider",
			id: "permission",
			connectionId,
			capability: "permission",
			definitions: [],
		}),
	);
	await waitFor(() => permissionProvider !== undefined, "permission provider installation");
	const requested = permissionProvider!(
		{ toolCallId: "call-1", toolName: "bash", title: "printf guarded", status: "pending" },
		[{ optionId: "allow_once", name: "Allow once", kind: "allow_once" }],
	);
	await waitFor(() => frames.some(frame => frame.type === "reverse_request"), "reverse permission request");
	const request = frames.find(frame => frame.type === "reverse_request")!;
	socket.send(
		JSON.stringify({
			type: "reverse_response",
			id: request.id,
			connectionId,
			leaseId: request.leaseId,
			ok: true,
			result: { outcome: "selected", optionId: "allow_once", kind: "allow_once" },
		}),
	);
	expect(await requested).toEqual({ outcome: "selected", optionId: "allow_once", kind: "allow_once" });
	const cancelledPermissionAbort = new AbortController();
	const cancelledPermission = permissionProvider!(
		{ toolCallId: "call-2", toolName: "bash", title: "printf cancelled", status: "pending" },
		[{ optionId: "reject_once", name: "Reject once", kind: "reject_once" }],
		cancelledPermissionAbort.signal,
	).catch(error => error);
	await waitFor(
		() => frames.filter(frame => frame.type === "reverse_request").length >= 2,
		"second reverse permission request",
	);
	const cancelledRequest = frames.filter(frame => frame.type === "reverse_request")[1]!;
	cancelledPermissionAbort.abort();
	await waitFor(
		() => frames.some(frame => frame.type === "reverse_cancel" && frame.id === cancelledRequest.id),
		"permission reverse cancellation",
	);
	expect(await cancelledPermission).toMatchObject({ message: "request_cancelled" });
	socket.send(
		JSON.stringify({
			type: "reverse_response",
			id: cancelledRequest.id,
			connectionId,
			leaseId: cancelledRequest.leaseId,
			ok: true,
			result: { outcome: "selected", optionId: "reject_once", kind: "reject_once" },
		}),
	);
	await waitFor(
		() =>
			frames.some(
				frame => frame.type === "reverse_response" && frame.id === cancelledRequest.id && frame.ok === false,
			),
		"stale reverse permission response",
	);
	expect(frames.filter(frame => frame.type === "reverse_cancel" && frame.id === cancelledRequest.id)).toHaveLength(1);
	expect(frames.find(frame => frame.type === "reverse_response" && frame.id === cancelledRequest.id)).toMatchObject({
		ok: false,
		error: { code: "unknown_request" },
	});
	socket.close();
	await waitFor(() => permissionProvider === undefined, "permission provider removal after disconnect");
});

test("ACP permission attachment normalizes decisions through the registered provider path", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-acp-permission-path-"));
	dirs.push(cwd);
	const sessionId = `sdk-acp-permission-path-${Date.now()}`;
	const acpSessionId = "acp-session-authority";
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected bundled test model");
	const bashTool = {
		name: "bash",
		label: "bash",
		description: "Guarded fixture tool",
		parameters: z.object({ command: z.string() }),
		executeCalls: 0,
		async execute() {
			bashTool.executeCalls++;
			return { content: [{ type: "text" as const, text: "executed" }] };
		},
	} satisfies AgentTool & { executeCalls: number };
	const sessionManager = SessionManager.inMemory(cwd);
	const agentSession = new AgentSession({
		agent: new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [bashTool], messages: [] },
			streamFn: createMockModel({ responses: [] }).stream,
		}),
		sessionManager,
		settings: Settings.isolated({ "compaction.enabled": false }),
		modelRegistry: {} as never,
		toolRegistry: new Map([[bashTool.name, bashTool]]),
	});
	agentSession.setSdkPermissionMode("prompt");
	let permissionProvider: SdkPermissionProvider;
	const ctx = {
		...context(cwd, sessionId),
		setSdkPermissionProvider: (provider: SdkPermissionProvider | undefined) => {
			permissionProvider = provider!;
			agentSession.setSdkPermissionProvider(provider);
		},
	};
	process.env.GJC_NOTIFICATIONS = "1";
	start(ctx);
	const endpointFile = path.join(cwd, ".gjc", "state", "sdk", `${sessionId}.json`);
	await waitFor(() => fs.existsSync(endpointFile), "SDK endpoint");
	const endpoint = JSON.parse(fs.readFileSync(endpointFile, "utf8")) as {
		sessionId: string;
		pid: number;
		url: string;
		token: string;
	};

	let nextResponse: unknown;
	let waitForReverseAbort = false;
	let reverseAbortObserved = false;
	const reverseCalls: Array<{
		method: string;
		input: Record<string, unknown>;
		signal: AbortSignal | undefined;
	}> = [];
	const connection = {
		async request(
			method: string,
			input: Record<string, unknown>,
			options?: { cancellationSignal?: AbortSignal },
		): Promise<unknown> {
			const signal = options?.cancellationSignal;
			reverseCalls.push({ method, input, signal });
			if (!waitForReverseAbort) return nextResponse;
			const { promise, resolve } = Promise.withResolvers<unknown>();
			const observeAbort = () => {
				reverseAbortObserved = true;
				resolve({ outcome: { outcome: "cancelled" } });
			};
			if (signal?.aborted) observeAbort();
			else signal?.addEventListener("abort", observeAbort, { once: true });
			return await promise;
		},
	} as unknown as AgentSideConnection;
	const client = new SdkClient(endpoint.url, endpoint.token);
	const routedFrame = (frame: Record<string, unknown>): Record<string, unknown> => ({
		...frame,
		connectionId: client.connectionId,
	});
	const attachment: SessionAttachment = {
		sessionId: acpSessionId,
		generation: 1,
		isCurrent: () => true,
		send: async frame => client.send(routedFrame(frame)),
		sendMaintenance: () => {},
		retire: async () => {},
	};
	const adapter = new AcpSdkAdapter({
		router: {
			request: async (_sessionId: string, frame: Record<string, unknown>) =>
				await client.request(routedFrame(frame)),
		} as never,
		attachment,
		sessionId: acpSessionId,
		connection: createAcpReverseConnection(connection, acpSessionId),
		providers: [{ capability: "permission", definitions: [] }],
		heartbeatMs: 60_000,
	});
	const unsubscribe = client.onFrame(frame => adapter.acceptFrame(frame));
	await client.connect();
	await adapter.start();

	try {
		await waitFor(() => permissionProvider !== undefined, "ACP permission provider installation");
		await agentSession.setActiveToolsByName(["bash"]);
		const guardedBash = agentSession.agent.state.tools.find(tool => tool.name === "bash");
		if (!guardedBash) throw new Error("Expected guarded bash tool");
		let callNumber = 0;
		const execute = async (response: unknown, signal?: AbortSignal) => {
			nextResponse = response;
			return await guardedBash.execute(
				`call-${++callNumber}`,
				{ command: "printf guarded" },
				signal,
				undefined as never,
				undefined as never,
			);
		};

		for (const response of [
			{ outcome: { outcome: "selected", optionId: "reject_once" } },
			{ outcome: { outcome: "cancelled" } },
			{ outcome: "cancelled" },
			null,
			1,
			[],
			{},
			{ outcome: "unknown" },
			{ outcome: "selected" },
			{ outcome: "selected", optionId: 1 },
			{ outcome: "selected", optionId: "" },
			{ outcome: "selected", optionId: "unknown_option" },
		]) {
			await expect(execute(response)).rejects.toThrow();
			expect(bashTool.executeCalls).toBe(0);
		}

		waitForReverseAbort = true;
		const cancellation = new AbortController();
		const cancelledExecution = execute(undefined, cancellation.signal);
		await waitFor(() => reverseCalls.length === 13, "reverse permission cancellation request");
		cancellation.abort();
		await expect(cancelledExecution).rejects.toThrow("Permission request cancelled");
		await waitFor(() => reverseAbortObserved, "ACP reverse cancellation signal");
		expect(bashTool.executeCalls).toBe(0);
		waitForReverseAbort = false;

		await expect(execute({ outcome: { outcome: "selected", optionId: "allow_once" } })).resolves.toBeDefined();
		await expect(execute({ outcome: "selected", optionId: "allow_once" })).resolves.toBeDefined();
		expect(bashTool.executeCalls).toBe(2);
		expect(reverseCalls).toHaveLength(15);
		expect(reverseCalls.every(call => call.method === "session/request_permission")).toBe(true);
		expect(reverseCalls.every(call => call.input.sessionId === acpSessionId)).toBe(true);
		expect(reverseCalls.every(call => call.signal instanceof AbortSignal)).toBe(true);
	} finally {
		unsubscribe();
		await adapter.close();
		await client.close();
		await agentSession.dispose();
	}
});

test("SDK host routes AskUserQuestion through a live ACP form elicitation provider", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-ui-provider-"));
	dirs.push(cwd);
	const sessionId = `sdk-ui-provider-${Date.now()}`;
	process.env.GJC_NOTIFICATIONS = "1";
	start(context(cwd, sessionId));
	const endpointFile = path.join(cwd, ".gjc", "state", "sdk", `${sessionId}.json`);
	await waitFor(() => fs.existsSync(endpointFile), "SDK endpoint");
	const endpoint = JSON.parse(fs.readFileSync(endpointFile, "utf8")) as { url: string; token: string };
	const socket = new WebSocket(`${endpoint.url}/?token=${encodeURIComponent(endpoint.token)}`);
	sockets.push(socket);
	const frames: Record<string, unknown>[] = [];
	socket.addEventListener("message", event => frames.push(JSON.parse(String(event.data))));
	await new Promise<void>((resolve, reject) => {
		socket.addEventListener("open", () => resolve(), { once: true });
		socket.addEventListener("error", () => reject(new Error("WS error")), { once: true });
	});
	await waitFor(() => frames.some(frame => frame.type === "hello"), "SDK hello");
	const priorAnswerSource = { awaitAnswer: async () => "fallback" };
	const disposePriorAnswerSource = registerAskAnswerSource(sessionId, priorAnswerSource);
	expect(getAskAnswerSource(sessionId)).toBe(priorAnswerSource);
	const connectionId = String(frames.find(frame => frame.type === "hello")?.connectionId);
	socket.send(
		JSON.stringify({
			type: "register_provider",
			id: "ui",
			connectionId,
			capability: "ui",
			definitions: [],
		}),
	);
	await waitFor(
		() => frames.some(frame => frame.type === "register_provider_result" && frame.id === "ui"),
		"UI provider registration",
	);
	const requested = getAskAnswerSource(sessionId)!.awaitAnswerRequest!(
		{ question: "Choose one", options: ["First", "Second"], interaction: "selector", controls: [] },
		new AbortController().signal,
	);
	await waitFor(() => frames.some(frame => frame.type === "reverse_request"), "reverse elicitation request");
	const request = frames.find(frame => frame.type === "reverse_request")!;
	expect(request).toMatchObject({
		payload: {
			method: "ui.elicit",
			payload: {
				mode: "form",
				message: "Choose one",
				requestedSchema: {
					type: "object",
					properties: {
						value: {
							type: "string",
							oneOf: [
								{ const: "option:0", title: "First" },
								{ const: "option:1", title: "Second" },
							],
						},
					},
					required: ["value"],
				},
			},
		},
	});
	socket.send(
		JSON.stringify({
			type: "reverse_response",
			id: request.id,
			connectionId,
			leaseId: request.leaseId,
			ok: true,
			result: { action: "accept", content: { value: "option:1" } },
		}),
	);
	expect(await requested).toBe("Second");
	const freeText = getAskAnswerSource(sessionId)!.awaitAnswerRequest!(
		{ question: "Explain", options: [], interaction: "custom_editor", controls: [] },
		new AbortController().signal,
	);
	await waitFor(
		() => frames.filter(frame => frame.type === "reverse_request").length >= 2,
		"reverse free-text elicitation",
	);
	const freeTextRequest = frames.filter(frame => frame.type === "reverse_request")[1]!;
	expect(freeTextRequest).toMatchObject({
		payload: {
			method: "ui.elicit",
			payload: {
				mode: "form",
				message: "Explain",
				requestedSchema: {
					type: "object",
					properties: { value: { type: "string" } },
					required: ["value"],
				},
			},
		},
	});
	socket.send(
		JSON.stringify({
			type: "reverse_response",
			id: freeTextRequest.id,
			connectionId,
			leaseId: freeTextRequest.leaseId,
			ok: true,
			result: { action: "accept", content: { value: "Because" } },
		}),
	);
	expect(await freeText).toBe("Because");

	const navigation = getAskAnswerSource(sessionId)!.awaitAnswerRequest!(
		{
			question: "Continue",
			options: [],
			interaction: "selector",
			controls: [{ id: "navigation_forward", kind: "navigation", label: "Done", enabled: true }],
		},
		new AbortController().signal,
	);
	await waitFor(
		() => frames.filter(frame => frame.type === "reverse_request").length >= 3,
		"reverse navigation elicitation",
	);
	const navigationRequest = frames.filter(frame => frame.type === "reverse_request")[2]!;
	expect(navigationRequest).toMatchObject({
		payload: {
			payload: {
				requestedSchema: {
					properties: {
						value: {
							type: "string",
							oneOf: [{ const: "control:navigation_forward", title: "Done" }],
						},
					},
				},
			},
		},
	});
	socket.send(
		JSON.stringify({
			type: "reverse_response",
			id: navigationRequest.id,
			connectionId,
			leaseId: navigationRequest.leaseId,
			ok: true,
			result: { action: "accept", content: { value: "control:navigation_forward" } },
		}),
	);
	const navigationReceipt = await navigation;
	expect(navigationReceipt).toMatchObject({
		source: "remote",
		interaction: { kind: "control", controlId: "navigation_forward" },
	});
	if (!navigationReceipt || typeof navigationReceipt === "string")
		throw new Error("Expected a typed navigation receipt.");
	expect(await navigationReceipt.settle({ kind: "commit" })).toEqual({
		kind: "committed",
		ack: { status: "failed", reason: "unsupported" },
	});
	const aborted = new AbortController();
	const cancelled = getAskAnswerSource(sessionId)!.awaitAnswerRequest!(
		{ question: "Cancel me", options: ["Wait"], interaction: "selector", controls: [] },
		aborted.signal,
	);
	const cancelledOutcome = cancelled.catch(error => error);
	await waitFor(
		() => frames.filter(frame => frame.type === "reverse_request").length >= 4,
		"abortable reverse elicitation",
	);
	const cancelledRequest = frames.filter(frame => frame.type === "reverse_request")[3]!;
	aborted.abort();
	await waitFor(
		() => frames.some(frame => frame.type === "reverse_cancel" && frame.id === cancelledRequest.id),
		"reverse elicitation cancellation",
	);
	expect(await cancelledOutcome).toMatchObject({ message: "request_cancelled" });

	socket.close();
	await waitFor(() => getAskAnswerSource(sessionId) === priorAnswerSource, "prior UI answer source restoration");
	disposePriorAnswerSource();
});

test("SDK ACP form elicitation remains preferred after /notify on and falls back on provider disconnect", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-ui-provider-notify-priority-"));
	dirs.push(cwd);
	const host = await startProductionSdkHost(cwd, { notificationsInitiallyEnabled: false });
	const { sessionId, endpoint } = host;
	try {
		expect(getAskAnswerSource(sessionId)).toBeUndefined();
		const frames: Record<string, unknown>[] = [];
		const socket = new WebSocket(`${endpoint.url}/?token=${encodeURIComponent(endpoint.token)}`);
		sockets.push(socket);
		socket.addEventListener("message", event => frames.push(JSON.parse(String(event.data))));
		await new Promise<void>((resolve, reject) => {
			socket.addEventListener("open", () => resolve(), { once: true });
			socket.addEventListener("error", () => reject(new Error("WS error")), { once: true });
		});
		await waitFor(() => frames.some(frame => frame.type === "hello"), "SDK hello");
		const connectionId = String(frames.find(frame => frame.type === "hello")?.connectionId);
		socket.send(
			JSON.stringify({
				type: "register_provider",
				id: "ui",
				connectionId,
				capability: "ui",
				definitions: [],
			}),
		);
		await waitFor(
			() => frames.some(frame => frame.type === "register_provider_result" && frame.id === "ui"),
			"UI provider registration",
		);
		const priorNotifications = process.env.GJC_NOTIFICATIONS;
		process.env.GJC_NOTIFICATIONS = "1";
		try {
			await host.runCommand("/notify on");
		} finally {
			if (priorNotifications === undefined) delete process.env.GJC_NOTIFICATIONS;
			else process.env.GJC_NOTIFICATIONS = priorNotifications;
		}

		const protocolAnswerSource = getAskAnswerSource(sessionId);
		expect(protocolAnswerSource).toBeDefined();
		const protocolAnswer = protocolAnswerSource!.awaitAnswerRequest!(
			{
				question: "Choose the protocol answer",
				options: ["First", "Second"],
				interaction: "selector",
				controls: [],
			},
			new AbortController().signal,
		);
		await waitFor(() => frames.some(frame => frame.type === "reverse_request"), "protocol elicitation request");
		const protocolRequest = frames.find(frame => frame.type === "reverse_request")!;
		expect(protocolRequest).toMatchObject({
			payload: {
				method: "ui.elicit",
				payload: { mode: "form", message: "Choose the protocol answer" },
			},
		});
		socket.send(
			JSON.stringify({
				type: "reverse_response",
				id: protocolRequest.id,
				connectionId,
				leaseId: protocolRequest.leaseId,
				ok: true,
				result: { action: "accept", content: { value: "option:1" } },
			}),
		);
		expect(await protocolAnswer).toBe("Second");

		await closeSocket(socket);
		await waitFor(() => {
			const selected = getAskAnswerSource(sessionId);
			return selected !== undefined && selected !== protocolAnswerSource;
		}, "interactive answer source restoration");
		const fallbackFrames: Record<string, unknown>[] = [];
		const fallbackSocket = new WebSocket(`${endpoint.url}/?token=${encodeURIComponent(endpoint.token)}`);
		sockets.push(fallbackSocket);
		fallbackSocket.addEventListener("message", event => fallbackFrames.push(JSON.parse(String(event.data))));
		await new Promise<void>((resolve, reject) => {
			fallbackSocket.addEventListener("open", () => resolve(), { once: true });
			fallbackSocket.addEventListener("error", () => reject(new Error("WS error")), { once: true });
		});
		await waitFor(() => fallbackFrames.some(frame => frame.type === "hello"), "fallback SDK hello");
		const interactiveAnswerSource = getAskAnswerSource(sessionId);
		expect(interactiveAnswerSource).toBeDefined();
		expect(interactiveAnswerSource).not.toBe(protocolAnswerSource);
		const fallbackAnswer = interactiveAnswerSource!.awaitAnswer("Choose the interactive fallback", [
			"Continue",
			"Stop",
		]);
		await waitFor(
			() => fallbackFrames.some(frame => frame.type === "action_needed" && frame.kind === "ask"),
			"interactive fallback presentation",
		);
		const fallbackAction = fallbackFrames.find(frame => frame.type === "action_needed" && frame.kind === "ask")!;
		fallbackSocket.send(
			JSON.stringify({
				type: "control_command",
				sessionId,
				token: endpoint.token,
				requestId: "interactive-fallback-answer",
				command: {
					type: "control_request",
					id: "interactive-fallback-answer",
					operation: "ask.answer",
					input: { id: fallbackAction.id, answer: 0 },
					idempotencyKey: "interactive-fallback-answer",
				},
			}),
		);
		await waitFor(
			() =>
				fallbackFrames.some(
					frame => frame.type === "control_command_result" && frame.requestId === "interactive-fallback-answer",
				),
			"interactive fallback answer",
		);
		expect(await fallbackAnswer).toBe("Continue");
		expect(frames.filter(frame => frame.type === "reverse_request")).toHaveLength(1);
	} finally {
		await host.stop();
	}
});
test("rejects malformed provider definitions without replacing a valid tools registry", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-provider-validation-"));
	dirs.push(cwd);
	const sessionId = `sdk-provider-validation-${Date.now()}`;
	process.env.GJC_NOTIFICATIONS = "1";
	start(context(cwd, sessionId));
	const endpointFile = path.join(cwd, ".gjc", "state", "sdk", `${sessionId}.json`);
	await waitFor(() => fs.existsSync(endpointFile), "SDK endpoint");
	const endpoint = JSON.parse(fs.readFileSync(endpointFile, "utf8")) as { url: string; token: string };
	const frames: Record<string, unknown>[] = [];
	const socket = new WebSocket(`${endpoint.url}/?token=${encodeURIComponent(endpoint.token)}`);
	sockets.push(socket);
	socket.addEventListener("message", event => frames.push(JSON.parse(String(event.data))));
	await new Promise<void>((resolve, reject) => {
		socket.addEventListener("open", () => resolve(), { once: true });
		socket.addEventListener("error", () => reject(new Error("WS error")), { once: true });
	});
	await waitFor(() => frames.some(frame => frame.type === "hello"), "SDK hello");
	const hello = frames.find(frame => frame.type === "hello")!;
	const connectionId = String(hello.connectionId);
	const sendProvider = (id: string, capability: string, definitions: unknown) =>
		socket.send(JSON.stringify({ type: "register_provider", id, connectionId, capability, definitions }));

	const validTool = { name: "host_read", description: "Read a host file.", parameters: {} };
	sendProvider("valid-tool", "host_tools", [validTool]);
	await waitFor(() => frames.some(frame => frame.type === "register_provider_result"), "valid tools registration");
	sendProvider("invalid-tool", "host_tools", [{ name: "", description: "missing name", parameters: {} }]);
	await waitFor(
		() => frames.some(frame => frame.type === "reverse_response" && frame.id === "invalid-tool"),
		"invalid tools rejection",
	);
	expect(frames.find(frame => frame.type === "reverse_response" && frame.id === "invalid-tool")).toMatchObject({
		ok: false,
		error: { code: "invalid_input" },
	});

	sendProvider("valid-uri", "host_uri", [{ scheme: "workspace+local" }]);
	await waitFor(
		() => frames.filter(frame => frame.type === "register_provider_result").length === 2,
		"valid URI registration",
	);
	sendProvider("invalid-uri", "host_uri", [{ scheme: "https" }]);
	await waitFor(
		() => frames.some(frame => frame.type === "reverse_response" && frame.id === "invalid-uri"),
		"invalid URI rejection",
	);
	expect(frames.find(frame => frame.type === "reverse_response" && frame.id === "invalid-uri")).toMatchObject({
		ok: false,
		error: { code: "invalid_input" },
	});

	socket.send(
		JSON.stringify({
			type: "control_command",
			sessionId,
			token: endpoint.token,
			requestId: "tools",
			command: { type: "query_request", id: "tools", query: "tools.list" },
		}),
	);
	await waitFor(
		() => frames.some(frame => frame.type === "control_command_result" && frame.requestId === "tools"),
		"tools query",
	);
	const tools = JSON.parse(
		String(frames.find(frame => frame.type === "control_command_result" && frame.requestId === "tools")?.message),
	);
	expect(tools).toMatchObject({ ok: true, page: { items: [validTool] } });
});

test("SDK host replay gaps are generation-scoped and sequence gaps remain coherent", async () => {
	let receive!: (connectionId: string, frame: Record<string, unknown>) => void;
	const sent: Array<Record<string, unknown>> = [];
	const host = new SessionSdkHost({
		sessionId: "replay-gaps",
		stateRoot: "/tmp/replay-gaps",
		token: "test-token",
		sendFrame: (_connectionId, frame) => {
			sent.push(frame);
			return "written";
		},
		onFrame: handler => {
			receive = handler;
			return () => {};
		},
	});
	await host.start();
	const replay = (id: string, sinceGeneration: number, sinceSeq: number) => {
		receive("client", { type: "event_replay", id, sinceGeneration, sinceSeq });
	};

	replay("normal", host.generation, 0);
	await waitFor(() => sent.some(frame => frame.id === "normal"), "normal replay");
	expect(sent.find(frame => frame.id === "normal")).toMatchObject({
		ok: true,
		events: [{ type: "event", name: "session_ready", seq: 1 }],
	});

	const previousGeneration = host.generation;
	host.events.restart();
	host.emitEvent({ name: "after_restart" });
	replay("reset", previousGeneration, 1);
	await waitFor(() => sent.some(frame => frame.id === "reset"), "generation reset replay");
	expect(sent.find(frame => frame.id === "reset")).toMatchObject({
		ok: true,
		generation: previousGeneration + 1,
		events: [{ type: "event", name: "after_restart", seq: 1 }],
		gap: {
			kind: "generation_reset",
			fromGeneration: previousGeneration,
			toGeneration: previousGeneration + 1,
			resyncQueries: ["Q01", "Q02", "Q03"],
		},
	});

	for (let index = 0; index < 256; index++) host.emitEvent({ name: `overflow-${index}` });
	replay("overflow", host.generation, 0);
	await waitFor(() => sent.some(frame => frame.id === "overflow"), "sequence gap replay");
	const overflow = sent.find(frame => frame.id === "overflow")!;
	expect(overflow).toMatchObject({
		ok: true,
		gap: { kind: "sequence_gap", fromSeq: 1, toSeq: 1, resyncQueries: ["Q01", "Q02", "Q03"] },
	});
	const gap = overflow.gap as { fromSeq: number; toSeq: number };
	expect(gap.fromSeq).toBeLessThanOrEqual(gap.toSeq);
	await host.stop();
});

test("Q17 returns resource_gone without readable assistant text and reads a completed persisted turn after reopen", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-last-assistant-"));
	dirs.push(cwd);
	const original = SessionManager.create(cwd, cwd);
	await original.flush();
	const sessionFile = original.getSessionFile();
	if (!sessionFile) throw new Error("Expected persisted session file");
	await original.close();
	const sessionManager = await SessionManager.open(sessionFile, cwd);
	const sessionId = sessionManager.getSessionId();
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected bundled test model");
	const authStorage = await AuthStorage.create(path.join(cwd, "auth.db"));
	authStorage.setRuntimeApiKey(model.provider, "test-key");
	const agentSession = new AgentSession({
		agent: new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: createMockModel({ responses: [{ content: ["Completed persisted reply"] }] }).stream,
		}),
		sessionManager,
		settings: Settings.isolated({ "compaction.enabled": false }),
		modelRegistry: new ModelRegistry(authStorage, path.join(cwd, "models.yml")),
	});
	agentSession.subscribe(() => {});
	const sessionContext = {
		...context(cwd, sessionId),
		sessionManager,
		getTranscript: () => agentSession.getTranscript(),
	};
	const handlers = start(
		sessionContext,
		undefined,
		(content, options) => agentSession.prompt(String(content), options),
		true,
	);
	const endpointFile = path.join(cwd, ".gjc", "state", "sdk", `${sessionId}.json`);
	await waitFor(() => fs.existsSync(endpointFile), "SDK endpoint");
	const endpoint = JSON.parse(fs.readFileSync(endpointFile, "utf8")) as { url: string; token: string };
	const frames: Record<string, unknown>[] = [];
	const socket = new WebSocket(`${endpoint.url}/?token=${encodeURIComponent(endpoint.token)}`);
	sockets.push(socket);
	socket.addEventListener("message", event => frames.push(JSON.parse(String(event.data))));
	await new Promise<void>((resolve, reject) => {
		socket.addEventListener("open", () => resolve(), { once: true });
		socket.addEventListener("error", () => reject(new Error("WS error")), { once: true });
	});
	const query = (requestId: string) =>
		socket.send(
			JSON.stringify({
				type: "control_command",
				sessionId,
				token: endpoint.token,
				requestId,
				command: { type: "query_request", id: requestId, query: "Q17" },
			}),
		);
	query("before");
	await waitFor(
		() =>
			frames.some(
				frame => frame.type === "control_command_result" && frame.requestId === "before" && frame.status === "ok",
			),
		"empty Q17 resource_gone response",
	);
	expect(
		JSON.parse(
			String(frames.find(frame => frame.type === "control_command_result" && frame.requestId === "before")?.message),
		),
	).toMatchObject({ ok: false, error: { code: "resource_gone" } });
	socket.send(
		JSON.stringify({
			type: "control_request",
			id: "completed-turn",
			operation: "turn.prompt",
			input: { text: "Persist a real assistant response" },
		}),
	);
	await waitFor(
		() => frames.some(frame => frame.type === "control_response" && frame.id === "completed-turn"),
		"completed turn acknowledgement",
	);
	await agentSession.waitForIdle();
	await sessionManager.flush();
	expect(sessionManager.getBranch()).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				type: "message",
				message: expect.objectContaining({ role: "assistant" }),
			}),
		]),
	);
	const completedAssistant = sessionManager
		.getBranch()
		.findLast(entry => entry.type === "message" && entry.message.role === "assistant");
	if (!completedAssistant || completedAssistant.type !== "message" || completedAssistant.message.role !== "assistant")
		throw new Error("Expected persisted assistant response");
	sessionManager.appendMessage({
		...completedAssistant.message,
		content: [{ type: "toolCall", id: "trailing-tool", name: "read", arguments: {} }],
		stopReason: "toolUse",
		timestamp: Date.now(),
	});
	await sessionManager.flush();
	query("after");
	await waitFor(
		() =>
			frames.some(
				frame => frame.type === "control_command_result" && frame.requestId === "after" && frame.status === "ok",
			),
		"completed-turn Q17 response",
	);
	expect(
		JSON.parse(
			String(frames.find(frame => frame.type === "control_command_result" && frame.requestId === "after")?.message),
		),
	).toMatchObject({
		ok: true,
		page: { items: ["Completed persisted reply"] },
	});
	await closeSocket(socket);
	await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, sessionContext);
	await agentSession.dispose();
	await sessionManager.close();

	const reopenedSessionManager = await SessionManager.open(sessionFile, cwd);
	const reopenedAgentSession = new AgentSession({
		agent: new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: createMockModel({ responses: [] }).stream,
		}),
		sessionManager: reopenedSessionManager,
		settings: Settings.isolated({ "compaction.enabled": false }),
		modelRegistry: new ModelRegistry(authStorage, path.join(cwd, "models.yml")),
	});
	const reopenedSessionContext = {
		...context(cwd, sessionId),
		sessionManager: reopenedSessionManager,
		getTranscript: () => reopenedAgentSession.getTranscript(),
	};
	const reopenedHandlers = start(reopenedSessionContext);
	await waitFor(() => fs.existsSync(endpointFile), "reopened SDK endpoint");
	const reopenedEndpoint = JSON.parse(fs.readFileSync(endpointFile, "utf8")) as { url: string; token: string };
	const reopenedFrames: Record<string, unknown>[] = [];
	const reopenedSocket = new WebSocket(`${reopenedEndpoint.url}/?token=${encodeURIComponent(reopenedEndpoint.token)}`);
	sockets.push(reopenedSocket);
	reopenedSocket.addEventListener("message", event => reopenedFrames.push(JSON.parse(String(event.data))));
	await new Promise<void>((resolve, reject) => {
		reopenedSocket.addEventListener("open", () => resolve(), { once: true });
		reopenedSocket.addEventListener("error", () => reject(new Error("reopened WS error")), { once: true });
	});
	reopenedSocket.send(
		JSON.stringify({
			type: "control_command",
			sessionId,
			token: reopenedEndpoint.token,
			requestId: "reopened",
			command: { type: "query_request", id: "reopened", query: "Q17" },
		}),
	);
	await waitFor(
		() =>
			reopenedFrames.some(
				frame => frame.type === "control_command_result" && frame.requestId === "reopened" && frame.status === "ok",
			),
		"reopened completed-turn Q17 response",
	);
	expect(
		JSON.parse(
			String(
				reopenedFrames.find(frame => frame.type === "control_command_result" && frame.requestId === "reopened")
					?.message,
			),
		),
	).toMatchObject({
		ok: true,
		page: { items: ["Completed persisted reply"] },
	});
	await closeSocket(reopenedSocket);
	await reopenedHandlers.get("session_shutdown")?.({ type: "session_shutdown" }, reopenedSessionContext);
	await reopenedAgentSession.dispose();
	await reopenedSessionManager.close();
	authStorage.close();
	closeModelCache(path.join(cwd, "models.db"));
	handlers.clear();
	reopenedHandlers.clear();
});

test("terminal shutdown removes session snapshot spills", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-host-snapshots-"));
	dirs.push(cwd);
	const sessionId = `snapshots-${Date.now()}`;
	const handlers = start(context(cwd, sessionId));
	const endpointFile = path.join(cwd, ".gjc", "state", "sdk", `${sessionId}.json`);
	await waitFor(() => fs.existsSync(endpointFile), "SDK endpoint");
	const endpoint = JSON.parse(fs.readFileSync(endpointFile, "utf8")) as { url: string; token: string };
	const socket = new WebSocket(`${endpoint.url}/?token=${encodeURIComponent(endpoint.token)}`);
	sockets.push(socket);
	const frames: Record<string, unknown>[] = [];
	socket.addEventListener("message", event => frames.push(JSON.parse(String(event.data))));
	await new Promise<void>((resolve, reject) => {
		socket.addEventListener("open", () => resolve(), { once: true });
		socket.addEventListener("error", () => reject(new Error("WS error")), { once: true });
	});
	socket.send(
		JSON.stringify({
			type: "control_command",
			sessionId,
			token: endpoint.token,
			requestId: "snapshot-query",
			command: { type: "query_request", id: "snapshot-query", query: "Q01" },
		}),
	);
	await waitFor(
		() => frames.some(frame => frame.type === "control_command_result" && frame.requestId === "snapshot-query"),
		"snapshot query response",
	);
	const snapshotDirectory = path.join(cwd, ".gjc", "state", "sdk", "snapshots", sessionId);
	await waitFor(() => fs.existsSync(snapshotDirectory), "snapshot spill");
	await handlers.get("session_shutdown")!({ type: "session_shutdown" }, context(cwd, sessionId));
	await waitFor(() => !fs.existsSync(snapshotDirectory), "snapshot spill removal");
});

test("diff queries return typed errors outside a Git working tree", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-host-no-git-"));
	dirs.push(cwd);
	const sessionId = `no-git-${Date.now()}`;
	const handlers = start(context(cwd, sessionId));
	const endpointFile = path.join(cwd, ".gjc", "state", "sdk", `${sessionId}.json`);
	await waitFor(() => fs.existsSync(endpointFile), "SDK endpoint");
	const endpoint = JSON.parse(fs.readFileSync(endpointFile, "utf8")) as { url: string; token: string };
	const socket = new WebSocket(`${endpoint.url}/?token=${encodeURIComponent(endpoint.token)}`);
	sockets.push(socket);
	const frames: Record<string, unknown>[] = [];
	socket.addEventListener("message", event => frames.push(JSON.parse(String(event.data))));
	await new Promise<void>((resolve, reject) => {
		socket.addEventListener("open", () => resolve(), { once: true });
		socket.addEventListener("error", () => reject(new Error("WS error")), { once: true });
	});
	for (const query of ["Q06", "Q07", "Q08"]) {
		socket.send(
			JSON.stringify({
				type: "control_command",
				sessionId,
				token: endpoint.token,
				requestId: query,
				command: { type: "query_request", id: query, query },
			}),
		);
	}
	await waitFor(
		() =>
			["Q06", "Q07", "Q08"].every(query =>
				frames.some(frame => frame.type === "control_command_result" && frame.requestId === query),
			),
		"typed diff responses",
	);
	for (const query of ["Q06", "Q07", "Q08"]) {
		const message = frames.find(
			frame => frame.type === "control_command_result" && frame.requestId === query,
		)?.message;
		expect(JSON.parse(String(message))).toMatchObject({ ok: false, error: { code: "not_git_repository" } });
	}
	await handlers.get("session_shutdown")!({ type: "session_shutdown" }, context(cwd, sessionId));
});

test("diff queries return a bounded error for oversized diffs", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-host-large-diff-"));
	dirs.push(cwd);
	for (const args of [
		["init", "-q"],
		["config", "user.email", "test@example.com"],
		["config", "user.name", "Test"],
	]) {
		expect(Bun.spawnSync(["git", ...args], { cwd }).exitCode).toBe(0);
	}
	fs.writeFileSync(path.join(cwd, "large.txt"), "seed\n");
	expect(Bun.spawnSync(["git", "add", "large.txt"], { cwd }).exitCode).toBe(0);
	expect(Bun.spawnSync(["git", "commit", "-qm", "seed"], { cwd }).exitCode).toBe(0);
	fs.writeFileSync(path.join(cwd, "large.txt"), "x".repeat(1024 * 1024 + 1));
	const sessionId = `large-diff-${Date.now()}`;
	const handlers = start(context(cwd, sessionId));
	const endpointFile = path.join(cwd, ".gjc", "state", "sdk", `${sessionId}.json`);
	await waitFor(() => fs.existsSync(endpointFile), "SDK endpoint");
	const endpoint = JSON.parse(fs.readFileSync(endpointFile, "utf8")) as { url: string; token: string };
	const socket = new WebSocket(`${endpoint.url}/?token=${encodeURIComponent(endpoint.token)}`);
	sockets.push(socket);
	const frames: Record<string, unknown>[] = [];
	socket.addEventListener("message", event => frames.push(JSON.parse(String(event.data))));
	await new Promise<void>((resolve, reject) => {
		socket.addEventListener("open", () => resolve(), { once: true });
		socket.addEventListener("error", () => reject(new Error("WS error")), { once: true });
	});
	socket.send(
		JSON.stringify({
			type: "control_command",
			sessionId,
			token: endpoint.token,
			requestId: "large-diff",
			command: { type: "query_request", id: "large-diff", query: "Q06" },
		}),
	);
	await waitFor(
		() => frames.some(frame => frame.type === "control_command_result" && frame.requestId === "large-diff"),
		"bounded diff response",
	);
	const message = frames.find(
		frame => frame.type === "control_command_result" && frame.requestId === "large-diff",
	)?.message;
	expect(JSON.parse(String(message))).toMatchObject({ ok: false, error: { code: "diff_too_large" } });
	await handlers.get("session_shutdown")!({ type: "session_shutdown" }, context(cwd, sessionId));
});

test("SDK host honors disable opt-out and excludes subagent sessions", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-host-gate-"));
	dirs.push(cwd);
	process.env.GJC_SDK_DISABLE = "1";
	start(context(cwd, "disabled"));
	await Bun.sleep(100);
	expect(fs.existsSync(path.join(cwd, ".gjc", "state", "sdk", "disabled.json"))).toBe(false);
	delete process.env.GJC_SDK_DISABLE;
	start(context(cwd, "subagent", "sub"));
	await Bun.sleep(100);
	expect(fs.existsSync(path.join(cwd, ".gjc", "state", "sdk", "subagent.json"))).toBe(false);
});

test("context.get reports live streaming state and typed queue depths without notifications", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-host-live-"));
	dirs.push(cwd);
	const sessionId = `live-${Date.now()}`;
	// Notifications intentionally NOT configured: SDK-only hosting.
	const live: { idle?: boolean; counts?: { steering: number; followUp: number; nextTurn: number } } = {};
	const handlers = start(context(cwd, sessionId, "main", live));
	const endpointFile = path.join(cwd, ".gjc", "state", "sdk", `${sessionId}.json`);
	await waitFor(() => fs.existsSync(endpointFile), "SDK endpoint");
	const endpoint = JSON.parse(fs.readFileSync(endpointFile, "utf8")) as { url: string; token: string };
	const frames: Record<string, unknown>[] = [];
	const socket = new WebSocket(`${endpoint.url}/?token=${encodeURIComponent(endpoint.token)}`);
	sockets.push(socket);
	socket.addEventListener("message", event => frames.push(JSON.parse(String(event.data))));
	await new Promise<void>((resolve, reject) => {
		socket.addEventListener("open", () => resolve(), { once: true });
		socket.addEventListener("error", () => reject(new Error("WS error")), { once: true });
	});
	await Bun.sleep(100);
	const queryContext = async (requestId: string): Promise<Record<string, unknown>> => {
		socket.send(
			JSON.stringify({
				type: "control_command",
				sessionId,
				token: endpoint.token,
				requestId,
				command: { type: "query_request", id: requestId, query: "context.get" },
			}),
		);
		await waitFor(
			() => frames.some(frame => frame.type === "control_command_result" && frame.requestId === requestId),
			`context response ${requestId}`,
		);
		const message = frames.find(
			frame => frame.type === "control_command_result" && frame.requestId === requestId,
		)?.message;
		const parsed = JSON.parse(String(message)) as { page: { items: Record<string, unknown>[] } };
		return parsed.page.items[0] as Record<string, unknown>;
	};

	// Idle, empty queues.
	const idle = await queryContext("ctx-idle");
	expect(idle).toMatchObject({ isStreaming: false, steeringQueueDepth: 0, followupQueueDepth: 0 });

	// Streaming via agent_start (notifications off — rt.busy must still track).
	const sessionContext = context(cwd, sessionId, "main", live);
	void handlers.get("agent_start")?.({ type: "agent_start" }, sessionContext);
	const streaming = await queryContext("ctx-streaming");
	expect(streaming).toMatchObject({ isStreaming: true });

	// Typed queue depths straight from the counted seam.
	live.counts = { steering: 2, followUp: 1, nextTurn: 3 };
	const queued = await queryContext("ctx-queued");
	expect(queued).toMatchObject({ steeringQueueDepth: 2, followupQueueDepth: 1 });

	// Settled via agent_end.
	void handlers.get("agent_end")?.({ type: "agent_end" }, sessionContext);
	live.counts = { steering: 0, followUp: 0, nextTurn: 0 };
	const settled = await queryContext("ctx-settled");
	expect(settled).toMatchObject({ isStreaming: false, steeringQueueDepth: 0, followupQueueDepth: 0 });
});

test("SDK endpoint applies typed skill, plan, goal, and config controls with observable readback", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-host-typed-controls-"));
	dirs.push(cwd);
	const sessionId = `typed-controls-${Date.now()}`;
	let plan: { enabled: boolean; planFilePath: string } | undefined;
	let goal: { enabled: boolean; goal: { objective: string; status: string } } | undefined;
	const activeSkills: Array<{ name: string; args?: string }> = [];
	const ctx = {
		...context(cwd, sessionId),
		getSkillState: () => activeSkills,
		getGoalState: () => goal,
		invokeSkill: async (name: string, args?: string) => {
			if (name !== "fixture-skill")
				throw Object.assign(new Error(`Skill ${name} was not found.`), { code: "invalid_input" });
			activeSkills.push({ name, args });
			return { name, args };
		},
		setPlanMode: (on: boolean) => {
			plan = on ? { enabled: true, planFilePath: "local://PLAN.md" } : undefined;
			return plan;
		},
		operateGoal: async (op: string, objective?: string) => {
			if (op === "create") {
				goal = { enabled: true, goal: { objective: objective ?? "", status: "active" } };
				return goal;
			}
			if (op === "get") return goal;
			throw Object.assign(new Error(`Unsupported goal op ${op}.`), { code: "invalid_input" });
		},
		sdkBindings: () => [
			"cycleModel",
			"cycleThinkingLevel",
			"setQueueMode",
			"getSkillState",
			"getConfigItems",
			"getBranchCandidates",
			"getExtensions",
			"invokeSkill",
			"setPlanMode",
			"operateGoal",
		],
	};
	const configWrites: Array<[string, unknown]> = [];
	const settings = {
		get: () => undefined,
		set: (key: string, value: unknown) => configWrites.push([key, value]),
	} as unknown as Settings;

	process.env.GJC_NOTIFICATIONS = "1";
	start(ctx, settings);

	const endpointFile = path.join(cwd, ".gjc", "state", "sdk", `${sessionId}.json`);
	await waitFor(() => fs.existsSync(endpointFile), "SDK endpoint");
	const endpoint = JSON.parse(fs.readFileSync(endpointFile, "utf8")) as { url: string; token: string };
	const socket = new WebSocket(`${endpoint.url}/?token=${encodeURIComponent(endpoint.token)}`);
	sockets.push(socket);
	const frames: Record<string, unknown>[] = [];
	socket.addEventListener("message", event => frames.push(JSON.parse(String(event.data))));
	await new Promise<void>((resolve, reject) => {
		socket.addEventListener("open", () => resolve(), { once: true });
		socket.addEventListener("error", () => reject(new Error("WS error")), { once: true });
	});
	const request = async (id: string, command: Record<string, unknown>): Promise<Record<string, unknown>> => {
		socket.send(
			JSON.stringify({ type: "control_command", sessionId, token: endpoint.token, requestId: id, command }),
		);
		await waitFor(
			() => frames.some(frame => frame.type === "control_command_result" && frame.requestId === id),
			`${id} response`,
		);
		return JSON.parse(
			String(frames.find(frame => frame.type === "control_command_result" && frame.requestId === id)?.message),
		) as Record<string, unknown>;
	};
	expect(
		await request("skill", {
			type: "control_request",
			id: "skill",
			operation: "skill.invoke",
			input: { name: "fixture-skill", args: "run" },
		}),
	).toMatchObject({ ok: true });
	expect(await request("q11", { type: "query_request", id: "q11", query: "Q11" })).toMatchObject({
		ok: true,
		page: { items: [{ name: "fixture-skill", args: "run" }] },
	});
	expect(
		await request("plan", { type: "control_request", id: "plan", operation: "mode.plan.set", input: { on: true } }),
	).toMatchObject({ ok: true, result: { state: { enabled: true, planFilePath: "local://PLAN.md" } } });
	expect(
		await request("goal", {
			type: "control_request",
			id: "goal",
			operation: "mode.goal.operate",
			input: { op: "create", objective: "Ship it" },
		}),
	).toMatchObject({ ok: true });
	expect(await request("q04", { type: "query_request", id: "q04", query: "Q04" })).toMatchObject({
		ok: true,
		page: { items: [{ enabled: true, goal: { objective: "Ship it", status: "active" } }] },
	});

	expect(
		await request("skill-error", {
			type: "control_request",
			id: "skill-error",
			operation: "skill.invoke",
			input: { name: "missing" },
		}),
	).toEqual({
		type: "control_response",
		id: "skill-error",
		ok: false,
		error: { code: "invalid_input", message: "Skill missing was not found." },
	});
	expect(
		await request("secret-error", {
			type: "control_request",
			id: "secret-error",
			operation: "config.patch",
			input: { patch: { apiToken: "secret" } },
		}),
	).toEqual({
		type: "control_response",
		id: "secret-error",
		ok: false,
		error: { code: "invalid_input", message: "config.patch rejects secret fields at the SDK host." },
	});
	expect(
		await request("nested-secret-error", {
			type: "control_request",
			id: "nested-secret-error",
			operation: "config.patch",
			input: { patch: { theme: "dark", display: { credentials: { apiKey: "secret" } } } },
		}),
	).toEqual({
		type: "control_response",
		id: "nested-secret-error",
		ok: false,
		error: { code: "invalid_input", message: "config.patch rejects secret fields at the SDK host." },
	});
	// Invalid values must be rejected before any durable write: a numeric
	// cycleOrder would later break getRoleModelCycleCandidateCount()'s for...of.
	expect(
		await request("invalid-type-error", {
			type: "control_request",
			id: "invalid-type-error",
			operation: "config.patch",
			input: { patch: { cycleOrder: 1 } },
		}),
	).toEqual({
		type: "control_response",
		id: "invalid-type-error",
		ok: false,
		error: {
			code: "invalid_input",
			message: "config.patch rejects invalid settings: cycleOrder (Expected array.)",
		},
	});
	// Unknown paths are rejected the same way, with no durable side effects.
	expect(
		await request("unknown-path-error", {
			type: "control_request",
			id: "unknown-path-error",
			operation: "config.patch",
			input: { patch: { noSuchSetting: true } },
		}),
	).toEqual({
		type: "control_response",
		id: "unknown-path-error",
		ok: false,
		error: {
			code: "invalid_input",
			message: "config.patch rejects invalid settings: noSuchSetting (Setting is not recognized by this version.)",
		},
	});
	expect(configWrites).toEqual([]);
});

test("Q12 records the runtime-turn correlation before a workflow gate is exposed", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-q12-runtime-turn-"));
	dirs.push(cwd);
	const emitter = new BrokerWorkflowGateEmitter("q12-runtime-turn", new FileGateStore(path.join(cwd, "gates.json")));
	const detachTerminalController = emitter.registerGateTerminalController!({
		completeGateInteractions: () => "not_published",
		cancelGateInteractions: () => {},
	});
	try {
		emitter.setRuntimeTurnProvider?.(() => "runtime-turn-2550");
		const advance = emitter.emitGate({
			stage: "deep-interview",
			kind: "question",
			schema: { type: "string", enum: ["continue"] },
		});
		const records = emitter.listWorkflowGateQueryRecords!();
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({
			id: expect.stringMatching(/^pending:/),
			tag: "pending",
			runtime_turn_id: "runtime-turn-2550",
		});
		await emitter.resolveGate!({
			gate_id: records[0]!.gate_id,
			answer: "continue",
			idempotency_key: "q12-runtime-turn",
		});
		expect(await advance).toBe("continue");
	} finally {
		detachTerminalController();
	}
});
test("workflow gate recommendation projection marks only one exact hint without changing raw options", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-workflow-gate-recommendation-"));
	dirs.push(cwd);
	const sessionId = `workflow-gate-recommendation-${Date.now()}`;
	let emitGate:
		| ((gate: { gate_id: string; options: Array<Record<string, unknown>>; context: Record<string, unknown> }) => void)
		| undefined;
	let terminalController: { completeGateInteractions: (gateId: string) => unknown } | undefined;
	const workflowGate = {
		supportsRemoteGateAnswers: () => true,
		onGateEmitted: (listener: typeof emitGate) => {
			emitGate = listener;
			return () => {};
		},
		registerGateTerminalController: (controller: typeof terminalController) => {
			terminalController = controller;
			return () => {};
		},
		resolveGate: async () => undefined,
		recoverAcceptedGates: async () => [],
		lookupCompletedResolution: () => undefined,
		prepareTerminalization: () => undefined,
		clearPreparedTerminalization: () => {},
		resolveGateFromNotification: async (response: { gate_id: string }, interaction: { resolveClaim: () => void }) => {
			interaction.resolveClaim();
			terminalController?.completeGateInteractions(response.gate_id);
			return { status: "accepted" };
		},
	} as unknown as WorkflowGateEmitter;
	process.env.GJC_NOTIFICATIONS = "1";
	const handlers = start(context(cwd, sessionId, "main", {}, workflowGate));
	const endpointFile = path.join(cwd, ".gjc", "state", "sdk", `${sessionId}.json`);
	await waitFor(() => fs.existsSync(endpointFile), "SDK endpoint");
	const endpoint = JSON.parse(fs.readFileSync(endpointFile, "utf8")) as { url: string; token: string };
	const socket = new WebSocket(`${endpoint.url}/?token=${encodeURIComponent(endpoint.token)}`);
	sockets.push(socket);
	const frames: Record<string, unknown>[] = [];
	socket.addEventListener("message", event => frames.push(JSON.parse(String(event.data))));
	await new Promise<void>((resolve, reject) => {
		socket.addEventListener("open", () => resolve(), { once: true });
		socket.addEventListener("error", () => reject(new Error("WS error")), { once: true });
	});
	const cases = [
		{ name: "all undefined", descriptions: [undefined, undefined], recommendedIndex: undefined },
		{ name: "one exact", descriptions: [undefined, "recommended"], recommendedIndex: 1 },
		{ name: "duplicate exact", descriptions: ["recommended", "recommended"], recommendedIndex: undefined },
		{ name: "nonexact variants", descriptions: ["Recommended", "recommended "], recommendedIndex: undefined },
		{ name: "exact plus another defined", descriptions: ["recommended", "other"], recommendedIndex: undefined },
	] as const;
	try {
		for (const [index, fixture] of cases.entries()) {
			const options = fixture.descriptions.map((description, optionIndex) => ({
				value: `value-${index}-${optionIndex}`,
				label: `Option ${index}-${optionIndex}`,
				...(description === undefined ? {} : { description }),
			}));
			const rawOptions = structuredClone(options);
			const gateId = `recommendation-gate-${index}`;
			emitGate?.({ gate_id: gateId, options, context: { prompt: fixture.name } });
			await waitFor(
				() => frames.some(frame => frame.type === "action_needed" && frame.workflowGateId === gateId),
				`${fixture.name} workflow gate presentation`,
			);
			const action = frames.findLast(frame => frame.type === "action_needed" && frame.workflowGateId === gateId);
			expect(action?.options).toEqual(options.map(option => option.label));
			if (fixture.recommendedIndex === undefined) expect(action).not.toHaveProperty("recommendedIndex");
			else expect(action).toMatchObject({ recommendedIndex: fixture.recommendedIndex });
			expect(options).toEqual(rawOptions);
			socket.send(
				JSON.stringify({
					type: "reply",
					id: action?.id,
					answer: 0,
					token: endpoint.token,
				}),
			);
			await waitFor(
				() => frames.some(frame => frame.type === "action_resolved" && frame.id === action?.id),
				`${fixture.name} workflow gate terminal`,
			);
		}
	} finally {
		await handlers.get("session_shutdown")!(
			{ type: "session_shutdown" },
			context(cwd, sessionId, "main", {}, workflowGate),
		);
	}
}, 60_000);

test("SDK host discovers, answers, and advances a durable workflow gate", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-host-workflow-gate-"));
	dirs.push(cwd);
	const sessionId = `workflow-gate-${Date.now()}`;
	const gateStore = new FileGateStore(path.join(cwd, ".gjc", "state", "workflow-gates.json"));
	const emitter = new BrokerWorkflowGateEmitter(sessionId, gateStore);
	process.env.GJC_NOTIFICATIONS = "1";
	start(context(cwd, sessionId, "main", {}, emitter));
	const endpointFile = path.join(cwd, ".gjc", "state", "sdk", `${sessionId}.json`);
	await waitFor(() => fs.existsSync(endpointFile), "SDK endpoint");
	const endpoint = JSON.parse(fs.readFileSync(endpointFile, "utf8")) as { url: string; token: string };
	const socket = new WebSocket(`${endpoint.url}/?token=${encodeURIComponent(endpoint.token)}`);
	sockets.push(socket);
	const frames: Record<string, unknown>[] = [];
	socket.addEventListener("message", event => frames.push(JSON.parse(String(event.data))));
	await new Promise<void>((resolve, reject) => {
		socket.addEventListener("open", () => resolve(), { once: true });
		socket.addEventListener("error", () => reject(new Error("WS error")), { once: true });
	});
	const request = async (id: string, command: Record<string, unknown>): Promise<Record<string, unknown>> => {
		socket.send(
			JSON.stringify({ type: "control_command", sessionId, token: endpoint.token, requestId: id, command }),
		);
		await waitFor(
			() => frames.some(frame => frame.type === "control_command_result" && frame.requestId === id),
			`${id} response`,
		);
		return JSON.parse(
			String(frames.find(frame => frame.type === "control_command_result" && frame.requestId === id)?.message),
		) as Record<string, unknown>;
	};
	let gateId = "";
	emitter.onGateEmitted!(gate => {
		gateId = gate.gate_id;
	});
	const advance = emitter.emitGate({
		stage: "ralplan",
		kind: "approval",
		schema: { type: "string", enum: ["approve"] },
	});
	await waitFor(() => gateId !== "", "workflow gate");
	Object.assign(emitter, { listWorkflowGateQueryRecords: undefined });
	expect(await request("gates", { type: "query_request", id: "gates", query: "Q12" })).toMatchObject({
		ok: true,
		page: { items: [{ gate_id: gateId, id: `pending:${gateId}`, tag: "pending" }] },
	});
	const initialGateId = gateId;
	const queuedAdvance = emitter.emitGate({
		stage: "ralplan",
		kind: "approval",
		schema: { type: "string", enum: ["approve"] },
	});
	await waitFor(() => gateId !== initialGateId, "queued workflow gate");
	const queuedGateId = gateId;
	expect(
		await request("queued-answer", {
			type: "control_request",
			id: "queued-answer",
			operation: "workflow.gate_answer",
			input: { id: queuedGateId, response: "approve", expectedSessionId: sessionId },
		}),
	).toMatchObject({ ok: true, result: { status: "accepted" } });
	expect(await queuedAdvance).toBe("approve");
	expect(gateStore.get(queuedGateId)).toMatchObject({ status: "accepted", advanced: true });
	expect(
		await request("wrong-session", {
			type: "control_request",
			id: "wrong-session",
			operation: "workflow.gate_answer",
			input: { id: initialGateId, response: "approve", expectedSessionId: "another-session" },
		}),
	).toMatchObject({ ok: false, error: { code: "resource_gone" } });
	expect(
		await request("answer", {
			type: "control_request",
			id: "answer",
			operation: "workflow.gate_answer",
			input: { id: initialGateId, response: "approve", expectedSessionId: sessionId },
		}),
	).toMatchObject({ ok: true, result: { status: "accepted" } });
	expect(await advance).toBe("approve");
	const originalResolveGate = emitter.resolveGate!.bind(emitter);
	const originalListPendingGates = emitter.listPendingGates!.bind(emitter);
	const originalClearPreparedTerminalization = emitter.clearPreparedTerminalization!.bind(emitter);
	let rejectDirectOnce = true;
	let clearedPreparedProofs = 0;
	Object.assign(emitter, {
		resolveGate: async (response: Parameters<NonNullable<WorkflowGateEmitter["resolveGate"]>>[0]) => {
			if (rejectDirectOnce) {
				rejectDirectOnce = false;
				throw new Error("transient direct-control failure");
			}
			return originalResolveGate(response);
		},
		listPendingGates: () => originalListPendingGates(),
		clearPreparedTerminalization: (id: string) => {
			clearedPreparedProofs += 1;
			originalClearPreparedTerminalization(id);
		},
	});
	const failedDirectPriorGateId = gateId;
	const failedDirectAdvance = emitter.emitGate({
		stage: "ralplan",
		kind: "approval",
		schema: { type: "string", enum: ["approve"] },
		options: [{ value: "approve", label: "Approve", description: "recommended" }],
	});
	await waitFor(() => gateId !== failedDirectPriorGateId, "failed-direct workflow gate");
	const failedDirectGateId = gateId;
	const actionFramesForGate = () =>
		frames.filter(frame => frame.type === "action_needed" && frame.workflowGateId === failedDirectGateId);
	await waitFor(() => actionFramesForGate().length === 1, "initial failed-direct presentation");
	const initialActionId = String(actionFramesForGate()[0]?.id);
	expect(actionFramesForGate()[0]).toMatchObject({ options: ["Approve"], recommendedIndex: 0 });
	expect(
		await request("failed-direct", {
			type: "control_request",
			id: "failed-direct",
			operation: "workflow.gate_answer",
			input: { id: failedDirectGateId, response: "approve", expectedSessionId: sessionId },
		}),
	).toMatchObject({ ok: false });
	expect(clearedPreparedProofs).toBe(1);
	await waitFor(() => actionFramesForGate().length >= 2, "reissued failed-direct presentation");
	const reissuedActionId = String(actionFramesForGate().at(-1)?.id);
	expect(reissuedActionId).not.toBe(initialActionId);
	expect(actionFramesForGate().at(-1)).toMatchObject({ options: ["Approve"], recommendedIndex: 0 });
	expect(
		await emitter.resolveGateFromNotification!(
			{ gate_id: failedDirectGateId, answer: "approve", idempotency_key: "failed-direct-generic" },
			{
				interactionActionId: reissuedActionId,
				replyReceiptId: "failed-direct-receipt",
				answerJson: JSON.stringify("approve"),
				requestSelectedAck: async () => ({ status: "delivered", messageId: 1 }),
				resolveClaim: () => {},
				closeClaimInvalid: reason => {
					throw new Error(`Unexpected invalid generic reply: ${reason}`);
				},
			},
		),
	).toMatchObject({ status: "accepted" });
	expect(await failedDirectAdvance).toBe("approve");

	const nextPriorGateId = gateId;
	const nextAdvance = emitter.emitGate({
		stage: "ralplan",
		kind: "approval",
		schema: { type: "string", enum: ["approve"] },
		options: [
			{ value: "approve", label: "Approve", description: "recommended" },
			{ value: "cancel", label: "Cancel", description: "unexpected" },
		],
	});
	await waitFor(() => gateId !== nextPriorGateId, "post-reissue workflow gate");
	const nextGateId = gateId;
	await waitFor(
		() => frames.some(frame => frame.type === "action_needed" && frame.workflowGateId === nextGateId),
		"post-reissue presentation",
	);
	const nextAction = frames.findLast(frame => frame.type === "action_needed" && frame.workflowGateId === nextGateId);
	expect(nextAction).toMatchObject({ options: ["Approve", "Cancel"] });
	expect(nextAction).not.toHaveProperty("recommendedIndex");
	expect(
		await emitter.resolveGateFromNotification!(
			{ gate_id: nextGateId, answer: "approve", idempotency_key: "post-reissue-generic" },
			{
				interactionActionId: String(nextAction?.id),
				replyReceiptId: "post-reissue-receipt",
				answerJson: JSON.stringify("approve"),
				requestSelectedAck: async () => ({ status: "delivered", messageId: 2 }),
				resolveClaim: () => {},
				closeClaimInvalid: reason => {
					throw new Error(`Unexpected invalid generic reply: ${reason}`);
				},
			},
		),
	).toMatchObject({ status: "accepted" });
	expect(await nextAdvance).toBe("approve");

	Object.assign(emitter, {
		resolveGate: async () => {
			throw new Error("durable resolution transport failed");
		},
		listPendingGates: () => {
			throw new Error("durable reconciliation unavailable");
		},
	});
	for (const [operation, input] of [
		["workflow.gate_answer", (id: string) => ({ id, response: "approve", expectedSessionId: sessionId })],
		["workflow.plan_approve", (id: string) => ({ id, choice: "approve", expectedSessionId: sessionId })],
	] as const) {
		const priorGateId = gateId;
		void emitter
			.emitGate({ stage: "ralplan", kind: "approval", schema: { type: "string", enum: ["approve"] } })
			.catch(() => {});
		await waitFor(() => gateId !== priorGateId, `uncertain ${operation} gate`);
		expect(
			await request(`uncertain-${operation}`, {
				type: "control_request",
				id: `uncertain-${operation}`,
				operation,
				input: input(gateId),
			}),
		).toMatchObject({ ok: false, error: { code: "terminal_uncertain" } });
	}
});

test("session teardown drains admitted direct gate resolution before detaching its controller", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-direct-resolution-drain-"));
	dirs.push(cwd);
	const sessionId = `direct-resolution-drain-${Date.now()}`;
	const emitter = new BrokerWorkflowGateEmitter(sessionId, new FileGateStore(path.join(cwd, "gates.json")));
	const resolution = Promise.withResolvers<void>();
	const preDrainBarrier = Promise.withResolvers<void>();
	const sessionClosedDrained = Promise.withResolvers<void>();
	const terminalized = Promise.withResolvers<void>();
	const events: string[] = [];
	let controllerAttached = false;
	let resolutionStarted = false;
	const originalRegisterController = emitter.registerGateTerminalController!.bind(emitter);
	const originalResolveGate = emitter.resolveGate!.bind(emitter);
	const originalPushFrameAndWait = NotificationServer.prototype.pushFrameAndWait;
	const registerController = spyOn(emitter, "registerGateTerminalController").mockImplementation(controller => {
		const detach = originalRegisterController(controller);
		controllerAttached = true;
		return () => {
			events.push("controller-detached");
			controllerAttached = false;
			detach();
		};
	});
	const resolveGate = spyOn(emitter, "resolveGate").mockImplementation(async response => {
		resolutionStarted = true;
		await resolution.promise;
		const resolved = await originalResolveGate(response);
		events.push("gate-terminalized");
		terminalized.resolve();
		return resolved;
	});
	const pushFrameAndWait = spyOn(NotificationServer.prototype, "pushFrameAndWait").mockImplementation(async function (
		this: NotificationServer,
		frame,
		timeout,
	) {
		const delivered = await originalPushFrameAndWait.call(this, frame, timeout);
		if ((JSON.parse(frame) as { type?: unknown }).type === "session_closed") {
			sessionClosedDrained.resolve();
			await preDrainBarrier.promise;
		}
		return delivered;
	});
	process.env.GJC_NOTIFICATIONS = "1";
	const sessionContext = context(cwd, sessionId, "main", {}, emitter);
	const handlers = start(sessionContext);
	const endpointFile = path.join(cwd, ".gjc", "state", "sdk", `${sessionId}.json`);
	let shutdown: Promise<unknown> | undefined;
	try {
		await waitFor(() => fs.existsSync(endpointFile), "SDK endpoint");
		const endpoint = JSON.parse(fs.readFileSync(endpointFile, "utf8")) as { url: string; token: string };
		const socket = new WebSocket(`${endpoint.url}/?token=${encodeURIComponent(endpoint.token)}`);
		sockets.push(socket);
		await new Promise<void>((resolve, reject) => {
			socket.addEventListener("open", () => resolve(), { once: true });
			socket.addEventListener("error", () => reject(new Error("WS error")), { once: true });
		});
		let gateId = "";
		emitter.onGateEmitted!(gate => {
			gateId = gate.gate_id;
		});
		const gateContinuation = emitter.emitGate({
			stage: "ralplan",
			kind: "approval",
			schema: { type: "string" },
		});
		await waitFor(() => gateId !== "", "workflow gate");
		socket.send(
			JSON.stringify({
				type: "control_command",
				sessionId,
				token: endpoint.token,
				requestId: "answer",
				command: {
					type: "control_request",
					id: "answer",
					operation: "workflow.gate_answer",
					input: { id: gateId, response: "approve", expectedSessionId: sessionId },
				},
			}),
		);
		await waitFor(() => resolutionStarted, "direct gate resolution");
		shutdown = Promise.resolve(handlers.get("session_shutdown")!({ type: "session_shutdown" }, sessionContext));
		await sessionClosedDrained.promise;
		expect(controllerAttached).toBe(true);
		preDrainBarrier.resolve();
		await new Promise<void>(resolve => setImmediate(resolve));
		expect(controllerAttached).toBe(true);
		resolution.resolve();
		expect(await gateContinuation).toBe("approve");
		await terminalized.promise;
		expect(controllerAttached).toBe(true);
		await shutdown;
		expect(events).toEqual(["gate-terminalized", "controller-detached"]);
	} finally {
		preDrainBarrier.resolve();
		resolution.resolve();
		await shutdown?.catch(() => {});
		pushFrameAndWait.mockRestore();
		resolveGate.mockRestore();
		registerController.mockRestore();
	}
});
test("SDK runtime bounds gate resolution drain at a finite ceiling", () => {
	// GATE_RESOLUTION_QUIESCENCE_MS is a finite constant that bounds
	// waitForGateResolutionQuiescence. The original PR removed the bound
	// (unbounded Promise.allSettled); this verifies it is restored.
	// The constant is not exported, so verify through the source file.
	const source = fs.readFileSync(path.resolve(__dirname, "../src/sdk/host/session-runtime.ts"), "utf8");
	expect(source).toContain("GATE_RESOLUTION_QUIESCENCE_MS");
	expect(source).toContain("Promise.race([settled, timeout])");
	expect(source).not.toMatch(/waitForGateResolutionQuiescence[^}]*await Promise\.allSettled/);
});
test("PresentationArbiter drops a retired presentation before terminal persistence recovery", async () => {
	const publications: string[] = [];
	const closed: string[] = [];
	const store = new MemoryGateStore();
	const originalPut = store.put.bind(store);
	let failTerminalizedWrite = true;
	const put = spyOn(store, "put").mockImplementation(record => {
		if (failTerminalizedWrite && record.terminalized) {
			failTerminalizedWrite = false;
			throw new Error("terminalized record write failed");
		}
		originalPut(record);
	});
	const emitter = new BrokerWorkflowGateEmitter("terminal-recovery", store);
	const arbiter = new PresentationArbiter(
		{
			registerArbitratedAsk(json: string) {
				const action = JSON.parse(json) as { id: string };
				publications.push(action.id);
				return { actionId: action.id, registrationEpoch: publications.length };
			},
			retireIfUnclaimed: () => ({ status: "retired" as const }),
		} as never,
		() => false,
	);
	emitter.registerGateTerminalController!({
		completeGateInteractions: gateId => arbiter.complete(gateId),
		cancelGateInteractions: gateId => arbiter.cancel(gateId, "terminalization failed"),
	});
	const gateIds: string[] = [];
	emitter.onGateEmitted!(gate => {
		gateIds.push(gate.gate_id);
		arbiter.retain({
			gateId: gate.gate_id,
			workflowGateId: gate.gate_id,
			sessionId: "session",
			question: gate.gate_id,
			options: ["approve"],
			controls: [],
			multi: false,
			allowEmpty: false,
			selectedOptions: [],
			onClosed: () => closed.push(gate.gate_id),
		});
	});
	const firstAdvance = emitter.emitGate({ stage: "ralplan", kind: "approval", schema: { type: "string" } });
	const secondAdvance = emitter.emitGate({ stage: "ralplan", kind: "approval", schema: { type: "string" } });
	const [firstGateId, secondGateId] = gateIds;

	try {
		await expect(
			emitter.resolveGate!({ gate_id: firstGateId!, answer: "approve", idempotency_key: firstGateId! }),
		).rejects.toThrow("terminalized record write failed");
		expect(publications).toHaveLength(2);
		expect(closed).toEqual([firstGateId]);
		expect(store.get(firstGateId!)).toMatchObject({ status: "accepted", terminalized: false, advanced: false });

		await expect(emitter.recoverAcceptedGates!()).resolves.toEqual([firstGateId]);
		expect(await firstAdvance).toBe("approve");
		expect(arbiter.complete(firstGateId!)).toBe("already_terminal");
		expect(closed).toEqual([firstGateId]);
		expect(arbiter.routeFor(publications[1]!)).toBe(secondGateId);
	} finally {
		put.mockRestore();
		void secondAdvance.catch(() => {});
	}
});

test("SDK host omits direct workflow controls for a legacy workflow-gate emitter", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-legacy-workflow-gate-"));
	dirs.push(cwd);
	const sessionId = `legacy-workflow-gate-${Date.now()}`;
	const legacyEmitter = {
		supportsRemoteGateAnswers: () => true,
		emitGate: async () => undefined,
		resolveGate: async () => ({
			gate_id: "legacy-gate",
			status: "accepted" as const,
			answer_hash: "fixture",
			resolved_at: new Date().toISOString(),
		}),
	} as WorkflowGateEmitter;
	process.env.GJC_NOTIFICATIONS = "1";
	start(context(cwd, sessionId, "main", {}, legacyEmitter));
	const endpointFile = path.join(cwd, ".gjc", "state", "sdk", `${sessionId}.json`);
	await waitFor(() => fs.existsSync(endpointFile), "SDK endpoint");
	const endpoint = JSON.parse(fs.readFileSync(endpointFile, "utf8")) as { url: string; token: string };
	const socket = new WebSocket(`${endpoint.url}/?token=${encodeURIComponent(endpoint.token)}`);
	sockets.push(socket);
	const frames: Record<string, unknown>[] = [];
	socket.addEventListener("message", event => frames.push(JSON.parse(String(event.data))));
	await new Promise<void>((resolve, reject) => {
		socket.addEventListener("open", () => resolve(), { once: true });
		socket.addEventListener("error", () => reject(new Error("WS error")), { once: true });
	});
	socket.send(
		JSON.stringify({
			type: "control_command",
			sessionId,
			token: endpoint.token,
			requestId: "capabilities",
			command: { type: "query_request", id: "capabilities", query: "runtime.capabilities" },
		}),
	);
	await waitFor(
		() => frames.some(frame => frame.type === "control_command_result" && frame.requestId === "capabilities"),
		"capabilities response",
	);
	const response = JSON.parse(
		String(
			frames.find(frame => frame.type === "control_command_result" && frame.requestId === "capabilities")?.message,
		),
	) as { page: { items: Array<{ operations: string[] }> } };
	const operations = response.page.items[0]!.operations;
	expect(operations).not.toContain("workflow.gate_answer");
	expect(operations).not.toContain("workflow.plan_approve");
	expect(operations).toContain("model.cycle");
});

test("PresentationArbiter serializes ordinary and workflow asks, fences queued controls, and fails closed on uncertainty", async () => {
	const publications: Array<Record<string, unknown>> = [];
	const retired: Array<{ actionId: string; registrationEpoch: number }> = [];
	let failures = 1;
	const server = {
		registerArbitratedAsk(json: string) {
			const action = JSON.parse(json) as Record<string, unknown>;
			if (failures > 0) {
				failures -= 1;
				throw new Error("publication unavailable");
			}
			publications.push(action);
			return { actionId: action.id as string, registrationEpoch: publications.length };
		},
		retireIfUnclaimed(lease: { actionId: string; registrationEpoch: number }) {
			retired.push(lease);
			return { status: "retired" as const };
		},
	} as never;
	const arbiter = new PresentationArbiter(server, () => false);
	const gate = (gateId: string, multi = false, recommendedIndex?: number) => ({
		gateId,
		...(gateId.startsWith("workflow") ? { workflowGateId: gateId } : {}),
		sessionId: "session",
		question: gateId,
		options: ["one", "two"],
		...(recommendedIndex === undefined ? {} : { recommendedIndex }),
		controls: [],
		multi,
		allowEmpty: false,
		selectedOptions: [],
	});
	arbiter.retain(gate("ordinary", false, 1));
	arbiter.retain(gate("workflow-first", true, 0));
	await Bun.sleep(PresentationArbiter.retryBaseDelayMs + 10);
	expect(publications.map(action => action.workflowGateId)).toEqual([undefined]);
	expect(publications[0]).toMatchObject({ options: ["one", "two"], recommendedIndex: 1 });
	arbiter.complete("ordinary");
	expect(publications.map(action => action.workflowGateId)).toEqual([undefined, "workflow-first"]);
	expect(publications[1]).toMatchObject({
		options: ["one", "two"],
		selectedOptionIndices: [],
		recommendedIndex: 0,
	});
	const firstActionId = publications[1]!.id as string;
	expect(arbiter.toggle(firstActionId, "one")).toBe(true);
	expect(publications).toHaveLength(3);
	expect(publications[2]).toMatchObject({
		question: "(1 selected) workflow-first",
		options: ["one", "two"],
		selectedOptionIndices: [0],
		recommendedIndex: 0,
	});
	const replayedActionId = publications[2]!.id as string;
	arbiter.retain(gate("workflow-first", true, 0));
	expect(arbiter.presentationFor(replayedActionId)?.selectedOptions).toEqual(["one"]);
	arbiter.retain(gate("workflow-second"));
	const queued = arbiter.prepareDirectControl("workflow-second");
	expect(queued).toEqual({ status: "queued", ordinal: 1 });
	arbiter.complete("workflow-first");
	expect(publications).toHaveLength(3);
	arbiter.finishDirectControl("workflow-second", queued as { status: "queued"; ordinal: number }, "rejected");
	await Promise.resolve();
	expect(publications).toHaveLength(4);
	const secondActionId = publications[3]!.id as string;
	const uncertain = arbiter.prepareDirectControl("workflow-second");
	expect(uncertain).toEqual({ status: "retired", ordinal: 0 });
	expect(retired.map(lease => lease.actionId)).toContain(secondActionId);
	arbiter.finishDirectControl("workflow-second", uncertain as { status: "retired"; ordinal: number }, "unknown");
	await Promise.resolve();
	expect(publications).toHaveLength(4);
});

test("PresentationArbiter retires and republishes an active replay whose option snapshot changed", () => {
	const publications: Array<Record<string, unknown>> = [];
	const retired: string[] = [];
	const arbiter = new PresentationArbiter(
		{
			registerArbitratedAsk(json: string) {
				const action = JSON.parse(json) as Record<string, unknown>;
				publications.push(action);
				return { actionId: action.id as string, registrationEpoch: publications.length };
			},
			retireIfUnclaimed(lease: { actionId: string }) {
				retired.push(lease.actionId);
				return { status: "retired" as const };
			},
		} as never,
		() => false,
	);
	const presentation = (options: string[]) => ({
		gateId: "workflow",
		workflowGateId: "workflow",
		sessionId: "session",
		question: "Pick",
		options,
		controls: [],
		multi: true,
		allowEmpty: false,
		selectedOptions: [],
	});

	arbiter.retain(presentation(["one", "two"]));
	const firstActionId = publications[0]!.id as string;
	expect(arbiter.toggle(firstActionId, "one")).toBe(true);
	const selectedActionId = publications[1]!.id as string;
	arbiter.retain(presentation(["two", "three"]));

	expect(retired).toContain(selectedActionId);
	expect(publications).toHaveLength(3);
	expect(publications[2]).toMatchObject({
		options: ["two", "three"],
		selectedOptionIndices: [],
	});
});

test("PresentationArbiter publishes the ask tool's selection state and keeps its own navigation control", () => {
	const publications: Array<Record<string, unknown>> = [];
	const arbiter = new PresentationArbiter(
		{
			registerArbitratedAsk(json: string) {
				const action = JSON.parse(json) as Record<string, unknown>;
				publications.push(action);
				return { actionId: action.id as string, registrationEpoch: publications.length };
			},
			retireIfUnclaimed: () => ({ status: "retired" as const }),
		} as never,
		() => false,
	);
	// The ask tool owns its multi-select loop: one presentation per toggle, with
	// its own Next/Done control rather than the workflow gate's synthesized one.
	const presentation = (selectedOptions: string[]) => ({
		gateId: `interactive:${selectedOptions.length}`,
		sessionId: "session",
		question: "Pick",
		options: ["one", "two"],
		controls: [
			{ id: "navigation_forward" as const, kind: "navigation" as const, label: "Next" as const, enabled: true },
		],
		multi: true,
		allowEmpty: false,
		selectedOptions,
	});

	arbiter.retain(presentation([]));
	expect(publications[0]).toMatchObject({
		question: "Pick",
		selectedOptionIndices: [],
		controls: [{ id: "navigation_forward", label: "Next", enabled: true }],
	});

	arbiter.complete("interactive:0");
	arbiter.retain(presentation(["two"]));
	expect(publications[1]).toMatchObject({
		question: "(1 selected) Pick",
		selectedOptionIndices: [1],
		controls: [{ id: "navigation_forward", label: "Next", enabled: true }],
	});
});

test("PresentationArbiter keeps the routed option snapshot when replay retirement lacks terminal proof", () => {
	const publications: Array<Record<string, unknown>> = [];
	const arbiter = new PresentationArbiter(
		{
			registerArbitratedAsk(json: string) {
				const action = JSON.parse(json) as Record<string, unknown>;
				publications.push(action);
				return { actionId: action.id as string, registrationEpoch: publications.length };
			},
			retireIfUnclaimed: () => ({ status: "claimed" as const }),
		} as never,
		() => false,
	);
	const presentation = (options: string[]) => ({
		gateId: "workflow",
		workflowGateId: "workflow",
		sessionId: "session",
		question: "Pick",
		options,
		controls: [],
		multi: false,
		allowEmpty: false,
		selectedOptions: [],
	});

	arbiter.retain(presentation(["one", "two"]));
	const actionId = publications[0]!.id as string;
	arbiter.retain(presentation(["two", "three"]));

	expect(publications).toHaveLength(1);
	expect(arbiter.presentationFor(actionId)?.options).toEqual(["one", "two"]);
});

test("PresentationArbiter terminalizes a queued direct control with explicit non-published proof", () => {
	const publications: string[] = [];
	const arbiter = new PresentationArbiter(
		{
			registerArbitratedAsk(json: string) {
				const action = JSON.parse(json) as { id: string };
				publications.push(action.id);
				return { actionId: action.id, registrationEpoch: publications.length };
			},
			retireIfUnclaimed: () => ({ status: "retired" as const }),
		} as never,
		() => false,
	);
	for (const gateId of ["published", "queued"]) {
		arbiter.retain({
			gateId,
			workflowGateId: gateId,
			sessionId: "session",
			question: gateId,
			options: ["approve"],
			controls: [],
			multi: false,
			allowEmpty: false,
			selectedOptions: [],
		});
	}

	expect(publications).toHaveLength(1);
	expect(arbiter.prepareDirectControl("queued")).toEqual({ status: "queued", ordinal: 1 });
	expect(arbiter.complete("queued")).toBe("not_published");
	expect(publications).toHaveLength(1);
});

test("PresentationArbiter defers suspended gates, direct controls, and stale source leases", () => {
	const publications: string[] = [];
	const arbiter = new PresentationArbiter(
		{
			registerArbitratedAsk(json: string) {
				const action = JSON.parse(json) as { id: string };
				publications.push(action.id);
				return { actionId: action.id, registrationEpoch: publications.length };
			},
			retireIfUnclaimed: () => ({ status: "retired" as const }),
		} as never,
		() => false,
	);
	const presentation = (gateId: string) => ({
		gateId,
		workflowGateId: gateId,
		sessionId: "session",
		question: gateId,
		options: ["approve"],
		controls: [],
		multi: false,
		allowEmpty: false,
		selectedOptions: [],
	});

	// Retention is local while policy is provisional; an accepted direct answer
	// consumes the queued presentation and leaves no later publication behind.
	arbiter.setPublicationSuspended(true);
	arbiter.retain(presentation("accepted"), { publish: false, sourceEpoch: 1 });
	expect(publications).toHaveLength(0);
	const accepted = arbiter.prepareDirectControl("accepted");
	expect(accepted).toEqual({ status: "queued", ordinal: 0 });
	arbiter.finishDirectControl("accepted", accepted as { status: "queued"; ordinal: number }, "accepted");
	arbiter.setPublicationSuspended(false);
	arbiter.activateDeferred(1);
	expect(publications).toHaveLength(0);

	// A rejected direct answer remains queued until committed activation, and
	// activation is idempotent rather than registering duplicate actions.
	arbiter.setPublicationSuspended(true);
	arbiter.retain(presentation("rejected"), { publish: false, sourceEpoch: 2 });
	const rejected = arbiter.prepareDirectControl("rejected");
	expect(rejected).toEqual({ status: "queued", ordinal: 0 });
	arbiter.finishDirectControl("rejected", rejected as { status: "queued"; ordinal: number }, "rejected");
	expect(publications).toHaveLength(0);
	arbiter.setPublicationSuspended(false);
	arbiter.activateDeferred(2);
	arbiter.activateDeferred(2);
	expect(publications).toHaveLength(1);

	// Rebinding/disposal removes old-source leases; an activation for the stale
	// epoch cannot publish the replacement until its own epoch is committed.
	arbiter.setPublicationSuspended(true);
	arbiter.retain(presentation("old-source"), { publish: false, sourceEpoch: 3 });
	arbiter.dispose();
	arbiter.retain(presentation("new-source"), { publish: false, sourceEpoch: 4 });
	arbiter.setPublicationSuspended(false);
	arbiter.activateDeferred(3);
	expect(publications).toHaveLength(1);
	arbiter.activateDeferred(4);
	// Keep the exact-once assertion adjacent to the source-epoch release.
	expect(publications).toHaveLength(2);
	arbiter.activateDeferred(4);
	expect(publications).toHaveLength(2);
});

test("PresentationArbiter releases unscoped asks with the current workflow source while fencing stale entries", () => {
	const publications: Array<Record<string, unknown>> = [];
	const arbiter = new PresentationArbiter(
		{
			registerArbitratedAsk(json: string) {
				const action = JSON.parse(json) as Record<string, unknown>;
				publications.push(action);
				return { actionId: action.id as string, registrationEpoch: publications.length };
			},
			retireIfUnclaimed: () => ({ status: "retired" as const }),
		} as never,
		() => false,
	);
	const presentation = (gateId: string, workflowGateId?: string) => ({
		gateId,
		...(workflowGateId ? { workflowGateId } : {}),
		sessionId: "session",
		question: gateId,
		options: ["approve"],
		controls: [],
		multi: false,
		allowEmpty: false,
		selectedOptions: [],
	});

	arbiter.setPublicationSuspended(true);
	arbiter.retain(presentation("ordinary"));
	arbiter.retain(presentation("current", "current"), { publish: false, sourceEpoch: 2 });
	arbiter.retain(presentation("stale", "stale"), { publish: false, sourceEpoch: 1 });
	arbiter.setPublicationSuspended(false);

	// The unscoped ask and current workflow source are both eligible for this activation.
	arbiter.activateDeferred(2);
	expect(publications).toHaveLength(1);
	expect(publications[0]?.workflowGateId).toBeUndefined();

	// Queue serialization still releases the current workflow entry even with a stale tail.
	const ordinaryActionId = publications[0]?.id;
	expect(typeof ordinaryActionId).toBe("string");
	arbiter.completeInteractive("ordinary", ordinaryActionId as string);
	expect(publications).toHaveLength(2);
	expect(publications[1]?.workflowGateId).toBe("current");

	// The stale workflow epoch remains fenced and cannot publish on the current activation.
	const currentActionId = publications[1]?.id;
	expect(typeof currentActionId).toBe("string");
	arbiter.completeInteractive("current", currentActionId as string);
	arbiter.activateDeferred(2);
	expect(publications).toHaveLength(2);

	// The optional-argument form preserves its existing global-release behavior.
	arbiter.activateDeferred();
	expect(publications).toHaveLength(3);
	expect(publications[2]?.workflowGateId).toBe("stale");
});

test("PresentationArbiter fences deferred direct-control completions across same-gate source replacement", async () => {
	for (const outcome of ["accepted", "rejected", "unknown"] as const) {
		const publications: Array<Record<string, unknown>> = [];
		const arbiter = new PresentationArbiter(
			{
				registerArbitratedAsk(json: string) {
					const action = JSON.parse(json) as Record<string, unknown>;
					publications.push(action);
					return { actionId: action.id as string, registrationEpoch: publications.length };
				},
				retireIfUnclaimed: () => ({ status: "retired" as const }),
			} as never,
			() => false,
		);
		const presentation = (question: string) => ({
			gateId: "same-gate",
			workflowGateId: "same-gate",
			sessionId: "session",
			question,
			options: ["approve"],
			controls: [],
			multi: false,
			allowEmpty: false,
			selectedOptions: [],
		});

		arbiter.retain(presentation("old source"), { sourceEpoch: 1 });
		const oldPrepared = arbiter.prepareDirectControl("same-gate");
		expect(oldPrepared).toEqual({ status: "retired", ordinal: 0 });
		if (oldPrepared.status !== "retired") throw new Error("Expected a retired direct-control lease");

		// Keep the old durable completion in flight while the source is rebound and
		// the replacement reuses the same gate id.
		const oldResolution = Promise.withResolvers<typeof outcome>();
		const oldFinished = Promise.withResolvers<void>();
		void oldResolution.promise.then(result => {
			arbiter.finishDirectControl("same-gate", oldPrepared, result);
			oldFinished.resolve();
		});
		arbiter.setPublicationSuspended(true);
		arbiter.dispose();
		arbiter.retain(presentation("replacement source"), { publish: false, sourceEpoch: 2 });
		oldResolution.resolve(outcome);
		await oldFinished.promise;

		// The stale completion cannot consume, requeue, or publish the replacement.
		expect(publications).toHaveLength(1);
		arbiter.setPublicationSuspended(false);
		arbiter.activateDeferred(1);
		expect(publications).toHaveLength(1);
		arbiter.activateDeferred(2);
		expect(publications).toHaveLength(2);
		const replacementActionId = publications[1]!.id as string;
		expect(arbiter.presentationFor(replacementActionId)?.question).toBe("replacement source");

		const replacementPrepared = arbiter.prepareDirectControl("same-gate");
		expect(replacementPrepared).toEqual({ status: "retired", ordinal: 0 });
		if (replacementPrepared.status !== "retired") throw new Error("Expected replacement to remain answerable");
		arbiter.finishDirectControl("same-gate", replacementPrepared, "accepted");
		expect(arbiter.presentationFor(replacementActionId)).toBeUndefined();
	}
});

test("PresentationArbiter preserves exact retired proof after route removal and suspension", () => {
	for (const terminalStatus of ["retired", "already_terminal"] as const) {
		const leases: Array<{ actionId: string; gateId: string; registrationEpoch: number }> = [];
		let publishedAction: { id: string } | undefined;
		const arbiter = new PresentationArbiter(
			{
				registerArbitratedAsk(json: string) {
					const action = JSON.parse(json) as { id: string };
					publishedAction = action;
					return { actionId: action.id, registrationEpoch: 1 };
				},
				retireIfUnclaimed(lease: { actionId: string; gateId: string; registrationEpoch: number }) {
					leases.push(lease);
					return { status: terminalStatus };
				},
			} as never,
			() => false,
		);
		arbiter.retain({
			gateId: "proof",
			workflowGateId: "proof",
			sessionId: "session",
			question: "Proof",
			options: ["approve"],
			controls: [],
			multi: false,
			allowEmpty: false,
			selectedOptions: [],
		});
		expect(publishedAction).toBeDefined();
		const actionId = publishedAction!.id;
		expect(arbiter.routeFor(actionId)).toBe("proof");
		expect(arbiter.closeInteraction(actionId, "test")).toBe(true);
		expect(leases).toEqual([{ actionId, gateId: "proof", registrationEpoch: 1 }]);
		arbiter.setPublicationSuspended(true);
		expect(arbiter.complete("proof")).toBe(terminalStatus);
	}
});

test("PresentationArbiter carries retained route proofs into direct terminalization after reissue failure", async () => {
	for (const terminalStatus of ["retired", "already_terminal"] as const) {
		const store = new MemoryGateStore();
		const emitter = new BrokerWorkflowGateEmitter(`direct-proof-${terminalStatus}`, store, {
			advance: async () => {},
		});
		const publications: string[] = [];
		let registrationsFail = false;
		const arbiter = new PresentationArbiter(
			{
				registerArbitratedAsk(json: string) {
					if (registrationsFail) throw new Error("reissue unavailable");
					const action = JSON.parse(json) as { id: string };
					publications.push(action.id);
					return { actionId: action.id, registrationEpoch: publications.length };
				},
				retireIfUnclaimed: () => ({ status: terminalStatus }),
			} as never,
			() => false,
		);
		emitter.registerGateTerminalController!({
			completeGateInteractions: gateId => arbiter.complete(gateId),
			cancelGateInteractions: (gateId, reason) => arbiter.cancel(gateId, reason),
		});
		let gateId = "";
		emitter.onGateEmitted!(gate => {
			gateId = gate.gate_id;
			arbiter.retain({
				gateId: gate.gate_id,
				workflowGateId: gate.gate_id,
				sessionId: "session",
				question: "Proof",
				options: ["approve"],
				controls: [],
				multi: false,
				allowEmpty: false,
				selectedOptions: [],
			});
		});
		const continuation = emitter.emitGate({
			stage: "ralplan",
			kind: "approval",
			schema: { type: "string", enum: ["approve"] },
		});
		expect(publications).toHaveLength(1);
		const actionId = publications[0]!;
		expect(arbiter.closeInteraction(actionId, "invalid_control")).toBe(true);
		registrationsFail = true;
		expect(arbiter.reissue(gateId)).toBeUndefined();
		expect(publications).toHaveLength(1);

		// A rejected direct attempt must leave the old exact proof available while
		// the retained presentation waits for a replacement publication.
		arbiter.setPublicationSuspended(true);
		const rejected = arbiter.prepareDirectControl(gateId);
		expect(rejected).toEqual({ status: "queued", ordinal: 0, terminalProof: terminalStatus });
		if (rejected.status !== "queued") throw new Error("Expected queued direct control for rejected retry");
		arbiter.finishDirectControl(gateId, rejected, "rejected");
		const prepared = arbiter.prepareDirectControl(gateId);
		expect(prepared).toEqual({ status: "queued", ordinal: 0, terminalProof: terminalStatus });
		if (prepared.status !== "queued" || !prepared.terminalProof)
			throw new Error("Expected the retained route proof on the queued direct control");
		expect(emitter.prepareTerminalization(gateId, prepared.terminalProof)).toBe(true);
		await expect(
			emitter.resolveGate!({ gate_id: gateId, answer: "approve", idempotency_key: `direct-${terminalStatus}` }),
		).resolves.toMatchObject({ status: "accepted" });
		await expect(continuation).resolves.toBe("approve");
		expect(store.get(gateId)).toMatchObject({
			status: "accepted",
			terminalized: true,
			terminalProof: terminalStatus,
			advanced: true,
		});
		expect(publications).toHaveLength(1);
	}
});

test("PresentationArbiter preserves the already-terminal proof across multi-select toggle reissue failure", async () => {
	const store = new MemoryGateStore();
	const emitter = new BrokerWorkflowGateEmitter("direct-multi-proof", store, { advance: async () => {} });
	const publications: string[] = [];
	const arbiter = new PresentationArbiter(
		{
			registerArbitratedAsk(json: string) {
				const action = JSON.parse(json) as { id: string };
				publications.push(action.id);
				return { actionId: action.id, registrationEpoch: publications.length };
			},
			retireIfUnclaimed: () => ({ status: "retired" as const }),
		} as never,
		() => false,
	);
	emitter.registerGateTerminalController!({
		completeGateInteractions: gateId => arbiter.complete(gateId),
		cancelGateInteractions: (gateId, reason) => arbiter.cancel(gateId, reason),
	});
	let gateId = "";
	emitter.onGateEmitted!(gate => {
		gateId = gate.gate_id;
		arbiter.retain({
			gateId: gate.gate_id,
			workflowGateId: gate.gate_id,
			sessionId: "session",
			question: "Choose",
			options: ["one", "two"],
			controls: [],
			multi: true,
			allowEmpty: false,
			selectedOptions: [],
		});
	});
	const continuation = emitter.emitGate({
		stage: "ralplan",
		kind: "approval",
		schema: { type: "object" },
	});
	const actionId = publications[0]!;
	arbiter.setPublicationSuspended(true);
	expect(arbiter.toggle(actionId, "one")).toBe(true);
	expect(publications).toHaveLength(1);

	const prepared = arbiter.prepareDirectControl(gateId);
	expect(prepared).toEqual({ status: "queued", ordinal: 0, terminalProof: "already_terminal" });
	if (prepared.status !== "queued" || prepared.terminalProof !== "already_terminal")
		throw new Error("Expected already-terminal proof for toggled published route");
	expect(emitter.prepareTerminalization(gateId, prepared.terminalProof)).toBe(true);
	await expect(
		emitter.resolveGate!({ gate_id: gateId, answer: { selected: ["one"] }, idempotency_key: "direct-multi-proof" }),
	).resolves.toMatchObject({ status: "accepted" });
	await expect(continuation).resolves.toEqual({ selected: ["one"] });
	expect(store.get(gateId)).toMatchObject({
		status: "accepted",
		terminalized: true,
		terminalProof: "already_terminal",
		advanced: true,
	});
	expect(publications).toHaveLength(1);
});

test("PresentationArbiter fails closed when a published route loses its proof during reissue failure", () => {
	const publications: string[] = [];
	const arbiter = new PresentationArbiter(
		{
			registerArbitratedAsk(json: string) {
				const action = JSON.parse(json) as { id: string };
				publications.push(action.id);
				return { actionId: action.id, registrationEpoch: publications.length };
			},
			retireIfUnclaimed: () => ({ status: "retired" as const }),
		} as never,
		() => false,
	);
	arbiter.retain({
		gateId: "unknown-proof",
		workflowGateId: "unknown-proof",
		sessionId: "session",
		question: "Choose",
		options: ["one"],
		controls: [],
		multi: false,
		allowEmpty: false,
		selectedOptions: [],
	});
	const actionId = publications[0]!;
	arbiter.setPublicationSuspended(true);
	arbiter.reissueAfterFailure(actionId);
	expect(publications).toHaveLength(1);
	// No exact native proof survived this transport failure, so direct control
	// must not manufacture not_published for a gate that was already published.
	expect(arbiter.prepareDirectControl("unknown-proof")).toEqual({ status: "stale" });
});

test("PresentationArbiter preserves replay retirement proof when replacement publication is suspended", async () => {
	for (const terminalStatus of ["retired", "already_terminal"] as const) {
		const publications: string[] = [];
		const arbiter = new PresentationArbiter(
			{
				registerArbitratedAsk(json: string) {
					const action = JSON.parse(json) as { id: string };
					publications.push(action.id);
					return { actionId: action.id, registrationEpoch: publications.length };
				},
				retireIfUnclaimed: () => ({ status: terminalStatus }),
			} as never,
			() => false,
		);
		arbiter.retain({
			gateId: "replay-proof",
			workflowGateId: "replay-proof",
			sessionId: "session",
			question: "Pick",
			options: ["one", "two"],
			controls: [],
			multi: false,
			allowEmpty: false,
			selectedOptions: [],
		});
		expect(publications).toHaveLength(1);
		arbiter.setPublicationSuspended(true);
		arbiter.retain({
			gateId: "replay-proof",
			workflowGateId: "replay-proof",
			sessionId: "session",
			question: "Pick again",
			options: ["one", "two", "three"],
			controls: [],
			multi: false,
			allowEmpty: false,
			selectedOptions: [],
		});
		const prepared = arbiter.prepareDirectControl("replay-proof");
		expect(prepared).toEqual({ status: "queued", ordinal: 0, terminalProof: terminalStatus });
		expect(publications).toHaveLength(1);
	}
});

test("PresentationArbiter preserves exact proof while completing an active route", () => {
	for (const terminalStatus of ["retired", "already_terminal"] as const) {
		const publications: string[] = [];
		const arbiter = new PresentationArbiter(
			{
				registerArbitratedAsk(json: string) {
					const action = JSON.parse(json) as { id: string };
					publications.push(action.id);
					return { actionId: action.id, registrationEpoch: 1 };
				},
				retireIfUnclaimed: () => ({ status: terminalStatus }),
			} as never,
			() => false,
		);
		arbiter.retain({
			gateId: "active-proof",
			workflowGateId: "active-proof",
			sessionId: "session",
			question: "Proof",
			options: ["approve"],
			controls: [],
			multi: false,
			allowEmpty: false,
			selectedOptions: [],
		});
		const actionId = publications[0];
		if (!actionId) throw new Error("Expected an active workflow gate route");
		expect(arbiter.routeFor(actionId)).toBe("active-proof");
		expect(arbiter.complete("active-proof")).toBe(terminalStatus);
		expect(arbiter.routeFor(actionId)).toBeUndefined();
	}
});

test("PresentationArbiter persists an already-terminal active proof", async () => {
	const store = new MemoryGateStore();
	const publications: string[] = [];
	const emitter = new BrokerWorkflowGateEmitter("already-terminal-proof", store, {
		advance: async () => {},
	});
	const arbiter = new PresentationArbiter(
		{
			registerArbitratedAsk(json: string) {
				const action = JSON.parse(json) as { id: string };
				publications.push(action.id);
				return { actionId: action.id, registrationEpoch: 1 };
			},
			retireIfUnclaimed: () => ({ status: "already_terminal" as const }),
		} as never,
		() => false,
	);
	emitter.registerGateTerminalController!({
		completeGateInteractions: gateId => arbiter.complete(gateId),
		cancelGateInteractions: (gateId, reason) => arbiter.cancel(gateId, reason),
	});
	let gateId: string | undefined;
	emitter.onGateEmitted!(gate => {
		gateId = gate.gate_id;
		arbiter.retain({
			gateId: gate.gate_id,
			workflowGateId: gate.gate_id,
			sessionId: "session",
			question: "Proof",
			options: ["approve"],
			controls: [],
			multi: false,
			allowEmpty: false,
			selectedOptions: [],
		});
	});
	const continuation = emitter.emitGate({
		stage: "ralplan",
		kind: "approval",
		schema: { type: "string" },
	});
	if (!gateId) throw new Error("Expected workflow gate emission");
	expect(publications).toHaveLength(1);
	await expect(
		emitter.resolveGate!({ gate_id: gateId, answer: "approve", idempotency_key: "already-terminal-proof" }),
	).resolves.toMatchObject({ status: "accepted" });
	await expect(continuation).resolves.toBe("approve");
	expect(store.get(gateId)).toMatchObject({
		status: "accepted",
		terminalized: true,
		terminalProof: "already_terminal",
		advanced: true,
	});
});

test("PresentationArbiter clears only the exact interactive route across settlement and terminal teardown", () => {
	const published: string[] = [];
	const arbiter = new PresentationArbiter(
		{
			registerArbitratedAsk(json: string) {
				const action = JSON.parse(json) as { id: string };
				published.push(action.id);
				return { actionId: action.id, registrationEpoch: published.length };
			},
			retireIfUnclaimed: () => ({ status: "retired" as const }),
		} as never,
		() => false,
	);
	const retainInteractive = (gateId: string, onClosed: () => void) => {
		let actionId: string | undefined;
		arbiter.retain({
			gateId,
			sessionId: "session",
			question: "Continue?",
			options: ["yes"],
			controls: [],
			multi: false,
			allowEmpty: false,
			selectedOptions: [],
			onActivated: actionId_ => {
				actionId = actionId_;
			},
			onClosed,
		});
		if (!actionId) throw new Error("Expected an active interactive route");
		return actionId;
	};

	let closed = 0;
	const first = retainInteractive("settled", () => {
		closed += 1;
	});
	arbiter.reissueAfterFailure(first);
	const replacement = published.at(-1);
	if (!replacement) throw new Error("Expected replacement route");
	expect(replacement).not.toBe(first);
	arbiter.completeInteractive("settled", first);
	expect(arbiter.routeFor(replacement)).toBe("settled");
	expect(arbiter.presentationFor(replacement)).toBeDefined();
	arbiter.completeInteractive("settled", replacement);
	arbiter.completeInteractive("settled", replacement);
	expect(arbiter.routeFor(replacement)).toBeUndefined();
	expect(arbiter.presentationFor(replacement)).toBeUndefined();
	expect(closed).toBe(1);

	const failed = retainInteractive("failed", () => {});
	arbiter.completeInteractive("failed", failed);
	expect(arbiter.routeFor(failed)).toBeUndefined();
	expect(arbiter.presentationFor(failed)).toBeUndefined();

	const cancelled = retainInteractive("cancelled", () => {});
	arbiter.cancel("cancelled", "interactive_abort");
	expect(arbiter.routeFor(cancelled)).toBeUndefined();
	expect(arbiter.presentationFor(cancelled)).toBeUndefined();

	const switched = retainInteractive("switched", () => {});
	arbiter.dispose();
	expect(arbiter.routeFor(switched)).toBeUndefined();
	expect(arbiter.presentationFor(switched)).toBeUndefined();
});

test("PresentationArbiter rejects claimed or stale retirement as terminal proof and clears the fenced head on cancellation", () => {
	const arbiter = new PresentationArbiter(
		{
			registerArbitratedAsk(json: string) {
				const action = JSON.parse(json) as { id: string };
				return { actionId: action.id, registrationEpoch: 1 };
			},
			retireIfUnclaimed: () => ({ status: "claimed" as const }),
		} as never,
		() => false,
	);
	let closed = 0;
	arbiter.retain({
		gateId: "claimed-gate",
		workflowGateId: "claimed-gate",
		sessionId: "session",
		question: "Continue?",
		options: ["yes"],
		controls: [],
		multi: false,
		allowEmpty: false,
		selectedOptions: [],
		onClosed: () => {
			closed++;
		},
	});
	expect(() => arbiter.complete("claimed-gate")).toThrow("lacks exact terminal proof");
	expect(arbiter.hasActivePresentation()).toBe(true);
	arbiter.cancel("claimed-gate", "terminalization_failed");
	expect(arbiter.hasActivePresentation()).toBe(false);
	expect(closed).toBe(1);
});

test("PresentationArbiter fences an exhausted ordinary interactive head until explicit cancellation", async () => {
	let registrationsFail = false;
	const published: string[] = [];
	const arbiter = new PresentationArbiter(
		{
			registerArbitratedAsk(json: string) {
				if (registrationsFail) throw new Error("unavailable");
				const action = JSON.parse(json) as { id: string };
				published.push(action.id);
				return { actionId: action.id, registrationEpoch: published.length };
			},
			retireIfUnclaimed: () => ({ status: "retired" as const }),
		} as never,
		() => false,
	);
	const answer = Promise.withResolvers<string | undefined>();
	const pendingInteractive = new Map<string, { actionId?: string; resolve: (result: string | undefined) => void }>();
	let settles = 0;
	const pending: { actionId?: string; resolve: (result: string | undefined) => void } = {
		resolve: (result: string | undefined) => {
			settles++;
			answer.resolve(result);
		},
	};
	arbiter.retain({
		gateId: "ordinary",
		sessionId: "session",
		question: "Continue?",
		options: ["yes"],
		controls: [],
		multi: false,
		allowEmpty: false,
		selectedOptions: [],
		onActivated: actionId => {
			if (pending.actionId && pendingInteractive.get(pending.actionId) === pending)
				pendingInteractive.delete(pending.actionId);
			pending.actionId = actionId;
			pendingInteractive.set(actionId, pending);
		},
		onClosed: () => {
			if (pending.actionId && pendingInteractive.get(pending.actionId) === pending)
				pendingInteractive.delete(pending.actionId);
			pending.resolve(undefined);
		},
	});
	const first = published[0];
	if (!first) throw new Error("Expected an active interactive route");
	arbiter.retain({
		gateId: "queued",
		sessionId: "session",
		question: "Queued?",
		options: ["yes"],
		controls: [],
		multi: false,
		allowEmpty: false,
		selectedOptions: [],
	});
	registrationsFail = true;
	arbiter.reissueAfterFailure(first);
	await Bun.sleep(PresentationArbiter.retryBaseDelayMs * 4);
	registrationsFail = false;
	await Bun.sleep(PresentationArbiter.retryBaseDelayMs);
	expect(arbiter.routeFor(first)).toBeUndefined();
	expect(pendingInteractive.size).toBe(1);
	expect(settles).toBe(0);
	expect(published).toEqual([first]);

	arbiter.cancel("ordinary", "interactive_abort");
	const queued = published[1];
	if (!queued) throw new Error("Expected queued presentation after cancellation");
	expect(arbiter.presentationFor(queued)?.question).toBe("Queued?");
	expect(pendingInteractive.size).toBe(0);
	expect(await answer.promise).toBeUndefined();
	expect(settles).toBe(1);
});

test("PresentationArbiter terminally cancels an exhausted ordinary head exactly once before promotion", async () => {
	const publications: string[] = [];
	const arbiter = new PresentationArbiter(
		{
			registerArbitratedAsk(json: string) {
				const action = JSON.parse(json) as { id: string; question: string };
				if (action.question === "Unavailable?") throw new Error("unavailable");
				publications.push(action.id);
				return { actionId: action.id, registrationEpoch: publications.length };
			},
			retireIfUnclaimed: () => ({ status: "retired" as const }),
		} as never,
		() => false,
	);
	const settled = Promise.withResolvers<string | undefined>();
	let closes = 0;
	arbiter.retain({
		gateId: "unavailable",
		sessionId: "session",
		question: "Unavailable?",
		options: ["yes"],
		controls: [],
		multi: false,
		allowEmpty: false,
		selectedOptions: [],
		onClosed: () => {
			closes++;
			settled.resolve(undefined);
		},
	});
	arbiter.retain({
		gateId: "queued",
		sessionId: "session",
		question: "Queued?",
		options: ["yes"],
		controls: [],
		multi: false,
		allowEmpty: false,
		selectedOptions: [],
	});

	await Bun.sleep(PresentationArbiter.retryBaseDelayMs * 4);
	expect(publications).toEqual([]);
	expect(closes).toBe(0);

	await expect(settled.promise).resolves.toBeUndefined();
	expect(closes).toBe(1);
	expect(publications).toHaveLength(1);
	expect(arbiter.presentationFor(publications[0]!)).toMatchObject({ question: "Queued?" });
	arbiter.cancel("unavailable", "late_cancellation");
	expect(closes).toBe(1);
});

test("PresentationArbiter fences already-terminal direct controls and resets exhausted head recovery", async () => {
	const publications: string[] = [];
	let registrationsFail = true;
	const arbiter = new PresentationArbiter(
		{
			registerArbitratedAsk(json: string) {
				if (registrationsFail) throw new Error("unavailable");
				const action = JSON.parse(json) as { id: string };
				publications.push(action.id);
				return { actionId: action.id, registrationEpoch: publications.length };
			},
			retireIfUnclaimed: () => ({ status: "already_terminal" as const }),
		} as never,
		() => false,
	);
	arbiter.retain({
		gateId: "head",
		workflowGateId: "head",
		sessionId: "session",
		question: "Continue?",
		options: ["yes"],
		controls: [],
		multi: false,
		allowEmpty: false,
		selectedOptions: [],
	});
	await Bun.sleep(PresentationArbiter.retryBaseDelayMs * 4);
	registrationsFail = false;
	arbiter.recover();
	expect(publications).toHaveLength(1);
	const direct = arbiter.prepareDirectControl("head");
	expect(direct).toEqual({ status: "stale" });
});

test("AC2/AC8: SDK host completes successful session mutations over its live WebSocket", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-host-successful-verbs-"));
	dirs.push(cwd);
	const sessionId = `successful-verbs-${Date.now()}`;
	const emitter = new BrokerWorkflowGateEmitter(
		sessionId,
		new FileGateStore(path.join(cwd, ".gjc", "state", "workflow-gates.json")),
	);
	const emittedGates: Array<{ gate_id: string; kind: string }> = [];
	emitter.onGateEmitted!(gate => emittedGates.push(gate));
	let compactions = 0;
	const configWrites: Array<[string, unknown]> = [];
	const settings = {
		get: () => undefined,
		set: (key: string, value: unknown) => configWrites.push([key, value]),
	} as unknown as Settings;
	const ctx = {
		...context(cwd, sessionId, "main", {}, emitter),
		compact: async () => {
			compactions++;
		},
		getConfigItems: () => ({ "theme.dark": "light" }),
	};
	process.env.GJC_NOTIFICATIONS = "1";
	start(ctx, settings);
	const endpointFile = path.join(cwd, ".gjc", "state", "sdk", `${sessionId}.json`);
	await waitFor(() => fs.existsSync(endpointFile), "SDK endpoint");
	const endpoint = JSON.parse(fs.readFileSync(endpointFile, "utf8")) as { url: string; token: string };
	const frames: Record<string, unknown>[] = [];
	const socket = new WebSocket(`${endpoint.url}/?token=${encodeURIComponent(endpoint.token)}`);
	sockets.push(socket);
	socket.addEventListener("message", event => frames.push(JSON.parse(String(event.data))));
	await new Promise<void>((resolve, reject) => {
		socket.addEventListener("open", () => resolve(), { once: true });
		socket.addEventListener("error", () => reject(new Error("WS error")), { once: true });
	});
	const request = async (id: string, command: Record<string, unknown>): Promise<Record<string, unknown>> => {
		socket.send(
			JSON.stringify({ type: "control_command", sessionId, token: endpoint.token, requestId: id, command }),
		);
		await waitFor(
			() => frames.some(frame => frame.type === "control_command_result" && frame.requestId === id),
			`${id} response`,
		);
		return JSON.parse(
			String(frames.find(frame => frame.type === "control_command_result" && frame.requestId === id)?.message),
		) as Record<string, unknown>;
	};

	await waitFor(() => getAskAnswerSource(sessionId) !== undefined, "interactive ask source");
	const askAnswer = getAskAnswerSource(sessionId)!.awaitAnswer("Continue with the SDK host test?", [
		"continue",
		"stop",
	]);
	await waitFor(() => frames.some(frame => frame.type === "action_needed" && frame.kind === "ask"), "pending ask");
	const askId = String(frames.find(frame => frame.type === "action_needed" && frame.kind === "ask")?.id);
	expect(
		await request("ask-answer", {
			type: "control_request",
			id: "ask-answer",
			operation: "ask.answer",
			input: { id: askId, answer: 0 },
			idempotencyKey: "successful-verbs-ask-answer",
		}),
	).toEqual({ type: "control_response", id: "ask-answer", ok: true, result: { resolved: true } });
	expect(await askAnswer).toBe("continue");

	const questionAdvance = emitter.emitGate({
		stage: "deep-interview",
		kind: "question",
		schema: { type: "string", enum: ["continue"] },
	});
	await waitFor(() => emittedGates.some(gate => gate.kind === "question"), "pending question gate");
	const questionGateId = emittedGates.find(gate => gate.kind === "question")!.gate_id;
	expect(
		await request("gate-answer", {
			type: "control_request",
			id: "gate-answer",
			operation: "workflow.gate_answer",
			input: { id: questionGateId, response: "continue" },
			idempotencyKey: "successful-verbs-gate-answer",
		}),
	).toMatchObject({
		type: "control_response",
		id: "gate-answer",
		ok: true,
		result: { gate_id: questionGateId, status: "accepted" },
	});
	expect(await questionAdvance).toBe("continue");

	const approvalAdvance = emitter.emitGate({
		stage: "ralplan",
		kind: "approval",
		schema: { type: "string", enum: ["approve"] },
	});
	await waitFor(() => emittedGates.some(gate => gate.kind === "approval"), "pending approval gate");
	const approvalGateId = emittedGates.find(gate => gate.kind === "approval")!.gate_id;
	expect(
		await request("plan-approve", {
			type: "control_request",
			id: "plan-approve",
			operation: "workflow.plan_approve",
			input: { id: approvalGateId, choice: "approve" },
			idempotencyKey: "successful-verbs-plan-approve",
		}),
	).toMatchObject({
		type: "control_response",
		id: "plan-approve",
		ok: true,
		result: { gate_id: approvalGateId, status: "accepted" },
	});
	expect(await approvalAdvance).toBe("approve");

	expect(
		await request("compaction", {
			type: "control_request",
			id: "compaction",
			operation: "compaction.run",
			input: {},
			idempotencyKey: "successful-verbs-compaction",
		}),
	).toEqual({ type: "control_response", id: "compaction", ok: true, result: { started: true } });
	expect(compactions).toBe(1);

	expect(
		await request("config-patch", {
			type: "control_request",
			id: "config-patch",
			operation: "config.patch",
			input: { patch: { "theme.dark": "dark" } },
			expectedRevision: "0",
			idempotencyKey: "successful-verbs-config-patch",
		}),
	).toEqual({
		type: "control_response",
		id: "config-patch",
		ok: true,
		result: { patched: ["theme.dark"], revision: "1" },
	});
	expect(
		await request("config-patch-repeat", {
			type: "control_request",
			id: "config-patch-repeat",
			operation: "config.patch",
			input: { patch: { "theme.dark": "light" } },
			expectedRevision: "1",
			idempotencyKey: "successful-verbs-config-patch-repeat",
		}),
	).toEqual({
		type: "control_response",
		id: "config-patch-repeat",
		ok: true,
		result: { patched: ["theme.dark"], revision: "2" },
	});
	expect(configWrites).toEqual([
		["theme.dark", "dark"],
		["theme.dark", "light"],
	]);
	expect(
		await request("config-readback", {
			type: "query_request",
			id: "config-readback",
			query: "config.list/get",
		}),
	).toMatchObject({
		type: "query_response",
		id: "config-readback",
		ok: true,
		page: { items: [{ "theme.dark": "light" }] },
	});
});

test("turn.prompt_status settles durable acceptance after disconnect before agent_start", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-prompt-reconcile-"));
	dirs.push(cwd);
	const sessionId = `sdk-prompt-reconcile-${Date.now()}`;
	const sessionFile = path.join(cwd, "session.jsonl");
	const sessionContext = context(cwd, sessionId);
	const sessionManager = sessionContext.sessionManager as Record<string, unknown>;
	sessionContext.sessionManager = {
		...sessionManager,
		getSessionFile: () => sessionFile,
	};
	const deliveries: unknown[] = [];
	const releaseExecution = Promise.withResolvers<void>();
	let preflightAborted = false;
	const handlers = start(
		sessionContext,
		undefined,
		async (content, options) => {
			await options?.onPreflightAcceptCommit?.();
			deliveries.push(content);
			const signal = options?.preflightSignal;
			const onAbort = () => {
				preflightAborted = true;
			};
			signal?.addEventListener("abort", onAbort, { once: true });
			try {
				await releaseExecution.promise;
			} finally {
				signal?.removeEventListener("abort", onAbort);
			}
		},
		true,
	);
	const endpointFile = path.join(cwd, ".gjc", "state", "sdk", `${sessionId}.json`);
	await waitFor(() => fs.existsSync(endpointFile), "SDK endpoint");
	const endpoint = JSON.parse(fs.readFileSync(endpointFile, "utf8")) as { url: string; token: string };
	const connect = async () => {
		const frames: Record<string, unknown>[] = [];
		const socket = new WebSocket(`${endpoint.url}/?token=${encodeURIComponent(endpoint.token)}`);
		sockets.push(socket);
		socket.addEventListener("message", event => frames.push(JSON.parse(String(event.data))));
		await new Promise<void>((resolve, reject) => {
			socket.addEventListener("open", () => resolve(), { once: true });
			socket.addEventListener("error", () => reject(new Error("WS error")), { once: true });
		});
		const request = async (command: Record<string, unknown>): Promise<Record<string, unknown>> => {
			const requestId = String(command.id);
			socket.send(JSON.stringify(command));
			const responseType = command.type === "query_request" ? "query_response" : "control_response";
			await waitFor(
				() => frames.some(frame => frame.type === responseType && frame.id === requestId),
				`${requestId} response`,
			);
			return frames.find(frame => frame.type === responseType && frame.id === requestId)!;
		};
		return { socket, frames, request };
	};

	const first = await connect();
	first.socket.send(
		JSON.stringify({
			type: "control_request",
			id: "prompt-reconcile",
			operation: "turn.prompt",
			input: { text: "reconcile me", clientRef: "recon-ref-1" },
			idempotencyKey: "recon-ik-1",
		}),
	);
	await waitFor(() => deliveries.length === 1, "prompt accepted before acknowledgement loss");

	// Simulate client-process death without consuming the control response. The
	// caller retained only its fresh clientRef, not the generated IDs.
	await closeSocket(first.socket);
	await Bun.sleep(20);
	expect(preflightAborted).toBe(false);
	await handlers.get("agent_start")?.({ type: "agent_start" }, sessionContext);

	// Reconnect: clientRef recovers the canonical generated pair, which then
	// reconciles identically through the generated-ID selector.
	const second = await connect();
	let byRef: Record<string, unknown> | undefined;
	for (let attempt = 0; attempt < 50; attempt++) {
		byRef = await second.request({
			type: "query_request",
			id: `status-ref-${attempt}`,
			query: "turn.prompt_status",
			input: { clientRef: "recon-ref-1" },
		});
		if ((byRef.result as { status?: unknown } | undefined)?.status === "in_flight") break;
		await Bun.sleep(20);
	}
	expect(byRef).toMatchObject({ ok: true, result: { status: "in_flight", clientRef: "recon-ref-1" } });
	const { commandId, turnId } = (byRef?.result ?? {}) as { commandId: string; turnId: string };
	expect(typeof commandId).toBe("string");
	expect(typeof turnId).toBe("string");
	const byPair = await second.request({
		type: "query_request",
		id: "status-pair",
		query: "turn.prompt_status",
		input: { commandId, turnId },
	});
	expect(byPair).toMatchObject({
		ok: true,
		result: { status: "in_flight", commandId, turnId, clientRef: "recon-ref-1" },
	});
	const wrongPair = await second.request({
		type: "query_request",
		id: "status-wrong-pair",
		query: "turn.prompt_status",
		input: { commandId, turnId: "turn-other" },
	});
	expect(wrongPair).toMatchObject({ ok: true, result: { status: "unknown" } });

	// A retained duplicate clientRef is rejected before execution (safe non-replay).
	const duplicate = await second.request({
		type: "control_request",
		id: "prompt-duplicate-ref",
		operation: "turn.prompt",
		input: { text: "duplicate", clientRef: "recon-ref-1" },
	});
	expect(duplicate).toMatchObject({ ok: false, error: { code: "client_ref_conflict" } });

	await handlers.get("agent_end")?.({ type: "agent_end" }, sessionContext);
	let terminal: Record<string, unknown> | undefined;
	for (let attempt = 0; attempt < 50; attempt++) {
		terminal = await second.request({
			type: "query_request",
			id: `status-terminal-${attempt}`,
			query: "turn.prompt_status",
			input: { commandId, turnId },
		});
		if ((terminal.result as { status?: unknown } | undefined)?.status === "terminal_ok") break;
		await Bun.sleep(20);
	}
	expect(terminal).toMatchObject({ ok: true, result: { status: "terminal_ok" } });
	releaseExecution.resolve();

	// Exactly one execution happened across the whole reconnect/reconcile flow.
	expect(deliveries).toHaveLength(1);
	await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, sessionContext);
});

test("ordered turn.prompt ignores envelope idempotencyKey: no replay and no idempotency_conflict", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-prompt-ordered-"));
	dirs.push(cwd);
	const sessionId = `sdk-prompt-ordered-${Date.now()}`;
	const sessionContext = context(cwd, sessionId);
	const deliveries: unknown[] = [];
	const handlers = start(sessionContext, undefined, (content: unknown) => {
		deliveries.push(content);
	});
	const endpointFile = path.join(cwd, ".gjc", "state", "sdk", `${sessionId}.json`);
	await waitFor(() => fs.existsSync(endpointFile), "SDK endpoint");
	const endpoint = JSON.parse(fs.readFileSync(endpointFile, "utf8")) as { url: string; token: string };
	const frames: Record<string, unknown>[] = [];
	const socket = new WebSocket(`${endpoint.url}/?token=${encodeURIComponent(endpoint.token)}`);
	sockets.push(socket);
	socket.addEventListener("message", event => frames.push(JSON.parse(String(event.data))));
	await new Promise<void>((resolve, reject) => {
		socket.addEventListener("open", () => resolve(), { once: true });
		socket.addEventListener("error", () => reject(new Error("WS error")), { once: true });
	});
	const prompt = async (id: string, text: string, clientRef?: string) => {
		socket.send(
			JSON.stringify({
				type: "control_request",
				id,
				operation: "turn.prompt",
				input: { text, ...(clientRef ? { clientRef } : {}) },
				idempotencyKey: "same-envelope-key",
			}),
		);
		await waitFor(() => frames.some(frame => frame.type === "control_response" && frame.id === id), `${id} response`);
		return frames.find(frame => frame.type === "control_response" && frame.id === id)!;
	};

	const first = await prompt("ordered-1", "first ordered prompt", "ordered-ref-1");
	expect(first).toMatchObject({ ok: true, result: { accepted: true } });
	const firstIds = first.result as { commandId: string; turnId: string };
	await handlers.get("agent_start")?.({ type: "agent_start" }, sessionContext);
	await handlers.get("agent_end")?.({ type: "agent_end" }, sessionContext);

	// Same envelope idempotencyKey with different input: a NEW ordered execution,
	// not a replay of the first response and not an idempotency_conflict.
	const second = await prompt("ordered-2", "second ordered prompt", "ordered-ref-2");
	expect(second).toMatchObject({ ok: true, result: { accepted: true } });
	const secondIds = second.result as { commandId: string; turnId: string };
	expect(secondIds.commandId).not.toBe(firstIds.commandId);
	expect(secondIds.turnId).not.toBe(firstIds.turnId);
	await handlers.get("agent_start")?.({ type: "agent_start" }, sessionContext);
	await handlers.get("agent_end")?.({ type: "agent_end" }, sessionContext);

	// Same key AND same input still executes anew (ordered, never replayed).
	const third = await prompt("ordered-3", "first ordered prompt", "ordered-ref-3");
	expect(third).toMatchObject({ ok: true, result: { accepted: true } });
	expect(((third.result ?? {}) as { commandId?: string }).commandId).not.toBe(firstIds.commandId);
	await handlers.get("agent_start")?.({ type: "agent_start" }, sessionContext);
	await handlers.get("agent_end")?.({ type: "agent_end" }, sessionContext);

	expect(deliveries).toHaveLength(3);
	await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, sessionContext);
});

test("turn.result validates selectors and its prompt alias rejects invalid clientRef input", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-prompt-validation-"));
	dirs.push(cwd);
	const sessionId = `sdk-prompt-validation-${Date.now()}`;
	const sessionContext = context(cwd, sessionId);
	const handlers = start(sessionContext);
	const endpointFile = path.join(cwd, ".gjc", "state", "sdk", `${sessionId}.json`);
	await waitFor(() => fs.existsSync(endpointFile), "SDK endpoint");
	const endpoint = JSON.parse(fs.readFileSync(endpointFile, "utf8")) as { url: string; token: string };
	const frames: Record<string, unknown>[] = [];
	const socket = new WebSocket(`${endpoint.url}/?token=${encodeURIComponent(endpoint.token)}`);
	sockets.push(socket);
	socket.addEventListener("message", event => frames.push(JSON.parse(String(event.data))));
	await new Promise<void>((resolve, reject) => {
		socket.addEventListener("open", () => resolve(), { once: true });
		socket.addEventListener("error", () => reject(new Error("WS error")), { once: true });
	});
	const request = async (command: Record<string, unknown>): Promise<Record<string, unknown>> => {
		const requestId = String(command.id);
		socket.send(JSON.stringify(command));
		const responseType = command.type === "query_request" ? "query_response" : "control_response";
		await waitFor(
			() => frames.some(frame => frame.type === responseType && frame.id === requestId),
			`${requestId} response`,
		);
		return frames.find(frame => frame.type === responseType && frame.id === requestId)!;
	};

	expect(
		await request({ type: "query_request", id: "q-partial", query: "turn.prompt_status", input: { commandId: "c" } }),
	).toMatchObject({ ok: false, error: { code: "invalid_request" } });
	expect(
		await request({
			type: "query_request",
			id: "q-both",
			query: "turn.prompt_status",
			input: { commandId: "c", turnId: "t", clientRef: "r" },
		}),
	).toMatchObject({ ok: false, error: { code: "invalid_request" } });
	expect(await request({ type: "query_request", id: "q-none", query: "turn.prompt_status", input: {} })).toMatchObject(
		{ ok: false, error: { code: "invalid_request" } },
	);
	expect(
		await request({
			type: "query_request",
			id: "q-cursor",
			query: "turn.prompt_status",
			input: { clientRef: "r" },
			cursor: "x",
		}),
	).toMatchObject({ ok: false, error: { code: "invalid_request" } });
	expect(
		await request({
			type: "query_request",
			id: "q-canonical-empty-cursor",
			query: "turn.result",
			input: { kind: "prompt", clientRef: "r" },
			cursor: "",
		}),
	).toMatchObject({ ok: false, error: { code: "invalid_request" } });
	expect(
		await request({
			type: "query_request",
			id: "q-unknown",
			query: "turn.prompt_status",
			input: { clientRef: "absent" },
		}),
	).toMatchObject({ ok: true, result: { status: "unknown" } });

	for (const [id, clientRef] of [
		["bad-empty", ""],
		["bad-blank", "   "],
		["bad-long", "x".repeat(129)],
	] as const) {
		const response = await request({
			type: "control_request",
			id,
			operation: "turn.prompt",
			input: { text: "bad ref", clientRef },
		});
		expect(response).toMatchObject({ ok: false, error: { code: "invalid_input" } });
	}
	await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, sessionContext);
});

test("clientRef admission reservation is released when a submission is rejected before acceptance", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-prompt-release-"));
	dirs.push(cwd);
	const sessionId = `sdk-prompt-release-${Date.now()}`;
	const sessionContext = context(cwd, sessionId);
	const deliveries: string[] = [];
	const handlers = start(
		sessionContext,
		undefined,
		async (
			content: unknown,
			options:
				| { onPreflightAccepted?: () => void; onPreflightAcceptCommit?: () => void | Promise<void> }
				| undefined,
		) => {
			const text = String(content);
			deliveries.push(text);
			if (text === "doomed preflight")
				return Promise.reject(Object.assign(new Error("submission lost"), { code: "unavailable" }));
			await firePreflightAccept(options);
			return Promise.resolve();
		},
		true,
	);
	const endpointFile = path.join(cwd, ".gjc", "state", "sdk", `${sessionId}.json`);
	await waitFor(() => fs.existsSync(endpointFile), "SDK endpoint");
	const endpoint = JSON.parse(fs.readFileSync(endpointFile, "utf8")) as { url: string; token: string };
	const frames: Record<string, unknown>[] = [];
	const socket = new WebSocket(`${endpoint.url}/?token=${encodeURIComponent(endpoint.token)}`);
	sockets.push(socket);
	socket.addEventListener("message", event => frames.push(JSON.parse(String(event.data))));
	await new Promise<void>((resolve, reject) => {
		socket.addEventListener("open", () => resolve(), { once: true });
		socket.addEventListener("error", () => reject(new Error("WS error")), { once: true });
	});
	const prompt = async (id: string, text: string, clientRef: string) => {
		socket.send(
			JSON.stringify({ type: "control_request", id, operation: "turn.prompt", input: { text, clientRef } }),
		);
		await waitFor(() => frames.some(frame => frame.type === "control_response" && frame.id === id), `${id} response`);
		return frames.find(frame => frame.type === "control_response" && frame.id === id)!;
	};

	// The rejected submission must release its admission reservation...
	const doomed = await prompt("release-1", "doomed preflight", "release-ref");
	expect(doomed.ok).toBe(false);
	// ...so the same clientRef can be admitted again for a fresh prompt.
	const freed = await prompt("release-2", "freed retry", "release-ref");
	expect(freed).toMatchObject({ ok: true, result: { accepted: true } });
	// And the rejected attempt left no reconciliation record behind.
	socket.send(
		JSON.stringify({
			type: "query_request",
			id: "release-status",
			query: "turn.prompt_status",
			input: { clientRef: "release-ref" },
		}),
	);
	await waitFor(
		() => frames.some(frame => frame.type === "query_response" && frame.id === "release-status"),
		"release status response",
	);
	const status = frames.find(frame => frame.type === "query_response" && frame.id === "release-status")!;
	expect(status).toMatchObject({ ok: true, result: { status: "accepted" } });
	await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, sessionContext);
});

test("busy rejection releases the clientRef admission so a same-ref retry succeeds after the turn", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-prompt-busy-release-"));
	dirs.push(cwd);
	const sessionId = `sdk-prompt-busy-release-${Date.now()}`;
	const sessionContext = context(cwd, sessionId);
	const handlers = start(sessionContext);
	const endpointFile = path.join(cwd, ".gjc", "state", "sdk", `${sessionId}.json`);
	await waitFor(() => fs.existsSync(endpointFile), "SDK endpoint");
	const endpoint = JSON.parse(fs.readFileSync(endpointFile, "utf8")) as { url: string; token: string };
	const frames: Record<string, unknown>[] = [];
	const socket = new WebSocket(`${endpoint.url}/?token=${encodeURIComponent(endpoint.token)}`);
	sockets.push(socket);
	socket.addEventListener("message", event => frames.push(JSON.parse(String(event.data))));
	await new Promise<void>((resolve, reject) => {
		socket.addEventListener("open", () => resolve(), { once: true });
		socket.addEventListener("error", () => reject(new Error("WS error")), { once: true });
	});
	const prompt = async (id: string, text: string, clientRef: string) => {
		socket.send(
			JSON.stringify({ type: "control_request", id, operation: "turn.prompt", input: { text, clientRef } }),
		);
		await waitFor(() => frames.some(frame => frame.type === "control_response" && frame.id === id), `${id} response`);
		return frames.find(frame => frame.type === "control_response" && frame.id === id)!;
	};

	// Occupy the session with a running turn.
	const first = await prompt("busy-first", "occupy the session", "busy-ref-first");
	expect(first.ok).toBe(true);
	await handlers.get("agent_start")?.({ type: "agent_start" }, sessionContext);

	// While busy, the same clientRef admission is rejected but must not linger.
	const rejected = await prompt("busy-rejected", "rejected while busy", "busy-ref-retry");
	expect(rejected).toMatchObject({ ok: false, error: { code: "busy" } });

	await handlers.get("agent_end")?.({ type: "agent_end" }, sessionContext);

	// After the turn, the same clientRef is admissible again (no phantom reservation).
	const retry = await prompt("busy-retry", "retry after idle", "busy-ref-retry");
	expect(retry).toMatchObject({ ok: true, result: { accepted: true } });
	await handlers.get("agent_start")?.({ type: "agent_start" }, sessionContext);
	await handlers.get("agent_end")?.({ type: "agent_end" }, sessionContext);
	await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, sessionContext);
});

test("accepted-then-failed submission retains its reconciliation record and blocks ref reuse", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-prompt-accepted-failure-"));
	dirs.push(cwd);
	const sessionId = `sdk-prompt-accepted-failure-${Date.now()}`;
	const sessionContext = context(cwd, sessionId);
	const handlers = start(
		sessionContext,
		undefined,
		async (
			_content: unknown,
			options:
				| { onPreflightAccepted?: () => void; onPreflightAcceptCommit?: () => void | Promise<void> }
				| undefined,
		) => {
			await firePreflightAccept(options);
			throw Object.assign(new Error("synchronous accepted failure"), { code: "unavailable" });
		},
		true,
	);
	const endpointFile = path.join(cwd, ".gjc", "state", "sdk", `${sessionId}.json`);
	await waitFor(() => fs.existsSync(endpointFile), "SDK endpoint");
	const endpoint = JSON.parse(fs.readFileSync(endpointFile, "utf8")) as { url: string; token: string };
	const frames: Record<string, unknown>[] = [];
	const socket = new WebSocket(`${endpoint.url}/?token=${encodeURIComponent(endpoint.token)}`);
	sockets.push(socket);
	socket.addEventListener("message", event => frames.push(JSON.parse(String(event.data))));
	await new Promise<void>((resolve, reject) => {
		socket.addEventListener("open", () => resolve(), { once: true });
		socket.addEventListener("error", () => reject(new Error("WS error")), { once: true });
	});
	const request = async (command: Record<string, unknown>): Promise<Record<string, unknown>> => {
		const requestId = String(command.id);
		socket.send(JSON.stringify(command));
		const responseType = command.type === "query_request" ? "query_response" : "control_response";
		await waitFor(
			() => frames.some(frame => frame.type === responseType && frame.id === requestId),
			`${requestId} response`,
		);
		return frames.find(frame => frame.type === responseType && frame.id === requestId)!;
	};

	// The prompt is accepted at preflight, then fails synchronously after acceptance.
	const ack = await request({
		type: "control_request",
		id: "accepted-failure",
		operation: "turn.prompt",
		input: { text: "accepted then failed", clientRef: "accepted-failure-ref" },
	});
	expect(ack.ok).toBe(true);
	await waitFor(() => frames.some(frame => frame.type === "agent_failed"), "correlated agent_failed frame");
	const failedFrame = frames.find(frame => frame.type === "agent_failed");
	expect(failedFrame).toMatchObject({
		error: { code: "unavailable", message: "Prompt submission failed." },
	});

	// The reconciliation record is retained with the failed outcome, not released.
	const status = await request({
		type: "query_request",
		id: "accepted-failure-status",
		query: "turn.prompt_status",
		input: { clientRef: "accepted-failure-ref" },
	});
	expect(status).toMatchObject({
		ok: true,
		result: { status: "failed", error: { code: "unavailable" } },
	});

	// Reusing the ref conflicts while the record is retained.
	const duplicate = await request({
		type: "control_request",
		id: "accepted-failure-duplicate",
		operation: "turn.prompt",
		input: { text: "duplicate", clientRef: "accepted-failure-ref" },
	});
	expect(duplicate).toMatchObject({ ok: false, error: { code: "client_ref_conflict" } });
	await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, sessionContext);
});

test("long-running prompt settles terminally after the delivery buffer expires", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-prompt-longrun-"));
	dirs.push(cwd);
	const sessionId = `sdk-prompt-longrun-${Date.now()}`;
	const sessionContext = context(cwd, sessionId);
	const handlers = start(sessionContext);
	const endpointFile = path.join(cwd, ".gjc", "state", "sdk", `${sessionId}.json`);
	await waitFor(() => fs.existsSync(endpointFile), "SDK endpoint");
	const endpoint = JSON.parse(fs.readFileSync(endpointFile, "utf8")) as { url: string; token: string };
	const frames: Record<string, unknown>[] = [];
	const socket = new WebSocket(`${endpoint.url}/?token=${encodeURIComponent(endpoint.token)}`);
	sockets.push(socket);
	socket.addEventListener("message", event => frames.push(JSON.parse(String(event.data))));
	await new Promise<void>((resolve, reject) => {
		socket.addEventListener("open", () => resolve(), { once: true });
		socket.addEventListener("error", () => reject(new Error("WS error")), { once: true });
	});
	const request = async (command: Record<string, unknown>): Promise<Record<string, unknown>> => {
		const requestId = String(command.id);
		socket.send(JSON.stringify(command));
		const responseType = command.type === "query_request" ? "query_response" : "control_response";
		await waitFor(
			() => frames.some(frame => frame.type === responseType && frame.id === requestId),
			`${requestId} response`,
		);
		return frames.find(frame => frame.type === responseType && frame.id === requestId)!;
	};

	const ack = await request({
		type: "control_request",
		id: "long-prompt",
		operation: "turn.prompt",
		input: { text: "long running turn", clientRef: "long-ref" },
	});
	expect(ack.ok).toBe(true);
	// Expire the transient delivery buffer before lifecycle start, then trigger
	// cleanup through an unrelated follow-up acceptance. The authoritative pending
	// correlation must remain queued for the original tracked prompt.
	const realNow = Date.now;
	let followUpIds: { commandId: string; turnId: string } | undefined;
	try {
		Date.now = () => realNow() + 6 * 60_000;
		const followUp = await request({
			type: "control_request",
			id: "delivery-expiry-trigger",
			operation: "turn.follow_up",
			input: { text: "trigger delivery cleanup" },
		});
		expect(followUp).toMatchObject({ ok: true, result: { accepted: true } });
		const result = followUp.result as { commandId: string; turnId: string };
		followUpIds = { commandId: result.commandId, turnId: result.turnId };
	} finally {
		Date.now = realNow;
	}
	const untrackedFollowUp = await request({
		type: "query_request",
		id: "follow-up-untracked",
		query: "turn.prompt_status",
		input: followUpIds,
	});
	expect(untrackedFollowUp).toMatchObject({ ok: true, result: { status: "unknown" } });
	await handlers.get("agent_start")?.({ type: "agent_start" }, sessionContext);
	const inFlight = await request({
		type: "query_request",
		id: "long-inflight",
		query: "turn.prompt_status",
		input: { clientRef: "long-ref" },
	});
	// The merged status query returns the authoritative admission record; the
	// run is live (accepted or in flight, never terminal) at this point.
	expect(inFlight).toMatchObject({ ok: true, result: { kind: "prompt", clientRef: "long-ref" } });
	expect((inFlight.result as { status?: string }).status).toMatch(/^(accepted|in_flight)$/);
	await handlers.get("agent_end")?.(
		{
			type: "agent_end",
			messages: [
				{
					role: "assistant",
					stopReason: "error",
					errorMessage: "private prompt /home/alice secret-token",
				},
			],
		},
		sessionContext,
	);

	// Authoritative settlement fired at lifecycle ingress even though the delivery
	// buffer expired, and the provider error is retained only as a safe failed code.
	let settled: Record<string, unknown> = {};
	const settledDeadline = Date.now() + 15_000;
	for (let poll = 0; Date.now() < settledDeadline; poll++) {
		settled = await request({
			type: "query_request",
			id: `long-settled-${poll}`,
			query: "turn.prompt_status",
			input: { clientRef: "long-ref" },
		});
		if ((settled.result as { status?: string } | undefined)?.status !== "in_flight") break;
		await Bun.sleep(20);
	}
	expect(settled).toMatchObject({
		ok: true,
		result: { status: "failed", error: { code: "agent_error", message: "Prompt submission failed." } },
	});
	await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, sessionContext);
});

test("identical clientRefs in separate session runtimes stay isolated", async () => {
	const cwdA = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-session-a-"));
	const cwdB = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-session-b-"));
	dirs.push(cwdA, cwdB);
	const sessionA = `sdk-session-a-${Date.now()}`;
	const sessionB = `sdk-session-b-${Date.now()}`;
	const contextA = context(cwdA, sessionA);
	const contextB = context(cwdB, sessionB);
	const handlersA = start(contextA);
	const handlersB = start(contextB);
	const endpointFileA = path.join(cwdA, ".gjc", "state", "sdk", `${sessionA}.json`);
	const endpointFileB = path.join(cwdB, ".gjc", "state", "sdk", `${sessionB}.json`);
	await waitFor(() => fs.existsSync(endpointFileA) && fs.existsSync(endpointFileB), "SDK endpoints");
	const connect = async (endpointFile: string) => {
		const endpoint = JSON.parse(fs.readFileSync(endpointFile, "utf8")) as { url: string; token: string };
		const frames: Record<string, unknown>[] = [];
		const socket = new WebSocket(`${endpoint.url}/?token=${encodeURIComponent(endpoint.token)}`);
		sockets.push(socket);
		socket.addEventListener("message", event => frames.push(JSON.parse(String(event.data))));
		await new Promise<void>((resolve, reject) => {
			socket.addEventListener("open", () => resolve(), { once: true });
			socket.addEventListener("error", () => reject(new Error("WS error")), { once: true });
		});
		return async (command: Record<string, unknown>): Promise<Record<string, unknown>> => {
			const requestId = String(command.id);
			socket.send(JSON.stringify(command));
			const responseType = command.type === "query_request" ? "query_response" : "control_response";
			await waitFor(
				() => frames.some(frame => frame.type === responseType && frame.id === requestId),
				`${requestId} response`,
			);
			return frames.find(frame => frame.type === responseType && frame.id === requestId)!;
		};
	};
	const requestA = await connect(endpointFileA);
	const requestB = await connect(endpointFileB);

	// The same clientRef may independently exist in both runtimes.
	const ackA = await requestA({
		type: "control_request",
		id: "a-prompt",
		operation: "turn.prompt",
		input: { text: "session A prompt", clientRef: "shared-ref" },
	});
	expect(ackA.ok).toBe(true);
	const ackB = await requestB({
		type: "control_request",
		id: "b-prompt",
		operation: "turn.prompt",
		input: { text: "session B prompt", clientRef: "shared-ref" },
	});
	expect(ackB.ok).toBe(true);
	const idsA = ackA.result as { commandId: string; turnId: string };
	const idsB = ackB.result as { commandId: string; turnId: string };
	expect(idsB.commandId).not.toBe(idsA.commandId);

	// Session B never sees session A's record: each runtime answers only for itself.
	const statusB = await requestB({
		type: "query_request",
		id: "b-status",
		query: "turn.prompt_status",
		input: { clientRef: "shared-ref" },
	});
	expect(statusB).toMatchObject({ ok: true, result: { status: "accepted", commandId: idsB.commandId } });
	const crossPair = await requestB({
		type: "query_request",
		id: "b-cross-pair",
		query: "turn.prompt_status",
		input: { commandId: idsA.commandId, turnId: idsA.turnId },
	});
	expect(crossPair).toMatchObject({ ok: true, result: { status: "unknown" } });

	await handlersA.get("session_shutdown")?.({ type: "session_shutdown" }, contextA);
	await handlersB.get("session_shutdown")?.({ type: "session_shutdown" }, contextB);
});
test("canonical subagent lifecycle keeps the parent workflow-gate runtime turn correlated", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-canonical-subagent-gate-correlation-"));
	dirs.push(cwd);
	const subagentSessionManager = SessionManager.inMemory(cwd);
	const sessionId = subagentSessionManager.getSessionId();
	const emitter = new BrokerWorkflowGateEmitter(
		sessionId,
		new FileGateStore(path.join(cwd, ".gjc", "state", "workflow-gates.json")),
	);
	const sessionContext = context(cwd, sessionId, "main", {}, emitter);
	const handlers = start(sessionContext);
	const endpointFile = path.join(cwd, ".gjc", "state", "sdk", `${sessionId}.json`);
	await waitFor(() => fs.existsSync(endpointFile), "SDK endpoint");
	const endpoint = JSON.parse(fs.readFileSync(endpointFile, "utf8")) as { url: string; token: string };
	const frames: Record<string, unknown>[] = [];
	const socket = new WebSocket(`${endpoint.url}/?token=${encodeURIComponent(endpoint.token)}`);
	sockets.push(socket);
	socket.addEventListener("message", event => frames.push(JSON.parse(String(event.data))));
	await new Promise<void>((resolve, reject) => {
		socket.addEventListener("open", () => resolve(), { once: true });
		socket.addEventListener("error", () => reject(new Error("WS error")), { once: true });
	});

	socket.send(
		JSON.stringify({
			type: "control_request",
			id: "canonical-subagent-prompt",
			operation: "turn.prompt",
			input: { text: "preserve the parent runtime turn" },
		}),
	);
	await waitFor(
		() => frames.some(frame => frame.type === "control_response" && frame.id === "canonical-subagent-prompt"),
		"prompt acknowledgement",
	);
	const acknowledgement = frames.find(
		frame => frame.type === "control_response" && frame.id === "canonical-subagent-prompt",
	) as { result?: { commandId?: unknown; turnId?: unknown } };
	const commandId = acknowledgement.result?.commandId;
	const turnId = acknowledgement.result?.turnId;
	expect(acknowledgement).toMatchObject({
		ok: true,
		result: { accepted: true, commandId: expect.any(String), turnId: expect.any(String) },
	});

	await handlers.get("agent_start")?.({ type: "agent_start" }, sessionContext);
	await waitFor(
		() => frames.some(frame => frame.type === "agent_start" && frame.commandId === commandId),
		"correlated parent agent start",
	);

	const resolveParentGate = async (idempotencyKey: string): Promise<void> => {
		const advance = emitter.emitGate({
			stage: "ralplan",
			kind: "approval",
			schema: { type: "string", enum: ["approve"] },
		});
		const gate = emitter.listWorkflowGateQueryRecords!().find(record => record.tag === "pending");
		expect(gate).toMatchObject({ tag: "pending", runtime_turn_id: turnId });
		await emitter.resolveGate!({
			gate_id: gate!.gate_id,
			answer: "approve",
			idempotency_key: idempotencyKey,
		});
		expect(await advance).toBe("approve");
	};

	let subagentSession: AgentSession | undefined;
	try {
		const subagent = await createAgentSession({
			cwd,
			agentDir: cwd,
			sessionManager: subagentSessionManager,
			settings: Settings.isolated(),
			model: getBundledModel("openai", "gpt-4o-mini"),
			hasUI: false,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			parentTaskPrefix: "0-Subagent",
			currentAgentType: "planner",
		});
		subagentSession = subagent.session;
		expect(subagentSession.getWorkflowGateEmitter()).toBeDefined();

		// A canonical subagent must remain local while the parent gate stays bound.
		await resolveParentGate("canonical-subagent-bound");

		await subagentSession.dispose();
		subagentSession = undefined;

		// Its teardown must not clear the parent endpoint binding.
		await resolveParentGate("canonical-subagent-disposed");

		await handlers.get("agent_end")?.(
			{ type: "agent_end", stopReason: "completed", messages: [{ role: "assistant", stopReason: "stop" }] } as never,
			sessionContext,
		);
		await waitFor(
			() => frames.some(frame => frame.type === "agent_end" && frame.commandId === commandId),
			"correlated parent terminal",
		);
		const terminalFrames = frames.filter(frame => frame.type === "agent_end" || frame.type === "agent_failed");
		expect(terminalFrames).toEqual([
			expect.objectContaining({
				type: "agent_end",
				sessionId,
				commandId,
				turnId,
				outcome: { kind: "stopped", reason: "end_turn", provenance: "agent" },
			}),
		]);
		expect(frames.filter(frame => frame.type === "agent_end")).toHaveLength(1);
	} finally {
		await subagentSession?.dispose();
		await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, sessionContext);
	}
});

/**
 * Regression: a continuation (todo reminder, TTSR resume, auto-continue) re-enters
 * the agent loop inside one prompt and emits a second `agent_start`. That start
 * used to shift the empty pending queue and overwrite the live correlation with
 * `undefined`, so the prompt's `agent_end` carried no correlation, was never
 * terminalized, and every ACP client hung until the 30-minute prompt deadline.
 */
test("SDK host keeps the prompt correlation across a mid-prompt continuation agent_start", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-continuation-correlation-"));
	dirs.push(cwd);
	const sessionId = `sdk-continuation-correlation-${Date.now()}`;
	const sessionContext = context(cwd, sessionId);
	const handlers = start(sessionContext);
	const endpointFile = path.join(cwd, ".gjc", "state", "sdk", `${sessionId}.json`);
	await waitFor(() => fs.existsSync(endpointFile), "SDK endpoint");
	const endpoint = JSON.parse(fs.readFileSync(endpointFile, "utf8")) as { url: string; token: string };
	const frames: Record<string, unknown>[] = [];
	const socket = new WebSocket(`${endpoint.url}/?token=${encodeURIComponent(endpoint.token)}`);
	sockets.push(socket);
	socket.addEventListener("message", event => frames.push(JSON.parse(String(event.data))));
	await new Promise<void>((resolve, reject) => {
		socket.addEventListener("open", () => resolve(), { once: true });
		socket.addEventListener("error", () => reject(new Error("WS error")), { once: true });
	});

	socket.send(
		JSON.stringify({
			type: "control_request",
			id: "continuation-prompt",
			operation: "turn.prompt",
			input: { text: "read the file and answer" },
		}),
	);
	await waitFor(
		() => frames.some(frame => frame.type === "control_response" && frame.id === "continuation-prompt"),
		"prompt acknowledgement",
	);
	const acknowledgement = frames.find(
		frame => frame.type === "control_response" && frame.id === "continuation-prompt",
	) as { result?: { commandId?: unknown; turnId?: unknown } };
	const commandId = acknowledgement.result?.commandId;
	const turnId = acknowledgement.result?.turnId;
	expect(acknowledgement).toMatchObject({
		ok: true,
		result: { accepted: true, commandId: expect.any(String), turnId: expect.any(String) },
	});

	// First loop entry claims the pending correlation.
	await handlers.get("agent_start")?.({ type: "agent_start" }, sessionContext);
	await waitFor(
		() => frames.some(frame => frame.type === "agent_start" && frame.commandId === commandId),
		"correlated agent start",
	);

	// The continuation re-enters the loop while the same prompt is still in flight.
	await handlers.get("agent_start")?.({ type: "agent_start" }, sessionContext);

	// The terminal must still carry this prompt's exact identity.
	await handlers.get("agent_end")?.(
		{ type: "agent_end", stopReason: "completed", messages: [{ role: "assistant", stopReason: "stop" }] } as never,
		sessionContext,
	);
	await waitFor(() => frames.some(frame => frame.type === "agent_end"), "correlated prompt terminal");
	expect(frames.find(frame => frame.type === "agent_end")).toMatchObject({
		sessionId,
		commandId,
		turnId,
		outcome: { kind: "stopped", reason: "end_turn", provenance: "agent" },
	});
	// The continuation must not publish a duplicate lifecycle start.
	expect(frames.filter(frame => frame.type === "agent_start").length).toBe(1);

	await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, sessionContext);
});

test("notification host rebinds the steering snapshot before terminalizing with a token", async () => {
	// Review thread P1: the notification (bus) path must invoke
	// rebindTerminalAbortSteeringSnapshot before the settlement whenever a
	// steering admission token is present — an abort admitted under another
	// connection's turn whose requester's prompt wins the race would otherwise
	// have the session reject the still-old token as unknown_run.
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-notif-rebind-"));
	dirs.push(cwd);
	const sessionId = `sdk-notif-rebind-${Date.now()}`;
	const rebinds: number[] = [];
	const sessionContext = {
		...context(cwd, sessionId),
		getActivePromptHandle: () => "exact-run-handle",
		getTerminalTurnEpoch: () => 3,
		captureTerminalAbortSteeringSnapshot: () => 42,
		discardTerminalAbortSteeringSnapshot: (token: number) => {
			// never expected in this flow (the settlement consumes the token)
			rebinds.push(token);
		},
		rebindTerminalAbortSteeringSnapshot: (token: number) => {
			rebinds.push(token);
		},
		abortPromptAndWait: async () => ({ status: "settled", terminalScope: {} }),
	};
	const handlers = start(sessionContext, { get: () => undefined, getAgentDir: () => cwd } as unknown as Settings);
	const endpointFile = path.join(cwd, ".gjc", "state", "sdk", `${sessionId}.json`);
	await waitFor(() => fs.existsSync(endpointFile), "SDK endpoint");
	const endpoint = JSON.parse(fs.readFileSync(endpointFile, "utf8")) as { url: string; token: string };
	const frames: Record<string, unknown>[] = [];
	const socket = new WebSocket(`${endpoint.url}/?token=${encodeURIComponent(endpoint.token)}`);
	sockets.push(socket);
	socket.addEventListener("message", event => frames.push(JSON.parse(String(event.data))));
	await new Promise<void>((resolve, reject) => {
		socket.addEventListener("open", () => resolve(), { once: true });
		socket.addEventListener("error", () => reject(new Error("WS error")), { once: true });
	});
	const request = async (command: Record<string, unknown>): Promise<Record<string, unknown>> => {
		const requestId = String(command.id);
		socket.send(JSON.stringify(command));
		const responseType = command.type === "query_request" ? "query_response" : "control_response";
		await waitFor(
			() => frames.some(frame => frame.type === responseType && frame.id === requestId),
			`${requestId} response`,
		);
		return frames.find(frame => frame.type === responseType && frame.id === requestId)!;
	};
	try {
		const ack = await request({
			type: "control_request",
			id: "rebind-prompt",
			operation: "turn.prompt",
			input: { text: "requester turn", clientRef: "rebind-ref" },
		});
		expect(ack.ok).toBe(true);
		const ackResult = ack.result as { commandId: string; turnId: string };
		// Bind the exact run handle through the correlation-carrying agent_start
		// so the abort reaches the ACTIVE terminalization path.
		await handlers.get("agent_start")?.(
			{ type: "agent_start", runId: "exact-run-handle", commandId: ackResult.commandId, turnId: ackResult.turnId },
			sessionContext,
		);
		// Terminal abort: the admission captured token 42 and the
		// terminalization passes it through — the bus must rebind it before the
		// settlement.
		const abort = await request({
			type: "control_request",
			id: "rebind-abort",
			operation: "turn.abort",
			input: { mode: "terminal" },
			idempotencyKey: "rebind-abort-key",
		});
		expect(abort.ok).toBe(true);
		expect(rebinds).toContain(42);
	} finally {
		await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, sessionContext);
		socket.close();
	}
});

for (const attached of [false, true]) {
	test(`session_closed non-delivery logs at ${attached ? "warn with an attached client" : "debug with no client"}`, async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-session-closed-level-"));
		dirs.push(cwd);
		const sessionId = `session-closed-level-${attached ? "attached" : "empty"}-${Date.now()}`;
		const sessionContext = context(cwd, sessionId);
		const warned: Array<Record<string, unknown> | undefined> = [];
		const debugged: Array<Record<string, unknown> | undefined> = [];
		const warnSpy = spyOn(logger, "warn").mockImplementation((message, context) => {
			if (message.includes("session_closed") && context?.sessionId === sessionId) warned.push(context);
		});
		const debugSpy = spyOn(logger, "debug").mockImplementation((message, context) => {
			if (message.includes("session_closed") && context?.sessionId === sessionId) debugged.push(context);
		});
		const pushFrameAndWait = spyOn(NotificationServer.prototype, "pushFrameAndWait").mockResolvedValue(false);
		process.env.GJC_NOTIFICATIONS = "1";
		try {
			const handlers = start(sessionContext);
			const endpointFile = path.join(cwd, ".gjc", "state", "sdk", `${sessionId}.json`);
			await waitFor(() => fs.existsSync(endpointFile), "SDK endpoint");
			if (attached) {
				const endpoint = JSON.parse(fs.readFileSync(endpointFile, "utf8")) as { url: string; token: string };
				const socket = new WebSocket(`${endpoint.url}/?token=${encodeURIComponent(endpoint.token)}`);
				sockets.push(socket);
				const serverFrames: unknown[] = [];
				socket.addEventListener("message", event => serverFrames.push(String(event.data)));
				await new Promise<void>((resolve, reject) => {
					socket.addEventListener("open", () => resolve(), { once: true });
					socket.addEventListener("error", () => reject(new Error("WS error")), { once: true });
				});
				// A server frame proves the authenticated connection is counted server-side.
				await waitFor(() => serverFrames.length > 0, "server frame proving registration");
			}
			await handlers.get("session_shutdown")!({ type: "session_shutdown" }, sessionContext);
			if (attached) {
				expect(warned).toHaveLength(1);
				expect(warned[0]).toMatchObject({ sessionId, endpointScope: "default", attachedClients: 1 });
				expect(debugged).toHaveLength(0);
			} else {
				expect(warned).toHaveLength(0);
				expect(debugged).toHaveLength(1);
				expect(debugged[0]).toMatchObject({ sessionId, endpointScope: "default", attachedClients: 0 });
			}
		} finally {
			pushFrameAndWait.mockRestore();
			warnSpy.mockRestore();
			debugSpy.mockRestore();
		}
	});
}
test("SDK host publishes one replayable bash_folded frame per fold and runtime.jobs.list carries foldReason", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-bash-folded-"));
	dirs.push(cwd);
	const sessionId = `sdk-bash-folded-${Date.now()}`;
	const foldListeners = new Set<(event: { jobId: string; generation: string; reason: string }) => void>();
	const jobs = {
		running: [
			{
				id: "bg_1",
				type: "bash",
				status: "running",
				label: "sleep 30",
				startTime: Date.now(),
				metadata: { backgrounded: true, foldReason: "steer" },
			},
		],
		recent: [],
		delivery: { queued: 0, inFlight: 0, deliveriesDrained: true },
	};
	const sessionContext = {
		...context(cwd, sessionId),
		getJobs: () => jobs,
		onJobFold: (listener: (event: { jobId: string; generation: string; reason: string }) => void) => {
			foldListeners.add(listener);
			return () => foldListeners.delete(listener);
		},
	};
	const handlers = start(sessionContext);
	const endpointFile = path.join(cwd, ".gjc", "state", "sdk", `${sessionId}.json`);
	await waitFor(() => fs.existsSync(endpointFile), "SDK endpoint");
	const endpoint = JSON.parse(fs.readFileSync(endpointFile, "utf8")) as { url: string; token: string };
	const frames: Record<string, unknown>[] = [];
	const socket = new WebSocket(`${endpoint.url}/?token=${encodeURIComponent(endpoint.token)}`);
	sockets.push(socket);
	socket.addEventListener("message", event => frames.push(JSON.parse(String(event.data))));
	await new Promise<void>((resolve, reject) => {
		socket.addEventListener("open", () => resolve(), { once: true });
		socket.addEventListener("error", () => reject(new Error("WS error")), { once: true });
	});
	try {
		await waitFor(() => foldListeners.size === 1, "fold listener registration");
		for (const listener of foldListeners) listener({ jobId: "bg_1", generation: "gen-1", reason: "steer" });
		// A second markBackgrounded on the same job never re-notifies (manager
		// contract); a distinct fold does. Replay must retain exactly one frame per fold.
		for (const listener of foldListeners) listener({ jobId: "bg_2", generation: "gen-2", reason: "chord" });

		socket.send(JSON.stringify({ type: "event_replay", id: "fold-replay", sinceSeq: 0 }));
		await waitFor(
			() => frames.some(frame => frame.type === "event_replay_result" && frame.id === "fold-replay"),
			"fold replay",
		);
		const replay = frames.find(frame => frame.type === "event_replay_result" && frame.id === "fold-replay") as {
			events?: Array<{ kind?: unknown; payload?: Record<string, unknown> }>;
		};
		const folded = replay.events?.filter(event => event.payload?.type === "bash_folded") ?? [];
		expect(folded).toEqual([
			expect.objectContaining({
				kind: "bash_folded",
				payload: { type: "bash_folded", sessionId, jobId: "bg_1", generation: "gen-1", reason: "steer" },
			}),
			expect.objectContaining({
				kind: "bash_folded",
				payload: { type: "bash_folded", sessionId, jobId: "bg_2", generation: "gen-2", reason: "chord" },
			}),
		]);

		// runtime.jobs.list exposes foldReason beside backgrounded.
		socket.send(JSON.stringify({ type: "query_request", id: "jobs", query: "runtime.jobs.list" }));
		await waitFor(() => frames.some(frame => frame.type === "query_response" && frame.id === "jobs"), "jobs query");
		const jobsResponse = frames.find(frame => frame.type === "query_response" && frame.id === "jobs") as {
			ok?: boolean;
			page?: {
				items?: Array<{
					running?: Array<{ id: string; metadata?: { foldReason?: string; backgrounded?: boolean } }>;
				}>;
			};
		};
		expect(jobsResponse.ok).toBe(true);
		expect(jobsResponse.page?.items?.[0]?.running?.[0]?.metadata).toMatchObject({
			backgrounded: true,
			foldReason: "steer",
		});
	} finally {
		await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, sessionContext);
	}
	expect(foldListeners.size).toBe(0);
}, 30_000);
