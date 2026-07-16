import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@gajae-code/coding-agent/config/settings";
import { InteractiveMode } from "@gajae-code/coding-agent/modes/interactive-mode";
import { initTheme } from "@gajae-code/coding-agent/modes/theme/theme";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { createTools, type Tool, type ToolSession } from "@gajae-code/coding-agent/tools";
import { TempDir } from "@gajae-code/utils";

type Harness = {
	tempDir: TempDir;
	authStorage: AuthStorage;
	session: AgentSession;
	mode: InteractiveMode;
	cleanup: () => Promise<void>;
};

type ContinuationTimer = {
	cancelled: boolean;
	callback: () => void;
};

let continuationTimers: ContinuationTimer[] = [];

function installContinuationTimerControl(): void {
	const realSetTimeout = globalThis.setTimeout;
	const realClearTimeout = globalThis.clearTimeout;
	const controlledSetTimeout = (callback: () => void, delay?: number): ReturnType<typeof setTimeout> => {
		if (delay !== 800) return realSetTimeout(callback, delay);
		const timer: ContinuationTimer = { cancelled: false, callback };
		continuationTimers.push(timer);
		return timer as unknown as ReturnType<typeof setTimeout>;
	};
	const controlledClearTimeout = (timer: unknown): void => {
		if (typeof timer === "object" && timer !== null && "cancelled" in timer && "callback" in timer) {
			(timer as unknown as ContinuationTimer).cancelled = true;
			return;
		}
		realClearTimeout(timer as ReturnType<typeof setTimeout>);
	};
	vi.spyOn(globalThis, "setTimeout").mockImplementation(controlledSetTimeout as unknown as typeof setTimeout);
	vi.spyOn(globalThis, "clearTimeout").mockImplementation(controlledClearTimeout as unknown as typeof clearTimeout);
}

async function advanceGoalContinuation(): Promise<void> {
	for (let i = 0; i < 100 && continuationTimers.length === 0; i++) {
		await Bun.sleep(0);
	}
	const timer = continuationTimers.shift();
	expect(timer).toBeDefined();
	if (!timer || timer.cancelled) throw new Error("Expected an active goal continuation timer");
	timer.callback();
	await flush();
}

async function createHarness(): Promise<Harness> {
	resetSettingsForTest();
	const tempDir = TempDir.createSync("@goal-timeout-loop-");
	await Settings.init({ inMemory: true, cwd: tempDir.path() });
	const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
	const model = new ModelRegistry(authStorage).find("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected test model");
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"goal.enabled": true,
		"goal.continuationModes": ["interactive"],
		"pet.mode": "off",
		"starReminder.enabled": false,
		"startup.quiet": true,
	});
	const toolSession: ToolSession = {
		cwd: tempDir.path(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings,
	};
	const tools = await createTools(toolSession, ["read"]);
	const session = new AgentSession({
		agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools, messages: [] } }),
		sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
		settings,
		modelRegistry: new ModelRegistry(authStorage),
		toolRegistry: new Map<string, Tool>(tools.map(tool => [tool.name, tool] as const)),
		rebuildSystemPrompt: async () => ({ systemPrompt: ["Test"] }),
	});
	const mode = new InteractiveMode(session, "test");
	await mode.init();
	mode.ui.stop();
	await mode.handleGoalModeCommand("Prevent timeout loop");
	return {
		tempDir,
		authStorage,
		session,
		mode,
		cleanup: async () => {
			mode.stop();
			await session.dispose();
			authStorage.close();
			tempDir.removeSync();
			resetSettingsForTest();
		},
	};
}

async function flush(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

async function runContinuation(
	harness: Harness,
	outcomes: Array<{ toolName: string; args: unknown; isError: boolean; result: unknown }>,
	unpaired: "none" | "start" | "end" = "none",
): Promise<void> {
	expect(harness.mode.goalModeEnabled).toBe(true);
	expect(harness.session.settings.get("goal.continuationModes")).toContain("interactive");
	const input = harness.mode.getUserInput();
	await advanceGoalContinuation();
	const submission = await input;
	expect(submission).toMatchObject({ customType: "goal-continuation" });
	expect(harness.mode.markPendingSubmissionStarted(submission)).toBe(true);
	harness.session.agent.emitExternalEvent({ type: "agent_start" });
	for (const [index, outcome] of outcomes.entries()) {
		const toolCallId = `call-${index}`;
		harness.session.agent.emitExternalEvent({
			type: "tool_execution_start",
			toolCallId,
			toolName: outcome.toolName,
			args: outcome.args,
		});
		if (unpaired !== "start") {
			harness.session.agent.emitExternalEvent({
				type: "tool_execution_end",
				toolCallId,
				toolName: outcome.toolName,
				isError: outcome.isError,
				result: outcome.result,
			});
		}
	}
	if (unpaired === "end") {
		harness.session.agent.emitExternalEvent({
			type: "tool_execution_end",
			toolCallId: "missing",
			toolName: "bash",
			isError: true,
			result: "Command timed out",
		});
	}
	harness.session.agent.emitExternalEvent({ type: "agent_end", messages: [] });
	await flush();
	await Bun.sleep(0);
	harness.mode.finishPendingSubmission(submission);
}

const timeout = (args: unknown = { command: "slow" }, toolName = "bash") => ({
	toolName,
	args,
	isError: true,
	result: { content: [{ type: "text", text: "Command timed out after 10 ms" }] },
});
const success = (args: unknown = { command: "slow" }) => ({
	toolName: "bash",
	args,
	isError: false,
	result: { content: [{ type: "text", text: "done" }] },
});
const otherError = (args: unknown = { command: "slow" }) => ({
	toolName: "bash",
	args,
	isError: true,
	result: { content: [{ type: "text", text: "permission denied" }] },
});

describe("goal continuation repeated timeout guard", () => {
	let harness: Harness;

	beforeAll(() => initTheme());
	beforeEach(async () => {
		harness = await createHarness();
		continuationTimers = [];
		installContinuationTimerControl();
	});
	afterEach(async () => {
		await harness.cleanup();
		vi.restoreAllMocks();
	});

	it("holds after repeated turns with multiple identical timeout calls and surfaces attention status", async () => {
		const status = vi.spyOn(harness.mode, "showStatus");
		await runContinuation(harness, [timeout(), timeout()]);
		await runContinuation(harness, [timeout(), timeout()]);
		const blocked = harness.mode.getUserInput();
		await flush();
		expect(harness.mode.onInputCallback).toBeDefined();
		expect(status).toHaveBeenCalledWith(
			"Goal paused for attention: repeated identical timeout from bash. Send a message to continue.",
		);
		harness.mode.onInputCallback?.(harness.mode.startPendingSubmission({ text: "attention" }));
		await blocked;
	});

	it("permits one timeout continuation", async () => {
		await runContinuation(harness, [timeout()]);
		const next = harness.mode.getUserInput();
		await advanceGoalContinuation();
		await expect(next).resolves.toMatchObject({ customType: "goal-continuation" });
	});

	it("resets the streak for changed args and changed tools", async () => {
		await runContinuation(harness, [timeout()]);
		await runContinuation(harness, [timeout({ command: "different" })]);
		await runContinuation(harness, [timeout({ command: "slow" }, "read")]);
		const next = harness.mode.getUserInput();
		await advanceGoalContinuation();
		await expect(next).resolves.toMatchObject({ customType: "goal-continuation" });
	});

	it("fails open for repeated non-timeout errors and mixed-progress turns", async () => {
		await runContinuation(harness, [otherError()]);
		await runContinuation(harness, [otherError()]);
		await runContinuation(harness, [timeout(), success()]);
		await runContinuation(harness, [timeout(), success()]);
		const next = harness.mode.getUserInput();
		await advanceGoalContinuation();
		await expect(next).resolves.toMatchObject({ customType: "goal-continuation" });
	});

	it("resets durably after a non-synthetic user message", async () => {
		await runContinuation(harness, [timeout()]);
		harness.session.agent.emitExternalEvent({
			type: "message_start",
			message: { role: "user", content: "continue", timestamp: 0 },
		});
		await flush();
		await runContinuation(harness, [timeout()]);
		const next = harness.mode.getUserInput();
		await advanceGoalContinuation();
		await expect(next).resolves.toMatchObject({ customType: "goal-continuation" });
	});

	it("releases suppression when the goal id or objective changes after a hold", async () => {
		await runContinuation(harness, [timeout()]);
		await runContinuation(harness, [timeout()]);
		await harness.session.goalRuntime.replaceGoal({ objective: "Changed objective" });
		await flush();
		const next = harness.mode.getUserInput();
		await advanceGoalContinuation();
		await expect(next).resolves.toMatchObject({ customType: "goal-continuation" });
	});

	it("fails open for unmatched starts", async () => {
		await runContinuation(harness, [timeout()], "start");
		await runContinuation(harness, [timeout()], "start");
		const next = harness.mode.getUserInput();
		await advanceGoalContinuation();
		await expect(next).resolves.toMatchObject({ customType: "goal-continuation" });
	});

	it("fails open for end-only unmatched tool events", async () => {
		await runContinuation(harness, [], "end");
		await runContinuation(harness, [], "end");
		const next = harness.mode.getUserInput();
		await advanceGoalContinuation();
		await expect(next).resolves.toMatchObject({ customType: "goal-continuation" });
	});

	it("resets the timeout streak after an ordinary agent turn", async () => {
		await runContinuation(harness, [timeout()]);
		harness.session.agent.emitExternalEvent({ type: "agent_start" });
		continuationTimers = [];
		harness.session.agent.emitExternalEvent({ type: "agent_end", messages: [] });
		await flush();
		await runContinuation(harness, [timeout()]);
		const next = harness.mode.getUserInput();
		await advanceGoalContinuation();
		await expect(next).resolves.toMatchObject({ customType: "goal-continuation" });
	});

	it("suppresses an empty hidden continuation", async () => {
		await runContinuation(harness, []);
		const blocked = harness.mode.getUserInput();
		await flush();
		expect(continuationTimers).toHaveLength(0);
		harness.mode.onInputCallback?.(harness.mode.startPendingSubmission({ text: "attention" }));
		await blocked;
	});
});
