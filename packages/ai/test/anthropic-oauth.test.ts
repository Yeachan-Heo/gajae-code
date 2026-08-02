import { afterEach, describe, expect, it, vi } from "bun:test";
import { buildAnthropicAuthConfig, buildAnthropicUrl } from "../src/utils/anthropic-auth";
import { ANTHROPIC_MANUAL_REDIRECT_URI, AnthropicOAuthFlow, refreshAnthropicToken } from "../src/utils/oauth/anthropic";
import { withEnv } from "./helpers";

const originalFetch = global.fetch;

afterEach(() => {
	global.fetch = originalFetch;
	vi.restoreAllMocks();
});

describe("anthropic oauth alignment", () => {
	it("generates auth URL with expected scope set", async () => {
		const flow = new AnthropicOAuthFlow({});
		const state = "state-123";
		const redirectUri = "http://localhost:54545/callback";

		const { url } = await flow.generateAuthUrl(state, redirectUri);
		const authUrl = new URL(url);

		expect(authUrl.origin + authUrl.pathname).toBe("https://claude.ai/oauth/authorize");
		expect(authUrl.searchParams.get("scope")).toBe("org:create_api_key user:profile user:inference");
		expect(authUrl.searchParams.get("state")).toBe(state);
		expect(authUrl.searchParams.get("redirect_uri")).toBe(redirectUri);
		expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");
	});

	it("uses api.anthropic.com token URL for code exchange", async () => {
		const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
			expect(typeof input === "string" ? input : input.toString()).toBe("https://api.anthropic.com/v1/oauth/token");
			expect(init?.method).toBe("POST");
			return new Response(
				JSON.stringify({
					access_token: "access-token",
					refresh_token: "refresh-token",
					expires_in: 3600,
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});
		global.fetch = fetchMock as unknown as typeof fetch;

		const flow = new AnthropicOAuthFlow({});
		await flow.generateAuthUrl("state-123", "http://localhost:54545/callback");

		const result = await flow.exchangeToken("code-123", "state-123", "http://localhost:54545/callback");

		expect(result.access).toBe("access-token");
		expect(result.refresh).toBe("refresh-token");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("parses callback code fragments into token exchange code/state", async () => {
		const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
			expect(typeof input === "string" ? input : input.toString()).toBe("https://api.anthropic.com/v1/oauth/token");
			const payload = JSON.parse(String(init?.body));
			expect(payload.code).toBe("code-123");
			expect(payload.state).toBe("state-override");
			return new Response(
				JSON.stringify({
					access_token: "access-token",
					refresh_token: "refresh-token",
					expires_in: 3600,
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});
		global.fetch = fetchMock as unknown as typeof fetch;

		const flow = new AnthropicOAuthFlow({});
		await flow.generateAuthUrl("state-123", "http://localhost:54545/callback");
		await flow.exchangeToken("code-123#state-override", "state-123", "http://localhost:54545/callback");

		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("keeps explicit state when callback code fragment state is empty", async () => {
		const fetchMock = vi.fn(async (_input: string | URL, init?: RequestInit) => {
			const payload = JSON.parse(String(init?.body));
			expect(payload.code).toBe("code-123");
			expect(payload.state).toBe("state-explicit");
			return new Response(
				JSON.stringify({
					access_token: "access-token",
					refresh_token: "refresh-token",
					expires_in: 3600,
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});
		global.fetch = fetchMock as unknown as typeof fetch;

		const flow = new AnthropicOAuthFlow({});
		await flow.generateAuthUrl("state-123", "http://localhost:54545/callback");
		await flow.exchangeToken("code-123#", "state-explicit", "http://localhost:54545/callback");

		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
	it("uses api.anthropic.com token URL for refresh", async () => {
		const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
			expect(typeof input === "string" ? input : input.toString()).toBe("https://api.anthropic.com/v1/oauth/token");
			expect(init?.method).toBe("POST");
			return new Response(
				JSON.stringify({
					access_token: "new-access-token",
					refresh_token: "new-refresh-token",
					expires_in: 7200,
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});
		global.fetch = fetchMock as unknown as typeof fetch;

		const result = await refreshAnthropicToken("refresh-123");

		expect(result.access).toBe("new-access-token");
		expect(result.refresh).toBe("new-refresh-token");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("extracts account uuid and email from token-exchange response", async () => {
		const fetchMock = vi.fn(async () => {
			return new Response(
				JSON.stringify({
					access_token: "access-token",
					refresh_token: "refresh-token",
					expires_in: 3600,
					account: {
						uuid: "11111111-2222-3333-4444-555555555555",
						email_address: "user@example.com",
					},
					organization: { uuid: "99999999-8888-7777-6666-555555555555" },
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});
		global.fetch = fetchMock as unknown as typeof fetch;

		const flow = new AnthropicOAuthFlow({});
		await flow.generateAuthUrl("state-123", "http://localhost:54545/callback");
		const result = await flow.exchangeToken("code-123", "state-123", "http://localhost:54545/callback");

		expect(result.accountId).toBe("11111111-2222-3333-4444-555555555555");
		expect(result.email).toBe("user@example.com");
	});

	it("extracts account uuid and email from refresh response", async () => {
		const fetchMock = vi.fn(async () => {
			return new Response(
				JSON.stringify({
					access_token: "new-access-token",
					refresh_token: "new-refresh-token",
					expires_in: 7200,
					account: {
						uuid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
						email_address: "refreshed@example.com",
					},
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});
		global.fetch = fetchMock as unknown as typeof fetch;

		const result = await refreshAnthropicToken("refresh-123");

		expect(result.accountId).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
		expect(result.email).toBe("refreshed@example.com");
	});

	it("leaves accountId/email undefined when token response omits account block", async () => {
		const fetchMock = vi.fn(async () => {
			return new Response(
				JSON.stringify({
					access_token: "access-token",
					refresh_token: "refresh-token",
					expires_in: 3600,
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});
		global.fetch = fetchMock as unknown as typeof fetch;

		const flow = new AnthropicOAuthFlow({});
		await flow.generateAuthUrl("state-noaccount", "http://localhost:54545/callback");
		const result = await flow.exchangeToken("code-noaccount", "state-noaccount", "http://localhost:54545/callback");

		expect(result.accountId).toBeUndefined();
		expect(result.email).toBeUndefined();
	});
});

function tokenResponseFetch(onBody: (body: Record<string, string>) => void) {
	return vi.fn(async (_input: string | URL, init?: RequestInit) => {
		onBody(JSON.parse(String(init?.body)) as Record<string, string>);
		return new Response(
			JSON.stringify({ access_token: "access-token", refresh_token: "refresh-token", expires_in: 3600 }),
			{ status: 200, headers: { "Content-Type": "application/json" } },
		);
	});
}

/**
 * Serves the pasted values in order. Once the list is exhausted the handler
 * parks forever instead of resolving: the flow re-prompts in a loop until a
 * value is accepted, so returning a rejected value repeatedly would spin.
 */
function pasteHandler(values: string[]): () => Promise<string> {
	const exhausted = Promise.withResolvers<string>();
	return () => {
		const next = values.shift();
		return next === undefined ? exhausted.promise : Promise.resolve(next);
	};
}

describe("anthropic paste-a-code login", () => {
	it("pairs through the hosted redirect without touching the loopback port", async () => {
		// Occupy the loopback callback port. Had the manual flow still tried to bind
		// it, the base class would fall back to a random port and announce that
		// through onProgress -- which is exactly what must never happen here.
		let blocker: Bun.Server<unknown> | undefined;
		try {
			blocker = Bun.serve({ port: 54545, hostname: "localhost", fetch: () => new Response("blocked") });
		} catch {
			// Already occupied by something else; the assertion below still holds.
		}
		let exchangeBody: Record<string, string> = {};
		global.fetch = tokenResponseFetch(body => {
			exchangeBody = body;
		}) as unknown as typeof fetch;
		let authorizeUrl = "";
		let issuedState = "";
		const progress: string[] = [];

		try {
			const credentials = await new AnthropicOAuthFlow(
				{
					onAuth: info => {
						authorizeUrl = info.url;
						issuedState = new URL(info.url).searchParams.get("state") ?? "";
					},
					onProgress: message => progress.push(message),
					// Anthropic's page renders the grant as `code#state`.
					onManualCodeInput: () => Promise.resolve(`pasted-code#${issuedState}`),
				},
				{ manualCode: true },
			).login();

			expect(progress).toContain("Waiting for the authorization code...");
			expect(progress.some(message => message.includes("Preferred port"))).toBe(false);
			// Authorization and exchange must advertise the same redirect, or Anthropic rejects the grant.
			expect(new URL(authorizeUrl).searchParams.get("redirect_uri")).toBe(ANTHROPIC_MANUAL_REDIRECT_URI);
			expect(exchangeBody.redirect_uri).toBe(ANTHROPIC_MANUAL_REDIRECT_URI);
			// The page renders `code#state`; only the code belongs in the `code` field.
			expect(exchangeBody.code).toBe("pasted-code");
			expect(exchangeBody.state).toBe(issuedState);
			expect(credentials.access).toBe("access-token");
		} finally {
			blocker?.stop(true);
		}
	});

	it("keeps every authorize parameter except the redirect identical to the loopback login", async () => {
		global.fetch = tokenResponseFetch(() => {}) as unknown as typeof fetch;
		let manualUrl = "";
		await new AnthropicOAuthFlow(
			{
				onAuth: info => {
					manualUrl = info.url;
				},
				onManualCodeInput: pasteHandler(["pasted-code"]),
			},
			{ manualCode: true },
		).login();
		const loopback = await new AnthropicOAuthFlow({}).generateAuthUrl("state-123", "http://localhost:54545/callback");

		const manualParams = new URL(manualUrl).searchParams;
		const loopbackParams = new URL(loopback.url).searchParams;
		const names = (params: URLSearchParams) => [...params.keys()].sort();

		expect(names(manualParams)).toEqual(names(loopbackParams));
		for (const key of ["code", "client_id", "response_type", "scope", "code_challenge_method"]) {
			expect(manualParams.get(key)).toBe(loopbackParams.get(key));
		}
		expect(manualParams.get("redirect_uri")).toBe(ANTHROPIC_MANUAL_REDIRECT_URI);
		expect(loopbackParams.get("redirect_uri")).toBe("http://localhost:54545/callback");
	});

	it("rejects a pasted code whose state does not match the request", async () => {
		let exchangeBody: Record<string, string> = {};
		global.fetch = tokenResponseFetch(body => {
			exchangeBody = body;
		}) as unknown as typeof fetch;
		let issuedState = "";
		const pasted = ["injected-code#attacker-state", "unused"];
		const nextPaste = pasteHandler(pasted);

		await new AnthropicOAuthFlow(
			{
				onAuth: info => {
					issuedState = new URL(info.url).searchParams.get("state") ?? "";
					pasted[1] = `expected-code#${issuedState}`;
				},
				onManualCodeInput: nextPaste,
			},
			{ manualCode: true },
		).login();

		expect(issuedState).not.toBe("");
		expect(exchangeBody.code).toBe("expected-code");
		expect(exchangeBody.state).toBe(issuedState);
	});

	it("fails before opening a browser when no paste handler is available", async () => {
		const onAuth = vi.fn();

		await expect(new AnthropicOAuthFlow({ onAuth }, { manualCode: true }).login()).rejects.toThrow(
			/manual authorization-code handler/,
		);
		expect(onAuth).not.toHaveBeenCalled();
	});

	it("still serves a loopback callback when the flag is absent, even after port fallback", async () => {
		// Hold the preferred port so the loopback flow is pushed down its fallback
		// path; authorize and exchange must still agree on the port it landed on.
		let blocker: Bun.Server<unknown> | undefined;
		// Not every host refuses a second bind of the same loopback address, so
		// probe with a control bind instead of assuming the block took effect.
		let duplicateBindsRejected = false;
		try {
			blocker = Bun.serve({ port: 54545, hostname: "localhost", fetch: () => new Response("blocked") });
			try {
				Bun.serve({ port: 54545, hostname: "localhost", fetch: () => new Response("probe") }).stop(true);
			} catch {
				duplicateBindsRejected = true;
			}
		} catch {
			// Occupied by something else: the flow falls back either way.
		}
		let exchangeBody: Record<string, string> = {};
		global.fetch = tokenResponseFetch(body => {
			exchangeBody = body;
		}) as unknown as typeof fetch;
		let authorizeUrl = "";
		let issuedState = "";

		try {
			await new AnthropicOAuthFlow({
				onAuth: info => {
					authorizeUrl = info.url;
					issuedState = new URL(info.url).searchParams.get("state") ?? "";
				},
				onManualCodeInput: () => Promise.resolve(`loopback-code#${issuedState}`),
			}).login();

			const advertised = new URL(authorizeUrl).searchParams.get("redirect_uri") ?? "";
			expect(advertised).toMatch(/^http:\/\/localhost:\d+\/callback$/);
			expect(exchangeBody.redirect_uri).toBe(advertised);
			if (blocker && duplicateBindsRejected) {
				expect(advertised).not.toBe("http://localhost:54545/callback");
			}
		} finally {
			blocker?.stop(true);
		}
	});

	it("cancels instead of re-prompting when the paste handler rejects", async () => {
		global.fetch = tokenResponseFetch(() => {}) as unknown as typeof fetch;
		let prompts = 0;

		await expect(
			new AnthropicOAuthFlow(
				{
					onManualCodeInput: () => {
						prompts += 1;
						return Promise.reject(new Error("Manual OAuth input cleared"));
					},
				},
				{ manualCode: true },
			).login(),
		).rejects.toThrow("Manual OAuth input cleared");
		// A retry loop here would spin without a local listener to break it.
		expect(prompts).toBe(1);
	});

	it("settles when the controller signal aborted before the wait started", async () => {
		global.fetch = tokenResponseFetch(() => {}) as unknown as typeof fetch;
		const controller = new AbortController();
		controller.abort(new Error("user cancelled"));
		const neverPasted = Promise.withResolvers<string>();

		await expect(
			new AnthropicOAuthFlow(
				{
					signal: controller.signal,
					onManualCodeInput: () => neverPasted.promise,
				},
				{ manualCode: true },
			).login(),
		).rejects.toThrow(/OAuth callback cancelled/);
	});

	it("pins the hosted redirect to a constant that no environment can rewrite", async () => {
		global.fetch = tokenResponseFetch(() => {}) as unknown as typeof fetch;
		let authorizeUrl = "";
		await withEnv(
			{
				ANTHROPIC_MANUAL_REDIRECT_URI: "https://attacker.example.com/steal",
				ANTHROPIC_OAUTH_REDIRECT_URI: "https://attacker.example.com/steal",
				OAUTH_REDIRECT_URI: "https://attacker.example.com/steal",
			},
			async () => {
				await new AnthropicOAuthFlow(
					{
						onAuth: info => {
							authorizeUrl = info.url;
						},
						onManualCodeInput: pasteHandler(["pasted-code"]),
					},
					{ manualCode: true },
				).login();
			},
		);

		expect(ANTHROPIC_MANUAL_REDIRECT_URI).toBe("https://platform.claude.com/oauth/code/callback");
		expect(new URL(authorizeUrl).searchParams.get("redirect_uri")).toBe(ANTHROPIC_MANUAL_REDIRECT_URI);
	});
});

describe("buildAnthropicAuthConfig", () => {
	it("classifies sk-ant-oat tokens as OAuth", () => {
		const config = buildAnthropicAuthConfig("sk-ant-oat-foobar");
		expect(config.isOAuth).toBe(true);
		expect(config.apiKey).toBe("sk-ant-oat-foobar");
	});

	it("treats sk-ant-api tokens as non-OAuth", () => {
		const config = buildAnthropicAuthConfig("sk-ant-api-foobar");
		expect(config.isOAuth).toBe(false);
	});

	it("normalizes the explicit baseUrl override (trailing slash, env precedence)", async () => {
		await withEnv(
			{
				CLAUDE_CODE_USE_FOUNDRY: "true",
				FOUNDRY_BASE_URL: "https://foundry.example.com/anthropic/",
				ANTHROPIC_BASE_URL: undefined,
			},
			async () => {
				const explicit = buildAnthropicAuthConfig("sk-ant-api-key", "https://override.example.com/");
				expect(explicit.baseUrl).toBe("https://override.example.com");
				expect(buildAnthropicUrl(explicit)).toBe("https://override.example.com/v1/messages?beta=true");
			},
		);
	});

	it("falls back to FOUNDRY_BASE_URL when Foundry mode is enabled and no explicit override is given", async () => {
		await withEnv(
			{
				CLAUDE_CODE_USE_FOUNDRY: "true",
				FOUNDRY_BASE_URL: "https://foundry.example.com/anthropic/",
				ANTHROPIC_BASE_URL: undefined,
			},
			async () => {
				const config = buildAnthropicAuthConfig("sk-ant-api-key");
				expect(config.baseUrl).toBe("https://foundry.example.com/anthropic");
			},
		);
	});

	it("falls back to ANTHROPIC_BASE_URL when Foundry mode is disabled", async () => {
		await withEnv(
			{
				CLAUDE_CODE_USE_FOUNDRY: undefined,
				FOUNDRY_BASE_URL: undefined,
				ANTHROPIC_BASE_URL: "https://anthropic.example.com/",
			},
			async () => {
				const config = buildAnthropicAuthConfig("sk-ant-api-key");
				expect(config.baseUrl).toBe("https://anthropic.example.com");
			},
		);
	});

	it("uses the default Anthropic base URL when no env or override is set", async () => {
		await withEnv(
			{
				CLAUDE_CODE_USE_FOUNDRY: undefined,
				FOUNDRY_BASE_URL: undefined,
				ANTHROPIC_BASE_URL: undefined,
			},
			async () => {
				const config = buildAnthropicAuthConfig("sk-ant-api-key");
				expect(config.baseUrl).toBe("https://api.anthropic.com");
			},
		);
	});
});
