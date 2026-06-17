import { describe, expect, test } from "bun:test";
import { parseCommand } from "../src/commands";

describe("parseCommand", () => {
	test("parses the command vocabulary", () => {
		expect(parseCommand("/help")).toEqual({ kind: "help" });
		expect(parseCommand("/presets")).toEqual({ kind: "presets" });
		expect(parseCommand("/sessions")).toEqual({ kind: "sessions", query: null });
		expect(parseCommand("/sessions feat x")).toEqual({ kind: "sessions", query: "feat x" });
		expect(parseCommand("/observe sess-1")).toEqual({ kind: "observe", sessionId: "sess-1" });
		expect(parseCommand("/start-session demo build the thing")).toEqual({
			kind: "start_session",
			presetId: "demo",
			task: "build the thing",
		});
		expect(parseCommand("/stop sess-1")).toEqual({ kind: "stop", sessionId: "sess-1", confirm: false });
		expect(parseCommand("/stop sess-1 confirm")).toEqual({ kind: "stop", sessionId: "sess-1", confirm: true });
		expect(parseCommand("/attach")).toEqual({ kind: "attach", socketPath: null });
		expect(parseCommand("/attach /tmp/gjc.sock")).toEqual({ kind: "attach", socketPath: "/tmp/gjc.sock" });
		expect(parseCommand("/detach")).toEqual({ kind: "detach" });
		expect(parseCommand("/status")).toEqual({ kind: "status" });
		expect(parseCommand("/abort")).toEqual({ kind: "abort" });
	});

	test("strips @botname mention and is case-insensitive", () => {
		expect(parseCommand("/Sessions@MyGjcBot")).toEqual({ kind: "sessions", query: null });
		expect(parseCommand("/Presets@MyGjcBot")).toEqual({ kind: "presets" });
		expect(parseCommand("/STOP sess-1 CONFIRM")).toEqual({ kind: "stop", sessionId: "sess-1", confirm: true });
	});

	test("missing arguments resolve to null fields, not crashes", () => {
		expect(parseCommand("/observe")).toEqual({ kind: "observe", sessionId: null });
		expect(parseCommand("/start-session")).toEqual({ kind: "start_session", presetId: null, task: null });
		expect(parseCommand("/stop")).toEqual({ kind: "stop", sessionId: null, confirm: false });
	});

	test("rejects the undocumented underscore alias for start-session", () => {
		expect(parseCommand("/start_session demo")).toEqual({ kind: "unknown" });
	});

	test("/start parses to onboarding, ignoring any payload and @mention", () => {
		expect(parseCommand("/start")).toEqual({ kind: "start" });
		expect(parseCommand("/start@MyGjcBot")).toEqual({ kind: "start" });
		expect(parseCommand("/start deep-link-payload")).toEqual({ kind: "start" });
	});

	test("rejects everything outside the vocabulary as unknown", () => {
		expect(parseCommand("/shell rm -rf /")).toEqual({ kind: "unknown" });
		expect(parseCommand("/exec")).toEqual({ kind: "unknown" });
		expect(parseCommand("hello there")).toEqual({ kind: "unknown" });
		expect(parseCommand("")).toEqual({ kind: "unknown" });
		expect(parseCommand("   ")).toEqual({ kind: "unknown" });
	});

	test("a non-leading slash is not a command", () => {
		expect(parseCommand("please /stop it")).toEqual({ kind: "unknown" });
	});
});
