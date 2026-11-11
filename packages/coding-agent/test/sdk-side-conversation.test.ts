import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import {
	type AssistantMessage,
	type CustomStreamSimpleFn,
	Effort,
	type Model,
	registerCustomApi,
	type SimpleStreamOptions,
	unregisterCustomApis,
} from "@gajae-code/ai";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";
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
	return { session, controls, registry };
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
	stream: AssistantMessageEventStream;
	message: AssistantMessage;
	options: SimpleStreamOptions | undefined;
}
function controlledBackend() {
	const started = Promise.withResolvers<ControlledCall>();
	const returning = Promise.withResolvers<void>();
	const releaseReturn = Promise.withResolvers<void>();
	const calls: ControlledCall[] = [];
	const streamFn: CustomStreamSimpleFn = (_model, _context, options) => {
		const stream = new AssistantMessageEventStream();
		const message = assistant("");
		const createIterator = stream[Symbol.asyncIterator].bind(stream);
		stream[Symbol.asyncIterator] = () => {
			const iterator = createIterator();
			return {
				next: () => iterator.next(),
				return: async () => {
					returning.resolve();
					await releaseReturn.promise;
					await iterator.return?.();
					return { done: true as const, value: undefined };
				},
			};
		};
		const call = { stream, message, options };
		calls.push(call);
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
	it("captures scope once, streams exact per-turn chunks and retains only completed side history", async () => {
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
		args?.onTextDelta?.("part");
		args?.onTextDelta?.("ial");
		const streamed = snapshot(controls.control("btw.read", { conversationId: opened.id, cursor: opened.nextCursor }));
		expect(streamed.turns[0]?.answer).toBe("partial");
		expect(streamed.deltas.map(delta => [delta.turnId, delta.text])).toEqual([
			[accepted.turns[0]!.id, "part"],
			[accepted.turns[0]!.id, "ial"],
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
		for (let i = 0; i < count; i++) args?.onTextDelta?.("x");
		expect(
			captureError(() => controls.control("btw.read", { conversationId: opened.id, cursor: opened.nextCursor })),
		).toMatchObject({
			code: "resource_gone",
			message: expect.stringContaining("omit cursor"),
		});
		const recovered = snapshot(controls.control("btw.read", { conversationId: opened.id }));
		expect(recovered.turns[0]?.answer).toBe("x".repeat(count));
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
			expect(() => controls.control("btw.submit", { conversationId: opened.id, question: "overlap" })).toThrow(
				"still running",
			);
			expect(snapshot(controls.control("btw.read", { conversationId: opened.id })).turns[0]).toMatchObject({
				status: "cancelled",
				answer: "visible",
			});
			expect(controls.control("btw.close", { conversationId: opened.id })).toEqual({ closed: true });
		}
		expect(release).not.toHaveBeenCalled();
		expect(() => controls.control("btw.read", { conversationId: opened.id })).toThrow("no longer available");
		expect(() => controls.control("btw.open", {})).toThrow("still running");
		backend.releaseReturn.resolve();
		await settle();
		expect(actuallySettled).toBe(false);
		expect(release).not.toHaveBeenCalled();
		expect(() => controls.control("btw.open", { question: "overlap" })).toThrow("still running");
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
