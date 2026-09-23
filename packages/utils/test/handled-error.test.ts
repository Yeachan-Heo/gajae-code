import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { computeHandledErrorFingerprint, parseCrashRecordMarker } from "../src/crash-fingerprint";
import { parseCrashEventLine } from "../src/crash-journal";
import { isDesignedError, markDesignedError } from "../src/error-classification";
import { recordHandledError, resetHandledErrorDedupeForTest } from "../src/postmortem";

function handledStore(): { readonly log: string; readonly journal: string } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-handled-error-"));
	return {
		log: path.join(dir, "gjc-error.log"),
		journal: path.join(dir, "gjc-error-events.jsonl"),
	};
}

async function journalLines(journal: string): Promise<string[]> {
	return (await Bun.file(journal).text()).split("\n").filter(Boolean);
}

function errorAtFrame(message: string, functionName: string): Error {
	const error = new Error(message);
	const frame = path.resolve(import.meta.dir, "../src/postmortem.ts");
	error.stack = `${error.name}: ${error.message}\n    at ${functionName} (${frame}:10:2)`;
	return error;
}

describe("recordHandledError", () => {
	it("writes a marked record and one sibling occurrence event", async () => {
		resetHandledErrorDedupeForTest();
		const store = handledStore();
		const error = new Error("tool execution failed");
		const written = recordHandledError("Tool functions.read", error, { path: store.log });

		expect(written).toBe(store.log);
		const record = await Bun.file(store.log).text();
		const markerLine = record.split("\n").find(line => line.startsWith("gjc-crash-record.v1 "));
		const marker = parseCrashRecordMarker(markerLine ?? "");
		const fingerprint = computeHandledErrorFingerprint({
			name: error.name,
			message: error.message,
			stack: error.stack ?? "",
		});
		expect(marker?.fingerprint).toBe(fingerprint.fingerprint);

		const lines = await journalLines(store.journal);
		expect(lines).toHaveLength(1);
		const event = parseCrashEventLine(lines[0] ?? "");
		expect(event?.kind).toBe("occurrence");
		expect(event && "fingerprint" in event ? event.fingerprint : undefined).toBe(fingerprint.fingerprint);
	});

	it("ignores non-Error values and errors without stacks", async () => {
		resetHandledErrorDedupeForTest();
		const store = handledStore();
		const stackless = new Error("missing stack");
		stackless.stack = "";
		const stackAbsent = new Error("absent stack");
		Object.defineProperty(stackAbsent, "stack", { value: undefined });

		expect(recordHandledError("Tool functions.read", "failure", { path: store.log })).toBeUndefined();
		expect(recordHandledError("Tool functions.read", { message: "failure" }, { path: store.log })).toBeUndefined();
		expect(recordHandledError("Tool functions.read", undefined, { path: store.log })).toBeUndefined();
		expect(recordHandledError("Tool functions.read", stackless, { path: store.log })).toBeUndefined();
		expect(recordHandledError("Tool functions.read", stackAbsent, { path: store.log })).toBeUndefined();
		expect(await Bun.file(store.log).exists()).toBe(false);
		expect(await Bun.file(store.journal).exists()).toBe(false);
	});

	it("records only explicitly designed refusals as excluded", async () => {
		resetHandledErrorDedupeForTest();
		const store = handledStore();
		const refusal = markDesignedError(new Error("Tool call rejected by user (bash)"));
		const spoofed = new Error("unexpected plugin failure");
		spoofed.name = "ToolError";

		expect(recordHandledError("Tool bash", refusal, { path: store.log })).toBeUndefined();
		expect(isDesignedError(spoofed)).toBe(false);
		expect(recordHandledError("Tool bash", spoofed, { path: store.log })).toBe(store.log);
		expect(await Bun.file(store.log).exists()).toBe(true);
		expect(await Bun.file(store.journal).exists()).toBe(true);
	});

	it("deduplicates genuine errors by their failing frame rather than the full wrapper stack", async () => {
		resetHandledErrorDedupeForTest();
		const store = handledStore();
		const frame = path.resolve(import.meta.dir, "../src/postmortem.ts");
		const first = new Error("command failed");
		first.stack = `Error: output one\n    at fail (${frame}:10:2)\n    at firstCaller (${frame}:30:2)`;
		const second = new Error("command failed");
		second.stack = `Error: output two\n    at fail (${frame}:20:2)\n    at secondCaller (${frame}:40:2)`;

		expect(recordHandledError("Tool bash", first, { path: store.log })).toBe(store.log);
		expect(recordHandledError("Tool bash", second, { path: store.log })).toBeUndefined();
		expect((await Bun.file(store.log).text()).match(/gjc-crash-record\.v1 /g)).toHaveLength(1);
	});

	it("deduplicates a fingerprint without suppressing distinct errors", async () => {
		resetHandledErrorDedupeForTest();
		const store = handledStore();
		const repeated = errorAtFrame("repeated failure", "repeatedFailure");

		expect(recordHandledError("Tool functions.read", repeated, { path: store.log })).toBe(store.log);
		expect(recordHandledError("Tool functions.read", repeated, { path: store.log })).toBeUndefined();
		expect(
			recordHandledError("Tool functions.read", errorAtFrame("different failure", "differentFailure"), {
				path: store.log,
			}),
		).toBe(store.log);
		expect((await Bun.file(store.log).text()).match(/gjc-crash-record\.v1 /g)).toHaveLength(2);
		expect(await journalLines(store.journal)).toHaveLength(2);
	});

	it("allows a fingerprint again after test dedupe reset", async () => {
		resetHandledErrorDedupeForTest();
		const store = handledStore();
		const error = new Error("retry after reset");

		recordHandledError("Tool functions.read", error, { path: store.log });
		resetHandledErrorDedupeForTest();
		expect(recordHandledError("Tool functions.read", error, { path: store.log })).toBe(store.log);
		expect((await Bun.file(store.log).text()).match(/gjc-crash-record\.v1 /g)).toHaveLength(2);
		expect(await journalLines(store.journal)).toHaveLength(2);
	});

	it("evicts the coldest fingerprint at the bound instead of going blind to new errors", async () => {
		resetHandledErrorDedupeForTest();
		const store = handledStore();
		// The dedupe set is what keeps a tool failing in a loop from writing
		// thousands of records, so it must itself be bounded rather than growing
		// with the number of distinct failure classes a long session produces.
		// Saturation must evict, not latch shut: a long-lived process that stops
		// admitting new fingerprints past the cap loses all later telemetry.
		for (let i = 0; i < 256; i++)
			recordHandledError("Tool functions.read", errorAtFrame(`bounded failure ${i}`, `boundedFailure${i}`), {
				path: store.log,
			});
		const admitted = await journalLines(store.journal);
		expect(admitted).toHaveLength(256);

		// The 257th distinct fingerprint is admitted by evicting the coldest one.
		expect(
			recordHandledError("Tool functions.read", errorAtFrame("one past the bound", "onePastTheBound"), {
				path: store.log,
			}),
		).toBe(store.log);
		expect(await journalLines(store.journal)).toHaveLength(257);

		// "bounded failure 0" was the coldest and is gone, so it records again;
		// a still-hot fingerprint is deduped rather than evicted under pressure.
		expect(
			recordHandledError("Tool functions.read", errorAtFrame("bounded failure 0", "boundedFailure0"), {
				path: store.log,
			}),
		).toBe(store.log);
		expect(
			recordHandledError("Tool functions.read", errorAtFrame("one past the bound", "onePastTheBound"), {
				path: store.log,
			}),
		).toBeUndefined();
		expect(await journalLines(store.journal)).toHaveLength(258);
	});

	it("does not trip the fatal journal latch", async () => {
		// The fatal journal latch is process-wide and never cleared, so this must
		// run in a fresh process: sharing the test runner's process would let
		// earlier suites consume the one fatal journal write this asserts on.
		const handled = handledStore();
		const fatal = handledStore();
		const script = path.join(path.dirname(fatal.log), "latch.ts");
		fs.writeFileSync(
			script,
			`import { recordFatalCrash, recordHandledError } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/postmortem.ts"))};\n` +
				`recordHandledError("Tool functions.read", new Error("handled failure"), { path: ${JSON.stringify(handled.log)} });\n` +
				`const written = recordFatalCrash("Uncaught Exception", new Error("fatal failure"), { path: ${JSON.stringify(fatal.log)} });\n` +
				`if (written !== ${JSON.stringify(fatal.log)}) process.exit(1);\n`,
		);
		const spawned = Bun.spawnSync({ cmd: [process.execPath, script], stdout: "pipe", stderr: "pipe" });
		expect(spawned.exitCode).toBe(0);

		expect(await journalLines(handled.journal)).toHaveLength(1);
		expect(await journalLines(path.join(path.dirname(fatal.log), "gjc-crash-events.jsonl"))).toHaveLength(1);
	});
});
