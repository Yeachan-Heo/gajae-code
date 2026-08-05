import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SessionSdkSessionRuntime, type SessionSdkTransport } from "./session-runtime";
import {
	createSdkWebSocketTransport,
	type SdkWebSocketTransportDependencies,
} from "./websocket-transport";

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
		expect(JSON.parse(await fs.readFile(endpointPath, "utf8")).url).toBe(endpoints[0]?.url);
		await transport.stop();
		await expect(fs.stat(endpointPath)).rejects.toMatchObject({ code: "ENOENT" });
		await fs.rm(stateRoot, { recursive: true, force: true });
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
			await Bun.sleep(0);
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
		await expect(fs.stat(path.join(stateRoot, "sdk", "chmod-failure.json"))).rejects.toMatchObject({ code: "ENOENT" });
		await transport.stop();
		await fs.rm(stateRoot, { recursive: true, force: true });
	});

	test("endpoint removal failures are typed and do not prevent server release", async () => {
		const stateRoot = await tempStateRoot();
		let rmCalls = 0;
		const real = fs;
		const dependencies: SdkWebSocketTransportDependencies = {
			filesystem: {
				mkdir: real.mkdir,
				writeFile: real.writeFile,
				chmod: real.chmod,
				rm: async (...args: Parameters<typeof real.rm>) => {
					rmCalls += 1;
					if (rmCalls === 1) throw Object.assign(new Error("rm injected failure"), { code: "EIO" });
					return await real.rm(...args);
				},
			},
		};
		const transport = await createSdkWebSocketTransport({
			sessionId: "rm-failure",
			stateRoot,
			token: "token",
			...dependencies,
		});
		await transport.start();
		await expect(transport.stop()).rejects.toMatchObject({ code: "endpoint_remove_failed" });
		await fs.rm(stateRoot, { recursive: true, force: true });
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
