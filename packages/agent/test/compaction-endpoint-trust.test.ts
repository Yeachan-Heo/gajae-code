import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * The remote-compaction endpoint is built from `OPENAI_BASE_URL` and carries the
 * OpenAI credential. `Bun.env === process.env`, and the env module merges the
 * caller's `cwd/.env` into it, so without a trust boundary a repository could
 * plant `.env` and have compaction requests delivered to an endpoint of its
 * choosing.
 *
 * `projectEnv` is parsed at module load from `process.cwd()`, so these drive a
 * child process with a controlled cwd.
 */

const PROBE = path.join(import.meta.dir, "fixtures", "compaction-endpoint-probe.ts");
const tempDirs: string[] = [];

function projectDir(dotenv?: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-compaction-endpoint-trust-"));
	tempDirs.push(dir);
	if (dotenv !== undefined) fs.writeFileSync(path.join(dir, ".env"), dotenv);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function endpointIn(cwd: string, overrides: Record<string, string> = {}): Promise<string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) env[key] = value;
	}
	// Never let the outer environment leak an endpoint override into the child.
	delete env.OPENAI_BASE_URL;
	Object.assign(env, overrides);

	const proc = Bun.spawn([process.execPath, PROBE], { cwd, env, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	const exitCode = await proc.exited;
	if (exitCode !== 0) throw new Error(`probe failed (${exitCode}): ${stderr}`);
	return (JSON.parse(stdout.trim()) as { endpoint: string }).endpoint;
}

describe("remote compaction endpoint trust boundary", () => {
	it("uses the hosted default when nothing sets a base URL", async () => {
		expect(await endpointIn(projectDir())).toStartWith("https://api.openai.com/");
	});

	it("ignores an OPENAI_BASE_URL planted by the project .env", async () => {
		const cwd = projectDir("OPENAI_BASE_URL=https://attacker.example/v1\n");
		const endpoint = await endpointIn(cwd);
		expect(endpoint).not.toContain("attacker.example");
		expect(endpoint).toStartWith("https://api.openai.com/");
	});

	it("still honors an inherited OPENAI_BASE_URL", async () => {
		const endpoint = await endpointIn(projectDir(), { OPENAI_BASE_URL: "https://gateway.internal/v1" });
		expect(endpoint).toStartWith("https://gateway.internal/v1");
	});

	it("does not let the project .env override an inherited base URL", async () => {
		const cwd = projectDir("OPENAI_BASE_URL=https://attacker.example/v1\n");
		const endpoint = await endpointIn(cwd, { OPENAI_BASE_URL: "https://gateway.internal/v1" });
		expect(endpoint).toStartWith("https://gateway.internal/v1");
	});
});
