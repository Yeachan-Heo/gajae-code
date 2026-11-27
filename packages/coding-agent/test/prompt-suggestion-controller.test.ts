import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AutocompleteItem, AutocompleteProvider } from "@gajae-code/tui";
import { Editor } from "@gajae-code/tui/components/editor";
import { defaultEditorTheme } from "../../tui/test/test-themes";
import { PROMPT_SUGGESTION_TIMEOUT_MS, PromptSuggestionController } from "../src/modes/prompt-suggestion-controller";
import type { InteractiveModeContext } from "../src/modes/types";
import { PROMPT_SUGGESTION_REQUEST } from "../src/utils/prompt-suggestion";

interface FakeCtxOptions {
	enabled?: boolean;
	isStreaming?: boolean;
	lastAssistantStopReason?: string | null;
	queued?: number;
	compactionQueued?: number;
	btwActive?: boolean;
}

interface EphemeralCall {
	promptText: string;
	signal: AbortSignal;
	maintenanceCall?: boolean;
	resolve: (replyText: string) => void;
	reject: (error: Error) => void;
}

function createFakeCtx(options: FakeCtxOptions = {}) {
	let editorText = "";
	const calls: EphemeralCall[] = [];
	const state = { renderCount: 0, setTextCalls: [] as string[], autocompleteOpen: false };
	const lastStop = options.lastAssistantStopReason === undefined ? "stop" : options.lastAssistantStopReason;
	const ctx = {
		settings: {
			get(key: string) {
				return key === "promptSuggestions" ? (options.enabled ?? true) : undefined;
			},
		},
		shutdownRequested: false,
		compactionQueuedMessages: Array.from({ length: options.compactionQueued ?? 0 }),
		hasActiveBtw: () => options.btwActive ?? false,
		session: {
			isStreaming: options.isStreaming ?? false,
			getLastAssistantMessage: () => (lastStop === null ? undefined : { role: "assistant", stopReason: lastStop }),
			getQueuedMessageEntries: () => Array.from({ length: options.queued ?? 0 }),
			runEphemeralTurn: (args: Omit<EphemeralCall, "resolve" | "reject">) => {
				const { promise, resolve, reject } = Promise.withResolvers<{
					replyText: string;
					assistantMessage: { stopReason: string };
				}>();
				calls.push({
					...args,
					resolve: replyText => resolve({ replyText, assistantMessage: { stopReason: "stop" } }),
					reject,
				});
				return promise;
			},
		},
		editor: {
			isShowingAutocomplete: () => state.autocompleteOpen,
			getText: () => editorText,
			setText: (text: string) => {
				editorText = text;
				state.setTextCalls.push(text);
			},
		},
		ui: {
			requestRender: () => {
				state.renderCount++;
			},
		},
	} as unknown as InteractiveModeContext;
	return { ctx, state, calls };
}

async function settle() {
	await new Promise(resolve => setImmediate(resolve));
	await new Promise(resolve => setImmediate(resolve));
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("PromptSuggestionController", () => {
	it("requests a suggestion after a completed turn and exposes the parsed result", async () => {
		const { ctx, state, calls } = createFakeCtx();
		const controller = new PromptSuggestionController(ctx);

		controller.onAgentEnd("completed");
		expect(calls).toHaveLength(1);
		expect(calls[0]!.promptText).toBe(PROMPT_SUGGESTION_REQUEST);
		expect(calls[0]!.maintenanceCall).toBe(true);
		expect(controller.active).toBe(true);
		expect(controller.current).toBeNull();

		calls[0]!.resolve('{"suggestion":"표로 다시 정리해줘"}');
		await settle();

		expect(controller.current).toBe("표로 다시 정리해줘");
		expect(state.renderCount).toBeGreaterThan(0);
	});

	it("does not request anything when the setting is disabled", () => {
		const { ctx, calls } = createFakeCtx({ enabled: false });
		new PromptSuggestionController(ctx).onAgentEnd("completed");
		expect(calls).toHaveLength(0);
	});

	it("only suggests after a normally completed turn", () => {
		for (const stopReason of [undefined, "cancelled", "paused", "maintenance"]) {
			const { ctx, calls } = createFakeCtx();
			new PromptSuggestionController(ctx).onAgentEnd(stopReason);
			expect(calls).toHaveLength(0);
		}
		for (const lastAssistantStopReason of ["error", "aborted", null]) {
			const { ctx, calls } = createFakeCtx({ lastAssistantStopReason });
			new PromptSuggestionController(ctx).onAgentEnd("completed");
			expect(calls).toHaveLength(0);
		}
	});

	it("skips while streaming, with queued messages, or with an open side chat", () => {
		for (const options of [
			{ isStreaming: true },
			{ queued: 1 },
			{ compactionQueued: 1 },
			{ btwActive: true },
		] satisfies FakeCtxOptions[]) {
			const { ctx, calls } = createFakeCtx(options);
			new PromptSuggestionController(ctx).onAgentEnd("completed");
			expect(calls).toHaveLength(0);
		}
	});

	it("keeps the suggestion while the user types and accepts it once the composer is empty again", async () => {
		const { ctx, state, calls } = createFakeCtx();
		const controller = new PromptSuggestionController(ctx);
		controller.onAgentEnd("completed");
		calls[0]!.resolve('{"suggestion":"Add a regression test"}');
		await settle();

		expect(controller.tryAcceptOnTab("draft")).toBe(false);
		expect(controller.current).toBe("Add a regression test");

		expect(controller.tryAcceptOnTab("")).toBe(true);
		expect(state.setTextCalls).toEqual(["Add a regression test"]);
		expect(controller.current).toBeNull();
		expect(controller.tryAcceptOnTab("")).toBe(false);
	});

	it("drops null, malformed, and failed replies", async () => {
		for (const settleCall of [
			(call: EphemeralCall) => call.resolve('{"suggestion":null}'),
			(call: EphemeralCall) => call.resolve("Run the tests next."),
			(call: EphemeralCall) => call.reject(new Error("provider failed")),
		]) {
			const { ctx, calls } = createFakeCtx();
			const controller = new PromptSuggestionController(ctx);
			controller.onAgentEnd("completed");
			settleCall(calls[0]!);
			await settle();
			expect(controller.current).toBeNull();
			expect(controller.active).toBe(false);
		}
	});

	it("cancels the in-flight request when a new turn starts and ignores its late result", async () => {
		const { ctx, calls } = createFakeCtx();
		const controller = new PromptSuggestionController(ctx);
		controller.onAgentEnd("completed");

		controller.onAgentStart();
		expect(calls[0]!.signal.aborted).toBe(true);
		calls[0]!.resolve('{"suggestion":"stale"}');
		await settle();

		expect(controller.current).toBeNull();
	});

	it("lets a newer request supersede an older one", async () => {
		const { ctx, calls } = createFakeCtx();
		const controller = new PromptSuggestionController(ctx);
		controller.onAgentEnd("completed");
		controller.onAgentEnd("completed");

		expect(calls[0]!.signal.aborted).toBe(true);
		calls[1]!.resolve('{"suggestion":"newer"}');
		calls[0]!.resolve('{"suggestion":"older"}');
		await settle();

		expect(controller.current).toBe("newer");
	});

	it("consumes Escape to cancel a pending or shown suggestion", async () => {
		const { ctx, calls } = createFakeCtx();
		const controller = new PromptSuggestionController(ctx);
		expect(controller.tryCancelOnEscape()).toBe(false);

		controller.onAgentEnd("completed");
		expect(controller.tryCancelOnEscape()).toBe(true);
		expect(calls[0]!.signal.aborted).toBe(true);

		controller.onAgentEnd("completed");
		calls[1]!.resolve('{"suggestion":"shown"}');
		await settle();
		expect(controller.tryCancelOnEscape()).toBe(true);
		expect(controller.current).toBeNull();
		expect(controller.tryCancelOnEscape()).toBe(false);
	});

	it("aborts the request after the 30 second deadline", async () => {
		const timers: Array<{ callback: () => void; delay: number }> = [];
		vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, delay: number) => {
			timers.push({ callback, delay });
			return { unref() {} } as never;
		}) as never);
		const { ctx, calls } = createFakeCtx();
		const controller = new PromptSuggestionController(ctx);
		controller.onAgentEnd("completed");

		expect(timers.map(timer => timer.delay)).toEqual([PROMPT_SUGGESTION_TIMEOUT_MS]);
		expect(PROMPT_SUGGESTION_TIMEOUT_MS).toBe(30_000);
		timers[0]!.callback();
		expect(calls[0]!.signal.aborted).toBe(true);
		// The provider has not settled, yet the request is already retired: Esc falls through.
		expect(controller.active).toBe(false);
		expect(controller.tryCancelOnEscape()).toBe(false);
		calls[0]!.resolve('{"suggestion":"too late"}');
		await settle();

		expect(controller.current).toBeNull();
		expect(controller.active).toBe(false);
	});

	it("does not let an expired request's deadline retire a newer request", async () => {
		const timers: Array<() => void> = [];
		vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void) => {
			timers.push(callback);
			return { unref() {} } as never;
		}) as never);
		vi.spyOn(globalThis, "clearTimeout").mockImplementation((() => {}) as never);
		const { ctx, calls } = createFakeCtx();
		const controller = new PromptSuggestionController(ctx);
		controller.onAgentEnd("completed");
		controller.onAgentEnd("completed");

		timers[0]!();
		expect(calls[1]!.signal.aborted).toBe(false);
		calls[1]!.resolve('{"suggestion":"newer"}');
		await settle();
		expect(controller.current).toBe("newer");
	});

	it("hides the suggestion and declines Tab while a turn streams or autocomplete is open", async () => {
		const { ctx, state, calls } = createFakeCtx();
		const session = ctx.session as unknown as { isStreaming: boolean };
		const controller = new PromptSuggestionController(ctx);
		controller.onAgentEnd("completed");
		calls[0]!.resolve('{"suggestion":"shown"}');
		await settle();

		state.autocompleteOpen = true;
		expect(controller.visible).toBeNull();
		expect(controller.tryAcceptOnTab("")).toBe(false);
		state.autocompleteOpen = false;

		session.isStreaming = true;
		expect(controller.visible).toBeNull();
		expect(controller.tryAcceptOnTab("")).toBe(false);
		session.isStreaming = false;

		expect(controller.visible).toBe("shown");
		expect(controller.tryAcceptOnTab("")).toBe(true);
		expect(state.setTextCalls).toEqual(["shown"]);
	});

	it("drops a stale suggestion on Esc during streaming without consuming the interrupt", async () => {
		const { ctx, calls } = createFakeCtx();
		const session = ctx.session as unknown as { isStreaming: boolean };
		const controller = new PromptSuggestionController(ctx);
		controller.onAgentEnd("completed");

		session.isStreaming = true;
		expect(controller.tryCancelOnEscape()).toBe(false);
		expect(calls[0]!.signal.aborted).toBe(true);
		expect(controller.active).toBe(false);
	});

	it("drops a hidden suggestion on Esc over a draft without consuming the draft-clear gesture", () => {
		const { ctx, calls } = createFakeCtx();
		const controller = new PromptSuggestionController(ctx);
		controller.onAgentEnd("completed");

		ctx.editor.setText("draft");
		expect(controller.tryCancelOnEscape()).toBe(false);
		expect(calls[0]!.signal.aborted).toBe(true);
		expect(controller.active).toBe(false);
	});
});

describe("PromptSuggestionController with a real Editor", () => {
	it("lets Tab select an open autocomplete popup instead of inserting a hidden suggestion", async () => {
		const { ctx, calls } = createFakeCtx();
		const editor = new Editor(defaultEditorTheme);
		const controller = new PromptSuggestionController(ctx);
		const items: AutocompleteItem[] = [
			{ value: "alpha.txt", label: "alpha.txt" },
			{ value: "beta.txt", label: "beta.txt" },
		];
		const provider: AutocompleteProvider & {
			getForceFileSuggestions: () => Promise<{ items: AutocompleteItem[]; prefix: string }>;
		} = {
			getSuggestions: async () => null,
			getForceFileSuggestions: async () => ({ items, prefix: "" }),
			applyCompletion: (_lines, _cursorLine, _cursorCol, item) => ({
				lines: [item.value],
				cursorLine: 0,
				cursorCol: item.value.length,
			}),
			getInlineHint: lines => (lines.every(line => line === "") ? controller.visible : null),
		};
		editor.setAutocompleteProvider(provider);
		editor.onTab = text => controller.tryAcceptOnTab(text);
		(ctx as unknown as { editor: Editor }).editor = editor;

		controller.onAgentEnd("completed");
		editor.handleInput("\t");
		await Bun.sleep(0);
		expect(editor.isShowingAutocomplete()).toBe(true);

		calls[0]!.resolve('{"suggestion":"hidden suggestion"}');
		await settle();
		expect(controller.current).toBe("hidden suggestion");
		expect(controller.visible).toBeNull();

		editor.handleInput("\t");
		await Bun.sleep(0);
		expect(editor.getText()).toBe("alpha.txt");
	});
});
