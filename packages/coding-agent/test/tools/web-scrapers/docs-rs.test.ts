import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { getAgentDir, setAgentDir } from "@gajae-code/utils";
import { ToolAbortError } from "../../../src/tools/tool-errors";
import { handleDocsRs } from "../../../src/web/scrapers/docs-rs";
import { MAX_BYTES } from "../../../src/web/scrapers/types";

const originalAgentDir = getAgentDir();
let agentDir: string;

function rustdocJson(crateName: string, padding = 0): string {
	return JSON.stringify({
		root: 0,
		crate_version: "1.0.0",
		index: {
			0: {
				name: crateName,
				docs: `${crateName} docs`,
				attrs: [],
				inner: { module: { items: [], is_crate: true } },
				visibility: "public",
				deprecation: null,
			},
		},
		paths: {},
		format_version: 37,
		padding: "x".repeat(padding),
	});
}

function mockGzip(body: Uint8Array): void {
	vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body, { status: 200 }));
}

beforeEach(async () => {
	agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-docs-rs-"));
	setAgentDir(agentDir);
});

afterEach(async () => {
	vi.restoreAllMocks();
	setAgentDir(originalAgentDir);
	await fs.rm(agentDir, { recursive: true, force: true });
});

describe("docs.rs rustdoc gzip bounds", () => {
	it("rejects concatenated gzip output over MAX_BYTES without caching", async () => {
		const input = Buffer.alloc(1024 * 1024);
		const member = gzipSync(input);
		expect(gunzipSync(Buffer.concat([member, member])).length).toBe(input.length * 2);
		mockGzip(Buffer.concat(Array.from({ length: MAX_BYTES / input.length + 1 }, () => member)));

		expect(await handleDocsRs("https://docs.rs/output_limit/1.0.0/output_limit/", 20)).toBeNull();
		expect(await fs.readdir(agentDir)).toEqual([]);
	});

	it("passes MAX_BYTES from the production handler without allocating it", async () => {
		const cancel = vi.fn(async () => {});
		const response = {
			ok: true,
			headers: new Headers(),
			body: { getReader: () => ({ read: async () => ({ done: false, value: { length: MAX_BYTES + 1 } }), cancel }) },
		} as unknown as Response;
		vi.spyOn(globalThis, "fetch").mockResolvedValue(response);

		expect(await handleDocsRs("https://docs.rs/production_limit/1.0.0/production_limit/", 20)).toBeNull();
		expect(cancel).toHaveBeenCalledTimes(1);
		expect(await fs.readdir(agentDir)).toEqual([]);
	});

	it("renders and caches under-budget rustdoc gzip", async () => {
		mockGzip(gzipSync(rustdocJson("bounded")));

		const result = await handleDocsRs("https://docs.rs/bounded/1.0.0/bounded/", 20);
		expect(result?.content).toContain("bounded docs");
		expect((await fs.readdir(path.join(agentDir, "webcache"))).length).toBe(1);
	});

	it("removes an oversized legacy cache entry before refetching", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response(gzipSync(rustdocJson("initial")), { status: 200 }));
		const url = "https://docs.rs/legacy_cache/1.0.0/legacy_cache/";
		const cachePath = path.join(agentDir, "webcache", "docsrs_legacy_cache_1.0.0", "rustdoc.json");

		expect((await handleDocsRs(url, 20))?.content).toContain("initial docs");
		await fs.truncate(cachePath, MAX_BYTES + 1);
		fetchSpy.mockResolvedValue(new Response(gzipSync(rustdocJson("refetched")), { status: 200 }));

		expect((await handleDocsRs(url, 20))?.content).toContain("refetched docs");
		expect(fetchSpy).toHaveBeenCalledTimes(2);
		expect((await fs.stat(cachePath)).size).toBeLessThanOrEqual(MAX_BYTES);
	});

	it("disables transport decompression and rejects encoded responses", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(gzipSync(rustdocJson("encoded")), {
				status: 200,
				headers: { "Content-Encoding": "gzip" },
			}),
		);

		expect(await handleDocsRs("https://docs.rs/encoded/1.0.0/encoded/", 20)).toBeNull();
		const request = fetchSpy.mock.calls[0]?.[1] as BunFetchRequestInit | undefined;
		expect(request?.decompress).toBe(false);
		expect(new Headers(request?.headers).get("Accept-Encoding")).toBe("identity");
		expect(await fs.readdir(agentDir)).toEqual([]);
	});

	it("preserves caller abort errors", async () => {
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new DOMException("Aborted", "AbortError"));
		const controller = new AbortController();
		controller.abort();

		await expect(
			handleDocsRs("https://docs.rs/aborted/1.0.0/aborted/", 20, controller.signal),
		).rejects.toBeInstanceOf(ToolAbortError);
	});
});
