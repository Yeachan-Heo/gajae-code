import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { sync as clientSync } from "../src/client/api";
import { startServer } from "../src/server";
import type { DashboardStats } from "../src/types";

const EMPTY_DASHBOARD: DashboardStats = {
	overall: {
		totalRequests: 0,
		successfulRequests: 0,
		failedRequests: 0,
		errorRate: 0,
		totalInputTokens: 0,
		totalOutputTokens: 0,
		totalCacheReadTokens: 0,
		totalCacheWriteTokens: 0,
		cacheRate: 0,
		totalCost: 0,
		totalPremiumRequests: 0,
		avgDuration: null,
		avgTtft: null,
		avgTokensPerSecond: null,
		firstTimestamp: 0,
		lastTimestamp: 0,
	},
	byModel: [],
	byFolder: [],
	timeSeries: [],
	modelSeries: [],
	modelPerformanceSeries: [],
	costSeries: [],
};

describe("stats server request policy", () => {
	let server: { port: number; stop(): void };
	let syncCalls = 0;
	let countCalls = 0;
	let runSync: () => Promise<{ processed: number; files: number }>;

	function request(host: string, path: string, init: RequestInit = {}): Promise<Response> {
		const headers = new Headers(init.headers);
		headers.set("Host", host);
		return fetch(`http://127.0.0.1:${server.port}${path}`, { ...init, headers });
	}

	function origin(hostname = "localhost"): string {
		return `http://${hostname}:${server.port}`;
	}

	beforeAll(async () => {
		runSync = async () => ({ processed: 1, files: 1 });
		server = await startServer(0, {
			getDashboardStats: async () => EMPTY_DASHBOARD,
			syncAllSessions: async () => {
				syncCalls += 1;
				return await runSync();
			},
			getTotalMessageCount: async () => {
				countCalls += 1;
				return 7;
			},
		});
	});

	afterAll(() => server.stop());

	beforeEach(() => {
		syncCalls = 0;
		countCalls = 0;
		runSync = async () => ({ processed: 1, files: 1 });
	});

	it("accepts only the exact loopback authority and actual port", async () => {
		for (const hostname of ["localhost", "127.0.0.1"]) {
			const response = await request(`${hostname}:${server.port}`, "/api/stats");
			expect(response.status).toBe(200);
			expect(response.headers.has("Access-Control-Allow-Origin")).toBe(false);
		}

		for (const authority of [
			`evil.test:${server.port}`,
			`127.0.0.2:${server.port}`,
			`127.1:${server.port}`,
			`LOCALHOST:${server.port}`,
			`%6cocalhost:${server.port}`,
			`localhost:${server.port + 1}`,
			"localhost:bad",
		]) {
			expect((await request(authority, "/api/stats")).status).toBe(403);
		}

		const forwarded = await request(`evil.test:${server.port}`, "/api/stats", {
			headers: { "X-Forwarded-Host": `localhost:${server.port}` },
		});
		expect(forwarded.status).toBe(403);
	});

	it("allows absent-Origin reads but rejects non-exact browser origins", async () => {
		expect((await request(`localhost:${server.port}`, "/api/stats")).status).toBe(200);
		for (const hostname of ["localhost", "127.0.0.1"]) {
			const response = await request(`${hostname}:${server.port}`, "/api/stats", {
				headers: { Origin: origin(hostname) },
			});
			expect(response.status).toBe(200);
		}

		for (const browserOrigin of ["null", `http://evil.test:${server.port}`, "not an origin"]) {
			const response = await request(`localhost:${server.port}`, "/api/stats", {
				headers: { Origin: browserOrigin },
			});
			expect(response.status).toBe(403);
			expect(response.headers.has("Access-Control-Allow-Origin")).toBe(false);
		}
	});

	it("enforces the API method and sync-origin matrix before side effects", async () => {
		const host = `localhost:${server.port}`;
		const wrongMethod = await request(host, "/api/sync");
		expect(wrongMethod.status).toBe(405);
		expect(wrongMethod.headers.get("Allow")).toBe("POST");
		const readWrite = await request(host, "/api/stats", { method: "POST", headers: { Origin: origin() } });
		expect(readWrite.status).toBe(405);
		expect(readWrite.headers.get("Allow")).toBe("GET");
		expect((await request(host, "/api/sync", { method: "POST" })).status).toBe(403);

		for (const browserOrigin of ["null", `http://evil.test:${server.port}`]) {
			expect(
				(
					await request(host, "/api/sync", {
						method: "POST",
						headers: { Origin: browserOrigin },
					})
				).status,
			).toBe(403);
		}

		const foreignPreflight = await request(host, "/api/sync", {
			method: "OPTIONS",
			headers: { Origin: `http://evil.test:${server.port}` },
		});
		expect(foreignPreflight.status).toBe(403);
		const sameOriginPreflight = await request(host, "/api/sync", {
			method: "OPTIONS",
			headers: { Origin: origin() },
		});
		expect(sameOriginPreflight.status).toBe(405);
		expect(sameOriginPreflight.headers.get("Allow")).toBe("POST");
		expect(syncCalls).toBe(0);
		expect(countCalls).toBe(0);
	});

	it("runs at most one sync and releases the guard afterward", async () => {
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		runSync = async () => {
			started.resolve();
			await release.promise;
			return { processed: 2, files: 1 };
		};
		const init = { method: "POST", headers: { Origin: origin() } };
		const first = request(`localhost:${server.port}`, "/api/sync", init);
		await started.promise;
		const concurrent = await request(`localhost:${server.port}`, "/api/sync", init);
		expect(concurrent.status).toBe(409);
		expect(syncCalls).toBe(1);
		expect(countCalls).toBe(0);
		release.resolve();
		expect((await first).status).toBe(200);

		runSync = async () => ({ processed: 3, files: 1 });
		expect((await request(`localhost:${server.port}`, "/api/sync", init)).status).toBe(200);
		expect(syncCalls).toBe(2);
		expect(countCalls).toBe(2);

		runSync = async () => {
			throw new Error("expected sync failure");
		};
		const errorSpy = spyOn(console, "error").mockImplementation(() => {});
		try {
			expect((await request(`localhost:${server.port}`, "/api/sync", init)).status).toBe(500);
		} finally {
			errorSpy.mockRestore();
		}
		runSync = async () => ({ processed: 4, files: 1 });
		expect((await request(`localhost:${server.port}`, "/api/sync", init)).status).toBe(200);
		expect(syncCalls).toBe(4);
		expect(countCalls).toBe(3);
	});

	it("keeps static SPA fallback outside API policy and sends client sync as POST", async () => {
		const staticResponse = await request(`localhost:${server.port}`, "/dashboard/route");
		expect(staticResponse.status).toBe(200);
		expect(staticResponse.headers.has("Access-Control-Allow-Origin")).toBe(false);

		const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
		try {
			await clientSync();
			expect(fetchSpy).toHaveBeenCalledWith("/api/sync", { method: "POST" });
		} finally {
			fetchSpy.mockRestore();
		}
	});
});
