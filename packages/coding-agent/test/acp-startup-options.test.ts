import { expect, test } from "bun:test";
import type { AgentSideConnection } from "@agentclientprotocol/sdk";
import { parseArgs } from "../src/cli/args";
import { resolveAcpStartupOptions } from "../src/main";
import {
	acpProviderRegistrations,
	acpSessionStateFromConfig,
	applyAcpPermissionMode,
	applyAcpStartupOptions,
	collectActiveProviderIds,
	collectModelCatalog,
	createAcpReverseConnection,
	paginateAcpSessions,
} from "../src/modes/acp/acp-agent";
import type { CreateAgentSessionOptions } from "../src/sdk";
import {
	ACP_FINAL_TEXT_LIMIT,
	acpFinalTextFromMessage,
	boundAcpFinalText,
	resolveAcpFinalText,
} from "../src/sdk/acp/final-text";

const model = { provider: "openai-codex", id: "gpt-5.6" } as CreateAgentSessionOptions["model"];

function providerNames(capabilities: unknown, env: NodeJS.ProcessEnv = {}): string[] {
	return acpProviderRegistrations(capabilities as never, env).map(provider => provider.capability);
}

test("ACP registers the permission channel for form-less clients regardless of permission mode", () => {
	expect(providerNames({ _meta: { gjc: { permissionHandling: "prompt" } } })).toContain("permission");
	// Form-less clients always get the permission channel so selector asks can
	// be answered even in auto/always-allow mode (the mode only gates tools).
	expect(providerNames({ _meta: { gjc: { permissionHandling: "auto" } } })).toContain("permission");
	expect(providerNames({ _meta: { gjc: { permissionHandling: "always-allow" } } })).toContain("permission");
	expect(providerNames(undefined, { GJC_ACP_PERMISSION_MODE: "prompt" })).toContain("permission");
	expect(providerNames(undefined, { GJC_ACP_PERMISSION_MODE: "auto" })).toContain("permission");
	expect(providerNames({ _meta: { gjc: { permissionHandling: "invalid" } } })).toContain("permission");
	// A form-eliciting client in allow mode keeps only the ui channel.
	expect(providerNames({ _meta: { gjc: { permissionHandling: "auto" } }, elicitation: { form: {} } })).not.toContain(
		"permission",
	);
	expect(providerNames({ _meta: { gjc: { permissionHandling: "auto" } }, elicitation: { form: {} } })).toContain("ui");
});

test("ACP registers the SDK UI provider only for clients with form elicitation", () => {
	expect(providerNames({ elicitation: { form: {} } })).toContain("ui");
	expect(providerNames({ elicitation: {} })).not.toContain("ui");
	expect(providerNames(undefined)).not.toContain("ui");
});

test("ACP reverse requests use canonical names, session scope, and cancellation", async () => {
	const calls: unknown[][] = [];
	const typedCalls: string[] = [];
	const connection = {
		request: async (...args: unknown[]) => {
			calls.push(args);
			return { action: "cancel" };
		},
		requestPermission: async () => {
			typedCalls.push("requestPermission");
			return {};
		},
		readTextFile: async () => {
			typedCalls.push("readTextFile");
			return {};
		},
		writeTextFile: async () => {
			typedCalls.push("writeTextFile");
		},
		createTerminal: async () => {
			typedCalls.push("createTerminal");
			return {};
		},
	} as unknown as AgentSideConnection;
	const signal = new AbortController().signal;
	const reverse = createAcpReverseConnection(connection, "session-1");
	const requests = [
		["request", { toolCallId: "call-1", sessionId: "spoofed-session" }],
		["permission.request", { toolCallId: "call-2", sessionId: "spoofed-session" }],
		["fs.readTextFile", { path: "/workspace/README.md" }],
		["fs.writeTextFile", { path: "/workspace/README.md", content: "updated" }],
		["terminal.create", { command: "printf", args: ["ok"] }],
		["ui.elicit", { mode: "form", message: "Choose" }],
	] as const;
	for (const [method, params] of requests) await reverse.request?.(method, params, { cancellationSignal: signal });

	expect(calls).toEqual([
		["session/request_permission", { toolCallId: "call-1", sessionId: "session-1" }, { cancellationSignal: signal }],
		["session/request_permission", { toolCallId: "call-2", sessionId: "session-1" }, { cancellationSignal: signal }],
		["fs/read_text_file", { path: "/workspace/README.md", sessionId: "session-1" }, { cancellationSignal: signal }],
		[
			"fs/write_text_file",
			{ path: "/workspace/README.md", content: "updated", sessionId: "session-1" },
			{ cancellationSignal: signal },
		],
		["terminal/create", { command: "printf", args: ["ok"], sessionId: "session-1" }, { cancellationSignal: signal }],
		[
			"elicitation/create",
			{ mode: "form", message: "Choose", sessionId: "session-1" },
			{ cancellationSignal: signal },
		],
	]);
	expect(typedCalls).toEqual([]);
});
test("ACP reverse permission aliases normalize nested and flat outcomes into the SDK decision contract", async () => {
	for (const method of ["request", "permission.request"] as const) {
		for (const [response, expected] of [
			[
				{ outcome: { outcome: "selected", optionId: "allow_once" } },
				{ outcome: "selected", optionId: "allow_once" },
			],
			[{ outcome: { outcome: "cancelled" } }, { outcome: "cancelled" }],
			[
				{ outcome: "selected", optionId: "allow_always" },
				{ outcome: "selected", optionId: "allow_always" },
			],
			[{ outcome: "cancelled" }, { outcome: "cancelled" }],
		] as const) {
			const connection = {
				request: async () => response,
			} as unknown as AgentSideConnection;
			const reverse = createAcpReverseConnection(connection, "session-1");
			expect(await reverse.request?.(method, { toolCallId: "call-1" })).toEqual(expected);
		}
	}
});

test("ACP maps non-prompt permission handling to the SDK allow policy", async () => {
	const modes: string[] = [];
	const adapter = {
		control: async (_operation: string, input: Record<string, unknown>) => modes.push(String(input.mode)),
	} as never;
	await applyAcpPermissionMode(adapter, { _meta: { gjc: { permissionHandling: "prompt" } } } as never);
	await applyAcpPermissionMode(adapter, { _meta: { gjc: { permissionHandling: "auto" } } } as never);
	await applyAcpPermissionMode(adapter, { _meta: { gjc: { permissionHandling: "always-allow" } } } as never);
	expect(modes).toEqual(["prompt", "allow", "allow"]);
});

test("ACP paginates after cwd filtering and terminates the filtered cursor", () => {
	const foreign = Array.from({ length: 50 }, (_, index) => ({
		sessionId: `foreign-${index}`,
		locator: { repo: "/other" },
	}));
	const sessions = [
		...foreign,
		{
			sessionId: "workspace",
			locator: { repo: "/workspace" },
			title: "MCP inspection",
			endpointMtimeMs: 1_784_998_000_000,
		},
	];
	expect(paginateAcpSessions(sessions, "/workspace", 0)).toEqual({
		sessions: [
			{
				sessionId: "workspace",
				cwd: "/workspace",
				title: "MCP inspection",
				updatedAt: new Date(1_784_998_000_000).toISOString(),
			},
		],
		nextCursor: undefined,
	});
});

test("ACP final text resolution is exact, suffix-only, bounded, and Unicode-safe", () => {
	expect(resolveAcpFinalText("", "hello")).toEqual({
		kind: "emit",
		final: { text: "hello", truncated: false },
		text: "hello",
	});
	expect(resolveAcpFinalText("hello", "hello").kind).toBe("none");
	expect(resolveAcpFinalText("hello ", "hello world")).toEqual({
		kind: "emit",
		final: { text: "hello world", truncated: false },
		text: "world",
	});
	expect(resolveAcpFinalText("prefix hello world suffix", "hello world").kind).toBe("none");
	expect(resolveAcpFinalText("streamed", "different").kind).toBe("divergent");
	expect(resolveAcpFinalText("안녕 ", "안녕 세계")).toEqual({
		kind: "emit",
		final: { text: "안녕 세계", truncated: false },
		text: "세계",
	});

	const oversized = `${"a".repeat(ACP_FINAL_TEXT_LIMIT - 1)}😀tail`;
	const bounded = boundAcpFinalText(oversized);
	expect(bounded.truncated).toBe(true);
	expect(bounded.text.length).toBe(ACP_FINAL_TEXT_LIMIT - 1);
	expect(bounded.text.endsWith("\ud83d")).toBe(false);
	expect(acpFinalTextFromMessage({ content: [{ type: "text", text: "  exact\n" }] }).text).toBe("  exact\n");
});

test("ACP reports model presets when --mpreset is provided", () => {
	const state = acpSessionStateFromConfig(
		{
			result: {
				page: {
					items: [
						{
							mode: "plan",
							model: "openai-codex/gpt-5.6",
							modelPreset: "opus-codex",
							thinking: "high",
							steeringMode: "one-at-a-time",
						},
					],
				},
			},
		},
		{
			result: {
				page: {
					items: [
						{ id: "codex-medium", displayName: "Codex Medium", source: "builtin", available: true },
						{ id: "cursor-pro", displayName: "Cursor Pro", source: "builtin", available: false },
						{ id: "opus-codex", displayName: "Opus Codex", source: "configured", available: true },
					],
				},
			},
		},
		"opus-codex",
	);
	expect(state.modes.currentModeId).toBe("plan");
	expect(state.configOptions).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ id: "mode", category: "mode", currentValue: "plan" }),
			expect.objectContaining({
				id: "model",
				name: "Preset",
				category: "model",
				currentValue: "opus-codex",
				options: [
					{ value: "codex-medium", name: "Codex Medium" },
					{ value: "opus-codex", name: "Opus Codex" },
				],
			}),
			expect.objectContaining({ id: "thinking", category: "thought_level", currentValue: "high" }),
			expect.objectContaining({ id: "steeringMode", currentValue: "one-at-a-time" }),
		]),
	);
});
test("ACP filters the model catalog to active providers and keeps the current model", () => {
	const state = acpSessionStateFromConfig(
		{
			result: {
				page: {
					items: [
						{
							mode: "default",
							model: "opencode-go/deepseek-v4-flash",
							thinking: "high",
						},
					],
				},
			},
		},
		{
			result: {
				page: {
					items: [
						{ provider: "opencode-go", id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" },
						{ provider: "openai-codex", id: "gpt-5.6", name: "GPT 5.6" },
						{ provider: "anthropic", id: "claude-opus", name: "Claude Opus" },
					],
				},
			},
		},
		undefined,
		new Set(["opencode-go", "anthropic"]),
	);
	const modelOption = state.configOptions.find(option => option.id === "model");
	expect(modelOption?.options).toEqual([
		{ value: "opencode-go/deepseek-v4-flash", name: "DeepSeek V4 Flash" },
		{ value: "anthropic/claude-opus", name: "Claude Opus" },
	]);
	// Undefined active providers (older session host) keeps the full catalog.
	const unfiltered = acpSessionStateFromConfig(
		{ result: { page: { items: [{ model: "openai-codex/gpt-5.6" }] } } },
		{
			result: {
				page: {
					items: [{ provider: "openai-codex", id: "gpt-5.6", name: "GPT 5.6" }],
				},
			},
		},
	);
	const unfilteredModel = unfiltered.configOptions.find(option => option.id === "model");
	expect(unfilteredModel?.options).toEqual([{ value: "openai-codex/gpt-5.6", name: "GPT 5.6" }]);
});
test("ACP collects every active-provider page and filters by connection kind", async () => {
	const pages = [
		{
			id: "1",
			ok: true,
			page: {
				items: [
					{ provider: "opencode-go", connectionKind: "credential" },
					{ provider: "openai-codex", connectionKind: "none" },
					{ provider: "litellm", connectionKind: "credentialless" },
				],
				complete: false,
				continuationCursor: "cursor-2",
			},
		},
		{
			id: "2",
			ok: true,
			page: {
				items: [{ provider: "anthropic", connectionKind: "credential" }],
				complete: true,
			},
		},
	];
	const adapter = {
		query: async (_query: string, _input: unknown, cursor?: string) => (cursor === "cursor-2" ? pages[1] : pages[0]),
	} as never;
	await expect(collectActiveProviderIds(adapter)).resolves.toEqual(new Set(["opencode-go", "litellm", "anthropic"]));
});

test("ACP fails open only for an unsupported providers.list/active query", async () => {
	const unsupported = {
		query: async () => {
			throw Object.assign(new Error("not installed"), { code: "operation_not_session_owned" });
		},
	} as never;
	await expect(collectActiveProviderIds(unsupported)).resolves.toBeUndefined();
	const preQ29 = {
		query: async () => {
			throw Object.assign(new Error("unknown query"), { code: "invalid_request" });
		},
	} as never;
	await expect(collectActiveProviderIds(preQ29)).resolves.toBeUndefined();
	const operational = {
		query: async () => {
			throw Object.assign(new Error("timed out"), { code: "timeout" });
		},
	} as never;
	await expect(collectActiveProviderIds(operational)).rejects.toThrow("timed out");
});
test("ACP collects every model-catalog page before filtering", async () => {
	const pages = [
		{
			id: "1",
			ok: true,
			page: {
				items: [
					{ provider: "opencode-go", id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" },
					{ provider: "openai-codex", id: "gpt-5.6", name: "GPT 5.6" },
				],
				complete: false,
				continuationCursor: "cursor-2",
			},
		},
		{
			id: "2",
			ok: true,
			page: {
				items: [{ provider: "anthropic", id: "claude-opus", name: "Claude Opus" }],
				complete: true,
			},
		},
	];
	const adapter = {
		query: async (_query: string, _input: unknown, cursor?: string) => (cursor === "cursor-2" ? pages[1] : pages[0]),
	} as never;
	const catalog = await collectModelCatalog(adapter);
	const items = (catalog as { result: { page: { items: unknown[] } } }).result.page.items;
	expect(items.map(item => (item as { id: string }).id)).toEqual(["deepseek-v4-flash", "gpt-5.6", "claude-opus"]);
});

test("ACP hides unavailable presets but retains an unavailable active preset", () => {
	const profiles = {
		result: {
			page: {
				items: [
					{ id: "codex-medium", displayName: "Codex Medium", available: true },
					{ id: "cursor-pro", displayName: "Cursor Pro", available: false },
				],
			},
		},
	};
	const available = acpSessionStateFromConfig(
		{ result: { page: { items: [{ modelPreset: "codex-medium" }] } } },
		profiles,
		"codex-medium",
	);
	expect(available.configOptions.find(option => option.id === "model")?.options).toEqual([
		{ value: "codex-medium", name: "Codex Medium" },
	]);

	const activeUnavailable = acpSessionStateFromConfig(
		{ result: { page: { items: [{ modelPreset: "cursor-pro" }] } } },
		profiles,
		"cursor-pro",
	);
	expect(activeUnavailable.configOptions.find(option => option.id === "model")?.options).toEqual([
		{ value: "codex-medium", name: "Codex Medium" },
		{ value: "cursor-pro", name: "Cursor Pro" },
	]);
});

test("ACP exposes presets without misrepresenting an unprofiled current model", () => {
	const state = acpSessionStateFromConfig(
		{ result: { page: { items: [{ model: "openai-codex/gpt-5.6" }] } } },
		{
			result: {
				page: {
					items: [{ id: "codex-medium", displayName: "Codex Medium", source: "builtin" }],
				},
			},
		},
		"codex-medium",
	);
	expect(state.configOptions).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				id: "model",
				name: "Preset",
				currentValue: "__custom__",
				options: [
					{ value: "codex-medium", name: "Codex Medium" },
					{ value: "__custom__", name: "Custom (current model)" },
				],
			}),
		]),
	);
});

test("ACP reports the existing model list when --mpreset is absent", () => {
	const state = acpSessionStateFromConfig(
		{
			result: {
				page: {
					items: [
						{
							model: "openai-codex/gpt-5.6",
							modelPreset: "persisted-default",
							thinking: "high",
						},
					],
				},
			},
		},
		{
			result: {
				page: {
					items: [
						{ provider: "openai-codex", id: "gpt-5.6", name: "GPT-5.6" },
						{ provider: "anthropic", id: "claude-opus", name: "Claude Opus" },
					],
				},
			},
		},
	);
	expect(state.configOptions).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				id: "model",
				name: "Model",
				currentValue: "openai-codex/gpt-5.6",
				options: [
					{ value: "openai-codex/gpt-5.6", name: "GPT-5.6" },
					{ value: "anthropic/claude-opus", name: "Claude Opus" },
				],
			}),
		]),
	);
});

test("ACP applies explicit CLI model and thinking through canonical SDK controls", async () => {
	const calls: Array<{ operation: string; input?: Record<string, unknown> }> = [];
	await applyAcpStartupOptions(
		{
			setModel: async (id: string) => calls.push({ operation: "model.set", input: { id } }),
			control: async (operation: string, input: Record<string, unknown>) => calls.push({ operation, input }),
		} as never,
		{ modelId: "openai-codex/gpt-5.6", thinkingLevel: "high" },
	);
	expect(calls).toEqual([
		{ operation: "model.set", input: { id: "openai-codex/gpt-5.6" } },
		{ operation: "thinking.set", input: { level: "high" } },
	]);
});

test("ACP fails closed for local-only startup flags while translating model and thinking", () => {
	const parsed = parseArgs(["--model", "gpt-5.6", "--thinking", "high"]);
	expect(resolveAcpStartupOptions(parsed, { model, thinkingLevel: "high" as never })).toEqual({
		modelId: "openai-codex/gpt-5.6",
		thinkingLevel: "high",
	});

	const unsupported = parseArgs(["--model", "gpt-5.6", "--no-lsp", "initial prompt"]);
	expect(() => resolveAcpStartupOptions(unsupported, { model })).toThrow(
		"Unsupported under SDK-backed ACP: initial prompt, --no-lsp",
	);

	const unresolved = parseArgs(["--model", "extension-model"]);
	expect(() => resolveAcpStartupOptions(unresolved, { modelPattern: "extension-model" })).toThrow(
		"--model could not be resolved to a canonical model ID",
	);
});

test("ACP rejects unknown flags instead of silently ignoring them", () => {
	const parsed = parseArgs(["--mpreset", "codex-medium", "--mpresett"]);
	expect(parsed.unknownFlags).toEqual(new Map([["--mpresett", true]]));
	expect(() => resolveAcpStartupOptions(parsed, {})).toThrow("Unsupported under SDK-backed ACP: extension flags");
});

test("ACP option values cannot consume dash-prefixed unknown flags", () => {
	for (const args of [
		["--mpreset", "--mystery"],
		["--mpreset=--mystery"],
		["--tools", "--mystery"],
		["--model", "--mystery"],
	]) {
		expect(() => parseArgs(args)).toThrow(/requires a value/);
	}
});

test("inline opaque prompt values may start with a dash", () => {
	expect(parseArgs(["--system-prompt=-literal"]).systemPrompt).toBe("-literal");
	expect(parseArgs(["--append-system-prompt=-literal"]).appendSystemPrompt).toBe("-literal");
});
test("ACP rejects --mcp-config instead of ignoring it", () => {
	const parsed = parseArgs(["--mcp-config", "/tmp/gjc-mcp.json"]);
	expect(() => resolveAcpStartupOptions(parsed, {})).toThrow("Unsupported under SDK-backed ACP: --mcp-config");
});
test("ACP preserves --models rejection alongside --mcp-config", () => {
	const modelsOnly = parseArgs(["--models", "openai-codex/gpt-5.6"]);
	expect(() => resolveAcpStartupOptions(modelsOnly, {})).toThrow("Unsupported under SDK-backed ACP: --models");

	const both = parseArgs(["--models", "openai-codex/gpt-5.6", "--mcp-config", "/tmp/gjc-mcp.json"]);
	expect(() => resolveAcpStartupOptions(both, {})).toThrow("Unsupported under SDK-backed ACP: --models, --mcp-config");
});

test("ACP forwards a model preset through session creation but rejects durable default mutation", () => {
	const preset = parseArgs(["--mpreset", "codex-medium"]);
	expect(resolveAcpStartupOptions(preset, {})).toEqual({ modelPreset: "codex-medium" });

	const persistDefault = parseArgs(["--mpreset", "codex-medium", "--default"]);
	expect(() => resolveAcpStartupOptions(persistDefault, {})).toThrow("Unsupported under SDK-backed ACP: --default");
});
