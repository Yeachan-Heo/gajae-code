import { afterEach, beforeAll, describe, expect, it, spyOn, vi } from "bun:test";
import type { AgentToolContext } from "@gajae-code/agent-core";
import { validateToolArguments } from "@gajae-code/ai/utils/validation";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import type { AppendOrMergeResult } from "@gajae-code/coding-agent/gjc-runtime/deep-interview-recorder";
import * as deepInterviewRecorder from "@gajae-code/coding-agent/gjc-runtime/deep-interview-recorder";
import { deepInterviewCharacterCount } from "@gajae-code/coding-agent/gjc-runtime/deep-interview-state";
import { getThemeByName, initTheme } from "@gajae-code/coding-agent/modes/theme/theme";
import type { AskAnswerRequest, AskAnswerSource, AskRemoteReceipt, ToolSession } from "@gajae-code/coding-agent/tools";
import { AskTool, askSchema, askToolRenderer } from "@gajae-code/coding-agent/tools/ask";
import { ToolAbortError } from "@gajae-code/coding-agent/tools/tool-errors";
import { logger } from "@gajae-code/utils";

function createSession(overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd: "/tmp/test",
		hasUI: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		...overrides,
	};
}

function createContext(args: {
	select: (
		prompt: string,
		options: string[],
		dialogOptions?: {
			initialIndex?: number;
			timeout?: number;
			signal?: AbortSignal;
			outline?: boolean;
			wrapFocused?: boolean;
			scrollTitleRows?: number;
			onTimeout?: () => void;
			onLeft?: () => void;
			onRight?: () => void;
			helpText?: string;
			customInput?: { optionLabel: string; onSubmit: (text: string) => void };
			clarificationInput?: { optionLabel: string; onSubmit: (text: string) => void; allowEmpty?: boolean };
		},
	) => Promise<string | undefined>;
	editor?: (
		title: string,
		prefill?: string,
		dialogOptions?: { signal?: AbortSignal },
		editorOptions?: { promptStyle?: boolean },
	) => Promise<string | undefined>;
	abort?: () => void;
}): AgentToolContext {
	// AgentToolContext includes many runtime fields; tests only need UI + abort behavior.
	return {
		hasUI: true,
		ui: {
			select: args.select,
			editor: (
				title: string,
				prefill?: string,
				dialogOptions?: { signal?: AbortSignal },
				editorOptions?: { promptStyle?: boolean },
			) => args.editor?.(title, prefill, dialogOptions, editorOptions) ?? Promise.resolve(undefined),
		},
		abort: args.abort ?? (() => {}),
	} as unknown as AgentToolContext;
}

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

beforeAll(async () => {
	await initTheme(false);
});

afterEach(() => {
	vi.restoreAllMocks();
});

function deepInterviewMeta() {
	return { round: 2, component: "Scope", dimension: "Constraints", ambiguity: 0.42 };
}

function singleDeepInterviewQuestion() {
	return {
		id: "q-deep",
		question: "Which constraint matters most?",
		options: [{ label: "Budget" }, { label: "Timeline" }],
		deepInterview: deepInterviewMeta(),
	};
}

describe("AskTool cancellation", () => {
	it("aborts the turn when the user cancels selection", async () => {
		const tool = new AskTool(createSession());
		const abort = vi.fn();
		const context = createContext({
			select: async () => undefined,
			abort,
		});

		expect(
			tool.execute(
				"call-1",
				{
					questions: [
						{
							id: "confirm",
							question: "Proceed?",
							options: [{ label: "yes" }, { label: "no" }],
						},
					],
				},
				undefined,
				undefined,
				context,
			),
		).rejects.toBeInstanceOf(ToolAbortError);
		expect(abort).toHaveBeenCalledTimes(1);
	});

	it("registers the remote ask before opening the local selector (Telegram buttons at invocation)", async () => {
		const order: string[] = [];
		// Remote source never resolves on its own; we only assert it was invoked
		// (i.e. action_needed was broadcast) BEFORE the local selector opened.
		const source = {
			awaitAnswer: (_q: string, _opts: string[], _signal?: AbortSignal) => {
				order.push("remote");
				return new Promise<string | undefined>(() => {});
			},
		};
		const tool = new AskTool(createSession({ getAskAnswerSource: () => source } as Partial<ToolSession>));
		const context = createContext({
			select: async () => {
				order.push("local");
				return "yes";
			},
		});

		const result = await tool.execute(
			"call-remote-emit",
			{ questions: [{ id: "confirm", question: "Proceed?", options: [{ label: "yes" }, { label: "no" }] }] },
			undefined,
			undefined,
			context,
		);

		// The remote ask must be registered first so the notification is emitted at
		// invocation, not only after the ask is finalized locally.
		expect(order[0]).toBe("remote");
		expect(order).toContain("local");
		expect(result.content[0]?.type).toBe("text");
		if (result.content[0]?.type === "text") expect(result.content[0].text).toContain("yes");
	});

	it("resolves the ask from a remote (Telegram) answer that wins the race", async () => {
		const source = {
			awaitAnswer: (_q: string, _opts: string[], _signal?: AbortSignal) => Promise.resolve("yes"),
		};
		const tool = new AskTool(createSession({ getAskAnswerSource: () => source } as Partial<ToolSession>));
		const context = createContext({
			// Local selector never resolves: only the remote answer can finish the ask.
			select: () => new Promise<string | undefined>(() => {}),
		});

		const result = await tool.execute(
			"call-remote-answer",
			{ questions: [{ id: "confirm", question: "Proceed?", options: [{ label: "yes" }, { label: "no" }] }] },
			undefined,
			undefined,
			context,
		);

		expect(result.content[0]?.type).toBe("text");
		if (result.content[0]?.type === "text") expect(result.content[0].text).toContain("yes");
	});

	it("closes (aborts) the local selector when a remote answer wins the race", async () => {
		const source = {
			awaitAnswer: (_q: string, _opts: string[], _signal?: AbortSignal) => Promise.resolve("yes"),
		};
		const tool = new AskTool(createSession({ getAskAnswerSource: () => source } as Partial<ToolSession>));
		let localAborted = false;
		const context = createContext({
			// The local selector only ends when its signal is aborted — proving the
			// remote win actually tears the TUI dialog down instead of leaving it open.
			select: (_prompt, _options, dialogOptions) =>
				new Promise<string | undefined>(resolve => {
					dialogOptions?.signal?.addEventListener("abort", () => {
						localAborted = true;
						resolve(undefined);
					});
				}),
		});

		const result = await tool.execute(
			"call-remote-closes-local",
			{ questions: [{ id: "confirm", question: "Proceed?", options: [{ label: "yes" }, { label: "no" }] }] },
			undefined,
			undefined,
			context,
		);

		expect(localAborted).toBe(true);
		expect(result.content[0]?.type).toBe("text");
		if (result.content[0]?.type === "text") expect(result.content[0].text).toContain("yes");
	});

	it("treats an unmatched remote answer as provide-my-own custom input", async () => {
		const source = {
			awaitAnswer: (_q: string, _opts: string[], _signal?: AbortSignal) => Promise.resolve("ship it tomorrow"),
		};
		const tool = new AskTool(createSession({ getAskAnswerSource: () => source } as Partial<ToolSession>));
		const context = createContext({
			// Local selector never resolves; the remote free-text answer wins.
			select: () => new Promise<string | undefined>(() => {}),
		});

		const result = await tool.execute(
			"call-remote-custom",
			{ questions: [{ id: "confirm", question: "Proceed?", options: [{ label: "yes" }, { label: "no" }] }] },
			undefined,
			undefined,
			context,
		);

		expect(result.details?.customInput).toBe("ship it tomorrow");
		expect(result.details?.selectedOptions).toEqual([]);
		if (result.content[0]?.type === "text") expect(result.content[0].text).toContain("custom input");
	});

	it("treats a remote answer that matches an option as a selection (not custom input)", async () => {
		const source = {
			awaitAnswer: (_q: string, _opts: string[], _signal?: AbortSignal) => Promise.resolve("no"),
		};
		const tool = new AskTool(createSession({ getAskAnswerSource: () => source } as Partial<ToolSession>));
		const context = createContext({
			select: () => new Promise<string | undefined>(() => {}),
		});

		const result = await tool.execute(
			"call-remote-match",
			{ questions: [{ id: "confirm", question: "Proceed?", options: [{ label: "yes" }, { label: "no" }] }] },
			undefined,
			undefined,
			context,
		);

		expect(result.details?.selectedOptions).toEqual(["no"]);
		expect(result.details?.customInput).toBeUndefined();
	});

	it("defaults to no timeout when ask.timeout is unset", async () => {
		// Regression for the surprise-auto-select report: a fresh install must let the user
		// deliberate indefinitely. The dialog timeout is opt-in via the `ask.timeout` setting.
		const tool = new AskTool(createSession());
		const select = vi.fn(
			async (_prompt: string, options: string[], _dialogOptions?: { initialIndex?: number; timeout?: number }) =>
				options[0],
		);
		const context = createContext({ select });

		await tool.execute(
			"call-default-no-timeout",
			{
				questions: [
					{
						id: "confirm",
						question: "Proceed?",
						options: [{ label: "yes" }, { label: "no" }],
					},
				],
			},
			undefined,
			undefined,
			context,
		);

		expect(select).toHaveBeenCalledTimes(1);
		expect(select.mock.calls[0]?.[2]?.timeout).toBeUndefined();
	});

	it("still aborts when user explicitly cancels with timeout configured", async () => {
		const tool = new AskTool(
			createSession({
				settings: Settings.isolated({ "ask.timeout": 30 }),
			}),
		);
		const abort = vi.fn();
		const context = createContext({
			select: async () => undefined,
			abort,
		});

		expect(
			tool.execute(
				"call-timeout-cancel",
				{
					questions: [
						{
							id: "confirm",
							question: "Proceed?",
							options: [{ label: "yes" }, { label: "no" }],
						},
					],
				},
				undefined,
				undefined,
				context,
			),
		).rejects.toBeInstanceOf(ToolAbortError);
		expect(abort).toHaveBeenCalledTimes(1);
	});
	it("auto-selects the recommended option on ask timeout", async () => {
		const tool = new AskTool(
			createSession({
				settings: Settings.isolated({ "ask.timeout": 0.001 }),
			}),
		);
		const abort = vi.fn();
		const select = vi.fn(
			async (
				_prompt: string,
				options: string[],
				dialogOptions?: { initialIndex?: number; timeout?: number; onTimeout?: () => void },
			) => {
				const timeout = dialogOptions?.timeout ?? 1;
				await Bun.sleep(timeout + 5);
				dialogOptions?.onTimeout?.();
				return options[dialogOptions?.initialIndex ?? 0];
			},
		);
		const context = createContext({
			select,
			abort,
		});

		const result = await tool.execute(
			"call-2",
			{
				questions: [
					{
						id: "confirm",
						question: "Proceed?",
						options: [{ label: "yes" }, { label: "no" }],
						recommended: 1,
					},
				],
			},
			undefined,
			undefined,
			context,
		);

		expect(result.content[0]?.type).toBe("text");
		if (result.content[0]?.type !== "text") {
			throw new Error("Expected text result");
		}
		expect(result.content[0].text).toContain("User selected: no");
		expect(result.details?.selectedOptions).toEqual(["no"]);
		expect(abort).not.toHaveBeenCalled();
		expect(select).toHaveBeenCalledTimes(1);
		expect(select.mock.calls[0]?.[2]?.initialIndex).toBe(1);
		expect(select.mock.calls[0]?.[2]?.timeout).toBeGreaterThan(0);
	});

	it("auto-selects the first option when timeout elapses without a selected option", async () => {
		const tool = new AskTool(
			createSession({
				settings: Settings.isolated({ "ask.timeout": 0.001 }),
			}),
		);
		const abort = vi.fn();
		const context = createContext({
			select: async (_prompt, _options, dialogOptions) => {
				const timeout = dialogOptions?.timeout ?? 1;
				await Bun.sleep(timeout + 5);
				dialogOptions?.onTimeout?.();
				return undefined;
			},
			abort,
		});

		const result = await tool.execute(
			"call-timeout-none",
			{
				questions: [
					{
						id: "confirm",
						question: "Proceed?",
						options: [{ label: "yes" }, { label: "no" }],
					},
				],
			},
			undefined,
			undefined,
			context,
		);

		expect(result.content[0]?.type).toBe("text");
		if (result.content[0]?.type !== "text") {
			throw new Error("Expected text result");
		}
		expect(result.content[0].text).toContain("User selected: yes");
		expect(result.details?.selectedOptions).toEqual(["yes"]);
		expect(abort).not.toHaveBeenCalled();
	});

	it("routes custom input through editor with promptStyle after choosing Other", async () => {
		const tool = new AskTool(
			createSession({
				settings: Settings.isolated({ "ask.timeout": 0.001 }),
			}),
		);
		const abort = vi.fn();
		const editor = vi.fn(
			async (
				_title: string,
				_prefill?: string,
				_dialogOptions?: unknown,
				editorOptions?: { promptStyle?: boolean },
			) => {
				// Verify promptStyle is passed
				expect(editorOptions?.promptStyle).toBe(true);
				return "custom response";
			},
		);
		const select = vi.fn(async () => "Other (type your own)");
		const context = createContext({
			select,
			editor,
			abort,
		});

		const result = await tool.execute(
			"call-custom-input",
			{
				questions: [
					{
						id: "confirm",
						question: "Proceed?",
						options: [{ label: "yes" }, { label: "no" }],
					},
				],
			},
			undefined,
			undefined,
			context,
		);

		expect(result.content[0]?.type).toBe("text");
		if (result.content[0]?.type !== "text") {
			throw new Error("Expected text result");
		}
		expect(result.content[0].text).toContain("custom response");
		expect(result.details?.selectedOptions).toEqual([]);
		expect(result.details?.customInput).toBe("custom response");
		expect((select.mock.calls[0] as unknown[])?.[2] as Record<string, unknown>).toHaveProperty("timeout");
		expect(editor).toHaveBeenCalledTimes(1);
		expect(abort).not.toHaveBeenCalled();
	});

	it("rejects oversized deep-interview custom input before recorder persistence", async () => {
		const appendSpy = spyOn(deepInterviewRecorder, "appendOrMergeDeepInterviewRound");
		const tool = new AskTool(createSession());
		const oversized = "😀".repeat(10_001);
		const context = createContext({
			select: async (_prompt, options, dialogOptions) => {
				dialogOptions?.customInput?.onSubmit(oversized);
				return options[2];
			},
		});

		await expect(
			tool.execute(
				"call-oversized-deep-input",
				{ questions: [singleDeepInterviewQuestion()] },
				undefined,
				undefined,
				context,
			),
		).rejects.toThrow("user_response exceeds max length 10000");
		expect(appendSpy).not.toHaveBeenCalled();
	});

	it("accepts exactly 10000 emoji custom-input characters and invalidates a 10001-character remote reply", async () => {
		const appendSpy = spyOn(deepInterviewRecorder, "appendOrMergeDeepInterviewRound").mockResolvedValue({
			action: "created",
			record: {} as AppendOrMergeResult["record"],
		});
		const exact = "😀".repeat(10_000);
		const local = new AskTool(createSession({ getSessionId: () => "test-session" }));
		const localContext = createContext({
			select: async (_prompt, options, dialogOptions) => {
				dialogOptions?.customInput?.onSubmit(exact);
				return options[2];
			},
		});
		await expect(
			local.execute(
				"call-exact-emoji-deep-input",
				{ questions: [singleDeepInterviewQuestion()] },
				undefined,
				undefined,
				localContext,
			),
		).resolves.toBeDefined();
		appendSpy.mockClear();

		const settlements: unknown[] = [];
		const remote = new AskTool(
			createSession({
				getAskAnswerSource: () => ({
					awaitAnswer: async () => undefined,
					awaitAnswerRequest: async () => ({
						source: "remote" as const,
						interaction: { kind: "value" as const, value: "😀".repeat(10_001) },
						settle: async settlement => {
							settlements.push(settlement);
							return { kind: "resolved_without_commit" as const };
						},
					}),
				}),
			}),
		);
		await expect(
			remote.execute(
				"call-remote-oversized-emoji-deep-input",
				{ questions: [singleDeepInterviewQuestion()] },
				undefined,
				undefined,
				createContext({ select: () => new Promise<string | undefined>(() => {}) }),
			),
		).rejects.toThrow("user_response exceeds max length 10000");
		expect(settlements).toEqual([{ kind: "invalid", reason: "invalid_structured_answer" }]);
		expect(appendSpy).not.toHaveBeenCalled();
	});

	it("rejects oversized legacy formatted deep-interview input before tool output", async () => {
		const appendSpy = spyOn(deepInterviewRecorder, "appendOrMergeDeepInterviewRound");
		const oversized = "한".repeat(10_001);
		const tool = new AskTool(createSession());
		const context = createContext({
			select: async (_prompt, options, dialogOptions) => {
				dialogOptions?.customInput?.onSubmit(oversized);
				return options.find(option => option === dialogOptions?.customInput?.optionLabel);
			},
		});

		await expect(
			tool.execute(
				"call-oversized-legacy-deep-input",
				{
					questions: [
						{
							id: "legacy-deep",
							question:
								"Round 1 | Component: Scope | Targeting: Constraints | Why now: unresolved boundary | Ambiguity: 42%\n\nWhat is the boundary?",
							options: [{ label: "Known" }],
						},
					],
				},
				undefined,
				undefined,
				context,
			),
		).rejects.toThrow("user_response exceeds max length 10000");
		const settlements: unknown[] = [];
		const remote = new AskTool(
			createSession({
				getAskAnswerSource: () => ({
					awaitAnswer: async () => undefined,
					awaitAnswerRequest: async () => ({
						source: "remote" as const,
						interaction: { kind: "value" as const, value: oversized },
						settle: async settlement => {
							settlements.push(settlement);
							return { kind: "resolved_without_commit" as const };
						},
					}),
				}),
			}),
		);
		await expect(
			remote.execute(
				"call-remote-oversized-legacy-deep-input",
				{
					questions: [
						{
							id: "legacy-deep",
							question:
								"Round 1 | Component: Scope | Targeting: Constraints | Why now: unresolved boundary | Ambiguity: 42%\n\nWhat is the boundary?",
							options: [{ label: "Known" }],
						},
					],
				},
				undefined,
				undefined,
				createContext({ select: () => new Promise<string | undefined>(() => {}) }),
			),
		).rejects.toThrow("user_response exceeds max length 10000");
		expect(settlements).toEqual([{ kind: "invalid", reason: "invalid_structured_answer" }]);
		expect(appendSpy).not.toHaveBeenCalled();
	});

	it("does not enter custom input when timeout resolves to Other in multi-select", async () => {
		const tool = new AskTool(
			createSession({
				settings: Settings.isolated({ "ask.timeout": 0.001 }),
			}),
		);
		const abort = vi.fn();
		const editor = vi.fn(async () => "should-not-be-used");
		const context = createContext({
			select: async (_prompt, _options, dialogOptions) => {
				const timeout = dialogOptions?.timeout ?? 1;
				await Bun.sleep(timeout + 5);
				dialogOptions?.onTimeout?.();
				return "Other (type your own)";
			},
			editor,
			abort,
		});

		const result = await tool.execute(
			"call-timeout-other-multi",
			{
				questions: [
					{
						id: "confirm",
						question: "Proceed?",
						options: [{ label: "yes" }, { label: "no" }],
						multi: true,
					},
				],
			},
			undefined,
			undefined,
			context,
		);

		expect(result.content[0]?.type).toBe("text");
		if (result.content[0]?.type !== "text") {
			throw new Error("Expected text result");
		}
		expect(result.content[0].text).toContain("User selected: yes");
		expect(result.details?.selectedOptions).toEqual(["yes"]);
		expect(result.details?.customInput).toBeUndefined();
		expect(editor).not.toHaveBeenCalled();
		expect(abort).not.toHaveBeenCalled();
	});

	it("aborts multi-question ask when any question is explicitly cancelled", async () => {
		const tool = new AskTool(createSession());
		const abort = vi.fn();
		const context = createContext({
			select: async prompt => {
				if (prompt.includes("First")) return "one";
				return undefined;
			},
			abort,
		});

		await expect(
			tool.execute(
				"call-3",
				{
					questions: [
						{
							id: "first",
							question: "First",
							options: [{ label: "one" }, { label: "two" }],
						},
						{
							id: "second",
							question: "Second",
							options: [{ label: "alpha" }, { label: "beta" }],
						},
					],
				},
				undefined,
				undefined,
				context,
			),
		).rejects.toBeInstanceOf(ToolAbortError);
		expect(abort).toHaveBeenCalledTimes(1);
	});
});

describe("AskTool remote semantic settlements", () => {
	const abortableUi = () =>
		createContext({
			select: (_prompt, _options, dialogOptions) =>
				new Promise<string | undefined>(resolve => {
					dialogOptions?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
				}),
			editor: (_title, _prefill, dialogOptions) =>
				new Promise<string | undefined>(resolve => {
					dialogOptions?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
				}),
		});

	it("awaits a committed visible acknowledgement before returning the answer", async () => {
		const settlementStarted = Promise.withResolvers<void>();
		const releaseSettlement = Promise.withResolvers<void>();
		let completed = false;
		const source: AskAnswerSource = {
			awaitAnswer: async () => undefined,
			awaitAnswerRequest: () =>
				Promise.resolve({
					source: "remote" as const,
					interaction: { kind: "value" as const, value: "yes" },
					settle: async settlement => {
						expect(settlement).toEqual({ kind: "commit" });
						settlementStarted.resolve();
						await releaseSettlement.promise;
						return { kind: "committed" as const, ack: { status: "delivered" as const, messageId: 42 } };
					},
				}),
		};
		const tool = new AskTool(createSession({ getAskAnswerSource: () => source }));
		const execution = tool
			.execute(
				"remote-commit-order",
				{ questions: [{ id: "confirm", question: "Proceed?", options: [{ label: "yes" }, { label: "no" }] }] },
				undefined,
				undefined,
				abortableUi(),
			)
			.then(result => {
				completed = true;
				return result;
			});
		await settlementStarted.promise;
		expect(completed).toBe(false);
		releaseSettlement.resolve();
		const result = await execution;
		expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain("yes");
	});

	for (const ack of [
		{ status: "failed" as const, reason: "telegram_rejected" as const },
		{ status: "unknown" as const, reason: "host_timeout" as const },
	]) {
		it(`preserves the accepted answer when visible acknowledgement is ${ack.status}`, async () => {
			let settlements = 0;
			const source: AskAnswerSource = {
				awaitAnswer: async () => undefined,
				awaitAnswerRequest: () =>
					Promise.resolve({
						source: "remote" as const,
						interaction: { kind: "value" as const, value: "yes" },
						settle: async settlement => {
							settlements++;
							expect(settlement).toEqual({ kind: "commit" });
							return { kind: "committed" as const, ack };
						},
					}),
			};
			const tool = new AskTool(createSession({ getAskAnswerSource: () => source }));
			const result = await tool.execute(
				`remote-commit-${ack.status}`,
				{ questions: [{ id: "confirm", question: "Proceed?", options: [{ label: "yes" }, { label: "no" }] }] },
				undefined,
				undefined,
				abortableUi(),
			);
			expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain("yes");
			expect(settlements).toBe(1);
		});
	}

	it("atomically selects a same-microtask remote selector receipt over the local value", async () => {
		const settlements: unknown[] = [];
		const source: AskAnswerSource = {
			awaitAnswer: async () => undefined,
			awaitAnswerRequest: () =>
				Promise.resolve({
					source: "remote" as const,
					interaction: { kind: "value" as const, value: "remote" },
					settle: async settlement => {
						settlements.push(settlement);
						return { kind: "committed" as const, ack: { status: "delivered" as const, messageId: 51 } };
					},
				}),
		};
		const result = await new AskTool(createSession({ getAskAnswerSource: () => source })).execute(
			"same-microtask-selector",
			{ questions: [{ id: "choice", question: "Choose", options: [{ label: "remote" }, { label: "local" }] }] },
			undefined,
			undefined,
			createContext({ select: () => Promise.resolve("local") }),
		);
		expect(result.details?.selectedOptions).toEqual(["remote"]);
		expect(settlements).toEqual([{ kind: "commit" }]);
	});

	it("atomically selects a same-microtask remote editor receipt over local text", async () => {
		const settlements: unknown[] = [];
		let requestCount = 0;
		const source: AskAnswerSource = {
			awaitAnswer: async () => undefined,
			awaitAnswerRequest: () => {
				if (requestCount++ === 0) return new Promise<AskRemoteReceipt | undefined>(() => {});
				return Promise.resolve({
					source: "remote" as const,
					interaction: { kind: "value" as const, value: "remote editor text" },
					settle: async settlement => {
						settlements.push(settlement);
						return { kind: "committed" as const, ack: { status: "delivered" as const, messageId: 52 } };
					},
				});
			},
		};
		const result = await new AskTool(createSession({ getAskAnswerSource: () => source })).execute(
			"same-microtask-editor",
			{ questions: [{ id: "choice", question: "Choose", options: [{ label: "yes" }, { label: "no" }] }] },
			undefined,
			undefined,
			createContext({
				select: (_prompt, options) => Promise.resolve(options[options.length - 1]),
				editor: () => Promise.resolve("local editor text"),
			}),
		);
		expect(result.details?.customInput).toBe("remote editor text");
		expect(settlements).toEqual([{ kind: "commit" }]);
	});

	it("settles a same-microtask remote toggle only after it wins the selector race", async () => {
		const settlements: unknown[] = [];
		let remoteCall = 0;
		let localCall = 0;
		const source: AskAnswerSource = {
			awaitAnswer: async () => undefined,
			awaitAnswerRequest: () => {
				const interaction =
					remoteCall++ === 0
						? { kind: "value" as const, value: "alpha" }
						: { kind: "control" as const, controlId: "navigation_forward" as const };
				return Promise.resolve({
					source: "remote" as const,
					interaction,
					settle: async settlement => {
						settlements.push(settlement);
						return settlement.kind === "commit"
							? { kind: "committed" as const, ack: { status: "delivered" as const, messageId: 53 } }
							: { kind: "resolved_without_commit" as const };
					},
				});
			},
		};
		const result = await new AskTool(createSession({ getAskAnswerSource: () => source })).execute(
			"same-microtask-toggle",
			{
				questions: [
					{ id: "choice", question: "Choose", multi: true, options: [{ label: "alpha" }, { label: "beta" }] },
				],
			},
			undefined,
			undefined,
			createContext({
				select: () => (localCall++ === 0 ? Promise.resolve("beta") : new Promise<string | undefined>(() => {})),
			}),
		);
		expect(result.details?.selectedOptions).toEqual(["alpha"]);
		expect(settlements).toEqual([{ kind: "resolve_without_commit", reason: "toggle" }, { kind: "commit" }]);
	});

	it("settles a same-microtask remote Other transition only after it wins", async () => {
		const settlements: unknown[] = [];
		let remoteCall = 0;
		const source: AskAnswerSource = {
			awaitAnswer: async () => undefined,
			awaitAnswerRequest: request => {
				const value =
					remoteCall++ === 0 ? request.options.find(option => option.includes("Other"))! : "remote custom text";
				return Promise.resolve({
					source: "remote" as const,
					interaction: { kind: "value" as const, value },
					settle: async settlement => {
						settlements.push(settlement);
						return settlement.kind === "commit"
							? { kind: "committed" as const, ack: { status: "delivered" as const, messageId: 54 } }
							: { kind: "resolved_without_commit" as const };
					},
				});
			},
		};
		const result = await new AskTool(createSession({ getAskAnswerSource: () => source })).execute(
			"same-microtask-other",
			{ questions: [{ id: "choice", question: "Choose", options: [{ label: "alpha" }, { label: "beta" }] }] },
			undefined,
			undefined,
			createContext({
				select: () => Promise.resolve("alpha"),
				editor: () => new Promise<string | undefined>(() => {}),
			}),
		);
		expect(result.details?.customInput).toBe("remote custom text");
		expect(settlements).toEqual([{ kind: "resolve_without_commit", reason: "other_transition" }, { kind: "commit" }]);
	});

	it("commits a real option whose label ends with the synthetic Other text", async () => {
		const label = "Deploy Other (type your own)";
		const settlements: unknown[] = [];
		const source: AskAnswerSource = {
			awaitAnswer: async () => undefined,
			awaitAnswerRequest: () =>
				Promise.resolve({
					source: "remote" as const,
					interaction: { kind: "value" as const, value: label },
					settle: async settlement => {
						settlements.push(settlement);
						return { kind: "committed" as const, ack: { status: "delivered" as const, messageId: 42 } };
					},
				}),
		};
		const result = await new AskTool(createSession({ getAskAnswerSource: () => source })).execute(
			"remote-sentinel-suffix",
			{ questions: [{ id: "choice", question: "Choose", options: [{ label }, { label: "Skip" }] }] },
			undefined,
			undefined,
			abortableUi(),
		);
		expect(settlements).toEqual([{ kind: "commit" }]);
		expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain(label);
	});

	it("aborts the remote leg and settles a late receipt after tool cancellation", async () => {
		const late = Promise.withResolvers<AskRemoteReceipt>();
		const settlement = vi.fn(async () => ({ kind: "resolved_without_commit" as const }));
		let remoteSignal: AbortSignal | undefined;
		const source: AskAnswerSource = {
			awaitAnswer: async () => undefined,
			awaitAnswerRequest: (_request, signal) => {
				remoteSignal = signal;
				return late.promise;
			},
		};
		const controller = new AbortController();
		const context = createContext({
			select: (_prompt, _options, dialogOptions) =>
				new Promise<string | undefined>((_resolve, reject) => {
					dialogOptions?.signal?.addEventListener(
						"abort",
						() => reject(new DOMException("Aborted", "AbortError")),
						{ once: true },
					);
					queueMicrotask(() => controller.abort());
				}),
		});
		const execution = new AskTool(createSession({ getAskAnswerSource: () => source })).execute(
			"remote-tool-abort",
			{ questions: [{ id: "choice", question: "Choose", options: [{ label: "yes" }] }] },
			controller.signal,
			undefined,
			context,
		);
		await expect(execution).rejects.toBeInstanceOf(ToolAbortError);
		expect(remoteSignal?.aborted).toBe(true);
		late.resolve({ source: "remote", interaction: { kind: "value", value: "yes" }, settle: settlement });
		await Promise.resolve();
		await Promise.resolve();
		expect(settlement).toHaveBeenCalledWith({ kind: "resolve_without_commit", reason: "aborted" });
	});

	it("settles multi-select toggles without acknowledgement and commits only Done", async () => {
		const requests: AskAnswerRequest[] = [];
		const settlements: unknown[] = [];
		let call = 0;
		const source: AskAnswerSource = {
			awaitAnswer: async () => undefined,
			awaitAnswerRequest: request => {
				requests.push(request);
				const interaction =
					call++ === 0
						? { kind: "value" as const, value: "alpha" }
						: { kind: "control" as const, controlId: "navigation_forward" as const };
				return Promise.resolve({
					source: "remote" as const,
					interaction,
					settle: async (settlement: unknown) => {
						settlements.push(settlement);
						return (settlement as { kind: string }).kind === "commit"
							? { kind: "committed" as const, ack: { status: "delivered" as const, messageId: 7 } }
							: { kind: "resolved_without_commit" as const };
					},
				});
			},
		};
		const tool = new AskTool(createSession({ getAskAnswerSource: () => source }));
		const result = await tool.execute(
			"remote-multi",
			{
				questions: [
					{
						id: "choices",
						question: "Choose",
						multi: true,
						recommended: 1,
						options: [{ label: "alpha" }, { label: "beta" }],
					},
				],
			},
			undefined,
			undefined,
			abortableUi(),
		);
		expect(requests[0]?.controls).toEqual([
			{ id: "navigation_forward", kind: "navigation", label: "Done", enabled: false },
		]);
		expect(requests[1]?.controls).toEqual([
			{ id: "navigation_forward", kind: "navigation", label: "Done", enabled: true },
		]);
		expect(requests.map(request => request.recommendedIndex)).toEqual([1, 1]);
		expect(settlements).toEqual([{ kind: "resolve_without_commit", reason: "toggle" }, { kind: "commit" }]);
		expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain("alpha");
	});
	it("omits invalid source recommendations from remote selector requests", async () => {
		for (const recommended of [-1, 0.5, 2]) {
			const requests: AskAnswerRequest[] = [];
			const source: AskAnswerSource = {
				awaitAnswer: async () => undefined,
				awaitAnswerRequest: request => {
					requests.push(request);
					return Promise.resolve({
						source: "remote" as const,
						interaction: { kind: "value" as const, value: "beta" },
						settle: async () => ({
							kind: "committed" as const,
							ack: { status: "delivered" as const, messageId: 7 },
						}),
					});
				},
			};
			const result = await new AskTool(createSession({ getAskAnswerSource: () => source })).execute(
				`remote-invalid-recommendation-${recommended}`,
				{
					questions: [
						{
							id: "choice",
							question: "Choose",
							recommended,
							options: [{ label: "alpha" }, { label: "beta" }],
						},
					],
				},
				undefined,
				undefined,
				abortableUi(),
			);
			expect(requests).toHaveLength(1);
			expect(requests[0]).not.toHaveProperty("recommendedIndex");
			expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain("beta");
		}
	});

	it("uses fresh receipts for Other and clarification transitions without acknowledgement", async () => {
		for (const mode of ["other", "clarification"] as const) {
			const requests: AskAnswerRequest[] = [];
			const settlements: unknown[] = [];
			let call = 0;
			const source: AskAnswerSource = {
				awaitAnswer: async () => undefined,
				awaitAnswerRequest: request => {
					requests.push(request);
					const first =
						mode === "other"
							? request.options.find(option => option.includes("Other"))!
							: request.options.find(option => option.includes("Ask about"))!;
					const interaction = {
						kind: "value" as const,
						value: call++ === 0 ? first : mode === "other" ? "custom text" : "what does this mean?",
					};
					return Promise.resolve({
						source: "remote" as const,
						interaction,
						settle: async (settlement: unknown) => {
							settlements.push(settlement);
							return (settlement as { kind: string }).kind === "commit"
								? { kind: "committed" as const, ack: { status: "delivered" as const, messageId: 9 } }
								: { kind: "resolved_without_commit" as const };
						},
					});
				},
			};
			const tool = new AskTool(createSession({ getAskAnswerSource: () => source }));
			await tool.execute(
				`remote-${mode}`,
				{
					questions: [
						{
							id: "q",
							question: mode === "clarification" ? "Round 1 | Scope | Ambiguity: 50%" : "Choose",
							options: [{ label: "alpha" }, { label: "beta" }],
							recommended: 1,
							deepInterview: mode === "clarification" ? deepInterviewMeta() : undefined,
						},
					],
				},
				undefined,
				undefined,
				abortableUi(),
			);
			expect(requests[1]?.interaction).toBe(mode === "other" ? "custom_editor" : "clarification_editor");
			expect(requests[0]?.recommendedIndex).toBe(1);
			expect(requests[1]).not.toHaveProperty("recommendedIndex");
			expect(settlements).toEqual(
				mode === "other"
					? [{ kind: "resolve_without_commit", reason: "other_transition" }, { kind: "commit" }]
					: [
							{ kind: "resolve_without_commit", reason: "clarification_transition" },
							{ kind: "resolve_without_commit", reason: "clarification_submitted" },
						],
			);
		}
	});

	it("advances an empty intermediate multi-question selection without acknowledgement", async () => {
		const settlements: unknown[] = [];
		let call = 0;
		const source: AskAnswerSource = {
			awaitAnswer: async () => undefined,
			awaitAnswerRequest: request => {
				if (call === 0)
					expect(request.controls).toEqual([
						{ id: "navigation_forward", kind: "navigation", label: "Next", enabled: true },
					]);
				const interaction =
					call++ === 0
						? { kind: "control" as const, controlId: "navigation_forward" as const }
						: { kind: "value" as const, value: "yes" };
				return Promise.resolve({
					source: "remote" as const,
					interaction,
					settle: async (settlement: unknown) => {
						settlements.push(settlement);
						return (settlement as { kind: string }).kind === "commit"
							? { kind: "committed" as const, ack: { status: "delivered" as const, messageId: 11 } }
							: { kind: "resolved_without_commit" as const };
					},
				});
			},
		};
		const tool = new AskTool(createSession({ getAskAnswerSource: () => source }));
		await tool.execute(
			"remote-empty-next",
			{
				questions: [
					{ id: "first", question: "Choose", multi: true, options: [{ label: "alpha" }] },
					{ id: "second", question: "Proceed?", options: [{ label: "yes" }, { label: "no" }] },
				],
			},
			undefined,
			undefined,
			abortableUi(),
		);
		expect(settlements).toEqual([{ kind: "resolve_without_commit", reason: "empty_navigation" }, { kind: "commit" }]);
	});
});
describe("AskTool custom input", () => {
	it("routes custom input through editor and preserves raw multiline strings", async () => {
		const tool = new AskTool(createSession());
		const abort = vi.fn();
		const multilineText = "first line\nsecond line";
		const editor = vi.fn(async () => multilineText);
		const questions = [
			{
				id: "details",
				question: "Share details",
				options: [{ label: "yes" }, { label: "no" }],
			},
		];
		const context = createContext({
			select: async () => "Other (type your own)",
			editor,
			abort,
		});

		const result = await tool.execute("call-editor-single", { questions }, undefined, undefined, context);
		expect(result.content[0]?.type).toBe("text");
		if (result.content[0]?.type !== "text") {
			throw new Error("Expected text result");
		}
		expect(result.content[0].text).toBe("User provided custom input:\n  first line\n  second line");
		expect(result.details?.customInput).toBe(multilineText);
		expect(result.details?.selectedOptions).toEqual([]);
		expect(editor).toHaveBeenCalledTimes(1);
		expect(abort).not.toHaveBeenCalled();
	});

	it("uses inline selector input for Other without opening the editor screen", async () => {
		const tool = new AskTool(createSession());
		const abort = vi.fn();
		const editor = vi.fn(async () => "editor text");
		const questions = [
			{
				id: "details",
				question: "Share details",
				options: [{ label: "yes" }, { label: "no" }],
			},
		];
		const context = createContext({
			select: async (_prompt, _options, dialogOptions) => {
				// Simulate the TUI selector collecting the text inline below the
				// option list, then resolving with the Other label.
				expect(dialogOptions?.customInput?.optionLabel).toBe("Other (type your own)");
				dialogOptions?.customInput?.onSubmit("inline answer");
				return "Other (type your own)";
			},
			editor,
			abort,
		});

		const result = await tool.execute("call-inline-single", { questions }, undefined, undefined, context);
		expect(result.details?.customInput).toBe("inline answer");
		expect(result.details?.selectedOptions).toEqual([]);
		expect(editor).not.toHaveBeenCalled();
		expect(abort).not.toHaveBeenCalled();
	});

	it("uses inline selector input for Other in multi-select questions", async () => {
		const tool = new AskTool(createSession());
		const abort = vi.fn();
		const editor = vi.fn(async () => "editor text");
		const questions = [
			{
				id: "details",
				question: "Share details",
				options: [{ label: "yes" }, { label: "no" }],
				multi: true,
			},
		];
		let call = 0;
		const context = createContext({
			select: async (_prompt, options, dialogOptions) => {
				call++;
				if (call === 1) {
					return options.find(option => option.includes("yes"));
				}
				dialogOptions?.customInput?.onSubmit("inline multi answer");
				return "Other (type your own)";
			},
			editor,
			abort,
		});

		const result = await tool.execute("call-inline-multi", { questions }, undefined, undefined, context);
		expect(result.details?.selectedOptions).toEqual(["yes"]);
		expect(result.details?.customInput).toBe("inline multi answer");
		expect(editor).not.toHaveBeenCalled();
		expect(abort).not.toHaveBeenCalled();
	});

	it("aborts when editor is cancelled in single-question flow", async () => {
		const tool = new AskTool(createSession());
		const abort = vi.fn();
		const editor = vi.fn(async () => undefined);
		const questions = [
			{
				id: "details",
				question: "Share details",
				options: [{ label: "yes" }, { label: "no" }],
			},
		];
		const context = createContext({
			select: async () => "Other (type your own)",
			editor,
			abort,
		});

		await expect(
			tool.execute("call-editor-cancel", { questions }, undefined, undefined, context),
		).rejects.toBeInstanceOf(ToolAbortError);
		expect(editor).toHaveBeenCalledTimes(1);
		expect(abort).toHaveBeenCalledTimes(1);
	});

	it("continues multi-question flow when editor is dismissed on a fresh question", async () => {
		const tool = new AskTool(createSession());
		const abort = vi.fn();
		const editor = vi.fn(async () => undefined);
		const questions = [
			{
				id: "first",
				question: "First?",
				options: [{ label: "one" }, { label: "two" }],
			},
			{
				id: "details",
				question: "Details?",
				options: [{ label: "short" }, { label: "long" }],
			},
		];
		const context = createContext({
			select: async prompt => {
				if (prompt.includes("First?")) return "one";
				if (prompt.includes("Details?")) return "Other (type your own)";
				return undefined;
			},
			editor,
			abort,
		});

		const result = await tool.execute("call-editor-multi-dismiss", { questions }, undefined, undefined, context);

		// Editor dismissed on "Details?" — flow continues with empty answer, not abort
		expect(result.details?.results?.[0]?.selectedOptions).toEqual(["one"]);
		expect(result.details?.results?.[1]?.selectedOptions).toEqual([]);
		expect(result.details?.results?.[1]?.customInput).toBeUndefined();
		expect(editor).toHaveBeenCalledTimes(1);
		expect(abort).not.toHaveBeenCalled();
	});

	it("surfaces external abort during editor mode as ToolAbortError", async () => {
		const tool = new AskTool(createSession());
		const abort = vi.fn();
		const controller = new AbortController();
		const editor = vi.fn(async (_title: string, _prefill?: string, dialogOptions?: { signal?: AbortSignal }) => {
			expect(dialogOptions?.signal).toBe(controller.signal);
			return await new Promise<string | undefined>((_resolve, reject) => {
				dialogOptions?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
					once: true,
				});
				queueMicrotask(() => controller.abort());
			});
		});
		const questions = [
			{
				id: "details",
				question: "Share details",
				options: [{ label: "yes" }, { label: "no" }],
			},
		];
		const context = createContext({
			select: async () => "Other (type your own)",
			editor,
			abort,
		});

		await expect(
			tool.execute("call-editor-abort", { questions }, controller.signal, undefined, context),
		).rejects.toBeInstanceOf(ToolAbortError);
		expect(editor).toHaveBeenCalledTimes(1);
		expect(abort).not.toHaveBeenCalled();
	});

	it("treats explicit empty-string custom input as submitted input", async () => {
		const tool = new AskTool(createSession());
		const abort = vi.fn();
		const editor = vi.fn(async () => "");
		const context = createContext({
			select: async () => "Other (type your own)",
			editor,
			abort,
		});

		const result = await tool.execute(
			"call-empty-custom",
			{
				questions: [
					{
						id: "details",
						question: "Share details",
						options: [{ label: "yes" }, { label: "no" }],
					},
				],
			},
			undefined,
			undefined,
			context,
		);

		expect(result.content[0]?.type).toBe("text");
		if (result.content[0]?.type !== "text") {
			throw new Error("Expected text result");
		}
		expect(result.content[0].text).toContain("User provided custom input:");
		expect(result.details?.customInput).toBe("");
		expect(result.details?.selectedOptions).toEqual([]);
		expect(editor).toHaveBeenCalledTimes(1);
		expect(abort).not.toHaveBeenCalled();
	});

	it("renders checked options together with custom text in multi-select answers", async () => {
		const tool = new AskTool(createSession());
		let step = 0;
		const editor = vi.fn(async () => "custom detail");
		const context = createContext({
			select: async (_prompt, options) => {
				if (step === 0) {
					step += 1;
					const alphaOption = options.find(option => option.endsWith("alpha"));
					if (!alphaOption) throw new Error("Missing alpha option");
					return alphaOption;
				}
				return "Other (type your own)";
			},
			editor,
		});

		const result = await tool.execute(
			"call-multi-custom-render",
			{
				questions: [
					{
						id: "multi",
						question: "Pick answers",
						options: [{ label: "alpha" }, { label: "beta" }],
						multi: true,
					},
				],
			},
			undefined,
			undefined,
			context,
		);

		expect(result.details?.selectedOptions).toEqual(["alpha"]);
		expect(result.details?.customInput).toBe("custom detail");
		expect(result.content[0]?.type).toBe("text");
		if (result.content[0]?.type !== "text") {
			throw new Error("Expected text result");
		}
		expect(result.content[0].text).toContain("alpha");
		expect(result.content[0].text).toContain("custom detail");

		const theme = await getThemeByName("red-claw");
		expect(theme).toBeDefined();
		const rendered = askToolRenderer.renderResult(result, { expanded: true, isPartial: false }, theme!);
		const renderedText = stripAnsi(rendered.render(120).join("\n"));
		expect(renderedText).toContain("alpha");
		expect(renderedText).toContain("custom detail");
	});

	it("preserves prior multi-select answers when custom editor is dismissed", async () => {
		const tool = new AskTool(createSession());
		let step = 0;
		const editor = vi.fn(async () => undefined);
		const context = createContext({
			select: async (_prompt, options) => {
				if (step === 0) {
					step += 1;
					const alphaOption = options.find(option => option.endsWith("alpha"));
					if (!alphaOption) throw new Error("Missing alpha option");
					return alphaOption;
				}
				return "Other (type your own)";
			},
			editor,
		});

		const result = await tool.execute(
			"call-multi-custom-dismiss",
			{
				questions: [
					{
						id: "multi",
						question: "Pick answers",
						options: [{ label: "alpha" }, { label: "beta" }],
						multi: true,
					},
				],
			},
			undefined,
			undefined,
			context,
		);

		expect(result.details?.selectedOptions).toEqual(["alpha"]);
		expect(result.details?.customInput).toBeUndefined();
		expect(result.content[0]?.type).toBe("text");
		if (result.content[0]?.type !== "text") {
			throw new Error("Expected text result");
		}
		expect(result.content[0].text).toContain("User selected: alpha");
		expect(editor).toHaveBeenCalledTimes(1);
	});

	it("fills the Other/custom-input editor from a remote free-text answer", async () => {
		let calls = 0;
		const source = {
			// 1st call = the select step (local picks Other); 2nd call = the editor step,
			// which a remote (e.g. Telegram) reply fills instead of blocking locally.
			awaitAnswer: (_q: string, _opts: string[], _signal?: AbortSignal) => {
				calls++;
				return calls === 1 ? new Promise<string | undefined>(() => {}) : Promise.resolve("remote typed answer");
			},
		};
		const tool = new AskTool(createSession({ getAskAnswerSource: () => source } as Partial<ToolSession>));
		const context = createContext({
			// Local selector picks the last entry — the "Other / type your own" option.
			select: (_prompt, options) => Promise.resolve(options[options.length - 1]),
			// Local editor never resolves; only the remote answer can complete it.
			editor: () => new Promise<string | undefined>(() => {}),
		});

		const result = await tool.execute(
			"call-remote-editor",
			{ questions: [{ id: "confirm", question: "Proceed?", options: [{ label: "yes" }, { label: "no" }] }] },
			undefined,
			undefined,
			context,
		);

		expect(result.details?.customInput).toBe("remote typed answer");
		if (result.content[0]?.type === "text") expect(result.content[0].text).toContain("remote typed answer");
	});
});

describe("AskTool option rendering", () => {
	it("wraps long single-question option labels without ellipsis", async () => {
		const theme = await getThemeByName("red-claw");
		expect(theme).toBeDefined();
		const longLabel =
			"Wrap this long option label across multiple indented lines so the entire choice remains visible to the user";
		const rendered = askToolRenderer.renderCall(
			{
				question: "Choose one",
				options: [{ label: longLabel }, { label: "short" }],
			},
			{ expanded: true, isPartial: false },
			theme!,
		);
		const lines = stripAnsi(rendered.render(44).join("\n")).split("\n");
		const renderedText = lines.join("\n");

		expect(renderedText).toContain("Wrap this long option label across");
		expect(renderedText).toContain("choice remains visible");
		expect(renderedText).not.toContain("...");
		expect(lines.some(line => /^\s{5,}multiple indented lines/.test(line))).toBe(true);
	});

	it("wraps long multi-question option labels under their option prefix", async () => {
		const theme = await getThemeByName("red-claw");
		expect(theme).toBeDefined();
		const longLabel =
			"Keep every multi question option fully readable by wrapping continuation text under the checkbox prefix";
		const rendered = askToolRenderer.renderCall(
			{
				questions: [
					{
						id: "render",
						question: "Choose one",
						options: [{ label: longLabel }, { label: "short" }],
					},
				],
			},
			{ expanded: true, isPartial: false },
			theme!,
		);
		const lines = stripAnsi(rendered.render(48).join("\n")).split("\n");
		const renderedText = lines.join("\n");

		expect(renderedText).toContain("Keep every multi question option fully");
		expect(renderedText).toContain("under the checkbox prefix");
		expect(renderedText).not.toContain("...");
		expect(lines.some(line => /^\s{8,}.*readable by wrapping/.test(line))).toBe(true);
	});
});

describe("AskTool multiline custom input rendering", () => {
	it("renders multiline custom answer as one block, not multiple checked items", async () => {
		const tool = new AskTool(createSession());
		const multilineText = "first line\nsecond line\nthird line";
		const editor = vi.fn(async () => multilineText);
		const context = createContext({
			select: async () => "Other (type your own)",
			editor,
		});

		const result = await tool.execute(
			"call-multiline-render",
			{
				questions: [
					{
						id: "details",
						question: "Share details",
						options: [{ label: "yes" }, { label: "no" }],
					},
				],
			},
			undefined,
			undefined,
			context,
		);

		expect(result.details?.customInput).toBe(multilineText);

		const theme = await getThemeByName("red-claw");
		expect(theme).toBeDefined();
		const rendered = askToolRenderer.renderResult(result, { expanded: true, isPartial: false }, theme!);
		const renderedText = stripAnsi(rendered.render(120).join("\n"));

		// All three lines should appear
		expect(renderedText).toContain("first line");
		expect(renderedText).toContain("second line");
		expect(renderedText).toContain("third line");

		// Count success icons — should be exactly one for the custom input block,
		// plus one for the question status icon (if present). The key contract is that
		// continuation lines do NOT get their own success icon.
		const successIconCount = (
			renderedText.match(new RegExp(theme!.status.success.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []
		).length;
		// One icon on the status line header + one on the custom input first line = 2 max
		expect(successIconCount).toBeLessThanOrEqual(2);

		// Ensure "second line" and "third line" are NOT preceded by a success icon on their own line
		const lines = renderedText.split("\n");
		for (const line of lines) {
			const trimmed = line.trim();
			if (trimmed.includes("second line") || trimmed.includes("third line")) {
				// These continuation lines must NOT start with a success icon
				expect(trimmed.startsWith(theme!.status.success)).toBe(false);
			}
		}
	});

	it("does not fabricate placeholder text for empty first-line custom input", async () => {
		const tool = new AskTool(createSession());
		const multilineText = "\nsecond line";
		const editor = vi.fn(async () => multilineText);
		const context = createContext({
			select: async () => "Other (type your own)",
			editor,
		});

		const result = await tool.execute(
			"call-leading-empty-line-render",
			{
				questions: [
					{
						id: "details",
						question: "Share details",
						options: [{ label: "yes" }, { label: "no" }],
					},
				],
			},
			undefined,
			undefined,
			context,
		);

		const theme = await getThemeByName("red-claw");
		expect(theme).toBeDefined();
		const rendered = askToolRenderer.renderResult(result, { expanded: true, isPartial: false }, theme!);
		const renderedText = stripAnsi(rendered.render(120).join("\n"));

		expect(renderedText).toContain("second line");
		expect(renderedText).not.toContain("(empty)");
	});
});

describe("AskTool multi-question navigation", () => {
	const questions = [
		{
			id: "first",
			question: "First?",
			options: [{ label: "one" }, { label: "two" }],
		},
		{
			id: "second",
			question: "Second?",
			options: [{ label: "alpha" }, { label: "beta" }],
		},
		{
			id: "third",
			question: "Third?",
			options: [{ label: "red" }, { label: "blue" }],
		},
	];

	it("keeps back unavailable on the first question and supports returning from later questions", async () => {
		const tool = new AskTool(createSession());
		const firstQuestionOptions: string[][] = [];
		let firstVisits = 0;
		let secondVisits = 0;
		const context = createContext({
			select: async (prompt, options, dialogOptions) => {
				if (prompt.includes("First?")) {
					firstQuestionOptions.push(options);
					firstVisits += 1;
					if (firstVisits === 1) return "one";
					dialogOptions?.onRight?.();
					return undefined;
				}
				if (prompt.includes("Second?")) {
					secondVisits += 1;
					if (secondVisits === 1) {
						dialogOptions?.onLeft?.();
						return undefined;
					}
					return "alpha";
				}
				dialogOptions?.onRight?.();
				return undefined;
			},
		});

		const result = await tool.execute("call-nav-1", { questions }, undefined, undefined, context);
		expect(result.details?.results?.[0]?.selectedOptions).toEqual(["one"]);
		expect(result.details?.results?.[1]?.selectedOptions).toEqual(["alpha"]);
		expect(firstQuestionOptions[0]).not.toContain("← Back");
		expect(firstQuestionOptions[1]).not.toContain("← Back");
	});

	it("allows forward action on the last question", async () => {
		const tool = new AskTool(createSession());
		const context = createContext({
			select: async (prompt, _options, dialogOptions) => {
				if (prompt.includes("First?")) return "one";
				if (prompt.includes("Second?")) return "alpha";
				dialogOptions?.onRight?.();
				return undefined;
			},
		});

		const result = await tool.execute("call-nav-2", { questions }, undefined, undefined, context);
		expect(result.details?.results?.[2]?.selectedOptions).toEqual([]);
		expect(result.details?.results?.[2]?.customInput).toBeUndefined();
	});

	it("persists state when changing an earlier answer and continuing", async () => {
		const tool = new AskTool(createSession());
		let firstVisits = 0;
		let secondVisits = 0;
		let thirdVisits = 0;
		const context = createContext({
			select: async (prompt, _options, dialogOptions) => {
				if (prompt.includes("First?")) {
					firstVisits += 1;
					if (firstVisits === 1) return "one";
					return "two";
				}
				if (prompt.includes("Second?")) {
					secondVisits += 1;
					if (secondVisits === 1) return "alpha";
					if (secondVisits === 2) {
						dialogOptions?.onLeft?.();
						return undefined;
					}
					dialogOptions?.onRight?.();
					return undefined;
				}
				if (prompt.includes("Third?")) {
					thirdVisits += 1;
					if (thirdVisits === 1) {
						dialogOptions?.onLeft?.();
						return undefined;
					}
					dialogOptions?.onRight?.();
					return undefined;
				}
				return undefined;
			},
		});

		const result = await tool.execute("call-nav-3", { questions }, undefined, undefined, context);
		expect(result.details?.results?.[0]?.selectedOptions).toEqual(["two"]);
		expect(result.details?.results?.[1]?.selectedOptions).toEqual(["alpha"]);
	});

	it("handles timeout with navigation and allows revisiting timed-out questions", async () => {
		const tool = new AskTool(
			createSession({
				settings: Settings.isolated({ "ask.timeout": 0.001 }),
			}),
		);
		let secondVisits = 0;
		let thirdVisits = 0;
		const context = createContext({
			select: async (prompt, _options, dialogOptions) => {
				if (prompt.includes("First?")) return "one";
				if (prompt.includes("Second?")) {
					secondVisits += 1;
					if (secondVisits === 1) {
						await Bun.sleep(5);
						dialogOptions?.onTimeout?.();
						return undefined;
					}
					return "beta";
				}
				if (prompt.includes("Third?")) {
					thirdVisits += 1;
					if (thirdVisits === 1) {
						dialogOptions?.onLeft?.();
						return undefined;
					}
					dialogOptions?.onRight?.();
					return undefined;
				}
				return undefined;
			},
		});

		const result = await tool.execute("call-nav-4", { questions }, undefined, undefined, context);
		expect(result.details?.results?.[0]?.selectedOptions).toEqual(["one"]);
		expect(result.details?.results?.[1]?.selectedOptions).toEqual(["beta"]);
		expect(result.details?.results?.[2]?.selectedOptions).toEqual([]);
	});
	it("preserves custom input when navigating back and forward", async () => {
		const tool = new AskTool(createSession());
		const multilineText = "line 1\nline 2";
		let detailVisits = 0;
		let summaryVisits = 0;
		const editor = vi.fn(async () => multilineText);
		const questions = [
			{
				id: "details",
				question: "Details?",
				options: [{ label: "short" }, { label: "long" }],
			},
			{
				id: "summary",
				question: "Summary?",
				options: [{ label: "one" }, { label: "two" }],
			},
		];
		const context = createContext({
			select: async (prompt, _options, dialogOptions) => {
				if (prompt.includes("Details?")) {
					detailVisits += 1;
					if (detailVisits === 1) return "Other (type your own)";
					dialogOptions?.onRight?.();
					return undefined;
				}
				if (prompt.includes("Summary?")) {
					summaryVisits += 1;
					if (summaryVisits === 1) {
						dialogOptions?.onLeft?.();
						return undefined;
					}
					return "two";
				}
				return undefined;
			},
			editor,
		});

		const result = await tool.execute("call-nav-multiline", { questions }, undefined, undefined, context);

		expect(result.details?.results?.[0]?.customInput).toBe(multilineText);
		expect(result.details?.results?.[1]?.selectedOptions).toEqual(["two"]);
		expect(editor).toHaveBeenCalledTimes(1);
	});

	it("preserves prior single-select answer when custom editor is dismissed during navigation", async () => {
		const tool = new AskTool(createSession());
		let detailVisits = 0;
		const editor = vi.fn(async () => undefined);
		const questions = [
			{
				id: "details",
				question: "Details?",
				options: [{ label: "short" }, { label: "long" }],
			},
			{
				id: "summary",
				question: "Summary?",
				options: [{ label: "one" }, { label: "two" }],
			},
		];
		const context = createContext({
			select: async (prompt, _options, dialogOptions) => {
				if (prompt.includes("Details?")) {
					detailVisits += 1;
					if (detailVisits === 1) return "short";
					// Second visit: try Other then dismiss editor, then forward
					if (detailVisits === 2) return "Other (type your own)";
					dialogOptions?.onRight?.();
					return undefined;
				}
				if (prompt.includes("Summary?")) {
					const summaryVisit = detailVisits;
					if (summaryVisit <= 2) {
						// Navigate back to re-visit details
						dialogOptions?.onLeft?.();
						return undefined;
					}
					return "two";
				}
				return undefined;
			},
			editor,
		});

		const result = await tool.execute("call-nav-single-dismiss", { questions }, undefined, undefined, context);

		// The prior selection "short" should survive the editor dismiss
		expect(result.details?.results?.[0]?.selectedOptions).toEqual(["short"]);
		expect(result.details?.results?.[0]?.customInput).toBeUndefined();
		expect(result.details?.results?.[1]?.selectedOptions).toEqual(["two"]);
		expect(editor).toHaveBeenCalledTimes(1);
	});
});

describe("AskTool deep-interview rendering middleware", () => {
	it("uses a readable selector prompt while preserving raw question details", async () => {
		const tool = new AskTool(createSession());
		const rawQuestion = [
			"Round 3 | Component: Review UI | Targeting: Success Criteria | Why now: the approval criteria are not yet testable | Ambiguity: 38%",
			"",
			"What exact conditions must be satisfied before a reviewer can approve an item?",
		].join("\n");
		const select = vi.fn(async (_prompt: string, options: string[]) => options[0]);
		const context = createContext({ select });

		const result = await tool.execute(
			"call-deep-interview",
			{
				questions: [
					{
						id: "round-3",
						question: rawQuestion,
						options: [{ label: "Condition A" }, { label: "Condition B" }],
					},
				],
			},
			undefined,
			undefined,
			context,
		);

		expect(select).toHaveBeenCalledTimes(1);
		expect(select.mock.calls[0]?.[1]).toEqual([
			"1. Condition A",
			"2. Condition B",
			"3. Other (type your own)",
			"4. Ask about these choices",
		]);
		const prompt = select.mock.calls[0]?.[0] ?? "";
		expect(prompt).toContain("Deep Interview · Round 3 · Ambiguity 38%");
		expect(prompt).toContain("Component: Review UI");
		expect(prompt).toContain("Target: Success Criteria");
		expect(prompt).toContain("Why now: the approval criteria are not yet testable");
		expect(prompt).toContain("What exact conditions must be satisfied before a reviewer can approve an item?");
		expect(result.details?.question).toBe(rawQuestion);
		expect(result.details?.options).toEqual(["Condition A", "Condition B"]);
		expect(result.details?.selectedOptions).toEqual(["Condition A"]);
		expect(result.content[0]).toMatchObject({ type: "text", text: "User selected: Condition A" });
	});

	it("does not double-number pre-numbered deep-interview options", async () => {
		const tool = new AskTool(createSession());
		const rawQuestion = [
			"Round 6 | Component: Review UI | Targeting: Success Criteria | Why now: answer labels might already be numbered | Ambiguity: 29%",
			"",
			"Which acceptance shape should be used?",
		].join("\n");
		const select = vi.fn(async (_prompt: string, options: string[]) => options[1]);
		const context = createContext({ select });

		const result = await tool.execute(
			"call-deep-interview-pre-numbered",
			{
				questions: [
					{
						id: "round-6",
						question: rawQuestion,
						options: [{ label: "1. Checklist" }, { label: "2) Scenario" }],
					},
				],
			},
			undefined,
			undefined,
			context,
		);

		expect(select.mock.calls[0]?.[1]).toEqual([
			"1. Checklist",
			"2) Scenario",
			"3. Other (type your own)",
			"4. Ask about these choices",
		]);
		expect(result.details?.selectedOptions).toEqual(["2) Scenario"]);
	});

	it("numbers loosely formatted deep-interview questions that are not structurally rendered", async () => {
		const tool = new AskTool(createSession());
		const rawQuestion = [
			"Round 7 | Component Review UI | Target Success Criteria | Why now option labels must remain scannable | Ambiguity is 34%",
			"",
			"What outcome proves the numbering is visible?",
		].join("\n");
		const select = vi.fn(async (_prompt: string, options: string[]) => options[0]);
		const context = createContext({ select });

		const result = await tool.execute(
			"call-deep-interview-loose",
			{
				questions: [
					{
						id: "round-7",
						question: rawQuestion,
						options: [{ label: "Numbered choices are visible" }, { label: "Raw answer labels are preserved" }],
					},
				],
			},
			undefined,
			undefined,
			context,
		);

		expect(select.mock.calls[0]?.[0]).toBe(rawQuestion);
		expect(select.mock.calls[0]?.[1]).toEqual([
			"1. Numbered choices are visible",
			"2. Raw answer labels are preserved",
			"3. Other (type your own)",
			"4. Ask about these choices",
		]);
		expect(result.details?.selectedOptions).toEqual(["Numbered choices are visible"]);
	});

	it("accepts the numbered deep-interview free-text option as custom input", async () => {
		const tool = new AskTool(createSession());
		const rawQuestion = [
			"Round 5 | Component: Review UI | Targeting: Constraints | Why now: boundaries are still unclear | Ambiguity: 31%",
			"",
			"Which boundary matters most?",
		].join("\n");
		const select = vi.fn(async (_prompt: string, options: string[]) => options[2]);
		const editor = vi.fn(async () => "Use my own boundary");
		const context = createContext({ select, editor });

		const result = await tool.execute(
			"call-deep-interview-other",
			{
				questions: [
					{
						id: "round-5",
						question: rawQuestion,
						options: [{ label: "Performance" }, { label: "Security" }],
					},
				],
			},
			undefined,
			undefined,
			context,
		);

		expect(select.mock.calls[0]?.[1]).toEqual([
			"1. Performance",
			"2. Security",
			"3. Other (type your own)",
			"4. Ask about these choices",
		]);
		expect(editor).toHaveBeenCalledTimes(1);
		expect(result.details?.selectedOptions).toEqual([]);
		expect(result.details?.customInput).toBe("Use my own boundary");
	});

	it("opts deep-interview selector prompts into local prompt scrolling", async () => {
		const tool = new AskTool(createSession());
		const rawQuestion = [
			"Round 4 | Component: Selector UI | Targeting: Readability | Why now: long prompts hide answers | Ambiguity: 44%",
			"",
			"What evidence proves the answer options remain visible while the question scrolls?",
		].join("\n");
		const select = vi.fn(
			async (_prompt: string, options: string[], _dialogOptions?: { scrollTitleRows?: number; helpText?: string }) =>
				options[0],
		);
		const context = createContext({ select });

		await tool.execute(
			"call-deep-interview-scroll",
			{
				questions: [
					{
						id: "round-4",
						question: rawQuestion,
						options: [{ label: "Visible options" }, { label: "Scrollable prompt" }],
					},
				],
			},
			undefined,
			undefined,
			context,
		);

		const dialogOptions = select.mock.calls[0]?.[2];
		expect(dialogOptions?.scrollTitleRows).toBe(Number.MAX_SAFE_INTEGER);
		expect(dialogOptions?.helpText).toContain("PgUp/PgDn/Ctrl+u/d: question");
		expect(dialogOptions?.helpText).toContain("Wheel: transcript");
	});

	it("opts structured deep-interview questions into local prompt scrolling", async () => {
		spyOn(deepInterviewRecorder, "appendOrMergeDeepInterviewRound").mockResolvedValue({
			action: "created",
			record: {} as AppendOrMergeResult["record"],
		});
		spyOn(deepInterviewRecorder, "syncDeepInterviewRecorderHud").mockResolvedValue(undefined);
		const tool = new AskTool(createSession({ getSessionId: () => "session-structured-scroll" }));
		const rawQuestion = [
			"The user-facing context is long enough that answer options can be pushed off screen.",
			"",
			"Which answer should prove the question area remains scrollable?",
		].join("\n");
		const select = vi.fn(
			async (_prompt: string, options: string[], _dialogOptions?: { scrollTitleRows?: number; helpText?: string }) =>
				options[0],
		);
		const context = createContext({ select });

		await tool.execute(
			"call-structured-deep-interview-scroll",
			{
				questions: [
					{
						id: "round-6",
						question: rawQuestion,
						options: [{ label: "Keep question scrolling" }, { label: "Regular selection" }],
						deepInterview: {
							round: 6,
							component: "Selector UI",
							dimension: "Readability",
							ambiguity: 0.41,
						},
					},
				],
			},
			undefined,
			undefined,
			context,
		);

		const dialogOptions = select.mock.calls[0]?.[2];
		expect(dialogOptions?.scrollTitleRows).toBe(Number.MAX_SAFE_INTEGER);
		expect(dialogOptions?.helpText).toContain("PgUp/PgDn/Ctrl+u/d: question");
		expect(dialogOptions?.helpText).toContain("Wheel: transcript");
	});

	it("Restate gate displays numbered selector labels while returning the raw selected label", async () => {
		spyOn(deepInterviewRecorder, "appendOrMergeDeepInterviewRound").mockResolvedValue({
			action: "created",
			record: {} as AppendOrMergeResult["record"],
		});
		spyOn(deepInterviewRecorder, "syncDeepInterviewRecorderHud").mockResolvedValue(undefined);
		const tool = new AskTool(createSession({ getSessionId: () => "session-restate-select" }));
		const select = vi.fn(
			async (_prompt: string, options: string[], _dialogOptions?: { scrollTitleRows?: number; helpText?: string }) =>
				options[0],
		);
		const context = createContext({ select });

		const result = await tool.execute(
			"call-restate-gate-select",
			{
				questions: [
					{
						id: "restate-gate",
						question: "If someone read only this line, would they know exactly what to build, avoid, and verify?",
						options: [{ label: "Yes, crystallize" }, { label: "Adjust wording" }, { label: "Missing scope" }],
						deepInterview: {
							round: 9,
							component: "Restate gate",
							dimension: "Confirmation",
							ambiguity: 0.17,
						},
					},
				],
			},
			undefined,
			undefined,
			context,
		);

		expect(select).toHaveBeenCalledTimes(1);
		const displayOptions = select.mock.calls[0]?.[1] ?? [];
		expect(displayOptions).toContain("1. Yes, crystallize");
		expect(displayOptions).toContain("2. Adjust wording");
		expect(displayOptions).toContain("3. Missing scope");
		const dialogOptions = select.mock.calls[0]?.[2];
		expect(dialogOptions?.scrollTitleRows).toBe(Number.MAX_SAFE_INTEGER);
		expect(result.details?.selectedOptions).toEqual(["Yes, crystallize"]);
		expect(result.details?.customInput).toBeUndefined();
	});

	it("Restate gate records inline custom input without selected options", async () => {
		spyOn(deepInterviewRecorder, "appendOrMergeDeepInterviewRound").mockResolvedValue({
			action: "created",
			record: {} as AppendOrMergeResult["record"],
		});
		spyOn(deepInterviewRecorder, "syncDeepInterviewRecorderHud").mockResolvedValue(undefined);
		const tool = new AskTool(createSession({ getSessionId: () => "session-restate-custom" }));
		const editor = vi.fn(async () => "editor fallback should not be used");
		const select = vi.fn(
			async (
				_prompt: string,
				options: string[],
				dialogOptions?: {
					scrollTitleRows?: number;
					helpText?: string;
					customInput?: { optionLabel: string; onSubmit: (text: string) => void };
				},
			) => {
				dialogOptions?.customInput?.onSubmit("Clarify the verification boundary before crystallizing.");
				return options[3];
			},
		);
		const context = createContext({ select, editor });

		const result = await tool.execute(
			"call-restate-gate-custom",
			{
				questions: [
					{
						id: "restate-gate",
						question: "If someone read only this line, would they know exactly what to build, avoid, and verify?",
						options: [{ label: "Yes, crystallize" }, { label: "Adjust wording" }, { label: "Missing scope" }],
						deepInterview: {
							round: 9,
							component: "Restate gate",
							dimension: "Confirmation",
							ambiguity: 0.17,
						},
					},
				],
			},
			undefined,
			undefined,
			context,
		);

		expect(select).toHaveBeenCalledTimes(1);
		expect(select.mock.calls[0]?.[1]).toContain("4. Other (type your own)");
		expect(select.mock.calls[0]?.[2]?.scrollTitleRows).toBe(Number.MAX_SAFE_INTEGER);
		expect(editor).not.toHaveBeenCalled();
		expect(result.details?.selectedOptions).toEqual([]);
		expect(result.details?.customInput).toBe("Clarify the verification boundary before crystallizing.");
	});

	it("returns deep-interview clarification as a non-answer and skips recorder writes", async () => {
		const recorder = spyOn(deepInterviewRecorder, "appendOrMergeDeepInterviewRound").mockResolvedValue({
			action: "created",
			record: {} as AppendOrMergeResult["record"],
		});
		spyOn(deepInterviewRecorder, "syncDeepInterviewRecorderHud").mockResolvedValue(undefined);
		const tool = new AskTool(createSession({ getSessionId: () => "session-clarification-inline" }));
		const editor = vi.fn(async () => "editor fallback should not be used");
		const select = vi.fn(
			async (
				_prompt: string,
				options: string[],
				dialogOptions?: {
					clarificationInput?: { optionLabel: string; onSubmit: (text: string) => void; allowEmpty?: boolean };
				},
			) => {
				expect(options).toContain("4. Ask about these choices");
				expect(dialogOptions?.clarificationInput?.optionLabel).toBe("4. Ask about these choices");
				expect(dialogOptions?.clarificationInput?.allowEmpty).toBe(false);
				dialogOptions?.clarificationInput?.onSubmit("What is the difference between Budget and Timeline?");
				return "4. Ask about these choices";
			},
		);
		const context = createContext({ select, editor });

		const result = await tool.execute(
			"call-deep-clarification-inline",
			{ questions: [singleDeepInterviewQuestion()] },
			undefined,
			undefined,
			context,
		);

		expect(result.details?.selectedOptions).toEqual([]);
		expect(result.details?.customInput).toBeUndefined();
		expect(result.details?.clarificationQuestion).toBe("What is the difference between Budget and Timeline?");
		expect(result.content[0]).toMatchObject({
			type: "text",
			text: "User asked a clarification question about the choices: What is the difference between Budget and Timeline?",
		});
		expect(editor).not.toHaveBeenCalled();
		expect(recorder).not.toHaveBeenCalled();
	});

	it("returns multi-select deep-interview clarification as unresolved even after a provisional pick", async () => {
		const recorder = spyOn(deepInterviewRecorder, "appendOrMergeDeepInterviewRound").mockResolvedValue({
			action: "created",
			record: {} as AppendOrMergeResult["record"],
		});
		const tool = new AskTool(createSession({ getSessionId: () => "session-clarification-multi" }));
		let step = 0;
		const select = vi.fn(
			async (
				_prompt: string,
				options: string[],
				dialogOptions?: {
					clarificationInput?: { optionLabel: string; onSubmit: (text: string) => void; allowEmpty?: boolean };
				},
			) => {
				step++;
				if (step === 1) {
					const budget = options.find(option => option.endsWith("Budget"));
					if (!budget) throw new Error("Missing Budget option");
					return budget;
				}
				const clarify = options.find(option => option.endsWith("Ask about these choices"));
				if (!clarify) throw new Error("Missing clarification option");
				dialogOptions?.clarificationInput?.onSubmit("Does Budget mean engineering time or money?");
				return clarify;
			},
		);
		const context = createContext({ select });

		const result = await tool.execute(
			"call-deep-clarification-multi",
			{ questions: [{ ...singleDeepInterviewQuestion(), multi: true }] },
			undefined,
			undefined,
			context,
		);

		expect(result.details?.selectedOptions).toEqual([]);
		expect(result.details?.customInput).toBeUndefined();
		expect(result.details?.clarificationQuestion).toBe("Does Budget mean engineering time or money?");
		expect(recorder).not.toHaveBeenCalled();
	});

	it("falls back to an editor for deep-interview clarification when inline input is unsupported", async () => {
		const recorder = spyOn(deepInterviewRecorder, "appendOrMergeDeepInterviewRound").mockResolvedValue({
			action: "created",
			record: {} as AppendOrMergeResult["record"],
		});
		const tool = new AskTool(createSession({ getSessionId: () => "session-clarification-editor" }));
		const editor = vi.fn(
			async (
				title: string,
				_prefill?: string,
				_dialogOptions?: unknown,
				editorOptions?: { promptStyle?: boolean },
			) => {
				expect(title).toBe("Ask a clarification question:");
				expect(editorOptions?.promptStyle).toBe(true);
				return "Which option keeps scope smallest?";
			},
		);
		const select = vi.fn(async (_prompt: string, options: string[]) => options[3]);
		const context = createContext({ select, editor });

		const result = await tool.execute(
			"call-deep-clarification-editor",
			{ questions: [singleDeepInterviewQuestion()] },
			undefined,
			undefined,
			context,
		);

		expect(result.details?.selectedOptions).toEqual([]);
		expect(result.details?.customInput).toBeUndefined();
		expect(result.details?.clarificationQuestion).toBe("Which option keeps scope smallest?");
		expect(editor).toHaveBeenCalledTimes(1);
		expect(recorder).not.toHaveBeenCalled();
	});

	it("leaves non-deep-interview selector prompts without scroll-title opt-in", async () => {
		const tool = new AskTool(createSession());
		const select = vi.fn(
			async (_prompt: string, options: string[], _dialogOptions?: { scrollTitleRows?: number; helpText?: string }) =>
				options[0],
		);
		const context = createContext({ select });

		await tool.execute(
			"call-normal-ask",
			{
				questions: [
					{
						id: "normal",
						question: "Which ordinary option should be selected?",
						options: [{ label: "A" }, { label: "B" }],
					},
				],
			},
			undefined,
			undefined,
			context,
		);

		const dialogOptions = select.mock.calls[0]?.[2];
		expect(dialogOptions?.scrollTitleRows).toBeUndefined();
		expect(dialogOptions?.helpText).not.toContain("scroll question");
	});

	it("recognizes topology questions even when the agent prepends an intro", async () => {
		const tool = new AskTool(createSession());
		const rawQuestion = [
			"Starting deep interview. I'll show a clarity score after each answer.",
			"",
			'**Your idea:** "Refresh the GJC UX"',
			"**Project type:** brownfield",
			"",
			"Round 0 | Topology confirmation | Ambiguity: not scored yet",
			"",
			"I'm currently reading the scope as these 2 top-level components.",
			"1. Brand and theme system: red-claw/GJC default theme and semantic color separation.",
			"2. Tool card UX: readability of ask/approval cards and tool output styling.",
			"",
			"Is that topology right? Should any component be added, removed, merged, split, or explicitly deferred?",
		].join("\n");
		const select = vi.fn(async (_prompt: string, options: string[]) => options[0]);
		const context = createContext({ select });

		await tool.execute(
			"call-deep-interview-topology",
			{
				questions: [
					{
						id: "round-0",
						question: rawQuestion,
						options: [{ label: "Looks right" }, { label: "Revise it" }],
					},
				],
			},
			undefined,
			undefined,
			context,
		);

		const prompt = select.mock.calls[0]?.[0] ?? "";
		expect(prompt).toContain("Deep Interview · Round 0 · Topology confirmation");
		expect(prompt).toContain("Ambiguity: not scored yet");
		expect(prompt).toContain("Reading:");
		expect(prompt).toContain("I'm currently reading the scope as these 2 top-level components.");
		expect(prompt).toContain("1. Brand and theme system — red-claw/GJC default theme and semantic color separation.");
		expect(prompt).toContain("Question:");
		expect(prompt).not.toContain("Context:");
		expect(prompt).not.toContain('**Your idea:** "Refresh the GJC UX"');
		expect(prompt).not.toContain("Round 0 | Topology confirmation");
	});

	it("renders round questions as structured cards in history", async () => {
		const theme = await getThemeByName("red-claw");
		expect(theme).toBeDefined();
		const rawQuestion = [
			"Round 2 | Component: Export | Targeting: Constraints | Why now: output boundaries are unclear | Ambiguity: 42%",
			"",
			"Which export formats are in scope?",
		].join("\n");

		const rendered = askToolRenderer.renderCall(
			{
				question: rawQuestion,
				options: [{ label: "CSV" }, { label: "PDF" }],
			},
			{ expanded: true, isPartial: false },
			theme!,
		);
		const renderedText = stripAnsi(rendered.render(100).join("\n"));

		expect(renderedText).toContain("Deep Interview · Round 2 · Ambiguity 42%");
		expect(renderedText).toContain("Component");
		expect(renderedText).toContain("Export");
		expect(renderedText).toContain("Why now");
		expect(renderedText).toContain("Question");
		expect(renderedText).toContain("1. CSV");
		expect(renderedText).toContain("2. PDF");
		expect(renderedText).not.toContain("Round 2 | Component:");
	});
});

describe("AskTool deep-interview recorder persistence", () => {
	it("swallows recorder rejection and preserves the selected answer", async () => {
		const warn = spyOn(logger, "warn").mockImplementation(() => {});
		const recorder = spyOn(deepInterviewRecorder, "appendOrMergeDeepInterviewRound").mockRejectedValue(
			new Error("recorder boom"),
		);
		const tool = new AskTool(createSession({ getSessionId: () => "session-ask" }));
		const context = createContext({ select: async (_prompt, options) => options[1] });

		const result = await tool.execute(
			"call-recorder-reject",
			{ questions: [singleDeepInterviewQuestion()] },
			undefined,
			undefined,
			context,
		);

		expect(result.content[0]).toMatchObject({ type: "text", text: "User selected: Timeline" });
		expect(result.details).toEqual({
			question: "Which constraint matters most?",
			options: ["Budget", "Timeline"],
			multi: false,
			selectedOptions: ["Timeline"],
			customInput: undefined,
		});
		expect(recorder).toHaveBeenCalledWith(
			"/tmp/test",
			expect.any(String),
			expect.objectContaining({
				round: 2,
				questionId: "q-deep",
				component: "Scope",
				dimension: "Constraints",
				ambiguity: 0.42,
				selectedOptions: ["Timeline"],
			}),
			{ sessionId: "session-ask" },
		);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("deep-interview round recording failed"));
	});

	it("does not synthesize or record intent authorization on ask timeout", async () => {
		const recorder = spyOn(deepInterviewRecorder, "appendOrMergeDeepInterviewRound").mockResolvedValue({
			action: "created",
			record: {} as AppendOrMergeResult["record"],
		});
		const tool = new AskTool(
			createSession({ settings: Settings.isolated({ "ask.timeout": 0.001 }), getSessionId: () => "session-ask" }),
		);
		const context = createContext({
			select: async (_prompt, _options, dialogOptions) => {
				const timeout = dialogOptions?.timeout ?? 1;
				await Bun.sleep(timeout + 5);
				dialogOptions?.onTimeout?.();
				return _options[0];
			},
		});
		const contractQuestion = {
			id: "intent-contract-timeout",
			question: "Confirm locked intent",
			options: [{ label: "Looks right" }, { label: "Revise" }],
			deepInterview: {
				round: 0,
				component: "review-topology",
				dimension: "topology",
				ambiguity: 1,
				intent_contract: {
					items: [{ id: "artifact:report", category: "artifact" as const, statement: "Produce report" }],
					confirmation_options: ["Looks right"],
				},
			},
		};
		const contractResult = await tool.execute(
			"intent-contract-timeout",
			{ questions: [contractQuestion] },
			undefined,
			undefined,
			context,
		);
		expect(contractResult.details?.selectedOptions).toEqual([]);
		const reviewQuestion = {
			id: "intent-review-timeout",
			question: "Approve reduction",
			options: [{ label: "Approve reduction" }, { label: "Revise" }],
			deepInterview: {
				round: 2,
				component: "locked-intent",
				dimension: "constraints",
				ambiguity: 0.2,
				intent_review: {
					observed_items: [{ id: "artifact:report", category: "artifact" as const, statement: "Produce report" }],
					supporting_substitutions: [
						{
							removed_id: "surface:review",
							replacement_ids: ["artifact:report"],
							rationale: "Report replacement",
						},
					],
					approval_options: ["Approve reduction"],
				},
			},
		};
		const reviewResult = await tool.execute(
			"intent-review-timeout",
			{ questions: [reviewQuestion] },
			undefined,
			undefined,
			context,
		);
		expect(reviewResult.details?.selectedOptions).toEqual([]);
		expect(recorder).not.toHaveBeenCalled();
	});

	it("discards focused intent choices before multi-question timeout navigation", async () => {
		const recorder = spyOn(deepInterviewRecorder, "appendOrMergeDeepInterviewRound").mockResolvedValue({
			action: "created",
			record: {} as AppendOrMergeResult["record"],
		});
		const tool = new AskTool(
			createSession({ settings: Settings.isolated({ "ask.timeout": 0.001 }), getSessionId: () => "session-ask" }),
		);
		let visits = 0;
		const context = createContext({
			select: async (_prompt, options, dialogOptions) => {
				visits += 1;
				if (visits === 1) {
					const timeout = dialogOptions?.timeout ?? 1;
					await Bun.sleep(timeout + 5);
					dialogOptions?.onTimeout?.();
				}
				return options[0];
			},
		});
		const result = await tool.execute(
			"intent-multi-timeout",
			{
				questions: [
					{
						id: "intent-contract-timeout",
						question: "Confirm locked intent",
						options: [{ label: "Looks right" }, { label: "Revise" }],
						deepInterview: {
							round: 0,
							component: "review-topology",
							dimension: "topology",
							ambiguity: 1,
							intent_contract: {
								items: [{ id: "artifact:report", category: "artifact", statement: "Produce report" }],
								confirmation_options: ["Looks right"],
							},
						},
					},
					{ id: "ordinary", question: "Continue?", options: [{ label: "Yes" }, { label: "No" }] },
				],
			},
			undefined,
			undefined,
			context,
		);
		expect(result.details?.results?.[0]?.selectedOptions).toEqual([]);
		expect(result.details?.results?.[1]?.selectedOptions).toEqual(["Yes"]);
		expect(recorder).not.toHaveBeenCalled();
	});

	it("times out a never-resolving recorder promise within the bounded await", async () => {
		const warn = spyOn(logger, "warn").mockImplementation(() => {});
		spyOn(deepInterviewRecorder, "appendOrMergeDeepInterviewRound").mockImplementation(
			() => new Promise(() => {}) as ReturnType<typeof deepInterviewRecorder.appendOrMergeDeepInterviewRound>,
		);
		const tool = new AskTool(createSession({ getSessionId: () => "session-ask" }));
		const context = createContext({ select: async (_prompt, options) => options[0] });
		const started = performance.now();

		const result = await tool.execute(
			"call-recorder-timeout",
			{ questions: [singleDeepInterviewQuestion()] },
			undefined,
			undefined,
			context,
		);

		expect(performance.now() - started).toBeLessThan(1000);
		expect(result.content[0]).toMatchObject({ type: "text", text: "User selected: Budget" });
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("timed out"));
	});

	it("swallows HUD sync failure after recorder write", async () => {
		const warn = spyOn(logger, "warn").mockImplementation(() => {});
		spyOn(deepInterviewRecorder, "appendOrMergeDeepInterviewRound").mockResolvedValue({
			action: "created",
			record: {} as Awaited<ReturnType<typeof deepInterviewRecorder.appendOrMergeDeepInterviewRound>>["record"],
		});
		spyOn(deepInterviewRecorder, "syncDeepInterviewRecorderHud").mockRejectedValue(new Error("hud boom"));
		const tool = new AskTool(createSession({ getSessionId: () => "session-ask" }));
		const context = createContext({ select: async (_prompt, options) => options[0] });

		const result = await tool.execute(
			"call-hud-reject",
			{ questions: [singleDeepInterviewQuestion()] },
			undefined,
			undefined,
			context,
		);

		expect(result.content[0]).toMatchObject({ type: "text", text: "User selected: Budget" });
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("deep-interview round recording failed"));
	});

	it("passes optional metadata for single, multi-question, and SDK workflow gate asks", async () => {
		const recorder = spyOn(deepInterviewRecorder, "appendOrMergeDeepInterviewRound").mockResolvedValue({
			action: "created",
			record: {} as Awaited<ReturnType<typeof deepInterviewRecorder.appendOrMergeDeepInterviewRound>>["record"],
		});
		spyOn(deepInterviewRecorder, "syncDeepInterviewRecorderHud").mockResolvedValue(undefined);

		await new AskTool(createSession({ getSessionId: () => "single-session" })).execute(
			"call-single-meta",
			{ questions: [singleDeepInterviewQuestion()] },
			undefined,
			undefined,
			createContext({ select: async (_prompt, options) => options[0] }),
		);

		await new AskTool(createSession({ getSessionId: () => "multi-session" })).execute(
			"call-multi-meta",
			{
				questions: [
					singleDeepInterviewQuestion(),
					{
						...singleDeepInterviewQuestion(),
						id: "q-deep-2",
						deepInterview: { ...deepInterviewMeta(), round: 3 },
					},
				],
			},
			undefined,
			undefined,
			createContext({ select: async (_prompt, options) => options[0] }),
		);

		const gateEmitter = {
			supportsRemoteGateAnswers: () => true,
			emitGate: vi.fn(async () => ({ selected: ["Timeline"] })),
		};
		await new AskTool(
			createSession({ hasUI: false, getSessionId: () => "gate-session", getWorkflowGateEmitter: () => gateEmitter }),
		).execute("call-gate-meta", { questions: [singleDeepInterviewQuestion()] }, undefined, undefined, undefined);

		expect(recorder).toHaveBeenCalledTimes(4);
		expect(recorder.mock.calls.map(call => call[2])).toEqual([
			expect.objectContaining({ round: 2, component: "Scope", dimension: "Constraints", ambiguity: 0.42 }),
			expect.objectContaining({ round: 2, component: "Scope", dimension: "Constraints", ambiguity: 0.42 }),
			expect.objectContaining({ round: 3, component: "Scope", dimension: "Constraints", ambiguity: 0.42 }),
			expect.objectContaining({ round: 2, component: "Scope", dimension: "Constraints", ambiguity: 0.42 }),
		]);
	});

	it("emits deep-interview question gates by default and honors ralplan approval overrides", async () => {
		const defaultGateEmitter = {
			supportsRemoteGateAnswers: () => true,
			emitGate: vi.fn(async () => ({ selected: ["Budget"] })),
		};
		await new AskTool(
			createSession({ hasUI: false, getWorkflowGateEmitter: () => defaultGateEmitter } as Partial<ToolSession>),
		).execute(
			"call-default-workflow-gate",
			{
				questions: [{ id: "confirm", question: "Proceed?", options: [{ label: "Budget" }, { label: "Timeline" }] }],
			},
			undefined,
			undefined,
			undefined,
		);

		expect(defaultGateEmitter.emitGate).toHaveBeenCalledWith(
			expect.objectContaining({ stage: "deep-interview", kind: "question" }),
		);

		const ralplanGateEmitter = {
			supportsRemoteGateAnswers: () => true,
			emitGate: vi.fn(async () => ({ selected: ["Approve execution via ultragoal"] })),
		};
		await new AskTool(
			createSession({ hasUI: false, getWorkflowGateEmitter: () => ralplanGateEmitter } as Partial<ToolSession>),
		).execute(
			"call-ralplan-workflow-gate",
			{
				questions: [
					{
						id: "final-approval",
						question: "Approve this plan?",
						options: [{ label: "Refine further" }, { label: "Approve execution via ultragoal" }],
						workflowGate: { stage: "ralplan", kind: "approval" },
					},
				],
			},
			undefined,
			undefined,
			undefined,
		);

		expect(ralplanGateEmitter.emitGate).toHaveBeenCalledWith(
			expect.objectContaining({ stage: "ralplan", kind: "approval" }),
		);
	});

	it("prefers the local interactive UI over the workflow gate when a UI context is present", async () => {
		// Regression: a durable workflow-gate emitter now exists for every session and
		// its supportsRemoteGateAnswers() is always true. Attended TUI asks must still use the local
		// selector instead of stranding on emitGate() waiting for a remote responder.
		const gateEmitter = {
			supportsRemoteGateAnswers: () => true,
			emitGate: vi.fn(async () => ({ selected: ["no"] })),
		};
		const select = vi.fn(async () => "yes");
		const context = createContext({ select });
		const result = await new AskTool(
			createSession({ getWorkflowGateEmitter: () => gateEmitter } as Partial<ToolSession>),
		).execute(
			"call-attended-no-gate",
			{ questions: [{ id: "confirm", question: "Proceed?", options: [{ label: "yes" }, { label: "no" }] }] },
			undefined,
			undefined,
			context,
		);
		expect(gateEmitter.emitGate).not.toHaveBeenCalled();
		expect(select).toHaveBeenCalledTimes(1);
		expect(result.details?.selectedOptions).toEqual(["yes"]);
	});

	function deepInterviewQuestionAtPayloadLength(length: number) {
		const question = singleDeepInterviewQuestion();
		question.question = "";
		const paddingLength = length - deepInterviewCharacterCount(JSON.stringify({ questions: [question] }));
		if (paddingLength < 0) throw new Error("deep-interview question base exceeds structured-response limit");
		question.question = "😀".repeat(paddingLength);
		if (deepInterviewCharacterCount(JSON.stringify({ questions: [question] })) !== length)
			throw new Error("unable to construct structured question boundary");
		return question;
	}

	it("accepts exactly 100000 structured question characters and rejects 100001 before gate or recorder advancement", async () => {
		const appendSpy = spyOn(deepInterviewRecorder, "appendOrMergeDeepInterviewRound").mockResolvedValue({
			action: "created",
			record: {} as AppendOrMergeResult["record"],
		});
		spyOn(deepInterviewRecorder, "syncDeepInterviewRecorderHud").mockResolvedValue(undefined);
		const gateEmitter = {
			supportsRemoteGateAnswers: () => true,
			emitGate: vi.fn(async () => ({ selected: ["Budget"] })),
		};
		const tool = new AskTool(
			createSession({
				hasUI: false,
				getSessionId: () => "test-session",
				getWorkflowGateEmitter: () => gateEmitter,
			} as Partial<ToolSession>),
		);
		const exact = deepInterviewQuestionAtPayloadLength(100_000);
		const oversized = deepInterviewQuestionAtPayloadLength(100_001);

		expect(deepInterviewCharacterCount(JSON.stringify({ questions: [exact] }))).toBe(100_000);
		await tool.execute("call-structured-limit-exact", { questions: [exact] }, undefined, undefined, undefined);
		expect(gateEmitter.emitGate).toHaveBeenCalledTimes(1);
		expect(appendSpy).toHaveBeenCalledTimes(1);

		expect(deepInterviewCharacterCount(JSON.stringify({ questions: [oversized] }))).toBe(100_001);
		await expect(
			tool.execute("call-structured-limit-oversized", { questions: [oversized] }, undefined, undefined, undefined),
		).rejects.toThrow("structured deep-interview response exceeds max length 100000");
		expect(gateEmitter.emitGate).toHaveBeenCalledTimes(1);
		expect(appendSpy).toHaveBeenCalledTimes(1);
	});

	it("bounds the complete legacy and multi-question ask payload before any gate emission", async () => {
		const gateEmitter = { supportsRemoteGateAnswers: () => true, emitGate: vi.fn(async () => ({ selected: ["A"] })) };
		const tool = new AskTool(
			createSession({ hasUI: false, getWorkflowGateEmitter: () => gateEmitter } as Partial<ToolSession>),
		);
		const payloadAtLength = (length: number) => {
			const questions = [
				{ id: "legacy", question: "", options: [{ label: "A" }] },
				{ id: "second", question: "Continue?", options: [{ label: "A" }] },
			];
			const overhead = deepInterviewCharacterCount(JSON.stringify({ questions }));
			questions[0]!.question = "한".repeat(length - overhead);
			return { questions };
		};
		const exact = payloadAtLength(100_000);
		const oversized = payloadAtLength(100_001);
		expect(deepInterviewCharacterCount(JSON.stringify(exact))).toBe(100_000);
		await tool.execute("call-legacy-aggregate-exact", exact, undefined, undefined, undefined);
		expect(gateEmitter.emitGate).toHaveBeenCalledTimes(2);
		expect(deepInterviewCharacterCount(JSON.stringify(oversized))).toBe(100_001);
		await expect(
			tool.execute("call-legacy-aggregate-oversized", oversized, undefined, undefined, undefined),
		).rejects.toThrow("structured deep-interview response exceeds max length 100000");
		expect(gateEmitter.emitGate).toHaveBeenCalledTimes(2);
	});

	it("forwards bounded inert adapter context through the canonical gate", async () => {
		const gateEmitter = {
			supportsRemoteGateAnswers: () => true,
			emitGate: vi.fn(async () => ({ selected: ["Continue"] })),
		};
		const adapterContext = {
			confused_terms: ["eventual consistency"],
			references: [
				{
					reference_id: "architecture-note",
					label: "Architecture note",
					origin: "user-provided",
					url: "https://example.test/architecture",
					excerpt: "Compare this design against the proposal.",
				},
			],
		};
		const tool = new AskTool(
			createSession({
				hasUI: false,
				getSessionId: () => "test-session",
				getWorkflowGateEmitter: () => gateEmitter,
			} as Partial<ToolSession>),
		);

		await tool.execute(
			"call-adapter-context",
			{
				questions: [
					{
						id: "adapter-context",
						question: "Which contrast should we explore?",
						options: [{ label: "Continue" }],
						deepInterview: { ...deepInterviewMeta(), ...adapterContext },
					},
				],
			},
			undefined,
			undefined,
			undefined,
		);

		const gate = (
			gateEmitter.emitGate.mock.calls as unknown as Array<[{ context: { stage_state: unknown } }]>
		)[0]?.[0];
		expect(gate?.context.stage_state).toMatchObject(adapterContext);
		expect(
			askSchema.safeParse({
				questions: [
					{
						id: "invalid-adapter-context",
						question: "Which contrast should we explore?",
						options: [{ label: "Continue" }],
						deepInterview: { ...deepInterviewMeta(), confused_terms: ["x".repeat(257)] },
					},
				],
			}).success,
		).toBe(false);
	});

	it("uses code-point limits for deep-interview metadata strings", () => {
		const metadata = { ...deepInterviewMeta(), component: "😀".repeat(128), dimension: "😀".repeat(128) };
		expect(
			askSchema.safeParse({
				questions: [
					{ id: "emoji-metadata", question: "Pick?", options: [{ label: "A" }], deepInterview: metadata },
				],
			}).success,
		).toBe(true);
		expect(
			askSchema.safeParse({
				questions: [
					{
						id: "oversized-emoji-metadata",
						question: "Pick?",
						options: [{ label: "A" }],
						deepInterview: { ...metadata, component: "😀".repeat(129) },
					},
				],
			}).success,
		).toBe(false);
	});

	it("keeps deepInterview optional and rejects malformed metadata", () => {
		expect(
			askSchema.safeParse({ questions: [{ id: "q", question: "Pick?", options: [{ label: "A" }] }] }).success,
		).toBe(true);
		expect(
			askSchema.safeParse({
				questions: [
					{
						id: "q",
						question: "Pick?",
						options: [{ label: "A" }],
						deepInterview: { round: "two", component: "Scope", dimension: "Constraints", ambiguity: 1.2 },
					},
				],
			}).success,
		).toBe(false);
	});

	it("preserves deep-interview intent branch and strict metadata validation", () => {
		const contract = {
			items: [{ id: "artifact:report", category: "artifact" as const, statement: "Produce report" }],
			confirmation_options: ["Confirm"],
		};
		const review = {
			observed_items: [{ id: "artifact:report", category: "artifact" as const, statement: "Produce report" }],
			supporting_substitutions: [],
			approval_options: ["Approve"],
		};
		const question = (deepInterview: Record<string, unknown>) => ({
			questions: [
				{ id: "q", question: "Pick?", options: [{ label: "Confirm" }, { label: "Approve" }], deepInterview },
			],
		});

		expect(
			askSchema.safeParse(
				question({
					round: 1,
					component: "review-topology",
					dimension: "topology",
					ambiguity: 0.5,
					intent_contract: contract,
				}),
			).success,
		).toBe(false);
		expect(
			askSchema.safeParse(
				question({
					round: 0,
					component: "review-topology",
					dimension: "topology",
					ambiguity: 0.5,
					intent_contract: contract,
					intent_review: review,
				}),
			).success,
		).toBe(false);
		expect(
			askSchema.safeParse(
				question({ round: 1, component: "Scope", dimension: "Constraints", ambiguity: 0.5, unexpected: true }),
			).success,
		).toBe(false);
	});
});

describe("AskTool Round-0 intent recovery", () => {
	function roundZeroPair(workflowGate?: Record<string, unknown>) {
		return {
			questions: [
				{
					id: "round-0-intent",
					question: "Confirm the locked intent",
					options: [{ label: "Looks right" }, { label: "Approve reduction" }, { label: "Revise" }],
					...(workflowGate === undefined ? {} : { workflowGate }),
					deepInterview: {
						round: 0,
						component: "review-topology",
						dimension: "topology",
						ambiguity: 1,
						intent_contract: {
							items: [{ id: "artifact:report", category: "artifact", statement: "Produce a report" }],
							confirmation_options: ["Looks right"],
						},
						intent_review: {
							observed_items: [{ id: "artifact:report", category: "artifact", statement: "Produce a report" }],
							supporting_substitutions: [],
							approval_options: ["Approve reduction"],
						},
					},
				},
			],
		};
	}

	function validateAsk(arguments_: Record<string, unknown>) {
		return validateToolArguments(new AskTool(createSession()), {
			type: "toolCall",
			id: "ask-round-0",
			name: "ask",
			arguments: arguments_,
		});
	}

	it("recovers only the canonical Round-0 pair and retains the contract", () => {
		const result = validateAsk(roundZeroPair());
		const deepInterview = (result.questions[0] as { deepInterview: Record<string, unknown> }).deepInterview;
		expect(deepInterview.intent_contract).toMatchObject({ confirmation_options: ["Looks right"] });
		expect(deepInterview.intent_review).toBeUndefined();
	});

	it("treats the explicit deep-interview question workflow gate as equivalent", () => {
		const result = validateAsk(roundZeroPair({ stage: "deep-interview", kind: "question" }));
		expect((result.questions[0] as { workflowGate: unknown }).workflowGate).toEqual({
			stage: "deep-interview",
			kind: "question",
		});
	});

	it("normalizes strict-provider null placeholders and preserves bounded adapter context before exact Round-0 recovery", () => {
		const pair = roundZeroPair();
		Object.assign(pair.questions[0], { multi: null, recommended: null, workflowGate: null });
		Object.assign(pair.questions[0].deepInterview, {
			round_id: null,
			confused_terms: ["eventual consistency"],
			references: [{ reference_id: "note", label: "Note", origin: "user", url: null, excerpt: null }],
		});
		const question = validateAsk(pair).questions[0];
		expect(question).toMatchObject({
			deepInterview: {
				intent_contract: expect.any(Object),
				confused_terms: ["eventual consistency"],
				references: [{ reference_id: "note" }],
			},
		});
		expect(question.deepInterview.references?.[0]).not.toHaveProperty("url");
		expect(question.deepInterview.references?.[0]).not.toHaveProperty("excerpt");
		expect(question.deepInterview).not.toHaveProperty("intent_review");
		expect(question.deepInterview).not.toHaveProperty("round_id");
		expect(question).not.toHaveProperty("multi");
		expect(question).not.toHaveProperty("recommended");
		expect(question).not.toHaveProperty("workflowGate");
	});

	it("normalizes a null optional deepInterview field on an ordinary ask", () => {
		const result = validateAsk({
			questions: [
				{
					id: "ordinary",
					question: "Choose one",
					options: [{ label: "First" }, { label: "Second" }],
					deepInterview: null,
				},
			],
		});

		expect(result.questions[0]).not.toHaveProperty("deepInterview");
	});

	it("terminally rejects every recovery-shaped near-miss before coercion", () => {
		const recorder = spyOn(deepInterviewRecorder, "appendOrMergeDeepInterviewRound");
		const gateEmitter = { supportsRemoteGateAnswers: () => true, emitGate: vi.fn() };
		const tool = new AskTool(
			createSession({ hasUI: false, getWorkflowGateEmitter: () => gateEmitter } as Partial<ToolSession>),
		);
		const execute = spyOn(tool, "execute");
		const validateCandidate = (arguments_: Record<string, unknown>) =>
			validateToolArguments(tool, {
				type: "toolCall",
				id: "ask-round-0-rejected",
				name: "ask",
				arguments: arguments_,
			});
		const prototypeRoot = Object.assign(Object.create({ inherited: true }), roundZeroPair());
		const prototypeQuestion = roundZeroPair();
		prototypeQuestion.questions[0] = Object.assign(
			Object.create({ inherited: true }),
			prototypeQuestion.questions[0],
		);
		const prototypeDeep = roundZeroPair();
		prototypeDeep.questions[0].deepInterview = Object.assign(
			Object.create({ inherited: true }),
			prototypeDeep.questions[0].deepInterview,
		);
		const extraRoot = { ...roundZeroPair(), extra: true };
		const extraQuestion = roundZeroPair();
		Object.assign(extraQuestion.questions[0], { extra: true });
		const extraDeep = roundZeroPair();
		Object.assign(extraDeep.questions[0].deepInterview, { extra: true });
		const duplicateOptions = roundZeroPair();
		duplicateOptions.questions[0].options = [{ label: "Looks right" }, { label: "Looks right" }];
		const ownUndefinedGate = roundZeroPair();
		ownUndefinedGate.questions[0].workflowGate = undefined;
		const reviewOnlyRoundZero = roundZeroPair();
		Reflect.deleteProperty(reviewOnlyRoundZero.questions[0].deepInterview, "intent_contract");
		const multipleQuestions = roundZeroPair();
		multipleQuestions.questions.push(structuredClone(multipleQuestions.questions[0]));
		const invalidLabels = roundZeroPair();
		invalidLabels.questions[0].deepInterview.intent_contract.confirmation_options = ["Looks right", "Looks right"];
		const encodedRoot = JSON.stringify(roundZeroPair()) as unknown as Record<string, unknown>;
		const encodedQuestions = roundZeroPair();
		encodedQuestions.questions = JSON.stringify(encodedQuestions.questions) as never;
		const encodedQuestion = roundZeroPair();
		encodedQuestion.questions[0] = JSON.stringify(encodedQuestion.questions[0]) as never;
		const encodedDeepInterview = roundZeroPair();
		encodedDeepInterview.questions[0].deepInterview = JSON.stringify(
			encodedDeepInterview.questions[0].deepInterview,
		) as never;
		const nullQuestions = { questions: null } as unknown as Record<string, unknown>;
		const malformedContractOnly = roundZeroPair();
		Reflect.deleteProperty(malformedContractOnly.questions[0].deepInterview, "intent_review");
		malformedContractOnly.questions[0].deepInterview.round = 1;
		const malformedReviewOnly = roundZeroPair();
		Reflect.deleteProperty(malformedReviewOnly.questions[0].deepInterview, "intent_contract");
		malformedReviewOnly.questions[0].deepInterview.round = 1;
		malformedReviewOnly.questions[0].deepInterview.component = "locked-intent";
		malformedReviewOnly.questions[0].deepInterview.dimension = "constraints";
		malformedReviewOnly.questions[0].deepInterview.intent_review.approval_options = ["Not displayed"];
		const sparseAdapterContext = roundZeroPair();
		Object.assign(sparseAdapterContext.questions[0].deepInterview, { confused_terms: new Array(1) });

		const invalidGates: unknown[] = [
			"deep-interview/question",
			[],
			{ stage: "deep-interview" },
			{ kind: "question" },
			{ stage: "deep-interview", kind: "question", extra: true },
			{ stage: "Deep-Interview", kind: "question" },
			{ stage: "deep-interview ", kind: "question" },
			{ stage: "ralplan", kind: "question" },
			{ stage: "ralplan", kind: "approval" },
			{ stage: "ultragoal", kind: "question" },
			{ stage: "ultragoal", kind: "execution" },
		];
		const malformedIntentMetadata: unknown[] = [null, "{}", [], { items: [] }, { items: [], extra: true }];

		for (const arguments_ of [
			prototypeRoot,
			prototypeQuestion,
			prototypeDeep,
			extraRoot,
			extraQuestion,
			extraDeep,
			duplicateOptions,
			ownUndefinedGate,
			reviewOnlyRoundZero,
			multipleQuestions,
			invalidLabels,
			encodedRoot,
			encodedQuestions,
			encodedQuestion,
			encodedDeepInterview,
			nullQuestions,
			malformedContractOnly,
			malformedReviewOnly,
			sparseAdapterContext,
		]) {
			expect(() => validateCandidate(arguments_)).toThrow("raw arguments rejected before coercion");
		}
		for (const workflowGate of invalidGates) {
			const pair = roundZeroPair();
			pair.questions[0].workflowGate = workflowGate as Record<string, unknown>;
			expect(() => validateCandidate(pair)).toThrow("raw arguments rejected before coercion");
		}
		for (const intentContract of malformedIntentMetadata) {
			const pair = roundZeroPair();
			pair.questions[0].deepInterview.intent_contract = intentContract as never;
			expect(() => validateCandidate(pair)).toThrow("raw arguments rejected before coercion");
		}
		for (const intentReview of malformedIntentMetadata) {
			const pair = roundZeroPair();
			pair.questions[0].deepInterview.intent_review = intentReview as never;
			expect(() => validateCandidate(pair)).toThrow("raw arguments rejected before coercion");
		}
		expect(execute).not.toHaveBeenCalled();
		expect(gateEmitter.emitGate).not.toHaveBeenCalled();
		expect(recorder).not.toHaveBeenCalled();
	});

	it("recovers the canonical pair once, emits its exact gate, and records only the contract", async () => {
		const recorder = spyOn(deepInterviewRecorder, "appendOrMergeDeepInterviewRound").mockResolvedValue({
			action: "created",
			record: {} as AppendOrMergeResult["record"],
		});
		spyOn(deepInterviewRecorder, "syncDeepInterviewRecorderHud").mockResolvedValue(undefined);
		const gateEmitter = {
			supportsRemoteGateAnswers: () => true,
			emitGate: vi.fn(async () => ({ selected: ["Looks right"] })),
		};
		const tool = new AskTool(
			createSession({ hasUI: false, getSessionId: () => "round-zero", getWorkflowGateEmitter: () => gateEmitter }),
		);
		const rawHook = spyOn(tool, "rawArgumentValidation");
		const execute = spyOn(tool, "execute");
		const recovered = askSchema.parse(
			validateToolArguments(tool, {
				type: "toolCall",
				id: "ask-round-0-recovered",
				name: "ask",
				arguments: roundZeroPair(),
			}),
		);

		await tool.execute("ask-round-0-recovered", recovered, undefined, undefined, undefined);

		expect(rawHook).toHaveBeenCalledTimes(1);
		expect(execute).toHaveBeenCalledTimes(1);
		expect(gateEmitter.emitGate).toHaveBeenCalledTimes(1);
		expect((gateEmitter.emitGate.mock.calls as unknown as Array<[unknown]>)[0]?.[0]).toMatchObject({
			stage: "deep-interview",
			kind: "question",
		});
		expect(recorder).toHaveBeenCalledTimes(1);
		expect(recorder.mock.calls[0]?.[2]).toMatchObject({
			intent_contract: { confirmation_options: ["Looks right"] },
			intent_review: undefined,
		});
	});

	it("leaves valid contract-only Round 0 and post-Round-0 review validation unchanged", () => {
		const contractOnly = roundZeroPair();
		Reflect.deleteProperty(contractOnly.questions[0].deepInterview, "intent_review");
		expect(validateAsk(contractOnly).questions[0]).toMatchObject({
			deepInterview: { intent_contract: expect.any(Object) },
		});
		const postRoundReview = roundZeroPair();
		Reflect.deleteProperty(postRoundReview.questions[0].deepInterview, "intent_contract");
		postRoundReview.questions[0].deepInterview.round = 1;
		postRoundReview.questions[0].deepInterview.component = "locked-intent";
		postRoundReview.questions[0].deepInterview.dimension = "constraints";
		expect(validateAsk(postRoundReview).questions[0]).toMatchObject({
			deepInterview: { intent_review: expect.any(Object) },
		});
	});
});
