import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type AuthStorage, resolveOAuthStorageProvider } from "@gajae-code/ai/core";
import {
	isSafeCatalogModelId,
	MODELS_LIST_REQUEST_TIMEOUT_MS,
	readBoundedModelsJson,
} from "@gajae-code/ai/utils/discovery/openai-compatible";
import { getAgentDbPath, getAgentDir, logger } from "@gajae-code/utils";
import { $rotatingCredentialEnv } from "@gajae-code/utils/env";
import { YAML } from "bun";
import { withFileLock } from "../config/file-lock";
import { type ModelsConfig, ModelsConfigSchema, type ProviderDiscovery } from "../config/models-config-schema";
import { compareRankedProviders, famousProviderIndex } from "../config/provider-ranking";
import { AuthStorage as AuthStorageImpl } from "../session/auth-storage";
import providerPresets from "./provider-presets.json";

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
	authStorage?: Pick<AuthStorage, "set" | "remove" | "exportSnapshot">;
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
}

type ProviderConfig = NonNullable<NonNullable<ModelsConfig["providers"]>[string]>;
type ProviderCompatConfig = NonNullable<ProviderConfig["compat"]>;

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
const REDACT_PREFIX = 4;
const REDACT_SUFFIX = 4;
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

export function redactSecret(secret: string): string {
	const trimmed = secret.trim();
	if (trimmed.length <= REDACT_PREFIX + REDACT_SUFFIX) return "***";
	return `${trimmed.slice(0, REDACT_PREFIX)}…${trimmed.slice(-REDACT_SUFFIX)}`;
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
	const file = Bun.file(modelsPath);
	if (!(await file.exists())) return {};
	const text = (await file.text()).trim();
	if (!text) return {};
	const parsed = modelsPath.endsWith(".json") || modelsPath.endsWith(".jsonc") ? JSON.parse(text) : YAML.parse(text);
	const checked = ModelsConfigSchema.safeParse(parsed);
	if (!checked.success) {
		const first = checked.error.issues[0];
		const where = first?.path.length ? `/${first.path.map(String).join("/")}` : "root";
		throw new Error(`Existing models config is invalid at ${where}: ${first?.message ?? "unknown schema error"}`);
	}
	return checked.data;
}

async function writeModelsConfig(modelsPath: string, config: ModelsConfig, signal?: AbortSignal): Promise<void> {
	const checked = ModelsConfigSchema.safeParse(config);
	if (!checked.success) {
		const first = checked.error.issues[0];
		const where = first?.path.length ? `/${first.path.map(String).join("/")}` : "root";
		throw new Error(`Generated models config is invalid at ${where}: ${first?.message ?? "unknown schema error"}`);
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
	const existing = await readModelsConfig(modelsPath);
	if (existing.providers?.[validated.providerId] && !input.force) {
		throw new Error(`Provider '${validated.providerId}' already exists. Use --force to replace it.`);
	}
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
		const probed = await probe({
			baseUrl: validated.baseUrl,
			apiKeyEnv: credentialSource === "env" ? validated.apiKey : undefined,
			apiKey: credentialSource === "literal" ? validated.apiKey : undefined,
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
	}
	// Serialize config merging under the file lock. Credential storage is a
	// separate authority, not an atomic transaction with models.yml: restore
	// successful credential writes on precommit failure and report failed recovery.
	type CredentialStore = Pick<AuthStorage, "set" | "remove" | "exportSnapshot">;
	type ApiKeyEntry = { type: "api_key"; key: string };
	const cancelledError = (): Error =>
		new Error(`Model discovery for '${validated.providerId}' was cancelled; setup did not write any config.`);
	// Snapshot the complete prior credential entries so a `--force`
	// replacement cancelled mid-write restores them exactly instead of
	// deleting them while the old models.yml provider remains. A
	// resolved-key snapshot is insufficient: the provider may hold multiple
	// entries, OAuth credentials, or env-resolved keys that were never
	// stored. Non-api_key entries cannot be restored from a snapshot
	// (refresh material is sentinelized), so refuse those replacements
	// upfront rather than destroying them on abort.
	const snapshotRestorableKeys = (store: CredentialStore): { restorable: ApiKeyEntry[]; unrestorable: number } => {
		const storageProvider = resolveOAuthStorageProvider(validated.providerId);
		const priorEntries = store.exportSnapshot().credentials.filter(entry => entry.provider === storageProvider);
		const restorable = priorEntries
			.filter((entry): entry is typeof entry & { credential: ApiKeyEntry } => entry.credential.type === "api_key")
			.map(entry => entry.credential);
		return { restorable, unrestorable: priorEntries.length - restorable.length };
	};
	const rollbackCredential = async (store: CredentialStore, restorable: ApiKeyEntry[]): Promise<void> => {
		if (restorable.length > 0) {
			await store.set(validated.providerId, restorable);
		} else {
			await store.remove(validated.providerId);
		}
	};
	const withCredentialStore = async (fn: (store: CredentialStore) => Promise<void>): Promise<void> => {
		if (input.authStorage) {
			await fn(input.authStorage);
			return;
		}
		const authStorage = await AuthStorageImpl.create(getAgentDbPath());
		try {
			await fn(authStorage);
		} finally {
			authStorage.close();
		}
	};
	await withFileLock(modelsPath, async () => {
		if (input.discoverySignal?.aborted) {
			throw cancelledError();
		}
		const current = await readModelsConfig(modelsPath);
		if (input.discoverySignal?.aborted) throw cancelledError();
		if (current.providers?.[validated.providerId] && !input.force) {
			throw new Error(`Provider '${validated.providerId}' already exists. Use --force to replace it.`);
		}
		let restorable: ApiKeyEntry[] = [];
		let unrestorable = 0;
		let wroteKey = false;
		try {
			if (validated.credentialSource !== "env") {
				await withCredentialStore(async store => {
					const snapshot = snapshotRestorableKeys(store);
					restorable = snapshot.restorable;
					unrestorable = snapshot.unrestorable;
					if (snapshot.unrestorable > 0 && input.discoverySignal) {
						throw new Error(
							`Provider '${validated.providerId}' holds non-API-key credentials that cannot be restored if setup is cancelled; remove them first or omit --force.`,
						);
					}
					await store.set(validated.providerId, { type: "api_key", key: validated.apiKey });
					wroteKey = true;
				});
			}
			if (input.discoverySignal?.aborted) throw cancelledError();
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
		} catch (error) {
			if (wroteKey) {
				try {
					if (unrestorable > 0) throw new Error("Prior credentials cannot be restored from a snapshot.");
					await withCredentialStore(store => rollbackCredential(store, restorable));
				} catch {
					// Store errors can contain credentials; never log or interpolate them.
					// Log independently of the wizard, which may already be dismissed.
					const recovery =
						restorable.length > 0 || unrestorable > 0 ? "restore prior credentials" : "remove new credentials";
					const message = `Provider '${validated.providerId}' setup failed before config commit and could not ${recovery}; credential recovery is required.`;
					logger.error(message);
					throw new Error(message, { cause: error });
				}
			}
			throw error;
		}
	});
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
	};
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
	if (state && (state.status === "ok" || state.status === "cached")) return null;
	const detail = state?.error ? ` (${state.error})` : "";
	return (
		`Live catalog unavailable${detail}; the provider is saved and will populate on the next online refresh. ` +
		`To pin models now, re-add with --force --model <id> (the provider already exists).`
	);
}

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
		`Config: ${result.modelsPath}`,
	].join("\n");
}
