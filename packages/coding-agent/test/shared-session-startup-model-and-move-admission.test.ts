/**
 * Regression coverage for #7856: a root TUI session allows the startup model setting
 * with --model/--mpreset after its first message. Also covers the shared-publication
 * layer's Move Session refusal; that case latches the manager's shared bars directly and
 * goes with the layer in single-owner steps 10d-10e.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, ThinkingLevel } from "@gajae-code/agent-core";
import { getBundledModel } from "@gajae-code/ai";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { initializeLocalRoot } from "../src/internal-urls/local-protocol";
import { createAgentSession } from "../src/sdk";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";

const roots: string[] = [];
const sessions: AgentSession[] = [];
const managers: SessionManager[] = [];
const registries: ModelRegistry[] = [];
const settingsStores: Settings[] = [];
const authStores: AuthStorage[] = [];

const provider = "issue-7856-fixture";
const initialSelector = `${provider}/initial`;
const user = (text: string) => ({ role: "user" as const, content: text, timestamp: 1 });

interface Fixture {
	session: AgentSession;
	manager: SessionManager;
	registry: ModelRegistry;
	settings: Settings;
	file: string;
	cwd: string;
	agentDir: string;
}

afterEach(async () => {
	vi.restoreAllMocks();
	const failures: unknown[] = [];
	const cleanup: Array<() => unknown> = [
		...sessions.splice(0).map(session => () => session.dispose()),
		...registries.splice(0).map(registry => () => registry.dispose()),
		...managers.splice(0).map(manager => () => manager.closeStrict()),
		...settingsStores.splice(0).map(settings => () => settings.close()),
		...authStores.splice(0).map(auth => () => auth.close()),
		...roots.splice(0).map(root => () => fs.rm(root, { recursive: true, force: true })),
	];
	for (const dispose of cleanup) {
		try {
			await dispose();
		} catch (error) {
			failures.push(error);
		}
	}
	if (failures.length > 0) throw new AggregateError(failures, "Fixture cleanup failed");
});

function modelsConfig(): string {
	return JSON.stringify({
		providers: {
			[provider]: {
				baseUrl: "https://issue-7856.invalid/v1",
				api: "openai-completions",
				apiKeyEnv: "GJC_TEST_ISSUE_7856_API_KEY",
				models: ["initial", "selected", "fallback"].map(id => ({
					id,
					reasoning: true,
					thinking: { mode: "effort", minLevel: "low", maxLevel: "high" },
					compat: { supportsReasoningEffort: true },
					input: ["text"],
					contextWindow: 32_000,
					maxTokens: 4_000,
				})),
			},
		},
		profiles: {},
	});
}

async function fixture(): Promise<Fixture> {
	const root = await fs.mkdtemp(path.join(import.meta.dirname, ".tmp-issue-7856-"));
	roots.push(root);
	const cwd = path.join(root, "workspace");
	const agentDir = path.join(root, "agent");
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
	await Bun.write(
		path.join(agentDir, "config.yml"),
		JSON.stringify({
			compaction: { enabled: false },
			todo: { reminders: false },
			startup: { networkPrewarm: false },
			defaultThinkingLevel: ThinkingLevel.Low,
			modelRoles: { default: initialSelector },
			task: { agentModelOverrides: { executor: initialSelector } },
		}),
	);
	await Bun.write(path.join(agentDir, "models.yml"), modelsConfig());

	const settings = await Settings.loadForScope({ cwd, agentDir });
	settingsStores.push(settings);

	const auth = await AuthStorage.create(path.join(root, "auth.db"));
	authStores.push(auth);
	auth.setRuntimeApiKey(provider, "issue-7856-test-key");

	const registry = new ModelRegistry(auth, path.join(agentDir, "models.yml"), settings, {
		agentDir,
		automaticRefresh: false,
	});
	registries.push(registry);

	const model = registry.find(provider, "initial");
	if (!model) throw new Error(`Missing fixture model: ${initialSelector}`);

	const manager = SessionManager.create(cwd, SessionManager.managedDestination(cwd, agentDir));
	managers.push(manager);
	manager.appendMessage(user("initial user"));
	manager.appendModelChange(initialSelector, "default");
	manager.appendModelChange(initialSelector, "temporary");
	manager.appendThinkingLevelChange(ThinkingLevel.Low);
	await manager.ensureOnDisk();
	await manager.flush();

	const file = manager.getSessionFile();
	if (!file) throw new Error("Missing fixture transcript");

	const agent = new Agent({
		initialState: {
			model,
			thinkingLevel: ThinkingLevel.Low,
			systemPrompt: ["Issue 7856 fixture"],
			tools: [],
			messages: manager.buildSessionContext().messages,
		},
		streamFn: () => {
			throw new Error("Issue 7856 fixture must not request a provider");
		},
	});

	const session = new AgentSession({
		agent,
		agentDir,
		sessionManager: manager,
		settings,
		modelRegistry: registry,
		thinkingLevel: ThinkingLevel.Low,
	});
	sessions.push(session);
	await manager.flush();

	await initializeLocalRoot({
		getSessionId: () => manager.getSessionId(),
		getArtifactsDir: () => manager.getArtifactsDir(),
		isManagedDestination: () => manager.isManagedDestination(),
		getManagedLegacyLocalMigrationSource: () => manager.getManagedLegacyLocalMigrationSource(),
	});

	return { session, manager, registry, settings, file, cwd, agentDir };
}

async function canonicalMessage(f: Fixture): Promise<void> {
	f.session.agent.emitExternalEvent({ type: "message_end", message: user("canonical shared user") });
	await f.session.awaitSessionSettlement();
	expect(f.manager.getLeafEntry()).toMatchObject({
		type: "message",
		message: { role: "user", content: "canonical shared user" },
	});
	expect(await Bun.file(f.file).text()).toContain(JSON.stringify("canonical shared user"));
}

describe("#7856 setTemporaryModel in a root TUI session", () => {
	it("allows setTemporaryModel at startup after the first message without throwing SharedSessionMutationUnsupportedError", async () => {
		const f = await fixture();
		await canonicalMessage(f);

		const model = f.registry.find(provider, "selected");
		if (!model) throw new Error(`Missing test model: ${provider}/selected`);

		const entriesBeforeOverride = f.manager.getEntries().length;

		// This should not throw SharedSessionMutationUnsupportedError
		try {
			await f.session.setModelTemporary(model, undefined, {
				persistAsSessionDefault: true,
				cause: "startup-override",
			});
		} catch (error) {
			throw new Error(`setModelTemporary failed: ${error instanceof Error ? error.message : String(error)}`);
		}

		// Verify that entries were published to the transcript
		const entriesAfterOverride = f.manager.getEntries();
		expect(entriesAfterOverride.length).toBeGreaterThan(entriesBeforeOverride);

		// Verify that a model_change entry was added with the correct model selector
		const modelChangeEntry = entriesAfterOverride.find(
			e => e.type === "model_change" && e.model === `${provider}/selected`,
		);
		expect(modelChangeEntry).toBeDefined();
	});
});

describe("#7856 Move Session in a shared root TUI session", () => {
	it("refuses moveTo in a shared session with SharedSessionMutationUnsupportedError", async () => {
		const f = await fixture();
		// A canonical shared append on the manager latches its shared bars.
		expect((await f.manager.appendMessageSharingSession(user("canonical shared user"))).kind).toBe("committed");

		const targetDir = path.join(f.cwd, "..", "moved-session");
		await fs.mkdir(targetDir, { recursive: true });

		// Move Session in shared root TUI sessions stays refused (pre-#7858 behavior).
		// This path is used by Move Session tool (via rescopeSessionCwd).
		let threwExpected = false;
		try {
			await f.manager.runExclusiveCwdMoveTransition(() => f.manager.moveTo(targetDir));
		} catch (error) {
			if (error instanceof Error && error.constructor.name === "SharedSessionMutationUnsupportedError") {
				threwExpected = true;
			} else {
				throw error;
			}
		}

		expect(threwExpected).toBe(true);
	});

	it("refuses the move_session tool before it changes the process cwd or rebinds services", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-move-session-tool-"));
		roots.push(root);
		const cwd = path.join(root, "workspace");
		const agentDir = path.join(root, "agent");
		// move_session only narrows the scope, so the target is a descendant.
		const target = path.join(cwd, "narrower");
		await fs.mkdir(cwd, { recursive: true });
		await fs.mkdir(target, { recursive: true });
		await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
		const settings = Settings.isolated();
		const sessionManager = SessionManager.create(cwd, SessionManager.managedDestination(cwd, agentDir));
		managers.push(sessionManager);
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			sessionManager,
			settings,
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			extensions: [],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMcpAutoload: false,
			enableLsp: false,
			skipPythonPreflight: true,
			toolNames: ["move_session"],
		});
		sessions.push(session);
		expect((await sessionManager.appendMessageSharingSession(user("shared message"))).kind).toBe("committed");
		const processCwd = process.cwd();
		const transition = vi.spyOn(sessionManager, "runExclusiveCwdMoveTransition");
		const tool = session.getToolByName("move_session");
		if (!tool) throw new Error("move_session tool is unavailable");
		await expect(tool.execute("move-session-refused", { path: target } as never)).rejects.toThrow(
			"Shared session mutation requires transaction admission: move session",
		);
		expect(transition).not.toHaveBeenCalled();
		expect(process.cwd()).toBe(processCwd);
		expect(sessionManager.getCwd()).toBe(cwd);
	});
});
