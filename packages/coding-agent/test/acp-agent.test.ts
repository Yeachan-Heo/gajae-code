import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
	AgentSideConnection,
	ClientCapabilities,
	CreateElicitationRequest,
	CreateElicitationResponse,
	PromptRequest,
	SessionNotification,
} from "@agentclientprotocol/sdk";
import {
	zForkSessionResponse,
	zLoadSessionResponse,
	zNewSessionResponse,
	zPromptResponse,
	zSessionNotification,
} from "@agentclientprotocol/sdk/dist/schema/zod.gen.js";
import type { Model } from "@gajae-code/ai";
import { getConfigRootDir, setAgentDir } from "@gajae-code/utils";
import { resetSettingsForTest, Settings } from "../src/config/settings";
import { ACP_BOOTSTRAP_RACE_GUARD_MS, AcpAgent, createAcpExtensionUiContext } from "../src/modes/acp/acp-agent";
import { getThemeByName, setThemeInstance } from "../src/modes/theme/theme";
import type { PlanModeState } from "../src/plan-mode/state";
import type { AgentSession, AgentSessionEvent } from "../src/session/agent-session";
import { SILENT_ABORT_MARKER } from "../src/session/messages";
import { SessionManager } from "../src/session/session-manager";
import { expectAcpStructure } from "./helpers/acp-schema";

const TEST_MODELS: Model[] = [
	{
		id: "claude-sonnet-4-20250514",
		name: "Claude Sonnet",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://example.invalid",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8_192,
	},
	{
		id: "gpt-5.4",
		name: "GPT-5.4",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8_192,
	},
];

function makeAssistantMessage(text: string, thinking?: string) {
	const content: Array<{ type: "text"; text: string } | { type: "thinking"; thinking: string }> = [
		{ type: "text", text },
	];
	if (thinking) {
		content.push({ type: "thinking" as const, thinking });
	}
	return {
		role: "assistant" as const,
		content,
		api: "anthropic-messages" as const,
		provider: "anthropic" as const,
		model: TEST_MODELS[0].id,
		usage: {
			input: 10,
			output: 5,
			cacheRead: 2,
			cacheWrite: 1,
			totalTokens: 18,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp: Date.now(),
	};
}

class FakeAgentSession {
	sessionManager: SessionManager;
	sessionId: string;
	agent: { sessionId: string; waitForIdle: () => Promise<void> };
	model: Model | undefined;
	thinkingLevel: string | undefined;
	customCommands: [] = [];
	extensionRunner = undefined;
	isStreaming = false;
	queuedMessageCount = 0;
	systemPrompt = "system";
	disposed = false;
	fastMode = false;
	forcedToolChoice: string | undefined;
	get settings(): Settings {
		return Settings.instance;
	}
	promptCalls: string[] = [];
	customMessages: Array<{ customType: string; content: string; details?: unknown }> = [];
	skillsSettings = { enableSkillCommands: true };
	skills: Array<{ name: string; description: string; filePath: string; baseDir: string; source: string }> = [];
	planModeState: PlanModeState | undefined;
	waitForIdleCalls = 0;
	waitForIdleBlocker: (() => Promise<void>) | undefined;
	asyncJobDrain: ((options?: { timeoutMs?: number }) => Promise<boolean>) | undefined;
	sendCustomMessage = async (message: { customType: string; content: string; details?: unknown }): Promise<void> => {
		this.customMessages.push(message);
	};
	#listeners = new Set<(event: AgentSessionEvent) => void>();

	constructor(
		cwd: string,
		private readonly models: Model[] = TEST_MODELS,
	) {
		this.sessionManager = SessionManager.create(cwd);
		this.sessionId = this.sessionManager.getSessionId();
		this.agent = {
			sessionId: this.sessionId,
			waitForIdle: async () => {
				await this.waitForIdle();
			},
		};
		this.model = models[0];
	}

	get sessionName(): string {
		return this.sessionManager.getHeader()?.title ?? `Session ${this.sessionId}`;
	}

	get modelRegistry(): { getApiKey: (model: Model) => Promise<string> } {
		return {
			getApiKey: async (_model: Model) => "test-key",
		};
	}

	getAvailableModels(): Model[] {
		return this.models;
	}

	getAvailableThinkingLevels(): ReadonlyArray<string> {
		return ["low", "medium", "high"];
	}

	setThinkingLevel(level: string | undefined): void {
		const isChanging = this.thinkingLevel !== level;
		this.thinkingLevel = level;
		if (isChanging) {
			for (const listener of this.#listeners) {
				listener({
					type: "thinking_level_changed",
					thinkingLevel: level,
				} as AgentSessionEvent);
			}
		}
	}

	setSlashCommands(_commands: unknown[]): void {
		// no-op for tests
	}

	async refreshSshTool(_options?: { activateIfAvailable?: boolean }): Promise<void> {}

	async setModel(model: Model): Promise<void> {
		this.model = model;
	}

	subscribe(listener: (event: AgentSessionEvent) => void): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	listeners(): Array<(event: AgentSessionEvent) => void> {
		return [...this.#listeners];
	}

	async prompt(text: string): Promise<void> {
		this.promptCalls.push(text);
		this.isStreaming = true;
		this.sessionManager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
		const assistantMessage = makeAssistantMessage("pong");
		for (const listener of this.#listeners) {
			listener({
				type: "message_update",
				message: assistantMessage,
				assistantMessageEvent: { type: "text_delta", delta: "pong" },
			} as AgentSessionEvent);
		}
		this.sessionManager.appendMessage(assistantMessage);
		for (const listener of this.#listeners) {
			listener({
				type: "agent_end",
				messages: [assistantMessage],
			} as AgentSessionEvent);
		}
		this.isStreaming = false;
	}

	async waitForIdle(): Promise<void> {
		this.waitForIdleCalls++;
		await this.waitForIdleBlocker?.();
	}

	async drainAsyncJobDeliveriesForAcp(options?: { timeoutMs?: number }): Promise<boolean> {
		return (await this.asyncJobDrain?.(options)) ?? false;
	}

	async abort(): Promise<void> {
		this.isStreaming = false;
	}

	async promptCustomMessage(message: { customType: string; content: string; details?: unknown }): Promise<void> {
		this.customMessages.push(message);
		this.isStreaming = true;
		const assistantMessage = makeAssistantMessage("skill pong");
		for (const listener of this.#listeners) {
			listener({
				type: "message_update",
				message: assistantMessage,
				assistantMessageEvent: { type: "text_delta", delta: "skill pong" },
			} as AgentSessionEvent);
		}
		this.sessionManager.appendMessage(assistantMessage);
		for (const listener of this.#listeners) {
			listener({
				type: "agent_end",
				messages: [assistantMessage],
			} as AgentSessionEvent);
		}
		this.isStreaming = false;
	}

	async refreshMCPTools(_tools: unknown[]): Promise<void> {}

	getContextUsage(): undefined {
		return undefined;
	}

	async switchSession(sessionPath: string): Promise<boolean> {
		await this.sessionManager.setSessionFile(sessionPath);
		this.sessionId = this.sessionManager.getSessionId();
		this.agent.sessionId = this.sessionId;
		return true;
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		await this.sessionManager.close();
	}

	async reload(): Promise<void> {}

	async newSession(): Promise<boolean> {
		await this.sessionManager.newSession();
		this.sessionId = this.sessionManager.getSessionId();
		this.agent.sessionId = this.sessionId;
		return true;
	}

	async branch(_entryId: string): Promise<{ cancelled: boolean }> {
		return { cancelled: false };
	}

	async navigateTree(_targetId: string): Promise<{ cancelled: boolean }> {
		return { cancelled: false };
	}

	getActiveToolNames(): string[] {
		return [];
	}

	getAllToolNames(): string[] {
		return [];
	}

	setActiveToolsByName(_toolNames: string[]): void {}

	setClientBridge(_bridge: unknown): void {}

	getPlanModeState(): PlanModeState | undefined {
		return this.planModeState;
	}

	setPlanModeState(state: PlanModeState | undefined): void {
		this.planModeState = state;
	}

	getToolByName(_name: string): undefined {
		return undefined;
	}

	toggleFastMode(): boolean {
		this.fastMode = !this.fastMode;
		return this.fastMode;
	}

	setFastMode(enabled: boolean): void {
		this.fastMode = enabled;
	}

	isFastModeEnabled(): boolean {
		return this.fastMode;
	}

	isFastForProvider(_provider?: string): boolean {
		return false;
	}

	isFastForSubagentProvider(_provider?: string): boolean {
		return false;
	}

	resolveRoleModelWithThinking(_role: string): { model: undefined } {
		return { model: undefined };
	}

	setForcedToolChoice(toolName: string): void {
		this.forcedToolChoice = toolName;
	}

	async sendUserMessage(_content: string, _options?: unknown): Promise<void> {}

	async compact(_instructions?: string, _options?: unknown): Promise<void> {}

	async fork(): Promise<boolean> {
		await this.sessionManager.flush();
		const forked = await this.sessionManager.fork();
		if (!forked) {
			return false;
		}
		this.sessionId = this.sessionManager.getSessionId();
		this.agent.sessionId = this.sessionId;
		return true;
	}
}

function holdPromptStreaming(session: FakeAgentSession): () => void {
	let finishPrompt!: () => void;
	session.prompt = async (text: string): Promise<void> => {
		session.promptCalls.push(text);
		session.isStreaming = true;
		const blocker = Promise.withResolvers<void>();
		finishPrompt = blocker.resolve;
		await blocker.promise;
		const assistantMessage = makeAssistantMessage("pong");
		for (const listener of session.listeners()) {
			listener({
				type: "message_update",
				message: assistantMessage,
				assistantMessageEvent: { type: "text_delta", delta: "pong" },
			} as AgentSessionEvent);
		}
		session.sessionManager.appendMessage(assistantMessage);
		for (const listener of session.listeners()) {
			listener({
				type: "agent_end",
				messages: [assistantMessage],
			} as AgentSessionEvent);
		}
		session.isStreaming = false;
	};
	return () => finishPrompt();
}

interface AgentHarness {
	agent: AcpAgent;
	updates: SessionNotification[];
	abortController: AbortController;
	sessions: FakeAgentSession[];
	cwdA: string;
	cwdB: string;
	findSession(sessionId: string): FakeAgentSession | undefined;
}

function getChunkMessageId(notification: SessionNotification): string | undefined {
	const update = notification.update as { messageId?: string | null };
	return typeof update.messageId === "string" ? update.messageId : undefined;
}

function expectAcpNotifications(updates: SessionNotification[]): void {
	for (const update of updates) {
		expectAcpStructure(zSessionNotification, update);
	}
}

const cleanupRoots: string[] = [];
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

afterEach(async () => {
	if (originalAgentDir) {
		setAgentDir(originalAgentDir);
	} else {
		setAgentDir(fallbackAgentDir);
		delete process.env.PI_CODING_AGENT_DIR;
	}
	resetSettingsForTest();

	for (const root of cleanupRoots.splice(0)) {
		await fs.promises.rm(root, { recursive: true, force: true });
	}
});

async function createHarness(): Promise<AgentHarness> {
	const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "gjc-acp-test-"));
	cleanupRoots.push(root);
	const agentDir = path.join(root, "agent");
	const cwdA = path.join(root, "cwd-a");
	const cwdB = path.join(root, "cwd-b");
	await fs.promises.mkdir(agentDir, { recursive: true });
	await fs.promises.mkdir(cwdA, { recursive: true });
	await fs.promises.mkdir(cwdB, { recursive: true });
	setAgentDir(agentDir);
	await Settings.init({ agentDir, inMemory: true });

	const updates: SessionNotification[] = [];
	const abortController = new AbortController();
	const sessions: FakeAgentSession[] = [];
	const connection = {
		sessionUpdate: async (notification: SessionNotification) => {
			updates.push(notification);
		},
		signal: abortController.signal,
		closed: Promise.withResolvers<void>().promise,
	} as unknown as AgentSideConnection;

	const initialSession = new FakeAgentSession(cwdA);
	sessions.push(initialSession);
	const factory = async (cwd: string): Promise<AgentSession> => {
		const session = new FakeAgentSession(cwd);
		sessions.push(session);
		return session as unknown as AgentSession;
	};

	return {
		agent: new AcpAgent(connection, factory, initialSession as unknown as AgentSession),
		updates,
		abortController,
		sessions,
		cwdA,
		cwdB,
		findSession: (sessionId: string) => sessions.find(session => session.sessionId === sessionId),
	};
}

/**
 * Wait until `#scheduleBootstrapUpdates`'s timer has fired and the
 * session-lifetime subscription is installed. 30 ms of slack absorbs
 * `setTimeout` drift without slowing tests meaningfully.
 */
async function waitForBootstrapGuard(): Promise<void> {
	await Bun.sleep(ACP_BOOTSTRAP_RACE_GUARD_MS + 30);
}

async function waitForAvailableCommandsUpdate(harness: AgentHarness, sessionId: string): Promise<void> {
	const deadline = Date.now() + ACP_BOOTSTRAP_RACE_GUARD_MS + 500;
	while (Date.now() < deadline) {
		if (
			harness.updates.some(
				update => update.sessionId === sessionId && update.update.sessionUpdate === "available_commands_update",
			)
		) {
			return;
		}
		await Bun.sleep(10);
	}
}

describe("ACP agent", () => {
	beforeAll(async () => {
		const installed = await getThemeByName("red-claw");
		if (installed) setThemeInstance(installed);
	});
	it("supports multiple live ACP sessions with model and lifecycle handlers", async () => {
		const harness = await createHarness();
		const first = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		const second = await harness.agent.newSession({ cwd: harness.cwdB, mcpServers: [] });
		expectAcpStructure(zNewSessionResponse, first);
		expectAcpStructure(zNewSessionResponse, second);

		expect(first.models?.availableModels.map(model => model.modelId)).toEqual(
			TEST_MODELS.map(model => `${model.provider}/${model.id}`),
		);

		await harness.agent.unstable_setSessionModel({
			sessionId: first.sessionId,
			modelId: `${TEST_MODELS[1]!.provider}/${TEST_MODELS[1]!.id}`,
		});
		await harness.agent.setSessionConfigOption({
			sessionId: first.sessionId,
			configId: "thinking",
			value: "high",
		});
		// Both model and thinking-level changes must surface as ACP
		// `config_option_update` notifications scoped to the right session;
		// the schema check alone would still pass if either method stopped
		// emitting notifications entirely.
		const configUpdatesForFirst = harness.updates.filter(
			n => n.sessionId === first.sessionId && n.update.sessionUpdate === "config_option_update",
		);
		expect(configUpdatesForFirst.length).toBeGreaterThanOrEqual(2);
		expectAcpNotifications(harness.updates);

		const firstSession = harness.findSession(first.sessionId);
		const secondSession = harness.findSession(second.sessionId);
		expect(firstSession?.model?.id).toBe(TEST_MODELS[1]!.id);
		expect(firstSession?.thinkingLevel).toBe("high");
		expect(secondSession?.model?.id).toBe(TEST_MODELS[0]!.id);
		expect(secondSession?.thinkingLevel).toBeUndefined();

		firstSession?.sessionManager.appendMessage({ role: "user", content: "fork me", timestamp: Date.now() });
		await firstSession?.sessionManager.flush();

		const forked = await harness.agent.unstable_forkSession({
			sessionId: first.sessionId,
			cwd: harness.cwdA,
			mcpServers: [],
		});
		expectAcpStructure(zForkSessionResponse, forked);
		const forkedSession = harness.findSession(forked.sessionId);
		const forkedMessages = forkedSession?.sessionManager.buildSessionContext().messages ?? [];
		expect(forked.sessionId).not.toBe(first.sessionId);
		expect(forkedMessages.some(message => message.role === "user" && message.content === "fork me")).toBe(true);

		await harness.agent.closeSession({ sessionId: forked.sessionId });
		await expect(harness.agent.setSessionMode({ sessionId: forked.sessionId, modeId: "default" })).rejects.toThrow(
			"Unsupported ACP session",
		);

		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("advertises plan mode and emits schema-valid mode updates", async () => {
		const harness = await createHarness();
		Settings.instance.set("plan.enabled", true);

		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		expectAcpStructure(zNewSessionResponse, created);
		expect(created.modes?.availableModes.map(mode => mode.id)).toEqual(["default", "plan"]);
		const initialModeConfig = created.configOptions?.find(option => option.id === "mode") as
			| { currentValue?: unknown; options?: Array<{ value: string }> }
			| undefined;
		expect(initialModeConfig?.currentValue).toBe("default");
		expect(initialModeConfig?.options?.map(option => option.value)).toEqual(["default", "plan"]);

		await harness.agent.setSessionMode({ sessionId: created.sessionId, modeId: "plan" });

		const session = harness.findSession(created.sessionId)!;
		expect(session.planModeState).toEqual(
			expect.objectContaining({ enabled: true, planFilePath: "local://PLAN.md", workflow: "parallel" }),
		);
		const modeNotifications = harness.updates.filter(
			notification =>
				notification.sessionId === created.sessionId &&
				(notification.update.sessionUpdate === "current_mode_update" ||
					notification.update.sessionUpdate === "config_option_update"),
		);
		expectAcpNotifications(modeNotifications);
		expect(
			modeNotifications.some(
				notification =>
					notification.update.sessionUpdate === "current_mode_update" &&
					notification.update.currentModeId === "plan",
			),
		).toBe(true);
		const configNotification = modeNotifications.findLast(
			notification => notification.update.sessionUpdate === "config_option_update",
		);
		const currentModeConfig =
			configNotification?.update.sessionUpdate === "config_option_update"
				? (configNotification.update.configOptions.find(option => option.id === "mode") as
						| { currentValue?: unknown }
						| undefined)
				: undefined;
		expect(currentModeConfig?.currentValue).toBe("plan");

		await harness.agent.setSessionMode({ sessionId: created.sessionId, modeId: "default" });
		expect(session.planModeState).toBeUndefined();

		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("pushes config_option_update when thinking level changes internally", async () => {
		// Internal callers (slash commands, model auto-adjust, extension UI) call
		// AgentSession.setThinkingLevel directly without going through the ACP
		// setSessionConfigOption surface. Once the session-lifetime subscription
		// is installed (after the 50ms bootstrap guard so the response has
		// reached the client first), those changes must surface to clients as
		// `config_option_update` so TORTAS-style fleet views stay in sync.
		const harness = await createHarness();
		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		const session = harness.findSession(created.sessionId)!;
		// Wait past the 50ms bootstrap timer so the lifetime subscription is
		// installed before we drive an internal thinking-level change.
		await waitForBootstrapGuard();

		const updatesBefore = harness.updates.length;
		session.setThinkingLevel("high");

		const pushedAfter = harness.updates.slice(updatesBefore);
		const configUpdates = pushedAfter.filter(
			notification =>
				notification.sessionId === created.sessionId &&
				notification.update.sessionUpdate === "config_option_update",
		);
		expect(configUpdates.length).toBeGreaterThanOrEqual(1);
		expectAcpNotifications(configUpdates);
		const firstUpdate = configUpdates[0]!.update;
		if (firstUpdate.sessionUpdate !== "config_option_update") {
			throw new Error("expected config_option_update");
		}
		const thinkingConfig = firstUpdate.configOptions.find(option => option.id === "thinking") as
			| { currentValue?: unknown }
			| undefined;
		expect(thinkingConfig?.currentValue).toBe("high");

		// Setting to the same level must not produce a redundant notification.
		const updatesBeforeRedundant = harness.updates.length;
		session.setThinkingLevel("high");
		expect(harness.updates.length).toBe(updatesBeforeRedundant);

		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("suppresses lifetime config_option_update during the bootstrap window", async () => {
		// Regression for OpenAI code backend review on #1060: an extension `session_start`
		// handler calling `setThinkingLevel` must not push a
		// `config_option_update` for a session id the client has not been told
		// about yet (matches Zed's `Received session notification for unknown
		// session` race that `#scheduleBootstrapUpdates` already guards).
		// The fake harness lets us simulate that pre-bootstrap window by
		// driving the change before sleeping past the 50ms guard.
		const harness = await createHarness();
		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		const session = harness.findSession(created.sessionId)!;

		const updatesBefore = harness.updates.length;
		// Synchronously after `newSession` returns, the bootstrap timer has
		// not fired yet, so the lifetime subscription is not installed.
		session.setThinkingLevel("high");

		const beforeBootstrap = harness.updates
			.slice(updatesBefore)
			.filter(
				notification =>
					notification.sessionId === created.sessionId &&
					notification.update.sessionUpdate === "config_option_update",
			);
		expect(beforeBootstrap.length).toBe(0);

		// After the 50ms bootstrap timer fires the subscription is installed,
		// and subsequent changes do surface.
		await waitForBootstrapGuard();
		const baseline = harness.updates.length;
		session.setThinkingLevel("medium");
		const afterBootstrap = harness.updates
			.slice(baseline)
			.filter(
				notification =>
					notification.sessionId === created.sessionId &&
					notification.update.sessionUpdate === "config_option_update",
			);
		expect(afterBootstrap.length).toBeGreaterThanOrEqual(1);

		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("emits a single config_option_update per setSessionConfigOption(thinking) call", async () => {
		// Client-initiated thinking changes flow through #setThinkingLevelById,
		// which fires `thinking_level_changed` and lets the lifetime subscription
		// push the notification. The ACP surface must not also push a duplicate
		// `config_option_update` of its own.
		const harness = await createHarness();
		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		// Wait past the bootstrap guard so the lifetime subscription is
		// installed and the client-driven setSessionConfigOption produces
		// exactly one notification through it.
		await waitForBootstrapGuard();

		const updatesBefore = harness.updates.length;
		const response = await harness.agent.setSessionConfigOption({
			sessionId: created.sessionId,
			configId: "thinking",
			value: "high",
		});

		const configUpdates = harness.updates
			.slice(updatesBefore)
			.filter(
				notification =>
					notification.sessionId === created.sessionId &&
					notification.update.sessionUpdate === "config_option_update",
			);
		expect(configUpdates.length).toBe(1);
		expectAcpNotifications(configUpdates);

		// The response still carries the fresh configOptions tree so the caller
		// gets the new state without relying on the notification.
		const thinkingOption = response.configOptions.find(option => option.id === "thinking") as
			| { currentValue?: unknown }
			| undefined;
		expect(thinkingOption?.currentValue).toBe("high");

		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("accepts only ACP underscore-prefixed extension methods", async () => {
		const harness = await createHarness();

		const result = await harness.agent.extMethod("_gjc/sessions/listAll", { limit: 2 });

		expect(Array.isArray(result.sessions)).toBe(true);
		expect(typeof result.total).toBe("number");
		await expect(harness.agent.extMethod("gjc/sessions/listAll", { limit: 2 })).rejects.toThrow(
			"Unknown ACP ext method",
		);

		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("replays messageIds and returns turn usage for prompts", async () => {
		const harness = await createHarness();
		const stored = new FakeAgentSession(harness.cwdA);
		harness.sessions.push(stored);
		stored.sessionManager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
		stored.sessionManager.appendMessage(makeAssistantMessage("reply", "reasoning"));
		await stored.sessionManager.ensureOnDisk();
		await stored.sessionManager.flush();

		const loaded = await harness.agent.loadSession({
			sessionId: stored.sessionId,
			cwd: harness.cwdA,
			mcpServers: [],
		});
		expectAcpStructure(zLoadSessionResponse, loaded);
		const replayChunks = harness.updates.filter(
			update =>
				update.sessionId === stored.sessionId &&
				(update.update.sessionUpdate === "user_message_chunk" ||
					update.update.sessionUpdate === "agent_message_chunk" ||
					update.update.sessionUpdate === "agent_thought_chunk"),
		);
		const replayAssistantChunks = replayChunks.filter(
			update =>
				update.update.sessionUpdate === "agent_message_chunk" ||
				update.update.sessionUpdate === "agent_thought_chunk",
		);

		expect(
			replayChunks.every(
				update => typeof getChunkMessageId(update) === "string" && getChunkMessageId(update)!.length > 0,
			),
		).toBe(true);
		expect(new Set(replayAssistantChunks.map(update => getChunkMessageId(update))).size).toBe(1);

		const live = await harness.agent.newSession({ cwd: harness.cwdB, mcpServers: [] });
		const response = await harness.agent.prompt({
			sessionId: live.sessionId,
			messageId: "05b17a6f-b310-4be7-b767-6b4f3a84eb63",
			prompt: [{ type: "text", text: "ping" }],
		} as PromptRequest);
		expectAcpStructure(zPromptResponse, response);
		expectAcpNotifications(harness.updates);

		const liveChunks = harness.updates.filter(
			update => update.sessionId === live.sessionId && update.update.sessionUpdate === "agent_message_chunk",
		);
		expect(response.userMessageId).toBe("05b17a6f-b310-4be7-b767-6b4f3a84eb63");
		expect(response.usage).toEqual({
			inputTokens: 10,
			outputTokens: 5,
			cachedReadTokens: 2,
			cachedWriteTokens: 1,
			totalTokens: 18,
		});
		expect(
			liveChunks.some(
				update => typeof getChunkMessageId(update) === "string" && getChunkMessageId(update)!.length > 0,
			),
		).toBe(true);

		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("replays assistant tool calls and matching results without duplicating the start", async () => {
		const harness = await createHarness();
		const stored = new FakeAgentSession(harness.cwdA);
		harness.sessions.push(stored);
		stored.sessionManager.appendMessage({ role: "user", content: "run tests", timestamp: Date.now() });
		stored.sessionManager.appendMessage({
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "toolu_bash_replay",
					name: "bash",
					arguments: { command: "npm test" },
				},
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: TEST_MODELS[0].id,
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: Date.now(),
		});
		stored.sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "toolu_bash_replay",
			toolName: "bash",
			content: [{ type: "text", text: "tests passed" }],
			isError: false,
			timestamp: Date.now(),
		});
		await stored.sessionManager.ensureOnDisk();
		await stored.sessionManager.flush();

		await harness.agent.loadSession({
			sessionId: stored.sessionId,
			cwd: harness.cwdA,
			mcpServers: [],
		});

		const toolUpdates = harness.updates
			.filter(update => update.sessionId === stored.sessionId)
			.map(notification => notification.update)
			.filter(update => "toolCallId" in update && update.toolCallId === "toolu_bash_replay");
		const starts = toolUpdates.filter(update => update.sessionUpdate === "tool_call");
		const completions = toolUpdates.filter(
			update => update.sessionUpdate === "tool_call_update" && update.status === "completed",
		);

		expect(starts).toHaveLength(1);
		expect(starts[0]).toEqual(
			expect.objectContaining({
				sessionUpdate: "tool_call",
				toolCallId: "toolu_bash_replay",
				rawInput: { command: "npm test" },
			}),
		);
		expect(starts[0]).toEqual(
			expect.objectContaining({
				content: expect.arrayContaining([{ type: "content", content: { type: "text", text: "$ npm test" } }]),
			}),
		);
		expect(starts.some(update => "rawInput" in update && JSON.stringify(update.rawInput) === "{}")).toBe(false);
		expect(completions).toHaveLength(1);
		expect(completions[0]).toEqual(
			expect.objectContaining({
				content: expect.arrayContaining([{ type: "content", content: { type: "text", text: "tests passed" } }]),
			}),
		);

		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("preserves tool_use input payloads when replaying assistant tool calls", async () => {
		const harness = await createHarness();
		const stored = new FakeAgentSession(harness.cwdA);
		harness.sessions.push(stored);
		stored.sessionManager.appendMessage({ role: "user", content: "use custom tool", timestamp: Date.now() });
		stored.sessionManager.appendMessage({
			role: "assistant",
			content: [
				{
					type: "tool_use",
					id: "toolu_custom",
					name: "custom_tool",
					input: "raw custom payload",
				},
			] as unknown as Array<{ type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }>,
			api: "openai-responses",
			provider: "openai",
			model: TEST_MODELS[1].id,
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: Date.now(),
		});
		await stored.sessionManager.ensureOnDisk();
		await stored.sessionManager.flush();

		await harness.agent.loadSession({
			sessionId: stored.sessionId,
			cwd: harness.cwdA,
			mcpServers: [],
		});

		const start = harness.updates
			.filter(update => update.sessionId === stored.sessionId)
			.map(notification => notification.update)
			.find(update => "toolCallId" in update && update.toolCallId === "toolu_custom");

		expect(start).toEqual(
			expect.objectContaining({
				sessionUpdate: "tool_call",
				toolCallId: "toolu_custom",
				rawInput: "raw custom payload",
			}),
		);

		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("does not replay silent-abort marker as agent_message_chunk to ACP clients", async () => {
		const harness = await createHarness();
		const stored = new FakeAgentSession(harness.cwdA);
		harness.sessions.push(stored);
		stored.sessionManager.appendMessage({ role: "user", content: "start", timestamp: Date.now() });
		// Simulate a silent-abort assistant message: empty content, errorMessage = marker
		stored.sessionManager.appendMessage({
			role: "assistant",
			content: [],
			api: "anthropic-messages",
			provider: "anthropic",
			model: TEST_MODELS[0].id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "aborted",
			errorMessage: SILENT_ABORT_MARKER,
			timestamp: Date.now(),
		});
		await stored.sessionManager.ensureOnDisk();
		await stored.sessionManager.flush();

		await harness.agent.loadSession({
			sessionId: stored.sessionId,
			cwd: harness.cwdA,
			mcpServers: [],
		});
		const replayChunks = harness.updates.filter(
			update => update.sessionId === stored.sessionId && update.update.sessionUpdate === "agent_message_chunk",
		);
		// The silent-abort marker MUST NOT surface as a replayed message chunk
		const markerChunks = replayChunks.filter(
			update =>
				update.update.sessionUpdate === "agent_message_chunk" &&
				update.update.content.type === "text" &&
				update.update.content.text === SILENT_ABORT_MARKER,
		);
		expect(markerChunks).toHaveLength(0);

		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("emits ACP plan updates from live todo_write results", async () => {
		const harness = await createHarness();
		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		const session = harness.findSession(created.sessionId)!;

		session.prompt = async (text: string): Promise<void> => {
			session.promptCalls.push(text);
			session.isStreaming = true;
			for (const listener of session.listeners()) {
				listener({
					type: "tool_execution_end",
					toolCallId: "todo_1",
					toolName: "todo_write",
					isError: false,
					result: {
						content: [{ type: "text", text: "updated" }],
						details: {
							phases: [
								{
									name: "Work",
									tasks: [
										{ content: "Fix bug", status: "in_progress" },
										{ content: "Run tests", status: "completed" },
									],
								},
							],
						},
					},
				} as AgentSessionEvent);
				listener({
					type: "tool_execution_end",
					toolCallId: "todo_empty",
					toolName: "todo_write",
					isError: false,
					result: {
						content: [{ type: "text", text: "cleared" }],
						details: { phases: [] },
					},
				} as AgentSessionEvent);
				listener({ type: "agent_end", messages: [] } as AgentSessionEvent);
			}
			session.isStreaming = false;
		};

		await harness.agent.prompt({
			sessionId: created.sessionId,
			messageId: "00000000-0000-4000-8000-000000000047",
			prompt: [{ type: "text", text: "write todos" }],
		} as PromptRequest);

		expect(harness.updates.map(update => update.update)).toContainEqual({
			sessionUpdate: "plan",
			entries: [
				{ content: "Fix bug", priority: "medium", status: "in_progress" },
				{ content: "Run tests", priority: "medium", status: "completed" },
			],
		});
		expect(harness.updates.map(update => update.update)).toContainEqual({ sessionUpdate: "plan", entries: [] });
		expectAcpNotifications(harness.updates);

		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("replays todo_write tool results as ACP plan updates", async () => {
		const harness = await createHarness();
		const stored = new FakeAgentSession(harness.cwdA);
		harness.sessions.push(stored);
		stored.sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "todo_replay",
			toolName: "todo_write",
			content: [{ type: "text", text: "updated" }],
			details: {
				phases: [{ name: "Replay", tasks: [{ content: "Restore plan", status: "pending" }] }],
			},
			isError: false,
			timestamp: Date.now(),
		});
		await stored.sessionManager.ensureOnDisk();
		await stored.sessionManager.flush();

		await harness.agent.loadSession({
			sessionId: stored.sessionId,
			cwd: harness.cwdA,
			mcpServers: [],
		});

		expect(harness.updates.map(update => update.update)).toContainEqual({
			sessionUpdate: "plan",
			entries: [{ content: "Restore plan", priority: "medium", status: "pending" }],
		});
		expectAcpNotifications(harness.updates);

		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("advertises ACP-safe builtins and skill commands", async () => {
		const harness = await createHarness();
		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		const session = harness.findSession(created.sessionId)!;
		const skillDir = path.join(harness.cwdA, ".skills", "sample");
		const skillPath = path.join(skillDir, "SKILL.md");
		await fs.promises.mkdir(skillDir, { recursive: true });
		await fs.promises.writeFile(skillPath, "---\ndescription: Sample skill\n---\n# Sample\nDo work.\n");
		session.skills = [
			{
				name: "sample",
				description: "Sample skill",
				filePath: skillPath,
				baseDir: skillDir,
				source: "test",
			},
		];
		await waitForAvailableCommandsUpdate(harness, created.sessionId);

		const commandUpdates = harness.updates.filter(
			update =>
				update.sessionId === created.sessionId && update.update.sessionUpdate === "available_commands_update",
		);
		const names = commandUpdates.flatMap(update =>
			update.update.sessionUpdate === "available_commands_update"
				? update.update.availableCommands.map(command => command.name)
				: [],
		);
		expect(names).toContain("fast");
		expect(names).not.toContain("force");
		expect(names).toContain("skill:sample");
		expect(names).not.toContain("sample");
		expect(names).not.toContain("settings");
		expect(names).not.toContain("copy");
		expect(names).not.toContain("plan");
		expect(names).not.toContain("loop");
		expect(names).not.toContain("login");
		expect(names).not.toContain("new");
		expect(names).not.toContain("handoff");
		expect(names).not.toContain("fork");
		expect(names).not.toContain("btw");
		expect(names).not.toContain("drop");
		expect(names).not.toContain("resume");
		expect(names).not.toContain("agents");
		expect(names).not.toContain("extensions");
		expect(names).not.toContain("hotkeys");

		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("executes skill commands through custom skill messages", async () => {
		const harness = await createHarness();
		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		const session = harness.findSession(created.sessionId)!;
		const skillDir = path.join(harness.cwdA, ".skills", "sample");
		const skillPath = path.join(skillDir, "SKILL.md");
		await fs.promises.mkdir(skillDir, { recursive: true });
		await fs.promises.writeFile(skillPath, "---\ndescription: Sample skill\n---\n# Sample\nDo work.\n");
		session.skills = [
			{
				name: "sample",
				description: "Sample skill",
				filePath: skillPath,
				baseDir: skillDir,
				source: "test",
			},
		];

		await harness.agent.prompt({
			sessionId: created.sessionId,
			messageId: "00000000-0000-4000-8000-000000000001",
			prompt: [{ type: "text", text: "/skill:sample extra context" }],
		} as PromptRequest);

		expect(session.promptCalls).toEqual([]);
		expect(session.customMessages).toHaveLength(1);
		expect(session.customMessages[0]!.customType).toBe("skill-prompt");
		expect(session.customMessages[0]!.content).toContain("# Sample\nDo work.");
		expect(session.customMessages[0]!.content).toContain(`Skill: ${skillPath}`);
		expect(session.customMessages[0]!.content).toContain("User: extra context");

		session.customMessages = [];
		session.skills.push({
			name: "fast",
			description: "Colliding skill",
			filePath: skillPath,
			baseDir: skillDir,
			source: "test",
		});
		await harness.agent.prompt({
			sessionId: created.sessionId,
			messageId: "00000000-0000-4000-8000-000000000002",
			prompt: [{ type: "text", text: "/fast" }],
		} as PromptRequest);

		expect(session.customMessages).toEqual([]);
		expect(session.fastMode).toBe(true);

		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("executes inline ACP skill commands through custom skill messages", async () => {
		const harness = await createHarness();
		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		const session = harness.findSession(created.sessionId)!;
		const skillDir = path.join(harness.cwdA, ".skills", "sample");
		const skillPath = path.join(skillDir, "SKILL.md");
		await fs.promises.mkdir(skillDir, { recursive: true });
		await fs.promises.writeFile(skillPath, "---\ndescription: Sample skill\n---\n# Sample\nDo work.\n");
		session.skills = [
			{
				name: "sample",
				description: "Sample skill",
				filePath: skillPath,
				baseDir: skillDir,
				source: "test",
			},
		];

		await harness.agent.prompt({
			sessionId: created.sessionId,
			messageId: "00000000-0000-4000-8000-0000000000a1",
			prompt: [{ type: "text", text: "please use /skill:sample for this" }],
		} as PromptRequest);

		expect(session.promptCalls).toEqual([]);
		expect(session.customMessages).toHaveLength(1);
		expect(session.customMessages[0]!.content).toContain("# Sample\nDo work.");
		expect(session.customMessages[0]!.content).toContain("User: please use for this");

		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("executes chained ACP skill commands in source order", async () => {
		const harness = await createHarness();
		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		const session = harness.findSession(created.sessionId)!;
		const sampleDir = path.join(harness.cwdA, ".skills", "sample");
		const samplePath = path.join(sampleDir, "SKILL.md");
		const secondDir = path.join(harness.cwdA, ".skills", "second");
		const secondPath = path.join(secondDir, "SKILL.md");
		await fs.promises.mkdir(sampleDir, { recursive: true });
		await fs.promises.mkdir(secondDir, { recursive: true });
		await fs.promises.writeFile(samplePath, "---\ndescription: Sample skill\n---\n# Sample\nDo work.\n");
		await fs.promises.writeFile(secondPath, "---\ndescription: Second skill\n---\n# Second\nDo second work.\n");
		session.skills = [
			{ name: "sample", description: "Sample skill", filePath: samplePath, baseDir: sampleDir, source: "test" },
			{ name: "second", description: "Second skill", filePath: secondPath, baseDir: secondDir, source: "test" },
		];

		await harness.agent.prompt({
			sessionId: created.sessionId,
			messageId: "00000000-0000-4000-8000-000000000003",
			prompt: [{ type: "text", text: "/skill:sample first /skill:second next args" }],
		} as PromptRequest);

		expect(session.promptCalls).toEqual([]);
		expect(session.customMessages.map(message => message.content.match(/User: .*/)?.[0] ?? message.content)).toEqual([
			"User: first",
			"User: next args",
		]);
		expect(session.customMessages[0]!.content).toContain("# Sample\nDo work.");
		expect(session.customMessages[0]!.content).toContain("User: first");
		expect(session.customMessages[1]!.content).toContain("# Second\nDo second work.");
		expect(session.customMessages[1]!.content).toContain("User: next args");

		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("rejects overlapping prompts while AgentSession is still streaming", async () => {
		const harness = await createHarness();
		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		const session = harness.findSession(created.sessionId)!;
		const finishPrompt = holdPromptStreaming(session);

		const firstPrompt = harness.agent.prompt({
			sessionId: created.sessionId,
			messageId: "00000000-0000-4000-8000-000000000035",
			prompt: [{ type: "text", text: "long running" }],
		} as PromptRequest);
		await Bun.sleep(0);

		try {
			await expect(
				harness.agent.prompt({
					sessionId: created.sessionId,
					messageId: "00000000-0000-4000-8000-000000000036",
					prompt: [{ type: "text", text: "overlap" }],
				} as PromptRequest),
			).rejects.toThrow("ACP prompt already in progress for this session");
			expect(session.promptCalls).toEqual(["long running"]);
		} finally {
			finishPrompt();
			await firstPrompt;
			harness.abortController.abort();
			await Bun.sleep(0);
		}
	});

	it("waits for AgentSession idle cleanup after agent_end before returning", async () => {
		const harness = await createHarness();
		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		const session = harness.findSession(created.sessionId)!;
		const { promise: idleBlocked, resolve: markIdleBlocked } = Promise.withResolvers<void>();
		const { promise: releaseIdle, resolve: unblockIdle } = Promise.withResolvers<void>();
		session.waitForIdleBlocker = async () => {
			markIdleBlocked();
			await releaseIdle;
		};

		const firstPrompt = harness.agent.prompt({
			sessionId: created.sessionId,
			messageId: "00000000-0000-4000-8000-000000000029",
			prompt: [{ type: "text", text: "wait for cleanup" }],
		} as PromptRequest);
		await idleBlocked;

		try {
			const returnedBeforeIdle = await Promise.race([firstPrompt.then(() => true), Bun.sleep(0).then(() => false)]);
			expect(returnedBeforeIdle).toBe(false);
			expect(session.waitForIdleCalls).toBe(1);

			unblockIdle();
			const response = await firstPrompt;
			expect(response.userMessageId).toBe("00000000-0000-4000-8000-000000000029");
		} finally {
			unblockIdle();
			harness.abortController.abort();
			await Bun.sleep(0);
		}
	});

	it("drains async job deliveries before completing the ACP prompt", async () => {
		const harness = await createHarness();
		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		const session = harness.findSession(created.sessionId)!;
		let releaseDelivery!: () => void;
		let drainCalls = 0;
		const deliveryBlocked = Promise.withResolvers<void>();
		const deliveryRelease = new Promise<void>(resolve => {
			releaseDelivery = resolve;
		});
		session.asyncJobDrain = async () => {
			drainCalls++;
			if (drainCalls > 1) return false;
			deliveryBlocked.resolve();
			await deliveryRelease;
			return true;
		};

		const prompt = harness.agent.prompt({
			sessionId: created.sessionId,
			messageId: "00000000-0000-4000-8000-000000000047",
			prompt: [{ type: "text", text: "wait for async delivery" }],
		} as PromptRequest);
		await deliveryBlocked.promise;

		try {
			const returnedBeforeDelivery = await Promise.race([prompt.then(() => true), Bun.sleep(0).then(() => false)]);
			expect(returnedBeforeDelivery).toBe(false);
			expect(session.waitForIdleCalls).toBe(1);

			releaseDelivery();
			const response = await prompt;
			expect(response.userMessageId).toBe("00000000-0000-4000-8000-000000000047");
			expect(session.waitForIdleCalls).toBe(2);
			expect(drainCalls).toBe(2);
		} finally {
			releaseDelivery();
			harness.abortController.abort();
			await Bun.sleep(0);
		}
	});

	it("keeps async delivery follow-up updates inside the owning ACP prompt", async () => {
		const harness = await createHarness();
		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		const session = harness.findSession(created.sessionId)!;
		let delivered = false;
		let drainCalls = 0;
		session.asyncJobDrain = async () => {
			drainCalls++;
			if (delivered) return false;
			delivered = true;
			const assistantMessage = makeAssistantMessage("async continuation");
			for (const listener of session.listeners()) {
				listener({
					type: "message_update",
					message: assistantMessage,
					assistantMessageEvent: { type: "text_delta", delta: "async continuation" },
				} as AgentSessionEvent);
			}
			return true;
		};

		await harness.agent.prompt({
			sessionId: created.sessionId,
			messageId: "00000000-0000-4000-8000-000000000048",
			prompt: [{ type: "text", text: "deliver async follow-up" }],
		} as PromptRequest);

		expect(harness.updates.some(notification => JSON.stringify(notification).includes("async continuation"))).toBe(
			true,
		);
		expect(session.waitForIdleCalls).toBe(2);
		expect(drainCalls).toBe(2);
		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("queues next prompt until AgentSession idle cleanup completes", async () => {
		const harness = await createHarness();
		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		const session = harness.findSession(created.sessionId)!;
		const { promise: idleBlocked, resolve: markIdleBlocked } = Promise.withResolvers<void>();
		const { promise: releaseIdle, resolve: unblockIdle } = Promise.withResolvers<void>();
		session.waitForIdleBlocker = async () => {
			markIdleBlocked();
			await releaseIdle;
		};

		const firstPrompt = harness.agent.prompt({
			sessionId: created.sessionId,
			messageId: "00000000-0000-4000-8000-000000000030",
			prompt: [{ type: "text", text: "wait for cleanup" }],
		} as PromptRequest);
		await idleBlocked;

		try {
			const secondPrompt = harness.agent.prompt({
				sessionId: created.sessionId,
				messageId: "00000000-0000-4000-8000-000000000031",
				prompt: [{ type: "text", text: "after cleanup" }],
			} as PromptRequest);
			await Bun.sleep(0);
			expect(session.promptCalls).toEqual(["wait for cleanup"]);

			unblockIdle();
			await firstPrompt;
			await secondPrompt;
			expect(session.promptCalls).toEqual(["wait for cleanup", "after cleanup"]);
		} finally {
			unblockIdle();
			harness.abortController.abort();
			await Bun.sleep(0);
		}
	});

	it("serializes multiple prompts queued during idle cleanup", async () => {
		const harness = await createHarness();
		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		const session = harness.findSession(created.sessionId)!;
		const { promise: idleBlocked, resolve: markIdleBlocked } = Promise.withResolvers<void>();
		const { promise: releaseIdle, resolve: unblockIdle } = Promise.withResolvers<void>();
		session.waitForIdleBlocker = async () => {
			markIdleBlocked();
			await releaseIdle;
		};

		const firstPrompt = harness.agent.prompt({
			sessionId: created.sessionId,
			messageId: "00000000-0000-4000-8000-000000000032",
			prompt: [{ type: "text", text: "wait for cleanup" }],
		} as PromptRequest);
		await idleBlocked;

		try {
			const secondPrompt = harness.agent.prompt({
				sessionId: created.sessionId,
				messageId: "00000000-0000-4000-8000-000000000033",
				prompt: [{ type: "text", text: "after cleanup A" }],
			} as PromptRequest);
			const thirdPrompt = harness.agent.prompt({
				sessionId: created.sessionId,
				messageId: "00000000-0000-4000-8000-000000000034",
				prompt: [{ type: "text", text: "after cleanup B" }],
			} as PromptRequest);
			await Bun.sleep(0);
			expect(session.promptCalls).toEqual(["wait for cleanup"]);

			unblockIdle();
			await firstPrompt;
			await secondPrompt;
			await thirdPrompt;
			expect(session.promptCalls).toEqual(["wait for cleanup", "after cleanup A", "after cleanup B"]);
		} finally {
			unblockIdle();
			harness.abortController.abort();
			await Bun.sleep(0);
		}
	});

	it("suppresses late updates after cancel and waits cleanup before the next prompt", async () => {
		const harness = await createHarness();
		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		const session = harness.findSession(created.sessionId)!;
		let releaseAbort!: () => void;
		const abortBlocked = Promise.withResolvers<void>();
		const releaseAbortPromise = new Promise<void>(resolve => {
			releaseAbort = resolve;
		});
		session.abort = async () => {
			session.isStreaming = false;
			abortBlocked.resolve();
			await releaseAbortPromise;
		};
		const finishPrompt = holdPromptStreaming(session);

		const firstPrompt = harness.agent.prompt({
			sessionId: created.sessionId,
			messageId: "00000000-0000-4000-8000-000000000039",
			prompt: [{ type: "text", text: "cancel me" }],
		} as PromptRequest);
		await Bun.sleep(0);
		const beforeCancelUpdates = harness.updates.length;

		const cancelPrompt = harness.agent.cancel({ sessionId: created.sessionId });
		await abortBlocked.promise;
		const returnedBeforeCleanup = await Promise.race([firstPrompt.then(() => true), Bun.sleep(0).then(() => false)]);
		expect(returnedBeforeCleanup).toBe(true);
		const cancelledResponse = await firstPrompt;
		expect(cancelledResponse.stopReason).toBe("cancelled");

		for (const listener of session.listeners()) {
			listener({
				type: "message_update",
				message: makeAssistantMessage("late"),
				assistantMessageEvent: { type: "text_delta", delta: "late" },
			} as AgentSessionEvent);
		}
		expect(harness.updates).toHaveLength(beforeCancelUpdates);

		const secondPrompt = harness.agent.prompt({
			sessionId: created.sessionId,
			messageId: "00000000-0000-4000-8000-000000000040",
			prompt: [{ type: "text", text: "after cancel" }],
		} as PromptRequest);
		await Bun.sleep(0);
		expect(session.promptCalls).toEqual(["cancel me"]);

		releaseAbort();
		await cancelPrompt;
		finishPrompt();
		await secondPrompt;
		expect(session.promptCalls).toEqual(["cancel me", "after cancel"]);

		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("closes the ACP session when cancel cleanup times out", async () => {
		const harness = await createHarness();
		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		const session = harness.findSession(created.sessionId)!;
		harness.agent.setCancelCleanupTimeoutForTesting(10);
		session.abort = async () => new Promise<void>(() => undefined);
		const finishPrompt = holdPromptStreaming(session);

		const firstPrompt = harness.agent.prompt({
			sessionId: created.sessionId,
			messageId: "00000000-0000-4000-8000-000000000041",
			prompt: [{ type: "text", text: "stuck cancel" }],
		} as PromptRequest);
		await Bun.sleep(0);

		const cancelPrompt = harness.agent.cancel({ sessionId: created.sessionId });
		const returnedBeforeTimeout = await Promise.race([firstPrompt.then(() => true), Bun.sleep(0).then(() => false)]);
		expect(returnedBeforeTimeout).toBe(true);
		await expect(cancelPrompt).resolves.toBeUndefined();
		expect(session.disposed).toBe(true);
		await expect(
			harness.agent.prompt({
				sessionId: created.sessionId,
				messageId: "00000000-0000-4000-8000-000000000042",
				prompt: [{ type: "text", text: "after stuck cancel" }],
			} as PromptRequest),
		).rejects.toThrow("Unsupported ACP session");

		finishPrompt();
		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("rejects a queued prompt when cancel cleanup closes the session", async () => {
		const harness = await createHarness();
		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		const session = harness.findSession(created.sessionId)!;
		harness.agent.setCancelCleanupTimeoutForTesting(10);
		session.abort = async () => new Promise<void>(() => undefined);
		const finishPrompt = holdPromptStreaming(session);

		const firstPrompt = harness.agent.prompt({
			sessionId: created.sessionId,
			messageId: "00000000-0000-4000-8000-000000000043",
			prompt: [{ type: "text", text: "stuck cancel before queued" }],
		} as PromptRequest);
		await Bun.sleep(0);

		const cancelPrompt = harness.agent.cancel({ sessionId: created.sessionId });
		await firstPrompt;
		const queuedPrompt = harness.agent
			.prompt({
				sessionId: created.sessionId,
				messageId: "00000000-0000-4000-8000-000000000044",
				prompt: [{ type: "text", text: "queued after stuck cancel" }],
			} as PromptRequest)
			.catch(error => error);

		await cancelPrompt;
		const queuedError = await queuedPrompt;
		expect(queuedError).toBeInstanceOf(Error);
		expect(queuedError.message).toBe("ACP cancel cleanup timed out");
		expect(session.promptCalls).toEqual(["stuck cancel before queued"]);

		finishPrompt();
		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("keeps closeSession gated while cancel cleanup is pending", async () => {
		const harness = await createHarness();
		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		const session = harness.findSession(created.sessionId)!;
		let releaseAbort!: () => void;
		const abortBlocked = Promise.withResolvers<void>();
		const releaseAbortPromise = new Promise<void>(resolve => {
			releaseAbort = resolve;
		});
		session.abort = async () => {
			session.isStreaming = false;
			abortBlocked.resolve();
			await releaseAbortPromise;
		};
		const finishPrompt = holdPromptStreaming(session);

		const firstPrompt = harness.agent.prompt({
			sessionId: created.sessionId,
			messageId: "00000000-0000-4000-8000-000000000045",
			prompt: [{ type: "text", text: "cancel before close" }],
		} as PromptRequest);
		await Bun.sleep(0);

		const cancelPrompt = harness.agent.cancel({ sessionId: created.sessionId });
		await abortBlocked.promise;
		await firstPrompt;

		const closePrompt = harness.agent.closeSession({ sessionId: created.sessionId });
		await Bun.sleep(0);
		expect(session.disposed).toBe(false);

		releaseAbort();
		await cancelPrompt;
		await closePrompt;
		expect(session.disposed).toBe(true);

		finishPrompt();
		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("rejects fork while cancel cleanup is pending", async () => {
		const harness = await createHarness();
		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		const session = harness.findSession(created.sessionId)!;
		let releaseAbort!: () => void;
		const abortBlocked = Promise.withResolvers<void>();
		const releaseAbortPromise = new Promise<void>(resolve => {
			releaseAbort = resolve;
		});
		session.abort = async () => {
			session.isStreaming = false;
			abortBlocked.resolve();
			await releaseAbortPromise;
		};
		const finishPrompt = holdPromptStreaming(session);

		const firstPrompt = harness.agent.prompt({
			sessionId: created.sessionId,
			messageId: "00000000-0000-4000-8000-000000000046",
			prompt: [{ type: "text", text: "cancel before fork" }],
		} as PromptRequest);
		await Bun.sleep(0);

		const cancelPrompt = harness.agent.cancel({ sessionId: created.sessionId });
		await abortBlocked.promise;
		await firstPrompt;

		await expect(
			harness.agent.unstable_forkSession({
				sessionId: created.sessionId,
				cwd: harness.cwdA,
				mcpServers: [],
			}),
		).rejects.toThrow("ACP session fork is unavailable while a prompt is in progress");

		releaseAbort();
		await cancelPrompt;
		finishPrompt();
		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("executes consumed ACP builtins without prompting the agent", async () => {
		const harness = await createHarness();
		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		const session = harness.findSession(created.sessionId)!;

		const response = await harness.agent.prompt({
			sessionId: created.sessionId,
			messageId: "00000000-0000-4000-8000-000000000002",
			prompt: [{ type: "text", text: "/fast status" }],
		} as PromptRequest);

		const chunks = harness.updates.filter(
			update => update.sessionId === created.sessionId && update.update.sessionUpdate === "agent_message_chunk",
		);
		expect(response.userMessageId).toBe("00000000-0000-4000-8000-000000000002");
		expect(session.promptCalls).toEqual([]);
		expect(
			chunks.some(
				update =>
					update.update.sessionUpdate === "agent_message_chunk" &&
					update.update.content.type === "text" &&
					update.update.content.text.includes("Fast 모드 상태"),
			),
		).toBe(true);

		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("forwards removed force slash commands as normal prompts", async () => {
		const harness = await createHarness();
		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		const session = harness.findSession(created.sessionId)!;

		await harness.agent.prompt({
			sessionId: created.sessionId,
			messageId: "00000000-0000-4000-8000-000000000003",
			prompt: [{ type: "text", text: "/force read inspect package.json" }],
		} as PromptRequest);

		expect(session.forcedToolChoice).toBeUndefined();
		expect(session.promptCalls).toEqual(["/force read inspect package.json"]);

		harness.abortController.abort();
		await Bun.sleep(0);
	});

	describe("ACP elicitation bridge", () => {
		const FORM_CAPABILITIES: ClientCapabilities = { elicitation: { form: {} } };

		function createElicitConnection(handler: (req: CreateElicitationRequest) => Promise<CreateElicitationResponse>): {
			connection: AgentSideConnection;
			calls: CreateElicitationRequest[];
		} {
			const calls: CreateElicitationRequest[] = [];
			const connection = {
				unstable_createElicitation: async (req: CreateElicitationRequest) => {
					calls.push(req);
					return handler(req);
				},
			} as unknown as AgentSideConnection;
			return { connection, calls };
		}

		it("translates select to a single-property string-enum elicitation", async () => {
			const { connection, calls } = createElicitConnection(async () => ({
				action: "accept",
				content: { value: "second" },
			}));
			const ctx = createAcpExtensionUiContext(connection, () => "session-select", FORM_CAPABILITIES);

			const result = await ctx.select("Pick one", ["first", "second", "third"]);

			expect(result).toBe("second");
			expect(calls).toHaveLength(1);
			const request = calls[0]!;
			expect(request.mode).toBe("form");
			expect(request.message).toBe("Pick one");
			if (request.mode !== "form" || !("sessionId" in request)) {
				throw new Error("expected session-scoped form elicitation");
			}
			expect(request.sessionId).toBe("session-select");
			expect(request.requestedSchema).toEqual({
				type: "object",
				properties: { value: { type: "string", enum: ["first", "second", "third"] } },
				required: ["value"],
			});
		});

		it("translates confirm to a boolean elicitation and returns the accepted value", async () => {
			const { connection, calls } = createElicitConnection(async () => ({
				action: "accept",
				content: { value: true },
			}));
			const ctx = createAcpExtensionUiContext(connection, () => "session-confirm", FORM_CAPABILITIES);

			const result = await ctx.confirm("Proceed?", "This will overwrite the file.");

			expect(result).toBe(true);
			expect(calls).toHaveLength(1);
			const request = calls[0]!;
			if (request.mode !== "form") {
				throw new Error("expected form-mode elicitation");
			}
			expect(request.message).toBe("Proceed?\n\nThis will overwrite the file.");
			expect(request.requestedSchema.properties?.value).toEqual({ type: "boolean" });
			expect(request.requestedSchema.required).toEqual(["value"]);
		});

		it("translates input to a string elicitation and surfaces the placeholder as description", async () => {
			const { connection, calls } = createElicitConnection(async () => ({
				action: "accept",
				content: { value: "claude" },
			}));
			const ctx = createAcpExtensionUiContext(connection, () => "session-input", FORM_CAPABILITIES);

			const result = await ctx.input("Your name?", "e.g. claude");

			expect(result).toBe("claude");
			expect(calls).toHaveLength(1);
			const request = calls[0]!;
			if (request.mode !== "form") {
				throw new Error("expected form-mode elicitation");
			}
			expect(request.message).toBe("Your name?");
			expect(request.requestedSchema.properties?.value).toEqual({
				type: "string",
				description: "e.g. claude",
			});
		});

		it("returns undefined / false for decline and cancel actions", async () => {
			let nextAction: "decline" | "cancel" = "decline";
			const { connection } = createElicitConnection(async () => ({ action: nextAction }));
			const ctx = createAcpExtensionUiContext(connection, () => "session-cancel", FORM_CAPABILITIES);

			for (const action of ["decline", "cancel"] as const) {
				nextAction = action;
				expect(await ctx.select("X", ["a"])).toBeUndefined();
				expect(await ctx.confirm("X", "Y")).toBe(false);
				expect(await ctx.input("X")).toBeUndefined();
			}
		});

		it("falls back to the stubbed behaviour when the client does not advertise form elicitation", async () => {
			const { connection, calls } = createElicitConnection(async () => ({
				action: "accept",
				content: { value: "ignored" },
			}));
			const ctx = createAcpExtensionUiContext(connection, () => "session-nocaps", {});

			expect(await ctx.select("X", ["a"])).toBeUndefined();
			expect(await ctx.confirm("X", "Y")).toBe(false);
			expect(await ctx.input("X")).toBeUndefined();
			expect(calls).toHaveLength(0);
		});

		it("treats transport-level elicitation failures as undecided input", async () => {
			const { connection, calls } = createElicitConnection(async () => {
				throw new Error("connection closed");
			});
			const ctx = createAcpExtensionUiContext(connection, () => "session-throw", FORM_CAPABILITIES);

			expect(await ctx.select("X", ["a"])).toBeUndefined();
			expect(await ctx.confirm("X", "Y")).toBe(false);
			expect(await ctx.input("X")).toBeUndefined();
			expect(calls).toHaveLength(3);
		});

		it("skips the SDK call entirely when dialogOptions.signal is already aborted", async () => {
			const { connection, calls } = createElicitConnection(async () => ({
				action: "accept",
				content: { value: "ignored" },
			}));
			const ctx = createAcpExtensionUiContext(connection, () => "session-preabort", FORM_CAPABILITIES);
			const controller = new AbortController();
			controller.abort();

			expect(await ctx.select("X", ["a"], { signal: controller.signal })).toBeUndefined();
			expect(await ctx.confirm("X", "Y", { signal: controller.signal })).toBe(false);
			expect(await ctx.input("X", undefined, { signal: controller.signal })).toBeUndefined();
			expect(calls).toHaveLength(0);
		});

		it("resolves to the stub fallback when dialogOptions.signal aborts mid-flight", async () => {
			const { resolve, promise: never } = Promise.withResolvers<CreateElicitationResponse>();
			const { connection, calls } = createElicitConnection(() => never);
			const ctx = createAcpExtensionUiContext(connection, () => "session-midabort", FORM_CAPABILITIES);
			const controller = new AbortController();

			const pending = ctx.select("X", ["a"], { signal: controller.signal });
			controller.abort();
			expect(await pending).toBeUndefined();
			expect(calls).toHaveLength(1);
			// Resolve the never-promise so the bridge's `.then(finish)` chain settles
			// and Bun's promise tracker doesn't flag a leaked pending promise.
			resolve({ action: "decline" });
		});

		it("returns the stub fallback when the client sends a wrong-typed accept payload", async () => {
			// confirm expects a boolean; a string `value` must narrow to `false`.
			const stringForBool = createElicitConnection(async () => ({
				action: "accept",
				content: { value: "yes" },
			}));
			const boolCtx = createAcpExtensionUiContext(
				stringForBool.connection,
				() => "session-wrongtype-bool",
				FORM_CAPABILITIES,
			);
			expect(await boolCtx.confirm("Proceed?", "")).toBe(false);

			// select expects a string; a boolean `value` must narrow to `undefined`.
			const boolForString = createElicitConnection(async () => ({
				action: "accept",
				content: { value: true },
			}));
			const selectCtx = createAcpExtensionUiContext(
				boolForString.connection,
				() => "session-wrongtype-str",
				FORM_CAPABILITIES,
			);
			expect(await selectCtx.select("Pick", ["a"])).toBeUndefined();
		});

		it("returns the stub fallback when accept arrives without the expected `value` key", async () => {
			// content present but missing the `value` key — the bridge looks up
			// `response.content.value` which is `undefined`, so the typeof guard fires.
			const missingKey = createElicitConnection(async () => ({
				action: "accept",
				content: { other: "noise" } as never,
			}));
			const ctx = createAcpExtensionUiContext(missingKey.connection, () => "session-missingkey", FORM_CAPABILITIES);
			expect(await ctx.select("Pick", ["a"])).toBeUndefined();
			expect(await ctx.confirm("Proceed?", "")).toBe(false);
			expect(await ctx.input("Name?")).toBeUndefined();
		});

		it("returns the stub fallback when accept arrives with no content at all", async () => {
			// content omitted entirely — the `!response.content` guard short-circuits
			// before the per-method narrow has a chance to run.
			const noContent = createElicitConnection(async () => ({ action: "accept" }));
			const ctx = createAcpExtensionUiContext(noContent.connection, () => "session-nocontent", FORM_CAPABILITIES);
			expect(await ctx.select("Pick", ["a"])).toBeUndefined();
			expect(await ctx.confirm("Proceed?", "")).toBe(false);
			expect(await ctx.input("Name?")).toBeUndefined();
		});

		it("fires onTimeout and resolves to the stub fallback when dialogOptions.timeout expires", async () => {
			const { promise: never } = Promise.withResolvers<CreateElicitationResponse>();
			const { connection, calls } = createElicitConnection(() => never);
			const ctx = createAcpExtensionUiContext(connection, () => "session-timeout", FORM_CAPABILITIES);
			let timeoutFired = 0;
			const result = await ctx.select("Pick", ["a"], { timeout: 1, onTimeout: () => timeoutFired++ });
			expect(result).toBeUndefined();
			expect(timeoutFired).toBe(1);
			expect(calls).toHaveLength(1);
		});

		it("treats whitespace-only placeholder as absent on `input`", async () => {
			const { connection, calls } = createElicitConnection(async () => ({
				action: "accept",
				content: { value: "n" },
			}));
			const ctx = createAcpExtensionUiContext(connection, () => "session-ws-placeholder", FORM_CAPABILITIES);

			await ctx.input("Name?", "   ");

			expect(calls).toHaveLength(1);
			const request = calls[0]!;
			if (request.mode !== "form") throw new Error("expected form-mode elicitation");
			expect(request.requestedSchema.properties?.value).toEqual({ type: "string" });
		});

		it("sends `message === title` on `confirm` when the message is empty (no join)", async () => {
			const { connection, calls } = createElicitConnection(async () => ({
				action: "accept",
				content: { value: true },
			}));
			const ctx = createAcpExtensionUiContext(connection, () => "session-confirm-empty", FORM_CAPABILITIES);

			await ctx.confirm("Proceed?", "");
			// Whitespace-only message must follow the same branch as empty —
			// CHANGELOG says join only when the message is non-empty.
			await ctx.confirm("Proceed?", "   ");

			expect(calls).toHaveLength(2);
			expect(calls[0]!.message).toBe("Proceed?");
			expect(calls[1]!.message).toBe("Proceed?");
		});

		it("still resolves to the stub fallback when dialogOptions.onTimeout throws", async () => {
			const { promise: never } = Promise.withResolvers<CreateElicitationResponse>();
			const { connection } = createElicitConnection(() => never);
			const ctx = createAcpExtensionUiContext(connection, () => "session-timeout-throw", FORM_CAPABILITIES);

			const result = await ctx.select("Pick", ["a"], {
				timeout: 1,
				onTimeout: () => {
					throw new Error("boom");
				},
			});

			expect(result).toBeUndefined();
		});

		it("reads the sessionId getter on every elicitation so mid-flight session changes are reflected", async () => {
			// `record.session.sessionId` mutates when an extension command calls
			// `ctx.switchSession` / `ctx.newSession`. Snapshotting it once at
			// factory time would route later elicitations to the pre-switch id.
			const { connection, calls } = createElicitConnection(async () => ({
				action: "accept",
				content: { value: "ok" },
			}));
			let currentSessionId = "session-before-switch";
			const ctx = createAcpExtensionUiContext(connection, () => currentSessionId, FORM_CAPABILITIES);

			await ctx.select("Pick", ["a"]);
			currentSessionId = "session-after-switch";
			await ctx.confirm("Continue?", "post-switch");
			await ctx.input("Name?");

			expect(calls).toHaveLength(3);
			// Each call must be a session-scoped form elicitation. Spelled as three
			// separate narrows because `mode === "form"` alone leaves both
			// `ElicitationRequestScope` and `ElicitationSessionScope` in the union —
			// only `"sessionId" in call` picks the session-scoped variant — and
			// loop-style narrows don't propagate to the assertions below.
			const [first, second, third] = calls;
			if (first?.mode !== "form" || !("sessionId" in first)) throw new Error("first call missing sessionId");
			if (second?.mode !== "form" || !("sessionId" in second)) throw new Error("second call missing sessionId");
			if (third?.mode !== "form" || !("sessionId" in third)) throw new Error("third call missing sessionId");
			expect(first.sessionId).toBe("session-before-switch");
			expect(second.sessionId).toBe("session-after-switch");
			expect(third.sessionId).toBe("session-after-switch");
		});
	});
});
