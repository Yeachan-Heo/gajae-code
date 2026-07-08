import { describe, expect, test } from "bun:test";
import { parseInThreadConfigCommand, parseRichToggleCommand } from "../src/notifications/config-commands";

describe("parseInThreadConfigCommand", () => {
	test("/verbose and /lean toggle verbosity", () => {
		expect(parseInThreadConfigCommand("/verbose")).toEqual({ verbosity: "verbose" });
		expect(parseInThreadConfigCommand("/lean")).toEqual({ verbosity: "lean" });
	});

	test("/verbosity <arg> sets verbosity, rejects bad args", () => {
		expect(parseInThreadConfigCommand("/verbosity verbose")).toEqual({ verbosity: "verbose" });
		expect(parseInThreadConfigCommand("/verbosity lean")).toEqual({ verbosity: "lean" });
		expect(parseInThreadConfigCommand("/verbosity loud")).toBeUndefined();
	});

	test("/redact on|off|true|false|1|0 toggles redaction", () => {
		expect(parseInThreadConfigCommand("/redact on")).toEqual({ redact: true });
		expect(parseInThreadConfigCommand("/redact off")).toEqual({ redact: false });
		expect(parseInThreadConfigCommand("/redact true")).toEqual({ redact: true });
		expect(parseInThreadConfigCommand("/redact 0")).toEqual({ redact: false });
		expect(parseInThreadConfigCommand("/redact maybe")).toBeUndefined();
	});

	test("non-commands and free text return undefined (treated as injection)", () => {
		expect(parseInThreadConfigCommand("keep going")).toBeUndefined();
		expect(parseInThreadConfigCommand("/answer s1 yes")).toBeUndefined();
		expect(parseInThreadConfigCommand("/unknown")).toBeUndefined();
		expect(parseInThreadConfigCommand("")).toBeUndefined();
	});

	test("is case-insensitive and tolerant of extra whitespace", () => {
		expect(parseInThreadConfigCommand("  /VERBOSE  ")).toEqual({ verbosity: "verbose" });
		expect(parseInThreadConfigCommand("/Redact   ON")).toEqual({ redact: true });
	});
});

describe("parseRichToggleCommand", () => {
	test("/rich on|true|1 -> true", () => {
		expect(parseRichToggleCommand("/rich on")).toBe(true);
		expect(parseRichToggleCommand("/rich true")).toBe(true);
		expect(parseRichToggleCommand("/rich 1")).toBe(true);
	});

	test("/rich off|false|0 -> false", () => {
		expect(parseRichToggleCommand("/rich off")).toBe(false);
		expect(parseRichToggleCommand("/rich false")).toBe(false);
		expect(parseRichToggleCommand("/rich 0")).toBe(false);
	});

	test("case-insensitive and whitespace-tolerant", () => {
		expect(parseRichToggleCommand("  /RICH   On ")).toBe(true);
		expect(parseRichToggleCommand("/Rich OFF")).toBe(false);
	});

	test("accepts the /rich@botname group form", () => {
		expect(parseRichToggleCommand("/rich@GajaeCodeBot off")).toBe(false);
		expect(parseRichToggleCommand("/rich@GajaeCodeBot on")).toBe(true);
		expect(parseRichToggleCommand("/RICH@GajaeCodeBot ON")).toBe(true);
	});

	test("missing/invalid arg and non-rich commands -> undefined", () => {
		expect(parseRichToggleCommand("/rich")).toBeUndefined();
		expect(parseRichToggleCommand("/rich maybe")).toBeUndefined();
		expect(parseRichToggleCommand("/richfoo on")).toBeUndefined();
		expect(parseRichToggleCommand("/verbose")).toBeUndefined();
		expect(parseRichToggleCommand("rich on")).toBeUndefined();
		expect(parseRichToggleCommand("")).toBeUndefined();
	});
});
