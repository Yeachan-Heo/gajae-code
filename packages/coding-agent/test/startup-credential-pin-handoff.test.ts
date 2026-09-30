import { describe, expect, setDefaultTimeout, test } from "bun:test";
import * as path from "node:path";
import { getBundledModel } from "@gajae-code/ai";
import type { UsageProvider } from "@gajae-code/ai/usage";
import { hookFetch, TempDir } from "@gajae-code/utils";
import type { Args } from "../src/cli/args";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { runRootCommand } from "../src/main";
import { type CreateAgentSessionOptions, type CreateAgentSessionResult, createAgentSession } from "../src/sdk";
import type { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";
import type { StartupAuthConfigSnapshot } from "../src/session/startup-auth-config";
import { EventBus } from "../src/utils/event-bus";

setDefaultTimeout(20_000);

const testModel = getBundledModel("anthropic", "claude-sonnet-4-5");
if (!testModel) throw new Error("Expected bundled test model");

function rootArgs(): Args {
	return {
		messages: [],
		fileArgs: [],
		unknownFlags: new Map(),
		print: true,
		noSession: true,
		noSkills: true,
		noRules: true,
		noTools: true,
		noLsp: true,
	};
}

function fakeSessionResult(): CreateAgentSessionResult {
	let activeModel = testModel;
	const session = {
		sessionId: "startup-pin-handoff",
		credentialSessionId: "startup-pin-handoff",
		get model() {
			return activeModel;
		},
		extensionRunner: undefined,
		getConfiguredModelChain: () => undefined,
		setConfiguredModelChain: () => {},
		seedDefaultFallbackResolution: () => {},
		setModelTemporary: async (model: typeof testModel) => {
			activeModel = model;
		},
		dispose: async () => {},
	} as unknown as AgentSession;
	return {
		session,
		extensionsResult: {},
		setToolUIContext: () => {},
		eventBus: new EventBus(),
	} as unknown as CreateAgentSessionResult;
}

function snapshot(
	provider: string,
	pin: string,
	storeIdentity = "fixture-store",
	pinStoreIdentity = storeIdentity,
): StartupAuthConfigSnapshot {
	return {
		broker: null,
		credentialStoreIdentity: storeIdentity,
		credentialPinStoreIdentity: pinStoreIdentity,
		credentialRankingMode: "balanced",
		credentialPins: { [provider]: pin },
	};
}

interface CredentialFixture {
	root: string;
	provider: string;
	wrongKey: string;
	paidKey: string;
	wrongRowId: number;
	paidRowId: number;
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
}

async function createCredentialFixture(tempRoot: string): Promise<CredentialFixture> {
	const provider = "startup-pin-provider";
	const wrongKey = "fixture-wrong-key";
	const paidKey = "fixture-paid-key";
	const authStorage = await AuthStorage.create(path.join(tempRoot, "auth.db"));
	await authStorage.set(provider, [
		{ type: "oauth", access: wrongKey, refresh: "fixture-wrong-refresh", expires: Date.now() + 3_600_000 },
		{ type: "oauth", access: paidKey, refresh: "fixture-paid-refresh", expires: Date.now() + 3_600_000 },
	]);
	const rows = authStorage.listCredentialInventory(provider);
	const wrongRow = rows[0];
	const paidRow = rows[1];
	if (!wrongRow || !paidRow) throw new Error("Expected both fixture credential rows");
	const modelRegistry = new ModelRegistry(authStorage, path.join(tempRoot, "models.yml"));
	modelRegistry.registerProvider(provider, {
		baseUrl: "https://startup-pin.example.test/v1",
		api: "openai-completions",
		oauth: {
			name: "Startup Pin Fixture",
			login: async () => ({
				access: "fixture-login-access",
				refresh: "fixture-login-refresh",
				expires: Date.now() + 3_600_000,
			}),
			getApiKey: credentials => credentials.access,
		},
		models: [
			{
				id: "entitled-model",
				name: "Entitled Model",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128_000,
				maxTokens: 8_192,
			},
		],
	});
	return {
		root: tempRoot,
		provider,
		wrongKey,
		paidKey,
		wrongRowId: wrongRow.id,
		paidRowId: paidRow.id,
		authStorage,
		modelRegistry,
	};
}

function sessionOptions(fixture: CredentialFixture): CreateAgentSessionOptions {
	return {
		cwd: fixture.root,
		agentDir: fixture.root,
		credentialSessionId: "credential-scope",
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
		settings: Settings.isolated({ "marketplace.autoUpdate": "off" }),
		authStorage: fixture.authStorage,
		modelRegistry: fixture.modelRegistry,
		modelPattern: `${fixture.provider}/entitled-model`,
	};
}

async function disposeFixture(fixture: CredentialFixture, session?: AgentSession): Promise<void> {
	await session?.dispose();
	await fixture.modelRegistry.dispose();
	fixture.authStorage.close();
}

/** Persist a session whose default model and durable pin target `provider`, then retire the pinned row. */
async function persistStalePinnedSession(
	fixture: CredentialFixture,
	savedModel: string,
	provider = fixture.provider,
	pinnedRowId = fixture.paidRowId,
): Promise<{ sessionFile: string; credentialScope: string }> {
	const savedManager = SessionManager.create(fixture.root, path.join(fixture.root, "sessions"));
	const credentialScope = savedManager.getSessionId();
	savedManager.appendModelChange(savedModel, "default");
	savedManager.appendCustomEntry("auth-credential-pin", {
		v: 1,
		scopeId: credentialScope,
		provider,
		pin: { kind: "id", value: String(pinnedRowId) },
		credentialStoreIdentity: "fixture-store",
	});
	await savedManager.ensureOnDisk();
	await savedManager.flush();
	const sessionFile = savedManager.getSessionFile();
	if (!sessionFile) throw new Error("Expected persisted session file");
	await savedManager.close();
	expect(fixture.authStorage.disableCredentialById(pinnedRowId, "removed by test")).toBe(true);
	return { sessionFile, credentialScope };
}

/**
 * Isolated settings with a configured default. A configured default disables the
 * unconfigured first-available sweep, so a resume can only land on the saved chain
 * or this default rather than on credentials outside the fixture.
 */
function settingsWithDefault(selector: string): Settings {
	const settings = Settings.isolated({ "marketplace.autoUpdate": "off" });
	settings.setModelRole("default", selector);
	return settings;
}

/** Resume `sessionFile` with provider network access forbidden. */
async function resumeStalePinnedSession(
	fixture: CredentialFixture,
	resumed: { sessionFile: string; credentialScope: string },
	overrides: Partial<CreateAgentSessionOptions> = {},
): Promise<CreateAgentSessionResult> {
	using _blockedFetch = hookFetch(() => {
		throw new Error("Resume must not call a provider");
	});
	return await createAgentSession({
		...sessionOptions(fixture),
		modelPattern: undefined,
		credentialSessionId: resumed.credentialScope,
		sessionManager: await SessionManager.open(resumed.sessionFile, fixture.root),
		startupAuthConfig: snapshot(fixture.provider, `id:${fixture.wrongRowId}`),
		modelRegistryStartupMutation: { owner: "cli-root", onAttempt: () => {} },
		...overrides,
	});
}

describe("startup credential pin handoff", () => {
	test("hands the exact startup auth snapshot from root discovery to the CLI session", async () => {
		using tempDir = TempDir.createSync("@gjc-startup-pin-root-");
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		const startupSnapshot = snapshot("fixture-provider", "id:2");
		let discoveredSnapshot: StartupAuthConfigSnapshot | undefined;
		let sessionOptionsSeen: CreateAgentSessionOptions | undefined;

		using _blockedFetch = hookFetch(() => {
			throw new Error("Unexpected network access in startup snapshot handoff test");
		});
		try {
			await runRootCommand(rootArgs(), [], {
				resolveStartupAuthConfig: async () => startupSnapshot,
				discoverAuthStorage: async (_agentDir, resolvedSnapshot) => {
					discoveredSnapshot = resolvedSnapshot;
					return authStorage;
				},
				createAgentSession: async options => {
					sessionOptionsSeen = options;
					return fakeSessionResult();
				},
				settings: Settings.isolated({ "marketplace.autoUpdate": "off", "startup.checkUpdate": false }),
				suppressProcessExit: true,
				initTheme: async () => {},
				readPipedInput: async () => undefined,
				runStartupCredentialAutoImportIfNeeded: async () => undefined,
				runPrintMode: async () => {},
				quit: async () => {},
			});

			expect(discoveredSnapshot).toBe(startupSnapshot);
			expect(sessionOptionsSeen?.startupAuthConfig).toBe(startupSnapshot);
			expect(sessionOptionsSeen?.modelRegistryStartupMutation?.owner).toBe("cli-root");
		} finally {
			authStorage.close();
		}
	});

	test("print runs select credentials without probing provider usage (#5939)", async () => {
		using tempDir = TempDir.createSync("@gjc-print-usage-probe-");
		let probes = 0;
		const probe: UsageProvider = {
			id: "anthropic",
			fetchUsage: async () => {
				probes += 1;
				return null; // the endpoint answered 429
			},
		};
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"), {
			usageProviderResolver: provider => (provider === "anthropic" ? probe : undefined),
		});
		const expires = Date.now() + 3_600_000;
		await authStorage.set("anthropic", [
			{ type: "oauth", access: "print-a", refresh: "refresh-a", expires, email: "a@example.test" },
			{ type: "oauth", access: "print-b", refresh: "refresh-b", expires, email: "b@example.test" },
		]);
		using _blockedFetch = hookFetch(() => new Response("offline", { status: 503 }));
		try {
			await runRootCommand(rootArgs(), [], {
				discoverAuthStorage: async () => authStorage,
				createAgentSession: async () => fakeSessionResult(),
				settings: Settings.isolated({ "marketplace.autoUpdate": "off", "startup.checkUpdate": false }),
				suppressProcessExit: true,
				initTheme: async () => {},
				readPipedInput: async () => undefined,
				runStartupCredentialAutoImportIfNeeded: async () => undefined,
				runPrintMode: async () => {
					// Model dispatch resolves a key through credential ranking.
					expect(await authStorage.getApiKey("anthropic", "print-session")).toMatch(/^print-/);
				},
				quit: async () => {},
			});
			expect(probes).toBe(0);
		} finally {
			authStorage.close();
		}
	});

	test("CLI-owned injected sessions apply a persistent paid pin before model selection", async () => {
		using tempDir = TempDir.createSync("@gjc-startup-pin-cli-");
		const fixture = await createCredentialFixture(tempDir.path());
		let session: AgentSession | undefined;
		using _blockedFetch = hookFetch(() => {
			throw new Error("Unexpected network access in CLI pin test");
		});
		try {
			const result = await createAgentSession({
				...sessionOptions(fixture),
				startupAuthConfig: snapshot(fixture.provider, `id:${fixture.paidRowId}`),
				modelRegistryStartupMutation: { owner: "cli-root", onAttempt: () => {} },
			});
			session = result.session;

			expect(session.model?.id).toBe("entitled-model");
			expect(
				await fixture.authStorage.peekApiKey(fixture.provider, {
					sessionId: session.credentialSessionId,
					owner: fixture.modelRegistry.getAuthStorageOwner(),
				}),
			).toBe(fixture.paidKey);
		} finally {
			await disposeFixture(fixture, session);
		}
	});

	test("generic injected SDK sessions ignore an explicit persistent pin snapshot", async () => {
		using tempDir = TempDir.createSync("@gjc-startup-pin-sdk-");
		const fixture = await createCredentialFixture(tempDir.path());
		let session: AgentSession | undefined;
		using _blockedFetch = hookFetch(() => {
			throw new Error("Unexpected network access in SDK isolation test");
		});
		try {
			const result = await createAgentSession({
				...sessionOptions(fixture),
				startupAuthConfig: snapshot(fixture.provider, `id:${fixture.paidRowId}`),
			});
			session = result.session;

			expect(
				await fixture.authStorage.peekApiKey(fixture.provider, {
					sessionId: session.credentialSessionId,
					owner: fixture.modelRegistry.getAuthStorageOwner(),
				}),
			).toBe(fixture.wrongKey);
		} finally {
			await disposeFixture(fixture, session);
		}
	});

	test("CLI-owned sessions skip numeric pins from a different credential store", async () => {
		using tempDir = TempDir.createSync("@gjc-startup-pin-store-");
		const fixture = await createCredentialFixture(tempDir.path());
		let session: AgentSession | undefined;
		using _blockedFetch = hookFetch(() => {
			throw new Error("Unexpected network access in store identity test");
		});
		try {
			const result = await createAgentSession({
				...sessionOptions(fixture),
				startupAuthConfig: snapshot(fixture.provider, `id:${fixture.paidRowId}`, "current-store", "previous-store"),
				modelRegistryStartupMutation: { owner: "cli-root", onAttempt: () => {} },
			});
			session = result.session;

			expect(
				await fixture.authStorage.peekApiKey(fixture.provider, {
					sessionId: session.credentialSessionId,
					owner: fixture.modelRegistry.getAuthStorageOwner(),
				}),
			).toBe(fixture.wrongKey);
		} finally {
			await disposeFixture(fixture, session);
		}
	});

	test("resumed durable AUTO and pin choices override the global paid pin", async () => {
		for (const resumedChoice of ["auto", "pin"] as const) {
			using tempDir = TempDir.createSync(`@gjc-startup-pin-resume-${resumedChoice}-`);
			const fixture = await createCredentialFixture(tempDir.path());
			const sessionManager = SessionManager.inMemory(fixture.root);
			sessionManager.appendCustomEntry("auth-credential-pin", {
				v: 1,
				scopeId: "credential-scope",
				provider: fixture.provider,
				pin: resumedChoice === "auto" ? { auto: true } : { kind: "id", value: String(fixture.wrongRowId) },
				credentialStoreIdentity: "fixture-store",
			});
			let session: AgentSession | undefined;
			using _blockedFetch = hookFetch(() => {
				throw new Error("Unexpected network access in resumed pin precedence test");
			});
			try {
				const result = await createAgentSession({
					...sessionOptions(fixture),
					sessionManager,
					startupAuthConfig: snapshot(fixture.provider, `id:${fixture.paidRowId}`),
					modelRegistryStartupMutation: { owner: "cli-root", onAttempt: () => {} },
				});
				session = result.session;

				expect(
					await fixture.authStorage.peekApiKey(fixture.provider, {
						sessionId: session.credentialSessionId,
						owner: fixture.modelRegistry.getAuthStorageOwner(),
					}),
					resumedChoice,
				).toBe(fixture.wrongKey);
			} finally {
				await disposeFixture(fixture, session);
			}
		}
	});

	test("a stale durable pin remains unavailable instead of using an alternate account", async () => {
		using tempDir = TempDir.createSync("@gjc-startup-pin-stale-");
		const fixture = await createCredentialFixture(tempDir.path());
		const sessionManager = SessionManager.inMemory(fixture.root);
		sessionManager.appendCustomEntry("auth-credential-pin", {
			v: 1,
			scopeId: "credential-scope",
			provider: fixture.provider,
			pin: { kind: "id", value: String(fixture.paidRowId) },
			credentialStoreIdentity: "fixture-store",
		});
		expect(fixture.authStorage.disableCredentialById(fixture.paidRowId, "revoked by test")).toBe(true);
		let session: AgentSession | undefined;
		const requests: string[] = [];
		using _fetch = hookFetch((_input, init) => {
			const bearer = new Headers(init?.headers).get("Authorization");
			if (bearer) requests.push(bearer);
			return Response.json({ data: [] });
		});
		try {
			const result = await createAgentSession({
				...sessionOptions(fixture),
				sessionManager,
				startupAuthConfig: snapshot(fixture.provider, `id:${fixture.paidRowId}`),
				modelRegistryStartupMutation: { owner: "cli-root", onAttempt: () => {} },
			});
			session = result.session;
			expect(
				await fixture.authStorage.peekApiKey(fixture.provider, {
					sessionId: session.credentialSessionId,
					owner: fixture.modelRegistry.getAuthStorageOwner(),
				}),
			).toBeUndefined();
			expect(requests).not.toContain(`Bearer ${fixture.wrongKey}`);
			expect(fixture.authStorage.hasSessionCredentialUnavailable(fixture.provider, "credential-scope")).toBe(true);
		} finally {
			await disposeFixture(fixture, session);
		}
	});

	test("resumes a saved model with a removed pin without selecting the settings default on that provider", async () => {
		using tempDir = TempDir.createSync("@gjc-startup-pin-saved-resume-");
		const fixture = await createCredentialFixture(tempDir.path());
		const savedManager = SessionManager.create(fixture.root, path.join(fixture.root, "sessions"));
		const credentialScope = savedManager.getSessionId();
		savedManager.appendModelChange(`${fixture.provider}/entitled-model`, "default");
		savedManager.appendCustomEntry("auth-credential-pin", {
			v: 1,
			scopeId: credentialScope,
			provider: fixture.provider,
			pin: { kind: "id", value: String(fixture.paidRowId) },
			credentialStoreIdentity: "fixture-store",
		});
		await savedManager.ensureOnDisk();
		await savedManager.flush();
		const sessionFile = savedManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected persisted session file");
		await savedManager.close();
		expect(fixture.authStorage.disableCredentialById(fixture.paidRowId, "removed by test")).toBe(true);

		const settings = Settings.isolated({ "marketplace.autoUpdate": "off" });
		settings.setModelRole("default", `${fixture.provider}/entitled-model`);
		let session: AgentSession | undefined;
		using _blockedFetch = hookFetch(() => {
			throw new Error("Resume must not call a provider with another credential");
		});
		try {
			const resumedManager = await SessionManager.open(sessionFile, fixture.root);
			const result = await createAgentSession({
				...sessionOptions(fixture),
				modelPattern: undefined,
				credentialSessionId: credentialScope,
				settings,
				sessionManager: resumedManager,
				startupAuthConfig: snapshot(fixture.provider, `id:${fixture.wrongRowId}`),
				modelRegistryStartupMutation: { owner: "cli-root", onAttempt: () => {} },
			});
			session = result.session;
			expect(session.model).toBeUndefined();
			expect(result.modelFallbackMessage).toContain("Re-pin a credential or select AUTO explicitly");
			expect(fixture.authStorage.hasSessionCredentialUnavailable(fixture.provider, credentialScope)).toBe(true);
			expect(
				await fixture.authStorage.peekApiKey(fixture.provider, {
					sessionId: credentialScope,
					owner: fixture.modelRegistry.getAuthStorageOwner(),
				}),
			).toBeUndefined();
		} finally {
			await disposeFixture(fixture, session);
		}
	});

	test("an explicit credential selector overrides the global paid pin", async () => {
		using tempDir = TempDir.createSync("@gjc-startup-pin-explicit-");
		const fixture = await createCredentialFixture(tempDir.path());
		let session: AgentSession | undefined;
		using _blockedFetch = hookFetch(() => {
			throw new Error("Unexpected network access in explicit pin precedence test");
		});
		try {
			const result = await createAgentSession({
				...sessionOptions(fixture),
				credentialSelector: {
					provider: fixture.provider,
					selector: { kind: "id", value: String(fixture.wrongRowId) },
					raw: `${fixture.provider}/id:${fixture.wrongRowId}`,
				},
				startupAuthConfig: snapshot(fixture.provider, `id:${fixture.paidRowId}`),
				modelRegistryStartupMutation: { owner: "cli-root", onAttempt: () => {} },
			});
			session = result.session;

			expect(
				await fixture.authStorage.peekApiKey(fixture.provider, {
					sessionId: session.credentialSessionId,
					owner: fixture.modelRegistry.getAuthStorageOwner(),
				}),
			).toBe(fixture.wrongKey);
		} finally {
			await disposeFixture(fixture, session);
		}
	});

	describe("explicit provider keys outrank an unavailable resumed pin", () => {
		const runtimeKey = "fixture-runtime-key";
		const configKey = "fixture-config-key";

		for (const source of ["runtime", "registry config"] as const) {
			test(`restores the saved model with a ${source} key instead of reporting the pin unavailable`, async () => {
				using tempDir = TempDir.createSync("@gjc-startup-pin-explicit-restore-");
				const fixture = await createCredentialFixture(tempDir.path());
				const resumed = await persistStalePinnedSession(fixture, `${fixture.provider}/entitled-model`);
				const explicitKey = source === "runtime" ? runtimeKey : configKey;
				if (source === "runtime") fixture.authStorage.setRuntimeApiKey(fixture.provider, runtimeKey);
				else
					fixture.authStorage.setConfigApiKey(fixture.provider, configKey, {
						owner: fixture.modelRegistry.getAuthStorageOwner(),
					});
				let session: AgentSession | undefined;
				try {
					const result = await resumeStalePinnedSession(fixture, resumed, {
						settings: settingsWithDefault(`${fixture.provider}/missing-model`),
					});
					session = result.session;
					expect(`${session.model?.provider}/${session.model?.id}`).toBe(`${fixture.provider}/entitled-model`);
					// Only the unresolvable settings default may be reported. This proves the
					// pre-extension restore selected the model: the post-extension retry would
					// also restore it but clears this message, so keep the exact match.
					expect(result.modelFallbackMessage).toBe(`Model ${fixture.provider}/missing-model not found`);
					expect(
						fixture.authStorage.hasSessionCredentialUnavailable(fixture.provider, resumed.credentialScope),
					).toBe(true);
					expect(await fixture.modelRegistry.getApiKeyForProvider(fixture.provider, resumed.credentialScope)).toBe(
						explicitKey,
					);
				} finally {
					await disposeFixture(fixture, session);
				}
			});
		}

		test("a config key registered by another registry does not unblock the unavailable pin", async () => {
			using tempDir = TempDir.createSync("@gjc-startup-pin-foreign-config-");
			const fixture = await createCredentialFixture(tempDir.path());
			const resumed = await persistStalePinnedSession(fixture, `${fixture.provider}/entitled-model`);
			fixture.authStorage.setConfigApiKey(fixture.provider, configKey, { owner: {} });
			let session: AgentSession | undefined;
			try {
				const result = await resumeStalePinnedSession(fixture, resumed, {
					settings: settingsWithDefault(`${fixture.provider}/missing-model`),
				});
				session = result.session;
				expect(session.model).toBeUndefined();
				expect(result.modelFallbackMessage).toContain("Re-pin a credential or select AUTO explicitly");
				expect(
					await fixture.authStorage.peekApiKey(fixture.provider, {
						sessionId: resumed.credentialScope,
						owner: fixture.modelRegistry.getAuthStorageOwner(),
					}),
				).toBeUndefined();
			} finally {
				await disposeFixture(fixture, session);
			}
		});

		test("an apiKeyEnv config key does not unblock the pin onto another stored api_key account", async () => {
			using tempDir = TempDir.createSync("@gjc-startup-pin-env-config-");
			const fixture = await createCredentialFixture(tempDir.path());
			const alternateKey = "fixture-alternate-api-key";
			fixture.authStorage.upsertCredential(fixture.provider, { type: "api_key", key: alternateKey });
			const resumed = await persistStalePinnedSession(fixture, `${fixture.provider}/entitled-model`);
			fixture.authStorage.setConfigApiKey(fixture.provider, "fixture-env-config-key", {
				envSourced: true,
				owner: fixture.modelRegistry.getAuthStorageOwner(),
			});
			// getApiKey prefers the stored api_key account over an apiKeyEnv override,
			// so treating this override as explicit would retarget the unavailable pin.
			expect(await fixture.modelRegistry.getApiKeyForProvider(fixture.provider, resumed.credentialScope)).toBe(
				alternateKey,
			);
			let session: AgentSession | undefined;
			try {
				const result = await resumeStalePinnedSession(fixture, resumed, {
					settings: settingsWithDefault(`${fixture.provider}/entitled-model`),
				});
				session = result.session;
				expect(session.model).toBeUndefined();
				expect(result.modelFallbackMessage).toContain("Re-pin a credential or select AUTO explicitly");
			} finally {
				await disposeFixture(fixture, session);
			}
		});

		test("falls back to the settings default on the pinned provider when a runtime key exists", async () => {
			using tempDir = TempDir.createSync("@gjc-startup-pin-explicit-settings-");
			const fixture = await createCredentialFixture(tempDir.path());
			const resumed = await persistStalePinnedSession(fixture, `${fixture.provider}/retired-model`);
			fixture.authStorage.setRuntimeApiKey(fixture.provider, runtimeKey);
			let session: AgentSession | undefined;
			try {
				const result = await resumeStalePinnedSession(fixture, resumed, {
					settings: settingsWithDefault(`${fixture.provider}/entitled-model`),
				});
				session = result.session;
				expect(`${session.model?.provider}/${session.model?.id}`).toBe(`${fixture.provider}/entitled-model`);
			} finally {
				await disposeFixture(fixture, session);
			}
		});

		for (const withRuntimeKey of [true, false]) {
			test(`post-extension retry ${withRuntimeKey ? "restores" : "keeps blocked"} an extension-registered saved model ${withRuntimeKey ? "with" : "without"} a runtime key`, async () => {
				using tempDir = TempDir.createSync("@gjc-startup-pin-explicit-late-");
				const fixture = await createCredentialFixture(tempDir.path());
				const lateProvider = "late-pin-provider";
				await fixture.authStorage.set(lateProvider, [
					{ type: "oauth", access: "late-wrong", refresh: "late-wrong-r", expires: Date.now() + 3_600_000 },
					{ type: "oauth", access: "late-paid", refresh: "late-paid-r", expires: Date.now() + 3_600_000 },
				]);
				const latePaidRow = fixture.authStorage.listCredentialInventory(lateProvider)[1];
				if (!latePaidRow) throw new Error("Expected late provider credential rows");
				const resumed = await persistStalePinnedSession(
					fixture,
					`${lateProvider}/late-model`,
					lateProvider,
					latePaidRow.id,
				);
				if (withRuntimeKey) fixture.authStorage.setRuntimeApiKey(lateProvider, runtimeKey);
				let session: AgentSession | undefined;
				try {
					// The unresolvable default leaves the post-extension retry as the only restore path.
					const result = await resumeStalePinnedSession(fixture, resumed, {
						settings: settingsWithDefault(`${fixture.provider}/missing-model`),
						extensions: [
							pi => {
								pi.registerProvider(lateProvider, {
									baseUrl: "https://late-pin.example.test/v1",
									api: "openai-completions",
									oauth: {
										name: "Late Pin Fixture",
										login: async () => ({
											access: "late-login",
											refresh: "late-login-r",
											expires: Date.now() + 3_600_000,
										}),
										getApiKey: credentials => credentials.access,
									},
									models: [
										{
											id: "late-model",
											name: "Late Model",
											reasoning: false,
											input: ["text"],
											cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
											contextWindow: 128_000,
											maxTokens: 8_192,
										},
									],
								});
							},
						],
					});
					session = result.session;
					if (withRuntimeKey) {
						expect(`${session.model?.provider}/${session.model?.id}`).toBe(`${lateProvider}/late-model`);
						expect(result.modelFallbackMessage).toBeUndefined();
					} else {
						expect(session.model).toBeUndefined();
						expect(result.modelFallbackMessage).toContain(`Could not restore model ${lateProvider}/late-model`);
						expect(
							await fixture.authStorage.peekApiKey(lateProvider, {
								sessionId: resumed.credentialScope,
								owner: fixture.modelRegistry.getAuthStorageOwner(),
							}),
						).toBeUndefined();
					}
				} finally {
					await disposeFixture(fixture, session);
				}
			});
		}
	});
});
