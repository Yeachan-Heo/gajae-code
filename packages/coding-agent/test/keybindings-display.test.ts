import { describe, expect, it } from "bun:test";
import { KeybindingsManager } from "../src/config/keybindings";
import type { Extension, ExtensionRuntime } from "../src/extensibility/extensions";
import { ExtensionRunner } from "../src/extensibility/extensions";

describe("KeybindingsManager.getDisplayString", () => {
	it("formats a single binding as a human-readable key hint", () => {
		const keybindings = KeybindingsManager.inMemory({
			"app.message.dequeue": "alt+up",
		});

		expect(keybindings.getDisplayString("app.message.dequeue")).toBe("Alt+Up");
	});

	it("formats multiple bindings with the existing separator", () => {
		const keybindings = KeybindingsManager.inMemory({
			"app.clipboard.copyPrompt": ["alt+shift+c", "ctrl+shift+c"],
		});

		expect(keybindings.getDisplayString("app.clipboard.copyPrompt")).toBe("Alt+Shift+C/Ctrl+Shift+C");
	});

	it("returns an empty string when the action has no binding", () => {
		const keybindings = KeybindingsManager.inMemory({
			"app.clipboard.copyPrompt": [],
		});

		expect(keybindings.getDisplayString("app.clipboard.copyPrompt")).toBe("");
	});
});

describe("message keybinding defaults", () => {
	it("does not bind follow-up to Ctrl+Enter by default", () => {
		const keybindings = KeybindingsManager.inMemory();

		expect(keybindings.getKeys("app.message.followUp")).toEqual([]);
		expect(keybindings.getDisplayString("app.message.followUp")).toBe("");
		expect(keybindings.getDisplayString("app.message.queue")).toBe("Alt+Enter");
	});
});

describe("extension shortcut reservations", () => {
	it("keeps Ctrl+Enter reserved for composer newline", () => {
		const shortcut = {
			shortcut: "ctrl+enter" as const,
			description: "conflicting shortcut",
			handler: () => {},
			extensionPath: "test-extension",
		};
		const extension: Extension = {
			path: "test-extension",
			resolvedPath: "test-extension",
			handlers: new Map(),
			tools: new Map(),
			messageRenderers: new Map(),
			commands: new Map(),
			flags: new Map(),
			shortcuts: new Map([["ctrl+enter", shortcut]]),
		};
		const runtime = {
			flagValues: new Map(),
			pendingProviderRegistrations: [],
		} as unknown as ExtensionRuntime;
		const runner = new ExtensionRunner([extension], runtime, process.cwd(), {} as never, {} as never);

		expect(runner.getShortcuts().has("ctrl+enter")).toBe(false);
	});
});
