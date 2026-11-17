import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	type AuthStorage,
	isStoredApiKeyCredentialForProvider,
	resolveOAuthStorageProvider,
} from "@gajae-code/ai/core";
import {
	isSafeCatalogModelId,
	MODELS_LIST_REQUEST_TIMEOUT_MS,
	readBoundedModelsJson,
} from "@gajae-code/ai/utils/discovery/openai-compatible";
import { getAgentDbPath, getAgentDir, logger } from "@gajae-code/utils";
import { $rotatingCredentialEnv } from "@gajae-code/utils/env";
import { YAML } from "bun";
import type { LoadResult } from "../config/config-file";
import { withFileLock } from "../config/file-lock";
import {
	type ModelsConfig,
	ModelsConfigSchema,
	PROVIDER_CREDENTIAL_STORE,
	type ProviderDiscovery,
} from "../config/models-config-schema";
import { compareRankedProviders, famousProviderIndex } from "../config/provider-ranking";
import { AuthStorage as AuthStorageImpl } from "../session/auth-storage";
import providerPresets from "./provider-presets.json";

// Setup writes YAML, and the models reader parses JSON only for `.json`/`.jsonc`.
// Accepting those extensions here would rename YAML into a path the reader
// then rejects, after the config and credential were already committed.
const MODELS_CONFIG_PATH_EXTENSIONS = [".yml", ".yaml"] as const;

interface ModelsConfigFileLike {
	relocate(configPath?: string): { invalidate(): void; tryLoad(): LoadResult<ModelsConfig> };
}

interface ModelRegistryModule {
	validateModelsConfig(config: ModelsConfig): void;
	ModelsConfigFile: ModelsConfigFileLike;
}

interface ConfigValueResolverModule {
	resolveConfigValue(config: string, cacheScope?: string): Promise<string | undefined>;
}

// The models-config validator and loader live in model-registry, which is
// deliberately kept out of the eager `gjc setup <component>` module graph
// (#5949). Setup pays for it only when it validates or re-reads a provider
// config.
let modelRegistryModule: Promise<ModelRegistryModule> | undefined;
function loadModelRegistryModule(): Promise<ModelRegistryModule> {
	if (!modelRegistryModule) {
		const loading = import("../config/model-registry");
		modelRegistryModule = loading;
		// A rejected import must not memoize: a wizard retry after the environment
		// is fixed has to be able to load the module again.
		loading.catch(() => {
			if (modelRegistryModule === loading) modelRegistryModule = undefined;
		});
	}
	return modelRegistryModule;
}

// Stored credential values may be `!<command>` or env-name references. The
// runtime resolves them with this module's resolver, and setup must resolve
// them the same way before any value can reach a discovery request. Kept
// dynamic for the same eager-graph reason as the models registry.
let configValueResolverModule: Promise<ConfigValueResolverModule> | undefined;
function loadConfigValueResolverModule(): Promise<ConfigValueResolverModule> {
	if (!configValueResolverModule) {
		const loading = import("../config/resolve-config-value");
		configValueResolverModule = loading;
		loading.catch(() => {
			if (configValueResolverModule === loading) configValueResolverModule = undefined;
		});
	}
	return configValueResolverModule;
}

function assertModelsConfigPath(modelsPath: string): void {
	if (MODELS_CONFIG_PATH_EXTENSIONS.some(extension => modelsPath.endsWith(extension))) return;
	throw new Error(`Models config path must end with ${MODELS_CONFIG_PATH_EXTENSIONS.join(" or ")}: ${modelsPath}`);
}

export type ProviderCompatibility = "openai" | "anthropic";
export type ProviderSetupApi = "openai-responses" | "openai-completions" | "anthropic-messages";

export interface ProviderSetupInput {
	compatibility?: ProviderCompatibility;
	preset?: string;
	providerId?: string;
	baseUrl?: string;
	apiKey?: string;
	apiKeyEnv?: string;
	models?: string[];
	modelsPath?: string;
	force?: boolean;
	/**
	 * Opt into live OpenAI `/v1/models` discovery for an OpenAI-compatible
	 * custom provider. Manual `--model` ids may be omitted when set; the
	 * runtime auto-discovers the catalog on refresh and merges it without
	 * duplicates.
	 *
	 * When no manual models are given, setup probes the endpoint before
	 * writing config so an unreachable endpoint, rejected credential, or
	 * empty catalog fails the setup loudly instead of writing a provider
	 * that can never serve a model. There is deliberately no skip flag: the
	 * pre-write probe is the enforcement point, and the wizard's
	 * interactive probe is a preview only (inputs may have changed since).
	 */
	discover?: boolean;
	/** Probe override for tests; defaults to the live endpoint probe. */
	probeDiscovery?: (input: ProviderDiscoveryProbeInput) => Promise<ProviderDiscoveryProbeResult>;
	/**
	 * Cancel discovery and persistence until the atomic config rename is
	 * invoked. Later cancellation does not undo a committed provider.
	 * Combined with the shared deadline inside the probe; callers that omit
	 * it get deadline-only probe behavior.
	 */
	discoverySignal?: AbortSignal;
	/**
	 * Live credential authority for literal-key persistence. Interactive
	 * callers pass the active session registry's AuthStorage so the
	 * subsequent targeted online refresh authenticates from the same
	 * authority that stored the key. When omitted, onboarding falls back
	 * to a short-lived store at the agent DB path (headless/CLI behavior).
	 */
	authStorage?: ProviderSetupCredentialStore;
}

export interface ProviderSetupResult {
	providerId: string;
	compatibility: ProviderCompatibility;
	api: ProviderSetupApi;
	baseUrl: string;
	modelIds: string[];
	modelsPath: string;
	redactedApiKey: string;
	credentialSource: "literal" | "env";
	/** True when the provider persists a `discovery:` block (live catalog). */
	discoveryEnabled: boolean;
	/** The persisted discovery type, when any (e.g. `openai-models-list`). */
	discoveryType?: string;
	preset?: string;
	presetName?: string;
	/**
	 * Set only when a forced env replacement disabled stored API-key rows the
	 * replaced entry declared via `credential: store`. Present so setup can
	 * report the destructive half instead of silently dropping a credential.
	 * Rows are soft-disabled, not deleted: `gjc accounts list` shows them as
	 * `disabled` and `gjc accounts logout <provider> --all` removes them.
	 */
	credentialCleanup?: { disabledApiKeys: number; envName: string };
	/**
	 * Set when an env-source add succeeds while stored api_key rows for the
	 * provider remain. They outrank `apiKeyEnv` at runtime and are not removed
	 * by setup (the replaced entry never declared `credential: store`), so the
	 * success output must say the environment variable is being shadowed.
	 */
	storedCredentialShadow?: { storedApiKeys: number; envName: string };
	/**
	 * Set when an env-source add succeeds but the credential store could not be
	 * inspected, so setup cannot say whether stored api_key rows shadow the env
	 * var. Present so the success output discloses the unverified risk instead
	 * of reporting unconditional success.
	 */
	storedCredentialShadowUnverified?: { envName: string };
}

type ProviderConfig = NonNullable<NonNullable<ModelsConfig["providers"]>[string]>;
type ProviderCompatConfig = NonNullable<ProviderConfig["compat"]>;
type ProviderSetupCredentialStore = Pick<
	AuthStorage,
	"set" | "remove" | "exportSnapshot" | "disableCredentialById" | "reload"
> & {
	/**
	 * Resolves a stored api_key value the way the runtime does: a
	 * `!<command>` value is executed and an env-name value is read from the
	 * environment. Optional so test doubles can omit it; the probe then uses
	 * the raw stored value, refusing a command-backed reference it cannot run.
	 */
	peekApiKey?: AuthStorage["peekApiKey"];
};

interface ProviderPreset {
	id: string;
	aliases: readonly string[];
	name: string;
	description: string;
	compatibility: ProviderCompatibility;
	api: ProviderSetupApi;
	providerId: string;
	baseUrl?: string;
	apiKeyEnv: string;
	models?: readonly string[];
	modelApi?: Readonly<Record<string, ProviderSetupApi>>;
	compat?: ProviderCompatConfig;
	discovery?: ProviderDiscovery;
	/**
	 * Parameterized presets (proxy gateways) do not hardcode a base URL or an
	 * unoverridable apiKeyEnv: the caller must supply `--base-url` and may
	 * override `--api-key-env`. `baseUrl` is absent for these presets.
	 */
	parameterized?: boolean;
}

const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
export const PROVIDER_PRESETS: readonly ProviderPreset[] = providerPresets as ProviderPreset[];

export function getDefaultModelsPath(): string {
	return path.join(getAgentDir(), "models.yml");
}

export function normalizeProviderId(providerId: string): string {
	return providerId.trim().toLowerCase();
}

export function parseProviderCompatibility(value: string): ProviderCompatibility {
	const normalized = value.trim().toLowerCase();
	if (normalized === "openai" || normalized === "openai-compatible" || normalized === "oai") return "openai";
	if (normalized === "anthropic" || normalized === "anthropic-compatible" || normalized === "claude") {
		return "anthropic";
	}
	throw new Error("Provider compatibility must be 'openai' or 'anthropic'.");
}

export function findProviderPreset(value: string | undefined): ProviderPreset | undefined {
	const normalized = value?.trim().toLowerCase();
	if (!normalized) return undefined;
	return PROVIDER_PRESETS.find(preset => preset.id === normalized || preset.aliases.includes(normalized));
}

function providerPresetRankingId(preset: ProviderPreset): string {
	return (
		[preset.providerId, preset.id, ...preset.aliases].find(id => famousProviderIndex(id) !== undefined) ?? preset.id
	);
}

export function formatProviderPresetList(): string {
	return [...PROVIDER_PRESETS]
		.sort((left, right) =>
			compareRankedProviders(
				{ id: providerPresetRankingId(left), label: left.name, authState: "none" },
				{ id: providerPresetRankingId(right), label: right.name, authState: "none" },
			),
		)
		.map(preset => {
			const aliases = preset.aliases.length > 0 ? ` (aliases: ${preset.aliases.join(", ")})` : "";
			return `${preset.id}${aliases}: ${preset.description}`;
		})
		.join("\n");
}

export function parseModelList(values: readonly string[]): string[] {
	const models = values
		.flatMap(value => value.split(","))
		.map(value => value.trim())
		.filter(value => value.length > 0);
	return [...new Set(models)];
}

export function redactSecret(_secret: string): string {
	return "***";
}

/**
 * Raised when setup committed a config that replaces a `credential: store`
 * declaration with an `apiKeyEnv` reference but could not disable the stored
 * api_key rows. The config is rolled back before this reaches the caller, so
 * the message always states both the failure and the recovery.
 */
class CredentialCleanupError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "CredentialCleanupError";
	}
}

/**
 * Recovery guidance shared by every cleanup failure. The add commands reject a
 * raw `--api-key`, so a literal key can only be re-entered through the
 * interactive wizard, while the command form re-adds the provider with an env
 * reference.
 */
function providerCredentialRecoveryHint(providerId: string): string {
	return (
		`Restore a working credential by running \`/provider\` with no arguments in the interactive TUI and pasting a literal key, ` +
		`or by re-adding the provider with an env reference: ` +
		`\`/provider add --compat <openai|anthropic> --provider ${providerId} --base-url <url> --api-key-env <ENV> (--model <id> | --discover) --force\` ` +
		`(the same flags work on \`gjc setup provider\`).`
	);
}

/**
 * Disable this provider's stored api_key rows when setup replaces a
 * `credential: store` entry with an `apiKeyEnv` reference. A stored api_key
 * outranks the env indirection, so leaving it behind would keep resolving the
 * old literal key. OAuth rows are never touched, and rows are soft-disabled
 * (`gjc accounts list` shows them as `disabled`) rather than deleted.
 *
 * Only a confirmed disable (`disableCredentialById` returning `true`) counts:
 * the store can swallow errors, and this count is what the user reasons about
 * in a path that cannot restore the rows. Persistence is verified by
 * re-reading the store, because remote (broker-owned) stores reject disables
 * outright and a reload is the only proof the rows no longer resolve.
 */
async function removeStoredApiKeyCredentials(store: ProviderSetupCredentialStore, providerId: string): Promise<number> {
	const selectApiKeyRows = () =>
		store.exportSnapshot().credentials.filter(entry => isStoredApiKeyCredentialForProvider(entry, providerId));
	const apiKeyIds = selectApiKeyRows().map(entry => entry.id);
	let disabledCount = 0;
	for (const id of apiKeyIds) {
		try {
			if (
				store.disableCredentialById(id, "provider setup switched to an environment-variable credential") === true
			) {
				disabledCount += 1;
			}
		} catch (error) {
			// Only this path proves the store refused the disable. A reload failure
			// below has a different diagnosis and must not borrow this one.
			throw new CredentialCleanupError(
				`Provider '${providerId}' could not disable its stored API key credentials ` +
					`(disabled ${disabledCount} of ${apiKeyIds.length} before the failure; disabled rows cannot be restored). ` +
					`The credential store raised an error while disabling the rows (read-only, broker-owned, or a failure after a removal). ` +
					`If a broker owns the credentials, disable them on the broker host with ` +
					`\`gjc auth-broker logout ${providerId}\`, which applies to every credential type stored for this provider on the broker host, including OAuth rows; ` +
					`for a local store, finish with \`gjc accounts logout ${providerId} --all\`, which removes every stored credential for this provider, including OAuth logins, and confirm with \`gjc accounts list\`. ` +
					`The previous provider settings were restored; rows already disabled stay disabled, and rows not confirmed disabled still resolve and remain the provider's credential. ` +
					providerCredentialRecoveryHint(providerId),
				{ cause: error },
			);
		}
	}
	try {
		await store.reload();
	} catch (error) {
		// The disables were attempted; only the confirmation read failed. Rows may
		// in fact be disabled, so this message must not claim a rejected disable.
		throw new CredentialCleanupError(
			`Provider '${providerId}': the store reported ${disabledCount} of ${apiKeyIds.length} stored API key credential(s) disabled, ` +
				`but the confirmation read failed because the credential store could not be re-read. ` +
				`Those rows may in fact be disabled. Confirm with \`gjc accounts list\` (disabled rows are listed as \`disabled\`), ` +
				`then delete them with \`gjc accounts logout ${providerId} --all\`, which removes every stored credential for this provider, including OAuth logins. ` +
				`The previous provider settings were restored; rows already disabled stay disabled, and rows whose disable was not confirmed may still resolve and remain the provider's credential. ` +
				providerCredentialRecoveryHint(providerId),
			{ cause: error },
		);
	}
	const remaining = selectApiKeyRows();
	if (remaining.length > 0) {
		throw new CredentialCleanupError(
			`Provider '${providerId}' kept ${remaining.length} stored API key credential(s) after cleanup: ` +
				`the store accepted the request but they still resolve. Delete them with ` +
				`\`gjc accounts logout ${providerId} --all\`, which removes every stored credential for this provider, including OAuth logins, and confirm with \`gjc accounts list\`. ` +
				`The previous provider settings were restored; rows already disabled stay disabled, and the surviving rows above still resolve and remain the provider's credential. ` +
				providerCredentialRecoveryHint(providerId),
		);
	}
	return disabledCount;
}

async function countStoredApiKeyCredentials(store: ProviderSetupCredentialStore, providerId: string): Promise<number> {
	// Read persisted state: the in-memory snapshot can be ahead of the store.
	await store.reload();
	return store.exportSnapshot().credentials.filter(entry => isStoredApiKeyCredentialForProvider(entry, providerId))
		.length;
}

/**
 * A credential value may reach the network only when the runtime resolver has
 * produced it: empty values and values that are still `!` references are
 * unresolved and must be treated as absent.
 */
function sanitizeResolvedCredentialValue(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	if (!trimmed || trimmed.startsWith("!")) return undefined;
	return trimmed;
}

/**
 * Resolve the stored api_key value a discovery probe may send. The invariant:
 * a stored value reaches the network only when it was resolved by the same
 * resolver the runtime uses. Presence is decided by the shared predicate; the
 * value comes from the store's resolver when it has one, otherwise from the
 * runtime's env-name-or-literal rule. Anything that is still a `!` reference
 * after resolution is unresolved and is treated as absent.
 *
 * This is the only resolution path for both a caller-supplied store and the
 * store setup opens itself.
 */
async function resolveStoredApiKeyValue(
	store: ProviderSetupCredentialStore,
	providerId: string,
): Promise<string | undefined> {
	const rows = store
		.exportSnapshot()
		.credentials.filter(entry => isStoredApiKeyCredentialForProvider(entry, providerId));
	if (rows.length === 0) return undefined;
	let resolved: string | undefined;
	if (store.peekApiKey) {
		try {
			resolved = await store.peekApiKey(providerId);
		} catch {
			// The stored value could not be resolved (for example its command failed).
			return undefined;
		}
	} else {
		const raw = rows[0]!.credential.key.trim();
		// A command reference needs the store's resolver, which this store does not
		// have; the remaining shape is the runtime's env-name-or-literal rule.
		resolved = raw.startsWith("!") ? undefined : process.env[raw] || raw;
	}
	const value = resolved?.trim();
	// Defense in depth for every store provenance: a resolver that returns the
	// reference unchanged has not resolved it.
	return sanitizeResolvedCredentialValue(value);
}

/**
 * One construction for every store setup opens itself. The runtime resolver is
 * injected so stored values and pasted literals resolve exactly as they do at
 * request time (the default resolver treats a `!<command>` value as a literal).
 */
async function createOwnedCredentialStore(): Promise<AuthStorageImpl> {
	const { resolveConfigValue } = await loadConfigValueResolverModule();
	return AuthStorageImpl.create(getAgentDbPath(), { configValueResolver: resolveConfigValue });
}

/**
 * Resolve a pasted literal for the pre-write discovery probe. The value is
 * stored verbatim and resolved by the same resolver at request time, so the
 * probe must resolve it now: a `!<command>` or env-name-shaped paste otherwise
 * diverges from what the runtime would send. Returns `undefined` when the
 * reference cannot be resolved.
 */
async function resolveLiteralApiKeyForProbe(value: string): Promise<string | undefined> {
	const { resolveConfigValue } = await loadConfigValueResolverModule();
	try {
		return sanitizeResolvedCredentialValue(await resolveConfigValue(value));
	} catch {
		return undefined;
	}
}

/**
 * Pick the store a discovery probe resolves through. A caller-supplied store
 * keeps the session's credential ranking (mode and preferences), so it resolves
 * the same row a request would. The store setup opens itself has no session
 * preferences: with multiple active rows it uses the store's default order,
 * which can differ from a session that pins a preferred account. Setup never
 * picks a row itself.
 */
async function resolveStoredApiKeyForProbe(
	providerId: string,
	inputStore: ProviderSetupCredentialStore | undefined,
): Promise<string | undefined> {
	let store = inputStore;
	let ownedStore: AuthStorageImpl | undefined;
	if (!store) {
		ownedStore = await createOwnedCredentialStore();
		store = ownedStore;
	}
	try {
		return await resolveStoredApiKeyValue(store, providerId);
	} finally {
		ownedStore?.close();
	}
}

function assertReplacementEnvResolves(providerId: string, envName: string): void {
	if ($rotatingCredentialEnv(envName)?.trim()) return;
	throw new Error(
		`Cannot replace provider '${providerId}' with apiKeyEnv '${envName}': ${envName} is not set, so its stored API key would still take precedence. ` +
			`Set ${envName} in the trusted environment, then re-run with --force. Nothing was changed.`,
	);
}

function apiForCompatibility(compatibility: ProviderCompatibility): ProviderSetupApi {
	return compatibility === "openai" ? "openai-responses" : "anthropic-messages";
}

function resolvePresetInput(input: ProviderSetupInput): {
	compatibility: ProviderCompatibility;
	preset?: ProviderPreset;
	providerId?: string;
	baseUrl?: string;
	apiKey?: string;
	apiKeyEnv?: string;
	models: readonly string[];
	modelApi?: Readonly<Record<string, ProviderSetupApi>>;
	api: ProviderSetupApi;
	compat?: ProviderCompatConfig;
	discovery?: ProviderDiscovery;
	requestedDiscovery: boolean;
} {
	const preset = input.preset ? findProviderPreset(input.preset) : undefined;
	if (input.preset && !preset) {
		throw new Error(`Unknown provider preset '${input.preset}'. Available presets:\n${formatProviderPresetList()}`);
	}
	if (preset && input.compatibility && input.compatibility !== preset.compatibility) {
		throw new Error(
			`Provider preset '${preset.id}' is ${preset.compatibility}-compatible; omit --compat or use '${preset.compatibility}'.`,
		);
	}
	if (preset && input.baseUrl !== undefined && !preset.parameterized) {
		throw new Error(
			`Provider preset '${preset.id}' uses a fixed base URL; omit --base-url or use --compat openai for a custom provider.`,
		);
	}
	if (preset?.parameterized && !input.baseUrl) {
		throw new Error(
			`Provider preset '${preset.id}' requires --base-url <url> (your proxy endpoint). Use --compat openai for a fully custom provider instead.`,
		);
	}
	if (preset && input.models && input.models.length > 0) {
		const catalogMode =
			preset.models && preset.models.length > 0 ? "uses fixed model ids" : "discovers models automatically";
		throw new Error(
			`Provider preset '${preset.id}' ${catalogMode}; omit --model or use --compat openai for a custom provider.`,
		);
	}
	if (
		preset &&
		input.apiKeyEnv !== undefined &&
		!preset.parameterized &&
		input.apiKeyEnv.trim() !== preset.apiKeyEnv
	) {
		throw new Error(
			`Provider preset '${preset.id}' uses ${preset.apiKeyEnv}; omit --api-key-env or use --compat openai for a custom provider.`,
		);
	}
	const compatibility = preset?.compatibility ?? input.compatibility;
	if (!compatibility) {
		throw new Error("Provider compatibility is required unless --preset is used.");
	}
	if (input.discover && preset) {
		throw new Error(
			`Provider preset '${preset.id}' manages its own model catalog; omit --discover or use --compat openai for a custom provider.`,
		);
	}
	if (input.discover && compatibility !== "openai") {
		throw new Error("Model discovery (--discover) requires an OpenAI-compatible provider; use --compat openai.");
	}
	return {
		compatibility,
		preset,
		providerId: input.providerId ?? preset?.providerId,
		baseUrl: input.baseUrl ?? preset?.baseUrl,
		apiKey: input.apiKey,
		apiKeyEnv: input.apiKeyEnv ?? preset?.apiKeyEnv,
		models: input.models && input.models.length > 0 ? input.models : (preset?.models ?? []),
		modelApi: preset?.modelApi,
		api: preset?.api ?? apiForCompatibility(compatibility),
		compat: preset?.compat,
		discovery: preset?.discovery,
		requestedDiscovery: input.discover === true,
	};
}

export function validateModelApi(
	modelApi: Readonly<Record<string, string>> | undefined,
	models: readonly string[],
	presetId: string,
): void {
	if (!modelApi) return;
	const modelSet = new Set(models);
	const validApis: readonly string[] = ["openai-responses", "openai-completions", "anthropic-messages"];
	for (const [key, value] of Object.entries(modelApi)) {
		if (!modelSet.has(key)) {
			throw new Error(`Provider preset '${presetId}' declares modelApi for unknown model '${key}'.`);
		}
		if (!validApis.includes(value)) {
			throw new Error(
				`Provider preset '${presetId}' declares invalid modelApi value '${value}' for model '${key}'.`,
			);
		}
	}
}

function validateSetupInput(input: ProviderSetupInput): {
	providerId: string;
	baseUrl: string;
	apiKey: string;
	credentialSource: ProviderSetupResult["credentialSource"];
	models: string[];
	compatibility: ProviderCompatibility;
	api: ProviderSetupApi;
	compat?: ProviderCompatConfig;
	modelApi?: Readonly<Record<string, ProviderSetupApi>>;
	discovery?: ProviderDiscovery;
	preset?: ProviderPreset;
} {
	const resolved = resolvePresetInput(input);
	if (!resolved.providerId) throw new Error("Provider id is required.");
	if (!resolved.baseUrl) throw new Error("Base URL is required.");
	const providerId = normalizeProviderId(resolved.providerId);
	if (!PROVIDER_ID_PATTERN.test(providerId)) {
		throw new Error("Provider id must use lowercase letters, numbers, dots, underscores, or hyphens.");
	}

	const baseUrl = resolved.baseUrl.trim();
	let url: URL;
	try {
		url = new URL(baseUrl);
	} catch {
		throw new Error("Base URL must be a valid absolute URL.");
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		throw new Error("Base URL must use http or https.");
	}
	if (url.protocol === "http:" && !isLocalHttpHost(url.hostname)) {
		throw new Error("Base URL must use https unless it targets localhost or a loopback address.");
	}

	const apiKeyEnv = resolved.apiKeyEnv?.trim();
	if (apiKeyEnv) {
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) {
			throw new Error("API key environment variable must be a valid environment variable name.");
		}
	}
	const apiKey = apiKeyEnv ?? resolved.apiKey?.trim() ?? "";
	if (!apiKey) throw new Error("API key is required.");

	const models = parseModelList(resolved.models);
	// An explicit `--discover` on an OpenAI-compatible custom provider persists
	// `discovery: { type: openai-models-list }`, which the runtime also
	// auto-enables — so manual models become optional rather than required.
	const discovery: ProviderDiscovery | undefined =
		resolved.discovery ?? (resolved.requestedDiscovery ? { type: "openai-models-list" } : undefined);
	if (models.length === 0 && !discovery)
		throw new Error("At least one model id or model discovery is required. Use --model <id> or --discover.");
	validateModelApi(resolved.modelApi, models, resolved.preset?.id ?? resolved.providerId);

	return {
		providerId,
		baseUrl,
		apiKey,
		credentialSource: apiKeyEnv ? "env" : "literal",
		models,
		compatibility: resolved.compatibility,
		api: resolved.api,
		modelApi: resolved.modelApi,
		compat: resolved.compat,
		discovery,
		preset: resolved.preset,
	};
}

async function readModelsConfig(modelsPath: string): Promise<ModelsConfig> {
	// The guard and the parse mode stay coupled: setup only writes YAML, and
	// this reader only parses YAML, so an unsupported extension fails here
	// before either half can drift.
	assertModelsConfigPath(modelsPath);
	const file = Bun.file(modelsPath);
	if (!(await file.exists())) return {};
	const text = (await file.text()).trim();
	if (!text) return {};
	const parsed = YAML.parse(text);
	const checked = ModelsConfigSchema.safeParse(parsed);
	if (!checked.success) {
		const first = checked.error.issues[0];
		const where = first?.path.length ? `/${first.path.map(String).join("/")}` : "root";
		throw new Error(`Existing models config is invalid at ${where}: ${first?.message ?? "unknown schema error"}`);
	}
	return checked.data;
}

async function writeModelsConfig(
	modelsPath: string,
	config: ModelsConfig,
	signal?: AbortSignal,
	options: { bypassSemanticValidation?: boolean } = {},
): Promise<void> {
	const checked = ModelsConfigSchema.safeParse(config);
	if (!checked.success) {
		const first = checked.error.issues[0];
		const where = first?.path.length ? `/${first.path.map(String).join("/")}` : "root";
		throw new Error(`Generated models config is invalid at ${where}: ${first?.message ?? "unknown schema error"}`);
	}
	// The runtime loader applies semantic rules the zod schema cannot express.
	// Run the loader's own validator before the atomic rename so setup never
	// commits a file the product itself rejects. Restores bypass that check:
	// after pre-rename validation the only reachable restore follows a
	// concurrent external write, and restoring the prior document's semantics
	// must not be refused merely because that document is already unloadable.
	// The restore is re-serialized from the parsed config like every write, so
	// comments and key order from the previous file are not preserved.
	if (!options.bypassSemanticValidation) {
		const { validateModelsConfig } = await loadModelRegistryModule();
		validateModelsConfig(checked.data);
	}
	const directory = path.dirname(modelsPath);
	await fs.mkdir(directory, { recursive: true });
	const tempPath = path.join(directory, `.${path.basename(modelsPath)}.${process.pid}.${randomUUID()}.tmp`);
	try {
		const tempHandle = await fs.open(tempPath, "wx", 0o600);
		try {
			await tempHandle.writeFile(YAML.stringify(checked.data, null, 2), "utf8");
			await tempHandle.sync();
		} finally {
			await tempHandle.close();
		}
		// Rename is the commit boundary. Cancellation after it cannot undo the saved provider.
		if (signal?.aborted) throw new Error("Provider setup was cancelled; setup did not write any config.");
		await fs.rename(tempPath, modelsPath);
		try {
			const directoryHandle = await fs.open(directory, "r");
			try {
				await directoryHandle.sync();
			} finally {
				await directoryHandle.close();
			}
		} catch {
			// Directory fsync is unavailable on some filesystems; the replacement succeeded.
		}
	} finally {
		await fs.rm(tempPath, { force: true }).catch(() => undefined);
	}
}

export async function addApiCompatibleProvider(input: ProviderSetupInput): Promise<ProviderSetupResult> {
	const validated = validateSetupInput(input);
	const modelsPath = input.modelsPath ?? getDefaultModelsPath();
	assertModelsConfigPath(modelsPath);
	// Evaluate the lazily imported registry module before taking the file lock:
	// module evaluation has nothing to do with the config transaction and must
	// not extend cross-process lock hold time.
	await loadModelRegistryModule();
	const existing = await readModelsConfig(modelsPath);
	if (existing.providers?.[validated.providerId] && !input.force) {
		throw new Error(`Provider '${validated.providerId}' already exists. Use --force to replace it.`);
	}
	// Cleanup only exists for a store-declared entry being switched to an env
	// reference; anything else keeps its stored credential. The replacement env
	// must also resolve, otherwise deleting the key would leave no credential.
	const willRemoveStoredKey =
		validated.credentialSource === "env" &&
		input.force === true &&
		existing.providers?.[validated.providerId]?.credential === PROVIDER_CREDENTIAL_STORE;
	if (willRemoveStoredKey) assertReplacementEnvResolves(validated.providerId, validated.apiKey);
	// P2: a discovery-only add with no manual models must prove the endpoint
	// serves a catalog before config is written — otherwise an unreachable
	// endpoint or rejected credential would be recorded as configured while
	// the provider can never serve a model. Manual-model adds skip the probe
	// (the static list degrades gracefully). The check runs after the
	// duplicate check above so a duplicate is rejected locally before any
	// credential crosses the network.
	// Only explicitly requested custom `--discover` setups are probe-gated.
	// Preset-managed discovery (goat, litellm, openai-compatible-proxy, ...)
	// keeps its documented contract — presets write env-var references and
	// never validate live credentials — so preset adds skip the probe and
	// resolve their catalog lazily at runtime as before.
	if (validated.discovery?.type === "openai-models-list" && validated.models.length === 0 && !validated.preset) {
		const probe = input.probeDiscovery ?? probeOpenAIModelsList;
		const credentialSource = validated.credentialSource;
		// Probe with the credential the runtime will resolve after this write. A
		// stored api_key is dropped only for the store->env replacement above;
		// otherwise it survives and outranks the env indirection (#5387).
		const storedApiKey =
			credentialSource === "env" && !willRemoveStoredKey
				? await resolveStoredApiKeyForProbe(validated.providerId, input.authStorage)
				: undefined;
		// A pasted literal is stored verbatim and resolved by the runtime resolver
		// at request time, so the probe must resolve it now instead of sending a
		// `!<command>` or env-name reference.
		const literalApiKey =
			credentialSource === "literal" ? await resolveLiteralApiKeyForProbe(validated.apiKey) : undefined;
		if (credentialSource === "literal" && literalApiKey === undefined) {
			throw new Error(
				`Provider '${validated.providerId}' credential could not be resolved for model discovery: the pasted value is a command or environment reference that does not resolve. ` +
					`Paste the key value itself, or pass \`--api-key-env <ENV>\` instead. No config or credential was written.`,
			);
		}
		const probed = await probe({
			baseUrl: validated.baseUrl,
			apiKeyEnv: credentialSource === "env" && !storedApiKey ? validated.apiKey : undefined,
			apiKey: credentialSource === "literal" ? literalApiKey : storedApiKey,
			signal: input.discoverySignal,
		});
		// The caller (wizard revision/cancel) may have aborted while the probe
		// was resolving: recheck before any credential or config write so a
		// stale revision cannot be persisted after dismissal.
		if (input.discoverySignal?.aborted) {
			throw new Error(
				`Model discovery for '${validated.providerId}' was cancelled; setup did not write any config.`,
			);
		}
		if (probed.models.length === 0) {
			throw new Error(
				`Model discovery for '${validated.providerId}' returned no models; add --model <id> or fix the endpoint catalog.`,
			);
		}
	}
	const provider: ProviderConfig = {
		baseUrl: validated.baseUrl,
		api: validated.api,
		auth: "apiKey",
		...(validated.models.length > 0
			? {
					models: validated.models.map(id => {
						const api = validated.modelApi?.[id];
						return api ? { id, api } : { id };
					}),
				}
			: {}),
	};
	if (validated.compat) provider.compat = validated.compat;
	if (validated.discovery) provider.discovery = validated.discovery;
	if (validated.credentialSource === "env") {
		provider.apiKeyEnv = validated.apiKey;
	} else {
		// The literal key is published to the credential store below; the config
		// only declares that the credential lives there. Without the declaration
		// the loader rejects this brand-new provider as credential-less.
		provider.credential = PROVIDER_CREDENTIAL_STORE;
	}
	// Serialize config merging under the file lock. Credential storage is a
	// separate authority, not an atomic transaction with models.yml. Publish the
	// new config first and only then update the credential authority so a live
	// session can never send a replacement key to the old base URL.
	type CredentialStore = ProviderSetupCredentialStore;
	const cancelledError = (): Error =>
		new Error(`Model discovery for '${validated.providerId}' was cancelled; setup did not write any config.`);
	// A cancellable replacement must not overwrite OAuth rows that cannot be
	// restored from the redacted snapshot. The check is read-only and happens
	// before the config commit; credentials are never rolled back after a
	// concurrent writer can have changed them.
	const hasUnrestorableCredentials = (store: CredentialStore): boolean => {
		const storageProvider = resolveOAuthStorageProvider(validated.providerId);
		const priorEntries = store.exportSnapshot().credentials.filter(entry => entry.provider === storageProvider);
		return priorEntries.some(entry => entry.credential.type !== "api_key");
	};
	const withCredentialStore = async (fn: (store: CredentialStore) => Promise<void>): Promise<void> => {
		if (input.authStorage) {
			await fn(input.authStorage);
			return;
		}
		// Same construction as the probe path. Today no write-path call resolves a
		// stored value, but sharing the construction keeps value resolution in one
		// place if one ever does.
		const authStorage = await createOwnedCredentialStore();
		try {
			await fn(authStorage);
		} finally {
			authStorage.close();
		}
	};
	const credentialUpdate =
		validated.credentialSource === "env" ? "disable the previous stored API key" : "publish credentials";
	let credentialCleanup: ProviderSetupResult["credentialCleanup"];
	let storedCredentialShadow: ProviderSetupResult["storedCredentialShadow"];
	let storedCredentialShadowUnverified: ProviderSetupResult["storedCredentialShadowUnverified"];
	let replacementCleanedStoredKeys = false;
	await withFileLock(modelsPath, async () => {
		if (input.discoverySignal?.aborted) {
			throw cancelledError();
		}
		const current = await readModelsConfig(modelsPath);
		if (input.discoverySignal?.aborted) throw cancelledError();
		if (current.providers?.[validated.providerId] && !input.force) {
			throw new Error(`Provider '${validated.providerId}' already exists. Use --force to replace it.`);
		}
		// Cleanup only exists for one case: the entry being replaced declared
		// `credential: store` and is now switched to an env reference. A provider
		// that was env-pinned or hand-configured keeps its stored credential.
		const replacedEntry = current.providers?.[validated.providerId];
		const replacingStoreBackedEntry =
			validated.credentialSource === "env" &&
			input.force === true &&
			replacedEntry?.credential === PROVIDER_CREDENTIAL_STORE;
		if (replacingStoreBackedEntry) assertReplacementEnvResolves(validated.providerId, validated.apiKey);
		if (validated.credentialSource !== "env" && input.discoverySignal) {
			await withCredentialStore(async store => {
				if (hasUnrestorableCredentials(store)) {
					throw new Error(
						`Provider '${validated.providerId}' holds non-API-key credentials that cannot be restored if setup is cancelled; remove them first or omit --force.`,
					);
				}
			});
		}
		if (input.discoverySignal?.aborted) throw cancelledError();
		const configExistedBeforeCommit = await Bun.file(modelsPath).exists();
		let configCommitted = false;
		try {
			await writeModelsConfig(
				modelsPath,
				{
					...current,
					providers: {
						...(current.providers ?? {}),
						[validated.providerId]: provider,
					},
				},
				input.discoverySignal,
			);
			configCommitted = true;
			// Verify the just-written config through the loader before touching the
			// credential authority: a disagreement rolls back cleanly with no
			// credential change instead of stranding a committed config whose stored
			// key was already disabled.
			await assertWrittenModelsConfigLoads(modelsPath, validated.providerId);
			// Cancellation after the atomic config rename cannot undo the saved
			// provider. Finish publishing the matching literal credential even if
			// the caller dismissed the wizard during the rename.
			if (validated.credentialSource !== "env") {
				await withCredentialStore(store =>
					store.set(validated.providerId, { type: "api_key", key: validated.apiKey }),
				);
			} else if (replacingStoreBackedEntry) {
				replacementCleanedStoredKeys = true;
				// A stored api_key outranks an apiKeyEnv indirection, so replacing a
				// store-backed provider with an env-backed one must disable the old
				// literal rows; OAuth rows are never touched. The cleanup re-reads the
				// store and fails loudly if the rows still resolve.
				await withCredentialStore(async store => {
					const disabledApiKeys = await removeStoredApiKeyCredentials(store, validated.providerId);
					credentialCleanup = disabledApiKeys > 0 ? { disabledApiKeys, envName: validated.apiKey } : undefined;
				});
			}
		} catch (error) {
			if (configCommitted) {
				try {
					if (configExistedBeforeCommit)
						await writeModelsConfig(modelsPath, current, undefined, { bypassSemanticValidation: true });
					else await fs.rm(modelsPath, { force: true });
				} catch {
					// Store/config errors can contain credentials; never log or
					// interpolate them. Log independently of the wizard, which may
					// already be dismissed.
					const message = `Provider '${validated.providerId}' setup failed while updating credentials and could not restore the previous provider settings; credential recovery is required.`;
					logger.error(message);
					throw new Error(message, { cause: error });
				}
				// A cleanup failure already explains rollback and recovery; do not
				// replace it with the generic credential-update message.
				if (error instanceof CredentialCleanupError) throw error;
				// The written config never loaded, so nothing credential-related ran;
				// keep the loader's detail and add the rollback outcome.
				if (error instanceof WrittenModelsConfigLoadError) {
					throw new WrittenModelsConfigLoadError(
						`${error.message} Setup restored the previous provider settings and did not change any credential. ` +
							`Fix the config, then re-run setup (adding --force if the provider already exists).`,
					);
				}
				throw new Error(
					`Provider '${validated.providerId}' setup could not ${credentialUpdate}; the previous provider settings were restored.`,
				);
			}
			throw error;
		}
	});
	// An env reference only supplies the key when nothing else outranks it. If
	// cleanup did not run (the replaced entry never declared credential: store),
	// disclose any stored api_key rows instead of claiming the env var wins.
	if (validated.credentialSource === "env" && !replacementCleanedStoredKeys) {
		try {
			await withCredentialStore(async store => {
				const storedApiKeys = await countStoredApiKeyCredentials(store, validated.providerId);
				if (storedApiKeys > 0) {
					storedCredentialShadow = { storedApiKeys, envName: validated.apiKey };
				}
			});
		} catch (error) {
			// Never fail the add for this: the provider and its env reference are
			// already committed and valid. Disclose the unverified risk instead of
			// reporting unconditional success, since a stored key would still win.
			storedCredentialShadowUnverified = { envName: validated.apiKey };
			logger.warn("could not inspect stored credentials after provider setup", {
				provider: validated.providerId,
				error: error instanceof Error ? error.name : typeof error,
			});
		}
	}
	return {
		providerId: validated.providerId,
		compatibility: validated.compatibility,
		api: validated.api,
		baseUrl: validated.baseUrl,
		modelIds: validated.models,
		modelsPath,
		redactedApiKey: redactSecret(validated.apiKey),
		credentialSource: validated.credentialSource,
		discoveryEnabled: validated.discovery !== undefined,
		discoveryType: validated.discovery?.type,
		preset: validated.preset?.id,
		presetName: validated.preset?.name,
		...(credentialCleanup ? { credentialCleanup } : {}),
		...(storedCredentialShadow ? { storedCredentialShadow } : {}),
		...(storedCredentialShadowUnverified ? { storedCredentialShadowUnverified } : {}),
	};
}

/**
 * Raised when the provider setup just wrote does not load through the
 * runtime's own loader. Thrown before any credential mutation, so the caller
 * can roll the config back without a credential change.
 */
class WrittenModelsConfigLoadError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WrittenModelsConfigLoadError";
	}
}

/**
 * Reload the just-written models config through the same loader the runtime
 * uses. Setup must never report success for a file the product rejects, even
 * if every pre-write check passed. This runs before the credential mutation,
 * so a failure can be rolled back without leaving a stored key behind.
 */
async function assertWrittenModelsConfigLoads(modelsPath: string, providerId: string): Promise<void> {
	const { ModelsConfigFile } = await loadModelRegistryModule();
	const configFile = ModelsConfigFile.relocate(modelsPath);
	// For the default agent path `relocate` returns the process-wide singleton a
	// live session already loaded (commonly `not-found` before the first add).
	// Drop that snapshot so the verdict reads the bytes just committed.
	configFile.invalidate();
	const loaded = configFile.tryLoad();
	if (loaded.status === "ok") return;
	const detail = loaded.status === "error" ? String(loaded.error) : `the file does not exist at ${modelsPath}`;
	throw new WrittenModelsConfigLoadError(
		`Provider '${providerId}' was written to ${modelsPath}, but the models config does not load: ${detail}.`,
	);
}

/**
 * Post-refresh guard for setup callers that reload through a live registry.
 * `refresh` re-reads the written config, so a loader error there means the
 * provider is unusable even though setup wrote it.
 */
export function assertProviderConfigLoaded(
	registry: { getError(): { id: string; message: string } | undefined },
	providerId: string,
	modelsPath: string,
	credentialSource: ProviderSetupResult["credentialSource"],
): void {
	const error = registry.getError();
	// getError() also reports accepted model-preset registry failures. Only a
	// models-config failure makes the provider setup itself unusable.
	if (error?.id !== "models") return;
	// The credential is not in models.yml either way; say which location applies
	// instead of claiming a credential was written there.
	const credentialLocation =
		credentialSource === "literal"
			? "its API key was written to the credential store, not to models.yml"
			: "its apiKeyEnv reference is in models.yml and the key itself stays in the environment";
	throw new Error(
		`Provider '${providerId}' was written to ${modelsPath} (${credentialLocation}), but the models config did not load: ${error.message}. ` +
			`Fix the config, then re-run setup with --force to replace the provider.`,
	);
}

function isLocalHttpHost(hostname: string): boolean {
	const normalized = hostname.toLowerCase().replace(/^\[(.*)]$/, "$1");
	return (
		normalized === "localhost" ||
		normalized === "127.0.0.1" ||
		normalized === "::1" ||
		normalized.endsWith(".localhost") ||
		/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(normalized)
	);
}

export interface ProviderDiscoveryProbeInput {
	baseUrl: string;
	apiKeyEnv?: string;
	apiKey?: string;
	timeoutMs?: number;
	signal?: AbortSignal;
}

export interface ProviderDiscoveryProbeResult {
	models: string[];
	endpoint: string;
}

function redactProbeUrl(value: URL): string {
	return `${value.origin}${value.pathname}`;
}

function normalizeProbeBaseUrl(rawBaseUrl: string): URL {
	const parsed = new URL(rawBaseUrl.trim());
	const trimmedPath = parsed.pathname.replace(/\/+$/g, "");
	parsed.pathname = trimmedPath.endsWith("/v1") ? trimmedPath || "/v1" : `${trimmedPath}/v1`;
	parsed.hash = "";
	return parsed;
}

/**
 * Probe an OpenAI-compatible `/v1/models` endpoint and return the sorted
 * model ids. Used by the Add-custom-provider wizard so gateway catalogs
 * (LiteLLM and friends) do not need manual transcription.
 *
 * Credential handling: an `apiKeyEnv` name resolves through the trusted
 * credential env only (never `cwd/.env`); a literal `apiKey` is used as-is.
 * Errors name the redacted endpoint only — the key material never appears
 * in messages, and callers must not log the request headers.
 */
export async function probeOpenAIModelsList(input: ProviderDiscoveryProbeInput): Promise<ProviderDiscoveryProbeResult> {
	let baseUrl: URL;
	try {
		baseUrl = normalizeProbeBaseUrl(input.baseUrl);
	} catch {
		throw new Error("Model discovery needs a valid absolute base URL before probing.");
	}
	if (baseUrl.protocol !== "https:" && baseUrl.protocol !== "http:") {
		throw new Error("Model discovery needs an http or https base URL.");
	}
	// P1: never transmit the bearer before the URL passes the same
	// HTTPS-unless-loopback validation that setup itself enforces — a remote
	// http:// URL must be rejected before any secret crosses the network.
	if (baseUrl.protocol === "http:" && !isLocalHttpHost(baseUrl.hostname)) {
		throw new Error("Model discovery needs https unless the endpoint targets localhost or a loopback address.");
	}
	const modelsUrl = new URL(baseUrl);
	modelsUrl.pathname = `${modelsUrl.pathname.replace(/\/+$/g, "")}/models`;
	const endpoint = redactProbeUrl(modelsUrl);
	if (input.signal?.aborted) {
		throw new Error(`Model discovery for ${endpoint} was cancelled before probing.`);
	}
	// Rotating reader (same as the model registry): an agent-.env credential
	// rotated or removed after startup must be honored live, not served from
	// the import-time snapshot.
	const apiKey = input.apiKeyEnv ? $rotatingCredentialEnv(input.apiKeyEnv)?.trim() : input.apiKey?.trim();
	if (!apiKey) {
		throw new Error(
			input.apiKeyEnv
				? `Discovery needs ${input.apiKeyEnv} set in the trusted environment before ${endpoint} can be probed.`
				: `Discovery needs an API key before ${endpoint} can be probed.`,
		);
	}
	const headers: Record<string, string> = {};
	let response: Response;
	try {
		response = await fetch(modelsUrl, {
			headers: { ...headers, Authorization: `Bearer ${apiKey}` },
			// Combine the caller signal with the shared deadline: a caller
			// signal alone must never leave the request without a timeout.
			signal: AbortSignal.any([
				...(input.signal ? [input.signal] : []),
				AbortSignal.timeout(input.timeoutMs ?? MODELS_LIST_REQUEST_TIMEOUT_MS),
			]),
		});
	} catch (error) {
		// Transport layers may echo request details (including the bearer)
		// in failure text: scrub resolved credential material before the
		// reason reaches any error surface.
		const reason = error instanceof Error ? error.message : String(error);
		const scrubbed = apiKey ? reason.split(apiKey).join("[redacted]") : reason;
		throw new Error(`Model discovery failed for ${endpoint}: ${scrubbed}`);
	}
	if (!response.ok) {
		if (response.status === 401 || response.status === 403) {
			throw new Error(
				`Model discovery rejected by ${endpoint} (HTTP ${response.status}): the credential was rejected; check the API key.`,
			);
		}
		throw new Error(`Model discovery failed for ${endpoint}: HTTP ${response.status}.`);
	}
	// Shared bounded reader (1MB cap): an unbounded response.json() would let
	// a malicious endpoint exhaust process memory before ID filtering runs.
	let payload: unknown;
	try {
		payload = await readBoundedModelsJson(response);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		if (reason.includes("exceeds the size limit")) {
			throw new Error(`Model discovery failed for ${endpoint}: the response exceeds the size limit.`);
		}
		throw new Error(`Model discovery failed for ${endpoint}: the response was not valid JSON.`);
	}
	if (typeof payload !== "object" || payload === null || !Array.isArray((payload as { data?: unknown }).data)) {
		throw new Error(`Model discovery failed for ${endpoint}: the response was not an OpenAI models list.`);
	}
	const ids = new Set<string>();
	for (const item of (payload as { data: unknown[] }).data) {
		// P1: the wire catalog is attacker-controlled — drop IDs that fail the
		// shared catalog safety check (control chars, OSC/ANSI, oversize)
		// before they can reach the setup-screen renderer.
		const rawId = typeof item === "object" && item !== null ? (item as { id?: unknown }).id : undefined;
		if (!isSafeCatalogModelId(rawId)) continue;
		ids.add(rawId.trim());
	}
	return { models: [...ids].sort((a, b) => a.localeCompare(b)), endpoint };
}

export interface DiscoveryCatalogRefresher {
	refresh(mode: "offline" | "online" | "online-if-uncached", credentialSessionId?: string): Promise<void>;
	refreshProvider(
		providerId: string,
		strategy?: "offline" | "online" | "online-if-uncached",
		credentialSessionId?: string,
	): Promise<void>;
	getProviderDiscoveryState(providerId: string): { status: string; error?: string } | undefined;
}

/**
 * Reload static config offline, then refresh only the newly added discovery
 * provider online so freshly requested live catalogs are selectable
 * immediately (including alongside manual models). Preset-managed
 * discovery is excluded by callers: presets resolve lazily at runtime.
 * Returns a recovery hint instead of reporting unconditional success when
 * the live catalog stays unavailable: the config is saved and valid, but
 * the user needs to know the catalog did not populate and how to recover
 * (wait for the next refresh, or re-add with explicit `--model` ids).
 */
export async function reloadAndRefreshDiscoveryCatalog(
	registry: DiscoveryCatalogRefresher,
	providerId: string,
	credentialSessionId?: string,
): Promise<string | null> {
	await registry.refresh("offline", credentialSessionId);
	try {
		await registry.refreshProvider(providerId, "online", credentialSessionId);
	} catch {
		// Fall through to the status read: discovery failures surface as
		// state, not rejections.
	}
	const state = registry.getProviderDiscoveryState(providerId);
	if (state?.status === "ok") return null;
	const detail = state?.error ? ` (${state.error})` : "";
	return (
		`Live catalog unavailable${detail}; the provider is saved and will populate on the next online refresh. ` +
		`To pin models now, re-add with --force --model <id> (the provider already exists).`
	);
}

/**
 * Render the success banner. Only call this after the written config has been
 * verified to load: `addApiCompatibleProvider` re-reads the file it wrote, and
 * registry-backed callers re-check `modelRegistry.getError()` after their
 * post-write refresh. On any load failure the setup path must throw instead.
 */
export function formatProviderSetupResult(result: ProviderSetupResult): string {
	return [
		`Provider '${result.providerId}' configured as ${result.compatibility}-compatible.`,
		...(result.presetName ? [`Preset: ${result.presetName}`] : []),
		`Models: ${result.modelIds.length > 0 ? result.modelIds.join(", ") : result.discoveryEnabled ? "discovered automatically" : "(none)"}`,
		...(result.discoveryEnabled
			? [
					result.discoveryType === "openai-models-list"
						? "Discovery: live OpenAI /v1/models catalog"
						: `Discovery: live ${result.discoveryType ?? "provider"} catalog`,
				]
			: []),
		`Base URL: ${result.baseUrl}`,
		`API key: ${result.credentialSource === "env" ? `${result.redactedApiKey} (environment variable)` : result.redactedApiKey}`,
		...(result.credentialCleanup
			? [
					`Stored API key: disabled ${result.credentialCleanup.disabledApiKeys} stored credential(s) for this provider; they no longer resolve and ${result.credentialCleanup.envName} now supplies the key. Delete them permanently with: gjc accounts logout ${result.providerId} --all (removes every stored credential for this provider, including OAuth logins)`,
				]
			: []),
		...(result.storedCredentialShadow
			? [
					`Warning: ${result.storedCredentialShadow.storedApiKeys} stored API key credential(s) for this provider take precedence over ${result.storedCredentialShadow.envName}. Remove them with: gjc accounts logout ${result.providerId} --all (removes every stored credential for this provider, including OAuth logins); with a broker configuration run gjc auth-broker logout ${result.providerId} on the broker host instead (same breadth)`,
				]
			: []),
		...(result.storedCredentialShadowUnverified
			? [
					`Warning: setup could not check the credential store for stored API key credentials; if any exist they would still take precedence over ${result.storedCredentialShadowUnverified.envName}. Verify with: gjc accounts list`,
				]
			: []),
		`Config: ${result.modelsPath}`,
	].join("\n");
}
