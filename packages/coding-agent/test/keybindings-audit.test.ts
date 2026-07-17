import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	defaultMessageQueueKeysForPlatform,
	defaultOppositeBusyModeKeysForPlatform,
	KEYBINDINGS,
} from "../src/config/keybindings";

const DOC_PATH = join(import.meta.dir, "../../../docs/keybindings.md");

describe("docs/keybindings.md current-surface audit", () => {
	it("documents every registry action ID (no drift)", () => {
		const doc = readFileSync(DOC_PATH, "utf8");
		const missing = Object.keys(KEYBINDINGS).filter(id => !doc.includes(`\`${id}\``));
		expect(missing).toEqual([]);
	});

	it("keeps follow-up and platform queue documentation aligned with the registry", () => {
		const doc = readFileSync(DOC_PATH, "utf8");

		expect(KEYBINDINGS["app.message.followUp"].description).toBe(
			"Send follow-up message (no default; Ctrl+Enter remains editor newline unless remapped)",
		);
		expect(defaultMessageQueueKeysForPlatform("darwin")).toBe("alt+q");
		expect(defaultMessageQueueKeysForPlatform("win32")).toBe("alt+q");
		expect(defaultMessageQueueKeysForPlatform("linux")).toBe("alt+enter");
		expect(defaultOppositeBusyModeKeysForPlatform("darwin")).toEqual(["super+enter"]);
		expect(defaultOppositeBusyModeKeysForPlatform("win32")).toEqual(["super+enter"]);
		expect(defaultOppositeBusyModeKeysForPlatform("linux")).toEqual(["super+enter"]);
		expect(KEYBINDINGS["app.message.oppositeBusyMode"].description).toBe(
			"Submit once using the opposite busy prompt mode",
		);
		expect(doc).toContain("| `app.message.queue` | `Alt+Enter` (`Alt+Q` on darwin/win32) |");
		expect(doc).toContain("| `app.message.queue` | alt+q (darwin/win32) / alt+enter (linux) |");
		expect(doc).toContain(
			"On macOS and native Windows terminals, GJC defaults `app.message.queue` to `Alt+Q`; other platforms use `Alt+Enter`.",
		);
		expect(doc).toContain(
			"| `app.message.followUp` | _(none)_ | Optional remap for a follow-up message; `Ctrl+Enter` is reserved for editor newline |",
		);
		expect(doc).toContain(
			"| `app.message.oppositeBusyMode` | `Command+Enter` (macOS) | Submit one message using the opposite of `busyPromptMode` |",
		);
		expect(doc).toContain(
			"configured `steer` queues that message, while configured `queue` steers it into the active turn.",
		);
	});
});
