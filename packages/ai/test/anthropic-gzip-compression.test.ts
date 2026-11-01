import { describe, expect, it } from "bun:test";
import { gunzipSync } from "node:zlib";
import { wrapAnthropicFetchForGzip } from "../src/providers/anthropic";

interface Captured {
	input: string | URL | Request;
	init: RequestInit | undefined;
}

function captureFetch(): { fetch: typeof globalThis.fetch; calls: Captured[] } {
	const calls: Captured[] = [];
	const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		calls.push({ input, init });
		return new Response("{}", { status: 200 });
	}) as unknown as typeof globalThis.fetch;
	return { fetch, calls };
}

function bodyText(body: RequestInit["body"]): string {
	if (typeof body === "string") return body;
	if (body instanceof ArrayBuffer) return Buffer.from(body).toString("utf-8");
	if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString("utf-8");
	throw new Error("uninspectable body");
}

describe("Anthropic gzip request compression", () => {
	it("compresses first-party request bodies and marks them as gzip", async () => {
		const { fetch, calls } = captureFetch();
		const payload = JSON.stringify({
			model: "claude-sonnet-4-5",
			messages: [{ role: "user", content: "Explain the patch in detail. ".repeat(64) }],
		});
		await wrapAnthropicFetchForGzip(fetch)("https://api.anthropic.com/v1/messages", {
			method: "POST",
			body: payload,
			headers: { "Content-Type": "application/json", "Content-Length": String(payload.length) },
		});

		expect(calls).toHaveLength(1);
		const init = calls[0]?.init;
		expect(init?.method).toBe("POST");
		const headers = new Headers(init?.headers);
		expect(headers.get("Content-Encoding")).toBe("gzip");
		expect(headers.get("Content-Type")).toBe("application/json");
		// A stale uncompressed length would make the request invalid.
		expect(headers.get("Content-Length")).toBeNull();
		const compressed = init?.body as Uint8Array;
		expect(compressed.byteLength).toBeLessThan(Buffer.byteLength(payload));
		expect(gunzipSync(compressed).toString("utf-8")).toBe(payload);
	});

	it("leaves third-party and non-HTTPS endpoints uncompressed", async () => {
		const { fetch, calls } = captureFetch();
		const wrapped = wrapAnthropicFetchForGzip(fetch);
		const payload = JSON.stringify({ model: "x" });
		for (const url of [
			"https://api.example.com/v1/messages",
			"http://api.anthropic.com/v1/messages",
			"https://api.anthropic.com:8443/v1/messages",
		]) {
			await wrapped(url, { method: "POST", body: payload });
		}
		expect(calls).toHaveLength(3);
		for (const call of calls) {
			expect(new Headers(call.init?.headers).get("Content-Encoding")).toBeNull();
			expect(bodyText(call.init?.body)).toBe(payload);
		}
	});

	it("passes uninspectable stream bodies through untouched", async () => {
		const { fetch, calls } = captureFetch();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode("{}"));
				controller.close();
			},
		});
		await wrapAnthropicFetchForGzip(fetch)("https://api.anthropic.com/v1/messages", {
			method: "POST",
			body: stream,
		});
		expect(calls[0]?.init?.body).toBe(stream);
		expect(new Headers(calls[0]?.init?.headers).get("Content-Encoding")).toBeNull();
	});

	it("compresses byte-array bodies without corrupting them", async () => {
		const { fetch, calls } = captureFetch();
		const payload = new TextEncoder().encode(JSON.stringify({ model: "x", padding: "y".repeat(2048) }));
		await wrapAnthropicFetchForGzip(fetch)("https://api.anthropic.com/v1/messages", {
			method: "POST",
			body: payload,
		});
		const compressed = calls[0]?.init?.body as Uint8Array;
		expect(gunzipSync(compressed).toString("utf-8")).toBe(new TextDecoder().decode(payload));
	});

	it("preserves the base fetch preconnect hook", () => {
		const base = Object.assign(
			(async () => new Response("{}", { status: 200 })) as unknown as typeof globalThis.fetch,
			{ preconnect: () => undefined },
		);
		const wrapped = wrapAnthropicFetchForGzip(base) as typeof globalThis.fetch & { preconnect?: () => void };
		expect(wrapped.preconnect).toBe(base.preconnect);
	});
});
