import { describe, expect, it, vi } from "bun:test";
import { defaultEditorTheme } from "../../tui/test/test-themes";
import { formatKeyHint } from "../src/config/keybindings";
import { CustomEditor } from "../src/modes/components/custom-editor";
import {
	createUnforwardedOptionChordWarner,
	macosOptionChordForComposedText,
	macosOptionForwardingInstruction,
} from "../src/modes/utils/macos-option-forwarding";

function editorWithQueueKey(queueKey: "alt+q" | "ctrl+q") {
	const editor = new CustomEditor(defaultEditorTheme);
	editor.setActionKeys("app.message.queue", [queueKey]);
	const onQueue = vi.fn();
	const onUnforwardedOptionChord = vi.fn();
	editor.onQueue = onQueue;
	editor.onUnforwardedOptionChord = onUnforwardedOptionChord;
	return { editor, onQueue, onUnforwardedOptionChord };
}

describe("macOS Option composition detection", () => {
	it("maps US/ABC Option compositions back to their chords", () => {
		expect(macosOptionChordForComposedText("œ")).toBe("alt+q");
		expect(macosOptionChordForComposedText("˙")).toBe("alt+h");
		expect(macosOptionChordForComposedText("π")).toBe("alt+p");
		expect(macosOptionChordForComposedText("q")).toBeUndefined();
		expect(macosOptionChordForComposedText("한")).toBeUndefined();
		expect(macosOptionChordForComposedText("œœ")).toBeUndefined();
	});

	it("reports a composed character for a bound Option chord and still inserts it", () => {
		const { editor, onQueue, onUnforwardedOptionChord } = editorWithQueueKey("alt+q");

		editor.handleInput("œ");

		expect(onQueue).not.toHaveBeenCalled();
		expect(onUnforwardedOptionChord).toHaveBeenCalledWith("alt+q", "œ");
		expect(editor.getText()).toBe("œ");
	});

	it("stays silent when the composed chord is not bound", () => {
		const { editor, onUnforwardedOptionChord } = editorWithQueueKey("ctrl+q");

		editor.handleInput("œ");

		expect(onUnforwardedOptionChord).not.toHaveBeenCalled();
		expect(editor.getText()).toBe("œ");
	});

	it("reports composed text for chords bound through custom key handlers", () => {
		const { editor, onUnforwardedOptionChord } = editorWithQueueKey("ctrl+q");
		editor.setCustomKeyHandler("alt+h", () => true);

		editor.handleInput("˙");

		expect(onUnforwardedOptionChord).toHaveBeenCalledWith("alt+h", "˙");
	});

	it("still fires the queue action when Option arrives as Meta", () => {
		const { editor, onQueue, onUnforwardedOptionChord } = editorWithQueueKey("alt+q");

		editor.handleInput("\x1bq");

		expect(onQueue).toHaveBeenCalledTimes(1);
		expect(onUnforwardedOptionChord).not.toHaveBeenCalled();
		expect(editor.getText()).toBe("");
	});
});

describe("createUnforwardedOptionChordWarner", () => {
	const formatDarwin = (key: string) => formatKeyHint(key, { platform: "darwin" });

	it("warns once per session with terminal-specific guidance", () => {
		const showWarning = vi.fn();
		const warn = createUnforwardedOptionChordWarner({
			platform: "darwin",
			terminalProgram: "ghostty",
			formatKeyHint: formatDarwin,
			showWarning,
		});

		warn?.("alt+q", "œ");
		warn?.("alt+q", "œ");

		expect(showWarning).toHaveBeenCalledTimes(1);
		const message = showWarning.mock.calls[0]![0] as string;
		expect(message).toContain(`${formatDarwin("alt+q")} arrived as "œ"`);
		expect(message).toContain("macos-option-as-alt = true");
		expect(message).toContain("keybindings.json");
	});

	it("falls back to generic guidance for unknown terminals", () => {
		const showWarning = vi.fn();
		createUnforwardedOptionChordWarner({
			platform: "darwin",
			terminalProgram: "WezTerm",
			formatKeyHint: formatDarwin,
			showWarning,
		})?.("alt+q", "œ");

		expect(showWarning.mock.calls[0]![0]).toContain("send Option as Alt/Meta");
	});

	it("is disabled off macOS, where the composition table does not apply", () => {
		const options = { terminalProgram: undefined, formatKeyHint: formatDarwin, showWarning: vi.fn() };
		expect(createUnforwardedOptionChordWarner({ ...options, platform: "linux" })).toBeUndefined();
		expect(createUnforwardedOptionChordWarner({ ...options, platform: "win32" })).toBeUndefined();
	});
});

describe("macosOptionForwardingInstruction", () => {
	it("names the setting for each known macOS terminal", () => {
		expect(macosOptionForwardingInstruction("ghostty")).toContain("macos-option-as-alt = true");
		expect(macosOptionForwardingInstruction("Apple_Terminal")).toContain("Use Option as Meta key");
		expect(macosOptionForwardingInstruction("iTerm.app")).toContain("Esc+");
		expect(macosOptionForwardingInstruction("WezTerm")).toBeUndefined();
		expect(macosOptionForwardingInstruction(undefined)).toBeUndefined();
	});
});
