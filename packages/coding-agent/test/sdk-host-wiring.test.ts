import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import { closeModelCache, getBundledModel } from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { NotificationServer } from "@gajae-code/natives";
import { logger } from "@gajae-code/utils";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { ExtensionRunner } from "../src/extensibility/extensions/runner";
import type {
	ExtensionActions,
	ExtensionContextActions,
	ExtensionUIContext,
} from "../src/extensibility/extensions/types";
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
import { brokerOwnerForTest } from "../src/sdk/broker/ensure";
import { SessionIndex } from "../src/sdk/broker/session-index";
import { createNotificationsExtension, PresentationArbiter } from "../src/sdk/bus";
import { getTelegramFileSink } from "../src/sdk/bus/attachment-registry";
import { SessionSdkHost } from "../src/sdk/host";
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
import { SessionManager } from "../src/session/session-manager";
import { getAskAnswerSource } from "../src/tools/ask-answer-registry";
import { startProductionSdkHost } from "./helpers/sdk-production-host";

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
	sendUserMessage: ExtensionActions["sendUserMessage"] = () => {},
	forwardPreflightCallbacks = false,
	commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>(),
	lifecycle?: { startupCapability: SdkStartupCapability; lifecycleRequired: true },
	autoStart = true,
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
			const { onPreflightAccepted, ...delivery } = options ?? {};
			const submission = sendUserMessage(content, Object.keys(delivery).length > 0 ? delivery : undefined);
			onPreflightAccepted?.();
			return Promise.resolve(submission);
		},
	} as never;
	if (lifecycle) attachLifecycleStartupCapability(api, lifecycle.startupCapability);
	const effectiveSettings =
		settings ??
		(lifecycle ? ({ get: () => undefined, getAgentDir: () => ctx.cwd } as unknown as Settings) : undefined);
	createNotificationsExtension(api, effectiveSettings ? { settings: effectiveSettings } : undefined);
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
	const capability = new SdkStartupCapability(tracker);
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
	const capability = new SdkStartupCapability(tracker);
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
	const capability = new SdkStartupCapability(tracker);
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
	const capability = new SdkStartupCapability();
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
	const serverStart = spyOn(NotificationServer.prototype, "start").mockRejectedValueOnce(
		new Error("server start failed"),
	);
	const hostStop = spyOn(SessionSdkHost.prototype, "stop").mockRejectedValueOnce(new Error("host stop failed"));
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
	const capability = new SdkStartupCapability();
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
	const capability = new SdkStartupCapability();
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
		await waitFor(
			() => fs.existsSync(path.join(agentDir, "sdk", "sessions", "index.jsonl")),
			"SDK broker registration",
		);
		const sessions = (await new SessionIndex(agentDir).open()).listSessions().sessions;
		expect(sessions).toContainEqual(
			expect.objectContaining({ sessionId, locator: expect.objectContaining({ repo: path.resolve(cwd) }) }),
		);
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

test("interactive session.handoff SDK control threads focus instructions to session.handoff", async () => {
	let contextActions: ExtensionContextActions | undefined;
	const handoffCalls: (string | undefined)[] = [];
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
			handoff: async (instructions?: string) => {
				handoffCalls.push(instructions);
				return { document: "## Goal\nContinue", savedPath: undefined };
			},
		},
	} as unknown as InteractiveModeContext);
	controller.initializeHookRunner({} as ExtensionUIContext, false);

	// The wire carries the focus under `target` (see sdk-control-dispatch);
	// the SDK control seam must forward it to session.handoff.
	expect(await contextActions?.sdkControl?.("session.handoff", { target: "preserve failing test" })).toEqual({
		handoff: { document: "## Goal\nContinue", savedPath: undefined },
	});
	expect(handoffCalls).toEqual(["preserve failing test"]);

	// A bare handoff (no focus) forwards undefined.
	await contextActions?.sdkControl?.("session.handoff", {});
	expect(handoffCalls).toEqual(["preserve failing test", undefined]);
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
				expect.objectContaining({ type: "identity_header", sessionId }),
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

test("concurrent /notify on waits for startup before activating notification answers", async () => {
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
		expect(messages).toEqual([
			{
				message: "Notifications failed to start for this session.",
				level: "error",
			},
		]);
		expect(getAskAnswerSource(sessionId)).toBeUndefined();
		await commands.get("notify")!.handler("on", sessionContext);
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

		await expect(getTelegramFileSink(sessionId)!({ path: attachmentPath })).resolves.toEqual({ ok: true });
		await waitFor(() => nativeData !== undefined, "raw N-API file attachment");
		expect(nativeData).toBeInstanceOf(Buffer);
		expect(nativeData).toEqual(bytes);

		socket.send(JSON.stringify({ type: "event_replay", id: "file-replay", sinceGeneration: 1, sinceSeq: 0 }));
		await waitFor(
			() => frames.some(frame => frame.type === "event_replay_result" && frame.id === "file-replay"),
			"file replay",
		);
		const replay = frames.find(frame => frame.type === "event_replay_result" && frame.id === "file-replay");
		expect(replay?.events).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					payload: expect.objectContaining({
						type: "file_attachment",
						sessionId,
						name: "replay.bin",
						data: bytes.toString("base64"),
					}),
				}),
			]),
		);
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

test("SDK host preserves ordered prompt image blocks in the host payload", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-prompt-images-"));
	dirs.push(cwd);
	const sessionId = `sdk-prompt-images-${Date.now()}`;
	const sent: Parameters<ExtensionActions["sendUserMessage"]>[] = [];
	const sessionContext = context(cwd, sessionId);
	const handlers = start(sessionContext, undefined, (...args) => {
		sent.push(args);
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
			undefined,
		],
		[[{ type: "image", data: "d2VicC1ieXRlcw", mimeType: "image/webp" }]],
	]);
});

test("SDK host correlates follow-up acknowledgements with the later agent start", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-follow-up-correlation-"));
	dirs.push(cwd);
	const sessionId = `sdk-follow-up-correlation-${Date.now()}`;
	const sent: Parameters<ExtensionActions["sendUserMessage"]>[] = [];
	const sessionContext = context(cwd, sessionId);
	const handlers = start(sessionContext, undefined, (...args) => {
		sent.push(args);
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
	expect(sent).toEqual([["queued follow-up", { deliverAs: "followUp" }]]);
	void handlers.get("agent_start")?.({ type: "agent_start" }, sessionContext);
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
	await handlers.get("agent_end")?.({ type: "agent_end" }, sessionContext);
	await waitFor(
		() => frames.some(frame => frame.type === "agent_start") && frames.some(frame => frame.type === "agent_end"),
		"correlated accepted prompt lifecycle",
	);
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
	observer.send(JSON.stringify({ type: "event_replay", id: "observer-replay", sinceSeq: 0 }));
	await waitFor(
		() => observerFrames.some(frame => frame.type === "event_replay_result" && frame.id === "observer-replay"),
		"observer event replay",
	);
	const observerReplay = observerFrames.find(
		frame => frame.type === "event_replay_result" && frame.id === "observer-replay",
	) as { events?: Array<Record<string, unknown>> };
	const correlation = {
		commandId: acknowledgement.result?.commandId,
		turnId: acknowledgement.result?.turnId,
	};
	expect(frames.filter(frame => frame.type === "agent_start")).toEqual([
		expect.objectContaining({ type: "agent_start", sessionId, ...correlation }),
	]);
	expect(frames.filter(frame => frame.type === "agent_end" || frame.type === "agent_failed")).toEqual([
		expect.objectContaining({ type: "agent_end", sessionId, ...correlation }),
	]);
	expect(observerFrames.some(frame => frame.type === "agent_start" || frame.type === "agent_end")).toBe(false);
	expect(observerFrames.some(frame => frame.type === "event" && frame.kind === "message_update")).toBe(false);
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
		(_content, options) => {
			options?.onPreflightAccepted?.();
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
		(_content, options) => {
			options?.onPreflightAccepted?.();
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
			error: { code: "unavailable", message: "synchronous accepted failure" },
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
	recovery.send(JSON.stringify({ type: "event_replay", id: "disconnect-replay", sinceGeneration: 1, sinceSeq: 0 }));
	await waitFor(
		() => recoveryFrames.some(frame => frame.type === "event_replay_result" && frame.id === "disconnect-replay"),
		"disconnected prompt replay",
	);
	const replay = recoveryFrames.find(
		frame => frame.type === "event_replay_result" && frame.id === "disconnect-replay",
	) as {
		events?: Array<{ payload?: Record<string, unknown> }>;
	};
	const lifecycle = replay.events?.filter(
		event =>
			event.payload?.commandId === correlation.commandId &&
			(event.payload?.type === "agent_start" || event.payload?.type === "agent_end"),
	);
	expect(lifecycle).toEqual([
		expect.objectContaining({ payload: { type: "agent_start", sessionId, ...correlation } }),
		expect.objectContaining({ payload: { type: "agent_end", sessionId, ...correlation } }),
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
			options?.onPreflightAccepted?.();
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
		expect.objectContaining({ payload: { type: "agent_end", sessionId, ...correlation } }),
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
		error: { code: "unavailable", message: "prompt failed after preflight" },
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
			options?.onPreflightAccepted?.();
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
			latePreflightAccepted = options?.onPreflightAccepted;
			preflightStarted.resolve();
			await neverPreflight.promise;
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
			options?.onPreflightAccepted?.();
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
		(content, options) => {
			deliveries.push([content, options]);
			options?.onPreflightAccepted?.();
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
	test(`SDK ${eventType} rotation swallows a retained owner-release failure without surfacing an extension error`, async () => {
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
		const errorSpy = spyOn(logger, "error").mockImplementation(() => {});
		try {
			const handlers = start(ctx);
			const endpointAPath = path.join(cwd, ".gjc", "state", "sdk", `${sessionA}.json`);
			await waitFor(() => fs.existsSync(endpointAPath), "session A endpoint");

			activeSessionId = sessionB;
			// Drive the rotation handler through a real ExtensionRunner so the onError
			// seam proves the swallowed failure is not surfaced as a red extension error.
			const rotationExt = {
				path: "test-rotation-ext",
				handlers: new Map([
					[
						eventType,
						[
							async () => {
								await handlers.get(eventType)!(
									{
										type: eventType,
										reason: "new",
										previousSessionFile: path.join(cwd, "sessions", `ts_${sessionA}.jsonl`),
									},
									ctx,
								);
							},
						],
					],
				]),
			};
			const runner = new ExtensionRunner([rotationExt as never], {} as never, cwd, {} as never, {} as never);
			runner.initialize({} as never, {} as never);
			const surfaced: Array<{ event: string }> = [];
			runner.onError(error => surfaced.push(error));
			await expect(
				runner.emit({
					type: eventType,
					reason: "new",
					previousSessionFile: path.join(cwd, "sessions", `ts_${sessionA}.jsonl`),
				} as never),
			).resolves.toBeUndefined();
			expect(surfaced).toEqual([]);

			// Rotation still publishes B and retires A despite the swallowed failure.
			const endpointBPath = path.join(cwd, ".gjc", "state", "sdk", `${sessionB}.json`);
			await waitFor(() => !fs.existsSync(endpointAPath) && fs.existsSync(endpointBPath), "rotated session endpoint");

			// The failure is logged at error severity with the shared prefix and A's
			// identity, never surfaced as a red extension error.
			const breadcrumbs = errorSpy.mock.calls.map(args => String(args[0]));
			expect(
				breadcrumbs.some(
					message =>
						message.startsWith("notifications: SDK notification runtime cleanup failed: ") &&
						message.includes(`SDK notification runtime ${sessionA} owner release failed`),
				),
			).toBe(true);

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
			errorSpy.mockRestore();
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
	socket.close();
	await waitFor(() => permissionProvider === undefined, "permission provider removal after disconnect");
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

test("Q17 returns resource_gone without an assistant and reads a completed persisted turn after reopen", async () => {
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
	const sessionContext = { ...context(cwd, sessionId), sessionManager };
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
		"empty Q17 response",
	);
	expect(
		JSON.parse(
			String(frames.find(frame => frame.type === "control_command_result" && frame.requestId === "before")?.message),
		),
	).toMatchObject({
		ok: false,
		error: { code: "resource_gone" },
	});
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
	const reopenedSessionContext = { ...context(cwd, sessionId), sessionManager: reopenedSessionManager };
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
		options: [{ value: "approve", label: "Approve" }],
	});
	await waitFor(() => gateId !== failedDirectPriorGateId, "failed-direct workflow gate");
	const failedDirectGateId = gateId;
	const actionFramesForGate = () =>
		frames.filter(frame => frame.type === "action_needed" && frame.workflowGateId === failedDirectGateId);
	await waitFor(() => actionFramesForGate().length === 1, "initial failed-direct presentation");
	const initialActionId = String(actionFramesForGate()[0]?.id);
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
		options: [{ value: "approve", label: "Approve" }],
	});
	await waitFor(() => gateId !== nextPriorGateId, "post-reissue workflow gate");
	const nextGateId = gateId;
	await waitFor(
		() => frames.some(frame => frame.type === "action_needed" && frame.workflowGateId === nextGateId),
		"post-reissue presentation",
	);
	const nextAction = frames.findLast(frame => frame.type === "action_needed" && frame.workflowGateId === nextGateId);
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
	const resolution = Promise.withResolvers<{ status: "accepted" }>();
	let resolutionStarted = false;
	let controllerDetached = false;
	const registerController = spyOn(emitter, "registerGateTerminalController").mockImplementation(() => () => {
		controllerDetached = true;
	});
	const resolveGate = spyOn(emitter, "resolveGate").mockImplementation(async response => {
		resolutionStarted = true;
		await resolution.promise;
		return {
			status: "accepted",
			gate_id: response.gate_id,
			answer_hash: "fixture",
			resolved_at: new Date().toISOString(),
		};
	});
	process.env.GJC_NOTIFICATIONS = "1";
	const sessionContext = context(cwd, sessionId, "main", {}, emitter);
	const handlers = start(sessionContext);
	const endpointFile = path.join(cwd, ".gjc", "state", "sdk", `${sessionId}.json`);
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
		void emitter.emitGate({ stage: "ralplan", kind: "approval", schema: { type: "string" } }).catch(() => {});
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
		const shutdown = handlers.get("session_shutdown")!({ type: "session_shutdown" }, sessionContext);
		await Bun.sleep(0);
		expect(controllerDetached).toBe(false);
		resolution.resolve({ status: "accepted" });
		await shutdown;
		expect(controllerDetached).toBe(true);
	} finally {
		resolveGate.mockRestore();
		registerController.mockRestore();
	}
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
		"test",
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
		isUnattended: () => true,
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
	const arbiter = new PresentationArbiter(server, () => false, "test");
	const gate = (gateId: string, multi = false) => ({
		gateId,
		...(gateId.startsWith("workflow") ? { workflowGateId: gateId } : {}),
		sessionId: "session",
		question: gateId,
		options: ["one", "two"],
		controls: [],
		multi,
		allowEmpty: false,
		selectedOptions: [],
	});
	arbiter.retain(gate("ordinary"));
	arbiter.retain(gate("workflow-first", true));
	await Bun.sleep(PresentationArbiter.retryBaseDelayMs + 10);
	expect(publications.map(action => action.workflowGateId)).toEqual([undefined]);
	arbiter.complete("ordinary");
	expect(publications.map(action => action.workflowGateId)).toEqual([undefined, "workflow-first"]);
	const firstActionId = publications[1]!.id as string;
	expect(arbiter.toggle(firstActionId, "one")).toBe(true);
	expect(publications).toHaveLength(3);
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
		"test",
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
		"test",
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
		"test",
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
		"test",
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
		"test",
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
		"test",
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
		getConfigItems: () => ({ "ui.theme": "light" }),
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
			input: { patch: { "ui.theme": "dark" } },
			expectedRevision: "0",
			idempotencyKey: "successful-verbs-config-patch",
		}),
	).toEqual({
		type: "control_response",
		id: "config-patch",
		ok: true,
		result: { patched: ["ui.theme"], revision: "1" },
	});
	expect(configWrites).toEqual([["ui.theme", "dark"]]);
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
		page: { items: [{ "ui.theme": "dark" }] },
	});
});
