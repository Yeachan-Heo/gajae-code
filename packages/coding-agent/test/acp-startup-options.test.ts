import { expect, test } from "bun:test";
import * as path from "node:path";
import type { AgentSideConnection } from "@agentclientprotocol/sdk";
import { ThinkingLevel } from "@gajae-code/agent-core";
import { type CliConfig, CliParseError } from "@gajae-code/utils/cli";
import { parseArgs } from "../src/cli/args";
import Acp from "../src/commands/acp";
import { resolveAcpStartupOptions } from "../src/main";
import {
	acpProviderRegistrations,
	acpSessionStateFromConfig,
	applyAcpPermissionMode,
	applyAcpStartupOptions,
	collectActiveProviderIds,
	collectModelCatalogAndActiveProviders,
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

const TEST_CONFIG: CliConfig = {
	bin: "gjc",
	version: "0.0.0-test",
	commands: new Map(),
};

async function runAcpCli(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn({
		cmd: [process.execPath, path.join(import.meta.dir, "../src/cli.ts"), "acp", ...args],
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	return { exitCode, stdout, stderr };
}

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
		locator: { cwd: "/other", worktreeRoot: null, stateRoot: "/other/.gjc/state" },
	}));
	const sessions = [
		...foreign,
		{
			sessionId: "workspace",
			locator: { cwd: "/workspace", worktreeRoot: null, stateRoot: "/workspace/.gjc/state" },
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
	const catalogPages = [
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
		query: async (query: string, _input: unknown, cursor?: string) =>
			query === "providers.list/active"
				? {
						id: "p",
						ok: true,
						page: { items: [{ provider: "anthropic", connectionKind: "credential" }], complete: true },
					}
				: cursor === "cursor-2"
					? catalogPages[1]
					: catalogPages[0],
	} as never;
	const { modelCatalog, activeProviders } = await collectModelCatalogAndActiveProviders(adapter);
	const items = (modelCatalog as { result: { page: { items: unknown[] } } }).result.page.items;
	expect(items.map(item => (item as { id: string }).id)).toEqual(["deepseek-v4-flash", "gpt-5.6", "claude-opus"]);
	expect(activeProviders).toEqual(new Set(["anthropic"]));
});

test("ACP starts providers.list/active only after the first catalog page resolves", async () => {
	const events: string[] = [];
	const pageTwo = Promise.withResolvers<{ id: string; ok: boolean; page: { items: unknown[]; complete: boolean } }>();
	const providersStarted = Promise.withResolvers<void>();
	let pageTwoBlocked = false;
	const adapter = {
		query: async (query: string, _input: unknown, cursor?: string) => {
			if (query === "models.list/current" && cursor === undefined) {
				events.push("catalog-page-1:start");
				await Bun.sleep(10);
				events.push("catalog-page-1:end");
				return { id: "1", ok: true, page: { items: [], complete: false, continuationCursor: "cursor-2" } };
			}
			if (query === "models.list/current") {
				events.push("catalog-page-2:start");
				pageTwoBlocked = true;
				const response = await pageTwo.promise;
				pageTwoBlocked = false;
				events.push("catalog-page-2:end");
				return response;
			}
			events.push("providers:start");
			providersStarted.resolve();
			events.push("providers:end");
			return { id: "3", ok: true, page: { items: [], complete: true } };
		},
	} as never;
	const catalog = collectModelCatalogAndActiveProviders(adapter);
	await providersStarted.promise;
	// The provider walk must not begin before the first catalog page has fully
	// resolved (credential side effects finalize there), but it must overlap the
	// remaining catalog pages instead of waiting for the whole walk.
	expect(events.indexOf("providers:start")).toBeGreaterThan(events.indexOf("catalog-page-1:end"));
	expect(events.indexOf("catalog-page-2:start")).toBeGreaterThanOrEqual(events.indexOf("catalog-page-1:end"));
	expect(pageTwoBlocked).toBe(true);
	pageTwo.resolve({ id: "2", ok: true, page: { items: [], complete: true } });
	await catalog;
	expect(events).toContain("catalog-page-2:end");
	expect(events).toContain("providers:end");
});

test("ACP combined catalog walk keeps the unsupported-host fallback", async () => {
	const catalogPage = {
		id: "1",
		ok: true,
		page: { items: [{ provider: "openai-codex", id: "gpt-5.6", name: "GPT 5.6" }], complete: true },
	};
	const unsupported = {
		query: async (query: string) => {
			if (query === "providers.list/active")
				throw Object.assign(new Error("not installed"), { code: "operation_not_session_owned" });
			return catalogPage;
		},
	} as never;
	const { modelCatalog, activeProviders } = await collectModelCatalogAndActiveProviders(unsupported);
	expect(activeProviders).toBeUndefined();
	const items = (modelCatalog as { result: { page: { items: unknown[] } } }).result.page.items;
	expect(items).toHaveLength(1);
	// Operational provider-walk failures still fail closed.
	const operational = {
		query: async (query: string) => {
			if (query === "providers.list/active") throw Object.assign(new Error("timed out"), { code: "timeout" });
			return catalogPage;
		},
	} as never;
	await expect(collectModelCatalogAndActiveProviders(operational)).rejects.toThrow("timed out");
});

test("ACP provider snapshot observes credential state finalized by the first catalog page", async () => {
	// Controlled OAuth-refresh interleaving: assembling the first catalog page
	// disables a provider whose credential turned out to be invalid (the host-side
	// Q10 side effect). The provider walk must observe that finalized state, never
	// a pre-refresh snapshot, no matter how the two walks interleave afterwards.
	const usableProviders = new Set(["opencode-go", "openai-codex"]);
	let providerCalls = 0;
	const adapter = {
		query: async (query: string, _input: unknown, cursor?: string) => {
			if (query === "models.list/current" && cursor === undefined) {
				await Bun.sleep(5);
				// Host-side refresh finalizes mid-page: openai-codex is disabled.
				usableProviders.delete("openai-codex");
				return {
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
				};
			}
			if (query === "models.list/current") {
				await Bun.sleep(5);
				return { id: "2", ok: true, page: { items: [], complete: true } };
			}
			providerCalls += 1;
			return {
				id: "3",
				ok: true,
				page: {
					items: [...usableProviders].map(provider => ({ provider, connectionKind: "credential" })),
					complete: true,
				},
			};
		},
	} as never;
	const { activeProviders } = await collectModelCatalogAndActiveProviders(adapter);
	expect(providerCalls).toBe(1);
	expect(activeProviders).toEqual(new Set(["opencode-go"]));
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
	const thinkingOff = parseArgs(["--thinking=off"]);
	expect(resolveAcpStartupOptions(thinkingOff, { thinkingLevel: ThinkingLevel.Off })).toEqual({
		thinkingLevel: "off",
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
	const parsed = parseArgs(["--mpreset", "codex-medium", "--mpresett"], "acp");
	expect(parsed.unknownFlags).toEqual(new Map([["--mpresett", true]]));
	expect(() => resolveAcpStartupOptions(parsed, {})).toThrow(
		"Unsupported under SDK-backed ACP: unknown flags: --mpresett",
	);
});

test("ACP accepts --no-extensions and still names every unsupported discovery flag", () => {
	const accepted = parseArgs(["--no-extensions"], "acp");
	expect(accepted.unknownFlags.size).toBe(0);
	expect(accepted.noExtensions).toBe(true);
	expect(() => resolveAcpStartupOptions(accepted, {})).not.toThrow();

	for (const [args, expectedFlag] of [
		[["--no-skills"], "--no-skills"],
		[["--skills", "git-*,docker"], "--skills"],
		[["--skills", ",,"], "--skills"],
		[["--skills", "git-*", "--skills", ",,"], "--skills"],
	] as const) {
		const parsed = parseArgs([...args], "acp");
		expect(parsed.unknownFlags.size).toBe(0);
		expect(() => resolveAcpStartupOptions(parsed, {})).toThrow(`Unsupported under SDK-backed ACP: ${expectedFlag}`);
	}
});

test("ACP rejects --tools by presence so an emptied filter cannot disable every tool", () => {
	for (const args of [
		["--tools", "read,bash"],
		["--tools", ",,"],
		["--tools", ","],
		["--tools", "read", "--tools", ",,"],
	] as const) {
		const parsed = parseArgs([...args]);
		expect(parsed.unknownFlags.size).toBe(0);
		expect(() => resolveAcpStartupOptions(parsed, {})).toThrow("Unsupported under SDK-backed ACP: --tools");
	}

	// A comma-only filter normalizes to [], which is truthy, so a bypass here would
	// reach `options.toolNames = parsed.tools` and start ACP with no tools at all.
	expect(parseArgs(["--tools", ",,"]).tools).toEqual([]);
});

test("ACP rejects registered extension-loading flags by name", () => {
	for (const args of [
		["--extension", "/tmp/a.ts"],
		["-e", "/tmp/a.ts"],
	] as const) {
		expect(() => resolveAcpStartupOptions(parseArgs([...args], "acp"), {})).toThrow(
			"Unsupported under SDK-backed ACP: --extension",
		);
	}
	expect(() => resolveAcpStartupOptions(parseArgs(["--hook", "/tmp/a.ts"], "acp"), {})).toThrow(
		"Unsupported under SDK-backed ACP: --hook. Use ACP session configuration",
	);
});

test("--default without --mpreset is a typed CLI parse error", () => {
	expect(() => parseArgs(["--default"])).toThrow(CliParseError);
	expect(() => parseArgs(["--default"])).toThrow("--default requires --mpreset <name>");
});

test("ACP command maps invalid argv to typed CLI usage errors", async () => {
	await expect(new Acp(["--mpresett"], TEST_CONFIG).run()).rejects.toBeInstanceOf(CliParseError);
	await expect(new Acp(["--mpresett"], TEST_CONFIG).run()).rejects.toThrow("Unknown ACP option: --mpresett");

	for (const modeArgs of [
		["--acp-terminal-auth", "--mode", "text"],
		["--acp-terminal-auth", "--mode=text"],
	]) {
		await expect(new Acp(modeArgs, TEST_CONFIG).run()).rejects.toBeInstanceOf(CliParseError);
		await expect(new Acp(modeArgs, TEST_CONFIG).run()).rejects.toThrow(
			"--acp-terminal-auth only supports --mode acp",
		);
	}
	await expect(new Acp(["--acp-terminal-auth", "--no-extensions"], TEST_CONFIG).run()).rejects.toThrow(
		"Unknown option: --no-extensions",
	);
});

test("ACP command renders usage and exits nonzero for invalid argv", async () => {
	for (const [args, message] of [
		[["--mpresett"], "Unknown ACP option: --mpresett"],
		[["--default"], "--default requires --mpreset <name>"],
		[["--acp-terminal-auth", "--mode", "text"], "--acp-terminal-auth only supports --mode acp"],
	] as const) {
		const result = await runAcpCli([...args]);
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain(message);
		expect(result.stdout).toContain("USAGE");
	}
}, 15_000);

test("ACP option values cannot consume dash-prefixed unknown flags", () => {
	for (const args of [
		["--mpreset", "--mystery"],
		["--mpreset=--mystery"],
		["--tools", "--mystery"],
		["--model", "--mystery"],
		["--system-prompt", "--mystery"],
		["--append-system-prompt", "--mystery"],
	]) {
		expect(() => parseArgs(args)).toThrow(/requires a value/);
	}
});

test("opaque prompt values may start with a dash in explicit or separated form", () => {
	expect(parseArgs(["--system-prompt=-literal"]).systemPrompt).toBe("-literal");
	expect(parseArgs(["--append-system-prompt=-literal"]).appendSystemPrompt).toBe("-literal");
	expect(parseArgs(["--system-prompt", "- Be concise"]).systemPrompt).toBe("- Be concise");
	expect(parseArgs(["--append-system-prompt", "- Be concise"]).appendSystemPrompt).toBe("- Be concise");
});
test("ACP rejects --mcp-config instead of ignoring it", () => {
	const parsed = parseArgs(["--mcp-config", "/tmp/gjc-mcp.json"]);
	expect(() => resolveAcpStartupOptions(parsed, {})).toThrow("Unsupported under SDK-backed ACP: --mcp-config");
});
test("ACP rejects --no-mcp instead of ignoring it", () => {
	const parsed = parseArgs(["--no-mcp"]);
	expect(() => resolveAcpStartupOptions(parsed, {})).toThrow("Unsupported under SDK-backed ACP: --no-mcp");
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
