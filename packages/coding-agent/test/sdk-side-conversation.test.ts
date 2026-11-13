import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import * as compactionModule from "@gajae-code/agent-core/compaction";
import {
	type AssistantMessage,
	type Context,
	type CustomStreamSimpleFn,
	Effort,
	type Model,
	registerCustomApi,
	type SimpleStreamOptions,
	unregisterCustomApis,
} from "@gajae-code/ai";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";
import { registerOAuthProvider, unregisterOAuthProviders } from "@gajae-code/ai/utils/oauth";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import {
	SIDE_CONVERSATION_MAX_DELTA_CHARS,
	SIDE_CONVERSATION_MAX_DELTA_CHUNKS,
	SideConversationControls,
	type SideConversationSnapshot,
} from "../src/sdk/side-conversation";
import { AgentSession, type EphemeralTurnArgs } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { BTW_MAX_ANSWER_UTF8_BYTES, BTW_MAX_CONTEXT_TURNS } from "../src/session/btw-contract";
import { SessionManager } from "../src/session/session-manager";

const model: Model = {
	id: "test",
	name: "test",
	provider: "test",
	api: "anthropic-messages",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8192,
	maxTokens: 1024,
};
const CONTROLLED_API = "sdk-side-stream-test";
const CONTROLLED_SOURCE = "sdk-side-conversation-test";
const cleanup: Array<() => Promise<void>> = [];
const backendCleanup: Array<() => void> = [];
afterEach(async () => {
	vi.useRealTimers();
	for (const release of backendCleanup.splice(0)) release();
	await settle();
	vi.restoreAllMocks();
	for (const fn of cleanup.splice(0)) await fn();
	unregisterCustomApis(CONTROLLED_SOURCE);
	unregisterOAuthProviders(CONTROLLED_SOURCE);
});
async function fixture(activeModel: Model = model) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "sdk-side-"));
	const auth = await AuthStorage.create(path.join(root, "auth.db"));
	const registry = new ModelRegistry(auth, path.join(root, "models.yml"));
	const session = new AgentSession({
		agent: new Agent({ initialState: { model: activeModel, tools: [], systemPrompt: ["Test"] } }),
		sessionManager: SessionManager.inMemory(root),
		settings: Settings.isolated(),
		modelRegistry: registry,
		thinkingLevel: Effort.Low,
	});
	const controls = new SideConversationControls(session);
	cleanup.push(async () => {
		controls.dispose();
		await session.dispose();
		auth.close();
		await fs.rm(root, { recursive: true, force: true });
	});
	return { session, controls, registry, auth };
}
function snapshot(value: unknown): SideConversationSnapshot {
	return value as SideConversationSnapshot;
}
function captureError(action: () => unknown): unknown {
	try {
		action();
	} catch (error) {
		return error;
	}
	throw new Error("Expected a side conversation error.");
}
async function settle() {
	for (let i = 0; i < 50; i++) await Promise.resolve();
}
function assistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: CONTROLLED_API,
		provider: model.provider,
		model: model.id,
		stopReason: "stop",
		timestamp: 0,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}
interface TestReply {
	replyText: string;
	assistantMessage: AssistantMessage;
}
function reply(text: string): TestReply {
	return { replyText: text, assistantMessage: assistant(text) };
}
interface ControlledCall {
	context: Context;
	stream: AssistantMessageEventStream;
	message: AssistantMessage;
	options: SimpleStreamOptions | undefined;
}
function controlledBackend(returnError?: Error) {
	const started = Promise.withResolvers<ControlledCall>();
	const returning = Promise.withResolvers<void>();
	const releaseReturn = Promise.withResolvers<void>();
	const calls: ControlledCall[] = [];
	const waiting = new Map<number, PromiseWithResolvers<ControlledCall>>();
	const streamFn: CustomStreamSimpleFn = (_model, context, options) => {
		const stream = new AssistantMessageEventStream();
		const message = assistant("");
		const index = calls.length;
		const createIterator = stream[Symbol.asyncIterator].bind(stream);
		stream[Symbol.asyncIterator] = () => {
			const iterator = createIterator();
			return {
				next: () => iterator.next(),
				return: async () => {
					returning.resolve();
					await releaseReturn.promise;
					await iterator.return?.();
					if (index === 0 && returnError) throw returnError;
					return { done: true as const, value: undefined };
				},
			};
		};
		const call = { context: structuredClone(context), stream, message, options };
		calls.push(call);
		waiting.get(calls.length - 1)?.resolve(call);
		stream.push({ type: "start", partial: message });
		started.resolve(call);
		// Deliberately ignore abort: next() and return() remain independently owned.
		return stream;
	};
	registerCustomApi(CONTROLLED_API, streamFn, CONTROLLED_SOURCE);
	backendCleanup.push(() => {
		releaseReturn.resolve();
		for (const call of calls) call.stream.end(call.message);
	});
	return {
		model: { ...model, api: CONTROLLED_API },
		started: started.promise,
		returning: returning.promise,
		releaseReturn,
		calls,
		callAt(index: number): Promise<ControlledCall> {
			const call = calls[index];
			if (call) return Promise.resolve(call);
			let pending = waiting.get(index);
			if (!pending) {
				pending = Promise.withResolvers<ControlledCall>();
				waiting.set(index, pending);
			}
			return pending.promise;
		},
	};
}
function emit(call: ControlledCall, text: string): void {
	call.stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: call.message });
}
function finish(call: ControlledCall): void {
	call.stream.push({ type: "done", reason: "stop", message: call.message });
	call.stream.end(call.message);
}

describe("SDK frozen-context side conversations", () => {
	it("settles side output and history while main-stream auto-compaction holds its summary", async () => {
		const backend = controlledBackend();
		backend.releaseReturn.resolve();
		const activeModel = { ...backend.model, contextWindow: 200_000, maxTokens: 32_768 };
		const { session, controls, registry, auth } = await fixture(activeModel);
		// Maintenance resolves credential row ownership independently of getApiKey.
		auth.setRuntimeApiKey(activeModel.provider, "test-key");
		vi.spyOn(registry, "getApiKey").mockResolvedValue("test-key");
		vi.spyOn(registry, "getAvailable").mockReturnValue([activeModel]);
		// Admit the held main provider before enabling threshold maintenance.
		session.settings.override("compaction.enabled", false);
		session.settings.override("compaction.strategy", "context-full");
		session.settings.override("compaction.thresholdTokens", 100_000);
		session.settings.override("compaction.keepRecentTokens", 1);
		session.settings.override("compaction.autoContinue", false);
		session.settings.override("contextPromotion.enabled", false);
		session.settings.override("todo.reminders", false);
		for (let index = 0; index < 4; index++) {
			session.sessionManager.appendMessage({
				role: "user",
				content: `earlier request ${index}`,
				timestamp: index * 2,
			});
			const message = assistant(`earlier response ${index}`);
			message.usage.input = index === 3 ? 100_001 : 1_000;
			message.usage.totalTokens = message.usage.input;
			message.timestamp = index * 2 + 1;
			session.sessionManager.appendMessage(message);
		}
		session.agent.replaceMessages(session.sessionManager.buildSessionContext().messages);
		const summaryEntered = Promise.withResolvers<void>();
		const releaseSummary = Promise.withResolvers<void>();
		backendCleanup.push(() => releaseSummary.resolve());
		vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => {
			summaryEntered.resolve();
			await releaseSummary.promise;
			return {
				summary: "maintenance summary",
				shortSummary: undefined,
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: preparation.tokensBefore,
				details: {},
			};
		});
		const main = session.prompt("main request");
		const mainCall = await Promise.race([
			backend.started,
			main.then(() => {
				throw new Error("Main run ended before provider admission.");
			}),
		]);
		expect(session.isStreaming).toBe(true);
		const run = vi.spyOn(session, "runEphemeralTurn");
		const opened = snapshot(controls.control("btw.open", { question: "side during main" }));
		const sideCall = await backend.callAt(1);
		const identity = session.sessionManager.getSessionIdentityGeneration();
		const generation = session.sessionLifecycle.generation;
		session.settings.override("compaction.enabled", true);
		expect(session.estimateMidRunContextTokensForTests(session.messages)).toBeGreaterThan(100_000);
		const maintenance = session.runMidRunMaintenanceForTests({
			systemPrompt: session.state.systemPrompt,
			messages: session.messages,
			tools: [],
		});
		await Promise.race([
			summaryEntered.promise,
			maintenance.then(outcome => {
				throw new Error(`Compaction ended before its summary barrier: ${outcome}.`);
			}),
		]);
		expect(session.sessionLifecycle.transitioning).toBe(true);
		emit(sideCall, "finished during maintenance\n");
		finish(sideCall);
		await run.mock.results[0]!.value;
		await session.joinBtwTurnsForControl();
		await settle();
		expect(
			captureError(() => controls.control("btw.submit", { conversationId: opened.id, question: "new ingress" })),
		).toMatchObject({ code: "busy" });
		releaseSummary.resolve();
		expect(await maintenance).toBe("compacted");
		expect(session.sessionManager.getSessionIdentityGeneration()).toBe(identity);
		expect(session.sessionLifecycle.generation).toBe(generation);
		const completed = snapshot(controls.control("btw.read", { conversationId: opened.id }));
		expect(completed.turns[0]).toMatchObject({
			status: "completed",
			cleanup: "settled",
			answer: "finished during maintenance",
		});
		expect(completed.deltas.map(delta => delta.text).join("")).toBe("finished during maintenance\n");
		controls.control("btw.submit", { conversationId: opened.id, question: "continue side" });
		const next = await backend.callAt(2);
		const nextArgs = run.mock.calls[1]?.[0];
		if (nextArgs?.purpose !== "btw") throw new Error("Expected an admitted side turn.");
		expect(nextArgs.contextExchanges).toEqual([
			{ question: "side during main", answer: "finished during maintenance" },
		]);
		emit(next, "continued");
		finish(next);
		await run.mock.results[1]!.value;
		await settle();
		session.settings.override("compaction.enabled", false);
		mainCall.message.content = [{ type: "text", text: "main completed" }];
		finish(mainCall);
		await main;
		expect(session.messages.some(message => message.role === "user" && message.content === "side during main")).toBe(
			false,
		);
	});

	it.each([
		false,
		true,
	])("retains native return rejection poison across retries and controllers (cancel=%s)", async cancelled => {
		const providerSecret = "private-provider-return-failure";
		const backend = controlledBackend(new Error(providerSecret));
		backend.releaseReturn.resolve();
		const { session, controls, registry } = await fixture(backend.model);
		vi.spyOn(registry, "getApiKey").mockResolvedValue("test-key");
		const run = vi.spyOn(session, "runEphemeralTurn");
		const opened = snapshot(controls.control("btw.open", { question: "uncertain side" }));
		const call = await backend.started;
		emit(call, "safe record\n");
		await settle();
		if (cancelled) controls.control("btw.cancel", { conversationId: opened.id, turnId: opened.turns[0]!.id });
		finish(call);
		await expect(run.mock.results[0]!.value).rejects.toMatchObject({ code: "unknown_effect" });
		await expect(session.joinBtwTurnsForControl()).rejects.toMatchObject({ code: "unknown_effect" });
		await settle();
		const uncertain = snapshot(controls.control("btw.read", { conversationId: opened.id }));
		expect(uncertain.turns[0]).toMatchObject({
			status: "unknown_effect",
			cleanup: "unknown_effect",
			answer: "safe record\n",
		});
		expect(JSON.stringify(uncertain)).not.toContain(providerSecret);
		expect(
			captureError(() => controls.control("btw.submit", { conversationId: opened.id, question: "retry" })),
		).toMatchObject({ code: "unknown_effect" });
		expect(
			captureError(() => controls.control("btw.cancel", { conversationId: opened.id, turnId: opened.turns[0]!.id })),
		).toMatchObject({ code: "resource_gone" });
		const original = run.mock.calls[0]![0];
		await expect(session.runEphemeralTurn({ ...original, signal: undefined })).rejects.toMatchObject({
			code: "unknown_effect",
		});
		const identity = session.sessionManager.getSessionIdentityGeneration();
		await session.runIdleCompaction();
		expect(session.sessionManager.getSessionIdentityGeneration()).toBe(identity);
		await expect(session.joinBtwTurnsForControl()).rejects.toMatchObject({ code: "unknown_effect" });
		controls.dispose();
		const replacement = new SideConversationControls(session);
		cleanup.push(async () => replacement.dispose());
		expect(captureError(() => replacement.control("btw.open", {}))).toMatchObject({ code: "unknown_effect" });
		expect(backend.calls).toHaveLength(1);
		// Failed cleanup is not permission to force newSession through its barrier.
		await expect(session.newSession()).rejects.toMatchObject({ code: "unknown_effect" });
		expect(session.sessionManager.getSessionIdentityGeneration()).toBe(identity);
		// A real native identity adoption retires the old poison; no controller reset does.
		await session.sessionManager.newSession();
		await session.joinBtwTurnsForControl();
		const successor = new SideConversationControls(session);
		cleanup.push(async () => successor.dispose());
		const reopened = snapshot(successor.control("btw.open", { question: "successor question" }));
		const next = await backend.callAt(1);
		expect(JSON.stringify(next.context)).not.toContain("uncertain side");
		original.onTextDelta?.("retired callback");
		if (original.purpose !== "btw") throw new Error("Expected a side turn");
		expect(captureError(() => original.onProviderCredential?.("retired-derived-key"))).toMatchObject({
			code: "stale_session",
		});
		expect(snapshot(successor.control("btw.read", { conversationId: reopened.id }))).toEqual(reopened);
		emit(next, "successor answer");
		finish(next);
		await run.mock.results.at(-1)!.value;
		await settle();
		expect(snapshot(successor.control("btw.read", { conversationId: reopened.id })).turns[0]).toMatchObject({
			status: "completed",
			cleanup: "settled",
			answer: "successor answer",
		});
		expect(session.messages).toEqual([]);
	});

	it("redacts native questions, results and public history without changing frozen provider context", async () => {
		const backend = controlledBackend();
		backend.releaseReturn.resolve();
		const { session, controls, registry, auth } = await fixture(backend.model);
		const first = "stored-primary-private-credential";
		const second = "stored-secondary-private-credential";
		const access = "stored-private-oauth-access";
		const refresh = "stored-private-oauth-refresh";
		const token = "stored-structured-private-token";
		await auth.set("test", [
			{ type: "api_key", key: first },
			{ type: "api_key", key: second },
		]);
		await auth.set("oauth-test", { type: "oauth", access, refresh, expires: Date.now() + 100_000 });
		await auth.set("structured-test", { type: "api_key", key: JSON.stringify({ token }) });
		const getAll = vi.spyOn(auth, "getAll");
		const resolve = vi.spyOn(registry, "getApiKey").mockResolvedValue("native-test-key");
		const run = vi.spyOn(session, "runEphemeralTurn");
		const privatePath = "/Users/private/.ssh/id_ed25519";
		session.sessionManager.appendMessage({ role: "user", content: `frozen ${first}`, timestamp: 0 });
		const opened = snapshot(controls.control("btw.open", {}));
		expect(getAll).toHaveBeenCalledTimes(1);
		expect(resolve).not.toHaveBeenCalled();
		const question = `Explain ${first} ${second} ${access} ${refresh} ${token} ${privatePath}`;
		const accepted = snapshot(controls.control("btw.submit", { conversationId: opened.id, question }));
		for (const secret of [first, second, access, refresh, token, privatePath])
			expect(JSON.stringify(accepted)).not.toContain(secret);
		const call = await backend.started;
		expect(JSON.stringify(call.context)).toContain(`frozen ${first}`);
		expect(JSON.stringify(call.context)).toContain(question);
		expect(JSON.stringify(call.context)).not.toContain("«redacted");
		// Stored credentials may change, but this conversation's original snapshot stays protective.
		await auth.set("test", { type: "api_key", key: "replacement-private-credential" });
		const prefix = first.slice(0, 14);
		emit(call, `public record\n${prefix}`);
		await settle();
		getAll.mockClear();
		resolve.mockClear();
		const partial = snapshot(controls.control("btw.read", { conversationId: opened.id, cursor: opened.nextCursor }));
		expect(JSON.stringify(partial)).not.toContain(prefix);
		expect(getAll).not.toHaveBeenCalled();
		expect(resolve).not.toHaveBeenCalled();
		const answer = `public record\n${first} ${second} ${access} ${refresh} ${token} ${privatePath}\n`;
		emit(call, answer.slice(`public record\n${prefix}`.length));
		finish(call);
		await run.mock.results[0]!.value;
		await settle();
		const completed = snapshot(controls.control("btw.read", { conversationId: opened.id }));
		expect(completed.turns[0]?.status).toBe("completed");
		expect(completed.turns[0]?.answer).toContain("public record");
		for (const secret of [first, second, access, refresh, token, privatePath])
			expect(JSON.stringify(completed)).not.toContain(secret);
		controls.control("btw.submit", { conversationId: opened.id, question: "continue" });
		const next = await backend.callAt(1);
		for (const secret of [first, second, access, refresh, token, privatePath])
			expect(JSON.stringify(next.context)).toContain(secret);
		expect(JSON.stringify(next.context)).not.toContain("«redacted");
		getAll.mockClear();
		resolve.mockClear();
		const observed = snapshot(controls.control("btw.read", { conversationId: opened.id }));
		for (const secret of [first, second, access, refresh, token, privatePath])
			expect(JSON.stringify(observed)).not.toContain(secret);
		expect(getAll).not.toHaveBeenCalled();
		expect(resolve).not.toHaveBeenCalled();
		emit(next, "continued");
		finish(next);
		await run.mock.results[1]!.value;
		await settle();
		expect(session.messages).toEqual([]);
	});

	it("redacts credentials rotated after scope capture before admitting a side question", async () => {
		const backend = controlledBackend();
		backend.releaseReturn.resolve();
		const { session, controls, auth, registry } = await fixture(backend.model);
		const previous = "first-side-value-7q";
		const current = "later-side-value-9r";
		const latest = "third-side-value-2s";
		const getAll = vi.spyOn(auth, "getAll");
		const resolve = vi.spyOn(registry, "getApiKey");
		await auth.set("test", { type: "api_key", key: previous });
		session.sessionManager.appendMessage({ role: "user", content: `frozen ${previous}`, timestamp: 0 });
		const opened = snapshot(controls.control("btw.open", {}));
		expect(resolve).not.toHaveBeenCalled();
		await auth.set("test", { type: "api_key", key: current });
		const run = vi.spyOn(session, "runEphemeralTurn");
		const question = `Explain ${current} and ${previous}`;
		const accepted = snapshot(controls.control("btw.submit", { conversationId: opened.id, question }));
		const call = await backend.started;
		expect(call.options?.apiKey).toBe(current);
		expect(JSON.stringify(call.context)).toContain(`frozen ${previous}`);
		expect(JSON.stringify(call.context)).toContain(question);
		for (const value of [previous, current]) expect(JSON.stringify(accepted)).not.toContain(value);
		expect(accepted.turns[0]?.question).toBe("Explain «redacted» and «redacted»");
		const firstAnswer = `${previous} ${current}\nend`;
		emit(call, previous.slice(0, 12));
		await settle();
		const partial = snapshot(controls.control("btw.read", { conversationId: opened.id }));
		expect(JSON.stringify(partial)).not.toContain(previous.slice(0, 12));
		emit(call, `${previous.slice(12)} ${current.slice(0, 12)}`);
		await settle();
		const split = snapshot(controls.control("btw.read", { conversationId: opened.id }));
		expect(JSON.stringify(split)).not.toContain(current.slice(0, 12));
		emit(call, `${current.slice(12)}\nend`);
		finish(call);
		await run.mock.results[0]!.value;
		await settle();
		const completed = snapshot(controls.control("btw.read", { conversationId: opened.id }));
		expect(completed.turns[0]?.status).toBe("completed");
		for (const value of [previous, current]) expect(JSON.stringify(completed)).not.toContain(value);
		expect(completed.turns[0]?.answer).toBe("«redacted» «redacted»\nend");
		expect(completed.deltas.map(delta => delta.text).join("")).toBe(completed.turns[0]?.answer);

		await auth.set("test", { type: "api_key", key: latest });
		const nextQuestion = `Recall ${previous} ${current} ${latest}`;
		const nextAccepted = snapshot(
			controls.control("btw.submit", { conversationId: opened.id, question: nextQuestion }),
		);
		const next = await backend.callAt(1);
		expect(next.options?.apiKey).toBe(latest);
		for (const raw of [`frozen ${previous}`, question, firstAnswer, nextQuestion])
			expect(JSON.stringify(next.context)).toContain(JSON.stringify(raw).slice(1, -1));
		expect(JSON.stringify(next.context)).not.toContain("«redacted");
		expect(nextAccepted.turns[1]?.question).toBe("Recall «redacted» «redacted» «redacted»");
		for (const value of [previous, current, latest]) {
			emit(next, value.slice(0, 12));
			await settle();
			const fragment = snapshot(
				controls.control("btw.read", { conversationId: opened.id, cursor: completed.nextCursor }),
			);
			expect(JSON.stringify(fragment)).not.toContain(value.slice(0, 12));
			emit(next, `${value.slice(12)}\n`);
		}
		emit(next, "end");
		finish(next);
		await run.mock.results[1]!.value;
		await settle();
		getAll.mockImplementation(() => {
			throw new Error("read must not consult credential storage");
		});
		resolve.mockClear();
		getAll.mockClear();
		const history = snapshot(controls.control("btw.read", { conversationId: opened.id }));
		for (const value of [previous, current, latest]) expect(JSON.stringify(history)).not.toContain(value);
		expect(history.turns.map(turn => turn.status)).toEqual(["completed", "completed"]);
		expect(history.turns[1]?.answer).toBe("«redacted»\n«redacted»\n«redacted»\nend");
		expect(getAll).not.toHaveBeenCalled();
		expect(resolve).not.toHaveBeenCalled();
		getAll.mockRestore();
		expect(session.messages).toEqual([]);
	});

	it.each([
		"access",
		"derived",
		"structured",
		"final-only",
	] as const)("redacts actual OAuth credentials refreshed by native provider admission (%s)", async mode => {
		const backend = controlledBackend();
		backend.releaseReturn.resolve();
		const { session, controls, auth } = await fixture(backend.model);
		const previous = "expired-side-value-5t";
		const current = "refreshed-side-value-4u";
		const token = `derived-${"long-private-value-".repeat(12)}9z`;
		const actualKey =
			mode === "structured"
				? JSON.stringify({ token, projectId: "public-project" })
				: mode === "derived"
					? token
					: current;
		let refreshes = 0;
		let resolutions = 0;
		registerOAuthProvider({
			id: "test",
			name: "Side refresh fixture",
			sourceId: CONTROLLED_SOURCE,
			async login() {
				throw new Error("Unexpected interactive login");
			},
			async refreshToken(credentials) {
				refreshes++;
				expect(credentials.access).toBe(previous);
				return { ...credentials, access: current, expires: Date.now() + 3_600_000 };
			},
			getApiKey: credentials => {
				resolutions++;
				expect(credentials.access).toBe(current);
				return actualKey;
			},
		});
		await auth.set("test", {
			type: "oauth",
			access: previous,
			refresh: "side-refresh-value-8r",
			expires: Date.now() - 60_000,
		});
		const run = vi.spyOn(session, "runEphemeralTurn");
		const opened = snapshot(controls.control("btw.open", { question: "Explain refresh" }));
		const call = await backend.started;
		expect(refreshes).toBe(1);
		expect(call.options?.apiKey).toBe(actualKey);
		expect(auth.get("test")).toMatchObject({ access: current });
		if (mode === "derived" || mode === "structured") expect(JSON.stringify(auth.getAll())).not.toContain(token);
		const echoed = mode === "structured" ? `${actualKey}\n${token}\nvisible` : `${actualKey}\nvisible`;
		if (mode === "final-only") call.message.content = [{ type: "text", text: echoed }];
		else {
			const prefix = actualKey.slice(0, mode === "derived" || mode === "structured" ? 100 : 12);
			emit(call, prefix);
			await settle();
			const partial = snapshot(controls.control("btw.read", { conversationId: opened.id }));
			expect(JSON.stringify(partial)).not.toContain(prefix);
			emit(call, echoed.slice(prefix.length));
		}
		finish(call);
		await run.mock.results[0]!.value;
		await settle();
		const completed = snapshot(controls.control("btw.read", { conversationId: opened.id }));
		expect(completed.turns[0]?.status).toBe("completed");
		for (const secret of [previous, current, actualKey, ...(mode === "structured" ? [token] : [])])
			expect(JSON.stringify(completed)).not.toContain(secret);
		expect(completed.turns[0]?.answer).toBe(
			mode === "structured" ? "«redacted»\n«redacted»\nvisible" : "«redacted»\nvisible",
		);
		expect(completed.deltas.map(delta => delta.text).join("")).toBe(completed.turns[0]?.answer);
		expect(refreshes).toBe(1);
		expect(resolutions).toBe(1);
		// A later admission cannot discard the non-stored key from private history.
		unregisterOAuthProviders(CONTROLLED_SOURCE);
		await auth.set("test", { type: "api_key", key: "next-native-key-6w" });
		controls.control("btw.submit", { conversationId: opened.id, question: "Follow up" });
		const next = await backend.callAt(1);
		expect(next.options?.apiKey).toBe("next-native-key-6w");
		expect(JSON.stringify(next.context)).toContain(JSON.stringify(echoed).slice(1, -1));
		emit(next, `${actualKey}\nnext-native-key-6w\nsafe`);
		finish(next);
		await run.mock.results[1]!.value;
		await settle();
		const getAll = vi.spyOn(auth, "getAll");
		const resolve = vi.spyOn(session.modelRegistry, "getApiKey");
		const history = snapshot(controls.control("btw.read", { conversationId: opened.id }));
		expect(JSON.stringify(history)).not.toContain(actualKey);
		expect(JSON.stringify(history)).not.toContain("next-native-key-6w");
		expect(history.turns[1]?.answer).toBe("«redacted»\n«redacted»\nsafe");
		expect(getAll).not.toHaveBeenCalled();
		expect(resolve).not.toHaveBeenCalled();
		expect(session.messages).toEqual([]);
	});

	it.each([
		"open",
		"submit",
	] as const)("fails closed on a fresh stored-secret snapshot failure before %s admission", async operation => {
		const backend = controlledBackend();
		backend.releaseReturn.resolve();
		const { session, controls, auth, registry } = await fixture(backend.model);
		const key = "snapshot-failure-real-provider-key";
		await auth.set("test", { type: "api_key", key });
		const run = vi.spyOn(session, "runEphemeralTurn");
		const scope = vi.spyOn(session, "createBtwConversationScope");
		const resolve = vi.spyOn(registry, "getApiKey");
		const opened = operation === "submit" ? snapshot(controls.control("btw.open", {})) : undefined;
		const getAll = vi.spyOn(auth, "getAll").mockImplementation(() => {
			throw new Error(`storage failure ${key}`);
		});
		const input = opened ? { conversationId: opened.id, question: key } : { question: key };
		const failure = captureError(() => controls.control(opened ? "btw.submit" : "btw.open", input));
		expect(failure).toMatchObject({
			code: "redaction_failed",
			message: "Side conversation redaction failed; output was withheld.",
		});
		expect(run).not.toHaveBeenCalled();
		expect(resolve).not.toHaveBeenCalled();
		expect(backend.calls).toHaveLength(0);
		expect(scope).toHaveBeenCalledTimes(opened ? 1 : 0);
		if (opened) expect(controls.control("btw.read", { conversationId: opened.id })).toEqual(opened);
		getAll.mockRestore();
		const admitted = snapshot(controls.control(opened ? "btw.submit" : "btw.open", input));
		expect(admitted.turns[0]?.question).toBe("«redacted»");
		const call = await backend.started;
		expect(call.options?.apiKey).toBe(key);
		emit(call, "safe retry");
		finish(call);
		await run.mock.results[0]!.value;
		await settle();
		expect(snapshot(controls.control("btw.read", { conversationId: admitted.id })).turns[0]).toMatchObject({
			status: "completed",
			answer: "safe retry",
			cleanup: "settled",
		});
	});

	it("retains only safe native deltas and recovers expired cursors without revealing split credentials", async () => {
		const backend = controlledBackend();
		backend.releaseReturn.resolve();
		const { session, controls, registry, auth } = await fixture(backend.model);
		const secret = "retained-native-private-credential";
		await auth.set("test", { type: "api_key", key: secret });
		vi.spyOn(registry, "getApiKey").mockResolvedValue("native-test-key");
		const run = vi.spyOn(session, "runEphemeralTurn");
		const opened = snapshot(controls.control("btw.open", { question: `check ${secret}` }));
		const call = await backend.started;
		emit(call, secret.slice(0, 15));
		await settle();
		const hidden = snapshot(controls.control("btw.read", { conversationId: opened.id, cursor: opened.nextCursor }));
		expect(hidden.turns[0]?.answer).toBe("");
		expect(hidden.deltas).toEqual([]);
		expect(hidden.nextCursor).toBe(opened.nextCursor);
		emit(call, `${secret.slice(15)}\n`);
		for (let index = 0; index < SIDE_CONVERSATION_MAX_DELTA_CHUNKS + 8; index++) {
			emit(call, `record ${index} ${secret}\n${"f".repeat(secret.length)}\n`);
			await settle();
		}
		expect(() => controls.control("btw.read", { conversationId: opened.id, cursor: opened.nextCursor })).toThrow(
			"expired",
		);
		const recovered = snapshot(controls.control("btw.read", { conversationId: opened.id }));
		expect(recovered.deltasTruncated).toBe(true);
		expect(recovered.deltas).toHaveLength(SIDE_CONVERSATION_MAX_DELTA_CHUNKS);
		expect(JSON.stringify(recovered)).not.toContain(secret.slice(0, 15));
		expect(recovered.turns[0]?.answer).toContain("«redacted»");
		const resumed = snapshot(
			controls.control("btw.read", { conversationId: opened.id, cursor: recovered.deltas[0]!.cursor }),
		);
		expect(resumed.deltas).toEqual(recovered.deltas.slice(1));
		finish(call);
		await run.mock.results[0]!.value;
		await settle();
		const final = snapshot(controls.control("btw.read", { conversationId: opened.id, cursor: recovered.nextCursor }));
		expect(final.turns[0]?.status).toBe("completed");
		expect(final.deltas.length).toBeGreaterThan(0);
		expect(JSON.stringify(final)).not.toContain(secret.slice(0, 15));
		expect(final.turns[0]?.answer).toContain(`record ${SIDE_CONVERSATION_MAX_DELTA_CHUNKS + 7}`);
	});

	it("withholds split generic credentials, multiline private keys and sensitive paths until safely redacted", async () => {
		const backend = controlledBackend();
		backend.releaseReturn.resolve();
		const { session, controls, registry } = await fixture(backend.model);
		vi.spyOn(registry, "getApiKey").mockResolvedValue("native-test-key");
		const run = vi.spyOn(session, "runEphemeralTurn");
		const opened = snapshot(controls.control("btw.open", { question: "inspect /private/.env.production" }));
		const call = await backend.started;
		for (const chunk of [
			"Bearer unregistered-",
			"private-bearer\n/private/.",
			"env.production\n-----BEGIN PRIVATE KEY-----\n",
			"UNREGISTERED_PRIVATE_KEY_BODY\n-----END PRIVATE KEY-----\npassword: |\n",
			"  UNREGISTERED_YAML_PASSWORD\nnormal: visible\n",
		]) {
			emit(call, chunk);
			await settle();
			const projected = JSON.stringify(controls.control("btw.read", { conversationId: opened.id }));
			for (const privateText of ["unregistered-", "/private/.", "UNREGISTERED_PRIVATE", "UNREGISTERED_YAML"])
				expect(projected).not.toContain(privateText);
		}
		finish(call);
		await run.mock.results[0]!.value;
		await settle();
		const completed = snapshot(controls.control("btw.read", { conversationId: opened.id }));
		expect(completed.turns[0]?.status).toBe("completed");
		expect(completed.turns[0]?.answer).toContain("normal: visible");
		for (const privateText of ["unregistered-", "/private/.", "UNREGISTERED_PRIVATE", "UNREGISTERED_YAML"])
			expect(JSON.stringify(completed)).not.toContain(privateText);
	});

	it.each([
		{ secret: "CUTOFF_PRIVATE_CREDENTIAL", reserve: 8, fragment: "CUTOFF_P", marker: "«redact" },
		{ secret: "𐀀𐀀𐀀PRIVATE_CREDENTIAL", reserve: 9, fragment: "𐀀𐀀", marker: "«redacte" },
	])("masks native credential suffixes cut off with $reserve bytes reserved", async ({
		secret,
		reserve,
		fragment,
		marker,
	}) => {
		const backend = controlledBackend();
		backend.releaseReturn.resolve();
		const { session, controls, registry, auth } = await fixture(backend.model);
		await auth.set("test", { type: "api_key", key: secret });
		vi.spyOn(registry, "getApiKey").mockResolvedValue("native-test-key");
		const run = vi.spyOn(session, "runEphemeralTurn");
		const opened = snapshot(controls.control("btw.open", { question: "large result" }));
		const call = await backend.started;
		emit(call, "a".repeat(BTW_MAX_ANSWER_UTF8_BYTES - reserve) + secret);
		finish(call);
		await run.mock.results[0]!.value;
		await settle();
		const completed = snapshot(controls.control("btw.read", { conversationId: opened.id }));
		expect(completed.turns[0]?.status).toBe("completed");
		expect(completed.turns[0]?.answer).toBe("a".repeat(BTW_MAX_ANSWER_UTF8_BYTES - reserve) + marker);
		expect(JSON.stringify(completed)).not.toContain(fragment);
		expect(Buffer.byteLength(completed.turns[0]!.answer)).toBe(BTW_MAX_ANSWER_UTF8_BYTES);
	});

	it("withholds native provider errors and interrupted credential prefixes without retaining failed model history", async () => {
		const backend = controlledBackend();
		backend.releaseReturn.resolve();
		const { session, controls, registry, auth } = await fixture(backend.model);
		const secret = "failed-native-private-credential";
		await auth.set("test", { type: "api_key", key: secret });
		vi.spyOn(registry, "getApiKey").mockResolvedValue("native-test-key");
		const run = vi.spyOn(session, "runEphemeralTurn");
		const opened = snapshot(controls.control("btw.open", { question: `failed question ${secret}` }));
		const call = await backend.started;
		emit(call, secret.slice(0, 14));
		const error = { ...assistant(""), stopReason: "error" as const, errorMessage: secret };
		call.stream.push({ type: "error", reason: "error", error });
		call.stream.end(error);
		await expect(run.mock.results[0]!.value).rejects.toBeInstanceOf(Error);
		await settle();
		const failed = snapshot(controls.control("btw.read", { conversationId: opened.id }));
		expect(failed.turns[0]).toMatchObject({ status: "failed", answer: "«redacted»" });
		expect(JSON.stringify(failed)).not.toContain(secret.slice(0, 14));
		controls.control("btw.submit", { conversationId: opened.id, question: "after failure" });
		const next = await backend.callAt(1);
		expect(JSON.stringify(next.context)).not.toContain("failed question");
		expect(JSON.stringify(next.context)).not.toContain(secret);
		emit(next, "recovered");
		finish(next);
		await run.mock.results[1]!.value;
		await settle();
	});

	it("redacts full service results before truncating and masks overlapping stored literals as a union", async () => {
		const { session, controls, auth } = await fixture();
		const longSecret = `long-private-${"z".repeat(BTW_MAX_ANSWER_UTF8_BYTES)}`;
		await auth.set("test", [
			{ type: "api_key", key: longSecret },
			{ type: "api_key", key: "overlap-private-abc" },
			{ type: "api_key", key: "private-abcdef" },
		]);
		vi.spyOn(session, "runEphemeralTurn").mockImplementation(async args => {
			const text = `lead ${longSecret} overlap-private-abcdef tail`;
			args.onTextDelta?.(text);
			return reply(text);
		});
		const opened = snapshot(controls.control("btw.open", { question: "large private result" }));
		await settle();
		const completed = snapshot(controls.control("btw.read", { conversationId: opened.id }));
		expect(completed.turns[0]?.answer).toBe("lead «redacted» «redacted» tail");
		expect(completed.deltas.map(delta => delta.text).join("")).toBe(completed.turns[0]?.answer);
	});

	it("captures scope once, streams safe per-turn records and retains only completed side history", async () => {
		const { session, controls } = await fixture();
		const scope = vi.spyOn(session, "createBtwConversationScope");
		const pending = Promise.withResolvers<TestReply>();
		backendCleanup.push(() => pending.resolve(reply("answer")));
		let args: EphemeralTurnArgs | undefined;
		const run = vi.spyOn(session, "runEphemeralTurn").mockImplementation(input => {
			args = input;
			return pending.promise;
		});
		const opened = snapshot(controls.control("btw.open", {}));
		const accepted = snapshot(controls.control("btw.submit", { conversationId: opened.id, question: "why?" }));
		expect(accepted.turns[0]?.status).toBe("running");
		args?.onTextDelta?.("part\n");
		args?.onTextDelta?.("ial\n");
		const streamed = snapshot(controls.control("btw.read", { conversationId: opened.id, cursor: opened.nextCursor }));
		expect(streamed.turns[0]?.answer).toBe("part\nial\n");
		expect(streamed.deltas.map(delta => [delta.turnId, delta.text])).toEqual([
			[accepted.turns[0]!.id, "part\n"],
			[accepted.turns[0]!.id, "ial\n"],
		]);
		expect(streamed.deltasTruncated).toBe(false);
		expect(
			snapshot(controls.control("btw.read", { conversationId: opened.id, cursor: streamed.nextCursor })).deltas,
		).toEqual([]);
		expect(() => controls.control("btw.submit", { conversationId: opened.id, question: "busy" })).toThrow(
			"still running",
		);
		pending.resolve(reply("answer"));
		await settle();
		run.mockImplementationOnce(input => {
			input.onTextDelta?.("second");
			return Promise.resolve(reply("second"));
		});
		const next = snapshot(controls.control("btw.submit", { conversationId: opened.id, question: "more?" }));
		await settle();
		expect(scope).toHaveBeenCalledTimes(1);
		expect(run.mock.calls[1]?.[0]).toMatchObject({
			purpose: "btw",
			contextExchanges: [{ question: "why?", answer: "answer" }],
		});
		const result = snapshot(controls.control("btw.read", { conversationId: opened.id, cursor: streamed.nextCursor }));
		expect(result.turns.map(turn => turn.status)).toEqual(["completed", "completed"]);
		expect(result.deltas).toEqual([{ turnId: next.turns[1]!.id, text: "second", cursor: result.nextCursor }]);
		result.turns[0]!.answer = "tamper";
		result.deltas[0]!.text = "tamper";
		const untampered = snapshot(controls.control("btw.read", { conversationId: opened.id }));
		expect(untampered.turns[0]?.answer).toBe("answer");
		expect(untampered.deltas.at(-1)?.text).toBe("second");
		expect(session.messages).toEqual([]);
	});

	it("bounds retained chunk count, rejects expired/malformed cursors and recovers without a cursor", async () => {
		const { session, controls } = await fixture();
		const pending = Promise.withResolvers<TestReply>();
		backendCleanup.push(() => pending.resolve(reply("done")));
		let args: EphemeralTurnArgs | undefined;
		vi.spyOn(session, "runEphemeralTurn").mockImplementation(input => {
			args = input;
			return pending.promise;
		});
		const opened = snapshot(controls.control("btw.open", { question: "chunks" }));
		const count = SIDE_CONVERSATION_MAX_DELTA_CHUNKS + 5;
		for (let i = 0; i < count; i++) args?.onTextDelta?.("x\n");
		expect(
			captureError(() => controls.control("btw.read", { conversationId: opened.id, cursor: opened.nextCursor })),
		).toMatchObject({
			code: "resource_gone",
			message: expect.stringContaining("omit cursor"),
		});
		const recovered = snapshot(controls.control("btw.read", { conversationId: opened.id }));
		expect(recovered.turns[0]?.answer).toBe("x\n".repeat(count));
		expect(recovered.deltas).toHaveLength(SIDE_CONVERSATION_MAX_DELTA_CHUNKS);
		expect(recovered.deltasTruncated).toBe(true);
		expect(new Set(recovered.deltas.map(delta => delta.cursor)).size).toBe(SIDE_CONVERSATION_MAX_DELTA_CHUNKS);
		expect(recovered.deltas.every(delta => delta.turnId === opened.turns[0]!.id)).toBe(true);
		const resumed = snapshot(
			controls.control("btw.read", { conversationId: opened.id, cursor: recovered.deltas[0]!.cursor }),
		);
		expect(resumed.deltas).toEqual(recovered.deltas.slice(1));
		expect(resumed.deltasTruncated).toBe(false);
		for (const cursor of [
			null,
			0,
			"",
			"bad",
			`${opened.id}:01`,
			`${opened.id}:-1`,
			`${opened.id}:1.5`,
			`${opened.id}:9007199254740992`,
		]) {
			expect(captureError(() => controls.control("btw.read", { conversationId: opened.id, cursor }))).toMatchObject({
				code: "invalid_input",
			});
		}
		expect(() =>
			controls.control("btw.read", { conversationId: opened.id, cursor: `${opened.id}:${count + 1}` }),
		).toThrow("ahead");
		const other = await fixture();
		const foreign = snapshot(other.controls.control("btw.open", {}));
		expect(
			captureError(() => controls.control("btw.read", { conversationId: opened.id, cursor: foreign.nextCursor })),
		).toMatchObject({
			code: "resource_gone",
			message: expect.stringContaining("another conversation"),
		});
		expect(() => controls.control("btw.read", { conversationId: `${opened.id} ` })).toThrow("no longer available");
		expect(session.messages).toEqual([]);
	});

	it("bounds retained delta characters independently of snapshots and bounds UTF-8 answers", async () => {
		const { session, controls } = await fixture();
		const text = "x".repeat(Math.floor(SIDE_CONVERSATION_MAX_DELTA_CHARS / 2) + 1);
		const run = vi.spyOn(session, "runEphemeralTurn").mockImplementation(async args => {
			args.onTextDelta?.(text);
			return reply(text);
		});
		const opened = snapshot(controls.control("btw.open", { question: "first" }));
		await settle();
		const first = snapshot(controls.control("btw.read", { conversationId: opened.id }));
		controls.control("btw.submit", { conversationId: opened.id, question: "second" });
		await settle();
		const second = snapshot(controls.control("btw.read", { conversationId: opened.id }));
		expect(second.turns.map(turn => turn.answer)).toEqual([text, text]);
		expect(second.deltas).toHaveLength(1);
		expect(second.deltas[0]?.turnId).toBe(second.turns[1]?.id);
		expect(second.deltas.reduce((sum, delta) => sum + delta.text.length, 0)).toBeLessThanOrEqual(
			SIDE_CONVERSATION_MAX_DELTA_CHARS,
		);
		expect(second.deltasTruncated).toBe(true);
		expect(
			snapshot(controls.control("btw.read", { conversationId: opened.id, cursor: first.nextCursor })).deltas,
		).toEqual(second.deltas);
		controls.control("btw.close", { conversationId: opened.id });
		const unicode = "𐐀".repeat(BTW_MAX_ANSWER_UTF8_BYTES);
		run.mockImplementation(async args => {
			args.onTextDelta?.(unicode);
			args.onTextDelta?.("overflow");
			return reply(unicode);
		});
		const unicodeOpened = snapshot(controls.control("btw.open", { question: "unicode" }));
		await settle();
		const bounded = snapshot(controls.control("btw.read", { conversationId: unicodeOpened.id }));
		expect(bounded.turns[0]?.answer).toBe("𐐀".repeat(BTW_MAX_ANSWER_UTF8_BYTES / 4));
		expect(bounded.turns[0]?.answer.isWellFormed()).toBe(true);
		expect(bounded.deltas.map(delta => delta.text).join("")).toBe(bounded.turns[0]?.answer);
		expect(bounded.deltas).toHaveLength(1);
		expect(session.messages).toEqual([]);
	});

	it("evicts deltas with bounded turn history without exposing a removed turn", async () => {
		const { session, controls } = await fixture();
		vi.spyOn(session, "runEphemeralTurn").mockImplementation(async args => {
			args.onTextDelta?.("answer");
			return reply("answer");
		});
		const opened = snapshot(controls.control("btw.open", {}));
		const started = snapshot(controls.control("btw.submit", { conversationId: opened.id, question: "first" }));
		await settle();
		for (let i = 0; i < BTW_MAX_CONTEXT_TURNS; i++) {
			controls.control("btw.submit", { conversationId: opened.id, question: `question ${i}` });
			await settle();
		}
		const result = snapshot(controls.control("btw.read", { conversationId: opened.id }));
		expect(result.turns).toHaveLength(BTW_MAX_CONTEXT_TURNS);
		expect(result.turns.some(turn => turn.id === started.turns[0]?.id)).toBe(false);
		expect(result.deltas.every(delta => result.turns.some(turn => turn.id === delta.turnId))).toBe(true);
		expect(result.deltasTruncated).toBe(true);
		expect(() => controls.control("btw.read", { conversationId: opened.id, cursor: opened.nextCursor })).toThrow(
			"expired",
		);
	});

	it("cancels exact turns, holds admission until public settlement and rejects cross-session refs", async () => {
		const { session, controls } = await fixture();
		const other = await fixture();
		const pending = Promise.withResolvers<TestReply>();
		backendCleanup.push(() => pending.resolve(reply("late")));
		let args: EphemeralTurnArgs | undefined;
		vi.spyOn(session, "runEphemeralTurn").mockImplementation(input => {
			args = input;
			return pending.promise;
		});
		const opened = snapshot(controls.control("btw.open", { question: "wait" }));
		const turnId = opened.turns[0]!.id;
		expect(() => controls.control("btw.cancel", { conversationId: opened.id, turnId: `${turnId} ` })).toThrow(
			"not running",
		);
		expect(args?.signal?.aborted).toBe(false);
		expect(() => other.controls.control("btw.read", { conversationId: opened.id })).toThrow("no longer available");
		args?.onTextDelta?.("before cancel");
		controls.control("btw.cancel", { conversationId: opened.id, turnId });
		expect(args?.signal?.aborted).toBe(true);
		args?.onTextDelta?.("must not appear");
		expect(() => controls.control("btw.submit", { conversationId: opened.id, question: "still busy" })).toThrow(
			"still running",
		);
		pending.reject(new Error("provider-secret"));
		await settle();
		const result = snapshot(controls.control("btw.read", { conversationId: opened.id }));
		expect(result.turns[0]).toMatchObject({ status: "cancelled", answer: "before cancel" });
		expect(result.deltas.map(delta => delta.text)).toEqual(["before cancel"]);
		expect(JSON.stringify(result)).not.toContain("provider-secret");
		expect(() => controls.control("btw.cancel", { conversationId: opened.id, turnId })).toThrow("not running");
		expect(session.messages).toEqual([]);
	});

	it.each([
		"cancel",
		"close",
	] as const)("keeps actual iterator admission after bounded %s until both next and return settle", async operation => {
		const backend = controlledBackend();
		const { session, controls, registry } = await fixture(backend.model);
		vi.spyOn(registry, "getApiKey").mockResolvedValue("test-key");
		const run = vi.spyOn(session, "runEphemeralTurn");
		const release = vi.spyOn(session, "releaseBtwConversationScope");
		const opened = snapshot(controls.control("btw.open", { question: "gated" }));
		const call = await backend.started;
		emit(call, "visible");
		await settle();
		vi.useFakeTimers();
		if (operation === "cancel")
			controls.control("btw.cancel", { conversationId: opened.id, turnId: opened.turns[0]!.id });
		else expect(controls.control("btw.close", { conversationId: opened.id })).toEqual({ closed: true });
		await backend.returning;
		await settle();
		expect(call.options?.signal?.aborted).toBe(true);
		vi.advanceTimersByTime(5_000);
		await expect(run.mock.results[0]?.value).rejects.toMatchObject({ code: "unknown_effect" });
		await settle();
		let actuallySettled = false;
		const actualJoin = session.joinBtwTurnsForControl().then(() => {
			actuallySettled = true;
		});
		await settle();
		expect(actuallySettled).toBe(false);
		if (operation === "cancel") {
			expect(
				captureError(() => controls.control("btw.submit", { conversationId: opened.id, question: "overlap" })),
			).toMatchObject({ code: "unknown_effect" });
			expect(snapshot(controls.control("btw.read", { conversationId: opened.id })).turns[0]).toMatchObject({
				status: "unknown_effect",
				cleanup: "unknown_effect",
				answer: "visible",
			});
			expect(controls.control("btw.close", { conversationId: opened.id })).toEqual({ closed: true });
		}
		expect(release).not.toHaveBeenCalled();
		expect(() => controls.control("btw.read", { conversationId: opened.id })).toThrow("no longer available");
		expect(captureError(() => controls.control("btw.open", {}))).toMatchObject({
			code: operation === "cancel" ? "unknown_effect" : "busy",
		});
		backend.releaseReturn.resolve();
		await settle();
		expect(actuallySettled).toBe(false);
		expect(release).not.toHaveBeenCalled();
		expect(captureError(() => controls.control("btw.open", { question: "overlap" }))).toMatchObject({
			code: operation === "cancel" ? "unknown_effect" : "busy",
		});
		emit(call, "late private bytes");
		finish(call);
		await actualJoin;
		await settle();
		expect(actuallySettled).toBe(true);
		expect(release).toHaveBeenCalledTimes(1);
		expect(backend.calls).toHaveLength(1);
		const reopened = snapshot(controls.control("btw.open", {}));
		expect(reopened.id).not.toBe(opened.id);
		run.mock.calls[0]?.[0].onTextDelta?.("stale callback");
		expect(snapshot(controls.control("btw.read", { conversationId: reopened.id }))).toEqual(reopened);
		expect(session.messages).toEqual([]);
	});

	it("shares admission across lifecycle retirement and service recreation without stale result mutation", async () => {
		const { session, controls } = await fixture();
		const pending = Promise.withResolvers<TestReply>();
		const backend = Promise.withResolvers<void>();
		backendCleanup.push(() => {
			pending.resolve(reply("stale answer"));
			backend.resolve();
		});
		let args: EphemeralTurnArgs | undefined;
		const release = vi.spyOn(session, "releaseBtwConversationScope");
		vi.spyOn(session, "runEphemeralTurn").mockImplementation(input => {
			args = input;
			return pending.promise;
		});
		vi.spyOn(session, "joinBtwTurnsForControl").mockImplementation(() => backend.promise);
		const opened = snapshot(controls.control("btw.open", { question: "old" }));
		await session.newSession();
		expect(args?.signal?.aborted).toBe(true);
		expect(release).not.toHaveBeenCalled();
		expect(() => controls.control("btw.read", { conversationId: opened.id })).toThrow("retired");
		const replacement = new SideConversationControls(session);
		cleanup.push(async () => replacement.dispose());
		expect(() => replacement.control("btw.open", {})).toThrow("still running");
		pending.resolve(reply("stale answer"));
		await settle();
		expect(release).not.toHaveBeenCalled();
		expect(() => replacement.control("btw.open", { question: "new" })).toThrow("still running");
		backend.resolve();
		await settle();
		expect(release).toHaveBeenCalledTimes(1);
		const reopened = snapshot(replacement.control("btw.open", {}));
		args?.onTextDelta?.("stale delta");
		expect(snapshot(replacement.control("btw.read", { conversationId: reopened.id }))).toEqual(reopened);
		expect(session.messages).toEqual([]);
	});

	it("retires scope on lifecycle change and validates malformed input before execution", async () => {
		const { session, controls } = await fixture();
		const release = vi.spyOn(session, "releaseBtwConversationScope");
		const run = vi.spyOn(session, "runEphemeralTurn");
		const opened = snapshot(controls.control("btw.open", {}));
		expect(() => controls.control("btw.submit", { conversationId: opened.id, question: "x".repeat(17000) })).toThrow(
			"UTF-8 limit",
		);
		expect(() => controls.control("btw.read", { conversationId: opened.id, secret: true })).toThrow("Unknown");
		expect(run).not.toHaveBeenCalled();
		await session.newSession();
		expect(release).toHaveBeenCalledTimes(1);
		expect(() => controls.control("btw.read", { conversationId: opened.id })).toThrow("retired");
	});
});
