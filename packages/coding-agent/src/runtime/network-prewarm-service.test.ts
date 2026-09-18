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
		expect(runtime.enabled).toBe(true);
		await service.dispose();
	});

	test("a throwing preconnect retires the capability instead of repeating it per host", async () => {
		const calls: string[] = [];
		const fetchWithPreconnect = Object.assign(async () => new Response("ok"), {
			preconnect: (url: string) => {
				calls.push(url);
				throw new Error("Invalid port");
			},
		}) as typeof fetch & { preconnect: (url: string) => void };
		globalThis.fetch = fetchWithPreconnect;

		const service = createNetworkPrewarmService(Settings.isolated());
		const runtime = await service.get("retire");
		expect(runtime.enabled).toBe(true);

		runtime.preconnect("https://first.test");
		runtime.preconnect("https://second.test");
		runtime.preconnect("https://third.test");

		// Only the probing call reaches the runtime; the rest short-circuit.
		expect(calls).toEqual(["https://first.test"]);
		expect(runtime.enabled).toBe(false);

		// A retired service still measures the unprewarmed first request.
		runtime.recordFirstRequestLatency(77);
		runtime.recordFirstRequestLatency(1234);
		expect(runtime.getFirstRequestLatencyDeltaMs()).toBe(77);
		await service.dispose();
	});

	test("a runtime without fetch.preconnect retires instead of silently doing nothing", async () => {
		// Deliberately a fetch without `preconnect`: the double assertion models a
		// runtime that does not expose the capability at all.
		globalThis.fetch = (async () => new Response("ok")) as unknown as typeof fetch;

		const service = createNetworkPrewarmService(Settings.isolated());
		const runtime = await service.get("absent");

		runtime.preconnect("https://example.test");

		expect(runtime.enabled).toBe(false);
		runtime.recordFirstRequestLatency(5);
		expect(runtime.getFirstRequestLatencyDeltaMs()).toBe(5);
		await service.dispose();
	});
});
