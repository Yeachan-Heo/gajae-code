import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentMessage, type AgentTool } from "@gajae-code/agent-core";
import { z } from "@gajae-code/ai";
import { getBundledModel } from "@gajae-code/ai/models";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { loadExtensions } from "@gajae-code/coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@gajae-code/coding-agent/extensibility/extensions/runner";
import { initializeExtensions } from "@gajae-code/coding-agent/modes/runtime-init";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { operatorErrorMessage } from "@gajae-code/coding-agent/session/operator-error-message";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { getProjectAgentDir, TempDir } from "@gajae-code/utils";
import {
	ManagedAppendIdentityMismatchError,
	ManagedSessionDescendantStore,
} from "../src/session/internal/managed-session-storage";

type Script = "text" | "tool";

interface Harness {
	session: AgentSession;
	writerA: SessionManager;
	file: string;
	/** Second writer: a separate manager opened on the same managed transcript. */
	appendFromB(text: string): Promise<void>;
	setScript(script: Script): void;
	counts(): { modelCalls: number; toolRuns: number };
	onToolRun(hook: (() => Promise<void>) | undefined): void;
	/** Extension events emitted to the hook runner (only with `withHooks`). */
	hookEvents: string[];
	modelRegistry: ModelRegistry;
}

/**
 * A compaction hook that short-circuits the summary, so compaction needs no model,
 * and a `/r5-status` command that starts no turn and counts its runs.
 */
const COMPACTION_HOOK_SOURCE = [
	"export default function(pi) {",
	'\tpi.registerCommand("r5-status", { handler: async () => { globalThis.__r5StatusRuns = (globalThis.__r5StatusRuns ?? 0) + 1; } });',
	'\tpi.registerCommand("r5-trigger", { handler: async () => { pi.sendMessage({ customType: "r5", content: "triggered turn", display: false }, { triggerTurn: true }); } });',
	'\tpi.registerCommand("r5-compact", { handler: async (_args, ctx) => { await ctx.compact(); } });',
	'\tpi.on("before_agent_start", async () => { globalThis.__r5BeforeAgentStart = (globalThis.__r5BeforeAgentStart ?? 0) + 1; });',
	'\tpi.on("session_before_compact", async event => ({',
	"\t\tcompaction: {",
	'\t\t\tsummary: "hook summary",',
	"\t\t\tshortSummary: undefined,",
	"\t\t\tfirstKeptEntryId: event.preparation.firstKeptEntryId,",
	"\t\t\ttokensBefore: event.preparation.tokensBefore,",
	"\t\t\tdetails: {},",
	"\t\t},",
	"\t}));",
	"}",
].join("\n");

function describeMessage(role: string, content: unknown): string {
	if (typeof content === "string") return `${role}:${content}`;
	const first = (Array.isArray(content) ? content[0] : undefined) as
		| { type?: string; text?: string; name?: string }
		| undefined;
	return `${role}:${first?.type === "toolCall" ? `tool:${first.name}` : (first?.text ?? "")}`;
}

function transcriptMessages(text: string): string[] {
	return text
		.split("\n")
		.filter(line => line.length > 0)
		.flatMap(line => {
			const entry = JSON.parse(line) as { type: string; message?: { role: string; content: unknown } };
			return entry.type === "message" && entry.message
				? [describeMessage(entry.message.role, entry.message.content)]
				: [];
		});
}

function memoryMessages(messages: readonly AgentMessage[]): string[] {
	return messages.map(message => describeMessage(message.role, (message as { content?: unknown }).content));
}

async function settle<T>(promise: Promise<T>): Promise<unknown> {
	return await promise.then(
		() => undefined,
		(error: unknown) => error,
	);
}

describe("AgentSession on a transcript another process changed", () => {
	let tempDir: TempDir | undefined;
	const cleanups: Array<() => Promise<unknown> | unknown> = [];

	afterEach(async () => {
		vi.restoreAllMocks();
		// Counters the test extension writes; cleared here so a failed assertion cannot leak them.
		const extensionGlobals = globalThis as { __r5StatusRuns?: number; __r5BeforeAgentStart?: number };
		delete extensionGlobals.__r5StatusRuns;
		delete extensionGlobals.__r5BeforeAgentStart;
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
		tempDir?.removeSync();
		tempDir = undefined;
	});

	async function setup(options?: { withHooks?: boolean }): Promise<Harness> {
		tempDir = TempDir.createSync("@gjc-stuck-refusal-");
		const root = tempDir.path();
		const auth = await AuthStorage.create(path.join(root, "auth.db"));
		cleanups.push(() => auth.close());
		auth.setRuntimeApiKey("anthropic", "test-key");
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic model");
		let script: Script = "text";
		let modelCalls = 0;
		let toolRuns = 0;
		let toolHook: (() => Promise<void>) | undefined;
		const mock = createMockModel({
			id: model.id,
			provider: model.provider,
			handler: () =>
				script === "tool"
					? { content: [{ type: "toolCall", name: "probe", arguments: {} }] }
					: { content: [`reply ${modelCalls}`] },
		});
		const tool: AgentTool = {
			name: "probe",
			label: "Probe",
			description: "Probe",
			parameters: z.object({}),
			execute: async () => {
				toolRuns++;
				script = "text";
				await toolHook?.();
				return { content: [{ type: "text", text: "tool ok" }] };
			},
		};
		const agent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [tool], messages: [] },
			streamFn: (...args) => {
				modelCalls++;
				return mock.stream(...args);
			},
			getApiKey: () => "test-key",
		});
		const destination = () => SessionManager.managedDestination(root, path.join(root, "agent"));
		const writerA = SessionManager.create(root, destination());
		const settings = Settings.isolated({ "compaction.enabled": false, "compaction.keepRecentTokens": 10 });
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		const modelRegistry = new ModelRegistry(auth);
		const hookEvents: string[] = [];
		let extensionRunner: ExtensionRunner | undefined;
		if (options?.withHooks) {
			const extensionPath = path.join(getProjectAgentDir(root), "extensions", "compaction-hook.ts");
			await Bun.write(extensionPath, COMPACTION_HOOK_SOURCE);
			const loaded = await loadExtensions([extensionPath], root);
			extensionRunner = new ExtensionRunner(loaded.extensions, loaded.runtime, root, writerA, modelRegistry);
			const emit = extensionRunner.emit.bind(extensionRunner);
			vi.spyOn(extensionRunner, "emit").mockImplementation(async event => {
				hookEvents.push(event.type);
				return await emit(event);
			});
		}
		const session = new AgentSession({
			agent,
			sessionManager: writerA,
			settings,
			modelRegistry,
			...(extensionRunner ? { extensionRunner } : {}),
		});
		cleanups.push(() => session.dispose());
		await session.prompt("first");
		await writerA.flush();
		const file = writerA.getSessionFile();
		if (!file) throw new Error("Expected a persisted transcript");
		return {
			session,
			writerA,
			file,
			appendFromB: async text => {
				const writerB = await SessionManager.open(file, destination());
				cleanups.push(() => writerB.close());
				writerB.appendMessage({ role: "user", content: text, timestamp: Date.now() });
				await writerB.flush();
			},
			setScript: next => {
				script = next;
			},
			counts: () => ({ modelCalls, toolRuns }),
			onToolRun: hook => {
				toolHook = hook;
			},
			hookEvents,
			modelRegistry,
		};
	}

	/**
	 * Two writers on one managed session: B appends, then A prompts. A's first append
	 * hits the fence and latches it, before any model call or tool run.
	 */
	async function latch(harness: Harness): Promise<ManagedAppendIdentityMismatchError> {
		await harness.appendFromB("from B");
		harness.setScript("tool");
		const before = harness.counts();
		const refusal = await settle(harness.session.prompt("latches"));
		expect(refusal).toBeInstanceOf(ManagedAppendIdentityMismatchError);
		expect(operatorErrorMessage(refusal)).toBe((refusal as ManagedAppendIdentityMismatchError).operatorMessage);
		expect(harness.counts()).toEqual(before);
		harness.setScript("text");
		const latched = harness.writerA.getAppendIdentityMismatch();
		if (!latched) throw new Error("Expected the append fence to latch");
		return latched;
	}

	it("refuses a prompt on the stuck writer before the model or any tool runs", async () => {
		const harness = await setup();
		const latched = await latch(harness);
		harness.setScript("tool");
		const before = harness.counts();
		const transcriptBefore = await Bun.file(harness.file).text();
		const memoryBefore = memoryMessages(harness.session.messages);
		const events: string[] = [];
		const unsubscribe = harness.session.subscribe(event => events.push(event.type));

		const refusal = await settle(harness.session.prompt("run the probe tool"));
		unsubscribe();

		expect(refusal).toBe(latched);
		expect(operatorErrorMessage(refusal)).toContain("/resume");
		expect(operatorErrorMessage(refusal)).toContain("/fork");
		expect(harness.counts()).toEqual(before);
		expect(events).toEqual([]);
		expect(memoryMessages(harness.session.messages)).toEqual(memoryBefore);
		expect(await Bun.file(harness.file).text()).toBe(transcriptBefore);
	});

	it("refuses hidden custom-message turns, continuation and queued input instead of resolving silently", async () => {
		const harness = await setup();
		const latched = await latch(harness);
		const before = harness.counts();
		const memoryBefore = memoryMessages(harness.session.messages);

		expect(
			await settle(
				harness.session.promptCustomMessage({
					customType: "probe",
					content: "hidden turn",
					display: false,
					attribution: "agent",
				}),
			),
		).toBe(latched);
		expect(await settle(harness.session.continuePersistedHistory())).toBe(latched);
		expect(await settle(harness.session.followUp("queued follow-up"))).toBe(latched);
		expect(await settle(harness.session.steer("queued steer"))).toBe(latched);

		expect(harness.counts()).toEqual(before);
		expect(memoryMessages(harness.session.messages)).toEqual(memoryBefore);
	});

	it("reports a mid-turn peer write with the operator message and keeps the turn in memory", async () => {
		const harness = await setup();
		harness.setScript("tool");
		harness.onToolRun(async () => {
			harness.onToolRun(undefined);
			await harness.appendFromB("from B mid-turn");
		});

		const refusal = await settle(harness.session.prompt("use the tool"));

		expect(refusal).toBeInstanceOf(ManagedAppendIdentityMismatchError);
		expect(operatorErrorMessage(refusal)).toBe((refusal as ManagedAppendIdentityMismatchError).operatorMessage);
		expect(harness.counts().toolRuns).toBe(1);
		const memory = memoryMessages(harness.session.messages);
		expect(memory).toContain("user:use the tool");
		expect(memory).toContain("assistant:tool:probe");
		expect(memory).toContain("toolResult:tool ok");
		const transcript = transcriptMessages(await Bun.file(harness.file).text());
		expect(transcript).toContain("user:from B mid-turn");
		expect(transcript).not.toContain("toolResult:tool ok");
	});

	it("recovers after /resume of the same session and keeps both writers' entries", async () => {
		const harness = await setup();
		await latch(harness);

		expect(await harness.session.switchSession(harness.file)).toBe(true);
		expect(harness.session.sessionManager.getAppendIdentityMismatch()).toBeUndefined();
		const callsBefore = harness.counts().modelCalls;
		await harness.session.prompt("after resume");

		expect(harness.counts().modelCalls).toBe(callsBefore + 1);
		const transcript = transcriptMessages(await Bun.file(harness.file).text());
		expect(transcript.slice(0, 3)).toEqual(["user:first", "assistant:reply 1", "user:from B"]);
		expect(transcript).toContain("user:after resume");
		expect(transcript).not.toContain("user:latches");
	});

	it("recovers through /fork into a new session without touching the changed transcript", async () => {
		const harness = await setup();
		await latch(harness);
		const peerTranscript = await Bun.file(harness.file).text();
		const assistantReply = harness.writerA
			.getBranch()
			.find(entry => entry.type === "message" && entry.message.role === "assistant");
		const firstUser = harness.writerA
			.getBranch()
			.find(entry => entry.type === "message" && entry.message.role === "user");
		if (!assistantReply || !firstUser) throw new Error("Expected the first exchange");

		const forked = await harness.session.branch(firstUser.id);
		expect(forked.cancelled).toBe(false);
		const forkFile = harness.session.sessionManager.getSessionFile();
		if (!forkFile) throw new Error("Expected a fork transcript");
		expect(forkFile).not.toBe(harness.file);
		await harness.session.prompt("after fork");

		expect(await Bun.file(harness.file).text()).toBe(peerTranscript);
		expect(transcriptMessages(await Bun.file(forkFile).text())).toContain("user:after fork");
	});

	it("recovers through /new without touching the changed transcript", async () => {
		const harness = await setup();
		await latch(harness);
		const peerTranscript = await Bun.file(harness.file).text();

		expect(await harness.session.newSession()).toBe(true);
		await harness.session.prompt("after new");

		const newFile = harness.session.sessionManager.getSessionFile();
		if (!newFile) throw new Error("Expected a new transcript");
		expect(newFile).not.toBe(harness.file);
		expect(transcriptMessages(await Bun.file(newFile).text())).toContain("user:after new");
		expect(await Bun.file(harness.file).text()).toBe(peerTranscript);
	});

	it.each([
		"a malformed /resume target",
		"a failed /resume adoption",
		"a failed /new",
		"a failed /fork",
	])("leaves the stuck session as it was after %s, and a later /resume still recovers", async kind => {
		const harness = await setup();
		const latched = await latch(harness);
		const peerTranscript = await Bun.file(harness.file).text();
		let transition: Promise<unknown>;
		if (kind === "a malformed /resume target") {
			const malformed = path.join(path.dirname(harness.file), "2026-01-01T00-00-00-000Z_malformed.jsonl");
			await Bun.write(malformed, "not json\n");
			transition = harness.session.switchSession(malformed);
		} else if (kind === "a failed /resume adoption") {
			vi.spyOn(harness.writerA, "setSessionFile").mockRejectedValueOnce(new Error("adoption failed"));
			transition = harness.session.switchSession(harness.file);
		} else if (kind === "a failed /new") {
			vi.spyOn(harness.writerA, "prepareNewSession").mockRejectedValueOnce(new Error("prepare failed"));
			transition = harness.session.newSession();
		} else {
			vi.spyOn(harness.writerA, "prepareBranchedSession").mockRejectedValueOnce(new Error("branch failed"));
			const firstUser = harness.writerA
				.getBranch()
				.find(entry => entry.type === "message" && entry.message.role === "user");
			if (!firstUser) throw new Error("Expected the first user entry");
			transition = harness.session.branch(firstUser.id);
		}
		expect(await settle(transition)).toBeInstanceOf(Error);

		const before = harness.counts();
		expect(await settle(harness.session.prompt("still stuck"))).toBe(latched);
		expect(harness.counts()).toEqual(before);
		expect(harness.session.sessionManager.getSessionFile()).toBe(harness.file);
		expect(await Bun.file(harness.file).text()).toBe(peerTranscript);

		expect(await harness.session.switchSession(harness.file)).toBe(true);
		await harness.session.prompt("after resume");
		expect(transcriptMessages(await Bun.file(harness.file).text())).toContain("user:after resume");
	});

	it("refuses turns up front after any other latched write failure, without promising a recovery", async () => {
		const harness = await setup();
		const failure = new Error("uncertain write");
		const append = vi
			.spyOn(ManagedSessionDescendantStore.prototype, "appendExpectedIdentitySync")
			.mockImplementation(() => {
				throw failure;
			});
		expect(await settle(harness.session.prompt("write fails"))).toBeInstanceOf(Error);
		append.mockRestore();
		expect(harness.writerA.getLatchedPersistenceFailure()).toBe(failure);
		const before = harness.counts();
		const memoryBefore = memoryMessages(harness.session.messages);

		expect(await settle(harness.session.prompt("again"))).toBe(failure);
		expect(
			await settle(
				harness.session.promptCustomMessage({
					customType: "probe",
					content: "hidden turn",
					display: false,
					attribution: "agent",
				}),
			),
		).toBe(failure);
		expect(await settle(harness.session.continuePersistedHistory())).toBe(failure);
		expect(operatorErrorMessage(failure)).toBe("uncertain write");

		expect(harness.counts()).toEqual(before);
		expect(memoryMessages(harness.session.messages)).toEqual(memoryBefore);
		// Reload the transcript so disposal does not report the uncertain write.
		await harness.writerA.recoverPersistenceFailure();
		expect(harness.writerA.getLatchedPersistenceFailure()).toBeUndefined();
	});

	it("refuses /compact on a stuck session before any compaction hook or model call", async () => {
		const harness = await setup({ withHooks: true });
		// Enough history that compaction has a cut point and would reach its hook.
		for (const turn of ["second", "third", "fourth"]) await harness.session.prompt(`${turn} ${"x".repeat(400)}`);
		const latched = await latch(harness);
		const transcriptBefore = await Bun.file(harness.file).text();
		const apiKey = vi.spyOn(harness.modelRegistry, "getApiKey").mockResolvedValue(undefined);
		harness.hookEvents.length = 0;
		const before = harness.counts();

		const refusal = await settle(harness.session.compact());

		expect(refusal).toBe(latched);
		expect(operatorErrorMessage(refusal)).toContain("/resume");
		expect(harness.hookEvents.filter(type => type.includes("compact"))).toEqual([]);
		expect(apiKey).not.toHaveBeenCalled();
		expect(harness.counts()).toEqual(before);
		expect(await Bun.file(harness.file).text()).toBe(transcriptBefore);
	});

	it("refuses /handoff on a stuck session before any hook or handoff model call", async () => {
		const harness = await setup({ withHooks: true });
		const latched = await latch(harness);
		const transcriptBefore = await Bun.file(harness.file).text();
		// A handoff resolves the API key immediately before its generation call.
		const apiKey = vi.spyOn(harness.modelRegistry, "getApiKey").mockResolvedValue(undefined);
		harness.hookEvents.length = 0;

		const refusal = await settle(harness.session.handoff());

		expect(refusal).toBe(latched);
		expect(operatorErrorMessage(refusal)).toContain("/resume");
		expect(harness.hookEvents).toEqual([]);
		expect(apiKey).not.toHaveBeenCalled();
		expect(harness.session.sessionManager.getSessionFile()).toBe(harness.file);
		expect(await Bun.file(harness.file).text()).toBe(transcriptBefore);
	});

	it("refuses a stuck prompt before preflight acceptance is reported", async () => {
		const harness = await setup();
		const latched = await latch(harness);
		const onPreflightAccepted = vi.fn();
		const onRunAccepted = vi.fn();

		const refusal = await settle(harness.session.prompt("not accepted", { onPreflightAccepted, onRunAccepted }));

		expect(refusal).toBe(latched);
		expect(onPreflightAccepted).not.toHaveBeenCalled();
		expect(onRunAccepted).not.toHaveBeenCalled();
	});

	it("still runs an extension command that starts no turn on a stuck session", async () => {
		const harness = await setup({ withHooks: true });
		await latch(harness);
		const runs = globalThis as { __r5StatusRuns?: number };
		runs.__r5StatusRuns = 0;
		const before = harness.counts();

		await harness.session.prompt("/r5-status");

		expect(runs.__r5StatusRuns).toBe(1);
		expect(harness.counts()).toEqual(before);
	});

	it("refuses a skill on a stuck session before resolving it", async () => {
		const harness = await setup();
		const latched = await latch(harness);

		expect(await settle(harness.session.invokeSkill("no-such-skill"))).toBe(latched);
	});

	it("reports a mid-turn peer write from a custom-message turn instead of resolving", async () => {
		const harness = await setup();
		harness.setScript("tool");
		harness.onToolRun(async () => {
			harness.onToolRun(undefined);
			await harness.appendFromB("from B mid-turn");
		});

		const refusal = await settle(
			harness.session.promptCustomMessage({
				customType: "probe",
				content: "hidden turn",
				display: false,
				attribution: "agent",
			}),
		);

		expect(refusal).toBeInstanceOf(ManagedAppendIdentityMismatchError);
		expect(harness.counts().toolRuns).toBe(1);
		expect(memoryMessages(harness.session.messages)).toContain("toolResult:tool ok");
	});

	it("reports a mid-turn peer write from a continuation instead of resolving", async () => {
		const harness = await setup();
		harness.session.agent.appendMessage({ role: "user", content: "continue me", timestamp: Date.now() });
		harness.setScript("tool");
		harness.onToolRun(async () => {
			harness.onToolRun(undefined);
			await harness.appendFromB("from B mid-turn");
		});

		const refusal = await settle(harness.session.continuePersistedHistory());

		expect(refusal).toBeInstanceOf(ManagedAppendIdentityMismatchError);
		expect(harness.counts().toolRuns).toBe(1);
		expect(memoryMessages(harness.session.messages)).toContain("toolResult:tool ok");
	});

	it("refuses a context clear on a stuck session before resetting the agent", async () => {
		const harness = await setup();
		const latched = await latch(harness);
		const memoryBefore = memoryMessages(harness.session.messages);

		expect(await settle(harness.session.clearContext())).toBe(latched);

		expect(memoryMessages(harness.session.messages)).toEqual(memoryBefore);
	});

	it("refuses a turn an extension command triggers on a stuck session before before_agent_start", async () => {
		const harness = await setup({ withHooks: true });
		const sendErrors: Error[] = [];
		await initializeExtensions(harness.session, {
			reportSendError: (_action, error) => sendErrors.push(error),
			reportRuntimeError: () => {},
		});
		const latched = await latch(harness);
		const hooks = globalThis as { __r5BeforeAgentStart?: number };
		hooks.__r5BeforeAgentStart = 0;
		const before = harness.counts();
		const memoryBefore = memoryMessages(harness.session.messages);

		await harness.session.prompt("/r5-trigger");
		for (let attempt = 0; attempt < 200 && sendErrors.length === 0; attempt++) await Bun.sleep(5);

		expect(sendErrors).toEqual([latched]);
		expect(hooks.__r5BeforeAgentStart).toBe(0);
		expect(harness.counts()).toEqual(before);
		expect(memoryMessages(harness.session.messages)).toEqual(memoryBefore);
	});

	it("reports an extension command's stuck-session write failure with the operator message", async () => {
		const harness = await setup({ withHooks: true });
		const runtimeErrors: string[] = [];
		await initializeExtensions(harness.session, {
			reportSendError: () => {},
			reportRuntimeError: error => runtimeErrors.push(error.error),
		});
		const latched = await latch(harness);

		await harness.session.prompt("/r5-compact");

		expect(runtimeErrors).toEqual([latched.operatorMessage]);
	});

	it.each([
		["an idle trigger", undefined],
		["a next-turn trigger", "nextTurn"],
	] as const)("reports a mid-turn peer write from %s instead of resolving", async (_label, deliverAs) => {
		const harness = await setup();
		harness.setScript("tool");
		harness.onToolRun(async () => {
			harness.onToolRun(undefined);
			await harness.appendFromB("from B mid-turn");
		});

		const refusal = await settle(
			harness.session.sendCustomMessage(
				{ customType: "probe", content: "triggered turn", display: false },
				{ triggerTurn: true, ...(deliverAs ? { deliverAs } : {}) },
			),
		);

		expect(refusal).toBeInstanceOf(ManagedAppendIdentityMismatchError);
		expect(harness.counts().toolRuns).toBe(1);
		expect(memoryMessages(harness.session.messages)).toContain("toolResult:tool ok");
	});

	it("leaves a single writer's prompts, tool turns, /new and /resume unchanged", async () => {
		const harness = await setup();
		await harness.session.prompt("second");
		harness.setScript("tool");
		await harness.session.prompt("third");

		expect(harness.counts()).toEqual({ modelCalls: 4, toolRuns: 1 });
		expect(transcriptMessages(await Bun.file(harness.file).text())).toEqual([
			"user:first",
			"assistant:reply 1",
			"user:second",
			"assistant:reply 2",
			"user:third",
			"assistant:tool:probe",
			"toolResult:tool ok",
			"assistant:reply 4",
		]);
		expect(await harness.session.newSession()).toBe(true);
		expect(await harness.session.switchSession(harness.file)).toBe(true);
		await harness.session.prompt("after resume");
		expect(transcriptMessages(await Bun.file(harness.file).text()).slice(-2)).toEqual([
			"user:after resume",
			"assistant:reply 5",
		]);
	});
});

describe("SessionManager.flushBeforeLeaving", () => {
	let tempDir: TempDir | undefined;

	afterEach(() => {
		vi.restoreAllMocks();
		tempDir?.removeSync();
		tempDir = undefined;
	});

	async function persistedManager(): Promise<{ manager: SessionManager; root: string; file: string }> {
		tempDir = TempDir.createSync("@gjc-flush-before-leaving-");
		const root = tempDir.path();
		const manager = SessionManager.create(root, SessionManager.managedDestination(root, path.join(root, "agent")));
		manager.appendMessage({ role: "user", content: "original", timestamp: 1 });
		await manager.ensureOnDisk();
		const file = manager.getSessionFile();
		if (!file) throw new Error("Expected a persisted transcript");
		return { manager, root, file };
	}

	it("settles a latched identity mismatch that flush keeps rethrowing", async () => {
		const { manager, root, file } = await persistedManager();
		const writerB = await SessionManager.open(
			file,
			SessionManager.managedDestination(root, path.join(root, "agent")),
		);
		writerB.appendMessage({ role: "user", content: "from B", timestamp: 2 });
		await writerB.flush();
		await writerB.close();
		expect(() => manager.appendMessage({ role: "user", content: "refused", timestamp: 3 })).toThrow(
			ManagedAppendIdentityMismatchError,
		);

		await expect(manager.flush()).rejects.toBeInstanceOf(ManagedAppendIdentityMismatchError);
		await expect(manager.flushBeforeLeaving()).resolves.toBeUndefined();
		expect(await manager.closeStrict()).toEqual({ kind: "closed" });
	});

	it("still throws any other latched persistence failure", async () => {
		const { manager } = await persistedManager();
		const failure = new Error("uncertain write");
		const append = vi
			.spyOn(ManagedSessionDescendantStore.prototype, "appendExpectedIdentitySync")
			.mockImplementation(() => {
				throw failure;
			});
		expect(() => manager.appendMessage({ role: "user", content: "lost?", timestamp: 2 })).toThrow(failure);
		append.mockRestore();

		await expect(manager.flushBeforeLeaving()).rejects.toBe(failure);
		await manager.closeStrict();
	});
});
