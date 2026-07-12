import { afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
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
import type { AssistantMessage, Model } from "@gajae-code/ai";
import { getAgentDir, setAgentDir } from "@gajae-code/utils";
import { resetSettingsForTest, Settings } from "../src/config/settings";
import { ACP_BOOTSTRAP_RACE_GUARD_MS, AcpAgent, createAcpExtensionUiContext } from "../src/modes/acp/acp-agent";
import { getThemeByName, setThemeInstance } from "../src/modes/theme/theme";
import type { PlanModeState } from "../src/plan-mode/state";
import type { AgentSession, AgentSessionEvent } from "../src/session/agent-session";
import { SILENT_ABORT_MARKER } from "../src/session/messages";
import { SessionManager } from "../src/session/session-manager";
import { FileSessionStorage } from "../src/session/session-storage";

const SESSION_UPDATE_VARIANTS = new Set([
	"user_message_chunk",
	"agent_message_chunk",
	"agent_thought_chunk",
	"tool_call",
	"tool_call_update",
	"plan",
	"plan_update",
	"plan_removed",
	"available_commands_update",
	"current_mode_update",
	"config_option_update",
	"session_info_update",
	"usage_update",
]);

function expectSessionNotificationShape(value: unknown): void {
	const notification = value as { sessionId?: unknown; update?: { sessionUpdate?: unknown } };
	const sessionUpdate = notification?.update?.sessionUpdate;
	expect(typeof notification?.sessionId).toBe("string");
	expect(SESSION_UPDATE_VARIANTS.has(typeof sessionUpdate === "string" ? sessionUpdate : "")).toBe(true);
}

function responseUserMessageId(response: { _meta?: { [key: string]: unknown } | null }): string | undefined {
	const value = response._meta?.userMessageId;
	return typeof value === "string" ? value : undefined;
}

function formRequestedSchema(
	request: CreateElicitationRequest,
): { properties?: { value?: unknown }; required?: unknown } | undefined {
	const schema = (request as { requestedSchema?: unknown }).requestedSchema;
	return typeof schema === "object" && schema !== null
		? (schema as { properties?: { value?: unknown }; required?: unknown })
		: undefined;
}

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
function makeProviderSafetyStopMessage(): AssistantMessage {
	return {
		...makeAssistantMessage(""),
		stopReason: "error",
		errorKind: "provider_safety_stop",
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
	promptResponse: AssistantMessage | undefined;
	customMessages: Array<{ customType: string; content: string; details?: unknown }> = [];
	skillsSettings = { enableSkillCommands: true };
	skills: Array<{ name: string; description: string; filePath: string; baseDir: string; source: string }> = [];
	planModeState: PlanModeState | undefined;
	waitForIdleCalls = 0;
	waitForIdleBlocker: (() => Promise<void>) | undefined;
	asyncJobDrain: ((options?: { timeoutMs?: number }) => Promise<boolean>) | undefined;
	asyncDeliveryState: { queued: number; delivering: boolean } | undefined;
	sendCustomMessage = async (message: { customType: string; content: string; details?: unknown }): Promise<void> => {
		this.customMessages.push(message);
	};
	#listeners = new Set<(event: AgentSessionEvent) => void>();

	constructor(
		cwd: string,
		private readonly models: Model[] = TEST_MODELS,
		// Optional flat shared session-dir, mirroring the real
		// `AcpSessionFactoryDescriptor.sessionDir` override. Undefined keeps the
		// per-CWD default layout so existing single-cwd call sites are unchanged.
		sessionDir?: string,
	) {
		this.sessionManager = SessionManager.create(cwd, sessionDir);
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
		const assistantMessage = this.promptResponse ?? makeAssistantMessage("pong");
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
	getAsyncDeliveryStateForAcp(): { queued: number; delivering: boolean } {
		return this.asyncDeliveryState ?? { queued: 0, delivering: false };
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

	async closeWriterStrict(): Promise<
		{ kind: "closed" } | { kind: "close_failed_retryable"; error: Error } | { kind: "close_unknown"; error: Error }
	> {
		await this.sessionManager.flush();
		return this.sessionManager.closeStrict();
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
		expectSessionNotificationShape(update);
	}
}

const cleanupRoots: string[] = [];
// Independently snapshot the resolver agent dir and the env var.
// `setAgentDir(...)` (called per-test in `createHarness`) re-seeds the
// module-global resolver AND sets `process.env.GJC_CODING_AGENT_DIR`, so the
// afterEach restores the resolver from the captured `getAgentDir()` in every
// branch, then resets the env var on its own so presence and value (including
// the empty string) match the snapshot exactly — avoiding leakage of the
// isolated temp dir into other tests.
const originalAgentEnv = process.env.GJC_CODING_AGENT_DIR;
const originalAgentDir = getAgentDir();

afterEach(async () => {
	// Restore the resolver from the independently captured original agent dir
	// in every branch, regardless of whether the env var was originally set.
	setAgentDir(originalAgentDir);
	// Restore the env var independently so presence and value (including the
	// empty string) match the captured snapshot exactly.
	if (originalAgentEnv !== undefined) {
		process.env.GJC_CODING_AGENT_DIR = originalAgentEnv;
	} else {
		delete process.env.GJC_CODING_AGENT_DIR;
	}
	resetSettingsForTest();

	for (const root of cleanupRoots.splice(0)) {
		await fs.promises.rm(root, { recursive: true, force: true });
	}
});

async function createHarness(options?: {
	createSessionGate?: Promise<void>;
	sharedSessionDir?: string;
}): Promise<AgentHarness> {
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

	const initialSession = new FakeAgentSession(cwdA, undefined, options?.sharedSessionDir);
	sessions.push(initialSession);
	const createSession = async (cwd: string): Promise<AgentSession> => {
		await options?.createSessionGate;
		const session = new FakeAgentSession(cwd, undefined, options?.sharedSessionDir);
		sessions.push(session);
		return session as unknown as AgentSession;
	};
	// The factory doubles as the `AcpSessionFactoryDescriptor`: its `sessionDir`
	// is the authoritative connection-wide override (known before the first
	// lifecycle/list call). Undefined keeps the per-CWD default layout.
	const factoryDescriptor = Object.assign(createSession, { sessionDir: options?.sharedSessionDir });

	return {
		agent: new AcpAgent(connection, factoryDescriptor, initialSession as unknown as AgentSession),
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
		const second = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		expect(typeof first.sessionId).toBe("string");
		expect(typeof second.sessionId).toBe("string");

		const firstModelOption = first.configOptions?.find(option => option.id === "model") as
			| { options?: Array<{ value: string }> }
			| undefined;
		expect(firstModelOption?.options?.map(option => option.value)).toEqual(
			TEST_MODELS.map(model => `${model.provider}/${model.id}`),
		);

		await harness.agent.setSessionConfigOption({
			sessionId: first.sessionId,
			configId: "model",
			value: `${TEST_MODELS[1]!.provider}/${TEST_MODELS[1]!.id}`,
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
		expect(typeof forked.sessionId).toBe("string");
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
		expect(typeof created.sessionId).toBe("string");
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
		expect(loaded).toBeDefined();
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

		const live = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		const response = await harness.agent.prompt({
			sessionId: live.sessionId,
			_meta: { userMessageId: "05b17a6f-b310-4be7-b767-6b4f3a84eb63" },
			prompt: [{ type: "text", text: "ping" }],
		} as PromptRequest);
		expect(typeof response.stopReason).toBe("string");
		expectAcpNotifications(harness.updates);

		const liveChunks = harness.updates.filter(
			update => update.sessionId === live.sessionId && update.update.sessionUpdate === "agent_message_chunk",
		);
		expect(responseUserMessageId(response)).toBe("05b17a6f-b310-4be7-b767-6b4f3a84eb63");
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
	it("maps typed provider safety stops to ACP refusals", async () => {
		const harness = await createHarness();
		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		const session = harness.findSession(created.sessionId)!;
		session.promptResponse = makeProviderSafetyStopMessage();

		const response = await harness.agent.prompt({
			sessionId: created.sessionId,
			messageId: "05b17a6f-b310-4be7-b767-6b4f3a84eb64",
			prompt: [{ type: "text", text: "trigger provider safety stop" }],
		} as PromptRequest);

		expect(response.stopReason).toBe("refusal");

		harness.abortController.abort();
		await Bun.sleep(0);
	});
	it("maps persisted legacy provider safety-stop labels to ACP refusals", async () => {
		const harness = await createHarness();
		const persistedLabels = [
			"Refusal (no details provided)",
			"Content flagged by safety filters",
			"Blocked under Anthropic's Usage Policy.",
			"Provider finish_reason: content_filter",
			"provider FINISH_REASON: CONTENT_FILTER\t",
		];
		for (const errorMessage of persistedLabels) {
			const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
			const session = harness.findSession(created.sessionId)!;
			session.promptResponse = {
				...makeAssistantMessage(""),
				stopReason: "error",
				errorMessage,
			};

			const response = await harness.agent.prompt({
				sessionId: created.sessionId,
				messageId: "05b17a6f-b310-4be7-b767-6b4f3a84eb65",
				prompt: [{ type: "text", text: "trigger persisted legacy provider safety stop" }],
			} as PromptRequest);

			expect(response.stopReason).toBe("refusal");
		}

		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("maps incidental legacy safety-stop prose in provider errors to ACP end_turn", async () => {
		const harness = await createHarness();
		const incidentalMessages = [
			"connection error after upstream refusal handshake",
			"connection error: content flagged by safety filters in a prior response",
			"connection error: request was blocked under Anthropic's Usage Policy while retrying",
			"connection error: Provider finish_reason: content_filter",
			"Provider finish_reason: content_filter timeout",
			"Content flagged by safety filtersXYZ",
			"Blocked under vendor Usage Policymaker timeout",
			"Refusal (unterminated transient transport error",
			" Provider finish_reason: content_filter",
			"Provider finish_reason: content_filter\n",
			"Provider finish_reason: content_filter\r\n",
			"Refusal: ",
			"Refusal (cyber): ",
			"Refusal( cyber )",
			"Refusal ( cyber)",
			"Refusal (cyber )",
			"Refusal (cy(ber))",
			"Blocked under xUsage Policy",
			"Provider finish_reason:content_filter",
			"Provider finish_reason:\tcontent_filter",
			"Provider finish_reason:  content_filter",
			"Provider finish_reason: \tcontent_filter",
		];
		for (const errorMessage of incidentalMessages) {
			const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
			const session = harness.findSession(created.sessionId)!;
			session.promptResponse = {
				...makeAssistantMessage(""),
				stopReason: "error",
				errorMessage,
			};

			const response = await harness.agent.prompt({
				sessionId: created.sessionId,
				messageId: "05b17a6f-b310-4be7-b767-6b4f3a84eb66",
				prompt: [{ type: "text", text: "trigger incidental legacy safety-stop prose" }],
			} as PromptRequest);

			expect(response.stopReason).toBe("end_turn");
		}

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

	it("forwards prompt compaction once and returns the session phase to idle", async () => {
		const harness = await createHarness();
		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		const session = harness.findSession(created.sessionId)!;
		await waitForBootstrapGuard();

		session.prompt = async (text: string): Promise<void> => {
			session.promptCalls.push(text);
			session.isStreaming = true;
			for (const listener of session.listeners()) {
				listener({
					type: "auto_compaction_start",
					reason: "overflow",
					action: "context-full",
				} as AgentSessionEvent);
			}
			for (const listener of session.listeners()) {
				listener({
					type: "auto_compaction_end",
					action: "context-full",
					result: undefined,
					aborted: false,
					willRetry: true,
				} as AgentSessionEvent);
			}
			const assistantMessage = makeAssistantMessage("continued after compaction");
			session.sessionManager.appendMessage(assistantMessage);
			for (const listener of session.listeners()) {
				listener({ type: "agent_end", messages: [assistantMessage] } as AgentSessionEvent);
			}
			session.isStreaming = false;
		};

		await harness.agent.prompt({
			sessionId: created.sessionId,
			messageId: "00000000-0000-4000-8000-0000000000cc",
			prompt: [{ type: "text", text: "trigger compaction" }],
		} as PromptRequest);

		const sessionInfoUpdates = harness.updates
			.filter(
				update => update.sessionId === created.sessionId && update.update.sessionUpdate === "session_info_update",
			)
			.map(notification => notification.update);
		const compactionUpdates = sessionInfoUpdates.filter(update => update._meta?.gjcCompactionState !== undefined);
		expect(compactionUpdates).toHaveLength(2);
		expect(compactionUpdates[0]?._meta).toMatchObject({
			gjcPhase: "compacting",
			gjcCompactionState: "start",
			gjcCompactionTrigger: "overflow",
			running: true,
		});
		expect(compactionUpdates[1]?._meta).toMatchObject({
			gjcPhase: "responding",
			gjcCompactionState: "end",
			gjcCompactionWillRetry: true,
			running: true,
		});
		expect(sessionInfoUpdates.at(-1)?._meta).toMatchObject({
			gjcPhase: "idle",
			running: false,
			gjcRunning: false,
		});
		expectAcpNotifications(harness.updates);

		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("forwards idle compaction through the session lifetime subscription", async () => {
		const harness = await createHarness();
		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		const session = harness.findSession(created.sessionId)!;
		await waitForBootstrapGuard();
		const before = harness.updates.length;

		for (const listener of session.listeners()) {
			listener({ type: "auto_compaction_start", reason: "idle", action: "handoff" } as AgentSessionEvent);
		}
		for (const listener of session.listeners()) {
			listener({
				type: "auto_compaction_end",
				action: "handoff",
				result: undefined,
				aborted: false,
				willRetry: false,
			} as AgentSessionEvent);
		}
		await Bun.sleep(0);

		const compactionUpdates = harness.updates
			.slice(before)
			.filter(update => update.update.sessionUpdate === "session_info_update")
			.filter(update => update.update._meta?.gjcCompactionState !== undefined)
			.map(notification => notification.update);
		expect(compactionUpdates).toHaveLength(2);
		expect(compactionUpdates[0]?._meta).toMatchObject({
			gjcPhase: "compacting",
			gjcCompactionTrigger: "idle",
			gjcCompactionAction: "handoff",
			running: true,
		});
		expect(compactionUpdates[1]?._meta).toMatchObject({
			gjcPhase: "idle",
			gjcCompactionState: "end",
			gjcCompactionAction: "handoff",
			running: false,
		});
		expectAcpNotifications(harness.updates);

		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("reports aborted compaction and clears phase when a prompt is cancelled", async () => {
		const harness = await createHarness();
		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		const session = harness.findSession(created.sessionId)!;
		const { promise: compactionStarted, resolve: markCompactionStarted } = Promise.withResolvers<void>();
		const { promise: releasePrompt, resolve: finishPrompt } = Promise.withResolvers<void>();

		session.prompt = async (text: string): Promise<void> => {
			session.promptCalls.push(text);
			session.isStreaming = true;
			for (const listener of session.listeners()) {
				listener({
					type: "auto_compaction_start",
					reason: "threshold",
					action: "context-full",
				} as AgentSessionEvent);
			}
			markCompactionStarted();
			await releasePrompt;
			session.isStreaming = false;
		};
		session.abort = async (): Promise<void> => {
			for (const listener of session.listeners()) {
				listener({
					type: "auto_compaction_end",
					action: "context-full",
					result: undefined,
					aborted: true,
					willRetry: false,
				} as AgentSessionEvent);
			}
			finishPrompt();
			session.isStreaming = false;
		};

		const prompt = harness.agent.prompt({
			sessionId: created.sessionId,
			messageId: "00000000-0000-4000-8000-0000000000ca",
			prompt: [{ type: "text", text: "cancel compaction" }],
		} as PromptRequest);
		await compactionStarted;
		await harness.agent.cancel({ sessionId: created.sessionId });
		expect((await prompt).stopReason).toBe("cancelled");
		await Bun.sleep(0);

		const sessionInfoUpdates = harness.updates
			.filter(
				update => update.sessionId === created.sessionId && update.update.sessionUpdate === "session_info_update",
			)
			.map(notification => notification.update);
		const compactionUpdates = sessionInfoUpdates.filter(update => update._meta?.gjcCompactionState !== undefined);
		expect(compactionUpdates).toHaveLength(2);
		expect(compactionUpdates[1]?._meta).toMatchObject({
			gjcPhase: "idle",
			gjcCompactionState: "end",
			gjcCompactionAborted: true,
			gjcCompactionWillRetry: false,
			running: false,
			gjcRunning: false,
		});
		expect(sessionInfoUpdates.at(-1)?._meta).toMatchObject({
			gjcPhase: "idle",
			running: false,
			gjcRunning: false,
		});

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
			_meta: { userMessageId: "00000000-0000-4000-8000-000000000029" },
			prompt: [{ type: "text", text: "wait for cleanup" }],
		} as PromptRequest);
		await idleBlocked;

		try {
			const returnedBeforeIdle = await Promise.race([firstPrompt.then(() => true), Bun.sleep(0).then(() => false)]);
			expect(returnedBeforeIdle).toBe(false);
			expect(session.waitForIdleCalls).toBe(1);

			unblockIdle();
			const response = await firstPrompt;
			expect(responseUserMessageId(response)).toBe("00000000-0000-4000-8000-000000000029");
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
			_meta: { userMessageId: "00000000-0000-4000-8000-000000000047" },
			prompt: [{ type: "text", text: "wait for async delivery" }],
		} as PromptRequest);
		await deliveryBlocked.promise;

		try {
			const returnedBeforeDelivery = await Promise.race([prompt.then(() => true), Bun.sleep(0).then(() => false)]);
			expect(returnedBeforeDelivery).toBe(false);
			expect(session.waitForIdleCalls).toBe(1);

			releaseDelivery();
			const response = await prompt;
			expect(responseUserMessageId(response)).toBe("00000000-0000-4000-8000-000000000047");
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
		const afterCancelUpdates = harness.updates.length;
		expect(afterCancelUpdates).toBeGreaterThan(beforeCancelUpdates);
		expect(harness.updates.at(-1)?.update._meta).toMatchObject({
			gjcPhase: "idle",
			running: false,
			gjcRunning: false,
		});

		for (const listener of session.listeners()) {
			listener({
				type: "message_update",
				message: makeAssistantMessage("late"),
				assistantMessageEvent: { type: "text_delta", delta: "late" },
			} as AgentSessionEvent);
		}
		expect(harness.updates).toHaveLength(afterCancelUpdates);

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
			_meta: { userMessageId: "00000000-0000-4000-8000-000000000002" },
			prompt: [{ type: "text", text: "/fast status" }],
		} as PromptRequest);

		const chunks = harness.updates.filter(
			update => update.sessionId === created.sessionId && update.update.sessionUpdate === "agent_message_chunk",
		);
		expect(responseUserMessageId(response)).toBe("00000000-0000-4000-8000-000000000002");
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

	// =========================================================================
	// session/delete — strict scope, authority snapshot, fail-closed behavior
	// =========================================================================

	/**
	 * Create a real session on disk in `cwd`'s default session directory, persist
	 * it, close the manager, and return `{ id, path }`. The session is then
	 * "inactive" — discoverable only via strict scoped inventory.
	 */
	async function persistInactiveSession(cwd: string, message = "hello"): Promise<{ id: string; path: string }> {
		const sm = SessionManager.create(cwd);
		sm.appendMessage({ role: "user", content: message, timestamp: Date.now() });
		await sm.ensureOnDisk();
		const id = sm.getSessionId();
		const sessionPath = sm.getSessionFile()!;
		await sm.close();
		return { id, path: sessionPath };
	}

	it("returns {} for delete of an unissued id before any scoped list (lookup-free)", async () => {
		const harness = await createHarness();
		// No explicit-cwd lifecycle/list call has issued any authority receipt yet,
		// so delete is a lookup-free no-op that never scans storage.
		const result = await harness.agent.deleteSession({ sessionId: "nonexistent-id" });
		expect(result).toEqual({});
		// Repeat is also a no-op.
		expect(await harness.agent.deleteSession({ sessionId: "nonexistent-id" })).toEqual({});
		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("returns {} for delete of an unissued id even after a scoped list (lookup-free)", async () => {
		const harness = await createHarness();
		// A scoped list issues authority receipts only for ids it observes; an id
		// never observed has no receipt → delete stays a lookup-free no-op.
		await harness.agent.listSessions({ cwd: harness.cwdA });
		expect(await harness.agent.deleteSession({ sessionId: "no-such-id" })).toEqual({});
		// Repeat no-op.
		expect(await harness.agent.deleteSession({ sessionId: "no-such-id" })).toEqual({});
		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("two CWDs coexist on one connection with isolated scoped lists", async () => {
		const harness = await createHarness();
		// Multiple CWDs coexist on one connection: a second cwd lifecycle never
		// rejects after the first (the old single-scope "scoped to" guard is gone).
		const createdA = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		const createdB = await harness.agent.newSession({ cwd: harness.cwdB, mcpServers: [] });
		expect(typeof createdA.sessionId).toBe("string");
		expect(typeof createdB.sessionId).toBe("string");
		expect(createdA.sessionId).not.toBe(createdB.sessionId);
		// Each cwd's scoped list observes only its own namespace — transcripts,
		// receipts, and authority never leak across cwds.
		const listA = await harness.agent.listSessions({ cwd: harness.cwdA });
		const listB = await harness.agent.listSessions({ cwd: harness.cwdB });
		expect(listA.sessions.some(s => s.sessionId === createdA.sessionId)).toBe(true);
		expect(listA.sessions.some(s => s.sessionId === createdB.sessionId)).toBe(false);
		expect(listB.sessions.some(s => s.sessionId === createdB.sessionId)).toBe(true);
		expect(listB.sessions.some(s => s.sessionId === createdA.sessionId)).toBe(false);
		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("keeps cwd-less listing display-only and non-authorizing for delete", async () => {
		const harness = await createHarness();
		// Create a real session on disk in cwdA.
		const { id } = await persistInactiveSession(harness.cwdA);
		// Cwd-less list works (display-only): it admits no namespace, issues no
		// authority receipt, and bumps no generation.
		const globalList = await harness.agent.listSessions({});
		expect(globalList.sessions.some(s => s.sessionId === id)).toBe(true);
		// Delete with no receipt issued → lookup-free {} (the real session is untouched).
		expect(await harness.agent.deleteSession({ sessionId: id })).toEqual({});
		// An explicit scoped list in cwdA issues a receipt; the session is still present.
		const scopedList = await harness.agent.listSessions({ cwd: harness.cwdA });
		expect(scopedList.sessions.some(s => s.sessionId === id)).toBe(true);
		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("deletes an exact-one inactive scoped session via verified deletion", async () => {
		const harness = await createHarness();
		const { id, path } = await persistInactiveSession(harness.cwdA, "delete-me");
		await harness.agent.listSessions({ cwd: harness.cwdA });
		// File exists before delete.
		expect(fs.existsSync(path)).toBe(true);
		const result = await harness.agent.deleteSession({ sessionId: id });
		expect(result).toEqual({});
		// Transcript gone.
		expect(fs.existsSync(path)).toBe(false);
		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("conflicts on duplicate session id in scoped inventory (fail-closed)", async () => {
		const harness = await createHarness();
		const { id, path: originalPath } = await persistInactiveSession(harness.cwdA, "original");
		// Create a duplicate file with the same header id in the same directory.
		const sessionDir = path.dirname(originalPath);
		const dupPath = path.join(sessionDir, `${id}-dup.jsonl`);
		const header = JSON.stringify({ type: "session", id, cwd: harness.cwdA, version: 2 });
		fs.writeFileSync(dupPath, `${header}\n`);
		// Scoped list succeeds (snapshot sees the conflict).
		const listResult = await harness.agent.listSessions({ cwd: harness.cwdA });
		expect(listResult.sessions.some(s => s.sessionId === id)).toBe(true);
		// Delete must fail-closed — neither transcript is touched.
		await expect(harness.agent.deleteSession({ sessionId: id })).rejects.toThrow(/Duplicate/);
		expect(fs.existsSync(originalPath)).toBe(true);
		expect(fs.existsSync(dupPath)).toBe(true);
		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("marks a cross-cwd duplicate id as absorbing ambiguity with no mutation", async () => {
		const harness = await createHarness();
		const { id, path: cwdAPath } = await persistInactiveSession(harness.cwdA, "cwd-a-original");
		// Plant the same id under cwdB (header cwd = cwdB) so cwdB's strict
		// inventory observes the id under a different namespace.
		const cwdBDir = SessionManager.getDefaultSessionDir(harness.cwdB);
		fs.mkdirSync(cwdBDir, { recursive: true });
		const cwdBPath = path.join(cwdBDir, `planted-${id}.jsonl`);
		fs.writeFileSync(cwdBPath, `${JSON.stringify({ type: "session", id, cwd: harness.cwdB, version: 2 })}\n`);
		// list cwdA issues a unique receipt for id under cwdA.
		await harness.agent.listSessions({ cwd: harness.cwdA });
		// list cwdB observes the same id under cwdB → cross-cwd collision → the
		// receipt flips to the absorbing `ambiguous` state for the connection.
		await harness.agent.listSessions({ cwd: harness.cwdB });
		// Delete must fail-closed; neither transcript is touched.
		await expect(harness.agent.deleteSession({ sessionId: id })).rejects.toThrow(/multiple cwds/);
		// Ambiguous is absorbing: a repeat delete also fails (it never re-authorizes).
		await expect(harness.agent.deleteSession({ sessionId: id })).rejects.toThrow(/multiple cwds/);
		expect(fs.existsSync(cwdAPath)).toBe(true);
		expect(fs.existsSync(cwdBPath)).toBe(true);
		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("fail-closes scoped list and delete when the inventory is corrupt", async () => {
		const harness = await createHarness();
		const { path: goodPath } = await persistInactiveSession(harness.cwdA, "good");
		// Write a corrupt file alongside the valid one.
		const sessionDir = path.dirname(goodPath);
		const corruptPath = path.join(sessionDir, "corrupt.jsonl");
		fs.writeFileSync(corruptPath, "{ this is not valid json\n");
		// Strict scoped list must error — it never grants partial authority.
		await expect(harness.agent.listSessions({ cwd: harness.cwdA })).rejects.toThrow(/incomplete/);
		// The valid session file is untouched.
		expect(fs.existsSync(goodPath)).toBe(true);
		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("detects duplicate ids beyond page 1 before the first page response", async () => {
		const harness = await createHarness();
		// Create 51 unique sessions, then a 52nd that duplicates the first id.
		const first = await persistInactiveSession(harness.cwdA, "first");
		for (let i = 0; i < 50; i++) {
			await persistInactiveSession(harness.cwdA, `filler-${i}`);
		}
		// Create a duplicate of the first id.
		const sessionDir = path.dirname(first.path);
		const dupPath = path.join(sessionDir, `${first.id}-dup2.jsonl`);
		const header = JSON.stringify({ type: "session", id: first.id, cwd: harness.cwdA, version: 2 });
		fs.writeFileSync(dupPath, `${header}\n`);
		// Even page 1 (first 50) must carry the conflict knowledge for the id
		// that appears beyond page 1 — delete must fail-closed.
		const page1 = await harness.agent.listSessions({ cwd: harness.cwdA });
		// Page 1 has at most SESSION_PAGE_SIZE sessions.
		expect(page1.sessions.length).toBeLessThanOrEqual(50);
		await expect(harness.agent.deleteSession({ sessionId: first.id })).rejects.toThrow(/Duplicate/);
		expect(fs.existsSync(first.path)).toBe(true);
		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("deletes an active session: drains prompt, closes writer, removes transcript", async () => {
		const harness = await createHarness();
		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		const session = harness.findSession(created.sessionId)!;
		const sessionPath = session.sessionManager.getSessionFile()!;
		expect(fs.existsSync(sessionPath)).toBe(true);
		const result = await harness.agent.deleteSession({ sessionId: created.sessionId });
		expect(result).toEqual({});
		// Transcript removed.
		expect(fs.existsSync(sessionPath)).toBe(false);
		// Session removed from active map — subsequent operations fail.
		await expect(harness.agent.setSessionMode({ sessionId: created.sessionId, modeId: "default" })).rejects.toThrow(
			"Unsupported ACP session",
		);
		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("isolates authority between connections (reconnect starts unissued)", async () => {
		// Connection A deletes a session.
		const harnessA = await createHarness();
		const { id } = await persistInactiveSession(harnessA.cwdA, "conn-a");
		await harnessA.agent.listSessions({ cwd: harnessA.cwdA });
		await harnessA.agent.deleteSession({ sessionId: id });
		harnessA.abortController.abort();
		await Bun.sleep(0);
		// Connection B (fresh agent) starts with no issued receipts.
		const harnessB = await createHarness();
		// B's delete with no receipt is lookup-free {}.
		expect(await harnessB.agent.deleteSession({ sessionId: id })).toEqual({});
		harnessB.abortController.abort();
		await Bun.sleep(0);
	});

	it("rejects a stale scoped cursor after a lifecycle invalidation between pages", async () => {
		const harness = await createHarness();
		// 51 sessions span two pages (page size 50).
		for (let i = 0; i < 51; i++) {
			await persistInactiveSession(harness.cwdA, `filler-${i}`);
		}
		const page1 = await harness.agent.listSessions({ cwd: harness.cwdA });
		expect(page1.sessions.length).toBe(50);
		expect(page1.nextCursor).toBeDefined();
		// The scoped cursor must carry the generation, not just the offset.
		expect(page1.nextCursor).toMatch(/:/);
		const staleCursor = page1.nextCursor!;
		// Lifecycle invalidation between page 1 and page 2: delete one scoped
		// session, which bumps the authority generation and discards the snapshot.
		await harness.agent.deleteSession({ sessionId: page1.sessions[0]!.sessionId });
		// Page 2 with the old cursor must be rejected — NOT rebuilt at the new gen.
		await expect(harness.agent.listSessions({ cwd: harness.cwdA, cursor: staleCursor })).rejects.toThrow(/stale/);
		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("accepts a still-valid scoped cursor across pages (no false rejection)", async () => {
		const harness = await createHarness();
		for (let i = 0; i < 51; i++) {
			await persistInactiveSession(harness.cwdA, `filler-${i}`);
		}
		const page1 = await harness.agent.listSessions({ cwd: harness.cwdA });
		expect(page1.sessions.length).toBe(50);
		// No lifecycle change → the minted cursor stays valid for page 2.
		const page2 = await harness.agent.listSessions({ cwd: harness.cwdA, cursor: page1.nextCursor });
		expect(page2.sessions.length).toBe(1);
		expect(page2.nextCursor).toBeUndefined();
		harness.abortController.abort();
		await Bun.sleep(0);
	});

	// =========================================================================
	// multi-CWD coexistence — independent cursors, ownership, authority, deletes
	// =========================================================================

	it("per-CWD cursors are independent: a lifecycle change in one cwd invalidates only its cursor", async () => {
		const harness = await createHarness();
		// 51 sessions per cwd span two pages (page size 50) so each mints a cursor.
		for (let i = 0; i < 51; i++) {
			await persistInactiveSession(harness.cwdA, `a-${i}`);
			await persistInactiveSession(harness.cwdB, `b-${i}`);
		}
		const page1A = await harness.agent.listSessions({ cwd: harness.cwdA });
		const page1B = await harness.agent.listSessions({ cwd: harness.cwdB });
		expect(page1A.sessions.length).toBe(50);
		expect(page1B.sessions.length).toBe(50);
		expect(page1A.nextCursor).toBeDefined();
		expect(page1B.nextCursor).toBeDefined();
		// Each namespace embeds its own opaque nonce binder in the versioned
		// grammar `acp1:<nonce>:<generation>:<offset>`; the nonce is segment [1].
		expect(page1A.nextCursor!.split(":")[0]).toBe("acp1");
		const nonceA = page1A.nextCursor!.split(":")[1]!;
		const nonceB = page1B.nextCursor!.split(":")[1]!;
		expect(nonceA).not.toBe(nonceB);
		// A lifecycle change in cwdA (delete one cwdA session via its issued receipt)
		// bumps only cwdA's generation; cwdB's cursor stays valid.
		await harness.agent.deleteSession({ sessionId: page1A.sessions[0]!.sessionId });
		await expect(harness.agent.listSessions({ cwd: harness.cwdA, cursor: page1A.nextCursor })).rejects.toThrow(
			/stale/,
		);
		// cwdB page 2 with its own (still-valid) cursor succeeds.
		const page2B = await harness.agent.listSessions({ cwd: harness.cwdB, cursor: page1B.nextCursor });
		expect(page2B.sessions.length).toBe(1);
		expect(page2B.nextCursor).toBeUndefined();
		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("a scoped cursor from one cwd cannot page another cwd's namespace", async () => {
		const harness = await createHarness();
		// Only cwdA needs >50 sessions to mint a scoped cursor.
		for (let i = 0; i < 51; i++) {
			await persistInactiveSession(harness.cwdA, `a-${i}`);
		}
		const page1A = await harness.agent.listSessions({ cwd: harness.cwdA });
		expect(page1A.nextCursor).toBeDefined();
		// The cursor carries cwdA's namespace nonce; cwdB's namespace has a
		// different nonce, so the cursor is rejected as bound elsewhere — it can
		// never page (or authorize) a different cwd's namespace.
		await expect(harness.agent.listSessions({ cwd: harness.cwdB, cursor: page1A.nextCursor })).rejects.toThrow(
			/bound to a different workspace/,
		);
		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("rejects load/resume of an active session under the wrong cwd (immutable ownership)", async () => {
		const harness = await createHarness();
		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		// The active session is immutably owned by cwdA. A load/resume under cwdB
		// is rejected before any mutation — ownership never rebinds to a new cwd.
		await expect(
			harness.agent.loadSession({ sessionId: created.sessionId, cwd: harness.cwdB, mcpServers: [] }),
		).rejects.toThrow(/already loaded for/);
		await expect(
			harness.agent.resumeSession({ sessionId: created.sessionId, cwd: harness.cwdB, mcpServers: [] }),
		).rejects.toThrow(/already loaded for/);
		// The same-cwd repeat load still succeeds (ownership is immutable, not blocking).
		await harness.agent.loadSession({ sessionId: created.sessionId, cwd: harness.cwdA, mcpServers: [] });
		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("wrong-cwd inactive load/resume is not found (no cross-cwd leakage)", async () => {
		const harness = await createHarness();
		const { id } = await persistInactiveSession(harness.cwdA, "cwd-a-only");
		// The session lives only in cwdA's namespace; cwdB's strict inventory
		// cannot observe it, so load/resume under cwdB is not found — it never
		// falls back to a forgiving cross-cwd lookup.
		await expect(harness.agent.loadSession({ sessionId: id, cwd: harness.cwdB, mcpServers: [] })).rejects.toThrow(
			/not found/,
		);
		await expect(harness.agent.resumeSession({ sessionId: id, cwd: harness.cwdB, mcpServers: [] })).rejects.toThrow(
			/not found/,
		);
		// cwdA can still load it.
		await harness.agent.loadSession({ sessionId: id, cwd: harness.cwdA, mcpServers: [] });
		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("close retains authority for a later inactive delete", async () => {
		const harness = await createHarness();
		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		const session = harness.findSession(created.sessionId)!;
		const sessionPath = session.sessionManager.getSessionFile()!;
		expect(fs.existsSync(sessionPath)).toBe(true);
		// Close is non-destructive: the transcript stays on disk and the authority
		// receipt is retained, so the now-inactive session stays deletable.
		await harness.agent.closeSession({ sessionId: created.sessionId });
		expect(fs.existsSync(sessionPath)).toBe(true);
		expect(await harness.agent.deleteSession({ sessionId: created.sessionId })).toEqual({});
		expect(fs.existsSync(sessionPath)).toBe(false);
		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("honors a connection-wide shared session-dir override known at construction", async () => {
		const sharedDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "gjc-acp-shared-"));
		cleanupRoots.push(sharedDir);
		const harness = await createHarness({ sharedSessionDir: sharedDir });
		// The override is the descriptor's authoritative session-dir, known before
		// any session is created. A fresh-connection scoped list resolves it.
		const emptyList = await harness.agent.listSessions({ cwd: harness.cwdA });
		expect(emptyList.sessions).toHaveLength(0);
		// A session created in cwdA lands in the shared dir, not cwdA's default.
		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		const session = harness.findSession(created.sessionId)!;
		const sharedPath = session.sessionManager.getSessionFile()!;
		expect(sharedPath.startsWith(sharedDir + path.sep)).toBe(true);
		// A scoped list in cwdA inventories the shared dir and finds the session.
		const listA = await harness.agent.listSessions({ cwd: harness.cwdA });
		expect(listA.sessions.some(s => s.sessionId === created.sessionId)).toBe(true);
		harness.abortController.abort();
		await Bun.sleep(0);
	});

	// =========================================================================
	// shared flat session-dir — two cwds coexist, foreign classified not shown
	// =========================================================================

	it("two cwds coexist in one shared flat session-dir: each lists only its own", async () => {
		const sharedDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "gjc-acp-shared-"));
		cleanupRoots.push(sharedDir);
		const harness = await createHarness({ sharedSessionDir: sharedDir });
		// Create one session under each cwd; both transcripts land in the SAME
		// flat directory with their own header cwd.
		const a = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		const b = await harness.agent.newSession({ cwd: harness.cwdB, mcpServers: [] });
		expect(a.sessionId).not.toBe(b.sessionId);
		// A scoped list in cwdA inventories the whole shared root but displays
		// ONLY cwdA's session; cwdB's record is classified as foreign, not shown.
		const listA = await harness.agent.listSessions({ cwd: harness.cwdA });
		expect(listA.sessions.map(s => s.sessionId)).toEqual([a.sessionId]);
		expect(listA.sessions.some(s => s.sessionId === b.sessionId)).toBe(false);
		// Symmetrically, cwdB lists only its own session.
		const listB = await harness.agent.listSessions({ cwd: harness.cwdB });
		expect(listB.sessions.map(s => s.sessionId)).toEqual([b.sessionId]);
		expect(listB.sessions.some(s => s.sessionId === a.sessionId)).toBe(false);
		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("a shared-root cross-cwd duplicate id becomes absorbing ambiguity and is not displayed", async () => {
		const sharedDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "gjc-acp-shared-"));
		cleanupRoots.push(sharedDir);
		const harness = await createHarness({ sharedSessionDir: sharedDir });
		// Issue authority for the id under cwdA first (plant cwdA's record + list),
		// THEN plant the same id under cwdB so the next list observes the collision.
		const id = "shared-dup-id";
		const headerA = JSON.stringify({ type: "session", id, cwd: harness.cwdA, version: 2 });
		const headerB = JSON.stringify({ type: "session", id, cwd: harness.cwdB, version: 2 });
		fs.writeFileSync(path.join(sharedDir, "a.jsonl"), `${headerA}\n`);
		await harness.agent.listSessions({ cwd: harness.cwdA });
		fs.writeFileSync(path.join(sharedDir, "b.jsonl"), `${headerB}\n`);
		// cwdA's next list scans the whole root and detects the same id under
		// cwdB: cross-cwd collision -> the id is not displayed and its receipt
		// flips to the absorbing ambiguous state.
		const listA = await harness.agent.listSessions({ cwd: harness.cwdA });
		expect(listA.sessions.some(s => s.sessionId === id)).toBe(false);
		// Delete of the now-ambiguous id fails closed; nothing is removed.
		await expect(harness.agent.deleteSession({ sessionId: id })).rejects.toThrow(/multiple cwds/);
		expect(fs.existsSync(path.join(sharedDir, "a.jsonl"))).toBe(true);
		expect(fs.existsSync(path.join(sharedDir, "b.jsonl"))).toBe(true);
		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("default per-cwd root still treats a foreign-cwd record as a strict inventory failure", async () => {
		const harness = await createHarness();
		// In a DEFAULT (non-shared) layout, plant a record whose header cwd is
		// cwdB inside cwdA's own session directory. This must remain a hard
		// inventory failure — the shared-root classification never applies.
		const dirA = SessionManager.getDefaultSessionDir(harness.cwdA);
		await fs.promises.mkdir(dirA, { recursive: true });
		const foreignHeader = JSON.stringify({ type: "session", id: "foreign-id", cwd: harness.cwdB, version: 2 });
		fs.writeFileSync(path.join(dirA, "foreign.jsonl"), `${foreignHeader}\n`);
		await expect(harness.agent.listSessions({ cwd: harness.cwdA })).rejects.toThrow(/incomplete/);
		harness.abortController.abort();
		await Bun.sleep(0);
	});

	// =========================================================================
	// scoped cursor grammar — anchored, versioned, exact
	// =========================================================================

	it("rejects malformed and pre-acp1 scoped cursors", async () => {
		const harness = await createHarness();
		// 51 sessions mint a valid scoped cursor for cwdA.
		for (let i = 0; i < 51; i++) {
			await persistInactiveSession(harness.cwdA, `filler-${i}`);
		}
		const page1 = await harness.agent.listSessions({ cwd: harness.cwdA });
		expect(page1.nextCursor).toBeDefined();
		// The grammar is `acp1:<nonce>:<generation>:<offset>`; any deviation fails.
		const valid = page1.nextCursor!;
		expect(valid.split(":")[0]).toBe("acp1");
		const nonce = valid.split(":")[1]!;
		const malformed: string[] = [
			"garbage",
			`${valid.split(":")[0]}:${nonce}:0:0:0:0`, // too many fields
			`1:2:3`, // pre-acp1 / unversioned
			`acp1:${nonce}`, // missing generation + offset
			`acp1:${nonce}:0`, // missing offset
			`acp1:${nonce}:0:0:extra`, // trailing field
			`acp1:${nonce}:0a:0`, // non-digit generation
			`acp1:${nonce}:-1:0`, // sign in generation
			`acp1:${nonce}:0:1e2`, // exponent in offset
			`acp1:${nonce}: 0 :0`, // whitespace
		];
		for (const cursor of malformed) {
			await expect(harness.agent.listSessions({ cwd: harness.cwdA, cursor })).rejects.toThrow(
				/Invalid ACP session cursor/,
			);
		}
		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("a scoped cursor with a foreign nonce is rejected as bound to a different workspace", async () => {
		const harness = await createHarness();
		for (let i = 0; i < 51; i++) {
			await persistInactiveSession(harness.cwdA, `filler-${i}`);
		}
		const page1 = await harness.agent.listSessions({ cwd: harness.cwdA });
		// Well-formed acp1 grammar but a nonce that belongs to no namespace here.
		const foreignCursor = `acp1:00000000-0000-0000-0000-000000000000:${page1.nextCursor!.split(":")[2]}:0`;
		await expect(harness.agent.listSessions({ cwd: harness.cwdA, cursor: foreignCursor })).rejects.toThrow(
			/bound to a different workspace/,
		);
		harness.abortController.abort();
		await Bun.sleep(0);
	});

	// =========================================================================
	// absorbing receipt state machine — replacement, delete tombstone, recreate
	// =========================================================================

	it("a replaced transcript (same id, same cwd, new identity) flips the receipt absorbing and blocks delete", async () => {
		const harness = await createHarness();
		const { id, path: sessionPath } = await persistInactiveSession(harness.cwdA, "original");
		// First scoped list issues a unique receipt bound to the original identity.
		await harness.agent.listSessions({ cwd: harness.cwdA });
		// Replace the transcript: same header id + cwd, but a fresh inode.
		fs.unlinkSync(sessionPath);
		const header = JSON.stringify({ type: "session", id, cwd: harness.cwdA, version: 2 });
		fs.writeFileSync(sessionPath, `${header}\n`);
		// Re-list observes the replacement -> the receipt becomes absorbing
		// (revocation, not a refresh).
		await harness.agent.listSessions({ cwd: harness.cwdA });
		await expect(harness.agent.deleteSession({ sessionId: id })).rejects.toThrow(/replaced|revoked|ambiguous/);
		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("a successful delete retains a tombstone: a second delete is a no-op and a recreate cannot re-authorize", async () => {
		const harness = await createHarness();
		const { id, path: sessionPath } = await persistInactiveSession(harness.cwdA, "doomed");
		await harness.agent.listSessions({ cwd: harness.cwdA });
		// First delete succeeds and removes the transcript.
		expect(await harness.agent.deleteSession({ sessionId: id })).toEqual({});
		expect(fs.existsSync(sessionPath)).toBe(false);
		// Second delete of the genuinely-gone tombstoned id is a lookup-free no-op.
		expect(await harness.agent.deleteSession({ sessionId: id })).toEqual({});
		// Recreate a transcript under the same id (fresh inode).
		const header = JSON.stringify({ type: "session", id, cwd: harness.cwdA, version: 2 });
		fs.writeFileSync(sessionPath, `${header}\n`);
		// Re-list must NOT reissue authority for the recreated id (tombstone stays).
		await harness.agent.listSessions({ cwd: harness.cwdA });
		// The old receipt cannot authorize the recreated transcript.
		await expect(harness.agent.deleteSession({ sessionId: id })).rejects.toThrow(/changed since authority/);
		expect(fs.existsSync(sessionPath)).toBe(true);
		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("an active control requires an exact unique receipt: an ambiguous id refuses prompt/mode", async () => {
		const harness = await createHarness();
		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		// Plant a duplicate of the active id in cwdA's directory, then list so
		// the snapshot detects the duplicate and flips the receipt ambiguous.
		const session = harness.findSession(created.sessionId)!;
		const sessionDir = path.dirname(session.sessionManager.getSessionFile()!);
		const dupPath = path.join(sessionDir, `${created.sessionId}-dup.jsonl`);
		const header = JSON.stringify({ type: "session", id: created.sessionId, cwd: harness.cwdA, version: 2 });
		fs.writeFileSync(dupPath, `${header}\n`);
		await harness.agent.listSessions({ cwd: harness.cwdA });
		// Now the active session's receipt is absorbing; every active control
		// refuses on the ownership gate rather than acting on #sessions alone.
		await expect(harness.agent.setSessionMode({ sessionId: created.sessionId, modeId: "default" })).rejects.toThrow(
			/no active authority receipt/,
		);
		await expect(
			harness.agent.prompt({ sessionId: created.sessionId, prompt: [{ type: "text", text: "hi" }] }),
		).rejects.toThrow(/no active authority receipt/);
		harness.abortController.abort();
		await Bun.sleep(0);
	});

	// =========================================================================
	// session/delete — cleanup_pending, fresh destructive authority, namespace staging
	// =========================================================================

	it("active delete surfaces cleanup_pending (artifacts) without removing the record or reporting success", async () => {
		const harness = await createHarness();
		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		const session = harness.findSession(created.sessionId)!;
		const sessionPath = session.sessionManager.getSessionFile()!;
		expect(fs.existsSync(sessionPath)).toBe(true);
		// Injectable fake: verified delete cannot complete artifact removal.
		const realDelete = session.sessionManager.deleteSessionVerified.bind(session.sessionManager);
		let observedTarget: { expectedArtifactsIdentity?: unknown } | undefined;
		session.sessionManager.deleteSessionVerified = async (target: unknown) => {
			observedTarget = target as { expectedArtifactsIdentity?: unknown };
			return {
				kind: "cleanup_pending",
				phase: "artifacts",
				error: new Error("simulated artifacts rm failure"),
				artifactsIdentity: { dev: 1n, ino: 2n },
				transcriptIdentity: { dev: 3n, ino: 4n },
			};
		};
		await expect(harness.agent.deleteSession({ sessionId: created.sessionId })).rejects.toThrow(/cleanup pending/);
		// Transcript untouched and record retained (not removed, not reported {}).
		expect(fs.existsSync(sessionPath)).toBe(true);
		// The record is locked in cleanup_pending — operations reject until retry.
		await expect(harness.agent.setSessionMode({ sessionId: created.sessionId, modeId: "default" })).rejects.toThrow(
			/terminal state/,
		);
		// No retry evidence was supplied on the first attempt.
		expect(observedTarget?.expectedArtifactsIdentity).toBeUndefined();
		// Restore so afterEach/dispose can clean up.
		session.sessionManager.deleteSessionVerified = realDelete;
		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("active delete retries after cleanup_pending using preserved artifact identity evidence", async () => {
		const harness = await createHarness();
		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		const session = harness.findSession(created.sessionId)!;
		const sessionPath = session.sessionManager.getSessionFile()!;
		const realDelete = session.sessionManager.deleteSessionVerified.bind(session.sessionManager);
		let attempt = 0;
		let retryTarget: { expectedArtifactsIdentity?: unknown } | undefined;
		session.sessionManager.deleteSessionVerified = async (target: unknown) => {
			attempt += 1;
			if (attempt === 1) {
				return {
					kind: "cleanup_pending",
					phase: "artifacts",
					error: new Error("simulated artifacts rm failure"),
					artifactsIdentity: { dev: 9n, ino: 9n },
					transcriptIdentity: (target as { transcriptIdentity: { dev: bigint; ino: bigint } }).transcriptIdentity,
				};
			}
			retryTarget = target as { expectedArtifactsIdentity?: unknown };
			// Simulate a successful retry: remove the transcript and report deleted.
			fs.unlinkSync(sessionPath);
			return { kind: "deleted" };
		};
		// First attempt: partial cleanup → visible error, transcript retained.
		await expect(harness.agent.deleteSession({ sessionId: created.sessionId })).rejects.toThrow(/cleanup pending/);
		expect(fs.existsSync(sessionPath)).toBe(true);
		// Retry: succeeds, and the preserved artifacts identity was bound to the retry target.
		const result = await harness.agent.deleteSession({ sessionId: created.sessionId });
		expect(result).toEqual({});
		expect(fs.existsSync(sessionPath)).toBe(false);
		expect(retryTarget?.expectedArtifactsIdentity).toEqual({ dev: 9n, ino: 9n });
		// Record removed: later operations fail.
		await expect(harness.agent.setSessionMode({ sessionId: created.sessionId, modeId: "default" })).rejects.toThrow(
			"Unsupported ACP session",
		);
		session.sessionManager.deleteSessionVerified = realDelete;
		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("active delete blocks mutation when writer close is unknown (no storage change)", async () => {
		const harness = await createHarness();
		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		const session = harness.findSession(created.sessionId)!;
		const sessionPath = session.sessionManager.getSessionFile()!;
		// Injectable fake: strict close cannot prove closure.
		session.closeWriterStrict = async () => ({ kind: "close_unknown", error: new Error("unknown close") });
		await expect(harness.agent.deleteSession({ sessionId: created.sessionId })).rejects.toThrow(/unknown/);
		// Storage untouched; record locked in terminal_failure — operations reject.
		expect(fs.existsSync(sessionPath)).toBe(true);
		await expect(harness.agent.setSessionMode({ sessionId: created.sessionId, modeId: "default" })).rejects.toThrow(
			/terminal state/,
		);
		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("active delete blocks mutation on retryable writer close failure (no storage change)", async () => {
		const harness = await createHarness();
		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		const session = harness.findSession(created.sessionId)!;
		const sessionPath = session.sessionManager.getSessionFile()!;
		session.closeWriterStrict = async () => ({
			kind: "close_failed_retryable",
			error: new Error("retryable close"),
		});
		await expect(harness.agent.deleteSession({ sessionId: created.sessionId })).rejects.toThrow(
			/failed before dispatch/,
		);
		expect(fs.existsSync(sessionPath)).toBe(true);
		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("concurrent active deletes join one verified-delete dispatch", async () => {
		const harness = await createHarness();
		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		const session = harness.findSession(created.sessionId)!;
		const sessionPath = session.sessionManager.getSessionFile()!;
		const realDelete = session.sessionManager.deleteSessionVerified.bind(session.sessionManager);
		const gate = Promise.withResolvers<void>();
		let dispatches = 0;
		session.sessionManager.deleteSessionVerified = async target => {
			dispatches += 1;
			await gate.promise;
			return realDelete(target);
		};
		const first = harness.agent.deleteSession({ sessionId: created.sessionId });
		await Bun.sleep(0);
		const second = harness.agent.deleteSession({ sessionId: created.sessionId });
		await Bun.sleep(0);
		expect(dispatches).toBe(1);
		gate.resolve();
		const [a, b] = await Promise.all([first, second]);
		expect(a).toEqual({});
		expect(b).toEqual({});
		expect(dispatches).toBe(1);
		expect(fs.existsSync(sessionPath)).toBe(false);
		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("blocks active deletion while async delivery remains queued", async () => {
		const harness = await createHarness();
		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		const session = harness.findSession(created.sessionId)!;
		const sessionPath = session.sessionManager.getSessionFile()!;
		session.asyncJobDrain = async () => false;
		session.asyncDeliveryState = { queued: 1, delivering: false };
		let dispatches = 0;
		const realDelete = session.sessionManager.deleteSessionVerified.bind(session.sessionManager);
		session.sessionManager.deleteSessionVerified = async target => {
			dispatches += 1;
			return realDelete(target);
		};
		await expect(harness.agent.deleteSession({ sessionId: created.sessionId })).rejects.toThrow(/not quiesced/);
		expect(dispatches).toBe(0);
		expect(fs.existsSync(sessionPath)).toBe(true);
		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("rejects an active transcript replacement after cleanup_pending", async () => {
		const harness = await createHarness();
		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		const session = harness.findSession(created.sessionId)!;
		const sessionPath = session.sessionManager.getSessionFile()!;
		let attempts = 0;
		session.sessionManager.deleteSessionVerified = async target => {
			attempts += 1;
			return {
				kind: "cleanup_pending",
				phase: "transcript",
				error: new Error("simulated transcript failure"),
				transcriptIdentity: target.transcriptIdentity,
			};
		};
		await expect(harness.agent.deleteSession({ sessionId: created.sessionId })).rejects.toThrow(/cleanup pending/);
		const contents = fs.readFileSync(sessionPath, "utf8");
		fs.unlinkSync(sessionPath);
		fs.writeFileSync(sessionPath, contents);
		await expect(harness.agent.deleteSession({ sessionId: created.sessionId })).rejects.toThrow(/identity changed/);
		expect(attempts).toBe(1);
		expect(fs.existsSync(sessionPath)).toBe(true);
		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("unissued inactive delete returns {} without scan (receipt-gated)", async () => {
		const harness = await createHarness();
		// An empty scoped list admits the namespace but issues no receipts.
		const empty = await harness.agent.listSessions({ cwd: harness.cwdA });
		expect(empty.sessions).toHaveLength(0);
		// External mutation after the list: a new session lands on disk, but its ID
		// was never issued a receipt → delete is a lookup-free {} (no inventory scan).
		const { id, path } = await persistInactiveSession(harness.cwdA, "created-after-list");
		expect(await harness.agent.deleteSession({ sessionId: id })).toEqual({});
		// The file is untouched — no fresh inventory scan was performed.
		expect(fs.existsSync(path)).toBe(true);
		// After a fresh list, the ID is issued a receipt and a delete can proceed.
		await harness.agent.listSessions({ cwd: harness.cwdA });
		expect(await harness.agent.deleteSession({ sessionId: id })).toEqual({});
		expect(fs.existsSync(path)).toBe(false);
		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("inactive delete retries cleanup_pending with preserved artifact identity", async () => {
		const harness = await createHarness();
		const { id, path: sessionPath } = await persistInactiveSession(harness.cwdA, "partial-inactive");
		await harness.agent.listSessions({ cwd: harness.cwdA });
		const proto = FileSessionStorage.prototype;
		const realDelete = proto.deleteSessionVerified;
		let attempts = 0;
		let retryArtifacts: unknown;
		proto.deleteSessionVerified = async target => {
			attempts += 1;
			if (attempts === 1) {
				return {
					kind: "cleanup_pending",
					phase: "artifacts",
					error: new Error("simulated artifact failure"),
					artifactsIdentity: { dev: 7n, ino: 8n },
					transcriptIdentity: target.transcriptIdentity,
				};
			}
			retryArtifacts = target.expectedArtifactsIdentity;
			fs.unlinkSync(sessionPath);
			return { kind: "deleted" };
		};
		try {
			await expect(harness.agent.deleteSession({ sessionId: id })).rejects.toThrow(/cleanup pending/);
			expect(fs.existsSync(sessionPath)).toBe(true);
			expect(await harness.agent.deleteSession({ sessionId: id })).toEqual({});
			expect(retryArtifacts).toEqual({ dev: 7n, ino: 8n });
			expect(attempts).toBe(2);
			expect(fs.existsSync(sessionPath)).toBe(false);
		} finally {
			proto.deleteSessionVerified = realDelete;
		}
		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("rejects an inactive transcript replacement after cleanup_pending", async () => {
		const harness = await createHarness();
		const { id, path: sessionPath } = await persistInactiveSession(harness.cwdA, "replaced-inactive");
		await harness.agent.listSessions({ cwd: harness.cwdA });
		const proto = FileSessionStorage.prototype;
		const realDelete = proto.deleteSessionVerified;
		let attempts = 0;
		proto.deleteSessionVerified = async target => {
			attempts += 1;
			return {
				kind: "cleanup_pending",
				phase: "transcript",
				error: new Error("simulated transcript failure"),
				transcriptIdentity: target.transcriptIdentity,
			};
		};
		try {
			await expect(harness.agent.deleteSession({ sessionId: id })).rejects.toThrow(/cleanup pending/);
			const contents = fs.readFileSync(sessionPath, "utf8");
			fs.unlinkSync(sessionPath);
			fs.writeFileSync(sessionPath, contents);
			await expect(harness.agent.deleteSession({ sessionId: id })).rejects.toThrow(
				/(identity changed|changed since authority)/,
			);
			expect(attempts).toBe(1);
			expect(fs.existsSync(sessionPath)).toBe(true);
		} finally {
			proto.deleteSessionVerified = realDelete;
		}
		harness.abortController.abort();
		await Bun.sleep(0);
	});

	// =========================================================================
	// Terminal state machine — failure rejection, no-reopen, duplicate rejection,
	// abort joining delete, late lifecycle rollback on shutdown
	// =========================================================================

	it("terminal_failure (close_unknown) rejects operations and never reopens on retry delete", async () => {
		const harness = await createHarness();
		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		const session = harness.findSession(created.sessionId)!;
		const sessionPath = session.sessionManager.getSessionFile()!;
		session.closeWriterStrict = async () => ({ kind: "close_unknown", error: new Error("unknown close") });
		// First delete fails with terminal_failure.
		await expect(harness.agent.deleteSession({ sessionId: created.sessionId })).rejects.toThrow(/unknown/);
		expect(fs.existsSync(sessionPath)).toBe(true);
		// Subsequent delete is rejected — terminal_failure never reopens.
		await expect(harness.agent.deleteSession({ sessionId: created.sessionId })).rejects.toThrow(/unknown/);
		// Normal operations reject on the terminal state.
		await expect(harness.agent.setSessionMode({ sessionId: created.sessionId, modeId: "default" })).rejects.toThrow(
			/terminal state/,
		);
		await expect(harness.agent.closeSession({ sessionId: created.sessionId })).rejects.toThrow(/terminal state/);
		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("quiescence terminal_failure rejects retry and operations", async () => {
		const harness = await createHarness();
		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		const session = harness.findSession(created.sessionId)!;
		const sessionPath = session.sessionManager.getSessionFile()!;
		session.asyncJobDrain = async () => false;
		session.asyncDeliveryState = { queued: 1, delivering: false };
		// First delete fails: quiescence barrier → terminal_failure.
		await expect(harness.agent.deleteSession({ sessionId: created.sessionId })).rejects.toThrow(/not quiesced/);
		expect(fs.existsSync(sessionPath)).toBe(true);
		// Retry is rejected — terminal_failure never reopens.
		await expect(harness.agent.deleteSession({ sessionId: created.sessionId })).rejects.toThrow(/not quiesced/);
		await expect(harness.agent.setSessionMode({ sessionId: created.sessionId, modeId: "default" })).rejects.toThrow(
			/terminal state/,
		);
		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("pre_dispatch_retryable allows a retry delete after close_failed_retryable", async () => {
		const harness = await createHarness();
		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		const session = harness.findSession(created.sessionId)!;
		const sessionPath = session.sessionManager.getSessionFile()!;
		// First attempt: close_failed_retryable → pre_dispatch_retryable.
		session.closeWriterStrict = async () => ({
			kind: "close_failed_retryable",
			error: new Error("retryable close"),
		});
		await expect(harness.agent.deleteSession({ sessionId: created.sessionId })).rejects.toThrow(
			/failed before dispatch/,
		);
		expect(fs.existsSync(sessionPath)).toBe(true);
		// Operations reject while in pre_dispatch_retryable.
		await expect(harness.agent.setSessionMode({ sessionId: created.sessionId, modeId: "default" })).rejects.toThrow(
			/terminal state/,
		);
		// Retry: close succeeds this time → verified delete completes.
		session.closeWriterStrict = async () => ({ kind: "closed" });
		expect(await harness.agent.deleteSession({ sessionId: created.sessionId })).toEqual({});
		expect(fs.existsSync(sessionPath)).toBe(false);
		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("load rejects a transcript replaced while session creation is pending", async () => {
		const gate = Promise.withResolvers<void>();
		const harness = await createHarness({ createSessionGate: gate.promise });
		const { id, path: sessionPath } = await persistInactiveSession(harness.cwdA, "load-replaced");
		const loadPromise = harness.agent.loadSession({ sessionId: id, cwd: harness.cwdA, mcpServers: [] });
		await Bun.sleep(0);
		const contents = fs.readFileSync(sessionPath, "utf8");
		fs.unlinkSync(sessionPath);
		fs.writeFileSync(sessionPath, contents);
		gate.resolve();
		await expect(loadPromise).rejects.toThrow(/changed while opening/);
		expect(fs.existsSync(sessionPath)).toBe(true);
		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("resume rejects a transcript replaced while session creation is pending", async () => {
		const gate = Promise.withResolvers<void>();
		const harness = await createHarness({ createSessionGate: gate.promise });
		const { id, path: sessionPath } = await persistInactiveSession(harness.cwdA, "resume-replaced");
		const resumePromise = harness.agent.resumeSession({ sessionId: id, cwd: harness.cwdA, mcpServers: [] });
		await Bun.sleep(0);
		const contents = fs.readFileSync(sessionPath, "utf8");
		fs.unlinkSync(sessionPath);
		fs.writeFileSync(sessionPath, contents);
		gate.resolve();
		await expect(resumePromise).rejects.toThrow(/changed while opening/);
		expect(fs.existsSync(sessionPath)).toBe(true);
		harness.abortController.abort();
		await Bun.sleep(0);
	});

	function replacePathWithSameContents(file: string): void {
		const replacement = `${file}.replacement`;
		fs.writeFileSync(replacement, fs.readFileSync(file));
		fs.unlinkSync(file);
		fs.renameSync(replacement, file);
	}

	it("fork of an active session refuses to reauthorize a transcript replaced after admission", async () => {
		const harness = await createHarness();
		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		const session = harness.findSession(created.sessionId)!;
		const sessionPath = session.sessionManager.getSessionFile()!;
		expect(fs.existsSync(sessionPath)).toBe(true);
		// Create the replacement while the original inode is still allocated so
		// immediate inode reuse cannot make this platform-dependent.
		replacePathWithSameContents(sessionPath);
		const sessionDir = path.dirname(sessionPath);
		const beforeFiles = fs.readdirSync(sessionDir).filter(f => f.endsWith(".jsonl"));
		await expect(
			harness.agent.unstable_forkSession({ sessionId: created.sessionId, cwd: harness.cwdA, mcpServers: [] }),
		).rejects.toThrow(/could not be bound to a verified descriptor/);
		// No fork publication leaked: the directory is unchanged.
		const afterFiles = fs.readdirSync(sessionDir).filter(f => f.endsWith(".jsonl"));
		expect(afterFiles).toEqual(beforeFiles);
		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("load admission binds the receipt to the selected descriptor identity, not a post-selection pathname restat", async () => {
		const harness = await createHarness();
		const { id, path: sessionPath } = await persistInactiveSession(harness.cwdA, "provenance-load");
		// Replace the transcript inside the selection→admission window:
		// switchSession runs immediately after the descriptor-bound read (which
		// binds the original inode) and immediately before receipt admission, so
		// swapping the pathname to a fresh inode here isolates whether the receipt
		// is bound to the selected identity or a fresh mutable-path restat.
		const realSwitch = FakeAgentSession.prototype.switchSession;
		const switchSpy = spyOn(FakeAgentSession.prototype, "switchSession").mockImplementation(async function (
			this: FakeAgentSession,
			switchPath: string,
		) {
			const result = await realSwitch.call(this, switchPath);
			replacePathWithSameContents(switchPath);
			return result;
		});
		try {
			await harness.agent.loadSession({ sessionId: id, cwd: harness.cwdA, mcpServers: [] });
		} finally {
			switchSpy.mockRestore();
		}
		// Close is non-destructive and retains the receipt; the session is inactive.
		await harness.agent.closeSession({ sessionId: id });
		// The receipt is bound to the SELECTED inode; the pathname now holds the
		// replacement inode, so a fresh strict inventory revalidates a different
		// identity and fails closed — it never reauthorizes the replacement that a
		// restat-based admission receipt would have bound.
		await expect(harness.agent.deleteSession({ sessionId: id })).rejects.toThrow(/changed since authority/);
		expect(fs.existsSync(sessionPath)).toBe(true);
		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("resume admission binds the receipt to the selected descriptor identity, not a post-selection pathname restat", async () => {
		const harness = await createHarness();
		const { id, path: sessionPath } = await persistInactiveSession(harness.cwdA, "provenance-resume");
		const realSwitch = FakeAgentSession.prototype.switchSession;
		const switchSpy = spyOn(FakeAgentSession.prototype, "switchSession").mockImplementation(async function (
			this: FakeAgentSession,
			switchPath: string,
		) {
			const result = await realSwitch.call(this, switchPath);
			replacePathWithSameContents(switchPath);
			return result;
		});
		try {
			await harness.agent.resumeSession({ sessionId: id, cwd: harness.cwdA, mcpServers: [] });
		} finally {
			switchSpy.mockRestore();
		}
		await harness.agent.closeSession({ sessionId: id });
		await expect(harness.agent.deleteSession({ sessionId: id })).rejects.toThrow(/changed since authority/);
		expect(fs.existsSync(sessionPath)).toBe(true);
		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("strict scoped inventory rejects a header cwd mismatch", async () => {
		const harness = await createHarness();
		const { path: sessionPath } = await persistInactiveSession(harness.cwdA, "wrong-header-cwd");
		const lines = fs.readFileSync(sessionPath, "utf8").split("\n");
		const header = JSON.parse(lines[0]!) as Record<string, unknown>;
		header.cwd = harness.cwdB;
		lines[0] = JSON.stringify(header);
		fs.writeFileSync(sessionPath, lines.join("\n"));
		await expect(harness.agent.listSessions({ cwd: harness.cwdA })).rejects.toThrow(/inventory is incomplete/);
		expect(fs.existsSync(sessionPath)).toBe(true);
		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("rejects duplicate load/resume via strict inventory (no first-match fallback)", async () => {
		const harness = await createHarness();
		const { id, path: originalPath } = await persistInactiveSession(harness.cwdA, "original");
		// Create a duplicate file with the same header id in the same directory.
		const sessionDir = path.dirname(originalPath);
		const dupPath = path.join(sessionDir, `${id}-dup.jsonl`);
		const header = JSON.stringify({ type: "session", id, cwd: harness.cwdA, version: 2 });
		fs.writeFileSync(dupPath, `${header}\n`);
		// Load must fail on the duplicate — never silently pick the first match.
		await expect(harness.agent.loadSession({ sessionId: id, cwd: harness.cwdA, mcpServers: [] })).rejects.toThrow(
			/Duplicate/,
		);
		// Resume must also fail on the duplicate.
		await expect(harness.agent.resumeSession({ sessionId: id, cwd: harness.cwdA, mcpServers: [] })).rejects.toThrow(
			/Duplicate/,
		);
		// Neither file was opened.
		expect(fs.existsSync(originalPath)).toBe(true);
		expect(fs.existsSync(dupPath)).toBe(true);
		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("connection abort joins terminal delete before disposing records", async () => {
		const harness = await createHarness();
		await harness.agent.initialize({ protocolVersion: 1 });
		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		const session = harness.findSession(created.sessionId)!;
		const sessionPath = session.sessionManager.getSessionFile()!;
		const idleGate = Promise.withResolvers<void>();
		session.waitForIdleBlocker = () => idleGate.promise;
		const deletePromise = harness.agent.deleteSession({ sessionId: created.sessionId });
		await Bun.sleep(0);
		harness.abortController.abort();
		await Bun.sleep(0);
		expect(fs.existsSync(sessionPath)).toBe(true);
		idleGate.resolve();
		expect(await deletePromise).toEqual({});
		await harness.agent.shutdownPromise;
		expect(fs.existsSync(sessionPath)).toBe(false);
	});

	it("rejects an issued inactive candidate replaced before delete", async () => {
		const harness = await createHarness();
		const { id, path: sessionPath } = await persistInactiveSession(harness.cwdA, "issued-replacement");
		await harness.agent.listSessions({ cwd: harness.cwdA });
		const contents = fs.readFileSync(sessionPath, "utf8");
		fs.unlinkSync(sessionPath);
		fs.writeFileSync(sessionPath, contents);
		await expect(harness.agent.deleteSession({ sessionId: id })).rejects.toThrow(/changed since authority/);
		expect(fs.existsSync(sessionPath)).toBe(true);
		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("shutdown waits for in-flight lifecycle preparation and rollback", async () => {
		const gate = Promise.withResolvers<void>();
		const harness = await createHarness({ createSessionGate: gate.promise });
		await harness.agent.initialize({ protocolVersion: 1 });
		const createPromise = harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		harness.abortController.abort();
		let shutdownSettled = false;
		void harness.agent.shutdownPromise.then(() => {
			shutdownSettled = true;
		});
		await Bun.sleep(0);
		expect(shutdownSettled).toBe(false);
		gate.resolve();
		await expect(createPromise).rejects.toThrow(/shutdown/);
		await harness.agent.shutdownPromise;
		expect(shutdownSettled).toBe(true);
		const prepared = harness.sessions.at(-1)!;
		expect(prepared.disposed).toBe(true);
	});

	it("late lifecycle registration is rolled back when shutdown wins the race", async () => {
		const harness = await createHarness();
		const { id } = await persistInactiveSession(harness.cwdA, "late-load");
		// Register the connection cleanup listener so abort sets #shuttingDown.
		await harness.agent.initialize({ protocolVersion: 1 });
		// Trigger shutdown — #shuttingDown is set synchronously.
		harness.abortController.abort();
		// After shutdown, new lifecycle calls must reject before start.
		await expect(harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] })).rejects.toThrow(/shutdown/);
		await expect(harness.agent.loadSession({ sessionId: id, cwd: harness.cwdA, mcpServers: [] })).rejects.toThrow(
			/shutdown/,
		);
		await expect(harness.agent.listSessions({ cwd: harness.cwdA })).rejects.toThrow(/shutdown/);
		await Bun.sleep(0);
	});

	it("a scoped list flushes loaded sessions from every cwd before paging", async () => {
		const harness = await createHarness();
		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		const session = harness.findSession(created.sessionId)!;
		const realFlush = session.sessionManager.flush.bind(session.sessionManager);
		let flushes = 0;
		session.sessionManager.flush = async () => {
			flushes += 1;
			return realFlush();
		};
		// A scoped list in a DIFFERENT cwd still flushes every loaded session
		// (the flush is global) before its inventory — multi-CWD coexistence does
		// not skip flushing, and the second-cwd list succeeds instead of rejecting.
		const listB = await harness.agent.listSessions({ cwd: harness.cwdB });
		expect(Array.isArray(listB.sessions)).toBe(true);
		expect(flushes).toBeGreaterThanOrEqual(1);
		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("preserves an existing loaded record when repeat-load response construction fails", async () => {
		const harness = await createHarness();
		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		const session = harness.findSession(created.sessionId)!;
		const modelSpy = spyOn(session, "getAvailableModels").mockImplementationOnce(() => {
			throw new Error("repeat response build failed");
		});
		await expect(
			harness.agent.loadSession({ sessionId: created.sessionId, cwd: harness.cwdA, mcpServers: [] }),
		).rejects.toThrow(/repeat response build failed/);
		modelSpy.mockRestore();
		expect(session.disposed).toBe(false);
		await harness.agent.setSessionMode({ sessionId: created.sessionId, modeId: "default" });
		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("an invalid first scoped cursor does not block a different cwd", async () => {
		const harness = await createHarness();
		await expect(harness.agent.listSessions({ cwd: harness.cwdA, cursor: "invalid" })).rejects.toThrow();
		const created = await harness.agent.newSession({ cwd: harness.cwdB, mcpServers: [] });
		expect(typeof created.sessionId).toBe("string");
		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("a failed first load response build does not block a different cwd", async () => {
		const harness = await createHarness();
		const { id } = await persistInactiveSession(harness.cwdA, "response-build-failure");
		const modelSpy = spyOn(FakeAgentSession.prototype, "getAvailableModels").mockImplementationOnce(() => {
			throw new Error("response build failed");
		});
		await expect(harness.agent.loadSession({ sessionId: id, cwd: harness.cwdA, mcpServers: [] })).rejects.toThrow(
			/response build failed/,
		);
		modelSpy.mockRestore();
		const created = await harness.agent.newSession({ cwd: harness.cwdB, mcpServers: [] });
		expect(typeof created.sessionId).toBe("string");
		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("a failed first lifecycle call does not block other cwds", async () => {
		const harness = await createHarness();
		// First call: load a nonexistent session in cwdA — must fail.
		await expect(
			harness.agent.loadSession({ sessionId: "no-such-session", cwd: harness.cwdA, mcpServers: [] }),
		).rejects.toThrow(/not found/);
		// A later lifecycle call in a different cwd must succeed (no global cwd lock).
		const created = await harness.agent.newSession({ cwd: harness.cwdB, mcpServers: [] });
		expect(typeof created.sessionId).toBe("string");
		// cwdA is still independently usable — multi-CWD, not single-scope.
		const listA = await harness.agent.listSessions({ cwd: harness.cwdA });
		expect(Array.isArray(listA.sessions)).toBe(true);
		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("a failed first scoped list does not block a different cwd", async () => {
		const harness = await createHarness();
		const { path: goodPath } = await persistInactiveSession(harness.cwdA, "good");
		// Corrupt the inventory so the first scoped list in cwdA fails.
		const sessionDir = path.dirname(goodPath);
		fs.writeFileSync(path.join(sessionDir, "corrupt.jsonl"), "{ not valid json\n");
		await expect(harness.agent.listSessions({ cwd: harness.cwdA })).rejects.toThrow(/incomplete/);
		// cwdA's failure does not block cwdB: a scoped list in cwdB must succeed.
		const other = await harness.agent.listSessions({ cwd: harness.cwdB });
		expect(Array.isArray(other.sessions)).toBe(true);
		harness.abortController.abort();
		await Bun.sleep(0);
	});
	// =========================================================================
	// Fork/new rollback — committed owned publication verified-deleted on
	// response/bootstrap failure; load/resume source transcript retained
	// =========================================================================

	it("fork response failure after commit verified-deletes only the owned publication, leaving the load source", async () => {
		const harness = await createHarness();
		// Persist an inactive load/resume source and issue authority via a scoped list.
		const { id: sourceId, path: sourcePath } = await persistInactiveSession(harness.cwdA, "fork-rollback-source");
		await harness.agent.listSessions({ cwd: harness.cwdA });
		const sessionDir = path.dirname(sourcePath);
		const beforeFiles = fs.readdirSync(sessionDir).filter(f => f.endsWith(".jsonl"));
		expect(beforeFiles).toHaveLength(1);

		// Deterministic proof the fork COMMITTED before the response failure: wrap
		// SessionManager.fork to record the owned publication path it produced.
		const realSmFork = SessionManager.prototype.fork;
		const realModels = FakeAgentSession.prototype.getAvailableModels;
		let forkCommitted = false;
		let committedForkPath: string | undefined;
		const smForkSpy = spyOn(SessionManager.prototype, "fork").mockImplementation(async function (
			this: SessionManager,
		) {
			const result = await realSmFork.call(this);
			if (result) {
				forkCommitted = true;
				committedForkPath = result.newSessionFile;
			}
			return result;
		});
		// Inject a deterministic response-build failure AFTER the record commits.
		// #buildConfigOptions is the first post-commit caller of getAvailableModels;
		// the forkCommitted guard guarantees the throw lands in the fork try-block,
		// driving #rollbackUnpublishedRecord rather than a pre-commit dispose leak.
		const modelSpy = spyOn(FakeAgentSession.prototype, "getAvailableModels").mockImplementation(function (
			this: FakeAgentSession,
		) {
			if (forkCommitted) throw new Error("fork response build failed");
			return realModels.call(this);
		});
		try {
			await expect(
				harness.agent.unstable_forkSession({ sessionId: sourceId, cwd: harness.cwdA, mcpServers: [] }),
			).rejects.toThrow(/fork response build failed/);
		} finally {
			smForkSpy.mockRestore();
			modelSpy.mockRestore();
		}

		// The fork committed an owned publication before the failure.
		expect(committedForkPath).toBeDefined();
		expect(committedForkPath).not.toBe(sourcePath);
		// Rollback verified-deleted the owned fork transcript AND its artifact directory.
		expect(fs.existsSync(committedForkPath!)).toBe(false);
		expect(fs.existsSync(committedForkPath!.slice(0, -6))).toBe(false);
		// The load/resume source transcript remains untouched.
		expect(fs.existsSync(sourcePath)).toBe(true);
		// No leaked fork transcript or stage: only the source remains.
		const afterFiles = fs.readdirSync(sessionDir).filter(f => f.endsWith(".jsonl"));
		expect(afterFiles).toEqual(beforeFiles);
		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("new session response failure after commit verified-deletes the owned new publication", async () => {
		const harness = await createHarness();
		const sessionDir = SessionManager.getDefaultSessionDir(harness.cwdA);
		fs.mkdirSync(sessionDir, { recursive: true });
		const beforeFiles = fs.readdirSync(sessionDir).filter(f => f.endsWith(".jsonl"));

		// #buildConfigOptions is the first post-commit caller of getAvailableModels,
		// so mockImplementationOnce fires after #createNewSessionRecord committed
		// the new transcript + receipt, driving #rollbackUnpublishedRecord.
		const modelSpy = spyOn(FakeAgentSession.prototype, "getAvailableModels").mockImplementationOnce(() => {
			throw new Error("new response build failed");
		});
		await expect(harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] })).rejects.toThrow(
			/new response build failed/,
		);
		modelSpy.mockRestore();
		// The owned new publication was verified-deleted on rollback: no transcript
		// or artifact directory survives the failed response.
		const afterFiles = fs.readdirSync(sessionDir).filter(f => f.endsWith(".jsonl"));
		expect(afterFiles).toEqual(beforeFiles);
		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("load response failure leaves the stored source transcript intact (no owned publication to delete)", async () => {
		const harness = await createHarness();
		const { id, path: sourcePath } = await persistInactiveSession(harness.cwdA, "load-rollback-source");
		await harness.agent.listSessions({ cwd: harness.cwdA });
		// Load/resume hydrates from a stored source with NO owned publication: a
		// response failure rolls back the prepared record but never deletes source.
		const modelSpy = spyOn(FakeAgentSession.prototype, "getAvailableModels").mockImplementationOnce(() => {
			throw new Error("load response build failed");
		});
		await expect(harness.agent.loadSession({ sessionId: id, cwd: harness.cwdA, mcpServers: [] })).rejects.toThrow(
			/load response build failed/,
		);
		modelSpy.mockRestore();
		// The source transcript is untouched by the load rollback.
		expect(fs.existsSync(sourcePath)).toBe(true);
		// The source remains authoritatively deletable afterwards (receipt retained).
		expect(await harness.agent.deleteSession({ sessionId: id })).toEqual({});
		expect(fs.existsSync(sourcePath)).toBe(false);
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
			const requestedSchema = formRequestedSchema(request);
			expect(requestedSchema?.properties?.value).toEqual({ type: "boolean" });
			expect(requestedSchema?.required).toEqual(["value"]);
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
			expect(formRequestedSchema(request)?.properties?.value).toEqual({
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
			expect(formRequestedSchema(request)?.properties?.value).toEqual({ type: "string" });
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
