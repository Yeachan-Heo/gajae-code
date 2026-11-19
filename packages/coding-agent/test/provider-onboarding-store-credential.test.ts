import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, logger, setAgentDir } from "@gajae-code/utils";
import { YAML } from "bun";
import { ConfigError } from "../src/config/config-file";
import { ModelRegistry, ModelsConfigFile } from "../src/config/model-registry";
import { resolveConfigValue } from "../src/config/resolve-config-value";
import { resetSettingsForTest } from "../src/config/settings";
import { AuthStorage, SqliteAuthCredentialStore } from "../src/session/auth-storage";
import {
	addApiCompatibleProvider,
	assertProviderConfigLoaded,
	formatProviderSetupResult,
} from "../src/setup/provider-onboarding";

const originalAgentDir = getAgentDir();
let tempRoot: string | undefined;
let modelsPath: string;
let store: SqliteAuthCredentialStore | undefined;
let authStorage: AuthStorage | undefined;

beforeEach(async () => {
	resetSettingsForTest();
	tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-store-credential-"));
	// A dedicated agent dir keeps the credential store (and the literal keys
	// these tests publish to it) out of the developer's real ~/.gjc.
	setAgentDir(path.join(tempRoot, "agent"));
	modelsPath = path.join(tempRoot, "models.yml");
	store = await SqliteAuthCredentialStore.open(path.join(tempRoot, "agent", "agent.db"));
	authStorage = new AuthStorage(store);
});

afterEach(async () => {
	store?.close();
	store = undefined;
	authStorage = undefined;
	setAgentDir(originalAgentDir);
	resetSettingsForTest();
	if (tempRoot) {
		await fs.rm(tempRoot, { recursive: true, force: true });
		tempRoot = undefined;
	}
});

interface WrittenProvider {
	baseUrl?: string;
	api?: string;
	auth?: string;
	credential?: string;
	apiKey?: string;
	apiKeyEnv?: string;
	models?: Array<{ id: string }>;
}

async function readWrittenProvider(providerId: string): Promise<WrittenProvider> {
	const parsed = YAML.parse(await Bun.file(modelsPath).text()) as {
		providers: Record<string, WrittenProvider>;
	};
	return parsed.providers[providerId]!;
}

function countStoreDeclarationWarnings(warn: { mock: { calls: unknown[][] } }): number {
	return warn.mock.calls.filter(call =>
		String(call[0]).includes("credential: store but no stored API-key credential exists for it"),
	).length;
}

describe("custom provider store-backed credentials", () => {
	it("writes credential: store for a pasted literal key and leaves the secret out of models.yml", async () => {
		const result = await addApiCompatibleProvider({
			compatibility: "openai",
			providerId: "store-provider",
			baseUrl: "https://api.example.com/v1",
			apiKey: "sk-store-literal",
			models: ["store-model"],
			modelsPath,
			authStorage,
		});

		expect(result.credentialSource).toBe("literal");
		const text = await Bun.file(modelsPath).text();
		expect(text).not.toContain("sk-store-literal");
		const provider = await readWrittenProvider("store-provider");
		expect(provider.credential).toBe("store");
		expect(provider.apiKey).toBeUndefined();
		expect(provider.apiKeyEnv).toBeUndefined();

		// The written file must load through the same loader the runtime uses.
		const loaded = ModelsConfigFile.relocate(modelsPath).tryLoad();
		expect(loaded.status).toBe("ok");
		if (loaded.status !== "ok") throw new Error("expected loaded config");
		expect(loaded.value.providers?.["store-provider"]?.models?.map(model => model.id)).toEqual(["store-model"]);
	});

	it("resolves the stored key at runtime with no apiKey/apiKeyEnv in the config and no environment variable", async () => {
		await addApiCompatibleProvider({
			compatibility: "openai",
			providerId: "store-provider",
			baseUrl: "https://api.example.com/v1",
			apiKey: "sk-store-literal",
			models: ["store-model"],
			modelsPath,
			authStorage,
		});

		const registry = new ModelRegistry(authStorage!, modelsPath);
		await registry.refresh("offline");

		expect(registry.getError()).toBeUndefined();
		const model = registry.find("store-provider", "store-model");
		expect(model).toBeDefined();
		expect(registry.hasUsableAuthForProvider("store-provider")).toBe(true);
		expect(await registry.getApiKeyForProvider("store-provider")).toBe("sk-store-literal");
		expect(await registry.getApiKey(model!)).toBe("sk-store-literal");
	});

	it("leaves the env-backed provider unchanged", async () => {
		await addApiCompatibleProvider({
			compatibility: "openai",
			providerId: "env-provider",
			baseUrl: "https://api.example.com/v1",
			apiKeyEnv: "STORE_CREDENTIAL_TEST_KEY",
			models: ["env-model"],
			modelsPath,
			authStorage,
		});

		const provider = await readWrittenProvider("env-provider");
		expect(provider.apiKeyEnv).toBe("STORE_CREDENTIAL_TEST_KEY");
		expect(provider.credential).toBeUndefined();
	});

	it("rejects credential: store combined with every other credential declaration", async () => {
		const build = (lines: string[]): string =>
			[
				"providers:",
				"  ambiguous:",
				"    baseUrl: https://example.invalid/v1",
				"    credential: store",
				...lines,
				"    models:",
				"      - id: example",
				"",
			].join("\n");
		const cases: Array<{ lines: string[]; message: string }> = [
			{
				lines: ["    api: openai-completions", "    apiKey: literal-key"],
				message: '"credential: store" cannot be combined with "apiKey"',
			},
			{
				lines: ["    api: openai-completions", "    apiKeyEnv: AMBIGUOUS_KEY"],
				message: '"credential: store" cannot be combined with "apiKeyEnv"',
			},
			{
				lines: ["    api: openai-completions", "    auth: oauth"],
				message: '"credential: store" cannot be combined with "auth: oauth"',
			},
			{
				lines: ["    api: openai-completions", "    auth: none"],
				message: '"credential: store" requires authentication and cannot be combined with "auth: none"',
			},
			{
				lines: [
					"    api: openai-completions",
					"    openaiCompat:",
					"      baseUrl: http://127.0.0.1:4000",
					"      apiKey: local-key",
				],
				message: '"credential: store" cannot be combined with "openaiCompat.apiKey"',
			},
			{
				lines: [
					"    api: openai-completions",
					"    openaiCompat:",
					"      baseUrl: http://127.0.0.1:4000",
					"      apiKeyEnv: LOCAL_KEY",
				],
				message: '"credential: store" cannot be combined with "openaiCompat.apiKeyEnv"',
			},
			{
				lines: ["    api: openai-completions", "    openaiCompat:", "      baseUrl: http://127.0.0.1:4000"],
				message: '"credential: store" cannot be combined with "openaiCompat"',
			},
			{
				lines: ["    api: bedrock-converse-stream"],
				message: '"credential: store" is not supported with "api: bedrock-converse-stream"',
			},
		];

		for (const { lines, message } of cases) {
			await Bun.write(modelsPath, build(lines));
			const loaded = ModelsConfigFile.relocate(modelsPath).tryLoad();
			expect(loaded.status).toBe("error");
			if (loaded.status !== "error") throw new Error("expected load error");
			expect(String(loaded.error)).toContain(message);
		}
	});

	it("rejects credential: store with a model-level Bedrock api", async () => {
		await Bun.write(
			modelsPath,
			[
				"providers:",
				"  model-bedrock:",
				"    baseUrl: https://example.invalid/v1",
				"    credential: store",
				"    models:",
				"      - id: example",
				"        api: bedrock-converse-stream",
				"",
			].join("\n"),
		);
		const loaded = ModelsConfigFile.relocate(modelsPath).tryLoad();
		expect(loaded.status).toBe("error");
		if (loaded.status !== "error") throw new Error("expected load error");
		expect(String(loaded.error)).toContain(
			'"credential: store" is not supported with "api: bedrock-converse-stream" at provider or model level',
		);
	});

	it("still rejects a provider with no credential source at all", async () => {
		await Bun.write(
			modelsPath,
			[
				"providers:",
				"  missing:",
				"    baseUrl: https://example.invalid/v1",
				"    api: openai-completions",
				"    auth: apiKey",
				"    models:",
				"      - id: example",
				"",
			].join("\n"),
		);
		const loaded = ModelsConfigFile.relocate(modelsPath).tryLoad();
		expect(loaded.status).toBe("error");
		if (loaded.status !== "error") throw new Error("expected load error");
		expect(String(loaded.error)).toContain("custom models need a credential source");
		expect(String(loaded.error)).toContain("credential: store");
		expect(String(loaded.error)).toContain("stored by an earlier provider setup");
	});

	it("accepts an override-only provider that only declares credential: store", async () => {
		await Bun.write(modelsPath, ["providers:", "  override-store:", "    credential: store", ""].join("\n"));
		const loaded = ModelsConfigFile.relocate(modelsPath).tryLoad();
		expect(loaded.status).toBe("ok");
		if (loaded.status !== "ok") throw new Error("expected loaded config");
		expect(loaded.value.providers?.["override-store"]?.credential).toBe("store");

		// The override-only rejection still fires for an empty provider, and now
		// names the declaration it accepts.
		await Bun.write(modelsPath, ["providers:", "  empty-provider:", "    api: openai-completions", ""].join("\n"));
		const rejected = ModelsConfigFile.relocate(modelsPath).tryLoad();
		expect(rejected.status).toBe("error");
		if (rejected.status !== "error") throw new Error("expected load error");
		expect(String(rejected.error)).toContain('"credential: store"');
	});

	it("falls back to the stored key when apiKeyEnv points at an unset variable", async () => {
		const envName = "GJC_STORE_CREDENTIAL_TEST_UNSET_ENV";
		expect(Bun.env[envName]).toBeUndefined();
		await authStorage!.set("env-pointer-provider", [{ type: "api_key", key: "sk-stored-over-env" }]);
		await Bun.write(
			modelsPath,
			[
				"providers:",
				"  env-pointer-provider:",
				"    baseUrl: https://api.example.com/v1",
				"    api: openai-completions",
				`    apiKeyEnv: ${envName}`,
				"    models:",
				"      - id: stored-model",
				"",
			].join("\n"),
		);

		const registry = new ModelRegistry(authStorage!, modelsPath);
		await registry.refresh("offline");

		expect(registry.getError()).toBeUndefined();
		expect(await registry.getApiKeyForProvider("env-pointer-provider")).toBe("sk-stored-over-env");
	});

	it("loads a declared store credential with no stored key but resolves no credential", async () => {
		await Bun.write(
			modelsPath,
			[
				"providers:",
				"  declared-empty:",
				"    baseUrl: https://api.example.com/v1",
				"    api: openai-completions",
				"    credential: store",
				"    models:",
				"      - id: declared-model",
				"",
			].join("\n"),
		);

		const loaded = ModelsConfigFile.relocate(modelsPath).tryLoad();
		expect(loaded.status).toBe("ok");

		const warn = spyOn(logger, "warn").mockImplementation(() => {});
		try {
			const registry = new ModelRegistry(authStorage!, modelsPath);
			await registry.refresh("offline");
			expect(registry.getError()).toBeUndefined();
			const model = registry.find("declared-empty", "declared-model");
			expect(model).toBeDefined();
			// The claim is not verified at load time, but the provider must never be
			// treated as authenticated, so nothing is sent without a credential.
			expect(registry.hasUsableAuthForProvider("declared-empty")).toBe(false);
			expect(await registry.getApiKeyForProvider("declared-empty")).toBeUndefined();
			expect(await registry.getApiKey(model!)).toBeUndefined();
			expect(registry.getAvailable().some(entry => entry.provider === "declared-empty")).toBe(false);

			// The broken declaration is diagnosable at load time, and deduped across
			// reloads of the same registry.
			await registry.refresh("offline");
			const declarationWarnings = warn.mock.calls.filter(call =>
				String(call[0]).includes("credential: store but no stored API-key credential exists for it"),
			);
			expect(declarationWarnings).toHaveLength(1);
			expect(declarationWarnings[0]?.[1]).toEqual({ provider: "declared-empty" });
		} finally {
			warn.mockRestore();
		}
	});

	it("warns from stored API-key rows only, not any other configured auth", async () => {
		await Bun.write(
			modelsPath,
			[
				"providers:",
				"  declared-runtime:",
				"    baseUrl: https://api.example.com/v1",
				"    api: openai-completions",
				"    credential: store",
				"    models:",
				"      - id: declared-model",
				"",
			].join("\n"),
		);
		// A runtime override satisfies hasAuth() but is not the stored api_key row
		// the declaration promises, so the warning must still be emitted.
		authStorage!.setRuntimeApiKey("declared-runtime", "sk-runtime-only");

		const warn = spyOn(logger, "warn").mockImplementation(() => {});
		try {
			const registry = new ModelRegistry(authStorage!, modelsPath);
			await registry.refresh("offline");
			const declarationWarnings = warn.mock.calls.filter(call =>
				String(call[0]).includes("credential: store but no stored API-key credential exists for it"),
			);
			expect(declarationWarnings).toHaveLength(1);
			expect(declarationWarnings[0]?.[1]).toEqual({ provider: "declared-runtime" });
		} finally {
			warn.mockRestore();
		}
	});

	it("defers the missing-store-credential warning until a staged reload publishes", async () => {
		const registry = new ModelRegistry(authStorage!, modelsPath);
		await registry.refresh("offline");
		const stagedConfig = [
			"providers:",
			"  staged-store:",
			"    baseUrl: https://api.example.com/v1",
			"    api: openai-completions",
			"    credential: store",
			"    models:",
			"      - id: staged-model",
			"",
		].join("\n");
		const countDeclarations = (spy: { mock: { calls: unknown[][] } }): number =>
			spy.mock.calls.filter(call =>
				String(call[0]).includes("credential: store but no stored API-key credential exists for it"),
			).length;

		const warn = spyOn(logger, "warn").mockImplementation(() => {});
		try {
			// Validating a candidate that never publishes must not warn.
			const discarded = await registry.stageModelsConfigReload({
				path: modelsPath,
				text: stagedConfig,
				identity: "staged-store-discarded",
			});
			expect(discarded.valid).toBe(true);
			expect(countDeclarations(warn)).toBe(0);
			discarded.rollback();
			expect(countDeclarations(warn)).toBe(0);

			// The published candidate emits the warning exactly once.
			const published = await registry.stageModelsConfigReload({
				path: modelsPath,
				text: stagedConfig,
				identity: "staged-store-published",
			});
			expect(published.valid).toBe(true);
			expect(countDeclarations(warn)).toBe(0);
			published.commit();
			// A commit alone is not durable yet: the warning waits for finalize.
			expect(countDeclarations(warn)).toBe(0);
			published.finalize();
			expect(countDeclarations(warn)).toBe(1);
		} finally {
			warn.mockRestore();
		}
	});

	it("emits no declaration warning for a rolled-back staged publish", async () => {
		const registry = new ModelRegistry(authStorage!, modelsPath);
		await registry.refresh("offline");
		const stagedConfig = [
			"providers:",
			"  staged-rollback-store:",
			"    baseUrl: https://api.example.com/v1",
			"    api: openai-completions",
			"    credential: store",
			"    models:",
			"      - id: staged-model",
			"",
		].join("\n");
		const warn = spyOn(logger, "warn").mockImplementation(() => {});
		try {
			const first = await registry.stageModelsConfigReload({
				path: modelsPath,
				text: stagedConfig,
				identity: "committed-rollback-first",
			});
			expect(first.valid).toBe(true);
			first.commit();
			// The publish is undone before it becomes durable, so no log line may
			// survive for the config that is no longer in effect.
			expect(countStoreDeclarationWarnings(warn)).toBe(0);
			first.rollback();
			expect(countStoreDeclarationWarnings(warn)).toBe(0);

			// The rollback left no mark behind: the next durable publish warns again.
			const second = await registry.stageModelsConfigReload({
				path: modelsPath,
				text: stagedConfig,
				identity: "committed-rollback-second",
			});
			expect(second.valid).toBe(true);
			second.commit();
			expect(countStoreDeclarationWarnings(warn)).toBe(0);
			second.finalize();
			expect(countStoreDeclarationWarnings(warn)).toBe(1);
		} finally {
			warn.mockRestore();
		}
	});

	it("force-replaces an env-backed provider with a store-backed one", async () => {
		await addApiCompatibleProvider({
			compatibility: "openai",
			providerId: "replace-provider",
			baseUrl: "https://api.example.com/v1",
			apiKeyEnv: "REPLACE_PROVIDER_KEY",
			models: ["old-model"],
			modelsPath,
			authStorage,
		});

		const result = await addApiCompatibleProvider({
			compatibility: "openai",
			providerId: "replace-provider",
			baseUrl: "https://api.example.com/v1",
			apiKey: "sk-replacement-secret",
			models: ["new-model"],
			modelsPath,
			force: true,
			authStorage,
		});

		expect(result.credentialSource).toBe("literal");
		const provider = await readWrittenProvider("replace-provider");
		expect(provider.credential).toBe("store");
		expect(provider.apiKeyEnv).toBeUndefined();
		expect(provider.models?.map(model => model.id)).toEqual(["new-model"]);

		const registry = new ModelRegistry(authStorage!, modelsPath);
		await registry.refresh("offline");
		expect(await registry.getApiKeyForProvider("replace-provider")).toBe("sk-replacement-secret");
	});

	it("discloses a shadowing stored key on a non-forced env add", async () => {
		const envName = "GJC_NEW_ENV_SHADOWED_KEY";
		const previousEnv = Bun.env[envName];
		Bun.env[envName] = "sk-new-env-value";
		try {
			await authStorage!.set("shadow-new", { type: "api_key", key: "sk-stale-login-key" });

			const result = await addApiCompatibleProvider({
				compatibility: "openai",
				providerId: "shadow-new",
				baseUrl: "https://api.example.com/v1",
				apiKeyEnv: envName,
				models: ["shadow-model"],
				modelsPath,
				authStorage,
			});

			expect(result.storedCredentialShadow).toEqual({ storedApiKeys: 1, envName });
			const banner = formatProviderSetupResult(result);
			expect(banner).toContain("take precedence over");
			expect(banner).toContain(`gjc accounts logout shadow-new --all`);
			expect(banner).toContain("removes every stored credential for this provider, including OAuth logins");
			// A broker configuration refuses the local command, so name the form that works there.
			expect(banner).toContain(`with a broker configuration run gjc auth-broker logout shadow-new`);
			// Disclosure only: the unrelated stored key is not deleted.
			expect(await authStorage!.peekApiKey("shadow-new")).toBe("sk-stale-login-key");
		} finally {
			if (previousEnv === undefined) delete Bun.env[envName];
			else Bun.env[envName] = previousEnv;
		}
	});

	it("discloses a surviving stored key after an interrupted env switch", async () => {
		const envName = "GJC_INTERRUPTED_SWITCH_KEY";
		const previousEnv = Bun.env[envName];
		Bun.env[envName] = "sk-interrupted-env-value";
		try {
			// The config already carries the env reference (an earlier attempt
			// committed it), but the old store-backed key survived that attempt.
			await Bun.write(
				modelsPath,
				[
					"providers:",
					"  interrupted-provider:",
					"    baseUrl: https://api.example.com/v1",
					"    api: openai-completions",
					"    apiKeyEnv: OLD_INTERRUPTED_KEY",
					"    models:",
					"      - id: old-model",
					"",
				].join("\n"),
			);
			await authStorage!.set("interrupted-provider", { type: "api_key", key: "sk-survived-key" });

			const result = await addApiCompatibleProvider({
				compatibility: "openai",
				providerId: "interrupted-provider",
				baseUrl: "https://api.example.com/v1",
				apiKeyEnv: envName,
				models: ["new-model"],
				modelsPath,
				force: true,
				authStorage,
			});

			expect(result.credentialCleanup).toBeUndefined();
			expect(result.storedCredentialShadow).toEqual({ storedApiKeys: 1, envName });
			expect(formatProviderSetupResult(result)).toContain("gjc accounts logout interrupted-provider --all");
			expect(await authStorage!.peekApiKey("interrupted-provider")).toBe("sk-survived-key");
		} finally {
			if (previousEnv === undefined) delete Bun.env[envName];
			else Bun.env[envName] = previousEnv;
		}
	});

	it("probes discovery with the runtime-resolved stored key, not the raw reference", async () => {
		const envName = "GJC_CMD_PROBE_ENV";
		const previousEnv = Bun.env[envName];
		Bun.env[envName] = "sk-env-fallback";
		// The real resolver executes `!<cmd>` values, exactly as a request would.
		const resolvingAuth = new AuthStorage(store!, { configValueResolver: resolveConfigValue });
		const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
			(async (_input: Parameters<typeof fetch>[0]) =>
				new Response(JSON.stringify({ data: [{ id: "cmd-model" }] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				})) as typeof fetch,
		);
		try {
			await resolvingAuth.set("cmd-probe", { type: "api_key", key: "!printf sk-cmd-key" });

			const result = await addApiCompatibleProvider({
				compatibility: "openai",
				providerId: "cmd-probe",
				baseUrl: "https://api.example.com/v1",
				apiKeyEnv: envName,
				discover: true,
				modelsPath,
				authStorage: resolvingAuth,
			});

			// The probe must never receive the unresolved `!<cmd>` reference.
			expect(result.discoveryEnabled).toBe(true);
			expect(fetchSpy).toHaveBeenCalledTimes(1);
			const requestInit = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined;
			const headers = requestInit?.headers as Record<string, string>;
			expect(headers.Authorization).toBe("Bearer sk-cmd-key");

			// ... and it must equal what the refreshed registry resolves at request time.
			const registry = new ModelRegistry(resolvingAuth, modelsPath);
			await registry.refresh("offline");
			expect(await registry.getApiKeyForProvider("cmd-probe")).toBe("sk-cmd-key");
		} finally {
			fetchSpy.mockRestore();
			if (previousEnv === undefined) delete Bun.env[envName];
			else Bun.env[envName] = previousEnv;
		}
	});

	it("never sends an unresolved command reference when the store cannot resolve it", async () => {
		const envName = "GJC_RAW_STORE_PROBE_ENV";
		const previousEnv = Bun.env[envName];
		Bun.env[envName] = "sk-env-fallback";
		const resolvingAuth = new AuthStorage(store!, { configValueResolver: resolveConfigValue });
		// A store that cannot resolve stored values: no `peekApiKey`.
		const rawOnlyStore = {
			exportSnapshot: () => resolvingAuth.exportSnapshot(),
			set: (...args: Parameters<AuthStorage["set"]>) => resolvingAuth.set(...args),
			remove: (...args: Parameters<AuthStorage["remove"]>) => resolvingAuth.remove(...args),
			disableCredentialById: (id: number, cause: string) => resolvingAuth.disableCredentialById(id, cause),
			reload: () => resolvingAuth.reload(),
		};
		const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
			(async (_input: Parameters<typeof fetch>[0]) =>
				new Response(JSON.stringify({ data: [{ id: "raw-model" }] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				})) as typeof fetch,
		);
		try {
			await resolvingAuth.set("cmd-probe-raw", { type: "api_key", key: "!printf sk-cmd-key" });

			await addApiCompatibleProvider({
				compatibility: "openai",
				providerId: "cmd-probe-raw",
				baseUrl: "https://api.example.com/v1",
				apiKeyEnv: envName,
				discover: true,
				modelsPath,
				authStorage: rawOnlyStore,
			});

			expect(fetchSpy).toHaveBeenCalledTimes(1);
			const requestInit = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined;
			const headers = requestInit?.headers as Record<string, string>;
			// Absent stored key -> the apiKeyEnv fallback, never `Bearer !<cmd>`.
			expect(headers.Authorization).toBe("Bearer sk-env-fallback");
			expect(headers.Authorization).not.toContain("!printf");
		} finally {
			fetchSpy.mockRestore();
			if (previousEnv === undefined) delete Bun.env[envName];
			else Bun.env[envName] = previousEnv;
		}
	});

	it("resolves a command-backed stored key for the store setup opens itself", async () => {
		const envName = "GJC_OWNED_PROBE_ENV";
		const previousEnv = Bun.env[envName];
		Bun.env[envName] = "sk-env-fallback";
		const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
			(async (_input: Parameters<typeof fetch>[0]) =>
				new Response(JSON.stringify({ data: [{ id: "owned-model" }] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				})) as typeof fetch,
		);
		try {
			// Same agent DB the owned store opens; the value must not be sent raw.
			await authStorage!.set("owned-probe", { type: "api_key", key: "!printf sk-owned-cmd-key" });

			await addApiCompatibleProvider({
				compatibility: "openai",
				providerId: "owned-probe",
				baseUrl: "https://api.example.com/v1",
				apiKeyEnv: envName,
				discover: true,
				modelsPath,
				// No authStorage: setup opens its own store, which must inject the real
				// config-value resolver instead of the env-or-literal default.
			});

			expect(fetchSpy).toHaveBeenCalledTimes(1);
			const requestInit = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined;
			const headers = requestInit?.headers as Record<string, string>;
			expect(headers.Authorization).toBe("Bearer sk-owned-cmd-key");
			expect(headers.Authorization).not.toContain("!printf");
		} finally {
			fetchSpy.mockRestore();
			if (previousEnv === undefined) delete Bun.env[envName];
			else Bun.env[envName] = previousEnv;
		}
	});

	it("resolves a pasted command-backed literal for the discovery probe", async () => {
		const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
			(async (_input: Parameters<typeof fetch>[0]) =>
				new Response(JSON.stringify({ data: [{ id: "literal-cmd-model" }] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				})) as typeof fetch,
		);
		try {
			const result = await addApiCompatibleProvider({
				compatibility: "openai",
				providerId: "literal-cmd-probe",
				baseUrl: "https://api.example.com/v1",
				apiKey: "!printf sk-literal-cmd-key",
				discover: true,
				modelsPath,
				authStorage,
			});

			// The pre-write probe must send what the runtime would resolve, not the
			// pasted reference.
			expect(fetchSpy).toHaveBeenCalledTimes(1);
			const requestInit = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined;
			const headers = requestInit?.headers as Record<string, string>;
			expect(headers.Authorization).toBe("Bearer sk-literal-cmd-key");
			expect(headers.Authorization).not.toContain("!printf");

			// The raw declaration is stored under credential: store and resolves to
			// the same secret the probe used.
			expect(result.credentialSource).toBe("literal");
			expect((await readWrittenProvider("literal-cmd-probe")).credential).toBe("store");
			const resolvingAuth = new AuthStorage(store!, { configValueResolver: resolveConfigValue });
			await resolvingAuth.reload();
			expect(await resolvingAuth.peekApiKey("literal-cmd-probe")).toBe("sk-literal-cmd-key");
		} finally {
			fetchSpy.mockRestore();
		}
	});

	it("fails a discovery add whose pasted reference cannot be resolved", async () => {
		const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
			(async (_input: Parameters<typeof fetch>[0]) =>
				new Response(JSON.stringify({ data: [{ id: "never-model" }] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				})) as typeof fetch,
		);
		try {
			await expect(
				addApiCompatibleProvider({
					compatibility: "openai",
					providerId: "broken-literal-probe",
					baseUrl: "https://api.example.com/v1",
					apiKey: "!gjc-no-such-command-rev8",
					discover: true,
					modelsPath,
					authStorage,
				}),
			).rejects.toThrow(/pasted value is a command or environment reference that does not resolve/);
			// Nothing crossed the network and nothing was written.
			expect(fetchSpy).not.toHaveBeenCalled();
			expect(await Bun.file(modelsPath).exists()).toBe(false);
		} finally {
			fetchSpy.mockRestore();
		}
	});

	it("treats a rejecting store resolver as absent instead of sending the raw value", async () => {
		const envName = "GJC_REJECTING_RESOLVER_ENV";
		const previousEnv = Bun.env[envName];
		Bun.env[envName] = "sk-env-fallback";
		const rejectingStore = {
			exportSnapshot: () => authStorage!.exportSnapshot(),
			set: (...args: Parameters<AuthStorage["set"]>) => authStorage!.set(...args),
			remove: (...args: Parameters<AuthStorage["remove"]>) => authStorage!.remove(...args),
			disableCredentialById: (id: number, cause: string) => authStorage!.disableCredentialById(id, cause),
			reload: () => authStorage!.reload(),
			peekApiKey: async () => {
				throw new Error("resolver failed");
			},
		};
		const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
			(async (_input: Parameters<typeof fetch>[0]) =>
				new Response(JSON.stringify({ data: [{ id: "rejecting-model" }] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				})) as typeof fetch,
		);
		try {
			await authStorage!.set("rejecting-probe", { type: "api_key", key: "!printf sk-cmd-key" });

			await addApiCompatibleProvider({
				compatibility: "openai",
				providerId: "rejecting-probe",
				baseUrl: "https://api.example.com/v1",
				apiKeyEnv: envName,
				discover: true,
				modelsPath,
				authStorage: rejectingStore,
			});

			expect(fetchSpy).toHaveBeenCalledTimes(1);
			const requestInit = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined;
			const headers = requestInit?.headers as Record<string, string>;
			expect(headers.Authorization).toBe("Bearer sk-env-fallback");
			expect(headers.Authorization).not.toContain("!printf");
		} finally {
			fetchSpy.mockRestore();
			if (previousEnv === undefined) delete Bun.env[envName];
			else Bun.env[envName] = previousEnv;
		}
	});

	it("treats a resolver result that is still a command reference as absent", async () => {
		const envName = "GJC_UNRESOLVED_RESULT_ENV";
		const previousEnv = Bun.env[envName];
		Bun.env[envName] = "sk-env-fallback";
		// A resolver that hands back the reference unchanged has not resolved it.
		const passthroughStore = {
			exportSnapshot: () => authStorage!.exportSnapshot(),
			set: (...args: Parameters<AuthStorage["set"]>) => authStorage!.set(...args),
			remove: (...args: Parameters<AuthStorage["remove"]>) => authStorage!.remove(...args),
			disableCredentialById: (id: number, cause: string) => authStorage!.disableCredentialById(id, cause),
			reload: () => authStorage!.reload(),
			peekApiKey: async () => "!printf sk-cmd-key",
		};
		const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
			(async (_input: Parameters<typeof fetch>[0]) =>
				new Response(JSON.stringify({ data: [{ id: "passthrough-model" }] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				})) as typeof fetch,
		);
		try {
			await authStorage!.set("passthrough-probe", { type: "api_key", key: "!printf sk-cmd-key" });

			await addApiCompatibleProvider({
				compatibility: "openai",
				providerId: "passthrough-probe",
				baseUrl: "https://api.example.com/v1",
				apiKeyEnv: envName,
				discover: true,
				modelsPath,
				authStorage: passthroughStore,
			});

			expect(fetchSpy).toHaveBeenCalledTimes(1);
			const requestInit = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined;
			const headers = requestInit?.headers as Record<string, string>;
			expect(headers.Authorization).toBe("Bearer sk-env-fallback");
			expect(headers.Authorization).not.toContain("!printf");
		} finally {
			fetchSpy.mockRestore();
			if (previousEnv === undefined) delete Bun.env[envName];
			else Bun.env[envName] = previousEnv;
		}
	});

	it("resolves an env-name stored value when the store has no resolver", async () => {
		const envName = "GJC_RAW_STORE_ENV_NAME";
		const storedEnvName = "GJC_STORED_ENV_NAME_KEY";
		const previousEnv = Bun.env[envName];
		const previousStoredEnv = Bun.env[storedEnvName];
		Bun.env[envName] = "sk-env-fallback";
		Bun.env[storedEnvName] = "sk-from-env-name";
		const rawOnlyStore = {
			exportSnapshot: () => authStorage!.exportSnapshot(),
			set: (...args: Parameters<AuthStorage["set"]>) => authStorage!.set(...args),
			remove: (...args: Parameters<AuthStorage["remove"]>) => authStorage!.remove(...args),
			disableCredentialById: (id: number, cause: string) => authStorage!.disableCredentialById(id, cause),
			reload: () => authStorage!.reload(),
		};
		const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
			(async (_input: Parameters<typeof fetch>[0]) =>
				new Response(JSON.stringify({ data: [{ id: "envname-model" }] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				})) as typeof fetch,
		);
		try {
			await authStorage!.set("envname-probe", { type: "api_key", key: storedEnvName });

			await addApiCompatibleProvider({
				compatibility: "openai",
				providerId: "envname-probe",
				baseUrl: "https://api.example.com/v1",
				apiKeyEnv: envName,
				discover: true,
				modelsPath,
				authStorage: rawOnlyStore,
			});

			expect(fetchSpy).toHaveBeenCalledTimes(1);
			const requestInit = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined;
			const headers = requestInit?.headers as Record<string, string>;
			// Env-name-or-literal, exactly like the runtime resolver.
			expect(headers.Authorization).toBe("Bearer sk-from-env-name");
			expect(headers.Authorization).not.toBe(`Bearer ${storedEnvName}`);
		} finally {
			fetchSpy.mockRestore();
			if (previousEnv === undefined) delete Bun.env[envName];
			else Bun.env[envName] = previousEnv;
			if (previousStoredEnv === undefined) delete Bun.env[storedEnvName];
			else Bun.env[storedEnvName] = previousStoredEnv;
		}
	});

	it("discloses that the shadow check could not run instead of reporting a clean success", async () => {
		const envName = "GJC_UNVERIFIED_SHADOW_KEY";
		const previousEnv = Bun.env[envName];
		Bun.env[envName] = "sk-unverified-env-value";
		try {
			// The add itself succeeds; only the post-add inspection is unavailable.
			const unreadableStore = {
				exportSnapshot: () => {
					throw new Error("snapshot unavailable");
				},
				set: async () => undefined,
				remove: async () => undefined,
				disableCredentialById: () => true,
				reload: async () => {
					throw new Error("credential store unavailable");
				},
			};

			const result = await addApiCompatibleProvider({
				compatibility: "openai",
				providerId: "unverified-shadow",
				baseUrl: "https://api.example.com/v1",
				apiKeyEnv: envName,
				models: ["unverified-model"],
				modelsPath,
				authStorage: unreadableStore,
			});

			// Not a failure and not silence: the add succeeded, and the result says the
			// store could not be checked.
			expect((await readWrittenProvider("unverified-shadow")).apiKeyEnv).toBe(envName);
			expect(result.storedCredentialShadow).toBeUndefined();
			expect(result.storedCredentialShadowUnverified).toEqual({ envName });
			const banner = formatProviderSetupResult(result);
			expect(banner).toContain("could not check the credential store");
			expect(banner).toContain(`would still take precedence over ${envName}`);
			expect(banner).toContain("gjc accounts list");
			// No invented count: the store was never read.
			expect(banner).not.toContain("stored API key credential(s) for this provider take precedence");
		} finally {
			if (previousEnv === undefined) delete Bun.env[envName];
			else Bun.env[envName] = previousEnv;
		}
	});

	it("warns again after a declared provider is removed and re-added", async () => {
		const declaredConfig = [
			"providers:",
			"  readd-store:",
			"    baseUrl: https://api.example.com/v1",
			"    api: openai-completions",
			"    credential: store",
			"    models:",
			"      - id: readd-model",
			"",
		].join("\n");
		const warn = spyOn(logger, "warn").mockImplementation(() => {});
		try {
			await Bun.write(modelsPath, declaredConfig);
			const registry = new ModelRegistry(authStorage!, modelsPath);
			await registry.refresh("offline");
			expect(countStoreDeclarationWarnings(warn)).toBe(1);

			await Bun.write(modelsPath, "providers: {}\n");
			await registry.refresh("offline");
			expect(countStoreDeclarationWarnings(warn)).toBe(1);

			await Bun.write(modelsPath, declaredConfig);
			await registry.refresh("offline");
			expect(countStoreDeclarationWarnings(warn)).toBe(2);
		} finally {
			warn.mockRestore();
		}
	});

	it("warns again after a declared provider is removed and re-added through staged publish", async () => {
		const declaredConfig = [
			"providers:",
			"  staged-readd-store:",
			"    baseUrl: https://api.example.com/v1",
			"    api: openai-completions",
			"    credential: store",
			"    models:",
			"      - id: staged-readd-model",
			"",
		].join("\n");
		const warn = spyOn(logger, "warn").mockImplementation(() => {});
		try {
			await Bun.write(modelsPath, declaredConfig);
			const registry = new ModelRegistry(authStorage!, modelsPath);
			await registry.refresh("offline");
			expect(countStoreDeclarationWarnings(warn)).toBe(1);

			// Publishing a config without the provider must prune the live mark: the
			// staged candidate prunes only its own fresh set, and the publish swaps
			// state without re-running the live instance's load.
			const removed = await registry.stageModelsConfigReload({
				path: modelsPath,
				text: "providers: {}\n",
				identity: "staged-readd-removed",
			});
			expect(removed.valid).toBe(true);
			removed.commit();
			removed.finalize();
			expect(countStoreDeclarationWarnings(warn)).toBe(1);

			const readded = await registry.stageModelsConfigReload({
				path: modelsPath,
				text: declaredConfig,
				identity: "staged-readd-added",
			});
			expect(readded.valid).toBe(true);
			readded.commit();
			readded.finalize();
			expect(countStoreDeclarationWarnings(warn)).toBe(2);
		} finally {
			warn.mockRestore();
		}
	});

	it("rejects unsupported models config paths before any credential or config write", async () => {
		for (const rejectedPath of [path.join(tempRoot!, "models.txt"), path.join(tempRoot!, "models.json")]) {
			await expect(
				addApiCompatibleProvider({
					compatibility: "openai",
					providerId: "bad-extension",
					baseUrl: "https://api.example.com/v1",
					apiKey: "sk-bad-extension",
					models: ["bad-model"],
					modelsPath: rejectedPath,
					authStorage,
				}),
			).rejects.toThrow("Models config path must end with .yml or .yaml");

			expect(await Bun.file(rejectedPath).exists()).toBe(false);
			expect(await authStorage!.peekApiKey("bad-extension")).toBeUndefined();
		}
	});

	it("ignores non-models registry errors when gating setup success", () => {
		const presetError = new ConfigError("model-preset-registry", undefined, {
			err: new Error("corrupt preset registry"),
			stage: "Registry",
		});
		expect(() =>
			assertProviderConfigLoaded({ getError: () => presetError }, "preset-provider", modelsPath, "env"),
		).not.toThrow();

		const modelsError = new ConfigError("models", undefined, {
			err: new Error("broken models config"),
			stage: "Validate(models)",
		});
		expect(() =>
			assertProviderConfigLoaded({ getError: () => modelsError }, "preset-provider", modelsPath, "env"),
		).toThrow(
			`Provider 'preset-provider' was written to ${modelsPath} (its apiKeyEnv reference is in models.yml and the key itself stays in the environment), but the models config did not load: Failed to load config file models`,
		);
		expect(() =>
			assertProviderConfigLoaded({ getError: () => modelsError }, "preset-provider", modelsPath, "literal"),
		).toThrow(
			`Provider 'preset-provider' was written to ${modelsPath} (its API key was written to the credential store, not to models.yml), but the models config did not load:`,
		);
	});

	it("invalidates the process-wide models config snapshot before verifying a committed add", async () => {
		const agentDir = path.join(tempRoot!, "singleton-agent");
		await fs.mkdir(agentDir, { recursive: true });
		const script = [
			'import { getAgentDbPath, getAgentDir } from "@gajae-code/utils";',
			'import * as path from "node:path";',
			'import { ModelRegistry, ModelsConfigFile } from "./src/config/model-registry";',
			'import { AuthStorage, SqliteAuthCredentialStore } from "./src/session/auth-storage";',
			'import { addApiCompatibleProvider } from "./src/setup/provider-onboarding";',
			"",
			"const warmed = ModelsConfigFile.tryLoad().status;",
			"const store = await SqliteAuthCredentialStore.open(getAgentDbPath());",
			"const authStorage = new AuthStorage(store);",
			"const registry = new ModelRegistry(authStorage);",
			'await registry.refresh("offline");',
			"const result = await addApiCompatibleProvider({",
			'	compatibility: "openai",',
			'	providerId: "singleton-provider",',
			'	baseUrl: "https://api.example.com/v1",',
			'	apiKey: "sk-singleton-secret",',
			'	models: ["singleton-model"],',
			"	authStorage,",
			"});",
			'await registry.refresh("offline");',
			'const model = registry.find("singleton-provider", "singleton-model");',
			"const configError = registry.getError();",
			"const report = {",
			"	warmed,",
			"	singletonPath: ModelsConfigFile.path(),",
			"	providerId: result.providerId,",
			"	modelsPath: result.modelsPath,",
			'	expectedPath: path.join(getAgentDir(), "models.yml"),',
			"	configError: configError ? configError.message : null,",
			'	key: await registry.getApiKeyForProvider("singleton-provider"),',
			"	found: Boolean(model),",
			"};",
			"store.close();",
			'process.stdout.write("RESULT:" + JSON.stringify(report) + "\\n");',
		].join("\n");

		const proc = Bun.spawn({
			cmd: [process.execPath, "-e", script],
			cwd: path.join(import.meta.dir, ".."),
			env: { ...process.env, GJC_CODING_AGENT_DIR: agentDir } as Record<string, string>,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, stdout, stderr] = await Promise.all([
			proc.exited,
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);

		const resultLine = stdout.split("\n").find(line => line.startsWith("RESULT:"));
		expect(exitCode).toBe(0);
		if (!resultLine) throw new Error(`subprocess produced no RESULT line; stderr: ${stderr}`);
		const report = JSON.parse(resultLine.slice("RESULT:".length)) as {
			warmed: string;
			singletonPath: string;
			providerId: string;
			modelsPath: string;
			expectedPath: string;
			configError: string | null;
			key: string | undefined;
			found: boolean;
		};
		// The warm cache was the singleton's own snapshot, not a private temp file.
		expect(report.warmed).toBe("not-found");
		expect(report.singletonPath).toBe(report.expectedPath);
		expect(report.modelsPath).toBe(report.expectedPath);
		expect(report.providerId).toBe("singleton-provider");
		expect(report.configError).toBeNull();
		expect(report.key).toBe("sk-singleton-secret");
		expect(report.found).toBe(true);
	}, 30_000);

	it("retries the dynamic registry import after a rejection", async () => {
		const retryModelsPath = path.join(tempRoot!, "retry-models.yml");
		const script = [
			"let resolutions = 0;",
			"await Bun.plugin({",
			'\tname: "fail-first-registry-import",',
			"\tsetup(build) {",
			"\t\tbuild.onResolve({ filter: /config\\/model-registry\\.ts$/ }, () => {",
			"\t\t\tresolutions += 1;",
			"\t\t\t// A transient resolution failure is not cached as a module record, so\n\t\t\t// the retry can actually re-resolve the real module.",
			'\t\t\tif (resolutions === 1) return { path: "/tmp/definitely-missing-model-registry.ts" };',
			"\t\t\treturn undefined;",
			"\t\t});",
			"\t},",
			"});",
			'const { addApiCompatibleProvider } = await import("./src/setup/provider-onboarding");',
			"let firstError = null;",
			"try {",
			"\tawait addApiCompatibleProvider({",
			'\t\tcompatibility: "openai",',
			'\t\tproviderId: "retry-provider",',
			'\t\tbaseUrl: "https://api.example.com/v1",',
			'\t\tapiKeyEnv: "RETRY_PROVIDER_KEY",',
			'\t\tmodels: ["retry-model"],',
			"\t\tmodelsPath: process.env.RETRY_MODELS_PATH,",
			"\t});",
			"} catch (error) {",
			"\tfirstError = error instanceof Error ? error.message : String(error);",
			"}",
			"const result = await addApiCompatibleProvider({",
			'\tcompatibility: "openai",',
			'\tproviderId: "retry-provider",',
			'\tbaseUrl: "https://api.example.com/v1",',
			'\tapiKeyEnv: "RETRY_PROVIDER_KEY",',
			'\tmodels: ["retry-model"],',
			"\tmodelsPath: process.env.RETRY_MODELS_PATH,",
			"});",
			"const exists = await Bun.file(process.env.RETRY_MODELS_PATH).exists();",
			'process.stdout.write("RESULT:" + JSON.stringify({ firstError, resolutions, providerId: result.providerId, exists }) + "\\n");',
		].join("\n");

		const proc = Bun.spawn({
			cmd: [process.execPath, "-e", script],
			cwd: path.join(import.meta.dir, ".."),
			env: {
				...process.env,
				RETRY_MODELS_PATH: retryModelsPath,
				RETRY_PROVIDER_KEY: "sk-retry-value",
			} as Record<string, string>,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, stdout, stderr] = await Promise.all([
			proc.exited,
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);

		const resultLine = stdout.split("\n").find(line => line.startsWith("RESULT:"));
		expect(exitCode).toBe(0);
		if (!resultLine) throw new Error(`subprocess produced no RESULT line; stderr: ${stderr}`);
		const report = JSON.parse(resultLine.slice("RESULT:".length)) as {
			firstError: string | null;
			resolutions: number;
			providerId: string;
			exists: boolean;
		};
		expect(report.firstError).toContain("definitely-missing-model-registry");
		expect(report.resolutions).toBeGreaterThanOrEqual(2);
		expect(report.providerId).toBe("retry-provider");
		expect(report.exists).toBe(true);
	}, 30_000);
});
