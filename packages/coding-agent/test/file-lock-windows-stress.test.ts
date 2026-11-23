import { afterEach, expect, test } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { registerOwnedDeletionRoot } from "../../../scripts/safe-cleanup";
import { collectFileLocksForGc } from "../src/config/file-lock-gc";
import { gcPidProbe } from "../src/gjc-runtime/gc-runtime";

// Multi-process Windows lock contention. `file-lock-windows-contention.test.ts` injects
// each native refusal deterministically; this test lets real NTFS produce them. Every
// contender loops acquire -> append -> release on one lock from its own process, so
// `<lock>/info` handles, detach renames and owner-record deletions race the way
// concurrent TUI sessions, the SDK broker and session hosts race in production.
// Meanwhile this process runs `gjc gc` file-lock collection over the same root, as a
// `gjc gc` started during that traffic would.
//
// Opt-in: it spawns 10 processes for ~20 s. Run with
//   GJC_TEST_LOCK_STRESS=1 bun test test/file-lock-windows-stress.test.ts
// On the pre-fix tree the same loop fails 11-18% of acquisitions with
// "Failed to roll back file lock published during removal transition: owner_mismatch",
// "EBADF: bad file descriptor, lstat '<lock>'" and
// "EPERM: operation not permitted, open '<lock>.removing.owner'".
// Before GC skipped removal transitions, collection failed with
// "EPERM: operation not permitted, scandir '<lock>.removing'" on ~0.2% of passes.

const enabled = process.platform === "win32" && process.env.GJC_TEST_LOCK_STRESS === "1";
const PROCESSES = 10;
const ITERATIONS = 60;
// The coordinator transaction lock in session-state-sidecar polls every 5 ms; that is the
// cadence under which the pre-fix failure rate was highest.
const RETRY_DELAY_MS = 5;
const RETRIES = Math.ceil(2_000 / RETRY_DELAY_MS);

const tempDirs: { directory: string; forgetGrant: () => void }[] = [];

afterEach(async () => {
	for (const { directory, forgetGrant } of tempDirs.splice(0)) {
		try {
			await fs.rm(directory, { recursive: true, force: true });
		} finally {
			forgetGrant();
		}
	}
});

interface ContenderSummary {
	workerId: number;
	ok: number;
	failures: { phase: "acquire" | "release"; code: string; message: string }[];
}

function contenderSource(target: string, workerId: number): string {
	const fileLockModule = path.resolve(import.meta.dir, "../src/config/file-lock.ts");
	return `
		import * as fs from "node:fs/promises";
		import { acquireFileLock } from ${JSON.stringify(fileLockModule)};
		const target = ${JSON.stringify(target)};
		const failures = [];
		let ok = 0;
		for (let i = 0; i < ${ITERATIONS}; i++) {
			let release;
			try {
				release = await acquireFileLock(target, {
					retries: ${RETRIES},
					retryDelayMs: ${RETRY_DELAY_MS},
					ownerHostId: "stress-host",
				});
			} catch (error) {
				failures.push({ phase: "acquire", code: String(error?.code ?? "unknown"), message: String(error?.message ?? error).slice(0, 200) });
				continue;
			}
			await fs.appendFile(target, ${JSON.stringify(`${workerId}:`)} + i + "\\n");
			try {
				await release();
				ok++;
			} catch (error) {
				failures.push({ phase: "release", code: String(error?.code ?? "unknown"), message: String(error?.message ?? error).slice(0, 200) });
			}
		}
		process.stdout.write(JSON.stringify({ workerId: ${workerId}, ok, failures }));
	`;
}

test.skipIf(!enabled)(
	"concurrent processes acquire and release one lock without a single contention failure or leftover",
	async () => {
		const root = path.join(await fs.realpath(os.tmpdir()), `file-lock-windows-stress-${crypto.randomUUID()}`);
		const forgetGrant = registerOwnedDeletionRoot(root);
		try {
			await fs.mkdir(root, { mode: 0o700 });
		} catch (error) {
			forgetGrant();
			throw error;
		}
		tempDirs.push({ directory: root, forgetGrant });
		const target = path.join(root, "index.jsonl");
		await fs.writeFile(target, "");

		const children = Array.from({ length: PROCESSES }, (_, workerId) =>
			Bun.spawn([process.execPath, "-e", contenderSource(target, workerId)], {
				cwd: path.resolve(import.meta.dir, "../../.."),
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
				env: { ...process.env, GJC_CODING_AGENT_DIR: path.join(root, "isolated-agent-dir") },
			}),
		);
		let contending = true;
		let gcPasses = 0;
		const gcErrors: string[] = [];
		const gcLoop = (async () => {
			while (contending) {
				const collected = await collectFileLocksForGc(
					{ cwd: root, env: {}, force: false, probe: gcPidProbe },
					{ roots: [root] },
				);
				gcPasses++;
				gcErrors.push(...collected.errors.map(error => error.message));
			}
		})();
		const results = await Promise.all(
			children.map(async child => {
				const [exitCode, stdout, stderr] = await Promise.all([
					child.exited,
					new Response(child.stdout).text(),
					new Response(child.stderr).text(),
				]);
				return { exitCode, stdout, stderr };
			}),
		);
		contending = false;
		await gcLoop;

		// A concurrent GC pass never fails on a lock that is being acquired or retired.
		expect(gcErrors).toEqual([]);
		expect(gcPasses).toBeGreaterThan(0);

		const summaries: ContenderSummary[] = [];
		for (const { exitCode, stdout, stderr } of results) {
			expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
			summaries.push(JSON.parse(stdout) as ContenderSummary);
		}
		const failures = summaries.flatMap(summary => summary.failures.map(f => ({ workerId: summary.workerId, ...f })));
		expect(failures).toEqual([]);
		expect(summaries.reduce((sum, summary) => sum + summary.ok, 0)).toBe(PROCESSES * ITERATIONS);

		// Every acquisition protected exactly one append, and nothing was lost under the lock.
		const lines = (await fs.readFile(target, "utf8")).split("\n").filter(Boolean);
		expect(lines).toHaveLength(PROCESSES * ITERATIONS);
		expect(new Set(lines).size).toBe(PROCESSES * ITERATIONS);

		// No empty lock directory, retained transition, remover record or staging dir survives.
		const leftovers = (await fs.readdir(root)).filter(
			name => name !== "index.jsonl" && name !== "isolated-agent-dir",
		);
		expect(leftovers).toEqual([]);
	},
	120_000,
);
