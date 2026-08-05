/** Canonical MCP connection-pool identity (contract C5). */
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import * as path from "node:path";
import type { MCPServerConfig } from "./types";

export type MCPPoolSharingMode = "per-session" | "shared";
export type MCPPoolTransport = "stdio" | "http" | "sse";
export type MCPPoolCapabilityProfile = "tools-only" | "roots";

export class MCPPoolConfigError extends Error {
	readonly code:
		| "MCP_USERINFO_NOT_ALLOWED"
		| "MCP_INVALID_ENDPOINT"
		| "MCP_SESSION_ID_REQUIRED"
		| "MCP_DUPLICATE_HEADER"
		| "MCP_AUTH_BINDING_REQUIRED";

	constructor(code: MCPPoolConfigError["code"], message: string) {
		super(message);
		this.name = "MCPPoolConfigError";
		this.code = code;
	}
}

export interface MCPEndpointIdentity {
	/** JSON-encoded canonical endpoint identity used in the pool key. */
	identity: string;
	/** Query text after only the permitted percent-hex case normalization. */
	queryIdentityInput?: string;
	/** SHA-256 of queryIdentityInput, when a query was configured. */
	queryHash?: string;
}

export interface MCPPoolKeyOptions {
	/** Original (unexpanded/uncredentialed) config used for stable identity. */
	keyConfig?: MCPServerConfig;
	/** Effective child environment after config substitutions. */
	effectiveEnv?: Record<string, string>;
	/** Effective current working directory. */
	effectiveCwd?: string;
	/** Session identity. W2 always supplies this for per-session leases. */
	sessionId?: string;
	sharingMode?: MCPPoolSharingMode;
	transport?: MCPPoolTransport;
	pluginNetworkPolicyId?: string;
	capabilityProfile?: MCPPoolCapabilityProfile;
	authBindingKind?: string;
	authScopeId?: string;
	/** Expanded HTTP/SSE headers. */
	effectiveHeaders?: Record<string, string>;
}

export interface MCPPoolKeyIdentity {
	schemaVersion: number;
	serverName: string;
	sharingMode: MCPPoolSharingMode;
	transport: MCPPoolTransport;
	command: string;
	argsNormalized: string[];
	effectiveCwdRealpath: string;
	endpointIdentity: string;
	envIdentity: string[];
	headerIdentity: string[];
	noInheritEnv: boolean;
	authBindingKind: string;
	authScopeId: string;
	pluginNetworkPolicyId: string;
	capabilityProfile: MCPPoolCapabilityProfile;
	sessionId?: string;
}

function sha256(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

function upperCasePercentHex(value: string): string {
	return value.replace(/%([0-9a-fA-F]{2})/g, (_match, hex: string) => `%${hex.toUpperCase()}`);
}

function hostEnvironment(): Record<string, string> {
	const source = typeof Bun !== "undefined" ? Bun.env : process.env;
	return Object.fromEntries(
		Object.entries(source).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
	);
}

const MINIMAL_ENV_KEYS = [
	"PATH",
	"HOME",
	"TMPDIR",
	"TEMP",
	"TMP",
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"SHELL",
	"USER",
	"SystemRoot",
	"SYSTEMROOT",
	"PATHEXT",
	"COMSPEC",
	"WINDIR",
];

function effectiveEnvironment(config: MCPServerConfig, options: MCPPoolKeyOptions): Record<string, string> {
	if (options.effectiveEnv) return { ...options.effectiveEnv };
	const inherited = config.type === "http" || config.type === "sse" || config.noInheritEnv !== true
		? hostEnvironment()
		: Object.fromEntries(MINIMAL_ENV_KEYS.flatMap(key => {
			const value = hostEnvironment()[key];
			return value === undefined ? [] : [[key, value] as const];
		}));
	return config.type === "http" || config.type === "sse" ? inherited : { ...inherited, ...(config.env ?? {}) };
}

function effectiveCwd(config: MCPServerConfig, options: MCPPoolKeyOptions): string {
	const cwd = options.effectiveCwd ?? (config.type === "stdio" ? config.cwd : undefined) ?? process.cwd();
	const absolute = path.resolve(cwd);
	try {
		return realpathSync.native(absolute);
	} catch {
		return absolute;
	}
}

function identityEntries(values: Record<string, string>): string[] {
	return Object.keys(values)
		.sort()
		.map(name => `${name}:${sha256(values[name] ?? "")}`);
}

function headerIdentity(
	config: MCPServerConfig,
	options: MCPPoolKeyOptions,
	authBindingKind: string,
	authScopeId: string,
): string[] {
	const headers = options.effectiveHeaders ?? (config.type === "http" || config.type === "sse" ? config.headers : undefined) ?? {};
	const names = Object.keys(headers);
	const normalizedNames = new Set<string>();
	for (const name of names) {
		const normalized = name.toLowerCase();
		if (normalizedNames.has(normalized)) {
			throw new MCPPoolConfigError(
				"MCP_DUPLICATE_HEADER",
				`MCP headers contain duplicate case-insensitive name: ${normalized}`,
			);
		}
		normalizedNames.add(normalized);
	}
	return names
		.map(name => name.toLowerCase())
		.sort()
		.map(name => {
			const originalName = names.find(candidate => candidate.toLowerCase() === name) ?? name;
			if (name === "authorization") {
				const sharingMode = options.sharingMode ?? config.sharing ?? "per-session";
				if (sharingMode === "shared" && (authBindingKind === "none" || authBindingKind.length === 0 || authScopeId.length === 0)) {
					throw new MCPPoolConfigError(
						"MCP_AUTH_BINDING_REQUIRED",
						"Shared MCP Authorization entries require non-secret auth binding kind and scope",
					);
				}
				return `${name}:${authBindingKind}:${authScopeId}`;
			}
			return `${name}:${sha256(headers[originalName] ?? "")}`;
		});
}

/**
 * Canonicalize an HTTP/SSE URL without serializing its path or query through URL.
 * The raw configured path/query are retained so duplicate/empty query parameters
 * and encoded reserved characters remain distinct identities.
 */
export function canonicalizeMCPEndpoint(raw: string): MCPEndpointIdentity {
	const schemeSeparator = raw.indexOf("://");
	if (schemeSeparator <= 0) {
		throw new MCPPoolConfigError("MCP_INVALID_ENDPOINT", "MCP endpoint must be an absolute URL");
	}
	const authorityStart = schemeSeparator + 3;
	const authorityEndRelative = raw.slice(authorityStart).search(/[\/?#]/);
	const authorityEnd = authorityEndRelative < 0 ? raw.length : authorityStart + authorityEndRelative;
	const authority = raw.slice(authorityStart, authorityEnd);
	if (authority.includes("@")) {
		throw new MCPPoolConfigError("MCP_USERINFO_NOT_ALLOWED", "MCP endpoint userinfo is not allowed");
	}
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch (error) {
		throw new MCPPoolConfigError(
			"MCP_INVALID_ENDPOINT",
			`MCP endpoint is invalid: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const scheme = parsed.protocol.slice(0, -1).toLowerCase();
	const host = parsed.hostname.toLowerCase();
	const defaultPort = scheme === "https" ? "443" : scheme === "http" ? "80" : "";
	const port = parsed.port || defaultPort;
	const rawWithoutFragment = raw.slice(0, raw.indexOf("#") >= 0 ? raw.indexOf("#") : raw.length);
	const pathStart = authorityEnd;
	const queryIndex = rawWithoutFragment.indexOf("?", pathStart);
	const pathEnd = queryIndex >= 0 ? queryIndex : rawWithoutFragment.length;
	const endpointPath = upperCasePercentHex(rawWithoutFragment.slice(pathStart, pathEnd));
	const queryPresent = queryIndex >= 0;
	const queryText = queryPresent ? upperCasePercentHex(rawWithoutFragment.slice(queryIndex + 1)) : undefined;
	const queryHash = queryText === undefined ? undefined : sha256(queryText);
	const identity = JSON.stringify({
		scheme,
		host,
		port,
		path: endpointPath,
		queryPresent,
		queryHash: queryHash ?? "",
	});
	return { identity, queryIdentityInput: queryText, queryHash };
}

function endpointIdentity(config: MCPServerConfig): MCPEndpointIdentity {
	return config.type === "http" || config.type === "sse" ? canonicalizeMCPEndpoint(config.url) : { identity: "" };
}

function authIdentity(config: MCPServerConfig, options: MCPPoolKeyOptions): { kind: string; scope: string } {
	return {
		kind: options.authBindingKind ?? config.auth?.type ?? "none",
		scope: options.authScopeId ?? config.auth?.credentialId ?? "",
	};
}

function requireSessionId(sharingMode: MCPPoolSharingMode, sessionId: string | undefined): void {
	if (sharingMode !== "per-session") return;
	if (typeof sessionId !== "string" || sessionId.trim().length === 0) {
		throw new MCPPoolConfigError(
			"MCP_SESSION_ID_REQUIRED",
			"MCP per-session pooling requires a non-empty sessionId",
		);
	}
}

/** Build the ordered C5 identity object before hashing. */
export function buildMCPPoolKeyIdentity(
	serverName: string,
	config: MCPServerConfig,
	options: MCPPoolKeyOptions = {},
): MCPPoolKeyIdentity {
	const source = options.keyConfig ?? config;
	const sharingMode = options.sharingMode ?? source.sharing ?? "per-session";
	requireSessionId(sharingMode, options.sessionId);
	const transport = options.transport ?? (config.type ?? "stdio");
	const auth = authIdentity(source, options);
	const env = effectiveEnvironment(config, options);
	const noInheritEnv = config.type === "stdio" && config.noInheritEnv === true;
	const envIdentity = identityEntries(env);
	if (!noInheritEnv) {
		const inherited = identityEntries(hostEnvironment());
		envIdentity.push(`inheritedEnvFingerprint:${sha256(inherited.join("\n"))}`);
	}
	const headers = headerIdentity(source, options, auth.kind, auth.scope);
	const identity: MCPPoolKeyIdentity = {
		schemaVersion: 1,
		serverName,
		sharingMode,
		transport,
		command: source.type === "http" || source.type === "sse" ? "" : source.command,
		argsNormalized: source.type === "http" || source.type === "sse" ? [] : [...(source.args ?? [])],
		effectiveCwdRealpath: effectiveCwd(config, options),
		endpointIdentity: endpointIdentity(source).identity,
		envIdentity,
		headerIdentity: headers,
		noInheritEnv,
		authBindingKind: auth.kind,
		authScopeId: auth.scope,
		pluginNetworkPolicyId: options.pluginNetworkPolicyId ?? "default",
		capabilityProfile: options.capabilityProfile ?? "roots",
	};
	if (sharingMode === "per-session") identity.sessionId = options.sessionId ?? "";
	return identity;
}

/** Compute the SHA-256 key for a C5 identity. */
export function computeMCPPoolKey(
	serverName: string,
	config: MCPServerConfig,
	options: MCPPoolKeyOptions = {},
): string {
	return sha256(JSON.stringify(buildMCPPoolKeyIdentity(serverName, config, options)));
}
