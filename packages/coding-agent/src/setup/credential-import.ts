/**
 * Discover and import existing Claude Code / Codex CLI credentials.
 *
 * This is the testable core behind `gjc setup credentials` (CLI, primary entry)
 * and the TUI provider-onboarding "import existing credentials" action. It never
 * prints or returns raw tokens: callers receive redacted summaries plus opaque
 * {@link AuthCredential} payloads that go straight into the store.
 *
 * Sources:
 *   - Claude Code: `~/.claude/.credentials.json` (Linux/WSL/Windows native),
 *     the macOS Keychain (`Claude Code-credentials`), and env vars.
 *   - Codex CLI: `~/.codex/auth.json` (OAuth `tokens` block or stored
 *     `OPENAI_API_KEY`), and env vars.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AuthCredential, OAuthCredential } from "@gajae-code/ai";
import { isEnoent } from "@gajae-code/utils";
import { redactSecret } from "./provider-onboarding";

/** gjc provider ids that external credentials map onto. */
export type ExternalProvider = "anthropic" | "openai-codex";

/** Where a discovered credential came from. */
export type CredentialOrigin = "claude-code-file" | "claude-code-keychain" | "codex-file";

export const AUTO_IMPORT_OAUTH_PROVIDER_ORIGINS: Record<ExternalProvider, ReadonlySet<CredentialOrigin>> = {
	anthropic: new Set<CredentialOrigin>(["claude-code-file", "claude-code-keychain"]),
	"openai-codex": new Set<CredentialOrigin>(["codex-file"]),
};

/** Human labels for providers, used in redacted summaries. */
export const EXTERNAL_PROVIDER_LABELS: Record<ExternalProvider, string> = {
	anthropic: "Claude (Anthropic)",
	"openai-codex": "Codex (ChatGPT)",
};

/** A credential that can be safely imported into gjc's store. */
export interface ImportableCredential {
	provider: ExternalProvider;
	origin: CredentialOrigin;
	/** Redacted, human-readable description of where this came from. */
	source: string;
	kind: AuthCredential["type"];
	identity?: { email?: string; accountId?: string };
	/** Epoch-ms expiry for OAuth credentials, when known. */
	expiresAt?: number;
	/** Redacted access token / API key — safe to display. */
	redactedToken: string;
	/** Opaque credential payload. Never include this in any summary output. */
	credential: AuthCredential;
}

/** A source that was found but could not be imported. */
export interface SkippedCredential {
	origin: CredentialOrigin;
	source: string;
	reason: string;
}

/** Ambient environment-backed auth that is already usable without import. */
export interface EnvironmentCredentialHint {
	provider: ExternalProvider;
	variable: string;
	redactedValue: string;
}

export interface CredentialDiscoveryResult {
	importable: ImportableCredential[];
	skipped: SkippedCredential[];
	environment: EnvironmentCredentialHint[];
}

export interface DiscoveryOptions {
	/** Override the home directory (defaults to `os.homedir()`). */
	homeDir?: string;
	/** Override the environment (defaults to `process.env`). */
	env?: Record<string, string | undefined>;
	/** Override the platform (defaults to `process.platform`). */
	platform?: NodeJS.Platform;
	/**
	 * Reader for the macOS Keychain `Claude Code-credentials` entry. Defaults to
	 * shelling out to `security`; injected in tests. Returns the raw JSON string,
	 * or `null` when no entry exists.
	 */
	readClaudeKeychain?: () => Promise<string | null>;
}

export type CredentialUpserter = (provider: string, credential: AuthCredential) => unknown | Promise<unknown>;

export interface ImportSummary {
	imported: ImportableCredential[];
	failed: Array<{ credential: ImportableCredential; error: string }>;
}

// ─── Source-file shapes ──────────────────────────────────────────────────────

interface ClaudeCredentialsFile {
	claudeAiOauth?: {
		accessToken?: unknown;
		refreshToken?: unknown;
		expiresAt?: unknown;
		scopes?: unknown;
	};
}

interface CodexAuthFile {
	OPENAI_API_KEY?: unknown;
	tokens?: {
		id_token?: unknown;
		access_token?: unknown;
		refresh_token?: unknown;
		account_id?: unknown;
	};
	last_refresh?: unknown;
}

const ANTHROPIC_ENV_KEYS = ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"] as const;
const OPENAI_ENV_KEYS = ["OPENAI_API_KEY"] as const;

// ─── JWT helpers (best-effort identity/expiry extraction) ────────────────────

const OPENAI_AUTH_CLAIM = "https://api.openai.com/auth";
const OPENAI_PROFILE_CLAIM = "https://api.openai.com/profile";

function decodeJwtPayload(token: string): Record<string, unknown> | null {
	try {
		const parts = token.split(".");
		if (parts.length !== 3) return null;
		const payload = parts[1] ?? "";
		const decoded = Buffer.from(payload, "base64url").toString("utf-8");
		const parsed = JSON.parse(decoded) as unknown;
		return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/**
 * Build a user-safe `skipped.reason` for a failed credential source.
 *
 * NEVER include the raw exception message: JSON parse errors and filesystem
 * errors can echo back file contents (including bare token-like substrings) or
 * other sensitive material, which then surfaces through CLI text/JSON and TUI
 * discovery summaries. We expose only a generic phrase plus a non-sensitive
 * error class (e.g. `SyntaxError`) or a standard Node syscall code (e.g.
 * `EACCES`), both of which come from fixed, non-secret vocabularies.
 */
function sanitizedFailureReason(
	base: "malformed credential file" | "unreadable credential file",
	err: unknown,
): string {
	if (!(err instanceof Error)) return base;
	const code = (err as NodeJS.ErrnoException).code;
	const detail = typeof code === "string" && /^[A-Z][A-Z0-9_]*$/.test(code) ? code : err.constructor.name;
	return detail ? `${base} (${detail})` : base;
}

// ─── Claude Code discovery ───────────────────────────────────────────────────

function parseClaudeCredentials(
	raw: string,
	origin: CredentialOrigin,
	source: string,
): ImportableCredential | SkippedCredential {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw) as ClaudeCredentialsFile;
	} catch (err) {
		return { origin, source, reason: sanitizedFailureReason("malformed credential file", err) };
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return { origin, source, reason: "unsupported shape (root is not an object)" };
	}
	const credentials = parsed as ClaudeCredentialsFile;
	const oauth = credentials.claudeAiOauth;
	if (typeof oauth !== "object" || oauth === null) {
		return { origin, source, reason: "missing claudeAiOauth block (unsupported shape)" };
	}
	const access = nonEmptyString(oauth.accessToken);
	const refresh = nonEmptyString(oauth.refreshToken);
	if (!access || !refresh) {
		return { origin, source, reason: "missing accessToken or refreshToken" };
	}
	const expiresAt =
		typeof oauth.expiresAt === "number" && Number.isFinite(oauth.expiresAt) ? oauth.expiresAt : undefined;
	const credential: OAuthCredential = {
		type: "oauth",
		access,
		refresh,
		expires: expiresAt ?? Date.now(),
	};
	return {
		provider: "anthropic",
		origin,
		source,
		kind: "oauth",
		expiresAt,
		redactedToken: redactSecret(access),
		credential,
	};
}

async function discoverClaudeCode(
	opts: Required<Pick<DiscoveryOptions, "homeDir" | "platform">> & Pick<DiscoveryOptions, "readClaudeKeychain">,
	result: CredentialDiscoveryResult,
): Promise<void> {
	const filePath = path.join(opts.homeDir, ".claude", ".credentials.json");
	const displayPath = `~/.claude/.credentials.json`;
	let fileRaw: string | null = null;
	try {
		fileRaw = await fs.readFile(filePath, "utf-8");
	} catch (err) {
		if (!isEnoent(err)) {
			result.skipped.push({
				origin: "claude-code-file",
				source: `Claude Code (${displayPath})`,
				reason: sanitizedFailureReason("unreadable credential file", err),
			});
		}
	}
	if (fileRaw !== null) {
		const outcome = parseClaudeCredentials(fileRaw, "claude-code-file", `Claude Code (${displayPath})`);
		pushOutcome(result, outcome);
	} else if (opts.platform === "darwin") {
		const reader = opts.readClaudeKeychain ?? defaultClaudeKeychainReader;
		let keychainRaw: string | null = null;
		try {
			keychainRaw = await reader();
		} catch (err) {
			result.skipped.push({
				origin: "claude-code-keychain",
				source: "Claude Code (macOS Keychain)",
				reason: sanitizedFailureReason("unreadable credential file", err),
			});
		}
		if (keychainRaw !== null && keychainRaw.trim().length > 0) {
			const outcome = parseClaudeCredentials(keychainRaw, "claude-code-keychain", "Claude Code (macOS Keychain)");
			pushOutcome(result, outcome);
		}
	}
}

async function defaultClaudeKeychainReader(): Promise<string | null> {
	const { $ } = await import("bun");
	const proc = await $`security find-generic-password -s ${"Claude Code-credentials"} -w`.quiet().nothrow();
	if (proc.exitCode !== 0) return null;
	const out = proc.stdout.toString().trim();
	return out.length > 0 ? out : null;
}

// ─── Codex discovery ─────────────────────────────────────────────────────────

function parseCodexAuth(raw: string, source: string): ImportableCredential | SkippedCredential {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw) as CodexAuthFile;
	} catch (err) {
		return { origin: "codex-file", source, reason: sanitizedFailureReason("malformed credential file", err) };
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return { origin: "codex-file", source, reason: "unsupported shape (root is not an object)" };
	}
	const auth = parsed as CodexAuthFile;
	const tokens = auth.tokens;
	const access = nonEmptyString(tokens?.access_token);
	const refresh = nonEmptyString(tokens?.refresh_token);
	if (access && refresh) {
		const accessPayload = decodeJwtPayload(access);
		const idPayload = nonEmptyString(tokens?.id_token) ? decodeJwtPayload(tokens?.id_token as string) : null;
		const accountId =
			nonEmptyString(tokens?.account_id) ??
			nonEmptyString((accessPayload?.[OPENAI_AUTH_CLAIM] as { chatgpt_account_id?: unknown })?.chatgpt_account_id) ??
			nonEmptyString((idPayload?.[OPENAI_AUTH_CLAIM] as { chatgpt_account_id?: unknown })?.chatgpt_account_id);
		const email =
			nonEmptyString((accessPayload?.[OPENAI_PROFILE_CLAIM] as { email?: unknown })?.email) ??
			nonEmptyString(idPayload?.email)?.toLowerCase();
		const expSeconds = typeof accessPayload?.exp === "number" ? accessPayload.exp : undefined;
		const expiresAt = expSeconds !== undefined ? expSeconds * 1000 : undefined;
		const credential: OAuthCredential = {
			type: "oauth",
			access,
			refresh,
			expires: expiresAt ?? Date.now(),
			...(accountId ? { accountId } : {}),
			...(email ? { email } : {}),
		};
		const identity =
			accountId || email ? { ...(email ? { email } : {}), ...(accountId ? { accountId } : {}) } : undefined;
		return {
			provider: "openai-codex",
			origin: "codex-file",
			source,
			kind: "oauth",
			...(identity ? { identity } : {}),
			expiresAt,
			redactedToken: redactSecret(access),
			credential,
		};
	}
	if (tokens && (tokens.access_token !== undefined || tokens.refresh_token !== undefined)) {
		return {
			origin: "codex-file",
			source,
			reason: "incomplete OAuth tokens (missing access_token or refresh_token)",
		};
	}
	const apiKey = nonEmptyString(auth.OPENAI_API_KEY);
	if (apiKey) {
		return {
			provider: "openai-codex",
			origin: "codex-file",
			source,
			kind: "api_key",
			redactedToken: redactSecret(apiKey),
			credential: { type: "api_key", key: apiKey },
		};
	}
	return { origin: "codex-file", source, reason: "no OAuth tokens or OPENAI_API_KEY present (unsupported shape)" };
}

async function discoverCodex(homeDir: string, result: CredentialDiscoveryResult): Promise<void> {
	const filePath = path.join(homeDir, ".codex", "auth.json");
	const displayPath = "~/.codex/auth.json";
	let raw: string | null = null;
	try {
		raw = await fs.readFile(filePath, "utf-8");
	} catch (err) {
		if (!isEnoent(err)) {
			result.skipped.push({
				origin: "codex-file",
				source: `Codex CLI (${displayPath})`,
				reason: sanitizedFailureReason("unreadable credential file", err),
			});
		}
		return;
	}
	pushOutcome(result, parseCodexAuth(raw, `Codex CLI (${displayPath})`));
}

// ─── Environment hints ───────────────────────────────────────────────────────

function discoverEnvironment(env: Record<string, string | undefined>, result: CredentialDiscoveryResult): void {
	for (const variable of ANTHROPIC_ENV_KEYS) {
		const value = nonEmptyString(env[variable]);
		if (value) {
			result.environment.push({ provider: "anthropic", variable, redactedValue: redactSecret(value) });
		}
	}
	for (const variable of OPENAI_ENV_KEYS) {
		const value = nonEmptyString(env[variable]);
		if (value) {
			result.environment.push({ provider: "openai-codex", variable, redactedValue: redactSecret(value) });
		}
	}
}

// ─── Public API ──────────────────────────────────────────────────────────────

function pushOutcome(result: CredentialDiscoveryResult, outcome: ImportableCredential | SkippedCredential): void {
	if ("reason" in outcome) result.skipped.push(outcome);
	else result.importable.push(outcome);
}

/**
 * Discover Claude Code and Codex CLI credentials across files, the macOS
 * Keychain, and environment variables. Never throws for individual unreadable or
 * malformed sources — those land in {@link CredentialDiscoveryResult.skipped}.
 */
export async function discoverExternalCredentials(options: DiscoveryOptions = {}): Promise<CredentialDiscoveryResult> {
	const homeDir = options.homeDir ?? os.homedir();
	const env = options.env ?? process.env;
	const platform = options.platform ?? process.platform;
	const result: CredentialDiscoveryResult = { importable: [], skipped: [], environment: [] };
	await discoverClaudeCode({ homeDir, platform, readClaudeKeychain: options.readClaudeKeychain }, result);
	await discoverCodex(homeDir, result);
	discoverEnvironment(env, result);
	return result;
}

/** Redacted one-line summary of an importable credential. Never includes secrets. */
export function formatCredentialSummary(credential: ImportableCredential): string {
	const provider = EXTERNAL_PROVIDER_LABELS[credential.provider];
	const kind = credential.kind === "oauth" ? "OAuth" : "API key";
	const identity = credential.identity?.email ?? credential.identity?.accountId;
	const identityPart = identity ? ` ${identity}` : "";
	let expiry = "";
	if (credential.kind === "oauth" && credential.expiresAt !== undefined) {
		expiry = credential.expiresAt < Date.now() ? " [expired]" : "";
	}
	return `${provider} · ${kind}${identityPart} · token ${credential.redactedToken}${expiry} (from ${credential.source})`;
}

/** Redacted summary lines for an entire discovery result. Never includes secrets. */
export function formatDiscoverySummary(result: CredentialDiscoveryResult): string[] {
	const lines: string[] = [];
	for (const credential of result.importable) {
		lines.push(`import  ${formatCredentialSummary(credential)}`);
	}
	for (const skip of result.skipped) {
		lines.push(`skip    ${skip.source}: ${skip.reason}`);
	}
	for (const hint of result.environment) {
		lines.push(
			`env     ${EXTERNAL_PROVIDER_LABELS[hint.provider]} · ${hint.variable}=${hint.redactedValue} (already active via environment)`,
		);
	}
	return lines;
}

export function isAutoImportOAuthCredential(credential: ImportableCredential): boolean {
	return (
		AUTO_IMPORT_OAUTH_PROVIDER_ORIGINS[credential.provider]?.has(credential.origin) === true &&
		credential.kind === "oauth" &&
		credential.credential.type === "oauth"
	);
}

export function filterAutoImportOAuthCredentials(credentials: readonly ImportableCredential[]): ImportableCredential[] {
	return credentials.filter(isAutoImportOAuthCredential);
}

/**
 * Persist discovered credentials via `upsert`. Each credential is imported
 * independently; a failure on one is recorded without aborting the rest.
 */
export async function importCredentials(
	credentials: readonly ImportableCredential[],
	upsert: CredentialUpserter,
): Promise<ImportSummary> {
	const summary: ImportSummary = { imported: [], failed: [] };
	for (const credential of credentials) {
		try {
			await upsert(credential.provider, credential.credential);
			summary.imported.push(credential);
		} catch (err) {
			summary.failed.push({ credential, error: err instanceof Error ? err.message : String(err) });
		}
	}
	return summary;
}
