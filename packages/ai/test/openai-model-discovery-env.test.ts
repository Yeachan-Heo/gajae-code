import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { lmStudioModelManagerOptions } from "../src/provider-models/openai-compat";

const tempDirs: string[] = [];
const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, { force: true, recursive: true });
	}
	vi.restoreAllMocks();
});

function runDiscoveryIsolationScript(script: string, env: Record<string, string>, dotenv: string): void {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ai-openai-model-env-"));
	tempDirs.push(dir);
	fs.writeFileSync(path.join(dir, ".env"), dotenv);
	const scriptPath = path.join(dir, "openai-model-discovery-env.test.ts");
	fs.writeFileSync(scriptPath, script);

	const result = Bun.spawnSync({
		cmd: [process.execPath, scriptPath],
		cwd: dir,
		env: {
			HOME: os.homedir(),
			PATH: Bun.env.PATH ?? "",
			...env,
		},
		stderr: "pipe",
		stdout: "pipe",
	});

	if (result.exitCode !== 0) {
		const output = [new TextDecoder().decode(result.stdout), new TextDecoder().decode(result.stderr)]
			.filter(Boolean)
			.join("\n");
		throw new Error(output || `model discovery isolation script exited with ${result.exitCode}`);
	}
}

describe("OpenAI model discovery environment precedence", () => {
	it("uses inherited shell OPENAI_BASE_URL before fallback $env.OPENAI_BASE_URL", () => {
		const providerModelsUrl = pathToFileURL(
			path.resolve(import.meta.dir, "../src/provider-models/openai-compat.ts"),
		).href;
		runDiscoveryIsolationScript(
			`
import { openaiModelManagerOptions } from ${JSON.stringify(providerModelsUrl)};

function assertEqual(actual: string | undefined, expected: string, label: string): void {
	if (actual !== expected) {
		throw new Error(\`\${label}: expected \${expected}, got \${actual}\`);
	}
}

Bun.env.OPENAI_BASE_URL = "https://fallback-openai.example.com/v1";
const requests: Array<{ url: string; authorization: string | null }> = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
	requests.push({
		url: String(input instanceof Request ? input.url : input),
		authorization: new Headers(init?.headers).get("authorization"),
	});
	return new Response(JSON.stringify({ data: [{ id: "gpt-4o", name: "GPT 4o" }] }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}) as typeof fetch;

const options = openaiModelManagerOptions({ apiKey: "test-key" });
const models = await options.fetchDynamicModels?.();
if (!models?.some(model => model.id === "gpt-4o")) {
	throw new Error("expected discovered gpt-4o model");
}
assertEqual(requests[0]?.url, "https://inherited-openai.example.com/v1/models", "discovery URL");
assertEqual(requests[0]?.authorization, "Bearer test-key", "discovery authorization");
`,
			{ OPENAI_BASE_URL: "https://inherited-openai.example.com/v1" },
			"OPENAI_BASE_URL=https://dotenv-openai.example.com/v1\n",
		);
	});
});

describe("LM Studio model discovery metadata", () => {
	it("uses nested LM Studio metadata for GGUF context and output limits", async () => {
		globalThis.fetch = vi.fn(async () => {
			return new Response(
				JSON.stringify({
					data: [
						{
							id: "DeepSeek-V4-Flash-Q4_K_M.gguf",
							name: "DeepSeek V4 Flash",
							meta: {
								n_ctx: "131072",
								n_ctx_train: 262144,
							},
							details: {
								max_tokens: "8192",
							},
						},
					],
				}),
				{ headers: { "content-type": "application/json" } },
			);
		}) as unknown as typeof fetch;

		const options = lmStudioModelManagerOptions({ baseUrl: "http://127.0.0.1:1234/v1" });
		const models = await options.fetchDynamicModels?.();

		const model = models?.find(candidate => candidate.id === "DeepSeek-V4-Flash-Q4_K_M.gguf");
		expect(model?.contextWindow).toBe(131072);
		expect(model?.maxTokens).toBe(8192);
	});
});
