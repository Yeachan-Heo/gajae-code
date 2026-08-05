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

		expect(calls).toEqual(["https://example.test"]);
		await service.dispose();
	});
});
