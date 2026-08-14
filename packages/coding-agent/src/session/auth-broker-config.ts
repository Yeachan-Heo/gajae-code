/**
 * Resolve auth-broker connection configuration for the local gjc client.
 *
 * Precedence (highest first):
 *   1. `GJC_AUTH_BROKER_URL` / `GJC_AUTH_BROKER_TOKEN` env vars.
 *   2. `auth.broker.url` / `auth.broker.token` in `~/.gjc/agent/config.yml`
 *      (hidden from the settings UI; `!command` resolution supported).
 *   3. Token file `~/.gjc/auth-broker.token` (paired with URL from env or config).
 *
 * Returns null when no broker URL is configured — caller falls back to the
 * local SQLite store.
 *
 * Reads config.yml directly (instead of going through `Settings.init`) because
 * `discoverAuthStorage` runs before the settings singleton is initialized in
 * `runRootCommand`, and we want hand-edited config entries to be honoured at
 * boot without forcing a startup reorder.
 */
import * as path from "node:path";
import { $credentialEnv, getAgentDir, getConfigRootDir, isEnoent, logger } from "@gajae-code/utils";
import { YAML } from "bun";
import { resolveConfigValue } from "../config/resolve-config-value";

export interface AuthBrokerClientConfig {
	url: string;
	token: string;
}

/** Path to the local bearer token file. Created on the broker host by `gjc auth-broker token`. */
export function getAuthBrokerTokenFilePath(): string {
	return path.join(getConfigRootDir(), "auth-broker.token");
}

async function readTokenFile(): Promise<string | null> {
	try {
		const raw = await Bun.file(getAuthBrokerTokenFilePath()).text();
		const trimmed = raw.trim();
		return trimmed.length > 0 ? trimmed : null;
	} catch (err) {
		if (isEnoent(err)) return null;
		logger.warn("auth-broker token file unreadable", { error: String(err) });
		return null;
	}
}

interface ConfigSnapshot {
	url?: string;
	token?: string;
}

async function readConfigYaml(): Promise<ConfigSnapshot> {
	const configPath = path.join(getAgentDir(), "config.yml");
	try {
		const raw = await Bun.file(configPath).text();
		const parsed = YAML.parse(raw);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		const record = parsed as Record<string, unknown>;
		const url = typeof record["auth.broker.url"] === "string" ? (record["auth.broker.url"] as string) : undefined;
		const token =
			typeof record["auth.broker.token"] === "string" ? (record["auth.broker.token"] as string) : undefined;
		return { url, token };
	} catch (err) {
		if (isEnoent(err)) return {};
		logger.warn("auth-broker config.yml unreadable", { error: String(err) });
		return {};
	}
}

/**
 * Read broker configuration. Returns null when the URL is missing
 * (broker disabled — local store is used). Throws when URL is set but no
 * token is available — the caller cannot fall back silently because the
 * user explicitly asked to use the broker.
 */
export async function resolveAuthBrokerConfig(): Promise<AuthBrokerClientConfig | null> {
	// Trusted sources only: this URL and token select the credential store the
	// agent uses for every provider, so whatever can set them can serve the
	// credentials the agent authenticates with and receive the ones it writes
	// back. `$env` merges the caller's `cwd/.env`, so reading them there would let
	// repository content replace the store wholesale. Resolve them the same way
	// the credentials themselves are: launching shell plus GJC/user-owned `.env`
	// files, never the project `.env`.
	const envUrl = $credentialEnv("GJC_AUTH_BROKER_URL");
	const envToken = $credentialEnv("GJC_AUTH_BROKER_TOKEN");

	let url = envUrl && envUrl.length > 0 ? envUrl : undefined;
	let configToken: string | undefined;
	if (!url || !envToken) {
		const fromConfig = await readConfigYaml();
		if (!url && fromConfig.url) {
			const resolved = await resolveConfigValue(fromConfig.url);
			if (resolved && resolved.length > 0) url = resolved;
		}
		if (fromConfig.token) {
			const resolved = await resolveConfigValue(fromConfig.token);
			if (resolved && resolved.length > 0) configToken = resolved;
		}
	}
	if (!url) return null;

	const token =
		(envToken && envToken.length > 0 ? envToken : undefined) ?? configToken ?? (await readTokenFile()) ?? undefined;
	if (!token) {
		throw new Error(
			`GJC_AUTH_BROKER_URL is set (${url}) but no bearer token is available. ` +
				`Set GJC_AUTH_BROKER_TOKEN, the \`auth.broker.token\` config entry, or place one at ${getAuthBrokerTokenFilePath()}.`,
		);
	}
	return { url, token };
}
