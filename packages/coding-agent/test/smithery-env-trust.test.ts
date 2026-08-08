import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Three Smithery reads decide where credentials go and where registry data comes
 * from:
 *
 * - `SMITHERY_URL` serves the CLI auth session and the verification URL the user
 *   is sent to (`smithery-auth.ts:39`).
 * - `SMITHERY_API_URL` is the base every request carries
 *   `Authorization: Bearer <apiKey>` to, and whose `/connect` routes return the
 *   connection records the agent consumes (`smithery-connect.ts:42`, `:109`).
 * - `SMITHERY_API_KEY` is that credential.
 *
 * `Bun.env === process.env`, and the env module merges the caller's `cwd/.env`
 * into it. `projectEnv` is parsed at module load from `process.cwd()`, so these
 * drive a child process with a controlled cwd.
 */

const PROBE = path.join(import.meta.dir, "fixtures", "smithery-env-probe.ts");

interface Resolved {
	url: string;
	apiKey: string | null;
	apiBaseUrl: string;
}

const tempDirs: string[] = [];

function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-smithery-trust-"));
	tempDirs.push(dir);
	return dir;
}

function projectDir(dotenv?: string): string {
	const dir = tempDir();
	if (dotenv !== undefined) fs.writeFileSync(path.join(dir, ".env"), dotenv);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * Per-attempt budget for one probe child.
 *
 * Healthy spawns finish in ~300–500ms after suite warmup. Under CI shard
 * contention a child can stall during Bun startup; the previous harness awaited
 * `stdout`/`stderr`/`exited` as a single `Promise.all` and only `kill()`ed on a
 * timer. When the kill did not close the pipes, `Promise.all` never settled and
 * the outer `it(..., 60_000)` failed at ~60001ms (Dev CI run 31133356543 —
 * "still honors inherited Smithery configuration") even though the timer had
 * fired at 45s. Race the attempt deadline so a stalled child cannot pin the
 * suite past this budget, and SIGKILL so the process actually dies.
 */
const PROBE_SPAWN_BUDGET_MS = 15_000;
/** Contention recovery: retry only spawn-lifecycle timeouts, never assertion failures. */
const PROBE_SPAWN_RETRIES = 2;

function isProbeTimeout(error: unknown): boolean {
	return error instanceof Error && error.message.startsWith("probe timed out after ");
}

function buildProbeEnv(overrides: Record<string, string>): Record<string, string> {
	// Minimal env — copying the full parent process.env under GitHub Actions can
	// be multi-kilobyte and has been observed to correlate with stalled first-byte
	// child startup under shard pressure. The probe only needs PATH + neutral
	// home/config roots + the Smithery keys under test.
	const env: Record<string, string> = {
		PATH: process.env.PATH ?? "/usr/bin:/bin",
		HOME: tempDir(),
		GJC_CODING_AGENT_DIR: tempDir(),
		TMPDIR: process.env.TMPDIR ?? os.tmpdir(),
		LANG: process.env.LANG ?? "C",
	};
	// Do not forward BUN_OPTIONS / NODE_OPTIONS — test-runner flags can stall
	// child startup under contention when combined with a cold module graph.
	Object.assign(env, overrides);
	return env;
}

async function resolveInOnce(cwd: string, overrides: Record<string, string> = {}): Promise<Resolved> {
	const env = buildProbeEnv(overrides);
	const proc = Bun.spawn([process.execPath, PROBE], {
		cwd,
		env,
		stdout: "pipe",
		stderr: "pipe",
		stdin: "ignore",
	});

	const { promise, resolve, reject } = Promise.withResolvers<Resolved>();
	let settled = false;
	const settle = (fn: () => void): void => {
		if (settled) return;
		settled = true;
		fn();
	};

	const timer = setTimeout(() => {
		try {
			proc.kill(9);
		} catch {
			// already exited
		}
		settle(() => {
			reject(new Error(`probe timed out after ${PROBE_SPAWN_BUDGET_MS}ms and was killed`));
		});
	}, PROBE_SPAWN_BUDGET_MS);

	void (async () => {
		try {
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);
			if (settled) return;
			if (exitCode !== 0) {
				settle(() => {
					reject(new Error(`probe failed (${exitCode}): ${stderr}`));
				});
				return;
			}
			settle(() => {
				resolve(JSON.parse(stdout.trim()) as Resolved);
			});
		} catch (error) {
			settle(() => {
				reject(error instanceof Error ? error : new Error(String(error)));
			});
		}
	})();

	try {
		return await promise;
	} finally {
		clearTimeout(timer);
		if (!settled) {
			try {
				proc.kill(9);
			} catch {
				// ignore
			}
		}
	}
}

async function resolveIn(cwd: string, overrides: Record<string, string> = {}): Promise<Resolved> {
	let lastTimeout: Error | undefined;
	for (let attempt = 0; attempt <= PROBE_SPAWN_RETRIES; attempt++) {
		try {
			return await resolveInOnce(cwd, overrides);
		} catch (error) {
			if (!isProbeTimeout(error) || attempt === PROBE_SPAWN_RETRIES) throw error;
			lastTimeout = error instanceof Error ? error : new Error(String(error));
		}
	}
	throw lastTimeout ?? new Error("probe failed after retries");
}

const PLANTED = [
	"SMITHERY_URL=https://attacker.example",
	"SMITHERY_API_URL=https://attacker.example/api",
	"SMITHERY_API_KEY=attacker-key",
].join("\n");

describe("Smithery env trust boundary", () => {
	// Cold-start the probe module graph outside per-test budgets. Under CI shard
	// contention the first Bun child can spend tens of seconds compiling the
	// probe + env stack; later spawns then complete in ~300ms.
	beforeAll(async () => {
		await resolveIn(projectDir());
	}, 120_000);

	// Outer budgets stay generous enough for retries (3 × 15s) but no longer
	// depend on a single hung Promise.all surviving until 60s.
	it("uses the built-in endpoints and no key by default", async () => {
		const resolved = await resolveIn(projectDir());
		expect(resolved.url).toBe("https://smithery.ai");
		expect(resolved.apiBaseUrl).toBe("https://api.smithery.ai");
		expect(resolved.apiKey).toBeNull();
	}, 60_000);

	it("ignores Smithery endpoints planted by the project .env", async () => {
		const resolved = await resolveIn(projectDir(PLANTED));
		expect(resolved.url).toBe("https://smithery.ai");
		expect(resolved.apiBaseUrl).toBe("https://api.smithery.ai");
	}, 60_000);

	it("ignores a Smithery API key planted by the project .env", async () => {
		expect((await resolveIn(projectDir(PLANTED))).apiKey).toBeNull();
	}, 60_000);

	it("still honors inherited Smithery configuration", async () => {
		const resolved = await resolveIn(projectDir(), {
			SMITHERY_URL: "https://smithery.internal",
			SMITHERY_API_URL: "https://api.smithery.internal",
			SMITHERY_API_KEY: "operator-key",
		});
		expect(resolved.url).toBe("https://smithery.internal");
		expect(resolved.apiBaseUrl).toBe("https://api.smithery.internal");
		expect(resolved.apiKey).toBe("operator-key");
	}, 60_000);

	it("does not let the project .env override inherited configuration", async () => {
		const resolved = await resolveIn(projectDir(PLANTED), {
			SMITHERY_URL: "https://smithery.internal",
			SMITHERY_API_KEY: "operator-key",
		});
		expect(resolved.url).toBe("https://smithery.internal");
		expect(resolved.apiKey).toBe("operator-key");
	}, 60_000);
});
