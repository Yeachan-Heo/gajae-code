import { describe, expect, test } from "bun:test";
import {
	parseInThreadConfigCommand,
	parseRichToggleCommand,
	parseTelegramControlCommand,
} from "../src/notifications/config-commands";

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

describe("parseTelegramControlCommand", () => {
	test("parses command roots and bot suffixes", () => {
		expect(parseTelegramControlCommand("/context@GajaeCodeBot", "GajaeCodeBot")).toEqual({
			kind: "command",
			command: { name: "context" },
		});
		expect(parseTelegramControlCommand("/usage", "GajaeCodeBot")).toEqual({
			kind: "command",
			command: { name: "usage" },
		});
		expect(parseTelegramControlCommand("/compact keep architecture notes", "GajaeCodeBot")).toEqual({
			kind: "command",
			command: { name: "compact", instructions: "keep architecture notes" },
		});
	});

	test("parses reasoning status, cycle, and levels", () => {
		expect(parseTelegramControlCommand("/reasoning")).toEqual({
			kind: "command",
			command: { name: "reasoning", action: "status" },
		});
		expect(parseTelegramControlCommand("/reasoning cycle")).toEqual({
			kind: "command",
			command: { name: "reasoning", action: "cycle" },
		});
		expect(parseTelegramControlCommand("/reasoning HIGH")).toEqual({
			kind: "command",
			command: { name: "reasoning", action: "set", level: "high" },
		});
		expect(parseTelegramControlCommand("/reasoning ULTRA")).toEqual({
			kind: "command",
			command: { name: "reasoning", action: "set", level: "ultra" },
		});
	});

	test("recognized invalid forms fail closed", () => {
		expect(parseTelegramControlCommand("/usage now")).toMatchObject({ kind: "invalid", commandName: "usage" });
		expect(parseTelegramControlCommand("/context extra")).toMatchObject({ kind: "invalid", commandName: "context" });
		expect(parseTelegramControlCommand("/reasoning enormous")).toMatchObject({
			kind: "invalid",
			commandName: "reasoning",
		});
	});

	test("unknown commands and wrong bot suffix fall through", () => {
		expect(parseTelegramControlCommand("/unknown")).toEqual({ kind: "none" });
		expect(parseTelegramControlCommand("/context@OtherBot", "GajaeCodeBot")).toEqual({
			kind: "ignored",
			commandName: "context",
		});
		expect(parseTelegramControlCommand("/context@OtherBot")).toEqual({ kind: "ignored", commandName: "context" });
		expect(parseTelegramControlCommand("plain text")).toEqual({ kind: "none" });
	});
});
