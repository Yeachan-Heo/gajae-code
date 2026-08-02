/**
 * Abstract base class for OAuth flows with local callback servers.
 *
 * Handles:
 * - Port allocation (tries expected port, falls back to random)
 * - Callback server setup and request handling
 * - Opting out of the local listener entirely (`skipCallbackServer`) for
 *   providers that redirect somewhere this process cannot observe
 * - Common OAuth flow logic
 *
 * Providers extend this and implement:
 * - generateAuthUrl(): Build provider-specific authorization URL
 * - exchangeToken(): Exchange authorization code for tokens
 */
import templateHtml from "./oauth.html" with { type: "text" };
import type { OAuthController, OAuthCredentials } from "./types";

const DEFAULT_TIMEOUT = 300_000;
const DEFAULT_HOSTNAME = "localhost";
const CALLBACK_PATH = "/callback";

export type CallbackResult = { code: string; state: string };

export interface OAuthCallbackFlowOptions {
	preferredPort: number;
	callbackPath?: string;
	callbackHostname?: string;
	/** Local listener hostname; defaults to callbackHostname when omitted. */
	callbackBindHostname?: string;
	/** Exact redirect URI advertised to the provider; disables port fallback. */
	redirectUri?: string;
	/**
	 * Do not bind a local listener at all. The provider redirects somewhere this
	 * process cannot observe (a hosted "copy this code" page, a custom protocol),
	 * so the code arrives by paste instead. Requires both `redirectUri` and an
	 * `onManualCodeInput` handler on the controller.
	 */
	skipCallbackServer?: boolean;
}

/**
 * Abstract base class for OAuth flows with local callback servers.
 */
export abstract class OAuthCallbackFlow {
	ctrl: OAuthController;
	preferredPort: number;
	callbackPath: string;
	callbackHostname: string;
	callbackBindHostname: string;
	redirectUri?: string;
	readonly #skipCallbackServer: boolean;
	#callbackResolve?: (result: CallbackResult) => void;
	#callbackReject?: (error: string) => void;

	constructor(
		ctrl: OAuthController,
		preferredPortOrOptions: number | OAuthCallbackFlowOptions,
		callbackPath: string = CALLBACK_PATH,
	) {
		this.ctrl = ctrl;
		if (typeof preferredPortOrOptions === "number") {
			this.preferredPort = preferredPortOrOptions;
			this.callbackPath = callbackPath;
			this.callbackHostname = DEFAULT_HOSTNAME;
			this.callbackBindHostname = DEFAULT_HOSTNAME;
			this.#skipCallbackServer = false;
			return;
		}

		this.preferredPort = preferredPortOrOptions.preferredPort;
		this.callbackPath = preferredPortOrOptions.callbackPath ?? CALLBACK_PATH;
		this.callbackHostname = preferredPortOrOptions.callbackHostname ?? DEFAULT_HOSTNAME;
		this.callbackBindHostname = preferredPortOrOptions.callbackBindHostname ?? this.callbackHostname;
		this.redirectUri = preferredPortOrOptions.redirectUri;
		this.#skipCallbackServer = preferredPortOrOptions.skipCallbackServer === true;
	}

	/**
	 * Generate provider-specific authorization URL.
	 * @param state - CSRF state token
	 * @param redirectUri - The actual redirect URI to use (may differ from expected if port fallback occurred)
	 * @returns Authorization URL and optional instructions
	 */
	abstract generateAuthUrl(state: string, redirectUri: string): Promise<{ url: string; instructions?: string }>;

	/**
	 * Exchange authorization code for OAuth tokens.
	 * @param code - Authorization code from callback
	 * @param state - CSRF state token
	 * @param redirectUri - The actual redirect URI used (must match authorization request)
	 * @returns OAuth credentials
	 */
	abstract exchangeToken(code: string, state: string, redirectUri: string): Promise<OAuthCredentials>;

	/**
	 * Generate CSRF state token. Override if provider needs custom state generation.
	 */
	generateState(): string {
		const bytes = new Uint8Array(16);
		crypto.getRandomValues(bytes);
		return Array.from(bytes)
			.map(value => value.toString(16).padStart(2, "0"))
			.join("");
	}

	/**
	 * Execute the OAuth login flow.
	 */
	async login(): Promise<OAuthCredentials> {
		if (this.#skipCallbackServer && !this.ctrl.onManualCodeInput) {
			// Fail before a browser is opened: without a listener and without a paste
			// handler the flow can only sit until the 5-minute timeout.
			throw new Error(
				"OAuth flow is configured without a local callback server, but no manual authorization-code handler was provided",
			);
		}
		const state = this.generateState();

		// Start callback server first to get actual redirect URI
		const { server, redirectUri } = await this.#startCallbackServer(state);

		try {
			// Generate auth URL with the ACTUAL redirect URI (may differ from expected if port was busy)
			const { url: authUrl, instructions } = await this.generateAuthUrl(state, redirectUri);

			// Notify controller that auth is ready
			this.ctrl.onAuth?.({ url: authUrl, instructions });
			this.ctrl.onProgress?.(
				this.#skipCallbackServer
					? "Waiting for the authorization code..."
					: "Waiting for browser authentication...",
			);

			// Wait for callback or manual input
			const { code } = await this.#waitForCallback(state);

			this.ctrl.onProgress?.("Exchanging authorization code for tokens...");

			return await this.exchangeToken(code, state, redirectUri);
		} finally {
			server?.stop();
		}
	}

	/**
	 * Start callback server, trying preferred port first, falling back to random.
	 * Returns no server when the flow opted out of the local listener.
	 */
	async #startCallbackServer(
		expectedState: string,
	): Promise<{ server: Bun.Server<unknown> | undefined; redirectUri: string }> {
		if (this.#skipCallbackServer) {
			if (!this.redirectUri) {
				throw new Error("OAuth flow skips the local callback server but no redirect URI was configured");
			}
			return { server: undefined, redirectUri: this.redirectUri };
		}
		try {
			const server = this.#createServer(this.preferredPort, expectedState);
			if (this.redirectUri) {
				return { server, redirectUri: this.redirectUri };
			}
			const redirectUri = `http://${this.callbackHostname}:${this.preferredPort}${this.callbackPath}`;
			return { server, redirectUri };
		} catch {
			if (this.redirectUri) {
				throw new Error(
					`OAuth callback port ${this.preferredPort} unavailable; cannot fall back to a random port when oauth.redirectUri is set`,
				);
			}
			const server = this.#createServer(0, expectedState);
			const actualPort = server.port;
			const redirectUri = `http://${this.callbackHostname}:${actualPort}${this.callbackPath}`;
			this.ctrl.onProgress?.(`Preferred port ${this.preferredPort} unavailable, using port ${actualPort}`);
			return { server, redirectUri };
		}
	}

	/**
	 * Create HTTP server for OAuth callback.
	 */
	#createServer(port: number, expectedState: string): Bun.Server<unknown> {
		return Bun.serve({
			hostname: this.callbackBindHostname,
			port,
			reusePort: false,
			fetch: req => this.#handleCallback(req, expectedState),
		});
	}

	/**
	 * Handle OAuth callback HTTP request.
	 */
	#handleCallback(req: Request, expectedState: string): Response {
		const url = new URL(req.url);

		if (url.pathname !== this.callbackPath) {
			return new Response("Not Found", { status: 404 });
		}

		const code = url.searchParams.get("code");
		const state = url.searchParams.get("state") || "";
		const error = url.searchParams.get("error") || "";
		const errorDescription = url.searchParams.get("error_description") || error;

		type OkState = { ok: true; code: string; state: string };
		type ErrorState = { ok?: false; error?: string };
		let resultState: OkState | ErrorState;

		if (error) {
			resultState = { ok: false, error: `Authorization failed: ${errorDescription}` };
		} else if (!code) {
			resultState = { ok: false, error: "Missing authorization code" };
		} else if (expectedState && state !== expectedState) {
			resultState = { ok: false, error: "State mismatch - possible CSRF attack" };
		} else {
			resultState = { ok: true, code, state };
		}

		// Signal to waitForCallback - capture refs before they could be cleared
		const resolve = this.#callbackResolve;
		const reject = this.#callbackReject;
		queueMicrotask(() => {
			if (resultState.ok) {
				resolve?.({ code: resultState.code, state: resultState.state });
			} else {
				reject?.(resultState.error ?? "Unknown error");
			}
		});

		return new Response(
			(templateHtml as unknown as string).replaceAll("__OAUTH_STATE__", JSON.stringify(resultState)),
			{
				status: resultState.ok ? 200 : 500,
				headers: { "Content-Type": "text/html" },
			},
		);
	}

	/**
	 * Wait for OAuth callback or manual input (whichever comes first).
	 */
	#waitForCallback(expectedState: string): Promise<CallbackResult> {
		const timeoutSignal = AbortSignal.timeout(DEFAULT_TIMEOUT);
		const signal = this.ctrl.signal ? AbortSignal.any([this.ctrl.signal, timeoutSignal]) : timeoutSignal;

		const callbackPromise = new Promise<CallbackResult>((resolve, reject) => {
			this.#callbackResolve = resolve;
			this.#callbackReject = reject;

			const cancel = () => {
				this.#callbackResolve = undefined;
				this.#callbackReject = undefined;
				reject(new Error(`OAuth callback cancelled: ${signal.reason}`));
			};
			// A signal that aborted before the listener was attached never fires the
			// event. Without a local listener to fall back on there would be nothing
			// left to settle this promise, so check the current state too.
			if (signal.aborted) {
				cancel();
				return;
			}
			signal.addEventListener("abort", cancel);
		});

		const parseManualInput = (input: string): CallbackResult | null => {
			const parsed = parseCallbackInput(input);
			if (!parsed.code) return null;
			if (expectedState && parsed.state && parsed.state !== expectedState) return null;
			return { code: parsed.code, state: parsed.state ?? "" };
		};

		// Manual input race (if supported)
		if (this.ctrl.onManualCodeInput) {
			const requestManualInput = this.ctrl.onManualCodeInput;
			const manualPromise = (async (): Promise<CallbackResult> => {
				while (true) {
					const attempt = requestManualInput().then(parseManualInput);
					// The losing branch of the race can still reject long after the login
					// settled (the pending prompt is cleared on teardown); keep that from
					// surfacing as an unhandled rejection.
					attempt.catch(() => undefined);
					// A rejection that arrives first is a cancellation — the prompt was
					// cleared or superseded — not a bad value. Re-prompting would spin
					// forever, and with no local listener nothing else can settle this.
					const result = await Promise.race([callbackPromise, attempt]);
					if (result) return result;
					// Yield to the macrotask queue so a handler that immediately resolves
					// unusable values cannot starve the abort/timeout timer.
					await Bun.sleep(0);
				}
			})();

			return Promise.race([callbackPromise, manualPromise]);
		}

		return callbackPromise;
	}
}

/**
 * Parse a redirect URL or code string to extract code and state.
 */
export function parseCallbackInput(input: string): { code?: string; state?: string } {
	const value = input.trim();
	if (!value) return {};

	try {
		const url = new URL(value);
		return {
			code: url.searchParams.get("code") ?? undefined,
			state: url.searchParams.get("state") ?? undefined,
		};
	} catch {
		// Not a URL - check for query string format
	}

	if (value.includes("code=")) {
		const params = new URLSearchParams(value.replace(/^[?#]/, ""));
		return {
			code: params.get("code") ?? undefined,
			state: params.get("state") ?? undefined,
		};
	}

	// Assume raw code, possibly with state after #
	const [code, state] = value.split("#", 2);
	return { code, state };
}
