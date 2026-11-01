import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	type AssistantMessage,
	type Context,
	type CustomStreamSimpleFn,
	registerCustomApi,
	type SimpleStreamOptions,
	unregisterCustomApis,
} from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";
import { AsyncJobManager } from "@gajae-code/coding-agent/async";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { AgentRegistry } from "@gajae-code/coding-agent/registry/agent-registry";
import { btw, type CreateAgentSessionResult, createAgentSession, Settings } from "@gajae-code/coding-agent/sdk";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { createDesktopBtwController, type DesktopBtwController, type DesktopBtwOptions } from "../src/btw-controls";
import type { DesktopBtwConversation, DesktopBtwEvent, DesktopBtwTurn } from "../src/btw-protocol";
import { createDesktopStreamRedactor } from "../src/stream-redactor";

type Session = CreateAgentSessionResult["session"];
interface SideArgs {
	purpose: "btw";
	turn: btw.BtwTurnCapture;
	contextExchanges?: readonly btw.BtwTextExchange[];
	signal?: AbortSignal;
	onTextDelta?: (text: string) => void;
}
interface SideResult {
	replyText: string;
	assistantMessage: AssistantMessage;
}

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	const failures: unknown[] = [];
	while (cleanups.length) {
		try {
			await cleanups.pop()?.();
		} catch (error) {
			failures.push(error);
		}
	}
	if (failures.length) throw new AggregateError(failures, "BTW fixture cleanup failed");
});

function assistant(text = "", api = "desktop-btw-fixture"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api,
		provider: "desktop-btw-fixture",
		model: "fixture",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

function result(text: string): SideResult {
	return {
		replyText: text,
		assistantMessage: Object.assign(assistant(text), { fixtureAuthority: "RAW_ASSISTANT_AUTHORITY" }),
	};
}

function observe(options: Partial<DesktopBtwOptions> = {}) {
	const events: DesktopBtwEvent[] = [];
	const terminal = new Map<string, DesktopBtwTurn>();
	const waiters = new Map<string, PromiseWithResolvers<DesktopBtwTurn>>();
	return {
		events,
		options: {
			redact: (text: string) => text,
			...options,
			emit(event: DesktopBtwEvent) {
				events.push(structuredClone(event));
				for (const turn of event.conversation?.turns ?? []) {
					if (turn.status === "running" || turn.status === "cancel_requested") continue;
					terminal.set(turn.turnId, structuredClone(turn));
					waiters.get(turn.turnId)?.resolve(structuredClone(turn));
				}
				options.emit?.(event);
			},
		},
		wait(turnId: string): Promise<DesktopBtwTurn> {
			const existing = terminal.get(turnId);
			if (existing) return Promise.resolve(existing);
			const pending = Promise.withResolvers<DesktopBtwTurn>();
			waiters.set(turnId, pending);
			return pending.promise;
		},
	};
}

function last(dto: DesktopBtwConversation): DesktopBtwTurn {
	const turn = dto.turns.at(-1);
	if (!turn) throw new Error("Missing fixture turn");
	return turn;
}

function expectCode(action: () => unknown, code: string): void {
	expect(action).toThrow(expect.objectContaining({ name: "DesktopBtwError", code }));
}

async function flush(): Promise<void> {
	for (let i = 0; i < 30; i++) await Promise.resolve();
}

/** Narrow lifecycle/host-callback seam for invalid identities and deliberately hostile callbacks. */
function seam(options: Partial<DesktopBtwOptions> = {}) {
	const lifecycle = { generation: 7, transitioning: false, disposed: false };
	const transitions = new Set<() => void>();
	const disposals = new Set<() => void>();
	const calls: Array<{
		args: SideArgs;
		question: string;
		scope: btw.BtwConversationScope | undefined;
		context: readonly btw.BtwTextExchange[];
		completion: PromiseWithResolvers<SideResult>;
	}> = [];
	const capturedScope = { authority: "PRIVATE_SCOPE" } as unknown as btw.BtwConversationScope;
	const session = {
		get sessionLifecycle() {
			return { ...lifecycle };
		},
		sessionId: "private-session-id",
		sessionManager: { getSessionId: () => "private-manager-id" },
		isDisposed: false,
		prompt: vi.fn(() => {
			throw new Error("Must not use the main prompt");
		}),
		abort: vi.fn(() => {
			throw new Error("Must not abort the main turn");
		}),
		createBtwConversationScope: vi.fn((_instruction: string) => capturedScope),
		runEphemeralTurn: vi.fn((args: SideArgs) => {
			const completion = Promise.withResolvers<SideResult>();
			calls.push({
				args,
				question: args.turn.question,
				scope: args.turn.scope,
				context: structuredClone(args.contextExchanges ?? []),
				completion,
			});
			return completion.promise;
		}),
		registerToolSessionCleanup(cleanup: () => void) {
			disposals.add(cleanup);
			return () => {
				disposals.delete(cleanup);
			};
		},
		registerToolSessionTransitionCleanup(cleanup: () => void) {
			transitions.add(cleanup);
			return () => {
				transitions.delete(cleanup);
			};
		},
	};
	const observation = observe(options);
	const controller = createDesktopBtwController(session as unknown as Session, observation.options);
	cleanups.push(() => controller.dispose());
	return { ...observation, controller, session, lifecycle, transitions, disposals, calls, capturedScope };
}

interface ControlledCall {
	stream: AssistantMessageEventStream;
	message: AssistantMessage;
	context: Context;
	options: SimpleStreamOptions | undefined;
	close(): void;
}

async function factory(options: Partial<DesktopBtwOptions> = {}) {
	const priorManager = AsyncJobManager.instance();
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-btw-"));
	const api = `desktop-btw-${crypto.randomUUID()}`;
	const source = `source-${api}`;
	const calls: ControlledCall[] = [];
	const waiters = new Map<number, PromiseWithResolvers<ControlledCall>>();
	const mainWork: Promise<void>[] = [];
	const mainFailure = Promise.withResolvers<never>();
	void mainFailure.promise.catch(() => {});
	let closing = false;
	const model = createMockModel({ provider: "desktop-btw-fixture" });
	Object.defineProperty(model, "api", { value: api });
	const stream: CustomStreamSimpleFn = (_model, context, options) => {
		const events = new AssistantMessageEventStream();
		const message = assistant("", api);
		const close = () => {
			options?.signal?.removeEventListener("abort", close);
			if (!events.done) {
				message.stopReason = "aborted";
				events.push({
					type: "error",
					reason: "aborted",
					error: { ...message, errorMessage: "PRIVATE_PROVIDER_FAILURE" },
				});
			}
			// A terminal push alone need not release every outstanding next()/return() waiter.
			events.end(message);
		};
		const call: ControlledCall = { stream: events, message, context: structuredClone(context), options, close };
		calls.push(call);
		waiters.get(calls.length - 1)?.resolve(call);
		events.push({ type: "start", partial: message });
		options?.signal?.addEventListener("abort", close, { once: true });
		if (closing || options?.signal?.aborted) close();
		return events;
	};
	const auth = await AuthStorage.create(path.join(directory, "auth.db"));
	auth.setRuntimeApiKey(model.provider, "PRIVATE_API_CREDENTIAL");
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"retry.enabled": false,
		"bash.autoBackground.enabled": false,
	});
	const registry = new ModelRegistry(auth, path.join(directory, "models.yml"), settings, { agentDir: directory });
	const sessionManager = SessionManager.inMemory(directory);
	sessionManager.appendMessage({ role: "user", content: "visible frozen seed", timestamp: 1 });
	let created: CreateAgentSessionResult | undefined;
	cleanups.push(async () => {
		closing = true;
		for (const call of calls) call.close();
		const ownedManager = AsyncJobManager.forEndpoint(sessionManager.getSessionId());
		// Restore only our publication, before disposal can clear it or a sibling can replace it.
		if (ownedManager && AsyncJobManager.instance() === ownedManager) AsyncJobManager.setInstance(priorManager);
		try {
			try {
				await created?.session.dispose();
			} finally {
				// dispose() has a bounded public deadline; the retained owner must finish before registry teardown.
				try {
					await created?.session.awaitDisposeCompletion();
				} finally {
					await Promise.allSettled(mainWork);
				}
			}
		} finally {
			unregisterCustomApis(source);
			await registry.dispose();
			await settings.close();
			auth.close();
			await fs.rm(directory, { recursive: true, force: true });
		}
	});
	registerCustomApi(api, stream, source);
	created = await createAgentSession({
		cwd: directory,
		agentDir: directory,
		authStorage: auth,
		modelRegistry: registry,
		settings,
		sessionManager,
		model,
		systemPrompt: ["PRIVATE_SYSTEM_INSTRUCTION"],
		agentId: `btw-${crypto.randomUUID()}`,
		agentRegistry: new AgentRegistry(),
		disableExtensionDiscovery: true,
		extensions: [],
		toolNames: [],
		skills: [],
		rules: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		workspaceTree: { rootPath: directory, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
		enableMcpAutoload: false,
		enableLsp: false,
		skipPythonPreflight: true,
		deferOptionalModelRefresh: true,
		deferModelProfileActivation: true,
		notificationHostModeSupported: false,
		sdkHostModeSupported: false,
	});
	const session = created.session;
	const observation = observe(options);
	const controller = createDesktopBtwController(session, observation.options);
	cleanups.push(() => controller.dispose());
	return {
		...observation,
		controller,
		session,
		sessionManager,
		calls,
		prompt(text: string): Promise<void> {
			const work = session.prompt(text);
			mainWork.push(work);
			// Observe rejection at launch, not after waiting for a provider request that may never arrive.
			void work.catch(mainFailure.reject);
			return work;
		},
		request(index: number): Promise<ControlledCall> {
			const existing = calls[index];
			if (existing) return Promise.resolve(existing);
			const pending = Promise.withResolvers<ControlledCall>();
			waiters.set(index, pending);
			return Promise.race([pending.promise, mainFailure.promise]);
		},
	};
}

function delta(call: ControlledCall, text: string): void {
	const content = call.message.content[0];
	if (content?.type !== "text") throw new Error("Missing controlled text block");
	content.text += text;
	call.stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: call.message });
}

function finish(call: ControlledCall, text = ""): void {
	if (text) delta(call, text);
	call.stream.push({ type: "done", reason: "stop", message: call.message });
	call.close();
}

describe("desktop genuine BTW adapter", () => {
	test("real factory side turns freeze context, never change main history, and carry only successful private follow-ups", async () => {
		const f = await factory({ redact: text => text.replaceAll("raw-secret", "[masked]") });
		const prompt = vi.spyOn(f.session, "prompt");
		const abort = vi.spyOn(f.session, "abort");
		cleanups.push(() => {
			prompt.mockRestore();
			abort.mockRestore();
		});
		const mainBefore = structuredClone(f.session.agent.state.messages);
		const persistedBefore = structuredClone(f.sessionManager.getEntries());
		const first = f.controller.open({ question: "first raw-secret" });
		expect(last(first)).toMatchObject({ question: "first [masked]", status: "running", answer: "" });
		expect(f.events).toHaveLength(0);
		const call = await f.request(0);
		expect(call.context.tools).toEqual([]);
		expect(call.options).toMatchObject({ toolChoice: "none", requestMaxRetries: 0, streamMaxRetries: 0 });
		expect(call.options?.sessionId).toContain(":btw:");
		expect(call.context.systemPrompt).toContain(btw.instruction);
		expect(JSON.stringify(call.context.messages)).toContain("visible frozen seed");
		expect(JSON.stringify(call.context.messages)).toContain("first raw-secret");
		delta(call, "answer raw-");
		delta(call, "secret");
		await flush();
		expect(last(f.controller.get()!)).toMatchObject({ answer: "", status: "running" });
		finish(call);
		expect(await f.wait(last(first).turnId)).toMatchObject({ answer: "answer [masked]", status: "completed" });
		expect(f.session.agent.state.messages).toEqual(mainBefore);
		expect(f.sessionManager.getEntries()).toEqual(persistedBefore);

		f.sessionManager.appendMessage({ role: "user", content: "later main context must not enter BTW", timestamp: 2 });
		f.session.agent.setSystemPrompt(["REPLACEMENT_PRIVATE_SYSTEM"]);
		const historyBeforeFollowup = structuredClone(f.sessionManager.getEntries());
		const second = f.controller.submit({ conversationId: first.conversationId, question: "follow-up" });
		const followup = await f.request(1);
		const followupText = JSON.stringify(followup.context);
		expect(followupText).toContain("first raw-secret");
		expect(followupText).toContain("answer raw-secret");
		expect(followupText).not.toContain("later main context");
		expect(followupText).not.toContain("REPLACEMENT_PRIVATE_SYSTEM");
		expect(followup.options?.sessionId).toBe(call.options?.sessionId);
		finish(followup, "done");
		await f.wait(last(second).turnId);
		expect(f.sessionManager.getEntries()).toEqual(historyBeforeFollowup);
		expect(prompt).not.toHaveBeenCalled();
		expect(abort).not.toHaveBeenCalled();
		const serialized = JSON.stringify({ events: f.events, dto: f.controller.get() });
		for (const secret of [
			"PRIVATE_API_CREDENTIAL",
			"PRIVATE_SYSTEM_INSTRUCTION",
			"raw-secret",
			"assistantMessage",
			"credentialSessionId",
			"systemPrompt",
		])
			expect(serialized).not.toContain(secret);
	});

	test("real cancellation never aborts a concurrent main provider turn and cancelled text never becomes follow-up context", async () => {
		const f = await factory();
		const main = f.prompt("main question");
		const mainCall = await f.request(0);
		const mainAbort = vi.spyOn(f.session, "abort");
		cleanups.push(() => mainAbort.mockRestore());
		const first = f.controller.open({ question: "cancel this side question" });
		const side = await f.request(1);
		delta(side, "cancelled answer sentinel");
		const cancellation = f.controller.cancel({ conversationId: first.conversationId, turnId: last(first).turnId });
		expect(last(cancellation).status).toBe("cancel_requested");
		expect(side.options?.signal?.aborted).toBe(true);
		expect(mainCall.options?.signal?.aborted).toBe(false);
		expect((await f.wait(last(first).turnId)).status).toBe("cancelled");
		expect(mainCall.stream.done).toBe(false);
		expect(mainAbort).not.toHaveBeenCalled();
		const next = f.controller.submit({ conversationId: first.conversationId, question: "after cancellation" });
		const followup = await f.request(2);
		expect(JSON.stringify(followup.context)).not.toContain("cancel this side question");
		expect(JSON.stringify(followup.context)).not.toContain("cancelled answer sentinel");
		finish(followup, "side done");
		await f.wait(last(next).turnId);
		finish(mainCall, "main answer");
		await main;
		const history = JSON.stringify(f.sessionManager.getEntries());
		expect(history).toContain("main answer");
		expect(history).not.toContain("after cancellation");
	});

	test("streaming policy masks split secrets and final output, while published DTOs stay independent", async () => {
		const f = await factory({
			createStreamRedactor: () => createDesktopStreamRedactor(["split-secret"], text => text),
		});
		const admitted = f.controller.open({ question: "hello" });
		const call = await f.request(0);
		delta(call, "public prefix split-");
		await flush();
		expect(last(f.controller.get()!).answer).toBe("public pr");
		delta(call, "secret suffix");
		await flush();
		expect(JSON.stringify(f.events)).not.toContain("split-secret");
		finish(call);
		expect((await f.wait(last(admitted).turnId)).answer).toBe("public prefix [redacted] suffix");
		last(admitted).question = "client mutation";
		const read = f.controller.get()!;
		last(read).answer = "client mutation";
		expect(last(f.controller.get()!).question).toBe("hello");
		expect(last(f.controller.get()!).answer).toBe("public prefix [redacted] suffix");
	});

	test("strict inputs reject unknown, prototype, accessor, symbol and client-context fields without running them", () => {
		const f = seam();
		const getter = vi.fn(() => "PRIVATE_ACCESSOR");
		for (const value of [
			null,
			[],
			"hello",
			{},
			{ question: "" },
			{ question: "  " },
			{ question: "hello", contextExchanges: [] },
			{ question: "hello", scope: {} },
			Object.create({ question: "inherited" }),
			Object.defineProperty({}, "question", { get: getter }),
			{ question: "hello", [Symbol("hidden")]: "authority" },
			{ question: "hello", __proto__: { authority: true } },
			{ question: "\ud800" },
			{ question: "界".repeat(btw.BTW_MAX_QUESTION_UTF8_BYTES) },
			new Proxy(
				{},
				{
					ownKeys() {
						throw new Error("PRIVATE_PROXY_ERROR");
					},
				},
			),
		])
			expectCode(() => f.controller.open(value), "invalid_request");
		expect(getter).not.toHaveBeenCalled();
		expect(f.session.createBtwConversationScope).not.toHaveBeenCalled();
		expect(f.calls).toHaveLength(0);
		const current = f.controller.open({ question: "valid" });
		expectCode(
			() => f.controller.submit({ conversationId: current.conversationId, question: "next", messages: [] }),
			"invalid_request",
		);
		expectCode(
			() =>
				f.controller.cancel({ conversationId: current.conversationId, turnId: last(current).turnId, signal: true }),
			"invalid_request",
		);
		expectCode(() => f.controller.close({ conversationId: current.conversationId, scope: {} }), "invalid_request");
		expectCode(() => f.controller.close({ conversationId: "forged-id" }), "invalid_request");
		expectCode(() => f.controller.close({ conversationId: crypto.randomUUID() }), "not_found");
	});

	test("only one live turn is admitted, captures are private, and completion cannot rewrite the synchronous running receipt", async () => {
		const f = seam();
		const admitted = f.controller.open({ question: "raw question" });
		expectCode(() => f.controller.open({ question: "other" }), "control_busy");
		expectCode(
			() => f.controller.submit({ conversationId: admitted.conversationId, question: "other" }),
			"control_busy",
		);
		await flush();
		expect(f.session.createBtwConversationScope).toHaveBeenCalledWith(btw.instruction);
		expect(f.calls[0]?.scope).toBe(f.capturedScope);
		expect(f.calls[0]?.args.purpose).toBe("btw");
		f.calls[0]!.completion.resolve(result("answer"));
		await f.wait(last(admitted).turnId);
		expect(last(admitted)).toMatchObject({ status: "running", answer: "" });
		expect(last(f.controller.get()!)).toMatchObject({ status: "completed", answer: "answer" });
		expect(JSON.stringify(f.controller.get())).not.toContain("PRIVATE_SCOPE");
		expect(JSON.stringify(f.controller.get())).not.toContain("RAW_ASSISTANT_AUTHORITY");
		expect(f.session.prompt).not.toHaveBeenCalled();
	});

	test("close/reopen scrubs old captures and ignores late success and delta callbacks", async () => {
		const f = seam({ createStreamRedactor: () => ({ push: chunk => chunk, finish: () => "" }) });
		const first = f.controller.open({ question: "first private question" });
		await flush();
		const old = f.calls[0]!;
		f.controller.close({ conversationId: first.conversationId });
		expect(f.controller.get()).toBeNull();
		expect(old.args.signal?.aborted).toBe(true);
		expect(old.args.turn).toEqual({ question: "", scope: undefined });
		expect(f.events.at(-1)).toEqual({ conversation: null });
		const second = f.controller.open({ question: "replacement" });
		await flush();
		const eventCount = f.events.length;
		old.args.onTextDelta?.("LATE_SECRET");
		old.completion.resolve(result("LATE_FINAL_SECRET"));
		await flush();
		expect(f.events).toHaveLength(eventCount);
		expect(last(f.controller.get()!)).toMatchObject({ question: "replacement", status: "running", answer: "" });
		expectCode(
			() => f.controller.cancel({ conversationId: first.conversationId, turnId: last(first).turnId }),
			"not_found",
		);
		expectCode(
			() => f.controller.cancel({ conversationId: second.conversationId, turnId: last(first).turnId }),
			"not_found",
		);
		f.calls[1]!.completion.resolve(result("replacement answer"));
		await f.wait(last(second).turnId);
		expect(f.calls[1]!.context).toEqual([]);
	});

	test.each([
		"generation",
		"sessionId",
		"manager",
		"managerId",
		"disposed",
		"transition",
	] as const)("%s changes refuse control and suppress stale callbacks", async kind => {
		const f = seam({ createStreamRedactor: () => ({ push: chunk => chunk, finish: () => "" }) });
		const current = f.controller.open({ question: "old session" });
		await flush();
		if (kind === "generation") f.lifecycle.generation++;
		if (kind === "sessionId") f.session.sessionId = "replacement session";
		if (kind === "manager") f.session.sessionManager = { getSessionId: () => "private-manager-id" };
		if (kind === "managerId") f.session.sessionManager.getSessionId = () => "replacement manager";
		if (kind === "disposed") f.lifecycle.disposed = true;
		if (kind === "transition") f.lifecycle.transitioning = true;
		const count = f.events.length;
		const expected = kind === "disposed" ? "disposed" : kind === "transition" ? "control_busy" : "stale_session";
		expectCode(
			() => f.controller.submit({ conversationId: current.conversationId, question: "wrong owner" }),
			expected,
		);
		f.calls[0]!.args.onTextDelta?.("STALE_CALLBACK_SECRET");
		f.calls[0]!.completion.resolve(result("STALE_FINAL_SECRET"));
		await flush();
		expect(f.calls[0]!.args.signal?.aborted).toBe(true);
		expect(f.events.slice(count).every(event => event.conversation === null)).toBe(true);
		if (kind === "transition") {
			f.lifecycle.transitioning = false;
			expect(f.controller.get()).toBeNull();
		}
	});

	test("transition cleanup, cancellation before dispatch, and dispose scrub authority without a main abort", async () => {
		const f = seam();
		const first = f.controller.open({ question: "cancel before provider" });
		f.controller.cancel({ conversationId: first.conversationId, turnId: last(first).turnId });
		expect((await f.wait(last(first).turnId)).status).toBe("cancelled");
		expect(f.calls).toHaveLength(0);
		const second = f.controller.submit({ conversationId: first.conversationId, question: "transition me" });
		await flush();
		for (const cleanup of f.transitions) cleanup();
		expect(f.controller.get()).toBeNull();
		expect(f.calls[0]!.args.turn.scope).toBeUndefined();
		f.calls[0]!.completion.reject(new Error("PRIVATE_TEARDOWN_ERROR"));
		await flush();
		const third = f.controller.open({ question: "dispose me" });
		await flush();
		f.controller.dispose();
		f.controller.dispose();
		expect(f.transitions.size).toBe(0);
		expect(f.disposals.size).toBe(0);
		expect(f.calls[1]!.args.signal?.aborted).toBe(true);
		expectCode(() => f.controller.get(), "disposed");
		expectCode(() => f.controller.open({ question: "too late" }), "disposed");
		f.calls[1]!.completion.resolve(result("PRIVATE_LATE_DISPOSED"));
		await flush();
		expect(f.session.abort).not.toHaveBeenCalled();
		expect(JSON.stringify(f.events)).not.toContain("PRIVATE_TEARDOWN_ERROR");
		expect(last(second).status).toBe("running");
		expect(last(third).status).toBe("running");
	});

	test("canonical UTF-8 byte limits bound retained DTOs and successful follow-up context without splitting Unicode", async () => {
		const f = seam();
		const rawQuestion = "😀".repeat(btw.BTW_MAX_QUESTION_UTF8_BYTES / 4);
		let dto = f.controller.open({ question: rawQuestion });
		for (let index = 0; index < btw.BTW_MAX_CONTEXT_TURNS + 3; index++) {
			await flush();
			const call = f.calls[index]!;
			expect(call.context).toEqual(btw.boundBtwExchanges(call.context));
			call.completion.resolve(result("😀".repeat(btw.BTW_MAX_ANSWER_UTF8_BYTES / 4 + 1)));
			const turn = await f.wait(last(dto).turnId);
			expect(turn.answerTruncated).toBe(true);
			expect(btw.utf8ByteLength(turn.answer)).toBe(btw.BTW_MAX_ANSWER_UTF8_BYTES);
			expect(turn.answer.isWellFormed()).toBe(true);
			const retained = f.controller.get()!;
			expect(retained.turns.length).toBeLessThanOrEqual(btw.BTW_MAX_CONTEXT_TURNS);
			expect(
				retained.turns.reduce(
					(bytes, turn) => bytes + btw.utf8ByteLength(turn.question) + btw.utf8ByteLength(turn.answer),
					0,
				),
			).toBeLessThanOrEqual(btw.BTW_MAX_CONTEXT_UTF8_BYTES);
			if (index < btw.BTW_MAX_CONTEXT_TURNS + 2)
				dto = f.controller.submit({ conversationId: dto.conversationId, question: rawQuestion });
		}
		const small = seam();
		let smallDto = small.controller.open({ question: "small" });
		for (let index = 0; index < btw.BTW_MAX_CONTEXT_TURNS + 2; index++) {
			await flush();
			small.calls[index]!.completion.resolve(result("small answer"));
			await small.wait(last(smallDto).turnId);
			if (index <= btw.BTW_MAX_CONTEXT_TURNS)
				smallDto = small.controller.submit({ conversationId: smallDto.conversationId, question: "small" });
		}
		expect(small.controller.get()!.turns).toHaveLength(btw.BTW_MAX_CONTEXT_TURNS);
		expect(small.calls.at(-1)!.context).toHaveLength(btw.BTW_MAX_CONTEXT_TURNS);
	});

	test("redaction happens before UTF-8 truncation and streamed surrogate pairs remain intact", async () => {
		const f = seam({
			redact: text => (text === "expand" ? "界".repeat(btw.BTW_MAX_QUESTION_UTF8_BYTES) : text),
			createStreamRedactor: () => ({ push: text => text, finish: () => "" }),
		});
		const dto = f.controller.open({ question: "expand" });
		expect(btw.utf8ByteLength(last(dto).question)).toBeLessThanOrEqual(btw.BTW_MAX_QUESTION_UTF8_BYTES);
		await flush();
		f.calls[0]!.args.onTextDelta?.("\ud83d");
		expect(last(f.controller.get()!).answer).toBe("");
		f.calls[0]!.args.onTextDelta?.("\ude00");
		expect(last(f.controller.get()!).answer).toBe("😀");
		f.calls[0]!.completion.resolve(result("😀"));
		expect((await f.wait(last(dto).turnId)).answer).toBe("😀");
	});

	test.each([
		"throw",
		"invalid",
		"streamThrow",
		"streamInvalid",
		"finishThrow",
		"factoryThrow",
	] as const)("%s redaction failures fail closed with static errors and no follow-up exchange", async mode => {
		let fail = true;
		const f = seam({
			redact(text) {
				if (text === "PRIVATE_ANSWER" && fail && mode === "throw") throw new Error("PRIVATE_REDACTOR_ERROR");
				if (text === "PRIVATE_ANSWER" && fail && mode === "invalid") return undefined as unknown as string;
				return text;
			},
			...(mode.startsWith("stream") || mode === "finishThrow" || mode === "factoryThrow"
				? {
						createStreamRedactor() {
							if (fail && mode === "factoryThrow") throw new Error("PRIVATE_FACTORY_ERROR");
							return {
								push(text: string) {
									if (fail && mode === "streamThrow") throw new Error("PRIVATE_STREAM_ERROR");
									if (fail && mode === "streamInvalid") return {} as unknown as string;
									return text;
								},
								finish() {
									if (fail && mode === "finishThrow") throw new Error("PRIVATE_FINISH_ERROR");
									return "";
								},
							};
						},
					}
				: {}),
		});
		const dto = f.controller.open({ question: "safe question" });
		await flush();
		if (mode !== "factoryThrow") {
			f.calls[0]!.args.onTextDelta?.("PRIVATE_ANSWER");
			f.calls[0]!.completion.resolve(result("PRIVATE_ANSWER"));
		}
		const terminal = await f.wait(last(dto).turnId);
		expect(terminal).toMatchObject({ status: "failed", answer: "", error: { code: "redaction_failed" } });
		expect(JSON.stringify(terminal)).not.toContain("PRIVATE_");
		fail = false;
		const next = f.controller.submit({ conversationId: dto.conversationId, question: "next" });
		await flush();
		const call = f.calls.at(-1)!;
		expect(call.context).toEqual([]);
		call.completion.resolve(result("recovered"));
		await f.wait(last(next).turnId);
	});

	test("provider exceptions never disclose text, credentials or authority and failed requests are omitted from context", async () => {
		const f = seam();
		const dto = f.controller.open({ question: "failed question" });
		await flush();
		f.calls[0]!.completion.reject(new Error("PRIVATE_SYSTEM apiKey=PRIVATE_CREDENTIAL /private/provider-path"));
		const terminal = await f.wait(last(dto).turnId);
		expect(terminal).toMatchObject({ status: "failed", answer: "", error: { code: "backend_failure" } });
		expect(JSON.stringify(terminal)).not.toContain("PRIVATE_");
		terminal.error!.message = "client mutation";
		expect(last(f.controller.get()!).error!.message).not.toBe("client mutation");
		f.controller.submit({ conversationId: dto.conversationId, question: "next" });
		await flush();
		expect(f.calls[1]!.context).toEqual([]);
	});

	test("redactor and emitter reentry cannot admit nested work or publish after reentrant disposal", async () => {
		let controller: DesktopBtwController | undefined;
		const rejected: string[] = [];
		const emitterRejections: unknown[] = [];
		const f = seam({
			redact(text) {
				if (controller) {
					try {
						controller.open({ question: "nested secret" });
					} catch (error) {
						rejected.push(error instanceof Error ? error.message : "unexpected");
					}
				}
				return text;
			},
			emit(event) {
				if (!event.conversation) return;
				try {
					controller!.close({ conversationId: event.conversation.conversationId });
					emitterRejections.push(undefined);
				} catch (error) {
					emitterRejections.push(error);
				}
			},
		});
		controller = f.controller;
		const dto = controller.open({ question: "outer" });
		await flush();
		f.calls[0]!.completion.resolve(result("answer"));
		await f.wait(last(dto).turnId);
		expect(rejected).toHaveLength(2);
		expect(emitterRejections).toHaveLength(2);
		for (const error of emitterRejections)
			expect(error).toMatchObject({ name: "DesktopBtwError", code: "control_busy" });
		expect(f.calls).toHaveLength(1);
		const disposing = seam({
			redact(text) {
				if (text === "final") disposing.controller.dispose();
				return text;
			},
		});
		const pending = disposing.controller.open({ question: "outer" });
		await flush();
		disposing.calls[0]!.completion.resolve(result("final"));
		await flush();
		expect(disposing.events.at(-1)).toEqual({ conversation: null });
		expect(
			disposing.events.some(event =>
				event.conversation?.turns.some(turn => turn.turnId === last(pending).turnId && turn.status === "completed"),
			),
		).toBe(false);
		expectCode(() => disposing.controller.get(), "disposed");
	});
});
