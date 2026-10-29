/** Host + JSON-lines transport + genuine SDK controls. Owner commits below are a unit seam, NOT DOM evidence. */
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import type { AssistantMessage, Model } from "@gajae-code/ai/core";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";
import { AsyncJobManager, type SubagentRunOutcome } from "@gajae-code/coding-agent/async/job-manager";
import { setModelPresetRegistryDisabled } from "@gajae-code/coding-agent/config/model-preset-registry";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { readDurableModelProfileOwnership } from "@gajae-code/coding-agent/config/model-profile-ownership";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { loadExtensions } from "@gajae-code/coding-agent/extensibility/extensions";
import { createAgentSession, type CreateAgentSessionOptions, type CreateAgentSessionResult } from "@gajae-code/coding-agent/sdk";
import { JobObservation } from "@gajae-code/coding-agent/sdk/job-observation";
import { approvalGate, executionGate, type OpenGateInput, type WorkflowGateEmitter } from "@gajae-code/coding-agent/sdk/workflow-gates";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { CronTool, listCronSnapshots } from "@gajae-code/coding-agent/tools/cron";
import type { ToolSession } from "@gajae-code/coding-agent/tools";
import { EventBus } from "@gajae-code/coding-agent/utils/event-bus";
import { getAgentDir, setAgentDir } from "@gajae-code/utils";
import type { DesktopActivityDetail, DesktopActivityRef, DesktopActivitySnapshot } from "../src/activity-protocol";
import { DESKTOP_ACTIVITY_LIMITS } from "../src/activity-controls";
import { DESKTOP_GATE_PRESENTATION_LIMITS } from "../src/gate-presentation";
import type { DesktopGatePresentation, DesktopGatePresentationEvent } from "../src/gate-presentation-protocol";
import type { DesktopPreferences, DesktopPreferenceResult } from "../src/preferences-protocol";
import { DesktopHost } from "../src/host";
import type { DesktopActivityUpdate, DesktopFrame, DesktopProject, DesktopRequest, DesktopSession, DesktopSnapshot } from "../src/protocol";
import { serveProtocol } from "../src/transport";

const provider = "desktop-transport-fixture";
const secret = "transport-owned-secret-never-render";
const endpoint = "https://example.invalid/private-transport-endpoint";
const cleanups: Array<() => Promise<void>> = [];
let environment: NodeJS.ProcessEnv;
let agentDir: string;
beforeEach(() => {
	environment = { ...process.env };
	agentDir = getAgentDir();
	process.env.GJC_DESKTOP_ISOLATED = "1";
	delete process.env.GJC_CODING_AGENT_DIR;
	delete process.env.CLAUDE_CODE_DISABLE_CRON;
	delete process.env.GJC_DESKTOP_TRANSPORT_UNUSED_API_KEY;
	// Discovery is unrelated to transport; never refresh a real provider or user's credentials.
	vi.spyOn(ModelRegistry.prototype, "refresh").mockResolvedValue(undefined);
});
afterEach(async () => {
	vi.useRealTimers();
	try { while (cleanups.length) await cleanups.pop()?.(); }
	finally {
		vi.restoreAllMocks();
		for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key];
		Object.assign(process.env, environment);
		setAgentDir(agentDir);
	}
});

type Response = Extract<DesktopFrame, { type: "response" }>;
type GateFrame = Extract<DesktopFrame, { type: "gate" }>;
type Retirement = Extract<DesktopGatePresentationEvent, { type: "retire" }>;
type RemoteEmitter = WorkflowGateEmitter & Required<Pick<WorkflowGateEmitter, "listPendingGates" | "listWorkflowGateQueryRecords">>;
interface ActivityUpdate extends DesktopActivityUpdate {
	activity: Extract<DesktopActivitySnapshot, { available: true }>;
}

/** Actual transport input queue; ACKs must be dispatched while earlier requests remain pending. */
class Input implements AsyncIterable<Uint8Array> {
	readonly #queued: Uint8Array[] = [];
	#wake = Promise.withResolvers<void>();
	#ended = false;
	push(value: unknown): void {
		this.#queued.push(new TextEncoder().encode(`${JSON.stringify(value)}\n`));
		this.#wake.resolve();
	}
	end(): void { this.#ended = true; this.#wake.resolve(); }
	async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
		while (true) {
			const chunk = this.#queued.shift();
			if (chunk) { yield chunk; continue; }
			if (this.#ended) return;
			await this.#wake.promise;
			this.#wake = Promise.withResolvers<void>();
		}
	}
}

function connect(dataDir: string, createSession: (options: CreateAgentSessionOptions) => Promise<CreateAgentSessionResult>) {
	const input = new Input();
	const frames: DesktopFrame[] = [];
	const responses = new Map<string, (response: Response) => void>();
	const observers = new Set<() => void>();
	const emit = (frame: DesktopFrame) => {
		frames.push(frame);
		if (frame.type === "response") responses.get(frame.id)?.(frame);
		for (const observer of observers) observer();
	};
	const host = new DesktopHost({ dataDir, createSession, emit });
	const serving = serveProtocol(input, host, emit);
	const call = async <T>(method: DesktopRequest["method"], params: Record<string, unknown> = {}): Promise<T> => {
		const id = crypto.randomUUID();
		const response = Promise.withResolvers<Response>();
		responses.set(id, response.resolve);
		input.push({ id, method, params });
		try {
			const result = await response.promise;
			if (!result.ok) throw new Error(`${method}: ${result.error}`);
			return result.result as T;
		} finally { responses.delete(id); }
	};
	const waitFrame = <T extends DesktopFrame>(predicate: (frame: DesktopFrame) => frame is T): Promise<T> => {
		const previous = frames.find(predicate);
		if (previous) return Promise.resolve(previous);
		const deferred = Promise.withResolvers<T>();
		const observer = () => {
			const frame = frames.find(predicate);
			if (!frame) return;
			observers.delete(observer);
			deferred.resolve(frame);
		};
		observers.add(observer);
		return deferred.promise;
	};
	let closed = false;
	const close = async () => {
		if (closed) return;
		closed = true;
		input.end();
		await serving;
	};
	return { host, call, frames, waitFrame, close };
}

function heldAgent(model: Model) {
	const started = Promise.withResolvers<void>();
	let finish: (() => void) | undefined;
	const agent = new Agent({
		initialState: { model, systemPrompt: ["private system instructions"], messages: [], tools: [] },
		getApiKey: () => secret,
		streamFn: (selected, _context, options) => {
			const stream = new AssistantMessageEventStream();
			const message: AssistantMessage = {
				role: "assistant", api: selected.api, provider: selected.provider, model: selected.id,
				content: [{ type: "text", text: "controlled work" }], stopReason: "stop", timestamp: Date.now(),
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			};
			let done = false;
			const settle = (aborted: boolean) => {
				if (done) return;
				done = true;
				options?.signal?.removeEventListener("abort", abort);
				if (aborted) {
					message.stopReason = "aborted";
					stream.push({ type: "error", reason: "aborted", error: message });
				} else stream.push({ type: "done", reason: "stop", message });
			};
			const abort = () => settle(true);
			finish = () => settle(false);
			options?.signal?.addEventListener("abort", abort, { once: true });
			queueMicrotask(() => {
				stream.push({ type: "start", partial: message });
				stream.push({ type: "text_delta", contentIndex: 0, delta: "controlled work", partial: message });
				if (options?.signal?.aborted) abort();
			});
			return stream;
		},
	});
	agent.subscribe(event => { if (event.type === "message_update") started.resolve(); });
	return { agent, started: started.promise, finish() {
		if (!finish) throw new Error("Controlled stream has not started");
		finish();
	} };
}

async function fixture(retentionMs?: number, canonicalFactory = false) {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-activity-transport-"));
	const dataDir = path.join(directory, "app");
	const scopedAgentDir = path.join(dataDir, "agent");
	await setModelPresetRegistryDisabled({ agentDir: scopedAgentDir, disabled: true });
	await Bun.write(path.join(scopedAgentDir, "models.yml"), JSON.stringify({
		providers: { [provider]: { api: "openai-completions", baseUrl: endpoint, apiKeyEnv: "GJC_DESKTOP_TRANSPORT_UNUSED_API_KEY", models: ["base", "next", "worker"].map(id => ({
			id, name: `Transport ${id}`, reasoning: false, input: ["text"], contextWindow: 200_000, maxTokens: 1024,
		})) } },
		profiles: {
			"desktop-a": { display_name: "Desktop A", required_providers: [provider], model_mapping: { default: `${provider}/base` } },
			"desktop-b": { display_name: "Desktop B", required_providers: [provider], model_mapping: { default: `${provider}/next`, executor: `${provider}/worker` } },
		},
	}));
	const auth = await AuthStorage.create(path.join(scopedAgentDir, "agent.db"));
	await auth.set(provider, { type: "api_key", key: secret });
	auth.close();
	const jobs = new AsyncJobManager({ onJobComplete: () => {}, retentionMs });
	const priorManager = AsyncJobManager.instance();
	const captures: Array<{ sdk: AgentSession; owner: string; observation: JobObservation; options: CreateAgentSessionOptions; control: HeldAgent; factory: CreateAgentSessionResult; manager: AsyncJobManager }> = [];
	const createSession = async (options: CreateAgentSessionOptions): Promise<CreateAgentSessionResult> => {
		if (!options.sessionManager || !options.settings || !options.modelRegistry) throw new Error("Missing host SDK services");
		const model = options.modelRegistry.find(provider, "base");
		if (!model) throw new Error("Missing deterministic configured model");
		options.settings.override("compaction.enabled", false);
		options.settings.override("retry.enabled", false);
		const owner = crypto.randomUUID();
		const control = heldAgent(model);
		if (canonicalFactory) {
			options.settings.override("bash.autoBackground.enabled", false);
			const factory = await createAgentSession({
				...options, model, agentId: owner, extensions: [], toolNames: [], skills: [], rules: [],
				contextFiles: [], promptTemplates: [], slashCommands: [],
				workspaceTree: { rootPath: String(options.cwd), rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
				enableMCP: false, enableMcpAutoload: false, enableLsp: false, skipPythonPreflight: true,
				deferOptionalModelRefresh: true,
			});
			const observation = factory.jobObservation;
			const manager = AsyncJobManager.instance();
			if (!observation || !manager) throw new Error("Canonical factory must own actual background observation services");
			captures.push({ sdk: factory.session, owner, observation, options, control, factory, manager });
			// The unused extension UI setter is outside this factory-observation lifecycle regression.
			vi.spyOn(factory, "setToolUIContext").mockImplementation(() => {});
			return factory;
		}
		const sdk = new AgentSession({
			agent: control.agent, sessionManager: options.sessionManager, settings: options.settings,
			modelRegistry: options.modelRegistry, agentDir: options.agentDir, agentRegistry: options.agentRegistry,
			ownedAsyncJobManager: jobs, disposeAsyncJobManager: false, agentId: owner, workflowGatePublication: "local",
		});
		const observation = new JobObservation(jobs, owner);
		sdk.registerToolSessionCleanup(() => observation.dispose());
		const eventBus = new EventBus();
		const extensionsResult = await loadExtensions([], options.sessionManager.getCwd(), eventBus);
		sdk.registerToolSessionCleanup(() => eventBus.clear());
		// Feature implementations are genuine. No extensions/UI tools exist; this factory-only setter is unused.
		const factory = { session: sdk, jobObservation: observation, extensionsResult, eventBus, setToolUIContext: () => {} } satisfies CreateAgentSessionResult;
		captures.push({ sdk, owner, observation, options, control, factory, manager: jobs });
		return factory;
	};
	const connections = [connect(dataDir, createSession)];
	cleanups.push(async () => {
		try { for (const connection of connections) await connection.close(); }
		finally {
			await jobs.dispose();
			if (canonicalFactory) AsyncJobManager.setInstance(priorManager);
			await fs.rm(directory, { recursive: true, force: true });
		}
	});
	const connection = connections[0]!;
	const projectPath = path.join(directory, "project");
	await Bun.write(path.join(projectPath, ".gjc", "config.yml"), "compaction:\n  enabled: false\nretry:\n  enabled: false\n");
	const project = await connection.call<DesktopProject>("project.open", { path: projectPath });
	const open = async () => {
		const dto = await connection.call<DesktopSession>("session.create", { projectId: project.id });
		return { dto, ...captures[captures.length - 1]! };
	};
	const first = await open();
	const activity = async (sessionId = first.dto.id): Promise<ActivityUpdate> => {
		const result = await connection.call<DesktopActivityUpdate>("activity.get", { sessionId });
		if (!result.activity.available) throw new Error(result.activity.reason);
		return result as ActivityUpdate;
	};
	return { ...connection, jobs, first, open, activity, captures, async reconnect() {
		await connection.close();
		const successor = connect(dataDir, createSession);
		connections.push(successor);
		return successor;
	} };
}

interface HeldAgent {
	agent: Agent;
	started: Promise<void>;
	finish(): void;
}

function monitor(jobs: AsyncJobManager, ownerId: string, options: { id?: string; label?: string } = {}): string {
	const deferred = Promise.withResolvers<string>();
	return jobs.register("bash", options.label ?? "owned monitor", ({ signal }) => {
		if (signal.aborted) deferred.resolve("stopped");
		else signal.addEventListener("abort", () => deferred.resolve("stopped"), { once: true });
		return deferred.promise;
	}, { ownerId, id: options.id, metadata: { monitor: true } });
}

function task(jobs: AsyncJobManager, ownerId: string, id: string) {
	const deferred = Promise.withResolvers<SubagentRunOutcome>();
	const jobId = jobs.register("task", id, ({ signal }) => {
		signal.addEventListener("abort", () => deferred.resolve({ kind: "completed", text: "stopped" }), { once: true });
		return deferred.promise;
	}, { ownerId });
	jobs.registerSubagentRecord({ subagentId: id, ownerId, status: "running", currentJobId: jobId,
		historicalJobIds: [jobId], sessionFile: null, resumable: true });
	return { deferred, job: jobs.getJob(jobId)! };
}

function gates(sdk: AgentSession): RemoteEmitter {
	const emitter = sdk.getWorkflowGateEmitter();
	if (!emitter?.listPendingGates || !emitter.listWorkflowGateQueryRecords) throw new Error("Missing genuine default workflow emitter");
	return emitter as RemoteEmitter;
}
function workflow(sdk: AgentSession, input: OpenGateInput = approvalGate({ plan: "Complete transport plan" })) {
	const emitter = gates(sdk);
	const state = { advanced: false, rejected: false, answer: undefined as unknown };
	const promise = emitter.emitGate(input).then(answer => {
		state.advanced = true; state.answer = answer; return answer;
	}, error => { state.rejected = true; throw error; });
	void promise.catch(() => undefined);
	return { emitter, state, promise };
}
function gateRef(update: ActivityUpdate): DesktopActivityRef {
	const value = update.activity.sessionState?.gates;
	if (!value?.available || !value.pending[0]) throw new Error("Missing emitted gate reference");
	return value.pending[0].ref;
}
async function flush(): Promise<void> { for (let index = 0; index < 16; index++) await Promise.resolve(); }

/** Explicit controlled main-window commit/removal seam, never automatic event -> ACK or timeout -> ACK. */
class CommittedOwner {
	readonly mounted = new Set<string>();
	constructor(readonly connection: {
		call<T>(method: DesktopRequest["method"], params: Record<string, unknown>): Promise<T>;
		frames: DesktopFrame[];
		waitFrame<T extends DesktopFrame>(predicate: (frame: DesktopFrame) => frame is T): Promise<T>;
	}, readonly sessionId: string) {}
	async present(ref: DesktopActivityRef): Promise<DesktopGatePresentation> {
		return this.connection.call("gate.present", { sessionId: this.sessionId, ref });
	}
	async commit(presentation: DesktopGatePresentation): Promise<void> {
		if (!this.connection.frames.some(frame => frame.type === "gate" && frame.sessionId === this.sessionId
			&& frame.event.type === "presented" && frame.event.presentation.id === presentation.id)) throw new Error("Surface was not delivered to its owner");
		this.mounted.add(presentation.id);
		await this.connection.call("gate.presented", { sessionId: this.sessionId, presentationId: presentation.id });
	}
	async retirement(id: string): Promise<Retirement> {
		const frame = await this.connection.waitFrame((frame): frame is GateFrame => frame.type === "gate"
			&& frame.sessionId === this.sessionId && frame.event.type === "retire" && frame.event.presentationId === id);
		if (frame.event.type !== "retire") throw new Error("Missing retirement event");
		return frame.event;
	}
	async remove(event: Retirement): Promise<void> {
		this.mounted.delete(event.presentationId);
		await this.connection.call("gate.retired", { sessionId: this.sessionId, presentationId: event.presentationId, nonce: event.nonce });
	}
}

describe("desktop activity and preferences over the real transport", () => {
	test("busy reads and exact gate ACKs bypass a running prompt without releasing its lock", async () => {
		const f = await fixture();
		const { dto, sdk, owner, control } = f.first;
		const id = monitor(f.jobs, owner);
		f.jobs.appendOutput(id, "live monitor output");
		let promptSettled = false;
		const prompt = f.call("prompt", { sessionId: dto.id, text: "Hold this provider stream" }).finally(() => { promptSettled = true; });
		await Promise.race([control.started, prompt.then(() => { throw new Error("Prompt settled before its controlled stream started"); })]);
		const update = await f.activity();
		expect(update).toMatchObject({ sessionId: dto.id, revision: expect.any(Number) });
		expect(update.activity.jobs.find(job => job.id === id)?.status).toBe("running");
		const detail = await f.call<DesktopActivityDetail>("activity.detail", { sessionId: dto.id, ref: update.activity.jobs[0]!.ref });
		expect(detail.output?.text).toBe("live monitor output");
		expect((await f.call<DesktopPreferences>("preferences.get", { sessionId: dto.id })).profiles.map(profile => profile.id)).toContain("desktop-b");
		await expect(f.call("preferences.apply", { sessionId: dto.id, action: { type: "profile.select", name: "desktop-b", scope: "session" } })).rejects.toThrow("실행 중");
		const pending = workflow(sdk, executionGate({ summary: "Exact busy-turn execution boundary" }));
		const ui = new CommittedOwner(f, dto.id);
		const presentation = await ui.present(gateRef(await f.activity()));
		await ui.commit(presentation);
		const answer = f.call("gate.answer", { sessionId: dto.id, presentationId: presentation.id, answer: { kind: "json", json: '{"decision":"decline"}' } });
		const retirement = await ui.retirement(presentation.id);
		await flush();
		expect(pending.state.advanced).toBe(false);
		expect(ui.mounted.has(presentation.id)).toBe(true);
		expect(promptSettled).toBe(false);
		await ui.remove(retirement);
		expect(await answer).toEqual({ status: "accepted" });
		expect(await pending.promise).toEqual({ decision: "decline" });
		expect(sdk.isStreaming).toBe(true);
		expect(promptSettled).toBe(false);
		control.finish();
		await prompt;
		expect((await f.call<DesktopSnapshot>("bootstrap")).sessions[0]?.status).toBe("idle");
	});

	test("captured owners reject foreign session/connection/guessed references and ACK scopes", async () => {
		const f = await fixture();
		const second = await f.open();
		const foreignConnection = await fixture();
		const own = monitor(f.jobs, f.first.owner);
		const other = monitor(f.jobs, second.owner);
		monitor(foreignConnection.jobs, foreignConnection.first.owner);
		const first = await f.activity();
		const next = await f.activity(second.dto.id);
		const remote = await foreignConnection.activity();
		const ref = first.activity.jobs.find(job => job.id === own)!.ref;
		expect(first.activity.jobs.map(job => job.id)).toEqual([own]);
		expect(next.activity.jobs.map(job => job.id)).toEqual([other]);
		for (const forged of [next.activity.jobs[0]!.ref, { ...ref, key: next.activity.jobs[0]!.ref.key }, { ...ref, key: "guessed" }, remote.activity.jobs[0]!.ref]) {
			await expect(f.call("activity.operate", { sessionId: f.first.dto.id, ref: forged, operation: "cancel" })).rejects.toThrow();
		}
		await expect(f.call("activity.detail", { sessionId: f.first.dto.id, ref: { ...ref, sessionGeneration: "old" } })).rejects.toThrow("session has changed");
		await expect(f.call("activity.detail", { sessionId: f.first.dto.id, ref: { ...ref, connectionGeneration: "old" } })).rejects.toThrow("connection has changed");
		await expect(f.call("activity.acknowledge", { sessionId: f.first.dto.id, scope: next.activity })).rejects.toThrow("session has changed");
		await expect(f.call("activity.acknowledge", { sessionId: f.first.dto.id, scope: remote.activity })).rejects.toThrow("connection has changed");
		for (const params of [{ ref: { key: own }, operation: "cancel" }, { ref, operation: "kill" }, { ref: { ...ref, key: 7 }, operation: "cancel" }])
			await expect(f.call("activity.operate", { sessionId: f.first.dto.id, ...params })).rejects.toThrow("Invalid");
		expect(f.jobs.getJob(own)?.status).toBe("running");
		expect(f.jobs.getJob(other)?.status).toBe("running");
		// Owner claims are ignored by the parser; the issued ref still reaches only its captured owner.
		await f.call("activity.operate", { sessionId: f.first.dto.id, ref: { ...ref, ownerId: second.owner }, operation: "cancel" });
		expect(f.jobs.getJob(own)?.abortController.signal.aborted).toBe(true);
		expect(f.jobs.getJob(other)?.abortController.signal.aborted).toBe(false);
	});

	test("monitor cancellation mutates the real record, emits revisioned frames, and redacts before truncation", async () => {
		const f = await fixture();
		const id = monitor(f.jobs, f.first.owner, { label: `${secret}\x1b[31m${"x".repeat(2000)}` });
		f.jobs.appendOutput(id, `${"z".repeat(DESKTOP_ACTIVITY_LIMITS.outputChars - 4)}${secret}${"z".repeat(1000)}`);
		const before = await f.activity();
		const ref = before.activity.jobs[0]!.ref;
		const detail = await f.call<DesktopActivityDetail>("activity.detail", { sessionId: f.first.dto.id, ref });
		expect(before.activity.jobs[0]!.label).toStartWith("[redacted]");
		expect(before.activity.jobs[0]!.label).not.toContain("\x1b");
		expect(detail.output).toMatchObject({ truncated: true });
		expect(detail.output?.text).toHaveLength(DESKTOP_ACTIVITY_LIMITS.outputChars);
		const after = await f.call<ActivityUpdate>("activity.operate", { sessionId: f.first.dto.id, ref, operation: "cancel" });
		expect(f.jobs.getJob(id)?.status).toBe("cancelled");
		expect(after.revision).toBeGreaterThan(before.revision);
		expect(after.activity.jobs.find(job => job.id === id)?.status).toBe("cancelled");
		expect(f.frames).toContainEqual({ type: "activity", update: after });
		await expect(f.call("activity.operate", { sessionId: f.first.dto.id, ref, operation: "cancel" })).rejects.toThrow("already terminal");
		const serialized = JSON.stringify(f.frames);
		for (const forbidden of [secret, endpoint, f.first.owner, "private system instructions", "abortController", "ownerId", "sessionFile"])
			expect(serialized).not.toContain(forbidden);
	});

	test("failure acknowledgement clears only the owning observation's latch, not the failed record", async () => {
		const f = await fixture();
		const independent = new JobObservation(f.jobs, f.first.owner);
		try {
			const id = f.jobs.register("bash", "failure", async () => { throw new Error(`${secret}: private backend diagnostic`); },
				{ ownerId: f.first.owner, metadata: { monitor: true } });
			await f.jobs.getJob(id)!.promise;
			await f.jobs.drainDeliveries({ timeoutMs: 1000 });
			const before = await f.activity();
			expect(before.activity.failedUnacknowledged).toBe(true);
			expect(independent.getSnapshot().failedUnacknowledged).toBe(true);
			await expect(f.call("activity.acknowledge", { sessionId: f.first.dto.id, scope: { ...before.activity, connectionGeneration: "stale" } })).rejects.toThrow("connection has changed");
			expect((await f.activity()).activity.failedUnacknowledged).toBe(true);
			const after = await f.call<ActivityUpdate>("activity.acknowledge", { sessionId: f.first.dto.id, scope: before.activity });
			expect(after.activity.failedUnacknowledged).toBe(false);
			expect(after.activity.jobs.find(job => job.id === id)?.status).toBe("failed");
			expect(independent.getSnapshot().failedUnacknowledged).toBe(true);
			expect(JSON.stringify(f.frames)).not.toContain(secret);
		} finally { independent.dispose(); }
	});

	test("detached task pause/resume/stop uses captured real runners and reports actual failures", async () => {
		const f = await fixture();
		const id = "transport-task";
		const run = task(f.jobs, f.first.owner, id);
		let pauses = 0;
		f.jobs.registerLiveHandle(id, { requestPause: () => { pauses++; }, injectMessage: async () => { throw new Error("Unused message injection"); } });
		let resumed: string | undefined;
		f.jobs.registerResumeDescriptor({ subagentId: id, ownerId: f.first.owner, data: { private: "captured-runner-secret" } }, taskId => {
			resumed = f.jobs.register("task", taskId, ({ signal }) => {
				const stopped = Promise.withResolvers<string>();
				signal.addEventListener("abort", () => stopped.resolve("stopped"), { once: true });
				return stopped.promise;
			}, { ownerId: f.first.owner });
			return resumed;
		});
		const running = (await f.activity()).activity.tasks.find(entry => entry.id === id)!;
		expect(running.controls).toEqual(["stop", "pause"]);
		const pause = await f.call<ActivityUpdate>("activity.operate", { sessionId: f.first.dto.id, ref: running.ref, operation: "pause" });
		expect(pauses).toBe(1);
		expect(run.job.abortController.signal.aborted).toBe(false);
		expect(pause.activity.tasks[0]?.status).toBe("running");
		run.deferred.resolve({ kind: "paused", note: "safe boundary" });
		await run.job.promise;
		const paused = (await f.activity()).activity.tasks.find(entry => entry.id === id)!;
		expect(paused.controls).toEqual(["stop", "resume"]);
		await f.call("activity.operate", { sessionId: f.first.dto.id, ref: paused.ref, operation: "resume" });
		expect(f.jobs.getSubagentRecord(id)?.status).toBe("running");
		await expect(f.call("activity.operate", { sessionId: f.first.dto.id, ref: paused.ref, operation: "stop" })).rejects.toThrow();
		const active = (await f.activity()).activity.tasks.find(entry => entry.id === id)!;
		await f.call("activity.operate", { sessionId: f.first.dto.id, ref: active.ref, operation: "stop" });
		expect(f.jobs.getJob(resumed!)?.abortController.signal.aborted).toBe(true);
		await f.jobs.getJob(resumed!)!.promise;
		expect((await f.activity()).activity.tasks.find(entry => entry.id === id)?.status).toBe("cancelled");

		const failure = task(f.jobs, f.first.owner, "pause-failure");
		f.jobs.registerLiveHandle("pause-failure", { requestPause: () => { throw new Error(`${secret}: pause backend failure`); }, injectMessage: async () => { throw new Error("Unused injection"); } });
		const failing = (await f.activity()).activity.tasks.find(entry => entry.id === "pause-failure")!;
		await expect(f.call("activity.operate", { sessionId: f.first.dto.id, ref: failing.ref, operation: "pause" })).rejects.toThrow("backend operation failed");
		expect(failure.job.abortController.signal.aborted).toBe(false);
		expect(f.jobs.getSubagentRecord("pause-failure")?.status).toBe("running");
		f.jobs.registerSubagentRecord({ subagentId: "resume-failure", ownerId: f.first.owner, status: "paused", currentJobId: null, historicalJobIds: [], sessionFile: "/private/retained.jsonl", resumable: true });
		f.jobs.registerResumeDescriptor({ subagentId: "resume-failure", ownerId: f.first.owner, data: {} }, () => { throw new Error(`${secret}: admission failed`); });
		const resume = (await f.activity()).activity.tasks.find(entry => entry.id === "resume-failure")!;
		await expect(f.call("activity.operate", { sessionId: f.first.dto.id, ref: resume.ref, operation: "resume" })).rejects.toThrow("backend operation failed");
		expect(f.jobs.getSubagentRecord("resume-failure")?.status).toBe("paused");
		for (const forbidden of [secret, "captured-runner-secret", "/private/retained.jsonl", "pause backend failure", "admission failed"])
			expect(JSON.stringify(f.frames)).not.toContain(forbidden);
	});

	test("cron deletion removes real owner-scoped schedules without serializing prompts or deleting another session's timer", async () => {
		const f = await fixture();
		const second = await f.open();
		for (const capture of [f.first, second]) {
			const toolSession: ToolSession = {
				cwd: capture.sdk.sessionManager.getCwd(), hasUI: capture.options.hasUI === true, settings: capture.sdk.settings,
				getSessionFile: () => capture.sdk.sessionFile ?? null, getSessionSpawns: () => capture.options.spawns ?? null,
				getSessionId: () => capture.sdk.sessionManager.getSessionId(), getAgentId: () => capture.sdk.getAgentId() ?? null,
				getAsyncJobManager: () => f.jobs, sendCustomMessage: capture.sdk.sendCustomMessage.bind(capture.sdk),
			};
			await new CronTool(toolSession).execute("transport-cron", { op: "create", cron_expression: "0 * * * *", recurring: true, prompt: "private scheduled prompt" });
		}
		const own = (await f.activity()).activity.crons[0]!;
		const other = (await f.activity(second.dto.id)).activity.crons[0]!;
		expect(listCronSnapshots(f.first.owner).map(entry => entry.id)).toEqual([own.id]);
		expect(listCronSnapshots(second.owner).map(entry => entry.id)).toEqual([other.id]);
		await expect(f.call("activity.operate", { sessionId: f.first.dto.id, ref: other.ref, operation: "delete" })).rejects.toThrow();
		await expect(f.call("activity.operate", { sessionId: f.first.dto.id, ref: own.ref, operation: "cancel" })).rejects.toThrow("does not currently support");
		const removed = await f.call<ActivityUpdate>("activity.operate", { sessionId: f.first.dto.id, ref: own.ref, operation: "delete" });
		expect(removed.activity.crons).toHaveLength(0);
		expect(listCronSnapshots(f.first.owner)).toHaveLength(0);
		expect(listCronSnapshots(second.owner).map(entry => entry.id)).toEqual([other.id]);
		await expect(f.call("activity.operate", { sessionId: f.first.dto.id, ref: own.ref, operation: "delete" })).rejects.toThrow("no longer");
		expect(JSON.stringify(f.frames)).not.toContain("private scheduled prompt");
	});

	test("actual job-ID reuse cannot turn an old reference into authority over its successor", async () => {
		const f = await fixture(0);
		const id = monitor(f.jobs, f.first.owner, { id: "transport-aba-monitor" });
		const ref = (await f.activity()).activity.jobs.find(job => job.id === id)!.ref;
		const old = f.jobs.getJob(id)!;
		await f.call("activity.operate", { sessionId: f.first.dto.id, ref, operation: "cancel" });
		await old.promise;
		await f.jobs.drainDeliveries({ timeoutMs: 1000 });
		monitor(f.jobs, f.first.owner, { id });
		const successor = f.jobs.getJob(id)!;
		await expect(f.call("activity.operate", { sessionId: f.first.dto.id, ref, operation: "cancel" })).rejects.toThrow();
		expect(successor.generation).not.toBe(old.generation);
		expect(successor.status).toBe("running");
		expect(successor.abortController.signal.aborted).toBe(false);
		expect(f.jobs.getJob(id)).toBe(successor);
		const current = (await f.activity()).activity.jobs.find(job => job.id === id)!.ref;
		expect(current.key).not.toBe(ref.key);
		await f.call("activity.operate", { sessionId: f.first.dto.id, ref: current, operation: "cancel" });
		expect(successor.abortController.signal.aborted).toBe(true);
		await successor.promise;
		await f.jobs.drainDeliveries({ timeoutMs: 1000 });
		expect(successor.status).toBe("cancelled");
		expect(f.jobs.getJob(id)).toBeUndefined();
		expect((await f.activity()).activity.jobs.some(job => job.id === id)).toBe(false);
	});

	test("canonical factory renews Host capabilities after same-ID clear and A-B-A, never old references", async () => {
		const f = await fixture(undefined, true);
		const { sdk, factory, manager, owner, dto } = f.first;
		const originalId = sdk.sessionId;
		const originalFile = sdk.sessionFile!;
		const ui = new CommittedOwner(f, dto.id);
		let previousObservation = factory.jobObservation!;
		for (const transition of ["same-id-clear", "a-b-a"] as const) {
			const id = `before-${transition}`;
			manager.registerSubagentRecord({ subagentId: id, ownerId: owner, status: "paused", currentJobId: null,
				historicalJobIds: [], sessionFile: null, resumable: false });
			const previous = await f.activity();
			const oldRef = previous.activity.tasks.find(task => task.id === id)!.ref;
			const generation = sdk.sessionLifecycle.generation;
			if (transition === "same-id-clear") expect(await sdk.clearContext()).toBe(true);
			else {
				expect(await sdk.newSession()).toBe(true);
				expect(sdk.sessionId).not.toBe(originalId);
				expect(await sdk.switchSession(originalFile)).toBe(true);
			}
			expect(sdk.sessionId).toBe(originalId);
			expect(sdk.sessionFile).toBe(originalFile);
			expect(sdk.sessionLifecycle.generation).toBeGreaterThan(generation);
			expect(sdk.sessionLifecycle.transitioning).toBe(false);
			await expect(f.call("activity.detail", { sessionId: dto.id, ref: oldRef })).rejects.toThrow("session has changed");
			await expect(f.call("activity.operate", { sessionId: dto.id, ref: oldRef, operation: "stop" })).rejects.toThrow("session has changed");
			await expect(f.call("activity.acknowledge", { sessionId: dto.id, scope: previous.activity })).rejects.toThrow("session has changed");
			const current = await f.activity();
			expect(current.activity.sessionGeneration).not.toBe(previous.activity.sessionGeneration);
			expect(current.activity.connectionGeneration).toBe(previous.activity.connectionGeneration);
			expect(current.revision).toBeGreaterThan(previous.revision);
			const observation = factory.jobObservation!;
			expect(observation).not.toBe(previousObservation);
			expect(() => previousObservation.getSnapshot()).toThrow("disposed");
			previousObservation = observation;

			const freshId = `after-${transition}`;
			manager.registerSubagentRecord({ subagentId: freshId, ownerId: owner, status: "paused", currentJobId: null,
				historicalJobIds: [], sessionFile: null, resumable: false });
			const fresh = (await f.activity()).activity.tasks.find(task => task.id === freshId)!;
			expect(fresh.controls).toEqual(["stop"]);
			await f.call("activity.operate", { sessionId: dto.id, ref: fresh.ref, operation: "stop" });
			expect(manager.getSubagentRecord(freshId)?.status).toBe("cancelled");
			const preferences = await f.call<DesktopPreferenceResult>("preferences.apply", {
				sessionId: dto.id, action: { type: "profile.select", name: "desktop-b", scope: "session" },
			});
			expect(preferences.preferences.profiles.find(profile => profile.id === "desktop-b")?.active).toBe(true);
			expect(sdk.model?.id).toBe("next");
			const pending = workflow(sdk, executionGate({ summary: `Fresh ${transition} gate` }));
			const presentation = await ui.present(gateRef(await f.activity()));
			await ui.commit(presentation);
			const answering = f.call("gate.answer", { sessionId: dto.id, presentationId: presentation.id,
				answer: { kind: "json", json: '{"decision":"decline"}' } });
			const retirement = await ui.retirement(presentation.id);
			expect(pending.state.advanced).toBe(false);
			await ui.remove(retirement);
			expect(await answering).toEqual({ status: "accepted" });
			expect(await pending.promise).toEqual({ decision: "decline" });
		}
	});

	test("session profile selection changes real model/roles but not another session or durable default", async () => {
		const f = await fixture();
		const second = await f.open();
		const beforeDefault = f.first.sdk.settings.getGlobal("modelProfile.default");
		const result = await f.call<DesktopPreferenceResult>("preferences.apply", { sessionId: f.first.dto.id, action: { type: "profile.select", name: "desktop-b", scope: "session" } });
		expect(result).toMatchObject({ applied: "profile.select", profileId: "desktop-b", scope: "session", durability: "session" });
		expect(f.first.sdk.model?.id).toBe("next");
		expect(f.first.sdk.getActiveModelProfile()).toBe("desktop-b");
		expect(result.preferences.roles.find(role => role.id === "executor")?.model?.id).toBe("worker");
		expect(second.sdk.model?.id).toBe("base");
		expect(second.sdk.getActiveModelProfile()).toBeUndefined();
		expect(f.first.sdk.settings.getGlobal("modelProfile.default")).toBe(beforeDefault);
		expect((await f.call<DesktopPreferences>("preferences.get", { sessionId: f.first.dto.id })).profiles.find(profile => profile.id === "desktop-b")?.active).toBe(true);
		for (const forbidden of [secret, endpoint, "model_mapping", "required_providers", "private system instructions"])
			expect(JSON.stringify(f.frames)).not.toContain(forbidden);
	});

	test("durable default selection preserves manual intent; refused actions and credential failures retain committed state", async () => {
		const f = await fixture();
		const revision = f.first.sdk.getUserModelSelectionRevision();
		for (const action of [null, [], {}, { type: "profile.select", name: "desktop-b" },
			{ type: "profile.select", name: "desktop-b", scope: "session", ownerId: "forged" },
			{ type: "sampling.set", parameter: "temperature", value: "1", scope: "session" },
			{ type: "role.set", role: "unknown", modelId: "base" }]) {
			await expect(f.call("preferences.apply", { sessionId: f.first.dto.id, action })).rejects.toThrow();
		}
		for (const action of [{ type: "sampling.set", parameter: "temperature", value: 0.4, scope: "session" },
			{ type: "role.set", role: "executor", modelId: `${provider}/worker` }])
			await expect(f.call("preferences.apply", { sessionId: f.first.dto.id, action })).rejects.toThrow();
		await expect(f.call("preferences.apply", { sessionId: f.first.dto.id, action: { type: "profile.select", name: "does-not-exist", scope: "session" } })).rejects.toThrow();
		expect(f.first.sdk.getUserModelSelectionRevision()).toBe(revision);

		const second = await f.open();
		const manualModel = second.sdk.modelRegistry.find(provider, "worker");
		if (!manualModel) throw new Error("Missing actual manual-selection fixture model");
		await second.sdk.setModelTemporary(manualModel, undefined, { cause: "user-selection", persistAsSessionDefault: true });
		second.sdk.settings.override("task.agentModelOverrides", { critic: `${provider}/worker` });
		const manualChain = second.sdk.getConfiguredModelChainState("default");
		const manualOverrides = second.sdk.settings.getOverride("task.agentModelOverrides");
		const settings = f.first.sdk.settings;
		expect(settings).toBe(f.first.options.settings!);
		await settings.flushOrThrow();
		const ownershipBefore = readDurableModelProfileOwnership(settings);
		const projectConfig = path.join(f.first.sdk.sessionManager.getCwd(), ".gjc", "config.yml");
		const projectBefore = await Bun.file(projectConfig).text();
		const control = vi.spyOn(f.first.sdk, "setDefaultModelProfileForControl");
		const persisted = await f.call<DesktopPreferenceResult>("preferences.apply", {
			sessionId: f.first.dto.id, action: { type: "profile.select", name: "desktop-b", scope: "default" },
		});
		expect(control).toHaveBeenCalledWith("desktop-b", { persistDefault: true, onBeforeActivation: expect.any(Function) });
		expect(persisted).toMatchObject({ applied: "profile.select", profileId: "desktop-b", scope: "default", durability: "persisted" });
		expect(persisted.preferences.profiles.find(profile => profile.id === "desktop-b")).toMatchObject({ active: true, default: true });
		expect(f.first.sdk.model?.id).toBe("next");
		expect(f.first.sdk.getActiveModelProfile()).toBe("desktop-b");
		expect(persisted.preferences.roles.find(role => role.id === "executor")?.model?.id).toBe("worker");
		const ownership = readDurableModelProfileOwnership(settings);
		expect(ownership).toEqual({ schemaVersion: 1, version: ownershipBefore.version + 1, marker: { kind: "profile", profile: "desktop-b" } });
		expect(settings.getGlobal("modelProfile.default")).toBe("desktop-b");
		const reopened = await Settings.loadForScope({ cwd: f.first.sdk.sessionManager.getCwd(), agentDir: f.first.options.agentDir! });
		try {
			expect(readDurableModelProfileOwnership(reopened)).toEqual(ownership);
			expect(reopened.getGlobal("modelProfile.default")).toBe("desktop-b");
		} finally { await reopened.close(); }
		expect(await Bun.file(projectConfig).text()).toBe(projectBefore);
		expect(second.sdk.model?.id).toBe("worker");
		expect(second.sdk.getActiveModelProfile()).toBeUndefined();
		expect(second.sdk.getConfiguredModelChainState("default")).toEqual(manualChain);
		expect(second.sdk.settings.getOverride("task.agentModelOverrides")).toEqual(manualOverrides);

		const beforeModel = f.first.sdk.model;
		const beforeProfile = f.first.sdk.getActiveModelProfile();
		const beforeOverrides = settings.getOverride("task.agentModelOverrides");
		const beforeChain = f.first.sdk.getConfiguredModelChainState("default");
		const durableConfig = path.join(f.first.options.agentDir!, "config.yml");
		const durableBefore = await Bun.file(durableConfig).text();
		const usageBefore = settings.getStorage()!.getModelUsageOrder();
		// Remove actual stored credentials, rather than mocking successful model activation.
		await f.first.options.authStorage!.remove(provider);
		for (const scope of ["session", "default"] as const) {
			await expect(f.call("preferences.apply", { sessionId: f.first.dto.id, action: { type: "profile.select", name: "desktop-a", scope } })).rejects.toThrow();
			expect(f.first.sdk.model).toBe(beforeModel);
			expect(f.first.sdk.getActiveModelProfile()).toBe(beforeProfile);
			expect(settings.getOverride("task.agentModelOverrides")).toEqual(beforeOverrides);
			expect(f.first.sdk.getConfiguredModelChainState("default")).toEqual(beforeChain);
			expect(readDurableModelProfileOwnership(settings)).toEqual(ownership);
			expect(settings.getGlobal("modelProfile.default")).toBe("desktop-b");
			expect(await Bun.file(durableConfig).text()).toBe(durableBefore);
			expect(settings.getStorage()!.getModelUsageOrder()).toEqual(usageBefore);
		}
		expect(JSON.stringify(f.frames)).not.toContain(secret);
	});
});

describe("genuine workflow gate transport terminalization", () => {
	test.each(["clear", "delete"] as const)("%s waits for every issued gate surface before mutating the SDK session", async operation => {
		const f = await fixture(undefined, true);
		const { sdk, dto } = f.first;
		const pending = workflow(sdk);
		const ui = new CommittedOwner(f, dto.id);
		const ref = gateRef(await f.activity());
		const first = await ui.present(ref);
		const second = await ui.present(ref);
		await ui.commit(first);
		const generation = sdk.sessionLifecycle.generation;
		let finished = false;
		const mutation = (operation === "clear"
			? f.call("command.run", { sessionId: dto.id, text: "/clear" })
			: f.call("session.delete", { sessionId: dto.id })).then(result => { finished = true; return result; });
		void mutation.catch(() => undefined);
		const firstRetirement = await ui.retirement(first.id);
		const secondRetirement = await ui.retirement(second.id);
		expect(firstRetirement.nonce).not.toBe(secondRetirement.nonce);
		expect(sdk.sessionLifecycle).toMatchObject({ generation, disposed: false });
		expect(finished).toBe(false);
		expect(pending.state.advanced).toBe(false);
		await expect(ui.present(ref)).rejects.toThrow("세션 변경 전에");
		await expect(f.call("gate.retired", { sessionId: dto.id, presentationId: second.id, nonce: firstRetirement.nonce }))
			.rejects.toThrow("No matching");
		await ui.remove(firstRetirement);
		await flush();
		expect(sdk.sessionLifecycle).toMatchObject({ generation, disposed: false });
		expect(finished).toBe(false);
		expect(pending.state.advanced).toBe(false);
		// Even an issued surface that never committed needs its own authentic ACK.
		await ui.remove(secondRetirement);
		await mutation;
		expect(finished).toBe(true);
		expect(pending.state.advanced).toBe(false);
		if (operation === "clear") {
			expect(sdk.sessionLifecycle.generation).toBeGreaterThan(generation);
			expect(sdk.sessionLifecycle.disposed).toBe(false);
		} else {
			expect(sdk.sessionLifecycle.disposed).toBe(true);
			expect((await f.call<DesktopSnapshot>("bootstrap")).sessions.some(session => session.id === dto.id)).toBe(false);
		}
	}, 30_000);

	test("activity reads preserve scheduled publication and exact answer retirement immediately publishes idle", async () => {
		const f = await fixture();
		const baseline = await f.activity();
		const ui = new CommittedOwner(f, f.first.dto.id);
		vi.useFakeTimers();
		try {
			const pending = workflow(f.first.sdk, executionGate({ summary: "Read before publication, then answer" }));
			const read = await f.activity();
			const ref = { ...gateRef(read) };
			expect(typeof ref.sessionGeneration).toBe("string");
			expect(typeof ref.connectionGeneration).toBe("string");
			expect(typeof ref.key).toBe("string");
			expect(read.revision).toBeGreaterThan(baseline.revision);
			const pendingGates = read.activity.sessionState?.gates;
			if (!pendingGates?.available) throw new Error("Expected real pending workflow gates");
			expect(pendingGates.pending.map(gate => gate.kind)).toEqual(["execution"]);
			expect(f.frames.some(frame => frame.type === "activity" && frame.update.sessionId === f.first.dto.id
				&& frame.update.revision === read.revision)).toBe(false);
			// Only the scheduled notification publishes; a preceding read must not consume it.
			vi.advanceTimersByTime(75);
			await flush();
			expect(f.frames).toContainEqual({ type: "activity", update: read });
			expect(f.frames.filter(frame => frame.type === "session").at(-1)).toMatchObject({
				type: "session", session: { id: f.first.dto.id, status: "waiting" },
			});
			const presentation = await ui.present(ref);
			await ui.commit(presentation);
			const offset = f.frames.length;
			const answering = f.call("gate.answer", { sessionId: f.first.dto.id, presentationId: presentation.id,
				answer: { kind: "json", json: '{"decision":"approve"}' } });
			const retirement = await ui.retirement(presentation.id);
			expect(pending.state.advanced).toBe(false);
			expect(ui.mounted.has(presentation.id)).toBe(true);
			await ui.remove(retirement);
			expect(await answering).toEqual({ status: "accepted" });
			expect(await pending.promise).toEqual({ decision: "approve" });
			expect(pending.state.advanced).toBe(true);
			expect(ui.mounted.size).toBe(0);
			// No clock advance after answering: the response path itself must refresh the sidebar.
			const answered = f.frames.slice(offset);
			expect(answered.filter(frame => frame.type === "session").at(-1)).toMatchObject({
				type: "session", session: { id: f.first.dto.id, status: "idle" },
			});
			const update = answered.filter(frame => frame.type === "activity").at(-1);
			expect(update).toMatchObject({ type: "activity", update: { sessionId: f.first.dto.id,
				activity: { sessionState: { gates: { available: true, pending: [] } } } } });
			if (update?.type !== "activity") throw new Error("Answer did not publish refreshed activity");
			expect(update.update.revision).toBeGreaterThan(read.revision);
			expect((await f.activity()).activity.sessionState?.gates).toMatchObject({ available: true, pending: [] });
		} finally { vi.useRealTimers(); }
	});

	test("reads, guessed IDs, foreign refs, uncommitted surfaces and invalid answers cannot advance a workflow", async () => {
		const f = await fixture();
		const second = await f.open();
		const pending = workflow(f.first.sdk, executionGate({ summary: `${secret}: complete execution boundary` }));
		const other = workflow(second.sdk);
		const ref = gateRef(await f.activity());
		const foreign = gateRef(await f.activity(second.dto.id));
		const ui = new CommittedOwner(f, f.first.dto.id);
		await expect(ui.present(foreign)).rejects.toThrow();
		await expect(ui.present({ ...ref, key: "guessed-gate" })).rejects.toThrow();
		await expect(ui.present({ ...ref, connectionGeneration: "old" })).rejects.toThrow("connection has changed");
		await expect(f.call("gate.presented", { sessionId: f.first.dto.id, presentationId: pending.emitter.listPendingGates()[0]!.gate_id })).rejects.toThrow("Unknown gate presentation");
		const presentation = await ui.present(ref);
		expect(Object.keys(presentation).sort()).toEqual(["gate", "id"]);
		expect(presentation.gate.content.summary).toContain("[redacted]");
		await expect(f.call("gate.answer", { sessionId: f.first.dto.id, presentationId: presentation.id, answer: { kind: "json", json: '{"decision":"approve"}' } })).rejects.toThrow("not committed");
		await expect(f.call("gate.retired", { sessionId: f.first.dto.id, presentationId: presentation.id, nonce: "unsolicited" })).rejects.toThrow("No matching");
		await ui.commit(presentation);
		for (const answer of [{ kind: "json", json: "{" }, { kind: "json", json: '{"decision":"invented"}' }, { kind: "choice", choiceKey: "guessed-choice" }])
			await expect(f.call("gate.answer", { sessionId: f.first.dto.id, presentationId: presentation.id, answer })).rejects.toThrow();
		await flush();
		expect(pending.state).toMatchObject({ advanced: false, rejected: false });
		expect(other.state).toMatchObject({ advanced: false, rejected: false });
		expect(pending.emitter.listPendingGates()).toHaveLength(1);
		expect(JSON.stringify(f.frames)).not.toContain(secret);
	});

	test("every issued surface needs its exact owner retirement nonce; foreign, wrong, duplicate ACKs do not count", async () => {
		const f = await fixture();
		const second = await f.open();
		const pending = workflow(f.first.sdk);
		const other = workflow(second.sdk);
		const ui = new CommittedOwner(f, f.first.dto.id);
		const foreignUi = new CommittedOwner(f, second.dto.id);
		const ref = gateRef(await f.activity());
		const first = await ui.present(ref);
		const neverCommitted = await ui.present(ref);
		const foreign = await foreignUi.present(gateRef(await f.activity(second.dto.id)));
		await ui.commit(first);
		await foreignUi.commit(foreign);
		await expect(f.call("gate.answer", { sessionId: f.first.dto.id, presentationId: foreign.id, answer: { kind: "json", json: '{"decision":"approve"}' } })).rejects.toThrow("Unknown gate presentation");
		const answer = f.call("gate.answer", { sessionId: f.first.dto.id, presentationId: first.id, answer: { kind: "json", json: '{"decision":"approve"}' } });
		void answer.catch(() => undefined);
		const one = await ui.retirement(first.id);
		const two = await ui.retirement(neverCommitted.id);
		expect(one.nonce).not.toBe(two.nonce);
		await expect(f.call("gate.retired", { sessionId: second.dto.id, presentationId: first.id, nonce: one.nonce })).rejects.toThrow("Unknown gate presentation");
		await expect(f.call("gate.retired", { sessionId: f.first.dto.id, presentationId: first.id, nonce: two.nonce })).rejects.toThrow("No matching");
		await expect(f.call("gate.retired", { sessionId: f.first.dto.id, presentationId: neverCommitted.id, nonce: "guessed" })).rejects.toThrow("No matching");
		await ui.remove(one);
		await flush();
		expect(pending.state.advanced).toBe(false);
		expect(other.state.advanced).toBe(false);
		expect(pending.emitter.listWorkflowGateQueryRecords()[0]).toMatchObject({ tag: "accepted", post_accept_disposition: "accepted" });
		await expect(f.call("gate.retired", { sessionId: f.first.dto.id, presentationId: first.id, nonce: one.nonce })).rejects.toThrow("No matching");
		await ui.remove(two);
		expect(await answer).toEqual({ status: "accepted" });
		expect(await pending.promise).toEqual({ decision: "approve" });
		expect(pending.emitter.listWorkflowGateQueryRecords()[0]).toMatchObject({ tag: "accepted", post_accept_disposition: "advanced" });
		expect(other.state.advanced).toBe(false);
	});

	test.each(["approve", "decline"] as const)("withdrawal retires only the surface; reopening preserves the actual %s answer", async decision => {
		const f = await fixture();
		const pending = workflow(f.first.sdk, executionGate({ summary: "Withdraw without answering" }));
		const ui = new CommittedOwner(f, f.first.dto.id);
		const first = await ui.present(gateRef(await f.activity()));
		await ui.commit(first);
		let hidden = false;
		const withdrawing = f.call("gate.withdraw", { sessionId: f.first.dto.id, presentationId: first.id }).then(() => { hidden = true; });
		const retirement = await ui.retirement(first.id);
		await flush();
		expect(hidden).toBe(false);
		expect(pending.state.advanced).toBe(false);
		expect(ui.mounted.has(first.id)).toBe(true);
		await ui.remove(retirement);
		await withdrawing;
		expect(pending.emitter.listPendingGates()).toHaveLength(1);
		expect(pending.state.advanced).toBe(false);
		const next = await ui.present(gateRef(await f.activity()));
		expect(next.id).not.toBe(first.id);
		await ui.commit(next);
		const answering = f.call("gate.answer", { sessionId: f.first.dto.id, presentationId: next.id, answer: { kind: "json", json: JSON.stringify({ decision, reason: "Exact operator answer" }) } });
		await ui.remove(await ui.retirement(next.id));
		expect(await answering).toEqual({ status: "accepted" });
		expect(await pending.promise).toEqual({ decision, reason: "Exact operator answer" });
		expect(ui.mounted.size).toBe(0);
	});

	test("a retirement deadline rejects without manufacturing UI removal or workflow continuation", async () => {
		const f = await fixture();
		const pending = workflow(f.first.sdk);
		const ui = new CommittedOwner(f, f.first.dto.id);
		const presentation = await ui.present(gateRef(await f.activity()));
		await ui.commit(presentation);
		vi.useFakeTimers();
		try {
			const answering = f.call("gate.answer", { sessionId: f.first.dto.id, presentationId: presentation.id, answer: { kind: "json", json: '{"decision":"approve"}' } });
			void answering.catch(() => undefined);
			const retirement = await ui.retirement(presentation.id);
			vi.advanceTimersByTime(DESKTOP_GATE_PRESENTATION_LIMITS.retirementTimeoutMs + 1);
			await expect(answering).rejects.toThrow();
			expect(ui.mounted.has(presentation.id)).toBe(true);
			expect(pending.state.advanced).toBe(false);
			await expect(f.call("gate.retired", { sessionId: f.first.dto.id, presentationId: presentation.id, nonce: retirement.nonce })).rejects.toThrow("No matching");
		} finally { vi.useRealTimers(); }
	});

	test("connection replacement rejects old ACKs and refs without opening an unloaded session", async () => {
		const f = await fixture();
		const pending = workflow(f.first.sdk);
		const oldUpdate = await f.activity();
		const ui = new CommittedOwner(f, f.first.dto.id);
		const presentation = await ui.present(gateRef(oldUpdate));
		await ui.commit(presentation);
		const successor = await f.reconnect();
		expect(pending.state.advanced).toBe(false);
		const opened = f.captures.length;
		for (const method of ["gate.presented", "gate.retired"] as const)
			await expect(successor.call(method, { sessionId: f.first.dto.id, presentationId: presentation.id, nonce: "old-binding" })).rejects.toThrow("No owned gate presenter");
		expect(f.captures).toHaveLength(opened);
		await successor.call("session.select", { sessionId: f.first.dto.id });
		expect(f.captures).toHaveLength(opened + 1);
		await expect(successor.call("gate.present", { sessionId: f.first.dto.id, ref: gateRef(oldUpdate) })).rejects.toThrow("connection has changed");
		await expect(successor.call("gate.presented", { sessionId: f.first.dto.id, presentationId: presentation.id })).rejects.toThrow("Unknown gate presentation");
	});
});
