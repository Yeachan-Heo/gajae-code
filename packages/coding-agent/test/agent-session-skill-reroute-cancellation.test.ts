import { afterEach, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
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

test("forwards preflight cancellation when a prompt reroutes to a skill", async () => {
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

test("cancels an ordinary prompt while it waits on the startup barrier", async () => {
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

test("rolls back workflow state seeded after durable acceptance when preflight is cancelled", async () => {
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
