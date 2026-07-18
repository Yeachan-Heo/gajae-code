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
		expect(captured.url?.searchParams.get("pageno")).toBe("1");
		expect(captured.url?.searchParams.get("time_range")).toBeNull();
		expect(captured.headers?.get("Authorization")).toBe(
			`Basic ${Buffer.from("alice:s3cret", "utf-8").toString("base64")}`,
		);
		expect(response).toMatchObject({
			provider: "searxng",
			relatedQuestions: ["related search"],
			sources: [{ title: "SearXNG", url: "https://example.com/result", snippet: "Metasearch result" }],
		});
	});
	it.each([
		["day", "day"],
		["month", "month"],
		["year", "year"],
	] as const)("sends %s recency as SearXNG time_range %s", async (recency, expectedTimeRange) => {
		resetSettingsForTest();
		process.env.SEARXNG_ENDPOINT = "https://searx.example.org";
		try {
			const captured: { url?: URL } = {};
			using _hook = hookFetch(input => {
				captured.url = new URL(input.toString());
				return new Response(JSON.stringify({ results: [] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			});

			await searchSearXNG({ query: "recent search", recency });

			expect(captured.url?.searchParams.get("time_range")).toBe(expectedTimeRange);
		} finally {
			resetSettingsForTest();
			delete process.env.SEARXNG_ENDPOINT;
		}
	});
	it("preserves configured request parameters with a temporal filter", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "searxng-request-"));
		try {
			await Bun.write(
				path.join(agentDir, "config.yml"),
				["searxng:", "  endpoint: https://searx.example.org", "  categories: general", "  language: en", ""].join(
					"\n",
				),
			);
			await Settings.init({ agentDir });

			const captured: { url?: URL } = {};
			using _hook = hookFetch(input => {
				captured.url = new URL(input.toString());
				return new Response(JSON.stringify({ results: [] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			});

			await searchSearXNG({ query: "recent search", num_results: 1, recency: "day" });

			expect(captured.url?.searchParams.get("q")).toBe("recent search");
			expect(captured.url?.searchParams.get("format")).toBe("json");
			expect(captured.url?.searchParams.get("pageno")).toBe("1");
			expect(captured.url?.searchParams.get("time_range")).toBe("day");
			expect(captured.url?.searchParams.get("categories")).toBe("general");
			expect(captured.url?.searchParams.get("language")).toBe("en");
		} finally {
			resetSettingsForTest();
			await fs.rm(agentDir, { recursive: true, force: true });
		}
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
