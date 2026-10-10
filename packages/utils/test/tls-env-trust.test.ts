import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * `NODE_TLS_REJECT_UNAUTHORIZED=0` turns off certificate verification for every
 * connection in the process. A repository `.env` pairing it with `HTTPS_PROXY`
 * would let the proxy terminate TLS and read provider API keys, so a project
 * declaration must never reach the live environment. Bun autoloads cwd/.env for
 * `bun` launches, and the env module copies the project `.env` itself when
 * autoload is off (compiled binaries), so both paths are exercised.
 */

const PROBE = path.join(import.meta.dir, "fixtures", "tls-env-probe.ts");
const KEY = "NODE_TLS_REJECT_UNAUTHORIZED";

const tempDirs: string[] = [];

function tempDir(dotenv?: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-tls-env-trust-"));
	tempDirs.push(dir);
	if (dotenv !== undefined) fs.writeFileSync(path.join(dir, ".env"), dotenv);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function resolveIn(cwd: string, options: { autoload: boolean; inherited?: string }): Promise<string | null> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) env[key] = value;
	}
	delete env[KEY];
	// Keep user-owned env files (agent `.env`, `~/.env`, shell rc) out of the result.
	env.HOME = tempDir();
	env.GJC_CODING_AGENT_DIR = tempDir();
	if (options.inherited !== undefined) env[KEY] = options.inherited;

	const args = options.autoload ? [PROBE] : ["--no-env-file", PROBE];
	const proc = Bun.spawn([process.execPath, ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	const exitCode = await proc.exited;
	if (exitCode !== 0) throw new Error(`probe failed (${exitCode}): ${stderr}`);
	return (JSON.parse(stdout.trim()) as { value: string | null }).value;
}

describe.each([
	["Bun dotenv autoload", true],
	["no dotenv autoload", false],
] as const)("NODE_TLS_REJECT_UNAUTHORIZED trust boundary (%s)", (_label, autoload) => {
	it("drops a value declared by the project .env", async () => {
		expect(await resolveIn(tempDir(`${KEY}=0\n`), { autoload })).toBeNull();
	});

	it("drops a dynamic project declaration", async () => {
		expect(await resolveIn(tempDir(`ZERO=0\n${KEY}=$ZERO\n`), { autoload })).toBeNull();
	});

	it("keeps a value inherited from the launching shell", async () => {
		expect(await resolveIn(tempDir(), { autoload, inherited: "0" })).toBe("0");
	});

	it("does not let the project .env replace an inherited value", async () => {
		expect(await resolveIn(tempDir(`${KEY}=0\n`), { autoload, inherited: "1" })).toBe("1");
	});
});
