import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SdkClient } from "../client/client";
import { SessionSdkSessionRuntime, type SessionSdkTransport } from "./session-runtime";
import { createSdkWebSocketTransport, type SdkWebSocketTransportDependencies } from "./websocket-transport";

async function tempStateRoot(): Promise<string> {
	return await fs.mkdtemp(path.join(os.tmpdir(), "gjc-sdk-transport-"));
}

async function probeWebSocketEndpoint(url: string, token: string): Promise<void> {
	const socket = new WebSocket(`${url}?token=${encodeURIComponent(token)}`);
	try {
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("timed out probing SDK endpoint")), 2_000);
			socket.addEventListener("open", () => {
				clearTimeout(timer);
				resolve();
			});
			socket.addEventListener("error", () => {
				clearTimeout(timer);
				reject(new Error("SDK endpoint probe failed"));
			});
		});
	} finally {
		socket.close();
	}
}

describe("SDK WebSocket transport lifecycle", () => {
	test("concurrent start calls share one endpoint and one server", async () => {
		const stateRoot = await tempStateRoot();
		const transport = await createSdkWebSocketTransport({
			sessionId: "concurrent-start",
			stateRoot,
			token: "token",
		});
		const endpoints = await Promise.all([transport.start(), transport.start(), transport.start()]);
		expect(new Set(endpoints.map(endpoint => endpoint.url)).size).toBe(1);
		const endpointPath = path.join(stateRoot, "sdk", "concurrent-start.json");
		expect(JSON.parse(await fs.readFile(endpointPath, "utf8"))).toMatchObject({
			sessionId: "concurrent-start",
			url: endpoints[0]?.url,
		});
		await transport.stop();
		await expect(fs.stat(endpointPath)).rejects.toMatchObject({ code: "ENOENT" });
		await fs.rm(stateRoot, { recursive: true, force: true });
	});
	test("publishes a complete mode-600 endpoint through one atomic rename", async () => {
		const stateRoot = await tempStateRoot();
		const endpointPath = path.join(stateRoot, "sdk", "atomic-publication.json");
		const renameEntered = Promise.withResolvers<void>();
		const releaseRename = Promise.withResolvers<void>();
		const transport = await createSdkWebSocketTransport({
			sessionId: "atomic-publication",
			stateRoot,
			token: "secret-token",
			filesystem: {
				mkdir: fs.mkdir,
				writeFile: fs.writeFile,
				chmod: fs.chmod,
				stat: fs.stat,
				rename: async (from, to) => {
					expect(to).toBe(endpointPath);
					expect((await fs.stat(from)).mode & 0o777).toBe(0o600);
					expect(JSON.parse(await fs.readFile(from, "utf8"))).toMatchObject({
						sessionId: "atomic-publication",
						token: "secret-token",
					});
					renameEntered.resolve();
					await releaseRename.promise;
					await fs.rename(from, to);
				},
				rm: fs.rm,
			},
		});
		const start = transport.start();
		try {
			await renameEntered.promise;
			await expect(fs.stat(endpointPath)).rejects.toMatchObject({ code: "ENOENT" });
			expect((await fs.readdir(path.dirname(endpointPath))).filter(file => file.endsWith(".tmp"))).toHaveLength(1);
			releaseRename.resolve();
			await start;
			expect(JSON.parse(await fs.readFile(endpointPath, "utf8"))).toMatchObject({
				sessionId: "atomic-publication",
				token: "secret-token",
			});
		} finally {
			releaseRename.resolve();
			await start.catch(() => undefined);
			await transport.stop().catch(() => undefined);
			await fs.rm(stateRoot, { recursive: true, force: true });
		}
	});
	test("six isolated roots publish unique endpoints that accept metadata and prompt controls", async () => {
		const roots = await Promise.all(Array.from({ length: 6 }, () => tempStateRoot()));
		const transports = await Promise.all(
			roots.map((stateRoot, index) =>
				createSdkWebSocketTransport({
					sessionId: `isolated-lane-${index + 1}`,
					stateRoot,
					token: `token-${index + 1}`,
				}),
			),
		);
		const frameDisposers = transports.map(transport =>
			transport.onFrame((connectionId, frame) => {
				if (frame.type !== "query_request" && frame.type !== "control_request") return;
				void transport.sendFrame(connectionId, {
					type: frame.type === "query_request" ? "query_response" : "control_response",
					id: frame.id,
					ok: true,
					result: frame.type === "query_request" ? { sessionId: transport.sessionId } : { accepted: true },
				});
			}),
		);
		const clients: SdkClient[] = [];
		try {
			const endpoints = await Promise.all(transports.map(transport => transport.start()));
			expect(new Set(endpoints.map(endpoint => endpoint.url)).size).toBe(6);
			await Promise.all(
				roots.map(async (stateRoot, index) => {
					const sessionId = `isolated-lane-${index + 1}`;
					const record = JSON.parse(await fs.readFile(path.join(stateRoot, "sdk", `${sessionId}.json`), "utf8"));
					expect(record).toMatchObject({ sessionId, url: endpoints[index]?.url, token: `token-${index + 1}` });
					await probeWebSocketEndpoint(endpoints[index]!.url, `token-${index + 1}`);
				}),
			);
			const connected = await Promise.all(
				endpoints.map((endpoint, index) => SdkClient.connect(endpoint.url, `token-${index + 1}`)),
			);
			clients.push(...connected);
			await Promise.all(
				connected.flatMap((client, index) => [
					expect(client.query("session.metadata")).resolves.toMatchObject({
						ok: true,
						result: { sessionId: `isolated-lane-${index + 1}` },
					}),
					expect(client.control("turn.prompt", { text: `probe lane ${index + 1}` })).resolves.toMatchObject({
						ok: true,
						result: { accepted: true },
					}),
				]),
			);
		} finally {
			await Promise.all(clients.map(client => client.close()));
			for (const dispose of frameDisposers) dispose?.();
			await Promise.all(transports.map(transport => transport.stop().catch(() => undefined)));
			await Promise.all(roots.map(root => fs.rm(root, { recursive: true, force: true })));
		}
	});

	test("start waits for a pending stop before publishing a probeable replacement endpoint", async () => {
		const stateRoot = await tempStateRoot();
		let releaseStop: (() => Promise<void>) | undefined;
		let stopEntered = false;
		let holdNextStop = true;
		const serve = ((options: any) => {
			const actual = Bun.serve(options) as any;
			const actualStop = actual.stop.bind(actual);
			actual.stop = (force?: boolean) => {
				if (!holdNextStop) return actualStop(force);
				holdNextStop = false;
				stopEntered = true;
				return new Promise<void>((resolve, reject) => {
					releaseStop = async () => {
						try {
							await actualStop(force);
							resolve();
						} catch (error) {
							reject(error);
							throw error;
						}
					};
				});
			};
			return actual;
		}) as SdkWebSocketTransportDependencies["serve"];
		const transport = await createSdkWebSocketTransport({
			sessionId: "stop-start-overlap",
			stateRoot,
			token: "token",
			serve,
		});
		try {
			const first = await transport.start();
			const stopPromise = transport.stop();
			for (let attempt = 0; attempt < 100 && !stopEntered; attempt += 1) await Bun.sleep(1);
			expect(stopEntered).toBe(true);
			let secondResolved = false;
			const secondPromise = transport.start().then(endpoint => {
				secondResolved = true;
				return endpoint;
			});
			await Bun.sleep(25);
			expect(secondResolved).toBe(false);
			const release = releaseStop;
			releaseStop = undefined;
			await release?.();
			await stopPromise;
			const second = await secondPromise;
			expect(second.url).toMatch(/^ws:\/\/127\.0\.0\.1:/);
			await probeWebSocketEndpoint(second.url, "token");
			expect(second.url).toBeTypeOf("string");
			void first;
		} finally {
			const cleanupStop = transport.stop().catch(() => undefined);
			for (let attempt = 0; attempt < 100 && !releaseStop; attempt += 1) await Bun.sleep(1);
			if (releaseStop) {
				const release = releaseStop;
				releaseStop = undefined;
				await release().catch(() => undefined);
			}
			await cleanupStop;
			await fs.rm(stateRoot, { recursive: true, force: true });
		}
	});
	test("chmod failure compensates by stopping the server and removing the endpoint", async () => {
		const stateRoot = await tempStateRoot();
		const real = fs;
		const dependencies: SdkWebSocketTransportDependencies = {
			filesystem: {
				mkdir: real.mkdir,
				writeFile: real.writeFile,
				chmod: async () => {
					throw Object.assign(new Error("chmod injected failure"), { code: "EACCES" });
				},
				stat: real.stat,
				rename: real.rename,
				rm: real.rm,
			},
		};
		const transport = await createSdkWebSocketTransport({
			sessionId: "chmod-failure",
			stateRoot,
			token: "token",
			...dependencies,
		});
		await expect(transport.start()).rejects.toMatchObject({ code: "endpoint_chmod_failed" });
		await expect(fs.stat(path.join(stateRoot, "sdk", "chmod-failure.json"))).rejects.toMatchObject({
			code: "ENOENT",
		});
		await transport.stop();
		await fs.rm(stateRoot, { recursive: true, force: true });
	});

	test("failed duplicate startup preserves a canonical endpoint it did not publish", async () => {
		const stateRoot = await tempStateRoot();
		const endpointPath = path.join(stateRoot, "sdk", "duplicate-cleanup.json");
		await fs.mkdir(path.dirname(endpointPath), { recursive: true });
		const canonicalEndpoint = JSON.stringify({
			version: 1,
			sessionId: "duplicate-cleanup",
			url: "ws://127.0.0.1:12345/",
			token: "canonical-token",
			pid: process.pid,
		});
		await fs.writeFile(endpointPath, canonicalEndpoint, { mode: 0o600 });
		const transport = await createSdkWebSocketTransport({
			sessionId: "duplicate-cleanup",
			stateRoot,
			token: "duplicate-token",
			filesystem: {
				mkdir: fs.mkdir,
				writeFile: async () => {
					throw Object.assign(new Error("duplicate startup failed"), { code: "EIO" });
				},
				chmod: fs.chmod,
				stat: fs.stat,
				rename: fs.rename,
				rm: fs.rm,
			},
		});
		try {
			await expect(transport.start()).rejects.toMatchObject({ code: "endpoint_write_failed" });
			expect(await fs.readFile(endpointPath, "utf8")).toBe(canonicalEndpoint);
		} finally {
			await transport.stop();
			await fs.rm(stateRoot, { recursive: true, force: true });
		}
	});

	test("retains a replacement endpoint while concurrent readers finish", async () => {
		const stateRoot = await tempStateRoot();
		const endpointPath = path.join(stateRoot, "sdk", "replacement.json");
		const transport = await createSdkWebSocketTransport({
			sessionId: "replacement",
			stateRoot,
			token: "token",
		});
		try {
			await transport.start();
			const replacement = JSON.stringify({ sessionId: "replacement", url: "ws://127.0.0.1:1", token: "successor" });
			const displaced = `${endpointPath}.displaced`;
			await fs.rename(endpointPath, displaced);
			await fs.writeFile(endpointPath, replacement, { mode: 0o600 });
			const readers = Promise.all(Array.from({ length: 16 }, async () => await fs.readFile(endpointPath, "utf8")));
			await transport.stop();
			expect(await readers).toEqual(Array(16).fill(replacement));
			expect(await fs.readFile(endpointPath, "utf8")).toBe(replacement);
			await fs.rm(displaced, { force: true });
		} finally {
			await transport.stop().catch(() => undefined);
			await fs.rm(stateRoot, { recursive: true, force: true });
		}
	});

	test("endpoint identity uncertainty is typed and retains the endpoint", async () => {
		const stateRoot = await tempStateRoot();
		const endpointPath = path.join(stateRoot, "sdk", "identity-uncertain.json");
		const transport = await createSdkWebSocketTransport({
			sessionId: "identity-uncertain",
			stateRoot,
			token: "token",
		});
		try {
			await transport.start();
			await fs.rm(endpointPath);
			await fs.mkdir(endpointPath);
			await expect(transport.stop()).rejects.toMatchObject({ code: "endpoint_remove_failed" });
			await expect(fs.stat(endpointPath)).resolves.toBeDefined();
		} finally {
			await fs.rm(stateRoot, { recursive: true, force: true });
		}
	});

	test("runtime stop releases the transport even when host stop fails", async () => {
		let transportStops = 0;
		const transport: SessionSdkTransport = {
			sessionId: "host-stop-failure",
			stateRoot: "/tmp",
			token: "token",
			onFrame: () => () => {},
			sendFrame: () => {},
			start: async () => ({ url: "ws://127.0.0.1:1" }),
			stop: async () => {
				transportStops += 1;
			},
		};
		const runtime = new SessionSdkSessionRuntime({ transport });
		await runtime.start();
		Object.defineProperty(runtime.host, "stop", {
			configurable: true,
			value: async () => {
				throw new Error("host stop injected failure");
			},
		});
		await expect(runtime.stop()).rejects.toThrow("host stop injected failure");
		expect(transportStops).toBe(1);
	});
});
