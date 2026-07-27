import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Two operator overrides are spawned directly:
 *
 * - `GJC_SDK_SESSION_COMMAND` becomes the broker's session-host `spawn(file, args)`
 * - `GJC_HARNESS_PROCESS_START_COMMAND` becomes the harness `Bun.spawnSync([...command, pid])`
 *
 * `Bun.env === process.env`, and the env module merges the caller's `cwd/.env`
 * into it, so without a trust boundary a repository could plant `.env` and pick
 * what those code paths execute.
 *
 * `projectEnv` is parsed at module load from `process.cwd()`, so these drive a
 * child process with a controlled cwd.
 */

const PROBE = path.join(import.meta.dir, "fixtures", "spawn-command-env-probe.ts");
const COMMAND_KEYS = ["GJC_SDK_SESSION_COMMAND", "GJC_HARNESS_PROCESS_START_COMMAND"] as const;

interface Resolved {
	sdkSessionCommand: { file: string; args: string[] } | null;
	processStartCommand: { kind: "none" } | { kind: "invalid" } | { kind: "command"; command: string[] };
}

const tempDirs: string[] = [];

function projectDir(dotenv?: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-spawn-command-trust-"));
	tempDirs.push(dir);
	if (dotenv !== undefined) fs.writeFileSync(path.join(dir, ".env"), dotenv);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function resolveIn(cwd: string, overrides: Record<string, string> = {}): Promise<Resolved> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) env[key] = value;
	}
	// Never let the outer environment leak an override into the child.
	for (const key of COMMAND_KEYS) delete env[key];
	Object.assign(env, overrides);

	const proc = Bun.spawn([process.execPath, PROBE], { cwd, env, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	const exitCode = await proc.exited;
	if (exitCode !== 0) throw new Error(`probe failed (${exitCode}): ${stderr}`);
	return JSON.parse(stdout.trim()) as Resolved;
}

describe("spawn command env trust boundary", () => {
	it("resolves no overrides when nothing sets them", async () => {
		const resolved = await resolveIn(projectDir());
		expect(resolved.sdkSessionCommand).toBeNull();
		expect(resolved.processStartCommand).toEqual({ kind: "none" });
	});

	it("ignores an SDK session command planted by the project .env", async () => {
		const cwd = projectDir("GJC_SDK_SESSION_COMMAND=/tmp/attacker-host --take-over\n");
		expect((await resolveIn(cwd)).sdkSessionCommand).toBeNull();
	});

	it("ignores a harness process-start command planted by the project .env", async () => {
		const cwd = projectDir('GJC_HARNESS_PROCESS_START_COMMAND=["/tmp/attacker-probe"]\n');
		expect((await resolveIn(cwd)).processStartCommand).toEqual({ kind: "none" });
	});

	it("still honors overrides inherited from the launching shell", async () => {
		const resolved = await resolveIn(projectDir(), {
			GJC_SDK_SESSION_COMMAND: "/opt/gjc/session-host --flag",
			GJC_HARNESS_PROCESS_START_COMMAND: '["ps","-o","lstart=","-p"]',
		});
		expect(resolved.sdkSessionCommand).toEqual({ file: "/opt/gjc/session-host", args: ["--flag"] });
		expect(resolved.processStartCommand).toEqual({ kind: "command", command: ["ps", "-o", "lstart=", "-p"] });
	});

	it("keeps a malformed inherited harness override fatal rather than falling back", async () => {
		const resolved = await resolveIn(projectDir(), { GJC_HARNESS_PROCESS_START_COMMAND: "not json" });
		expect(resolved.processStartCommand).toEqual({ kind: "invalid" });
	});

	it("does not let the project .env override inherited values", async () => {
		const cwd = projectDir("GJC_SDK_SESSION_COMMAND=/tmp/attacker-host\n");
		expect((await resolveIn(cwd, { GJC_SDK_SESSION_COMMAND: "/opt/gjc/session-host" })).sdkSessionCommand).toEqual({
			file: "/opt/gjc/session-host",
			args: [],
		});
	});
});
