/**
 * Generic OAuth flow for MCP servers.
 *
 * Allows users to authenticate with any OAuth-compatible MCP server
 * by providing authorization URL, token URL, and client credentials.
 */

import type { OAuthCallbackFlowOptions } from "@gajae-code/ai/utils/oauth/callback-server";
import { OAuthCallbackFlow } from "@gajae-code/ai/utils/oauth/callback-server";
import type { OAuthController, OAuthCredentials } from "@gajae-code/ai/utils/oauth/types";
import { MCPExpectedFailure } from "./types";

const DEFAULT_PORT = 3000;
const CALLBACK_PATH = "/callback";
const CALLBACK_BIND_HOSTNAME = "127.0.0.1";
type RefreshTokenResponse = {
	access_token: string;
	refresh_token?: string;
	expires_in?: number;
};

function isRefreshTokenResponse(value: unknown): value is RefreshTokenResponse {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const payload = value as Record<string, unknown>;
	return (
		typeof payload.access_token === "string" &&
		payload.access_token.length > 0 &&
		(payload.refresh_token === undefined || typeof payload.refresh_token === "string") &&
		(payload.expires_in === undefined ||
			(typeof payload.expires_in === "number" && Number.isFinite(payload.expires_in) && payload.expires_in >= 0))
	);
}

function isLoopbackHostname(hostname: string): boolean {
	return hostname === "localhost" || hostname === "127.0.0.1";
}

function resolveRedirectUri(redirectUri: string | undefined): string | undefined {
	const configured = redirectUri;
	const trimmed = configured?.trim();
	if (!trimmed) return undefined;
	if (trimmed !== configured) {
		throw new Error("OAuth redirect URI must not include surrounding whitespace");
	}

	const parsed = new URL(configured);
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error("OAuth redirect URI must use http or https");
	}
	return configured;
}

function parseRedirectUri(redirectUri: string | undefined): URL | undefined {
	return redirectUri ? new URL(redirectUri) : undefined;
}

function getUriPort(uri: URL): number {
	if (uri.port !== "") return Number(uri.port);
	return uri.protocol === "https:" ? 443 : 80;
}

function validateRedirectConfig(config: MCPOAuthConfig, redirectUri: string | undefined): void {
	const parsed = parseRedirectUri(redirectUri);
	if (parsed?.protocol !== "https:" || !isLoopbackHostname(parsed.hostname)) {
		return;
	}

	if (config.callbackPort === undefined) {
		throw new Error(
			"HTTPS loopback redirect URIs require oauth.callbackPort to point at the local HTTP callback listener behind your TLS terminator",
		);
	}

	if (config.callbackPort === getUriPort(parsed)) {
		throw new Error(
			"HTTPS loopback redirect URIs cannot reuse the same local port; terminate TLS separately and forward to oauth.callbackPort",
		);
	}
}

function resolveCallbackPort(callbackPort: number | undefined, redirectUri: string | undefined): number {
	if (callbackPort !== undefined) return callbackPort;

	const parsed = parseRedirectUri(redirectUri);
	if (parsed?.protocol !== "http:" || !isLoopbackHostname(parsed.hostname)) {
		return DEFAULT_PORT;
	}

	const port = getUriPort(parsed);
	return Number.isFinite(port) && port > 0 ? port : DEFAULT_PORT;
}

function resolveCallbackPath(callbackPath: string | undefined, redirectUri: string | undefined): string {
	const trimmed = callbackPath?.trim();
	if (trimmed) return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;

	const parsed = parseRedirectUri(redirectUri);
	if (parsed?.pathname) return parsed.pathname;
	return CALLBACK_PATH;
}

function resolveCallbackHostname(redirectUri: string | undefined): string | undefined {
	const parsed = parseRedirectUri(redirectUri);
	if (!parsed || !isLoopbackHostname(parsed.hostname)) return undefined;
	return parsed.hostname;
}

function resolveCallbackOptions(config: MCPOAuthConfig): OAuthCallbackFlowOptions {
	const redirectUri = resolveRedirectUri(config.redirectUri);
	validateRedirectConfig(config, redirectUri);
	return {
		preferredPort: resolveCallbackPort(config.callbackPort, redirectUri),
		callbackPath: resolveCallbackPath(config.callbackPath, redirectUri),
		callbackHostname: resolveCallbackHostname(redirectUri),
		callbackBindHostname: CALLBACK_BIND_HOSTNAME,
		redirectUri,
	};
}

export interface MCPOAuthConfig {
	/** Authorization endpoint URL */
	authorizationUrl: string;
	/** Token endpoint URL */
	tokenUrl: string;
	/** Client ID (optional when already embedded in authorization URL) */
	clientId?: string;
	/** Client secret (optional for PKCE flows) */
	clientSecret?: string;
	/** OAuth scopes (space-separated) */
	scopes?: string;
	/** Exact redirect URI to advertise to the provider */
	redirectUri?: string;
	/** Custom callback port (default: 3000) */
	callbackPort?: number;
	/** Custom callback path (default: /callback or redirectUri pathname) */
	callbackPath?: string;
}

/**
 * Generic OAuth flow for MCP servers.
 * Supports standard OAuth 2.0 authorization code flow with PKCE.
 */
export class MCPOAuthFlow extends OAuthCallbackFlow {
	#resolvedClientId?: string;
	#registeredClientSecret?: string;
	#codeVerifier?: string;

	constructor(
		private config: MCPOAuthConfig,
		ctrl: OAuthController,
	) {
		super(ctrl, resolveCallbackOptions(config));
		this.#resolvedClientId = this.#resolveClientId(config);
	}

	/**
	 * Client id used during the authorization request. Returns the value supplied
	 * via {@link MCPOAuthConfig.clientId} or, when the server required dynamic
	 * client registration, the id issued during registration. `undefined` until
	 * {@link generateAuthUrl} (or {@link login}) has run for a server that needs
	 * a client id.
	 */
	get resolvedClientId(): string | undefined {
		return this.#resolvedClientId;
	}

	/**
	 * Client secret issued by dynamic client registration, if any. Always
	 * `undefined` for PKCE-only/public clients and when the caller supplies the
	 * client id via config.
	 */
	get registeredClientSecret(): string | undefined {
		return this.#registeredClientSecret;
	}

	async generateAuthUrl(state: string, redirectUri: string): Promise<{ url: string; instructions?: string }> {
		if (!this.#resolvedClientId) {
			await this.#tryRegisterClient(redirectUri);
		}

		const authUrl = new URL(this.config.authorizationUrl);
		const params = authUrl.searchParams;

		if (!params.get("response_type")) {
			params.set("response_type", "code");
		}
		const existingClientId = params.get("client_id")?.trim();
		if (this.#resolvedClientId && !existingClientId) {
			params.set("client_id", this.#resolvedClientId);
		}
		if (this.config.scopes && !params.get("scope")) {
			params.set("scope", this.config.scopes);
		}
		params.set("redirect_uri", redirectUri);
		params.set("state", state);

		// Add PKCE challenge (some providers require it)
		const codeVerifier = this.#generateCodeVerifier();
		const codeChallenge = await this.#generateCodeChallenge(codeVerifier);
		params.set("code_challenge", codeChallenge);
		params.set("code_challenge_method", "S256");

		// Store code verifier for token exchange
		this.#codeVerifier = codeVerifier;

		if (!params.get("client_id")) {
			await this.#assertClientIdNotRequired(authUrl.toString());
		}

		return { url: authUrl.toString() };
	}

	async exchangeToken(code: string, _state: string, redirectUri: string): Promise<OAuthCredentials> {
		const params = new URLSearchParams({
			grant_type: "authorization_code",
			code,
			redirect_uri: redirectUri,
		});
		if (this.#resolvedClientId) {
			params.set("client_id", this.#resolvedClientId);
		}

		// Add code verifier for PKCE
		if (this.#codeVerifier) {
			params.set("code_verifier", this.#codeVerifier);
		}
		this.#codeVerifier = undefined;

		// Add client secret if provided
		const clientSecret = this.config.clientSecret ?? this.#registeredClientSecret;
		if (clientSecret) {
			params.set("client_secret", clientSecret);
		}

		const response = await fetch(this.config.tokenUrl, {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body: params.toString(),
		});

		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(`Token exchange failed: ${response.status} ${errorText}`);
		}

		const data = (await response.json()) as {
			access_token: string;
			refresh_token?: string;
			expires_in?: number;
			token_type?: string;
		};

		// Calculate expiry timestamp
		const expiresIn = data.expires_in ?? 3600; // Default to 1 hour
		const expires = Date.now() + expiresIn * 1000;

		return {
			access: data.access_token,
			refresh: data.refresh_token ?? "",
			expires,
		};
	}

	/**
	 * Generate PKCE code verifier (random string).
	 */
	#generateCodeVerifier(): string {
		const bytes = new Uint8Array(32);
		crypto.getRandomValues(bytes);
		return this.#base64UrlEncode(bytes);
	}

	/**
	 * Generate PKCE code challenge from verifier.
	 */
	async #generateCodeChallenge(verifier: string): Promise<string> {
		const encoder = new TextEncoder();
		const data = encoder.encode(verifier);
		const hash = await crypto.subtle.digest("SHA-256", data);
		return this.#base64UrlEncode(new Uint8Array(hash));
	}

	/**
	 * Base64 URL encode (without padding).
	 */
	#base64UrlEncode(bytes: Uint8Array): string {
		const base64 = btoa(String.fromCharCode(...bytes));
		return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
	}

	#resolveClientId(config: MCPOAuthConfig): string | undefined {
		const fromConfig = config.clientId?.trim();
		if (fromConfig) return fromConfig;

		try {
			return new URL(config.authorizationUrl).searchParams.get("client_id") ?? undefined;
		} catch {
			return undefined;
		}
	}

	/**
	 * Try OAuth dynamic client registration when provider requires a client_id.
	 */
	async #tryRegisterClient(redirectUri: string): Promise<void> {
		const registrationEndpoint = await this.#resolveRegistrationEndpoint();
		if (!registrationEndpoint) return;

		try {
			const response = await fetch(registrationEndpoint, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Accept: "application/json",
				},
				body: JSON.stringify({
					client_name: "Codex",
					redirect_uris: [redirectUri],
					grant_types: ["authorization_code", "refresh_token"],
					response_types: ["code"],
					token_endpoint_auth_method: "none",
					application_type: "native",
				}),
			});

			if (!response.ok) return;

			const data = (await response.json()) as {
				client_id?: string;
				client_secret?: string;
			};

			if (data.client_id && data.client_id.trim() !== "") {
				this.#resolvedClientId = data.client_id;
			}
			if (data.client_secret && data.client_secret.trim() !== "") {
				this.#registeredClientSecret = data.client_secret;
			}
		} catch {
			// Ignore registration failures and continue without client registration.
		}
	}

	async #resolveRegistrationEndpoint(): Promise<string | null> {
		try {
			const authorizationEndpoint = new URL(this.config.authorizationUrl);
			const metadataUrl = new URL("/.well-known/oauth-authorization-server", authorizationEndpoint.origin);
			const response = await fetch(metadataUrl.toString(), {
				method: "GET",
				headers: { Accept: "application/json" },
			});

			if (!response.ok) return null;
			const metadata = (await response.json()) as { registration_endpoint?: string };
			if (metadata.registration_endpoint && metadata.registration_endpoint.trim() !== "") {
				return metadata.registration_endpoint;
			}
		} catch {
			// Ignore metadata discovery failures.
		}

		return null;
	}

	async #assertClientIdNotRequired(authorizationUrl: string): Promise<void> {
		try {
			const response = await fetch(authorizationUrl, {
				method: "GET",
				redirect: "manual",
				headers: { Accept: "text/plain,text/html,application/json" },
			});
			if (response.status < 400) return;
			const body = await response.text();
			if (/client[_-]?id/i.test(body) && /(required|missing|invalid)/i.test(body)) {
				throw new Error("OAuth provider requires client_id");
			}
		} catch (error) {
			if (error instanceof Error && /client[_-]?id/i.test(error.message)) {
				throw error;
			}
			// Ignore network/probe failures to avoid blocking flows that still work.
		}
	}
}

/**
 * Refresh an MCP OAuth token using the standard refresh_token grant.
 * Returns updated credentials; preserves the old refresh token if the server doesn't rotate it.
 */
export async function refreshMCPOAuthToken(
	tokenUrl: string,
	refreshToken: string,
	clientId?: string,
	clientSecret?: string,
): Promise<OAuthCredentials> {
	const params = new URLSearchParams({
		grant_type: "refresh_token",
		refresh_token: refreshToken,
	});
	if (clientId) params.set("client_id", clientId);
	if (clientSecret) params.set("client_secret", clientSecret);

	let response: Response;
	try {
		response = await fetch(tokenUrl, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: params.toString(),
		});
	} catch (error) {
		throw new MCPExpectedFailure(error);
	}

	if (!response.ok) {
		let text: string;
		try {
			text = await response.text();
		} catch (error) {
			throw new MCPExpectedFailure(error);
		}
		throw new MCPExpectedFailure(new Error(`MCP OAuth refresh failed: ${response.status} ${text}`));
	}

	let data: unknown;
	try {
		data = await response.json();
	} catch {
		throw new MCPExpectedFailure();
	}
	if (!isRefreshTokenResponse(data)) throw new MCPExpectedFailure();
	const expiresIn = data.expires_in ?? 3600;
	return {
		access: data.access_token,
		refresh: data.refresh_token ?? refreshToken,
		expires: Date.now() + expiresIn * 1000,
	};
}
