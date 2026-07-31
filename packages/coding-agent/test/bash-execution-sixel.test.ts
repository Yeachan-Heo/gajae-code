import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { BashExecutionComponent } from "@gajae-code/coding-agent/modes/components/bash-execution";
import { IrcSplitViewComponent } from "@gajae-code/coding-agent/modes/components/irc-sidebar";
import { IrcObservationLedger } from "@gajae-code/coding-agent/modes/irc-observation-ledger";
import { getThemeByName, setThemeInstance, theme } from "@gajae-code/coding-agent/modes/theme/theme";
import { sanitizeWithOptionalSixelPassthrough } from "@gajae-code/coding-agent/utils/sixel";
import { ImageProtocol, TERMINAL, type TUI } from "@gajae-code/tui";
import { sanitizeText } from "@gajae-code/utils";

const SIXEL = "\x1bPqabc\x1b\\";

describe("BashExecutionComponent SIXEL sanitization", () => {
	const originalForceProtocol = Bun.env.PI_FORCE_IMAGE_PROTOCOL;
	const originalAllowPassthrough = Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH;
	const ui = { requestRender: () => {} } as unknown as TUI;
	const originalProtocol = TERMINAL.imageProtocol;
	const terminal = TERMINAL as unknown as { imageProtocol: ImageProtocol | null };

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
		terminal.imageProtocol = originalProtocol;
	});

	it("preserves SIXEL output when passthrough gates are enabled", () => {
		Bun.env.PI_FORCE_IMAGE_PROTOCOL = "sixel";
		Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH = "1";

		const component = new BashExecutionComponent("echo sixel", ui, false);
		component.appendOutput(SIXEL);
		component.setComplete(0, false);

		expect(component.getOutput()).toContain(SIXEL);
	});

	it("renders all completed SIXEL output outside the graphics fallback", () => {
		terminal.imageProtocol = ImageProtocol.Sixel;
		Bun.env.PI_FORCE_IMAGE_PROTOCOL = "sixel";
		Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH = "1";
		const output = [`before ${SIXEL}`, ...Array.from({ length: 25 }, (_, index) => `line ${index}`)].join("\n");
		const component = new BashExecutionComponent("emit sixel", ui, false);
		component.setComplete(0, false, { output });

		const rendered = component.render(160).join("\n");
		expect(rendered).toContain(SIXEL);
		expect(Bun.stripANSI(rendered)).toContain("line 0");
		expect(Bun.stripANSI(rendered)).toContain("line 24");
		expect(Bun.stripANSI(rendered)).not.toContain("more lines");
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

	it("rebuilds SIXEL output through the visible sidebar and restores passthrough when hidden", () => {
		terminal.imageProtocol = ImageProtocol.Sixel;
		Bun.env.PI_FORCE_IMAGE_PROTOCOL = "sixel";
		Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH = "1";
		const component = new BashExecutionComponent("echo sixel", ui, false);
		const split = new IrcSplitViewComponent(component, new IrcObservationLedger(), theme);
		component.setComplete(0, false, { output: `before\n${SIXEL}\nafter` });

		expect(split.render(80).join("\n")).toContain(SIXEL);
		split.setVisible(true);
		const visible = split.render(80).join("\n");
		expect(visible).not.toContain(SIXEL);
		expect(visible).not.toContain("\x1bP");
		split.setVisible(false);
		expect(split.render(80).join("\n")).toContain(SIXEL);
	});

	it("suppresses SIXEL completed after the IRC split becomes visible and restores it when hidden", () => {
		terminal.imageProtocol = ImageProtocol.Sixel;
		Bun.env.PI_FORCE_IMAGE_PROTOCOL = "sixel";
		Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH = "1";
		const component = new BashExecutionComponent("echo sixel", ui, false);
		const split = new IrcSplitViewComponent(component, new IrcObservationLedger(), theme);
		split.setVisible(true);
		component.setComplete(0, false, { output: SIXEL });

		const visible = split.render(160).join("\n");
		expect(Bun.stripANSI(visible)).toContain("[SIXEL image hidden while IRC sidebar is visible]");
		expect(visible).not.toContain("\x1bP");

		split.setVisible(false);
		expect(split.render(160).join("\n")).toContain(SIXEL);
	});

	it("suppresses SIXEL after expansion while the IRC split is already visible", () => {
		terminal.imageProtocol = ImageProtocol.Sixel;
		Bun.env.PI_FORCE_IMAGE_PROTOCOL = "sixel";
		Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH = "1";
		const component = new BashExecutionComponent("echo sixel", ui, false);
		const split = new IrcSplitViewComponent(component, new IrcObservationLedger(), theme);
		component.setComplete(0, false, { output: SIXEL });
		split.setVisible(true);
		component.setExpanded(true);

		const visible = split.render(160).join("\n");
		expect(Bun.stripANSI(visible)).toContain("[SIXEL image hidden while IRC sidebar is visible]");
		expect(visible).not.toContain("\x1bP");
	});

	it("restores SIXEL after a visible transcript-style completion without an intervening toggle", () => {
		terminal.imageProtocol = ImageProtocol.Sixel;
		Bun.env.PI_FORCE_IMAGE_PROTOCOL = "sixel";
		Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH = "1";
		const component = new BashExecutionComponent("echo sixel", ui, false);
		const split = new IrcSplitViewComponent(component, new IrcObservationLedger(), theme);
		split.setVisible(true);
		component.setComplete(0, false, { output: `before\n${SIXEL}\nafter` });

		const visible = split.render(160).join("\n");
		expect(Bun.stripANSI(visible)).toContain("[SIXEL image hidden while IRC sidebar is visible]");
		expect(visible).not.toContain("\x1bP");
		split.setVisible(false);
		expect(split.render(160).join("\n")).toContain(SIXEL);
	});

	it("keeps collapsed preview and hidden-line counts while replacing SIXEL through the visible sidebar", () => {
		terminal.imageProtocol = ImageProtocol.Sixel;
		Bun.env.PI_FORCE_IMAGE_PROTOCOL = "sixel";
		Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH = "1";
		const component = new BashExecutionComponent("echo sixel", ui, false);
		const split = new IrcSplitViewComponent(component, new IrcObservationLedger(), theme);
		component.setComplete(0, false, {
			output: `${Array.from({ length: 25 }, (_, index) => `line ${index}`).join("\n")}\n${SIXEL}`,
		});
		split.setVisible(true);
		const raw = split.render(160).join("\n");
		const visible = Bun.stripANSI(raw);
		expect(visible).toContain("line 6");
		expect(visible).not.toContain("line 0");
		expect(visible).toContain("[SIXEL image hidden while IRC sidebar is visible]");
		expect(visible.split("[SIXEL image hidden while IRC sidebar is visible]").length - 1).toBe(1);
		expect(raw).not.toContain("\x1bP");
		expect(visible).toContain("6 more lines");
	});

	it("expands full output with SIXEL placeholder and no hidden-count footer through the visible sidebar", () => {
		terminal.imageProtocol = ImageProtocol.Sixel;
		Bun.env.PI_FORCE_IMAGE_PROTOCOL = "sixel";
		Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH = "1";
		const component = new BashExecutionComponent("echo sixel", ui, false);
		const split = new IrcSplitViewComponent(component, new IrcObservationLedger(), theme);
		component.setComplete(0, false, {
			output: `${Array.from({ length: 25 }, (_, index) => `line ${index}`).join("\n")}\n${SIXEL}`,
		});
		component.setExpanded(true);
		split.setVisible(true);
		const raw = split.render(120).join("\n");
		const visible = Bun.stripANSI(raw);
		expect(visible).toContain("line 0");
		expect(visible).toContain("[SIXEL image hidden while IRC sidebar is visible]");
		expect(raw).not.toContain("\x1bP");
		expect(visible).not.toContain("more lines");
	});
});

describe("BashExecutionComponent streaming throttle", () => {
	const ui = { requestRender: () => {} } as unknown as TUI;

	beforeEach(async () => {
		const theme = await getThemeByName("red-claw");
		expect(theme).toBeDefined();
		setThemeInstance(theme!);
	});

	it("keeps the complete stream while the collapsed preview stays bounded", () => {
		const component = new BashExecutionComponent("test", ui, false);

		// Flood with more lines than the collapsed preview retains.
		const lines = Array.from({ length: 500 }, (_, i) => `line${i}`).join("\n");
		component.appendOutput(lines);
		component.setComplete(0, false);

		const output = component.getOutput();
		const outputLineCount = output.split("\n").length;
		expect(outputLineCount).toBe(500);
		// The complete stream is available for expansion.
		expect(output).toContain("line0\n");
		expect(output).toContain("line499");
	});

	it("retains rapid chunks while throttling preview updates", async () => {
		const component = new BashExecutionComponent("test", ui, false);

		// Send 100 chunks rapidly (all in the same tick).
		for (let i = 0; i < 100; i++) {
			component.appendOutput(`chunk${i}\n`);
		}

		await Bun.sleep(60); // CHUNK_THROTTLE_MS is 50
		const output = component.getOutput();
		expect(output).toContain("chunk0");
		expect(output).toContain("chunk99");
	});

	it("keeps streamed output when the final result is tail-bounded", () => {
		const component = new BashExecutionComponent("test", ui, false);

		// Stream some partial output
		component.appendOutput("streaming_line\n");

		// Complete with different final output
		component.setComplete(0, false, { output: "final_line_1\nfinal_line_2" });

		const output = component.getOutput();
		expect(output).toContain("streaming_line");
		// The bounded final snapshot must not replace the complete live stream.
		expect(output).not.toContain("final_line_1");
	});
});
