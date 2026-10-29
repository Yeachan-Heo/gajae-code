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
import { loadExtensions } from "@gajae-code/coding-agent/extensibility/extensions";
import type { CreateAgentSessionResult } from "@gajae-code/coding-agent/sdk";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { EventBus } from "@gajae-code/coding-agent/utils/event-bus";
import { getAgentDir, setAgentDir } from "@gajae-code/utils";
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
	id: "controlled", name: "Controlled local stream", provider: "desktop-stream-fixture", api: "openai-completions",
	baseUrl: "https://example.invalid", reasoning: false, input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 1024,
};

function controlledAgent() {
	const started = Promise.withResolvers<void>();
	const prompts: string[] = [];
	let aborts = 0;
	let finishTurn: ((text: string) => void) | undefined;
	const agent = new Agent({
		initialState: { model, messages: [], tools: [], systemPrompt: [] },
		getApiKey: () => "local-stream-only",
		streamFn: (_model, context, options) => {
			const text = context.messages.flatMap(message => message.role === "user" ? [
				typeof message.content === "string" ? message.content
					: message.content.filter(block => block.type === "text").map(block => block.text).join(""),
			] : []).join("\n");
			prompts.push(text);
			const stream = new AssistantMessageEventStream();
			const message: AssistantMessage = {
				role: "assistant", content: [{ type: "text", text: "working" }], api: model.api,
				provider: model.provider, model: model.id, stopReason: "stop", timestamp: Date.now(),
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			};
			let done = false;
			const settle = (aborted: boolean, response = "") => {
				if (done) return;
				done = true;
				options?.signal?.removeEventListener("abort", abort);
				if (aborted) {
					aborts++;
					message.stopReason = "aborted";
					stream.push({ type: "error", reason: "aborted", error: message });
				} else {
					message.content = [{ type: "text", text: response }];
					stream.push({ type: "done", reason: "stop", message });
				}
			};
			const abort = () => settle(true);
			finishTurn = response => settle(false, response);
			options?.signal?.addEventListener("abort", abort, { once: true });
			queueMicrotask(() => {
				stream.push({ type: "start", partial: message });
				stream.push({ type: "text_delta", contentIndex: 0, delta: "working", partial: message });
				if (options?.signal?.aborted) abort();
			});
			return stream;
		},
	});
	agent.subscribe(event => { if (event.type === "message_update") started.resolve(); });
	return { agent, started: started.promise, prompts, get aborts() { return aborts; }, finishTurn(response: string) {
		if (!finishTurn) throw new Error("No controlled provider turn is running");
		finishTurn(response);
	} };
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
		try { while (cleanups.length > 0) await cleanups.pop()?.(); }
		finally {
			vi.restoreAllMocks();
			for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key];
			Object.assign(process.env, environment);
			setAgentDir(previousAgentDir);
		}
	});

	async function launch() {
		const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-desktop-stream-"));
		const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-desktop-project-"));
		await setModelPresetRegistryDisabled({ agentDir: path.join(dataDir, "agent"), disabled: true });
		await Bun.write(path.join(projectDir, ".gjc", "config.yml"), "compaction:\n  enabled: false\nretry:\n  enabled: false\n");
		// Host initialization ordinarily refreshes online; model discovery is not under test.
		vi.spyOn(ModelRegistry.prototype, "refresh").mockResolvedValue(undefined);
		const frames: DesktopFrame[] = [];
		const captures: Array<{ session: AgentSession; control: ControlledAgent }> = [];
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
				const session = new AgentSession({
					agent: control.agent, sessionManager: options.sessionManager, settings: options.settings,
					modelRegistry: options.modelRegistry, agentDir: options.agentDir, workflowGatePublication: "local",
				});
				captures.push({ session, control });
				const eventBus = new EventBus();
				const extensionsResult = await loadExtensions([], options.sessionManager.getCwd(), eventBus);
				session.registerToolSessionCleanup(() => eventBus.clear());
				// No extensions/tools are loaded in this fixture. Only the unrelated factory UI setter is unused.
				return { session, extensionsResult, eventBus, setToolUIContext: () => {} } satisfies CreateAgentSessionResult;
			},
		});
		cleanups.push(async () => {
			try { await host.close(); }
			finally {
				await fs.rm(dataDir, { recursive: true, force: true });
				await fs.rm(projectDir, { recursive: true, force: true });
			}
		});
		const call = async <T>(method: DesktopRequest["method"], params: Record<string, unknown> = {}): Promise<T> => {
			const id = crypto.randomUUID();
			await host.handle(parseRequest(JSON.stringify({ id, method, params })));
			const response = frames.find(frame => frame.type === "response" && frame.id === id);
			if (!response || response.type !== "response") throw new Error(`No response for ${method}`);
			if (!response.ok) throw new Error(response.error);
			return response.result as T;
		};
		const snapshot = () => call<DesktopSnapshot>("bootstrap");
		const project = await call<DesktopProject>("project.open", { path: projectDir });
		const session = await call<DesktopSession>("session.create", { projectId: project.id });
		return { call, snapshot, project, session, sdk: captures[0]!.session, control: captures[0]!.control, frames };
	}

	test("a run reports running, accepts a steer, and abort clears it", async () => {
		const { call, snapshot, session, sdk, control, frames } = await launch();
		const running = call("prompt", { sessionId: session.id, text: "긴 작업" });
		await Promise.race([control.started, running.then(() => { throw new Error("Prompt settled before its controlled stream started"); })]);
		expect(sdk.isStreaming).toBe(true);
		expect(control.prompts).toHaveLength(1);
		expect(control.prompts[0]).toContain("긴 작업");
		expect((await snapshot()).sessions[0]?.status).toBe("running");
		expect((await snapshot()).sessions[0]?.messages.map(message => message.text)).toContain("working");
		await expect(call("command.run", { sessionId: session.id, text: "/tools" })).rejects.toThrow("실행 중");

		const steer = await call<{ queued: boolean; submissionId: string }>("prompt", {
			sessionId: session.id, text: "방향 전환", deliverAs: "steer",
		});
		expect(steer.queued).toBe(true);
		expect(sdk.getQueuedMessages().steering).toEqual(["방향 전환"]);
		expect((await snapshot()).sessions[0]?.queued).toEqual([
			expect.objectContaining({ id: steer.submissionId, text: "방향 전환", deliverAs: "steer", cancelable: true }),
		]);
		expect(await call<{ removed: boolean }>("queue.cancel", { sessionId: session.id, queueId: steer.submissionId })).toEqual({ removed: true });
		expect(sdk.getQueuedMessages().steering).toEqual([]);
		expect((await snapshot()).sessions[0]?.queued ?? []).toHaveLength(0);

		await call("prompt", { sessionId: session.id, text: "두번째", deliverAs: "followUp" });
		expect(sdk.getQueuedMessages().followUp).toEqual(["두번째"]);
		expect((await snapshot()).sessions[0]?.queued ?? []).toHaveLength(1);
		await call("abort", { sessionId: session.id });
		await running;
		expect(control.aborts).toBe(1);
		expect(sdk.isStreaming).toBe(false);
		expect(sdk.getQueuedMessages()).toEqual({ steering: [], followUp: [] });
		expect(control.prompts).toHaveLength(1);
		const aborted = (await snapshot()).sessions[0];
		expect(aborted?.status).not.toBe("running");
		expect(aborted?.queued ?? []).toHaveLength(0);
		expect(frames.some(frame => frame.type === "session" && frame.session.status === "running")).toBe(true);
	});

	test("a completed turn returns the session to idle and keeps its genuine transcript", async () => {
		const { call, snapshot, session, sdk, control, project } = await launch();
		const running = call("prompt", { sessionId: session.id, text: "짧은 작업" });
		await Promise.race([control.started, running.then(() => { throw new Error("Prompt settled before its controlled stream started"); })]);
		control.finishTurn("echo: 짧은 작업");
		await running;
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
		expect(await call<DesktopCommandResult>("command.run", { sessionId: session.id, text: "/jobs" })).toMatchObject({ consumed: true });
	});
});

interface ControlledAgent {
	agent: Agent;
	started: Promise<void>;
	prompts: string[];
	readonly aborts: number;
	finishTurn(response: string): void;
}
