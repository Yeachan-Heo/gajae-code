/**
 * Test-process log-directory isolation decision (scripts/test-log-dir-isolation.ts).
 *
 * The preload that consumes this decision is what keeps `bun test` from
 * appending fixture `level:error` records to the operator's live
 * `~/.gjc/logs/gjc.<date>.log` (issue #5618). The decision is unit-tested here
 * because importing the preload would apply its environment mutations.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { decideLogDirIsolation } from "../../../scripts/test-log-dir-isolation";

describe("test log-dir isolation decision", () => {
	test("isolates when no override is present", () => {
		expect(decideLogDirIsolation({ env: {}, projectEnv: {} })).toEqual({ action: "isolate", reason: "absent" });
	});

	test("isolates a blank override", () => {
		expect(decideLogDirIsolation({ env: { GJC_LOG_DIR: "   " }, projectEnv: {} })).toEqual({
			action: "isolate",
			reason: "absent",
		});
	});

	test("isolates an override the project .env declares", () => {
		// Bun overlays `cwd/.env` into `process.env` before any module runs, so
		// honoring a repo-declared value would isolate nothing.
		const planted = "/repo/shipped-log-dir";
		expect(decideLogDirIsolation({ env: { GJC_LOG_DIR: planted }, projectEnv: { GJC_LOG_DIR: planted } })).toEqual({
			action: "isolate",
			reason: "untrusted",
		});
	});

	test("isolates an inherited value whenever the project .env declares the key at all", () => {
		// Stricter than production's value-equality rule on purpose: a test preload
		// has no reason to honor a repo-declared log directory, whatever it says.
		expect(
			decideLogDirIsolation({
				env: { GJC_LOG_DIR: "/tmp/inherited-logs" },
				projectEnv: { GJC_LOG_DIR: "/repo/shipped-log-dir" },
			}),
		).toEqual({ action: "isolate", reason: "untrusted" });
	});

	test("refuses to run when the project .env declares the key dynamically", () => {
		// Bun expands the value at load time, so production's trust check rejects
		// the key regardless of what this preload pins — every write would fall
		// back to the operator's live sink. Fail closed instead.
		expect(
			decideLogDirIsolation({ env: { GJC_LOG_DIR: "/tmp/expanded" }, projectEnv: { GJC_LOG_DIR: "$HOME/logs" } }),
		).toEqual({ action: "fail", reason: "dynamic" });
	});

	test("refuses a backtick declaration even when the expansion left the value blank", () => {
		// Checked before the value, not after: the key is poisoned for the whole
		// process, so an absent current value is not a reason to isolate and move on.
		expect(decideLogDirIsolation({ env: {}, projectEnv: { GJC_LOG_DIR: "`pwd`/logs" } })).toEqual({
			action: "fail",
			reason: "dynamic",
		});
	});

	test("honors an explicit trusted pin", () => {
		expect(decideLogDirIsolation({ env: { GJC_LOG_DIR: "/tmp/pinned-logs" }, projectEnv: {} })).toEqual({
			action: "honor",
			logDir: "/tmp/pinned-logs",
		});
	});

	test("honors a trusted pin with surrounding whitespace, trimmed", () => {
		expect(decideLogDirIsolation({ env: { GJC_LOG_DIR: " /tmp/pinned-logs " }, projectEnv: {} })).toEqual({
			action: "honor",
			logDir: "/tmp/pinned-logs",
		});
	});
});

describe("preload log-sink behavior (real preload path)", () => {
	const preload = path.resolve(import.meta.dir, "../../../scripts/test-preload.ts");
	const printLogDir = "console.log(process.env.GJC_LOG_DIR)";

	/** Child env copied into an index signature so `delete` type-checks under Bun's known-key typing. */
	function childEnv(overrides: Record<string, string>): Record<string, string | undefined> {
		const env: Record<string, string | undefined> = { ...process.env };
		delete env.GJC_LOG_DIR;
		return { ...env, ...overrides };
	}

	test("replaces a log dir the project .env planted with a fresh isolated sink", async () => {
		const planted = await fs.promises.mkdtemp(path.join(os.tmpdir(), "gjc-preload-planted-logs-"));
		const cwd = await fs.promises.mkdtemp(path.join(os.tmpdir(), "gjc-preload-logcwd-"));
		await fs.promises.writeFile(path.join(cwd, ".env"), `GJC_LOG_DIR=${planted}\n`);
		try {
			const probe = Bun.spawnSync({
				cmd: [process.execPath, "--preload", preload, "-e", printLogDir],
				cwd,
				env: childEnv({ GJC_LOG_DIR: planted }),
				stdout: "pipe",
				stderr: "pipe",
			});
			const adopted = probe.stdout.toString().trim();
			expect(probe.exitCode).toBe(0);
			expect(adopted).not.toBe(planted);
			expect(path.basename(adopted).startsWith("gjc-test-logs-")).toBe(true);
			await fs.promises.rm(adopted, { recursive: true, force: true });
		} finally {
			await fs.promises.rm(planted, { recursive: true, force: true });
			await fs.promises.rm(cwd, { recursive: true, force: true });
		}
	}, 30_000);

	test("refuses to run when the project .env declares GJC_LOG_DIR dynamically", async () => {
		const cwd = await fs.promises.mkdtemp(path.join(os.tmpdir(), "gjc-preload-dynlogcwd-"));
		await fs.promises.writeFile(path.join(cwd, ".env"), "GJC_LOG_DIR=$HOME/planted-logs\n");
		try {
			const probe = Bun.spawnSync({
				cmd: [process.execPath, "--preload", preload, "-e", printLogDir],
				cwd,
				env: childEnv({}),
				stdout: "pipe",
				stderr: "pipe",
			});
			expect(probe.exitCode).not.toBe(0);
			expect(probe.stderr.toString()).toContain("Test log-directory isolation failed (dynamic)");
			// It must not have adopted (or printed) any log dir at all.
			expect(probe.stdout.toString().trim()).toBe("");
		} finally {
			await fs.promises.rm(cwd, { recursive: true, force: true });
		}
	}, 30_000);

	test("an explicit trusted pin survives the real preload", async () => {
		const pinned = await fs.promises.mkdtemp(path.join(os.tmpdir(), "gjc-preload-pinned-logs-"));
		try {
			const probe = Bun.spawnSync({
				cmd: [process.execPath, "--preload", preload, "-e", printLogDir],
				env: childEnv({ GJC_LOG_DIR: pinned }),
				stdout: "pipe",
				stderr: "pipe",
			});
			expect(probe.exitCode).toBe(0);
			expect(probe.stdout.toString().trim()).toBe(pinned);
		} finally {
			await fs.promises.rm(pinned, { recursive: true, force: true });
		}
	}, 30_000);
});
