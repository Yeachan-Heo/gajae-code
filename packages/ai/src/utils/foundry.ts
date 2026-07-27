import { $credentialEnv } from "@gajae-code/utils";

/**
 * Whether Anthropic requests run in Foundry gateway mode.
 *
 * Resolved from trusted environment sources only. Enabling Foundry switches the
 * request base URL and injects TLS client material, so whatever can set this
 * redirects authenticated traffic. `$env` merges the caller's `cwd/.env`, so
 * reading it there would let repository content flip the mode; resolve it the
 * same way the credentials themselves are (launching shell plus GJC/user-owned
 * `.env` files, never the project `.env`).
 */
export function isFoundryEnabled(): boolean {
	const value = $credentialEnv("CLAUDE_CODE_USE_FOUNDRY");
	if (!value) return false;
	const normalized = value.trim().toLowerCase();
	return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}
