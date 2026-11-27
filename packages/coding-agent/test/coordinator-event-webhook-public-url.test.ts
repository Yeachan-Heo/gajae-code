import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import fc from "fast-check";
import {
	createDefaultEventWebhookDelivery,
	deliverEventWebhook,
	parseEventWebhookConfig,
} from "../src/coordinator-mcp/event-webhook";
import { type AddressResolver, isPrivateOrSpecialAddress } from "../src/web/insane/url-guard";

const tempDirs: string[] = [];
const proxyKeys = ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"] as const;

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-event-webhook-public-"));
	tempDirs.push(dir);
	return dir;
}

function outbox(dir: string, eventId: string): string {
	return path.join(dir, "webhook-outbox", `${createHash("sha256").update(eventId).digest("hex")}.json`);
}

function expectedLoopbackHttpWebhook(rawUrl: string): boolean {
	let parsed: URL;
	try {
		parsed = new URL(rawUrl);
	} catch {
		return false;
	}
	const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
	return parsed.protocol === "http:" && (hostname === "127.0.0.1" || hostname === "::1" || hostname === "localhost");
}

function mockFetchOk() {
	return spyOn(globalThis, "fetch").mockImplementation(
		(async () => new Response("ok", { status: 200 })) as unknown as typeof fetch,
	);
}

async function withoutProxy<T>(run: () => Promise<T>): Promise<T> {
	const saved = proxyKeys.map(key => [key, process.env[key]] as const);
	for (const key of proxyKeys) delete process.env[key];
	try {
		return await run();
	} finally {
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

function post(url: string, hooks?: { resolver?: AddressResolver }, token: string | null = null) {
	return createDefaultEventWebhookDelivery(hooks).post('{"event":"demo"}', {
		url,
		token,
		timeoutMs: 1_000,
		signal: new AbortController().signal,
	});
}

describe("event webhook public destinations", () => {
	it("refuses an https metadata address before posting the journal row", async () => {
		const fetchSpy = mockFetchOk();
		const dir = await tempRoot();
		try {
			await deliverEventWebhook(
				dir,
				{
					url: "https://169.254.169.254/latest/meta-data/",
					tokenFile: null,
					sessionIds: null,
					timeoutMs: 1_000,
					maxAttempts: 1,
				},
				{ id: "event-metadata" },
				() => '{"id":"event-metadata"}',
				createDefaultEventWebhookDelivery(),
			);
			const record = JSON.parse(await fs.readFile(outbox(dir, "event-metadata"), "utf8")) as { status: string };
			expect(record.status).toBe("failed");
			expect(fetchSpy).not.toHaveBeenCalled();
		} finally {
			fetchSpy.mockRestore();
		}
	});

	it("refuses an https hostname that resolves to a private address", async () => {
		const fetchSpy = mockFetchOk();
		try {
			const outcome = await post("https://sink.example.test/hook", { resolver: async () => ["10.1.2.3"] });
			expect(outcome).toEqual({ ok: false, status: null, error: "host resolves to a private or reserved address" });
			expect(fetchSpy).not.toHaveBeenCalled();
		} finally {
			fetchSpy.mockRestore();
		}
	});

	it("refuses an https hostname that does not resolve", async () => {
		const fetchSpy = mockFetchOk();
		try {
			const outcome = await post("https://sink.example.test/hook", {
				resolver: async () => {
					throw new Error("dns");
				},
			});
			expect(outcome.ok).toBe(false);
			expect(fetchSpy).not.toHaveBeenCalled();
		} finally {
			fetchSpy.mockRestore();
		}
	});

	it("refuses an https loopback address literal", async () => {
		const fetchSpy = mockFetchOk();
		try {
			const outcome = await post("https://127.0.0.1/hook");
			expect(outcome.ok).toBe(false);
			expect(fetchSpy).not.toHaveBeenCalled();
		} finally {
			fetchSpy.mockRestore();
		}
	});

	it("refuses an https ipv6 loopback literal", async () => {
		const fetchSpy = mockFetchOk();
		try {
			const outcome = await post("https://[::1]/hook");
			expect(outcome.ok).toBe(false);
			expect(fetchSpy).not.toHaveBeenCalled();
		} finally {
			fetchSpy.mockRestore();
		}
	});

	it("refuses an https ipv4-mapped private literal", async () => {
		const fetchSpy = mockFetchOk();
		try {
			const outcome = await post("https://[::ffff:10.0.0.1]/hook");
			expect(outcome.ok).toBe(false);
			expect(fetchSpy).not.toHaveBeenCalled();
		} finally {
			fetchSpy.mockRestore();
		}
	});

	it("refuses an https public address with embedded userinfo", async () => {
		const fetchSpy = mockFetchOk();
		try {
			const outcome = await post("https://user:secret@1.1.1.1/hook");
			expect(outcome.ok).toBe(false);
			expect(fetchSpy).not.toHaveBeenCalled();
		} finally {
			fetchSpy.mockRestore();
		}
	});

	it("refuses a public https webhook when a proxy is configured", async () => {
		const previous = process.env.HTTP_PROXY;
		process.env.HTTP_PROXY = "http://127.0.0.1:9";
		const fetchSpy = mockFetchOk();
		try {
			const outcome = await post("https://1.1.1.1/hook");
			expect(outcome.ok).toBe(false);
			expect(outcome.error).toContain("proxy");
			expect(fetchSpy).not.toHaveBeenCalled();
		} finally {
			fetchSpy.mockRestore();
			if (previous === undefined) delete process.env.HTTP_PROXY;
			else process.env.HTTP_PROXY = previous;
		}
	});

	it("observes an aborted signal before posting", async () => {
		const controller = new AbortController();
		controller.abort();
		const fetchSpy = mockFetchOk();
		try {
			await expect(
				createDefaultEventWebhookDelivery({ resolver: async () => ["1.1.1.1"] }).post('{"event":"demo"}', {
					url: "https://sink.example.test/hook",
					token: null,
					timeoutMs: 1_000,
					signal: controller.signal,
				}),
			).rejects.toBeDefined();
			expect(fetchSpy).not.toHaveBeenCalled();
		} finally {
			fetchSpy.mockRestore();
		}
	});

	it("still allows an http loopback webhook", async () => {
		const seen: Array<{ body: string; authorization: string | null }> = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(req) {
				seen.push({ body: await req.text(), authorization: req.headers.get("authorization") });
				return new Response("ok", { status: 200 });
			},
		});
		const dir = await tempRoot();
		const tokenFile = path.join(dir, "token");
		await fs.writeFile(tokenFile, "secret-token\n");
		// An earlier case sets HTTP_PROXY. Bun 1.4.0 keeps that proxy after the
		// variable is removed, so this loopback connect has to opt out explicitly.
		const previousNoProxy = process.env.NO_PROXY;
		process.env.NO_PROXY = "127.0.0.1,localhost";
		try {
			await deliverEventWebhook(
				dir,
				{
					url: `http://127.0.0.1:${server.port}/hook`,
					tokenFile,
					sessionIds: null,
					timeoutMs: 5_000,
					maxAttempts: 1,
				},
				{ id: "event-loopback" },
				() => '{"id":"event-loopback"}',
				createDefaultEventWebhookDelivery(),
			);
			expect(seen).toEqual([{ body: '{"id":"event-loopback"}', authorization: "Bearer secret-token" }]);
		} finally {
			if (previousNoProxy === undefined) delete process.env.NO_PROXY;
			else process.env.NO_PROXY = previousNoProxy;
			server.stop(true);
		}
	});

	it("still allows http loopback on port 80", async () => {
		const fetchSpy = mockFetchOk();
		try {
			const outcome = await post("http://127.0.0.1:80/hook", undefined, "tok");
			expect(outcome.ok).toBe(true);
			expect(String(fetchSpy.mock.calls[0]?.[0])).toContain("http://127.0.0.1:80/hook");
		} finally {
			fetchSpy.mockRestore();
		}
	});

	it("still allows uppercase localhost for http", async () => {
		const fetchSpy = mockFetchOk();
		try {
			const outcome = await post("http://LOCALHOST:9/hook");
			expect(outcome.ok).toBe(true);
			expect(String(fetchSpy.mock.calls[0]?.[0]).toLowerCase()).toContain("localhost");
		} finally {
			fetchSpy.mockRestore();
		}
	});

	it("still allows http ipv6 loopback", async () => {
		const fetchSpy = mockFetchOk();
		try {
			const outcome = await post("http://[::1]:9/hook");
			expect(outcome.ok).toBe(true);
			expect(fetchSpy).toHaveBeenCalled();
		} finally {
			fetchSpy.mockRestore();
		}
	});

	it("still allows an https public address on port 80 and the default port", async () => {
		await withoutProxy(async () => {
			const fetchSpy = mockFetchOk();
			try {
				for (const url of [
					"https://1.1.1.1/hook",
					"https://1.1.1.1:443/hook",
					"https://1.1.1.1:80/hook",
					"https://8.8.8.8/",
				]) {
					const outcome = await post(url);
					expect({ url, ok: outcome.ok }).toEqual({ url, ok: true });
				}
			} finally {
				fetchSpy.mockRestore();
			}
		});
	});

	it("still allows a padded https public url", () => {
		expect(parseEventWebhookConfig({ GJC_COORDINATOR_MCP_EVENT_WEBHOOK_URL: "  https://1.1.1.1/hook  " })?.url).toBe(
			"https://1.1.1.1/hook",
		);
	});

	it("still allows an https hostname that resolves to a public address", async () => {
		await withoutProxy(async () => {
			const fetchSpy = mockFetchOk();
			try {
				const outcome = await post("https://SINK.example.test/hook", { resolver: async () => ["1.1.1.1"] });
				expect(outcome.ok).toBe(true);
			} finally {
				fetchSpy.mockRestore();
			}
		});
	});

	it("posts a resolved public address instead of the original hostname", async () => {
		await withoutProxy(async () => {
			const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
				input: Parameters<typeof fetch>[0],
				init?: Parameters<typeof fetch>[1],
			) => {
				const href = input instanceof URL ? input.href : String(input);
				expect(new URL(href).hostname).toBe("1.1.1.1");
				expect(new Headers(init?.headers).get("host")).toBe("sink.example.test");
				return new Response("ok", { status: 200 });
			}) as unknown as typeof fetch);
			try {
				const outcome = await post("https://sink.example.test/hook", { resolver: async () => ["1.1.1.1"] });
				expect(outcome.ok).toBe(true);
			} finally {
				fetchSpy.mockRestore();
			}
		});
	});

	it("classifies http loopback separately from other webhook urls", async () => {
		const mod = await import("../src/coordinator-mcp/event-webhook");
		const classify = mod.isLoopbackHttpWebhook;
		expect(typeof classify).toBe("function");
		fc.assert(
			fc.property(
				fc.constantFrom("http", "https", "HTTP", "ftp"),
				fc.constantFrom(
					"127.0.0.1",
					"LOCALHOST",
					"localhost",
					"[::1]",
					"[0:0:0:0:0:0:0:1]",
					"1.1.1.1",
					"10.0.0.1",
					"example.test",
				),
				fc.constantFrom("", ":80", ":443", ":9"),
				fc.constantFrom("/", "/hook"),
				fc.constantFrom("plain", "spaced"),
				(scheme, host, port, path, shape) => {
					const raw =
						shape === "spaced" ? ` ${scheme}://${host}${port}${path}` : `${scheme}://${host}${port}${path}`;
					expect(classify("http://127.0.0.1/hook")).toBe(true);
					expect(classify("HTTP://LOCALHOST:80/hook")).toBe(true);
					expect(classify("http://[::1]:9/")).toBe(true);
					expect(classify("https://127.0.0.1/hook")).toBe(false);
					expect(classify("https://[::1]/")).toBe(false);
					expect(classify(raw)).toBe(expectedLoopbackHttpWebhook(raw));
				},
			),
			{ seed: 4352027, numRuns: 64 },
		);
	});

	it("matches the public address check for https literals", async () => {
		await withoutProxy(async () => {
			await fc.assert(
				fc.asyncProperty(
					fc.integer({ min: 0, max: 255 }),
					fc.integer({ min: 0, max: 255 }),
					fc.integer({ min: 0, max: 255 }),
					fc.integer({ min: 0, max: 255 }),
					async (a, b, c, d) => {
						const ip = `${a}.${b}.${c}.${d}`;
						const fetchSpy = mockFetchOk();
						try {
							const outcome = await post(`https://${ip}/hook`);
							if (isPrivateOrSpecialAddress(ip)) {
								expect(outcome.ok).toBe(false);
								expect(fetchSpy).not.toHaveBeenCalled();
							} else {
								expect(outcome.ok).toBe(true);
								expect(fetchSpy).toHaveBeenCalled();
							}
						} finally {
							fetchSpy.mockRestore();
						}
					},
				),
				{ seed: 4352026, numRuns: 64 },
			);
		});
	});
});
