/**
 * Perplexity login and token refresh.
 *
 * Login paths (in priority order):
 * 1. macOS native app: reads JWT from NSUserDefaults (`defaults read ai.perplexity.mac authToken`)
 * 2. HTTP email OTP: `GET /api/auth/csrf` → `POST /api/auth/signin-email` → `POST /api/auth/signin-otp`
 *
 * No browser or manual cookie paste required.
 * Refresh: Socket.IO `refreshJWT` RPC over authenticated WebSocket connection.
 *
 * Protocol: Engine.IO v4 + Socket.IO v4 over WebSocket (bypasses Cloudflare managed challenge).
 * Architecture reverse-engineered from Perplexity macOS app (ai.perplexity.mac).
 */
import * as os from "node:os";
import { $env } from "@gajae-code/utils";
import { $ } from "bun";
import type { OAuthController, OAuthCredentials } from "./types";

const API_VERSION = "2.18";
const NATIVE_APP_BUNDLE = "ai.perplexity.mac";
const APP_USER_AGENT = "Perplexity/641 CFNetwork/1568 Darwin/25.2.0";

// ---------------------------------------------------------------------------
// JWT helpers
// ---------------------------------------------------------------------------

/**
 * Extract expiry from a JWT. Perplexity tokens generally lack an `exp` claim
 * (their sessions are server-side and effectively non-expiring from the client's
 * point of view), so we return a far-future sentinel when no `exp` is present.
 * When `exp` IS present, subtract a 5-minute safety margin.
 */
const NEVER_EXPIRES = 8.64e15; // max safe Date value
function getJwtExpiry(token: string): number {
	try {
		const parts = token.split(".");
		if (parts.length !== 3) return NEVER_EXPIRES;
		const payload = parts[1] ?? "";
		const decoded = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
		if (typeof decoded?.exp === "number" && Number.isFinite(decoded.exp)) {
			return decoded.exp * 1000 - 5 * 60_000;
		}
	} catch {
		// Ignore decode errors
	}
	return NEVER_EXPIRES;
}

/** Build OAuthCredentials from a Perplexity JWT string. */
function jwtToCredentials(jwt: string, email?: string): OAuthCredentials {
	return {
		access: jwt,
		refresh: jwt,
		expires: getJwtExpiry(jwt),
		email,
	};
}

// ---------------------------------------------------------------------------
// Desktop app extraction
// ---------------------------------------------------------------------------

/**
 * Read the Perplexity JWT from the native macOS Catalyst app's UserDefaults.
 * Tokens are stored in NSUserDefaults (not Keychain), readable by any same-UID process.
 */
async function extractFromNativeApp(): Promise<string | null> {
	if (os.platform() !== "darwin") return null;

	try {
		const result = await $`defaults read ${NATIVE_APP_BUNDLE} authToken`.quiet().nothrow();
		if (result.exitCode !== 0) return null;
		const token = result.text().trim();
		if (!token || token === "(null)") return null;
		return token;
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Socket.IO email OTP login
// ---------------------------------------------------------------------------

/**
 * Send email OTP and exchange it for a Perplexity JWT via HTTP endpoints.
 */
async function httpEmailLogin(ctrl: OAuthController): Promise<OAuthCredentials> {
	if (!ctrl.onPrompt) {
		throw new Error("Perplexity login requires onPrompt callback");
	}
	const email = await ctrl.onPrompt({
		message: "Enter your Perplexity email address",
		placeholder: "user@example.com",
	});
	const trimmedEmail = email.trim();
	if (!trimmedEmail) throw new Error("Email is required for Perplexity login");
	if (ctrl.signal?.aborted) throw new Error("Login cancelled");

	ctrl.onProgress?.("Fetching Perplexity CSRF token...");
	const csrfResponse = await fetch("https://www.perplexity.ai/api/auth/csrf", {
		headers: {
			"User-Agent": APP_USER_AGENT,
			"X-App-ApiVersion": API_VERSION,
		},
		signal: ctrl.signal,
	});

	if (!csrfResponse.ok) {
		throw new Error(`Perplexity CSRF request failed: ${csrfResponse.status}`);
	}

	const csrfData = (await csrfResponse.json()) as { csrfToken?: string };
	if (!csrfData.csrfToken) {
		throw new Error("Perplexity CSRF response missing csrfToken");
	}
	ctrl.onProgress?.("Sending login code to your email...");
	const sendResponse = await fetch("https://www.perplexity.ai/api/auth/signin-email", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"User-Agent": APP_USER_AGENT,
			"X-App-ApiVersion": API_VERSION,
		},
		body: JSON.stringify({
			email: trimmedEmail,
			csrfToken: csrfData.csrfToken,
		}),
		signal: ctrl.signal,
	});

	if (!sendResponse.ok) {
		const body = await sendResponse.text();
		throw new Error(`Perplexity send login code failed (${sendResponse.status}): ${body}`);
	}
	const otp = await ctrl.onPrompt({
		message: "Enter the code sent to your email",
		placeholder: "123456",
	});
	const trimmedOtp = otp.trim();
	if (!trimmedOtp) throw new Error("OTP code is required");
	if (ctrl.signal?.aborted) throw new Error("Login cancelled");
	ctrl.onProgress?.("Verifying login code...");
	const verifyResponse = await fetch("https://www.perplexity.ai/api/auth/signin-otp", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"User-Agent": APP_USER_AGENT,
			"X-App-ApiVersion": API_VERSION,
		},
		body: JSON.stringify({
			email: trimmedEmail,
			otp: trimmedOtp,
			csrfToken: csrfData.csrfToken,
		}),
		signal: ctrl.signal,
	});

	const verifyData = (await verifyResponse.json()) as {
		token?: string;
		status?: string;
		error_code?: string;
		text?: string;
	};

	if (!verifyResponse.ok) {
		const reason = verifyData.text ?? verifyData.error_code ?? verifyData.status ?? "OTP verification failed";
		throw new Error(`Perplexity OTP verification failed: ${reason}`);
	}

	if (!verifyData.token) {
		throw new Error("Perplexity OTP verification response missing token");
	}

	return jwtToCredentials(verifyData.token, trimmedEmail);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Login to Perplexity.
 *
 * Tries auto-extraction from the desktop app, then runs HTTP email OTP login.
 *
 * No browser/manual token paste fallback is used.
 */
/**
 * Whether the operator disabled borrowing a token from the native macOS app.
 *
 * `GJC_AUTH_NO_BORROW` is the documented name; `PI_AUTH_NO_BORROW` is the legacy
 * one that was the only name actually read.
 */
function authBorrowDisabled(): boolean {
	return Boolean($env.GJC_AUTH_NO_BORROW || $env.PI_AUTH_NO_BORROW);
}

/** Test seam: the resolved native-app borrowing opt-out. */
export function authBorrowDisabledForTest(): boolean {
	return authBorrowDisabled();
}

export async function loginPerplexity(ctrl: OAuthController): Promise<OAuthCredentials> {
	if (!ctrl.onPrompt) {
		throw new Error("Perplexity login requires onPrompt callback");
	}

	// Path 1: Native macOS app JWT, skipped when the operator opts out.
	//
	// Presence-based on purpose: this is a privacy opt-out, so any set value must
	// disable borrowing. A boolean contract would let `GJC_AUTH_NO_BORROW=0`
	// silently re-enable reading a token out of another application.
	if (!authBorrowDisabled()) {
		ctrl.onProgress?.("Checking for Perplexity desktop app...");
		const nativeJwt = await extractFromNativeApp();
		if (nativeJwt) {
			ctrl.onProgress?.("Found Perplexity JWT from native app");
			return jwtToCredentials(nativeJwt);
		}
	}

	// Path 2: HTTP email OTP
	return httpEmailLogin(ctrl);
}
