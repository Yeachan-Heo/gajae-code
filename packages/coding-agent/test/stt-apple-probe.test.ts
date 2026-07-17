import { describe, expect, test } from "bun:test";
import { decideProbeOutcome } from "../src/stt/backends/apple-probe";

describe("decideProbeOutcome (pure)", () => {
	test("a signal-killed child is unsafe — the TCC abort is the evidence", () => {
		expect(decideProbeOutcome({ exitCode: null, signalCode: "SIGABRT", stdout: "" })).toEqual({
			safe: false,
			reason: "crash:SIGABRT",
		});
	});

	test("clean ok line is safe", () => {
		expect(decideProbeOutcome({ exitCode: 0, signalCode: null, stdout: '{"ok":true}\n' })).toEqual({
			safe: true,
		});
	});

	test("permission outcomes surface their status", () => {
		expect(
			decideProbeOutcome({
				exitCode: 20,
				signalCode: null,
				stdout: '{"ok":false,"reason":"permission:denied"}\n',
			}),
		).toEqual({ safe: false, reason: "permission:denied" });
	});

	test("garbage or empty output is never safe (fail-closed)", () => {
		expect(decideProbeOutcome({ exitCode: 1, signalCode: null, stdout: "" }).safe).toBe(false);
		expect(decideProbeOutcome({ exitCode: 0, signalCode: null, stdout: "not json" }).safe).toBe(false);
	});

	test("only the last stdout line decides (earlier noise tolerated)", () => {
		const stdout = 'warn: something\n{"ok":true}\n';
		expect(decideProbeOutcome({ exitCode: 0, signalCode: null, stdout }).safe).toBe(true);
	});
});

describe("shouldCacheOutcome (pure)", () => {
	test("definitive verdicts cache; transient failures retry", async () => {
		const { shouldCacheOutcome } = await import("../src/stt/backends/apple-probe");
		expect(shouldCacheOutcome({ safe: true })).toBe(true);
		expect(shouldCacheOutcome({ safe: false, reason: "crash:SIGABRT" })).toBe(true);
		expect(shouldCacheOutcome({ safe: false, reason: "permission:denied" })).toBe(true);
		expect(shouldCacheOutcome({ safe: false, reason: "error:unparseable_exit_137" })).toBe(false);
		expect(shouldCacheOutcome({ safe: false, reason: "error:spawn_failed" })).toBe(false);
	});
});
