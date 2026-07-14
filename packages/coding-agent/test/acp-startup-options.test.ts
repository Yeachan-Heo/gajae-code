import { expect, test } from "bun:test";
import { parseArgs } from "../src/cli/args";
import { resolveAcpStartupOptions } from "../src/main";
import {
	acpProviderRegistrations,
	acpSessionStateFromConfig,
	applyAcpPermissionMode,
	applyAcpStartupOptions,
	paginateAcpSessions,
} from "../src/modes/acp/acp-agent";
import type { CreateAgentSessionOptions } from "../src/sdk";

const model = { provider: "openai-codex", id: "gpt-5.6" } as CreateAgentSessionOptions["model"];

function providerNames(capabilities: unknown, env: NodeJS.ProcessEnv = {}): string[] {
	return acpProviderRegistrations(capabilities as never, env).map(provider => provider.capability);
}

test("ACP registers a permission provider only for prompt handling", () => {
	expect(providerNames({ _meta: { gjc: { permissionHandling: "prompt" } } })).toContain("permission");
	expect(providerNames({ _meta: { gjc: { permissionHandling: "auto" } } })).not.toContain("permission");
	expect(providerNames({ _meta: { gjc: { permissionHandling: "always-allow" } } })).not.toContain("permission");
	expect(providerNames(undefined, { GJC_ACP_PERMISSION_MODE: "prompt" })).toContain("permission");
	expect(providerNames(undefined, { GJC_ACP_PERMISSION_MODE: "auto" })).not.toContain("permission");
	expect(providerNames({ _meta: { gjc: { permissionHandling: "invalid" } } })).toContain("permission");
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
	const sessions = [...foreign, { sessionId: "workspace", locator: { repo: "/workspace" } }];
	expect(paginateAcpSessions(sessions, "/workspace", 0)).toEqual({
		sessions: [{ sessionId: "workspace", cwd: "/workspace", title: "workspace" }],
		nextCursor: undefined,
	});
});

test("ACP reports live SDK config values and mode rather than hard-coded defaults", () => {
	const state = acpSessionStateFromConfig({
		result: {
			page: {
				items: [
					{
						mode: "plan",
						model: "openai-codex/gpt-5.6",
						thinking: "high",
						steeringMode: "one-at-a-time",
					},
				],
			},
		},
	});
	expect(state.modes.currentModeId).toBe("plan");
	expect(state.configOptions).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ id: "mode", currentValue: "plan" }),
			expect.objectContaining({ id: "model", currentValue: "openai-codex/gpt-5.6" }),
			expect.objectContaining({ id: "thinking", currentValue: "high" }),
			expect.objectContaining({ id: "steeringMode", currentValue: "one-at-a-time" }),
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
