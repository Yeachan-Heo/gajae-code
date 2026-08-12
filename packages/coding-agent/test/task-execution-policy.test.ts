import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../src/config/settings";
import { type CreateAgentSessionResult, createAgentSession } from "../src/sdk/session";
import { SessionManager } from "../src/session/session-manager";
import { TaskTool } from "../src/task";
import * as discoveryModule from "../src/task/discovery";
import {
	bindTaskExecutionPolicyController,
	compileTaskExecutionPolicy,
	DEFAULT_TASK_EXECUTION_POLICY,
	getTaskExecutionPolicyController,
	isTaskMcpAllowed,
	isTaskToolAllowed,
	TASK_EXECUTION_POLICY_MAX_DURATION_MS,
	TASK_EXECUTION_POLICY_MIN_DURATION_MS,
	type TaskExecutionPolicy,
	TaskExecutionPolicyController,
} from "../src/task/execution-policy";
import type { ExecutorOptions } from "../src/task/executor";
import * as executorModule from "../src/task/executor";
import type { AgentDefinition } from "../src/task/types";
import type { ToolSession } from "../src/tools";

const TEST_AGENT: AgentDefinition = {
	name: "worker",
	description: "A focused worker.",
	systemPrompt: "You are a focused worker.",
	source: "bundled",
};

function policy(overrides: Partial<TaskExecutionPolicy> = {}): TaskExecutionPolicy {
	return {
		isolation: overrides.isolation ?? "current",
		toolAccess: overrides.toolAccess ?? { allow: [], deny: [] },
		mcpDiscovery: overrides.mcpDiscovery ?? "configured",
		maxDurationMs: overrides.maxDurationMs ?? null,
		simpleMode: overrides.simpleMode ?? false,
	};
}

function createToolSession(): ToolSession {
	return {
		cwd: process.cwd(),
		hasUI: false,
		settings: Settings.isolated({ "async.enabled": false, "task.isolation.mode": "auto" }),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
	};
}

function createExecutorOptions(): ExecutorOptions {
	return {
		cwd: process.cwd(),
		agent: TEST_AGENT,
		task: "Run the focused task.",
		assignment: "Run the focused task.",
		index: 0,
		id: "0-Worker",
	};
}

describe("task execution policy", () => {
	const createdSessions: CreateAgentSessionResult[] = [];
	const temporaryDirectories: string[] = [];

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const result of createdSessions.splice(0)) await result.session.dispose();
		for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
	});

	it("rejects unknown fields, overlap, and out-of-range durations", () => {
		const unknown = compileTaskExecutionPolicy({ ...DEFAULT_TASK_EXECUTION_POLICY, workMode: "plan" });
		expect(unknown.ok).toBe(false);
		if (!unknown.ok) expect(unknown.error.code).toBe("unknown_field");

		const overlap = compileTaskExecutionPolicy(policy({ toolAccess: { allow: ["read"], deny: ["READ"] } }));
		expect(overlap.ok).toBe(false);
		if (!overlap.ok) expect(overlap.error.code).toBe("overlapping_tools");

		const tooShort = compileTaskExecutionPolicy(policy({ maxDurationMs: TASK_EXECUTION_POLICY_MIN_DURATION_MS - 1 }));
		expect(tooShort.ok).toBe(false);
		if (!tooShort.ok) expect(tooShort.error.code).toBe("invalid_duration");

		const tooLong = compileTaskExecutionPolicy(policy({ maxDurationMs: TASK_EXECUTION_POLICY_MAX_DURATION_MS + 1 }));
		expect(tooLong.ok).toBe(false);
		if (!tooLong.ok) expect(tooLong.error.code).toBe("invalid_duration");
	});

	it("freezes fingerprints and keeps acquired launches on their original revision", () => {
		const controller = new TaskExecutionPolicyController();
		const initial = controller.getSnapshot();
		const lease = controller.acquireLaunchLease();
		const next = controller.apply(policy({ maxDurationMs: TASK_EXECUTION_POLICY_MIN_DURATION_MS }));

		expect(Object.isFrozen(initial)).toBe(true);
		expect(Object.isFrozen(initial.policy)).toBe(true);
		expect(lease.snapshot.revision).toBe(initial.revision);
		expect(lease.snapshot.fingerprint).toBe(initial.fingerprint);
		expect(next.revision).toBe(initial.revision + 1);
		expect(next.fingerprint).not.toBe(initial.fingerprint);
		expect(controller.activeLaunchCount).toBe(1);
		lease.release();
		lease.release();
		expect(controller.activeLaunchCount).toBe(0);
	});

	it("isolates sessions and gives deny precedence over dynamic allow activation", () => {
		const first = new TaskExecutionPolicyController(policy({ toolAccess: { allow: ["task"], deny: ["read"] } }));
		const second = new TaskExecutionPolicyController();
		const firstSnapshot = first.getSnapshot();
		const secondSnapshot = second.getSnapshot();

		expect(isTaskToolAllowed(firstSnapshot, "read")).toBe(false);
		expect(isTaskToolAllowed(firstSnapshot, "task")).toBe(true);
		expect(isTaskToolAllowed(secondSnapshot, "read")).toBe(true);

		const oldSnapshot = first.getSnapshot();
		first.apply(policy({ toolAccess: { allow: ["read"], deny: [] } }));
		expect(isTaskToolAllowed(oldSnapshot, "read")).toBe(false);
		expect(isTaskToolAllowed(first.getSnapshot(), "read")).toBe(true);
	});

	it("fails closed for disabled MCP and preserves non-MCP tools", () => {
		const controller = new TaskExecutionPolicyController(policy({ mcpDiscovery: "disabled" }));
		const snapshot = controller.getSnapshot();

		expect(isTaskMcpAllowed(snapshot, "mcp__filesystem__read")).toBe(false);
		expect(isTaskMcpAllowed(snapshot, "read")).toBe(true);
	});

	it("forces simple independent mode without adding model or workMode policy keys", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [TEST_AGENT],
			projectAgentsDir: null,
		});
		const session = createToolSession();
		const controller = new TaskExecutionPolicyController(policy({ simpleMode: true }));
		bindTaskExecutionPolicyController(session, controller);
		const tool = await TaskTool.create(session);

		expect(tool.description).toContain("each `assignment`");
		expect(tool.description).not.toContain("- `schema`:");
		const snapshot = controller.getSnapshot();
		expect(Object.hasOwn(snapshot.policy, "model")).toBe(false);
		expect(Object.hasOwn(snapshot.policy, "workMode")).toBe(false);
	});

	it("binds one session controller to repeated TaskTool creation", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [TEST_AGENT],
			projectAgentsDir: null,
		});
		const session = createToolSession();
		const controller = new TaskExecutionPolicyController(
			policy({ maxDurationMs: TASK_EXECUTION_POLICY_MIN_DURATION_MS }),
		);
		bindTaskExecutionPolicyController(session, controller);
		await TaskTool.create(session);
		await TaskTool.create(session);
		expect(getTaskExecutionPolicyController(session)).toBe(controller);
	});

	it("rejects worktree launches without an owner and rejects current launches with a worktree", async () => {
		const worktreeController = new TaskExecutionPolicyController(policy({ isolation: "worktree" }));
		const worktreeResult = await executorModule.runSubprocess({
			...createExecutorOptions(),
			executionPolicyController: worktreeController,
		});
		expect(worktreeResult.error).toContain("worktree isolation owner");
		expect(worktreeController.activeLaunchCount).toBe(0);

		const currentController = new TaskExecutionPolicyController(policy({ isolation: "current" }));
		const currentResult = await executorModule.runSubprocess({
			...createExecutorOptions(),
			worktree: path.join(os.tmpdir(), "policy-worktree"),
			executionPolicyController: currentController,
		});
		expect(currentResult.error).toContain("current-session isolation");
		expect(currentController.activeLaunchCount).toBe(0);
	});

	it("releases a launch lease after cancellation while honoring the policy duration bound", async () => {
		const controller = new TaskExecutionPolicyController(
			policy({ maxDurationMs: TASK_EXECUTION_POLICY_MIN_DURATION_MS }),
		);
		const result = await executorModule.runSubprocess({
			...createExecutorOptions(),
			executionPolicyController: controller,
			signal: AbortSignal.abort("cancelled"),
		});

		expect(result.aborted).toBe(true);
		expect(controller.activeLaunchCount).toBe(0);
	});

	it("exposes isolated public session policy controls", async () => {
		const firstDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-policy-a-"));
		const secondDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-policy-b-"));
		temporaryDirectories.push(firstDirectory, secondDirectory);

		const first = await createAgentSession({
			cwd: firstDirectory,
			agentDir: path.join(firstDirectory, "agent"),
			sessionManager: SessionManager.inMemory(firstDirectory),
			settings: Settings.isolated(),
			taskExecutionPolicy: policy({ isolation: "worktree", simpleMode: true }),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
		});
		const second = await createAgentSession({
			cwd: secondDirectory,
			agentDir: path.join(secondDirectory, "agent"),
			sessionManager: SessionManager.inMemory(secondDirectory),
			settings: Settings.isolated(),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
		});
		createdSessions.push(first, second);
		if (
			!first.getExecutionPolicy ||
			!first.applyExecutionPolicy ||
			!first.clearExecutionPolicy ||
			!second.getExecutionPolicy ||
			!second.applyExecutionPolicy ||
			!second.clearExecutionPolicy
		)
			throw new Error("Execution policy session surface is unavailable");

		const firstSnapshot = first.getExecutionPolicy();
		expect(firstSnapshot.source.kind).toBe("session");
		expect(firstSnapshot.policy.isolation).toBe("worktree");
		expect(firstSnapshot.policy.simpleMode).toBe(true);
		expect(second.getExecutionPolicy().source.kind).toBe("default");
		expect(Object.hasOwn(firstSnapshot.policy, "model")).toBe(false);
		expect(Object.hasOwn(firstSnapshot.policy, "workMode")).toBe(false);

		const applied = second.applyExecutionPolicy(policy({ maxDurationMs: TASK_EXECUTION_POLICY_MIN_DURATION_MS }));
		expect(applied.ok).toBe(true);
		expect(first.getExecutionPolicy().policy.maxDurationMs).toBe(null);
		expect(second.getExecutionPolicy().policy.maxDurationMs).toBe(TASK_EXECUTION_POLICY_MIN_DURATION_MS);

		const cleared = first.clearExecutionPolicy();
		expect(cleared.source.kind).toBe("default");
		expect(cleared.revision).toBe(firstSnapshot.revision + 1);
	});
});
