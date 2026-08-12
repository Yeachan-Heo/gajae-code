import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { type CreateAgentSessionResult, createAgentSession } from "../src/sdk/session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";
import { TaskTool } from "../src/task";
import * as discoveryModule from "../src/task/discovery";
import {
	bindTaskExecutionPolicyController,
	DEFAULT_TASK_EXECUTION_POLICY,
	getTaskExecutionPolicyController,
	type TaskExecutionPolicy,
	TaskExecutionPolicyController,
} from "../src/task/execution-policy";
import type { ToolSession } from "../src/tools";

type ExecutionPolicySurface = Required<
	Pick<CreateAgentSessionResult, "getExecutionPolicy" | "applyExecutionPolicy" | "clearExecutionPolicy">
>;

type SessionFixture = {
	result: CreateAgentSessionResult;
	authStorage: AuthStorage;
};

const INITIAL_POLICY: TaskExecutionPolicy = {
	isolation: "worktree",
	toolAccess: { allow: ["task"], deny: ["read"] },
	mcpDiscovery: "disabled",
	maxDurationMs: 1_000,
	simpleMode: true,
};

const UPDATED_POLICY: TaskExecutionPolicy = {
	isolation: "current",
	toolAccess: { allow: ["task"], deny: [] },
	mcpDiscovery: "configured",
	maxDurationMs: 2_000,
	simpleMode: false,
};

function policySurface(result: CreateAgentSessionResult): ExecutionPolicySurface {
	const getExecutionPolicy = result.getExecutionPolicy;
	const applyExecutionPolicy = result.applyExecutionPolicy;
	const clearExecutionPolicy = result.clearExecutionPolicy;
	if (
		typeof getExecutionPolicy !== "function" ||
		typeof applyExecutionPolicy !== "function" ||
		typeof clearExecutionPolicy !== "function"
	) {
		throw new Error("createAgentSession did not expose execution policy controls");
	}
	return { getExecutionPolicy, applyExecutionPolicy, clearExecutionPolicy };
}

async function createSessionFixture(root: string, taskExecutionPolicy?: TaskExecutionPolicy): Promise<SessionFixture> {
	const authStorage = await AuthStorage.create(path.join(root, "auth.db"));
	const modelRegistry = new ModelRegistry(authStorage, path.join(root, "models.yml"));
	try {
		const result = await createAgentSession({
			cwd: root,
			agentDir: path.join(root, "agent"),
			authStorage,
			modelRegistry,
			sessionManager: SessionManager.inMemory(root),
			settings: Settings.isolated(),
			taskExecutionPolicy,
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
		});
		return { result, authStorage };
	} catch (error) {
		authStorage.close();
		throw error;
	}
}

function createTaskToolSession(): ToolSession {
	return {
		cwd: process.cwd(),
		hasUI: false,
		settings: Settings.isolated({ "task.isolation.mode": "auto", "async.enabled": false }),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
	};
}

describe("createAgentSession task execution policy integration", () => {
	it("isolates real sessions, reuses TaskTool policy bindings, and cleans up on dispose", async () => {
		const firstRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-agent-policy-first-"));
		const secondRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-agent-policy-second-"));
		let firstFixture: SessionFixture | undefined;
		let secondFixture: SessionFixture | undefined;
		try {
			firstFixture = await createSessionFixture(firstRoot, INITIAL_POLICY);
			secondFixture = await createSessionFixture(secondRoot);
			const firstSurface = policySurface(firstFixture.result);
			const secondSurface = policySurface(secondFixture.result);

			const firstInitial = firstSurface.getExecutionPolicy();
			const secondInitial = secondSurface.getExecutionPolicy();
			expect(firstInitial.policy).toEqual(INITIAL_POLICY);
			expect(firstInitial.source.kind).toBe("session");
			expect(secondInitial.policy).toEqual(DEFAULT_TASK_EXECUTION_POLICY);
			expect(secondInitial.source.kind).toBe("default");
			expect(Object.hasOwn(firstInitial.policy, "model")).toBe(false);
			expect(Object.hasOwn(firstInitial.policy, "workMode")).toBe(false);
			expect(Object.hasOwn(secondInitial.policy, "model")).toBe(false);
			expect(Object.hasOwn(secondInitial.policy, "workMode")).toBe(false);

			const firstApplied = firstSurface.applyExecutionPolicy(UPDATED_POLICY);
			if (!firstApplied.ok) throw new Error(firstApplied.error.message);
			expect(firstApplied.snapshot.policy).toEqual(UPDATED_POLICY);
			expect(secondSurface.getExecutionPolicy()).toEqual(secondInitial);

			const firstCleared = firstSurface.clearExecutionPolicy();
			expect(firstCleared.source.kind).toBe("default");
			expect(firstCleared.policy).toEqual(DEFAULT_TASK_EXECUTION_POLICY);
			expect(firstSurface.getExecutionPolicy()).toEqual(firstCleared);

			const secondApplied = secondSurface.applyExecutionPolicy(INITIAL_POLICY);
			if (!secondApplied.ok) throw new Error(secondApplied.error.message);
			expect(secondApplied.snapshot.policy).toEqual(INITIAL_POLICY);
			expect(firstSurface.getExecutionPolicy().policy).toEqual(DEFAULT_TASK_EXECUTION_POLICY);

			const secondCleared = secondSurface.clearExecutionPolicy();
			expect(secondCleared.source.kind).toBe("default");
			expect(secondSurface.getExecutionPolicy()).toEqual(secondCleared);

			const discovery = vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
				agents: [],
				projectAgentsDir: null,
			});
			const toolSession = createTaskToolSession();
			const boundController = new TaskExecutionPolicyController(firstInitial.policy);
			bindTaskExecutionPolicyController(toolSession, boundController);
			const firstTaskTool = await TaskTool.create(toolSession);
			const secondTaskTool = await TaskTool.create(toolSession);
			expect(firstTaskTool).not.toBe(secondTaskTool);
			expect(discovery).toHaveBeenCalledTimes(2);

			const retrievedController = getTaskExecutionPolicyController(toolSession);
			expect(retrievedController).toBe(boundController);
			if (retrievedController === undefined)
				throw new Error("TaskTool policy controller binding was not retrievable");

			const lease = retrievedController.acquireLaunchLease();
			try {
				const leasedSnapshot = lease.snapshot;
				const leaseApplied = retrievedController.apply(UPDATED_POLICY);
				expect(leaseApplied.revision).toBe(leasedSnapshot.revision + 1);
				expect(lease.snapshot).toBe(leasedSnapshot);
				expect(lease.snapshot.fingerprint).toBe(leasedSnapshot.fingerprint);
				expect(lease.released).toBe(false);
			} finally {
				lease.release();
			}
			expect(lease.released).toBe(true);
			expect(retrievedController.activeLaunchCount).toBe(0);

			await firstFixture.result.session.dispose();
			expect(firstFixture.result.session.isDisposed).toBe(true);
			expect(firstSurface.getExecutionPolicy().source.kind).toBe("default");
			await secondFixture.result.session.dispose();
			expect(secondFixture.result.session.isDisposed).toBe(true);
		} finally {
			if (firstFixture) {
				await firstFixture.result.session.dispose();
				firstFixture.authStorage.close();
			}
			if (secondFixture) {
				await secondFixture.result.session.dispose();
				secondFixture.authStorage.close();
			}
			fs.rmSync(firstRoot, { recursive: true, force: true });
			fs.rmSync(secondRoot, { recursive: true, force: true });
			vi.restoreAllMocks();
		}
		expect(fs.existsSync(firstRoot)).toBe(false);
		expect(fs.existsSync(secondRoot)).toBe(false);
	});
});
