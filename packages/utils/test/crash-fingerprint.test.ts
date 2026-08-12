import { describe, expect, it } from "bun:test";
import {
	computeCrashFingerprint,
	formatCrashRecordMarker,
	NO_APP_FRAME,
	normalizeCrashFrames,
	normalizeCrashMessage,
	parseCrashRecordMarker,
} from "../src/crash-fingerprint";

const OPTIONS = { installRoot: "/opt/gjc", homeDir: "/home/alice" };

function fingerprint(input: { name: string; message: string; stack: string }): string {
	return computeCrashFingerprint(input, OPTIONS).fingerprint;
}

describe("normalizeCrashMessage", () => {
	it("collapses absolute paths, home prefixes and high-entropy ids", () => {
		const normalized = normalizeCrashMessage(
			"ENOSPC writing /var/lib/gjc/state.db for 550e8400-e29b-41d4-a716-446655440000 (pid 2557873, sha deadbeefcafe)",
			OPTIONS,
		);
		expect(normalized).toBe("ENOSPC writing <path> for <uuid> (pid <num>, sha <hex>)");
	});

	it("maps a home-rooted path to <home> and a foreign path to <path>", () => {
		expect(normalizeCrashMessage("read /home/alice/.gjc/agent/x.log", OPTIONS)).toBe("read <home>");
		expect(normalizeCrashMessage("read /home/bob/.gjc/agent/x.log", OPTIONS)).toBe("read <path>");
	});

	it("preserves semantically meaningful codes so 404 and 500 stay distinct classes", () => {
		expect(normalizeCrashMessage("request failed with status 404", OPTIONS)).toBe("request failed with status 404");
		expect(fingerprint({ name: "Error", message: "request failed with status 404", stack: "" })).not.toBe(
			fingerprint({ name: "Error", message: "request failed with status 500", stack: "" }),
		);
	});

	it("routes credential shapes through the redactor's markers", () => {
		expect(normalizeCrashMessage("auth failed: Bearer abcdefgh12345678", OPTIONS)).toBe(
			"auth failed: «redacted-auth»",
		);
	});
});

describe("normalizeCrashFrames", () => {
	const sourceStack = [
		"Error: shared topic authority unavailable",
		"    at resolveTopic (/opt/gjc/packages/coding-agent/src/sdk/bus/topics.ts:412:19)",
		"    at async publish (/opt/gjc/packages/coding-agent/src/sdk/bus/publish.ts:88:5)",
		"    at process.processTicksAndRejections (node:internal/process/task_queues:105:5)",
	].join("\n");

	it("drops line/column numbers and node internals", () => {
		expect(normalizeCrashFrames(sourceStack, OPTIONS)).toEqual([
			"packages/coding-agent/src/sdk/bus/topics.ts#resolveTopic",
			"packages/coding-agent/src/sdk/bus/publish.ts#publish",
		]);
	});

	it("treats compiled-binary and Windows stacks as the same frames as the source stack", () => {
		const bunfs = sourceStack.replace(/\/opt\/gjc\//g, "/$bunfs/root/");
		const windows = [
			"Error: shared topic authority unavailable",
			"    at resolveTopic (C:\\gjc\\packages\\coding-agent\\src\\sdk\\bus\\topics.ts:9:1)",
			"    at async publish (C:\\gjc\\packages\\coding-agent\\src\\sdk\\bus\\publish.ts:3:2)",
		].join("\n");
		expect(normalizeCrashFrames(bunfs, OPTIONS)).toEqual(normalizeCrashFrames(sourceStack, OPTIONS));
		expect(normalizeCrashFrames(windows, { ...OPTIONS, installRoot: "C:\\gjc" })).toEqual(
			normalizeCrashFrames(sourceStack, OPTIONS),
		);
	});

	it("skips dependency frames and reports <no-app-frame> when nothing is in-app", () => {
		const stack = [
			"TypeError: boom",
			"    at fetch (/opt/gjc/node_modules/undici/lib/api.js:1:1)",
			"    at process.processTicksAndRejections (node:internal/process/task_queues:105:5)",
		].join("\n");
		expect(normalizeCrashFrames(stack, OPTIONS)).toEqual([NO_APP_FRAME]);
	});
});

describe("computeCrashFingerprint", () => {
	const stackFor = (root: string, line: number) =>
		[
			"Error: shared topic authority unavailable",
			`    at resolveTopic (${root}/packages/coding-agent/src/sdk/bus/topics.ts:${line}:19)`,
		].join("\n");

	it("is stable across versions, hosts and pids for the same logical crash", () => {
		const a = fingerprint({
			name: "Error",
			message: "shared topic authority unavailable (pid 2557873, /home/alice/.gjc/agent)",
			stack: stackFor("/opt/gjc", 412),
		});
		const b = computeCrashFingerprint(
			{
				name: "Error",
				message: "shared topic authority unavailable (pid 9104, /home/bob/.gjc/agent)",
				stack: stackFor("/usr/lib/gjc", 998),
			},
			{ installRoot: "/usr/lib/gjc", homeDir: "/home/bob" },
		).fingerprint;
		expect(a).toBe(b);
	});

	it("separates distinct error names and distinct top frames", () => {
		const base = { message: "boom", stack: stackFor("/opt/gjc", 1) };
		expect(fingerprint({ ...base, name: "Error" })).not.toBe(fingerprint({ ...base, name: "TypeError" }));
		expect(fingerprint({ name: "Error", message: "boom", stack: stackFor("/opt/gjc", 1) })).not.toBe(
			fingerprint({
				name: "Error",
				message: "boom",
				stack: "Error: boom\n    at other (/opt/gjc/packages/utils/src/other.ts:1:1)",
			}),
		);
	});

	it("emits 32 lowercase hex characters and records the algorithm version", () => {
		const result = computeCrashFingerprint({ name: "Error", message: "boom", stack: "" }, OPTIONS);
		expect(result.fingerprint).toMatch(/^[0-9a-f]{32}$/);
		expect(result.version).toBe(1);
		expect(result.frames).toEqual([NO_APP_FRAME]);
	});

	it("never hashes raw path or secret text (only its normalized form)", () => {
		const withSecret = computeCrashFingerprint(
			{ name: "Error", message: "credential sk-abcdefgh12345678 at /home/alice/x", stack: "" },
			OPTIONS,
		);
		expect(withSecret.messageClass).toBe("credential «redacted-api-key» at <home>");
		expect(withSecret.fingerprint).toBe(
			computeCrashFingerprint(
				{ name: "Error", message: "credential sk-99999999zzzzzzzz at /home/alice/y", stack: "" },
				OPTIONS,
			).fingerprint,
		);
	});
});

describe("crash record marker", () => {
	it("round-trips a formatted marker", () => {
		const line = formatCrashRecordMarker("a".repeat(32), 1, "0123456789abcdef");
		expect(parseCrashRecordMarker(line)).toEqual({
			fingerprint: "a".repeat(32),
			version: 1,
			recordId: "0123456789abcdef",
		});
	});

	it("refuses legacy records and malformed markers instead of guessing", () => {
		expect(
			parseCrashRecordMarker("2026-08-02T17:05:35.948Z pid=2557873 [Uncaught Exception] Error: x"),
		).toBeUndefined();
		expect(parseCrashRecordMarker("gjc-crash-record.v1 fp:zzz fpv:1 id:0123456789abcdef")).toBeUndefined();
		expect(
			parseCrashRecordMarker(`gjc-crash-record.v1 fp:${"a".repeat(32)} fpv:0 id:0123456789abcdef`),
		).toBeUndefined();
	});
});
