import { afterEach, describe, expect, it } from "bun:test";
import type * as childProcess from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import {
	acquireComputerBrokerLeaseFromEnvironment,
	type ComputerBrokerProcessIdentity,
	computerBrokerTestSeams,
	createComputerBrokerControllerFromEnvironment,
	disposeComputerBrokerLease,
	GJC_COMPUTER_BROKER_DIR_ENV,
	GJC_COMPUTER_BROKER_EXECUTABLE_ENV,
	GJC_COMPUTER_BROKER_EXECUTABLE_SHA256_ENV,
	GJC_COMPUTER_BROKER_PGID_ENV,
	GJC_COMPUTER_BROKER_PID_ENV,
	GJC_COMPUTER_BROKER_REQUIRED_ENV,
	GJC_COMPUTER_BROKER_SOCKET_ENV,
	GJC_COMPUTER_BROKER_START_ENV,
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
	GJC_COMPUTER_BROKER_PID_ENV,
	GJC_COMPUTER_BROKER_START_ENV,
	GJC_COMPUTER_BROKER_EXECUTABLE_ENV,
	GJC_COMPUTER_BROKER_EXECUTABLE_SHA256_ENV,
	GJC_COMPUTER_BROKER_PGID_ENV,
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

function currentBrokerIdentity(): ComputerBrokerProcessIdentity {
	const identity = computerBrokerTestSeams.processIdentity(process.pid);
	if (!identity) throw new Error("expected current process identity");
	return identity;
}

function setBrokerIdentityEnvironment(): void {
	const identity = currentBrokerIdentity();
	process.env[GJC_COMPUTER_BROKER_PID_ENV] = String(identity.pid);
	process.env[GJC_COMPUTER_BROKER_START_ENV] = identity.start;
	process.env[GJC_COMPUTER_BROKER_EXECUTABLE_ENV] = identity.executable;
	process.env[GJC_COMPUTER_BROKER_EXECUTABLE_SHA256_ENV] = identity.executableSha256;
	process.env[GJC_COMPUTER_BROKER_PGID_ENV] = String(identity.pgid);
}

function line(socketPath: string, frame: unknown): Promise<unknown> {
	const pending = Promise.withResolvers<unknown>();
	let buffer = Buffer.alloc(0);
	const socket = net.createConnection(socketPath);
	socket.once("connect", () => socket.write(`${JSON.stringify(frame)}\n`));
	socket.once("error", pending.reject);
	socket.on("data", chunk => {
		buffer = Buffer.concat([buffer, typeof chunk === "string" ? Buffer.from(chunk) : chunk]);
		const newline = buffer.indexOf(0x0a);
		if (newline === -1) return;
		socket.destroy();
		pending.resolve(JSON.parse(buffer.subarray(0, newline).toString("utf8")));
	});
	return pending.promise;
}

interface TestFrameWaiter {
	promise: Promise<unknown>;
	resolve(value: unknown): void;
	reject(reason?: unknown): void;
}

function socketFrames(socket: net.Socket): { next(): Promise<unknown> } {
	let buffer = Buffer.alloc(0);
	const queued: unknown[] = [];
	const waiters: TestFrameWaiter[] = [];
	const fail = (error: unknown): void => {
		for (const waiter of waiters.splice(0)) waiter.reject(error);
	};
	socket.on("data", chunk => {
		buffer = Buffer.concat([buffer, typeof chunk === "string" ? Buffer.from(chunk) : chunk]);
		while (true) {
			const newline = buffer.indexOf(0x0a);
			if (newline === -1) return;
			const line = buffer.subarray(0, newline);
			buffer = buffer.subarray(newline + 1);
			try {
				const frame: unknown = JSON.parse(line.toString("utf8"));
				const waiter = waiters.shift();
				if (waiter) waiter.resolve(frame);
				else queued.push(frame);
			} catch (error) {
				fail(error);
			}
		}
	});
	socket.once("error", fail);
	socket.once("close", () => fail(new Error("socket closed before frame")));
	return {
		next: () => {
			if (queued.length > 0) return Promise.resolve(queued.shift());
			const waiter = Promise.withResolvers<unknown>();
			waiters.push(waiter);
			return waiter.promise;
		},
	};
}

async function waitForSocket(socketPath: string): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		try {
			const stat = fs.lstatSync(socketPath);
			if (stat.isSocket() && (stat.mode & 0o777) === 0o600) return;
		} catch {}
		await Bun.sleep(5);
	}
	throw new Error("broker socket did not start");
}

async function listen(server: net.Server, socketPath: string): Promise<void> {
	const listening = Promise.withResolvers<void>();
	server.once("error", listening.reject);
	server.listen(socketPath, listening.resolve);
	await listening.promise;
	fs.chmodSync(socketPath, 0o600);
}

async function closeServer(server: net.Server): Promise<void> {
	const closed = Promise.withResolvers<void>();
	server.close(error => {
		if (error) closed.reject(error);
		else closed.resolve();
	});
	await closed.promise;
}

function fakeBrokerChild(pid: number, onKill: (signal: NodeJS.Signals) => boolean): childProcess.ChildProcess {
	let child: childProcess.ChildProcess;
	child = {
		pid,
		exitCode: null,
		unref: () => child,
		once: () => child,
		kill: (signal?: NodeJS.Signals | number) => onKill(typeof signal === "string" ? signal : "SIGTERM"),
	} as unknown as childProcess.ChildProcess;
	return child;
}

const testHelperExecutable = fs.realpathSync(process.execPath);
const testHelperExecutableSha256 = crypto.createHash("sha256").update(testHelperExecutable, "utf8").digest("hex");

function staticProcessIdentity(pid: number): ComputerBrokerProcessIdentity {
	return {
		pid,
		start: "100:200",
		executable: testHelperExecutable,
		executableSha256: testHelperExecutableSha256,
		pgid: pid,
		parentPid: process.pid,
	};
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

	it("fails closed when configured broker identity metadata is incomplete", () => {
		process.env[GJC_COMPUTER_BROKER_SOCKET_ENV] = "/tmp/gjc-computer-broker/broker.sock";
		process.env[GJC_COMPUTER_BROKER_TOKEN_ENV] = "a".repeat(64);
		process.env[GJC_COMPUTER_BROKER_DIR_ENV] = "/tmp/gjc-computer-broker";
		delete process.env[GJC_COMPUTER_BROKER_PID_ENV];
		expect(() => createComputerBrokerControllerFromEnvironment()).toThrow(
			"Computer broker configuration is unavailable",
		);
	});

	it("fails closed when identity metadata exists without broker paths", () => {
		for (const key of brokerEnv) delete process.env[key];
		process.env[GJC_COMPUTER_BROKER_PID_ENV] = String(process.pid);
		expect(() => createComputerBrokerControllerFromEnvironment()).toThrow(
			"Computer broker is required but unavailable",
		);
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

	it("never pathname-closes a production broker after post-listen failure", () => {
		const calls: string[] = [];
		let server: net.Server;
		server = {
			close: () => {
				calls.push("close");
				return server;
			},
			unref: () => {
				calls.push("unref");
				return server;
			},
		} as net.Server;
		computerBrokerTestSeams.abandonServerAfterListenFailure(server, false);
		expect(calls).toEqual(["unref"]);
	});
	it("refuses source-mode managed tmux ownership", () => {
		expect(startComputerBrokerForTmux({ env: {}, isCompiledBinary: () => false })).toBeNull();
	});

	it("deletes only the captured broker runtime inode", () => {
		const base = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-computer-broker-cleanup-"));
		const directory = path.join(base, "owner");
		const socket = path.join(directory, "broker.sock");
		fs.mkdirSync(directory, { mode: 0o700 });
		fs.writeFileSync(socket, "owner");
		fs.chmodSync(socket, 0o600);
		const identity = computerBrokerTestSeams.captureRuntimePathIdentity({ socket, directory });
		if (!identity) throw new Error("expected runtime identity");
		computerBrokerTestSeams.removeRuntimeDirectory({ socket, directory }, identity);
		expect(fs.existsSync(directory)).toBe(false);
		fs.rmSync(base, { recursive: true, force: true });
	});

	it("refuses to delete replacement broker paths", () => {
		const base = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-computer-broker-replaced-"));
		const directory = path.join(base, "owner");
		const moved = path.join(base, "moved-owner");
		const socket = path.join(directory, "broker.sock");
		fs.mkdirSync(directory, { mode: 0o700 });
		fs.writeFileSync(socket, "owner");
		fs.chmodSync(socket, 0o600);
		const identity = computerBrokerTestSeams.captureRuntimePathIdentity({ socket, directory });
		if (!identity) throw new Error("expected runtime identity");
		fs.renameSync(directory, moved);
		fs.mkdirSync(directory, { mode: 0o700 });
		fs.writeFileSync(socket, "replacement");
		fs.chmodSync(socket, 0o600);
		expect(() => computerBrokerTestSeams.removeRuntimeDirectory({ socket, directory }, identity)).toThrow(
			"Computer broker cleanup could not be confirmed",
		);
		expect(fs.readFileSync(socket, "utf8")).toBe("replacement");
		expect(fs.readFileSync(path.join(moved, "broker.sock"), "utf8")).toBe("owner");
		fs.rmSync(base, { recursive: true, force: true });
	});

	it("never accepts or signals a replacement process on the first identity read", () => {
		const pid = 42_423;
		const replacementIdentity = {
			...staticProcessIdentity(pid),
			parentPid: process.pid + 1,
		};
		const signals: NodeJS.Signals[] = [];
		let runtimeDirectory: string | undefined;
		const child = fakeBrokerChild(pid, signal => {
			signals.push(signal);
			return true;
		});
		const spawn = ((_command: string, _args: readonly string[], options: childProcess.SpawnOptions) => {
			runtimeDirectory = options.env?.[GJC_COMPUTER_BROKER_DIR_ENV];
			return child;
		}) as typeof childProcess.spawn;
		try {
			expect(() =>
				startComputerBrokerForTmux({
					isCompiledBinary: () => true,
					spawn,
					startupTimeoutMs: 1,
					readProcessIdentity: () => replacementIdentity,
					isProcessAlive: () => true,
					termTimeoutMs: 1,
					killTimeoutMs: 1,
				}),
			).toThrow("Computer broker cleanup could not be confirmed");
			expect(signals).toEqual([]);
		} finally {
			if (runtimeDirectory) fs.rmSync(runtimeDirectory, { recursive: true, force: true });
		}
	});
	it("never signals a reused broker PID", () => {
		const pid = 42_424;
		const originalIdentity = staticProcessIdentity(pid);
		const replacementIdentity = { ...originalIdentity, start: "100:201" };
		const signals: NodeJS.Signals[] = [];
		let identityReads = 0;
		let runtimeDirectory: string | undefined;
		const child = fakeBrokerChild(pid, signal => {
			signals.push(signal);
			return true;
		});
		const spawn = ((_command: string, _args: readonly string[], options: childProcess.SpawnOptions) => {
			runtimeDirectory = options.env?.[GJC_COMPUTER_BROKER_DIR_ENV];
			return child;
		}) as typeof childProcess.spawn;
		try {
			expect(() =>
				startComputerBrokerForTmux({
					isCompiledBinary: () => true,
					spawn,
					startupTimeoutMs: 1,
					readProcessIdentity: () => (identityReads++ === 0 ? originalIdentity : replacementIdentity),
					isProcessAlive: () => true,
					termTimeoutMs: 1,
					killTimeoutMs: 1,
				}),
			).toThrow("Computer broker cleanup could not be confirmed");
			expect(signals).toEqual([]);
		} finally {
			if (runtimeDirectory) fs.rmSync(runtimeDirectory, { recursive: true, force: true });
		}
	});

	it("revalidates one broker incarnation before TERM and KILL", () => {
		const pid = 42_425;
		const identity = staticProcessIdentity(pid);
		const signals: NodeJS.Signals[] = [];
		let alive = true;
		const child = fakeBrokerChild(pid, signal => {
			signals.push(signal);
			if (signal === "SIGKILL") alive = false;
			return true;
		});
		const spawn = ((_command: string, _args: readonly string[], _options: childProcess.SpawnOptions) =>
			child) as typeof childProcess.spawn;
		expect(
			startComputerBrokerForTmux({
				isCompiledBinary: () => true,
				spawn,
				startupTimeoutMs: 1,
				readProcessIdentity: () => identity,
				isProcessAlive: () => alive,
				termTimeoutMs: 1,
				killTimeoutMs: 1,
			}),
		).toBeNull();
		expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
	});

	it.if(process.platform === "darwin")("never sends the lease token to a mismatched peer incarnation", async () => {
		for (const mismatch of ["pid", "start"] as const) {
			const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-computer-broker-peer-"));
			const socketPath = path.join(directory, "broker.sock");
			const token = mismatch === "pid" ? "4".repeat(64) : "5".repeat(64);
			let received = Buffer.alloc(0);
			const connectionClosed = Promise.withResolvers<void>();
			const server = net.createServer(socket => {
				socket.on("data", chunk => {
					received = Buffer.concat([received, typeof chunk === "string" ? Buffer.from(chunk) : chunk]);
				});
				socket.once("close", connectionClosed.resolve);
			});
			await listen(server, socketPath);
			process.env[GJC_COMPUTER_BROKER_DIR_ENV] = directory;
			process.env[GJC_COMPUTER_BROKER_SOCKET_ENV] = socketPath;
			process.env[GJC_COMPUTER_BROKER_TOKEN_ENV] = token;
			setBrokerIdentityEnvironment();
			if (mismatch === "pid") process.env[GJC_COMPUTER_BROKER_PID_ENV] = String(process.pid + 100_000);
			else process.env[GJC_COMPUTER_BROKER_START_ENV] = "0:0";
			try {
				await acquireComputerBrokerLeaseFromEnvironment();
				throw new Error("expected broker identity rejection");
			} catch (error) {
				expect((error as { code?: string }).code).toBe("COMPUTER_BROKER_UNAVAILABLE");
			}
			await connectionClosed.promise;
			expect(received.byteLength).toBe(0);
			await closeServer(server);
			fs.rmSync(directory, { recursive: true, force: true });
		}
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
			setBrokerIdentityEnvironment();
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
			setBrokerIdentityEnvironment();
			const server = runComputerBrokerServerFromEnvironment({ controller: {} });
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
			const tokenBearingRequest = await line(socket, {
				version: 1,
				type: "request",
				token,
				id: "stolen-token",
				method: "screenshot",
				args: [],
				deadlineAtMs: Date.now() + 1_000,
			});
			expect(tokenBearingRequest).toMatchObject({ ok: false, error: { code: "COMPUTER_BROKER_AUTH" } });
			const malformed = await line(socket, {
				version: 1,
				type: "request",
				token,
				id: "strict",
				method: "click",
				args: [null, 1],
			});
			expect(malformed).toMatchObject({ ok: false, error: { code: "COMPUTER_BROKER_AUTH" } });
			lease.destroy();
			await server;
			expect(fs.existsSync(socket)).toBe(false);
			try {
				fs.rmdirSync(directory);
			} catch {}
		},
	);

	it.if(process.platform === "darwin")(
		"reassembles fragmented multibyte request frames on the owner lease",
		async () => {
			const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-computer-broker-unicode-"));
			const socketPath = path.join(directory, "broker.sock");
			const token = "7".repeat(64);
			process.env[GJC_COMPUTER_BROKER_DIR_ENV] = directory;
			process.env[GJC_COMPUTER_BROKER_SOCKET_ENV] = socketPath;
			process.env[GJC_COMPUTER_BROKER_TOKEN_ENV] = token;
			setBrokerIdentityEnvironment();
			const typed: string[] = [];
			const server = runComputerBrokerServerFromEnvironment({
				controller: {
					type: (_epoch, text) => {
						typed.push(text);
					},
				},
				startupTimeoutMs: 1_000,
			});
			await waitForSocket(socketPath);
			const lease = net.createConnection(socketPath);
			const frames = socketFrames(lease);
			await new Promise<void>((resolve, reject) => {
				lease.once("connect", resolve);
				lease.once("error", reject);
			});
			lease.write(`${JSON.stringify({ version: 1, type: "lease", token })}\n`);
			expect(await frames.next()).toMatchObject({ version: 1, type: "lease_ack", ok: true });
			const text = "한글🙂";
			const request = Buffer.from(
				`${JSON.stringify({
					version: 1,
					type: "request",
					token,
					id: "unicode",
					method: "type",
					args: [null, text],
					deadlineAtMs: Date.now() + 1_000,
				})}\n`,
				"utf8",
			);
			const multibyteStart = request.indexOf(Buffer.from("한", "utf8"));
			expect(multibyteStart).toBeGreaterThan(0);
			lease.write(request.subarray(0, multibyteStart + 1));
			await Bun.sleep(1);
			lease.write(request.subarray(multibyteStart + 1));
			expect(await frames.next()).toMatchObject({ version: 1, type: "response", id: "unicode", ok: true });
			expect(typed).toEqual([text]);
			lease.destroy();
			await server;
			expect(fs.existsSync(socketPath)).toBe(false);
			expect(fs.existsSync(directory)).toBe(false);
		},
	);

	it.if(process.platform === "darwin")(
		"reassembles fragmented multibyte responses on the persistent lease",
		async () => {
			const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-computer-broker-response-unicode-"));
			const socketPath = path.join(directory, "broker.sock");
			const token = "8".repeat(64);
			const server = net.createServer(socket => {
				const frames = socketFrames(socket);
				void (async () => {
					expect(await frames.next()).toEqual({ version: 1, type: "lease", token });
					socket.write(`${JSON.stringify({ version: 1, type: "lease_ack", ok: true })}\n`);
					const request = (await frames.next()) as { id: string };
					const response = Buffer.from(
						`${JSON.stringify({ version: 1, type: "response", id: request.id, ok: true, result: "응답🙂" })}\n`,
						"utf8",
					);
					const multibyteStart = response.indexOf(Buffer.from("응", "utf8"));
					socket.write(response.subarray(0, multibyteStart + 1));
					await Bun.sleep(1);
					socket.write(response.subarray(multibyteStart + 1));
				})().catch(() => socket.destroy());
			});
			await listen(server, socketPath);
			process.env[GJC_COMPUTER_BROKER_DIR_ENV] = directory;
			process.env[GJC_COMPUTER_BROKER_SOCKET_ENV] = socketPath;
			process.env[GJC_COMPUTER_BROKER_TOKEN_ENV] = token;
			setBrokerIdentityEnvironment();
			const controller = createComputerBrokerControllerFromEnvironment();
			if (!controller?.brokerInvoke) throw new Error("expected broker invocation");
			expect(await controller.brokerInvoke("wait", [null, 1])).toBe("응답🙂");
			disposeComputerBrokerLease();
			await closeServer(server);
			fs.rmSync(directory, { recursive: true, force: true });
		},
	);

	it.if(process.platform === "darwin")("fails the lease and pending request on an unknown response id", async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-computer-broker-response-id-"));
		const socketPath = path.join(directory, "broker.sock");
		const token = "9".repeat(64);
		const server = net.createServer(socket => {
			const frames = socketFrames(socket);
			void (async () => {
				await frames.next();
				socket.write(`${JSON.stringify({ version: 1, type: "lease_ack", ok: true })}\n`);
				await frames.next();
				socket.write(
					`${JSON.stringify({ version: 1, type: "response", id: "unknown", ok: true, result: null })}\n`,
				);
			})().catch(() => socket.destroy());
		});
		await listen(server, socketPath);
		process.env[GJC_COMPUTER_BROKER_DIR_ENV] = directory;
		process.env[GJC_COMPUTER_BROKER_SOCKET_ENV] = socketPath;
		process.env[GJC_COMPUTER_BROKER_TOKEN_ENV] = token;
		setBrokerIdentityEnvironment();
		const controller = createComputerBrokerControllerFromEnvironment();
		if (!controller?.brokerInvoke) throw new Error("expected broker invocation");
		try {
			await controller.brokerInvoke("wait", [null, 1]);
			throw new Error("expected response-id rejection");
		} catch (error) {
			expect((error as { code?: string }).code).toBe("COMPUTER_BROKER_PROTOCOL");
		}
		disposeComputerBrokerLease();
		await closeServer(server);
		fs.rmSync(directory, { recursive: true, force: true });
	});

	it.if(process.platform === "darwin")("rejects all pending requests when the owner lease is lost", async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-computer-broker-lease-loss-"));
		const socketPath = path.join(directory, "broker.sock");
		const token = "a".repeat(64);
		const server = net.createServer(socket => {
			const frames = socketFrames(socket);
			void (async () => {
				await frames.next();
				socket.write(`${JSON.stringify({ version: 1, type: "lease_ack", ok: true })}\n`);
				await Promise.all([frames.next(), frames.next()]);
				socket.destroy();
			})().catch(() => socket.destroy());
		});
		await listen(server, socketPath);
		process.env[GJC_COMPUTER_BROKER_DIR_ENV] = directory;
		process.env[GJC_COMPUTER_BROKER_SOCKET_ENV] = socketPath;
		process.env[GJC_COMPUTER_BROKER_TOKEN_ENV] = token;
		setBrokerIdentityEnvironment();
		const controller = createComputerBrokerControllerFromEnvironment();
		if (!controller?.brokerInvoke) throw new Error("expected broker invocation");
		const outcomes = await Promise.allSettled([
			controller.brokerInvoke("wait", [null, 1]),
			controller.brokerInvoke("move", [null, 1, 2]),
		]);
		for (const outcome of outcomes) {
			expect(outcome.status).toBe("rejected");
			if (outcome.status === "rejected")
				expect((outcome.reason as { code?: string }).code).toBe("COMPUTER_BROKER_UNAVAILABLE");
		}
		disposeComputerBrokerLease();
		await closeServer(server);
		fs.rmSync(directory, { recursive: true, force: true });
	});

	it.if(process.platform === "darwin")(
		"roundtrips screenshots and input while preserving redacted native errors",
		async () => {
			const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-computer-broker-roundtrip-"));
			const socket = path.join(directory, "broker.sock");
			const token = "d".repeat(64);
			process.env[GJC_COMPUTER_BROKER_DIR_ENV] = directory;
			process.env[GJC_COMPUTER_BROKER_SOCKET_ENV] = socket;
			process.env[GJC_COMPUTER_BROKER_TOKEN_ENV] = token;
			setBrokerIdentityEnvironment();
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
			const queuedAt = Date.now();
			try {
				await controller.brokerInvoke("move", [null, 3, 4], { timeoutMs: 5 });
				throw new Error("expected expired queued request");
			} catch (error) {
				expect((error as { code?: string }).code).toBe("COMPUTER_CANCELLED");
				expect(Date.now() - queuedAt).toBeGreaterThanOrEqual(40);
			}
			await blockingWait;
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

	it.if(process.platform === "darwin")("settles a dispatched action despite later cancellation", async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-computer-broker-abort-"));
		const socket = path.join(directory, "broker.sock");
		const token = "2".repeat(64);
		process.env[GJC_COMPUTER_BROKER_DIR_ENV] = directory;
		process.env[GJC_COMPUTER_BROKER_SOCKET_ENV] = socket;
		process.env[GJC_COMPUTER_BROKER_TOKEN_ENV] = token;
		setBrokerIdentityEnvironment();
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
		await queued;
		await active;
		expect(moveCalls).toBe(1);
		disposeComputerBrokerLease();
		await server;
		expect(fs.existsSync(socket)).toBe(false);
		expect(fs.existsSync(directory)).toBe(false);
	});

	it.if(process.platform === "darwin")(
		"does not complete broker shutdown before an active action settles",
		async () => {
			const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-computer-broker-drain-"));
			const socket = path.join(directory, "broker.sock");
			const token = "3".repeat(64);
			process.env[GJC_COMPUTER_BROKER_DIR_ENV] = directory;
			process.env[GJC_COMPUTER_BROKER_SOCKET_ENV] = socket;
			process.env[GJC_COMPUTER_BROKER_TOKEN_ENV] = token;
			setBrokerIdentityEnvironment();
			const actionStarted = Promise.withResolvers<void>();
			const releaseAction = Promise.withResolvers<void>();
			const server = runComputerBrokerServerFromEnvironment({
				controller: {
					move: async () => {
						actionStarted.resolve();
						await releaseAction.promise;
					},
				},
				startupTimeoutMs: 1_000,
			});
			await waitForSocket(socket);
			const controller = createComputerBrokerControllerFromEnvironment();
			if (!controller?.brokerInvoke) throw new Error("expected broker invocation");
			const invocation = controller.brokerInvoke("move", [null, 1, 2]).then(
				() => null,
				error => error,
			);
			await actionStarted.promise;
			let serverSettled = false;
			const serverCompletion = server.then(() => {
				serverSettled = true;
			});
			disposeComputerBrokerLease();
			await Bun.sleep(10);
			expect(serverSettled).toBe(false);
			releaseAction.resolve();
			const invocationError = await invocation;
			expect((invocationError as { code?: string }).code).toBe("COMPUTER_BROKER_UNAVAILABLE");
			await serverCompletion;
			expect(serverSettled).toBe(true);
			expect(fs.existsSync(socket)).toBe(false);
			expect(fs.existsSync(directory)).toBe(false);
		},
	);

	it("lease initialization is a synchronous no-op without broker configuration", () => {
		for (const key of brokerEnv) delete process.env[key];
		expect(() => initializeComputerBrokerLeaseFromEnvironment()).not.toThrow();
	});
});
