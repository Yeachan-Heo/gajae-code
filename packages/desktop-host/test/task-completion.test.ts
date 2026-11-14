/** Real Agent/AgentSession run and queue contracts, with an in-process provider stream. */
import { afterEach, beforeEach, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import type { AssistantMessage, Model } from "@gajae-code/ai/core";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";
import { setModelPresetRegistryDisabled } from "@gajae-code/coding-agent/config/model-preset-registry";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { ExtensionRunner, loadExtensions } from "@gajae-code/coding-agent/extensibility/extensions";
import type { CreateAgentSessionResult } from "@gajae-code/coding-agent/sdk";
import {
	AgentSession,
	type AgentSessionEvent,
	type AutoSessionTitleResult,
	type QueuedInputTerminal,
} from "@gajae-code/coding-agent/session/agent-session";
import { EventBus } from "@gajae-code/coding-agent/utils/event-bus";
import { getAgentDir, setAgentDir } from "@gajae-code/utils";
import { DeliveryJournal } from "../src/delivery-journal";
import { DesktopHost } from "../src/host";
import {
	type DesktopFrame,
	type DesktopProject,
	type DesktopRequest,
	type DesktopSession,
	type DesktopSnapshot,
	parseRequest,
} from "../src/protocol";

const model: Model = {
	id: "completion-fixture",
	name: "Controlled completion fixture",
	provider: "desktop-completion-fixture",
	api: "openai-completions",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 1024,
};

let environment: NodeJS.ProcessEnv;
let previousAgentDir: string;
const cleanups: Array<() => Promise<void>> = [];
beforeEach(() => {
	environment = { ...process.env };
	previousAgentDir = getAgentDir();
	process.env.GJC_DESKTOP_ISOLATED = "1";
	// Only task responses use this fixture's controlled provider stream.
	// Automatic title generation has separate real-SDK coverage.
	process.env.GJC_NO_TITLE = "1";
	delete process.env.GJC_CODING_AGENT_DIR;
	vi.spyOn(ModelRegistry.prototype, "refresh").mockResolvedValue(undefined);
});
afterEach(async () => {
	try {
		while (cleanups.length) await cleanups.pop()?.();
	} finally {
		vi.restoreAllMocks();
		for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key];
		Object.assign(process.env, environment);
		setAgentDir(previousAgentDir);
	}
});

type Observed<T> = { ok: true; value: T } | { ok: false; error: unknown };
function observe<T>(promise: Promise<T>): Promise<Observed<T>> {
	return promise.then<Observed<T>, Observed<T>>(
		value => ({ ok: true, value }),
		error => ({ ok: false, error }),
	);
}

async function until(predicate: () => boolean, diagnostic?: () => string): Promise<void> {
	const deadline = Date.now() + 3_000;
	while (!predicate()) {
		if (Date.now() >= deadline)
			throw new Error(`Completion fixture did not reach its expected state${diagnostic ? `: ${diagnostic()}` : ""}`);
		await Bun.sleep(5);
	}
}

function overrideNextRead<T extends object, K extends keyof T>(target: T, key: K, value: T[K]) {
	const original = Object.getOwnPropertyDescriptor(target, key);
	let reads = 0;
	let restored = false;
	const mockRestore = () => {
		if (restored) return;
		restored = true;
		if (original) Object.defineProperty(target, key, original);
		else Reflect.deleteProperty(target, key);
	};
	Object.defineProperty(target, key, {
		configurable: true,
		get: () => {
			reads++;
			// Restore before returning the stale snapshot: subsequent persistence
			// and cleanup must observe only the genuine SDK/manager identity.
			mockRestore();
			return value;
		},
	});
	return { mockRestore, reads: () => reads };
}

async function launch(
	options: {
		projectTerminal?: (event: AgentSessionEvent) => AgentSessionEvent | undefined;
		handledInput?: boolean;
		followUpMode?: "all" | "one-at-a-time";
	} = {},
) {
	const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gjc-task-completion-")));
	const dataDir = path.join(directory, "app");
	const cwd = path.join(directory, "project");
	await fs.mkdir(cwd);
	await setModelPresetRegistryDisabled({ agentDir: path.join(dataDir, "agent"), disabled: true });
	const extensionPath = path.join(directory, "handled-input.ts");
	if (options.handledInput)
		await Bun.write(extensionPath, 'export default api => { api.on("input", async () => ({ handled: true })); };\n');
	const frames: DesktopFrame[] = [];
	const terminals: AgentSessionEvent[] = [];
	const launchedAt = performance.now();
	const timeline: Array<{ ms: number; event: string; detail?: unknown }> = [];
	const trace = (event: string, detail?: unknown) => {
		if (timeline.length === 64) timeline.shift();
		timeline.push({
			ms: Math.round(performance.now() - launchedAt),
			event,
			...(detail === undefined ? {} : { detail }),
		});
	};
	let sdk!: AgentSession;
	const streams: Array<{
		stream: AssistantMessageEventStream;
		finish: (reason?: "stop" | "error") => void;
		abort: () => void;
		isSettled: () => boolean;
	}> = [];
	const requests = new Set<Promise<unknown>>();
	const titles = new Set<Promise<AutoSessionTitleResult>>();
	let closing = false;
	const host = new DesktopHost({
		dataDir,
		emit: frame => {
			frames.push(frame);
			if (frame.type === "delivery")
				trace("host:delivery", { id: frame.receipt.id, disposition: frame.receipt.disposition });
			else if (frame.type === "response") trace("host:response", { id: frame.id, ok: frame.ok });
		},
		createSession: async input => {
			if (!input.sessionManager || !input.settings || !input.modelRegistry || !input.authStorage)
				throw new Error("Host must provide actual scoped SDK services");
			input.authStorage.setRuntimeApiKey(model.provider, "local-only");
			input.settings.override("compaction.enabled", false);
			input.settings.override("retry.enabled", false);
			const agent = new Agent({
				initialState: { model, messages: [], tools: [], systemPrompt: [] },
				followUpMode: options.followUpMode ?? "one-at-a-time",
				getApiKey: () => {
					trace("agent:api-key-resolved");
					return "local-only";
				},
				streamFn: (_model, _context, streamOptions) => {
					trace("provider:entered", { stream: streams.length + 1 });
					const stream = new AssistantMessageEventStream();
					const message: AssistantMessage = {
						role: "assistant",
						content: [{ type: "text", text: "working" }],
						api: model.api,
						provider: model.provider,
						model: model.id,
						stopReason: "stop",
						timestamp: Date.now(),
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
					};
					let settled = false;
					const settle = (reason: "stop" | "error" | "aborted") => {
						if (settled) return;
						settled = true;
						streamOptions?.signal?.removeEventListener("abort", abort);
						message.stopReason = reason;
						if (reason === "stop") {
							message.content = [{ type: "text", text: "private provider answer" }];
							stream.push({ type: "done", reason, message });
						} else {
							message.errorMessage = reason === "error" ? "Controlled provider failure" : "Request was aborted";
							stream.push({ type: "error", reason, error: message });
						}
					};
					const abort = () => settle("aborted");
					streams.push({
						stream,
						finish: (reason = "stop") => {
							if (settled) throw new Error("Fixture provider stream was already settled");
							settle(reason);
						},
						abort,
						isSettled: () => settled,
					});
					streamOptions?.signal?.addEventListener("abort", abort, { once: true });
					queueMicrotask(() => {
						stream.push({ type: "start", partial: message });
						stream.push({ type: "text_delta", contentIndex: 0, delta: "working", partial: message });
						if (closing || streamOptions?.signal?.aborted) abort();
					});
					return stream;
				},
			});
			// Observe public events only; no context/preflight pipeline is replaced.
			const unsubscribeAgentTrace = agent.subscribe(event => {
				if (event.type === "message_update") return;
				trace(`agent:${event.type}`, {
					...("scope" in event && event.scope ? { scope: event.scope } : {}),
					...("message" in event ? { role: event.message.role } : {}),
					...(event.type === "agent_end" ? { stopReason: event.stopReason } : {}),
				});
			});
			const eventBus = new EventBus();
			const extensionsResult = await loadExtensions(options.handledInput ? [extensionPath] : [], cwd, eventBus);
			const runner = options.handledInput
				? new ExtensionRunner(
						extensionsResult.extensions,
						extensionsResult.runtime,
						cwd,
						input.sessionManager,
						input.modelRegistry,
					)
				: undefined;
			sdk = new AgentSession({
				agent,
				sessionManager: input.sessionManager,
				settings: input.settings,
				modelRegistry: input.modelRegistry,
				agentDir: input.agentDir,
				workflowGatePublication: "local",
				extensionRunner: runner,
			});
			// Host starts title generation independently of request/turn settlement.
			// Retain its actual promise so fixture teardown also joins that owner.
			const generateTitle = sdk.generateAutoSessionTitle.bind(sdk);
			vi.spyOn(sdk, "generateAutoSessionTitle").mockImplementation((text, options) => {
				const title = generateTitle(text, options);
				titles.add(title);
				void title.then(
					() => titles.delete(title),
					() => titles.delete(title),
				);
				return title;
			});
			sdk.registerToolSessionCleanup(() => {
				unsubscribeAgentTrace();
				eventBus.clear();
			});
			sdk.subscribe(event => {
				if (event.type === "agent_end") terminals.push(event);
				if (event.type === "message_update") return;
				trace(`sdk:${event.type}`, {
					...("scope" in event && event.scope ? { scope: event.scope } : {}),
					...("message" in event && typeof event.message !== "string" ? { role: event.message.role } : {}),
					...(event.type === "agent_end" ? { stopReason: event.stopReason } : {}),
				});
			});
			if (options.projectTerminal) {
				const subscribe = sdk.subscribe.bind(sdk);
				vi.spyOn(sdk, "subscribe").mockImplementation(listener =>
					subscribe(event => {
						const projected = event.type === "agent_end" ? options.projectTerminal!(event) : event;
						if (projected) listener(projected);
					}),
				);
			}
			return {
				session: sdk,
				eventBus,
				extensionsResult,
				setToolUIContext: () => {},
			} satisfies CreateAgentSessionResult;
		},
	});
	cleanups.push(async () => {
		closing = true;
		for (const stream of streams) stream.abort();
		try {
			// A response/agent_end is not the SDK's settlement or durable sidecar
			// barrier. Drain those actual owners before starting bounded disposal.
			await Promise.allSettled([...requests]);
			if (sdk && !sdk.sessionLifecycle.disposed) {
				await sdk.waitForIdle();
				await sdk.awaitSessionSettlement();
				await sdk.awaitCoordinatorRuntimeStatePersistenceForTests();
			}
			await Promise.all([...titles]);
		} finally {
			await host.close();
		}
		// A failed close retains ownership; leave its directory intact rather
		// than deleting files that an outstanding teardown may still use.
		await fs.rm(directory, { recursive: true, force: true });
	});
	const call = <T>(
		method: DesktopRequest["method"],
		params: Record<string, unknown> = {},
		id: string = crypto.randomUUID(),
	): Promise<T> => {
		trace("host:request", { id, method });
		const request = (async () => {
			await host.handle(parseRequest(JSON.stringify({ id, method, params })));
			const response = frames.findLast(frame => frame.type === "response" && frame.id === id);
			if (response?.type !== "response") throw new Error("Missing Desktop response");
			if (!response.ok) throw new Error(response.error);
			return response.result as T;
		})();
		requests.add(request);
		// A prompt may reject while the test is controlling another request/stream.
		// Keep its original rejection observable without leaking it between tests.
		void request.then(
			() => requests.delete(request),
			() => requests.delete(request),
		);
		return request;
	};
	const project = await call<DesktopProject>("project.open", { path: cwd });
	const session = await call<DesktopSession>("session.create", { projectId: project.id });
	return {
		host,
		call,
		project,
		session,
		sdk,
		frames,
		terminals,
		dataDir,
		completions: () => frames.filter(frame => frame.type === "task-completed"),
		streamCount: () => streams.length,
		started: (count = 1) =>
			until(
				() => {
					const stream = streams[count - 1];
					return !!stream && !stream.isSettled() && stream.stream.hasActiveConsumer;
				},
				() =>
					JSON.stringify({
						waitingForProviderStream: count,
						streams: streams.map(stream => ({
							settled: stream.isSettled(),
							consumer: stream.stream.hasActiveConsumer,
						})),
						streaming: sdk?.isStreaming,
						awaitingIdle: sdk?.isAwaitingIdle,
						timeline,
						responses: frames.flatMap(frame =>
							frame.type === "response"
								? [{ id: frame.id, ok: frame.ok, ...(!frame.ok ? { error: frame.error } : {}) }]
								: [],
						),
					}),
			),
		finish: (reason?: "stop" | "error") => {
			const stream = streams.at(-1);
			if (!stream) throw new Error("No active fixture stream");
			stream.finish(reason);
		},
		snapshot: () => call<DesktopSnapshot>("bootstrap"),
	};
}

test("local success emits one opaque actual-run notice, never receipt/bootstrap/history replay", async () => {
	const h = await launch();
	const running = h.call("prompt", { sessionId: h.session.id, text: "private user task" }, "input-identity");
	await h.started();
	expect(h.completions()).toEqual([]);
	h.finish();
	await running;
	const notices = h.completions();
	expect(notices).toHaveLength(1);
	const notice = notices[0]!;
	const terminal = h.terminals.find(event => event.type === "agent_end" && event.scope);
	if (notice.type !== "task-completed" || terminal?.type !== "agent_end" || !terminal.scope)
		throw new Error("Expected actual scoped completion proof");
	const identity: unknown[] = JSON.parse(notice.id);
	expect(identity).toEqual([
		expect.any(String),
		h.session.id,
		"local",
		terminal.scope.lineage,
		terminal.scope.generation,
		terminal.scope.attemptId,
	]);
	expect(Object.keys(notice).sort()).toEqual(["id", "sessionId", "type"]);
	expect(notice.sessionId).toBe(h.session.id);
	expect(notice.id).not.toContain("input-identity");
	expect(JSON.stringify(notice)).not.toContain("private");
	await h.call("history.get", { sessionId: h.session.id });
	await h.call("session.select", { sessionId: h.session.id });
	await h.call("delivery.ack", { deliveryId: "input-identity" });
	const snapshot = await h.snapshot();
	expect(JSON.stringify(snapshot)).not.toContain(notice.id);
	expect(await Bun.file(path.join(h.dataDir, "catalog.json")).text()).not.toContain(notice.id);
	expect(await Bun.file(path.join(h.dataDir, "deliveries.json")).text()).not.toContain(notice.id);
	expect(h.completions()).toEqual(notices);
	await h.host.close();
	const reopened = new DesktopHost({ dataDir: h.dataDir, emit: frame => h.frames.push(frame) });
	cleanups.push(() => reopened.close());
	await reopened.handle(parseRequest(JSON.stringify({ id: "reopened-bootstrap", method: "bootstrap", params: {} })));
	expect(h.frames.find(frame => frame.type === "response" && frame.id === "reopened-bootstrap")).toMatchObject({
		ok: true,
	});
	expect(h.completions()).toEqual(notices);
});

test("distinct actual local attempt scopes each notify", async () => {
	const h = await launch();
	for (let index = 1; index <= 2; index++) {
		const running = h.call("prompt", { sessionId: h.session.id, text: `task ${index}` });
		await h.started(index);
		h.finish();
		await running;
	}
	expect(h.completions()).toHaveLength(2);
	expect(new Set(h.completions().map(frame => (frame.type === "task-completed" ? frame.id : "")))).toHaveProperty(
		"size",
		2,
	);
});

for (const followUpMode of ["all", "one-at-a-time"] as const) {
	test(`multiple queued inputs sharing actual terminal scope notify once in ${followUpMode} mode`, async () => {
		// One-at-a-time needs three provider responses; batching needs two. Neither
		// provider response count nor intermediate attempt scopes prove completion.
		const h = await launch({ followUpMode });
		const queuedTerminals: QueuedInputTerminal[] = [];
		const original = h.sdk.submitUserMessage.bind(h.sdk);
		vi.spyOn(h.sdk, "submitUserMessage").mockImplementation(async (text, options) => {
			const submission = await original(text, options);
			return {
				...submission,
				terminal: submission.terminal.then(outcome => {
					const cloned =
						outcome.disposition === "completed"
							? { ...outcome, attemptScope: { ...outcome.attemptScope } }
							: outcome;
					queuedTerminals.push(cloned);
					return cloned;
				}),
			};
		});
		const running = observe(h.call("prompt", { sessionId: h.session.id, text: "initial" }, "initial"));
		await h.started();
		for (const id of ["queued-one", "queued-two"])
			await h.call("prompt", { sessionId: h.session.id, text: id, deliverAs: "followUp" }, id);
		expect(h.completions()).toEqual([]);
		h.finish();
		await h.started(2);
		h.finish();
		if (followUpMode === "one-at-a-time") {
			await h.started(3);
			expect(h.completions()).toEqual([]);
			h.finish();
		}
		const initial = await running;
		// The initial handle may lack the continuation's exact terminal scope;
		// that remains uncertainty, not an inferred failed/successful turn.
		if (!initial.ok) expect(initial.error).toMatchObject({ message: "Prompt outcome unknown" });
		await until(
			() =>
				h.frames.filter(
					frame =>
						frame.type === "delivery" &&
						frame.receipt.id.startsWith("queued-") &&
						frame.receipt.disposition === "completed",
				).length >= 2,
		);
		expect(queuedTerminals).toHaveLength(2);
		const completed = queuedTerminals.flatMap(terminal => (terminal.disposition === "completed" ? [terminal] : []));
		expect(completed).toHaveLength(2);
		expect(completed[0]!.attemptScope).toEqual(completed[1]!.attemptScope);
		expect(completed[0]!.attemptScope).not.toBe(completed[1]!.attemptScope);
		const scope = completed[0]!.attemptScope;
		expect(h.terminals).toContainEqual(
			expect.objectContaining({ type: "agent_end", scope, stopReason: "completed" }),
		);
		await until(() => h.completions().length === 1);
		const notice = h.completions()[0]!;
		if (notice.type !== "task-completed") throw new Error("Missing scoped notice");
		expect(JSON.parse(notice.id).slice(3)).toEqual([scope.lineage, scope.generation, scope.attemptId]);
		expect(h.completions()).toHaveLength(1);
		expect(h.streamCount()).toBe(followUpMode === "all" ? 2 : 3);
	});
}

for (const mode of [
	"no-scope",
	"unrelated-scope",
	"malformed-scope",
	"no-assistant",
	"no-terminal-reason",
	"waiting",
	"length",
	"toolUse",
] as const) {
	test(`does not infer local success from ${mode} events`, async () => {
		const h = await launch({
			projectTerminal: event => {
				if (event.type !== "agent_end") return event;
				if (mode === "no-scope") return { ...event, scope: undefined };
				if (mode === "unrelated-scope" && event.scope)
					return { ...event, scope: { ...event.scope, attemptId: crypto.randomUUID() } };
				if (mode === "malformed-scope" && event.scope)
					return { ...event, scope: { ...event.scope, generation: Number.NaN } };
				if (mode === "no-assistant") return { ...event, messages: [] };
				if (mode === "no-terminal-reason") return { ...event, stopReason: undefined };
				if (mode === "waiting") return { ...event, stopReason: "paused" };
				if (mode === "length" || mode === "toolUse")
					return {
						...event,
						messages: event.messages.map(message =>
							message.role === "assistant" ? { ...message, stopReason: mode } : message,
						),
					};
				return event;
			},
		});
		const running = h.call("prompt", { sessionId: h.session.id, text: mode });
		await h.started();
		h.finish();
		await running;
		expect(h.completions()).toEqual([]);
	});
}

for (const result of ["error", "abort", "no-scope", "length"] as const) {
	test(`queued ${result} never creates a success notice for its attempt`, async () => {
		const h = await launch({
			projectTerminal: event => {
				if (event.type !== "agent_end") return event;
				if (result === "no-scope") return { ...event, scope: undefined };
				if (result === "length")
					return {
						...event,
						messages: event.messages.map(message =>
							message.role === "assistant" ? { ...message, stopReason: "length" } : message,
						),
					};
				return event;
			},
		});
		const running = observe(h.call("prompt", { sessionId: h.session.id, text: "initial" }, "initial-queued-case"));
		await h.started();
		await h.call("prompt", { sessionId: h.session.id, text: "queued", deliverAs: "followUp" }, "queued-case");
		h.finish();
		await h.started(2);
		if (result === "error") h.finish("error");
		else if (result === "abort") await h.call("abort", { sessionId: h.session.id });
		else h.finish();
		const initial = await running;
		if (!initial.ok) {
			expect(initial.error).toBeInstanceOf(Error);
			expect((initial.error as Error).message).toMatch(/^Prompt (failed|outcome unknown)$/);
		}
		await until(() =>
			h.frames.some(
				frame =>
					frame.type === "delivery" &&
					frame.receipt.id === "queued-case" &&
					["failed", "unknown", "completed"].includes(frame.receipt.disposition),
			),
		);
		const receipt = (await h.snapshot()).deliveries.find(item => item.id === "queued-case");
		expect(receipt?.disposition).toBe(result === "error" ? "failed" : result === "length" ? "completed" : "unknown");
		const queuedTerminal = h.terminals.filter(event => event.type === "agent_end").at(-1);
		if (queuedTerminal?.type !== "agent_end" || !queuedTerminal.scope)
			throw new Error("Missing real queued terminal");
		const assistant = queuedTerminal.messages.filter(message => message.role === "assistant").at(-1);
		expect(assistant?.stopReason).toBe(result === "error" ? "error" : result === "abort" ? "aborted" : "stop");
		expect(
			h
				.completions()
				.some(
					frame => frame.type === "task-completed" && JSON.parse(frame.id)[5] === queuedTerminal.scope?.attemptId,
				),
		).toBe(false);
	});
}

test("removing accepted queued input never notifies that input", async () => {
	const h = await launch();
	const running = h.call("prompt", { sessionId: h.session.id, text: "initial" });
	await h.started();
	const queued = await h.call<{ submissionId: string }>(
		"prompt",
		{ sessionId: h.session.id, text: "cancelled", deliverAs: "followUp" },
		"cancelled",
	);
	await h.call("queue.cancel", { sessionId: h.session.id, queueId: queued.submissionId });
	expect(h.completions()).toEqual([]);
	h.finish();
	await running;
	expect(h.completions()).toHaveLength(1);
	expect((await h.snapshot()).deliveries.find(receipt => receipt.id === "cancelled")?.disposition).toBe("cancelled");
});

test("a successful terminal without this input's accepted run handle cannot notify", async () => {
	const h = await launch();
	const prompt = h.sdk.prompt.bind(h.sdk);
	vi.spyOn(h.sdk, "prompt").mockImplementation((text, options) =>
		prompt(text, { ...options, onRunAccepted: () => {} }),
	);
	const running = h.call("prompt", { sessionId: h.session.id, text: "no actual run handle" });
	await h.started();
	h.finish();
	await running;
	expect(h.terminals.some(event => event.type === "agent_end" && event.stopReason === "completed")).toBe(true);
	expect(h.completions()).toEqual([]);
});

for (const reason of ["error", "abort"] as const) {
	test(`a real local ${reason} never notifies`, async () => {
		const h = await launch();
		const running = h.call("prompt", { sessionId: h.session.id, text: reason });
		await h.started();
		if (reason === "error") h.finish("error");
		else await h.call("abort", { sessionId: h.session.id });
		await expect(running).rejects.toThrow(reason === "error" ? "Prompt failed" : "Prompt outcome unknown");
		expect(h.completions()).toEqual([]);
	});
}

test("accepted-only work, extension-handled input, pure builtins and retry booleans never notify", async () => {
	const h = await launch({ handledInput: true });
	await h.call("prompt", { sessionId: h.session.id, text: "handled locally" });
	await h.call("command.run", { sessionId: h.session.id, text: "/jobs" });
	vi.spyOn(h.sdk, "retry").mockResolvedValue(true);
	await h.call("session.retry", { sessionId: h.session.id });
	expect(h.completions()).toEqual([]);
	const plain = await launch();
	vi.spyOn(plain.sdk, "prompt").mockImplementation(async (_text, options) => {
		await options?.onPreflightAcceptCommit?.();
	});
	await plain.call("prompt", { sessionId: plain.session.id, text: "accepted only" });
	expect((await plain.snapshot()).deliveries.at(-1)?.disposition).toBe("unknown");
	expect(plain.completions()).toEqual([]);
});

for (const state of ["generation", "transitioning", "disposed", "session-identity", "cwd"] as const) {
	test(`late successful proof cannot notify after local ${state} changes`, async () => {
		const h = await launch();
		const persisted = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const update = DeliveryJournal.prototype.update;
		const fence: {
			inject?: () => { mockRestore(): void; reads(): number };
			changed?: { mockRestore(): void; reads(): number };
		} = {};
		const journal = vi.spyOn(DeliveryJournal.prototype, "update").mockImplementation(async function (
			this: DeliveryJournal,
			id,
			changes,
		) {
			await update.call(this, id, changes);
			if (id === "stale-success" && changes.disposition === "completed") {
				persisted.resolve();
				await release.promise;
				// No more awaited work before Host receives the successful update.
				// Its next identity read belongs to the completion fence, not SDK I/O.
				fence.changed = fence.inject?.();
			}
		});
		const running = observe(h.call("prompt", { sessionId: h.session.id, text: "old live owner" }, "stale-success"));
		try {
			await h.started();
			h.finish();
			await persisted.promise;
			// Finish the real successful turn and all asynchronous writer work before
			// exposing a stale snapshot to exactly one Host notification guard read.
			await h.sdk.waitForIdle();
			await h.sdk.awaitSessionSettlement();
			await h.sdk.awaitCoordinatorRuntimeStatePersistenceForTests();
			const terminal = h.terminals.find(event => event.type === "agent_end");
			expect(terminal).toMatchObject({ stopReason: "completed", scope: expect.any(Object) });
			if (terminal?.type !== "agent_end") throw new Error("Missing actual successful terminal");
			expect(terminal.messages.filter(message => message.role === "assistant").at(-1)?.stopReason).toBe("stop");
			expect(h.completions()).toEqual([]);
			const lifecycle = h.sdk.sessionLifecycle;
			const manager = h.sdk.sessionManager;
			const identityGeneration = manager.getSessionIdentityGeneration();
			fence.inject = () =>
				state === "session-identity"
					? overrideNextRead(manager, "getSessionIdentityGeneration", () => identityGeneration + 1)
					: state === "cwd"
						? overrideNextRead(manager, "getCwd", () => path.join(h.project.path, "replacement"))
						: overrideNextRead(h.sdk, "sessionLifecycle", {
								...lifecycle,
								generation: lifecycle.generation + (state === "generation" ? 1 : 0),
								transitioning: state === "transitioning",
								disposed: state === "disposed",
							});
			release.resolve();
			const outcome = await running;
			expect(outcome.ok).toBe(true);
			expect(fence.changed?.reads()).toBe(1);
			expect(h.completions()).toEqual([]);
			expect(h.sdk.sessionLifecycle).toEqual(lifecycle);
			expect(manager.getSessionIdentityGeneration()).toBe(identityGeneration);
			expect(manager.getCwd()).toBe(h.project.path);
		} finally {
			fence.inject = undefined;
			fence.changed?.mockRestore();
			release.resolve();
			try {
				// Also settle preflight/stream ownership when an earlier assertion
				// failed, rather than awaiting a still-controlled request forever.
				await h.sdk.abort();
				await running;
			} finally {
				journal.mockRestore();
			}
		}
	});
}

test("already-successful local proof cannot notify after its live owner retires during receipt persistence", async () => {
	const h = await launch();
	const persisting = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const update = DeliveryJournal.prototype.update;
	const journal = vi.spyOn(DeliveryJournal.prototype, "update").mockImplementation(async function (
		this: DeliveryJournal,
		id,
		changes,
	) {
		if (id === "retired-success" && changes.disposition === "completed") {
			persisting.resolve();
			await release.promise;
		}
		await update.call(this, id, changes);
	});
	const running = h.call("prompt", { sessionId: h.session.id, text: "successful but retired" }, "retired-success");
	try {
		await h.started();
		h.finish();
		await persisting.promise;
		await h.call("project.close", { projectId: h.project.id });
		release.resolve();
		await running;
		expect(h.terminals.some(event => event.type === "agent_end" && event.stopReason === "completed")).toBe(true);
		expect(h.completions()).toEqual([]);
	} finally {
		release.resolve();
		journal.mockRestore();
	}
});

for (const retirement of ["project", "host"] as const) {
	test(`retiring the ${retirement} never notifies its pending input`, async () => {
		const h = await launch();
		const running = observe(h.call("prompt", { sessionId: h.session.id, text: "retired work" }));
		await h.started();
		if (retirement === "project") await h.call("project.close", { projectId: h.project.id });
		else await h.host.close();
		const outcome = await running;
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) {
			expect(outcome.error).toBeInstanceOf(Error);
			expect((outcome.error as Error).message).toMatch(/^(Prompt outcome unknown|Host is closed)$/);
		}
		expect(h.completions()).toEqual([]);
	});
}
