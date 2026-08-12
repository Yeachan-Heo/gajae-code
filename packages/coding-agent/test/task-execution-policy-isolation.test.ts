import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@gajae-code/ai";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { MCPManager } from "../src/runtime-mcp/manager";
import * as sdkModule from "../src/sdk";
import { type CreateAgentSessionOptions, type CreateAgentSessionResult, createAgentSession } from "../src/sdk/session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";
import {
	compileTaskExecutionPolicy,
	isTaskToolAllowed,
	TASK_CONTROL_PLANE_TOOL_IDS,
	TASK_EXECUTION_POLICY_MIN_DURATION_MS,
	type TaskExecutionPolicy,
	TaskExecutionPolicyController,
} from "../src/task/execution-policy";
import { type ExecutorOptions, runSubprocess } from "../src/task/executor";
import type { AgentDefinition } from "../src/task/types";

const TEST_AGENT: AgentDefinition = {
	name: "policy-worker",
	description: "A worker used to verify launch policy enforcement.",
	systemPrompt: "Verify the supplied task.",
	source: "bundled",
};

const DISCOVERY_SETTINGS = {
	"tools.discoveryMode": "all" as const,
	"tools.essentialOverride": ["read", "search_tool_bm25"],
	"browser.enabled": false,
	"debug.enabled": false,
	"recipe.enabled": false,
};

type ChildOverrides = Pick<
	CreateAgentSessionOptions,
	| "deferMcpConfigStartup"
	| "enableLsp"
	| "mcpConfigPath"
	| "parentTaskPrefix"
	| "requireYieldTool"
	| "settings"
	| "taskDepth"
	| "toolNames"
	| "currentAgentType"
>;

type OwnedSession = {
	readonly result: CreateAgentSessionResult;
	readonly authStorage: AuthStorage;
	readonly root: string;
};

function makePolicy(overrides: Partial<TaskExecutionPolicy> = {}): TaskExecutionPolicy {
	return {
		isolation: overrides.isolation ?? "current",
		toolAccess: overrides.toolAccess ?? { allow: [], deny: [] },
		mcpDiscovery: overrides.mcpDiscovery ?? "configured",
		maxDurationMs: overrides.maxDurationMs ?? null,
		simpleMode: overrides.simpleMode ?? false,
	};
}

function makeRoot(roots: string[]): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-policy-isolation-"));
	roots.push(root);
	return root;
}

function policySurface(
	result: CreateAgentSessionResult,
): () => ReturnType<TaskExecutionPolicyController["getSnapshot"]> {
	const getExecutionPolicy = result.getExecutionPolicy;
	if (!getExecutionPolicy) throw new Error("createAgentSession did not expose execution policy controls");
	return getExecutionPolicy;
}

async function createChild(
	root: string,
	snapshot: ReturnType<TaskExecutionPolicyController["getSnapshot"]>,
	overrides: ChildOverrides = {},
): Promise<OwnedSession> {
	const authStorage = await AuthStorage.create(path.join(root, "auth.db"));
	const modelRegistry = new ModelRegistry(authStorage, path.join(root, "models.yml"));
	try {
		const result = await createAgentSession({
			cwd: root,
			agentDir: path.join(root, "agent"),
			authStorage,
			modelRegistry,
			model: getBundledModel("openai", "gpt-4o-mini"),
			sessionManager: SessionManager.inMemory(root),
			settings: Settings.isolated(),
			disableExtensionDiscovery: true,
			extensions: [],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			rules: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			executionPolicySnapshot: snapshot,
			...overrides,
		});
		return { result, authStorage, root };
	} catch (error) {
		authStorage.close();
		throw error;
	}
}

function executorOptions(root: string, id: string): ExecutorOptions {
	return {
		cwd: root,
		agent: TEST_AGENT,
		task: "Run the policy isolation check.",
		assignment: "Run the policy isolation check.",
		index: 0,
		id,
	};
}

function mcpServerScript(): string {
	return `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const send = message => process.stdout.write(JSON.stringify(message) + "\\n");
rl.on("line", line => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: {
      protocolVersion: "2025-03-26",
      capabilities: { tools: {} },
      serverInfo: { name: "policy-server", version: "1.0.0" }
    }});
  } else if (message.method === "tools/list") {
    send({ jsonrpc: "2.0", id: message.id, result: { tools: [{
      name: "lookup",
      description: "Lookup a policy fixture value.",
      inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] }
    }] }});
  } else if (message.method === "tools/call") {
    send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "ok" }] } });
  } else if (message.id !== undefined) {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
  }
});
setInterval(() => {}, 1000);
`;
}

async function writeMcpConfig(root: string): Promise<string> {
	const configPath = path.join(root, "mcp.json");
	await fs.promises.writeFile(
		configPath,
		JSON.stringify({
			mcpServers: {
				policy: {
					command: process.execPath,
					args: ["-e", mcpServerScript()],
					timeout: 2_000,
				},
			},
		}),
		"utf8",
	);
	return configPath;
}

describe("launch-enforced task execution policy isolation", () => {
	const ownedSessions: OwnedSession[] = [];
	const roots: string[] = [];

	afterEach(async () => {
		for (const owned of ownedSessions.splice(0)) {
			await owned.result.session.dispose();
			owned.authStorage.close();
		}
		for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
	});

	it("enforces allow and deny lists through real child tool and activation APIs", async () => {
		const allowRoot = makeRoot(roots);
		const allowController = new TaskExecutionPolicyController(
			makePolicy({ toolAccess: { allow: ["read", "search_tool_bm25", "todo_write"], deny: [] } }),
		);
		const allowLease = allowController.acquireLaunchLease();
		let allowChild: OwnedSession;
		try {
			allowChild = await createChild(allowRoot, allowLease.snapshot, {
				parentTaskPrefix: "0-PolicyAllow",
				currentAgentType: "worker",
				taskDepth: 1,
				settings: Settings.isolated(DISCOVERY_SETTINGS),
			});
		} finally {
			allowLease.release();
		}
		ownedSessions.push(allowChild);

		const allowSession = allowChild.result.session;
		expect(allowSession.getActiveToolNames()).toContain("read");
		expect(allowSession.getActiveToolNames()).not.toContain("bash");
		expect(allowSession.getToolByName("read")).toBeDefined();
		expect(allowSession.getToolByName("todo_write")).toBeDefined();
		expect(allowSession.getToolByName("bash")).toBeUndefined();
		expect(allowSession.getToolByName("ask")).toBeDefined();
		expect(allowSession.getToolForExecution("read")).toBeDefined();
		expect(allowSession.getToolForExecution("todo_write")).toBeDefined();
		expect(allowSession.getToolForExecution("bash")).toBeUndefined();
		expect(allowSession.getToolForExecution("ask")).toBeDefined();

		const discoverable = allowSession.getDiscoverableTools({ source: "builtin" });
		expect(discoverable.map(tool => tool.name)).toEqual(["ask", "todo_write"]);
		expect(allowSession.getDiscoverableToolSearchIndex().documents.map(document => document.tool.name)).toEqual([
			"ask",
			"todo_write",
		]);
		expect(await allowSession.activateDiscoveredTools(["todo_write", "bash"])).toEqual(["todo_write"]);
		expect(allowSession.getActiveToolNames()).toContain("todo_write");
		await allowSession.setActiveToolsByName(["read", "todo_write", "ask", "bash"]);
		expect(allowSession.getActiveToolNames()).toContain("read");
		expect(allowSession.getActiveToolNames()).toContain("todo_write");
		expect(allowSession.getActiveToolNames()).not.toContain("bash");
		expect(allowSession.getActiveToolNames()).toContain("ask");

		const denyRoot = makeRoot(roots);
		const denyController = new TaskExecutionPolicyController(
			makePolicy({ toolAccess: { allow: [], deny: ["bash", "todo_write"] } }),
		);
		const denyLease = denyController.acquireLaunchLease();
		let denyChild: OwnedSession;
		try {
			denyChild = await createChild(denyRoot, denyLease.snapshot, {
				parentTaskPrefix: "0-PolicyDeny",
				currentAgentType: "worker",
				taskDepth: 1,
				settings: Settings.isolated(DISCOVERY_SETTINGS),
			});
		} finally {
			denyLease.release();
		}
		ownedSessions.push(denyChild);

		const denySession = denyChild.result.session;
		expect(denySession.getToolByName("read")).toBeDefined();
		expect(denySession.getToolByName("bash")).toBeUndefined();
		expect(denySession.getToolByName("todo_write")).toBeUndefined();
		expect(denySession.getToolForExecution("read")).toBeDefined();
		expect(denySession.getToolForExecution("bash")).toBeUndefined();
		expect(denySession.getDiscoverableTools({ source: "builtin" }).map(tool => tool.name)).toEqual([
			"ast_grep",
			"ast_edit",
			"ask",
			"bisect",
			"eval",
			"find",
			"search",
			"computer",
			"task",
			"subagent",
			"job",
			"monitor",
			"cron",
			"irc",
			"web_search",
			"write",
		]);
		expect(denySession.getDiscoverableToolSearchIndex().documents.map(document => document.tool.name)).toEqual([
			"ast_grep",
			"ast_edit",
			"ask",
			"bisect",
			"eval",
			"find",
			"search",
			"computer",
			"task",
			"subagent",
			"job",
			"monitor",
			"cron",
			"irc",
			"web_search",
			"write",
		]);
		expect(await denySession.activateDiscoveredTools(["todo_write", "bash"])).toEqual([]);
		await denySession.setActiveToolsByName(["read", "todo_write", "bash"]);
		expect(denySession.getActiveToolNames()).toContain("read");
		expect(denySession.getActiveToolNames()).not.toContain("bash");
		expect(denySession.getActiveToolNames()).not.toContain("todo_write");
	});

	it("preserves mandatory control-plane tools through compile/apply while arbitrary denials remain denied", () => {
		expect(Object.isFrozen(TASK_CONTROL_PLANE_TOOL_IDS)).toBe(true);
		expect(TASK_CONTROL_PLANE_TOOL_IDS).toEqual(["yield", "report_finding", "ask"]);

		const value = makePolicy({
			toolAccess: {
				allow: ["read"],
				deny: ["yield", "report_finding", "ask", "bash", "edit", "write"],
			},
		});
		const compiled = compileTaskExecutionPolicy(value);
		expect(compiled.ok).toBe(true);
		if (!compiled.ok) return;

		const controller = new TaskExecutionPolicyController();
		const applied = controller.tryApply(value);
		expect(applied.ok).toBe(true);
		if (!applied.ok) return;

		const snapshot = applied.snapshot;
		expect(isTaskToolAllowed(snapshot, "ask")).toBe(true);
		expect(isTaskToolAllowed(snapshot, "yield")).toBe(true);
		expect(isTaskToolAllowed(snapshot, "report_finding")).toBe(true);
		expect(isTaskToolAllowed(snapshot, "read")).toBe(true);
		for (const deniedTool of ["bash", "edit", "write"]) {
			expect(isTaskToolAllowed(snapshot, deniedTool)).toBe(false);
		}
	});

	it("locks child policy controls and omits mutable result methods", async () => {
		const root = makeRoot(roots);
		const parent = new TaskExecutionPolicyController(makePolicy({ toolAccess: { allow: ["read"], deny: [] } }));
		const lease = parent.acquireLaunchLease();
		let child: OwnedSession;
		try {
			child = await createChild(root, lease.snapshot, {
				parentTaskPrefix: "0-PolicyLocked",
				currentAgentType: "worker",
				taskDepth: 1,
			});
		} finally {
			lease.release();
		}
		ownedSessions.push(child);

		expect(Object.hasOwn(child.result, "applyExecutionPolicy")).toBe(false);
		expect(Object.hasOwn(child.result, "clearExecutionPolicy")).toBe(false);
		expect(typeof child.result.getExecutionPolicy).toBe("function");

		const controller = child.result.session.getExecutionPolicyController();
		if (controller === undefined) throw new Error("child session did not expose its policy controller");
		const before = controller.getSnapshot();
		const preview = controller.previewApply(makePolicy({ toolAccess: { allow: ["bash"], deny: [] } }));
		expect(preview.ok).toBe(true);
		if (preview.ok) expect(preview.snapshot.policy.toolAccess.allow).toEqual(["bash"]);
		expect(controller.getSnapshot()).toBe(before);
		const applied = controller.tryApply(makePolicy({ toolAccess: { allow: ["bash"], deny: [] } }));
		expect(applied.ok).toBe(false);
		if (!applied.ok) expect(applied.error).toMatchObject({ code: "policy_locked" });
		expect(controller.getSnapshot()).toBe(before);
		expect(controller.clear()).toBe(before);
		expect(controller.getSnapshot()).toBe(before);
		expect(() => controller.apply(makePolicy({ toolAccess: { allow: ["bash"], deny: [] } }))).toThrow(
			"Execution policy is locked for this launch.",
		);
		expect(controller.getSnapshot()).toBe(before);
	});

	it("keeps completion and reporting protocol tools in a constrained architect child", async () => {
		const root = makeRoot(roots);
		const controller = new TaskExecutionPolicyController(
			makePolicy({
				toolAccess: {
					allow: ["read", "search", "find", "lsp"],
					deny: ["bash", "edit", "write"],
				},
			}),
		);
		const lease = controller.acquireLaunchLease();
		let child: OwnedSession;
		try {
			child = await createChild(root, lease.snapshot, {
				parentTaskPrefix: "0-SecureReviewArchitect",
				currentAgentType: "architect",
				taskDepth: 1,
				requireYieldTool: true,
				enableLsp: true,
				settings: Settings.isolated({
					...DISCOVERY_SETTINGS,
					"find.enabled": true,
					"lsp.enabled": true,
					"search.enabled": true,
				}),
				toolNames: ["read", "search", "find", "lsp", "yield", "report_finding", "bash", "edit", "write"],
			});
		} finally {
			lease.release();
		}
		ownedSessions.push(child);

		const session = child.result.session;
		const activeToolNames = session.getActiveToolNames();
		expect(activeToolNames).toEqual(
			expect.arrayContaining(["read", "search", "find", "lsp", "yield", "report_finding"]),
		);
		expect(activeToolNames).not.toEqual(expect.arrayContaining(["bash", "edit", "write"]));
		expect(session.getToolForExecution("yield")).toBeDefined();
		expect(session.getToolForExecution("report_finding")).toBeDefined();
		for (const deniedTool of ["bash", "edit", "write"]) {
			expect(session.getToolByName(deniedTool)).toBeUndefined();
			expect(session.getToolForExecution(deniedTool)).toBeUndefined();
		}

		// Protocol tools are intentionally hidden from discovery; direct execution is their contract.
		const discoverableToolNames = session.getDiscoverableTools({ source: "builtin" }).map(tool => tool.name);
		expect(discoverableToolNames).not.toEqual(
			expect.arrayContaining(["yield", "report_finding", "bash", "edit", "write"]),
		);
		expect(await session.activateDiscoveredTools(["bash", "edit", "write"])).toEqual([]);
		await session.setActiveToolsByName([
			"read",
			"search",
			"find",
			"lsp",
			"yield",
			"report_finding",
			"bash",
			"edit",
			"write",
		]);
		const afterReactivationToolNames = session.getActiveToolNames();
		expect(afterReactivationToolNames).toEqual(
			expect.arrayContaining(["read", "search", "find", "lsp", "yield", "report_finding"]),
		);
		expect(afterReactivationToolNames).not.toEqual(expect.arrayContaining(["bash", "edit", "write"]));
	});

	it("keeps configured and deferred MCP tools non-executable when discovery is disabled", async () => {
		const configuredRoot = makeRoot(roots);
		const configuredPath = await writeMcpConfig(configuredRoot);
		const probeManager = new MCPManager(configuredRoot, null, { toolsOnly: true });
		await probeManager.discoverAndConnect({ configPath: configuredPath });
		await probeManager.disconnectAll();
		const disabledController = new TaskExecutionPolicyController(
			makePolicy({
				toolAccess: { allow: ["read"], deny: [] },
				mcpDiscovery: "disabled",
			}),
		);
		const configuredLease = disabledController.acquireLaunchLease();
		let configuredChild: OwnedSession;
		try {
			configuredChild = await createChild(configuredRoot, configuredLease.snapshot, {
				mcpConfigPath: configuredPath,
				settings: Settings.isolated({ ...DISCOVERY_SETTINGS, "mcp.discoveryMode": true }),
			});
		} finally {
			configuredLease.release();
		}
		ownedSessions.push(configuredChild);

		const configuredSession = configuredChild.result.session;
		expect(configuredSession.getActiveToolNames()).toContain("read");
		expect(configuredSession.getToolByName("read")).toBeDefined();
		expect(configuredSession.getToolForExecution("read")).toBeDefined();
		expect(configuredSession.getAllToolNames()).not.toContain("mcp__policy_lookup");
		expect(configuredSession.getToolByName("mcp__policy_lookup")).toBeUndefined();
		expect(configuredSession.getToolForExecution("mcp__policy_lookup")).toBeUndefined();
		expect(configuredSession.getDiscoverableTools({ source: "mcp" }).map(tool => tool.name)).toEqual([]);
		expect(await configuredSession.activateDiscoveredTools(["mcp__policy_lookup"])).toEqual([]);
		expect(
			configuredSession
				.getDiscoverableToolSearchIndex()
				.documents.map(document => document.tool.name)
				.includes("mcp__policy_lookup"),
		).toBe(false);

		const deferredRoot = makeRoot(roots);
		const deferredPath = await writeMcpConfig(deferredRoot);
		const deferredLease = disabledController.acquireLaunchLease();
		let deferredChild: OwnedSession;
		try {
			deferredChild = await createChild(deferredRoot, deferredLease.snapshot, {
				mcpConfigPath: deferredPath,
				deferMcpConfigStartup: true,
				settings: Settings.isolated({ ...DISCOVERY_SETTINGS, "mcp.discoveryMode": true }),
			});
		} finally {
			deferredLease.release();
		}
		ownedSessions.push(deferredChild);

		const deferredSession = deferredChild.result.session;
		const startDeferredMcpConfig = deferredChild.result.startDeferredMcpConfig;
		if (!startDeferredMcpConfig) throw new Error("deferred MCP startup handle was not returned");
		expect(deferredSession.getToolByName("read")).toBeDefined();
		expect(deferredSession.getToolByName("mcp__policy_lookup")).toBeUndefined();
		expect(deferredSession.getAllToolNames()).not.toContain("mcp__policy_lookup");
		expect(deferredSession.getToolForExecution("mcp__policy_lookup")).toBeUndefined();
		expect(deferredSession.getActiveToolNames()).not.toContain("mcp__policy_lookup");
		expect(deferredSession.getDiscoverableTools({ source: "mcp" }).map(tool => tool.name)).toEqual([]);
		expect(await deferredSession.activateDiscoveredTools(["mcp__policy_lookup"])).toEqual([]);
		expect(await startDeferredMcpConfig()).toEqual({ loadedToolCount: 1, hasErrors: false });
		expect(deferredSession.getAllToolNames()).not.toContain("mcp__policy_lookup");
		expect(deferredSession.getToolByName("mcp__policy_lookup")).toBeUndefined();
		expect(deferredSession.getActiveToolNames()).not.toContain("mcp__policy_lookup");
		expect(deferredSession.getToolForExecution("mcp__policy_lookup")).toBeUndefined();
		expect(deferredSession.getDiscoverableTools({ source: "mcp" }).map(tool => tool.name)).toEqual([]);
		expect(
			deferredSession
				.getDiscoverableToolSearchIndex()
				.documents.map(document => document.tool.name)
				.includes("mcp__policy_lookup"),
		).toBe(false);
		expect(deferredSession.getToolByName("read")).toBeDefined();
	});

	it("keeps an existing child on its launch snapshot while a new child gets the next lease", async () => {
		const parent = new TaskExecutionPolicyController(
			makePolicy({
				toolAccess: { allow: ["read"], deny: [] },
				maxDurationMs: TASK_EXECUTION_POLICY_MIN_DURATION_MS,
			}),
		);
		const firstRoot = makeRoot(roots);
		const firstLease = parent.acquireLaunchLease();
		let firstChild: OwnedSession;
		try {
			firstChild = await createChild(firstRoot, firstLease.snapshot, {
				parentTaskPrefix: "0-PolicySnapshotFirst",
				currentAgentType: "worker",
				taskDepth: 1,
			});
		} finally {
			firstLease.release();
		}
		ownedSessions.push(firstChild);

		const firstPolicy = policySurface(firstChild.result)();
		const nextPolicy = makePolicy({ toolAccess: { allow: ["bash"], deny: [] } });
		const applied = parent.apply(nextPolicy);
		expect(applied.fingerprint).not.toBe(firstPolicy.fingerprint);
		expect(parent.clear().source.kind).toBe("default");
		expect(policySurface(firstChild.result)()).toEqual(firstPolicy);
		expect(firstChild.result.session.getToolByName("read")).toBeDefined();
		expect(firstChild.result.session.getToolByName("bash")).toBeUndefined();

		const secondRoot = makeRoot(roots);
		const secondLease = parent.acquireLaunchLease();
		let secondChild: OwnedSession;
		try {
			secondChild = await createChild(secondRoot, secondLease.snapshot, {
				parentTaskPrefix: "0-PolicySnapshotSecond",
				currentAgentType: "worker",
				taskDepth: 1,
			});
		} finally {
			secondLease.release();
		}
		ownedSessions.push(secondChild);

		expect(policySurface(secondChild.result)().source.kind).toBe("default");
		expect(secondChild.result.session.getToolByName("read")).toBeDefined();
		expect(secondChild.result.session.getToolByName("bash")).toBeDefined();

		const thirdSnapshot = parent.apply(nextPolicy);
		const thirdRoot = makeRoot(roots);
		const thirdLease = parent.acquireLaunchLease();
		let thirdChild: OwnedSession;
		try {
			thirdChild = await createChild(thirdRoot, thirdLease.snapshot, {
				parentTaskPrefix: "0-PolicySnapshotThird",
				currentAgentType: "worker",
				taskDepth: 1,
			});
		} finally {
			thirdLease.release();
		}
		ownedSessions.push(thirdChild);

		expect(policySurface(thirdChild.result)()).toEqual(thirdSnapshot);
		expect(thirdChild.result.session.getToolByName("read")).toBeUndefined();
		expect(thirdChild.result.session.getToolByName("bash")).toBeDefined();
	});
	it("uses the invocation snapshot across delayed child setup and releases its launch lease", async () => {
		const root = makeRoot(roots);
		const worktree = path.join(root, "worktree");
		await fs.promises.mkdir(worktree, { recursive: true });
		const authStorage = await AuthStorage.create(path.join(root, "auth.db"));
		const modelRegistry = new ModelRegistry(authStorage, path.join(root, "models.yml"));
		const controller = new TaskExecutionPolicyController(
			makePolicy({
				isolation: "worktree",
				toolAccess: { allow: ["read"], deny: ["bash"] },
				mcpDiscovery: "disabled",
				maxDurationMs: TASK_EXECUTION_POLICY_MIN_DURATION_MS,
				simpleMode: true,
			}),
		);
		const executionPolicySnapshot = controller.getSnapshot();
		const abort = new AbortController();
		const setupReady = Promise.withResolvers<void>();
		const releaseSetup = Promise.withResolvers<void>();
		let childOptions: CreateAgentSessionOptions | undefined;
		let childSnapshot: ReturnType<TaskExecutionPolicyController["getSnapshot"]> | undefined;
		let childActiveTools: string[] | undefined;
		let childHasRead = false;
		let childHasBash = false;
		const originalCreateAgentSession = sdkModule.createAgentSession;
		const createAgentSessionSpy = vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			try {
				const child = await originalCreateAgentSession({ ...options, agentDir: path.join(root, "agent") });
				childOptions = options;
				childSnapshot = child.getExecutionPolicy?.();
				childActiveTools = child.session.getActiveToolNames();
				childHasRead = child.session.getToolByName("read") !== undefined;
				childHasBash = child.session.getToolByName("bash") !== undefined;
				setupReady.resolve();
				await releaseSetup.promise;
				abort.abort();
				return child;
			} catch (error) {
				setupReady.resolve();
				throw error;
			}
		});
		try {
			const pending = runSubprocess({
				...executorOptions(root, "0-PolicyInvocationSnapshot"),
				agent: { ...TEST_AGENT, tools: ["read", "bash"] },
				worktree,
				executionPolicyController: controller,
				executionPolicySnapshot,
				authStorage,
				modelRegistry,
				settings: Settings.isolated({ ...DISCOVERY_SETTINGS, "task.maxRuntimeMs": 0 }),
				enableLsp: false,
				signal: abort.signal,
			});

			const permissivePolicy = makePolicy({
				isolation: "current",
				toolAccess: { allow: ["read", "bash"], deny: [] },
				mcpDiscovery: "configured",
				maxDurationMs: null,
				simpleMode: false,
			});
			expect(controller.apply(permissivePolicy).policy).toEqual(permissivePolicy);

			await setupReady.promise;
			expect(controller.activeLaunchCount).toBe(1);
			releaseSetup.resolve();
			const result = await pending;

			expect(result.aborted).toBe(true);
			expect(childOptions?.cwd).toBe(worktree);
			expect(childOptions?.enableMCP).toBe(false);
			expect(childOptions?.toolNames).toEqual(["read"]);
			expect(childOptions?.executionPolicySnapshot).toEqual(executionPolicySnapshot);
			expect(childSnapshot).toEqual(executionPolicySnapshot);
			expect(childActiveTools).toContain("read");
			expect(childHasRead).toBe(true);
			expect(childHasBash).toBe(false);
		} finally {
			createAgentSessionSpy.mockRestore();
			releaseSetup.resolve();
			authStorage.close();
		}
		expect(controller.activeLaunchCount).toBe(0);
	});

	it("rejects isolation mismatches before setup and releases cancellation leases", async () => {
		const root = makeRoot(roots);
		const worktreeController = new TaskExecutionPolicyController(makePolicy({ isolation: "worktree" }));
		const worktreeResult = await runSubprocess({
			...executorOptions(root, "0-PolicyWorktreeMismatch"),
			executionPolicyController: worktreeController,
		});
		expect(worktreeResult.error).toContain("worktree isolation owner");
		expect(worktreeResult.setupFailure?.summary).toContain("worktree isolation owner");
		expect(worktreeResult.durationMs).toBe(0);
		expect(worktreeController.activeLaunchCount).toBe(0);

		const worktreePath = path.join(root, "unexpected-worktree");
		const currentController = new TaskExecutionPolicyController(makePolicy({ isolation: "current" }));
		const currentResult = await runSubprocess({
			...executorOptions(root, "0-PolicyCurrentMismatch"),
			worktree: worktreePath,
			executionPolicyController: currentController,
		});
		expect(currentResult.error).toContain("current-session isolation");
		expect(currentResult.setupFailure?.summary).toContain("current-session isolation");
		expect(currentResult.durationMs).toBe(0);
		expect(currentController.activeLaunchCount).toBe(0);
		expect(fs.existsSync(worktreePath)).toBe(false);

		const cancelledRoot = makeRoot(roots);
		const artifactsDir = path.join(cancelledRoot, "artifacts");
		const cancelledController = new TaskExecutionPolicyController(
			makePolicy({ maxDurationMs: TASK_EXECUTION_POLICY_MIN_DURATION_MS }),
		);
		const cancelledResult = await runSubprocess({
			...executorOptions(cancelledRoot, "0-PolicyCancelled"),
			executionPolicyController: cancelledController,
			signal: AbortSignal.abort("cancelled"),
			artifactsDir,
			sessionFile: path.join(artifactsDir, "child.jsonl"),
		});
		expect(cancelledResult.aborted).toBe(true);
		expect(cancelledResult.error).toContain("Cancelled before start");
		expect(cancelledController.activeLaunchCount).toBe(0);
		expect(fs.existsSync(artifactsDir)).toBe(false);
	});

	it("rejects unsupported policy fields", () => {
		const unsupportedFields: Record<string, unknown>[] = [
			{ permissionProfile: "standard" },
			{ runtimeLocation: "sandbox" },
			{ cost: "low" },
			{ model: "gpt-5" },
			{ workMode: "plan" },
		];

		for (const field of unsupportedFields) {
			const input = { ...makePolicy(), ...field };
			const compiled = compileTaskExecutionPolicy(input);
			expect(compiled.ok).toBe(false);
			if (!compiled.ok) expect(compiled.error.code).toBe("unknown_field");

			const controller = new TaskExecutionPolicyController();
			const applied = controller.tryApply(input);
			expect(applied.ok).toBe(false);
			if (!applied.ok) expect(applied.error.code).toBe("unknown_field");
			expect(controller.activeLaunchCount).toBe(0);
		}
	});
});
