import { expect, test } from "bun:test";
import * as path from "node:path";
import { parseArgs } from "../src/cli/args";
import { resolveAcpStartupOptions } from "../src/main";
import {
	acpProviderRegistrations,
	acpSessionStateFromConfig,
	applyAcpPermissionMode,
	applyAcpStartupOptions,
	matchesAbsoluteAcpCwd,
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

test("ACP CWD matching requires fully-qualified absolute paths in each path flavor", () => {
	const cases: Array<{
		flavor: "posix" | "win32";
		locator: string;
		cwd: string | undefined;
		matches: boolean;
	}> = [
		{ flavor: "posix", locator: "/workspace/.", cwd: "/workspace", matches: true },
		{ flavor: "posix", locator: "workspace", cwd: "/workspace", matches: false },
		{ flavor: "posix", locator: "./workspace", cwd: "/workspace", matches: false },
		{ flavor: "posix", locator: "", cwd: "/workspace", matches: false },
		{ flavor: "posix", locator: "unknown", cwd: "/workspace", matches: false },
		{ flavor: "posix", locator: String.raw`C:\workspace`, cwd: "/workspace", matches: false },
		{ flavor: "posix", locator: "/Workspace", cwd: "/workspace", matches: false },
		{ flavor: "win32", locator: String.raw`C:\workspace\.`, cwd: String.raw`C:\workspace`, matches: true },
		{ flavor: "win32", locator: "C:/workspace", cwd: String.raw`C:\workspace`, matches: true },
		{
			flavor: "win32",
			locator: String.raw`\\server\share\workspace\.`,
			cwd: String.raw`\\server\share\workspace`,
			matches: true,
		},
		{
			flavor: "win32",
			locator: "//server/share/workspace/.",
			cwd: String.raw`\\server\share\workspace`,
			matches: true,
		},
		{ flavor: "win32", locator: "C:workspace", cwd: String.raw`C:\workspace`, matches: false },
		{ flavor: "win32", locator: String.raw`\workspace`, cwd: String.raw`C:\workspace`, matches: false },
		{ flavor: "win32", locator: "unknown", cwd: String.raw`C:\workspace`, matches: false },
		{ flavor: "win32", locator: String.raw`C:\Workspace`, cwd: String.raw`C:\workspace`, matches: false },
	];
	for (const entry of cases) expect(matchesAbsoluteAcpCwd(entry.locator, entry.cwd, entry.flavor)).toBe(entry.matches);
});

test("ACP paginates only absolute path-equivalent workspace locators", () => {
	const cwd = path.resolve(path.sep, "workspace");
	const equivalentCwd = `${cwd}${path.sep}.`;
	const malformed = ["workspace", "./workspace", "", "unknown", "C:workspace"].map((repo, index) => ({
		sessionId: `malformed-${index}`,
		locator: { repo },
	}));
	expect(paginateAcpSessions(malformed, undefined, 0)).toEqual({ sessions: [], nextCursor: undefined });
	const foreign = Array.from({ length: 50 }, (_, index) => ({
		sessionId: `foreign-${index}`,
		locator: { repo: path.resolve(path.sep, "other") },
	}));
	const matching = Array.from({ length: 51 }, (_, index) => ({
		sessionId: `workspace-${index}`,
		locator: { repo: index % 2 === 0 ? cwd : equivalentCwd },
	}));
	const listed = [...malformed, ...foreign, ...matching];

	const first = paginateAcpSessions(listed, cwd, 0);
	expect(first.sessions.map(session => session.sessionId)).toEqual(
		Array.from({ length: 50 }, (_, index) => `workspace-${index}`),
	);
	expect(first.nextCursor).toBe("50");
	expect(paginateAcpSessions(listed, cwd, 50)).toEqual({
		sessions: [{ sessionId: "workspace-50", cwd, title: "workspace-50" }],
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

test("ACP forwards a model preset through session creation but rejects durable default mutation", () => {
	const preset = parseArgs(["--mpreset", "codex-medium"]);
	expect(resolveAcpStartupOptions(preset, {})).toEqual({ modelPreset: "codex-medium" });

	const persistDefault = parseArgs(["--mpreset", "codex-medium", "--default"]);
	expect(() => resolveAcpStartupOptions(persistDefault, {})).toThrow("Unsupported under SDK-backed ACP: --default");
});
