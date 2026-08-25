import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { closeModelCache, DEFAULT_MODEL_PER_PROVIDER, Effort, getBundledModel, type Model } from "@gajae-code/ai";
import { ModelRegistry, ModelsConfigFile } from "@gajae-code/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@gajae-code/coding-agent/config/settings";
import { createAgentSession } from "@gajae-code/coding-agent/sdk";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { getAgentDbPath, getAgentDir, hookFetch, Snowflake, setAgentDir } from "@gajae-code/utils";

setDefaultTimeout(20_000);

describe("createAgentSession deferred model pattern resolution", () => {
	let tempDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = path.join(os.tmpdir(), `pi-sdk-model-selection-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		registerRuntimeProvider(modelRegistry);
	});

	afterEach(async () => {
		resetSettingsForTest();
		await modelRegistry?.dispose();
		authStorage?.close();
		if (tempDir && fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	function registerRuntimeProvider(target: ModelRegistry): void {
		target.registerProvider("runtime-provider", {
			baseUrl: "http://127.0.0.1:9/v1",
			apiKey: "RUNTIME_KEY",
			api: "openai-completions",
			models: [
				{
					id: "runtime-model",
					name: "Runtime Model",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128000,
					maxTokens: 8192,
				},
				{
					id: "runtime-reasoning-model",
					name: "Runtime Reasoning Model",
					reasoning: true,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128000,
					maxTokens: 8192,
					compat: { supportsReasoningEffort: true },
					thinking: {
						minLevel: Effort.Minimal,
						maxLevel: Effort.High,
						mode: "effort",
						defaultLevel: Effort.Low,
					},
				},
				{
					id: "runtime-global-b",
					name: "Runtime Global B",
					reasoning: true,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128000,
					maxTokens: 8192,
					compat: { supportsReasoningEffort: true },
					thinking: {
						minLevel: Effort.Minimal,
						maxLevel: Effort.High,
						mode: "effort",
						defaultLevel: Effort.Low,
					},
				},
				{
					id: "runtime-policy-c",
					name: "Runtime Policy C",
					reasoning: true,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128000,
					maxTokens: 8192,
					compat: { supportsReasoningEffort: true },
					thinking: {
						minLevel: Effort.Minimal,
						maxLevel: Effort.High,
						mode: "effort",
						defaultLevel: Effort.Low,
					},
				},
			],
		});
	}

	function buildSessionOptions(modelPattern?: string, sessionManager: SessionManager = SessionManager.inMemory()) {
		return {
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager,
			disableExtensionDiscovery: true,
			extensions: [],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			workspaceTree: { rootPath: tempDir, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
			toolNames: [],
			rules: [],
			modelRegistry,
			modelPattern,
		};
	}

	interface OwnedDiscoveryFixture {
		root: string;
		agentDir: string;
		provider: string;
		modelId: string;
		foreignProvider: string;
		foreignRowId: number;
		wrongRowId: number;
		selectedRowId: number;
		commandRowId: number;
		commandMarker: string;
		preloadedRegistry?: ModelRegistry;
		cleanup(): Promise<void>;
	}

	async function seedOwnedDiscoveryFixture(
		cacheCredential: "wrong" | "selected" = "selected",
	): Promise<OwnedDiscoveryFixture> {
		const root = path.join(tempDir, `owned-${Snowflake.next()}`);
		const agentDir = path.join(root, "agent");
		const modelsPath = path.join(agentDir, "models.yml");
		const cacheDbPath = path.join(agentDir, "models.db");
		const provider = "fixture-owned-discovery";
		const foreignProvider = "fixture-foreign-discovery";
		const modelId = "discovered-only-model";
		const baseUrl = "https://owned-discovery.example.test/v1";
		const commandMarker = path.join(root, "command-ran");
		const originalAgentDir = getAgentDir();
		const originalGjcAgentDir = process.env.GJC_CODING_AGENT_DIR;
		const originalPiAgentDir = process.env.PI_CODING_AGENT_DIR;
		const originalRelocate = ModelsConfigFile.relocate.bind(ModelsConfigFile);
		let restoreModelsConfigRelocate: (() => void) | undefined;
		let seedAuth: AuthStorage | undefined;
		let seedRegistry: ModelRegistry | undefined;

		const restoreEnvironment = () => {
			setAgentDir(originalAgentDir);
			if (originalGjcAgentDir === undefined) delete process.env.GJC_CODING_AGENT_DIR;
			else process.env.GJC_CODING_AGENT_DIR = originalGjcAgentDir;
			if (originalPiAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = originalPiAgentDir;
		};
		const cleanup = async () => {
			restoreModelsConfigRelocate?.();
			await seedRegistry?.dispose();
			closeModelCache(cacheDbPath);
			closeModelCache();
			seedAuth?.close();
			restoreEnvironment();
			await fs.promises.rm(root, { recursive: true, force: true });
			expect(fs.existsSync(root)).toBe(false);
		};

		try {
			await Bun.write(
				modelsPath,
				JSON.stringify({
					providers: {
						[provider]: {
							baseUrl,
							api: "openai-responses",
							discovery: { type: "openai-models-list" },
						},
					},
				}),
			);
			const wrongKey = ["fixture", "literal", "wrong"].join("-");
			const selectedKey = ["fixture", "literal", "selected"].join("-");
			const foreignKey = ["fixture", "literal", "foreign"].join("-");
			const commandReference = `!printf command-ran > ${JSON.stringify(commandMarker)}`;
			seedAuth = await AuthStorage.create(getAgentDbPath(agentDir));
			await seedAuth.set(provider, [
				{ type: "api_key", key: wrongKey },
				{ type: "api_key", key: selectedKey },
				{ type: "api_key", key: commandReference },
			]);
			await seedAuth.set(foreignProvider, [{ type: "api_key", key: foreignKey }]);
			const rows = seedAuth.listCredentialInventory(provider);
			const foreignRow = seedAuth.listCredentialInventory(foreignProvider)[0];
			const wrongRow = rows[0];
			const selectedRow = rows[1];
			const commandRow = rows[2];
			if ([foreignRow, wrongRow, selectedRow, commandRow].some(row => row?.credentialKind !== "api_key")) {
				throw new Error("Expected literal and command API-key fixture rows");
			}

			seedRegistry = new ModelRegistry(seedAuth, modelsPath);
			if (cacheCredential === "selected") {
				expect(await seedAuth.getApiKey(provider)).toBe(wrongKey);
			}
			const cacheKey = cacheCredential === "selected" ? selectedKey : wrongKey;
			let seedRequests = 0;
			using _seedFetch = hookFetch((input, init) => {
				seedRequests += 1;
				expect(String(input)).toBe(`${baseUrl}/models`);
				expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${cacheKey}`);
				return new Response(JSON.stringify({ data: [{ id: modelId }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			});
			await seedRegistry.refreshProvider(provider, "online");
			expect(seedRequests).toBe(1);
			expect(seedRegistry.find(provider, modelId)).toBeDefined();
			const preloadedRegistry = cacheCredential === "wrong" ? seedRegistry : undefined;
			if (!preloadedRegistry) {
				seedAuth.close();
				seedAuth = undefined;
			}
			closeModelCache(cacheDbPath);

			setAgentDir(agentDir);
			const isolatedModelsConfig = originalRelocate(modelsPath);
			const relocateSpy = vi
				.spyOn(ModelsConfigFile, "relocate")
				.mockImplementation(requestedPath =>
					requestedPath === undefined ? isolatedModelsConfig : originalRelocate(requestedPath),
				);
			restoreModelsConfigRelocate = () => relocateSpy.mockRestore();

			return {
				root,
				agentDir,
				provider,
				modelId,
				foreignProvider,
				foreignRowId: foreignRow.id,
				wrongRowId: wrongRow.id,
				selectedRowId: selectedRow.id,
				commandRowId: commandRow.id,
				commandMarker,
				preloadedRegistry,
				cleanup,
			};
		} catch (error) {
			await cleanup();
			throw error;
		}
	}

	function ownedDiscoverySessionOptions(fixture: OwnedDiscoveryFixture, rowId: number, modelId = fixture.modelId) {
		return {
			cwd: fixture.root,
			agentDir: fixture.agentDir,
			enableMCP: false,
			enableLsp: false,
			workspaceTree: { rootPath: fixture.root, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
			modelPattern: `${fixture.provider}/${modelId}`,
			credentialSelector: {
				provider: fixture.provider,
				selector: { kind: "id" as const, value: String(rowId) },
				raw: `${fixture.provider}/id:${rowId}`,
			},
		};
	}

	function spyOnCacheAdmissions(results: boolean[]) {
		const admit = ModelRegistry.prototype.admitCachedProviderForStoredLiteralCredential;
		return vi
			.spyOn(ModelRegistry.prototype, "admitCachedProviderForStoredLiteralCredential")
			.mockImplementation(function (this: ModelRegistry, provider, selector) {
				const admitted = admit.call(this, provider, selector);
				results.push(admitted);
				return admitted;
			});
	}

	async function assertOwnedCachedModelNotFound(
		fixture: OwnedDiscoveryFixture,
		rowId: number,
		modelId: string,
		expectedAdmission: boolean,
	): Promise<void> {
		const admissions: boolean[] = [];
		let providerRequests = 0;
		let session: { dispose(): Promise<void> } | undefined;
		try {
			using _admissions = spyOnCacheAdmissions(admissions);
			using _blockedFetch = hookFetch(() => {
				providerRequests += 1;
				return Promise.reject(new Error("provider request"));
			});
			const result = await createAgentSession(ownedDiscoverySessionOptions(fixture, rowId, modelId));
			session = result.session;
			expect(admissions).toEqual([expectedAdmission]);
			expect(result.session.model).toBeUndefined();
			expect(result.modelFallbackMessage).toBe(`Model "${fixture.provider}/${modelId}" not found`);
			expect(providerRequests).toBe(0);
		} finally {
			await session?.dispose();
			await fixture.cleanup();
		}
	}

	test("uses the machine-global default selector and its effective suffix for a fresh session", async () => {
		// Given a durable machine-global B selector
		await Bun.write(
			path.join(tempDir, "config.yml"),
			"modelRoles:\n  default: runtime-provider/runtime-global-b:high\n",
		);
		const settings = await Settings.init({ cwd: tempDir, agentDir: tempDir });

		// When a fresh session starts without an explicit model
		const { session } = await createAgentSession({ ...buildSessionOptions(), settings });

		// Then it consumes both the global model and effective thinking suffix
		expect(settings.getGlobal("modelRoles")).toEqual({
			default: "runtime-provider/runtime-global-b:high",
		});
		expect(session.model?.id).toBe("runtime-global-b");
		expect(session.thinkingLevel).toBe(Effort.High);
		await session.dispose();
	});

	test("uses project default role C instead of machine-global B for a fresh session", async () => {
		// Given global B and a project-scoped C override
		await Bun.write(
			path.join(tempDir, "config.yml"),
			"modelRoles:\n  default: runtime-provider/runtime-global-b:high\n",
		);
		await Bun.write(
			path.join(tempDir, ".gjc", "config.yml"),
			"modelRoles:\n  default: runtime-provider/runtime-policy-c:low\n",
		);
		const settings = await Settings.init({ cwd: tempDir, agentDir: tempDir });

		// When a fresh project session starts without an explicit model
		const { session } = await createAgentSession({ ...buildSessionOptions(), settings });

		// Then project C and its suffix outrank global B
		expect(settings.getGlobal("modelRoles")).toEqual({
			default: "runtime-provider/runtime-global-b:high",
		});
		expect(settings.getModelRole("default")).toBe("runtime-provider/runtime-policy-c:low");
		expect(session.model?.id).toBe("runtime-policy-c");
		expect(session.thinkingLevel).toBe(Effort.Low);
		await session.dispose();
	});

	test("restores resumed transcript C instead of machine-global B", async () => {
		// Given global B and a resumed transcript that records C with medium thinking
		await Bun.write(
			path.join(tempDir, "config.yml"),
			"modelRoles:\n  default: runtime-provider/runtime-global-b:high\n",
		);
		const settings = await Settings.init({ cwd: tempDir, agentDir: tempDir });
		const sessionManager = SessionManager.inMemory(tempDir);
		sessionManager.appendModelChange("runtime-provider/runtime-policy-c", "default");
		sessionManager.appendThinkingLevelChange(Effort.Medium);

		// When the recorded transcript resumes without an explicit model
		const { session } = await createAgentSession({ ...buildSessionOptions(undefined, sessionManager), settings });

		// Then transcript C and its recorded thinking level outrank global B
		expect(settings.getGlobal("modelRoles")).toEqual({
			default: "runtime-provider/runtime-global-b:high",
		});
		expect(session.model?.id).toBe("runtime-policy-c");
		expect(session.thinkingLevel).toBe(Effort.Medium);
		await session.dispose();
	});

	test("resolves explicit modelPattern after runtime providers are available", async () => {
		const { session, modelFallbackMessage } = await createAgentSession(
			buildSessionOptions("runtime-provider/runtime-model"),
		);

		expect(session.model).toBeDefined();
		expect(session.model?.provider).toBe("runtime-provider");
		expect(session.model?.id).toBe("runtime-model");
		expect(modelFallbackMessage).toBeUndefined();
		await session.dispose();
	});

	test("does not silently fallback when explicit modelPattern is unresolved", async () => {
		const { session, modelFallbackMessage } = await createAgentSession(
			buildSessionOptions("missing-provider/missing-model"),
		);

		expect(session.model).toBeUndefined();
		expect(modelFallbackMessage).toBe('Model "missing-provider/missing-model" not found');
		await session.dispose();
	});

	test("owned registry credential-scoped cache startup selects before background fetch", async () => {
		const fixture = await seedOwnedDiscoveryFixture();
		const events: string[] = [];
		const backgroundCatalogSnapshots: boolean[] = [];
		let startupFetches = 0;
		let session: { model: Model | undefined; dispose(): Promise<void> } | undefined;
		let assertionFailure: unknown;
		const originalGetAll = ModelRegistry.prototype.getAll;
		const originalRefreshInBackground = ModelRegistry.prototype.refreshInBackground;

		try {
			using _catalogEvents = vi.spyOn(ModelRegistry.prototype, "getAll").mockImplementation(function (
				this: ModelRegistry,
			) {
				const models = originalGetAll.call(this);
				if (
					models.some(model => model.provider === fixture.provider && model.id === fixture.modelId) &&
					!events.includes("catalog:target-visible")
				) {
					events.push("catalog:target-visible");
				}
				return models;
			});
			using _backgroundEvents = vi
				.spyOn(ModelRegistry.prototype, "refreshInBackground")
				.mockImplementation(function (this: ModelRegistry, strategy) {
					events.push("background:start");
					backgroundCatalogSnapshots.push(this.find(fixture.provider, fixture.modelId) !== undefined);
					return originalRefreshInBackground.call(this, strategy);
				});
			using _blockedStartupFetch = hookFetch(() => {
				startupFetches += 1;
				events.push("provider:fetch");
				throw new Error("owned startup must not contact the provider before model resolution");
			});

			const result = await createAgentSession({
				cwd: fixture.root,
				agentDir: fixture.agentDir,
				disableExtensionDiscovery: true,
				extensions: [],
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				workspaceTree: {
					rootPath: fixture.root,
					rendered: "",
					truncated: false,
					totalLines: 0,
					agentsMdFiles: [],
				},
				toolNames: [],
				rules: [],
				modelPattern: `${fixture.provider}/${fixture.modelId}`,
				credentialSelector: {
					provider: fixture.provider,
					selector: { kind: "id", value: String(fixture.selectedRowId) },
					raw: `${fixture.provider}/id:${fixture.selectedRowId}`,
				},
			});
			session = result.session;
			await Bun.sleep(0);
			events.push(session.model ? "model:selected" : "model:not-found");

			expect(session.model).toMatchObject({ provider: fixture.provider, id: fixture.modelId });
			expect(result.modelFallbackMessage).toBeUndefined();
			expect(backgroundCatalogSnapshots).toEqual([]);
			expect(startupFetches).toBe(0);
			const catalogVisible = events.indexOf("catalog:target-visible");
			const modelSelected = events.indexOf("model:selected");
			expect(catalogVisible).toBeGreaterThanOrEqual(0);
			expect(modelSelected).toBeGreaterThan(catalogVisible);
		} catch (error) {
			assertionFailure = error;
		} finally {
			await session?.dispose();
			await fixture.cleanup();
		}

		expect(fs.existsSync(fixture.root)).toBe(false);
		if (assertionFailure !== undefined) throw assertionFailure;
	});

	test("owned registry credential-scoped cache startup does not execute a command selector", async () => {
		const fixture = await seedOwnedDiscoveryFixture();
		let session: { model: Model | undefined; dispose(): Promise<void> } | undefined;
		let assertionFailure: unknown;

		try {
			const commandAuth = await AuthStorage.create(getAgentDbPath(fixture.agentDir));
			try {
				expect(
					commandAuth.getStoredLiteralApiKeyEvidenceGeneration(fixture.provider, {
						kind: "id",
						value: String(fixture.commandRowId),
					}),
				).toBeUndefined();
			} finally {
				commandAuth.close();
			}
			using _blockedStartupFetch = hookFetch(() => {
				throw new Error("command credential guard must remain offline");
			});
			const result = await createAgentSession({
				cwd: fixture.root,
				agentDir: fixture.agentDir,
				disableExtensionDiscovery: true,
				extensions: [],
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				workspaceTree: {
					rootPath: fixture.root,
					rendered: "",
					truncated: false,
					totalLines: 0,
					agentsMdFiles: [],
				},
				toolNames: [],
				rules: [],
				modelPattern: `${fixture.provider}/${fixture.modelId}`,
				credentialSelector: {
					provider: fixture.provider,
					selector: { kind: "id", value: String(fixture.commandRowId) },
					raw: `${fixture.provider}/id:${fixture.commandRowId}`,
				},
			});
			session = result.session;
			await Bun.sleep(0);

			expect(fs.existsSync(fixture.commandMarker)).toBe(false);
			expect(session.model).toBeUndefined();
			expect(result.modelFallbackMessage).toBe(`Model "${fixture.provider}/${fixture.modelId}" not found`);
		} catch (error) {
			assertionFailure = error;
		} finally {
			await session?.dispose();
			await fixture.cleanup();
		}

		expect(fs.existsSync(fixture.root)).toBe(false);
		if (assertionFailure !== undefined) throw assertionFailure;
	});

	test("owned registry provider-mismatched selector suppresses background refresh", async () => {
		const fixture = await seedOwnedDiscoveryFixture();
		const admissions: boolean[] = [];
		let backgroundRefreshes = 0;
		let providerRequests = 0;
		let session: { dispose(): Promise<void> } | undefined;
		try {
			const foreignAuth = await AuthStorage.create(getAgentDbPath(fixture.agentDir));
			try {
				expect(
					foreignAuth.getStoredLiteralApiKeyEvidenceGeneration(fixture.foreignProvider, {
						kind: "id",
						value: String(fixture.foreignRowId),
					}),
				).toBeDefined();
			} finally {
				foreignAuth.close();
			}
			using _admissions = spyOnCacheAdmissions(admissions);
			using _backgroundRefresh = vi.spyOn(ModelRegistry.prototype, "refreshInBackground").mockImplementation(() => {
				backgroundRefreshes += 1;
			});
			using _blockedFetch = hookFetch(() => {
				providerRequests += 1;
				return Promise.reject(new Error("provider request"));
			});
			const result = await createAgentSession({
				...ownedDiscoverySessionOptions(fixture, fixture.foreignRowId),
				credentialSelector: {
					provider: fixture.foreignProvider,
					selector: { kind: "id", value: String(fixture.foreignRowId) },
					raw: `${fixture.foreignProvider}/id:${fixture.foreignRowId}`,
				},
			});
			session = result.session;
			expect(admissions).toEqual([]);
			expect(backgroundRefreshes).toBe(0);
			expect(result.session.model).toBeUndefined();
			expect(result.modelFallbackMessage).toBe(`Model "${fixture.provider}/${fixture.modelId}" not found`);
			expect(providerRequests).toBe(0);
		} finally {
			await session?.dispose();
			await fixture.cleanup();
		}
	});

	test("injected registry credential cache does not mutate shared catalog", async () => {
		const fixture = await seedOwnedDiscoveryFixture();
		const sharedAuth = await AuthStorage.create(getAgentDbPath(fixture.agentDir));
		const sharedRegistry = new ModelRegistry(sharedAuth, path.join(fixture.agentDir, "models.yml"));
		let providerRequests = 0;
		let session: { dispose(): Promise<void> } | undefined;
		try {
			expect(sharedRegistry.find(fixture.provider, fixture.modelId)).toBeUndefined();
			using _blockedFetch = hookFetch(() => {
				providerRequests += 1;
				return Promise.reject(new Error("provider request"));
			});
			const result = await createAgentSession({
				...ownedDiscoverySessionOptions(fixture, fixture.selectedRowId),
				modelRegistry: sharedRegistry,
			});
			session = result.session;
			expect(sharedRegistry.find(fixture.provider, fixture.modelId)).toBeUndefined();
			expect(result.session.model).toBeUndefined();
			expect(result.modelFallbackMessage).toBe(`Model "${fixture.provider}/${fixture.modelId}" not found`);
			expect(providerRequests).toBe(0);
		} finally {
			await session?.dispose();
			sharedAuth.close();
			await fixture.cleanup();
		}
	});

	test("owned registry wrong literal credential does not admit cached model", async () => {
		const fixture = await seedOwnedDiscoveryFixture();
		await assertOwnedCachedModelNotFound(fixture, fixture.wrongRowId, fixture.modelId, false);
	});

	test("owned registry matching cache keeps unknown model unresolved", async () => {
		const fixture = await seedOwnedDiscoveryFixture();
		await assertOwnedCachedModelNotFound(fixture, fixture.selectedRowId, "genuinely-unknown-model", true);
	});

	test("explicit selector rejects an existing dynamic model cached for another literal credential", async () => {
		const fixture = await seedOwnedDiscoveryFixture("wrong");
		const admissions: boolean[] = [];
		const sharedRegistry = fixture.preloadedRegistry;
		if (!sharedRegistry) throw new Error("Expected preloaded foreign-credential registry");
		let providerRequests = 0;
		let session: { dispose(): Promise<void> } | undefined;
		try {
			expect(sharedRegistry.find(fixture.provider, fixture.modelId)).toBeDefined();
			const discoveryStateBefore = sharedRegistry.getProviderDiscoveryState(fixture.provider);
			using _admissions = spyOnCacheAdmissions(admissions);
			using _blockedFetch = hookFetch(() => {
				providerRequests += 1;
				return Promise.reject(new Error("provider request"));
			});
			const result = await createAgentSession({
				...ownedDiscoverySessionOptions(fixture, fixture.selectedRowId, fixture.modelId),
				modelRegistry: sharedRegistry,
			});
			session = result.session;
			expect(admissions).toEqual([]);
			expect(sharedRegistry.find(fixture.provider, fixture.modelId)).toBeDefined();
			expect(sharedRegistry.getProviderDiscoveryState(fixture.provider)).toEqual(discoveryStateBefore);
			expect(result.session.model).toBeUndefined();
			expect(result.modelFallbackMessage).toBe(`Model "${fixture.provider}/${fixture.modelId}" not found`);
			expect(providerRequests).toBe(0);
		} finally {
			await session?.dispose();
			await fixture.cleanup();
		}
	});

	test("CLI root authority revalidates a pre-resolved dynamic model against the selected literal", async () => {
		const fixture = await seedOwnedDiscoveryFixture("wrong");
		const admissions: boolean[] = [];
		const rootRegistry = fixture.preloadedRegistry;
		if (!rootRegistry) throw new Error("Expected preloaded CLI-root registry");
		const preResolvedModel = rootRegistry.find(fixture.provider, fixture.modelId);
		if (!preResolvedModel) throw new Error("Expected pre-resolved foreign-credential model");
		let admissionAttempts = 0;
		let providerRequests = 0;
		let session: { dispose(): Promise<void> } | undefined;
		try {
			using _admissions = spyOnCacheAdmissions(admissions);
			using _blockedFetch = hookFetch(() => {
				providerRequests += 1;
				return Promise.reject(new Error("provider request"));
			});
			const result = await createAgentSession({
				...ownedDiscoverySessionOptions(fixture, fixture.selectedRowId, fixture.modelId),
				model: preResolvedModel,
				modelPattern: undefined,
				modelRegistry: rootRegistry,
				modelRegistryStartupMutation: {
					owner: "cli-root",
					onAttempt: () => {
						admissionAttempts += 1;
					},
				},
			});
			session = result.session;
			expect(admissionAttempts).toBe(1);
			expect(admissions).toEqual([false]);
			expect(rootRegistry.find(fixture.provider, fixture.modelId)).toBeDefined();
			expect(result.session.model).toBeUndefined();
			expect(result.modelFallbackMessage).toBe(`Model "${fixture.provider}/${fixture.modelId}" not found`);
			expect(providerRequests).toBe(0);
		} finally {
			await session?.dispose();
			await fixture.cleanup();
		}
	});

	test("provider-mismatched selector rejects a preloaded dynamic target without mutating the registry", async () => {
		const fixture = await seedOwnedDiscoveryFixture("wrong");
		const admissions: boolean[] = [];
		const sharedRegistry = fixture.preloadedRegistry;
		if (!sharedRegistry) throw new Error("Expected preloaded provider-mismatch registry");
		const discoveryStateBefore = sharedRegistry.getProviderDiscoveryState(fixture.provider);
		let providerRequests = 0;
		let session: { dispose(): Promise<void> } | undefined;
		try {
			using _admissions = spyOnCacheAdmissions(admissions);
			using _blockedFetch = hookFetch(() => {
				providerRequests += 1;
				return Promise.reject(new Error("provider request"));
			});
			const result = await createAgentSession({
				...ownedDiscoverySessionOptions(fixture, fixture.selectedRowId, fixture.modelId),
				credentialSelector: {
					provider: fixture.foreignProvider,
					selector: { kind: "id", value: String(fixture.foreignRowId) },
					raw: `${fixture.foreignProvider}/id:${fixture.foreignRowId}`,
				},
				modelRegistry: sharedRegistry,
			});
			session = result.session;
			expect(admissions).toEqual([]);
			expect(sharedRegistry.find(fixture.provider, fixture.modelId)).toBeDefined();
			expect(sharedRegistry.getProviderDiscoveryState(fixture.provider)).toEqual(discoveryStateBefore);
			expect(result.session.model).toBeUndefined();
			expect(result.modelFallbackMessage).toBe(`Model "${fixture.provider}/${fixture.modelId}" not found`);
			expect(providerRequests).toBe(0);
		} finally {
			await session?.dispose();
			await fixture.cleanup();
		}
	});

	test("rejects an admitted dynamic target after an extension changes its request context", async () => {
		const fixture = await seedOwnedDiscoveryFixture();
		const admissions: boolean[] = [];
		let providerRequests = 0;
		let session: { dispose(): Promise<void> } | undefined;
		try {
			using _admissions = spyOnCacheAdmissions(admissions);
			using _blockedFetch = hookFetch(() => {
				providerRequests += 1;
				return Promise.reject(new Error("provider request"));
			});
			const result = await createAgentSession({
				...ownedDiscoverySessionOptions(fixture, fixture.selectedRowId, fixture.modelId),
				extensions: [
					api => {
						api.registerProvider(fixture.provider, {
							baseUrl: "https://changed-discovery.example.test/v1",
							headers: { "X-Fixture-Tenant": "changed" },
						});
					},
				],
			});
			session = result.session;
			expect(admissions).toEqual([true]);
			expect(result.session.model).toBeUndefined();
			expect(result.modelFallbackMessage).toBe(`Model "${fixture.provider}/${fixture.modelId}" not found`);
			expect(providerRequests).toBe(0);
		} finally {
			await session?.dispose();
			await fixture.cleanup();
		}
	});

	test("keeps case-insensitive bundled model resolution outside dynamic cache validation", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic model");
		const storedKey = ["fixture", "static", "anthropic"].join("-");
		await authStorage.set(model.provider, [{ type: "api_key", key: storedKey }]);
		const row = authStorage.listCredentialInventory(model.provider)[0];
		if (row?.credentialKind !== "api_key") throw new Error("Expected bundled-model API-key row");
		let providerRequests = 0;
		using _blockedFetch = hookFetch(() => {
			providerRequests += 1;
			return Promise.reject(new Error("provider request"));
		});
		const { session } = await createAgentSession({
			modelRegistry,
			modelPattern: `${model.provider.toUpperCase()}/${model.id.toUpperCase()}`,
			credentialSelector: {
				selector: { kind: "id", value: String(row.id) },
				raw: `id:${row.id}`,
			},
			disableExtensionDiscovery: true,
			settings: Settings.isolated(),
		});
		try {
			expect(session.model).toMatchObject({ provider: model.provider, id: model.id });
			expect(providerRequests).toBe(0);
		} finally {
			await session.dispose();
		}
	});

	test("keeps derived OpenRouter static routes outside dynamic cache validation", async () => {
		const baseModel = getBundledModel("openrouter", "z-ai/glm-4.7");
		if (!baseModel) throw new Error("Expected bundled OpenRouter model");
		const routedId = "z-ai/glm-4.7-20251222:nitro";
		const storedKey = ["fixture", "static", "openrouter"].join("-");
		await authStorage.set(baseModel.provider, [{ type: "api_key", key: storedKey }]);
		const row = authStorage.listCredentialInventory(baseModel.provider)[0];
		if (row?.credentialKind !== "api_key") throw new Error("Expected OpenRouter API-key row");
		let providerRequests = 0;
		using _blockedFetch = hookFetch(() => {
			providerRequests += 1;
			return Promise.reject(new Error("provider request"));
		});
		const { session } = await createAgentSession({
			modelRegistry,
			modelPattern: `${baseModel.provider}/${routedId}`,
			credentialSelector: {
				selector: { kind: "id", value: String(row.id) },
				raw: `id:${row.id}`,
			},
			disableExtensionDiscovery: true,
			settings: Settings.isolated(),
		});
		try {
			expect(session.model).toMatchObject({ provider: baseModel.provider, id: routedId });
			expect(providerRequests).toBe(0);
		} finally {
			await session.dispose();
		}
	});

	test("exact stored literal selector outranks provider environment fallback", async () => {
		const authPath = path.join(tempDir, `env-precedence-${Snowflake.next()}.db`);
		const auth = await AuthStorage.create(authPath);
		const originalOpenAiKey = process.env.OPENAI_API_KEY;
		const siblingEnvName = `GJC_SIBLING_ENV_${Snowflake.next()}`;
		const originalSiblingEnv = process.env[siblingEnvName];
		const storedKey = ["fixture", "stored", "selected"].join("-");
		try {
			await auth.set("openai", [
				{ type: "api_key", key: siblingEnvName },
				{ type: "api_key", key: storedKey },
			]);
			const row = auth.listCredentialInventory("openai")[1];
			if (row?.credentialKind !== "api_key") throw new Error("Expected stored API-key fixture row");
			const selector = { kind: "id" as const, value: String(row.id) };
			process.env.OPENAI_API_KEY = ["fixture", "environment", "fallback"].join("-");
			process.env[siblingEnvName] = ["fixture", "sibling", "one"].join("-");

			expect(await auth.getApiKey("openai", undefined, { credentialSelector: selector })).toBe(storedKey);
			const firstEvidence = auth.getStoredLiteralApiKeyEvidenceGeneration("openai", selector);
			expect(firstEvidence).toBeDefined();
			process.env[siblingEnvName] = ["fixture", "sibling", "two"].join("-");
			expect(auth.getStoredLiteralApiKeyEvidenceGeneration("openai", selector)).toBe(firstEvidence);
		} finally {
			if (originalOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
			else process.env.OPENAI_API_KEY = originalOpenAiKey;
			if (originalSiblingEnv === undefined) delete process.env[siblingEnvName];
			else process.env[siblingEnvName] = originalSiblingEnv;
			auth.close();
		}
	});

	test("does not apply default role thinking override when modelPattern is explicit", async () => {
		const settings = Settings.isolated({ defaultThinkingLevel: "off" });
		settings.setModelRole("default", "runtime-provider/runtime-reasoning-model:high");

		const { session } = await createAgentSession({
			...buildSessionOptions("runtime-provider/runtime-reasoning-model"),
			settings,
		});

		expect(session.model?.provider).toBe("runtime-provider");
		expect(session.model?.id).toBe("runtime-reasoning-model");
		expect(session.thinkingLevel).toBe("off");
		await session.dispose();
	});

	test("uses model defaultLevel when default thinking is not configured", async () => {
		const { session } = await createAgentSession(buildSessionOptions("runtime-provider/runtime-reasoning-model"));

		expect(session.model?.provider).toBe("runtime-provider");
		expect(session.model?.id).toBe("runtime-reasoning-model");
		expect(session.thinkingLevel).toBe(Effort.Low);
		await session.dispose();
	});

	test("uses explicit defaultThinkingLevel over model defaultLevel", async () => {
		const settings = Settings.isolated({ defaultThinkingLevel: Effort.Minimal });

		const { session } = await createAgentSession({
			...buildSessionOptions("runtime-provider/runtime-reasoning-model"),
			settings,
		});

		expect(session.model?.provider).toBe("runtime-provider");
		expect(session.model?.id).toBe("runtime-reasoning-model");
		expect(session.thinkingLevel).toBe(Effort.Minimal);
		await session.dispose();
	});

	test("selects the settings default model without synchronously validating auth", async () => {
		const defaultModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!defaultModel) {
			throw new Error("Expected bundled anthropic default model");
		}

		const authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
		authStorage.setRuntimeApiKey(defaultModel.provider, "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		const settings = Settings.isolated();
		settings.setModelRole("default", `${defaultModel.provider}/${defaultModel.id}`);

		const getApiKeySpy = vi
			.spyOn(modelRegistry, "getApiKey")
			.mockRejectedValue(new Error("settings default model should not validate auth during startup"));

		try {
			const { session } = await createAgentSession({
				cwd: tempDir,
				agentDir: tempDir,
				authStorage,
				modelRegistry,
				settings,
				sessionManager: SessionManager.inMemory(),
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				workspaceTree: { rootPath: tempDir, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
				toolNames: [],
				rules: [],
			});

			try {
				expect(session.model?.provider).toBe(defaultModel.provider);
				expect(session.model?.id).toBe(defaultModel.id);
				expect(getApiKeySpy).not.toHaveBeenCalled();
			} finally {
				await session.dispose();
			}
		} finally {
			getApiKeySpy.mockRestore();
			authStorage.close();
		}
	});

	test("unqualified preferred credential overrides a default model from another provider", async () => {
		// `runtime-provider` is registered with a config apiKey (via `registerRuntimeProvider`
		// in `beforeEach`), which is intentionally incompatible with a preferred-credential
		// selector (`#assertPreferredCredentialSelectorUsable` rejects providers with an active
		// API-key override). The preferred row therefore has to live on a real OAuth-backed
		// provider; a bundled provider with no separate config registration here works.
		const anthropicModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!anthropicModel) throw new Error("Expected a bundled anthropic model");
		await authStorage.set("anthropic", [
			{
				type: "oauth",
				access: "token-test-primary",
				refresh: "refresh-test-primary",
				expires: Date.now() + 60 * 60_000,
				email: "primary@example.test",
			},
		]);
		const preferredRow = authStorage.exportSnapshot().credentials.find(entry => entry.provider === "anthropic");
		if (!preferredRow) throw new Error("Expected an anthropic credential row");
		const settings = Settings.isolated();
		// Default points at `runtime-provider`, a different provider than the preference.
		settings.setModelRole("default", "runtime-provider/runtime-model");

		const { session } = await createAgentSession({
			...buildSessionOptions(),
			settings,
			preferredCredentialSelector: {
				selector: { kind: "id", value: String(preferredRow.id) },
				raw: `id:${preferredRow.id}`,
			},
		});
		try {
			// The settings default model role ("runtime-provider/runtime-model") is skipped
			// because its provider mismatches the preference; the resolved model falls back to
			// whichever anthropic candidate the fallback scan finds first — provider correctness
			// is the invariant under test, not a specific catalog entry.
			expect(session.model?.provider).toBe("anthropic");
			expect(authStorage.hasRuntimePreferredCredentialSelector("anthropic")).toBe(true);
			expect(authStorage.hasRuntimePreferredCredentialSelector("runtime-provider")).toBe(false);
		} finally {
			await session.dispose();
		}
	});

	test("honors explicit provider priority when selecting curated startup defaults", async () => {
		const anthropicDefault = getBundledModel("anthropic", DEFAULT_MODEL_PER_PROVIDER.anthropic);
		const bedrockDefault = getBundledModel("amazon-bedrock", DEFAULT_MODEL_PER_PROVIDER["amazon-bedrock"]);
		if (!anthropicDefault || !bedrockDefault) throw new Error("Expected bundled Anthropic and Bedrock defaults");

		authStorage.setRuntimeApiKey("anthropic", "anthropic-test-key");
		authStorage.setRuntimeApiKey("amazon-bedrock", "bedrock-test-key");
		const settings = Settings.isolated({ modelProviderOrder: ["amazon-bedrock", "anthropic"] });
		const { session } = await createAgentSession({
			...buildSessionOptions(),
			settings,
		});

		try {
			expect(session.model).toMatchObject({ provider: bedrockDefault.provider, id: bedrockDefault.id });
			expect(session.model?.id).not.toBe(anthropicDefault.id);
		} finally {
			await session.dispose();
		}
	});

	test("skips a curated default disproved by fresh provider discovery", async () => {
		const staleAuth = await AuthStorage.create(path.join(tempDir, `stale-default-${Snowflake.next()}.db`));
		const staleRegistry = new ModelRegistry(
			staleAuth,
			path.join(tempDir, `stale-default-${Snowflake.next()}.yml`),
			undefined,
			{ automaticRefresh: false },
		);
		const currentModelId = "claude-opus-4-6";
		try {
			staleAuth.setRuntimeApiKey("anthropic", "anthropic-test-key");
			using _hook = hookFetch(input => {
				const url = String(input);
				if (url === "https://models.dev/api.json") {
					return new Response(JSON.stringify({ anthropic: { models: {} } }), {
						headers: { "Content-Type": "application/json" },
					});
				}
				if (!url.endsWith("/models")) throw new Error(`Unexpected model discovery request: ${input}`);
				return new Response(JSON.stringify({ data: [{ id: currentModelId }] }), {
					headers: { "Content-Type": "application/json" },
				});
			});
			await staleRegistry.refreshProvider("anthropic", "online");

			const curatedDefault = DEFAULT_MODEL_PER_PROVIDER.anthropic;
			expect(staleRegistry.getAvailable().some(model => model.id === curatedDefault)).toBe(true);
			expect(staleRegistry.getAvailableForProfileActivation().some(model => model.id === curatedDefault)).toBe(
				false,
			);

			const settings = Settings.isolated({
				enabledModels: [`anthropic/${curatedDefault}`, `anthropic/${currentModelId}`],
			});
			const { session } = await createAgentSession({
				...buildSessionOptions(),
				authStorage: staleAuth,
				modelRegistry: staleRegistry,
				settings,
			});
			try {
				expect(session.model).toMatchObject({ provider: "anthropic", id: currentModelId });
			} finally {
				await session.dispose();
			}
		} finally {
			staleRegistry.dispose();
			staleAuth.close();
		}
	});

	test(
		"same-provider sibling registry overrides do not block startup or session pin validation",
		async () => {
			const provider = "anthropic";
			const model = getBundledModel(provider, "claude-sonnet-4-5");
			if (!model) throw new Error("Expected bundled Anthropic model");
			const modelId = model.id;
			const sharedAuth = await AuthStorage.create(path.join(tempDir, `shared-selector-${Snowflake.next()}.db`));
			const firstRegistry = new ModelRegistry(
				sharedAuth,
				path.join(tempDir, `shared-selector-a-${Snowflake.next()}.yml`),
				undefined,
				{
					automaticRefresh: false,
				},
			);
			const secondRegistry = new ModelRegistry(
				sharedAuth,
				path.join(tempDir, `shared-selector-b-${Snowflake.next()}.yml`),
				undefined,
				{
					automaticRefresh: false,
				},
			);
			let session:
				| {
						model: Model | undefined;
						setCredentialPin(provider: string, selector: { kind: "id"; value: string }): Promise<void>;
						dispose(): Promise<void>;
				  }
				| undefined;
			try {
				await sharedAuth.set(provider, [
					{
						type: "oauth",
						access: "shared-selector-access",
						refresh: "shared-selector-refresh",
						expires: Date.now() + 60 * 60_000,
						email: "shared-selector@example.test",
					},
				]);
				const row = sharedAuth.listCredentialInventory(provider)[0];
				if (!row) throw new Error("Expected shared selector OAuth row");
				const selector = { kind: "id" as const, value: String(row.id) };
				secondRegistry.registerProvider(provider, {
					baseUrl: "https://shared-selector-b.example.test",
					api: "anthropic-messages",
					apiKey: "shared-selector-second-key",
				});
				expect(await secondRegistry.getApiKeyForProvider(provider)).toBe("shared-selector-second-key");

				// Registry B's same-provider key must not make registry A's OAuth selector
				// appear unusable. This is the direct owner-scoped startup authority check.
				expect(
					await firstRegistry.getApiKeyForProvider(provider, undefined, undefined, {
						credentialSelector: selector,
					}),
				).toBe("shared-selector-access");

				const result = await createAgentSession({
					cwd: tempDir,
					agentDir: tempDir,
					sessionManager: SessionManager.inMemory(tempDir),
					modelRegistry: firstRegistry,
					modelPattern: `${provider}/${modelId}`,
					credentialSelector: { provider, selector, raw: `${provider}/id:${row.id}` },
					settings: Settings.isolated({ "compaction.enabled": false, "todo.enabled": false }),
					disableExtensionDiscovery: true,
					extensions: [],
					skills: [],
					contextFiles: [],
					promptTemplates: [],
					slashCommands: [],
					enableMCP: false,
					enableLsp: false,
					workspaceTree: { rootPath: tempDir, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
					toolNames: [],
					rules: [],
				});
				session = result.session;
				expect(session.model).toMatchObject({ provider, id: modelId });
				await session.setCredentialPin(provider, selector);

				secondRegistry.dispose();
				expect(
					await firstRegistry.getApiKeyForProvider(provider, undefined, undefined, {
						credentialSelector: selector,
					}),
				).toBe("shared-selector-access");
			} finally {
				await session?.dispose();
				firstRegistry.dispose();
				secondRegistry.dispose();
				sharedAuth.close();
			}
		},
		{ timeout: 60_000 },
	);

	test("uses an unqualified credential selector while checking fallback model availability", async () => {
		const anthropicModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!anthropicModel) throw new Error("Expected a bundled anthropic model");
		await authStorage.set("anthropic", [
			{
				type: "oauth",
				access: "selector-access",
				refresh: "selector-refresh",
				expires: Date.now() + 60_000,
				email: "selector@example.test",
			},
		]);
		const row = authStorage.exportSnapshot().credentials.find(entry => entry.provider === "anthropic");
		if (!row) throw new Error("Expected an anthropic credential row");
		const calls: Array<{ provider: string; selector: unknown }> = [];
		const getApiKeySpy = vi.spyOn(modelRegistry, "getApiKey").mockImplementation(async (model, _session, options) => {
			calls.push({ provider: model.provider, selector: options?.credentialSelector });
			return model.provider === "anthropic" && options?.credentialSelector?.kind === "id"
				? "selected-key"
				: undefined;
		});
		try {
			const { session } = await createAgentSession({
				...buildSessionOptions(),
				credentialSelector: {
					selector: { kind: "id", value: String(row.id) },
					raw: `id:${row.id}`,
				},
			});
			try {
				expect(session.model?.provider).toBe("anthropic");
				expect(calls.some(call => call.provider === "anthropic" && call.selector !== undefined)).toBe(true);
			} finally {
				await session.dispose();
			}
		} finally {
			getApiKeySpy.mockRestore();
		}
	});

	test("passes the resolved provider credential scope into the AgentSession", async () => {
		const scopeId = "provider-credential-scope";
		const { session } = await createAgentSession({
			...buildSessionOptions("runtime-provider/runtime-model"),
			providerSessionId: scopeId,
			credentialSessionId: undefined,
		});
		try {
			expect(session.credentialSessionId).toBe(scopeId);
			expect(authStorage.hasCredentialScopeLease(scopeId)).toBe(true);
		} finally {
			await session.dispose();
		}
		expect(authStorage.hasCredentialScopeLease(scopeId)).toBe(false);
	});

	test("a model resolved from another provider than the preferred credential fails closed", async () => {
		await authStorage.set("anthropic", [
			{
				type: "oauth",
				access: "token-test-primary",
				refresh: "refresh-test-primary",
				expires: Date.now() + 60 * 60_000,
				email: "primary@example.test",
			},
		]);
		const preferredRow = authStorage.exportSnapshot().credentials.find(entry => entry.provider === "anthropic");
		if (!preferredRow) throw new Error("Expected an anthropic credential row");

		await expect(
			createAgentSession({
				...buildSessionOptions("runtime-provider/runtime-model"),
				preferredCredentialSelector: {
					selector: { kind: "id", value: String(preferredRow.id) },
					raw: `id:${preferredRow.id}`,
				},
			}),
		).rejects.toThrow(/--prefer-credential id:\d+ matches anthropic, but the resolved model uses runtime-provider/);
	});

	test("persists model substitution metadata on new session model_change", async () => {
		const effectiveModel: Model = {
			id: "gpt-5.5",
			name: "GPT-5.5",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://api.openai.com/v1",
			reasoning: true,
			thinking: { minLevel: Effort.Minimal, maxLevel: Effort.XHigh, mode: "effort" },
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 8192,
		};
		const requestedModel: Model = {
			...effectiveModel,
			id: "gpt-5.3-codex",
			name: "GPT-5.3 Codex",
			contextWindow: 272000,
		};
		const sessionManager = SessionManager.inMemory(tempDir);

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			model: effectiveModel,
			thinkingLevel: Effort.High,
			modelSubstitution: { requestedModel, reason: "auth_unavailable" },
			sessionManager,
			disableExtensionDiscovery: true,
			skills: [],
			rules: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			workspaceTree: { rootPath: tempDir, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
			toolNames: [],
			enableMCP: false,
			enableLsp: false,
		});

		try {
			const modelChanges = sessionManager.getEntries().filter(entry => entry.type === "model_change");
			expect(modelChanges).toHaveLength(1);
			expect(modelChanges[0]).toMatchObject({
				type: "model_change",
				model: "openai-codex/gpt-5.5",
				previousModel: "openai-codex/gpt-5.3-codex",
				reason: "auth_unavailable",
				thinkingLevel: Effort.High,
			});
		} finally {
			await session.dispose();
		}
	});

	test("restores the configured default-chain head over legacy models.default on resume", async () => {
		const sessionManager = SessionManager.create(tempDir, path.join(tempDir, "sessions"));
		// Legacy scalar model diverges from the configured chain head.
		sessionManager.appendModelChange("runtime-provider/runtime-reasoning-model", "default");
		sessionManager.appendConfiguredModelChain({
			role: "default",
			entries: ["runtime-provider/runtime-model", "runtime-provider/runtime-reasoning-model"],
			origin: "model_selection",
			explicitHead: true,
		});
		await sessionManager.ensureOnDisk();
		await sessionManager.flush();
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected persisted session file");
		await sessionManager.close();

		authStorage.setRuntimeApiKey("runtime-provider", "test-key");
		const resumedManager = await SessionManager.open(sessionFile, tempDir);
		const { session } = await createAgentSession({
			...buildSessionOptions(""),
			modelPattern: undefined,
			sessionManager: resumedManager,
		});

		try {
			expect(session.model?.provider).toBe("runtime-provider");
			expect(session.model?.id).toBe("runtime-model");
		} finally {
			await session.dispose();
		}
	});
	test("falls back to the global default without seeding an exhausted persisted controller", async () => {
		const sessionManager = SessionManager.create(tempDir, path.join(tempDir, "sessions"));
		sessionManager.appendConfiguredModelChain({
			role: "default",
			entries: ["missing-provider/first", "missing-provider/second"],
			origin: "model_selection",
			explicitHead: true,
		});
		await sessionManager.ensureOnDisk();
		await sessionManager.flush();
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected persisted session file");
		await sessionManager.close();

		authStorage.setRuntimeApiKey("runtime-provider", "test-key");
		const settings = Settings.isolated();
		settings.setModelRole("default", "runtime-provider/runtime-model");
		const resumedManager = await SessionManager.open(sessionFile, tempDir);
		const { session } = await createAgentSession({
			...buildSessionOptions(""),
			modelPattern: undefined,
			settings,
			sessionManager: resumedManager,
		});

		try {
			expect(session.model).toMatchObject({ provider: "runtime-provider", id: "runtime-model" });
			expect(session.getConfiguredModelChain("default")).toEqual([
				"missing-provider/first",
				"missing-provider/second",
			]);
		} finally {
			await session.dispose();
		}
	});
	test("resumes a bare profile alias through preset-equivalent resolution when a startup profile is configured", async () => {
		// Slash-prefixed catalog id keeps the alias out of the exact canonical-id
		// path, so resolution must pass through the final-segment alias stage.
		modelRegistry.registerProvider("alias-provider", {
			baseUrl: "http://127.0.0.1:9/v1",
			apiKey: "ALIAS_KEY",
			api: "openai-completions",
			models: [
				{
					id: "synthetic/flare-alias",
					name: "Flare Alias",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128000,
					maxTokens: 8192,
				},
			],
		});
		authStorage.setRuntimeApiKey("alias-provider", "test-key");
		const profileName = modelRegistry.getAvailableModelProfileNames()[0];
		if (!profileName) throw new Error("Expected at least one registered model profile");

		const sessionManager = SessionManager.create(tempDir, path.join(tempDir, "sessions"));
		sessionManager.appendConfiguredModelChain({
			role: "default",
			entries: ["flare-alias"],
			origin: "profile-activation",
			identity: profileName,
			explicitHead: true,
		});
		await sessionManager.ensureOnDisk();
		await sessionManager.flush();
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected persisted session file");
		await sessionManager.close();

		const lookupAliasSpy = vi.spyOn(modelRegistry, "lookupAliasExists");
		const resolveAliasSpy = vi.spyOn(modelRegistry, "resolveModelByLookupAlias");
		const resumedManager = await SessionManager.open(sessionFile, tempDir);
		const { session } = await createAgentSession({
			...buildSessionOptions(""),
			modelPattern: undefined,
			settings: Settings.isolated({ "modelProfile.default": profileName }),
			sessionManager: resumedManager,
			providerSessionId: "provider-affinity",
		});

		try {
			expect(session.model).toMatchObject({ provider: "alias-provider", id: "synthetic/flare-alias" });
			// The persisted bare alias must be resolved through the preset-equivalent
			// alias stage (real registry), not left to exact/fuzzy matching.
			expect(lookupAliasSpy).toHaveBeenCalled();
			expect(resolveAliasSpy).toHaveBeenCalled();
			expect(session.getActiveModelProfile()).toBe(profileName);
			expect(modelRegistry.getSessionCanonicalVariant("provider-affinity")).toBe(
				"alias-provider/synthetic/flare-alias",
			);
			expect(modelRegistry.getSessionCanonicalVariant(resumedManager.getSessionId())).toBeUndefined();
		} finally {
			await session.dispose();
		}
	});

	test("keeps resume exact when no startup profile is configured", async () => {
		modelRegistry.registerProvider("alias-provider", {
			baseUrl: "http://127.0.0.1:9/v1",
			apiKey: "ALIAS_KEY",
			api: "openai-completions",
			models: [
				{
					id: "synthetic/flare-alias",
					name: "Flare Alias",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128000,
					maxTokens: 8192,
				},
			],
		});
		authStorage.setRuntimeApiKey("alias-provider", "test-key");

		const sessionManager = SessionManager.create(tempDir, path.join(tempDir, "sessions"));
		sessionManager.appendConfiguredModelChain({
			role: "default",
			entries: ["flare-alias"],
			origin: "profile-activation",
			identity: "stale-profile",
			explicitHead: true,
		});
		await sessionManager.ensureOnDisk();
		await sessionManager.flush();
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected persisted session file");
		await sessionManager.close();

		const lookupAliasSpy = vi.spyOn(modelRegistry, "lookupAliasExists");
		const resolveAliasSpy = vi.spyOn(modelRegistry, "resolveModelByLookupAlias");
		const resumedManager = await SessionManager.open(sessionFile, tempDir);
		// Direct/manual startup: no profile default, so the alias stage must not
		// be consulted and the persisted alias falls back to the exact path.
		const { session } = await createAgentSession({
			...buildSessionOptions(""),
			modelPattern: undefined,
			sessionManager: resumedManager,
		});

		try {
			expect(session.model).toMatchObject({ provider: "alias-provider", id: "synthetic/flare-alias" });
			expect(lookupAliasSpy).not.toHaveBeenCalled();
			expect(resolveAliasSpy).not.toHaveBeenCalled();
			expect(session.getActiveModelProfile()).toBeUndefined();
		} finally {
			await session.dispose();
		}
	});
});
