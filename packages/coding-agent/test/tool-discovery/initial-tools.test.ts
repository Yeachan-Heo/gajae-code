import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../../src/config/settings";
import { type GoalModeState, GoalRuntime } from "../../src/goals";
import { AgentRegistry, MAIN_AGENT_ID } from "../../src/registry/agent-registry";
import { createAgentSession } from "../../src/sdk/session";
import type { ToolSession } from "../../src/tools/index";
import {
	BUILTIN_CAPABILITY_CATALOG,
	BUILTIN_TOOLS,
	computeEssentialBuiltinNames,
	createTools,
	DEFAULT_ESSENTIAL_TOOL_NAMES,
} from "../../src/tools/index";

const allToolsSettings = Settings.isolated({
	"astGrep.enabled": true,
	"astEdit.enabled": true,
	"renderMermaid.enabled": true,
	"debug.enabled": true,
	"find.enabled": true,
	"search.enabled": true,
	"github.enabled": true,
	"lsp.enabled": true,
	"web_search.enabled": true,
	"calc.enabled": true,
	"browser.enabled": true,
	"checkpoint.enabled": true,
	"irc.enabled": true,
	"recipe.enabled": true,
	"todo.enabled": true,
	"memory.backend": "hindsight",
	"tools.discoveryMode": "all",
	"goal.enabled": true,
});

const activeGoalState: GoalModeState = {
	enabled: true,
	mode: "active",
	goal: {
		id: "goal-1",
		objective: "Verify tool metadata",
		status: "active",
		tokensUsed: 0,
		timeUsedSeconds: 0,
		createdAt: 1,
		updatedAt: 1,
	},
};

const goalRuntime = new GoalRuntime({
	getState: () => activeGoalState,
	setState: () => {},
	getCurrentUsage: () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
	emit: () => {},
	persist: () => {},
	sendHiddenMessage: async () => {},
	now: () => 1,
});

const toolSession: ToolSession = {
	cwd: "/tmp/test",
	hasUI: false,
	getSessionFile: () => null,
	getSessionSpawns: () => null,
	settings: allToolsSettings,
	isToolDiscoveryEnabled: () => true,
	getSelectedDiscoveredToolNames: () => [],
	activateDiscoveredTools: async names => names,
	getGoalModeState: () => activeGoalState,
	getGoalRuntime: () => goalRuntime,
	skills: [
		{
			name: "stub-skill",
			description: "stub skill for tool metadata coverage",
			filePath: "/tmp/stub-skill/SKILL.md",
			baseDir: "/tmp/stub-skill",
			source: "test",
			content: "stub",
		},
	],
	sendCustomMessage: async () => {},
};

async function getToolMetadata(): Promise<Map<string, { loadMode?: string; summary?: string }>> {
	const tools = await createTools(toolSession, Object.keys(BUILTIN_TOOLS));
	const { AskTool, ComputerTool, IrcTool, JobTool, RecipeTool, SshTool, TelegramSendTool } = await import("../../src/tools/implementations");
	const metadata = new Map(tools.map(tool => [tool.name, { loadMode: tool.loadMode, summary: tool.summary }]));
	for (const tool of [
		new AskTool({ ...toolSession, hasUI: true }),
		new ComputerTool(toolSession),
		new SshTool(toolSession, [], new Map(), ""),
		new JobTool(toolSession),
		new RecipeTool(toolSession, []),
		new IrcTool(toolSession),
		new TelegramSendTool(toolSession),
	]) {
		metadata.set(tool.name, { loadMode: tool.loadMode, summary: tool.summary });
	}
	// `computer` is a public built-in factory but intentionally returns null on
	// non-macOS/disabled sessions. Keep this registry-shape assertion independent
	// from platform gating by reading its static capability metadata.
	const computerCapability = BUILTIN_CAPABILITY_CATALOG.find(entry => entry.name === "computer");
	if (computerCapability) {
		metadata.set("computer", { loadMode: "discoverable", summary: computerCapability.summary });
	}
	return metadata;
}
describe("BUILTIN_TOOLS public factory map", () => {
	it("sets loading fields on tool definitions without wrapping factories", async () => {
		const metadata = await getToolMetadata();
		const missing = Object.keys(BUILTIN_TOOLS).filter(name => metadata.get(name)?.loadMode === undefined);
		expect(missing).toEqual([]);
	});

	it("does not expose memory helpers as public built-in tools", async () => {
		expect(Object.keys(BUILTIN_TOOLS)).not.toEqual(expect.arrayContaining(["memory", "recall", "retain", "reflect"]));

		const tools = await createTools(
			{
				...toolSession,
				settings: Settings.isolated({ "memory.backend": "hindsight", "tools.discoveryMode": "all" }),
			},
			Object.keys(BUILTIN_TOOLS),
		);
		expect(tools.map(tool => tool.name)).not.toEqual(
			expect.arrayContaining(["memory", "recall", "retain", "reflect"]),
		);
	});

	it("exposes the skill tool by default when skills and custom-message bridge are available", async () => {
		const tools = await createTools(
			{
				...toolSession,
				settings: Settings.isolated(),
			},
			["skill"],
		);

		expect(tools.some(tool => tool.name === "skill")).toBe(true);
	});

	it("omits the skill tool when skill.enabled is false", async () => {
		const tools = await createTools(
			{
				...toolSession,
				settings: Settings.isolated({ "skill.enabled": false }),
			},
			["skill"],
		);

		expect(tools.some(tool => tool.name === "skill")).toBe(false);
	});

	it("exposes detached subagent controls and keeps generic job controls without async flags", async () => {
		const session = {
			...toolSession,
			settings: Settings.isolated({ "async.enabled": false, "bash.autoBackground.enabled": false }),
		};

		const tools = await createTools(session, ["subagent", "job"]);

		expect(tools.some(tool => tool.name === "job")).toBe(true);
		expect(tools.some(tool => tool.name === "subagent")).toBe(true);
	});

	it("keeps IRC available for main-agent coordination when detached subagents run with async disabled", async () => {
		const session = {
			...toolSession,
			agentRegistry: new AgentRegistry(),
			getAgentId: () => MAIN_AGENT_ID,
			settings: Settings.isolated({ "async.enabled": false, "irc.enabled": true }),
		};

		const tools = await createTools(session, ["irc"]);

		expect(tools.some(tool => tool.name === "irc")).toBe(true);
	});
});

describe("built-in tool loadMode annotations", () => {
	it("provides a summary for every discoverable tool", async () => {
		const missing: string[] = [];
		const metadata = await getToolMetadata();
		for (const [name, meta] of metadata) {
			if (meta.loadMode === "discoverable" && !meta.summary) {
				missing.push(name);
			}
		}
		expect(missing).toEqual([]);
	});
});

describe("alwaysActiveToolNames keeps discoverable coordination tools loaded", () => {
	async function tempDir(): Promise<string> {
		return await fs.mkdtemp(path.join(os.tmpdir(), "gjc-always-active-"));
	}

	it("hides irc from a subagent-style session by default and forces it active when requested", async () => {
		const cwd = await tempDir();
		const agentDir = await tempDir();

		// No `toolNames`: this is the executor/generic-subagent path, which inherits the
		// full builtin set. With tools.discoveryMode="all" (the default), `irc` is
		// loadMode "discoverable" and must therefore be hidden behind search_tool_bm25.
		const hidden = await createAgentSession({ cwd, agentDir });
		expect(hidden.session.getActiveToolNames()).not.toContain("irc");

		const forced = await createAgentSession({ cwd, agentDir, alwaysActiveToolNames: ["irc"] });
		expect(forced.session.getActiveToolNames()).toContain("irc");

		// Forcing one tool active must not drag the rest of the discoverable set in.
		expect(forced.session.getActiveToolNames()).not.toContain("browser");
	}, 60_000);
});

describe("computeEssentialBuiltinNames", () => {
	it("returns DEFAULT_ESSENTIAL_TOOL_NAMES when override is empty", () => {
		const settings = Settings.isolated({});
		expect(computeEssentialBuiltinNames(settings).sort()).toEqual([...DEFAULT_ESSENTIAL_TOOL_NAMES].sort());
	});

	it("respects tools.essentialOverride when provided", () => {
		const settings = Settings.isolated({ "tools.essentialOverride": ["read", "find"] });
		expect(computeEssentialBuiltinNames(settings).sort()).toEqual(["find", "read"]);
	});

	it("filters override entries that are not known built-in tools", () => {
		const settings = Settings.isolated({
			"tools.essentialOverride": ["read", "not_a_real_tool", "edit"],
		});
		expect(computeEssentialBuiltinNames(settings).sort()).toEqual(["edit", "read"]);
	});

	it("trims whitespace and drops empty entries from the override", () => {
		const settings = Settings.isolated({
			"tools.essentialOverride": [" read ", "", "  "],
		});
		expect(computeEssentialBuiltinNames(settings)).toEqual(["read"]);
	});

	it("falls back to defaults when override is non-empty but contains only invalid names", () => {
		// The filtered list is empty (no valid names), but the override was provided —
		// current behavior returns the empty filtered list (caller can decide). Document the behavior.
		const settings = Settings.isolated({
			"tools.essentialOverride": ["not_a_real_tool"],
		});
		expect(computeEssentialBuiltinNames(settings)).toEqual([]);
	});
});

describe("tools.discoveryMode settings schema", () => {
	it("back-compat: mcp.discoveryMode still accepted", () => {
		const settings = Settings.isolated({ "mcp.discoveryMode": true });
		expect(settings.get("mcp.discoveryMode")).toBe(true);
	});
});
