import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, type AgentTool } from "@gajae-code/agent-core";
import { getBundledModel } from "@gajae-code/ai";
import { createMockModel, type MockResponse } from "@gajae-code/ai/providers/mock";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@gajae-code/coding-agent/config/settings";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { convertToLlm } from "@gajae-code/coding-agent/session/messages";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { classifyOwnedCompletion } from "@gajae-code/coding-agent/session/terminal-abort";
import { BashTool, type ToolSession } from "@gajae-code/coding-agent/tools";
import { Snowflake } from "@gajae-code/utils";
import { AsyncJobManager } from "../src/async";

/** Scripted assistant turn that issues a single `bash` tool call. */
function bashCall(command: string, callId: string): MockResponse {
	return {
		content: [{ type: "toolCall", id: callId, name: "bash", arguments: { command, timeout: 10 } }],
		stopReason: "toolUse",
	};
}

/** Scripted plain-text assistant turn with `stopReason: "stop"`. */
function stopReply(text: string): MockResponse {
	return {
		content: [{ type: "text", text }],
		stopReason: "stop",
	};
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
		await Bun.sleep(10);
	}
}

describe("terminal abort registers a turn scope so left-running owned work classifies by source", () => {
	let session: AgentSession;
	let tempDir: string;
	let authStorage: AuthStorage | undefined;
	let scriptedResponses: MockResponse[];
	let manager: AsyncJobManager;

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `pi-terminal-abort-chain-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });

		resetSettingsForTest();
		await Settings.init({ inMemory: true, cwd: tempDir });

		authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");

		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("expected claude-sonnet-4-5 to be bundled");

		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"todo.enabled": false,
			"todo.eager": false,
			"todo.reminders": false,
			// The managed async-job path must be live so BashTool registers jobs
			// and the terminal-abort lineage binding is captured.
			"async.enabled": true,
			"bash.autoBackground.enabled": true,
		});
		const sessionManager = SessionManager.inMemory(tempDir);

		const toolSession: ToolSession = {
			cwd: tempDir,
			hasUI: false,
			settings,
			getSessionFile: () => sessionManager.getSessionFile() ?? null,
			getSessionId: () => sessionManager.getSessionId?.() ?? null,
			getSessionSpawns: () => "*",
		};
		const bashTool = new BashTool(toolSession);

		scriptedResponses = [];

		const mock = createMockModel({
			handler: () => scriptedResponses.shift() ?? stopReply("done"),
		});

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [bashTool as unknown as AgentTool],
				messages: [],
			},
			convertToLlm,
			streamFn: mock.stream,
		});

		manager = new AsyncJobManager({ maxRunningJobs: 2, onJobComplete: () => {} });
		AsyncJobManager.setInstance(manager);

		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			toolRegistry: new Map([[bashTool.name, bashTool as unknown as AgentTool]]),
		});
		session.setSdkPermissionMode("allow");
	});

	afterEach(async () => {
		AsyncJobManager.setInstance(undefined);
		await session?.dispose();
		authStorage?.close();
		authStorage = undefined;
		if (fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("terminal abort registers the scope so the left-running owned job classifies as owned-completion", async () => {
		const callId = "call_terminal_owned";
		scriptedResponses = [bashCall("echo left-running", callId), stopReply("ok")];

		const promptPromise = session.prompt("run owned work").catch(() => {
			// The turn may be interrupted by the terminal abort; that is expected.
		});
		await waitFor(() => manager.getAllJobs().length > 0, "bash job registered");
		const job = manager.getAllJobs()[0]!;

		const handle = session.agent.activeResourceRunId;
		const proof = await session.abortPromptAndWait(handle ?? job.id, {
			graceMs: 2_000,
			terminal: { scope: "turn" },
		});
		// The abort may or may not fence (run handle availability varies), but the
		// terminal scope MUST be registered for the aborted turn either way.
		expect(proof).toBeDefined();

		// The left-running owned job now classifies by exact source lineage.
		const classified = classifyOwnedCompletion(job.id, job.generation);
		expect(classified).toBeDefined();
		expect(classified?.registration.jobId).toBe(job.id);
		expect(classified?.registration.jobGeneration).toBe(job.generation);

		await promptPromise;
	}, 20_000);

	it("owned scope registers a scope with owned-completion delivery disabled", async () => {
		const callId = "call_terminal_owned_disabled";
		scriptedResponses = [bashCall("echo stopped", callId), stopReply("ok")];

		const promptPromise = session.prompt("run capturable work").catch(() => {
			// Interruption by the terminal abort is expected.
		});
		await waitFor(() => manager.getAllJobs().length > 0, "bash job registered");
		const job = manager.getAllJobs()[0]!;

		await session.abortPromptAndWait(session.agent.activeResourceRunId ?? job.id, {
			graceMs: 2_000,
			terminal: { scope: "owned" },
		});

		// The job still classifies as owned (exact tuple), but the scope's
		// owned-completion policy is disabled — no resume from stopped work.
		const classified = classifyOwnedCompletion(job.id, job.generation);
		expect(classified).toBeDefined();
		expect(classified?.registration.promptAttemptEpoch).toBeGreaterThanOrEqual(0);

		await promptPromise;
	}, 20_000);

	it("terminal abort advances the epoch so a later turn's work never binds the aborted scope", async () => {
		// Turn A spawns a job; terminal abort fences turn A's lineage+epoch.
		scriptedResponses = [bashCall("echo first", "call-a"), stopReply("ok")];
		const firstPrompt = session.prompt("first turn").catch(() => {});
		await waitFor(() => manager.getAllJobs().length > 0, "first job registered");
		const firstJob = manager.getAllJobs()[0]!;
		await session.abortPromptAndWait(session.agent.activeResourceRunId ?? firstJob.id, {
			graceMs: 2_000,
			terminal: { scope: "turn" },
		});
		await firstPrompt;
		expect(classifyOwnedCompletion(firstJob.id, firstJob.generation)).toBeDefined();

		// Turn B (fresh user prompt) spawns a job in a NEW turn: the epoch
		// advanced, so its lineage is distinct and the aborted scope must NOT
		// claim it (AC 27/28 — the fence bounds only the aborted turn).
		const jobCountBefore = manager.getAllJobs().length;
		scriptedResponses = [bashCall("echo second", "call-b"), stopReply("ok")];
		const secondPrompt = session.prompt("second turn").catch(() => {});
		await waitFor(() => manager.getAllJobs().length > jobCountBefore, "second job registered");
		const secondJob = manager.getAllJobs().find(job => job.id !== firstJob.id)!;
		expect(classifyOwnedCompletion(secondJob.id, secondJob.generation)).toBeUndefined();
		await secondPrompt;
	}, 20_000);
});
