import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as dns from "node:dns/promises";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import * as os from "node:os";
import * as path from "node:path";
import { Readable } from "node:stream";

import {
	classifySource,
	fetchMarketplace,
	parseMarketplaceCatalog,
} from "@gajae-code/coding-agent/extensibility/plugins/marketplace";

// Fixture lives at test/marketplace/fixtures/valid-marketplace/
const FIXTURE_DIR = path.join(import.meta.dir, "fixtures", "valid-marketplace");
const MAX_CATALOG_BYTES = 2 * 1024 * 1024;
const CORE_HTTP_REQUEST = http.request;

function response(
	body: string | Uint8Array,
	options: { status?: number; headers?: http.IncomingHttpHeaders; peer?: string; rawHeaders?: string[] } = {},
) {
	const message = Readable.from([body]) as unknown as http.IncomingMessage;
	Object.defineProperties(message, {
		headers: { value: options.headers ?? {} },
		rawHeaders: { value: options.rawHeaders ?? [] },
		socket: { value: { remoteAddress: options.peer ?? "8.8.8.8" } },
		statusCode: { value: options.status ?? 200 },
		statusMessage: { value: "Test" },
	});
	return message;
}

function mockHttpRequests(nextResponse: (options: https.RequestOptions, call: number) => http.IncomingMessage) {
	const requests: https.RequestOptions[] = [];
	const request = ((options: https.RequestOptions, callback?: (message: http.IncomingMessage) => void) => {
		requests.push(options);
		const client = new EventEmitter() as EventEmitter & { destroy: () => void; end: () => void };
		client.destroy = () => {};
		client.end = () => queueMicrotask(() => callback?.(nextResponse(options, requests.length)));
		return client as unknown as http.ClientRequest;
	}) as typeof http.request;
	vi.spyOn(http, "request").mockImplementation(request);
	vi.spyOn(https, "request").mockImplementation(request as typeof https.request);
	return requests;
}

// ── classifySource ────────────────────────────────────────────────────

describe("classifySource", () => {
	// ── local ─────────────────────────────────────────────────────────

	it("classifies './' prefix as local", () => {
		expect(classifySource("./my-marketplace")).toBe("local");
	});

	it("classifies POSIX absolute path as local", () => {
		expect(classifySource("/abs/path")).toBe("local");
	});

	it("classifies '~/' prefix as local", () => {
		expect(classifySource("~/my-marketplace")).toBe("local");
	});

	it("classifies Windows absolute path as local", () => {
		// C:\Users\me\marketplace — path.isAbsolute returns false on POSIX,
		// so the WIN_ABS_RE fallback must handle this.
		expect(classifySource("C:\\Users\\me\\marketplace")).toBe("local");
	});

	// ── url ───────────────────────────────────────────────────────────

	it("classifies https .json URL as url", () => {
		expect(classifySource("https://example.com/marketplace.json")).toBe("url");
	});

	// ── git ───────────────────────────────────────────────────────────

	it("classifies https non-.json URL as git", () => {
		expect(classifySource("https://github.com/owner/repo.git")).toBe("git");
	});

	it("classifies git@ SCP-style URL as git", () => {
		expect(classifySource("git@github.com:owner/repo.git")).toBe("git");
	});

	it("classifies ssh:// URL as git", () => {
		expect(classifySource("ssh://git@github.com/owner/repo")).toBe("git");
	});

	// ── github ────────────────────────────────────────────────────────

	it("classifies owner/repo shorthand as github", () => {
		expect(classifySource("owner/repo")).toBe("github");
	});

	// ── errors ────────────────────────────────────────────────────────

	it("throws on bare name with suggestion", () => {
		expect(() => classifySource("just-a-name")).toThrow(
			"Unrecognized source format. Did you mean './just-a-name' (local) or 'owner/repo' (GitHub)?",
		);
	});
});

// ── parseMarketplaceCatalog ───────────────────────────────────────────

describe("parseMarketplaceCatalog", () => {
	const VALID = JSON.stringify({
		name: "test-marketplace",
		owner: { name: "Test Author", email: "test@example.com" },
		metadata: { description: "A test marketplace" },
		plugins: [{ name: "hello-plugin", source: "./plugins/hello-plugin", description: "Greets" }],
	});

	it("parses a valid catalog", () => {
		const catalog = parseMarketplaceCatalog(VALID, "/fake/marketplace.json");
		expect(catalog.name).toBe("test-marketplace");
		expect(catalog.owner.name).toBe("Test Author");
		expect(catalog.plugins).toHaveLength(1);
		expect(catalog.plugins[0].name).toBe("hello-plugin");
	});

	it("throws on missing name", () => {
		const bad = JSON.stringify({ owner: { name: "x" }, plugins: [] });
		expect(() => parseMarketplaceCatalog(bad, "/f.json")).toThrow(/"name"/);
	});

	it("throws when name fails isValidNameSegment", () => {
		const bad = JSON.stringify({ name: "Invalid Name", owner: { name: "x" }, plugins: [] });
		expect(() => parseMarketplaceCatalog(bad, "/f.json")).toThrow(/"name"/);
	});

	it("throws on missing plugins", () => {
		const bad = JSON.stringify({ name: "valid-name", owner: { name: "x" } });
		expect(() => parseMarketplaceCatalog(bad, "/f.json")).toThrow(/"plugins"/);
	});

	it("throws on missing owner", () => {
		const bad = JSON.stringify({ name: "valid-name", plugins: [] });
		expect(() => parseMarketplaceCatalog(bad, "/f.json")).toThrow(/"owner"/);
	});

	it("empty plugins array is valid", () => {
		const catalog = parseMarketplaceCatalog(
			JSON.stringify({ name: "valid-name", owner: { name: "x" }, plugins: [] }),
			"/f.json",
		);
		expect(catalog.plugins).toHaveLength(0);
	});

	it("preserves extra fields in output", () => {
		const extra = JSON.stringify({
			name: "my-market",
			owner: { name: "x" },
			plugins: [],
			myCustomField: "preserved",
			anotherExtra: 42,
		});
		const catalog = parseMarketplaceCatalog(extra, "/f.json") as unknown as Record<string, unknown>;
		expect(catalog.myCustomField).toBe("preserved");
		expect(catalog.anotherExtra).toBe(42);
	});

	it("accepts plugin with object source (typed source object)", () => {
		const content = JSON.stringify({
			name: "my-market",
			owner: { name: "x" },
			plugins: [{ name: "p1", source: { source: "github", repo: "owner/repo" } }],
		});
		const catalog = parseMarketplaceCatalog(content, "/f.json");
		expect(catalog.plugins[0].name).toBe("p1");
	});

	it("throws on invalid JSON", () => {
		expect(() => parseMarketplaceCatalog("{not json", "/f.json")).toThrow(
			"Failed to parse marketplace catalog at /f.json",
		);
	});
});

// ── fetchMarketplace ──────────────────────────────────────────────────

describe("fetchMarketplace", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-fetcher-test-"));
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ordinary fetch must not run"));
	});

	afterEach(() => {
		vi.restoreAllMocks();
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("resolves catalog from fixture directory", async () => {
		const result = await fetchMarketplace(FIXTURE_DIR, tmpDir);
		expect(result.catalog.name).toBe("test-marketplace");
		expect(result.catalog.owner.name).toBe("Test Author");
		expect(result.catalog.plugins).toHaveLength(1);
		expect(result.catalog.plugins[0].name).toBe("hello-plugin");
		// local fetch never returns a clonePath
		expect(result.clonePath).toBeUndefined();
	});

	it("throws a clear error for nonexistent local directory", async () => {
		const missing = path.join(tmpDir, "nonexistent");
		await expect(fetchMarketplace(missing, tmpDir)).rejects.toThrow(/Marketplace catalog not found/);
	});

	it("throws a clear error for relative nonexistent path", async () => {
		// Use a path that resolves within tmpDir but doesn't exist
		const fakeSrc = path.join(tmpDir, "ghost-marketplace");
		await expect(fetchMarketplace(fakeSrc, tmpDir)).rejects.toThrow(/Marketplace catalog not found/);
	});

	it("binds a hostname request to the single approved DNS answer", async () => {
		let resolution = 0;
		const dnsLookup = vi
			.spyOn(dns, "lookup")
			.mockImplementation((async () => [
				{ address: resolution++ === 0 ? "8.8.8.8" : "127.0.0.1", family: 4 },
			]) as unknown as typeof dns.lookup);
		const requests = mockHttpRequests(() =>
			response(JSON.stringify({ name: "remote-market", owner: { name: "x" }, plugins: [] }), {
				peer: "::ffff:8.8.8.8",
			}),
		);

		await fetchMarketplace("https://rebind.example/marketplace.json", tmpDir);

		expect(dnsLookup).toHaveBeenCalledTimes(1);
		expect(globalThis.fetch).not.toHaveBeenCalled();
		expect(requests[0]?.agent).toBe(false);
		expect(requests[0]?.headers).toMatchObject({ Connection: "close", Host: "rebind.example" });
		expect(requests[0]).toMatchObject({
			insecureHTTPParser: false,
			maxHeaderSize: 16 * 1024,
			rejectUnauthorized: true,
			servername: "rebind.example",
		});
		expect(requests[0]?.lookup).toBeFunction();
		const allCallback = vi.fn();
		requests[0]?.lookup?.("rebind.example", { all: true }, allCallback);
		expect(allCallback).toHaveBeenCalledWith(null, [{ address: "8.8.8.8", family: 4 }]);
		for (const [hostname, family] of [
			["other.example", 4],
			["rebind.example", 6],
		] as const) {
			const rejectedCallback = vi.fn();
			requests[0]?.lookup?.(hostname, { family }, rejectedCallback);
			expect(rejectedCallback.mock.calls[0]?.[0]).toMatchObject({ code: "ENOTFOUND" });
		}
	});

	it("passes the pinned lookup and original Host through core http.request", async () => {
		vi.spyOn(dns, "lookup").mockImplementation((async () => [
			{ address: "8.8.8.8", family: 4 },
		]) as unknown as typeof dns.lookup);
		const requests = mockHttpRequests(() =>
			response(JSON.stringify({ name: "core-proof", owner: { name: "x" }, plugins: [] })),
		);
		await fetchMarketplace("http://pinned.example/marketplace.json", tmpDir);

		const hostSeen = Promise.withResolvers<string>();
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				hostSeen.resolve(request.headers.get("host") ?? "");
				return new Response();
			},
		});
		const finished = Promise.withResolvers<void>();
		const coreRequest = CORE_HTTP_REQUEST(
			{
				...requests[0],
				port: server.port,
				lookup: (hostname, options, callback) =>
					requests[0]?.lookup?.(hostname, options, (error, approved, family) => {
						const selected = typeof approved === "string" ? approved : approved[0]?.address;
						expect(selected).toBe("8.8.8.8");
						const local = typeof approved === "string" ? "127.0.0.1" : [{ address: "127.0.0.1", family: 4 }];
						callback(error, local, family);
					}),
			},
			response => {
				response.resume();
				response.once("end", finished.resolve);
			},
		);
		try {
			coreRequest.once("error", finished.reject);
			coreRequest.end();
			await finished.promise;
			expect(await hostSeen.promise).toBe("pinned.example");
		} finally {
			await server.stop(true);
		}
	});

	it("preserves public IP literals and omits SNI for HTTPS literals", async () => {
		const requests = mockHttpRequests((_options, call) =>
			response(JSON.stringify({ name: `literal-${call}`, owner: { name: "x" }, plugins: [] }), {
				peer: call === 1 ? "8.8.8.8" : "2606:4700:4700::1111",
			}),
		);
		await fetchMarketplace("https://8.8.8.8/marketplace.json", tmpDir);
		await fetchMarketplace("http://[2606:4700:4700::1111]/marketplace.json", tmpDir);
		expect(requests[0]).toMatchObject({ hostname: "8.8.8.8", servername: undefined });
		expect(requests[1]).toMatchObject({ hostname: "2606:4700:4700::1111" });
		expect(requests[1]?.headers).toMatchObject({ Host: "[2606:4700:4700::1111]" });
	});

	it("rejects a connected peer outside the approved DNS answers before caching", async () => {
		vi.spyOn(dns, "lookup").mockImplementation((async () => [
			{ address: "8.8.8.8", family: 4 },
		]) as unknown as typeof dns.lookup);
		const message = response(JSON.stringify({ name: "peer-mismatch", owner: { name: "x" }, plugins: [] }), {
			peer: "127.0.0.1",
		});
		const destroy = vi.spyOn(message, "destroy");
		mockHttpRequests(() => message);

		await expect(fetchMarketplace("http://rebind.example/marketplace.json", tmpDir)).rejects.toThrow(
			/connected peer/,
		);

		expect(destroy).toHaveBeenCalled();
		expect(fs.readdirSync(tmpDir)).toEqual([]);
	});

	it("rejects credentialed and private targets before opening a request", async () => {
		const requests = mockHttpRequests(() => response(""));

		for (const source of ["http://user@8.8.8.8/marketplace.json", "http://127.0.0.1/marketplace.json"]) {
			await expect(fetchMarketplace(source, tmpDir)).rejects.toThrow(/not public HTTP\(S\)/);
		}
		expect(requests).toHaveLength(0);
	});

	it("revalidates redirects before opening the next request", async () => {
		const requests = mockHttpRequests(() =>
			response("", { status: 302, headers: { location: "http://127.0.0.1/marketplace.json" } }),
		);

		await expect(fetchMarketplace("http://8.8.8.8/marketplace.json", tmpDir)).rejects.toThrow(/not public HTTP\(S\)/);
		expect(requests).toHaveLength(1);
	});

	it("rejects missing redirect locations and excessive redirect chains", async () => {
		let requests = mockHttpRequests(() => response("", { status: 302 }));
		await expect(fetchMarketplace("http://8.8.8.8/marketplace.json", tmpDir)).rejects.toThrow(/Location/);
		expect(requests).toHaveLength(1);

		vi.restoreAllMocks();
		requests = mockHttpRequests(() => response("", { status: 302, headers: { location: "/marketplace.json" } }));
		await expect(fetchMarketplace("http://8.8.8.8/marketplace.json", tmpDir)).rejects.toThrow(/redirects/);
		expect(requests).toHaveLength(6);
	});

	it("rejects declared and chunked bodies above two MiB", async () => {
		let message = response("", { headers: { "content-length": String(MAX_CATALOG_BYTES + 1) } });
		let destroy = vi.spyOn(message, "destroy");
		mockHttpRequests(() => message);
		await expect(fetchMarketplace("http://8.8.8.8/marketplace.json", tmpDir)).rejects.toThrow(/2 MiB/);
		expect(destroy).toHaveBeenCalled();

		vi.restoreAllMocks();
		message = response(new Uint8Array(MAX_CATALOG_BYTES + 1));
		destroy = vi.spyOn(message, "destroy");
		mockHttpRequests(() => message);
		await expect(fetchMarketplace("http://8.8.8.8/marketplace.json", tmpDir)).rejects.toThrow(/2 MiB/);
		expect(destroy).toHaveBeenCalled();
	});

	it("rejects duplicate Content-Length and Content-Length plus Transfer-Encoding", async () => {
		const framingCases: Array<[string[], string, RegExp]> = [
			[["Content-Length", "1", "Content-Length", "1"], "1", /framing/],
			[["Content-Length", "1", "Transfer-Encoding", "chunked"], "1", /framing/],
			[["Content-Length", "invalid"], "invalid", /Content-Length/],
		];
		for (const [rawHeaders, contentLength, expected] of framingCases) {
			const message = response("x", { headers: { "content-length": contentLength }, rawHeaders });
			mockHttpRequests(() => message);
			await expect(fetchMarketplace("http://8.8.8.8/marketplace.json", tmpDir)).rejects.toThrow(expected);
			vi.restoreAllMocks();
		}
	});

	it("destroys an in-flight request when the single deadline aborts", async () => {
		const controller = new AbortController();
		vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
		const opened = Promise.withResolvers<void>();
		const client = new EventEmitter() as EventEmitter & { destroy: () => void; end: () => void };
		client.destroy = vi.fn();
		client.end = opened.resolve;
		vi.spyOn(http, "request").mockReturnValue(client as unknown as http.ClientRequest);
		const operation = fetchMarketplace("http://8.8.8.8/marketplace.json", tmpDir);
		await opened.promise;
		controller.abort(new DOMException("deadline", "TimeoutError"));
		await expect(operation).rejects.toThrow(/Timed out/);
		expect(client.destroy).toHaveBeenCalled();
		expect(fs.readdirSync(tmpDir)).toEqual([]);
	});

	it("follows a bounded public redirect and caches a valid catalog", async () => {
		const catalog = JSON.stringify({ name: "redirect-market", owner: { name: "x" }, plugins: [] });
		const requests = mockHttpRequests((_options, call) =>
			call === 1
				? response("", { status: 302, headers: { location: "http://1.1.1.1/catalog.json" } })
				: response(catalog, { peer: "1.1.1.1" }),
		);

		const result = await fetchMarketplace("http://8.8.8.8/marketplace.json", tmpDir);

		expect(result.catalog.name).toBe("redirect-market");
		expect(requests).toHaveLength(2);
		expect(requests[1]?.signal).toBe(requests[0]?.signal);
		expect(fs.readFileSync(path.join(tmpDir, "redirect-market", "marketplace.json"), "utf8")).toBe(catalog);
	});

	// Network-dependent tests — skip in CI / offline environments.
	// These verify real git clone and HTTP fetch error handling.
	it.skip("github source throws on nonexistent repo", async () => {
		await expect(fetchMarketplace("nonexistent-owner-xyz/nonexistent-repo-xyz", tmpDir)).rejects.toThrow(
			/git clone failed/,
		);
	});

	it.skip("git source throws on nonexistent repo", async () => {
		await expect(
			fetchMarketplace("git@github.com:nonexistent-owner-xyz/nonexistent-repo-xyz.git", tmpDir),
		).rejects.toThrow(/git clone failed/);
	});

	it.skip("url source throws on non-2xx response", async () => {
		await expect(fetchMarketplace("https://example.com/nonexistent-catalog-xyz.json", tmpDir)).rejects.toThrow(
			/HTTP [45]\d\d/,
		);
	});
});
