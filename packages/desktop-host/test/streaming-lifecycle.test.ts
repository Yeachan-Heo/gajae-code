/** Real SDK streaming/queue/persistence lifecycle with an in-process controlled provider stream. */
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, type AgentTool } from "@gajae-code/agent-core";
import { z } from "@gajae-code/ai";
import type { AssistantMessage, Model } from "@gajae-code/ai/core";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";
import { setModelPresetRegistryDisabled } from "@gajae-code/coding-agent/config/model-preset-registry";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import {
	ExtensionRunner,
	type ExtensionUIContext,
	loadExtensions,
} from "@gajae-code/coding-agent/extensibility/extensions";
import type { CreateAgentSessionResult } from "@gajae-code/coding-agent/sdk";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { EventBus } from "@gajae-code/coding-agent/utils/event-bus";
import { getAgentDir, setAgentDir } from "@gajae-code/utils";
import { createSdkRunCapability } from "../../coding-agent/src/sdk/host/sdk-run-capability";
import { DeliveryJournal } from "../src/delivery-journal";
import { DesktopHost } from "../src/host";
import {
	type DesktopCommandResult,
	type DesktopFrame,
	type DesktopHistory,
	type DesktopProject,
	type DesktopRequest,
	type DesktopSession,
	type DesktopSnapshot,
	parseRequest,
} from "../src/protocol";

const model: Model = {
	id: "controlled",
	name: "Controlled local stream",
	provider: "desktop-stream-fixture",
	api: "openai-completions",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 1024,
};

function controlledAgent() {
	const started = Promise.withResolvers<void>();
	const prompts: string[] = [];
	let aborts = 0;
	let finishTurn: ((text: string, failed?: boolean) => void) | undefined;
	let finishWithToolCall: (() => void) | undefined;
	let toolCalls = 0;
	let toolEntered = Promise.withResolvers<void>();
	let releaseTool: (() => void) | undefined;
	// A real tool the controlled model can call; it runs until the test releases it or the run aborts.
	const read: AgentTool = {
		name: "read",
		label: "Read",
		description: "Parks until the test releases it",
		parameters: z.object({ path: z.string() }),
		execute: async (_id, _args, signal) => {
			const released = Promise.withResolvers<void>();
			releaseTool = () => released.resolve();
			signal?.addEventListener("abort", () => released.resolve(), { once: true });
			toolEntered.resolve();
			await released.promise;
			return { content: [{ type: "text", text: "file body" }] };
		},
	};
	const agent = new Agent({
		initialState: { model, messages: [], tools: [read], systemPrompt: [] },
		getApiKey: () => "local-stream-only",
		streamFn: (_model, context, options) => {
			const text = context.messages
				.flatMap(message =>
					message.role === "user"
						? [
								typeof message.content === "string"
									? message.content
									: message.content
											.filter(block => block.type === "text")
											.map(block => block.text)
											.join(""),
							]
						: [],
				)
				.join("\n");
			prompts.push(text);
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
			let done = false;
			const settle = (aborted: boolean, response = "", failed = false) => {
				if (done) return;
				done = true;
				options?.signal?.removeEventListener("abort", abort);
				if (aborted) {
					aborts++;
					message.stopReason = "aborted";
					stream.push({ type: "error", reason: "aborted", error: message });
				} else if (failed) {
					message.stopReason = "error";
					message.errorMessage = "controlled provider failure";
					stream.push({ type: "error", reason: "error", error: message });
				} else {
					message.content = [{ type: "text", text: response }];
					stream.push({ type: "done", reason: "stop", message });
				}
			};
			const abort = () => settle(true);
			finishTurn = (response, failed) => settle(false, response, failed);
			finishWithToolCall = () => {
				if (done) return;
				done = true;
				options?.signal?.removeEventListener("abort", abort);
				message.content = [
					{ type: "toolCall", id: `read-${++toolCalls}`, name: "read", arguments: { path: "a.ts" } },
				];
				message.stopReason = "toolUse";
				stream.push({ type: "done", reason: "toolUse", message });
			};
			options?.signal?.addEventListener("abort", abort, { once: true });
			queueMicrotask(() => {
				stream.push({ type: "start", partial: message });
				stream.push({ type: "text_delta", contentIndex: 0, delta: "working", partial: message });
				if (options?.signal?.aborted) abort();
			});
			return stream;
		},
	});
	agent.subscribe(event => {
		if (event.type === "message_update") started.resolve();
	});
	return {
		agent,
		started: started.promise,
		prompts,
		get aborts() {
			return aborts;
		},
		finishTurn(response: string, failed = false) {
			if (!finishTurn) throw new Error("No controlled provider turn is running");
			finishTurn(response, failed);
		},
		/** Ends the streaming turn with a `read` call and resolves once that tool is running. */
		callTool(): Promise<void> {
			if (!finishWithToolCall) throw new Error("No controlled provider turn is running");
			toolEntered = Promise.withResolvers<void>();
			finishWithToolCall();
			return toolEntered.promise;
		},
		releaseTool() {
			if (!releaseTool) throw new Error("No controlled tool is running");
			releaseTool();
		},
	};
}

/** The visible text of a transcript message, for asserting what actually reached the conversation. */
const copyText = (message: AgentSession["messages"][number]): string =>
	!("content" in message)
		? ""
		: typeof message.content === "string"
			? message.content
			: message.content.map(block => (block.type === "text" ? block.text : "")).join("");

describe("desktop streaming lifecycle", () => {
	let environment: NodeJS.ProcessEnv;
	let previousAgentDir: string;
	beforeEach(() => {
		environment = { ...process.env };
		previousAgentDir = getAgentDir();
		process.env.GJC_DESKTOP_ISOLATED = "1";
		delete process.env.GJC_CODING_AGENT_DIR;
	});
	const cleanups: Array<() => Promise<void>> = [];
	afterEach(async () => {
		try {
			while (cleanups.length > 0) await cleanups.pop()?.();
		} finally {
			vi.restoreAllMocks();
			for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key];
			Object.assign(process.env, environment);
			setAgentDir(previousAgentDir);
		}
	});

	async function launch(withRunner = false, extensionSource?: string) {
		const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-desktop-stream-"));
		const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-desktop-project-"));
		await setModelPresetRegistryDisabled({ agentDir: path.join(dataDir, "agent"), disabled: true });
		await Bun.write(
			path.join(projectDir, ".gjc", "config.yml"),
			"compaction:\n  enabled: false\nretry:\n  enabled: false\n",
		);
		const extensionPath = path.join(projectDir, "input-extension.ts");
		if (extensionSource) await Bun.write(extensionPath, extensionSource);
		// Host initialization ordinarily refreshes online; model discovery is not under test.
		vi.spyOn(ModelRegistry.prototype, "refresh").mockResolvedValue(undefined);
		const frames: DesktopFrame[] = [];
		const startupEvents: string[] = [];
		const captures: Array<{
			session: AgentSession;
			control: ControlledAgent;
			runner?: ExtensionRunner;
			contexts: ExtensionUIContext[];
		}> = [];
		const host = new DesktopHost({
			dataDir,
			emit: frame => frames.push(frame),
			createSession: async options => {
				if (!options.sessionManager || !options.settings || !options.modelRegistry || !options.authStorage)
					throw new Error("Host must supply genuine session-scoped SDK services");
				options.authStorage.setRuntimeApiKey(model.provider, "local-stream-only");
				options.settings.override("compaction.enabled", false);
				options.settings.override("retry.enabled", false);
				const control = controlledAgent();
				const eventBus = new EventBus();
				const extensionsResult = await loadExtensions(
					extensionSource ? [extensionPath] : [],
					options.sessionManager.getCwd(),
					eventBus,
				);
				const runner = withRunner
					? new ExtensionRunner(
							extensionsResult.extensions,
							extensionsResult.runtime,
							options.sessionManager.getCwd(),
							options.sessionManager,
							options.modelRegistry,
						)
					: undefined;
				if (runner) {
					const emit = runner.emit.bind(runner);
					vi.spyOn(runner, "emit").mockImplementation((event, ...args) => {
						startupEvents.push(event.type);
						return emit(event, ...args);
					});
					vi.spyOn(runner, "onError");
				}
				const contexts: ExtensionUIContext[] = [];
				const session = new AgentSession({
					agent: control.agent,
					sessionManager: options.sessionManager,
					settings: options.settings,
					modelRegistry: options.modelRegistry,
					agentDir: options.agentDir,
					workflowGatePublication: "local",
					extensionRunner: runner,
				});
				captures.push({ session, control, runner, contexts });
				session.registerToolSessionCleanup(() => eventBus.clear());
				// No extensions/tools are loaded in this fixture. Only the unrelated factory UI setter is unused.
				return {
					session,
					extensionsResult,
					eventBus,
					setToolUIContext: ui => {
						contexts.push(ui);
					},
				} satisfies CreateAgentSessionResult;
			},
		});
		cleanups.push(async () => {
			try {
				await host.close();
			} finally {
				await fs.rm(dataDir, { recursive: true, force: true });
				await fs.rm(projectDir, { recursive: true, force: true });
			}
		});
		const call = async <T>(
			method: DesktopRequest["method"],
			params: Record<string, unknown> = {},
			id: string = crypto.randomUUID(),
		): Promise<T> => {
			await host.handle(parseRequest(JSON.stringify({ id, method, params })));
			const response = frames.findLast(frame => frame.type === "response" && frame.id === id);
			if (response?.type !== "response") throw new Error(`No response for ${method}`);
			if (!response.ok) throw new Error(response.error);
			return response.result as T;
		};
		const snapshot = () => call<DesktopSnapshot>("bootstrap");
		const project = await call<DesktopProject>("project.open", { path: projectDir });
		const session = await call<DesktopSession>("session.create", { projectId: project.id });
		return {
			call,
			snapshot,
			project,
			session,
			sdk: captures[0]!.session,
			control: captures[0]!.control,
			runner: captures[0]!.runner,
			contexts: captures[0]!.contexts,
			startupEvents,
			frames,
		};
	}

	test("same runner refreshes UI without repeating startup or error listeners", async () => {
		const { call, snapshot, session, sdk, runner, contexts, startupEvents } = await launch(true);
		if (!runner) throw new Error("Expected extension runner");
		await call("command.run", { sessionId: session.id, text: "/tools" });
		const oldUI = contexts[0]!;
		expect(await sdk.clearContext()).toBe(true);
		await call("session.select", { sessionId: session.id });
		expect(runner.onError).toHaveBeenCalledTimes(1);
		expect(startupEvents.filter(type => type === "session_start")).toHaveLength(1);
		expect(contexts.length).toBeGreaterThan(1);
		expect(await oldUI.input("stale")).toBeUndefined();
		const answer = runner.getUIContext().input("fresh");
		const question = (await snapshot()).sessions[0]?.question;
		expect(question?.title).toBe("fresh");
		await call("question.answer", { sessionId: session.id, questionId: question!.id, value: "answer" });
		expect(await answer).toBe("answer");
	});

	test("real input hooks transform direct and queued prompts and handle input locally", async () => {
		const { call, snapshot, session, control } = await launch(
			true,
			`export default function (pi) {
			pi.on("input", async event => event.text === "handled" ? { handled: true } : { text: "transformed: " + event.text });
		}`,
		);
		await call("prompt", { sessionId: session.id, text: "handled" }, "handled-input");
		expect(control.prompts).toHaveLength(0);
		expect((await snapshot()).deliveries).toContainEqual(
			expect.objectContaining({ id: "handled-input", disposition: "completed" }),
		);
		const running = call("prompt", { sessionId: session.id, text: "direct" }, "transformed-direct");
		await Promise.race([
			control.started,
			running.then(() => {
				throw new Error("Prompt settled before stream");
			}),
		]);
		expect(control.prompts[0]).toContain("transformed: direct");
		await call("prompt", { sessionId: session.id, text: "queued", deliverAs: "followUp" }, "transformed-queued");
		control.finishTurn("first");
		for (let i = 0; i < 200 && control.prompts.length < 2; i++) await Bun.sleep(5);
		expect(control.prompts[1]).toContain("transformed: queued");
		control.finishTurn("second");
		await running;
	});

	test("forwarded commands dispatch input hooks exactly once", async () => {
		const { call, session, control } = await launch(
			true,
			`export default function (pi) {
			pi.on("input", async event => ({ text: "hook: " + event.text }));
		}`,
		);
		const running = call("command.run", { sessionId: session.id, text: "forwarded" }, "forwarded-hook");
		await Promise.race([
			control.started,
			running.then(() => {
				throw new Error("Prompt settled before stream");
			}),
		]);
		expect(control.prompts[0]).toContain("hook: forwarded");
		expect(control.prompts[0]).not.toContain("hook: hook:");
		control.finishTurn("done");
		await running;
	});

	test("a run reports running, accepts a steer, and abort clears it", async () => {
		const { call, snapshot, session, sdk, control, frames } = await launch();
		const running = call("prompt", { sessionId: session.id, text: "long task" }, "stopped-run");
		await Promise.race([
			control.started,
			running.then(() => {
				throw new Error("Prompt settled before its controlled stream started");
			}),
		]);
		expect(sdk.isStreaming).toBe(true);
		expect(control.prompts).toHaveLength(1);
		expect(control.prompts[0]).toContain("long task");
		expect((await snapshot()).sessions[0]?.status).toBe("running");
		expect((await snapshot()).sessions[0]?.messages.map(message => message.text)).toContain("working");
		await expect(call("command.run", { sessionId: session.id, text: "/tools" })).rejects.toThrow(
			"Another operation is running",
		);

		const steer = await call<{ queued: boolean; submissionId: string }>(
			"prompt",
			{
				sessionId: session.id,
				text: "change direction",
				deliverAs: "steer",
			},
			"steer-delivery",
		);
		expect(steer.queued).toBe(true);
		expect(sdk.getQueuedMessages().steering).toEqual(["change direction"]);
		expect((await snapshot()).sessions[0]?.queued).toEqual([
			expect.objectContaining({
				id: steer.submissionId,
				text: "change direction",
				deliverAs: "steer",
				cancelable: true,
			}),
		]);
		expect(
			await call<{ removed: boolean }>("queue.cancel", { sessionId: session.id, queueId: steer.submissionId }),
		).toEqual({ removed: true });
		expect(sdk.getQueuedMessages().steering).toEqual([]);
		expect((await snapshot()).sessions[0]?.queued ?? []).toHaveLength(0);
		expect((await snapshot()).deliveries).toContainEqual(
			expect.objectContaining({
				id: "steer-delivery",
				sdkSubmissionId: steer.submissionId,
				disposition: "cancelled",
			}),
		);

		await call("prompt", { sessionId: session.id, text: "second turn", deliverAs: "followUp" }, "followup-delivery");
		expect(sdk.getQueuedMessages().followUp).toEqual(["second turn"]);
		expect((await snapshot()).sessions[0]?.queued ?? []).toHaveLength(1);
		await call("abort", { sessionId: session.id });
		// A user Stop is a cancellation, not an uncertain outcome: the prompt request settles
		// normally and its already-persisted text stays in the conversation.
		expect(await running).toBeNull();
		expect(control.aborts).toBe(1);
		expect(sdk.isStreaming).toBe(false);
		expect(sdk.getQueuedMessages()).toEqual({ steering: [], followUp: [] });
		expect(control.prompts).toHaveLength(1);
		const state = await snapshot();
		const aborted = state.sessions[0];
		expect(aborted?.status).not.toBe("running");
		expect(aborted?.status).not.toBe("error");
		expect(aborted?.error).toBeUndefined();
		expect(aborted?.errorOwner).toBeUndefined();
		expect(aborted?.queued ?? []).toHaveLength(0);
		expect(state.deliveries).toContainEqual(expect.objectContaining({ id: "stopped-run", disposition: "cancelled" }));
		// Stop kept the queued follow-up from running. It never reached the conversation, so it is
		// `removed`, which returns its text to the composer; `cancelled` would drop it.
		expect(state.deliveries).toContainEqual(
			expect.objectContaining({ id: "followup-delivery", disposition: "removed" }),
		);
		const history = await call<DesktopHistory>("history.get", { sessionId: session.id });
		expect(history.messages.map(message => message.text)).toContain("long task");
		expect(history.messages.map(message => message.text)).not.toContain("second turn");
		expect(frames.some(frame => frame.type === "session" && frame.session.status === "running")).toBe(true);
	});

	test("a Stop after acceptance but before the transcript append restores the draft", async () => {
		const { call, snapshot, session, sdk, control } = await launch();
		const held = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const update = DeliveryJournal.prototype.update;
		vi.spyOn(DeliveryJournal.prototype, "update").mockImplementation(async function (
			this: DeliveryJournal,
			id,
			changes,
		) {
			if (id === "stopped-before-append" && changes.disposition === "accepted") {
				held.resolve();
				await release.promise;
			}
			return update.call(this, id, changes);
		});
		const abort = sdk.abort.bind(sdk);
		const stopReached = Promise.withResolvers<void>();
		vi.spyOn(sdk, "abort").mockImplementation(options => {
			stopReached.resolve();
			return abort(options);
		});
		const running = call("prompt", { sessionId: session.id, text: "keep this draft" }, "stopped-before-append");
		// SDK preflight accepted the prompt; its user message is appended only after this write.
		await held.promise;
		// The SDK abort joins the in-flight acceptance, so the write is released once Stop reached it.
		const stopping = call("abort", { sessionId: session.id });
		await stopReached.promise;
		release.resolve();
		await stopping;
		expect(await running).toBeNull();
		const state = await snapshot();
		// The app restores a refused prompt into the composer before finalizing it. A cancelled
		// receipt is finalized without restoring, which would lose text the transcript never got.
		expect(state.deliveries).toContainEqual(
			expect.objectContaining({ id: "stopped-before-append", disposition: "refused" }),
		);
		expect(control.prompts).toHaveLength(0);
		expect(sdk.messages.some(message => message.role === "user")).toBe(false);
		expect(state.sessions[0]?.error).toBeUndefined();
		expect(state.sessions[0]?.errorOwner).toBeUndefined();
	});

	test("closing the workspace during a run leaves the prompt outcome unknown", async () => {
		const { call, snapshot, session, project, control } = await launch();
		const running = call("prompt", { sessionId: session.id, text: "interrupted by close" }, "closed-run");
		await Promise.race([
			control.started,
			running.then(() => {
				throw new Error("Prompt settled before its controlled stream started");
			}),
		]);
		// A Host-initiated abort is not the user's Stop: the app cannot claim a cancellation.
		await call("project.close", { projectId: project.id });
		await expect(running).rejects.toThrow("Prompt outcome unknown");
		expect((await snapshot()).deliveries).toContainEqual(
			expect.objectContaining({ id: "closed-run", disposition: "unknown" }),
		);
	});

	test("Stop leaves the conversation idle and keeps a follow-up the agent queued for the next turn", async () => {
		const { call, snapshot, session, sdk, control } = await launch();
		const running = call("prompt", { sessionId: session.id, text: "long task" }, "stopped-with-agent-follow-up");
		await Promise.race([
			control.started,
			running.then(() => {
				throw new Error("Prompt settled before its controlled stream started");
			}),
		]);
		// Monitor and cron notifications reach a streaming run as agent follow-ups that trigger a turn.
		await sdk.sendCustomMessage(
			{ customType: "task-notification", content: "monitor fired", display: false, attribution: "agent" },
			{ triggerTurn: true, deliverAs: "followUp" },
		);
		expect(sdk.agent.hasQueuedMessages()).toBe(true);
		await call("abort", { sessionId: session.id });
		// Stop settles the stopped prompt's own request instead of handing the session to a new turn.
		expect(await Promise.race([running.then(() => "settled"), Bun.sleep(1_000).then(() => "pending")])).toBe(
			"settled",
		);
		// A resumed turn would start about a millisecond after the abort returns.
		await Bun.sleep(50);
		expect(control.prompts).toHaveLength(1);
		expect(sdk.isStreaming).toBe(false);
		const state = await snapshot();
		expect(state.sessions[0]?.status).toBe("done");
		expect(state.deliveries).toContainEqual(
			expect.objectContaining({ id: "stopped-with-agent-follow-up", disposition: "cancelled" }),
		);
		// The notification is not lost: it waits in the queue and follows the next turn.
		expect(sdk.agent.hasQueuedMessages()).toBe(true);
		const next = call("prompt", { sessionId: session.id, text: "next" }, "after-stop");
		for (let i = 0; i < 400 && control.prompts.length < 2; i++) await Bun.sleep(5);
		control.finishTurn("answered");
		for (let i = 0; i < 400 && control.prompts.length < 3; i++) await Bun.sleep(5);
		expect(control.prompts).toHaveLength(3);
		control.finishTurn("notification handled");
		await next;
		const delivered = sdk.messages.findIndex(
			message => message.role === "custom" && message.customType === "task-notification",
		);
		const nextPrompt = sdk.messages.findIndex(message => message.role === "user" && copyText(message) === "next");
		expect(nextPrompt).toBeGreaterThan(-1);
		expect(delivered).toBeGreaterThan(nextPrompt);
		expect(sdk.agent.hasQueuedMessages()).toBe(false);
	});

	/** Every receipt a delivery id passed through, in emission order. */
	const receiptTrail = (frames: DesktopFrame[], id: string) =>
		frames.flatMap(frame =>
			frame.type === "delivery" && frame.receipt.id === id ? [frame.receipt.disposition] : [],
		);

	test("Stop returns every input still queued to the composer, identical texts included", async () => {
		const { call, snapshot, session, sdk, control, frames } = await launch();
		const running = call("prompt", { sessionId: session.id, text: "long task" }, "stopped-with-queue");
		await Promise.race([
			control.started,
			running.then(() => {
				throw new Error("Prompt settled before its controlled stream started");
			}),
		]);
		await call("prompt", { sessionId: session.id, text: "same", deliverAs: "steer" }, "queued-first");
		await call("prompt", { sessionId: session.id, text: "same", deliverAs: "steer" }, "queued-second");
		expect((await snapshot()).sessions[0]?.queued).toHaveLength(2);
		await call("abort", { sessionId: session.id });
		expect(await running).toBeNull();
		await Bun.sleep(50);
		expect(control.prompts).toHaveLength(1);
		const state = await snapshot();
		expect(state.sessions[0]?.queued ?? []).toHaveLength(0);
		expect(state.deliveries).toContainEqual(
			expect.objectContaining({ id: "stopped-with-queue", disposition: "cancelled" }),
		);
		for (const id of ["queued-first", "queued-second"]) {
			expect(state.deliveries).toContainEqual(expect.objectContaining({ id, disposition: "removed" }));
			// The SDK also reports these as cancelled removals. The app settles a receipt on the first
			// final frame it sees, so no `cancelled` frame may ever reach it for them.
			expect(receiptTrail(frames, id)).not.toContain("cancelled");
		}
		expect(sdk.messages.filter(message => message.role === "user").map(copyText)).toEqual(["long task"]);
	});

	test("a steer admitted while Stop is settling the queue is returned as well", async () => {
		const { call, snapshot, session, sdk, control, frames } = await launch();
		const running = call("prompt", { sessionId: session.id, text: "long task" }, "stopped-while-settling");
		await Promise.race([
			control.started,
			running.then(() => {
				throw new Error("Prompt settled before its controlled stream started");
			}),
		]);
		await call("prompt", { sessionId: session.id, text: "queued first", deliverAs: "steer" }, "settled-first");
		const held = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const update = DeliveryJournal.prototype.update;
		vi.spyOn(DeliveryJournal.prototype, "update").mockImplementation(async function (
			this: DeliveryJournal,
			id,
			changes,
		) {
			// Hold Stop's own write for the queued input; other journal writes proceed.
			if (id === "settled-first" && changes.disposition !== "queued" && changes.disposition !== "accepted") {
				held.resolve();
				await release.promise;
			}
			return update.call(this, id, changes);
		});
		const stopping = call("abort", { sessionId: session.id });
		await held.promise;
		// Stop has counted itself and is writing the first input's receipt; this steer still queues.
		const late = await call<{ queued: boolean }>(
			"prompt",
			{ sessionId: session.id, text: "typed during Stop", deliverAs: "steer" },
			"admitted-during-stop",
		);
		expect(late.queued).toBe(true);
		release.resolve();
		expect(await stopping).toBeNull();
		expect(await running).toBeNull();
		await Bun.sleep(50);
		expect(control.prompts).toHaveLength(1);
		const state = await snapshot();
		expect(state.sessions[0]?.queued ?? []).toHaveLength(0);
		for (const id of ["settled-first", "admitted-during-stop"]) {
			expect(state.deliveries).toContainEqual(expect.objectContaining({ id, disposition: "removed" }));
			expect(receiptTrail(frames, id)).not.toContain("cancelled");
		}
		expect(sdk.messages.filter(message => message.role === "user").map(copyText)).toEqual(["long task"]);
	});

	test("pressing Stop twice settles the run once and returns the queued input", async () => {
		const { call, snapshot, session, sdk, control } = await launch();
		const running = call("prompt", { sessionId: session.id, text: "long task" }, "stopped-twice");
		await Promise.race([
			control.started,
			running.then(() => {
				throw new Error("Prompt settled before its controlled stream started");
			}),
		]);
		await call("prompt", { sessionId: session.id, text: "typed next", deliverAs: "steer" }, "queued-before-stops");
		const first = call("abort", { sessionId: session.id });
		const second = call("abort", { sessionId: session.id });
		expect(await Promise.all([first, second])).toEqual([null, null]);
		expect(await running).toBeNull();
		await Bun.sleep(50);
		expect(control.prompts).toHaveLength(1);
		expect(control.aborts).toBe(1);
		expect(sdk.isStreaming).toBe(false);
		const state = await snapshot();
		expect(state.sessions[0]?.status).toBe("done");
		expect(state.sessions[0]?.error).toBeUndefined();
		expect(state.deliveries).toContainEqual(
			expect.objectContaining({ id: "stopped-twice", disposition: "cancelled" }),
		);
		expect(state.deliveries).toContainEqual(
			expect.objectContaining({ id: "queued-before-stops", disposition: "removed" }),
		);
	});

	test("a workspace close right after Stop keeps the Stop's outcomes", async () => {
		const { call, snapshot, session, project, sdk, control, frames } = await launch();
		const running = call("prompt", { sessionId: session.id, text: "long task" }, "stopped-then-closed");
		await Promise.race([
			control.started,
			running.then(() => {
				throw new Error("Prompt settled before its controlled stream started");
			}),
		]);
		await call("prompt", { sessionId: session.id, text: "typed next", deliverAs: "steer" }, "queued-before-close");
		const abort = sdk.abort.bind(sdk);
		const stopReached = Promise.withResolvers<void>();
		vi.spyOn(sdk, "abort").mockImplementation(options => {
			stopReached.resolve();
			return abort(options);
		});
		const stopping = call("abort", { sessionId: session.id });
		// The close starts while the Stop's abort is still unwinding.
		await stopReached.promise;
		const closing = call("project.close", { projectId: project.id });
		expect(await stopping).toBeNull();
		await closing;
		expect(await running).toBeNull();
		expect(control.prompts).toHaveLength(1);
		const state = await snapshot();
		expect(state.deliveries).toContainEqual(
			expect.objectContaining({ id: "stopped-then-closed", disposition: "cancelled" }),
		);
		expect(state.deliveries).toContainEqual(
			expect.objectContaining({ id: "queued-before-close", disposition: "removed" }),
		);
		expect(receiptTrail(frames, "queued-before-close")).not.toContain("cancelled");
	});

	/**
	 * Presses Stop from inside the SDK's report that it took the next steer from the queue: the
	 * input is consumed but not yet appended, so the aborted run hands it back and never sends it.
	 */
	function stopAtNextSteerConsumption(sdk: AgentSession, stop: () => Promise<unknown>): () => Promise<unknown> {
		const consumed = sdk.agent.onSteeringConsumed;
		if (!consumed) throw new Error("The SDK no longer reports steering consumption");
		cleanups.push(async () => {
			sdk.agent.onSteeringConsumed = consumed;
		});
		const abort = sdk.abort.bind(sdk);
		const stopReached = Promise.withResolvers<void>();
		vi.spyOn(sdk, "abort").mockImplementation(options => {
			stopReached.resolve();
			return abort(options);
		});
		const stopping = Promise.withResolvers<unknown>();
		sdk.agent.onSteeringConsumed = async (messages, promotion) => {
			await consumed(messages, promotion);
			sdk.agent.onSteeringConsumed = consumed;
			stop().then(stopping.resolve, stopping.reject);
			await stopReached.promise;
		};
		return () => stopping.promise;
	}
	const userTurns = (sdk: AgentSession) => sdk.messages.filter(message => message.role === "user").map(copyText);
	const settledReceipts = async (snapshot: () => Promise<DesktopSnapshot>, ids: string[]) => {
		let state = await snapshot();
		for (
			let i = 0;
			i < 200 &&
			ids.some(id =>
				["pending", "accepted", "queued"].includes(
					state.deliveries.find(item => item.id === id)?.disposition ?? "pending",
				),
			);
			i++
		) {
			await Bun.sleep(5);
			state = await snapshot();
		}
		return Object.fromEntries(ids.map(id => [id, state.deliveries.find(item => item.id === id)?.disposition]));
	};

	test("an identical steer the stopped run took but never sent does not borrow the earlier one's turn", async () => {
		const h = await launch();
		const running = h.call("prompt", { sessionId: h.session.id, text: "long task" }, "tool-run");
		await h.control.started;
		await h.control.callTool();
		// Both are queued before either reaches the transcript, so both can see the first one's turn.
		await h.call("prompt", { sessionId: h.session.id, text: "same", deliverAs: "steer" }, "steer-sent");
		await h.call("prompt", { sessionId: h.session.id, text: "same", deliverAs: "steer" }, "steer-taken");
		h.control.releaseTool();
		for (let i = 0; i < 400 && h.control.prompts.length < 2; i++) await Bun.sleep(5);
		expect(h.control.prompts[1]).toBe("long task\nsame");
		await h.control.callTool();
		const stopped = stopAtNextSteerConsumption(h.sdk, () => h.call("abort", { sessionId: h.session.id }));
		h.control.releaseTool();
		expect(await stopped()).toBeNull();
		expect(await running).toBeNull();
		expect(h.control.prompts).toHaveLength(2);
		expect(userTurns(h.sdk)).toEqual(["long task", "same"]);
		// One transcript turn is evidence for one input. The input it does not belong to never ran
		// visibly, so it must not be settled as a cancellation that drops its text.
		expect(await settledReceipts(h.snapshot, ["tool-run", "steer-sent", "steer-taken"])).toEqual({
			"tool-run": "cancelled",
			"steer-sent": "cancelled",
			"steer-taken": "unknown",
		});
	});

	test("after Stop, a steer taken at a finished turn but never sent is not reported completed", async () => {
		const h = await launch();
		const running = h.call("prompt", { sessionId: h.session.id, text: "long task" }, "finished-run");
		await h.control.started;
		await h.call("prompt", { sessionId: h.session.id, text: "same", deliverAs: "steer" }, "steer-answered");
		await h.call("prompt", { sessionId: h.session.id, text: "same", deliverAs: "steer" }, "steer-dropped");
		h.control.finishTurn("one");
		for (let i = 0; i < 400 && h.control.prompts.length < 2; i++) await Bun.sleep(5);
		expect(h.control.prompts[1]).toBe("long task\nsame");
		const stopped = stopAtNextSteerConsumption(h.sdk, () => h.call("abort", { sessionId: h.session.id }));
		// The turn's answer is final, so the run ends completed although Stop handed the steer back.
		h.control.finishTurn("two");
		expect(await stopped()).toBeNull();
		await running;
		expect(h.control.prompts).toHaveLength(2);
		expect(userTurns(h.sdk)).toEqual(["long task", "same"]);
		expect(h.sdk.agent.hasQueuedMessages()).toBe(false);
		expect(await settledReceipts(h.snapshot, ["finished-run", "steer-answered", "steer-dropped"])).toEqual({
			"finished-run": "completed",
			"steer-answered": "completed",
			// `completed` would finalize it silently; its text never reached the conversation.
			"steer-dropped": "unknown",
		});
	});

	test("Stop after two identical steers both reached the transcript cancels both", async () => {
		const h = await launch();
		const running = h.call("prompt", { sessionId: h.session.id, text: "long task" }, "both-sent-run");
		await h.control.started;
		await h.call("prompt", { sessionId: h.session.id, text: "same", deliverAs: "steer" }, "steer-one");
		await h.call("prompt", { sessionId: h.session.id, text: "same", deliverAs: "steer" }, "steer-two");
		h.control.finishTurn("one");
		for (let i = 0; i < 400 && h.control.prompts.length < 2; i++) await Bun.sleep(5);
		h.control.finishTurn("two");
		for (let i = 0; i < 400 && h.control.prompts.length < 3; i++) await Bun.sleep(5);
		expect(h.control.prompts[2]).toBe("long task\nsame\nsame");
		await h.call("abort", { sessionId: h.session.id });
		expect(await running).toBeNull();
		expect(userTurns(h.sdk)).toEqual(["long task", "same", "same"]);
		expect(await settledReceipts(h.snapshot, ["both-sent-run", "steer-one", "steer-two"])).toEqual({
			"both-sent-run": "cancelled",
			"steer-one": "cancelled",
			"steer-two": "cancelled",
		});
	});

	/** An input hook that asks the user before letting any text starting with "ask" through. */
	const askingInputHook = `export default function (pi) {
		pi.on("input", async (event, ctx) => {
			if (event.text.startsWith("ask")) await ctx.ui.input("Send " + event.text + "?");
			return { text: event.text };
		});
	}`;
	const questionShown = async (snapshot: () => Promise<DesktopSnapshot>) => {
		for (let i = 0; i < 400 && !(await snapshot()).sessions[0]?.question; i++) await Bun.sleep(5);
		expect((await snapshot()).sessions[0]?.question).toBeDefined();
	};

	test("Stop while a prompt's input hook runs keeps it from running and returns its text", async () => {
		const { call, snapshot, session, project, sdk, control } = await launch(true, askingInputHook);
		const running = call("prompt", { sessionId: session.id, text: "ask first" }, "stopped-in-hook");
		await questionShown(snapshot);
		// Nothing has reached the SDK yet, so the Stop's abort has nothing to end.
		await call("abort", { sessionId: session.id });
		expect(await Promise.race([running.then(() => "settled"), Bun.sleep(1_000).then(() => "pending")])).toBe(
			"settled",
		);
		expect(control.prompts).toHaveLength(0);
		expect(sdk.messages.some(message => message.role === "user")).toBe(false);
		let state = await snapshot();
		// `refused` is what returns the text to the composer.
		expect(state.deliveries).toContainEqual(
			expect.objectContaining({
				id: "stopped-in-hook",
				disposition: "refused",
				error: "Prompt stopped before it started",
			}),
		);
		expect(state.sessions[0]?.status).not.toBe("running");
		expect(state.sessions[0]?.error).toBeUndefined();
		// That Stop cannot label a later prompt's Host abort as the user's cancellation.
		const later = call("prompt", { sessionId: session.id, text: "next task" }, "closed-after-hook-stop");
		await Promise.race([
			control.started,
			later.then(() => {
				throw new Error("Prompt settled before its controlled stream started");
			}),
		]);
		await call("project.close", { projectId: project.id });
		await expect(later).rejects.toThrow("Prompt outcome unknown");
		state = await snapshot();
		expect(state.deliveries).toContainEqual(
			expect.objectContaining({ id: "closed-after-hook-stop", disposition: "unknown" }),
		);
	});

	test("Stop while a steer's input hook runs keeps it from queueing or starting a turn", async () => {
		const { call, snapshot, session, sdk, control } = await launch(true, askingInputHook);
		const running = call("prompt", { sessionId: session.id, text: "long task" }, "run-before-hooked-steer");
		await Promise.race([
			control.started,
			running.then(() => {
				throw new Error("Prompt settled before its controlled stream started");
			}),
		]);
		const steer = call("prompt", { sessionId: session.id, text: "ask steer", deliverAs: "steer" }, "steer-in-hook");
		await questionShown(snapshot);
		await call("abort", { sessionId: session.id });
		expect(await running).toBeNull();
		expect(await steer).toBeNull();
		await Bun.sleep(50);
		expect(control.prompts).toHaveLength(1);
		expect(sdk.isStreaming).toBe(false);
		expect(sdk.getQueuedMessages()).toEqual({ steering: [], followUp: [] });
		const state = await snapshot();
		expect(state.sessions[0]?.queued ?? []).toHaveLength(0);
		expect(state.deliveries).toContainEqual(
			expect.objectContaining({ id: "run-before-hooked-steer", disposition: "cancelled" }),
		);
		expect(state.deliveries).toContainEqual(
			expect.objectContaining({
				id: "steer-in-hook",
				disposition: "refused",
				error: "Prompt stopped before it started",
			}),
		);
		expect(userTurns(sdk)).toEqual(["long task"]);
	});

	test("invalid prompt reports a definitive refusal before admission", async () => {
		const { call, session, frames, snapshot } = await launch();
		await expect(call("prompt", { sessionId: session.id, text: "" }, "invalid-id")).rejects.toThrow();
		expect(frames.findLast(frame => frame.type === "response" && frame.id === "invalid-id")).toMatchObject({
			ok: false,
			deliveryDisposition: "refused",
		});
		expect((await snapshot()).deliveries.some(receipt => receipt.id === "invalid-id")).toBe(false);
		await call("delivery.ack", { deliveryId: "invalid-id" });
		await expect(call("prompt", { sessionId: session.id, text: "valid" }, "invalid-id")).rejects.toThrow(
			"Duplicate delivery id",
		);
	});

	test("preflight refusals and uncertain acceptance do not own session errors", async () => {
		const { call, snapshot, session, sdk } = await launch();
		const prompt = vi.spyOn(sdk, "prompt");
		prompt.mockImplementationOnce(async () => {
			throw new Error("preflight refused");
		});
		await expect(call("prompt", { sessionId: session.id, text: "private input" }, "refused-id")).rejects.toThrow(
			"preflight refused",
		);
		let state = await snapshot();
		expect(state.deliveries).toContainEqual(expect.objectContaining({ id: "refused-id", disposition: "refused" }));
		expect(state.sessions[0]?.errorOwner).toBeUndefined();
		prompt.mockImplementationOnce(async (_text, options) => {
			await options?.onPreflightAcceptCommit?.();
			throw new Error("preflight lost");
		});
		await expect(call("prompt", { sessionId: session.id, text: "private input" }, "unknown-id")).rejects.toThrow(
			"preflight lost",
		);
		state = await snapshot();
		expect(state.deliveries).toContainEqual(expect.objectContaining({ id: "unknown-id", disposition: "unknown" }));
		expect(state.sessions[0]?.errorOwner).toBeUndefined();
	});

	test("a resolved provider error retains a failed receipt and causal session error", async () => {
		const { call, snapshot, session, control } = await launch();
		const running = call("prompt", { sessionId: session.id, text: "provider error" }, "provider-error-id");
		await Promise.race([
			control.started,
			running.then(() => {
				throw new Error("Prompt settled before stream");
			}),
		]);
		control.finishTurn("", true);
		await expect(running).rejects.toThrow("Prompt failed");
		const state = await snapshot();
		expect(state.deliveries).toContainEqual(
			expect.objectContaining({ id: "provider-error-id", disposition: "failed" }),
		);
		expect(state.sessions[0]).toMatchObject({ errorOwner: "provider-error-id" });
	});

	test("a forwarded real provider failure owns the command request", async () => {
		const { call, snapshot, session, control } = await launch();
		const running = call(
			"command.run",
			{ sessionId: session.id, text: "forwarded provider error" },
			"forwarded-error-id",
		);
		await Promise.race([
			control.started,
			running.then(() => {
				throw new Error("Prompt settled before stream");
			}),
		]);
		control.finishTurn("", true);
		await expect(running).rejects.toThrow("Prompt failed");
		const state = await snapshot();
		expect(state.deliveries).toContainEqual(
			expect.objectContaining({ id: "forwarded-error-id", disposition: "failed" }),
		);
		expect(state.sessions[0]).toMatchObject({
			status: "error",
			error: "Prompt failed",
			errorOwner: "forwarded-error-id",
		});
	});

	for (const result of ["success", "error", "abort"] as const) {
		test(`consumed queued input matches cloned scope on ${result}`, async () => {
			const { call, snapshot, session, sdk, control } = await launch();
			const original = sdk.submitUserMessage.bind(sdk);
			let cloned = false;
			vi.spyOn(sdk, "submitUserMessage").mockImplementation(async (content, options) => {
				const submission = await original(content, options);
				return {
					...submission,
					terminal: submission.terminal.then(outcome => {
						if (outcome.disposition !== "completed") return outcome;
						const attemptScope = { ...outcome.attemptScope };
						cloned = attemptScope !== outcome.attemptScope;
						return { ...outcome, attemptScope };
					}),
				};
			});
			const running = call("prompt", { sessionId: session.id, text: "initial" }, `initial-${result}`);
			await Promise.race([
				control.started,
				running.then(() => {
					throw new Error("Prompt settled before stream");
				}),
			]);
			const queued = await call<{ submissionId: string }>(
				"prompt",
				{ sessionId: session.id, text: "queued", deliverAs: "followUp" },
				`queued-${result}`,
			);
			control.finishTurn("first completed");
			for (let i = 0; i < 200 && control.prompts.length < 2; i++) await Bun.sleep(5);
			expect(control.prompts.length).toBe(2);
			if (result === "abort") await call("abort", { sessionId: session.id });
			else control.finishTurn("second completed", result === "error");
			if (result === "error") await expect(running).rejects.toThrow("Prompt failed");
			else await running;
			const expected = result === "success" ? "completed" : result === "error" ? "failed" : "cancelled";
			let state = await snapshot();
			for (
				let i = 0;
				i < 200 && state.deliveries.find(item => item.id === `queued-${result}`)?.disposition !== expected;
				i++
			) {
				await Bun.sleep(5);
				state = await snapshot();
			}
			expect(cloned).toBe(true);
			expect(state.deliveries).toContainEqual(
				expect.objectContaining({
					id: `queued-${result}`,
					sdkSubmissionId: queued.submissionId,
					disposition: expected,
				}),
			);
			if (result === "error") expect(state.sessions[0]?.errorOwner).toBe(`initial-${result}`);
		});
	}

	test("a real queued no-model refusal retains a refused receipt without a provider turn", async () => {
		const { call, snapshot, session, sdk, control } = await launch();
		const submit = sdk.submitUserMessage.bind(sdk);
		vi.spyOn(sdk, "submitUserMessage").mockImplementation((content, options) =>
			submit(content, { ...options, sdkRunCapability: createSdkRunCapability("host-refused-queued-run") }),
		);
		const running = call("prompt", { sessionId: session.id, text: "predecessor" }, "predecessor-id");
		await Promise.race([
			control.started,
			running.then(() => {
				throw new Error("Prompt settled before stream");
			}),
		]);
		const queued = await call<{ submissionId: string }>(
			"prompt",
			{
				sessionId: session.id,
				text: "restore this input",
				deliverAs: "followUp",
			},
			"refused-queue-id",
		);
		sdk.agent.setModel(undefined);
		control.finishTurn("predecessor completed");
		await running;
		let state = await snapshot();
		for (
			let i = 0;
			i < 200 && state.deliveries.find(item => item.id === "refused-queue-id")?.disposition !== "refused";
			i++
		) {
			await Bun.sleep(5);
			state = await snapshot();
		}
		expect(control.prompts).toHaveLength(1);
		expect(state.deliveries).toContainEqual(
			expect.objectContaining({
				id: "refused-queue-id",
				sessionId: session.id,
				sdkSubmissionId: queued.submissionId,
				disposition: "refused",
			}),
		);
		expect(state.sessions[0]?.errorOwner).not.toBe("refused-queue-id");
		expect(state.sessions[0]?.queued ?? []).toHaveLength(0);
		expect(state.sessions[0]?.messages.some(message => message.text.includes("restore this input"))).toBe(false);
		await call("delivery.ack", { deliveryId: "refused-queue-id" });
		expect((await snapshot()).deliveries.some(item => item.id === "refused-queue-id")).toBe(false);
	});

	test("SDK queue removal remains visible as a removed receipt", async () => {
		const { call, snapshot, session, sdk, control } = await launch();
		const running = call("prompt", { sessionId: session.id, text: "running" });
		await Promise.race([
			control.started,
			running.then(() => {
				throw new Error("Prompt settled before stream");
			}),
		]);
		const queued = await call<{ submissionId: string }>(
			"prompt",
			{ sessionId: session.id, text: "discarded", deliverAs: "followUp" },
			"removed-delivery",
		);
		sdk.clearQueue();
		let receipt = (await snapshot()).deliveries.find(item => item.id === "removed-delivery");
		for (let i = 0; i < 100 && receipt?.disposition !== "removed"; i++) {
			await Bun.sleep(5);
			receipt = (await snapshot()).deliveries.find(item => item.id === "removed-delivery");
		}
		expect(receipt).toMatchObject({ disposition: "removed", sdkSubmissionId: queued.submissionId });
		control.finishTurn("done");
		await running;
	});

	test("a completed turn returns the session to idle and keeps its genuine transcript", async () => {
		const { call, snapshot, session, sdk, control, project } = await launch();
		const running = call("prompt", { sessionId: session.id, text: "short task" }, "prompt-delivery");
		await Promise.race([
			control.started,
			running.then(() => {
				throw new Error("Prompt settled before its controlled stream started");
			}),
		]);
		await expect(call("delivery.ack", { deliveryId: "prompt-delivery" })).rejects.toThrow("not final");
		await expect(call("prompt", { sessionId: session.id, text: "another task" }, "prompt-delivery")).rejects.toThrow(
			"Duplicate delivery id",
		);
		control.finishTurn("echo: short task");
		await running;
		expect((await snapshot()).deliveries).toContainEqual(
			expect.objectContaining({ id: "prompt-delivery", disposition: "completed" }),
		);
		await call("delivery.ack", { deliveryId: "prompt-delivery" });
		expect((await snapshot()).deliveries.some(receipt => receipt.id === "prompt-delivery")).toBe(false);
		const done = (await snapshot()).sessions[0];
		// A settled session that finished a turn reports "done"; a never-used session stays "idle".
		expect(done?.status).toBe("done");
		expect(done?.messages.map(message => message.text)).toContain("echo: short task");
		const history = await call<DesktopHistory>("history.get", { sessionId: session.id });
		expect(history.messages.map(message => message.text)).toContain("short task");
		expect(history.messages.map(message => message.text)).toContain("echo: short task");
		const transcript = await Bun.file(sdk.sessionFile!).text();
		expect(transcript).toContain("short task");
		expect(transcript).toContain("echo: short task");
		expect(sdk.sessionManager.getCwd()).toBe(project.path);
		expect(await call<DesktopCommandResult>("command.run", { sessionId: session.id, text: "/jobs" })).toMatchObject({
			consumed: true,
		});
	});

	async function promptTurn(
		call: <T>(method: DesktopRequest["method"], params?: Record<string, unknown>, id?: string) => Promise<T>,
		control: ControlledAgent,
		params: Record<string, unknown>,
		response: string,
	): Promise<string> {
		const before = control.prompts.length;
		const running = call("prompt", params);
		for (let i = 0; i < 400 && control.prompts.length === before; i++) await Bun.sleep(5);
		expect(control.prompts).toHaveLength(before + 1);
		control.finishTurn(response);
		await running;
		return control.prompts.at(-1)!;
	}
	const conversation = async (snapshot: () => Promise<DesktopSnapshot>) =>
		((await snapshot()).sessions[0]?.messages ?? []).filter(
			message => message.role === "user" || message.role === "assistant",
		);

	test("notices stay where they were raised and never count as conversation", async () => {
		const { call, snapshot, session, control, runner } = await launch(
			true,
			`export default function (pi) {
			pi.on("session_start", async (_event, ctx) => ctx.ui.notify("extension ready", "info"));
		}`,
		);
		let state = await snapshot();
		for (let i = 0; i < 200 && !state.sessions[0]?.messages.length; i++) {
			await Bun.sleep(5);
			state = await snapshot();
		}
		expect(state.sessions[0]?.messages).toEqual([
			expect.objectContaining({ role: "system", text: "extension ready" }),
		]);
		// A notice is not a turn: a new conversation holding only a notice is still idle.
		expect(state.sessions[0]?.status).toBe("idle");
		await promptTurn(call, control, { sessionId: session.id, text: "first turn" }, "first answer");
		if (!runner) throw new Error("Expected extension runner");
		runner.getUIContext().notify("between turns", "info");
		await promptTurn(call, control, { sessionId: session.id, text: "second turn" }, "second answer");
		const after = (await snapshot()).sessions[0];
		expect(after?.messages.map(message => message.text)).toEqual([
			"extension ready",
			"first turn",
			"first answer",
			"between turns",
			"second turn",
			"second answer",
		]);
		expect(after?.status).toBe("done");
	});

	test("editing a prompt rewinds like /tree and its revisions switch between branches", async () => {
		const { call, snapshot, session, control } = await launch();
		await promptTurn(call, control, { sessionId: session.id, text: "first question" }, "answer one");
		await promptTurn(call, control, { sessionId: session.id, text: "second question" }, "answer two");
		const original = await conversation(snapshot);
		expect((await snapshot()).sessions[0]?.promptEditing).toBe(true);
		expect(original.some(message => message.revision)).toBe(false);
		const firstId = original.find(message => message.text === "first question")?.entryId;
		if (!firstId) throw new Error("Expected a persisted first prompt");

		const context = await promptTurn(
			call,
			control,
			{ sessionId: session.id, text: "first edited", editEntryId: firstId },
			"edited answer",
		);
		// The model sees the conversation from before the edited prompt, not the abandoned branch.
		expect(context).toBe("first edited");
		const edited = await conversation(snapshot);
		expect(edited.map(message => message.text)).toEqual(["first edited", "edited answer"]);
		const editedId = edited[0]?.entryId;
		expect(edited[0]?.revision).toEqual({ index: 1, count: 2, previous: firstId });

		await call("session.revision", { sessionId: session.id, entryId: firstId });
		const restored = await conversation(snapshot);
		expect(restored.map(message => message.text)).toEqual([
			"first question",
			"answer one",
			"second question",
			"answer two",
		]);
		expect(restored[0]?.revision).toEqual({ index: 0, count: 2, next: editedId });

		await call("session.revision", { sessionId: session.id, entryId: editedId! });
		expect((await conversation(snapshot)).map(message => message.text)).toEqual(["first edited", "edited answer"]);
	});

	test("refused prompt edits leave the branch being read untouched", async () => {
		const { call, snapshot, session, sdk, control } = await launch(
			true,
			`export default function (pi) {
			pi.on("input", async event => event.text === "handled" ? { handled: true } : undefined);
		}`,
		);
		await promptTurn(call, control, { sessionId: session.id, text: "first question" }, "answer one");
		const [prompt] = await conversation(snapshot);
		const leaf = sdk.sessionManager.getLeafId();
		if (!prompt?.entryId || !leaf) throw new Error("Expected a persisted turn");

		// An extension consumed the edit: nothing was appended, so the original branch returns.
		await call("prompt", { sessionId: session.id, text: "handled", editEntryId: prompt.entryId });
		expect(sdk.sessionManager.getLeafId()).toBe(leaf);
		await expect(
			call("prompt", { sessionId: session.id, text: "/tools", editEntryId: prompt.entryId }),
		).rejects.toThrow("A slash command cannot replace a prompt.");
		await expect(call("prompt", { sessionId: session.id, text: "not a prompt", editEntryId: leaf })).rejects.toThrow(
			"Invalid entry ID for editing",
		);
		await expect(call("session.revision", { sessionId: session.id, entryId: leaf })).rejects.toThrow(
			"Invalid entry ID for a prompt revision",
		);

		const running = call("prompt", { sessionId: session.id, text: "second question" });
		for (let i = 0; i < 400 && control.prompts.length < 2; i++) await Bun.sleep(5);
		await expect(
			call("prompt", { sessionId: session.id, text: "too early", editEntryId: prompt.entryId }),
		).rejects.toThrow("Edit the prompt after the current operation finishes.");
		control.finishTurn("answer two");
		await running;
		expect((await conversation(snapshot)).map(message => message.text)).toEqual([
			"first question",
			"answer one",
			"second question",
			"answer two",
		]);
		expect(control.prompts).toHaveLength(2);
	});
});

interface ControlledAgent {
	agent: Agent;
	started: Promise<void>;
	prompts: string[];
	readonly aborts: number;
	finishTurn(response: string, failed?: boolean): void;
	callTool(): Promise<void>;
	releaseTool(): void;
}
