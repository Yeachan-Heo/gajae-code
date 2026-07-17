import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as tls from "node:tls";
import { Effort } from "@gajae-code/ai";
import {
	applyClaudeToolPrefix,
	buildAnthropicClientOptions,
	buildAnthropicHeaders,
	buildAnthropicSystemBlocks,
	claudeCodeVersion,
	generateClaudeCloakingUserId,
	isClaudeCloakingUserId,
	mapStainlessArch,
	mapStainlessOs,
	streamAnthropic,
	stripClaudeToolPrefix,
} from "@gajae-code/ai/providers/anthropic";
import { getEnvApiKey } from "@gajae-code/ai/stream";
import type { Context, Model, TJsonSchema, Tool } from "@gajae-code/ai/types";
import * as z from "zod/v4";
import { withEnv } from "./helpers";

const ANTHROPIC_MODEL: Model<"anthropic-messages"> = {
	id: "claude-sonnet-4-5",
	name: "Claude Sonnet 4.5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
};

const CLOUDFLARE_ANTHROPIC_MODEL: Model<"anthropic-messages"> = {
	...ANTHROPIC_MODEL,
	id: "anthropic/claude-sonnet-4-5",
	name: "Claude Sonnet 4.5 via Cloudflare",
	provider: "cloudflare-ai-gateway",
	baseUrl: "https://gateway.ai.cloudflare.com/v1/account/gateway/anthropic",
};

function createAbortedSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

type CaptureAnthropicOptions = {
	isOAuth?: boolean;
	metadata?: { user_id?: string };
	thinkingEnabled?: boolean;
	reasoning?: Effort;
	temperature?: number;
	topP?: number;
	topK?: number;
	toolChoice?: "auto" | "none" | "any" | { type: "tool"; name: string };
};

function captureAnthropicPayload(
	model: Model<"anthropic-messages">,
	context: Context,
	options?: CaptureAnthropicOptions,
): Promise<unknown> {
	const { promise, resolve } = Promise.withResolvers<unknown>();
	streamAnthropic(model, context, {
		apiKey: "sk-ant-oat-test",
		isOAuth: options?.isOAuth ?? true,
		signal: createAbortedSignal(),
		metadata: options?.metadata,
		thinkingEnabled: options?.thinkingEnabled,
		reasoning: options?.reasoning,
		temperature: options?.temperature,
		topP: options?.topP,
		topK: options?.topK,
		toolChoice: options?.toolChoice,
		onPayload: payload => resolve(payload),
	});
	return promise;
}

describe("Anthropic request fingerprint alignment", () => {
	it("maps Stainless OS and arch values from explicit inputs", () => {
		expect(mapStainlessOs("darwin")).toBe("MacOS");
		expect(mapStainlessOs("windows")).toBe("Windows");
		expect(mapStainlessOs("linux")).toBe("Linux");
		expect(mapStainlessOs("freebsd")).toBe("FreeBSD");
		expect(mapStainlessOs("solaris")).toBe("Other::solaris");

		expect(mapStainlessArch("x64")).toBe("x64");
		expect(mapStainlessArch("amd64")).toBe("x64");
		expect(mapStainlessArch("arm64")).toBe("arm64");
		expect(mapStainlessArch("386")).toBe("x86");
		expect(mapStainlessArch("x86")).toBe("x86");
		expect(mapStainlessArch("sparc64")).toBe("other::sparc64");
	});

	it("uses runtime Stainless OS and arch mappings in Anthropic headers", () => {
		const headers = buildAnthropicHeaders({
			apiKey: "sk-ant-oat-test",
			isOAuth: true,
			stream: true,
		});

		expect(headers["X-Stainless-Os"]).toBe(mapStainlessOs(process.platform));
		expect(headers["X-Stainless-Arch"]).toBe(mapStainlessArch(process.arch));
	});

	it("attaches cache_control only to the last emitted system block when cacheControl is set", () => {
		const blocks = buildAnthropicSystemBlocks(["Stay concise."], {
			includeClaudeCodeInstruction: true,
			extraInstructions: ["Use citations when possible"],
			cacheControl: { type: "ephemeral" },
		});

		expect(blocks).toBeDefined();
		// Earlier blocks must NOT carry cache_control; a single trailing breakpoint covers them all.
		expect(blocks?.[2]).toEqual({
			type: "text",
			text: "Use citations when possible",
		});
		expect(blocks?.[3]).toEqual({
			type: "text",
			text: "Stay concise.",
			cache_control: { type: "ephemeral" },
		});
	});

	it("places the automatic Anthropic cache breakpoint on the last ordered system prompt", async () => {
		const payload = (await captureAnthropicPayload(
			ANTHROPIC_MODEL,
			{
				systemPrompt: ["stable system", "stable durable context"],
				messages: [{ role: "user", content: "variable context", timestamp: Date.now() }],
			},
			{ isOAuth: false },
		)) as { system?: Array<{ type: string; text?: string; cache_control?: unknown }> };

		expect(payload.system).toEqual([
			{ type: "text", text: "stable system" },
			// Canonical Anthropic API + long-cache-capable model defaults to 1h retention.
			{ type: "text", text: "stable durable context", cache_control: { type: "ephemeral", ttl: "1h" } },
		]);
	});

	it("uses Bearer auth for non-Anthropic API bases with api-key credentials", () => {
		const headers = buildAnthropicHeaders({
			apiKey: "sk-ant-api-test",
			baseUrl: "https://proxy.example.com",
			stream: true,
		});

		expect(headers.Authorization).toBe("Bearer sk-ant-api-test");
		expect(headers["X-Api-Key"]).toBeUndefined();
	});

	it("forwards a custom User-Agent through the non-Anthropic proxy branch so WAFs see the configured client", () => {
		const headers = buildAnthropicHeaders({
			apiKey: "sk-ant-api-test",
			baseUrl: "https://api.layofflabs.com",
			stream: true,
			modelHeaders: { "User-Agent": "curl/8.7.1" },
		});

		expect(headers["User-Agent"]).toBe("curl/8.7.1");
	});

	it("forwards only prefix-matching Claude Code User-Agent values", () => {
		const forwardedHeaders = buildAnthropicHeaders({
			apiKey: "sk-ant-oat-test",
			isOAuth: true,
			stream: true,
			modelHeaders: { "User-Agent": "claude-cli/2.1.63 (external, cli)" },
		});
		expect(forwardedHeaders["User-Agent"]).toBe("claude-cli/2.1.63 (external, cli)");

		// Test variant without slash
		const forwardedNoSlashHeaders = buildAnthropicHeaders({
			apiKey: "sk-ant-oat-test",
			isOAuth: true,
			stream: true,
			modelHeaders: { "User-Agent": "claude-cli-dev" },
		});
		expect(forwardedNoSlashHeaders["User-Agent"]).toBe("claude-cli-dev");

		const normalizedHeaders = buildAnthropicHeaders({
			apiKey: "sk-ant-oat-test",
			isOAuth: true,
			stream: true,
			modelHeaders: { "User-Agent": "curl/8.7.1" },
		});
		expect(normalizedHeaders["User-Agent"]).toBe(`claude-cli/${claudeCodeVersion} (external, cli)`);

		const embeddedClaudeCliHeaders = buildAnthropicHeaders({
			apiKey: "sk-ant-oat-test",
			isOAuth: true,
			stream: true,
			modelHeaders: { "User-Agent": "my-client claude-cli/2.1.63" },
		});
		expect(embeddedClaudeCliHeaders["User-Agent"]).toBe(`claude-cli/${claudeCodeVersion} (external, cli)`);
	});

	it("skips Claude Code instruction injection for claude-3-5-haiku models", async () => {
		const payload = (await captureAnthropicPayload(
			{ ...ANTHROPIC_MODEL, id: "claude-3-5-haiku", name: "Claude 3.5 Haiku" },
			{
				systemPrompt: ["Stay concise."],
				messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
			},
		)) as { system?: Array<{ type: string; text?: string }> };

		expect(Array.isArray(payload.system)).toBe(true);
		const systemBlocks = payload.system ?? [];
		expect(systemBlocks.some(block => block.text?.startsWith("x-anthropic-billing-header:"))).toBe(false);
		expect(systemBlocks[0]?.text).toBe("Stay concise.");
	});

	it("accepts uppercase hex in the user hash segment", () => {
		const userId =
			"user_ABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCD_account_12345678-1234-1234-1234-1234567890ab_session_abcdefab-cdef-abcd-efab-cdefabcdef12";
		expect(isClaudeCloakingUserId(userId)).toBe(true);
	});

	it("generates cloaking-compatible user IDs", () => {
		const userId = generateClaudeCloakingUserId();
		expect(isClaudeCloakingUserId(userId)).toBe(true);
	});

	it("injects generated metadata.user_id for OAuth requests when missing", async () => {
		const payload = (await captureAnthropicPayload(ANTHROPIC_MODEL, {
			systemPrompt: ["Stay concise."],
			messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
		})) as { metadata?: { user_id?: string } };
		const userId = payload.metadata?.user_id;
		expect(typeof userId).toBe("string");
		expect(isClaudeCloakingUserId(userId ?? "")).toBe(true);
	});

	it("does not inject metadata.user_id for non-OAuth requests without caller metadata", async () => {
		const payload = (await captureAnthropicPayload(
			ANTHROPIC_MODEL,
			{
				systemPrompt: ["Stay concise."],
				messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
			},
			{ isOAuth: false },
		)) as { metadata?: { user_id?: string } };
		expect(payload.metadata).toBeUndefined();
	});

	it("preserves valid caller metadata.user_id for OAuth requests", async () => {
		const userId = generateClaudeCloakingUserId();
		const payload = (await captureAnthropicPayload(
			ANTHROPIC_MODEL,
			{
				systemPrompt: ["Stay concise."],
				messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
			},
			{ metadata: { user_id: userId } },
		)) as { metadata?: { user_id?: string } };

		expect(payload.metadata?.user_id).toBe(userId);
	});

	it("preserves real Claude Code JSON-format metadata.user_id for OAuth requests", async () => {
		// Matches the shape produced by services/api/Anthropic model.ts → getAPIMetadata in
		// the Anthropic Code source: { device_id, account_uuid, session_id, ...extra }.
		const userId = JSON.stringify({
			device_id: "a".repeat(64),
			account_uuid: "12345678-1234-1234-1234-1234567890ab",
			session_id: "abcdefab-cdef-abcd-efab-cdefabcdef12",
		});
		const payload = (await captureAnthropicPayload(
			ANTHROPIC_MODEL,
			{
				systemPrompt: ["Stay concise."],
				messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
			},
			{ metadata: { user_id: userId } },
		)) as { metadata?: { user_id?: string } };

		expect(payload.metadata?.user_id).toBe(userId);
	});

	it("preserves a minimal { session_id } JSON metadata.user_id for OAuth requests", async () => {
		const userId = JSON.stringify({ session_id: "0190fb1e-0000-7000-8000-000000000001" });
		const payload = (await captureAnthropicPayload(
			ANTHROPIC_MODEL,
			{
				systemPrompt: ["Stay concise."],
				messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
			},
			{ metadata: { user_id: userId } },
		)) as { metadata?: { user_id?: string } };

		expect(payload.metadata?.user_id).toBe(userId);
	});

	it("replaces JSON metadata.user_id missing session_id for OAuth requests", async () => {
		const userId = JSON.stringify({ device_id: "x".repeat(64) });
		const payload = (await captureAnthropicPayload(
			ANTHROPIC_MODEL,
			{
				systemPrompt: ["Stay concise."],
				messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
			},
			{ metadata: { user_id: userId } },
		)) as { metadata?: { user_id?: string } };

		expect(payload.metadata?.user_id).not.toBe(userId);
		expect(isClaudeCloakingUserId(payload.metadata?.user_id ?? "")).toBe(true);
	});

	it("replaces invalid caller metadata.user_id for OAuth requests", async () => {
		const payload = (await captureAnthropicPayload(
			ANTHROPIC_MODEL,
			{
				systemPrompt: ["Stay concise."],
				messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
			},
			{ metadata: { user_id: "invalid-user-id" } },
		)) as { metadata?: { user_id?: string } };

		expect(payload.metadata?.user_id).not.toBe("invalid-user-id");
		expect(isClaudeCloakingUserId(payload.metadata?.user_id ?? "")).toBe(true);
	});

	it("omits forced tool_choice for Anthropic Mythos models via compat resolution", async () => {
		const payload = (await captureAnthropicPayload(
			{ ...ANTHROPIC_MODEL, id: "claude-mythos-4", name: "Claude Mythos 4", compat: { toolChoiceSupport: "auto" } },
			{
				systemPrompt: ["Stay concise."],
				messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
				tools: [
					{
						name: "resolve",
						description: "resolve a pending action",
						parameters: {
							type: "object",
							properties: { action: { type: "string" } },
							required: ["action"],
						} as TJsonSchema,
					},
				],
			},
			{ toolChoice: { type: "tool", name: "resolve" } },
		)) as { tool_choice?: unknown; tools?: unknown[] };

		expect(payload.tool_choice).toBeUndefined();
		expect(payload.tools).toHaveLength(1);
	});

	it("does not hard-code Mythos forced tool_choice gating in Anthropic request code", () => {
		const source = fs.readFileSync(path.join(import.meta.dir, "../src/providers/anthropic.ts"), "utf8");
		expect(source).not.toContain("claude-mythos");
	});

	it("keeps forced tool_choice for compatible Anthropic models", async () => {
		const payload = (await captureAnthropicPayload(
			ANTHROPIC_MODEL,
			{
				systemPrompt: ["Stay concise."],
				messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
			},
			{ toolChoice: { type: "tool", name: "resolve" } },
		)) as { tool_choice?: unknown };

		expect(payload.tool_choice).toEqual({ type: "tool", name: "proxy_resolve" });
	});
	it("adds additionalProperties false to Anthropic tool object schemas", async () => {
		const originalNestedSchema = {
			type: "object",
			properties: {
				path: { type: "string" },
			},
			patternProperties: {
				"^x-": { type: "string" },
			},
			required: ["path"],
		};
		const tools: Tool[] = [
			{
				name: "edit_file",
				description: "edit files",
				parameters: {
					type: "object",
					properties: {
						target: originalNestedSchema,
						operations: {
							type: "array",
							items: {
								type: "object",
								properties: { content: { type: "string" } },
								required: ["content"],
							},
						},
						env: {
							type: "object",
							patternProperties: {
								"^[A-Za-z_][A-Za-z0-9_]*$": { type: "string" },
							},
							propertyNames: {
								type: "string",
								pattern: "^[A-Za-z_][A-Za-z0-9_]*$",
							},
						},
					},
					required: ["target"],
				} as TJsonSchema,
			},
		];

		const payload = (await captureAnthropicPayload(ANTHROPIC_MODEL, {
			systemPrompt: ["Stay concise."],
			messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
			tools,
		})) as {
			tools?: Array<{
				input_schema?: {
					additionalProperties?: boolean;
					properties?: Record<string, unknown>;
					required?: string[];
				};
			}>;
		};

		const inputSchema = payload.tools?.[0]?.input_schema;
		const properties = inputSchema?.properties as Record<string, Record<string, unknown>>;
		const target = properties.target as { additionalProperties?: boolean; patternProperties?: unknown };
		const operations = properties.operations as {
			type?: string;
			items?: { additionalProperties?: boolean; required?: string[] };
		};
		const env = properties.env as {
			additionalProperties?: boolean;
			patternProperties?: unknown;
			propertyNames?: unknown;
		};

		expect(inputSchema?.additionalProperties).toBe(false);
		expect(inputSchema?.required).toEqual(["target"]);
		expect(target.additionalProperties).toBe(false);
		expect(operations.type).toBe("array");
		expect(operations.items?.additionalProperties).toBe(false);
		expect(operations.items?.required).toEqual(["content"]);
		expect(target).not.toHaveProperty("patternProperties");
		expect(env.additionalProperties).toBe(false);
		expect(env).not.toHaveProperty("patternProperties");
		expect(env).not.toHaveProperty("propertyNames");
		expect(inputSchema?.properties).toHaveProperty("target");
		expect(originalNestedSchema).not.toHaveProperty("additionalProperties");
		expect(originalNestedSchema).toHaveProperty("patternProperties");
	});

	it("preserves explicit additionalProperties schemas and true for open record fields", async () => {
		// Mirrors open record-style shapes: Zod's `z.record(z.string(), z.unknown())`
		// emits `additionalProperties: {}`, typed maps use a schema, and the yield
		// fallback uses `additionalProperties: true`. Each must remain open after
		// unsupported key-schema keywords are stripped.
		const tools: Tool[] = [
			{
				name: "resolve",
				description: "resolve a pending action",
				parameters: {
					type: "object",
					properties: {
						action: { type: "string" },
						extra: {
							type: "object",
							propertyNames: { type: "string" },
							additionalProperties: {},
						},
						extraTyped: {
							type: "object",
							additionalProperties: { type: "string" },
						},
						extraLoose: {
							type: "object",
							additionalProperties: true,
						},
					},
					required: ["action"],
				} as TJsonSchema,
			},
		];

		const payload = (await captureAnthropicPayload(ANTHROPIC_MODEL, {
			systemPrompt: ["Stay concise."],
			messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
			tools,
		})) as {
			tools?: Array<{
				input_schema?: {
					additionalProperties?: boolean;
					properties?: Record<string, unknown>;
				};
			}>;
		};

		const inputSchema = payload.tools?.[0]?.input_schema;
		const properties = inputSchema?.properties as Record<string, Record<string, unknown>>;
		const extra = properties.extra as { additionalProperties?: unknown; propertyNames?: unknown };
		const extraTyped = properties.extraTyped as { additionalProperties?: unknown };
		const extraLoose = properties.extraLoose as { additionalProperties?: unknown };

		expect(inputSchema?.additionalProperties).toBe(false);
		// The unsupported `propertyNames` keyword is still stripped …
		expect(extra).not.toHaveProperty("propertyNames");
		// … but the explicit open-map schema survives (normalized to `true` per
		// JSON Schema 2020-12 §4.3.1 — `{}` and `true` are equivalent).
		expect(extra.additionalProperties).toBe(true);
		// A typed value schema is preserved verbatim (and would be recursed into
		// if it were an object — covered separately).
		expect(extraTyped.additionalProperties).toEqual({ type: "string" });
		expect(extraLoose.additionalProperties).toBe(true);
	});

	it("removes Anthropic-unsupported array item count constraints", async () => {
		const tools: Tool[] = [
			{
				name: "edit_file",
				description: "edit files",
				parameters: {
					type: "object",
					properties: {
						sub: {
							type: "array",
							items: { type: "string" },
							minItems: 2,
							maxItems: 2,
						},
						nonEmpty: {
							type: "array",
							items: { type: "string" },
							minItems: 1,
						},
					},
					required: ["sub"],
				} as TJsonSchema,
			},
		];

		const payload = (await captureAnthropicPayload(ANTHROPIC_MODEL, {
			systemPrompt: ["Stay concise."],
			messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
			tools,
		})) as {
			tools?: Array<{
				input_schema?: {
					properties?: Record<string, unknown>;
				};
			}>;
		};

		const properties = payload.tools?.[0]?.input_schema?.properties as Record<string, Record<string, unknown>>;

		expect(properties.sub).not.toHaveProperty("minItems");
		expect(properties.sub).not.toHaveProperty("maxItems");
		expect(properties.nonEmpty.minItems).toBe(1);
	});

	it("strips minItems from object-typed property schemas (Anthropic rejects them)", async () => {
		const tools: Tool[] = [
			{
				name: "weird",
				description: "nested object with stray minItems",
				parameters: {
					type: "object",
					properties: {
						block: {
							type: "object",
							properties: { a: { type: "string" } },
							required: ["a"],
							minItems: 1,
						},
					},
					required: ["block"],
				} as TJsonSchema,
			},
		];

		const payload = (await captureAnthropicPayload(ANTHROPIC_MODEL, {
			systemPrompt: ["Stay concise."],
			messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
			tools,
		})) as {
			tools?: Array<{
				input_schema?: { properties?: Record<string, unknown> };
			}>;
		};

		const block = payload.tools?.[0]?.input_schema?.properties?.block as Record<string, unknown> | undefined;
		expect(block?.type).toBe("object");
		expect(block).not.toHaveProperty("minItems");
	});

	it("marks only the Anthropic strict allowlist strict", async () => {
		const tools: Tool[] = [
			...(["bash", "python", "edit", "find"] as const).map(name => ({
				name,
				description: `${name} tool`,
				strict: true,
				parameters: {
					type: "object",
					properties: { requiredValue: { type: "string" } },
					required: ["requiredValue"],
				} as TJsonSchema,
			})),
			...(["write", "grep", "read", "task", "todo_write", "web_search", "ast_grep"] as const).map(name => ({
				name,
				description: `${name} tool`,
				strict: true,
				parameters: {
					type: "object",
					properties: { requiredValue: { type: "string" } },
					required: ["requiredValue"],
				} as TJsonSchema,
			})),
		];

		const payload = (await captureAnthropicPayload(
			ANTHROPIC_MODEL,
			{
				systemPrompt: ["Stay concise."],
				messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
				tools,
			},
			{ isOAuth: false },
		)) as {
			tools?: Array<{ name?: string; strict?: boolean; input_schema?: { required?: string[] } }>;
		};

		const strictNames = (payload.tools ?? []).filter(tool => tool.strict === true).map(tool => tool.name);

		expect(strictNames).toEqual(["bash", "python", "edit", "find"]);
		expect(payload.tools?.find(tool => tool.name === "bash")?.input_schema?.required).toEqual(["requiredValue"]);
	});

	it("never sends strict tools on OAuth requests", async () => {
		const tools: Tool[] = (["bash", "python", "edit", "find"] as const).map(name => ({
			name,
			description: `${name} tool`,
			strict: true,
			parameters: {
				type: "object",
				properties: { requiredValue: { type: "string" } },
				required: ["requiredValue"],
			} as TJsonSchema,
		}));

		const payload = (await captureAnthropicPayload(
			ANTHROPIC_MODEL,
			{
				systemPrompt: ["Stay concise."],
				messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
				tools,
			},
			{ isOAuth: true },
		)) as {
			tools?: Array<{ name?: string; strict?: boolean }>;
		};

		expect(payload.tools?.length).toBe(4);
		expect((payload.tools ?? []).some(tool => tool.strict === true)).toBe(false);
		// OAuth still prefixes custom tool names.
		expect(payload.tools?.map(tool => tool.name)).toEqual(["proxy_bash", "proxy_python", "proxy_edit", "proxy_find"]);
	});

	it("marks regular two-field Zod object tools strict", async () => {
		const tools: Tool[] = [
			{
				name: "bash",
				description: "bash tool",
				strict: true,
				parameters: z.object({
					command: z.string(),
					cwd: z.string(),
				}),
			},
		];

		const payload = (await captureAnthropicPayload(
			ANTHROPIC_MODEL,
			{
				systemPrompt: ["Stay concise."],
				messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
				tools,
			},
			{ isOAuth: false },
		)) as {
			tools?: Array<{
				name?: string;
				strict?: boolean;
				input_schema?: { properties?: Record<string, unknown>; required?: string[] };
			}>;
		};

		const bashTool = payload.tools?.find(tool => tool.name === "bash");

		expect(bashTool?.strict).toBe(true);
		expect(Object.keys(bashTool?.input_schema?.properties ?? {})).toEqual(["command", "cwd"]);
		expect(bashTool?.input_schema?.required).toEqual(["command", "cwd"]);
	});

	it("does not mark allowlisted Anthropic tools strict when schemas contain open object maps", async () => {
		const tools: Tool[] = [
			{
				name: "bash",
				description: "bash tool",
				strict: true,
				parameters: {
					type: "object",
					properties: {
						command: { type: "string" },
						env: {
							type: "object",
							additionalProperties: { type: "string" },
						},
					},
					required: ["command"],
				} as TJsonSchema,
			},
			{
				name: "python",
				description: "python tool",
				strict: true,
				parameters: {
					type: "object",
					properties: { requiredValue: { type: "string" } },
					required: ["requiredValue"],
				} as TJsonSchema,
			},
		];

		const payload = (await captureAnthropicPayload(
			ANTHROPIC_MODEL,
			{
				systemPrompt: ["Stay concise."],
				messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
				tools,
			},
			{ isOAuth: false },
		)) as {
			tools?: Array<{
				name?: string;
				strict?: boolean;
				input_schema?: { properties?: Record<string, unknown>; required?: string[] };
			}>;
		};

		const bashTool = payload.tools?.find(tool => tool.name === "bash");
		const pythonTool = payload.tools?.find(tool => tool.name === "python");
		const env = bashTool?.input_schema?.properties?.env as { additionalProperties?: unknown } | undefined;

		expect(bashTool?.strict).toBeUndefined();
		expect(env?.additionalProperties).toEqual({ type: "string" });
		expect(pythonTool?.strict).toBe(true);
		expect(pythonTool?.input_schema?.required).toEqual(["requiredValue"]);
	});

	it("honors strict=false and skips non-allowlisted Anthropic tools", async () => {
		const tools: Tool[] = [
			{
				name: "bash",
				description: "bash tool",
				strict: false,
				parameters: {
					type: "object",
					properties: { requiredValue: { type: "string" } },
					required: ["requiredValue"],
				} as TJsonSchema,
			},
			{
				name: "python",
				description: "python tool",
				strict: true,
				parameters: {
					type: "object",
					properties: { requiredValue: { type: "string" } },
					required: ["requiredValue"],
				} as TJsonSchema,
			},
			{
				name: "write",
				description: "write tool",
				parameters: {
					type: "object",
					properties: { requiredValue: { type: "string" } },
					required: ["requiredValue"],
				} as TJsonSchema,
			},
			{
				name: "grep",
				description: "grep tool",
				strict: true,
				parameters: {
					type: "object",
					properties: { requiredValue: { type: "string" } },
					required: ["requiredValue"],
				} as TJsonSchema,
			},
		];

		const payload = (await captureAnthropicPayload(
			ANTHROPIC_MODEL,
			{
				systemPrompt: ["Stay concise."],
				messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
				tools,
			},
			{ isOAuth: false },
		)) as { tools?: Array<{ name?: string; strict?: boolean }> };

		const strictNames = (payload.tools ?? []).filter(tool => tool.strict === true).map(tool => tool.name);
		expect(strictNames).toEqual(["python"]);
	});

	it("adds legacy fine-grained tool-streaming beta only for tool requests on incompatible models", () => {
		const incompatibleModel: Model<"anthropic-messages"> = {
			...ANTHROPIC_MODEL,
			compat: { supportsEagerToolInputStreaming: false },
		};

		const withoutTools = buildAnthropicClientOptions({
			model: incompatibleModel,
			apiKey: "sk-ant-api-test",
			extraBetas: [],
			stream: true,
			interleavedThinking: false,
			hasTools: false,
		});
		const withCompatibleTools = buildAnthropicClientOptions({
			model: ANTHROPIC_MODEL,
			apiKey: "sk-ant-api-test",
			extraBetas: [],
			stream: true,
			interleavedThinking: false,
			hasTools: true,
		});
		const withIncompatibleTools = buildAnthropicClientOptions({
			model: incompatibleModel,
			apiKey: "sk-ant-api-test",
			extraBetas: [],
			stream: true,
			interleavedThinking: false,
			hasTools: true,
		});

		expect(withoutTools.defaultHeaders["Anthropic-Beta"]).not.toContain("fine-grained-tool-streaming-2025-05-14");
		expect(withCompatibleTools.defaultHeaders["Anthropic-Beta"]).not.toContain(
			"fine-grained-tool-streaming-2025-05-14",
		);
		expect(withIncompatibleTools.defaultHeaders["Anthropic-Beta"]).toContain(
			"fine-grained-tool-streaming-2025-05-14",
		);
	});

	it("uses Cloudflare AI Gateway authorization without Anthropic credential headers", () => {
		const options = buildAnthropicClientOptions({
			model: CLOUDFLARE_ANTHROPIC_MODEL,
			apiKey: "cf-gateway-token",
			extraBetas: [],
			stream: true,
			interleavedThinking: false,
			dynamicHeaders: {},
		});

		expect(options.baseURL).toBe("https://gateway.ai.cloudflare.com/v1/account/gateway/anthropic");
		expect(options.apiKey).toBeNull();
		expect(options.authToken).toBeNull();
		expect(options.defaultHeaders["cf-aig-authorization"]).toBe("Bearer cf-gateway-token");
		expect(options.defaultHeaders.Authorization).toBeUndefined();
		expect(options.defaultHeaders["X-Api-Key"]).toBeUndefined();
	});

	it("keeps Cloudflare gateway auth authoritative over caller-supplied auth headers", () => {
		const options = buildAnthropicClientOptions({
			model: {
				...CLOUDFLARE_ANTHROPIC_MODEL,
				headers: {
					Authorization: "Bearer anthropic-oauth",
					"X-Api-Key": "sk-ant-api-leak",
					"cf-aig-authorization": "Bearer stale-token",
				},
			},
			apiKey: "cf-gateway-token",
			extraBetas: [],
			stream: true,
			interleavedThinking: false,
			dynamicHeaders: {},
		});

		expect(options.defaultHeaders["cf-aig-authorization"]).toBe("Bearer cf-gateway-token");
		expect(options.defaultHeaders.Authorization).toBeUndefined();
		expect(options.defaultHeaders["X-Api-Key"]).toBeUndefined();
	});

	it("applies Claude Code TLS profile for direct Anthropic transport", () => {
		const options = buildAnthropicClientOptions({
			model: ANTHROPIC_MODEL,
			apiKey: "sk-ant-oat-test",
			extraBetas: [],
			stream: true,
			interleavedThinking: false,
			dynamicHeaders: {},
		});

		const tlsOptions = (
			options.fetchOptions as
				| {
						tls?: {
							rejectUnauthorized?: boolean;
							serverName?: string;
							ciphers?: string;
						};
				  }
				| undefined
		)?.tls;
		expect(tlsOptions).toBeDefined();
		expect(tlsOptions?.rejectUnauthorized).toBe(true);
		expect(tlsOptions?.serverName).toBe("api.anthropic.com");
		expect(tlsOptions?.ciphers).toBe(tls.DEFAULT_CIPHERS);
	});

	it("uses Foundry base URL, Bearer auth, and custom headers when enabled", async () => {
		await withEnv(
			{
				CLAUDE_CODE_USE_FOUNDRY: "true",
				FOUNDRY_BASE_URL: "https://foundry.example.com/anthropic/",
				ANTHROPIC_CUSTOM_HEADERS: "user-id: alice, x-route: engineering",
			},
			() => {
				const options = buildAnthropicClientOptions({
					model: ANTHROPIC_MODEL,
					apiKey: "foundry-token",
					extraBetas: [],
					stream: true,
					interleavedThinking: false,
					dynamicHeaders: {},
				});

				expect(options.baseURL).toBe("https://foundry.example.com/anthropic");
				expect(options.defaultHeaders.Authorization).toBe("Bearer foundry-token");
				expect(options.defaultHeaders["X-Api-Key"]).toBeUndefined();
				expect(options.defaultHeaders["user-id"]).toBe("alice");
				expect(options.defaultHeaders["x-route"]).toBe("engineering");
			},
		);
	});

	it("loads Foundry mTLS and CA material from file paths", async () => {
		const tmpDir = path.join(os.tmpdir(), `pi-ai-foundry-${Date.now()}-${Math.random().toString(16).slice(2)}`);
		fs.mkdirSync(tmpDir, { recursive: true });
		const caPath = path.join(tmpDir, "ca.pem");
		const certPath = path.join(tmpDir, "client-cert.pem");
		const keyPath = path.join(tmpDir, "client-key.pem");
		fs.writeFileSync(caPath, "-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----\n", "utf8");
		fs.writeFileSync(certPath, "-----BEGIN CERTIFICATE-----\nCERT\n-----END CERTIFICATE-----\n", "utf8");
		fs.writeFileSync(keyPath, "-----BEGIN PRIVATE KEY-----\nKEY\n-----END PRIVATE KEY-----\n", "utf8");

		try {
			await withEnv(
				{
					CLAUDE_CODE_USE_FOUNDRY: "1",
					FOUNDRY_BASE_URL: "https://foundry.example.com",
					NODE_EXTRA_CA_CERTS: caPath,
					CLAUDE_CODE_CLIENT_CERT: certPath,
					CLAUDE_CODE_CLIENT_KEY: keyPath,
				},
				() => {
					const options = buildAnthropicClientOptions({
						model: ANTHROPIC_MODEL,
						apiKey: "foundry-token",
						extraBetas: [],
						stream: true,
						interleavedThinking: false,
						dynamicHeaders: {},
					});

					const tlsOptions = (
						options.fetchOptions as
							| {
									tls?: {
										serverName?: string;
										ca?: string | string[];
										cert?: string;
										key?: string;
									};
							  }
							| undefined
					)?.tls;
					expect(tlsOptions?.serverName).toBe("foundry.example.com");
					expect(Array.isArray(tlsOptions?.ca)).toBe(true);
					const caValues = (tlsOptions?.ca ?? []) as string[];
					expect(caValues.length).toBeGreaterThanOrEqual(tls.rootCertificates.length + 1);
					expect(caValues.slice(0, tls.rootCertificates.length)).toEqual([...tls.rootCertificates]);
					expect(caValues.at(-1)).toContain("BEGIN CERTIFICATE");
					expect(tlsOptions?.cert).toContain("BEGIN CERTIFICATE");
					expect(tlsOptions?.key).toContain("BEGIN PRIVATE KEY");
				},
			);
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("throws when Foundry mTLS cert/key pair is incomplete", async () => {
		await withEnv(
			{
				CLAUDE_CODE_USE_FOUNDRY: "true",
				FOUNDRY_BASE_URL: "https://foundry.example.com",
				CLAUDE_CODE_CLIENT_CERT: "-----BEGIN CERTIFICATE-----\nCERT\n-----END CERTIFICATE-----\n",
				CLAUDE_CODE_CLIENT_KEY: undefined,
			},
			() => {
				expect(() =>
					buildAnthropicClientOptions({
						model: ANTHROPIC_MODEL,
						apiKey: "foundry-token",
						extraBetas: [],
						stream: true,
						interleavedThinking: false,
						dynamicHeaders: {},
					}),
				).toThrow("Both CLAUDE_CODE_CLIENT_CERT and CLAUDE_CODE_CLIENT_KEY must be set for mTLS.");
			},
		);
	});

	it("resolves Anthropic Foundry API key when Foundry mode is enabled", async () => {
		await withEnv(
			{
				CLAUDE_CODE_USE_FOUNDRY: "true",
				ANTHROPIC_FOUNDRY_API_KEY: "foundry-env-token",
				ANTHROPIC_OAUTH_TOKEN: "sk-ant-oat-should-not-win",
				ANTHROPIC_API_KEY: "sk-ant-api-should-not-win",
			},
			() => {
				expect(getEnvApiKey("anthropic")).toBe("foundry-env-token");
			},
		);
	});

	it("sends temperature for Anthropic requests without enabled thinking", async () => {
		const payload = (await captureAnthropicPayload(
			ANTHROPIC_MODEL,
			{
				systemPrompt: ["Stay concise."],
				messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
			},
			{ temperature: 0.2 },
		)) as { temperature?: number; thinking?: { type?: string } };

		expect(payload.temperature).toBe(0.2);
		expect(payload.thinking).toBeUndefined();
	});

	it("omits thinking for reasoning models when thinking is explicitly disabled", async () => {
		const payload = (await captureAnthropicPayload(
			ANTHROPIC_MODEL,
			{
				systemPrompt: ["Stay concise."],
				messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
			},
			{ thinkingEnabled: false },
		)) as { thinking?: { type?: string } };

		expect(payload.thinking).toBeUndefined();
	});

	it("drops temperature and sampling params for Opus 4.7 without enabled thinking", async () => {
		const payload = (await captureAnthropicPayload(
			{ ...ANTHROPIC_MODEL, id: "claude-opus-4-7", name: "Claude Opus 4.7" },
			{
				systemPrompt: ["Stay concise."],
				messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
			},
			{
				temperature: 0.2,
				topP: 0.3,
				topK: 4,
			},
		)) as {
			temperature?: number;
			top_p?: number;
			top_k?: number;
			thinking?: { type?: string };
		};

		expect(payload.temperature).toBeUndefined();
		expect(payload.top_p).toBeUndefined();
		expect(payload.top_k).toBeUndefined();
		expect(payload.thinking).toBeUndefined();
	});

	it("drops sampling params and requests summarized adaptive thinking for Opus 4.7", async () => {
		const payload = (await captureAnthropicPayload(
			{
				...ANTHROPIC_MODEL,
				id: "claude-opus-4-7",
				name: "Claude Opus 4.7",
				thinking: {
					mode: "anthropic-adaptive",
					minLevel: Effort.Minimal,
					maxLevel: Effort.Max,
				},
			},
			{
				systemPrompt: ["Stay concise."],
				messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
			},
			{
				thinkingEnabled: true,
				reasoning: Effort.High,
				temperature: 0.2,
				topP: 0.3,
				topK: 4,
			},
		)) as {
			temperature?: number;
			top_p?: number;
			top_k?: number;
			thinking?: { type?: string; display?: string };
			output_config?: { effort?: string };
		};

		expect(payload.temperature).toBeUndefined();
		expect(payload.top_p).toBeUndefined();
		expect(payload.top_k).toBeUndefined();
		expect(payload.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(payload.output_config).toEqual({ effort: "high" });
	});

	it("maps Opus max reasoning to Anthropic adaptive max", async () => {
		const payload = (await captureAnthropicPayload(
			{
				...ANTHROPIC_MODEL,
				id: "claude-opus-4-7",
				name: "Claude Opus 4.7",
				thinking: {
					mode: "anthropic-adaptive",
					minLevel: Effort.Minimal,
					maxLevel: Effort.Max,
				},
			},
			{
				systemPrompt: ["Stay concise."],
				messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
			},
			{
				thinkingEnabled: true,
				reasoning: Effort.Max,
			},
		)) as { output_config?: { effort?: string } };

		expect(payload.output_config).toEqual({ effort: "max" });
	});

	it("treats tool prefix helpers as no-ops when prefix is empty", () => {
		expect(applyClaudeToolPrefix("Read", "")).toBe("Read");
		expect(stripClaudeToolPrefix("proxy_Read", "")).toBe("proxy_Read");
	});

	it("does not prefix built-in Anthropic tool names when prefix is configured", () => {
		expect(applyClaudeToolPrefix("web_search", "proxy_")).toBe("web_search");
		expect(applyClaudeToolPrefix("CODE_EXECUTION", "proxy_")).toBe("CODE_EXECUTION");
		expect(applyClaudeToolPrefix("Text_Editor", "proxy_")).toBe("Text_Editor");
		expect(applyClaudeToolPrefix("computer", "proxy_")).toBe("computer");
	});

	it("prefixes custom tool names when prefix is configured", () => {
		expect(applyClaudeToolPrefix("Read", "proxy_")).toBe("proxy_Read");
		expect(applyClaudeToolPrefix("proxy_Read", "proxy_")).toBe("proxy_proxy_Read");
		expect(stripClaudeToolPrefix("proxy_Read", "proxy_")).toBe("Read");
		expect(stripClaudeToolPrefix(applyClaudeToolPrefix("proxy_Read", "proxy_"), "proxy_")).toBe("proxy_Read");
	});
});
