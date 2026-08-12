import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentTool, type AgentToolResult } from "@gajae-code/agent-core";
import { getBundledModel, z } from "@gajae-code/ai/core";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import * as pyExecutor from "@gajae-code/coding-agent/eval/py/executor";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { TempDir } from "@gajae-code/utils";
import {
	AUTORESEARCH_PYTHON_TOOL_NAME,
	autoresearchKernelOwnerId,
	createAutoresearchPythonTool,
} from "../../src/autoresearch/python-tool";
import type { ToolDefinition } from "../../src/extensibility/extensions/types";
import { applyToolProxy } from "../../src/extensibility/tool-proxy";
import { RlmNotebookWriter } from "../../src/rlm/notebook";

const KERNEL_TEST_TIMEOUT_MS = 35_000;

/** Params accepted by the mission python tool: `action` defaults to "execute". */
type ToolCallParams = { action?: "execute" | "clear"; code?: string };

/** A tool the mission may merge alongside `python` to prove full-list activation semantics. */
function createBasicAgentTool(name: string): AgentTool {
	return {
		name,
		label: name,
		description: `${name} tool`,
		parameters: z.object({ value: z.string() }),
		strict: true,
		async execute() {
			return { content: [{ type: "text", text: `${name} executed` }] };
		},
	};
}

/**
 * Adapts a ToolDefinition into the AgentTool shape the session registry holds,
 * using the same proxy mechanism as the production RegisteredToolAdapter.
 */
function toAgentTool(definition: ToolDefinition): AgentTool {
	const agentTool = {
		async execute(toolCallId: string, params: never, signal?: AbortSignal): Promise<AgentToolResult> {
			return definition.execute(toolCallId, params, signal, undefined, undefined as never);
		},
	} as AgentTool;
	applyToolProxy(definition, agentTool);
	return agentTool;
}

function createMissionTool(options: {
	cwd: string;
	getMissionId: () => string | null;
	registerSessionCleanup?: (cleanup: () => Promise<void> | void) => void;
}): ToolDefinition {
	return createAutoresearchPythonTool({
		cwd: options.cwd,
		artifactsDir: path.join(options.cwd, "artifacts"),
		notebook: new RlmNotebookWriter(path.join(options.cwd, "notebook.ipynb")),
		getMissionId: options.getMissionId,
		registerSessionCleanup: options.registerSessionCleanup ?? (() => {}),
	});
}

async function executeTool(
	tool: ToolDefinition,
	params: ToolCallParams,
	signal?: AbortSignal,
): Promise<AgentToolResult> {
	return await tool.execute("test-call", params, signal, undefined, undefined as never);
}

function textOf(result: AgentToolResult): string {
	return result.content.map(block => (block.type === "text" ? block.text : "")).join("\n");
}

/** Session constructed with a shared mutable registry (mirrors the production seam). */
async function createSessionFixture(toolRegistry: Map<string, AgentTool>): Promise<{
	session: AgentSession;
	cwd: string;
	cleanup: () => Promise<void>;
}> {
	const tempDir = TempDir.createSync("@ar-python-tool-");
	const authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const modelRegistry = new ModelRegistry(authStorage);
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected bundled anthropic model to exist");
	const agent = new Agent({
		initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
	});
	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated(),
		modelRegistry,
		toolRegistry,
	});
	return {
		session,
		cwd: tempDir.path(),
		cleanup: async () => {
			await session.dispose();
			authStorage.close();
			tempDir.removeSync();
		},
	};
}

describe("autoresearch mission python tool", () => {
	const sessionCleanups: Array<() => Promise<void>> = [];

	afterEach(async () => {
		delete Bun.env.PI_PYTHON_SKIP_CHECK;
		for (const cleanup of sessionCleanups.splice(0)) await cleanup();
		await pyExecutor.disposeAllKernelSessions();
		vi.restoreAllMocks();
	});

	describe("definition", () => {
		it("is a ToolDefinition named python, default-inactive, with no discoverable loadMode", () => {
			const tool = createMissionTool({ cwd: ".", getMissionId: () => null });

			expect(tool.name).toBe(AUTORESEARCH_PYTHON_TOOL_NAME);
			expect(tool.name).toBe("python");
			expect(tool.defaultInactive).toBe(true);
			expect(tool.label).toBe("Python");
			expect(typeof tool.description).toBe("string");
			expect(typeof tool.execute).toBe("function");
			// ToolDefinition has no `loadMode`; that field governs built-in discovery only
			// (agent-session.ts #collectDiscoverableBuiltinTools), so this tool can never
			// be picked up by activateDiscoveredTools.
			expect("loadMode" in tool).toBe(false);
		});

		it("widens the { code } schema with an action that defaults to execute", () => {
			const tool = createAutoresearchPythonTool({
				cwd: ".",
				artifactsDir: path.join(".", "artifacts"),
				notebook: new RlmNotebookWriter(path.join(".", "notebook.ipynb")),
				getMissionId: () => null,
				registerSessionCleanup: () => {},
			});

			// Existing `{ code }` calls remain valid and mean execute.
			expect(tool.parameters.parse({ code: "x = 1" })).toEqual({ action: "execute", code: "x = 1" });
			// The clear action needs no code.
			expect(tool.parameters.parse({ action: "clear" })).toEqual({ action: "clear" });
			expect(tool.parameters.parse({ action: "execute", code: "print(1)" })).toEqual({
				action: "execute",
				code: "print(1)",
			});
		});

		it("registers the mission-owner disposer with the session disposal path at construction", () => {
			const registered: Array<() => Promise<void> | void> = [];
			createMissionTool({
				cwd: ".",
				getMissionId: () => "mission-register",
				registerSessionCleanup: cleanup => registered.push(cleanup),
			});

			expect(registered).toHaveLength(1);
		});

		it("refuses execute and clear when no mission is active", async () => {
			const executeSpy = vi.spyOn(pyExecutor, "executePython");
			try {
				const tool = createMissionTool({ cwd: ".", getMissionId: () => null });

				const executed = await executeTool(tool, { code: "print(1)" });
				expect(executed.isError).toBe(true);
				expect(executeSpy).not.toHaveBeenCalled();

				const cleared = await executeTool(tool, { action: "clear" });
				expect(cleared.isError).toBe(true);
				expect(executeSpy).not.toHaveBeenCalled();
			} finally {
				executeSpy.mockRestore();
			}
		});

		it("clear disposes the mission owner via disposeKernelSessionsByOwner", async () => {
			const disposeSpy = vi.spyOn(pyExecutor, "disposeKernelSessionsByOwner").mockResolvedValue(undefined);
			try {
				const tool = createMissionTool({ cwd: ".", getMissionId: () => "mission-clear" });

				const result = await executeTool(tool, { action: "clear" });

				expect(result.isError).toBeUndefined();
				expect(textOf(result)).toContain("cleared");
				expect(disposeSpy).toHaveBeenCalledTimes(1);
				expect(disposeSpy).toHaveBeenCalledWith("autoresearch:mission-clear");
			} finally {
				disposeSpy.mockRestore();
			}
		});
	});

	describe("session integration (construction registration + full-list activation)", () => {
		it("is in the session registry at construction but not active by default", async () => {
			const registry = new Map<string, AgentTool>();
			const { session, cwd, cleanup } = await createSessionFixture(registry);
			sessionCleanups.push(cleanup);
			registry.set("python", toAgentTool(createMissionTool({ cwd, getMissionId: () => "mission-registry" })));
			registry.set("read", createBasicAgentTool("read"));

			expect(session.getAllToolNames().sort()).toEqual(["python", "read"]);
			expect(session.getActiveToolNames()).toEqual([]);
		});

		it("activates python via setActiveToolsByName with the full merged list", async () => {
			const registry = new Map<string, AgentTool>();
			const { session, cwd, cleanup } = await createSessionFixture(registry);
			sessionCleanups.push(cleanup);
			registry.set("python", toAgentTool(createMissionTool({ cwd, getMissionId: () => "mission-activate" })));
			registry.set("read", createBasicAgentTool("read"));

			await session.setActiveToolsByName(["read"]);
			expect(session.getActiveToolNames()).toEqual(["read"]);

			// The mission activation pattern: merge, never replace with just ["python"].
			await session.setActiveToolsByName([...session.getActiveToolNames(), "python"]);
			expect(session.getActiveToolNames().sort()).toEqual(["python", "read"]);
		});

		it("proves setActiveToolsByName replaces the active set: a merge that drops names deactivates them", async () => {
			const registry = new Map<string, AgentTool>();
			const { session, cwd, cleanup } = await createSessionFixture(registry);
			sessionCleanups.push(cleanup);
			registry.set("python", toAgentTool(createMissionTool({ cwd, getMissionId: () => "mission-drop" })));
			registry.set("read", createBasicAgentTool("read"));

			await session.setActiveToolsByName(["read", "python"]);
			expect(session.getActiveToolNames().sort()).toEqual(["python", "read"]);

			// Passing only ["python"] would silently drop "read" — the setter replaces the
			// whole active set, which is why the mission must pass the full merged list.
			await session.setActiveToolsByName(["python"]);
			expect(session.getActiveToolNames()).toEqual(["python"]);
			expect(session.getActiveToolNames()).not.toContain("read");
		});

		it("silently drops unregistered names, so construction-time registration is mandatory", async () => {
			const registry = new Map<string, AgentTool>();
			const { session, cwd, cleanup } = await createSessionFixture(registry);
			sessionCleanups.push(cleanup);
			registry.set("python", toAgentTool(createMissionTool({ cwd, getMissionId: () => "mission-unknown" })));
			registry.set("read", createBasicAgentTool("read"));

			await session.setActiveToolsByName(["read"]);
			await session.setActiveToolsByName([...session.getActiveToolNames(), "no-such-tool"]);

			expect(session.getActiveToolNames()).toEqual(["read"]);
		});

		it("registers no separate clear/teardown tool — python is the only mission tool", async () => {
			const registry = new Map<string, AgentTool>();
			const { session, cwd, cleanup } = await createSessionFixture(registry);
			sessionCleanups.push(cleanup);
			registry.set("python", toAgentTool(createMissionTool({ cwd, getMissionId: () => "mission-solo" })));
			registry.set("read", createBasicAgentTool("read"));
			await session.setActiveToolsByName([...session.getActiveToolNames(), "python"]);

			expect(session.getAllToolNames().sort()).toEqual(["python", "read"]);
			expect(session.getToolByName("python")).toBeDefined();
			for (const teardownName of ["clear", "python_clear", "python_teardown", "teardown"]) {
				expect(session.getToolByName(teardownName)).toBeUndefined();
			}
		});

		it("keeps the mission owner distinct from the session eval kernel owner (f33)", async () => {
			const disposeSpy = vi.spyOn(pyExecutor, "disposeKernelSessionsByOwner").mockResolvedValue(undefined);
			try {
				const registry = new Map<string, AgentTool>();
				const { session, cwd, cleanup } = await createSessionFixture(registry);
				sessionCleanups.push(cleanup);
				const missionOwner = autoresearchKernelOwnerId("mission-f33");
				expect(missionOwner).toBe("autoresearch:mission-f33");
				const missionTool = createMissionTool({
					cwd,
					getMissionId: () => "mission-f33",
					registerSessionCleanup: registered => session.registerToolSessionCleanup(registered),
				});
				registry.set("python", toAgentTool(missionTool));
				registry.set("read", createBasicAgentTool("read"));
				await session.setActiveToolsByName(["read", "python"]);
				// Record the mission owner through a real tool call (mirrors a mission that
				// ran a cell, which is what actually owns a kernel subprocess).
				await executeTool(missionTool, { action: "clear" });

				// Graceful dispose drains the registered mission-owner disposer AND the
				// session's own eval-owner disposal; the two owners must never alias.
				await session.dispose();
				const disposedOwners = disposeSpy.mock.calls.map(call => call[0] as string);
				expect(disposedOwners).toContain(missionOwner);
				const otherOwners = disposedOwners.filter(owner => owner !== missionOwner);
				expect(otherOwners).toHaveLength(1);
				expect(otherOwners[0]?.startsWith("agent-session:")).toBe(true);
			} finally {
				disposeSpy.mockRestore();
			}
		});
	});

	describe("persistent mission kernel", () => {
		it(
			"persists variables and imports across calls within one mission kernel",
			async () => {
				Bun.env.PI_PYTHON_SKIP_CHECK = "1";
				using tempDir = TempDir.createSync("@ar-python-persist-");
				const notebook = new RlmNotebookWriter(path.join(tempDir.path(), "notebook.ipynb"));
				const tool = createAutoresearchPythonTool({
					cwd: tempDir.path(),
					artifactsDir: path.join(tempDir.path(), "artifacts"),
					notebook,
					getMissionId: () => "mission-persist",
					registerSessionCleanup: () => {},
				});

				const seeded = await executeTool(tool, { code: "answer = 41\nimport json" });
				expect(seeded.isError).toBeUndefined();

				// Variable state survives from the previous call.
				expect(textOf(await executeTool(tool, { code: "print(answer + 1)" }))).toContain("42");
				// Imports survive too.
				expect(textOf(await executeTool(tool, { code: "print(json.dumps({'ok': True}))" }))).toContain(
					'"ok": true',
				);
				// Every executed cell is recorded in the mission notebook.
				expect(notebook.cellCount).toBe(3);
			},
			KERNEL_TEST_TIMEOUT_MS,
		);

		it(
			"clear disposes the mission kernel; the next execute starts a fresh kernel",
			async () => {
				Bun.env.PI_PYTHON_SKIP_CHECK = "1";
				using tempDir = TempDir.createSync("@ar-python-clear-");
				const notebook = new RlmNotebookWriter(path.join(tempDir.path(), "notebook.ipynb"));
				const tool = createAutoresearchPythonTool({
					cwd: tempDir.path(),
					artifactsDir: path.join(tempDir.path(), "artifacts"),
					notebook,
					getMissionId: () => "mission-clear-kernel",
					registerSessionCleanup: () => {},
				});

				await executeTool(tool, { code: "answer = 7" });
				expect(textOf(await executeTool(tool, { code: "print(answer)" }))).toContain("7");

				const cleared = await executeTool(tool, { action: "clear" });
				expect(textOf(cleared)).toContain("cleared");

				// Fresh kernel: the old variable is gone, proving the subprocess was reaped.
				const fresh = await executeTool(tool, { code: "print(answer)" });
				expect(fresh.isError).toBeUndefined();
				expect(textOf(fresh)).toContain("NameError");
			},
			KERNEL_TEST_TIMEOUT_MS,
		);
	});
});
