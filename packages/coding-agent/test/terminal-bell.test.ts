import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings, settings } from "@gajae-code/coding-agent/config/settings";
import { classifyHookSelectorBellEvent, ringTerminalBell } from "@gajae-code/coding-agent/modes/utils/terminal-bell";

beforeEach(async () => {
	resetSettingsForTest();
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-terminal-bell-"));
	await Settings.init({ inMemory: true, cwd: tempDir });
});

afterEach(() => {
	vi.restoreAllMocks();
	resetSettingsForTest();
});

describe("terminal bell notifications", () => {
	it("is opt-in by default", () => {
		const output = { write: vi.fn(() => true) };
		ringTerminalBell("complete", output);
		expect(output.write).not.toHaveBeenCalled();
	});

	it("rings for enabled ask and approval events", () => {
		settings.set("notifications.terminalBell", true);
		settings.set("notifications.bellOnAsk", true);
		settings.set("notifications.bellOnApproval", true);
		const output = { write: vi.fn(() => true) };

		ringTerminalBell("ask", output);
		ringTerminalBell("approval", output);

		expect(output.write).toHaveBeenCalledTimes(2);
		expect(output.write).toHaveBeenNthCalledWith(1, "\x07");
		expect(output.write).toHaveBeenNthCalledWith(2, "\x07");
	});

	it("honors per-event toggles", () => {
		settings.set("notifications.terminalBell", true);
		settings.set("notifications.bellOnAsk", false);
		const output = { write: vi.fn(() => true) };

		ringTerminalBell("ask", output);

		expect(output.write).not.toHaveBeenCalled();
	});

	it("classifies approval-like selector titles separately from generic ask prompts", () => {
		expect(classifyHookSelectorBellEvent("Plan ready for approval")).toBe("approval");
		expect(classifyHookSelectorBellEvent("Approve tool use?")).toBe("approval");
		expect(classifyHookSelectorBellEvent("Choose an option")).toBe("ask");
	});
});
