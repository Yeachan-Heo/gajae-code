import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { captureEndpointConfiguration, type EndpointConfiguration, hookFetch } from "@gajae-code/utils";
import { streamAnthropic } from "../src/providers/anthropic";
import type { Context, Model } from "../src/types";

/**
 * `resolveAnthropicBaseUrlFromEnv()` feeds `buildAnthropicAuthConfig()`, whose
 * result `buildAnthropicUrl()` turns into `${baseUrl}/v1/messages` while the
 * headers carry the Anthropic API key / OAuth token. `isFoundryEnabled()` picks
 * the Foundry branch of that resolution and gates the mTLS material.
 *
 * `Bun.env === process.env`, and the env module merges the caller's `cwd/.env`
 * into it, so without a trust boundary a repository could plant `.env` and have
 * authenticated requests delivered to an endpoint of its choosing.
 *
 * `projectEnv` is parsed at module load from `process.cwd()`, so these drive a
 * child process with a controlled cwd.
 */

const PROBE = path.join(import.meta.dir, "fixtures", "anthropic-baseurl-probe.ts");
const KEYS = ["ANTHROPIC_BASE_URL", "FOUNDRY_BASE_URL", "CLAUDE_CODE_USE_FOUNDRY"] as const;

interface Resolved {
	foundryEnabled: boolean;
	baseUrl: string | null;
}

const tempDirs: string[] = [];

function projectDir(dotenv?: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-anthropic-baseurl-trust-"));
	tempDirs.push(dir);
	if (dotenv !== undefined) fs.writeFileSync(path.join(dir, ".env"), dotenv);
	return dir;
}

function createAnthropicSseResponse(): Response {
	const frames = [
		{
			type: "message_start",
			message: {
				id: "msg_endpoint_scope",
				type: "message",
				role: "assistant",
				model: "claude-3-5-haiku-latest",
				content: [],
				stop_reason: null,
				stop_sequence: null,
				usage: { input_tokens: 1, output_tokens: 0 },
			},
		},
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
		{ type: "message_stop" },
	];
	const sse = frames.map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join("");
	return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
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

describe("Anthropic endpoint trust boundary", () => {
	it("resolves no env base URL and no Foundry mode by default", async () => {
		expect(await resolveIn(projectDir())).toEqual({ foundryEnabled: false, baseUrl: null });
	});

	it("ignores an ANTHROPIC_BASE_URL planted by the project .env", async () => {
		const cwd = projectDir("ANTHROPIC_BASE_URL=https://attacker.example\n");
		expect((await resolveIn(cwd)).baseUrl).toBeNull();
	});

	it("ignores a Foundry opt-in planted by the project .env", async () => {
		const cwd = projectDir("CLAUDE_CODE_USE_FOUNDRY=1\nFOUNDRY_BASE_URL=https://attacker.example\n");
		const resolved = await resolveIn(cwd);
		expect(resolved.foundryEnabled).toBe(false);
		expect(resolved.baseUrl).toBeNull();
	});

	it("ignores a planted FOUNDRY_BASE_URL even when Foundry is legitimately enabled", async () => {
		const cwd = projectDir("FOUNDRY_BASE_URL=https://attacker.example\n");
		const resolved = await resolveIn(cwd, { CLAUDE_CODE_USE_FOUNDRY: "1" });
		expect(resolved.foundryEnabled).toBe(true);
		expect(resolved.baseUrl).toBeNull();
	});

	it("still honors an inherited ANTHROPIC_BASE_URL", async () => {
		const resolved = await resolveIn(projectDir(), { ANTHROPIC_BASE_URL: "https://gateway.internal/" });
		expect(resolved.baseUrl).toBe("https://gateway.internal");
	});

	it("still honors an inherited Foundry configuration", async () => {
		const resolved = await resolveIn(projectDir(), {
			CLAUDE_CODE_USE_FOUNDRY: "true",
			FOUNDRY_BASE_URL: "https://foundry.internal",
		});
		expect(resolved.foundryEnabled).toBe(true);
		expect(resolved.baseUrl).toBe("https://foundry.internal");
	});

	it("does not let the project .env override an inherited base URL", async () => {
		const cwd = projectDir("ANTHROPIC_BASE_URL=https://attacker.example\n");
		expect((await resolveIn(cwd, { ANTHROPIC_BASE_URL: "https://gateway.internal" })).baseUrl).toBe(
			"https://gateway.internal",
		);
	});

	it("pins Foundry and ZCode URLs on actual Anthropic SDK requests", async () => {
		const envKeys = ["FOUNDRY_BASE_URL", "CLAUDE_CODE_USE_FOUNDRY", "ZCODE_PLAN_ANTHROPIC_BASE_URL"] as const;
		const previousEnv = new Map(envKeys.map(key => [key, Bun.env[key]]));
		const anthropicModel: Model<"anthropic-messages"> = {
			id: "claude-3-5-haiku-latest",
			name: "Claude 3.5 Haiku",
			api: "anthropic-messages",
			provider: "anthropic",
			baseUrl: "https://explicit-model-anthropic.example",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200000,
			maxTokens: 8192,
		};
		const zcodeModel: Model<"anthropic-messages"> = {
			...anthropicModel,
			provider: "glm-zcode",
			baseUrl: "https://bundled-zcode-model.example",
		};
		const context: Context = { messages: [{ role: "user", content: "route this request", timestamp: Date.now() }] };
		const requests: Array<{ url: string; apiKey: string | null; model: unknown }> = [];
		const send = async (
			model: Model<"anthropic-messages">,
			endpointConfiguration: EndpointConfiguration,
			apiKey: string,
		) => {
			const result = await streamAnthropic(model, context, {
				endpointConfiguration,
				apiKey,
				isOAuth: false,
				requestMaxRetries: 0,
				streamMaxRetries: 0,
				streamFirstEventTimeoutMs: 2_000,
				streamIdleTimeoutMs: 2_000,
			}).result();
			expect(result.stopReason).toBe("stop");
		};

		try {
			for (const key of envKeys) delete Bun.env[key];
			Bun.env.CLAUDE_CODE_USE_FOUNDRY = "1";
			Bun.env.FOUNDRY_BASE_URL = "https://foundry-scope-a.example";
			const scopeA = captureEndpointConfiguration();
			Bun.env.FOUNDRY_BASE_URL = "https://foundry-scope-b.example";
			const scopeB = captureEndpointConfiguration();
			Bun.env.CLAUDE_CODE_USE_FOUNDRY = "0";
			Bun.env.FOUNDRY_BASE_URL = "https://foundry-scope-c.example";
			const capturedFoundryDisabled = captureEndpointConfiguration();

			using _hook = hookFetch(async (input, init) => {
				const request = input instanceof Request ? input : new Request(String(input), init);
				const body = (await request.clone().json()) as { model?: unknown };
				requests.push({ url: request.url, apiKey: request.headers.get("x-api-key"), model: body.model });
				return createAnthropicSseResponse();
			});

			Bun.env.CLAUDE_CODE_USE_FOUNDRY = "0";
			Bun.env.FOUNDRY_BASE_URL = "https://live-foundry-later.example";
			await send(anthropicModel, scopeA, "shared-current-key-a");
			await send(anthropicModel, scopeA, "shared-current-key-b");
			await send(anthropicModel, scopeB, "shared-current-key-c");

			Bun.env.CLAUDE_CODE_USE_FOUNDRY = "1";
			Bun.env.FOUNDRY_BASE_URL = "https://live-foundry-after-disabled-capture.example";
			await send(anthropicModel, capturedFoundryDisabled, "shared-current-key-d");

			delete Bun.env.CLAUDE_CODE_USE_FOUNDRY;
			delete Bun.env.FOUNDRY_BASE_URL;
			const capturedAbsence = captureEndpointConfiguration();
			Bun.env.CLAUDE_CODE_USE_FOUNDRY = "1";
			Bun.env.FOUNDRY_BASE_URL = "https://live-foundry-after-absence.example";
			await send(anthropicModel, capturedAbsence, "shared-current-key-e");

			Bun.env.ZCODE_PLAN_ANTHROPIC_BASE_URL = "https://zcode-scope-a.example/api/anthropic";
			const zcodeScopeA = captureEndpointConfiguration();
			Bun.env.ZCODE_PLAN_ANTHROPIC_BASE_URL = "https://zcode-scope-b.example/api/anthropic";
			await send(zcodeModel, zcodeScopeA, "shared-current-key-f");
			delete Bun.env.ZCODE_PLAN_ANTHROPIC_BASE_URL;
			const zcodeAbsence = captureEndpointConfiguration();
			Bun.env.ZCODE_PLAN_ANTHROPIC_BASE_URL = "https://zcode-live-after-absence.example/api/anthropic";
			await send(zcodeModel, zcodeAbsence, "shared-current-key-g");

			const beforeForgedHandle = requests.length;
			expect(() =>
				streamAnthropic(anthropicModel, context, {
					endpointConfiguration: Object.freeze({}) as EndpointConfiguration,
					client: {} as never,
				}),
			).toThrow("Invalid endpoint configuration handle");
			expect(requests).toHaveLength(beforeForgedHandle);

			expect(requests.map(request => request.url)).toEqual([
				"https://foundry-scope-a.example/v1/messages",
				"https://foundry-scope-a.example/v1/messages",
				"https://foundry-scope-b.example/v1/messages",
				"https://explicit-model-anthropic.example/v1/messages",
				"https://explicit-model-anthropic.example/v1/messages",
				"https://zcode-scope-a.example/api/anthropic/v1/messages",
				"https://api.z.ai/api/anthropic/v1/messages",
			]);
			expect(requests.map(request => request.apiKey)).toEqual([
				"shared-current-key-a",
				"shared-current-key-b",
				"shared-current-key-c",
				"shared-current-key-d",
				"shared-current-key-e",
				"shared-current-key-f",
				"shared-current-key-g",
			]);
			expect(requests.map(request => request.model)).toEqual(Array(7).fill("claude-3-5-haiku-latest"));
		} finally {
			for (const key of envKeys) {
				const previous = previousEnv.get(key);
				if (previous === undefined) delete Bun.env[key];
				else Bun.env[key] = previous;
			}
		}
	});
});
