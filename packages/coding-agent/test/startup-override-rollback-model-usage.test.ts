import { afterEach, beforeAll, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { Agent, type AgentOptions, ThinkingLevel } from "@gajae-code/agent-core";
import type { AssistantMessage, Model } from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";
import { activateModelProfile } from "@gajae-code/coding-agent/config/model-profile-activation";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import type { ModelSelectorComponent } from "@gajae-code/coding-agent/modes/components/model-selector";
import { SelectorController } from "@gajae-code/coding-agent/modes/controllers/selector-controller";
import { getThemeByName, setThemeInstance } from "@gajae-code/coding-agent/modes/theme/theme";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { applyStartupModelProfiles } from "../src/main";
import { executeAcpBuiltinSlashCommand } from "../src/slash-commands/acp-builtins";
import type { AcpBuiltinCommandRuntime } from "../src/slash-commands/types";

// `gjc --model openai-codex/gpt-5.5` installs a run-scoped startup override that
// never enters the agent.db model MRU (issue #6768). A model change inside that
// run that fails and rolls back to the CLI model used to record the rollback
// target (and the failed forward pick) as a recent user choice, so later
// sessions resolved glob/ambiguous defaults against a one-off CLI model.
// A failed change must leave the MRU exactly as it was before the change.
const CLI_MODEL = "openai-codex/gpt-5.5";
const SONNET = "anthropic/claude-sonnet-5-5";
const OPUS = "anthropic/claude-opus-5-5";
const PROFILE = "opus-codex";

interface Env {
	root: string;
	agentDir: string;
	cwd: string;
	settings: Settings;
	modelRegistry: ModelRegistry;
	session: AgentSession;
	output: string[];
	runtime: AcpBuiltinCommandRuntime;
}

const envs: Env[] = [];
const authStorages: AuthStorage[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	for (const env of envs.splice(0)) {
		await env.session.dispose();
		await env.modelRegistry.dispose();
		await env.settings.close();
		await fs.rm(env.root, { recursive: true, force: true });
	}
	for (const auth of authStorages.splice(0)) auth.close();
});

beforeAll(async () => {
	const theme = await getThemeByName("red-claw");
	if (!theme) throw new Error("Failed to load test theme");
	setThemeInstance(theme);
});

function find(modelRegistry: ModelRegistry, selector: string): Model {
	const [provider, id] = selector.split("/");
	const model = modelRegistry.find(provider, id);
	if (!model) throw new Error(`Expected built-in model ${selector}`);
	return model;
}

function liveModel(env: Env): string | undefined {
	const model = env.session.model;
	return model ? `${model.provider}/${model.id}` : undefined;
}

async function createEnv(startModel: string, streamFn?: AgentOptions["streamFn"]): Promise<Env> {
	// Canonicalize: macOS os.tmpdir() sits behind the /var -> /private/var symlink.
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gjc-rollback-mru-")));
	const agentDir = path.join(root, "agent");
	const cwd = path.join(root, "work");
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(agentDir, { recursive: true });
	await Bun.write(path.join(agentDir, "config.yml"), "modelRoles: {}\n");
	const settings = await Settings.loadForScope({ cwd, agentDir });
	const authStorage = await AuthStorage.create(path.join(agentDir, "testauth.db"));
	authStorages.push(authStorage);
	authStorage.setRuntimeApiKey("openai-codex", "test-key");
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const modelRegistry = new ModelRegistry(authStorage, path.join(agentDir, "models.yml"));
	// Keep the model catalog offline.
	spyOn(modelRegistry, "refresh").mockResolvedValue(undefined);
	spyOn(modelRegistry, "refreshInBackground").mockImplementation(() => {});
	const agent = new Agent({
		initialState: { model: find(modelRegistry, startModel), systemPrompt: ["Test"], tools: [], messages: [] },
		...(streamFn ? { streamFn, getApiKey: () => "test-key" } : {}),
	});
	const session = new AgentSession({ agent, sessionManager: SessionManager.inMemory(), settings, modelRegistry });
	const output: string[] = [];
	const runtime: AcpBuiltinCommandRuntime = {
		session,
		sessionManager: session.sessionManager,
		settings,
		cwd,
		output: text => {
			output.push(text);
		},
		refreshCommands: () => {},
		reloadPlugins: async () => {},
	};
	const env = { root, agentDir, cwd, settings, modelRegistry, session, output, runtime };
	envs.push(env);
	return env;
}

/** A typed provider quota failure that the real retry path answers with a fallback switch. */
function rateLimitedStream(model: Model): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	queueMicrotask(() => {
		const message: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "error",
			errorMessage: "Provider returned error: rate_limit_error: organization quota reached",
			errorStatus: 429,
			transportFailure: { kind: "transport", status: 429, headers: { "retry-after-ms": "60000" } },
			timestamp: Date.now(),
		};
		stream.push({ type: "start", partial: message });
		stream.push({ type: "error", reason: "error", error: message });
	});
	return stream;
}

/** `gjc --model CLI_MODEL --thinking xhigh` through the real startup policy. */
async function startWithCliModel(): Promise<Env> {
	const env = await createEnv(CLI_MODEL);
	await applyStartupModelProfiles({
		session: env.session,
		settings: env.settings,
		modelRegistry: env.modelRegistry,
		parsedArgs: { model: CLI_MODEL, thinking: ThinkingLevel.XHigh },
		startupModel: find(env.modelRegistry, CLI_MODEL),
		startupThinkingLevel: ThinkingLevel.XHigh,
	});
	expect(liveModel(env)).toBe(CLI_MODEL);
	return env;
}

/** The agent.db MRU order as the next process reads it. */
async function freshUsageOrder(env: Env): Promise<string[]> {
	await env.settings.flush();
	const reloaded = await Settings.loadForScope({ cwd: env.cwd, agentDir: env.agentDir });
	try {
		return [...(reloaded.getStorage()?.getModelUsageOrder() ?? [])];
	} finally {
		await reloaded.close();
	}
}

/** Real TUI selector controller over the env's real session and file-backed settings. */
function openModelSelector(env: Env): ModelSelectorComponent {
	const addChild = vi.fn();
	const ctx = {
		ui: { setFocus: vi.fn(), requestRender: vi.fn(), requestLayoutRender: vi.fn() },
		editorContainer: { clear: vi.fn(), detachChild: vi.fn(), addChild },
		editor: {},
		settings: env.settings,
		session: env.session,
		statusLine: { invalidate: vi.fn() },
		updateEditorBorderColor: vi.fn(),
		showStatus: vi.fn(),
		showError: vi.fn(),
		notifyConfigChanged: vi.fn(async () => {}),
		restoreComposer: vi.fn(),
	};
	new SelectorController(ctx as never).showModelSelector();
	const selector = addChild.mock.calls[0]?.[0] as ModelSelectorComponent | undefined;
	if (!selector) throw new Error("Expected the model selector to mount");
	return selector;
}

function selectDefault(env: Env, selector: string, thinkingLevel: ThinkingLevel = ThinkingLevel.High): Promise<void> {
	return openModelSelector(env).__testSelectAssignment({
		model: find(env.modelRegistry, selector),
		role: "default",
		thinkingLevel,
		selector: `${selector}:${thinkingLevel}`,
	});
}

/**
 * Fail the TUI DEFAULT role write that follows the live `setModel` mutation: a
 * real settings mutation failure after the forward model change committed.
 */
function failDefaultRoleWriteAfterSetModel(env: Env): { failures: () => number } {
	const setModelRole = env.settings.setModelRole.bind(env.settings);
	let calls = 0;
	let failures = 0;
	spyOn(env.settings, "setModelRole").mockImplementation((role, value) => {
		calls++;
		// Call 1 is inside AgentSession.setModel; call 2 is the selector's durable write.
		if (calls === 2) {
			failures++;
			throw new Error("injected default role write failure");
		}
		setModelRole(role, value);
	});
	return { failures: () => failures };
}

/**
 * Fail the profile activation's agent-role override install, which runs after
 * the activation published the profile DEFAULT as the live model.
 */
function failProfileAgentOverridesInstall(env: Env): { failures: () => number } {
	const override = env.settings.override.bind(env.settings);
	let armed = true;
	let failures = 0;
	spyOn(env.settings, "override").mockImplementation(((settingPath: string, value: unknown) => {
		if (armed && settingPath === "task.agentModelOverrides") {
			armed = false;
			failures++;
			throw new Error("injected agent override install failure");
		}
		(override as (p: string, v: unknown) => void)(settingPath, value);
	}) as typeof env.settings.override);
	return { failures: () => failures };
}

describe("failed model changes after a startup override leave the model MRU untouched", () => {
	it("startup override alone does not enter the MRU", async () => {
		const env = await startWithCliModel();
		expect(await freshUsageOrder(env)).toEqual([]);
	});

	it("(a) a profile switch that fails after publishing its DEFAULT and rolls back to the CLI model", async () => {
		const env = await startWithCliModel();
		const before = await freshUsageOrder(env);
		const commitProfileSelection = spyOn(env.session, "commitPreparedProfileModelSelection");
		const injected = failProfileAgentOverridesInstall(env);

		expect(await executeAcpBuiltinSlashCommand(`/model ${PROFILE}`, env.runtime)).toEqual({ consumed: true });

		expect(injected.failures()).toBe(1);
		expect(env.output.some(text => text.includes("Failed to activate model profile"))).toBe(true);
		// The profile DEFAULT really became the live model before the failure.
		expect(
			commitProfileSelection.mock.calls.some(
				([selection]) => `${selection.model.provider}/${selection.model.id}` === OPUS,
			),
		).toBe(true);
		expect(liveModel(env)).toBe(CLI_MODEL);
		expect(env.session.getActiveModelProfile()).toBeUndefined();
		const after = await freshUsageOrder(env);
		expect(after).toEqual(before);
		expect(after).not.toContain(CLI_MODEL);
	});

	it("(b) a TUI DEFAULT selection rolled back after a real settings mutation failure", async () => {
		const env = await startWithCliModel();
		const before = await freshUsageOrder(env);
		const injected = failDefaultRoleWriteAfterSetModel(env);

		await expect(selectDefault(env, SONNET)).rejects.toThrow("injected default role write failure");

		expect(injected.failures()).toBe(1);
		expect(liveModel(env)).toBe(CLI_MODEL);
		expect(env.session.thinkingLevel).toBe(ThinkingLevel.XHigh);
		const after = await freshUsageOrder(env);
		expect(after).toEqual(before);
		expect(after).not.toContain(CLI_MODEL);
	});

	it("(c) a TUI DEFAULT selection that fails its credential preflight", async () => {
		const env = await startWithCliModel();
		const before = await freshUsageOrder(env);
		spyOn(env.modelRegistry, "getApiKey").mockResolvedValueOnce(undefined);

		await expect(selectDefault(env, SONNET)).rejects.toThrow("No API key");

		expect(liveModel(env)).toBe(CLI_MODEL);
		expect(await freshUsageOrder(env)).toEqual(before);
	});

	it("(c) a TUI DEFAULT selection whose setModel credential check fails after the selector preflight", async () => {
		const env = await startWithCliModel();
		const before = await freshUsageOrder(env);
		// Selector preflight passes; the credential disappears before setModel's own check.
		spyOn(env.modelRegistry, "getApiKey").mockResolvedValueOnce("test-key").mockResolvedValueOnce(undefined);

		await expect(selectDefault(env, SONNET)).rejects.toThrow("No API key");

		expect(liveModel(env)).toBe(CLI_MODEL);
		expect(await freshUsageOrder(env)).toEqual(before);
	});

	it("a setModelTemporary rollback to the CLI model is not a usage choice", async () => {
		const env = await startWithCliModel();
		await selectDefault(env, SONNET);
		const before = await freshUsageOrder(env);
		expect(before).toEqual([SONNET]);

		await env.session.setModelTemporary(find(env.modelRegistry, CLI_MODEL), ThinkingLevel.XHigh, {
			cause: "rollback",
		});

		expect(liveModel(env)).toBe(CLI_MODEL);
		expect(await freshUsageOrder(env)).toEqual(before);
	});

	it("a profile switch superseded by a newer user selection after publishing its DEFAULT", async () => {
		const env = await startWithCliModel();
		const revision = env.session.getUserModelSelectionRevision();
		const finishProfileSelection = env.session.finishPreparedProfileModelSelection.bind(env.session);
		let superseded = false;
		spyOn(env.session, "finishPreparedProfileModelSelection").mockImplementation(async selection => {
			if (!superseded) {
				superseded = true;
				expect(liveModel(env)).toBe(OPUS);
				// The user explicitly picks Sonnet while the activation is still in flight.
				await env.session.setModel(find(env.modelRegistry, SONNET), "default", { cause: "user-selection" });
			}
			return finishProfileSelection(selection);
		});

		await activateModelProfile(
			{ session: env.session, modelRegistry: env.modelRegistry, settings: env.settings, profileName: PROFILE },
			{ persistDefault: false, isCurrent: () => env.session.getUserModelSelectionRevision() === revision },
		);

		expect(superseded).toBe(true);
		expect(liveModel(env)).toBe(SONNET);
		expect(await freshUsageOrder(env)).toEqual([SONNET]);
	});

	it("a profile switch without a supersede check does not record its DEFAULT over a newer user selection", async () => {
		const env = await startWithCliModel();
		const storage = env.settings.getStorage();
		if (!storage) throw new Error("Expected file-backed agent storage");
		const record = spyOn(storage, "recordModelUsage");
		const finishProfileSelection = env.session.finishPreparedProfileModelSelection.bind(env.session);
		let overtaken = false;
		spyOn(env.session, "finishPreparedProfileModelSelection").mockImplementation(async selection => {
			if (!overtaken) {
				overtaken = true;
				expect(liveModel(env)).toBe(OPUS);
				// The TUI profile selector passes no isCurrent fence, so the activation
				// completes after the user picks Sonnet in the meantime.
				await env.session.setModel(find(env.modelRegistry, SONNET), "default", { cause: "user-selection" });
			}
			return finishProfileSelection(selection);
		});

		await activateModelProfile(
			{ session: env.session, modelRegistry: env.modelRegistry, settings: env.settings, profileName: PROFILE },
			{ persistDefault: false },
		);

		expect(overtaken).toBe(true);
		expect(liveModel(env)).toBe(SONNET);
		expect(record.mock.calls).toEqual([[SONNET]]);
		expect(await freshUsageOrder(env)).toEqual([SONNET]);
	});

	it("a TUI DEFAULT selection overtaken by a newer selection while it awaits does not record over it", async () => {
		const env = await startWithCliModel();
		const storage = env.settings.getStorage();
		if (!storage) throw new Error("Expected file-backed agent storage");
		const record = spyOn(storage, "recordModelUsage");
		const setModel = env.session.setModel.bind(env.session);
		let overtaken = false;
		spyOn(env.session, "setModel").mockImplementation(async (model, role, options) => {
			await setModel(model, role, options);
			if (`${model.provider}/${model.id}` === SONNET && !overtaken) {
				overtaken = true;
				// A second selector completes Opus before the first selection's transaction ends.
				await selectDefault(env, OPUS);
			}
		});

		await selectDefault(env, SONNET);

		expect(overtaken).toBe(true);
		expect(liveModel(env)).toBe(OPUS);
		expect(record.mock.calls).toEqual([[OPUS]]);
		expect(await freshUsageOrder(env)).toEqual([OPUS]);
	});

	it("a TUI DEFAULT selection keeps its usage when a fallback switch moves the live model mid-transaction", async () => {
		const requested: string[] = [];
		const recovering = createMockModel({ responses: [{ content: ["Recovered"] }] });
		const env = await createEnv(CLI_MODEL, (model, context, options) => {
			const selector = `${model.provider}/${model.id}`;
			requested.push(selector);
			return selector === OPUS ? rateLimitedStream(model) : recovering.stream(model, context, options);
		});
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		env.settings.set("retry.baseDelayMs", 1);
		env.settings.set("compaction.enabled", false);
		env.session.setConfiguredModelChain("default", [OPUS, SONNET], "test");
		const storage = env.settings.getStorage();
		if (!storage) throw new Error("Expected file-backed agent storage");
		const record = spyOn(storage, "recordModelUsage");
		const setModel = env.session.setModel.bind(env.session);
		spyOn(env.session, "setModel").mockImplementation(async (model, role, options) => {
			await setModel(model, role, options);
			// A turn running on the selected head fails and the real retry path
			// advances the default fallback chain before the selection transaction ends.
			await env.session.prompt("turn during the selection");
			await env.session.waitForIdle();
		});

		await selectDefault(env, OPUS);

		expect(requested[0]).toBe(OPUS);
		expect(requested.at(-1)).toBe(SONNET);
		expect(liveModel(env)).toBe(SONNET);
		// The fallback switch is not a usage choice; the user's completed OPUS pick is.
		expect(record.mock.calls).toEqual([[OPUS]]);
		expect(await freshUsageOrder(env)).toEqual([OPUS]);
	});

	it("a TUI DEFAULT selection still records when a newer overlapping selection fails and rolls back to it", async () => {
		const env = await startWithCliModel();
		await selectDefault(env, CLI_MODEL, ThinkingLevel.XHigh);
		expect(await freshUsageOrder(env)).toEqual([CLI_MODEL]);
		// Cross SQLite's one-second last_used_at granularity so a stale head would show.
		await Bun.sleep(1100);
		const setModelRole = env.settings.setModelRole.bind(env.settings);
		let opusRoleWrites = 0;
		spyOn(env.settings, "setModelRole").mockImplementation((role, value) => {
			// Write 1 for OPUS is inside AgentSession.setModel; write 2 is the selector's durable write.
			if (String(value).startsWith(OPUS) && ++opusRoleWrites === 2)
				throw new Error("injected default role write failure");
			setModelRole(role, value);
		});
		const setModel = env.session.setModel.bind(env.session);
		const releaseOverlap = Promise.withResolvers<void>();
		let overlapping: Promise<void> | undefined;
		spyOn(env.session, "setModel").mockImplementation(async (model, role, options) => {
			await setModel(model, role, options);
			const selector = `${model.provider}/${model.id}`;
			if (selector === SONNET && !overlapping) {
				// A newer OPUS selection starts and installs OPUS before SONNET's transaction ends.
				overlapping = selectDefault(env, OPUS);
				await Bun.sleep(0);
				expect(liveModel(env)).toBe(OPUS);
			} else if (selector === OPUS) {
				await releaseOverlap.promise;
			}
		});

		await selectDefault(env, SONNET);
		releaseOverlap.resolve();
		await expect(overlapping).rejects.toThrow("injected default role write failure");

		expect(liveModel(env)).toBe(SONNET);
		expect(await freshUsageOrder(env)).toEqual([SONNET, CLI_MODEL]);
	});

	it("a rolled-back TUI DEFAULT selection keeps a concurrent session's usage write", async () => {
		const env = await startWithCliModel();
		const setModelRole = env.settings.setModelRole.bind(env.settings);
		let calls = 0;
		spyOn(env.settings, "setModelRole").mockImplementation((role, value) => {
			calls++;
			if (calls === 2) throw new Error("injected default role write failure");
			setModelRole(role, value);
		});
		// Another gjc process sharing agent.db records its own choice mid-transaction.
		const other = await Settings.loadForScope({ cwd: env.cwd, agentDir: env.agentDir });
		try {
			const getApiKey = env.modelRegistry.getApiKey.bind(env.modelRegistry);
			spyOn(env.modelRegistry, "getApiKey").mockImplementation(async (...args) => {
				other.getStorage()?.recordModelUsage(OPUS);
				return getApiKey(...args);
			});

			await expect(selectDefault(env, SONNET)).rejects.toThrow("injected default role write failure");
		} finally {
			await other.close();
		}

		expect(liveModel(env)).toBe(CLI_MODEL);
		expect(await freshUsageOrder(env)).toEqual([OPUS]);
	});
});

describe("genuine user choices still reach the model MRU", () => {
	function selectBatch(env: Env, selector: string): Promise<void> {
		return openModelSelector(env).__testSelectAssignment({
			model: find(env.modelRegistry, selector),
			role: "default",
			roles: ["default", "executor"],
			thinkingLevel: ThinkingLevel.High,
			selector: `${selector}:high`,
		});
	}

	it("records a TUI batch selection that includes DEFAULT exactly once", async () => {
		const env = await startWithCliModel();
		const storage = env.settings.getStorage();
		if (!storage) throw new Error("Expected file-backed agent storage");
		const record = spyOn(storage, "recordModelUsage");

		await selectBatch(env, SONNET);

		expect(liveModel(env)).toBe(SONNET);
		expect(record.mock.calls).toEqual([[SONNET]]);
		expect(await freshUsageOrder(env)).toEqual([SONNET]);
	});

	it("keeps a TUI batch selection that includes DEFAULT out of the MRU when it rolls back", async () => {
		const env = await startWithCliModel();
		const before = await freshUsageOrder(env);
		const injected = failDefaultRoleWriteAfterSetModel(env);

		// Batch assignments surface the failure through showError instead of rethrowing.
		await selectBatch(env, SONNET);

		expect(injected.failures()).toBe(1);
		expect(liveModel(env)).toBe(CLI_MODEL);
		expect(await freshUsageOrder(env)).toEqual(before);
	});

	it("records an explicit TUI DEFAULT selection of a different model", async () => {
		const env = await startWithCliModel();

		await selectDefault(env, SONNET);

		expect(liveModel(env)).toBe(SONNET);
		expect(await freshUsageOrder(env)).toEqual([SONNET]);
	});

	it("records an explicit TUI DEFAULT selection of the model the CLI chose", async () => {
		const env = await startWithCliModel();

		await selectDefault(env, CLI_MODEL, ThinkingLevel.XHigh);

		expect(liveModel(env)).toBe(CLI_MODEL);
		expect(await freshUsageOrder(env)).toEqual([CLI_MODEL]);
	});

	it("records an explicit /model default selection of the model the CLI chose", async () => {
		const env = await startWithCliModel();

		expect(await executeAcpBuiltinSlashCommand(`/model default ${CLI_MODEL}:xhigh`, env.runtime)).toEqual({
			consumed: true,
		});

		expect(liveModel(env)).toBe(CLI_MODEL);
		expect(await freshUsageOrder(env)).toEqual([CLI_MODEL]);
	});

	it("records a successful profile switch made after a startup override", async () => {
		const env = await startWithCliModel();

		expect(await executeAcpBuiltinSlashCommand(`/model ${PROFILE}`, env.runtime)).toEqual({ consumed: true });

		expect(liveModel(env)).toBe(OPUS);
		expect(await freshUsageOrder(env)).toEqual([OPUS]);
	});

	it("keeps a prior explicit choice when a later TUI DEFAULT selection rolls back to it", async () => {
		const env = await startWithCliModel();
		await selectDefault(env, SONNET);
		const before = await freshUsageOrder(env);
		expect(before).toEqual([SONNET]);
		const injected = failDefaultRoleWriteAfterSetModel(env);

		await expect(selectDefault(env, OPUS)).rejects.toThrow("injected default role write failure");

		expect(injected.failures()).toBe(1);
		expect(liveModel(env)).toBe(SONNET);
		expect(await freshUsageOrder(env)).toEqual(before);
	});

	it("keeps a prior explicit choice when a later profile switch rolls back to it", async () => {
		const env = await startWithCliModel();
		await selectDefault(env, SONNET);
		const before = await freshUsageOrder(env);
		expect(before).toEqual([SONNET]);
		const injected = failProfileAgentOverridesInstall(env);

		expect(await executeAcpBuiltinSlashCommand(`/model ${PROFILE}`, env.runtime)).toEqual({ consumed: true });

		expect(injected.failures()).toBe(1);
		expect(env.output.some(text => text.includes("Failed to activate model profile"))).toBe(true);
		expect(liveModel(env)).toBe(SONNET);
		expect(await freshUsageOrder(env)).toEqual(before);
	});
});
