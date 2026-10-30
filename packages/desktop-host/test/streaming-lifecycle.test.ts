/** Real SDK streaming/queue/persistence lifecycle with an in-process controlled provider stream. */
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
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
	const agent = new Agent({
		initialState: { model, messages: [], tools: [], systemPrompt: [] },
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
	};
}

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
		const running = call("prompt", { sessionId: session.id, text: "긴 작업" });
		await Promise.race([
			control.started,
			running.then(() => {
				throw new Error("Prompt settled before its controlled stream started");
			}),
		]);
		expect(sdk.isStreaming).toBe(true);
		expect(control.prompts).toHaveLength(1);
		expect(control.prompts[0]).toContain("긴 작업");
		expect((await snapshot()).sessions[0]?.status).toBe("running");
		expect((await snapshot()).sessions[0]?.messages.map(message => message.text)).toContain("working");
		await expect(call("command.run", { sessionId: session.id, text: "/tools" })).rejects.toThrow("실행 중");

		const steer = await call<{ queued: boolean; submissionId: string }>(
			"prompt",
			{
				sessionId: session.id,
				text: "방향 전환",
				deliverAs: "steer",
			},
			"steer-delivery",
		);
		expect(steer.queued).toBe(true);
		expect(sdk.getQueuedMessages().steering).toEqual(["방향 전환"]);
		expect((await snapshot()).sessions[0]?.queued).toEqual([
			expect.objectContaining({ id: steer.submissionId, text: "방향 전환", deliverAs: "steer", cancelable: true }),
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

		await call("prompt", { sessionId: session.id, text: "두번째", deliverAs: "followUp" }, "followup-delivery");
		expect(sdk.getQueuedMessages().followUp).toEqual(["두번째"]);
		expect((await snapshot()).sessions[0]?.queued ?? []).toHaveLength(1);
		await call("abort", { sessionId: session.id });
		await expect(running).rejects.toThrow("Prompt outcome unknown");
		expect(control.aborts).toBe(1);
		expect(sdk.isStreaming).toBe(false);
		expect(sdk.getQueuedMessages()).toEqual({ steering: [], followUp: [] });
		expect(control.prompts).toHaveLength(1);
		const aborted = (await snapshot()).sessions[0];
		expect(aborted?.status).not.toBe("running");
		expect(aborted?.queued ?? []).toHaveLength(0);
		expect((await snapshot()).deliveries).toContainEqual(
			expect.objectContaining({ id: "followup-delivery", disposition: "cancelled" }),
		);
		expect(frames.some(frame => frame.type === "session" && frame.session.status === "running")).toBe(true);
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
			if (result === "success") await running;
			else await expect(running).rejects.toThrow(result === "error" ? "Prompt failed" : "Prompt outcome unknown");
			const expected = result === "success" ? "completed" : result === "error" ? "failed" : "unknown";
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
		const running = call("prompt", { sessionId: session.id, text: "짧은 작업" }, "prompt-delivery");
		await Promise.race([
			control.started,
			running.then(() => {
				throw new Error("Prompt settled before its controlled stream started");
			}),
		]);
		await expect(call("delivery.ack", { deliveryId: "prompt-delivery" })).rejects.toThrow("not final");
		await expect(call("prompt", { sessionId: session.id, text: "다른 작업" }, "prompt-delivery")).rejects.toThrow(
			"Duplicate delivery id",
		);
		control.finishTurn("echo: 짧은 작업");
		await running;
		expect((await snapshot()).deliveries).toContainEqual(
			expect.objectContaining({ id: "prompt-delivery", disposition: "completed" }),
		);
		await call("delivery.ack", { deliveryId: "prompt-delivery" });
		expect((await snapshot()).deliveries.some(receipt => receipt.id === "prompt-delivery")).toBe(false);
		const done = (await snapshot()).sessions[0];
		expect(done?.status).toBe("idle");
		expect(done?.messages.map(message => message.text)).toContain("echo: 짧은 작업");
		const history = await call<DesktopHistory>("history.get", { sessionId: session.id });
		expect(history.messages.map(message => message.text)).toContain("짧은 작업");
		expect(history.messages.map(message => message.text)).toContain("echo: 짧은 작업");
		const transcript = await Bun.file(sdk.sessionFile!).text();
		expect(transcript).toContain("짧은 작업");
		expect(transcript).toContain("echo: 짧은 작업");
		expect(sdk.sessionManager.getCwd()).toBe(project.path);
		expect(await call<DesktopCommandResult>("command.run", { sessionId: session.id, text: "/jobs" })).toMatchObject({
			consumed: true,
		});
	});
});

interface ControlledAgent {
	agent: Agent;
	started: Promise<void>;
	prompts: string[];
	readonly aborts: number;
	finishTurn(response: string, failed?: boolean): void;
}
