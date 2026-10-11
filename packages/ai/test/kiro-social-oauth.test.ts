import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "../src/auth-storage";
import { kiroModelManagerOptions } from "../src/provider-models/special";
import { getOAuthApiKey, refreshOAuthToken } from "../src/utils/oauth";
import type { OAuthCredentials } from "../src/utils/oauth/types";

const SOCIAL_PROFILE_ARN = "arn:aws:codewhisperer:us-east-1:123456789012:profile/social-profile";
const SOCIAL_CREDENTIAL: OAuthCredentials = {
	access: "social-access-token",
	refresh: "social-refresh-token",
	expires: Date.now() - 1_000,
	profileArn: SOCIAL_PROFILE_ARN,
};

afterEach(() => {
	vi.restoreAllMocks();
});

describe("Kiro social OAuth credentials", () => {
	test("refreshes through the social-login endpoint and preserves the non-rotated refresh token", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({
					accessToken: "refreshed-social-access",
					expiresIn: 3600,
					profileArn: SOCIAL_PROFILE_ARN,
					refreshToken: SOCIAL_CREDENTIAL.refresh,
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			),
		);

		const refreshed = await refreshOAuthToken("kiro", SOCIAL_CREDENTIAL);

		expect(fetchSpy).toHaveBeenCalledTimes(1);
		const [url, init] = fetchSpy.mock.calls[0]!;
		expect(url).toBe("https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken");
		expect(init?.method).toBe("POST");
		expect(init?.redirect).toBe("error");
		expect(JSON.parse(String(init?.body))).toEqual({ refreshToken: SOCIAL_CREDENTIAL.refresh });
		expect(refreshed).toMatchObject({
			access: "refreshed-social-access",
			refresh: SOCIAL_CREDENTIAL.refresh,
			profileArn: SOCIAL_PROFILE_ARN,
		});
		expect(refreshed.expires).toBeGreaterThan(Date.now());
	});

	test("does not fall back to SSO refresh for a rejected social token", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 }));

		await expect(refreshOAuthToken("kiro", SOCIAL_CREDENTIAL)).rejects.toThrow(/kiro-cli login/);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(fetchSpy.mock.calls[0]?.[0]).toBe("https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken");
	});

	test("retains profileArn in AuthStorage after refreshing an imported social credential", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-kiro-social-refresh-"));
		const store = await SqliteAuthCredentialStore.open(path.join(tempDir, "auth.sqlite3"));
		try {
			const storage = new AuthStorage(store);
			await storage.reload();
			await storage.set("kiro", { type: "oauth", ...SOCIAL_CREDENTIAL });
			const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
				new Response(JSON.stringify({ accessToken: "stored-refresh-access", expiresIn: 3600 }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);

			const apiKey = await storage.getApiKey("kiro");
			if (!apiKey) throw new Error("expected refreshed Kiro API key");
			const structuredKey = JSON.parse(apiKey) as { token: string; profileArn?: string };
			expect(structuredKey).toMatchObject({ token: "stored-refresh-access", profileArn: SOCIAL_PROFILE_ARN });
			expect(fetchSpy).toHaveBeenCalledTimes(1);
			const stored = storage.get("kiro");
			if (stored?.type !== "oauth") throw new Error("expected stored Kiro OAuth credential");
			expect(stored.profileArn).toBe(SOCIAL_PROFILE_ARN);
			expect(stored.refresh).toBe(SOCIAL_CREDENTIAL.refresh);
		} finally {
			store.close();
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	test("passes profileArn to OAuth ListAvailableModels discovery", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ models: [{ modelId: "claude-sonnet-4.5", modelName: "Claude Sonnet 4.5" }] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);
		const oauth = await getOAuthApiKey("kiro", { kiro: { ...SOCIAL_CREDENTIAL, expires: Date.now() + 60_000 } });
		if (!oauth) throw new Error("expected structured Kiro OAuth key");
		const structuredKey = JSON.parse(oauth.apiKey) as { token: string; profileArn?: string };
		expect(structuredKey.profileArn).toBe(SOCIAL_PROFILE_ARN);

		const manager = kiroModelManagerOptions({ apiKey: oauth.apiKey });
		if (!manager.fetchDynamicModels) throw new Error("expected Kiro OAuth model discovery");
		const models = await manager.fetchDynamicModels();

		expect(models?.map(model => model.id)).toContain("claude-sonnet-4.5");
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		const [url, init] = fetchSpy.mock.calls[0]!;
		expect(url).toBe("https://codewhisperer.us-east-1.amazonaws.com/");
		const headers = new Headers(init?.headers);
		expect(headers.get("authorization")).toBe("Bearer social-access-token");
		expect(headers.get("x-amz-target")).toBe("AmazonCodeWhispererService.ListAvailableModels");
		expect(headers.has("tokentype")).toBe(false);
		expect(JSON.parse(String(init?.body))).toEqual({ origin: "AI_EDITOR", profileArn: SOCIAL_PROFILE_ARN });
	});
});
