import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type Hook, hookCapability } from "../src/capability/hook";
import { Settings } from "../src/config/settings";
import { getProviderInfo, loadCapability } from "../src/discovery";
import { EXTENSION_HANDLER_TIMEOUT_MS } from "../src/extensibility/extensions/runner";
import { discoverAndLoadHooks } from "../src/extensibility/hooks/loader";
import {
	CONVENTION_EVENT_CONTRACTS,
	EXTERNAL_EVENT_ALIASES,
	HOOK_EVENT_SCHEMAS,
	HookAuthority,
	HookEventKind,
	HookSourceConvention,
} from "../src/hooks/events";
import {
	HookDiagnosticCode,
	HookDiagnosticSeverity,
	normalizeDirectoryHook,
	normalizeHookBatch,
	normalizeInProcessHook,
	normalizeManagedJsonHook,
	normalizePluginHook,
	normalizeToolMatcher,
	resolveAuthority,
	resolveCanonicalKind,
	resolveExecutionContract,
} from "../src/hooks/normalize";
import { createAgentSession } from "../src/sdk";
import { SessionManager } from "../src/session/session-manager";

const directory = (convention: HookSourceConvention, phase: "pre" | "post", toolName = "edit") =>
	normalizeDirectoryHook({ convention, phase, toolName, source: `${convention}:${phase}:${toolName}` });

describe("cross-convention normalization", () => {
	it("normalizes native, Claude, and Codex directory metadata to one tool event while retaining provenance", () => {
		for (const convention of [
			HookSourceConvention.NativeGjc,
			HookSourceConvention.ClaudeCode,
			HookSourceConvention.Codex,
		] as const) {
			const result = directory(convention, "pre");
			expect(result.diagnostics).toEqual([]);
			expect(result.hook).toMatchObject({
				kind: HookEventKind.PreToolUse,
				runtimeEvent: "tool_call",
				authority: HookAuthority.InProcess,
				convention,
				toolName: "edit",
			});
		}
	});

	it("does not mislabel imported directory modules as command hooks", () => {
		for (const convention of [
			HookSourceConvention.NativeGjc,
			HookSourceConvention.ClaudeCode,
			HookSourceConvention.Codex,
		] as const) {
			expect(directory(convention, "post").hook?.authority).toBe(HookAuthority.InProcess);
		}
	});

	it("keeps Codex managed JSON command authority separate", () => {
		const result = normalizeManagedJsonHook({
			externalEvent: "UserPromptSubmit",
			command: "gjc codex-native-hook",
			source: "~/.codex/hooks.json:UserPromptSubmit",
		});
		expect(result.hook).toMatchObject({
			kind: HookEventKind.UserPromptSubmit,
			authority: HookAuthority.Command,
			runtimeEvent: "UserPromptSubmit",
		});
		expect(result.hook?.contract.ordering).toBe("external-runtime");
	});

	it("maps agent_end to Stop but rejects per-turn turn_end", () => {
		expect(normalizeInProcessHook({ registeredEvent: "agent_end", source: "hook.ts" }).hook?.kind).toBe(
			HookEventKind.Stop,
		);
		const turnEnd = normalizeInProcessHook({ registeredEvent: "turn_end", source: "hook.ts" });
		expect(turnEnd.hook).toBeNull();
		expect(turnEnd.diagnostics[0]?.code).toBe(HookDiagnosticCode.SemanticMismatch);
	});
});

describe("execution contracts reflect runtime differences", () => {
	it("records actual ExtensionRunner pre-tool fail-closed behavior", () => {
		const contract = resolveExecutionContract(HookSourceConvention.NativeGjc, HookEventKind.PreToolUse);
		expect(contract).toMatchObject({
			runtimeEvent: "tool_call",
			ordering: "sequential",
			awaitBehavior: "awaited",
			canCancel: true,
			timeoutMs: null,
			errorBehavior: "fail-closed",
			processAuthority: "hook-api",
			trustRequirement: "not-enforced",
			redaction: "none",
		});
	});

	it("records actual ExtensionRunner post-tool mutation and isolation behavior", () => {
		const contract = resolveExecutionContract(HookSourceConvention.ClaudeCode, HookEventKind.PostToolUse);
		expect(contract?.mutation).toEqual(["content", "details", "isError"]);
		expect(contract?.timeoutMs).toBe(EXTENSION_HANDLER_TIMEOUT_MS);
		expect(contract?.errorBehavior).toBe("isolate");
	});

	it("records constrained pre/post timeout and error differences", () => {
		const pre = resolveExecutionContract(HookSourceConvention.GjcPlugin, HookEventKind.PreToolUse);
		const post = resolveExecutionContract(HookSourceConvention.GjcPlugin, HookEventKind.PostToolUse);
		expect(pre).toMatchObject({
			authority: HookAuthority.Constrained,
			timeoutMs: null,
			errorBehavior: "fail-closed",
		});
		expect(post).toMatchObject({
			authority: HookAuthority.Constrained,
			timeoutMs: EXTENSION_HANDLER_TIMEOUT_MS,
			errorBehavior: "isolate",
		});
		expect(post?.mutation).toEqual(["content", "details", "isError"]);
	});

	it("does not invent GJC scheduling semantics for Codex-owned commands", () => {
		const contract = resolveExecutionContract(HookSourceConvention.CodexManagedJson, HookEventKind.UserPromptSubmit);
		expect(contract).toMatchObject({
			ordering: "external-runtime",
			awaitBehavior: "external-runtime",
			errorBehavior: "external-runtime",
			trustRequirement: "provider-owned",
			redaction: "provider-owned",
		});
	});

	it("covers every canonical schema without creating a parallel runtime union", () => {
		expect(Object.keys(HOOK_EVENT_SCHEMAS).sort()).toEqual(Object.values(HookEventKind).sort());
		for (const schema of Object.values(HOOK_EVENT_SCHEMAS)) {
			expect(schema.input.length).toBeGreaterThan(0);
			expect(schema.output.length).toBeGreaterThan(0);
		}
	});
});

describe("constrained plugin authority cannot expand through normalization", () => {
	it("maps tool_call/before to cancellable pre-tool constrained authority", () => {
		const result = normalizePluginHook({
			declaredEvent: "tool_call",
			target: "edit",
			phase: "before",
			plugin: "audit",
			source: "plugin:audit",
		});
		expect(result.diagnostics).toEqual([]);
		expect(result.hook).toMatchObject({
			kind: HookEventKind.PreToolUse,
			runtimeEvent: "tool_call",
			authority: HookAuthority.Constrained,
		});
	});

	it("maps tool_call/after to post-tool and removes blocking authority", () => {
		const result = normalizePluginHook({
			declaredEvent: "tool_call",
			target: "edit",
			phase: "after",
			plugin: "audit",
			source: "plugin:audit",
		});
		expect(result.hook).toMatchObject({
			kind: HookEventKind.PostToolUse,
			runtimeEvent: "tool_result",
			authority: HookAuthority.Constrained,
		});
		expect(result.hook?.contract.canCancel).toBe(false);
	});

	it("preserves compiler-valid constrained session lifecycle hooks", () => {
		for (const declaredEvent of ["session_start", "session_shutdown"] as const) {
			const result = normalizePluginHook({
				declaredEvent,
				plugin: "lifecycle",
				source: "plugin:lifecycle",
			});
			expect(result.diagnostics).toEqual([]);
			expect(result.hook).toMatchObject({
				runtimeEvent: declaredEvent,
				authority: HookAuthority.Constrained,
				toolName: "*",
			});
		}
	});

	it("accepts only compiler-valid tool_result/after", () => {
		const valid = normalizePluginHook({
			declaredEvent: "tool_result",
			phase: "after",
			plugin: "audit",
			source: "plugin:audit",
		});
		expect(valid.hook?.kind).toBe(HookEventKind.PostToolUse);

		for (const phase of [undefined, "before"] as const) {
			const invalid = normalizePluginHook({
				declaredEvent: "tool_result",
				phase,
				plugin: "audit",
				source: "plugin:audit",
			});
			expect(invalid.hook).toBeNull();
			expect(invalid.diagnostics[0]?.code).toBe(HookDiagnosticCode.InvalidPluginPhase);
		}
	});

	it("rejects unknown runtime phases instead of defaulting them to post-tool", () => {
		for (const declaredEvent of ["tool_call", "tool_result"]) {
			const result = normalizePluginHook({
				declaredEvent,
				target: "read",
				phase: "during",
				plugin: "malformed",
				source: "plugin:malformed",
			});
			expect(result.hook).toBeNull();
			expect(result.diagnostics[0]?.code).toBe(HookDiagnosticCode.InvalidPluginPhase);
		}
	});

	it("rejects target or phase fields on constrained lifecycle hooks", () => {
		for (const input of [{ target: "read" }, { phase: "before" }, { target: null }, { phase: null }]) {
			const result = normalizePluginHook({
				declaredEvent: "session_start",
				...input,
				plugin: "malformed",
				source: "plugin:malformed",
			});
			expect(result.hook).toBeNull();
			expect(result.diagnostics[0]?.code).toBe(HookDiagnosticCode.InvalidPluginPhase);
		}
	});

	it("rejects aliases and lifecycle names instead of resolving them for plugins", () => {
		for (const declaredEvent of [
			"pre_tool_use",
			"post_tool_use",
			"UserPromptSubmit",
			"Stop",
			"session_switch",
			"agent_end",
		]) {
			const result = normalizePluginHook({
				declaredEvent,
				target: "bash",
				phase: "before",
				plugin: "malicious",
				source: "plugin:malicious",
			});
			expect(result.hook).toBeNull();
			expect(result.diagnostics[0]?.code).toBe(HookDiagnosticCode.UnrecognizedPluginEvent);
		}
	});

	it("rejects malformed/defaulted tool_call descriptors", () => {
		for (const input of [
			{ target: undefined, phase: "before" as const },
			{ target: "read", phase: undefined },
			{ target: "", phase: "before" as const },
		]) {
			const result = normalizePluginHook({
				declaredEvent: "tool_call",
				...input,
				plugin: "malicious",
				source: "plugin:malicious",
			});
			expect(result.hook).toBeNull();
			expect(result.diagnostics[0]?.code).toBe(HookDiagnosticCode.InvalidPluginPhase);
		}
	});

	it("grants plugins only constrained authority", () => {
		for (const contract of Object.values(CONVENTION_EVENT_CONTRACTS[HookSourceConvention.GjcPlugin])) {
			expect(contract?.authority).toBe(HookAuthority.Constrained);
			expect(contract?.processAuthority).toBe("ambient-host");
		}
		expect(resolveAuthority(HookSourceConvention.GjcPlugin, HookEventKind.UserPromptSubmit)).toBeNull();
		expect(resolveAuthority(HookSourceConvention.GjcPlugin, HookEventKind.Stop)).toBeNull();
	});
});

describe("bounded diagnostics, matchers, provenance, duplicates, and ordering", () => {
	it("rejects unknown managed events and empty commands", () => {
		const unknown = normalizeManagedJsonHook({ externalEvent: "BeforeTool", command: "x", source: "hooks.json" });
		expect(unknown.hook).toBeNull();
		expect(unknown.diagnostics[0]).toMatchObject({
			severity: HookDiagnosticSeverity.Error,
			code: HookDiagnosticCode.UnsupportedConventionEvent,
		});

		const empty = normalizeManagedJsonHook({ externalEvent: "Stop", command: "  ", source: "hooks.json" });
		expect(empty.hook).toBeNull();
		expect(empty.diagnostics[0]?.code).toBe(HookDiagnosticCode.InvalidCommand);
	});

	it("rejects path-like, empty, dot, and NUL tool matchers while preserving case", () => {
		for (const matcher of ["", "  ", " read ", ".", "..", "../bash", "a/b", "a\\b", "a\0b", 42]) {
			expect(normalizeToolMatcher(matcher)).toBeNull();
		}
		expect(normalizeToolMatcher("Read")).toBe("Read");
		expect(normalizeToolMatcher("read")).toBe("read");
		expect(normalizeToolMatcher("*")).toBe("*");
	});

	it("retains source provenance and rejects blank sources", () => {
		const source = ".claude/hooks/pre/edit.ts";
		expect(directory(HookSourceConvention.ClaudeCode, "pre").hook?.source).toContain("claude-code");
		const invalid = normalizeDirectoryHook({
			convention: HookSourceConvention.ClaudeCode,
			phase: "pre",
			toolName: "edit",
			source: " ",
		});
		expect(invalid.hook).toBeNull();
		expect(invalid.diagnostics[0]?.code).toBe(HookDiagnosticCode.InvalidSource);
		expect(source.length).toBeGreaterThan(0);
	});

	it("batch normalization is stable first-wins and never drops rejection diagnostics", () => {
		const first = directory(HookSourceConvention.NativeGjc, "pre", "bash");
		const rejected = normalizeManagedJsonHook({ externalEvent: "Unknown", command: "x", source: "hooks.json" });
		const batch = normalizeHookBatch([
			first,
			rejected,
			first,
			directory(HookSourceConvention.NativeGjc, "post", "bash"),
		]);
		expect(batch.hooks.map(hook => hook.kind)).toEqual([HookEventKind.PreToolUse, HookEventKind.PostToolUse]);
		expect(batch.diagnostics.map(diagnostic => diagnostic.code)).toEqual([
			HookDiagnosticCode.UnsupportedConventionEvent,
			HookDiagnosticCode.DuplicateHook,
		]);
	});

	it("keeps aliases intentionally narrow", () => {
		expect(EXTERNAL_EVENT_ALIASES.agent_end).toBe(HookEventKind.Stop);
		expect(EXTERNAL_EVENT_ALIASES.turn_end).toBeUndefined();
		expect(resolveCanonicalKind("BeforeTool")).toBeNull();
		expect(resolveCanonicalKind("stop")).toBeNull();
		expect(
			normalizeManagedJsonHook({ externalEvent: "before_agent_start", command: "x", source: "hooks.json" }).hook,
		).toBeNull();
		expect(
			normalizeManagedJsonHook({ externalEvent: "agent_end", command: "x", source: "hooks.json" }).hook,
		).toBeNull();
		expect(normalizeInProcessHook({ registeredEvent: "UserPromptSubmit", source: "hook.ts" }).hook).toBeNull();
		expect(normalizeInProcessHook({ registeredEvent: "Stop", source: "hook.ts" }).hook).toBeNull();
	});
});

describe("production discovery integration", () => {
	it("discovers native hook files in deterministic byte order", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-native-hook-order-"));
		const hooksDir = path.join(root, ".gjc", "hooks", "pre");
		await fs.mkdir(hooksDir, { recursive: true });
		await Bun.write(path.join(hooksDir, "z-last.ts"), "export default () => undefined;\n");
		await Bun.write(path.join(hooksDir, "a-first.ts"), "export default () => undefined;\n");

		try {
			const result = await loadCapability<Hook>(hookCapability.id, { cwd: root, providers: ["native"] });
			expect(result.items.map(hook => hook.name)).toEqual(["a-first.ts", "z-last.ts"]);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("keeps Claude and Codex providers available for import diagnostics", async () => {
		expect(getProviderInfo("claude")?.capabilities).toEqual(["hooks"]);
		expect(getProviderInfo("codex")?.capabilities).toEqual(["hooks"]);

		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-hook-provider-diagnostics-"));
		await fs.mkdir(path.join(root, ".claude", "hooks", "pre"), { recursive: true });
		await fs.mkdir(path.join(root, ".codex", "hooks"), { recursive: true });
		await Bun.write(path.join(root, ".claude", "hooks", "pre", "read.ts"), "export default () => undefined;\n");
		await Bun.write(path.join(root, ".codex", "hooks", "pre-read.ts"), "export default () => undefined;\n");

		try {
			const claude = await loadCapability(hookCapability.id, { cwd: root, providers: ["claude"] });
			const codex = await loadCapability(hookCapability.id, { cwd: root, providers: ["codex"] });
			expect(claude.items.map(hook => hook._source.provider)).toEqual(["claude"]);
			expect(codex.items.map(hook => hook._source.provider)).toEqual(["codex"]);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("keeps foreign hook layouts import-only during runtime discovery", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-hook-normalization-"));
		const claudeHooksDir = path.join(root, ".claude", "hooks", "pre");
		const codexHooksDir = path.join(root, ".codex", "hooks");
		const claudeMarker = path.join(root, "claude-imported");
		const codexMarker = path.join(root, "codex-imported");
		await fs.mkdir(claudeHooksDir, { recursive: true });
		await fs.mkdir(codexHooksDir, { recursive: true });
		await Bun.write(
			path.join(claudeHooksDir, "read.ts"),
			`await Bun.write(${JSON.stringify(claudeMarker)}, "imported"); export default () => undefined;\n`,
		);
		await Bun.write(
			path.join(codexHooksDir, "pre-read.ts"),
			`await Bun.write(${JSON.stringify(codexMarker)}, "imported"); export default () => undefined;\n`,
		);

		try {
			const result = await discoverAndLoadHooks([], root);
			expect(result.hooks).toEqual([]);
			expect(result.errors).toEqual([]);
			expect(await Bun.file(claudeMarker).exists()).toBe(false);
			expect(await Bun.file(codexMarker).exists()).toBe(false);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("loads native directory hooks into session ExtensionRunner and ignores foreign duplicates", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-hook-session-"));
		const hooksDir = path.join(root, ".gjc", "hooks", "pre");
		const foreignHooksDir = path.join(root, ".codex", "hooks");
		const executionMarker = path.join(root, "executed");
		const foreignExecutionMarker = path.join(root, "foreign-executed");
		const rejectedImportMarker = path.join(root, "rejected-imported");
		const throwingHookPath = path.join(hooksDir, "bash.ts");
		await fs.mkdir(hooksDir, { recursive: true });
		await fs.mkdir(foreignHooksDir, { recursive: true });
		await Bun.write(
			path.join(hooksDir, "read.ts"),
			`export default (api) => api.on("tool_call", async (_event, ctx) => { await Bun.write(${JSON.stringify(executionMarker)}, ctx.hasQueuedMessages() ? "queued" : "read"); });\n`,
		);
		await Bun.write(
			path.join(foreignHooksDir, "pre-read.ts"),
			`export default (api) => api.on("tool_call", async () => { await Bun.write(${JSON.stringify(foreignExecutionMarker)}, "foreign"); });\n`,
		);
		await Bun.write(
			throwingHookPath,
			'export default (api) => api.on("tool_call", () => { throw new Error("hook-boom"); });\n',
		);
		await Bun.write(
			path.join(foreignHooksDir, "unprefixed.ts"),
			`await Bun.write(${JSON.stringify(rejectedImportMarker)}, "imported"); export default () => undefined;\n`,
		);

		try {
			const { session } = await createAgentSession({
				cwd: root,
				agentDir: root,
				settings: Settings.isolated(),
				sessionManager: SessionManager.inMemory(root),
				skills: [],
				rules: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				toolNames: ["__none__"],
			});
			try {
				expect(session.extensionRunner?.hasHandlers("tool_call")).toBe(true);
				let observedErrorPath: string | undefined;
				session.extensionRunner?.onError(error => {
					if (error.error === "hook-boom") observedErrorPath = error.extensionPath;
				});
				await session.extensionRunner?.emitToolCall({
					type: "tool_call",
					toolName: "write",
					toolCallId: "wrong-tool",
					input: {},
				});
				expect(await Bun.file(executionMarker).exists()).toBe(false);
				await session.extensionRunner?.emitToolCall({
					type: "tool_call",
					toolName: "read",
					toolCallId: "exact-tool",
					input: {},
				});
				expect(await Bun.file(executionMarker).text()).toBe("read");
				expect(await Bun.file(foreignExecutionMarker).exists()).toBe(false);
				const blocked = await session.extensionRunner?.emitToolCall({
					type: "tool_call",
					toolName: "bash",
					toolCallId: "throwing-hook",
					input: {},
				});
				expect(blocked).toMatchObject({ block: true });
				expect(blocked?.reason).toContain(`hook:${throwingHookPath}`);
				expect(observedErrorPath).toBe(`hook:${throwingHookPath}`);
				expect(await Bun.file(rejectedImportMarker).exists()).toBe(false);
			} finally {
				await session.dispose();
			}
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("loads explicit configured hook paths into session ExtensionRunner without foreign authority", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-hook-configured-"));
		const configuredHook = path.join(root, "configured", "hook.ts");
		const marker = path.join(root, "configured-executed");
		const foreignMarker = path.join(root, "foreign-executed");
		await fs.mkdir(path.dirname(configuredHook), { recursive: true });
		await fs.mkdir(path.join(root, ".claude", "hooks", "pre"), { recursive: true });
		await Bun.write(
			configuredHook,
			`export default (api) => api.on("tool_call", async () => { await Bun.write(${JSON.stringify(marker)}, "executed"); });\n`,
		);
		await Bun.write(
			path.join(root, ".claude", "hooks", "pre", "read.ts"),
			`await Bun.write(${JSON.stringify(foreignMarker)}, "imported"); export default () => undefined;\n`,
		);

		try {
			const { session } = await createAgentSession({
				cwd: root,
				agentDir: root,
				settings: Settings.isolated(),
				sessionManager: SessionManager.inMemory(root),
				hookPaths: [path.relative(root, configuredHook)],
				skills: [],
				rules: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				toolNames: ["__none__"],
			});
			try {
				await session.extensionRunner?.emitToolCall({
					type: "tool_call",
					toolName: "read",
					toolCallId: "configured-hook",
					input: {},
				});
			} finally {
				await session.dispose();
			}
			expect(await Bun.file(marker).text()).toBe("executed");
			expect(await Bun.file(foreignMarker).exists()).toBe(false);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
