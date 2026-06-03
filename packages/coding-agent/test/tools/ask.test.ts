import { beforeAll, describe, expect, it, vi } from "bun:test";
import type { AgentToolContext } from "@gajae-code/agent-core";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { getThemeByName, initTheme } from "@gajae-code/coding-agent/modes/theme/theme";
import type { ToolSession } from "@gajae-code/coding-agent/tools";
import { AskTool, askToolRenderer } from "@gajae-code/coding-agent/tools/ask";
import { ToolAbortError } from "@gajae-code/coding-agent/tools/tool-errors";

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
		const prompt = select.mock.calls[0]?.[0] ?? "";
		expect(prompt).toContain("Deep Interview · Round 3 · Ambiguity 38%");
		expect(prompt).toContain("Component: Review UI");
		expect(prompt).toContain("Target: Success Criteria");
		expect(prompt).toContain("Why now: the approval criteria are not yet testable");
		expect(prompt).toContain("What exact conditions must be satisfied before a reviewer can approve an item?");
		expect(result.details?.question).toBe(rawQuestion);
	});

	it("opts deep-interview selector prompts into local prompt scrolling", async () => {
		const tool = new AskTool(createSession());
		const rawQuestion = [
			"Round 4 | Component: Selector UI | Targeting: Readability | Why now: long prompts hide answers | Ambiguity: 44%",
			"",
			"What evidence proves the answer options remain visible while the question scrolls?",
		].join("\n");
		const select = vi.fn(async (_prompt: string, options: string[]) => options[0]);
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
		expect(dialogOptions?.scrollTitleRows).toBe(12);
		expect(dialogOptions?.helpText).toContain("PgUp/PgDn scroll question");
	});

	it("leaves non-deep-interview selector prompts without scroll-title opt-in", async () => {
		const tool = new AskTool(createSession());
		const select = vi.fn(async (_prompt: string, options: string[]) => options[0]);
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
		expect(dialogOptions?.helpText).not.toContain("PgUp/PgDn scroll question");
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
		expect(renderedText).not.toContain("Round 2 | Component:");
	});
});
