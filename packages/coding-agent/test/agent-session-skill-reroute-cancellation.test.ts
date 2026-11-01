import { afterEach, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, type AgentMessage, type AgentTool } from "@gajae-code/agent-core";
import { getBundledModel } from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { modeStatePath } from "@gajae-code/coding-agent/gjc-runtime/session-layout";
import { readVisibleSkillActiveState } from "@gajae-code/coding-agent/hooks/skill-state";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { FallbackChainController } from "@gajae-code/coding-agent/session/fallback-chain-controller";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import * as z from "zod/v4";
import { createSdkRunCapability } from "../src/sdk/host/sdk-run-capability";

let session: AgentSession | undefined;
let authStorage: AuthStorage | undefined;
let tempDir: string | undefined;

function makeTool(name: string): AgentTool {
	return {
		name,
		label: name,
		description: `${name} test tool`,
		parameters: z.object({}),
		async execute() {
			return { content: [{ type: "text", text: `${name} called` }] };
		},
	};
}

function createLifecycleIndependentSessionManager(): SessionManager {
	const lifecycleRequestId = process.env.GJC_LIFECYCLE_REQUEST_ID;
	const lifecycleSessionId = process.env.GJC_SESSION_ID;
	try {
		delete process.env.GJC_LIFECYCLE_REQUEST_ID;
		delete process.env.GJC_SESSION_ID;
		return SessionManager.inMemory();
	} finally {
		if (lifecycleRequestId === undefined) delete process.env.GJC_LIFECYCLE_REQUEST_ID;
		else process.env.GJC_LIFECYCLE_REQUEST_ID = lifecycleRequestId;
		if (lifecycleSessionId === undefined) delete process.env.GJC_SESSION_ID;
		else process.env.GJC_SESSION_ID = lifecycleSessionId;
	}
}

async function waitForFollowUp(agent: Agent, text: string): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (
		!agent
			.snapshotFollowUp()
			.some(
				message =>
					message.role === "user" &&
					Array.isArray(message.content) &&
					message.content.some(part => part.type === "text" && part.text === text),
			)
	) {
		if (Date.now() >= deadline) throw new Error(`Timed out waiting for queued follow-up: ${text}`);
		await Bun.sleep(1);
	}
}

afterEach(async () => {
	await session?.dispose();
	authStorage?.close();
	if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
	vi.restoreAllMocks();
	session = undefined;
	authStorage = undefined;
	tempDir = undefined;
});

test.serial("forwards preflight cancellation when a prompt reroutes to a skill", async () => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-skill-reroute-cancel-"));
	const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
	authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: ["Test"], tools: [] },
	});
	session = new AgentSession({
		agent,
		sessionManager: createLifecycleIndependentSessionManager(),
		settings: Settings.isolated(),
		modelRegistry,
		skills: [
			{
				name: "fixture-skill",
				description: "Fixture skill",
				filePath: "/tmp/fixture-skill/SKILL.md",
				baseDir: "/tmp/fixture-skill",
				source: "test",
			},
		],
	});
	const controller = new AbortController();
	const rerouteStarted = Promise.withResolvers<void>();
	const invokeSkill = vi.spyOn(session, "invokeSkill").mockImplementation(async (_name, _args, options) => {
		const signal = options?.preflightSignal;
		if (!signal) throw new Error("missing preflight signal");
		rerouteStarted.resolve();
		const cancellation = Promise.withResolvers<never>();
		signal.addEventListener(
			"abort",
			() =>
				cancellation.reject(
					Object.assign(new Error("Skill preflight was cancelled before execution."), {
						code: "busy",
					}),
				),
			{ once: true },
		);
		await cancellation.promise;
		return { name: _name, path: "/tmp/fixture-skill/SKILL.md", args: _args };
	});

	const prompt = session.prompt("/Skill:fixture-skill review", {
		preflightSignal: controller.signal,
	});
	await rerouteStarted.promise;
	controller.abort();

	await expect(prompt).rejects.toMatchObject({ code: "busy" });
	expect(invokeSkill).toHaveBeenCalledWith(
		"fixture-skill",
		"review",
		expect.objectContaining({
			preflightSignal: controller.signal,
			promptAdmissionFence: expect.any(Object),
		}),
	);
	expect(invokeSkill.mock.calls[0]?.[2]?.promptAdmissionFence?.signal.aborted).toBe(true);
});

test.serial("cancels inline skill preparation after a session abort without an external signal", async () => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-skill-internal-abort-"));
	const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
	authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
	const contentLoadStarted = Promise.withResolvers<void>();
	const contentLoadRelease = Promise.withResolvers<void>();
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: ["Test"], tools: [] },
	});
	session = new AgentSession({
		agent,
		sessionManager: createLifecycleIndependentSessionManager(),
		settings: Settings.isolated(),
		modelRegistry,
		skills: [
			{
				name: "fixture-skill",
				description: "Fixture skill",
				filePath: "/tmp/fixture-skill/SKILL.md",
				baseDir: "/tmp/fixture-skill",
				source: "test",
				loadContent: async () => {
					contentLoadStarted.resolve();
					await contentLoadRelease.promise;
					return "Fixture skill body";
				},
			},
		],
	});
	const promptCustomMessage = vi.spyOn(session, "promptCustomMessage");
	const pending = session.prompt("Review /skill:fixture-skill while loading");
	try {
		await contentLoadStarted.promise;
		await session.abort();
		await expect(pending).rejects.toMatchObject({ code: "busy" });
		expect(promptCustomMessage).not.toHaveBeenCalled();
	} finally {
		contentLoadRelease.resolve();
		await pending.catch(() => undefined);
	}
});

test.serial("loads a skill referenced inline in ordinary prompt text", async () => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-skill-leading-slash-"));
	const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
	authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
	const mock = createMockModel({ responses: [{ content: ["ack"] }] });
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		streamFn: mock.stream,
	});
	session = new AgentSession({
		agent,
		sessionManager: createLifecycleIndependentSessionManager(),
		settings: Settings.isolated({ "compaction.enabled": false }),
		modelRegistry,
		skills: [
			{
				name: "fixture-skill",
				description: "Fixture skill",
				filePath: "/tmp/fixture-skill/SKILL.md",
				baseDir: "/tmp/fixture-skill",
				source: "test",
				content: "Fixture skill body",
			},
		],
	});

	const promptCustomMessage = vi.spyOn(session, "promptCustomMessage").mockResolvedValue(undefined);
	await session.prompt("xskill:noise /skill:fixture-skill review");

	expect(promptCustomMessage).toHaveBeenCalledTimes(1);
	expect(promptCustomMessage.mock.calls[0]?.[0]).toMatchObject({
		content: expect.stringContaining("Fixture skill body"),
		details: expect.objectContaining({ args: "xskill:noise review", name: "fixture-skill" }),
	});
	const agentPrompt = vi.spyOn(agent, "prompt").mockResolvedValue(undefined);
	await session.prompt("preserve /skill:unknown literally");
	expect(agentPrompt.mock.calls[0]?.[0]).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				role: "user",
				content: expect.arrayContaining([{ type: "text", text: "preserve /skill:unknown literally" }]),
			}),
		]),
	);
	expect(session.resolvePromptSkillInvocation("preserve /skill:unknown literally")).toBeUndefined();
});

test.serial("keeps synthetic and agent-attributed inline skill text on the ordinary prompt path", async () => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-skill-internal-prompt-"));
	const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
	authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: ["Test"], tools: [] },
	});
	session = new AgentSession({
		agent,
		sessionManager: createLifecycleIndependentSessionManager(),
		settings: Settings.isolated(),
		modelRegistry,
		skills: [
			{
				name: "fixture-skill",
				description: "Fixture skill",
				filePath: "/tmp/fixture-skill/SKILL.md",
				baseDir: "/tmp/fixture-skill",
				source: "test",
				content: "Fixture skill body",
			},
		],
	});
	const promptCustomMessage = vi.spyOn(session, "promptCustomMessage").mockResolvedValue(undefined);
	const agentPrompt = vi.spyOn(agent, "prompt").mockResolvedValue(undefined);
	await session.prompt("Approved plan /skill:fixture-skill should remain a plan", { synthetic: true });
	await session.prompt("Worker assignment /skill:fixture-skill remains literal", { attribution: "agent" });

	expect(promptCustomMessage).not.toHaveBeenCalled();
	expect(agentPrompt.mock.calls[0]?.[0]).toEqual(
		expect.arrayContaining([expect.objectContaining({ role: "developer" })]),
	);
	expect(agentPrompt.mock.calls[1]?.[0]).toEqual(
		expect.arrayContaining([expect.objectContaining({ role: "user", attribution: "agent" })]),
	);
});

test.serial("honors disabled skill commands without disabling explicit skill invocation", async () => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-skill-command-disabled-"));
	const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
	authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
	const settings = Settings.isolated({ "compaction.enabled": false, "skills.enableSkillCommands": false });
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: ["Test"], tools: [] },
	});
	session = new AgentSession({
		agent,
		sessionManager: createLifecycleIndependentSessionManager(),
		settings,
		skillsSettings: settings.getGroup("skills"),
		modelRegistry,
		skills: [
			{
				name: "fixture-skill",
				description: "Fixture skill",
				filePath: "/tmp/fixture-skill/SKILL.md",
				baseDir: "/tmp/fixture-skill",
				source: "test",
				content: "Fixture skill body",
			},
		],
	});
	const promptCustomMessage = vi.spyOn(session, "promptCustomMessage").mockResolvedValue(undefined);
	const agentPrompt = vi.spyOn(agent, "prompt").mockResolvedValue(undefined);
	await session.prompt("Explain /skill:fixture-skill behavior");
	expect(promptCustomMessage).not.toHaveBeenCalled();
	expect(agentPrompt.mock.calls[0]?.[0]).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				role: "user",
				content: expect.arrayContaining([{ type: "text", text: "Explain /skill:fixture-skill behavior" }]),
			}),
		]),
	);
	expect(session.resolvePromptSkillInvocation("Explain /skill:fixture-skill behavior")).toBeUndefined();

	await session.invokeSkill("fixture-skill", "explicit call");
	expect(promptCustomMessage).toHaveBeenCalledTimes(1);
	expect(promptCustomMessage.mock.calls[0]?.[0].content).toContain("Fixture skill body");
});

test.serial("preserves follow-up delivery options when an inline skill reroutes during streaming", async () => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-skill-follow-up-reroute-"));
	const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
	authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
	const activeTurnStarted = Promise.withResolvers<void>();
	const activeTurnRelease = Promise.withResolvers<void>();
	const mock = createMockModel({
		responses: [
			async () => {
				activeTurnStarted.resolve();
				await activeTurnRelease.promise;
				return { content: ["active turn complete"] };
			},
			{ content: ["skill follow-up complete"] },
		],
	});
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		streamFn: mock.stream,
	});
	session = new AgentSession({
		agent,
		sessionManager: createLifecycleIndependentSessionManager(),
		settings: Settings.isolated({ "compaction.enabled": false }),
		modelRegistry,
		skills: [
			{
				name: "fixture-skill",
				description: "Fixture skill",
				filePath: "/tmp/fixture-skill/SKILL.md",
				baseDir: "/tmp/fixture-skill",
				source: "test",
				content: "Fixture skill body",
			},
		],
	});
	const activePrompt = session.prompt("active turn");
	const resetFallbackBudget = vi.spyOn(FallbackChainController.prototype, "resetAttemptBudget");
	try {
		await activeTurnStarted.promise;
		resetFallbackBudget.mockClear();
		const promptCustomMessage = vi.spyOn(session, "promptCustomMessage");
		const accepted = vi.fn();
		await session.prompt("Please handle /skill:fixture-skill this way", {
			streamingBehavior: "followUp",
			followUpQueuePolicy: "sequential",
			onPreflightAcceptCommit: accepted,
		});

		expect(promptCustomMessage.mock.calls[0]?.[1]).toMatchObject({
			streamingBehavior: "followUp",
			followUpQueuePolicy: "sequential",
		});
		expect(promptCustomMessage.mock.calls[0]?.[0].content).toContain("Fixture skill body");
		expect(session.agent.snapshotFollowUp()).toHaveLength(1);
		expect(accepted).toHaveBeenCalledTimes(1);
	} finally {
		activeTurnRelease.resolve();
		await activePrompt;
		await session.waitForIdle();
	}
	expect(resetFallbackBudget).toHaveBeenCalled();
});

test.serial("enforces plan-mode decisions after an inline skill turn", async () => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-skill-plan-mode-reroute-"));
	const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
	authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
	const askTool = makeTool("ask");
	const resolveTool = makeTool("resolve");
	const mock = createMockModel({
		responses: [{ content: ["skill complete"] }, { content: ["plan reminder complete"] }],
	});
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: ["Test"], tools: [askTool, resolveTool], messages: [] },
		streamFn: mock.stream,
	});
	session = new AgentSession({
		agent,
		sessionManager: createLifecycleIndependentSessionManager(),
		settings: Settings.isolated({ "compaction.enabled": false }),
		modelRegistry,
		toolRegistry: new Map([
			[askTool.name, askTool],
			[resolveTool.name, resolveTool],
		]),
		skills: [
			{
				name: "fixture-skill",
				description: "Fixture skill",
				filePath: "/tmp/fixture-skill/SKILL.md",
				baseDir: "/tmp/fixture-skill",
				source: "test",
				content: "Fixture skill body",
			},
		],
	});
	session.setPlanModeState({ enabled: true, planFilePath: path.join(tempDir, "plan.md") });
	const resetFallbackBudget = vi.spyOn(FallbackChainController.prototype, "resetAttemptBudget");
	const prompt = vi.spyOn(session, "prompt");
	await session.prompt("Review /skill:fixture-skill and choose the next step");

	expect(resetFallbackBudget).toHaveBeenCalled();
	expect(prompt).toHaveBeenCalledTimes(2);
	expect(prompt.mock.calls[1]?.[0]).toContain("ask");
	expect(prompt.mock.calls[1]?.[1]).toMatchObject({ synthetic: true, toolChoice: "required" });
});

test.serial("retains the eager-todo prelude for an idle inline skill prompt", async () => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-skill-eager-todo-"));
	const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
	authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
	const todoWriteTool = makeTool("todo_write");
	const mock = createMockModel({ responses: [{ content: ["skill complete"] }] });
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: ["Test"], tools: [todoWriteTool], messages: [] },
		streamFn: mock.stream,
	});
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"todo.enabled": true,
		"todo.eager": true,
	});
	session = new AgentSession({
		agent,
		sessionManager: createLifecycleIndependentSessionManager(),
		settings,
		modelRegistry,
		toolRegistry: new Map([[todoWriteTool.name, todoWriteTool]]),
		skills: [
			{
				name: "fixture-skill",
				description: "Fixture skill",
				filePath: "/tmp/fixture-skill/SKILL.md",
				baseDir: "/tmp/fixture-skill",
				source: "test",
				content: "Fixture skill body",
			},
		],
	});
	const agentPrompt = vi.spyOn(agent, "prompt");
	await session.prompt("Implement /skill:fixture-skill and add regression tests");

	expect(agentPrompt.mock.calls[0]?.[0]).toEqual(
		expect.arrayContaining([expect.objectContaining({ role: "custom", customType: "eager-todo-prelude" })]),
	);
});

test.serial("keeps SDK ownership when an internal skill invocation becomes a custom prompt", async () => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-skill-sdk-owner-"));
	const skillPath = path.join(tempDir, "SKILL.md");
	fs.writeFileSync(skillPath, "# Fixture skill\n\n{{args}}\n");
	const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
	authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: ["Test"], tools: [] },
	});
	session = new AgentSession({
		agent,
		sessionManager: createLifecycleIndependentSessionManager(),
		settings: Settings.isolated(),
		modelRegistry,
		skills: [
			{
				name: "fixture-skill",
				description: "Fixture skill",
				filePath: skillPath,
				baseDir: tempDir,
				source: "test",
			},
		],
	});
	const promptCustomMessage = vi.spyOn(session, "promptCustomMessage").mockResolvedValue(undefined);
	await session.invokeSkill("fixture-skill", "owned", {
		sdkRunCapability: createSdkRunCapability("skill-owner-token"),
	});
	expect(promptCustomMessage).toHaveBeenCalledWith(
		expect.objectContaining({ customType: expect.any(String) }),
		expect.objectContaining({ sdkRunToken: "skill-owner-token" }),
	);
});

test.serial("cancels an ordinary prompt while it waits on the startup barrier", async () => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-prompt-admission-cancel-"));
	const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
	authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: ["Test"], tools: [] },
	});
	const promptAgent = vi.spyOn(agent, "prompt");
	session = new AgentSession({
		agent,
		sessionManager: createLifecycleIndependentSessionManager(),
		settings: Settings.isolated(),
		modelRegistry,
	});
	const startupBarrier = Promise.withResolvers<void>();
	session.extendStartupTurnBarrier(startupBarrier.promise);
	const controller = new AbortController();

	const prompt = session.prompt("wait behind startup", { preflightSignal: controller.signal });
	await Bun.sleep(0);
	controller.abort();

	await expect(prompt).rejects.toMatchObject({ code: "busy" });
	expect(promptAgent).not.toHaveBeenCalled();
	startupBarrier.resolve();
});

test.serial("rolls back workflow state seeded after durable acceptance when preflight is cancelled", async () => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-skill-state-cancel-"));
	const skillDir = path.join(tempDir, "deep-interview");
	const skillPath = path.join(skillDir, "SKILL.md");
	fs.mkdirSync(skillDir, { recursive: true });
	fs.writeFileSync(skillPath, "# Deep interview fixture\n");
	const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
	authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: ["Test"], tools: [] },
	});
	const sessionManager = SessionManager.create(tempDir, tempDir);
	session = new AgentSession({
		agent,
		sessionManager,
		settings: Settings.isolated(),
		modelRegistry,
		skills: [
			{
				name: "deep-interview",
				description: "Deep interview fixture",
				filePath: skillPath,
				baseDir: skillDir,
				source: "test",
			},
		],
	});
	const controller = new AbortController();

	const invocation = session.invokeSkill("deep-interview", undefined, {
		preflightSignal: controller.signal,
		onPreflightAcceptCommit: () => controller.abort(),
	});

	await expect(invocation).rejects.toMatchObject({ code: "busy" });
	const sessionId = sessionManager.getSessionId();
	const visible = await readVisibleSkillActiveState(tempDir, sessionId);
	expect(
		visible?.active_skills?.some(entry => entry.skill === "deep-interview" && entry.active !== false) ?? false,
	).toBe(false);
	expect(fs.existsSync(modeStatePath(tempDir, sessionId, "deep-interview"))).toBe(false);
	expect(agent.state.messages).toHaveLength(0);
});
test.serial("rolls back a real subskill activation after durable acceptance is cancelled", async () => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-subskill-state-cancel-"));
	const skillDir = path.join(tempDir, "deep-interview");
	const skillPath = path.join(skillDir, "SKILL.md");
	const pluginRoot = path.join(tempDir, ".gjc", "gjc-plugins", "cancellation-plugin");
	fs.mkdirSync(path.join(pluginRoot, "subskills", "design"), { recursive: true });
	fs.mkdirSync(skillDir, { recursive: true });
	fs.writeFileSync(skillPath, "# Deep interview fixture\n");
	fs.writeFileSync(
		path.join(pluginRoot, "gajae-plugin.json"),
		JSON.stringify({
			kind: "gajae-code-plugin",
			name: "cancellation-plugin",
			version: "1.0.0",
			subskills: ["subskills/design/SKILL.md"],
			tools: [],
		}),
	);
	fs.writeFileSync(
		path.join(pluginRoot, "subskills", "design", "SKILL.md"),
		"---\nname: design\ndescription: cancellation fixture\nbinds_to: deep-interview\nphase: interviewing\nactivation_arg: design\n---\nCancellation fixture.\n",
	);
	const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
	authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: ["Test"], tools: [] },
	});
	const sessionManager = SessionManager.create(tempDir, tempDir);
	session = new AgentSession({
		agent,
		sessionManager,
		settings: Settings.isolated(),
		modelRegistry,
		skills: [
			{
				name: "deep-interview",
				description: "Deep interview fixture",
				filePath: skillPath,
				baseDir: skillDir,
				source: "test",
			},
		],
	});
	const controller = new AbortController();

	const acceptedSubskills = Promise.withResolvers<void>();
	const invocation = session.invokeSkill("deep-interview", "--design", {
		preflightSignal: controller.signal,
		onPreflightAcceptCommit: async () => {
			const visible = await readVisibleSkillActiveState(tempDir!, sessionManager.getSessionId());
			expect(
				visible?.active_skills?.some(
					entry =>
						entry.skill === "deep-interview" &&
						entry.active_subskills?.some(subskill => subskill.subskillName === "design"),
				) ?? false,
			).toBe(true);
			acceptedSubskills.resolve();
		},
	});
	await acceptedSubskills.promise;
	controller.abort();
	await expect(invocation).rejects.toMatchObject({ code: "busy" });

	const sessionId = sessionManager.getSessionId();
	const visible = await readVisibleSkillActiveState(tempDir, sessionId);
	expect(
		visible?.active_skills?.some(
			entry => entry.skill === "deep-interview" && entry.active !== false && entry.active_subskills?.length,
		) ?? false,
	).toBe(false);
	expect(fs.existsSync(modeStatePath(tempDir, sessionId, "deep-interview"))).toBe(false);
	expect(agent.state.messages).toHaveLength(0);
});

test.serial("cancels only its accepted idle follow-up before it can execute", async () => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-idle-follow-up-cancel-"));
	const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
	authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: ["Test"], tools: [] },
	});
	session = new AgentSession({
		agent,
		sessionManager: createLifecycleIndependentSessionManager(),
		settings: Settings.isolated(),
		modelRegistry,
	});
	const controller = new AbortController();

	agent.followUp({
		role: "user",
		content: [{ type: "text", text: "unrelated follow-up" }],
		attribution: "user",
		timestamp: Date.now(),
	});
	await session.sendUserMessage("owned follow-up", {
		deliverAs: "followUp",
		preflightSignal: controller.signal,
		sdkRunCapability: createSdkRunCapability("sdk-owned-follow-up"),
		onPreflightAcceptCommit: () => {},
	} as never);
	controller.abort();

	expect(agent.snapshotFollowUp()).toMatchObject([{ content: [{ type: "text", text: "unrelated follow-up" }] }]);
	expect(agent.snapshotFollowUp()).toHaveLength(1);
	await Bun.sleep(0);
	expect(agent.state.messages).toHaveLength(0);
});
test.serial("defers an SDK follow-up behind pre-existing queued work so its run token binds", async () => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-follow-up-defer-"));
	const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
	authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: ["Test"], tools: [] },
	});
	session = new AgentSession({
		agent,
		sessionManager: createLifecycleIndependentSessionManager(),
		settings: Settings.isolated(),
		modelRegistry,
	});
	const controller = new AbortController();

	agent.followUp({
		role: "user",
		content: [{ type: "text", text: "unrelated follow-up" }],
		attribution: "user",
		timestamp: Date.now(),
	});
	await session.sendUserMessage("owned follow-up", {
		deliverAs: "followUp",
		preflightSignal: controller.signal,
		sdkRunCapability: createSdkRunCapability("sdk-owned-follow-up-deferred"),
		onPreflightAcceptCommit: () => {},
	} as never);

	// The SDK-owned follow-up must not sit behind the unrelated message: at the
	// next acceptance the unrelated message would run first and the SDK message
	// would be consumed mid-run with its token never bound to an agent_start.
	// It is deferred instead, so the queue holds only the pre-existing work.
	expect(agent.snapshotFollowUp()).toHaveLength(1);
	expect(agent.snapshotFollowUp()[0]).toMatchObject({ content: [{ type: "text", text: "unrelated follow-up" }] });
});

test.serial("releases a deferred SDK follow-up only after queued work drains", async () => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-follow-up-release-"));
	const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
	authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: ["Test"], tools: [] },
	});
	session = new AgentSession({
		agent,
		sessionManager: createLifecycleIndependentSessionManager(),
		settings: Settings.isolated(),
		modelRegistry,
	});

	const unrelated: AgentMessage = {
		role: "user",
		content: [{ type: "text", text: "unrelated follow-up" }],
		attribution: "user",
		timestamp: Date.now(),
	};
	agent.followUp(unrelated);
	await session.sendUserMessage("owned follow-up", {
		deliverAs: "followUp",
		preflightSignal: new AbortController().signal,
		sdkRunCapability: createSdkRunCapability("sdk-owned-follow-up-release"),
		onPreflightAcceptCommit: () => {},
	} as never);
	expect(agent.snapshotFollowUp()).toHaveLength(1);
	// Hold scheduled delivery before dequeue so release is observable even when
	// the continuation runs before the assertion. Session disposal cancels this wait.
	session.extendStartupTurnBarrier(new Promise<void>(() => {}));

	// agent_end while queued work is still pending must hold the SDK follow-up.
	agent.emitExternalEvent({ type: "agent_end", messages: [] });
	await Bun.sleep(20);
	expect(agent.snapshotFollowUp()).toHaveLength(1);
	expect(agent.snapshotFollowUp()[0]).toMatchObject({ content: [{ type: "text", text: "unrelated follow-up" }] });

	// Once the queue drains, the next agent_end releases it as its own run.
	agent.removeQueuedMessages(candidate => candidate === unrelated);
	agent.emitExternalEvent({ type: "agent_end", messages: [] });
	await waitForFollowUp(agent, "owned follow-up");
	expect(agent.snapshotFollowUp()).toHaveLength(1);
	expect(agent.snapshotFollowUp()[0]).toMatchObject({ content: [{ type: "text", text: "owned follow-up" }] });
});
test.serial("releases the next deferred SDK follow-up when a released one is cancelled", async () => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-follow-up-advance-"));
	const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
	authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: ["Test"], tools: [] },
	});
	session = new AgentSession({
		agent,
		sessionManager: createLifecycleIndependentSessionManager(),
		settings: Settings.isolated(),
		modelRegistry,
	});
	const firstController = new AbortController();
	const secondController = new AbortController();
	const unrelated: AgentMessage = {
		role: "user",
		content: [{ type: "text", text: "unrelated follow-up" }],
		attribution: "user",
		timestamp: Date.now(),
	};
	agent.followUp(unrelated);
	await session.sendUserMessage("owned m1", {
		deliverAs: "followUp",
		preflightSignal: firstController.signal,
		sdkRunCapability: createSdkRunCapability("token-m1"),
		onPreflightAcceptCommit: () => {},
	} as never);
	await session.sendUserMessage("owned m2", {
		deliverAs: "followUp",
		preflightSignal: secondController.signal,
		sdkRunCapability: createSdkRunCapability("token-m2"),
		onPreflightAcceptCommit: () => {},
	} as never);
	// Both SDK follow-ups are deferred behind the pre-existing queued work.
	expect(agent.snapshotFollowUp()).toHaveLength(1);
	// Keep m1 cancellable after release, before any continuation can consume it.
	// Session disposal cancels the parked startup wait.
	session.extendStartupTurnBarrier(new Promise<void>(() => {}));

	// agent_end releases only the first deferred follow-up.
	agent.removeQueuedMessages(candidate => candidate === unrelated);
	agent.emitExternalEvent({ type: "agent_end", messages: [] });
	await waitForFollowUp(agent, "owned m1");
	expect(agent.snapshotFollowUp()).toHaveLength(1);
	expect(agent.snapshotFollowUp()[0]).toMatchObject({ content: [{ type: "text", text: "owned m1" }] });

	// Cancelling m1 before its scheduled continuation starts must advance the
	// deferred queue to m2; no further agent_end will arrive to release it.
	firstController.abort();
	await waitForFollowUp(agent, "owned m2");
	expect(agent.snapshotFollowUp()).toHaveLength(1);
	expect(agent.snapshotFollowUp()[0]).toMatchObject({ content: [{ type: "text", text: "owned m2" }] });
});
