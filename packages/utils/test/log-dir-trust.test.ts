import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * `GJC_LOG_DIR` selects where the rotating file transport writes and where every
 * log reader looks (issue #5618). Bun loads `cwd/.env` into `process.env` before
 * any module runs, so a repository that plants this variable could otherwise
 * redirect the operator's production log writes into a directory it ships.
 *
 * The trust snapshot and the override are both resolved from `process.cwd()`, so
 * these drive a child process with a controlled cwd holding a planted `.env`.
 * The `.env` is always written into a temp directory — never the repo root.
 */

const PROBE = path.join(import.meta.dir, "fixtures", "log-dir-trust-probe.ts");
const DATED_LOG_NAME = /^gjc\.\d{4}-\d{2}-\d{2}\.log$/;

interface Resolved {
	effectiveLogsDir: string | null;
	effectiveLogPath: string | null;
	logsDir: string | null;
	logPath: string | null;
	markerDir: string | null;
}

const tempDirs: string[] = [];

function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-log-dir-trust-"));
	tempDirs.push(dir);
	return dir;
}

function projectDir(dotenv: string): string {
	const dir = tempDir();
	fs.writeFileSync(path.join(dir, ".env"), dotenv);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function resolveIn(
	cwd: string,
	home: string,
	overrides: Record<string, string> = {},
): Promise<Resolved & { canonicalLogsDir: string }> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) env[key] = value;
	}
	// This test process was itself pinned by the preload; the child has to
	// resolve its own or the planted `.env` would never be exercised.
	delete env.GJC_LOG_DIR;
	delete env.GJC_CONFIG_DIR;
	delete env.PI_CONFIG_DIR;
	delete env.GJC_CODING_AGENT_DIR;
	delete env.PI_CODING_AGENT_DIR;
	delete env.GJC_PROBE_WRITE;
	// Keep the canonical logs directory a plain `<home>/.gjc/logs`.
	delete env.XDG_STATE_HOME;
	delete env.XDG_DATA_HOME;
	delete env.XDG_CACHE_HOME;
	env.HOME = home;
	Object.assign(env, overrides);

	const proc = Bun.spawn([process.execPath, PROBE], { cwd, env, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	const exitCode = await proc.exited;
	if (exitCode !== 0) throw new Error(`probe failed (${exitCode}): ${stderr}`);
	return {
		...(JSON.parse(stdout.trim()) as Resolved),
		canonicalLogsDir: path.join(home, ".gjc", "logs"),
	};
}

describe("log directory trust boundary", () => {
	it("ignores a log directory planted by the project .env", async () => {
		const planted = tempDir();
		const home = tempDir();
		const resolved = await resolveIn(projectDir(`GJC_LOG_DIR=${planted}\n`), home, { GJC_PROBE_WRITE: "1" });
		expect(resolved.effectiveLogsDir).not.toBe(planted);
		expect(resolved.effectiveLogsDir).toBe(resolved.canonicalLogsDir);
		// The transport must refuse the plant too, not just the readers: a second
		// env read inside the logger is what made writers and readers disagree.
		expect(resolved.markerDir).toBe(resolved.canonicalLogsDir);
		expect(fs.existsSync(planted) && fs.readdirSync(planted).length).toBe(0);
	}, 60_000);

	it("ignores an exported log directory planted by the project .env", async () => {
		const planted = tempDir();
		const home = tempDir();
		const resolved = await resolveIn(projectDir(`export GJC_LOG_DIR=${planted}\n`), home);
		expect(resolved.effectiveLogsDir).not.toBe(planted);
		expect(resolved.effectiveLogsDir).toBe(resolved.canonicalLogsDir);
	}, 30_000);

	it("ignores a log directory the project .env plants dynamically", async () => {
		// Bun expands `$HOME` at load time, so a value comparison cannot see what
		// the declaration became. The trust check rejects the key outright.
		const home = tempDir();
		const resolved = await resolveIn(projectDir("GJC_LOG_DIR=$HOME/planted-logs\n"), home);
		expect(resolved.effectiveLogsDir).not.toBe(path.join(home, "planted-logs"));
		expect(resolved.effectiveLogsDir).toBe(resolved.canonicalLogsDir);
	}, 30_000);

	it("does not let the project .env redirect a log directory inherited from the shell", async () => {
		const operatorDir = tempDir();
		const plantedDir = tempDir();
		const home = tempDir();
		const resolved = await resolveIn(projectDir(`GJC_LOG_DIR=${plantedDir}\n`), home, {
			GJC_LOG_DIR: operatorDir,
		});
		expect(resolved.effectiveLogsDir).toBe(operatorDir);
	}, 30_000);

	it("writes to, and reads back from, the same directory for a trusted pin", async () => {
		const pinned = tempDir();
		const home = tempDir();
		const resolved = await resolveIn(projectDir("SOMETHING_ELSE=1\n"), home, {
			GJC_LOG_DIR: pinned,
			GJC_PROBE_WRITE: "1",
		});

		// Reader side: the effective helpers point at the pin...
		expect(resolved.effectiveLogsDir).toBe(pinned);
		expect(path.dirname(resolved.effectiveLogPath ?? "")).toBe(pinned);
		// ...with the same dated-filename shape as the canonical path. Compared by
		// basename rather than a recomputed date so a midnight rollover between the
		// two processes cannot make this flake.
		expect(path.basename(resolved.effectiveLogPath ?? "")).toMatch(DATED_LOG_NAME);
		expect(path.basename(resolved.effectiveLogPath ?? "")).toBe(path.basename(resolved.logPath ?? ""));

		// Writer side: the transport actually landed there. Asserted on the
		// directory, not the file, because winston's DailyRotateFile names files by
		// LOCAL date while `getEffectiveLogPath()` uses the UTC date.
		expect(resolved.markerDir).toBe(pinned);

		// The split is intentional and scoped: the canonical helpers still resolve
		// the config root, which is what `dirs-python-gateway` and
		// `composer-detach-overlay-paths` pin.
		expect(resolved.logsDir).toBe(resolved.canonicalLogsDir);
		expect(resolved.logsDir).not.toBe(pinned);
		expect(path.dirname(resolved.logPath ?? "")).toBe(resolved.canonicalLogsDir);
	}, 60_000);
});
