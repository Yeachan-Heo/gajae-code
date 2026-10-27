import { afterEach, describe, expect, test } from "bun:test";
import { Settings } from "../config/settings";
import { createNetworkPrewarmService } from "./network-prewarm-service";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("network prewarm runtime service", () => {
	test("networkPrewarm=false skips fetch.preconnect and records the first-request delta", async () => {
		const calls: string[] = [];
		const fetchWithPreconnect = Object.assign(async () => new Response("ok"), {
			preconnect: (url: string) => {
				calls.push(url);
			},
		}) as typeof fetch & { preconnect: (url: string) => void };
		globalThis.fetch = fetchWithPreconnect;

		const service = createNetworkPrewarmService(Settings.isolated({ "startup.networkPrewarm": false }));
		const runtime = await service.get("test");
		runtime.preconnect("https://example.test");
		runtime.recordFirstRequestLatency(42);
		runtime.recordFirstRequestLatency(99);

		expect(calls).toEqual([]);
		expect(runtime.getFirstRequestLatencyDeltaMs()).toBe(42);
		await service.dispose();
	});

	test("the compatibility default preserves model-host preconnect", async () => {
		const calls: string[] = [];
		const fetchWithPreconnect = Object.assign(async () => new Response("ok"), {
			preconnect: (url: string) => {
				calls.push(url);
			},
		}) as typeof fetch & { preconnect: (url: string) => void };
		globalThis.fetch = fetchWithPreconnect;

		const service = createNetworkPrewarmService(Settings.isolated());
		const runtime = await service.get("legacy-startup");
		runtime.preconnect("https://example.test");

		expect(calls).toEqual(["https://example.test:443/"]);
		await service.dispose();
	});

	test("normalizes a portless HTTPS model host before preconnect", async () => {
		const calls: string[] = [];
		const fetchWithPreconnect = Object.assign(async () => new Response("ok"), {
			preconnect: (url: string) => {
				calls.push(url);
			},
		}) as typeof fetch & { preconnect: (url: string) => void };
		globalThis.fetch = fetchWithPreconnect;

		const service = createNetworkPrewarmService(Settings.isolated());
		const runtime = await service.get("portless-https");
		runtime.preconnect("https://api.anthropic.com/v1/messages");

		expect(calls).toEqual(["https://api.anthropic.com:443/v1/messages"]);
		await service.dispose();
	});

	test("falls back to Bun's accepted TCP form when default-port HTTPS is rejected", async () => {
		const calls: string[] = [];
		const fetchWithPreconnect = Object.assign(async () => new Response("ok"), {
			preconnect: (url: string) => {
				calls.push(url);
				if (url.startsWith("https://")) throw new TypeError("Invalid port");
			},
		}) as typeof fetch & { preconnect: (url: string) => void };
		globalThis.fetch = fetchWithPreconnect;

		const service = createNetworkPrewarmService(Settings.isolated());
		const runtime = await service.get("bun-1.4.0");
		runtime.preconnect("https://api.anthropic.com");

		expect(calls).toEqual(["https://api.anthropic.com:443/", "http://api.anthropic.com:443/"]);
		await service.dispose();
	});
});
