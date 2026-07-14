import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Settings } from "../src/config/settings";
import { ExtensionRunner } from "../src/extensibility/extensions/runner";
import type {
	ExtensionActions,
	ExtensionContextActions,
	ExtensionUIContext,
} from "../src/extensibility/extensions/types";
import { ExtensionUiController } from "../src/modes/controllers/extension-ui-controller";
import {
	BrokerWorkflowGateEmitter,
	FileGateStore,
	type WorkflowGateEmitter,
} from "../src/modes/shared/agent-wire/workflow-gate-broker";
import type { InteractiveModeContext } from "../src/modes/types";
import { brokerOwnerForTest } from "../src/sdk/broker/ensure";
import { SessionIndex } from "../src/sdk/broker/session-index";
import { createNotificationsExtension } from "../src/sdk/bus";
import { SessionSdkHost } from "../src/sdk/host";
import type {
	ClientBridgePermissionOption,
	ClientBridgePermissionOutcome,
	ClientBridgePermissionToolCall,
} from "../src/session/client-bridge";

import { getAskAnswerSource } from "../src/tools/ask-answer-registry";

type SdkPermissionProvider =
	NonNullable<ExtensionContextActions["setSdkPermissionProvider"]> extends (provider: infer T) => void ? T : never;

const dirs: string[] = [];
const sockets: WebSocket[] = [];
afterEach(() => {
	for (const socket of sockets.splice(0)) socket.close();
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
	delete process.env.GJC_SDK_DISABLE;
	delete process.env.GJC_NOTIFICATIONS;
});

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
	const deadline = Date.now() + 4_000;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
		await Bun.sleep(20);
	}
}

function start(
	ctx: Record<string, unknown>,
	settings?: Settings,
	sendUserMessage: ExtensionActions["sendUserMessage"] = () => {},
	forwardPreflightCallbacks = false,
): Map<string, (event: unknown, context: unknown) => unknown> {
	const handlers = new Map<string, (event: unknown, context: unknown) => unknown>();
	createNotificationsExtension(
		{
			on: (event: string, handler: (event: unknown, context: unknown) => unknown) => handlers.set(event, handler),
			registerCommand: () => {},
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
		} as never,
		settings ? { settings } : undefined,
	);
	void handlers.get("session_start")?.({ type: "session_start" }, ctx);
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
			getSessionName: () => "SDK wiring",
			getUsageStatistics: () => ({ input: 1, output: 2, cacheRead: 0, cacheWrite: 0, premiumRequests: 0, cost: 0 }),
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
});

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
	void handlers.get("agent_start")?.({ type: "agent_start" }, sessionContext);

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
			{ deliverAs: "steer" },
		],
		[[{ type: "image", data: "d2VicC1ieXRlcw", mimeType: "image/webp" }], { deliverAs: "steer" }],
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
	socket.send(JSON.stringify({ type: "event_replay", id: "follow-up-replay", sinceGeneration: 1, sinceSeq: 0 }));
	await waitFor(
		() => frames.some(frame => frame.type === "event_replay_result" && frame.id === "follow-up-replay"),
		"correlated agent start replay",
	);
	const replay = frames.find(frame => frame.type === "event_replay_result" && frame.id === "follow-up-replay");
	expect(replay?.events).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				type: "event",
				kind: "agent_start",
				payload: expect.objectContaining({ type: "agent_start", sessionId, commandId, turnId }),
			}),
		]),
	);
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
	const live = { idle: false };
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

test("Q17 returns resource_gone before the host has an assistant message and returns it after", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-last-assistant-"));
	dirs.push(cwd);
	const sessionId = `sdk-q17-${Date.now()}`;
	let lastAssistant: string | undefined;
	start({
		...context(cwd, sessionId),
		sessionManager: {
			...(context(cwd, sessionId).sessionManager as object),
			getLastAssistantText: () => lastAssistant,
		},
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
			String(
				frames.find(
					frame =>
						frame.type === "control_command_result" && frame.requestId === "before" && frame.status === "ok",
				)?.message,
			),
		),
	).toMatchObject({ ok: false, error: { code: "resource_gone" } });
	lastAssistant = "Assistant reply";
	query("after");
	await waitFor(
		() =>
			frames.some(
				frame => frame.type === "control_command_result" && frame.requestId === "after" && frame.status === "ok",
			),
		"message Q17 response",
	);
	expect(
		JSON.parse(
			String(
				frames.find(
					frame => frame.type === "control_command_result" && frame.requestId === "after" && frame.status === "ok",
				)?.message,
			),
		),
	).toMatchObject({ ok: true, page: { items: ["Assistant reply"] } });
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

test("SDK host discovers, answers, and advances a durable workflow gate", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-host-workflow-gate-"));
	dirs.push(cwd);
	const sessionId = `workflow-gate-${Date.now()}`;
	const emitter = new BrokerWorkflowGateEmitter(
		sessionId,
		new FileGateStore(path.join(cwd, ".gjc", "state", "workflow-gates.json")),
	);
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
	expect(await request("gates", { type: "query_request", id: "gates", query: "Q12" })).toMatchObject({
		ok: true,
		page: { items: [{ gate_id: gateId }] },
	});
	expect(
		await request("answer", {
			type: "control_request",
			id: "answer",
			operation: "workflow.gate_answer",
			input: { id: gateId, response: "approve" },
		}),
	).toMatchObject({ ok: true, result: { status: "accepted" } });
	expect(await advance).toBe("approve");
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
