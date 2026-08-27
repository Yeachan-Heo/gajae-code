import { afterEach, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, type AgentMessage } from "@gajae-code/agent-core";
import { getBundledModel } from "@gajae-code/ai";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { modeStatePath } from "@gajae-code/coding-agent/gjc-runtime/session-layout";
import { readVisibleSkillActiveState } from "@gajae-code/coding-agent/hooks/skill-state";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";

let session: AgentSession | undefined;
let authStorage: AuthStorage | undefined;
let tempDir: string | undefined;

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

	const prompt = session.prompt("/skill:fixture-skill review", {
		preflightSignal: controller.signal,
	});
	await rerouteStarted.promise;
	controller.abort();

	await expect(prompt).rejects.toMatchObject({ code: "busy" });
	expect(invokeSkill).toHaveBeenCalledWith("fixture-skill", "review", {
		preflightSignal: controller.signal,
	});
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
		sdkRunToken: "sdk-owned-follow-up",
		onPreflightAcceptCommit: () => {},
	});
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
		sdkRunToken: "sdk-owned-follow-up-deferred",
		onPreflightAcceptCommit: () => {},
	});

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
		sdkRunToken: "sdk-owned-follow-up-release",
		onPreflightAcceptCommit: () => {},
	});
	expect(agent.snapshotFollowUp()).toHaveLength(1);

	// agent_end while queued work is still pending must hold the SDK follow-up.
	agent.emitExternalEvent({ type: "agent_end", messages: [] });
	await Bun.sleep(20);
	expect(agent.snapshotFollowUp()).toHaveLength(1);
	expect(agent.snapshotFollowUp()[0]).toMatchObject({ content: [{ type: "text", text: "unrelated follow-up" }] });

	// Once the queue drains, the next agent_end releases it as its own run.
	agent.removeQueuedMessages(candidate => candidate === unrelated);
	agent.emitExternalEvent({ type: "agent_end", messages: [] });
	await Bun.sleep(20);
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
		sdkRunToken: "token-m1",
		onPreflightAcceptCommit: () => {},
	});
	await session.sendUserMessage("owned m2", {
		deliverAs: "followUp",
		preflightSignal: secondController.signal,
		sdkRunToken: "token-m2",
		onPreflightAcceptCommit: () => {},
	});
	// Both SDK follow-ups are deferred behind the pre-existing queued work.
	expect(agent.snapshotFollowUp()).toHaveLength(1);

	// agent_end releases only the first deferred follow-up.
	agent.removeQueuedMessages(candidate => candidate === unrelated);
	agent.emitExternalEvent({ type: "agent_end", messages: [] });
	await Bun.sleep(20);
	expect(agent.snapshotFollowUp()).toHaveLength(1);
	expect(agent.snapshotFollowUp()[0]).toMatchObject({ content: [{ type: "text", text: "owned m1" }] });

	// Cancelling m1 before its scheduled continuation starts must advance the
	// deferred queue to m2; no further agent_end will arrive to release it.
	firstController.abort();
	await Bun.sleep(20);
	expect(agent.snapshotFollowUp()).toHaveLength(1);
	expect(agent.snapshotFollowUp()[0]).toMatchObject({ content: [{ type: "text", text: "owned m2" }] });
});
