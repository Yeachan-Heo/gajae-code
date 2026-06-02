import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { BashExecutionComponent } from "@gajae-code/coding-agent/modes/components/bash-execution";
import { getThemeByName, setThemeInstance } from "@gajae-code/coding-agent/modes/theme/theme";
import { sanitizeWithOptionalSixelPassthrough } from "@gajae-code/coding-agent/utils/sixel";
import type { TUI } from "@gajae-code/tui";
import { sanitizeText } from "@gajae-code/utils";

const SIXEL = "\x1bPqabc\x1b\\";

describe("BashExecutionComponent SIXEL sanitization", () => {
	const originalForceProtocol = Bun.env.PI_FORCE_IMAGE_PROTOCOL;
	const originalAllowPassthrough = Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH;
	const ui = { requestRender: () => {} } as unknown as TUI;

	beforeEach(async () => {
		const theme = await getThemeByName("red-claw");
		expect(theme).toBeDefined();
		setThemeInstance(theme!);
	});
	afterEach(() => {
		if (originalForceProtocol === undefined) delete Bun.env.PI_FORCE_IMAGE_PROTOCOL;
		else Bun.env.PI_FORCE_IMAGE_PROTOCOL = originalForceProtocol;
		if (originalAllowPassthrough === undefined) delete Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH;
		else Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH = originalAllowPassthrough;
	});

	it("preserves SIXEL output when passthrough gates are enabled", () => {
		Bun.env.PI_FORCE_IMAGE_PROTOCOL = "sixel";
		Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH = "1";

		const component = new BashExecutionComponent("echo sixel", ui, false);
		component.appendOutput(SIXEL);
		component.setComplete(0, false);

		expect(component.getOutput()).toContain(SIXEL);
	});

	it("does not truncate long SIXEL payload lines", () => {
		Bun.env.PI_FORCE_IMAGE_PROTOCOL = "sixel";
		Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH = "1";

		const payload = `\x1bPq${"A".repeat(5000)}\x1b\\`;
		const component = new BashExecutionComponent("echo sixel", ui, false);
		component.appendOutput(payload);
		component.setComplete(0, false);

		const output = component.getOutput();
		expect(output).toContain("\x1bPq");
		expect(output).toContain("\x1b\\");
		expect(output).not.toContain("visible columns omitted");
	});

	it("still truncates long non-SIXEL lines", () => {
		Bun.env.PI_FORCE_IMAGE_PROTOCOL = "sixel";
		Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH = "1";

		const longText = "x".repeat(5000);
		const component = new BashExecutionComponent("echo text", ui, false);
		component.appendOutput(longText);
		component.setComplete(0, false);

		const output = component.getOutput();
		expect(output).toContain("visible columns omitted");
		expect(output).not.toContain("\x1bPq");
	});

	it("strips SIXEL control escapes when passthrough gates are disabled", () => {
		delete Bun.env.PI_FORCE_IMAGE_PROTOCOL;
		delete Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH;

		// appendOutput receives pre-sanitized chunks from OutputSink.
		// Simulate that: sanitize before passing to the component.
		const sanitized = sanitizeWithOptionalSixelPassthrough(SIXEL, sanitizeText);
		const component = new BashExecutionComponent("test sixel", ui, false);
		component.appendOutput(sanitized);
		component.setComplete(0, false);

		expect(component.getOutput()).not.toContain("\x1bPq");
		expect(component.getOutput()).toBe("");
	});
});

describe("BashExecutionComponent streaming throttle", () => {
	const ui = { requestRender: () => {} } as unknown as TUI;

	beforeEach(async () => {
		const theme = await getThemeByName("red-claw");
		expect(theme).toBeDefined();
		setThemeInstance(theme!);
	});

	it("caps stored lines during streaming", () => {
		const component = new BashExecutionComponent("test", ui, false);

		// Flood with 500 lines in one chunk (exceeds STREAMING_LINE_CAP of 100)
		const lines = Array.from({ length: 500 }, (_, i) => `line${i}`).join("\n");
		component.appendOutput(lines);

		// Internal lines should be capped (we can't read #outputLines directly,
		// but getOutput() returns the joined lines — it should have at most ~100 lines)
		const output = component.getOutput();
		const outputLineCount = output.split("\n").length;
		expect(outputLineCount).toBeLessThanOrEqual(101); // 100 cap + possible partial
		// Should retain the tail, not the head
		expect(output).toContain("line499");
		expect(output).not.toContain("line0\n");
	});

	it("gate drops rapid chunks", async () => {
		const component = new BashExecutionComponent("test", ui, false);

		// Send 100 chunks rapidly (all in same tick, before setTimeout fires)
		for (let i = 0; i < 100; i++) {
			component.appendOutput(`chunk${i}\n`);
		}

		// Only the first chunk should have been processed (gate blocks the rest)
		const output = component.getOutput();
		expect(output).toContain("chunk0");
		expect(output).not.toContain("chunk99");

		// After the gate timer expires, the next chunk is accepted
		await Bun.sleep(60); // CHUNK_THROTTLE_MS is 50
		component.appendOutput("after_gate\n");
		expect(component.getOutput()).toContain("after_gate");
	});

	it("setComplete replaces streaming output with final output", () => {
		const component = new BashExecutionComponent("test", ui, false);

		// Stream some partial output
		component.appendOutput("streaming_line\n");

		// Complete with different final output
		component.setComplete(0, false, { output: "final_line_1\nfinal_line_2" });

		const output = component.getOutput();
		expect(output).toContain("final_line_1");
		expect(output).toContain("final_line_2");
		// Streaming output is replaced, not appended
		expect(output).not.toContain("streaming_line");
	});
});
