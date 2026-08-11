import { afterEach, expect, setDefaultTimeout, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { closeModelCache, Effort } from "@gajae-code/ai";
import { YAML } from "bun";
import { ModelRegistry } from "../src/config/model-registry";
import { resetSettingsForTest, Settings } from "../src/config/settings";
import { initializeExtensions } from "../src/modes/runtime-init";
import { createAgentSession, type Q10Model, type Q10SettableThinkingLevel } from "../src/sdk";
import { startFixtureBrokerWithLeaseForTest } from "../src/sdk/broker/ensure";
import { createNotificationsExtension } from "../src/sdk/bus";
import { SdkClient } from "../src/sdk/client";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";
import {
	cleanupFixtureRoot,
	createFixtureBrokerEnvironment,
	createFixtureRootCleanup,
	type FixtureRootCleanup,
	registerFixtureRuntime,
	withFixtureBrokerEnvironment,
} from "./helpers/fixture-broker-cleanup";

let tempDir: string | undefined;
let authStorage: AuthStorage | undefined;
let fixtureCleanup: FixtureRootCleanup | undefined;
const SDK_REQUEST_TIMEOUT_MS = 10_000;
setDefaultTimeout(30_000);

afterEach(async () => {
	delete process.env.GJC_NOTIFICATIONS;
	resetSettingsForTest();
	vi.restoreAllMocks();
	if (fixtureCleanup) await cleanupFixtureRoot(fixtureCleanup);
	fixtureCleanup = undefined;
	authStorage = undefined;
	tempDir = undefined;
});

test("model.set executes every Q10-advertised selection and persists the public current readback", async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-sdk-default-model-"));
	const agentDir = path.join(tempDir, "agent");
	const fixtureEnv = createFixtureBrokerEnvironment(tempDir, agentDir);
	const started = await withFixtureBrokerEnvironment(() =>
		startFixtureBrokerWithLeaseForTest({ agentDir, env: fixtureEnv }),
	);
	fixtureCleanup = createFixtureRootCleanup(tempDir, agentDir, started.lease);
	authStorage = await AuthStorage.create(path.join(agentDir, "auth.db"));
	if (!fixtureCleanup) throw new Error("Expected fixture broker cleanup.");
	registerFixtureRuntime(fixtureCleanup, {
		key: "auth-storage",
		requiredOwner: "runtime",
		dispose: async () => authStorage?.close(),
	});
	registerFixtureRuntime(fixtureCleanup, {
		key: "model-cache",
		requiredOwner: "runtime",
		dispose: async () => void closeModelCache(path.join(agentDir, "models.db")),
	});
	const modelRegistry = new ModelRegistry(authStorage, path.join(agentDir, "models.yml"));
	modelRegistry.registerProvider("runtime-provider", {
		baseUrl: "http://127.0.0.1:9/v1",
		apiKey: "RUNTIME_KEY",
		api: "openai-completions",
		models: [
			{
				id: "initial-model",
				name: "Initial Model",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128_000,
				maxTokens: 8_192,
			},
			{
				id: "reasoning-model",
				name: "Reasoning Model",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128_000,
				maxTokens: 8_192,
				thinking: {
					minLevel: Effort.Minimal,
					maxLevel: Effort.High,
					mode: "effort",
					defaultLevel: Effort.Low,
				},
			},
			{
				id: "sparse-reasoning-model",
				name: "Sparse Reasoning Model",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128_000,
				maxTokens: 8_192,
				thinking: {
					minLevel: Effort.Low,
					maxLevel: Effort.XHigh,
					mode: "effort",
					levels: [Effort.Low, Effort.XHigh],
					defaultLevel: Effort.XHigh,
				},
			},
			{
				id: "max-reasoning-model",
				name: "Max Reasoning Model",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128_000,
				maxTokens: 8_192,
				thinking: {
					minLevel: Effort.XHigh,
					maxLevel: Effort.Max,
					mode: "effort",
					defaultLevel: Effort.Max,
				},
			},
		],
	});
	const settings = await Settings.init({ cwd: tempDir, agentDir });
	const initialModel = modelRegistry.find("runtime-provider", "initial-model");
	if (!initialModel) throw new Error("Expected initial model fixture");
	const reasoningModel = modelRegistry.find("runtime-provider", "reasoning-model");
	if (!reasoningModel) throw new Error("Expected reasoning model fixture");
	const sparseReasoningModel = modelRegistry.find("runtime-provider", "sparse-reasoning-model");
	if (!sparseReasoningModel) throw new Error("Expected sparse reasoning model fixture");
	const maxReasoningModel = modelRegistry.find("runtime-provider", "max-reasoning-model");
	if (!maxReasoningModel) throw new Error("Expected max reasoning model fixture");
	vi.spyOn(modelRegistry, "getAll").mockReturnValue([
		initialModel,
		reasoningModel,
		sparseReasoningModel,
		maxReasoningModel,
	]);

	process.env.GJC_NOTIFICATIONS = "1";
	const { session } = await createAgentSession({
		cwd: tempDir,
		agentDir,
		authStorage,
		modelRegistry,
		settings,
		model: initialModel,
		sessionManager: SessionManager.inMemory(tempDir),
		disableExtensionDiscovery: true,
		extensions: [api => createNotificationsExtension(api, { settings })],
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
	});
	if (!fixtureCleanup) throw new Error("Expected fixture broker cleanup.");
	registerFixtureRuntime(fixtureCleanup, {
		key: `session:${session.sessionId}`,
		requiredOwner: "runtime-and-broker",
		shutdown: async () => void (await session.extensionRunner?.emit({ type: "session_shutdown" })),
		dispose: () => session.dispose(),
	});
	await initializeExtensions(session, { reportSendError: () => {}, reportRuntimeError: () => {} });

	const endpointFile = path.join(tempDir, ".gjc", "state", "sdk", `${session.sessionId}.json`);
	const deadline = Date.now() + 4_000;
	while (!(await Bun.file(endpointFile).exists())) {
		if (Date.now() > deadline) throw new Error("Timed out starting SDK host");
		await Bun.sleep(10);
	}
	const endpoint = (await Bun.file(endpointFile).json()) as { url: string; token: string };
	const client = await SdkClient.connect(endpoint.url, endpoint.token, {
		timeoutMs: SDK_REQUEST_TIMEOUT_MS,
		reconnectAttempts: 0,
	});
	let persistedSelection: { provider: string; modelId: string; thinkingLevel: Q10SettableThinkingLevel } | undefined;

	try {
		const catalog = (await client.query("Q10")) as { page?: { items: Q10Model[] } };
		const rows = catalog.page?.items ?? [];
		expect(rows).toHaveLength(4);

		// Invalid `inherit` rejection is covered by sdk-host-wiring; this process-heavy
		// fixture exercises only Q10-advertised selections and exact owner teardown.

		const nonReasoningRow = rows.find(row => !row.reasoning);
		if (!nonReasoningRow) throw new Error("Expected a non-reasoning model in the public Q10 response");
		expect(nonReasoningRow.thinking.validLevels).toEqual(["off"]);
		const advertisedSelections = rows.flatMap(row =>
			row.thinking.validLevels.map(thinkingLevel => ({
				provider: row.provider,
				modelId: row.id,
				thinkingLevel,
			})),
		);
		expect(advertisedSelections).not.toHaveLength(0);
		for (const selection of advertisedSelections) {
			await expect(
				client.control("model.set", {
					id: `${selection.provider}/${selection.modelId}`,
					thinkingLevel: selection.thinkingLevel,
				}),
			).resolves.toMatchObject({ ok: true, result: selection });
			const currentCatalog = (await client.query("Q10")) as { page?: { items: Q10Model[] } };
			const currentRows = currentCatalog.page?.items ?? [];
			expect(currentRows.filter(row => row.current)).toMatchObject([
				{
					provider: selection.provider,
					id: selection.modelId,
					current: true,
					currentThinkingLevel: selection.thinkingLevel,
				},
			]);
		}

		const finalSelection = advertisedSelections.at(-1);
		if (!finalSelection) throw new Error("Expected an advertised Q10 selection");
		persistedSelection = finalSelection;
		expect(session.model?.id).toBe(finalSelection.modelId);
		expect(session.thinkingLevel).toBe(finalSelection.thinkingLevel);
		expect(settings.getGlobal("modelRoles")).toEqual({
			default: `${finalSelection.provider}/${finalSelection.modelId}:${finalSelection.thinkingLevel}`,
		});
	} finally {
		await client.close();
	}

	const { session: freshSession } = await createAgentSession({
		cwd: tempDir,
		agentDir,
		authStorage,
		modelRegistry,
		settings,
		sessionManager: SessionManager.inMemory(tempDir),
		disableExtensionDiscovery: true,
		extensions: [],
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
	});
	if (!fixtureCleanup) throw new Error("Expected fixture broker cleanup.");
	registerFixtureRuntime(fixtureCleanup, {
		key: `session:${freshSession.sessionId}`,
		requiredOwner: "runtime-and-broker",
		dispose: () => freshSession.dispose(),
	});
	if (!persistedSelection) throw new Error("Expected a persisted Q10 selection");
	expect(freshSession.model?.provider).toBe(persistedSelection.provider);
	expect(freshSession.model?.id).toBe(persistedSelection.modelId);
	expect(freshSession.thinkingLevel).toBe(persistedSelection.thinkingLevel);
}, 30000);
test("session-only profile restores the starting model without a durable default", async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-sdk-session-profile-successor-"));
	const agentDir = path.join(tempDir, "agent");
	const fixtureEnv = createFixtureBrokerEnvironment(tempDir, agentDir);
	const started = await withFixtureBrokerEnvironment(() =>
		startFixtureBrokerWithLeaseForTest({ agentDir, env: fixtureEnv }),
	);
	fixtureCleanup = createFixtureRootCleanup(tempDir, agentDir, started.lease);
	authStorage = await AuthStorage.create(path.join(agentDir, "auth.db"));
	if (!fixtureCleanup) throw new Error("Expected fixture broker cleanup.");
	registerFixtureRuntime(fixtureCleanup, {
		key: "auth-storage",
		requiredOwner: "runtime",
		dispose: async () => authStorage?.close(),
	});
	registerFixtureRuntime(fixtureCleanup, {
		key: "model-cache",
		requiredOwner: "runtime",
		dispose: async () => void closeModelCache(path.join(agentDir, "models.db")),
	});

	await fs.mkdir(agentDir, { recursive: true });
	await fs.writeFile(
		path.join(agentDir, "models.yml"),
		YAML.stringify({
			profiles: {
				"custom-eco": {
					display_name: "Custom Eco",
					required_providers: ["runtime-provider"],
					model_mapping: { default: "runtime-provider/profile-model" },
				},
			},
		}),
	);

	const modelRegistry = new ModelRegistry(authStorage, path.join(agentDir, "models.yml"));
	modelRegistry.registerProvider("runtime-provider", {
		baseUrl: "http://127.0.0.1:9/v1",
		apiKey: "RUNTIME_KEY",
		api: "openai-completions",
		models: [
			{
				id: "initial-model",
				name: "Initial Model",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128_000,
				maxTokens: 8_192,
			},
			{
				id: "profile-model",
				name: "Profile Model",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128_000,
				maxTokens: 8_192,
			},
		],
	});
	const settings = await Settings.init({ cwd: tempDir, agentDir });
	const initialModel = modelRegistry.find("runtime-provider", "initial-model");
	const profileModel = modelRegistry.find("runtime-provider", "profile-model");
	if (!initialModel || !profileModel) throw new Error("Expected profile model fixtures");
	vi.spyOn(modelRegistry, "getAll").mockReturnValue([initialModel, profileModel]);

	const { session } = await createAgentSession({
		cwd: tempDir,
		agentDir,
		authStorage,
		modelRegistry,
		settings,
		model: initialModel,
		sessionManager: SessionManager.inMemory(tempDir),
		disableExtensionDiscovery: true,
		extensions: [],
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
	});
	if (!fixtureCleanup) throw new Error("Expected fixture broker cleanup.");
	registerFixtureRuntime(fixtureCleanup, {
		key: `session:${session.sessionId}`,
		requiredOwner: "runtime-and-broker",
		dispose: () => session.dispose(),
	});

	expect(settings.getGlobal("modelRoles")).toBeUndefined();
	expect(session.model?.id).toBe("initial-model");
	await session.setDefaultModelProfileForControl("custom-eco", { persistDefault: false });
	expect(session.getActiveModelProfile()).toBe("custom-eco");
	expect(session.model?.id).toBe("profile-model");
	expect(await session.newSession()).toBe(true);
	expect(session.getActiveModelProfile()).toBeUndefined();
	// A failure leaks the session-only profile model and lets /new invent a durable default.
	expect(session.model?.id).toBe("initial-model");
	expect(settings.getGlobal("modelRoles")).toBeUndefined();
}, 30000);
test("selecting a synthetic gajae-code profile remains session-scoped across concrete selection and restart", async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-sdk-synthetic-profile-"));
	const agentDir = path.join(tempDir, "agent");
	const fixtureEnv = createFixtureBrokerEnvironment(tempDir, agentDir);
	const started = await withFixtureBrokerEnvironment(() =>
		startFixtureBrokerWithLeaseForTest({ agentDir, env: fixtureEnv }),
	);
	fixtureCleanup = createFixtureRootCleanup(tempDir, agentDir, started.lease);
	authStorage = await AuthStorage.create(path.join(agentDir, "auth.db"));
	if (!fixtureCleanup) throw new Error("Expected fixture broker cleanup.");
	registerFixtureRuntime(fixtureCleanup, {
		key: "auth-storage",
		requiredOwner: "runtime",
		dispose: async () => authStorage?.close(),
	});
	registerFixtureRuntime(fixtureCleanup, {
		key: "model-cache",
		requiredOwner: "runtime",
		dispose: async () => void closeModelCache(path.join(agentDir, "models.db")),
	});

	// A custom profile requiring the authenticated fixture provider makes the
	// synthetic facade selectable in the Q10 catalog.
	await fs.mkdir(agentDir, { recursive: true });
	const modelsYml = YAML.stringify({
		profiles: {
			"custom-eco": {
				display_name: "Custom Eco",
				required_providers: ["runtime-provider"],
				model_mapping: {
					default: "runtime-provider/initial-model",
					executor: "runtime-provider/executor-model",
					planner: "runtime-provider/planner-model",
					critic: "runtime-provider/critic-model",
					architect: "runtime-provider/architect-model",
				},
			},
			// A default-only successor profile must drop the previous profile's
			// role-agent mappings when activated after a full profile.
			"default-only-eco": {
				display_name: "Default Only Eco",
				required_providers: ["runtime-provider"],
				model_mapping: {
					default: "runtime-provider/initial-model",
				},
			},
			"missing-bare-role": {
				display_name: "Missing Bare Role",
				required_providers: ["runtime-provider"],
				model_mapping: {
					default: "runtime-provider/initial-model",
					executor: "missing-role-alias",
				},
			},
		},
		// Configured modelBindings share the modelRoles/task.agentModelOverrides
		// runtime override slots with profile activations and must survive
		// session transitions and concrete picks. The critic binding lives in the
		// same agentModelOverrides slot the profile's critic mapping uses.
		modelBindings: {
			agentModelOverrides: {
				critic: "runtime-provider/reasoning-model",
			},
		},
	});
	await fs.writeFile(path.join(agentDir, "models.yml"), modelsYml);

	const modelRegistry = new ModelRegistry(authStorage, path.join(agentDir, "models.yml"));
	modelRegistry.registerProvider("runtime-provider", {
		baseUrl: "http://127.0.0.1:9/v1",
		apiKey: "RUNTIME_KEY",
		api: "openai-completions",
		models: [
			{
				id: "initial-model",
				name: "Initial Model",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128_000,
				maxTokens: 8_192,
			},
			{
				id: "reasoning-model",
				name: "Reasoning Model",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128_000,
				maxTokens: 8_192,
				thinking: {
					minLevel: Effort.Minimal,
					maxLevel: Effort.High,
					mode: "effort",
					defaultLevel: Effort.Low,
				},
			},
			{
				id: "executor-model",
				name: "Executor Model",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128_000,
				maxTokens: 8_192,
			},
			{
				id: "planner-model",
				name: "Planner Model",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128_000,
				maxTokens: 8_192,
			},
			{
				id: "critic-model",
				name: "Critic Model",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128_000,
				maxTokens: 8_192,
			},
			{
				id: "architect-model",
				name: "Architect Model",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128_000,
				maxTokens: 8_192,
			},
		],
	});
	const settings = await Settings.init({ cwd: tempDir, agentDir });
	const initialModel = modelRegistry.find("runtime-provider", "initial-model");
	if (!initialModel) throw new Error("Expected initial model fixture");
	vi.spyOn(modelRegistry, "getAll").mockReturnValue([
		initialModel,
		modelRegistry.find("runtime-provider", "reasoning-model")!,
		modelRegistry.find("runtime-provider", "executor-model")!,
		modelRegistry.find("runtime-provider", "planner-model")!,
		modelRegistry.find("runtime-provider", "critic-model")!,
		modelRegistry.find("runtime-provider", "architect-model")!,
	]);

	const { session } = await createAgentSession({
		cwd: tempDir,
		agentDir,
		authStorage,
		modelRegistry,
		settings,
		model: initialModel,
		sessionManager: SessionManager.inMemory(tempDir),
		disableExtensionDiscovery: true,
		extensions: [],
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
	});
	if (!fixtureCleanup) throw new Error("Expected fixture broker cleanup.");
	registerFixtureRuntime(fixtureCleanup, {
		key: `session:${session.sessionId}`,
		requiredOwner: "runtime-and-broker",
		shutdown: async () => void (await session.extensionRunner?.emit({ type: "session_shutdown" })),
		dispose: () => session.dispose(),
	});
	await initializeExtensions(session, { reportSendError: () => {}, reportRuntimeError: () => {} });

	const endpointFile = path.join(tempDir, ".gjc", "state", "sdk", `${session.sessionId}.json`);
	const deadline = Date.now() + 4_000;
	while (!(await Bun.file(endpointFile).exists())) {
		if (Date.now() > deadline) throw new Error("Timed out starting SDK host");
		await Bun.sleep(10);
	}
	const endpoint = (await Bun.file(endpointFile).json()) as { url: string; token: string };
	const client = await SdkClient.connect(endpoint.url, endpoint.token, {
		timeoutMs: SDK_REQUEST_TIMEOUT_MS,
		reconnectAttempts: 0,
	});

	try {
		const catalog = (await client.query("Q10")) as { page?: { items: Q10Model[] } };
		const syntheticRow = catalog.page?.items.find(row => row.provider === "gajae-code" && row.id === "custom-eco");
		expect(syntheticRow).toMatchObject({
			provider: "gajae-code",
			id: "custom-eco",
			name: "Custom Eco",
			reasoning: false,
			thinking: { validLevels: ["off"] },
			current: false,
		});
		expect(catalog.page?.items.some(row => row.provider === "gajae-code" && row.id === "missing-bare-role")).toBe(
			false,
		);

		const selection = await client.control("model.set", { id: "gajae-code/custom-eco" });
		// Q27 remains the full profile catalog and agrees with the Q10
		// availability facade on the shared authenticated-provider derivation.
		const profiles = (await client.query("Q27")) as {
			page?: { items: Array<{ id: string; available?: boolean }> };
		};
		const customEcoProfile = profiles.page?.items.find(item => item.id === "custom-eco");
		expect(customEcoProfile).toMatchObject({ id: "custom-eco", available: true });
		const missingBareRoleProfile = profiles.page?.items.find(item => item.id === "missing-bare-role");
		expect(missingBareRoleProfile).toMatchObject({ id: "missing-bare-role", available: false });
		expect((selection as { ok?: boolean; result?: unknown }).ok).toBe(true);
		expect((selection as { result?: unknown }).result).toEqual({ changed: true });

		// Concurrent synthetic selections serialize through the session admission
		// queue (FIFO); a racing config.patch remains durable because session-scoped
		// activation never rewrites persisted profile-owned settings.
		const concurrent = await Promise.all([
			client.control("model.set", { id: "gajae-code/custom-eco" }),
			client.control("model.set", { id: "gajae-code/custom-eco" }),
		]);
		expect(concurrent.every(result => (result as { ok?: boolean }).ok === true)).toBe(true);
		const racyPatch = await Promise.all([
			client.control("config.patch", {
				patch: {
					modelRoles: { default: "runtime-provider/initial-model" },
					cycleOrder: ["default", "executor"],
				},
			}),
			client.control("model.set", { id: "gajae-code/custom-eco" }),
		]);
		expect((racyPatch[0] as { ok?: boolean }).ok).toBe(true);
		expect((racyPatch[1] as { ok?: boolean }).ok).toBe(true);
		expect(settings.getGlobal("modelRoles")).toEqual({ default: "runtime-provider/initial-model" });
		expect(settings.getGlobal("modelProfile.default")).toBeUndefined();
		expect(session.getActiveModelProfile()).toBe("custom-eco");
		expect(session.model?.provider).toBe("runtime-provider");
		expect(session.model?.id).toBe("initial-model");
		expect(settings.getGlobal("modelProfile.default")).toBeUndefined();
		expect(settings.getGlobal("modelRoles")).toEqual({ default: "runtime-provider/initial-model" });
		// The config query shadow remains authoritative because session-scoped
		// activation does not rewrite either patched setting.
		const configAfter = (await client.query("Q13")) as { page?: { items: unknown[] } };
		const configFlat = (configAfter.page?.items ?? []).flatMap(item => {
			const record = item as Record<string, unknown>;
			if (typeof record.id === "string") return [[record.id, record.value] as const];
			return Object.entries(record);
		});
		expect(configFlat.some(([key]) => key === "modelRoles")).toBe(true);
		expect(configFlat.some(([key]) => key === "cycleOrder")).toBe(true);
		// The FULL preset is applied to the live session: every role mapping from
		// the profile is active as a runtime override (executor/planner/critic/
		// architect -> task.agentModelOverrides) without changing durable roles.
		expect(settings.get("task.agentModelOverrides")).toEqual({
			executor: "runtime-provider/executor-model",
			planner: "runtime-provider/planner-model",
			critic: "runtime-provider/critic-model",
			architect: "runtime-provider/architect-model",
		});
		const afterCatalog = (await client.query("Q10")) as { page?: { items: Q10Model[] } };
		const currentRows = afterCatalog.page?.items.filter(row => row.current);
		expect(currentRows).toHaveLength(1);
		expect(currentRows?.[0]).toMatchObject({
			provider: "gajae-code",
			id: "custom-eco",
			current: true,
			currentThinkingLevel: "inherit",
		});

		// A concrete selection clears the session-only marker without materializing
		// profile assignments or writing a global profile default.
		await client.control("model.set", { id: "runtime-provider/initial-model" });
		expect(session.getActiveModelProfile()).toBeUndefined();
		expect(settings.getGlobal("modelProfile.default")).toBeUndefined();
		expect(settings.getGlobal("modelRoles")).toEqual({ default: "runtime-provider/initial-model" });

		const concreteCatalog = (await client.query("Q10")) as { page?: { items: Q10Model[] } };
		const concreteCurrent = concreteCatalog.page?.items.filter(row => row.current);
		expect(concreteCurrent).toHaveLength(1);
		expect(concreteCurrent?.[0]).toMatchObject({ provider: "runtime-provider", id: "initial-model" });

		// Registry-error fail-closed: an invalid models.yml must not advertise
		// synthetic rows (selection would reject them via the same registry
		// error) while the concrete catalog stays queryable.
		await fs.writeFile(path.join(agentDir, "models.yml"), "profiles: [broken\n");
		await modelRegistry.refresh("offline");
		expect(modelRegistry.getError?.()).toBeDefined();
		const errorCatalog = (await client.query("Q10")) as { page?: { items: Q10Model[] } };
		expect(errorCatalog.page?.items.some(row => row.provider === "gajae-code")).toBe(false);
		expect(errorCatalog.page?.items.some(row => row.provider === "runtime-provider")).toBe(true);

		// Restore a valid configuration so the fresh-launch reapply below works.
		await fs.writeFile(path.join(agentDir, "models.yml"), modelsYml);
		await modelRegistry.refresh("offline");
		expect(modelRegistry.getError?.()).toBeUndefined();
		await client.control("model.set", { id: "gajae-code/custom-eco" });
		expect(session.getActiveModelProfile()).toBe("custom-eco");

		// Reserved-namespace collision: a real provider named `gajae-code` makes
		// `gajae-code/*` ids ambiguous, so Q10 must not advertise ANY row from
		// that namespace — neither the colliding provider's concrete models nor
		// synthetic profiles — while other providers stay queryable.
		await fs.writeFile(
			path.join(agentDir, "models.yml"),
			YAML.stringify({
				providers: {
					"runtime-provider": {
						baseUrl: "http://127.0.0.1:9/v1",
						apiKey: "RUNTIME_KEY",
						api: "openai-completions",
						models: [
							{
								id: "initial-model",
								name: "Initial Model",
								reasoning: false,
								input: ["text"],
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
								contextWindow: 128_000,
								maxTokens: 8_192,
							},
						],
					},
					"gajae-code": {
						baseUrl: "http://127.0.0.1:9/v1",
						apiKey: "RUNTIME_KEY",
						api: "openai-completions",
						models: [
							{
								id: "shadow-model",
								name: "Shadow Model",
								reasoning: false,
								input: ["text"],
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
								contextWindow: 128_000,
								maxTokens: 8_192,
							},
						],
					},
				},
				profiles: {
					"custom-eco": {
						display_name: "Custom Eco",
						required_providers: ["runtime-provider"],
						model_mapping: { default: "runtime-provider/initial-model" },
					},
					// A profile whose default mapping cannot activate (its
					// required provider is authenticated but the default maps to
					// an unauthenticated provider) must not be advertised.
					"broken-default": {
						display_name: "Broken Default",
						required_providers: ["runtime-provider"],
						model_mapping: { default: "no-such-provider/ghost-model" },
					},
				},
			}),
		);
		await modelRegistry.refresh("offline");
		vi.spyOn(modelRegistry, "getAll").mockReturnValue([
			initialModel,
			modelRegistry.find("runtime-provider", "reasoning-model")!,
			modelRegistry.find("gajae-code", "shadow-model")!,
		]);
		const collisionCatalog = (await client.query("Q10")) as { page?: { items: Q10Model[] } };
		expect(collisionCatalog.page?.items.some(row => row.provider === "gajae-code")).toBe(false);
		expect(collisionCatalog.page?.items.some(row => row.provider === "runtime-provider")).toBe(true);
		expect(
			collisionCatalog.page?.items.some(row => row.provider === "gajae-code" && row.id === "broken-default"),
		).toBe(false);
		// An already-active synthetic profile must not reinstate a collided
		// synthetic value through Q13/ACP current-value fallback.
		const collisionConfig = (await client.query("Q13")) as { page?: { items: unknown[] } };
		const collisionModel = (collisionConfig.page?.items ?? [])
			.flatMap(item => {
				const record = item as Record<string, unknown>;
				return typeof record.id === "string" ? [[record.id, record.value] as const] : Object.entries(record);
			})
			.find(([key]) => key === "model")?.[1];
		expect(collisionModel).toBe("runtime-provider/initial-model");

		// A session transition must not carry the profile into the successor:
		// session.new resets the marker and the runtime role overrides so the
		// successor session reports its own concrete model as current. Verify
		// directly on the session because the SDK endpoint closes on the
		// identity rotation. Restore the non-collided registry first.
		await fs.writeFile(path.join(agentDir, "models.yml"), modelsYml);
		await modelRegistry.refresh("offline");
		vi.spyOn(modelRegistry, "getAll").mockReturnValue([
			initialModel,
			modelRegistry.find("runtime-provider", "reasoning-model")!,
			modelRegistry.find("runtime-provider", "executor-model")!,
			modelRegistry.find("runtime-provider", "planner-model")!,
			modelRegistry.find("runtime-provider", "critic-model")!,
			modelRegistry.find("runtime-provider", "architect-model")!,
		]);
		expect(modelRegistry.getError?.()).toBeUndefined();
		await client.control("model.set", { id: "gajae-code/custom-eco" });
		expect(session.getActiveModelProfile()).toBe("custom-eco");
		expect(settings.get("task.agentModelOverrides")).toEqual({
			executor: "runtime-provider/executor-model",
			planner: "runtime-provider/planner-model",
			critic: "runtime-provider/critic-model",
			architect: "runtime-provider/architect-model",
		});
		// While active, the profile overrides the configured critic binding.
		expect(settings.get("task.agentModelOverrides")?.critic).toBe("runtime-provider/critic-model");

		// A concrete selection after a session-only profile drops the marker AND
		// the runtime role overrides the profile activation installed, while the
		// configured modelBinding for critic survives the drop.
		await client.control("model.set", { id: "runtime-provider/initial-model" });
		expect(session.getActiveModelProfile()).toBeUndefined();
		expect(settings.get("task.agentModelOverrides")).toEqual({ critic: "runtime-provider/reasoning-model" });
		expect(settings.getGlobal("modelRoles")).toEqual({ default: "runtime-provider/initial-model" });

		// A session transition must not carry the profile into the successor:
		// session.new resets the marker and the runtime role overrides so the
		// successor session reports its own concrete model as current. Verify
		// directly on the session because the SDK endpoint closes on the
		// identity rotation.
		await client.control("model.set", { id: "gajae-code/custom-eco" });
		expect(session.getActiveModelProfile()).toBe("custom-eco");
		expect(settings.get("task.agentModelOverrides")).toEqual({
			executor: "runtime-provider/executor-model",
			planner: "runtime-provider/planner-model",
			critic: "runtime-provider/critic-model",
			architect: "runtime-provider/architect-model",
		});
		expect(await session.newSession()).toBe(true);
		expect(session.getActiveModelProfile()).toBeUndefined();
		// The profile's role overrides are gone; the durable schema default is
		// an empty record rather than the profile's four-role mapping, while the
		// configured critic binding survives the transition.
		expect(settings.get("task.agentModelOverrides")).toEqual({ critic: "runtime-provider/reasoning-model" });
		expect(session.model?.provider).toBe("runtime-provider");
		expect(session.model?.id).toBe("initial-model");

		// A DURABLE profile survives the transition: /new keeps its marker and
		// runtime role overrides because the startup policy reapplies it on a
		// fresh launch.
		await session.setDefaultModelProfileForControl("custom-eco", { persistDefault: true });
		expect(session.getActiveModelProfile()).toBe("custom-eco");
		expect(settings.getGlobal("modelProfile.default")).toBe("custom-eco");
		expect(settings.get("task.agentModelOverrides")).toEqual({
			executor: "runtime-provider/executor-model",
			planner: "runtime-provider/planner-model",
			critic: "runtime-provider/critic-model",
			architect: "runtime-provider/architect-model",
		});
		expect(await session.newSession()).toBe(true);
		expect(session.getActiveModelProfile()).toBe("custom-eco");
		expect(settings.getGlobal("modelProfile.default")).toBe("custom-eco");
		expect(settings.get("task.agentModelOverrides")).toEqual({
			executor: "runtime-provider/executor-model",
			planner: "runtime-provider/planner-model",
			critic: "runtime-provider/critic-model",
			architect: "runtime-provider/architect-model",
		});

		// A default-only successor profile drops the previous profile's role-agent
		// mappings even though it contributes none of its own.
		await session.setDefaultModelProfileForControl("default-only-eco", { persistDefault: false });
		expect(session.getActiveModelProfile()).toBe("default-only-eco");
		expect(settings.get("task.agentModelOverrides")).toEqual({});
		// The durable custom-eco default is still configured but no longer
		// matches the session-only marker; a concrete pick supersedes it.
		expect(settings.getGlobal("modelProfile.default")).toBe("custom-eco");
		await session.setDefaultModelSelection(initialModel, undefined);
		expect(session.getActiveModelProfile()).toBeUndefined();
		expect(settings.getGlobal("modelProfile.default")).toBeUndefined();
		expect(settings.getGlobal("modelRoles")).toEqual({ default: "runtime-provider/initial-model:off" });
		expect(settings.get("task.agentModelOverrides")).toEqual({ critic: "runtime-provider/reasoning-model" });

		// Restore the session-only baseline so the fresh-launch assertions below
		// expect no persisted profile.
		await session.setDefaultModelProfileForControl("custom-eco", { persistDefault: false });
		expect(await session.newSession()).toBe(true);
		expect(session.getActiveModelProfile()).toBeUndefined();
		expect(settings.getGlobal("modelProfile.default")).toBeUndefined();
		expect(settings.get("task.agentModelOverrides")).toEqual({ critic: "runtime-provider/reasoning-model" });
	} finally {
		await client.close();
	}

	// A fresh launch must not inherit a profile selected through ACP. The fresh
	// session does not need an SDK endpoint, so disable hosting to avoid an
	// async discovery-file write racing fixture-root removal during cleanup.
	process.env.GJC_SDK_DISABLE = "1";
	const { session: freshSession } = await createAgentSession({
		cwd: tempDir,
		agentDir,
		authStorage,
		modelRegistry,
		settings,
		sessionManager: SessionManager.inMemory(tempDir),
		disableExtensionDiscovery: true,
		extensions: [],
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
	});
	if (!fixtureCleanup) throw new Error("Expected fixture broker cleanup.");
	registerFixtureRuntime(fixtureCleanup, {
		key: `session:${freshSession.sessionId}`,
		requiredOwner: "runtime-and-broker",
		dispose: () => freshSession.dispose(),
	});
	expect(freshSession.getActiveModelProfile()).toBeUndefined();
	expect(settings.getGlobal("modelProfile.default")).toBeUndefined();

	// Let any in-flight SDK-host/broker discovery writes settle before the
	// fixture cleanup removes the root, so the absence observation never sees a
	// stale async write recreate the fixture root.
	await Bun.sleep(200);
}, 30_000);
