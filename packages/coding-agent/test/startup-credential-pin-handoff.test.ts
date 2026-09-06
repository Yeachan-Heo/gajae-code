import { describe, expect, setDefaultTimeout, test } from "bun:test";
import * as path from "node:path";
import { getBundledModel } from "@gajae-code/ai";
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
});
