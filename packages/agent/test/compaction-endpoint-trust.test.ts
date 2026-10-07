import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

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
	const home = path.join(cwd, ".home");
	fs.mkdirSync(home, { recursive: true });
	env.HOME = home;
	delete env.GJC_CONFIG_DIR;
	delete env.PI_CONFIG_DIR;
	Object.assign(env, overrides);

	const proc = Bun.spawn([process.execPath, PROBE], { cwd, env, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	const exitCode = await proc.exited;
	if (exitCode !== 0) throw new Error(`probe failed (${exitCode}): ${stderr}`);
	return (JSON.parse(stdout.trim()) as { endpoint: string }).endpoint;
}

async function openAiRoutingIn(
	cwd: string,
	modelBaseUrl: string,
	openAiBaseUrl: string,
): Promise<{ responsesBaseUrl: string; completionsBaseUrl: string; compactionEndpoint: string }> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) env[key] = value;
	}
	delete env.OPENAI_BASE_URL;
	const home = path.join(cwd, ".home");
	fs.mkdirSync(home, { recursive: true });
	env.HOME = home;
	delete env.GJC_CONFIG_DIR;
	delete env.PI_CONFIG_DIR;
	env.OPENAI_BASE_URL = openAiBaseUrl;
	env.MODEL_BASE_URL = modelBaseUrl;
	const workspaceRoot = path.resolve(import.meta.dir, "../../..");
	const utilsModule = pathToFileURL(path.join(workspaceRoot, "packages/utils/src/index.ts")).href;
	const responsesModule = pathToFileURL(
		path.join(workspaceRoot, "packages/ai/src/providers/openai-responses.ts"),
	).href;
	const completionsModule = pathToFileURL(
		path.join(workspaceRoot, "packages/ai/src/providers/openai-completions.ts"),
	).href;
	const compactionModule = pathToFileURL(path.join(workspaceRoot, "packages/agent/src/compaction/openai.ts")).href;
	const script = `
const { captureEndpointConfiguration } = await import(${JSON.stringify(utilsModule)});
const { resolveOpenAIProviderBaseUrlForTest } = await import(${JSON.stringify(responsesModule)});
const { resolveOpenAICompletionsBaseUrlForTest } = await import(${JSON.stringify(completionsModule)});
const { resolveOpenAiCompactEndpointForTest } = await import(${JSON.stringify(compactionModule)});
const endpointConfiguration = captureEndpointConfiguration();
const baseUrl = Bun.env.MODEL_BASE_URL;
const model = { id: "gpt-5.4", provider: "openai", baseUrl };
console.log(JSON.stringify({
  responsesBaseUrl: resolveOpenAIProviderBaseUrlForTest(baseUrl, "api_key", endpointConfiguration),
  completionsBaseUrl: resolveOpenAICompletionsBaseUrlForTest(baseUrl, "api_key", endpointConfiguration),
  compactionEndpoint: resolveOpenAiCompactEndpointForTest(model, "api_key", endpointConfiguration),
}));
`;
	const proc = Bun.spawn([process.execPath, "-e", script], { cwd, env, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	const exitCode = await proc.exited;
	if (exitCode !== 0) throw new Error(`routing probe failed (${exitCode}): ${stderr}`);
	return JSON.parse(stdout.trim()) as {
		responsesBaseUrl: string;
		completionsBaseUrl: string;
		compactionEndpoint: string;
	};
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

	it("routes default OpenAI URLs with custom ports to the captured endpoint across providers and compaction", async () => {
		const result = await openAiRoutingIn(projectDir(), "https://api.openai.com:8443/v1", "https://proxy.example/v1");
		expect(result.responsesBaseUrl).toBe("https://proxy.example/v1");
		expect(result.completionsBaseUrl).toBe("https://proxy.example/v1");
		expect(result.compactionEndpoint).toBe("https://proxy.example/v1/responses/compact");
	});

	it("routes mixed-case canonical OpenAI URLs to the captured endpoint across providers and compaction", async () => {
		const result = await openAiRoutingIn(projectDir(), "https://API.OPENAI.COM/v1", "https://proxy.example/v1");
		expect(result.responsesBaseUrl).toBe("https://proxy.example/v1");
		expect(result.completionsBaseUrl).toBe("https://proxy.example/v1");
		expect(result.compactionEndpoint).toBe("https://proxy.example/v1/responses/compact");
	});

	it("keeps an explicit slash-suffixed model route across providers and compaction", async () => {
		const result = await openAiRoutingIn(projectDir(), "https://api.openai.com/v1/", "https://proxy.example/v1");
		expect(result.responsesBaseUrl).toBe("https://api.openai.com/v1/");
		expect(result.completionsBaseUrl).toBe("https://api.openai.com/v1/");
		expect(result.compactionEndpoint).toBe("https://api.openai.com/v1/responses/compact");
	});
});
