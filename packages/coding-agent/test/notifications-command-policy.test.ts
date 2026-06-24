import { describe, expect, test } from "bun:test";
import {
	classifyTypedSlash,
	isAllowedSkillInvocation,
	isConfigCommand,
	isDeniedCommand,
	isModelCommandWithArgs,
	parseSlashName,
} from "../src/notifications/command-policy";

describe("command-policy parseSlashName", () => {
	test("parses name and args, colon and space separators", () => {
		expect(parseSlashName("/skill:ralplan refactor auth")).toEqual({ name: "skill", args: "ralplan refactor auth" });
		expect(parseSlashName("/model gpt-5")).toEqual({ name: "model", args: "gpt-5" });
		expect(parseSlashName("/menu")).toEqual({ name: "menu", args: "" });
		expect(parseSlashName("plain text")).toBeUndefined();
	});
});

describe("command-policy config detection", () => {
	test("recognizes existing in-thread config commands", () => {
		for (const c of ["/verbose", "/lean", "/verbosity verbose", "/redact on"]) expect(isConfigCommand(c)).toBe(true);
		expect(isConfigCommand("/menu")).toBe(false);
		expect(isConfigCommand("/skill:ralplan")).toBe(false);
	});
});

describe("command-policy denial", () => {
	test("/model with args is denied; bare /model is not", () => {
		expect(isModelCommandWithArgs("/model gpt-5")).toBe(true);
		expect(isModelCommandWithArgs("/model")).toBe(false);
		expect(isDeniedCommand("/model gpt-5")).toBe(true);
		expect(isDeniedCommand("/model")).toBe(false);
	});

	test("destructive/persistent/TUI-only commands and shell/eval are denied", () => {
		for (const c of [
			"/session delete",
			"/memory clear",
			"/provider add x",
			"/compact",
			"/clear",
			"/vim",
			"!ls",
			"$1+1",
		]) {
			expect(isDeniedCommand(c)).toBe(true);
		}
	});

	test("allowed surfaces are not denied", () => {
		for (const c of ["/skill:ralplan", "/notify status", "/help", "/menu", "/model"]) {
			expect(isDeniedCommand(c)).toBe(false);
		}
	});
});

describe("command-policy skill invocation", () => {
	test("validates against session-provided allowlist, case-insensitive", () => {
		const allowed = ["ralplan", "deep-interview", "ultragoal", "team"];
		expect(isAllowedSkillInvocation("ralplan", allowed)).toBe(true);
		expect(isAllowedSkillInvocation("RALPLAN", allowed)).toBe(true);
		expect(isAllowedSkillInvocation("nope", allowed)).toBe(false);
		expect(isAllowedSkillInvocation("", allowed)).toBe(false);
	});
});

describe("command-policy classifyTypedSlash", () => {
	test("classifies config, denied, command, and not_command", () => {
		expect(classifyTypedSlash("/verbose")).toEqual({ kind: "config" });
		expect(classifyTypedSlash("keep going").kind).toBe("not_command");
		expect(classifyTypedSlash("!rm -rf").kind).toBe("denied");
		expect(classifyTypedSlash("/model gpt-5").kind).toBe("denied");
		expect(classifyTypedSlash("/session delete").kind).toBe("denied");
		expect(classifyTypedSlash("/skill:ralplan go")).toEqual({ kind: "command" });
		expect(classifyTypedSlash("/menu")).toEqual({ kind: "command" });
	});
});
