import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { $inheritedEnv } from "@gajae-code/utils";
import { getBundledModel } from "../src/models";
import { streamOpenAICompletions } from "../src/providers/openai-completions";
import { streamOpenAIResponses } from "../src/providers/openai-responses";
import type { Context, Model } from "../src/types";
import { createSseResponse } from "./openai-tool-choice-test-helpers";

const originalFetch = global.fetch;
const tempDirs: string[] = [];

afterEach(() => {
	global.fetch = originalFetch;
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, { force: true, recursive: true });
	}
});

function setEnvForTest(key: string, value: string): () => void {
	const inherited = $inheritedEnv(key);
	if (inherited !== undefined) {
		return () => {};
	}
	const previous = Bun.env[key];
	Bun.env[key] = value;
	return () => {
		if (previous === undefined) {
			delete Bun.env[key];
		} else {
			Bun.env[key] = previous;
		}
	};
}

function runProviderIsolationScript(script: string, env: Record<string, string>, dotenv: string): void {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ai-openai-env-"));
	tempDirs.push(dir);
	fs.writeFileSync(path.join(dir, ".env"), dotenv);
	const scriptPath = path.join(dir, "provider-env-isolation.test.ts");
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
		throw new Error(output || `provider isolation script exited with ${result.exitCode}`);
	}
}

function providerImportUrls(): {
	models: string;
	openAICompletions: string;
	openAIResponses: string;
	types: string;
} {
	return {
		models: pathToFileURL(path.resolve(import.meta.dir, "../src/models.ts")).href,
		openAICompletions: pathToFileURL(path.resolve(import.meta.dir, "../src/providers/openai-completions.ts")).href,
		openAIResponses: pathToFileURL(path.resolve(import.meta.dir, "../src/providers/openai-responses.ts")).href,
		types: pathToFileURL(path.resolve(import.meta.dir, "../src/types.ts")).href,
	};
}

function openAIProviderIsolationPrelude(): string {
	const urls = providerImportUrls();
	return `
import { getBundledModel } from ${JSON.stringify(urls.models)};
import { streamOpenAICompletions } from ${JSON.stringify(urls.openAICompletions)};
import { streamOpenAIResponses } from ${JSON.stringify(urls.openAIResponses)};
import type { Context, Model } from ${JSON.stringify(urls.types)};

const responsesModel = getBundledModel("openai", "gpt-5-mini") as Model<"openai-responses">;
const completionsModel = {
	...(getBundledModel("openai", "gpt-4o-mini") as Model<"openai-completions">),
	api: "openai-completions",
} satisfies Model<"openai-completions">;

function assertEqual(actual: string | undefined | null, expected: string | undefined | null, label: string): void {
	if (actual !== expected) {
		throw new Error(\`\${label}: expected \${expected}, got \${actual}\`);
	}
}

function baseContext(): Context {
	return {
		messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
	};
}

function sse(events: unknown[]): Response {
	const payload = \`\${events.map(event => \`data: \${typeof event === "string" ? event : JSON.stringify(event)}\`).join("\\n\\n")}\\n\\n\`;
	return new Response(payload, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}
`;
}

const openAIResponsesModel = getBundledModel("openai", "gpt-5-mini") as Model<"openai-responses">;
const openAICompletionsModel = {
	...(getBundledModel("openai", "gpt-4o-mini") as Model<"openai-completions">),
	api: "openai-completions",
} satisfies Model<"openai-completions">;

function baseContext(): Context {
	return {
		messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
	};
}
function rejectingGlobalFetch(): typeof fetch {
	const reject = async (): Promise<never> => {
		throw new Error("global fetch must not be used when an override is provided");
	};
	return Object.assign(reject, { preconnect: originalFetch.preconnect });
}

describe("StreamOptions.fetch override", () => {
	it("routes openai-completions requests through the override", async () => {
		const calls: Array<{ url: string }> = [];
		global.fetch = rejectingGlobalFetch();

		const customFetch = async (input: string | URL | Request, _init?: RequestInit) => {
			calls.push({ url: String(input instanceof Request ? input.url : input) });
			return createSseResponse([
				{
					id: "chatcmpl-test",
					object: "chat.completion.chunk",
					created: 0,
					model: openAICompletionsModel.id,
					choices: [{ index: 0, delta: { content: "hi" } }],
				},
				{
					id: "chatcmpl-test",
					object: "chat.completion.chunk",
					created: 0,
					model: openAICompletionsModel.id,
					choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
					usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
				},
				"[DONE]",
			]);
		};

		const result = await streamOpenAICompletions(openAICompletionsModel, baseContext(), {
			apiKey: "test-key",
			fetch: customFetch,
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(calls.length).toBeGreaterThanOrEqual(1);
		expect(calls[0]?.url).toContain("/chat/completions");
	});

	it("routes openai-responses requests through the override", async () => {
		const calls: Array<{ url: string }> = [];
		global.fetch = rejectingGlobalFetch();

		const customFetch = async (input: string | URL | Request, _init?: RequestInit) => {
			calls.push({ url: String(input instanceof Request ? input.url : input) });
			return createSseResponse([
				{ type: "response.created", response: { id: "resp_test" } },
				{
					type: "response.output_item.added",
					item: { type: "message", id: "msg_test", role: "assistant", status: "in_progress", content: [] },
				},
				{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
				{ type: "response.output_text.delta", delta: "hi" },
				{
					type: "response.output_item.done",
					item: {
						type: "message",
						id: "msg_test",
						role: "assistant",
						status: "completed",
						content: [{ type: "output_text", text: "hi" }],
					},
				},
				{
					type: "response.completed",
					response: {
						id: "resp_test",
						status: "completed",
						usage: {
							input_tokens: 1,
							output_tokens: 1,
							total_tokens: 2,
							input_tokens_details: { cached_tokens: 0 },
						},
					},
				},
			]);
		};

		const result = await streamOpenAIResponses(openAIResponsesModel, baseContext(), {
			apiKey: "test-key",
			fetch: customFetch,
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(calls.length).toBeGreaterThanOrEqual(1);
		expect(calls[0]?.url).toContain("/responses");
	});

	it("uses OPENAI_BASE_URL for openai-responses even when bundled metadata has the default OpenAI URL", async () => {
		const restore = setEnvForTest("OPENAI_BASE_URL", "https://openai-proxy.example.com/v1");
		const calls: Array<{ url: string }> = [];
		try {
			const customFetch = async (input: string | URL | Request, _init?: RequestInit) => {
				calls.push({ url: String(input instanceof Request ? input.url : input) });
				return createSseResponse([
					{ type: "response.created", response: { id: "resp_test" } },
					{
						type: "response.completed",
						response: {
							id: "resp_test",
							status: "completed",
							usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
						},
					},
				]);
			};

			const staleBundledDefault = { ...openAIResponsesModel, baseUrl: "https://api.openai.com/v1" };
			await streamOpenAIResponses(staleBundledDefault, baseContext(), {
				apiKey: "test-key",
				fetch: customFetch,
			}).result();

			expect(calls[0]?.url).toBe(
				`${$inheritedEnv("OPENAI_BASE_URL") ?? "https://openai-proxy.example.com/v1"}/responses`,
			);
		} finally {
			restore();
		}
	});

	it("uses OPENAI_BASE_URL for openai-completions even when bundled metadata has the default OpenAI URL", async () => {
		const restore = setEnvForTest("OPENAI_BASE_URL", "https://openai-proxy.example.com/v1");
		const calls: Array<{ url: string }> = [];
		try {
			const customFetch = async (input: string | URL | Request, _init?: RequestInit) => {
				calls.push({ url: String(input instanceof Request ? input.url : input) });
				return createSseResponse([
					{
						id: "chatcmpl-test",
						object: "chat.completion.chunk",
						created: 0,
						model: openAICompletionsModel.id,
						choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
						usage: { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1 },
					},
					"[DONE]",
				]);
			};

			const staleBundledDefault = { ...openAICompletionsModel, baseUrl: "https://api.openai.com/v1" };
			await streamOpenAICompletions(staleBundledDefault, baseContext(), {
				apiKey: "test-key",
				fetch: customFetch,
			}).result();

			expect(calls[0]?.url).toBe(
				`${$inheritedEnv("OPENAI_BASE_URL") ?? "https://openai-proxy.example.com/v1"}/chat/completions`,
			);
		} finally {
			restore();
		}
	});

	it("keeps OAuth OpenAI requests on the default API base URL even when OPENAI_BASE_URL is set", async () => {
		const restore = setEnvForTest("OPENAI_BASE_URL", "https://openai-proxy.example.com/v1");
		const calls: Array<{ url: string }> = [];
		try {
			const customFetch = async (input: string | URL | Request, _init?: RequestInit) => {
				calls.push({ url: String(input instanceof Request ? input.url : input) });
				return createSseResponse([
					{ type: "response.created", response: { id: "resp_test" } },
					{
						type: "response.completed",
						response: {
							id: "resp_test",
							status: "completed",
							usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
						},
					},
				]);
			};

			await streamOpenAIResponses(openAIResponsesModel, baseContext(), {
				apiKey: "oauth-token",
				authCredentialType: "oauth",
				fetch: customFetch,
			}).result();

			expect(calls[0]?.url).toBe("https://api.openai.com/v1/responses");
		} finally {
			restore();
		}
	});

	it("uses inherited shell OPENAI_BASE_URL ahead of fallback $env for default OpenAI Responses and Completions", () => {
		runProviderIsolationScript(
			`${openAIProviderIsolationPrelude()}
Bun.env.OPENAI_BASE_URL = "https://fallback-openai.example.com/v1";

const calls: Array<{ url: string }> = [];
const customFetch = async (input: string | URL | Request, _init?: RequestInit): Promise<Response> => {
	calls.push({ url: String(input instanceof Request ? input.url : input) });
	if (calls.length === 1) {
		return sse([
			{ type: "response.created", response: { id: "resp_test" } },
			{
				type: "response.completed",
				response: {
					id: "resp_test",
					status: "completed",
					usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
				},
			},
		]);
	}
	return sse([
		{
			id: "chatcmpl-test",
			object: "chat.completion.chunk",
			created: 0,
			model: completionsModel.id,
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			usage: { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1 },
		},
		"[DONE]",
	]);
};

await streamOpenAIResponses({ ...responsesModel, baseUrl: "https://api.openai.com/v1" }, baseContext(), {
	apiKey: "test-key",
	fetch: customFetch,
}).result();
await streamOpenAICompletions({ ...completionsModel, baseUrl: "https://api.openai.com/v1" }, baseContext(), {
	apiKey: "test-key",
	fetch: customFetch,
}).result();

assertEqual(calls[0]?.url, "https://inherited-openai.example.com/v1/responses", "responses inherited base URL");
assertEqual(calls[1]?.url, "https://inherited-openai.example.com/v1/chat/completions", "completions inherited base URL");
`,
			{ OPENAI_BASE_URL: "https://inherited-openai.example.com/v1" },
			"OPENAI_BASE_URL=https://dotenv-openai.example.com/v1\n",
		);
	});

	it("keeps deliberate non-default OpenAI model base URLs ahead of inherited OPENAI_BASE_URL", () => {
		runProviderIsolationScript(
			`${openAIProviderIsolationPrelude()}
Bun.env.OPENAI_BASE_URL = "https://fallback-openai.example.com/v1";

const calls: Array<{ url: string }> = [];
const customFetch = async (input: string | URL | Request, _init?: RequestInit): Promise<Response> => {
	calls.push({ url: String(input instanceof Request ? input.url : input) });
	return sse([
		{ type: "response.created", response: { id: "resp_test" } },
		{
			type: "response.completed",
			response: {
				id: "resp_test",
				status: "completed",
				usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
			},
		},
	]);
};

await streamOpenAIResponses({ ...responsesModel, baseUrl: "https://runtime-gateway.example.com/v1" }, baseContext(), {
	apiKey: "test-key",
	fetch: customFetch,
}).result();

assertEqual(calls[0]?.url, "https://runtime-gateway.example.com/v1/responses", "runtime model base URL");
`,
			{ OPENAI_BASE_URL: "https://inherited-openai.example.com/v1" },
			"OPENAI_BASE_URL=https://dotenv-openai.example.com/v1\n",
		);
	});
	it("does not apply direct OpenAI Responses session or prompt-cache fields to proxy-shaped configured base URLs", () => {
		runProviderIsolationScript(
			`${openAIProviderIsolationPrelude()}
Bun.env.OPENAI_BASE_URL = "https://fallback-openai.example.com/v1";

const calls: Array<{
	url: string;
	sessionId: string | null;
	clientRequestId: string | null;
	promptCacheKey?: unknown;
	promptCacheRetention?: unknown;
}> = [];
const customFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
	const body = JSON.parse(String(init?.body ?? "{}")) as {
		prompt_cache_key?: unknown;
		prompt_cache_retention?: unknown;
	};
	const headers = new Headers(init?.headers);
	calls.push({
		url: String(input instanceof Request ? input.url : input),
		sessionId: headers.get("session_id"),
		clientRequestId: headers.get("x-client-request-id"),
		promptCacheKey: body.prompt_cache_key,
		promptCacheRetention: body.prompt_cache_retention,
	});
	return sse([
		{ type: "response.created", response: { id: "resp_test" } },
		{
			type: "response.completed",
			response: {
				id: "resp_test",
				status: "completed",
				usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
			},
		},
	]);
};

await streamOpenAIResponses(
	{ ...responsesModel, baseUrl: "https://api.openai.com.proxy.example.com/v1" },
	baseContext(),
	{
		apiKey: "test-key",
		cacheRetention: "long",
		fetch: customFetch,
		sessionId: "proxy-session",
	},
).result();
await streamOpenAIResponses(
	{ ...responsesModel, baseUrl: "https://proxy.example.com/api.openai.com/v1" },
	baseContext(),
	{
		apiKey: "test-key",
		cacheRetention: "long",
		fetch: customFetch,
		sessionId: "path-session",
	},
).result();

assertEqual(calls[0]?.url, "https://api.openai.com.proxy.example.com/v1/responses", "host proxy URL");
assertEqual(calls[0]?.sessionId, null, "host proxy session header");
assertEqual(calls[0]?.clientRequestId, null, "host proxy request id header");
assertEqual(String(calls[0]?.promptCacheKey), "proxy-session", "host proxy prompt cache key");
assertEqual(calls[0]?.promptCacheRetention as string | undefined, undefined, "host proxy prompt cache retention");
assertEqual(calls[1]?.url, "https://proxy.example.com/api.openai.com/v1/responses", "path proxy URL");
assertEqual(calls[1]?.sessionId, null, "path proxy session header");
assertEqual(calls[1]?.clientRequestId, null, "path proxy request id header");
assertEqual(String(calls[1]?.promptCacheKey), "path-session", "path proxy prompt cache key");
assertEqual(calls[1]?.promptCacheRetention as string | undefined, undefined, "path proxy prompt cache retention");
`,
			{ OPENAI_BASE_URL: "https://inherited-openai.example.com/v1" },
			"OPENAI_BASE_URL=https://dotenv-openai.example.com/v1\n",
		);
	});

	it("keeps OAuth OpenAI Responses on the default API base URL ahead of inherited and fallback OPENAI_BASE_URL", () => {
		runProviderIsolationScript(
			`${openAIProviderIsolationPrelude()}
Bun.env.OPENAI_BASE_URL = "https://fallback-openai.example.com/v1";

const calls: Array<{ url: string }> = [];
const customFetch = async (input: string | URL | Request, _init?: RequestInit): Promise<Response> => {
	calls.push({ url: String(input instanceof Request ? input.url : input) });
	return sse([
		{ type: "response.created", response: { id: "resp_test" } },
		{
			type: "response.completed",
			response: {
				id: "resp_test",
				status: "completed",
				usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
			},
		},
	]);
};

await streamOpenAIResponses(responsesModel, baseContext(), {
	apiKey: "oauth-token",
	authCredentialType: "oauth",
	fetch: customFetch,
}).result();

assertEqual(calls[0]?.url, "https://api.openai.com/v1/responses", "oauth base URL");
`,
			{ OPENAI_BASE_URL: "https://inherited-openai.example.com/v1" },
			"OPENAI_BASE_URL=https://dotenv-openai.example.com/v1\n",
		);
	});

	it("uses inherited shell OPENAI_API_KEY for Authorization and lets explicit apiKey win", () => {
		runProviderIsolationScript(
			`${openAIProviderIsolationPrelude()}
Bun.env.OPENAI_API_KEY = "fallback-key";

const authorizations: Array<string | null> = [];
const customFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
	const url = String(input instanceof Request ? input.url : input);
	authorizations.push(new Headers(init?.headers).get("authorization"));
	if (url.endsWith("/chat/completions")) {
		return sse([
			{
				id: "chatcmpl-test",
				object: "chat.completion.chunk",
				created: 0,
				model: completionsModel.id,
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				usage: { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1 },
			},
			"[DONE]",
		]);
	}
	return sse([
		{ type: "response.created", response: { id: "resp_test" } },
		{
			type: "response.completed",
			response: {
				id: "resp_test",
				status: "completed",
				usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
			},
		},
	]);
};

await streamOpenAIResponses(responsesModel, baseContext(), { fetch: customFetch }).result();
await streamOpenAICompletions(completionsModel, baseContext(), { fetch: customFetch }).result();
await streamOpenAIResponses(responsesModel, baseContext(), {
	apiKey: "explicit-key",
	fetch: customFetch,
}).result();

assertEqual(authorizations[0], "Bearer inherited-key", "responses inherited authorization");
assertEqual(authorizations[1], "Bearer inherited-key", "completions inherited authorization");
assertEqual(authorizations[2], "Bearer explicit-key", "explicit authorization");
`,
			{ OPENAI_API_KEY: "inherited-key" },
			"OPENAI_API_KEY=dotenv-key\n",
		);
	});
});
