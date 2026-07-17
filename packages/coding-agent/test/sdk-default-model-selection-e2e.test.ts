import { afterEach, expect, setDefaultTimeout, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { closeModelCache, Effort } from "@gajae-code/ai";
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
