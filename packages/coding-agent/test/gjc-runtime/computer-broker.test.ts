import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import {
	acquireComputerBrokerLeaseFromEnvironment,
	createComputerBrokerControllerFromEnvironment,
	disposeComputerBrokerLease,
	GJC_COMPUTER_BROKER_DIR_ENV,
	GJC_COMPUTER_BROKER_REQUIRED_ENV,
	GJC_COMPUTER_BROKER_SOCKET_ENV,
	GJC_COMPUTER_BROKER_TOKEN_ENV,
	initializeComputerBrokerLeaseFromEnvironment,
	runComputerBrokerServerFromEnvironment,
	startComputerBrokerForTmux,
} from "@gajae-code/coding-agent/gjc-runtime/computer-broker";

const brokerEnv = [
	GJC_COMPUTER_BROKER_SOCKET_ENV,
	GJC_COMPUTER_BROKER_TOKEN_ENV,
	GJC_COMPUTER_BROKER_DIR_ENV,
	GJC_COMPUTER_BROKER_REQUIRED_ENV,
] as const;
const original = new Map(brokerEnv.map(key => [key, process.env[key]]));

afterEach(() => {
	disposeComputerBrokerLease();
	for (const key of brokerEnv) {
		const value = original.get(key);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

function line(socketPath: string, frame: unknown): Promise<unknown> {
	const pending = Promise.withResolvers<unknown>();
	let buffer = "";
	const socket = net.createConnection(socketPath);
	socket.once("connect", () => socket.write(`${JSON.stringify(frame)}\n`));
	socket.once("error", pending.reject);
	socket.on("data", chunk => {
		buffer += chunk.toString();
		const newline = buffer.indexOf("\n");
		if (newline === -1) return;
		socket.destroy();
		pending.resolve(JSON.parse(buffer.slice(0, newline)));
	});
	return pending.promise;
}

async function waitForSocket(socketPath: string): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (fs.existsSync(socketPath)) return;
		await Bun.sleep(5);
	}
	throw new Error("broker socket did not start");
}

describe("computer broker", () => {
	it("does not create a controller without broker environment", () => {
		for (const key of brokerEnv) delete process.env[key];
		expect(createComputerBrokerControllerFromEnvironment()).toBeNull();
	});

	it("fails closed for partial broker environment without reflecting the token", () => {
		process.env[GJC_COMPUTER_BROKER_SOCKET_ENV] = "/tmp/not-a-broker.sock";
		process.env[GJC_COMPUTER_BROKER_TOKEN_ENV] = "a".repeat(64);
		delete process.env[GJC_COMPUTER_BROKER_DIR_ENV];
		expect(() => createComputerBrokerControllerFromEnvironment()).toThrow(
			"Computer broker configuration is unavailable",
		);
		expect(() => createComputerBrokerControllerFromEnvironment()).not.toThrow("a".repeat(64));
	});

	it("fails closed when managed tmux marks the broker required but unavailable", () => {
		delete process.env[GJC_COMPUTER_BROKER_SOCKET_ENV];
		delete process.env[GJC_COMPUTER_BROKER_TOKEN_ENV];
		delete process.env[GJC_COMPUTER_BROKER_DIR_ENV];
		process.env[GJC_COMPUTER_BROKER_REQUIRED_ENV] = "1";
		expect(() => createComputerBrokerControllerFromEnvironment()).toThrow(
			"Computer broker is required but unavailable",
		);
	});

	it("refuses source-mode managed tmux ownership", () => {
		expect(startComputerBrokerForTmux({ env: {}, isCompiledBinary: () => false })).toBeNull();
	});

	it.if(process.platform === "darwin")("removes an unclaimed broker after the startup deadline", async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-computer-broker-unclaimed-"));
		const socket = path.join(directory, "broker.sock");
		const token = "e".repeat(64);
		const server = runComputerBrokerServerFromEnvironment({
			env: {
				[GJC_COMPUTER_BROKER_DIR_ENV]: directory,
				[GJC_COMPUTER_BROKER_SOCKET_ENV]: socket,
				[GJC_COMPUTER_BROKER_TOKEN_ENV]: token,
			},
			controller: {},
			startupTimeoutMs: 20,
		});
		await waitForSocket(socket);
		await server;
		expect(fs.existsSync(socket)).toBe(false);
		expect(fs.existsSync(directory)).toBe(false);
	});

	it.if(process.platform === "darwin")("fails closed on malformed or closed lease acknowledgments", async () => {
		for (const response of ["malformed", "close"] as const) {
			const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-computer-broker-ack-"));
			const socketPath = path.join(directory, "broker.sock");
			const token = response === "malformed" ? "f".repeat(64) : "1".repeat(64);
			const server = net.createServer(socket => {
				socket.once("data", () => {
					if (response === "malformed")
						socket.end(`${JSON.stringify({ version: 1, type: "lease_ack", ok: false })}\n`);
					else socket.destroy();
				});
			});
			const listening = Promise.withResolvers<void>();
			server.once("error", listening.reject);
			server.listen(socketPath, listening.resolve);
			await listening.promise;
			fs.chmodSync(socketPath, 0o600);
			process.env[GJC_COMPUTER_BROKER_DIR_ENV] = directory;
			process.env[GJC_COMPUTER_BROKER_SOCKET_ENV] = socketPath;
			process.env[GJC_COMPUTER_BROKER_TOKEN_ENV] = token;
			try {
				await acquireComputerBrokerLeaseFromEnvironment();
				throw new Error("expected lease failure");
			} catch (error) {
				expect((error as { code?: string }).code).toBe(
					response === "malformed" ? "COMPUTER_BROKER_PROTOCOL" : "COMPUTER_BROKER_UNAVAILABLE",
				);
			}
			disposeComputerBrokerLease();
			const closed = Promise.withResolvers<void>();
			server.close(error => {
				if (error) closed.reject(error);
				else closed.resolve();
			});
			await closed.promise;
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});

	it.if(process.platform === "darwin")(
		"rejects unauthenticated and malformed request frames, then cleans up after lease close",
		async () => {
			const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-computer-broker-test-"));
			const socket = path.join(directory, "broker.sock");
			const token = "b".repeat(64);
			process.env[GJC_COMPUTER_BROKER_DIR_ENV] = directory;
			process.env[GJC_COMPUTER_BROKER_SOCKET_ENV] = socket;
			process.env[GJC_COMPUTER_BROKER_TOKEN_ENV] = token;
			const server = runComputerBrokerServerFromEnvironment();
			await waitForSocket(socket);
			const rejected = await line(socket, {
				version: 1,
				type: "request",
				token: "c".repeat(64),
				id: "auth",
				method: "screenshot",
				args: [],
			});
			expect(rejected).toMatchObject({ ok: false, error: { code: "COMPUTER_BROKER_AUTH" } });
			const preLease = await line(socket, {
				version: 1,
				type: "request",
				token,
				id: "pre-lease",
				method: "screenshot",
				args: [],
				deadlineAtMs: null,
			});
			expect(preLease).toMatchObject({ ok: false, error: { code: "COMPUTER_BROKER_AUTH" } });
			const lease = net.createConnection(socket);
			const leaseConnected = Promise.withResolvers<void>();
			lease.once("connect", () => {
				lease.write(`${JSON.stringify({ version: 1, type: "lease", token })}\n`);
				leaseConnected.resolve();
			});
			lease.once("error", leaseConnected.reject);
			await leaseConnected.promise;
			const competingLease = await line(socket, { version: 1, type: "lease", token });
			expect(competingLease).toMatchObject({ ok: false, error: { code: "COMPUTER_BROKER_AUTH" } });
			const malformed = await line(socket, {
				version: 1,
				type: "request",
				token,
				id: "strict",
				method: "click",
				args: [null, 1],
			});
			expect(malformed).toMatchObject({ ok: false, error: { code: "COMPUTER_BROKER_PROTOCOL" } });
			lease.destroy();
			await server;
			expect(fs.existsSync(socket)).toBe(false);
			try {
				fs.rmdirSync(directory);
			} catch {}
		},
	);

	it.if(process.platform === "darwin")(
		"roundtrips screenshots and input while preserving redacted native errors",
		async () => {
			const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-computer-broker-roundtrip-"));
			const socket = path.join(directory, "broker.sock");
			const token = "d".repeat(64);
			process.env[GJC_COMPUTER_BROKER_DIR_ENV] = directory;
			process.env[GJC_COMPUTER_BROKER_SOCKET_ENV] = socket;
			process.env[GJC_COMPUTER_BROKER_TOKEN_ENV] = token;
			const calls: unknown[][] = [];
			const waitStarted = Promise.withResolvers<void>();
			let moveCalls = 0;
			const permissionError = Object.assign(new Error("COMPUTER_SUSPENDED: sentinel-secret"), {
				code: "GenericFailure",
			});
			const server = runComputerBrokerServerFromEnvironment({
				controller: {
					screenshot: () => ({
						png: new Uint8Array([1, 2, 3]),
						widthPx: 2,
						heightPx: 1,
						displayEpoch: 42,
						captureId: 7,
					}),
					click: (...args) => {
						calls.push(["click", ...args]);
					},
					doubleClick: (...args) => {
						calls.push(["doubleClick", ...args]);
					},
					drag: (...args) => {
						calls.push(["drag", ...args]);
					},
					scroll: (...args) => {
						calls.push(["scroll", ...args]);
					},
					type: (...args) => {
						calls.push(["type", ...args]);
					},
					wait: async () => {
						waitStarted.resolve();
						await Bun.sleep(50);
					},
					move: () => {
						moveCalls++;
					},
					keypress: (...args) => {
						if (Array.isArray(args[1]) && args[1][0] === "escape") throw permissionError;
						calls.push(["keypress", ...args]);
					},
				},
				startupTimeoutMs: 1_000,
			});
			await waitForSocket(socket);
			const controller = createComputerBrokerControllerFromEnvironment();
			if (!controller?.screenshot || !controller.click || !controller.keypress || !controller.brokerInvoke)
				throw new Error("expected complete broker controller");
			const screenshot = await controller.screenshot();
			expect(Buffer.from(screenshot.png as Uint8Array)).toEqual(Buffer.from([1, 2, 3]));
			expect(screenshot).toMatchObject({ widthPx: 2, heightPx: 1, displayEpoch: 42, captureId: 7 });
			await controller.click(42, 1, 2, "middle");
			await controller.brokerInvoke("doubleClick", [42, 3, 4, "right"]);
			await controller.brokerInvoke("drag", [42, 5, 6, 7, 8, "left"]);
			await controller.brokerInvoke("scroll", [42, 9, 10, -2, 3]);
			await controller.brokerInvoke("type", [null, "line one\n\tline two"]);
			await controller.brokerInvoke("keypress", [null, ["cmd", "a"]]);
			expect(calls).toEqual([
				["click", 42, 1, 2, "middle"],
				["doubleClick", 42, 3, 4, "right"],
				["drag", 42, 5, 6, 7, 8, "left"],
				["scroll", 42, 9, 10, -2, 3],
				["type", undefined, "line one\n\tline two"],
				["keypress", undefined, ["cmd", "a"]],
			]);
			try {
				await controller.keypress(undefined, ["escape"]);
				throw new Error("expected broker error");
			} catch (error) {
				expect((error as { code?: string }).code).toBe("COMPUTER_SUSPENDED");
				expect((error as Error).message).not.toContain("sentinel-secret");
			}
			if (!controller.brokerInvoke) throw new Error("expected context-aware broker invocation");
			const blockingWait = controller.brokerInvoke("wait", [null, 50], { timeoutMs: 500 });
			await waitStarted.promise;
			try {
				await controller.brokerInvoke("move", [null, 3, 4], { timeoutMs: 5 });
				throw new Error("expected broker timeout");
			} catch (error) {
				expect((error as { code?: string }).code).toBe("COMPUTER_BROKER_TIMEOUT");
			}
			try {
				await blockingWait;
				throw new Error("expected broker shutdown");
			} catch (error) {
				expect((error as { code?: string }).code).toBe("COMPUTER_BROKER_UNAVAILABLE");
			}
			expect(moveCalls).toBe(0);
			const abort = new AbortController();
			abort.abort();
			try {
				await controller.brokerInvoke("move", [null, 5, 6], { signal: abort.signal });
				throw new Error("expected broker cancellation");
			} catch (error) {
				expect((error as { code?: string }).code).toBe("COMPUTER_CANCELLED");
			}
			expect(moveCalls).toBe(0);
			disposeComputerBrokerLease();
			await server;
			expect(fs.existsSync(socket)).toBe(false);
			expect(fs.existsSync(directory)).toBe(false);
		},
	);

	it.if(process.platform === "darwin")("aborts a queued action and shuts down the leased broker", async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-computer-broker-abort-"));
		const socket = path.join(directory, "broker.sock");
		const token = "2".repeat(64);
		process.env[GJC_COMPUTER_BROKER_DIR_ENV] = directory;
		process.env[GJC_COMPUTER_BROKER_SOCKET_ENV] = socket;
		process.env[GJC_COMPUTER_BROKER_TOKEN_ENV] = token;
		const waitStarted = Promise.withResolvers<void>();
		let moveCalls = 0;
		const server = runComputerBrokerServerFromEnvironment({
			controller: {
				wait: async () => {
					waitStarted.resolve();
					await Bun.sleep(50);
				},
				move: () => {
					moveCalls++;
				},
			},
			startupTimeoutMs: 1_000,
		});
		await waitForSocket(socket);
		const controller = createComputerBrokerControllerFromEnvironment();
		if (!controller?.brokerInvoke) throw new Error("expected broker invocation");
		const active = controller.brokerInvoke("wait", [null, 50], { timeoutMs: 500 });
		await waitStarted.promise;
		const abort = new AbortController();
		const queued = controller.brokerInvoke("move", [null, 1, 1], { timeoutMs: 500, signal: abort.signal });
		await Bun.sleep(10);
		abort.abort();
		try {
			await queued;
			throw new Error("expected queued cancellation");
		} catch (error) {
			expect((error as { code?: string }).code).toBe("COMPUTER_CANCELLED");
		}
		try {
			await active;
			throw new Error("expected active request shutdown");
		} catch (error) {
			expect((error as { code?: string }).code).toBe("COMPUTER_BROKER_UNAVAILABLE");
		}
		expect(moveCalls).toBe(0);
		await server;
		expect(fs.existsSync(socket)).toBe(false);
		expect(fs.existsSync(directory)).toBe(false);
	});

	it("lease initialization is a synchronous no-op without broker configuration", () => {
		for (const key of brokerEnv) delete process.env[key];
		expect(() => initializeComputerBrokerLeaseFromEnvironment()).not.toThrow();
	});
});
