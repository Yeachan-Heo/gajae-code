import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@gajae-code/utils";
import { ARTIFACTS_ROOT, buildReport } from "../bench/multisession/run";
import type { ArmKind, RepRecord, RunnerEvent } from "../bench/multisession/types";

let tempDir: TempDir | undefined;

afterEach(() => {
	tempDir?.removeSync();
	tempDir = undefined;
});

const PINS = {
	sourceSha: "abc",
	dirty: false,
	workloadDigest: "w",
	bootstrapDigest: "b",
	bunVersion: "1.4.0",
	osVersion: "macOS 26",
	cpu: "Apple M5 Max",
	contractDigest: "sha256:c",
};

async function evidenceDir(root: string): Promise<string> {
	const dir = path.join(root, "evidence");
	for (const stream of ["transcript.jsonl", "requests.jsonl", "tools.jsonl", "events.jsonl"]) {
		await Bun.write(path.join(dir, stream), "");
	}
	return dir;
}

function rep(arm: ArmKind, n: number, evidence: Array<string | undefined>): RepRecord {
	const runnerEvents: RunnerEvent[] = [];
	evidence.forEach((dir, sessionIndex) => {
		if (dir) runnerEvents.push({ type: "done", sessionIndex, evidenceDir: dir });
	});
	return {
		arm,
		n,
		rep: 1,
		samples: [],
		gatedWindowTicks: [],
		teardownTick: null,
		runnerEvents,
		coldReadyMs: [],
		warmAdmissionMs: [],
		visibilityCheck: { passed: true },
		orphans: { owned: [], unresolved: [], complete: true, errors: [] },
	};
}

async function writeRun(runDir: string, records: RepRecord[], pins: Record<string, unknown> = PINS): Promise<void> {
	await Bun.write(path.join(runDir, "environment.json"), JSON.stringify(pins));
	for (const record of records) {
		await Bun.write(path.join(runDir, `rep-${record.arm}-n${record.n}-r${record.rep}.json`), JSON.stringify(record));
	}
}

describe("multi-session report assembly", () => {
	it("refuses to combine run directories with different provenance pins", async () => {
		tempDir = TempDir.createSync("@bench-multisession-assembly-pins-");
		const root = tempDir.path();
		await writeRun(path.join(root, "run-a"), [rep("standalone", 1, [])]);
		await writeRun(path.join(root, "run-b"), [rep("worker", 1, [])], { ...PINS, bunVersion: "1.4.1" });
		await expect(buildReport(root)).rejects.toThrow("inconsistent provenance pins");
	});

	it("refuses an operand whose run directory has no environment pins", async () => {
		tempDir = TempDir.createSync("@bench-multisession-assembly-nopins-");
		const root = tempDir.path();
		const runDir = path.join(root, "run-a");
		await Bun.write(path.join(runDir, "rep-standalone-n1-r1.json"), JSON.stringify(rep("standalone", 1, [])));
		await expect(buildReport(root)).rejects.toThrow("no environment.json pins");
	});

	it("refuses identically incomplete pins instead of treating them as consistent", async () => {
		tempDir = TempDir.createSync("@bench-multisession-assembly-partial-");
		const root = tempDir.path();
		const { sourceSha: _sourceSha, ...partial } = PINS;
		await writeRun(path.join(root, "run-a"), [rep("standalone", 1, [])], partial);
		await writeRun(path.join(root, "run-b"), [rep("worker", 1, [])], partial);
		await expect(buildReport(root)).rejects.toThrow("missing provenance pins: sourceSha");
		await writeRun(path.join(root, "run-a"), [rep("standalone", 1, [])], {});
		await expect(buildReport(root)).rejects.toThrow("missing provenance pins");
	});

	it("counts an unmatched repetition and a missing session as fidelity differences", async () => {
		tempDir = TempDir.createSync("@bench-multisession-assembly-fidelity-");
		const root = tempDir.path();
		const runDir = path.join(root, "run-a");
		const standalone0 = await evidenceDir(path.join(runDir, "s0"));
		const standalone1 = await evidenceDir(path.join(runDir, "s1"));
		const worker0 = await evidenceDir(path.join(runDir, "w0"));
		await writeRun(runDir, [
			// N=2: worker session 1 produced no evidence.
			rep("standalone", 2, [standalone0, standalone1]),
			rep("worker", 2, [worker0, undefined]),
			// N=3: standalone only, no worker counterpart at all.
			rep("standalone", 3, []),
		]);
		const { fidelityDiffs, markdown } = await buildReport(root);
		expect(fidelityDiffs).toEqual(["n2 r1 s1: no worker evidence", "n3 r1: no worker repetition to compare"]);
		expect(markdown).toContain("Fidelity comparisons: 1 session pairs, 2 differences");
		expect(markdown).toContain("| fidelity | fail |");
	});
});

describe("multi-session CLI refusals", () => {
	const runScript = path.join(import.meta.dir, "..", "bench", "multisession", "run.ts");
	const runDirs = async (): Promise<string[]> => fs.readdir(ARTIFACTS_ROOT).catch(() => []);

	it.each([
		[
			["--arm", "bogus"],
			"--arm must be one of broker|standalone|preflight|worker (or use --report / --characterize / --sanity)",
		],
		[["--arm", "standalone", "--reps", "0"], '--reps must be a positive integer, got "0"'],
		[["--arm", "standalone", "--n", "1,x"], '--n must be a positive integer, got "x"'],
	])("rejects %p with one error line and writes no run directory", async (args, message) => {
		const before = await runDirs();
		const child = Bun.spawn([process.execPath, runScript, ...args], { stdout: "pipe", stderr: "pipe" });
		const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
		expect(exitCode).toBe(1);
		expect(stderr.trim()).toBe(`multisession: ${message}`);
		expect(await runDirs()).toEqual(before);
	});
});
