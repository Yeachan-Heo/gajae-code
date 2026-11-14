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
import { btw, createAgentSession, Settings } from "@gajae-code/coding-agent/sdk";
import { createDesktopBtwController, type DesktopBtwController, type DesktopBtwOptions } from "../src/btw-controls";
import type { DesktopBtwConversation, DesktopBtwEvent, DesktopBtwTurn } from "../src/btw-protocol";
import { createDesktopStreamRedactor } from "../src/stream-redactor";

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
	vi.restoreAllMocks();
	if (failures.length) throw new AggregateError(failures, "BTW fixture cleanup failed");
});

interface ControlledCall {
	stream: AssistantMessageEventStream;
	message: AssistantMessage;
	context: Context;
	options: SimpleStreamOptions | undefined;
	close(): void;
}

function assistant(api: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "" }],
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

function last(dto: DesktopBtwConversation): DesktopBtwTurn {
	const turn = dto.turns.at(-1);
	if (!turn) throw new Error("Missing side turn");
	return turn;
}

async function waitFor(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("Side turn did not settle");
		await Bun.sleep(10);
	}
}

/** Real factory session, actual SDK frozen history/redaction/owner barrier, controlled provider only. */
async function fixture(options: Partial<DesktopBtwOptions> = {}) {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-btw-sdk-"));
	const api = `desktop-btw-${crypto.randomUUID()}`;
	const source = `source-${api}`;
	const calls: ControlledCall[] = [];
	const model = createMockModel({ provider: "desktop-btw-fixture" });
	Object.defineProperty(model, "api", { value: api });
	const stream: CustomStreamSimpleFn = (_model, context, requestOptions) => {
		const events = new AssistantMessageEventStream();
		const message = assistant(api);
		const close = () => {
			requestOptions?.signal?.removeEventListener("abort", close);
			if (!events.done) {
				message.stopReason = "aborted";
				events.push({
					type: "error",
					reason: "aborted",
					error: { ...message, errorMessage: "PRIVATE_PROVIDER_FAILURE" },
				});
			}
			events.end(message);
		};
		calls.push({ stream: events, message, context: structuredClone(context), options: requestOptions, close });
		events.push({ type: "start", partial: message });
		requestOptions?.signal?.addEventListener("abort", close, { once: true });
		if (requestOptions?.signal?.aborted) close();
		return events;
	};
	registerCustomApi(api, stream, source);
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"retry.enabled": false,
		"bash.autoBackground.enabled": false,
		"async.enabled": false,
	});
	const created = await createAgentSession({
		cwd: directory,
		agentDir: directory,
		settings,
		model,
		agentId: `btw-${crypto.randomUUID()}`,
		systemPrompt: ["PRIVATE_SYSTEM_INSTRUCTION"],
		toolNames: [],
		disableExtensionDiscovery: true,
		extensions: [],
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
	session.modelRegistry.authStorage.setRuntimeApiKey(model.provider, "PRIVATE_API_CREDENTIAL");
	session.sessionManager.appendMessage({ role: "user", content: "visible frozen seed", timestamp: 1 });
	const events: DesktopBtwEvent[] = [];
	const mainWork: Promise<void>[] = [];
	const controller = createDesktopBtwController(session, {
		redact: text => text,
		...options,
		emit(event) {
			events.push(structuredClone(event));
			options.emit?.(event);
		},
	});
	cleanups.push(async () => {
		controller.dispose();
		for (const call of calls) call.close();
		try {
			await session.dispose();
			await session.awaitDisposeCompletion();
			await Promise.allSettled(mainWork);
		} finally {
			unregisterCustomApis(source);
			await settings.close();
			await fs.rm(directory, { recursive: true, force: true });
		}
	});
	return {
		controller,
		session,
		calls,
		events,
		async request(index: number): Promise<ControlledCall> {
			await waitFor(() => calls[index] !== undefined);
			return calls[index]!;
		},
		async wait(turnId: string): Promise<DesktopBtwTurn> {
			await waitFor(() =>
				events.some(event =>
					event.conversation?.turns.some(
						turn => turn.turnId === turnId && turn.status !== "running" && turn.status !== "cancel_requested",
					),
				),
			);
			return events
				.flatMap(event => event.conversation?.turns ?? [])
				.findLast(
					turn => turn.turnId === turnId && turn.status !== "running" && turn.status !== "cancel_requested",
				)!;
		},
		prompt(text: string): Promise<void> {
			const work = session.prompt(text);
			void work.catch(() => {});
			mainWork.push(work);
			return work;
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

function expectCode(action: () => unknown, code: string): void {
	expect(action).toThrow(expect.objectContaining({ name: "DesktopBtwError", code }));
}

describe("desktop public SDK side conversation projection", () => {
	test("SDK freezes context, keeps successful private follow-ups and never mutates main history", async () => {
		const f = await fixture({ redact: text => text.replaceAll("raw-secret", "[masked]") });
		const prompt = vi.spyOn(f.session, "prompt");
		const abort = vi.spyOn(f.session, "abort");
		const mainBefore = structuredClone(f.session.agent.state.messages);
		const persistedBefore = structuredClone(f.session.sessionManager.getEntries());
		const first = f.controller.open({ question: "first raw-secret" });
		expect(last(first)).toMatchObject({
			question: "first [masked]",
			status: "running",
			cleanup: "pending",
			answer: "",
		});
		const call = await f.request(0);
		expect(call.context.tools).toEqual([]);
		expect(call.options).toMatchObject({ toolChoice: "none", requestMaxRetries: 0, streamMaxRetries: 0 });
		expect(call.options?.sessionId).toContain(":btw:");
		expect(call.context.systemPrompt).toContain(btw.instruction);
		expect(JSON.stringify(call.context.messages)).toContain("visible frozen seed");
		delta(call, "answer raw-");
		delta(call, "secret");
		expect(last(f.controller.get()!).answer).toBe("");
		finish(call);
		expect(await f.wait(last(first).turnId)).toMatchObject({
			answer: "answer [masked]",
			status: "completed",
			cleanup: "settled",
		});
		expect(f.session.agent.state.messages).toEqual(mainBefore);
		expect(f.session.sessionManager.getEntries()).toEqual(persistedBefore);
		f.session.sessionManager.appendMessage({ role: "user", content: "later main context", timestamp: 2 });
		f.session.agent.setSystemPrompt(["REPLACEMENT_PRIVATE_SYSTEM"]);
		const second = f.controller.submit({ conversationId: first.conversationId, question: "follow-up" });
		const followup = await f.request(1);
		const frozen = JSON.stringify(followup.context);
		expect(frozen).toContain("first raw-secret");
		expect(frozen).toContain("answer raw-secret");
		expect(frozen).not.toContain("later main context");
		expect(frozen).not.toContain("REPLACEMENT_PRIVATE_SYSTEM");
		finish(followup, "done");
		await f.wait(last(second).turnId);
		expect(prompt).not.toHaveBeenCalled();
		expect(abort).not.toHaveBeenCalled();
		const wire = JSON.stringify({ events: f.events, dto: f.controller.get() });
		for (const secret of [
			"PRIVATE_API_CREDENTIAL",
			"PRIVATE_SYSTEM_INSTRUCTION",
			"raw-secret",
			"assistantMessage",
			"credentialSessionId",
			"systemPrompt",
		])
			expect(wire).not.toContain(secret);
	});

	test("cancel affects only the SDK side owner and cancelled text never enters follow-up history", async () => {
		const f = await fixture();
		const main = f.prompt("main question");
		const mainCall = await f.request(0);
		const abort = vi.spyOn(f.session, "abort");
		const first = f.controller.open({ question: "cancel side question" });
		const side = await f.request(1);
		delta(side, "cancelled side answer");
		const cancelled = f.controller.cancel({ conversationId: first.conversationId, turnId: last(first).turnId });
		expect(last(cancelled)).toMatchObject({ status: "cancel_requested", cleanup: "pending" });
		expect(side.options?.signal?.aborted).toBe(true);
		expect(mainCall.options?.signal?.aborted).toBe(false);
		expect(await f.wait(last(first).turnId)).toMatchObject({ status: "cancelled", cleanup: "settled" });
		expect(mainCall.stream.done).toBe(false);
		expect(abort).not.toHaveBeenCalled();
		const second = f.controller.submit({ conversationId: first.conversationId, question: "after cancellation" });
		const followup = await f.request(2);
		expect(JSON.stringify(followup.context)).not.toContain("cancel side question");
		expect(JSON.stringify(followup.context)).not.toContain("cancelled side answer");
		finish(followup, "side done");
		await f.wait(last(second).turnId);
		finish(mainCall, "main answer");
		await main;
		expect(JSON.stringify(f.session.sessionManager.getEntries())).not.toContain("after cancellation");
	});

	test("completed provider replies remain running until the actual SDK cleanup barrier settles", async () => {
		const f = await fixture();
		const release = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		const join = f.session.joinBtwTurnsForControl.bind(f.session);
		const barrier = vi.spyOn(f.session, "joinBtwTurnsForControl").mockImplementation(async () => {
			entered.resolve();
			await release.promise;
			await join();
		});
		cleanups.push(() => {
			release.resolve();
			barrier.mockRestore();
		});
		const opened = f.controller.open({ question: "held cleanup" });
		finish(await f.request(0), "provider done");
		await entered.promise;
		expect(last(f.controller.get()!)).toMatchObject({ status: "running", cleanup: "pending", answer: "" });
		expectCode(
			() => f.controller.submit({ conversationId: opened.conversationId, question: "too early" }),
			"control_busy",
		);
		release.resolve();
		expect(await f.wait(last(opened).turnId)).toMatchObject({
			status: "completed",
			cleanup: "settled",
			answer: "provider done",
		});
	});

	test("unknown SDK cleanup remains explicit and refuses retries even across a close/reopen", async () => {
		const f = await fixture();
		const barrier = vi
			.spyOn(f.session, "joinBtwTurnsForControl")
			.mockRejectedValue(new Error("PRIVATE_CLEANUP_FAILURE"));
		cleanups.push(() => barrier.mockRestore());
		const opened = f.controller.open({ question: "uncertain cleanup" });
		finish(await f.request(0), "not safe to certify");
		expect(await f.wait(last(opened).turnId)).toMatchObject({
			status: "failed",
			cleanup: "unknown_effect",
			answer: "",
			error: { code: "backend_failure" },
		});
		expectCode(
			() => f.controller.submit({ conversationId: opened.conversationId, question: "retry" }),
			"backend_failure",
		);
		f.controller.close({ conversationId: opened.conversationId });
		expectCode(() => f.controller.open({ question: "replacement retry" }), "backend_failure");
		expect(f.calls).toHaveLength(1);
		expect(JSON.stringify(f.events)).not.toContain("PRIVATE_CLEANUP_FAILURE");
	});

	test("provider failures expose only static errors and never become successful follow-up history", async () => {
		const f = await fixture();
		const opened = f.controller.open({ question: "failed side question" });
		const call = await f.request(0);
		call.message.stopReason = "error";
		call.stream.push({
			type: "error",
			reason: "error",
			error: { ...call.message, errorMessage: "PRIVATE_PROVIDER_FAILURE PRIVATE_API_CREDENTIAL" },
		});
		call.close();
		expect(await f.wait(last(opened).turnId)).toMatchObject({
			status: "failed",
			cleanup: "settled",
			answer: "",
			error: { code: "backend_failure" },
		});
		const next = f.controller.submit({ conversationId: opened.conversationId, question: "after failure" });
		const followup = await f.request(1);
		expect(JSON.stringify(followup.context)).not.toContain("failed side question");
		finish(followup, "recovered");
		await f.wait(last(next).turnId);
		expect(JSON.stringify(f.events)).not.toContain("PRIVATE_PROVIDER_FAILURE");
		expect(JSON.stringify(f.events)).not.toContain("PRIVATE_API_CREDENTIAL");
	});

	test("native and host privacy policies redact provider credentials and split host secrets", async () => {
		const f = await fixture({
			createStreamRedactor: () => createDesktopStreamRedactor(["split-secret"], text => text),
		});
		const opened = f.controller.open({ question: "hello" });
		const call = await f.request(0);
		delta(call, "public record split-");
		delta(call, "secret PRIVATE_API_");
		delta(call, "CREDENTIAL\npublic padding long enough to release the first record\nmore trailing padding");
		const live = last(f.controller.get()!);
		expect(live.status).toBe("running");
		expect(live.answer).not.toContain("split-secret");
		expect(live.answer).not.toContain("PRIVATE_API_CREDENTIAL");
		finish(call);
		const done = await f.wait(last(opened).turnId);
		expect(done.answer).toContain("[redacted]");
		expect(done.answer).not.toContain("split-secret");
		expect(done.answer).not.toContain("PRIVATE_API_CREDENTIAL");
		last(opened).question = "client mutation";
		last(f.controller.get()!).answer = "client mutation";
		expect(last(f.controller.get()!).question).toBe("hello");
		expect(last(f.controller.get()!).answer).not.toBe("client mutation");
	});

	test("native answer ceilings withhold host-secret fragments without weakening SDK cleanup", async () => {
		const f = await fixture({
			createStreamRedactor: () => createDesktopStreamRedactor(["cut-through-host-secret"], text => text),
		});
		const opened = f.controller.open({ question: "large answer" });
		finish(await f.request(0), `${"x".repeat(btw.BTW_MAX_ANSWER_UTF8_BYTES - 5)}cut-through-host-secret`);
		expect(await f.wait(last(opened).turnId)).toMatchObject({
			status: "completed",
			cleanup: "settled",
			answer: "",
			answerTruncated: true,
		});
		expect(JSON.stringify(f.events)).not.toContain("cut-through-host-secret");
	});

	test("host overlay failure closes native history and requires a fresh SDK conversation", async () => {
		let fail = true;
		const f = await fixture({
			redact(text) {
				if (fail && text.includes("PRIVATE_HOST_ANSWER")) throw new Error("PRIVATE_REDACTOR_FAILURE");
				return text;
			},
		});
		const opened = f.controller.open({ question: "old private question" });
		finish(await f.request(0), "PRIVATE_HOST_ANSWER");
		expect(await f.wait(last(opened).turnId)).toMatchObject({
			status: "failed",
			answer: "",
			error: { code: "redaction_failed" },
		});
		expectCode(
			() => f.controller.submit({ conversationId: opened.conversationId, question: "reuse closed history" }),
			"redaction_failed",
		);
		fail = false;
		const replacement = f.controller.open({ question: "fresh question" });
		const followup = await f.request(1);
		expect(JSON.stringify(followup.context)).not.toContain("old private question");
		expect(JSON.stringify(followup.context)).not.toContain("PRIVATE_HOST_ANSWER");
		finish(followup, "safe answer");
		await f.wait(last(replacement).turnId);
		expect(JSON.stringify(f.events)).not.toContain("PRIVATE_REDACTOR_FAILURE");
	});

	test("strict wire inputs cannot import context or invoke accessors", async () => {
		const f = await fixture();
		const getter = vi.fn(() => "PRIVATE_ACCESSOR");
		for (const value of [
			null,
			[],
			{},
			{ question: "" },
			{ question: "  " },
			{ question: "hello", contextExchanges: [] },
			{ question: "hello", scope: {} },
			Object.create({ question: "inherited" }),
			Object.defineProperty({}, "question", { get: getter }),
			{ question: "hello", [Symbol()]: true },
			{ question: "\ud800" },
			{ question: "界".repeat(btw.BTW_MAX_QUESTION_UTF8_BYTES) },
		])
			expectCode(() => f.controller.open(value), "invalid_request");
		expect(getter).not.toHaveBeenCalled();
		expect(f.calls).toHaveLength(0);
		const opened = f.controller.open({ question: "valid" });
		expectCode(
			() => f.controller.submit({ conversationId: opened.conversationId, question: "next", messages: [] }),
			"invalid_request",
		);
		expectCode(
			() =>
				f.controller.cancel({ conversationId: opened.conversationId, turnId: last(opened).turnId, signal: true }),
			"invalid_request",
		);
		expectCode(() => f.controller.close({ conversationId: "forged-id" }), "invalid_request");
		expectCode(() => f.controller.close({ conversationId: crypto.randomUUID() }), "not_found");
	});

	test("close cancels native work, invalidates projections and allows an isolated replacement after cleanup", async () => {
		const f = await fixture();
		const opened = f.controller.open({ question: "close me" });
		const call = await f.request(0);
		f.controller.close({ conversationId: opened.conversationId });
		expect(call.options?.signal?.aborted).toBe(true);
		expect(f.controller.get()).toBeNull();
		expect(f.events.at(-1)).toEqual({ conversation: null });
		await f.session.joinBtwTurnsForControl();
		// Native SideConversationControls' own barrier continuation must also release admission.
		await Bun.sleep(25);
		const replacement = f.controller.open({ question: "new scope" });
		const next = await f.request(1);
		expect(JSON.stringify(next.context)).not.toContain("close me");
		finish(next, "done");
		await f.wait(last(replacement).turnId);
	});

	test("committed session transitions and disposal clear wire history and retire native controls", async () => {
		const f = await fixture();
		const opened = f.controller.open({ question: "first" });
		finish(await f.request(0), "done");
		await f.wait(last(opened).turnId);
		await f.session.newSession();
		expect(f.events.at(-1)).toEqual({ conversation: null });
		expectCode(() => f.controller.get(), "stale_session");
		f.controller.dispose();
		expectCode(() => f.controller.open({ question: "after disposal" }), "disposed");
	});

	test("session disposal fences even empty projections before native cleanup hooks finish", async () => {
		const f = await fixture();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		f.session.registerToolSessionCleanup(async () => {
			entered.resolve();
			await release.promise;
		});
		cleanups.push(() => release.resolve());
		const disposal = f.session.dispose();
		await entered.promise;
		expectCode(() => f.controller.get(), "disposed");
		expectCode(() => f.controller.open({ question: "after retirement" }), "disposed");
		release.resolve();
		await disposal;
	});

	test("redactor reentry cannot admit nested turns or publish after reentrant disposal", async () => {
		let controller: DesktopBtwController | undefined;
		let rejections = 0;
		const f = await fixture({
			redact(text) {
				if (controller) {
					expectCode(() => controller!.open({ question: "nested" }), "control_busy");
					rejections++;
				}
				if (text === "dispose on answer") controller?.dispose();
				return text;
			},
		});
		controller = f.controller;
		const opened = controller.open({ question: "outer" });
		finish(await f.request(0), "dispose on answer");
		await waitFor(() => f.events.at(-1)?.conversation === null);
		expect(rejections).toBeGreaterThan(0);
		expect(f.calls).toHaveLength(1);
		expect(
			f.events.some(event =>
				event.conversation?.turns.some(turn => turn.turnId === last(opened).turnId && turn.status === "completed"),
			),
		).toBe(false);
		expectCode(() => controller!.get(), "disposed");
	});
});
