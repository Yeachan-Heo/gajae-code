import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import { getBundledModel } from "@gajae-code/ai";
import { AsyncJobManager } from "@gajae-code/coding-agent/async/job-manager";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import * as internalUrls from "@gajae-code/coding-agent/internal-urls";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import type { ToolSession } from "@gajae-code/coding-agent/tools";
import { TodoWriteTool } from "@gajae-code/coding-agent/tools/implementations";
import { Snowflake } from "@gajae-code/utils";

/**
 * Regression test: /new (AgentSession.newSession) must fully switch to a new session file
 * before the call resolves.
 *
 * If it doesn't, UI code that reloads todos immediately after /new will read the old
 * session artifact dir and keep showing stale todos.
 */
describe("AgentSession newSession clears todo artifacts", () => {
	let tempDir: string;
	let session: AgentSession;
	let sessionManager: SessionManager;
	let authStorage: AuthStorage | undefined;
	let ownerManager: AsyncJobManager | undefined;

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `pi-new-session-todos-test-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });

		sessionManager = SessionManager.create(tempDir, tempDir);
		const settings = Settings.isolated();
		authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));

		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Test model not found in registry");
		}

		const toolSession: ToolSession = {
			cwd: tempDir,
			hasUI: false,
			getSessionFile: () => sessionManager.getSessionFile() ?? null,
			getSessionSpawns: () => "*",
			settings,
		};

		const agent = new Agent({
			getApiKey: () => "test",
			initialState: {
				model,
				systemPrompt: ["test"],
				tools: [new TodoWriteTool(toolSession)],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			agentId: "new-session-todos-owner",
		});

		// Must subscribe to enable session persistence hooks
		session.subscribe(() => {});
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
		}
		authStorage?.close();
		authStorage = undefined;
		await ownerManager?.dispose({ timeoutMs: 100 });
		ownerManager = undefined;
		AsyncJobManager.setInstance(undefined);
		vi.restoreAllMocks();
		if (tempDir && fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true });
		}
	});

	it("should not carry over todo state to the new session branch", async () => {
		const oldSessionFile = session.sessionFile;
		expect(oldSessionFile).toBeDefined();

		session.setTodoPhases([
			{
				name: "Tasks",
				tasks: [{ content: "do the thing", status: "pending" }],
			},
		]);
		expect(session.getTodoPhases()).toHaveLength(1);
		expect(session.getTodoPhases()[0]?.tasks).toHaveLength(1);
		await session.newSession();

		const newSessionFile = session.sessionFile;
		expect(newSessionFile).toBeDefined();
		expect(newSessionFile).not.toBe(oldSessionFile);

		expect(session.getTodoPhases()).toHaveLength(0);
	});

	it("should clear stale todo cache when branching from the first user message", async () => {
		sessionManager.appendMessage({
			role: "user",
			content: "start task",
			timestamp: Date.now(),
		});

		const branchCandidates = session.getUserMessagesForBranching();
		expect(branchCandidates).toHaveLength(1);

		session.setTodoPhases([
			{
				name: "Execution",
				tasks: [{ content: "stale from old branch", status: "in_progress" }],
			},
		]);
		expect(session.getTodoPhases()).toHaveLength(1);

		const result = await session.branch(branchCandidates[0].entryId);
		expect(result.cancelled).toBe(false);
		expect(result.selectedText).toBe("start task");
		expect(session.getTodoPhases()).toHaveLength(0);
	});

	describe("AgentSession /new successor readiness", () => {
		function localPath(name: string): string {
			return internalUrls.resolveLocalUrlToPath(`local://${name}`, {
				getArtifactsDir: () => sessionManager.getArtifactsDir(),
				getSessionId: () => sessionManager.getSessionId(),
			});
		}

		async function assertReadinessBoundary(useOwnerLease: boolean): Promise<void> {
			if (useOwnerLease) {
				ownerManager = new AsyncJobManager({ onJobComplete: async () => {} });
				AsyncJobManager.setInstance(ownerManager);
			}
			const predecessor = {
				id: session.sessionId,
				file: session.sessionFile,
				artifacts: sessionManager.getArtifactsDir(),
				workflowGate: session.getWorkflowGateEmitter(),
			};
			const predecessorMarker = localPath("predecessor-ready.txt");
			fs.writeFileSync(predecessorMarker, "predecessor");
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const initializeLocalRoot = internalUrls.initializeLocalRoot;
			const readiness = vi.spyOn(internalUrls, "initializeLocalRoot").mockImplementationOnce(async options => {
				entered.resolve();
				await release.promise;
				return await initializeLocalRoot(options);
			});
			try {
				const transition = session.newSession();
				await entered.promise;

				expect(session.sessionId).toBe(predecessor.id);
				expect(session.sessionFile).toBe(predecessor.file);
				expect(sessionManager.getArtifactsDir()).toBe(predecessor.artifacts);
				expect(session.getWorkflowGateEmitter()).toBe(predecessor.workflowGate);
				expect(localPath("predecessor-ready.txt")).toBe(predecessorMarker);
				expect(fs.readFileSync(predecessorMarker, "utf8")).toBe("predecessor");

				release.resolve();
				await expect(transition).resolves.toBe(true);
				expect(session.sessionId).not.toBe(predecessor.id);
				expect(session.sessionFile).not.toBe(predecessor.file);
				expect(sessionManager.getArtifactsDir()).not.toBe(predecessor.artifacts);
				expect(session.getWorkflowGateEmitter()).not.toBe(predecessor.workflowGate);
				const successorPath = localPath("successor-ready.txt");
				expect(fs.existsSync(path.dirname(successorPath))).toBe(true);
			} finally {
				release.resolve();
				readiness.mockRestore();
			}
		}

		it("does not publish a normal /new successor before its local root is ready", async () => {
			await assertReadinessBoundary(false);
		});

		it("does not publish an owner-lease /new successor before its local root is ready", async () => {
			await assertReadinessBoundary(true);
		});

		it("retains predecessor todos and executable queues after local readiness fails, then retries", async () => {
			session.setTodoPhases([
				{ name: "Retry", tasks: [{ content: "preserve predecessor", status: "in_progress" }] },
			]);
			session.queueDeferredMessageForTests(
				{
					role: "custom",
					customType: "test",
					content: "predecessor executable queue",
					display: false,
					timestamp: Date.now(),
				},
				false,
			);
			const beforeId = session.sessionId;
			const beforeFile = session.sessionFile;
			const beforeTodos = session.getTodoPhases();
			const beforeQueue = session.getPendingNextTurnMessagesForTests();
			vi.spyOn(internalUrls, "initializeLocalRoot").mockRejectedValueOnce(new Error("new readiness boom"));

			await expect(session.newSession()).rejects.toThrow("new readiness boom");
			expect(session.sessionId).toBe(beforeId);
			expect(session.sessionFile).toBe(beforeFile);
			expect(session.getTodoPhases()).toEqual(beforeTodos);
			expect(session.getPendingNextTurnMessagesForTests()).toEqual(beforeQueue);

			await expect(session.newSession()).resolves.toBe(true);
			expect(session.sessionId).not.toBe(beforeId);
			expect(session.getTodoPhases()).toHaveLength(0);
		});
	});
});
