/**
 * JetBrains Junie / JetBrains AI OAuth flow.
 *
 * Logs in with a JetBrains Account using the same browser-based PKCE flow the
 * official Junie CLI uses: the authorization request is opened against
 * `junie.jetbrains.com/cli-auth`, which drives the JetBrains Hub login and
 * redirects the authorization code back to a local loopback callback server.
 * The resulting access token authenticates requests against the JetBrains AI
 * Service (`ingrazzio-cloud-prod.labs.jb.gg`), which exposes a native Anthropic
 * Messages endpoint.
 *
 * Endpoints and parameters mirror the public Junie CLI client (`junie-cli`).
 */
import { OAuthCallbackFlow, type OAuthCallbackFlowOptions, parseCallbackInput } from "./callback-server";
import { generatePKCE } from "./pkce";
import type { OAuthController, OAuthCredentials } from "./types";

type FetchImpl = typeof globalThis.fetch;

const CLIENT_ID = "junie-cli";
const SCOPES = "offline_access openid jb-authn-service";
const LOGIN_INITIAL_URL = "https://junie.jetbrains.com/cli-auth";
const TOKEN_ENDPOINT = "https://oauth.account.jetbrains.com/oauth2/token";

/** Loopback callback ports allow-listed for the `junie-cli` OAuth client. */
const CALLBACK_PORT_START = 62345;
const CALLBACK_PORT_END = 62364;
const CALLBACK_HOST = "localhost";

const TOKEN_REQUEST_TIMEOUT_MS = 15_000;

interface PKCE {
	verifier: string;
	challenge: string;
}

interface JetBrainsTokenResponse {
	access_token?: unknown;
	refresh_token?: unknown;
	expires_in?: unknown;
	token_type?: unknown;
}

function toExpiry(expiresIn: unknown): number {
	const seconds = typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600;
	return Date.now() + seconds * 1000;
}

/** Probe a single loopback port; returns true when it can be bound right now. */
function canBindPort(port: number): boolean {
	try {
		const server = Bun.serve({
			hostname: CALLBACK_HOST,
			port,
			reusePort: false,
			fetch: () => new Response(null, { status: 404 }),
		});
		server.stop(true);
		return true;
	} catch {
		return false;
	}
}

/** Find the first free port in the JetBrains loopback callback range. */
function findFreeCallbackPort(): number {
	for (let port = CALLBACK_PORT_START; port <= CALLBACK_PORT_END; port++) {
		if (canBindPort(port)) {
			return port;
		}
	}
	throw new Error(
		`JetBrains Junie OAuth: no free callback port available in range ${CALLBACK_PORT_START}-${CALLBACK_PORT_END}`,
	);
}

async function exchangeCodeForToken(
	fetchImpl: FetchImpl,
	code: string,
	verifier: string,
	redirectUri: string,
	signal: AbortSignal | undefined,
): Promise<OAuthCredentials> {
	// Manual paste may include the whole redirect URL; recover the bare code.
	const resolvedCode = parseCallbackInput(code).code ?? code;
	const body = new URLSearchParams({
		grant_type: "authorization_code",
		code: resolvedCode,
		code_verifier: verifier,
		client_id: CLIENT_ID,
		redirect_uri: redirectUri,
	});
	const response = await fetchImpl(TOKEN_ENDPOINT, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
		body,
		signal: signal ?? AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
	});
	if (!response.ok) {
		throw new Error(`JetBrains Junie token exchange failed: ${response.status} ${await response.text()}`);
	}
	const data = (await response.json()) as JetBrainsTokenResponse;
	if (typeof data.access_token !== "string" || data.access_token.length === 0) {
		throw new Error("JetBrains Junie token exchange response missing access_token");
	}
	return {
		access: data.access_token,
		refresh: typeof data.refresh_token === "string" ? data.refresh_token : "",
		expires: toExpiry(data.expires_in),
	};
}

export interface JetBrainsJunieOAuthFlowOptions {
	fetch?: FetchImpl;
}

export class JetBrainsJunieOAuthFlow extends OAuthCallbackFlow {
	#fetch: FetchImpl;
	#pkce: PKCE;

	constructor(ctrl: OAuthController, pkce: PKCE, port: number, options: JetBrainsJunieOAuthFlowOptions = {}) {
		super(ctrl, {
			preferredPort: port,
			// JetBrains redirects to the loopback root (`http://localhost:PORT`),
			// so the callback request lands on the "/" path.
			callbackPath: "/",
			callbackHostname: CALLBACK_HOST,
			callbackBindHostname: CALLBACK_HOST,
			// Advertise the exact redirect_uri the Junie CLI uses (no trailing path).
			redirectUri: `http://${CALLBACK_HOST}:${port}`,
		} satisfies OAuthCallbackFlowOptions);
		this.#pkce = pkce;
		this.#fetch = options.fetch ?? ctrl.fetch ?? globalThis.fetch;
	}

	async generateAuthUrl(state: string, redirectUri: string): Promise<{ url: string; instructions?: string }> {
		// Build the query manually to match the official Junie CLI byte-for-byte
		// (encodeURIComponent encodes spaces as %20 inside the scope value).
		const url =
			`${LOGIN_INITIAL_URL}?client_id=${CLIENT_ID}` +
			`&scope=${encodeURIComponent(SCOPES)}` +
			`&state=${state}` +
			`&code_challenge=${this.#pkce.challenge}` +
			`&redirect_uri=${encodeURIComponent(redirectUri)}`;
		return {
			url,
			instructions:
				"Sign in with your JetBrains Account in the browser. If the CLI cannot capture the redirect automatically, paste the final redirect URL or authorization code when prompted.",
		};
	}

	async exchangeToken(code: string, _state: string, redirectUri: string): Promise<OAuthCredentials> {
		return exchangeCodeForToken(this.#fetch, code, this.#pkce.verifier, redirectUri, this.ctrl.signal);
	}
}

/**
 * Login with JetBrains Junie (JetBrains Account OAuth, PKCE browser flow).
 */
export async function loginJetBrainsJunie(
	ctrl: OAuthController,
	options?: JetBrainsJunieOAuthFlowOptions,
): Promise<OAuthCredentials> {
	const pkce = await generatePKCE();
	const port = findFreeCallbackPort();
	return new JetBrainsJunieOAuthFlow(ctrl, pkce, port, options).login();
}

export interface JetBrainsJunieRefreshOptions {
	signal?: AbortSignal;
	fetch?: FetchImpl;
}

/**
 * Refresh a JetBrains Junie access token using the stored refresh token.
 */
export async function refreshJetBrainsJunieToken(
	credentials: OAuthCredentials,
	options: AbortSignal | JetBrainsJunieRefreshOptions = {},
): Promise<OAuthCredentials> {
	const { signal, fetch: fetchImpl } =
		options instanceof AbortSignal ? { signal: options, fetch: undefined } : options;
	if (!credentials.refresh) {
		throw new Error(
			"JetBrains Junie credentials require re-login (`/login jetbrains-junie`); no refresh token stored",
		);
	}
	const fetchImplResolved = fetchImpl ?? globalThis.fetch;
	const body = new URLSearchParams({
		grant_type: "refresh_token",
		refresh_token: credentials.refresh,
		client_id: CLIENT_ID,
	});
	const response = await fetchImplResolved(TOKEN_ENDPOINT, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
		body,
		signal: signal ?? AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
	});
	if (!response.ok) {
		throw new Error(`JetBrains Junie token refresh failed: ${response.status} ${await response.text()}`);
	}
	const data = (await response.json()) as JetBrainsTokenResponse;
	if (typeof data.access_token !== "string" || data.access_token.length === 0) {
		throw new Error("JetBrains Junie token refresh response missing access_token");
	}
	return {
		access: data.access_token,
		refresh:
			typeof data.refresh_token === "string" && data.refresh_token.length > 0
				? data.refresh_token
				: credentials.refresh,
		expires: toExpiry(data.expires_in),
	};
}
