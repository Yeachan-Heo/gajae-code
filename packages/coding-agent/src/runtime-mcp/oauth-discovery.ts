/**
 * MCP OAuth Auto-Discovery
 *
 * Automatically detects OAuth requirements from MCP server responses
 * and extracts authentication endpoints.
 */
import type { AddressResolver, PublicUrlAccepted } from "../web/insane/url-guard";
import { validatePublicHttpUrl } from "../web/insane/url-guard";

export interface OAuthEndpoints {
	authorizationUrl: string;
	tokenUrl: string;
	clientId?: string;
	scopes?: string;
	/** Issuer recorded from the validated metadata document (RFC 9207). */
	issuer?: string;
	/** `authorization_response_iss_parameter_supported` from the same metadata. */
	authorizationResponseIssSupported?: boolean;
}

export interface AuthDetectionResult {
	requiresAuth: boolean;
	authType?: "oauth" | "apikey" | "unknown";
	oauth?: OAuthEndpoints;
	authServerUrl?: string;
	message?: string;
}

interface OAuthDiscoveryOptions {
	fetch?: (input: string | URL | Request, init?: BunFetchRequestInit) => Promise<Response>;
	resolver?: AddressResolver;
	maxRequests?: number;
	maxNodes?: number;
	maxRedirects?: number;
	timeoutMs?: number;
	signal?: AbortSignal;
}

function parseMcpAuthServerUrl(errorMessage: string): string | undefined {
	const match = errorMessage.match(/Mcp-Auth-Server:\s*([^;\]\s]+)/i);
	if (!match?.[1]) return undefined;

	try {
		return new URL(match[1]).toString();
	} catch {
		return undefined;
	}
}

export function extractMcpAuthServerUrl(error: Error): string | undefined {
	return parseMcpAuthServerUrl(error.message);
}

/**
 * Detect if an error indicates authentication is required.
 * Checks for common auth error patterns.
 */
export function detectAuthError(error: Error): boolean {
	const errorMsg = error.message.toLowerCase();

	// Check for HTTP auth status codes
	if (
		errorMsg.includes("401") ||
		errorMsg.includes("403") ||
		errorMsg.includes("unauthorized") ||
		errorMsg.includes("forbidden") ||
		errorMsg.includes("authentication required") ||
		errorMsg.includes("authentication failed")
	) {
		return true;
	}

	return false;
}

const CHALLENGE_KEY_MAX_LENGTH = 64;

function isChallengeKeyStart(code: number): boolean {
	return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95;
}

function isChallengeKeyPart(code: number): boolean {
	return isChallengeKeyStart(code) || (code >= 48 && code <= 57) || code === 45;
}

/**
 * Scan challenge parameters without retrying an entire identifier run at every
 * offset. Skipping a failed run is important: a bounded regex could reinterpret
 * the suffix of an oversized key as a different, recognized parameter.
 */
function extractChallengeEntries(errorMessage: string): Array<[string, string]> {
	const entries: Array<[string, string]> = [];
	let cursor = 0;

	while (cursor < errorMessage.length) {
		const keyStart = cursor;
		if (!isChallengeKeyStart(errorMessage.charCodeAt(keyStart))) {
			cursor++;
			continue;
		}

		let keyEnd = keyStart + 1;
		while (isChallengeKeyPart(errorMessage.charCodeAt(keyEnd))) keyEnd++;

		if (errorMessage.charCodeAt(keyEnd) !== 61 || errorMessage.charCodeAt(keyEnd + 1) !== 34) {
			cursor = keyEnd + 1;
			continue;
		}

		const valueStart = keyEnd + 2;
		const valueEnd = errorMessage.indexOf('"', valueStart);
		if (valueEnd === -1) break;
		if (valueEnd > valueStart && keyEnd - keyStart <= CHALLENGE_KEY_MAX_LENGTH) {
			entries.push([errorMessage.slice(keyStart, keyEnd).toLowerCase(), errorMessage.slice(valueStart, valueEnd)]);
		}
		cursor = valueEnd + 1;
	}

	return entries;
}

interface QuotedParameter {
	markerStart: number;
	valueEnd: number;
	value: string;
}

function isRegexLineTerminator(code: number): boolean {
	return code === 10 || code === 13 || code === 0x2028 || code === 0x2029;
}

function collectQuotedParameters(errorMessage: string, prefix: string): QuotedParameter[] {
	const entries: QuotedParameter[] = [];
	for (
		let markerStart = errorMessage.indexOf(prefix);
		markerStart !== -1;
		markerStart = errorMessage.indexOf(prefix, markerStart + 1)
	) {
		const valueStart = markerStart + prefix.length;
		const valueEnd = errorMessage.indexOf('"', valueStart);
		if (valueEnd === -1) break;
		if (valueEnd > valueStart)
			entries.push({ markerStart, valueEnd, value: errorMessage.slice(valueStart, valueEnd) });
	}
	return entries;
}

/**
 * Preserve the legacy `realm="...".*token_url="..."` fallback without the
 * greedy wildcard rescanning every later `realm` marker. The wildcard cannot
 * cross a JavaScript regex line terminator and selects the last valid token on
 * the matching line.
 */
function extractLegacyWwwAuth(errorMessage: string): { authorizationUrl: string; tokenUrl: string } | null {
	const lineAt = new Uint32Array(errorMessage.length + 1);
	let line = 0;
	for (let index = 0; index < errorMessage.length; index++) {
		lineAt[index] = line;
		if (isRegexLineTerminator(errorMessage.charCodeAt(index))) line++;
	}
	lineAt[errorMessage.length] = line;

	const realms = collectQuotedParameters(errorMessage, 'realm="');
	const tokens = collectQuotedParameters(errorMessage, 'token_url="');
	const lastTokenByLine = new Map<number, QuotedParameter>();
	for (const token of tokens) lastTokenByLine.set(lineAt[token.markerStart]!, token);

	for (const realm of realms) {
		const token = lastTokenByLine.get(lineAt[realm.valueEnd + 1]!);
		if (token && token.markerStart > realm.valueEnd) {
			return { authorizationUrl: realm.value, tokenUrl: token.value };
		}
	}

	return null;
}

/**
 * Extract OAuth endpoints from error response.
 * Looks for WWW-Authenticate header format or JSON error bodies.
 */
export function extractOAuthEndpoints(error: Error): OAuthEndpoints | null {
	const errorMsg = error.message;

	const readEndpointsFromObject = (obj: Record<string, unknown>): OAuthEndpoints | null => {
		const authorizationUrl =
			(obj.authorization_url as string | undefined) ||
			(obj.authorizationUrl as string | undefined) ||
			(obj.authorization_endpoint as string | undefined) ||
			(obj.authorizationEndpoint as string | undefined) ||
			(obj.authorization_uri as string | undefined) ||
			(obj.authorizationUri as string | undefined);
		const tokenUrl =
			(obj.token_url as string | undefined) ||
			(obj.tokenUrl as string | undefined) ||
			(obj.token_endpoint as string | undefined) ||
			(obj.tokenEndpoint as string | undefined) ||
			(obj.token_uri as string | undefined) ||
			(obj.tokenUri as string | undefined);

		if (!authorizationUrl || !tokenUrl) return null;

		const scopeFromArray = Array.isArray(obj.scopes_supported)
			? (obj.scopes_supported as unknown[]).filter(v => typeof v === "string").join(" ")
			: undefined;
		const scopes = (obj.scopes as string | undefined) || (obj.scope as string | undefined) || scopeFromArray;
		const clientId =
			(obj.client_id as string | undefined) ||
			(obj.clientId as string | undefined) ||
			(obj.default_client_id as string | undefined) ||
			(obj.public_client_id as string | undefined);

		return { authorizationUrl, tokenUrl, clientId, scopes };
	};

	const clientIdFromAuthUrl = (authorizationUrl: string): string | undefined => {
		try {
			return new URL(authorizationUrl).searchParams.get("client_id") ?? undefined;
		} catch {
			return undefined;
		}
	};

	const scopeFromAuthUrl = (authorizationUrl: string): string | undefined => {
		try {
			return new URL(authorizationUrl).searchParams.get("scope") ?? undefined;
		} catch {
			return undefined;
		}
	};

	try {
		// Try to parse as JSON error response
		// Many MCP servers return JSON with OAuth endpoints in error body
		const jsonStart = errorMsg.indexOf("{");
		const jsonEnd = errorMsg.lastIndexOf("}");
		if (jsonEnd > jsonStart) {
			const errorBody = JSON.parse(errorMsg.slice(jsonStart, jsonEnd + 1)) as Record<string, unknown>;

			// Check for OAuth endpoints in error body
			if (errorBody.oauth || errorBody.authorization || errorBody.auth) {
				const oauthData = (errorBody.oauth || errorBody.authorization || errorBody.auth) as Record<string, unknown>;
				const endpoints = readEndpointsFromObject(oauthData);
				if (endpoints) {
					return {
						...endpoints,
						clientId: endpoints.clientId || clientIdFromAuthUrl(endpoints.authorizationUrl),
						scopes: endpoints.scopes || scopeFromAuthUrl(endpoints.authorizationUrl),
					};
				}
			}

			const topLevelEndpoints = readEndpointsFromObject(errorBody);
			if (topLevelEndpoints) {
				return {
					...topLevelEndpoints,
					clientId: topLevelEndpoints.clientId || clientIdFromAuthUrl(topLevelEndpoints.authorizationUrl),
					scopes: topLevelEndpoints.scopes || scopeFromAuthUrl(topLevelEndpoints.authorizationUrl),
				};
			}
		}
	} catch {
		// Not JSON, continue with other detection methods
	}

	const challengeEntries = extractChallengeEntries(errorMsg);
	if (challengeEntries.length > 0) {
		const challengeValues = new Map<string, string>();
		for (const [key, value] of challengeEntries) {
			challengeValues.set(key, value);
		}

		const authorizationUrl =
			challengeValues.get("authorization_uri") ||
			challengeValues.get("authorization_url") ||
			challengeValues.get("authorization_endpoint") ||
			challengeValues.get("authorize_url") ||
			challengeValues.get("realm");
		const tokenUrl =
			challengeValues.get("token_url") || challengeValues.get("token_uri") || challengeValues.get("token_endpoint");

		if (authorizationUrl && tokenUrl) {
			return {
				authorizationUrl,
				tokenUrl,
				clientId: challengeValues.get("client_id") || clientIdFromAuthUrl(authorizationUrl),
				scopes: challengeValues.get("scope") || challengeValues.get("scopes") || scopeFromAuthUrl(authorizationUrl),
			};
		}
	}

	const wwwAuth = extractLegacyWwwAuth(errorMsg);
	if (wwwAuth) {
		return {
			...wwwAuth,
			clientId: clientIdFromAuthUrl(wwwAuth.authorizationUrl),
			scopes: scopeFromAuthUrl(wwwAuth.authorizationUrl),
		};
	}

	return null;
}

/**
 * Analyze an error to determine authentication requirements.
 * Returns structured info about what auth is needed.
 */
export function analyzeAuthError(error: Error): AuthDetectionResult {
	if (!detectAuthError(error)) {
		return { requiresAuth: false };
	}

	// Error text is useful for classification, but is not trusted discovery authority.
	if (extractOAuthEndpoints(error) || extractMcpAuthServerUrl(error)) {
		return {
			requiresAuth: true,
			authType: "oauth",
			message: "Server requires OAuth authentication. Launching authorization flow...",
		};
	}

	// Check if it might be API key based
	const errorMsg = error.message.toLowerCase();
	if (
		errorMsg.includes("api key") ||
		errorMsg.includes("api_key") ||
		errorMsg.includes("token") ||
		errorMsg.includes("bearer")
	) {
		return {
			requiresAuth: true,
			authType: "apikey",
			message: "Server requires API key authentication.",
		};
	}

	// Unknown auth type
	return {
		requiresAuth: true,
		authType: "unknown",
		message: "Server requires authentication but type could not be determined.",
	};
}

/**
 * Try to discover OAuth endpoints by querying the server's well-known endpoints.
 * This is a fallback when error responses don't include OAuth metadata.
 */
export async function discoverOAuthEndpoints(
	serverUrl: string,
	authServerUrl?: string,
	options: OAuthDiscoveryOptions = {},
): Promise<OAuthEndpoints | null> {
	const wellKnownPaths = [
		"/.well-known/oauth-authorization-server",
		"/.well-known/openid-configuration",
		"/.well-known/oauth-protected-resource",
		"/oauth/metadata",
		"/.mcp/auth",
		"/authorize", // Some MCP servers expose OAuth config here
	];
	const fetcher = options.fetch ?? globalThis.fetch;
	const maxRequests = options.maxRequests ?? 32;
	const maxNodes = options.maxNodes ?? 8;
	const maxRedirects = options.maxRedirects ?? 3;
	const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? 10_000);
	const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
	const { promise: aborted, resolve: resolveAbort } = Promise.withResolvers<null>();
	if (signal.aborted) resolveAbort(null);
	else signal.addEventListener("abort", () => resolveAbort(null), { once: true });
	const queue: string[] = [];
	const queued = new Set<string>();
	const visited = new Set<string>();
	let requests = 0;

	const canonicalUrl = (raw: string): string | null => {
		try {
			const url = new URL(raw);
			url.hash = "";
			return url.toString();
		} catch {
			return null;
		}
	};

	const validateUrl = async (raw: string): Promise<PublicUrlAccepted | null> => {
		const canonical = canonicalUrl(raw);
		if (!canonical || signal.aborted) return null;
		const result = await Promise.race([validatePublicHttpUrl(canonical, { resolver: options.resolver }), aborted]);
		if (!result) return null;
		return result.ok && !signal.aborted ? result : null;
	};

	const enqueue = async (raw: string): Promise<void> => {
		const canonical = canonicalUrl(raw);
		if (!canonical) return;
		const authority = new URL(canonical).origin;
		if (queued.has(authority) || visited.has(authority) || queued.size + visited.size >= maxNodes) return;
		const accepted = await validateUrl(canonical);
		if (!accepted) return;
		queued.add(accepted.url.origin);
		queue.push(accepted.url.origin);
	};

	const fetchMetadata = async (raw: string): Promise<Record<string, unknown> | null> => {
		let current = raw;
		for (let redirects = 0; redirects <= maxRedirects; redirects++) {
			if (signal.aborted || requests >= maxRequests) return null;
			const accepted = await validateUrl(current);
			if (!accepted) return null;
			const target = new URL(accepted.url);
			const address = accepted.addresses[0];
			target.hostname = address.includes(":") ? `[${address}]` : address;
			requests++;
			const response = await fetcher(target, {
				method: "GET",
				headers: { Accept: "application/json", Host: accepted.url.host },
				redirect: "manual",
				signal,
				tls: accepted.url.protocol === "https:" ? { serverName: accepted.url.hostname } : undefined,
			});
			if ([301, 302, 303, 307, 308].includes(response.status)) {
				const location = response.headers.get("Location");
				if (!location || redirects === maxRedirects) return null;
				current = new URL(location, accepted.url).toString();
				continue;
			}
			if (!response.ok) return null;
			return (await Promise.race([response.json(), aborted])) as Record<string, unknown> | null;
		}
		return null;
	};

	const server = await validateUrl(serverUrl);
	if (!server) return null;
	await enqueue(server.url.toString());
	if (authServerUrl) await enqueue(authServerUrl);

	const findEndpoints = (metadata: Record<string, unknown>): OAuthEndpoints | null => {
		if (metadata.authorization_endpoint && metadata.token_endpoint) {
			const scopesSupported = Array.isArray(metadata.scopes_supported)
				? metadata.scopes_supported.filter((scope): scope is string => typeof scope === "string").join(" ")
				: undefined;
			return {
				authorizationUrl: String(metadata.authorization_endpoint),
				tokenUrl: String(metadata.token_endpoint),
				clientId:
					typeof metadata.client_id === "string"
						? metadata.client_id
						: typeof metadata.clientId === "string"
							? metadata.clientId
							: typeof metadata.default_client_id === "string"
								? metadata.default_client_id
								: typeof metadata.public_client_id === "string"
									? metadata.public_client_id
									: undefined,
				scopes:
					scopesSupported ||
					(typeof metadata.scopes === "string"
						? metadata.scopes
						: typeof metadata.scope === "string"
							? metadata.scope
							: undefined),
			};
		}

		if (metadata.oauth || metadata.authorization || metadata.auth) {
			const oauthData = (metadata.oauth || metadata.authorization || metadata.auth) as Record<string, unknown>;
			if (typeof oauthData.authorization_url === "string" && typeof oauthData.token_url === "string") {
				return {
					authorizationUrl: oauthData.authorization_url || String(oauthData.authorizationUrl),
					tokenUrl: oauthData.token_url || String(oauthData.tokenUrl),
					clientId:
						typeof oauthData.client_id === "string"
							? oauthData.client_id
							: typeof oauthData.clientId === "string"
								? oauthData.clientId
								: typeof oauthData.default_client_id === "string"
									? oauthData.default_client_id
									: typeof oauthData.public_client_id === "string"
										? oauthData.public_client_id
										: undefined,
					scopes:
						typeof oauthData.scopes === "string"
							? oauthData.scopes
							: typeof oauthData.scope === "string"
								? oauthData.scope
								: undefined,
				};
			}
		}

		return null;
	};

	while (queue.length > 0 && !signal.aborted && requests < maxRequests) {
		const baseUrl = queue.shift()!;
		queued.delete(baseUrl);
		if (visited.has(baseUrl)) continue;
		visited.add(baseUrl);
		for (const path of wellKnownPaths) {
			try {
				const url = new URL(path, baseUrl);
				const metadata = await fetchMetadata(url.toString());

				if (metadata) {
					const endpoints = findEndpoints(metadata);
					if (endpoints) {
						const issuer = typeof metadata.issuer === "string" ? canonicalUrl(metadata.issuer) : null;
						const issuerBound = issuer === canonicalUrl(baseUrl);
						const authorization = await validateUrl(endpoints.authorizationUrl);
						const token = await validateUrl(endpoints.tokenUrl);
						const legacySameOrigin =
							!issuer && authorization?.url.origin === baseUrl && token?.url.origin === baseUrl;
						if ((issuerBound || legacySameOrigin) && authorization && token) {
							return {
								...endpoints,
								authorizationUrl: authorization.url.toString(),
								tokenUrl: token.url.toString(),
								// RFC 9207 (MCP 2026-07-28): record the issuer from this validated
								// metadata document so the authorization response can be checked.
								...(issuer ? { issuer } : {}),
								...(typeof metadata.authorization_response_iss_parameter_supported === "boolean"
									? {
											authorizationResponseIssSupported:
												metadata.authorization_response_iss_parameter_supported,
										}
									: {}),
							};
						}
					}

					if (path === "/.well-known/oauth-protected-resource") {
						const resource = typeof metadata.resource === "string" ? canonicalUrl(metadata.resource) : null;
						if (resource !== canonicalUrl(server.url.toString())) continue;
						const authServers = Array.isArray(metadata.authorization_servers)
							? metadata.authorization_servers.filter((entry): entry is string => typeof entry === "string")
							: [];

						for (const discoveredAuthServer of authServers) {
							await enqueue(discoveredAuthServer);
						}
					}
				}
			} catch {
				// Ignore errors, try next path
			}
		}
	}

	return null;
}
