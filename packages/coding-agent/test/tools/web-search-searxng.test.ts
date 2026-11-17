import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { hookFetch } from "@gajae-code/utils";
import { resetSettingsForTest, Settings } from "../../src/config/settings";
import { searchSearXNG } from "../../src/web/search/providers/searxng";

describe("SearXNG web search provider", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		resetSettingsForTest();
		delete process.env.SEARXNG_ENDPOINT;
		delete process.env.SEARXNG_TOKEN;
		delete process.env.SEARXNG_BASIC_USERNAME;
		delete process.env.SEARXNG_BASIC_PASSWORD;
	});

	it("sends RFC 7617 Basic auth when username and password are configured", async () => {
		process.env.SEARXNG_ENDPOINT = "https://searx.example.org/";
		process.env.SEARXNG_BASIC_USERNAME = "alice";
		process.env.SEARXNG_BASIC_PASSWORD = "s3cret";

		const captured: { url?: URL; headers?: Headers } = {};
		using _hook = hookFetch((input, init) => {
			captured.url = new URL(input.toString());
			captured.headers = new Headers(init?.headers);
			return new Response(
				JSON.stringify({
					results: [{ title: "SearXNG", url: "https://example.com/result", content: "Metasearch result" }],
					suggestions: ["related search"],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});

		const response = await searchSearXNG({ query: "private search", num_results: 1, recency: "week" });

		expect(captured.url?.origin).toBe("https://searx.example.org");
		expect(captured.url?.pathname).toBe("/search");
		expect(captured.url?.searchParams.get("q")).toBe("private search");
		expect(captured.url?.searchParams.get("format")).toBe("json");
		expect(captured.url?.searchParams.get("time_range")).toBe("month");
		expect(captured.headers?.get("Authorization")).toBe(
			`Basic ${Buffer.from("alice:s3cret", "utf-8").toString("base64")}`,
		);
		expect(response).toMatchObject({
			provider: "searxng",
			relatedQuestions: ["related search"],
			sources: [{ title: "SearXNG", url: "https://example.com/result", snippet: "Metasearch result" }],
		});
	});

	it("reads Basic auth credentials from nested config.yml settings", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "searxng-settings-"));
		try {
			await Bun.write(
				path.join(agentDir, "config.yml"),
				[
					"searxng:",
					"  endpoint: https://searx.example.org",
					"  basicUsername: alice",
					"  basicPassword: s3cret",
					"",
				].join("\n"),
			);
			await Settings.init({ agentDir });

			const captured: { headers?: Headers } = {};
			using _hook = hookFetch((_input, init) => {
				captured.headers = new Headers(init?.headers);
				return new Response(JSON.stringify({ results: [] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			});

			await searchSearXNG({ query: "settings basic auth" });

			expect(captured.headers?.get("Authorization")).toBe(
				`Basic ${Buffer.from("alice:s3cret", "utf-8").toString("base64")}`,
			);
		} finally {
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});

	it("prefers Basic auth over bearer token when both are configured", async () => {
		process.env.SEARXNG_ENDPOINT = "https://searx.example.org";
		process.env.SEARXNG_TOKEN = "bearer-token";
		process.env.SEARXNG_BASIC_USERNAME = "alice";
		process.env.SEARXNG_BASIC_PASSWORD = "s3cret";

		const captured: { headers?: Headers } = {};
		using _hook = hookFetch((_input, init) => {
			captured.headers = new Headers(init?.headers);
			return new Response(JSON.stringify({ results: [] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});

		await searchSearXNG({ query: "auth precedence" });

		expect(captured.headers?.get("Authorization")).toBe(
			`Basic ${Buffer.from("alice:s3cret", "utf-8").toString("base64")}`,
		);
	});

	it("sends Basic auth when the password is intentionally empty", async () => {
		process.env.SEARXNG_ENDPOINT = "https://searx.example.org";
		process.env.SEARXNG_BASIC_USERNAME = "alice";
		process.env.SEARXNG_BASIC_PASSWORD = "";

		const captured: { headers?: Headers } = {};
		using _hook = hookFetch((_input, init) => {
			captured.headers = new Headers(init?.headers);
			return new Response(JSON.stringify({ results: [] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});

		await searchSearXNG({ query: "empty password" });

		expect(captured.headers?.get("Authorization")).toBe(`Basic ${Buffer.from("alice:", "utf-8").toString("base64")}`);
	});

	it("sends Basic auth when the username is intentionally empty", async () => {
		process.env.SEARXNG_ENDPOINT = "https://searx.example.org";
		process.env.SEARXNG_BASIC_USERNAME = "";
		process.env.SEARXNG_BASIC_PASSWORD = "s3cret";

		const captured: { headers?: Headers } = {};
		using _hook = hookFetch((_input, init) => {
			captured.headers = new Headers(init?.headers);
			return new Response(JSON.stringify({ results: [] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});

		await searchSearXNG({ query: "empty username" });

		expect(captured.headers?.get("Authorization")).toBe(
			`Basic ${Buffer.from(":s3cret", "utf-8").toString("base64")}`,
		);
	});

	it("requires both Basic auth username and password", async () => {
		process.env.SEARXNG_ENDPOINT = "https://searx.example.org";
		process.env.SEARXNG_BASIC_USERNAME = "alice";

		await expect(searchSearXNG({ query: "missing password" })).rejects.toThrow(
			"SearXNG Basic auth requires both searxng.basicUsername and searxng.basicPassword",
		);
	});

	it("requires a Basic auth username when only password is configured", async () => {
		process.env.SEARXNG_ENDPOINT = "https://searx.example.org";
		process.env.SEARXNG_BASIC_PASSWORD = "s3cret";

		await expect(searchSearXNG({ query: "missing username" })).rejects.toThrow(
			"SearXNG Basic auth requires both searxng.basicUsername and searxng.basicPassword",
		);
	});

	it("rejects Basic auth usernames containing a colon", async () => {
		process.env.SEARXNG_ENDPOINT = "https://searx.example.org";
		process.env.SEARXNG_BASIC_USERNAME = "alice:admin";
		process.env.SEARXNG_BASIC_PASSWORD = "s3cret";

		await expect(searchSearXNG({ query: "invalid username" })).rejects.toThrow(
			"SearXNG Basic auth username cannot contain ':'",
		);
	});

	it("rejects Basic auth usernames containing control characters", async () => {
		process.env.SEARXNG_ENDPOINT = "https://searx.example.org";
		process.env.SEARXNG_BASIC_USERNAME = "alice\u0007";
		process.env.SEARXNG_BASIC_PASSWORD = "s3cret";

		await expect(searchSearXNG({ query: "invalid username control character" })).rejects.toThrow(
			"SearXNG Basic auth credentials must not contain RFC 7617 control characters",
		);
	});

	it("rejects Basic auth passwords containing control characters", async () => {
		process.env.SEARXNG_ENDPOINT = "https://searx.example.org";
		process.env.SEARXNG_BASIC_USERNAME = "alice";
		process.env.SEARXNG_BASIC_PASSWORD = "s3cret\u0001";

		await expect(searchSearXNG({ query: "invalid password control character" })).rejects.toThrow(
			"SearXNG Basic auth credentials must not contain RFC 7617 control characters",
		);
	});

	it("keeps bearer token authentication when Basic auth is not configured", async () => {
		process.env.SEARXNG_ENDPOINT = "https://searx.example.org";
		process.env.SEARXNG_TOKEN = "bearer-token";

		const captured: { headers?: Headers } = {};
		using _hook = hookFetch((_input, init) => {
			captured.headers = new Headers(init?.headers);
			return new Response(JSON.stringify({ results: [] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});

		await searchSearXNG({ query: "bearer search" });

		expect(captured.headers?.get("Authorization")).toBe("Bearer bearer-token");
	});
});

describe("SearXNG project endpoint credential boundary", () => {
	const tempDirs: string[] = [];

	afterEach(async () => {
		vi.restoreAllMocks();
		resetSettingsForTest();
		delete process.env.SEARXNG_ENDPOINT;
		delete process.env.SEARXNG_TOKEN;
		delete process.env.SEARXNG_BASIC_USERNAME;
		delete process.env.SEARXNG_BASIC_PASSWORD;
		await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
	});

	async function projectSettings(searxng: Record<string, unknown>): Promise<Settings> {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "searxng-project-endpoint-"));
		tempDirs.push(root);
		const projectDir = path.join(root, "project");
		const agentDir = path.join(root, "agent");
		await fs.mkdir(path.join(projectDir, ".gjc"), { recursive: true });
		await fs.mkdir(agentDir, { recursive: true });
		await Bun.write(path.join(projectDir, ".gjc", "settings.json"), JSON.stringify({ searxng }));
		return Settings.loadReadonly({ cwd: projectDir, agentDir });
	}

	async function captureSearch(query: string, activeSettings?: Settings) {
		const captured: { url?: URL; headers?: Headers } = {};
		using _hook = hookFetch((input, init) => {
			captured.url = new URL(input.toString());
			captured.headers = new Headers(init?.headers);
			return new Response(
				JSON.stringify({
					results: [{ title: "Result", url: "https://example.com/result", content: "snippet" }],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});
		const response = await searchSearXNG({ query, settings: activeSettings });
		return { captured, response };
	}

	async function expectProjectEndpointIgnored(searxng: Record<string, unknown>, query: string) {
		const activeSettings = await projectSettings(searxng);
		let calls = 0;
		using _hook = hookFetch(() => {
			calls += 1;
			return new Response(JSON.stringify({ results: [] }), { status: 200 });
		});
		await expect(searchSearXNG({ query, settings: activeSettings })).rejects.toThrow(
			"SearXNG endpoint not configured",
		);
		expect(calls).toBe(0);
		expect(activeSettings.get("searxng.endpoint")).toBeUndefined();
	}

	it("does not send an operator env token to a project settings endpoint", async () => {
		process.env.SEARXNG_TOKEN = "operator-token";
		process.env.SEARXNG_BASIC_USERNAME = "alice";
		process.env.SEARXNG_BASIC_PASSWORD = "s3cret";
		await expectProjectEndpointIgnored({ endpoint: "https://attacker.example" }, "project endpoint");
	});

	it("still sends an operator env token to an operator env endpoint", async () => {
		process.env.SEARXNG_ENDPOINT = "https://searx.example.org";
		process.env.SEARXNG_TOKEN = "operator-token";

		const { captured, response } = await captureSearch("operator endpoint");

		expect(captured.url?.origin).toBe("https://searx.example.org");
		expect(captured.headers?.get("Authorization")).toBe("Bearer operator-token");
		expect(response.provider).toBe("searxng");
		expect(response.sources.length).toBeGreaterThan(0);
	});

	it("still sends an operator env token to an operator settings endpoint", async () => {
		process.env.SEARXNG_TOKEN = "operator-token";
		const activeSettings = Settings.isolated({ "searxng.endpoint": "https://searx.example.org" });

		const { captured } = await captureSearch("operator settings endpoint", activeSettings);

		expect(captured.url?.origin).toBe("https://searx.example.org");
		expect(captured.headers?.get("Authorization")).toBe("Bearer operator-token");
	});

	it("does not send a project token to a project settings endpoint", async () => {
		process.env.SEARXNG_TOKEN = "operator-token";
		await expectProjectEndpointIgnored(
			{ endpoint: "https://attacker.example", token: "project-token" },
			"project credential",
		);
	});

	it("does not send project basic auth to a project settings endpoint", async () => {
		process.env.SEARXNG_TOKEN = "operator-token";
		await expectProjectEndpointIgnored(
			{ endpoint: "https://attacker.example", basicUsername: "alice", basicPassword: "project-secret" },
			"project basic",
		);
	});

	it("runs a query when no credential is configured", async () => {
		process.env.SEARXNG_ENDPOINT = "https://searx.example.org";

		const { captured, response } = await captureSearch("no credential");

		expect(captured.url?.origin).toBe("https://searx.example.org");
		expect(captured.headers?.get("Authorization")).toBeNull();
		expect(response).toMatchObject({ provider: "searxng", sources: [{ url: "https://example.com/result" }] });
	});

	it("does not send an environment password to a project endpoint that sets only a username", async () => {
		process.env.SEARXNG_BASIC_PASSWORD = "env-only-password";
		process.env.SEARXNG_BASIC_USERNAME = "env-user";
		await expectProjectEndpointIgnored(
			{ endpoint: "https://attacker.example", basicUsername: "alice" },
			"project username only",
		);
	});

	it("does not send an environment username to a project endpoint that sets only a password", async () => {
		process.env.SEARXNG_BASIC_USERNAME = "env-only-user";
		process.env.SEARXNG_BASIC_PASSWORD = "env-only-password";
		await expectProjectEndpointIgnored(
			{ endpoint: "https://attacker.example", basicPassword: "project-secret" },
			"project password only",
		);
	});

	it("does not send a project bearer token to a project endpoint when basic auth is only half set", async () => {
		process.env.SEARXNG_BASIC_PASSWORD = "env-only-password";
		process.env.SEARXNG_TOKEN = "operator-token";
		await expectProjectEndpointIgnored(
			{ endpoint: "https://attacker.example", basicUsername: "alice", token: "project-token" },
			"project token over half basic",
		);
	});

	it("does not send a session auth-broker key to a project endpoint", async () => {
		const activeSettings = await projectSettings({ endpoint: "https://attacker.example" });
		process.env.SEARXNG_TOKEN = "operator-token";
		let calls = 0;
		using _hook = hookFetch(() => {
			calls += 1;
			return new Response(JSON.stringify({ results: [] }), { status: 200 });
		});

		await expect(
			searchSearXNG({
				query: "stored key",
				settings: activeSettings,
				authStorage: {
					async getApiKey(provider: string) {
						return provider === "searxng" ? "stored-searxng-key" : undefined;
					},
				} as unknown as NonNullable<Parameters<typeof searchSearXNG>[0]["authStorage"]>,
			}),
		).rejects.toThrow("SearXNG endpoint not configured");
		expect(calls).toBe(0);
	});
});
