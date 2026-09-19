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
import type { ProjectEnvSnapshot } from "../src/env-file";

/**
 * Build the canonical provenance snapshot shape the decision now consumes.
 *
 * `dynamic` is supplied explicitly rather than re-derived from `values`: the
 * real snapshot applies later-layer precedence, so the two can legitimately
 * disagree and the decision must follow the snapshot, not the value text.
 */
function snapshot(values: Record<string, string> = {}, dynamic: string[] = []): ProjectEnvSnapshot {
	return { values, dynamic: new Set(dynamic) };
}

describe("test log-dir isolation decision", () => {
	test("isolates when no override is present", () => {
		expect(decideLogDirIsolation({ env: {}, projectEnv: snapshot() })).toEqual({
			action: "isolate",
			reason: "absent",
		});
	});

	test("isolates a blank override", () => {
		expect(decideLogDirIsolation({ env: { GJC_LOG_DIR: "   " }, projectEnv: snapshot() })).toEqual({
			action: "isolate",
			reason: "absent",
		});
	});

	test("isolates an override the project dotenv declares", () => {
		// Bun overlays the checkout's dotenv files into `process.env` before any
		// module runs, so honoring a repo-declared value would isolate nothing.
		const planted = "/repo/shipped-log-dir";
		expect(
			decideLogDirIsolation({ env: { GJC_LOG_DIR: planted }, projectEnv: snapshot({ GJC_LOG_DIR: planted }) }),
		).toEqual({ action: "isolate", reason: "untrusted" });
	});

	test("isolates an inherited value whenever the project dotenv declares the key at all", () => {
		// Stricter than production's value-equality rule on purpose: a test preload
		// has no reason to honor a repo-declared log directory, whatever it says.
		expect(
			decideLogDirIsolation({
				env: { GJC_LOG_DIR: "/tmp/inherited-logs" },
				projectEnv: snapshot({ GJC_LOG_DIR: "/repo/shipped-log-dir" }),
			}),
		).toEqual({ action: "isolate", reason: "untrusted" });
	});

	test("isolates a declaration that came from a layered dotenv file", () => {
		// `.env.local` / `.env.$NODE_ENV` / `.env.$NODE_ENV.local` are part of the
		// snapshot production resolves from. A reader that saw only `cwd/.env`
		// honored these and left the suite writing to the operator's sink.
		expect(
			decideLogDirIsolation({
				env: { GJC_LOG_DIR: "/repo/layered-log-dir" },
				projectEnv: snapshot({ GJC_LOG_DIR: "/repo/layered-log-dir" }),
			}),
		).toEqual({ action: "isolate", reason: "untrusted" });
	});

	test("refuses to run when the project dotenv declares the key dynamically", () => {
		// Bun expands the value at load time, so production's trust check rejects
		// the key regardless of what this preload pins — every write would fall
		// back to the operator's live sink. Fail closed instead.
		expect(
			decideLogDirIsolation({
				env: { GJC_LOG_DIR: "/tmp/expanded" },
				projectEnv: snapshot({ GJC_LOG_DIR: "$HOME/logs" }, ["GJC_LOG_DIR"]),
			}),
		).toEqual({ action: "fail", reason: "dynamic" });
	});

	test("refuses a dynamic declaration that came from a layered dotenv file", () => {
		expect(
			decideLogDirIsolation({
				env: { GJC_LOG_DIR: "/tmp/expanded" },
				projectEnv: snapshot({ GJC_LOG_DIR: "`pwd`/logs" }, ["GJC_LOG_DIR"]),
			}),
		).toEqual({ action: "fail", reason: "dynamic" });
	});

	test("refuses a dynamic declaration even when the expansion left the value blank", () => {
		// Checked before the value, not after: the key is poisoned for the whole
		// process, so an absent current value is not a reason to isolate and move on.
		expect(
			decideLogDirIsolation({ env: {}, projectEnv: snapshot({ GJC_LOG_DIR: "`pwd`/logs" }, ["GJC_LOG_DIR"]) }),
		).toEqual({ action: "fail", reason: "dynamic" });
	});

	test("isolates — not fails — when a later dotenv layer redeclared the key statically", () => {
		// The precedence case, and the one that proves the snapshot's verdict is
		// CONSUMED rather than recomputed: `.env` declared `$HOME/logs` but
		// `.env.test` redeclared it statically, so `projectEnvSnapshot()` called
		// `dynamic.delete(key)`. A local `/[$`]/` re-test of the surviving value
		// would still see the stale dynamic text and wrongly fail closed here.
		expect(
			decideLogDirIsolation({
				env: { GJC_LOG_DIR: "/repo/static-override" },
				projectEnv: snapshot({ GJC_LOG_DIR: "/repo/static-override" }, []),
			}),
		).toEqual({ action: "isolate", reason: "untrusted" });
	});

	test("fails closed when a later layer redeclared the key dynamically", () => {
		// The mirror of the case above: the snapshot's `dynamic.add(key)` wins even
		// though the surviving value text has no `$` or backtick left to re-test.
		expect(
			decideLogDirIsolation({
				env: { GJC_LOG_DIR: "/tmp/expanded" },
				projectEnv: snapshot({ GJC_LOG_DIR: "/plain/looking/value" }, ["GJC_LOG_DIR"]),
			}),
		).toEqual({ action: "fail", reason: "dynamic" });
	});

	test("honors an explicit trusted pin", () => {
		expect(decideLogDirIsolation({ env: { GJC_LOG_DIR: "/tmp/pinned-logs" }, projectEnv: snapshot() })).toEqual({
			action: "honor",
			logDir: "/tmp/pinned-logs",
		});
	});

	test("honors a trusted pin with surrounding whitespace, trimmed", () => {
		expect(decideLogDirIsolation({ env: { GJC_LOG_DIR: " /tmp/pinned-logs " }, projectEnv: snapshot() })).toEqual({
			action: "honor",
			logDir: "/tmp/pinned-logs",
		});
	});

	test("isolates a key declared with an empty value", () => {
		// `Object.hasOwn`, not truthiness: `GJC_LOG_DIR=` in a dotenv file is still
		// a declaration, and the checkout still authored it.
		expect(
			decideLogDirIsolation({ env: { GJC_LOG_DIR: "/tmp/inherited" }, projectEnv: snapshot({ GJC_LOG_DIR: "" }) }),
		).toEqual({ action: "isolate", reason: "untrusted" });
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

	/**
	 * Drive the real preload AND the real production resolver in one child: the
	 * probe prints what `getEffectiveLogsDir()` resolves after the preload ran, so
	 * these assert writer/reader agreement rather than just the pinned string.
	 *
	 * The bug this guards: the preload honored a layered declaration (so it never
	 * isolated) while production's `trustedValue()` rejected it and fell back to
	 * the canonical sink — isolation appeared to work while every record landed in
	 * the operator's `~/.gjc/logs`.
	 */
	const PROBE = path.join(import.meta.dir, "fixtures", "log-dir-trust-probe.ts");

	interface ProbeResult {
		adopted: string;
		effectiveLogsDir: string | null;
		canonicalLogsDir: string;
	}

	async function runLayeredPlantProbe(options: {
		dotenvFile: string;
		nodeEnv: string | undefined;
	}): Promise<ProbeResult> {
		const planted = await fs.promises.mkdtemp(path.join(os.tmpdir(), "gjc-preload-layered-planted-"));
		const home = await fs.promises.mkdtemp(path.join(os.tmpdir(), "gjc-preload-layered-home-"));
		const cwd = await fs.promises.mkdtemp(path.join(os.tmpdir(), "gjc-preload-layered-cwd-"));
		await fs.promises.writeFile(path.join(cwd, options.dotenvFile), `GJC_LOG_DIR=${planted}\n`);
		try {
			const env = childEnv({ HOME: home });
			// NODE_ENV decides which layered files production reads at all, so each
			// case must run under the NODE_ENV that makes its file live. `bun test`
			// sets NODE_ENV=test in this parent, so a `.env.local` case has to clear
			// it explicitly — production deliberately SKIPS `.env.local` under
			// NODE_ENV=test, and asserting isolation there would assert a bug.
			if (options.nodeEnv === undefined) delete env.NODE_ENV;
			else env.NODE_ENV = options.nodeEnv;
			// Keep the canonical logs dir a plain `<home>/.gjc/logs`.
			delete env.GJC_CONFIG_DIR;
			delete env.PI_CONFIG_DIR;
			delete env.XDG_STATE_HOME;
			delete env.XDG_DATA_HOME;
			delete env.XDG_CACHE_HOME;

			const probe = Bun.spawnSync({
				cmd: [process.execPath, "--preload", preload, PROBE],
				cwd,
				env,
				stdout: "pipe",
				stderr: "pipe",
			});
			const stdout = probe.stdout.toString();
			expect(probe.exitCode, `probe failed: ${stdout}\n${probe.stderr.toString()}`).toBe(0);
			// The probe prints one JSON line; the preload prints nothing.
			const resolved = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as {
				effectiveLogsDir: string | null;
			};
			const adopted = resolved.effectiveLogsDir ?? "";

			expect(adopted).not.toBe(planted);
			expect(path.basename(adopted).startsWith("gjc-test-logs-")).toBe(true);
			expect(adopted).not.toBe(path.join(home, ".gjc", "logs"));
			await fs.promises.rm(adopted, { recursive: true, force: true });
			return {
				adopted,
				effectiveLogsDir: resolved.effectiveLogsDir,
				canonicalLogsDir: path.join(home, ".gjc", "logs"),
			};
		} finally {
			await fs.promises.rm(planted, { recursive: true, force: true });
			await fs.promises.rm(home, { recursive: true, force: true });
			await fs.promises.rm(cwd, { recursive: true, force: true });
		}
	}

	test("isolates a GJC_LOG_DIR planted in .env.local", async () => {
		// NODE_ENV cleared: production reads `.env.local` only when NODE_ENV is not
		// "test", so this is the configuration in which the declaration is live.
		await runLayeredPlantProbe({ dotenvFile: ".env.local", nodeEnv: undefined });
	}, 30_000);

	test("isolates a GJC_LOG_DIR planted in .env.test", async () => {
		await runLayeredPlantProbe({ dotenvFile: ".env.test", nodeEnv: "test" });
	}, 30_000);

	test("isolates a GJC_LOG_DIR planted in .env.test.local", async () => {
		await runLayeredPlantProbe({ dotenvFile: ".env.test.local", nodeEnv: "test" });
	}, 30_000);

	test("honors a .env.local plant under NODE_ENV=test, which production never reads", async () => {
		// The control for the CRITICAL asymmetry above. Production's file list skips
		// `.env.local` when NODE_ENV === "test", so the declaration is invisible to
		// `trustedValue()` too — honoring it here keeps the preload and the resolver
		// in agreement, which is the whole point. Asserting isolation would be
		// asserting a bug.
		const planted = await fs.promises.mkdtemp(path.join(os.tmpdir(), "gjc-preload-localskip-"));
		const cwd = await fs.promises.mkdtemp(path.join(os.tmpdir(), "gjc-preload-localskip-cwd-"));
		await fs.promises.writeFile(path.join(cwd, ".env.local"), `GJC_LOG_DIR=${planted}\n`);
		try {
			const probe = Bun.spawnSync({
				cmd: [process.execPath, "--preload", preload, "-e", printLogDir],
				cwd,
				env: childEnv({ GJC_LOG_DIR: planted, NODE_ENV: "test" }),
				stdout: "pipe",
				stderr: "pipe",
			});
			expect(probe.exitCode).toBe(0);
			expect(probe.stdout.toString().trim()).toBe(planted);
		} finally {
			await fs.promises.rm(planted, { recursive: true, force: true });
			await fs.promises.rm(cwd, { recursive: true, force: true });
		}
	}, 30_000);

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
