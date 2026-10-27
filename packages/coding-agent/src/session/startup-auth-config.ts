/**
 * Read the global startup-auth configuration before Settings is initialized.
 *
 * The config file is canonical nested YAML only. Legacy literal dotted auth keys
 * are rejected with a manual rewrite diagnostic; no compatibility migration is
 * performed. Environment values are trusted credential sources and take
 * precedence over global config values.
 */

import * as os from "node:os";
import * as path from "node:path";
import type {
	AuthCredentialSelector,
	ConfiguredCredentialPreference,
	CredentialRankingMode,
} from "@gajae-code/ai/core";
import { $credentialEnv, getAgentDbPath, getAgentDir, getConfigRootDir, isEnoent, logger } from "@gajae-code/utils";
import { YAML } from "bun";
import { readSecureTokenFile } from "./secure-token-file";

export interface AuthBrokerClientConfig {
	url: string;
	token: string;
}

export interface StartupAuthConfigSnapshot {
	broker: AuthBrokerClientConfig | null;
	/** Opaque credential-store authority used to bind numeric row-id pins. */
	credentialStoreIdentity: string;
	/** Persisted authority for global numeric pins; absent values invalidate ID pins. */
	credentialPinStoreIdentity?: string;
	credentialRankingMode: CredentialRankingMode;
	credentialPins: Readonly<Record<string, string>>;
	/** Ordered soft per-provider preferences; only portable email/`account:` selectors are accepted. */
	credentialPreferences: Readonly<Record<string, readonly ConfiguredCredentialPreference[]>>;
}

export type StartupAuthConfigErrorKind =
	| "unreadable"
	| "invalid-yaml"
	| "non-mapping-root"
	| "invalid-auth"
	| "invalid-broker"
	| "invalid-gateway"
	| "invalid-ranking-mode"
	| "invalid-credential-pins"
	| "invalid-credential-preferences";

/** A malformed startup-auth config aborts resolution rather than downgrading to local authority. */
export class StartupAuthConfigError extends Error {
	readonly name = "StartupAuthConfigError";
	readonly code: StartupAuthConfigErrorKind;
	readonly causeClass: StartupAuthConfigErrorKind;

	constructor(
		readonly kind: StartupAuthConfigErrorKind,
		configPath: string,
	) {
		const displayPath = shortenConfigPath(configPath);
		super(`Startup auth config ${displayPath}: ${kind}.`);
		this.code = kind;
		this.causeClass = kind;
	}
}

const DEFAULT_CREDENTIAL_RANKING_MODE: CredentialRankingMode = "balanced";
/** JSON-schema pattern shared with the runtime persisted-selector grammar. */
export const PERSISTED_CREDENTIAL_SELECTOR_PATTERN = "^(id:[1-9][0-9]*|email:[^@\\s]+@[^@\\s]+|account:\\S+)$";
const LEGACY_LITERAL_AUTH_KEYS = new Set([
	"auth.broker.url",
	"auth.broker.token",
	"auth.credentialRankingMode",
	"auth.credentialPins",
	"auth.credentialPreferences",
]);

function configPathForAgentDir(agentDir: string): string {
	return path.join(agentDir, "config.yml");
}

function shortenConfigPath(configPath: string): string {
	const absolutePath = path.resolve(configPath).replace(/[\u0000-\u001f\u007f]/gu, "?");
	const homePath = path.resolve(os.homedir());
	if (absolutePath === homePath) return "~";
	const homePrefix = `${homePath}${path.sep}`;
	return absolutePath.startsWith(homePrefix) ? `~${absolutePath.slice(homePath.length)}` : absolutePath;
}

export function startupAuthConfigError(agentDir: string, kind: StartupAuthConfigErrorKind): StartupAuthConfigError {
	return new StartupAuthConfigError(kind, configPathForAgentDir(agentDir));
}

/** Path to the local bearer token file. Created on the broker host by `gjc auth-broker token`. */
export function getAuthBrokerTokenFilePath(): string {
	return path.join(getConfigRootDir(), "auth-broker.token");
}

/** Validate the persisted selector grammar used by `auth.credentialPins`. */
export function parsePersistedCredentialSelector(value: string): AuthCredentialSelector | undefined {
	const trimmed = value.trim();
	if (/^id:[1-9][0-9]*$/.test(trimmed)) return { kind: "id", value: trimmed.slice(3) };
	if (/^email:[^@\s]+@[^@\s]+$/.test(trimmed)) return { kind: "email", value: trimmed.slice(6) };
	if (/^account:\S+$/.test(trimmed)) return { kind: "account", value: trimmed.slice(8) };
	return undefined;
}

export function isValidPersistedCredentialSelector(value: string): boolean {
	return parsePersistedCredentialSelector(value) !== undefined;
}

/** JSON-schema pattern for a preference account; shared with {@link parsePreferenceAccount}. */
export const PREFERENCE_ACCOUNT_PATTERN = "^(email:[^@\\s]+@[^@\\s]+|account:\\S+|[^@\\s:]+@[^@\\s]+)$";

/**
 * Parse one `auth.credentialPreferences` account: a bare email, `email:<address>`, or `account:<id>`. Numeric row ids
 * are excluded: they are bound to one credential store, and a preference has no store-identity binding to detect a
 * retargeted row.
 */
export function parsePreferenceAccount(value: string): AuthCredentialSelector | undefined {
	const trimmed = value.trim();
	const selector = parsePersistedCredentialSelector(trimmed);
	if (selector) return selector.kind === "id" ? undefined : selector;
	return /^[^@\s:]+@[^@\s]+$/.test(trimmed) ? { kind: "email", value: trimmed } : undefined;
}

/** A preference cap accepts (0, 100]; 100 moves past the account only once it is blocked. */
export function isValidCredentialPreferenceCap(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 100;
}

/** Canonical config text for one preference entry: the account, or a one-key `{ account: cap }` mapping. */
export type CredentialPreferenceEntryValue = string | Readonly<Record<string, number>>;

function parseCredentialPreferenceEntry(value: unknown): ConfiguredCredentialPreference | undefined {
	if (typeof value === "string") {
		const selector = parsePreferenceAccount(value);
		return selector ? { selector } : undefined;
	}
	const entry = asRecord(value);
	const fields = entry ? Object.entries(entry) : [];
	if (fields.length !== 1) return undefined;
	const [account, cap] = fields[0]!;
	const selector = parsePreferenceAccount(account);
	if (!selector || !isValidCredentialPreferenceCap(cap)) return undefined;
	return cap === 100 ? { selector } : { selector, maxUsedFraction: cap / 100 };
}

function preferenceSelectorKey(selector: AuthCredentialSelector): string {
	return `${selector.kind}:${selector.kind === "email" ? selector.value.toLowerCase() : selector.value}`;
}

/**
 * Parse one provider's `auth.credentialPreferences` value: a single account, or a non-empty ordered list whose
 * entries are an account (`me@example.com`) or an account with a usage cap in percent (`me@example.com: 75`).
 * Returns undefined for any invalid value, including an account listed twice, so a typo fails closed instead of
 * silently changing the order.
 */
export function parseCredentialPreferenceList(value: unknown): ConfiguredCredentialPreference[] | undefined {
	const rawEntries = Array.isArray(value) ? value : [value];
	if (rawEntries.length === 0) return undefined;
	const entries: ConfiguredCredentialPreference[] = [];
	const seen = new Set<string>();
	for (const rawEntry of rawEntries) {
		const entry = parseCredentialPreferenceEntry(rawEntry);
		if (!entry) return undefined;
		const key = preferenceSelectorKey(entry.selector);
		if (seen.has(key)) return undefined;
		seen.add(key);
		entries.push(entry);
	}
	return entries;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function resolveRankingMode(value: unknown): CredentialRankingMode | undefined {
	return value === "balanced" || value === "earliest-reset" ? value : undefined;
}

/** Resolve the documented `$ENV_NAME` indirection without consulting project `.env` values. */
function resolveNestedBrokerValue(raw: string | undefined): string | undefined {
	const trimmed = raw?.trim();
	if (!trimmed) return undefined;
	const match = /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(trimmed);
	if (!match) return trimmed;
	return $credentialEnv(match[1]);
}

function canonicalBrokerUrl(raw: string): string {
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		throw new Error("Auth broker URL is invalid.");
	}
	if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password) {
		throw new Error("Auth broker URL must be an HTTP(S) origin without credentials.");
	}
	if (parsed.search || parsed.hash) throw new Error("Auth broker URL must not contain a query or fragment.");
	parsed.pathname = parsed.pathname.replace(/\/+$/, "");
	return parsed.toString().replace(/\/$/, "");
}

function throwLegacyLiteralKeyError(keys: string[]): never {
	throw new Error(
		`Unsupported legacy dotted auth configuration key${keys.length === 1 ? "" : "s"}: ${keys.join(", ")}. ` +
			"Rewrite config.yml manually using canonical nested YAML (no automatic migration):\n" +
			"auth:\n" +
			"  broker:\n" +
			"    url: <broker-url>\n" +
			"    token: <broker-token>\n" +
			"  credentialRankingMode: balanced\n" +
			"  credentialPins:\n" +
			"    <provider>: id:<positive-id>\n" +
			"  credentialPreferences:\n" +
			"    <provider>:\n" +
			"      - <email>\n" +
			"      - <email>: <max used percent, above 0 and at most 100>\n" +
			"Do not copy secret values into command output; rewrite the file by hand.",
	);
}

function readCredentialPins(
	auth: Record<string, unknown> | undefined,
	configPath: string,
): Readonly<Record<string, string>> {
	const rawPins = auth?.credentialPins;
	if (rawPins === undefined) return {};
	const pins = asRecord(rawPins);
	if (!pins) throw new StartupAuthConfigError("invalid-credential-pins", configPath);

	const result: Record<string, string> = {};
	for (const [provider, rawSelector] of Object.entries(pins)) {
		const normalizedProvider = provider.trim();
		if (normalizedProvider.length === 0 || /[\u0000-\u001f\u007f]/u.test(normalizedProvider)) {
			throw new StartupAuthConfigError("invalid-credential-pins", configPath);
		}
		if (typeof rawSelector !== "string" || !isValidPersistedCredentialSelector(rawSelector)) {
			throw new StartupAuthConfigError("invalid-credential-pins", configPath);
		}
		result[normalizedProvider] = rawSelector.trim();
	}
	return result;
}

function readCredentialPreferences(
	auth: Record<string, unknown> | undefined,
	configPath: string,
): Readonly<Record<string, readonly ConfiguredCredentialPreference[]>> {
	const rawPreferences = auth?.credentialPreferences;
	if (rawPreferences === undefined) return {};
	const preferences = asRecord(rawPreferences);
	if (!preferences) throw new StartupAuthConfigError("invalid-credential-preferences", configPath);

	const result: Record<string, readonly ConfiguredCredentialPreference[]> = {};
	for (const [provider, rawList] of Object.entries(preferences)) {
		const normalizedProvider = provider.trim();
		if (normalizedProvider.length === 0 || /[\u0000-\u001f\u007f]/u.test(normalizedProvider)) {
			throw new StartupAuthConfigError("invalid-credential-preferences", configPath);
		}
		const entries = parseCredentialPreferenceList(rawList);
		if (!entries) throw new StartupAuthConfigError("invalid-credential-preferences", configPath);
		result[normalizedProvider] = entries;
	}
	return result;
}

interface GlobalStartupAuthYaml {
	auth: Record<string, unknown> | undefined;
	credentialPinStoreIdentity: string | undefined;
	credentialPins: Readonly<Record<string, string>>;
	credentialPreferences: Readonly<Record<string, readonly ConfiguredCredentialPreference[]>>;
}

const EMPTY_GLOBAL_STARTUP_AUTH: GlobalStartupAuthYaml = {
	auth: undefined,
	credentialPinStoreIdentity: undefined,
	credentialPins: {},
	credentialPreferences: {},
};

async function readGlobalStartupAuthYaml(agentDir: string): Promise<GlobalStartupAuthYaml> {
	const configPath = configPathForAgentDir(agentDir);
	let raw: string;
	try {
		raw = await Bun.file(configPath).text();
	} catch (error) {
		if (isEnoent(error)) return EMPTY_GLOBAL_STARTUP_AUTH;
		logger.warn("startup auth config.yml unreadable", { path: shortenConfigPath(configPath), cause: "unreadable" });
		throw startupAuthConfigError(agentDir, "unreadable");
	}
	if (raw.trim() === "") return EMPTY_GLOBAL_STARTUP_AUTH;

	let parsed: unknown;
	try {
		parsed = YAML.parse(raw);
	} catch {
		logger.warn("startup auth config.yml has invalid YAML", {
			path: shortenConfigPath(configPath),
			cause: "invalid-yaml",
		});
		throw startupAuthConfigError(agentDir, "invalid-yaml");
	}
	const root = asRecord(parsed);
	if (!root) {
		logger.warn("startup auth config.yml root is not a mapping", {
			path: shortenConfigPath(configPath),
			cause: "non-mapping-root",
		});
		throw startupAuthConfigError(agentDir, "non-mapping-root");
	}
	const legacyKeys = Object.keys(root).filter(key => LEGACY_LITERAL_AUTH_KEYS.has(key));
	if (legacyKeys.length > 0) throwLegacyLiteralKeyError(legacyKeys);

	if (root.auth === undefined) return EMPTY_GLOBAL_STARTUP_AUTH;
	const auth = asRecord(root.auth);
	if (!auth) throw startupAuthConfigError(agentDir, "invalid-auth");

	for (const [sectionName, errorKind] of [
		["broker", "invalid-broker"],
		["gateway", "invalid-gateway"],
	] as const) {
		const section = auth[sectionName];
		if (section === undefined) continue;
		const sectionRecord = asRecord(section);
		if (!sectionRecord) throw startupAuthConfigError(agentDir, errorKind);
		for (const key of ["url", "token"] as const) {
			if (Object.hasOwn(sectionRecord, key) && typeof sectionRecord[key] !== "string") {
				throw startupAuthConfigError(agentDir, errorKind);
			}
		}
	}

	if (Object.hasOwn(auth, "credentialRankingMode") && resolveRankingMode(auth.credentialRankingMode) === undefined) {
		throw startupAuthConfigError(agentDir, "invalid-ranking-mode");
	}
	const credentialPins = readCredentialPins(auth, configPath);
	const credentialPreferences = readCredentialPreferences(auth, configPath);
	const rawCredentialPinStoreIdentity = auth.credentialPinStoreIdentity;
	const credentialPinStoreIdentity =
		typeof rawCredentialPinStoreIdentity === "string" && rawCredentialPinStoreIdentity.trim().length > 0
			? rawCredentialPinStoreIdentity.trim()
			: undefined;
	return { auth, credentialPinStoreIdentity, credentialPins, credentialPreferences };
}

async function readTokenFile(): Promise<string | undefined> {
	const token = await readSecureTokenFile(getAuthBrokerTokenFilePath());
	return token ?? undefined;
}

/**
 * Resolve one typed startup-auth snapshot from trusted env and global config.
 * Project settings are intentionally not read here, so project-scoped pins
 * cannot influence credential selection.
 */
export async function resolveStartupAuthConfig(agentDir: string = getAgentDir()): Promise<StartupAuthConfigSnapshot> {
	const { auth, credentialPinStoreIdentity, credentialPins, credentialPreferences } =
		await readGlobalStartupAuthYaml(agentDir);
	const broker = asRecord(auth?.broker);
	const envUrl = $credentialEnv("GJC_AUTH_BROKER_URL")?.trim();
	const envToken = $credentialEnv("GJC_AUTH_BROKER_TOKEN")?.trim();

	let url = envUrl || undefined;
	const nestedUrlRaw = typeof broker?.url === "string" ? broker.url : undefined;
	const nestedUrl = resolveNestedBrokerValue(nestedUrlRaw);
	if (!url && nestedUrlRaw?.trim() && nestedUrl === undefined) {
		throw startupAuthConfigError(agentDir, "invalid-broker");
	}
	if (!url && nestedUrl) url = nestedUrl;
	if (url) url = canonicalBrokerUrl(url);

	const configToken = resolveNestedBrokerValue(typeof broker?.token === "string" ? broker.token : undefined);

	let resolvedBroker: AuthBrokerClientConfig | null = null;
	if (url) {
		const token = envToken || configToken || (await readTokenFile());
		if (!token) {
			throw new Error(
				"An auth broker URL is configured but no bearer token is available. " +
					`Set GJC_AUTH_BROKER_TOKEN, the nested \`auth.broker.token\` config entry, or place one at ${getAuthBrokerTokenFilePath()}.`,
			);
		}
		resolvedBroker = { url, token };
	}

	const rankingMode =
		resolveRankingMode($credentialEnv("GJC_CREDENTIAL_RANKING_MODE")) ??
		resolveRankingMode(auth?.credentialRankingMode) ??
		DEFAULT_CREDENTIAL_RANKING_MODE;
	return {
		broker: resolvedBroker,
		credentialStoreIdentity: resolvedBroker
			? `broker:${resolvedBroker.url}`
			: `local:${path.resolve(getAgentDbPath(agentDir))}`,
		...(credentialPinStoreIdentity ? { credentialPinStoreIdentity } : {}),
		credentialRankingMode: rankingMode,
		credentialPins,
		credentialPreferences,
	};
}
