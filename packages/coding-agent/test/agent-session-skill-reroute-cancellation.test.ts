import { afterEach, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import { getBundledModel } from "@gajae-code/ai";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
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
