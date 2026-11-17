/**
 * Regression coverage for #7856: shared root TUI sessions should allow mutations
 * through transaction admission for startup model setting with --model/--mpreset
 * and for the Move Session tool.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent, ThinkingLevel } from "@gajae-code/agent-core";
import { initializeLocalRoot } from "../src/internal-urls/local-protocol";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { type SessionInfo, SessionManager } from "../src/session/session-manager";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";

const roots: string[] = [];
const sessions: AgentSession[] = [];
const managers: SessionManager[] = [];
const registries: ModelRegistry[] = [];
const settingsStores: Settings[] = [];
const authStores: AuthStorage[] = [];

const provider = "issue-7856-fixture";
const initialSelector = `${provider}/initial`;
const selectedSelector = `${provider}/selected`;
const fallbackSelector = `${provider}/fallback`;
const defaultChain = [`${selectedSelector}:high`, `${fallbackSelector}:low`];
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

function modelsConfig(profileDefault: readonly string[]): string {
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
	await Bun.write(path.join(agentDir, "models.yml"), modelsConfig(defaultChain));

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
		// Mirrors sdk/session.ts for a trusted root interactive CLI TUI session (#7711).
		rootInteractiveSharedAppend: true,
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
	expect(f.manager.getLeafEntry()).toMatchObject({ type: "message", message: { role: "user", content: "canonical shared user" } });
	expect(await Bun.file(f.file).text()).toContain(JSON.stringify("canonical shared user"));
}

describe("#7856 setTemporaryModel in a shared root TUI session", () => {
	it("allows setTemporaryModel at startup in a shared session without throwing SharedSessionMutationUnsupportedError", async () => {
		const f = await fixture();
		await canonicalMessage(f);

		const model = f.registry.find(provider, "selected");
		if (!model) throw new Error(`Missing test model: ${selectedSelector}`);

		// This should not throw SharedSessionMutationUnsupportedError
		try {
			await f.session.setModelTemporary(model, undefined, {
				persistAsSessionDefault: true,
				cause: "startup-override",
			});
		} catch (error) {
			throw new Error(`setModelTemporary failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	});
});

describe("#7856 Move Session in a shared root TUI session", () => {
	it("allows moveTo in a shared session without throwing SharedSessionMutationUnsupportedError", async () => {
		const f = await fixture();
		await canonicalMessage(f);

		const targetDir = path.join(f.cwd, "..", "moved-session");
		await fs.mkdir(targetDir, { recursive: true });

		// This should not throw SharedSessionMutationUnsupportedError
		try {
			await f.manager.moveTo(targetDir);
		} catch (error) {
			throw new Error(`moveTo failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	});
});
