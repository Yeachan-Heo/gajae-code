import { describe, expect, it } from "bun:test";
import { formatSTTUsage, getRecorderInstallHint } from "../src/stt/setup";

describe("STT setup guidance", () => {
	it("uses platform-specific recorder installation commands", () => {
		expect(getRecorderInstallHint("darwin")).toContain("brew install sox");
		expect(getRecorderInstallHint("linux")).toContain("sudo apt install sox");
		expect(getRecorderInstallHint("win32")).toContain("PowerShell fallback available");
	});

	it("explains the complete enable, record, and transcribe flow", () => {
		const usage = formatSTTUsage("linux");

		expect(usage).toContain("gjc config set stt.enabled true");
		expect(usage).toContain("/settings > Interaction > Speech-to-Text");
		expect(usage).toContain("press Alt+H to start recording");
		expect(usage).toContain("press Alt+H again to stop and transcribe");
		expect(usage).toContain("inserted into the composer for review");
		expect(usage).toContain("Run /hotkeys");
		expect(usage).toContain("press Ctrl+P and select Toggle speech-to-text");
	});

	it("clarifies the macOS Option key requirement", () => {
		const usage = formatSTTUsage("darwin", "ghostty");
		expect(usage).toContain("Alt+H is Option+H");
		expect(usage).toContain("forward Option as Meta/Esc");
		expect(usage).toContain("macos-option-as-alt = true");
	});
});
