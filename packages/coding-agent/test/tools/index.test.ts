import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";

import { type SettingPath, Settings } from "@gajae-code/coding-agent/config/settings";
import {
	BUILTIN_TOOLS,
	createTools,
	HIDDEN_TOOLS,
	parseGjcPy,
	resolveEvalBackends,
	resolveEvalBackendsFromEnv,
	resolvePythonIntegrationGate,
	resolvePythonIpcTrace,
	resolvePythonSkipCheck,
	type ToolSession,
} from "@gajae-code/coding-agent/tools";

const PY_ENV_KEYS = [
	"GJC_PY",
	"PI_PY",
	"PI_JS",
	"GJC_PYTHON_SKIP_CHECK",
	"PI_PYTHON_SKIP_CHECK",
	"GJC_PYTHON_IPC_TRACE",
	"PI_PYTHON_IPC_TRACE",
	"GJC_PYTHON_INTEGRATION",
	"PI_PYTHON_INTEGRATION",
] as const;

function snapshotPyEnv(): Map<string, string | undefined> {
	return new Map(PY_ENV_KEYS.map(key => [key, Bun.env[key]]));
}

function restorePyEnv(snapshot: Map<string, string | undefined>): void {
	for (const key of PY_ENV_KEYS) {
		const value = snapshot.get(key);
		if (value === undefined) delete Bun.env[key];
		else Bun.env[key] = value;
	}
}

let testPyEnv = new Map<string, string | undefined>();
beforeEach(() => {
	testPyEnv = snapshotPyEnv();
	clearPyEnvKeys();
	Bun.env.PI_PYTHON_SKIP_CHECK = "1";
});
afterEach(() => restorePyEnv(testPyEnv));

function createTestSession(overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd: "/tmp/test",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		...overrides,
	};
}

function createSettingsWithOverrides(overrides: Partial<Record<SettingPath, unknown>> = {}): Settings {
	return Settings.isolated({
		"lsp.formatOnWrite": true,
		"bashInterceptor.enabled": true,
		...overrides,
	});
}

function createActiveGoalState() {
	return {
		enabled: true,
		mode: "active" as const,
		goal: {
			id: "goal-1",
			objective: "Ship the release",
			status: "active" as const,
			tokensUsed: 5,
			timeUsedSeconds: 0,
			createdAt: 1,
			updatedAt: 1,
		},
	};
}

function createDiscoverySessionHooks(): Partial<ToolSession> {
	const selected: string[] = [];
	return {
		isToolDiscoveryEnabled: () => true,
		getDiscoverableTools: () => [],
		getSelectedDiscoveredToolNames: () => [...selected],
		activateDiscoveredTools: async toolNames => {
			const activated: string[] = [];
			for (const name of toolNames) {
				if (!selected.includes(name)) {
					selected.push(name);
					activated.push(name);
				}
			}
			return activated;
		},
	};
}

describe("createTools", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("creates all builtin tools by default", async () => {
		const session = createTestSession();
		const tools = await createTools(session);
		const names = tools.map(t => t.name);

		// Core tools should always be present
		expect(names).toContain("eval");
		expect(names).toContain("bash");
		expect(names).toContain("read");
		expect(names).toContain("edit");
		expect(names).toContain("write");
		expect(names).toContain("search");
		expect(names).toContain("find");
		expect(names).toContain("lsp");
		expect(names).toContain("task");
		expect(names).toContain("todo_write");
		expect(names).toContain("web_search");
		expect(names).toContain("resolve");
		expect(names).toContain("goal");
		expect(names).not.toContain("fetch");
		expect(names).not.toContain("vim");
	});

	it("keeps edit visible when vim edit mode is active", async () => {
		const session = createTestSession({
			settings: createSettingsWithOverrides({
				"edit.mode": "vim",
			}),
		});
		const tools = await createTools(session);
		const names = tools.map(t => t.name);

		expect(names).toContain("edit");
		expect(names).not.toContain("vim");
	});

	it("includes bash and eval when both eval backends are allowed", async () => {
		const session = createTestSession({
			settings: createSettingsWithOverrides({
				"eval.py": true,
				"eval.js": true,
			}),
		});
		const tools = await createTools(session);
		const names = tools.map(t => t.name);

		expect(names).toContain("eval");
		expect(names).toContain("bash");
	});

	it("still exposes eval when only the js backend is allowed", async () => {
		const session = createTestSession({
			settings: createSettingsWithOverrides({
				"eval.py": false,
				"eval.js": true,
			}),
		});
		const tools = await createTools(session);
		const names = tools.map(t => t.name);

		expect(names).toContain("bash");
		expect(names).toContain("eval");
	});

	it("still exposes eval when python kernel is unavailable (dispatches to js)", async () => {
		const session = createTestSession();
		vi.spyOn(
			await import("@gajae-code/coding-agent/eval/py/kernel"),
			"checkPythonKernelAvailability",
		).mockResolvedValue({
			ok: false,
			reason: "missing python",
		});
		const tools = await createTools(session, ["eval"]);
		const names = tools.map(t => t.name);

		expect(names).toContain("eval");
		expect(names).toContain("resolve");
	});

	it("excludes lsp tool when session disables LSP", async () => {
		const session = createTestSession({ enableLsp: false });
		const tools = await createTools(session, ["read", "lsp", "write"]);
		const names = tools.map(t => t.name);

		expect(names).toEqual(["read", "write", "goal", "resolve"]);
	});

	it("excludes lsp tool when disabled", async () => {
		const session = createTestSession({ enableLsp: false });
		const tools = await createTools(session);
		const names = tools.map(t => t.name);

		expect(names).not.toContain("lsp");
	});

	it("respects requested tool subset", async () => {
		const session = createTestSession();
		const tools = await createTools(session, ["read", "write"]);
		const names = tools.map(t => t.name);

		expect(names).toEqual(["read", "write", "goal", "resolve"]);
	});

	it("ignores vim as an unknown requested tool even when vim edit mode is active", async () => {
		const session = createTestSession({
			settings: createSettingsWithOverrides({
				"edit.mode": "vim",
			}),
		});
		const tools = await createTools(session, ["read", "vim"]);
		const names = tools.map(t => t.name);

		expect(names).toEqual(["read", "goal", "resolve"]);
	});

	it("lowercases requested tool subset", async () => {
		const session = createTestSession();
		const tools = await createTools(session, ["Read", "Write"]);
		const names = tools.map(t => t.name);

		expect(names).toEqual(["read", "write", "goal", "resolve"]);
	});

	it("includes hidden tools when explicitly requested", async () => {
		const session = createTestSession();
		const tools = await createTools(session, ["report_finding"]);
		const names = tools.map(t => t.name);

		expect(names).toEqual(["report_finding", "goal", "resolve"]);
	});

	it("includes yield tool when required", async () => {
		const session = createTestSession({ requireYieldTool: true });
		const tools = await createTools(session);
		const names = tools.map(t => t.name);

		expect(names).toContain("yield");
	});

	it("excludes ask tool when hasUI is false", async () => {
		const session = createTestSession({ hasUI: false });
		const tools = await createTools(session);
		const names = tools.map(t => t.name);

		expect(names).not.toContain("ask");
	});

	it("includes ask tool when hasUI is true", async () => {
		const session = createTestSession({ hasUI: true });
		const tools = await createTools(session);
		const names = tools.map(t => t.name);

		expect(names).toContain("ask");
	});

	it("filters disabled builtin tools by settings", async () => {
		const session = createTestSession({
			settings: createSettingsWithOverrides({
				"find.enabled": false,
				"search.enabled": false,
				"astGrep.enabled": false,
				"astEdit.enabled": false,
				"renderMermaid.enabled": false,
				"web_search.enabled": false,
				"browser.enabled": false,
				"calc.enabled": false,
			}),
		});
		const tools = await createTools(session);
		const names = tools.map(t => t.name);

		expect(names).not.toContain("find");
		expect(names).not.toContain("search");
		expect(names).not.toContain("ast_grep");
		expect(names).not.toContain("ast_edit");
		expect(names).not.toContain("render_mermaid");
		expect(names).not.toContain("web_search");
		expect(names).not.toContain("browser");
		expect(names).not.toContain("calc");
	});

	it("always includes resolve regardless of plan-mode setting", async () => {
		const session = createTestSession({
			settings: createSettingsWithOverrides({
				"plan.enabled": false,
			}),
		});

		const defaultTools = await createTools(session);
		expect(defaultTools.map(t => t.name)).toContain("resolve");
		expect(defaultTools.map(t => t.name)).not.toContain("exit_plan_mode");

		const requestedTools = await createTools(session, ["read"]);
		expect(requestedTools.map(t => t.name)).toEqual(["read", "goal", "resolve"]);
	});

	it("excludes the unified goal tool only when goal mode is disabled", async () => {
		const session = createTestSession({
			settings: createSettingsWithOverrides({
				"goal.enabled": false,
			}),
		});

		const defaultTools = await createTools(session);
		expect(defaultTools.map(t => t.name)).not.toContain("goal");

		const requestedTools = await createTools(session, ["read", "goal"]);
		expect(requestedTools.map(t => t.name)).toEqual(["read", "resolve"]);
	});
	it("auto-includes the unified goal tool when goal mode is enabled", async () => {
		const session = createTestSession({
			settings: createSettingsWithOverrides({
				"goal.enabled": true,
			}),
			getGoalModeState: () => createActiveGoalState(),
			getGoalRuntime: () =>
				({}) as NonNullable<ToolSession["getGoalRuntime"]> extends () => infer Runtime ? Runtime : never,
		});
		const tools = await createTools(session, ["read"]);
		const names = tools.map(t => t.name);

		expect(names).toEqual(["read", "goal", "resolve"]);
	});

	it("exposes the unified goal tool even when no goal is active", async () => {
		const session = createTestSession({
			settings: createSettingsWithOverrides({
				"goal.enabled": true,
			}),
			getGoalRuntime: () =>
				({}) as NonNullable<ToolSession["getGoalRuntime"]> extends () => infer Runtime ? Runtime : never,
		});
		const tools = await createTools(session, ["read"]);
		const names = tools.map(t => t.name);

		expect(names).toEqual(["read", "goal", "resolve"]);
	});

	it("includes search_tool_bm25 when MCP tool discovery is enabled and executable", async () => {
		const session = createTestSession({
			settings: createSettingsWithOverrides({
				"mcp.discoveryMode": true,
			}),
			...createDiscoverySessionHooks(),
		});
		const tools = await createTools(session);
		const names = tools.map(t => t.name);

		expect(names).toContain("search_tool_bm25");
	});

	it("exposes only the unified goal tool as a builtin goal surface", () => {
		expect(Object.keys(HIDDEN_TOOLS).sort()).toEqual(["report_finding", "resolve", "yield"]);
		expect(Object.keys(BUILTIN_TOOLS)).toContain("goal");
		expect(Object.keys(BUILTIN_TOOLS)).not.toEqual(
			expect.arrayContaining(["get_goal", "create_goal", "update_goal"]),
		);
	});
});

// Env vars exercised below leak across tests via the shared `Bun.env`/`$env`
// reference, so each block restores the keys it touches in afterEach.
function clearPyEnvKeys(): void {
	for (const key of PY_ENV_KEYS) delete Bun.env[key];
}

describe("parseGjcPy", () => {
	it("returns null when GJC_PY is unset", () => {
		expect(parseGjcPy({})).toBeNull();
	});

	it("returns null when GJC_PY is empty or whitespace", () => {
		expect(parseGjcPy({ GJC_PY: "" })).toBeNull();
		expect(parseGjcPy({ GJC_PY: "   " })).toBeNull();
	});

	it("returns null for unrecognized tokens (invalid values are ignored)", () => {
		expect(parseGjcPy({ GJC_PY: "python" })).toBeNull();
		expect(parseGjcPy({ GJC_PY: "yes" })).toBeNull();
		expect(parseGjcPy({ GJC_PY: "2" })).toBeNull();
	});

	it("parses 0/bash as JavaScript only", () => {
		expect(parseGjcPy({ GJC_PY: "0" })).toEqual({ py: false, js: true });
		expect(parseGjcPy({ GJC_PY: "bash" })).toEqual({ py: false, js: true });
	});

	it("parses 1/py as Python only", () => {
		expect(parseGjcPy({ GJC_PY: "1" })).toEqual({ py: true, js: false });
		expect(parseGjcPy({ GJC_PY: "py" })).toEqual({ py: true, js: false });
	});

	it("parses js as JavaScript only", () => {
		expect(parseGjcPy({ GJC_PY: "js" })).toEqual({ py: false, js: true });
	});

	it("parses mix/both as both backends", () => {
		expect(parseGjcPy({ GJC_PY: "mix" })).toEqual({ py: true, js: true });
		expect(parseGjcPy({ GJC_PY: "both" })).toEqual({ py: true, js: true });
	});

	it("is case-insensitive", () => {
		expect(parseGjcPy({ GJC_PY: "PY" })).toEqual({ py: true, js: false });
		expect(parseGjcPy({ GJC_PY: "Both" })).toEqual({ py: true, js: true });
		expect(parseGjcPy({ GJC_PY: "  Js  " })).toEqual({ py: false, js: true });
	});
});

describe("resolveEvalBackendsFromEnv", () => {
	it("returns null when no env override is set", () => {
		expect(resolveEvalBackendsFromEnv({})).toBeNull();
	});

	it("prefers GJC_PY over legacy PI_PY/PI_JS", () => {
		// GJC_PY=py (python only) wins even though PI_JS would enable js.
		expect(resolveEvalBackendsFromEnv({ GJC_PY: "py", PI_JS: "1" })).toEqual({ python: true, js: false });
	});

	it("falls back to legacy PI_PY/PI_JS when GJC_PY is unset", () => {
		expect(resolveEvalBackendsFromEnv({ PI_PY: "1", PI_JS: "0" })).toEqual({ python: true, js: false });
		expect(resolveEvalBackendsFromEnv({ PI_PY: "0", PI_JS: "1" })).toEqual({ python: false, js: true });
	});

	it("falls back to legacy flags when GJC_PY is an unrecognized token", () => {
		expect(resolveEvalBackendsFromEnv({ GJC_PY: "bogus", PI_PY: "1" })).toEqual({ python: true, js: true });
	});

	it("treats an unset legacy flag as true (defer-to-settings semantics)", () => {
		// Only PI_PY set: python follows it, js defaults true.
		expect(resolveEvalBackendsFromEnv({ PI_PY: "0" })).toEqual({ python: false, js: true });
		expect(resolveEvalBackendsFromEnv({ PI_JS: "0" })).toEqual({ python: true, js: false });
	});

	it("honors truthy legacy values 1/true/yes case-insensitively", () => {
		expect(resolveEvalBackendsFromEnv({ PI_PY: "true", PI_JS: "YES" })).toEqual({
			python: true,
			js: true,
		});
	});

	it("treats non-truthy legacy values as false", () => {
		expect(resolveEvalBackendsFromEnv({ PI_PY: "no", PI_JS: "0" })).toEqual({ python: false, js: false });
	});
});

describe("resolveEvalBackends (session integration)", () => {
	let previousEnv = new Map<string, string | undefined>();

	beforeEach(() => {
		previousEnv = snapshotPyEnv();
		clearPyEnvKeys();
	});

	afterEach(() => restorePyEnv(previousEnv));

	it("restores pre-existing Python environment values after cleanup", () => {
		const suiteEnv = snapshotPyEnv();
		try {
			for (const key of PY_ENV_KEYS) Bun.env[key] = `hostile-${key}`;
			const testEnv = snapshotPyEnv();
			clearPyEnvKeys();
			restorePyEnv(testEnv);
			for (const key of PY_ENV_KEYS) expect(Bun.env[key]).toBe(`hostile-${key}`);
		} finally {
			restorePyEnv(suiteEnv);
		}
	});
	it("defers to settings when no env override is set", () => {
		clearPyEnvKeys();
		const session = createTestSession({
			settings: createSettingsWithOverrides({ "eval.py": false, "eval.js": true }),
		});
		expect(resolveEvalBackends(session)).toEqual({ python: false, js: true });
	});

	it("GJC_PY=py overrides settings to python only", () => {
		clearPyEnvKeys();
		Bun.env.GJC_PY = "py";
		const session = createTestSession({
			settings: createSettingsWithOverrides({ "eval.py": true, "eval.js": true }),
		});
		expect(resolveEvalBackends(session)).toEqual({ python: true, js: false });
	});

	it("GJC_PY=0 disables python and enables js regardless of settings", () => {
		clearPyEnvKeys();
		Bun.env.GJC_PY = "0";
		const session = createTestSession({
			settings: createSettingsWithOverrides({ "eval.py": true, "eval.js": false }),
		});
		expect(resolveEvalBackends(session)).toEqual({ python: false, js: true });
	});

	it("GJC_PY wins over legacy PI_PY/PI_JS when both are set", () => {
		clearPyEnvKeys();
		Bun.env.GJC_PY = "js";
		Bun.env.PI_PY = "1";
		Bun.env.PI_JS = "0";
		const session = createTestSession();
		// GJC says js only; PI says py only. GJC wins → python false, js true.
		expect(resolveEvalBackends(session)).toEqual({ python: false, js: true });
	});

	it("legacy PI_PY/PI_JS still apply when GJC_PY is unset", () => {
		clearPyEnvKeys();
		Bun.env.PI_PY = "1";
		Bun.env.PI_JS = "0";
		const session = createTestSession({
			settings: createSettingsWithOverrides({ "eval.py": false, "eval.js": true }),
		});
		expect(resolveEvalBackends(session)).toEqual({ python: true, js: false });
	});
});

describe("resolvePythonSkipCheck", () => {
	it("is false when neither GJC nor PI is set", () => {
		expect(resolvePythonSkipCheck({})).toBe(false);
	});

	it("honors GJC_PYTHON_SKIP_CHECK truthy values", () => {
		expect(resolvePythonSkipCheck({ GJC_PYTHON_SKIP_CHECK: "1" })).toBe(true);
		expect(resolvePythonSkipCheck({ GJC_PYTHON_SKIP_CHECK: "true" })).toBe(true);
		expect(resolvePythonSkipCheck({ GJC_PYTHON_SKIP_CHECK: "yes" })).toBe(true);
	});

	it("falls back to PI_PYTHON_SKIP_CHECK", () => {
		expect(resolvePythonSkipCheck({ PI_PYTHON_SKIP_CHECK: "1" })).toBe(true);
	});

	it("prefers GJC over PI but either truthy wins (OR)", () => {
		expect(resolvePythonSkipCheck({ GJC_PYTHON_SKIP_CHECK: "1", PI_PYTHON_SKIP_CHECK: "0" })).toBe(true);
		expect(resolvePythonSkipCheck({ GJC_PYTHON_SKIP_CHECK: "0", PI_PYTHON_SKIP_CHECK: "1" })).toBe(true);
	});

	it("is case-insensitive and ignores whitespace", () => {
		expect(resolvePythonSkipCheck({ GJC_PYTHON_SKIP_CHECK: "  YES  " })).toBe(true);
	});

	it("treats non-truthy values as false", () => {
		expect(resolvePythonSkipCheck({ GJC_PYTHON_SKIP_CHECK: "no" })).toBe(false);
		expect(resolvePythonSkipCheck({ GJC_PYTHON_SKIP_CHECK: "0" })).toBe(false);
	});
});

describe("resolvePythonIpcTrace", () => {
	it("is false when neither is set", () => {
		expect(resolvePythonIpcTrace({})).toBe(false);
	});

	it("honors GJC_PYTHON_IPC_TRACE first, then PI_PYTHON_IPC_TRACE", () => {
		expect(resolvePythonIpcTrace({ GJC_PYTHON_IPC_TRACE: "1" })).toBe(true);
		expect(resolvePythonIpcTrace({ PI_PYTHON_IPC_TRACE: "true" })).toBe(true);
		expect(resolvePythonIpcTrace({ GJC_PYTHON_IPC_TRACE: "0", PI_PYTHON_IPC_TRACE: "1" })).toBe(true);
	});
});

describe("resolvePythonIntegrationGate (OR semantics)", () => {
	it("is false when neither is set", () => {
		expect(resolvePythonIntegrationGate({})).toBe(false);
	});

	it("is true when GJC_PYTHON_INTEGRATION=1", () => {
		expect(resolvePythonIntegrationGate({ GJC_PYTHON_INTEGRATION: "1" })).toBe(true);
	});

	it("is true when PI_PYTHON_INTEGRATION=1", () => {
		expect(resolvePythonIntegrationGate({ PI_PYTHON_INTEGRATION: "1" })).toBe(true);
	});

	it("GJC=0, PI=1 is still true (OR semantics, not GJC-gated)", () => {
		expect(resolvePythonIntegrationGate({ GJC_PYTHON_INTEGRATION: "0", PI_PYTHON_INTEGRATION: "1" })).toBe(true);
	});

	it("both 0 is false", () => {
		expect(resolvePythonIntegrationGate({ GJC_PYTHON_INTEGRATION: "0", PI_PYTHON_INTEGRATION: "0" })).toBe(false);
	});

	it("accepts truthy tokens true/yes case-insensitively", () => {
		expect(resolvePythonIntegrationGate({ GJC_PYTHON_INTEGRATION: "TRUE" })).toBe(true);
		expect(resolvePythonIntegrationGate({ PI_PYTHON_INTEGRATION: "yes" })).toBe(true);
	});
});
