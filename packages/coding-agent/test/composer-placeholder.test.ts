import { describe, expect, it } from "bun:test";
import { getDefaultComposerPlaceholder } from "../src/modes/interactive-mode";

describe("composer placeholder", () => {
	it.each([
		["darwin", "⇧↩/⌃J: New line · ⌃C: Clear · ⌃R: Search history · ⇧⇥: Reasoning"],
		["win32", "Alt+Enter/Ctrl+J: New line · Ctrl+C: Clear · Ctrl+R: Search history · Shift+Tab: Reasoning"],
		["linux", "Shift+Enter/Ctrl+J: New line · Ctrl+C: Clear · Ctrl+R: Search history · Shift+Tab: Reasoning"],
	] as const)("formats canonical idle shortcuts for %s", (platform, expected) => {
		expect(getDefaultComposerPlaceholder({ platform })).toBe(`Type your message... ${expected}`);
	});
});
