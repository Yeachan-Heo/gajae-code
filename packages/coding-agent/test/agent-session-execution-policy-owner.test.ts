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
	getTaskExecutionPolicyController,
	type TaskExecutionPolicy,
	TaskExecutionPolicyController,
} from "../src/task/execution-policy";
import type { ToolSession } from "../src/tools";

const INITIAL_POLICY: TaskExecutionPolicy = {
	isolation: "worktree",
	toolAccess: { allow: ["task"], deny: ["read"] },
	mcpDiscovery: "disabled",
	maxDurationMs: 1_000,
	simpleMode: true,
};

type SessionFixture = {
	readonly result: CreateAgentSessionResult;
	readonly authStorage: AuthStorage;
	readonly root: string;
};

async function createSessionFixture(prefix: string): Promise<SessionFixture> {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
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
			taskExecutionPolicy: INITIAL_POLICY,
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
		return { result, authStorage, root };
	} catch (error) {
		authStorage.close();
		fs.rmSync(root, { recursive: true, force: true });
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

describe("AgentSession execution policy ownership", () => {
	it("owns one controller per session and releases it after disposal", async () => {
		const first = await createSessionFixture("gjc-agent-policy-owner-first-");
		const second = await createSessionFixture("gjc-agent-policy-owner-second-");
		const discovery = vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [],
			projectAgentsDir: null,
		});
		try {
			const firstController = first.result.session.getExecutionPolicyController();
			const secondController = second.result.session.getExecutionPolicyController();
			if (firstController === undefined || secondController === undefined) {
				throw new Error("createAgentSession did not bind an execution policy controller");
			}
			expect(firstController).not.toBe(secondController);
			expect(first.result.session.getExecutionPolicyController()).toBe(firstController);
			expect(second.result.session.getExecutionPolicyController()).toBe(secondController);

			first.result.session.bindExecutionPolicyController(firstController);
			expect(first.result.session.getExecutionPolicyController()).toBe(firstController);
			expect(() => first.result.session.bindExecutionPolicyController(new TaskExecutionPolicyController())).toThrow(
				"AgentSession already owns a different task execution policy controller.",
			);

			const getExecutionPolicy = first.result.getExecutionPolicy;
			const applyExecutionPolicy = first.result.applyExecutionPolicy;
			if (typeof getExecutionPolicy !== "function" || typeof applyExecutionPolicy !== "function") {
				throw new Error("createAgentSession did not expose execution policy controls");
			}
			const applied = applyExecutionPolicy(INITIAL_POLICY);
			if (!applied.ok) throw new Error(applied.error.message);
			expect(applied.snapshot).toBe(firstController.getSnapshot());
			expect(getExecutionPolicy()).toBe(firstController.getSnapshot());

			const toolSession = createTaskToolSession();
			bindTaskExecutionPolicyController(toolSession, firstController);
			await TaskTool.create(toolSession);
			expect(getTaskExecutionPolicyController(toolSession)).toBe(firstController);

			await first.result.session.dispose();
			expect(first.result.session.isDisposed).toBe(true);
			expect(first.result.session.getExecutionPolicyController()).toBeUndefined();
			expect(getExecutionPolicy().source.kind).toBe("default");
			expect(second.result.session.getExecutionPolicyController()).toBe(secondController);
		} finally {
			discovery.mockRestore();
			await first.result.session.dispose();
			await second.result.session.dispose();
			first.authStorage.close();
			second.authStorage.close();
			fs.rmSync(first.root, { recursive: true, force: true });
			fs.rmSync(second.root, { recursive: true, force: true });
		}
	});
});
