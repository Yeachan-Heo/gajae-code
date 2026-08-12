import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseCrashRecordMarker } from "../src/crash-fingerprint";
import {
	appendCrashEvent,
	CRASH_EVENT_MAX_BYTES,
	type CrashOccurrenceEvent,
	formatCrashEventLine,
	parseCrashEventLine,
} from "../src/crash-journal";
import { recordFatalCrash } from "../src/postmortem";

const FP = "0123456789abcdef0123456789abcdef";

function tempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "gjc-crash-journal-"));
}

function occurrence(overrides: Partial<CrashOccurrenceEvent> = {}): CrashOccurrenceEvent {
	return {
		kind: "occurrence",
		fingerprint: FP,
		fpv: 1,
		recordId: "abcdef0123456789",
		at: Date.UTC(2026, 7, 11, 12, 0, 0),
		errorName: "Error",
		messageClass: "shared topic authority unavailable",
		...overrides,
	};
}

describe("crash event line", () => {
	it("round-trips an occurrence", () => {
		const line = formatCrashEventLine(occurrence());
		expect(parseCrashEventLine(line)).toEqual(occurrence());
	});

	it("keeps a hostile oversized message inside the 512-byte line budget", () => {
		const line = formatCrashEventLine(occurrence({ messageClass: "가".repeat(4000) }));
		expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(CRASH_EVENT_MAX_BYTES);
		expect(line.split("\n").filter(Boolean)).toHaveLength(1);
		const parsed = parseCrashEventLine(line);
		expect(parsed?.kind).toBe("occurrence");
	});

	it("never lets control characters forge a second journal line", () => {
		const line = formatCrashEventLine(occurrence({ messageClass: "a\nb\u001b[31mc\u0000d" }));
		expect(line.split("\n").filter(Boolean)).toHaveLength(1);
		const parsed = parseCrashEventLine(line);
		expect(parsed?.kind === "occurrence" && parsed.messageClass).toBe("a b [31mc d");
	});

	it("rejects malformed, out-of-alphabet and out-of-range events", () => {
		expect(parseCrashEventLine("not an event")).toBeUndefined();
		expect(parseCrashEventLine('gjc-crash-event.v1 {"k":"occurrence"}')).toBeUndefined();
		expect(
			parseCrashEventLine(`gjc-crash-event.v1 {"k":"occurrence","fp":"nope","at":1,"id":"aa","fpv":1}`),
		).toBeUndefined();
		expect(parseCrashEventLine(`gjc-crash-event.v1 {"k":"nudged","at":0}`)).toBeUndefined();
		expect(parseCrashEventLine(`gjc-crash-event.v1 {"k":"unknown","at":${Date.now()}}`)).toBeUndefined();
	});
});

describe("appendCrashEvent", () => {
	it("appends whole lines from concurrent writers", () => {
		const journal = path.join(tempDir(), "nested", "gjc-crash-events.jsonl");
		for (let index = 0; index < 20; index++) {
			appendCrashEvent(occurrence({ recordId: index.toString(16).padStart(16, "0") }), journal);
		}
		const lines = fs.readFileSync(journal, "utf8").split("\n").filter(Boolean);
		expect(lines).toHaveLength(20);
		expect(lines.every(line => parseCrashEventLine(line) !== undefined)).toBe(true);
		expect(fs.statSync(journal).mode & 0o777).toBe(0o600);
	});

	it("swallows a write failure instead of masking the original fatal", () => {
		const dir = tempDir();
		// A directory where the journal file should be: every open fails.
		const journal = path.join(dir, "gjc-crash-events.jsonl");
		fs.mkdirSync(journal);
		expect(appendCrashEvent(occurrence(), journal)).toBe(false);
	});

	it("writes at most one fatal-path event per process (crash-during-crash skips journal work)", () => {
		// The latch is process-wide and deliberately never cleared, so this must be
		// exercised in a fresh process rather than sharing the test runner's.
		const dir = tempDir();
		const journal = path.join(dir, "gjc-crash-events.jsonl");
		const script = path.join(dir, "latch.ts");
		fs.writeFileSync(
			script,
			`import { appendFatalCrashEvent } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/crash-journal.ts"))};\n` +
				`const event = ${JSON.stringify(occurrence())};\n` +
				`const first = appendFatalCrashEvent(event, ${JSON.stringify(journal)});\n` +
				`const second = appendFatalCrashEvent({ ...event, recordId: "ffffffffffffffff" }, ${JSON.stringify(journal)});\n` +
				`process.stdout.write(JSON.stringify({ first, second }));\n`,
		);
		const spawned = Bun.spawnSync({ cmd: [process.execPath, script], stdout: "pipe", stderr: "pipe" });
		expect(spawned.stdout.toString()).toBe('{"first":true,"second":false}');
		expect(fs.readFileSync(journal, "utf8").split("\n").filter(Boolean)).toHaveLength(1);
	});
});

describe("recordFatalCrash identity", () => {
	it("appends a parseable identity line and journals the occurrence beside the log", () => {
		const dir = tempDir();
		const target = path.join(dir, "gjc-crash.log");
		// A fresh process: the fatal journal latch fires once per process lifetime.
		const script = path.join(dir, "crash.ts");
		fs.writeFileSync(
			script,
			`import { recordFatalCrash } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/postmortem.ts"))};\n` +
				`recordFatalCrash("Uncaught Exception", new Error("boom while streaming"), { path: ${JSON.stringify(target)} });\n`,
		);
		const spawned = Bun.spawnSync({ cmd: [process.execPath, script], stdout: "pipe", stderr: "pipe" });
		expect(spawned.exitCode).toBe(0);

		const contents = fs.readFileSync(target, "utf8");
		const markerLine = contents.split("\n").find(line => line.startsWith("gjc-crash-record.v1 "));
		const marker = parseCrashRecordMarker(markerLine ?? "");
		expect(marker?.fingerprint).toMatch(/^[0-9a-f]{32}$/);
		expect(marker?.version).toBe(1);

		const journal = fs.readFileSync(path.join(dir, "gjc-crash-events.jsonl"), "utf8");
		const event = parseCrashEventLine(journal.split("\n")[0] ?? "");
		expect(event?.kind).toBe("occurrence");
		expect(event && "fingerprint" in event ? event.fingerprint : undefined).toBe(marker?.fingerprint ?? "");
	});

	it("keeps the identity line even when the record body is truncated", () => {
		const dir = tempDir();
		const target = path.join(dir, "gjc-crash.log");
		recordFatalCrash("Uncaught Exception", new Error("x".repeat(200_000)), { path: target });
		const contents = fs.readFileSync(target, "utf8");
		expect(contents).toContain("[crash record truncated]");
		expect(parseCrashRecordMarker(contents.split("\n").at(-3) ?? "")).toBeDefined();
	});
});
