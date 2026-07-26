import { describe, expect, it } from "bun:test";
import { KeybindingsManager } from "../src/config/keybindings";
import { getComposerPlaceholder, getDefaultComposerPlaceholder } from "../src/modes/interactive-mode";

describe("composer placeholder", () => {
	it.each([
		["darwin", "⌥Q: Queue (busy) · ⇧⇥: Thinking · ⌃L: Model · ⌃R: History · ⇧↩/⌃J: New line · ⌃C: Clear"],
		[
			"win32",
			"Alt+Q: Queue (busy) · Shift+Tab: Thinking · Ctrl+L: Model · Ctrl+R: History · Alt+Enter/Ctrl+J: New line · Ctrl+C: Clear",
		],
		[
			"linux",
			"Alt+Enter: Queue (busy) · Shift+Tab: Thinking · Ctrl+L: Model · Ctrl+R: History · Shift+Enter/Ctrl+J: New line · Ctrl+C: Clear",
		],
	] as const)("formats platform defaults for %s independently of the host", (platform, expected) => {
		expect(getDefaultComposerPlaceholder({ platform })).toBe(`Type your message... ${expected}`);
	});

	it("uses effective remapped discovery bindings", () => {
		const keybindings = KeybindingsManager.inMemory({
			"app.history.search": "alt+h",
			"app.thinking.cycle": "ctrl+t",
			"app.model.select": "super+m",
			"app.message.queue": "ctrl+k",
		});

		expect(getDefaultComposerPlaceholder({ platform: "darwin" }, keybindings)).toBe(
			"Type your message... ⌃K: Queue (busy) · ⌃T: Thinking · ⌘M: Model · ⌥H: History · ⇧↩/⌃J: New line · ⌃C: Clear",
		);
		expect(
			getComposerPlaceholder(keybindings, { platform: "darwin" }, { busy: false, busyPromptMode: "steer" }),
		).toBe(
			"Type your message... ⌃K: Queue (busy) · ⌃T: Thinking · ⌘M: Model · ⌥H: History · ⇧↩/⌃J: New line · ⌃C: Clear",
		);
	});

	it("omits unbound discovery actions", () => {
		const keybindings = KeybindingsManager.inMemory({
			"app.history.search": [],
			"app.thinking.cycle": [],
			"app.model.select": [],
			"app.message.queue": [],
		});

		expect(getComposerPlaceholder(keybindings, { platform: "linux" }, { busy: false, busyPromptMode: "steer" })).toBe(
			"Type your message... Shift+Enter/Ctrl+J: New line · Ctrl+C: Clear",
		);
	});

	it("shows distinct submit and queue actions while busy in steer mode", () => {
		const keybindings = KeybindingsManager.inMemory({
			"app.message.queue": "alt+q",
			"tui.input.submit": "enter",
		});

		expect(getComposerPlaceholder(keybindings, { platform: "darwin" }, { busy: true, busyPromptMode: "steer" })).toBe(
			"Type your message... ↩: Steer · ⌥Q: Queue · ⇧⇥: Thinking · ⌃L: Model · ⌃R: History · ⇧↩/⌃J: New line · ⌃C: Clear",
		);
	});

	it("does not duplicate Queue when submit queues in busy queue mode", () => {
		const keybindings = KeybindingsManager.inMemory({
			"app.message.queue": "ctrl+k",
			"tui.input.submit": "enter",
		});

		expect(getComposerPlaceholder(keybindings, { platform: "darwin" }, { busy: true, busyPromptMode: "queue" })).toBe(
			"Type your message... ↩: Queue · ⇧⇥: Thinking · ⌃L: Model · ⌃R: History · ⇧↩/⌃J: New line · ⌃C: Clear",
		);
	});

	it("falls back to the dedicated queue binding when busy queue submit is unbound", () => {
		const keybindings = KeybindingsManager.inMemory({
			"app.message.queue": "ctrl+k",
			"tui.input.submit": [],
		});

		expect(getComposerPlaceholder(keybindings, { platform: "win32" }, { busy: true, busyPromptMode: "queue" })).toBe(
			"Type your message... Ctrl+K: Queue · Shift+Tab: Thinking · Ctrl+L: Model · Ctrl+R: History · Alt+Enter/Ctrl+J: New line · Ctrl+C: Clear",
		);
	});
});
