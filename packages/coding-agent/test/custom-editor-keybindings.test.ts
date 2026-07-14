import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AutocompleteProvider } from "@gajae-code/tui";
import { defaultEditorTheme } from "../../tui/test/test-themes";
import { defaultMessageQueueKeysForPlatform, KEYBINDINGS } from "../src/config/keybindings";
import { CustomEditor } from "../src/modes/components/custom-editor";

function ctrl(key: string): string {
	return String.fromCharCode(key.toLowerCase().charCodeAt(0) & 31);
}

function inputForKey(key: string): string {
	switch (key) {
		case "alt+q":
			return "\x1bq";
		case "alt+enter":
			return "\x1b\r";
		default:
			throw new Error(`Unsupported test key: ${key}`);
	}
}

function createEditor() {
	return new CustomEditor(defaultEditorTheme);
}

afterEach(() => {
	vi.useRealTimers();
});

describe("CustomEditor command palette keybinding", () => {
	it("routes Ctrl+P to the command palette instead of model cycling", () => {
		const editor = createEditor();
		const onOpenCommandPalette = vi.fn();
		const onCycleModelForward = vi.fn();
		editor.onOpenCommandPalette = onOpenCommandPalette;
		editor.onCycleModelForward = onCycleModelForward;

		editor.handleInput(ctrl("p"));

		expect(onOpenCommandPalette).toHaveBeenCalledTimes(1);
		expect(onCycleModelForward).not.toHaveBeenCalled();
	});

	it("moves model cycling to Alt+N by default", () => {
		const editor = createEditor();
		const onCycleModelForward = vi.fn();
		editor.onCycleModelForward = onCycleModelForward;

		editor.handleInput("\x1bn");

		expect(KEYBINDINGS["app.model.cycleForward"].defaultKeys).toBe("alt+n");
		expect(onCycleModelForward).toHaveBeenCalledTimes(1);
	});

	it("opens the slash command autocomplete surface from an empty prompt", async () => {
		const editor = createEditor();
		editor.setAutocompleteProvider({
			async getSuggestions() {
				return { items: [{ value: "new", label: "new", description: "Start a new session" }], prefix: "/" };
			},
			applyCompletion(lines, cursorLine, cursorCol) {
				return { lines, cursorLine, cursorCol };
			},
		} satisfies AutocompleteProvider);
		editor.onOpenCommandPalette = () => editor.handleInput("/");

		editor.handleInput(ctrl("p"));
		await Bun.sleep(0);

		expect(editor.getText()).toBe("/");
		expect(editor.isShowingAutocomplete()).toBe(true);
	});
});

describe("CustomEditor temporary model selector keybinding", () => {
	it("triggers the temporary selector from a remapped action key instead of Alt+P", () => {
		const editor = createEditor();
		const onSelectModelTemporary = vi.fn();
		editor.onSelectModelTemporary = onSelectModelTemporary;
		editor.setActionKeys("app.model.selectTemporary", ["ctrl+y"]);

		editor.handleInput(ctrl("y"));
		expect(onSelectModelTemporary).toHaveBeenCalledTimes(1);

		editor.handleInput("\x1bp");
		expect(onSelectModelTemporary).toHaveBeenCalledTimes(1);
	});

	it("removes the default Alt+P shortcut when the action is disabled", () => {
		const editor = createEditor();
		const onSelectModelTemporary = vi.fn();
		editor.onSelectModelTemporary = onSelectModelTemporary;

		editor.handleInput("\x1bp");
		expect(onSelectModelTemporary).toHaveBeenCalledTimes(1);

		editor.setActionKeys("app.model.selectTemporary", []);
		editor.handleInput("\x1bp");
		expect(onSelectModelTemporary).toHaveBeenCalledTimes(1);
	});
});

describe("CustomEditor queue keybinding", () => {
	it("triggers explicit queue from the configured action key", () => {
		const editor = createEditor();
		const onQueue = vi.fn();
		editor.onQueue = onQueue;

		editor.handleInput(inputForKey(defaultMessageQueueKeysForPlatform()));

		expect(onQueue).toHaveBeenCalledTimes(1);
		expect(editor.getText()).toBe("");
	});

	it("triggers explicit queue from legacy Alt+LF terminals", () => {
		const editor = createEditor();
		const onQueue = vi.fn();
		editor.onQueue = onQueue;
		editor.setActionKeys("app.message.queue", ["alt+enter"]);

		editor.handleInput("\x1b\n");

		expect(onQueue).toHaveBeenCalledTimes(1);
		expect(editor.getText()).toBe("");
	});

	it("keeps Ctrl+Enter as a multiline newline chord", () => {
		const editor = createEditor();
		const onQueue = vi.fn();
		const onSubmit = vi.fn();
		editor.onQueue = onQueue;
		editor.onSubmit = onSubmit;

		editor.handleInput("a");
		editor.handleInput("\x1b[13;5u");

		expect(onQueue).not.toHaveBeenCalled();
		expect(onSubmit).not.toHaveBeenCalled();
		expect(editor.getText()).toBe("a\n");
	});

	it("keeps macOS Option+Enter legacy CR sequence as newline when queue uses Alt+Q", () => {
		const editor = createEditor();
		const onQueue = vi.fn();
		const onSubmit = vi.fn();
		editor.onQueue = onQueue;
		editor.onSubmit = onSubmit;
		editor.setActionKeys("app.message.queue", [defaultMessageQueueKeysForPlatform("darwin")]);

		editor.handleInput("a");
		editor.handleInput("\x1b\r");

		expect(onQueue).not.toHaveBeenCalled();
		expect(onSubmit).not.toHaveBeenCalled();
		expect(editor.getText()).toBe("a\n");
	});

	it("submits plain Enter", () => {
		const editor = createEditor();
		const onSubmit = vi.fn();
		editor.onSubmit = onSubmit;

		editor.handleInput("a");
		editor.handleInput("\r");

		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit).toHaveBeenCalledWith("a");
		expect(editor.getText()).toBe("");
	});

	it("keeps Ctrl+Enter as newline without routing slash command completion", () => {
		const editor = createEditor();
		const onSubmit = vi.fn();
		editor.onSubmit = onSubmit;
		editor.setAutocompleteProvider({
			async getSuggestions() {
				return null;
			},
			applyCompletion(_lines, cursorLine, _cursorCol, _item, _prefix) {
				return { lines: ["/model"], cursorLine, cursorCol: "/model".length };
			},
			trySyncSlashCompletion(textBeforeCursor) {
				return textBeforeCursor === "/mo" ? { items: [{ value: "/model", label: "/model" }], prefix: "/mo" } : null;
			},
		} satisfies AutocompleteProvider);

		editor.handleInput("/mo");
		editor.handleInput("\x1b[13;5u");

		expect(onSubmit).not.toHaveBeenCalled();
		expect(editor.getText()).toBe("/mo\n");
	});

	it("keeps Shift+Enter as the multiline newline chord", () => {
		const editor = createEditor();
		const onSubmit = vi.fn();
		editor.onSubmit = onSubmit;

		editor.handleInput("a");
		editor.handleInput("\x1b[13;2u");
		editor.handleInput("b");

		expect(onSubmit).not.toHaveBeenCalled();
		expect(editor.getText()).toBe("a\nb");
	});

	it("supports remapping the explicit queue key when Alt+Enter is unavailable", () => {
		const editor = createEditor();
		const onQueue = vi.fn();
		editor.onQueue = onQueue;
		editor.setActionKeys("app.message.queue", ["alt+q"]);

		editor.handleInput("\x1b\r");
		expect(onQueue).not.toHaveBeenCalled();

		editor.handleInput("\x1bq");
		expect(onQueue).toHaveBeenCalledTimes(1);
	});
});
describe("CustomEditor viewport paging", () => {
	it("routes PageUp and PageDown to transcript scrolling instead of prompt history", () => {
		const editor = createEditor();
		const onViewportPageScroll = vi.fn((_direction: -1 | 1) => undefined);
		editor.onViewportPageScroll = onViewportPageScroll;
		editor.addToHistory("previous prompt");

		editor.handleInput("\x1b[5~");
		editor.handleInput("\x1b[6~");

		expect(onViewportPageScroll).toHaveBeenNthCalledWith(1, -1);
		expect(onViewportPageScroll).toHaveBeenNthCalledWith(2, 1);
		expect(editor.getText()).toBe("");
	});

	it("keeps PageUp and PageDown available to autocomplete lists", async () => {
		const editor = createEditor();
		const onViewportPageScroll = vi.fn((_direction: -1 | 1) => undefined);
		editor.onViewportPageScroll = onViewportPageScroll;
		editor.setAutocompleteProvider({
			async getSuggestions() {
				return {
					items: [
						{ value: "alpha", label: "alpha" },
						{ value: "beta", label: "beta" },
					],
					prefix: "/",
				};
			},
			applyCompletion(lines, cursorLine, cursorCol) {
				return { lines, cursorLine, cursorCol };
			},
		} satisfies AutocompleteProvider);

		editor.handleInput("/");
		await Bun.sleep(0);
		editor.handleInput("\x1b[5~");
		editor.handleInput("\x1b[6~");

		expect(editor.isShowingAutocomplete()).toBe(true);
		expect(onViewportPageScroll).not.toHaveBeenCalled();
	});

	it("returns the transcript viewport to live output before regular input", () => {
		const editor = createEditor();
		const onViewportFollowLive = vi.fn();
		editor.onViewportFollowLive = onViewportFollowLive;

		editor.handleInput("a");

		expect(onViewportFollowLive).toHaveBeenCalledTimes(1);
		expect(editor.getText()).toBe("a");
	});
});

describe("CustomEditor pasteImage default sourced from KEYBINDINGS", () => {
	it("intercepts the registry's platform-aware pasteImage default (single source of truth)", () => {
		const editor = createEditor();
		const onPasteImage = vi.fn();
		editor.onPasteImage = onPasteImage;

		const def = KEYBINDINGS["app.clipboard.pasteImage"].defaultKeys;
		const key = Array.isArray(def) ? def[0]! : def;
		// ctrl+v on most platforms, alt+v on win32 — both come from the registry now.
		const data = key === "alt+v" ? "\x1bv" : ctrl("v");

		editor.handleInput(data);
		expect(onPasteImage).toHaveBeenCalledTimes(1);
	});
});

describe("CustomEditor bracketed paste interception", () => {
	it("lets coding-agent consume pasted content before the base editor stores it", async () => {
		const editor = createEditor();
		const onPasteText = vi.fn(() => true);
		editor.onPasteText = onPasteText;

		editor.handleInput("\x1b[200~/tmp/clipboard-2026-06-04-120441-CAC144E7.png\x1b[201~");
		await Bun.sleep(0);

		expect(onPasteText).toHaveBeenCalledWith("/tmp/clipboard-2026-06-04-120441-CAC144E7.png");
		expect(editor.getText()).toBe("");
	});

	it("falls back to normal paste handling when coding-agent does not consume it", async () => {
		const editor = createEditor();
		const onPasteText = vi.fn(() => false);
		editor.onPasteText = onPasteText;

		editor.handleInput("\x1b[200~hello\x1b[201~");
		await Bun.sleep(0);

		expect(onPasteText).toHaveBeenCalledWith("hello");
		expect(editor.getText()).toBe("hello");
	});

	it("follows live before dispatching an async consumed paste and replays later input afterward", async () => {
		const editor = createEditor();
		const pasteDecision = Promise.withResolvers<boolean>();
		const trace: string[] = [];
		editor.handleInput("before ");
		editor.onViewportFollowLive = () => trace.push("follow");
		editor.onPasteText = () => {
			trace.push("paste");
			return pasteDecision.promise;
		};

		editor.handleInput("\x1b[200~/tmp/clipboard-2026-06-04-120441-CAC144E7.png\x1b[201~");
		editor.handleInput("after");

		expect(editor.getText()).toBe("before ");
		expect(trace).toEqual(["follow", "paste"]);

		pasteDecision.resolve(true);
		await Bun.sleep(0);

		expect(editor.getText()).toBe("before after");
		expect(trace).toEqual(["follow", "paste", "follow"]);
	});

	it("follows live before dispatching an async unconsumed paste and replays paste before later input", async () => {
		const editor = createEditor();
		const pasteDecision = Promise.withResolvers<boolean>();
		const trace: string[] = [];
		editor.handleInput("before ");
		editor.onViewportFollowLive = () => trace.push("follow");
		editor.onPasteText = () => {
			trace.push("paste");
			return pasteDecision.promise;
		};

		editor.handleInput("\x1b[200~middle \x1b[201~");
		editor.handleInput("after");

		expect(editor.getText()).toBe("before ");
		expect(trace).toEqual(["follow", "paste"]);

		pasteDecision.resolve(false);
		await Bun.sleep(0);

		expect(editor.getText()).toBe("before middle after");
		expect(trace).toEqual(["follow", "paste", "follow"]);
	});

	it("drops queued input and ignores late async paste decisions after timeout", async () => {
		vi.useFakeTimers();
		const editor = createEditor();
		const pasteDecision = Promise.withResolvers<boolean>();
		const onPastePendingInputCleared = vi.fn();
		editor.onPasteText = vi.fn(() => pasteDecision.promise);
		editor.onPastePendingInputCleared = onPastePendingInputCleared;

		editor.handleInput("before ");
		editor.handleInput("\x1b[200~middle \x1b[201~");
		editor.handleInput("after");

		expect(editor.getText()).toBe("before ");

		vi.advanceTimersByTime(5_000);
		expect(onPastePendingInputCleared).toHaveBeenCalledWith("timeout", 1);

		pasteDecision.resolve(false);
		await Promise.resolve();

		expect(editor.getText()).toBe("before ");
	});

	it("bounds the async paste input queue and clears pending state", async () => {
		const editor = createEditor();
		const pasteDecision = Promise.withResolvers<boolean>();
		const onPastePendingInputCleared = vi.fn();
		editor.onPasteText = vi.fn(() => pasteDecision.promise);
		editor.onPastePendingInputCleared = onPastePendingInputCleared;

		editor.handleInput("before ");
		editor.handleInput("\x1b[200~middle \x1b[201~");
		for (let index = 0; index < 65; index += 1) {
			editor.handleInput(`queued-${index} `);
		}

		expect(onPastePendingInputCleared).toHaveBeenCalledWith("queue-limit", 65);
		expect(editor.getText()).toBe("before ");

		pasteDecision.resolve(false);
		await Bun.sleep(0);

		expect(editor.getText()).toBe("before ");
	});

	it("clears pending async paste state when disposed", async () => {
		const editor = createEditor();
		const pasteDecision = Promise.withResolvers<boolean>();
		editor.onPasteText = vi.fn(() => pasteDecision.promise);

		editor.handleInput("before ");
		editor.handleInput("\x1b[200~middle \x1b[201~");
		editor.handleInput("after");
		editor.dispose();

		pasteDecision.resolve(false);
		await Bun.sleep(0);

		expect(editor.getText()).toBe("before ");
	});
});
