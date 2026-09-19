import { afterEach, describe, expect, test, vi } from "bun:test";
import {
	disposeAllResourceOwners,
	isResourceOwnerDisposalActive,
	registerResourceOwner,
} from "../src/runtime/process-lifecycle";
import { HttpTransport, liveHttpTransportCount } from "../src/runtime-mcp/transports/http";

const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(async () => {
	await disposeAllResourceOwners().catch(() => undefined);
	for (const server of servers.splice(0)) server.stop(true);
	vi.restoreAllMocks();
});

describe("MCP HTTP postmortem release", () => {
	test("terminates a live legacy server session during resource-owner disposal", async () => {
		const methods: string[] = [];
		const sessionIds: Array<string | null> = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				methods.push(request.method);
				sessionIds.push(request.headers.get("Mcp-Session-Id"));
				if (request.method === "DELETE") return new Response(null, { status: 204 });
				const body = (await request.json()) as { id: string; method: string };
				return Response.json(
					{
						jsonrpc: "2.0",
						id: body.id,
						result: {
							protocolVersion: "2025-03-26",
							capabilities: {},
							serverInfo: { name: "postmortem-test", version: "1" },
						},
					},
					{ headers: { "Mcp-Session-Id": "session-to-release" } },
				);
			},
		});
		servers.push(server);

		const transport = new HttpTransport({ type: "http", url: `${server.url}mcp`, timeout: 1_000 });
		await transport.connect();
		await transport.request("initialize", {});
		expect(liveHttpTransportCount()).toBe(1);

		await disposeAllResourceOwners();

		expect(methods).toEqual(["POST", "DELETE"]);
		expect(sessionIds).toEqual([null, "session-to-release"]);
		expect(liveHttpTransportCount()).toBe(0);
	});

	test("postmortem and graceful close share one session termination", async () => {
		const deleteStarted = Promise.withResolvers<void>();
		const releaseDelete = Promise.withResolvers<void>();
		let deletes = 0;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				if (request.method === "DELETE") {
					deletes += 1;
					deleteStarted.resolve();
					await releaseDelete.promise;
					return new Response(null, { status: 204 });
				}
				const body = (await request.json()) as { id: string };
				return Response.json(
					{ jsonrpc: "2.0", id: body.id, result: {} },
					{ headers: { "Mcp-Session-Id": "single-flight-session" } },
				);
			},
		});
		servers.push(server);

		const transport = new HttpTransport({ type: "http", url: `${server.url}mcp`, timeout: 1_000 });
		await transport.connect();
		await transport.request("initialize", {});

		const postmortem = disposeAllResourceOwners();
		await deleteStarted.promise;
		const graceful = transport.close();
		await Bun.sleep(10);
		expect(deletes).toBe(1);
		releaseDelete.resolve();
		await Promise.all([postmortem, graceful]);
		expect(deletes).toBe(1);
	});

	test("aborts a postmortem DELETE at the cleanup deadline", async () => {
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				const body = (await request.json()) as { id: string };
				return Response.json(
					{ jsonrpc: "2.0", id: body.id, result: {} },
					{ headers: { "Mcp-Session-Id": "deadline-session" } },
				);
			},
		});
		servers.push(server);
		const transport = new HttpTransport({ type: "http", url: `${server.url}mcp`, timeout: 30_000 });
		await transport.connect();
		await transport.request("initialize", {});

		let deleteSignal: AbortSignal | undefined;
		vi.spyOn(globalThis, "fetch").mockImplementation(((_input, init) => {
			deleteSignal = init?.signal ?? undefined;
			return new Promise<Response>((_resolve, reject) => {
				const rejectAbort = () => reject(deleteSignal?.reason ?? new DOMException("Aborted", "AbortError"));
				if (deleteSignal?.aborted) rejectAbort();
				else deleteSignal?.addEventListener("abort", rejectAbort, { once: true });
			});
		}) as typeof fetch);

		const startedAt = performance.now();
		await disposeAllResourceOwners();
		const elapsed = performance.now() - startedAt;

		expect(deleteSignal?.aborted).toBe(true);
		expect(elapsed).toBeGreaterThanOrEqual(1_900);
		expect(elapsed).toBeLessThan(3_000);
		expect(liveHttpTransportCount()).toBe(0);
	});

	test("rejects HTTP transport admission during the complete resource-owner sweep", async () => {
		const blockerStarted = Promise.withResolvers<void>();
		const releaseBlocker = Promise.withResolvers<void>();
		registerResourceOwner("test:http-postmortem-blocker", async () => {
			blockerStarted.resolve();
			await releaseBlocker.promise;
		});
		const existing = new HttpTransport({ type: "http", url: "http://127.0.0.1:1" });
		await existing.connect();
		expect(liveHttpTransportCount()).toBe(1);

		const disposal = disposeAllResourceOwners();
		await blockerStarted.promise;
		expect(isResourceOwnerDisposalActive()).toBe(true);
		const late = new HttpTransport({ type: "http", url: "http://127.0.0.1:1" });
		await expect(late.connect()).rejects.toThrow("during process resource disposal");
		expect(liveHttpTransportCount()).toBe(1);

		releaseBlocker.resolve();
		await disposal;
		expect(isResourceOwnerDisposalActive()).toBe(false);
		expect(liveHttpTransportCount()).toBe(0);

		await late.connect();
		expect(liveHttpTransportCount()).toBe(1);
		await late.close();
	});

	test("graceful close unregisters the transport before postmortem", async () => {
		let deletes = 0;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				if (request.method === "DELETE") deletes += 1;
				return new Response(null, { status: 204 });
			},
		});
		servers.push(server);

		const transport = new HttpTransport({ type: "http", url: `${server.url}mcp`, timeout: 1_000 });
		await transport.connect();
		expect(liveHttpTransportCount()).toBe(1);
		await transport.close();
		expect(liveHttpTransportCount()).toBe(0);

		await disposeAllResourceOwners();
		expect(deletes).toBe(0);
	});
});
