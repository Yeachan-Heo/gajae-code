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

test(
	"a test process does not write watchdog errors into the operator log sink",
	async () => {
		const home = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-log-sink-guard-"));

		// Drop the inherited pin so the child's own preload has to isolate itself;
		// inheriting it would make this pass without exercising the guard at all.
		const env = { ...process.env, HOME: home };
		delete env.GJC_LOG_DIR;

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
	},
	180_000,
);
