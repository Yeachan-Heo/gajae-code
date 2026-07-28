import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * These base URLs become the request endpoints that carry the OpenAI / Azure
 * credential. `Bun.env === process.env`, and the env module merges the caller's
 * `cwd/.env` into it, so without a trust boundary a repository could plant
 * `.env` and have authenticated requests delivered to an endpoint of its
 * choosing.
 *
 * `projectEnv` is parsed at module load from `process.cwd()`, so these drive a
 * child process with a controlled cwd.
 */

const PROBE = path.join(import.meta.dir, "fixtures", "openai-baseurl-probe.ts");
const KEYS = ["OPENAI_BASE_URL", "AZURE_OPENAI_BASE_URL", "AZURE_OPENAI_RESOURCE_NAME"] as const;
const OPENAI_DEFAULT = "https://api.openai.com/v1";

interface Resolved {
	responses: string;
	completions: string;
	modelManager: string;
	azure: string | null;
}

const tempDirs: string[] = [];

function projectDir(dotenv?: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-openai-baseurl-trust-"));
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
	// Never let the outer environment leak an endpoint override into the child.
	for (const key of KEYS) delete env[key];
	Object.assign(env, overrides);

	const proc = Bun.spawn([process.execPath, PROBE], { cwd, env, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	const exitCode = await proc.exited;
	if (exitCode !== 0) throw new Error(`probe failed (${exitCode}): ${stderr}`);
	return JSON.parse(stdout.trim()) as Resolved;
}

describe("OpenAI/Azure endpoint trust boundary", () => {
	it("falls back to the hosted defaults when nothing sets a base URL", async () => {
		const resolved = await resolveIn(projectDir());
		expect(resolved.responses).toBe(OPENAI_DEFAULT);
		expect(resolved.completions).toBe(OPENAI_DEFAULT);
		expect(resolved.modelManager).toBe(OPENAI_DEFAULT);
		expect(resolved.azure).toBeNull();
	});

	it("ignores an OPENAI_BASE_URL planted by the project .env", async () => {
		const cwd = projectDir("OPENAI_BASE_URL=https://attacker.example/v1\n");
		const resolved = await resolveIn(cwd);
		expect(resolved.responses).toBe(OPENAI_DEFAULT);
		expect(resolved.completions).toBe(OPENAI_DEFAULT);
		expect(resolved.modelManager).toBe(OPENAI_DEFAULT);
	});

	it("ignores an AZURE_OPENAI_BASE_URL planted by the project .env", async () => {
		const cwd = projectDir("AZURE_OPENAI_BASE_URL=https://attacker.azure.example\n");
		expect((await resolveIn(cwd)).azure).toBeNull();
	});

	it("ignores an AZURE_OPENAI_RESOURCE_NAME planted by the project .env", async () => {
		// The resource name is the alternate constructor for the same host:
		// https://<resource>.openai.azure.com/openai/v1
		const cwd = projectDir("AZURE_OPENAI_RESOURCE_NAME=attacker-owned-resource\n");
		expect((await resolveIn(cwd)).azure).toBeNull();
	});

	it("still honors an inherited AZURE_OPENAI_RESOURCE_NAME", async () => {
		const resolved = await resolveIn(projectDir(), { AZURE_OPENAI_RESOURCE_NAME: "corp-resource" });
		expect(resolved.azure).toBe("https://corp-resource.openai.azure.com/openai/v1");
	});

	it("does not let the project .env override an inherited resource name", async () => {
		const cwd = projectDir("AZURE_OPENAI_RESOURCE_NAME=attacker-owned-resource\n");
		const resolved = await resolveIn(cwd, { AZURE_OPENAI_RESOURCE_NAME: "corp-resource" });
		expect(resolved.azure).toBe("https://corp-resource.openai.azure.com/openai/v1");
	});

	it("still honors an inherited OPENAI_BASE_URL", async () => {
		const resolved = await resolveIn(projectDir(), { OPENAI_BASE_URL: "https://gateway.internal/v1" });
		expect(resolved.responses).toBe("https://gateway.internal/v1");
		expect(resolved.completions).toBe("https://gateway.internal/v1");
		expect(resolved.modelManager).toBe("https://gateway.internal/v1");
	});

	it("still honors an inherited AZURE_OPENAI_BASE_URL", async () => {
		const resolved = await resolveIn(projectDir(), { AZURE_OPENAI_BASE_URL: "https://azure.internal" });
		expect(resolved.azure).toBe("https://azure.internal");
	});

	it("does not let the project .env override an inherited base URL", async () => {
		const cwd = projectDir("OPENAI_BASE_URL=https://attacker.example/v1\n");
		const resolved = await resolveIn(cwd, { OPENAI_BASE_URL: "https://gateway.internal/v1" });
		expect(resolved.responses).toBe("https://gateway.internal/v1");
		expect(resolved.modelManager).toBe("https://gateway.internal/v1");
	});
});
