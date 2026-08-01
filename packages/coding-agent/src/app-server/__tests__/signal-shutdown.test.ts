import { expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import * as path from "node:path";

type JsonObject = Record<string, unknown>;
type ListenerCase =
	| { readonly kind: "websocket"; readonly listen: string; readonly port: number }
	| { readonly kind: "unix"; readonly listen: string; readonly socketPath: string };
type ProcessRecord = { readonly pid: number; readonly ppid: number; readonly command: string; readonly raw: string };
type PsEvidence = {
	readonly raw: string;
	readonly records: readonly ProcessRecord[];
	readonly matches: readonly ProcessRecord[];
};

const repoRoot = path.resolve(import.meta.dir, "../../../../..");
const frameTimeoutMs = 15_000;
const startupTimeoutMs = 15_000;
const shutdownTimeoutMs = 15_000;
const brokerGoneTimeoutMs = 10_000;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([
		promise,
		new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error(message)), timeoutMs);
		}),
	]).finally(() => {
		if (timer !== undefined) clearTimeout(timer);
	});
}

function isRecord(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function encodeClientFrame(payload: Uint8Array, opcode = 1): Buffer {
	if (payload.length > 65_535) throw new Error("signal probe frame is too large");
	const mask = randomBytes(4);
	let header: Buffer;
	if (payload.length < 126) {
		header = Buffer.from([0x80 | opcode, 0x80 | payload.length]);
	} else {
		header = Buffer.from([0x80 | opcode, 0x80 | 126, payload.length >> 8, payload.length & 0xff]);
	}
	const masked = Buffer.allocUnsafe(payload.length);
	for (let index = 0; index < payload.length; index++) masked[index] = payload[index]! ^ mask[index % 4]!;
	return Buffer.concat([header, mask, masked]);
}

class RawWebSocketClient {
	readonly #socket: Socket;
	#buffer = Buffer.alloc(0);
	#handshakeComplete = false;
	#failed = Promise.withResolvers<never>();
	#handshake = Promise.withResolvers<void>();
	#frames: JsonObject[] = [];
	#waiters: Array<{ resolve: (frame: JsonObject) => void; reject: (error: unknown) => void }> = [];

	constructor(socket: Socket) {
		this.#failed.promise.catch(() => {});
		this.#handshake.promise.catch(() => {});
		this.#socket = socket;
		socket.on("data", chunk => this.#onData(Buffer.from(chunk)));
		socket.on("error", error => this.#fail(error));
		socket.on("close", () => this.#fail(new Error("WebSocket socket closed before shutdown probe completed.")));
	}

	async open(mode: ListenerCase, timeoutMs: number): Promise<void> {
		const connected = Promise.withResolvers<void>();
		const onConnect = (): void => connected.resolve();
		this.#socket.once("connect", onConnect);
		await withTimeout(
			Promise.race([connected.promise, this.#failed.promise]),
			timeoutMs,
			"timed out connecting to app-server",
		);
		const host = mode.kind === "websocket" ? `127.0.0.1:${mode.port}` : "localhost";
		const key = randomBytes(16).toString("base64");
		this.#socket.write(
			`GET / HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
		);
		await withTimeout(
			Promise.race([this.#handshake.promise, this.#failed.promise]),
			timeoutMs,
			"timed out waiting for WebSocket handshake",
		);
	}

	async sendJson(frame: JsonObject): Promise<void> {
		if (!this.#handshakeComplete) throw new Error("WebSocket handshake has not completed");
		this.#socket.write(encodeClientFrame(Buffer.from(JSON.stringify(frame), "utf8")));
	}

	async nextJson(timeoutMs = frameTimeoutMs): Promise<JsonObject> {
		const queued = this.#frames.shift();
		if (queued) return queued;
		const pending = Promise.withResolvers<JsonObject>();
		this.#waiters.push(pending);
		return withTimeout(pending.promise, timeoutMs, "timed out waiting for app-server WebSocket frame");
	}

	async response(id: number): Promise<JsonObject> {
		while (true) {
			const frame = await this.nextJson();
			if (frame.id === id) return frame;
		}
	}

	destroy(): void {
		this.#socket.destroy();
	}

	#onData(chunk: Buffer): void {
		this.#buffer = Buffer.concat([this.#buffer, chunk]);
		if (!this.#handshakeComplete) {
			const headerEnd = this.#buffer.indexOf("\r\n\r\n");
			if (headerEnd < 0) return;
			const header = this.#buffer.subarray(0, headerEnd).toString("ascii");
			this.#buffer = this.#buffer.subarray(headerEnd + 4);
			if (!/^HTTP\/1\.1 101\b/.test(header)) {
				this.#fail(new Error(`WebSocket handshake rejected: ${header}`));
				return;
			}
			this.#handshakeComplete = true;
			this.#handshake.resolve();
		}
		this.#drainFrames();
	}

	#drainFrames(): void {
		while (true) {
			const frame = this.#readFrame();
			if (!frame) return;
			if (frame.opcode === 8) {
				this.#fail(new Error("app-server closed the WebSocket before shutdown completed"));
				return;
			}
			if (frame.opcode === 9) {
				this.#socket.write(encodeClientFrame(frame.payload, 10));
				continue;
			}
			if (frame.opcode !== 1 && frame.opcode !== 2) continue;
			let parsed: unknown;
			try {
				parsed = JSON.parse(frame.payload.toString("utf8"));
			} catch (error) {
				this.#fail(new Error(`invalid JSON WebSocket frame: ${String(error)}`));
				return;
			}
			if (!isRecord(parsed)) {
				this.#fail(new Error("app-server WebSocket frame was not a JSON object"));
				return;
			}
			const waiter = this.#waiters.shift();
			if (waiter) waiter.resolve(parsed);
			else this.#frames.push(parsed);
		}
	}

	#readFrame(): { readonly opcode: number; readonly payload: Buffer } | undefined {
		if (this.#buffer.length < 2) return undefined;
		const first = this.#buffer[0]!;
		const second = this.#buffer[1]!;
		const opcode = first & 0x0f;
		const masked = (second & 0x80) !== 0;
		let payloadLength = second & 0x7f;
		let offset = 2;
		if (payloadLength === 126) {
			if (this.#buffer.length < 4) return undefined;
			payloadLength = this.#buffer.readUInt16BE(2);
			offset = 4;
		} else if (payloadLength === 127) {
			if (this.#buffer.length < 10) return undefined;
			const high = this.#buffer.readUInt32BE(2);
			const low = this.#buffer.readUInt32BE(6);
			if (high > 0x1fffff) throw new Error("WebSocket frame exceeds the safe integer range");
			payloadLength = high * 2 ** 32 + low;
			offset = 10;
		}
		const maskOffset = masked ? 4 : 0;
		const frameLength = offset + maskOffset + payloadLength;
		if (this.#buffer.length < frameLength) return undefined;
		let payload = this.#buffer.subarray(offset + maskOffset, frameLength);
		if (masked) {
			const mask = this.#buffer.subarray(offset, offset + 4);
			const unmasked = Buffer.allocUnsafe(payloadLength);
			for (let index = 0; index < payloadLength; index++) unmasked[index] = payload[index]! ^ mask[index % 4]!;
			payload = unmasked;
		}
		this.#buffer = this.#buffer.subarray(frameLength);
		return { opcode, payload };
	}

	#fail(error: unknown): void {
		this.#failed.reject(error);
		this.#handshake.reject(error);
		for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
	}
}

async function reserveTcpPort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve());
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("failed to reserve an ephemeral TCP port");
	const port = address.port;
	await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
	return port;
}

async function connectWebSocket(mode: ListenerCase): Promise<RawWebSocketClient> {
	const deadline = Date.now() + startupTimeoutMs;
	let lastError: unknown;
	while (Date.now() < deadline) {
		const socket =
			mode.kind === "unix"
				? createConnection({ path: mode.socketPath })
				: createConnection({ host: "127.0.0.1", port: mode.port });
		const client = new RawWebSocketClient(socket);
		try {
			await client.open(mode, Math.max(1, deadline - Date.now()));
			return client;
		} catch (error) {
			lastError = error;
			client.destroy();
			await Bun.sleep(20);
		}
	}
	throw new Error(`timed out waiting for ${mode.kind} listener: ${String(lastError)}`);
}

function psEvidence(agentDir: string, pid?: number): PsEvidence {
	const args =
		pid === undefined
			? ["ps", "-axo", "pid=,ppid=,command="]
			: ["ps", "-p", String(pid), "-o", "pid=,ppid=,command="];
	const result = Bun.spawnSync(args);
	const raw = new TextDecoder().decode(result.stdout);
	const records: ProcessRecord[] = [];
	for (const line of raw.split(/\r?\n/)) {
		const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
		if (!match) continue;
		records.push({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3]!, raw: line });
	}
	return {
		raw,
		records,
		matches: records.filter(
			record => record.command.includes("sdk broker-internal") && record.command.includes(agentDir),
		),
	};
}

async function waitForBroker(
	agentDir: string,
): Promise<{ readonly broker: ProcessRecord; readonly evidence: PsEvidence }> {
	const deadline = Date.now() + startupTimeoutMs;
	let evidence = psEvidence(agentDir);
	while (Date.now() < deadline) {
		if (evidence.matches.length === 1) return { broker: evidence.matches[0]!, evidence };
		await Bun.sleep(25);
		evidence = psEvidence(agentDir);
	}
	throw new Error(`timed out waiting for one broker process; ps=${evidence.raw}`);
}

async function waitForBrokerGone(pid: number): Promise<PsEvidence> {
	const deadline = Date.now() + brokerGoneTimeoutMs;
	let evidence = psEvidence("", pid);
	while (evidence.records.length > 0 && Date.now() < deadline) {
		await Bun.sleep(25);
		evidence = psEvidence("", pid);
	}
	return evidence;
}

async function runSignalCase(kind: ListenerCase, signal: "SIGINT" | "SIGTERM"): Promise<void> {
	const tempRoot = mkdtempSync(path.join(tmpdir(), "gjc-app-server-signal-"));
	const agentDir = path.join(tempRoot, "agent");
	mkdirSync(agentDir);
	const provider = path.join(
		repoRoot,
		"packages/coding-agent/src/app-server/__tests__/fixtures/stub-model-provider.ts",
	);
	const child = Bun.spawn(
		[process.execPath, "packages/coding-agent/src/cli.ts", "app-server", "--listen", kind.listen],
		{
			cwd: repoRoot,
			env: {
				...process.env,
				GJC_AGENT_DIR: agentDir,
				GJC_CODING_AGENT_DIR: agentDir,
				PI_CODING_AGENT_DIR: agentDir,
				GJC_TEST_MODEL_PROVIDER: provider,
				GJC_TEST_MODEL_PROVIDER_AUTHORITY: "1",
			},
			stdin: "ignore",
			stdout: "ignore",
			stderr: "pipe",
		},
	);
	const stderr = new Response(child.stderr).text();
	let client: RawWebSocketClient | undefined;
	let broker: ProcessRecord | undefined;
	let before: PsEvidence | undefined;
	try {
		client = await connectWebSocket(kind);
		await client.sendJson({
			id: 1,
			method: "initialize",
			params: { clientInfo: { name: "signal-probe", version: "1.0.0" } },
		});
		const initialized = await client.response(1);
		expect(initialized.error).toBeUndefined();
		await client.sendJson({ jsonrpc: "2.0", method: "initialized" });
		await client.sendJson({
			id: 2,
			method: "thread/start",
			params: {
				cwd: repoRoot,
				model: "gjc-app-server-stub/gjc-app-server-stub-model",
				allowProviderModelFallback: false,
				experimentalRawEvents: false,
			},
		});
		const threadStart = await client.response(2);
		expect(threadStart.error).toBeUndefined();
		const brokerResult = await waitForBroker(agentDir);
		broker = brokerResult.broker;
		before = brokerResult.evidence;
		expect(broker.pid).toBeGreaterThan(0);
		expect(broker.ppid).toBeGreaterThan(0);
		expect(child.exitCode).toBeNull();

		child.kill(signal);
		const exitCode = await withTimeout(
			child.exited,
			shutdownTimeoutMs,
			`${kind.kind}/${signal} listener did not exit`,
		);
		expect(exitCode).toBe(0);
		const after = await waitForBrokerGone(broker.pid);
		const afterAll = psEvidence(agentDir);
		console.log(
			`[signal-probe] ${kind.kind} ${signal} broker=${broker.pid}/${broker.ppid}\n` +
				`ps-before:\n${before.matches.map(record => record.raw).join("\n") || "<empty>"}\n` +
				`ps-after-exact:\n${after.raw.trim() || "<empty>"}\n` +
				`ps-after-agent-dir:\n${afterAll.matches.map(record => record.raw).join("\n") || "<empty>"}`,
		);
		expect(after.records, `${kind.kind}/${signal} left broker pid ${broker.pid} alive`).toEqual([]);
		expect(afterAll.matches, `${kind.kind}/${signal} left an sdk broker for this agent dir`).toEqual([]);
	} finally {
		client?.destroy();
		if (child.exitCode === null) {
			child.kill("SIGKILL");
			await child.exited;
		}
		if (broker) {
			const residual = psEvidence(agentDir, broker.pid).matches;
			if (residual.length > 0) {
				try {
					process.kill(broker.pid, "SIGTERM");
				} catch {
					// The exact broker may have exited between the ps snapshot and cleanup.
				}
				const afterTerm = await waitForBrokerGone(broker.pid);
				if (afterTerm.records.some(record => record.command.includes(agentDir))) {
					try {
						process.kill(broker.pid, "SIGKILL");
					} catch {
						// The exact broker may have exited after the bounded graceful cleanup.
					}
				}
			}
		}
		await stderr;
		rmSync(tempRoot, { recursive: true, force: true });
	}
}

test("real app-server websocket and unix listeners gracefully tear down on OS signals", async () => {
	const port = await reserveTcpPort();
	const tempRoot = mkdtempSync(path.join(tmpdir(), "gjc-app-server-signal-sockets-"));
	const socketPath = path.join(tempRoot, "app-server.sock");
	try {
		for (const signal of ["SIGINT", "SIGTERM"] as const) {
			await runSignalCase({ kind: "websocket", listen: `ws://127.0.0.1:${port}`, port }, signal);
			await runSignalCase({ kind: "unix", listen: `unix://${socketPath}`, socketPath }, signal);
		}
	} finally {
		rmSync(tempRoot, { recursive: true, force: true });
	}
}, 120_000);
