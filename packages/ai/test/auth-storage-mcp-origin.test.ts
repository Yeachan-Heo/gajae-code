import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import fc from "fast-check";
import { oauthCredentialSchema, remoteOauthCredentialSchema } from "../src/auth-broker/wire-schemas";
import {
	AuthStorage,
	REMOTE_REFRESH_SENTINEL,
	resolveMCPOAuthResourceOrigin,
	resolveMCPOAuthTokenEndpoint,
	SqliteAuthCredentialStore,
} from "../src/auth-storage";

describe("MCP OAuth credential binding persistence", () => {
	let tempDir = "";

	afterEach(async () => {
		if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
		tempDir = "";
	});

	test("preserves the bound MCP and token endpoints across storage reopen", async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-mcp-oauth-origin-"));
		const dbPath = path.join(tempDir, "agent.db");
		const provider = "mcp_oauth_test";
		const firstStore = await SqliteAuthCredentialStore.open(dbPath);
		firstStore.replaceAuthCredentialsForProvider(provider, [
			{
				type: "oauth",
				access: "access",
				refresh: "refresh",
				expires: Date.now() + 60_000,
				mcpBinding: {
					resourceOrigin: "https://mcp.example",
					tokenEndpoint: "https://auth.example/token",
				},
			},
		]);
		firstStore.close();

		const reopenedStore = await SqliteAuthCredentialStore.open(dbPath);
		try {
			expect(reopenedStore.listAuthCredentials(provider)[0]?.credential).toMatchObject({
				type: "oauth",
				mcpBinding: {
					resourceOrigin: "https://mcp.example",
					tokenEndpoint: "https://auth.example/token",
				},
			});
		} finally {
			reopenedStore.close();
		}
	});

	test("rejects malformed or noncanonical bindings on upload, snapshot, and refresh", async () => {
		const invalidBindings = [
			{ resourceOrigin: "not-a-url", tokenEndpoint: "https://auth.example/token" },
			{ resourceOrigin: "https://user@mcp.example", tokenEndpoint: "https://auth.example/token" },
			{ resourceOrigin: "https://mcp.example/", tokenEndpoint: "https://auth.example/token" },
			{ resourceOrigin: "https://mcp.example", tokenEndpoint: "https://auth.example:443/token" },
			{ resourceOrigin: "https://mcp.example", tokenEndpoint: "https://user:pass@auth.example/token" },
		];
		for (const mcpBinding of invalidBindings) {
			const credential = { type: "oauth" as const, access: "access", expires: 0, mcpBinding };
			expect(oauthCredentialSchema.safeParse({ ...credential, refresh: "refresh" }).success).toBe(false);
			expect(
				remoteOauthCredentialSchema.safeParse({ ...credential, refresh: REMOTE_REFRESH_SENTINEL }).success,
			).toBe(false);
		}

		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-mcp-oauth-invalid-binding-"));
		const storage = new AuthStorage(await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db")));
		await storage.reload();
		await storage.set("mcp_oauth_invalid", {
			type: "oauth",
			access: "old-access",
			refresh: "refresh",
			expires: 0,
			mcpBinding: invalidBindings[4],
		});
		const credential = storage.get("mcp_oauth_invalid");
		if (credential?.type !== "oauth") throw new Error("expected OAuth credential");
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		try {
			await expect(storage.forceRefreshOAuthCredential("mcp_oauth_invalid", credential)).rejects.toThrow(
				"Invalid MCP OAuth credential binding",
			);
			expect(fetchSpy).not.toHaveBeenCalled();
		} finally {
			storage.close();
			fetchSpy.mockRestore();
		}
	});

	test("refreshes a local MCP credential through its stored token endpoint and preserves its binding", async () => {
		let requestBody = "";
		const tokenServer = Bun.serve({
			port: 0,
			async fetch(request) {
				requestBody = await request.text();
				return Response.json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 });
			},
		});
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-mcp-oauth-refresh-"));
		const dbPath = path.join(tempDir, "agent.db");
		const provider = "mcp_oauth_local";
		const binding = {
			resourceOrigin: "https://mcp.example",
			tokenEndpoint: tokenServer.url.href,
		};
		const storage = new AuthStorage(await SqliteAuthCredentialStore.open(dbPath));
		await storage.reload();
		await storage.set(provider, {
			type: "oauth",
			access: "old-access",
			refresh: "local-refresh-secret",
			expires: Date.now() - 1,
			mcpBinding: binding,
		});

		try {
			const credential = storage.get(provider);
			if (credential?.type !== "oauth") throw new Error("expected OAuth credential");
			const refreshed = await storage.forceRefreshOAuthCredential(provider, credential, {
				clientId: "bound-client",
				clientSecret: "bound-secret",
			});
			expect(refreshed).toMatchObject({ access: "new-access", mcpBinding: binding });
			expect(requestBody).toContain("refresh_token=local-refresh-secret");
			expect(requestBody).toContain("client_id=bound-client");
			expect(requestBody).toContain("client_secret=bound-secret");
			expect(storage.get(provider)).toMatchObject({
				access: "new-access",
				refresh: "new-refresh",
				mcpBinding: binding,
			});
		} finally {
			storage.close();
			await tokenServer.stop(true);
		}
	});

	test("rejects 307 and 308 redirects without forwarding MCP refresh credentials", async () => {
		const forwardedBodies: string[] = [];
		const redirectTarget = Bun.serve({
			port: 0,
			async fetch(request) {
				forwardedBodies.push(await request.text());
				return Response.json({ access_token: "attacker-access" });
			},
		});
		let redirectStatus = 307;
		let tokenEndpointCalls = 0;
		const tokenServer = Bun.serve({
			port: 0,
			fetch() {
				tokenEndpointCalls++;
				return new Response(null, {
					status: redirectStatus,
					headers: { Location: redirectTarget.url.href },
				});
			},
		});
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-mcp-oauth-redirect-"));
		const provider = "mcp_oauth_redirect";
		const storage = new AuthStorage(await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db")));
		await storage.reload();
		await storage.set(provider, {
			type: "oauth",
			access: "old-access",
			refresh: "redirect-refresh-secret",
			expires: 0,
			mcpBinding: {
				resourceOrigin: "https://mcp.example",
				tokenEndpoint: tokenServer.url.href,
			},
		});

		try {
			for (redirectStatus of [307, 308]) {
				const credential = storage.get(provider);
				if (credential?.type !== "oauth") throw new Error("expected OAuth credential");
				await expect(
					storage.forceRefreshOAuthCredential(
						provider,
						credential,
						{ clientId: "redirect-client", clientSecret: "redirect-client-secret" },
						undefined,
					),
				).rejects.toThrow(`MCP OAuth refresh rejected redirect response (${redirectStatus})`);
			}
			expect(tokenEndpointCalls).toBe(2);
			expect(forwardedBodies).toEqual([]);
			expect(storage.get(provider)).toMatchObject({
				access: "old-access",
				refresh: "redirect-refresh-secret",
			});
		} finally {
			storage.close();
			await tokenServer.stop(true);
			await redirectTarget.stop(true);
		}
	});

	test("passes caller cancellation to the bound token fetch", async () => {
		const fetchStarted = Promise.withResolvers<AbortSignal>();
		const fetchMock = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const requestSignal = init?.signal;
			if (!requestSignal) throw new Error("expected refresh fetch signal");
			fetchStarted.resolve(requestSignal);
			const pending = Promise.withResolvers<void>();
			const rejectOnAbort = (): void => pending.reject(new Error("token request aborted"));
			if (requestSignal.aborted) {
				rejectOnAbort();
			} else {
				requestSignal.addEventListener("abort", rejectOnAbort, { once: true });
			}
			await pending.promise;
			return Response.json({ access_token: "unexpected-access" });
		};
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as unknown as typeof fetch);
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-mcp-oauth-abort-"));
		const provider = "mcp_oauth_abort";
		const storage = new AuthStorage(await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db")));
		await storage.reload();
		await storage.set(provider, {
			type: "oauth",
			access: "old-access",
			refresh: "abort-refresh-secret",
			expires: 0,
			mcpBinding: {
				resourceOrigin: "https://mcp.example",
				tokenEndpoint: "https://auth.example/token",
			},
		});
		const credential = storage.get(provider);
		if (credential?.type !== "oauth") throw new Error("expected OAuth credential");
		const controller = new AbortController();

		try {
			const refresh = storage.forceRefreshOAuthCredential(provider, credential, {}, controller.signal);
			expect(await fetchStarted.promise).toBe(controller.signal);
			controller.abort();
			await expect(refresh).rejects.toThrow("credential refresh aborted");
			expect(storage.get(provider)).toMatchObject({
				access: "old-access",
				refresh: "abort-refresh-secret",
			});
		} finally {
			storage.close();
			fetchSpy.mockRestore();
		}
	});

	test("rejects invalid refresh payloads through AuthStorage without persisting them", async () => {
		let payload: unknown;
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation((async () => Response.json(payload)) as unknown as typeof fetch);
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-mcp-oauth-invalid-refresh-"));
		const storage = new AuthStorage(await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db")));
		await storage.reload();
		await storage.set("mcp_oauth_invalid_refresh", {
			type: "oauth",
			access: "old-access",
			refresh: "refresh",
			expires: 0,
			mcpBinding: { resourceOrigin: "https://mcp.example", tokenEndpoint: "https://auth.example/token" },
		});
		const credential = storage.get("mcp_oauth_invalid_refresh");
		if (credential?.type !== "oauth") throw new Error("expected OAuth credential");
		try {
			for (payload of [
				null,
				{},
				{ access_token: 1 },
				{ access_token: "" },
				{ access_token: "access", refresh_token: 1 },
				{ access_token: "access", expires_in: "3600" },
				{ access_token: "access", expires_in: -1 },
			]) {
				await expect(
					storage.forceRefreshOAuthCredential("mcp_oauth_invalid_refresh", credential),
				).rejects.toThrow();
				const stored = storage.get("mcp_oauth_invalid_refresh");
				expect(stored?.type === "oauth" ? stored.access : undefined).toBe("old-access");
			}
		} finally {
			storage.close();
			fetchSpy.mockRestore();
		}
	});

	test("refreshes the exact requested credential when a provider has multiple rows", async () => {
		let firstCalls = 0;
		let secondCalls = 0;
		const firstServer = Bun.serve({
			port: 0,
			fetch() {
				firstCalls++;
				return Response.json({ access_token: "wrong-access" });
			},
		});
		const secondServer = Bun.serve({
			port: 0,
			fetch() {
				secondCalls++;
				return Response.json({ access_token: "second-access" });
			},
		});
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-mcp-oauth-exact-"));
		const storage = new AuthStorage(await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db")));
		await storage.reload();
		const first = {
			type: "oauth" as const,
			access: "first-old",
			refresh: "first-refresh",
			expires: 0,
			accountId: "first",
			mcpBinding: { resourceOrigin: "https://first.example", tokenEndpoint: firstServer.url.href },
		};
		const second = {
			type: "oauth" as const,
			access: "second-old",
			refresh: "second-refresh",
			expires: 0,
			accountId: "second",
			mcpBinding: { resourceOrigin: "https://second.example", tokenEndpoint: secondServer.url.href },
		};
		await storage.set("mcp_oauth_multiple", [first, second]);

		try {
			const refreshed = await storage.forceRefreshOAuthCredential("mcp_oauth_multiple", second);
			expect(refreshed.access).toBe("second-access");
			expect(firstCalls).toBe(0);
			expect(secondCalls).toBe(1);
		} finally {
			storage.close();
			await firstServer.stop(true);
			await secondServer.stop(true);
		}
	});
});

describe("MCP OAuth token endpoint TLS", () => {
	const cleartextRefused = [
		"http://192.0.0.9/token",
		"http://192.0.0.10/token",
		"http://[::ffff:c000:9]/token",
		"http://[::ffff:c000:a]/token",
		"http://192.0.0.8/token",
		"http://192.0.0.11/token",
		"http://attacker.example/token",
		"http://10.0.0.1/token",
	];
	const httpsStillAllowed = [
		"https://192.0.0.9/token",
		"https://192.0.0.10/token",
		"https://[::ffff:c000:9]/token",
		"https://[::ffff:c000:a]/token",
		"https://192.0.0.8/token",
		"https://192.0.0.11/token",
		"https://attacker.example/token",
		"https://10.0.0.1/token",
	];
	const loopbackStillAllowed = [
		"http://127.0.0.1/token",
		"http://localhost/token",
		"http://localhost./token",
		"http://[::1]/token",
		"http://[::ffff:7f00:1]/token",
	];

	async function refreshTokenEndpoint(
		tokenEndpoint: string,
	): Promise<{ fetchedBody: string | null; error: string | null }> {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-mcp-oauth-tls-"));
		let fetchedBody: string | null = null;
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async (
			input: string | URL | Request,
			init?: RequestInit,
		) => {
			const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			if (href !== tokenEndpoint) throw new Error(`unexpected token endpoint ${href}`);
			fetchedBody = String(init?.body ?? "");
			return Response.json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 });
		}) as unknown as typeof fetch);
		const storage = new AuthStorage(await SqliteAuthCredentialStore.open(path.join(dir, "agent.db")));
		try {
			await storage.reload();
			await storage.set("mcp_oauth_tls", {
				type: "oauth",
				access: "old-access",
				refresh: "refresh-secret",
				expires: 0,
				mcpBinding: { resourceOrigin: "https://mcp.example", tokenEndpoint },
			});
			const credential = storage.get("mcp_oauth_tls");
			if (credential?.type !== "oauth") throw new Error("expected OAuth credential");
			await storage.forceRefreshOAuthCredential("mcp_oauth_tls", credential, {
				clientId: "bound-client",
				clientSecret: "bound-secret",
			});
			return { fetchedBody, error: null };
		} catch (error) {
			return { fetchedBody, error: error instanceof Error ? error.message : String(error) };
		} finally {
			fetchSpy.mockRestore();
			storage.close();
			await fs.rm(dir, { recursive: true, force: true });
		}
	}

	test("does not refresh globally reachable anycast addresses over HTTP, including mapped forms", async () => {
		for (const tokenEndpoint of [
			"http://192.0.0.9/token",
			"http://192.0.0.10/token",
			"http://[::ffff:c000:9]/token",
			"http://[::ffff:c000:a]/token",
		]) {
			expect(resolveMCPOAuthTokenEndpoint(tokenEndpoint)).toBeUndefined();
			expect(resolveMCPOAuthTokenEndpoint("http://[::ffff:192.0.0.9]/token")).toBeUndefined();
			expect(resolveMCPOAuthTokenEndpoint("http://[0:0:0:0:0:ffff:192.0.0.10]/token")).toBeUndefined();
			const outcome = await refreshTokenEndpoint(tokenEndpoint);
			expect(outcome.fetchedBody).toBeNull();
			expect(outcome.error).toContain("Invalid MCP OAuth credential binding");
		}
	});

	test("still refreshes the https form of those addresses and adjacent hosts", async () => {
		for (const tokenEndpoint of httpsStillAllowed) {
			expect(resolveMCPOAuthTokenEndpoint(tokenEndpoint)).toBe(tokenEndpoint);
			const outcome = await refreshTokenEndpoint(tokenEndpoint);
			expect(outcome.error).toBeNull();
			expect(outcome.fetchedBody).toContain("refresh_token=refresh-secret");
			expect(outcome.fetchedBody).toContain("client_secret=bound-secret");
		}
	});

	test("still refreshes a loopback http token endpoint, including the mapped form", async () => {
		for (const tokenEndpoint of loopbackStillAllowed) {
			expect(resolveMCPOAuthTokenEndpoint(tokenEndpoint)).toBe(new URL(tokenEndpoint).href);
			const outcome = await refreshTokenEndpoint(new URL(tokenEndpoint).href);
			expect(outcome.error).toBeNull();
			expect(outcome.fetchedBody).toContain("refresh_token=refresh-secret");
		}
	});

	test("refuses other cleartext token endpoints and leaves the resource origin on http", async () => {
		for (const tokenEndpoint of cleartextRefused) {
			expect(resolveMCPOAuthTokenEndpoint(tokenEndpoint)).toBeUndefined();
		}
		expect(resolveMCPOAuthResourceOrigin("http://192.0.0.9")).toBe("http://192.0.0.9");
		expect(resolveMCPOAuthResourceOrigin("http://attacker.example")).toBe("http://attacker.example");
		const credential = {
			type: "oauth" as const,
			access: "access",
			refresh: "refresh",
			expires: 0,
			mcpBinding: { resourceOrigin: "https://mcp.example", tokenEndpoint: "http://192.0.0.9/token" },
		};
		expect(oauthCredentialSchema.safeParse(credential).success).toBe(false);
	});

	test("property: non-loopback token endpoints are https, fc.property seed 65827, numRuns 80", () => {
		const letter = fc.integer({ min: 0, max: 25 }).map(value => String.fromCharCode(97 + value));
		fc.assert(
			fc.property(
				fc.integer({ min: 0, max: 255 }),
				fc.integer({ min: 0, max: 255 }),
				fc.integer({ min: 0, max: 255 }),
				fc.integer({ min: 0, max: 255 }),
				letter,
				letter,
				letter,
				(a, b, c, d, x, y, z) => {
					const host = `${a}.${b}.${c}.${d}`;
					const loopback = a === 127;
					const http = resolveMCPOAuthTokenEndpoint(`http://${host}/token`);
					const https = resolveMCPOAuthTokenEndpoint(`https://${host}/token`);
					const mappedHttp = resolveMCPOAuthTokenEndpoint(`http://[::ffff:${host}]/token`);
					const mappedHttps = resolveMCPOAuthTokenEndpoint(`https://[::ffff:${host}]/token`);
					const name = `${x}${y}${z}.example`;
					const namedHttp = resolveMCPOAuthTokenEndpoint(`http://${name}/token`);
					const namedHttps = resolveMCPOAuthTokenEndpoint(`https://${name}/token`);
					const httpOk = loopback ? http === `http://${host}/token` : http === undefined;
					const mappedHttpOk = loopback
						? mappedHttp?.startsWith("http:") === true && resolveMCPOAuthTokenEndpoint(mappedHttp) === mappedHttp
						: mappedHttp === undefined;
					const mappedHttpsOk =
						mappedHttps?.startsWith("https://") === true &&
						resolveMCPOAuthTokenEndpoint(mappedHttps) === mappedHttps;
					return (
						httpOk &&
						mappedHttpOk &&
						https === `https://${host}/token` &&
						resolveMCPOAuthTokenEndpoint(https) === https &&
						mappedHttpsOk &&
						namedHttp === undefined &&
						namedHttps === `https://${name}/token`
					);
				},
			),
			{ seed: 65827, numRuns: 80 },
		);
	});
});
