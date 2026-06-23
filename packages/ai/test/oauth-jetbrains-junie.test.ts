import { describe, expect, it } from "bun:test";
import { loginJetBrainsJunie, refreshJetBrainsJunieToken } from "../src/utils/oauth/jetbrains-junie";
import type { OAuthController } from "../src/utils/oauth/types";

const TOKEN_ENDPOINT = "https://oauth.account.jetbrains.com/oauth2/token";

interface CapturedRequest {
	url: string;
	body: URLSearchParams;
}

function makeFetch(captured: CapturedRequest[], response: Record<string, unknown>): typeof globalThis.fetch {
	return (async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input.toString();
		const raw = init?.body;
		const body = new URLSearchParams(typeof raw === "string" ? raw : raw ? String(raw) : "");
		captured.push({ url, body });
		return new Response(JSON.stringify(response), { status: 200, headers: { "Content-Type": "application/json" } });
	}) as unknown as typeof globalThis.fetch;
}

describe("JetBrains Junie OAuth", () => {
	it("logs in via the PKCE browser flow and exchanges the authorization code", async () => {
		const captured: CapturedRequest[] = [];
		let authUrl = "";
		const ctrl: OAuthController = {
			fetch: makeFetch(captured, {
				access_token: "junie-access-token",
				refresh_token: "junie-refresh-token",
				expires_in: 3600,
				token_type: "Bearer",
			}),
			onAuth: info => {
				authUrl = info.url;
			},
			// Simulate the user pasting the redirect URL so we do not depend on a
			// real browser round-trip hitting the loopback callback server.
			onManualCodeInput: async () => "http://localhost/?code=test-auth-code",
		};

		const creds = await loginJetBrainsJunie(ctrl);

		// Authorization URL targets the Junie CLI auth entrypoint with PKCE params.
		expect(authUrl.startsWith("https://junie.jetbrains.com/cli-auth?")).toBe(true);
		const authQuery = new URL(authUrl).searchParams;
		expect(authQuery.get("client_id")).toBe("junie-cli");
		expect(authQuery.get("scope")).toBe("offline_access openid jb-authn-service");
		expect(authQuery.get("code_challenge")).toBeTruthy();
		const redirectUri = authQuery.get("redirect_uri") ?? "";
		expect(redirectUri).toMatch(/^http:\/\/localhost:623(4[5-9]|5\d|6[0-4])$/);

		// Token exchange posts the authorization_code grant with the PKCE verifier.
		expect(captured).toHaveLength(1);
		expect(captured[0].url).toBe(TOKEN_ENDPOINT);
		expect(captured[0].body.get("grant_type")).toBe("authorization_code");
		expect(captured[0].body.get("code")).toBe("test-auth-code");
		expect(captured[0].body.get("client_id")).toBe("junie-cli");
		expect(captured[0].body.get("code_verifier")).toBeTruthy();
		expect(captured[0].body.get("redirect_uri")).toBe(redirectUri);

		expect(creds.access).toBe("junie-access-token");
		expect(creds.refresh).toBe("junie-refresh-token");
		expect(creds.expires).toBeGreaterThan(Date.now());
	});

	it("refreshes the access token with the refresh_token grant", async () => {
		const captured: CapturedRequest[] = [];
		const fetchImpl = makeFetch(captured, {
			access_token: "refreshed-access-token",
			expires_in: 7200,
			token_type: "Bearer",
		});

		const creds = await refreshJetBrainsJunieToken(
			{ access: "old-access", refresh: "stored-refresh-token", expires: Date.now() - 1000 },
			{ fetch: fetchImpl },
		);

		expect(captured).toHaveLength(1);
		expect(captured[0].url).toBe(TOKEN_ENDPOINT);
		expect(captured[0].body.get("grant_type")).toBe("refresh_token");
		expect(captured[0].body.get("refresh_token")).toBe("stored-refresh-token");
		expect(captured[0].body.get("client_id")).toBe("junie-cli");

		expect(creds.access).toBe("refreshed-access-token");
		// Refresh token is preserved when the response omits a new one.
		expect(creds.refresh).toBe("stored-refresh-token");
		expect(creds.expires).toBeGreaterThan(Date.now());
	});

	it("rejects refresh when no refresh token is stored", async () => {
		await expect(refreshJetBrainsJunieToken({ access: "x", refresh: "", expires: 0 })).rejects.toThrow(
			/require re-login/,
		);
	});
});
