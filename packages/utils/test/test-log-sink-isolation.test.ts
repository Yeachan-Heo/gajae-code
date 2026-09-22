import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Guard for issue #5618: a test process must never append real `level:error`
 * records to the operator's shared `~/.gjc/logs/gjc.<date>.log`.
 *
 * This drives the real path rather than a mock — a nested `bun test` of one ACP
 * prompt-watchdog case, which reaches `logger.error("acp_prompt_watchdog_expired")`
 * through production code. Remove the `GJC_LOG_DIR` pin from
 * `scripts/test-preload.ts` and this fails on the record count.
 */

const REPO_ROOT = path.resolve(import.meta.dir, "../../..");
const PRELOAD = path.join(REPO_ROOT, "scripts", "test-preload.ts");
const PROBE = path.join(import.meta.dir, "fixtures", "log-dir-trust-probe.ts");
const WATCHDOG_TEST = "packages/coding-agent/test/acp-prompt-watchdog.test.ts";
const WATCHDOG_CASE = "a prompt awaiting the model past the inference bound is rejected instead of hanging";
const MARKER = "acp_prompt_watchdog_expired";

/**
 * Count marker records across every `gjc.*.log` under a home.
 *
 * Globs rather than computing one filename: winston's DailyRotateFile names
 * files by LOCAL date while `getLogPath()` uses the UTC date, so a single-name
 * lookup silently misses the file near midnight.
 */
async function countMarkerRecords(home: string): Promise<number> {
	const logsDir = path.join(home, ".gjc", "logs");
	const entries = await fs.readdir(logsDir).catch(() => [] as string[]);
	let count = 0;
	for (const entry of entries) {
		if (!entry.startsWith("gjc.") || !entry.endsWith(".log")) continue;
		const content = await fs.readFile(path.join(logsDir, entry), "utf8").catch(() => "");
		count += content.split("\n").filter(line => line.includes(MARKER)).length;
	}
	return count;
}

async function countMarkersInDir(logsDir: string): Promise<number> {
	const entries = await fs.readdir(logsDir).catch(() => [] as string[]);
	let count = 0;
	for (const entry of entries) {
		if (!entry.startsWith("gjc.") || !entry.endsWith(".log")) continue;
		const content = await fs.readFile(path.join(logsDir, entry), "utf8").catch(() => "");
		count += content.split("\n").filter(line => line.includes("gjc_log_dir_trust_probe_marker")).length;
	}
	return count;
}

test("test logger rejects an inherited operator sink", async () => {
	const home = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-log-sink-path-"));
	const operatorHome = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-log-sink-operator-home-"));
	const operatorXdgStateHome = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-log-sink-operator-xdg-"));
	try {
		await fs.mkdir(path.join(operatorXdgStateHome, "gjc"), { recursive: true });
		const inheritedOperatorSink = path.join(operatorHome, ".gjc", "logs");
		const env: Record<string, string | undefined> = {
			...process.env,
			HOME: home,
			// Simulate a parent preload that selected this path before the child
			// switched to its own temporary HOME. The inherited XDG root makes the
			// two canonical spellings differ, which is the gap the preload must close
			// rather than letting the pin reach the operator sink.
			XDG_STATE_HOME: operatorXdgStateHome,
			GJC_LOG_DIR: inheritedOperatorSink,
			GJC_TEST_PRELOAD_LOG_DIR_PROVENANCE: inheritedOperatorSink,
			GJC_PROBE_WRITE: "1",
		};

		const proc = Bun.spawn([process.execPath, "--preload", PRELOAD, PROBE], {
			cwd: REPO_ROOT,
			env,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		expect(exitCode, `log probe failed:\n${stdout}\n${stderr}`).toBe(0);
		const result = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as {
			effectiveLogsDir: string | null;
			markerDir: string | null;
		};
		expect(result.effectiveLogsDir).not.toBe(inheritedOperatorSink);
		expect(path.basename(result.effectiveLogsDir ?? "")).toMatch(/^gjc-test-logs-/);
		expect(result.markerDir).toBe(result.effectiveLogsDir);
		expect(await countMarkersInDir(result.effectiveLogsDir ?? "")).toBeGreaterThan(0);
		expect(await countMarkerRecords(operatorHome)).toBe(0);
	} finally {
		await Promise.all([
			fs.rm(home, { recursive: true, force: true }),
			fs.rm(operatorHome, { recursive: true, force: true }),
			fs.rm(operatorXdgStateHome, { recursive: true, force: true }),
		]);
	}
}, 30_000);

test("test logger honors an explicitly owned sink under its HOME", async () => {
	const home = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-log-sink-owned-home-"));
	try {
		const owned = path.join(home, ".gjc", "logs");
		const env: Record<string, string | undefined> = {
			...process.env,
			HOME: home,
			GJC_LOG_DIR: owned,
			GJC_TEST_PRELOAD_LOG_DIR_PROVENANCE: path.join(home, ".gjc", "parent-logs"),
			GJC_PROBE_WRITE: "1",
		};
		const proc = Bun.spawn([process.execPath, "--preload", PRELOAD, PROBE], {
			cwd: REPO_ROOT,
			env,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		expect(exitCode, `log probe failed:\n${stdout}\n${stderr}`).toBe(0);
		const result = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as {
			effectiveLogsDir: string | null;
			markerDir: string | null;
		};
		expect(result.effectiveLogsDir).toBe(owned);
		expect(result.markerDir).toBe(owned);
		expect(await countMarkersInDir(owned)).toBeGreaterThan(0);
	} finally {
		await fs.rm(home, { recursive: true, force: true });
	}
}, 30_000);

test("a test process does not write watchdog errors into the operator log sink", async () => {
	const home = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-log-sink-guard-"));

	// Drop the inherited pin so the child's own preload has to isolate itself;
	// inheriting it would make this pass without exercising the guard at all.
	// Widened to an index-signature copy because Bun types `process.env` with
	// known keys only, so `delete` on the spread result does not type-check.
	const env: Record<string, string | undefined> = { ...process.env, HOME: home };
	delete env.GJC_LOG_DIR;
	// Keep the nested preload independent from the parent test process's
	// temporary profile and ambient XDG state. The child has no log pin of its
	// own, so the marker is pinned to the default lane for deterministic sink
	// comparison.
	delete env.XDG_STATE_HOME;
	env.GJC_TEST_PRELOAD_PROFILE_AUTHORITY = "default";

	const proc = Bun.spawn([process.execPath, "test", WATCHDOG_TEST, "-t", WATCHDOG_CASE], {
		cwd: REPO_ROOT,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	expect(exitCode, `nested bun test failed:\n${stdout}\n${stderr}`).toBe(0);

	// Poll before asserting zero: winston's transport is async, so an instant
	// read can pass vacuously on a sink that is about to be written.
	const deadline = Date.now() + 5000;
	let count = 0;
	while (Date.now() < deadline) {
		count = await countMarkerRecords(home);
		if (count > 0) break;
		await new Promise(resolve => setTimeout(resolve, 100));
	}

	expect(count).toBe(0);
}, 180_000);
