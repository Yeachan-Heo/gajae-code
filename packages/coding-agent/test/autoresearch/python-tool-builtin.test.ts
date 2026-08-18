import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentTool, type AgentToolResult } from "@gajae-code/agent-core";
import { getBundledModel } from "@gajae-code/ai/core";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import * as pyExecutor from "@gajae-code/coding-agent/eval/py/executor";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { TempDir } from "@gajae-code/utils";
import {
	AUTORESEARCH_PYTHON_TOOL_NAME,
	AUTORESEARCH_PYTHON_TOOL_NO_MISSION_ERROR,
	autoresearchKernelOwnerId,
} from "../../src/autoresearch/python-tool";
import { autoresearchClear, autoresearchWrite } from "../../src/gjc-runtime/autoresearch-runtime";
import { BUILTIN_TOOL_DESCRIPTORS, BUILTIN_TOOLS, createTools, type ToolSession } from "../../src/tools";

const TEST_SESSION_ID = "test-session";
let previousGjcSessionId: string | undefined;

// The mission resolver writes and reads state, which requires an explicit
// session id. Pin one rather than inheriting the ambient GJC_SESSION_ID, which
// is present when this suite runs inside a live GJC session and absent on a
// clean runner -- that difference made these tests pass locally while failing
// in CI with SessionResolutionError.
beforeAll(() => {
	previousGjcSessionId = process.env.GJC_SESSION_ID;
	process.env.GJC_SESSION_ID = TEST_SESSION_ID;
});

afterAll(() => {
	if (previousGjcSessionId === undefined) {
		delete process.env.GJC_SESSION_ID;
	} else {
		process.env.GJC_SESSION_ID = previousGjcSessionId;
	}
});

function textOf(result: AgentToolResult): string {
	return result.content.map(block => (block.type === "text" ? block.text : "")).join("\n");
}

/** Minimal ToolSession for the production loader; the discovery-mode default matches prod. */
function makeToolSession(
	cwd: string,
	registerSessionCleanup?: (cleanup: () => Promise<void> | void) => void,
	sessionId: string = TEST_SESSION_ID,
): ToolSession {
	const session: ToolSession = {
		cwd,
		hasUI: false,
		settings: Settings.isolated(),
		requireYieldTool: false,
		enableLsp: true,
		taskDepth: 0,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		getSessionId: () => sessionId,
	};
	if (registerSessionCleanup) {
		session.registerSessionCleanup = cleanup => {
			registerSessionCleanup(cleanup);
			return () => {};
		};
	}
	return session;
}

function mockPythonResult(output = "ok"): pyExecutor.PythonResult {
	return {
		output,
		exitCode: 0,
		cancelled: false,
		truncated: false,
		totalLines: output.length > 0 ? 1 : 0,
		totalBytes: output.length,
		outputLines: output.length > 0 ? 1 : 0,
		outputBytes: output.length,
		displayOutputs: [],
		stdinRequested: false,
	};
}

async function createMission(cwd: string, slug: string): Promise<void> {
	await autoresearchWrite({
		cwd,
		objective: "Optimize the tokenizer hot path",
		mode: "web",
		deliverables: ["Benchmark report"],
		constraints: ["No public API change"],
		slug,
		sessionId: TEST_SESSION_ID,
	});
}

/** Session constructed with the shared registry produced by createTools (mirrors production). */
async function createSessionFixture(
	toolRegistry: Map<string, AgentTool>,
	onSessionCreated?: (session: AgentSession) => void,
): Promise<{ session: AgentSession; cleanup: () => Promise<void> }> {
	const tempDir = TempDir.createSync("@ar-python-builtin-");
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
		discoveryMode: "all",
	});
	// The production SDK wires the ToolSession cleanup seam to the live session
	// after construction; mirror that here so the loader's registration lands in
	// the session disposal path (drained on graceful dispose and signal exit).
	onSessionCreated?.(session);
	return {
		session,
		cleanup: async () => {
			await session.dispose();
			authStorage.close();
			tempDir.removeSync();
		},
	};
}

describe("autoresearch mission python tool — production builtin wiring", () => {
	const sessionCleanups: Array<() => Promise<void>> = [];
	const tempDirs: TempDir[] = [];

	function tempDir(): string {
		const dir = TempDir.createSync("@ar-python-builtin-");
		tempDirs.push(dir);
		return dir.path();
	}

	afterEach(async () => {
		for (const cleanup of sessionCleanups.splice(0)) await cleanup();
		for (const dir of tempDirs.splice(0)) dir.removeSync();
		await pyExecutor.disposeAllKernelSessions();
		vi.restoreAllMocks();
	});

	it("registers python in the builtin registry as discoverable, deferred, and not active by default", async () => {
		const descriptor = BUILTIN_TOOL_DESCRIPTORS[AUTORESEARCH_PYTHON_TOOL_NAME];
		expect(descriptor).toBeDefined();
		expect(descriptor.metadata.name).toBe(AUTORESEARCH_PYTHON_TOOL_NAME);
		expect(descriptor.metadata.name).toBe("python");
		expect(descriptor.metadata.loadMode).toBe("discoverable");
		expect(descriptor.metadata.deferrable).toBe(true);
		expect(descriptor.presentation.label).toBe("Python");
		expect(typeof descriptor.metadata.summary).toBe("string");
		expect(descriptor.metadata.summary?.length).toBeGreaterThan(0);
		expect(typeof descriptor.metadata.description).toBe("string");
		// The descriptor advertises the wire schema so the deferred facade can be
		// serialized for the provider before its loader ever runs.
		expect(descriptor.metadata.parameters).toBeDefined();
		expect(descriptor.metadata.parameters).toMatchObject({
			type: "object",
			properties: { action: expect.anything(), code: expect.anything() },
		});

		// createTools (discovery "all", the production default) defers the tool:
		// registered but not part of the initial active set.
		const cwd = tempDir();
		const toolSession = makeToolSession(cwd);
		const tools = await createTools(toolSession);
		const facade = tools.find(tool => tool.name === AUTORESEARCH_PYTHON_TOOL_NAME);
		expect(facade).toBeDefined();
		expect(facade?.loadMode).toBe("discoverable");
		expect(facade?.deferrable).toBe(true);
	});

	it("loads through the descriptor loader into a callable tool", async () => {
		const cwd = tempDir();
		const toolSession = makeToolSession(cwd);
		const tool = await BUILTIN_TOOL_DESCRIPTORS[AUTORESEARCH_PYTHON_TOOL_NAME].load(toolSession);
		expect(tool).not.toBeNull();
		expect(tool!.name).toBe(AUTORESEARCH_PYTHON_TOOL_NAME);
		expect(typeof tool!.execute).toBe("function");
	});

	it("fails closed with no active mission, starts no kernel, and names `gjc autoresearch`", async () => {
		const cwd = tempDir();
		const executeSpy = vi.spyOn(pyExecutor, "executePython");
		try {
			const toolSession = makeToolSession(cwd);
			const tool = await BUILTIN_TOOLS[AUTORESEARCH_PYTHON_TOOL_NAME](toolSession);
			expect(tool).not.toBeNull();

			const executed = await tool!.execute("call-no-mission", { code: "print(1)" });
			expect(executed.isError).toBe(true);
			expect(textOf(executed)).toBe(AUTORESEARCH_PYTHON_TOOL_NO_MISSION_ERROR);
			expect(textOf(executed)).toContain("gjc autoresearch");

			const cleared = await tool!.execute("call-no-mission-clear", { action: "clear" });
			expect(cleared.isError).toBe(true);
			expect(executeSpy).not.toHaveBeenCalled();
		} finally {
			executeSpy.mockRestore();
		}
	});

	it("resolves the active mission per call and uses owner autoresearch:<mission-id>", async () => {
		const cwd = tempDir();
		await createMission(cwd, "tokenizer-mission");
		const executeSpy = vi.spyOn(pyExecutor, "executePython").mockResolvedValue(mockPythonResult());
		try {
			const toolSession = makeToolSession(cwd);
			const tool = await BUILTIN_TOOLS[AUTORESEARCH_PYTHON_TOOL_NAME](toolSession);
			expect(tool).not.toBeNull();

			const result = await tool!.execute("call-mission", { code: "x = 1" });
			expect(result.isError).toBeUndefined();
			expect(executeSpy).toHaveBeenCalledTimes(1);
			const options = executeSpy.mock.calls[0]?.[1] as { sessionId: string; kernelOwnerId: string };
			expect(options.sessionId).toBe(autoresearchKernelOwnerId(TEST_SESSION_ID, "tokenizer-mission"));
			expect(options.kernelOwnerId).toBe(autoresearchKernelOwnerId(TEST_SESSION_ID, "tokenizer-mission"));
			expect(options.kernelOwnerId).toBe(`autoresearch:${TEST_SESSION_ID}:tokenizer-mission`);
		} finally {
			executeSpy.mockRestore();
		}
	});

	it("derives the same kernel owner as the public clear verb, so clearing reaps the live kernel", async () => {
		// Regression: the live tool used a slug-only owner while `gjc autoresearch
		// clear` disposed a session-scoped one, so clear never reached the running
		// kernel and two sessions on the same slug shared state.
		const cwd = tempDir();
		await createMission(cwd, "owner-agreement-mission");
		const executeSpy = vi.spyOn(pyExecutor, "executePython").mockResolvedValue(mockPythonResult());
		const disposeSpy = vi.spyOn(pyExecutor, "disposeKernelSessionsByOwner").mockResolvedValue(undefined);
		try {
			const tool = await BUILTIN_TOOLS[AUTORESEARCH_PYTHON_TOOL_NAME](makeToolSession(cwd));
			await tool!.execute("call-exec", { code: "x = 1" });
			const liveOwner = (executeSpy.mock.calls[0]?.[1] as { kernelOwnerId: string }).kernelOwnerId;

			// The public clear verb resolves its own owner from mission state.
			await autoresearchClear(cwd, TEST_SESSION_ID);

			expect(disposeSpy).toHaveBeenCalledWith(liveOwner);
		} finally {
			executeSpy.mockRestore();
			disposeSpy.mockRestore();
		}
	});

	it("scopes the kernel owner per session so two sessions on the same slug do not share a kernel", async () => {
		const cwdA = tempDir();
		const cwdB = tempDir();
		await createMission(cwdA, "shared-slug");
		const executeSpy = vi.spyOn(pyExecutor, "executePython").mockResolvedValue(mockPythonResult());
		try {
			const toolA = await BUILTIN_TOOLS[AUTORESEARCH_PYTHON_TOOL_NAME](makeToolSession(cwdA));
			await toolA!.execute("a", { code: "x = 1" });
			const ownerA = (executeSpy.mock.calls[0]?.[1] as { kernelOwnerId: string }).kernelOwnerId;

			// Same slug, different GJC session id.
			await autoresearchWrite({
				cwd: cwdB,
				objective: "Same slug, other session",
				mode: "web",
				deliverables: ["d"],
				constraints: ["c"],
				slug: "shared-slug",
				sessionId: "other-session",
			});
			const toolB = await BUILTIN_TOOLS[AUTORESEARCH_PYTHON_TOOL_NAME](
				makeToolSession(cwdB, undefined, "other-session"),
			);
			await toolB!.execute("b", { code: "y = 2" });
			const ownerB = (executeSpy.mock.calls[1]?.[1] as { kernelOwnerId: string }).kernelOwnerId;

			expect(ownerA).not.toBe(ownerB);
			expect(ownerA).toContain(TEST_SESSION_ID);
			expect(ownerB).toContain("other-session");
		} finally {
			executeSpy.mockRestore();
		}
	});

	it("keeps clear on the same tool; no separate teardown tool is registered", async () => {
		const cwd = tempDir();
		await createMission(cwd, "tokenizer-mission");
		const disposeSpy = vi.spyOn(pyExecutor, "disposeKernelSessionsByOwner").mockResolvedValue(undefined);
		try {
			const toolSession = makeToolSession(cwd);
			const tool = await BUILTIN_TOOLS[AUTORESEARCH_PYTHON_TOOL_NAME](toolSession);
			expect(tool).not.toBeNull();

			const cleared = await tool!.execute("call-clear", { action: "clear" });
			expect(cleared.isError).toBeUndefined();
			expect(textOf(cleared)).toContain("cleared");
			expect(disposeSpy).toHaveBeenCalledWith(`autoresearch:${TEST_SESSION_ID}:tokenizer-mission`);

			// The clear action lives on the single `python` tool — no teardown tool
			// is registered anywhere in the builtin registry.
			for (const teardownName of ["clear", "python_clear", "python_teardown", "teardown"]) {
				expect(BUILTIN_TOOL_DESCRIPTORS[teardownName]).toBeUndefined();
			}
			expect(BUILTIN_TOOL_DESCRIPTORS[AUTORESEARCH_PYTHON_TOOL_NAME]).toBeDefined();
		} finally {
			disposeSpy.mockRestore();
		}
	});

	it("activates through the discovery path and becomes callable in a live session", async () => {
		const cwd = tempDir();
		await createMission(cwd, "discovery-mission");
		// The production SDK wires the ToolSession cleanup seam to the live
		// session's disposal path only AFTER the session exists; the loader runs
		// lazily on first activation, so a forwarder captured before construction
		// resolves to the live session exactly like the production closure.
		const cleanupRegistrarHolder: { current?: (cleanup: () => Promise<void> | void) => void } = {};
		const toolSession = makeToolSession(cwd, cleanup => cleanupRegistrarHolder.current?.(cleanup));
		const tools = await createTools(toolSession);
		const registry = new Map(tools.map(tool => [tool.name, tool]));

		const { session, cleanup } = await createSessionFixture(registry, liveSession => {
			cleanupRegistrarHolder.current = cleanup => liveSession.registerToolSessionCleanup(cleanup);
		});
		sessionCleanups.push(cleanup);
		const executeSpy = vi.spyOn(pyExecutor, "executePython").mockResolvedValue(mockPythonResult());
		const disposeSpy = vi.spyOn(pyExecutor, "disposeKernelSessionsByOwner").mockResolvedValue(undefined);
		try {
			// Not active by default, even though it is registered.
			expect(session.getAllToolNames()).toContain(AUTORESEARCH_PYTHON_TOOL_NAME);
			expect(session.getActiveToolNames()).not.toContain(AUTORESEARCH_PYTHON_TOOL_NAME);

			// Activation through the discovery path makes it callable.
			const activated = await session.activateDiscoveredTools([AUTORESEARCH_PYTHON_TOOL_NAME]);
			expect(activated).toEqual([AUTORESEARCH_PYTHON_TOOL_NAME]);
			expect(session.getActiveToolNames()).toContain(AUTORESEARCH_PYTHON_TOOL_NAME);

			const tool = session.getToolByName(AUTORESEARCH_PYTHON_TOOL_NAME);
			expect(tool).toBeDefined();
			const result = await tool!.execute("call-discovery", { code: "x = 1" });
			expect(result.isError).toBeUndefined();
			expect(executeSpy).toHaveBeenCalledTimes(1);

			// The registered mission disposer is drained on graceful dispose and the
			// mission owner stays distinct from the session eval owner.
			await session.dispose();
			const disposedOwners = disposeSpy.mock.calls.map(call => call[0] as string);
			expect(disposedOwners).toContain(`autoresearch:${TEST_SESSION_ID}:discovery-mission`);
			const otherOwners = disposedOwners.filter(
				owner => owner !== `autoresearch:${TEST_SESSION_ID}:discovery-mission`,
			);
			expect(otherOwners).toHaveLength(1);
			expect(otherOwners[0]?.startsWith("agent-session:")).toBe(true);
			expect(cleanupRegistrarHolder.current).toBeDefined();
		} finally {
			executeSpy.mockRestore();
			disposeSpy.mockRestore();
		}
	});
});
