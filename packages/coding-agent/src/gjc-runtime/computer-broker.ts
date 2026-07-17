import * as childProcess from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { TextDecoder } from "node:util";
import { loadNative } from "@gajae-code/natives/loader-state";
import { isCompiledBinary } from "@gajae-code/utils/env";

export const COMPUTER_BROKER_CLI_FLAG = "--internal-computer-broker";
export const GJC_COMPUTER_BROKER_SOCKET_ENV = "GJC_COMPUTER_BROKER_SOCKET";
export const GJC_COMPUTER_BROKER_TOKEN_ENV = "GJC_COMPUTER_BROKER_TOKEN";
export const GJC_COMPUTER_BROKER_DIR_ENV = "GJC_COMPUTER_BROKER_DIR";
export const GJC_COMPUTER_BROKER_REQUIRED_ENV = "GJC_COMPUTER_BROKER_REQUIRED";

const PROTOCOL_VERSION = 1;
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 48 * 1024 * 1024;
const MAX_PNG_BYTES = 32 * 1024 * 1024;
const MAX_REQUEST_DEADLINE_MS = 65_000;
const STARTUP_TIMEOUT_MS = 5_000;
const LEASE_TIMEOUT_MS = 5_000;
const TERM_TIMEOUT_MS = 1_000;
const KILL_TIMEOUT_MS = 1_000;
const TOKEN_RE = /^[a-f0-9]{64}$/;
export const COMPUTER_BROKER_METHODS = [
	"screenshot",
	"click",
	"doubleClick",
	"move",
	"drag",
	"scroll",
	"type",
	"keypress",
	"wait",
] as const;
export type ComputerBrokerMethod = (typeof COMPUTER_BROKER_METHODS)[number];
export interface ComputerBrokerInvokeOptions {
	timeoutMs?: number;
	signal?: AbortSignal;
}

export type ComputerScreenshot = {
	png?: Uint8Array | Buffer | ArrayBuffer | string;
	widthPx?: number;
	heightPx?: number;
	scaleX?: number;
	scaleY?: number;
	originX?: number;
	originY?: number;
	displayEpoch?: number;
	captureId?: string | number;
};

export type ComputerControllerLike = {
	brokerInvoke?: (
		method: ComputerBrokerMethod,
		args: unknown[],
		options?: ComputerBrokerInvokeOptions,
	) => Promise<unknown>;
	screenshot?: () => ComputerScreenshot | Promise<ComputerScreenshot>;
	click?: (expectedEpoch: number | undefined, x: number, y: number, button?: string) => void | Promise<void>;
	doubleClick?: (expectedEpoch: number | undefined, x: number, y: number, button?: string) => void | Promise<void>;
	move?: (expectedEpoch: number | undefined, x: number, y: number) => void | Promise<void>;
	drag?: (
		expectedEpoch: number | undefined,
		x: number,
		y: number,
		toX: number,
		toY: number,
		button?: string,
	) => void | Promise<void>;
	scroll?: (
		expectedEpoch: number | undefined,
		x: number,
		y: number,
		scrollX: number,
		scrollY: number,
	) => void | Promise<void>;
	type?: (expectedEpoch: number | undefined, text: string) => void | Promise<void>;
	keypress?: (expectedEpoch: number | undefined, keys: string[]) => void | Promise<void>;
	wait?: (expectedEpoch: number | undefined, ms: number) => void | Promise<void>;
};

type ComputerNativeBindings = Record<string, unknown> & {
	ComputerController: new () => ComputerControllerLike;
};

function createNativeComputerController(): ComputerControllerLike {
	const { ComputerController } = loadNative<ComputerNativeBindings>();
	return new ComputerController();
}

export interface ComputerBrokerLaunch {
	environment: Record<string, string>;
	dispose(): void;
}

export interface StartComputerBrokerOptions {
	env?: NodeJS.ProcessEnv;
	cwd?: string;
	startupTimeoutMs?: number;
	isCompiledBinary?: () => boolean;
	spawn?: typeof childProcess.spawn;
}

interface RequestFrame {
	version: 1;
	type: "request";
	token: string;
	id: string;
	method: ComputerBrokerMethod;
	args: unknown[];
	deadlineAtMs: number | null;
}
type LeaseFrame = { version: 1; type: "lease"; token: string };
type LeaseAckFrame = { version: 1; type: "lease_ack"; ok: true };
type ResponseFrame =
	| { version: 1; type: "response"; id: string; ok: true; result: unknown }
	| { version: 1; type: "response"; id: string; ok: false; error: { code: string; message: string } };

class BrokerError extends Error {
	constructor(
		readonly code: string,
		message = "Computer broker request failed.",
	) {
		super(message);
	}
}

/** Bounded newline-delimited UTF-8 framing without decoding arbitrary socket chunks. */
class FrameReader {
	private parts: Buffer[] = [];
	private size = 0;

	constructor(private readonly limit: number) {}

	push(chunk: Buffer): string[] {
		const frames: string[] = [];
		let start = 0;
		for (let index = 0; index < chunk.length; index++) {
			if (chunk[index] !== 0x0a) continue;
			this.append(chunk.subarray(start, index));
			try {
				frames.push(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(this.parts, this.size)));
			} catch {
				throw new BrokerError("COMPUTER_BROKER_PROTOCOL", "Invalid computer broker frame.");
			}
			this.parts = [];
			this.size = 0;
			start = index + 1;
		}
		this.append(chunk.subarray(start));
		return frames;
	}

	private append(part: Buffer): void {
		if (part.length === 0) return;
		this.size += part.length;
		if (this.size > this.limit) throw new BrokerError("COMPUTER_BROKER_PROTOCOL", "Invalid computer broker frame.");
		this.parts.push(part);
	}
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	return Object.keys(value).length === keys.length && keys.every(key => key in value);
}

function record(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function safeMessage(code: string): string {
	return `Computer action failed (${code}).`;
}

function nativeError(error: unknown): BrokerError {
	const candidate = record(error);
	const rawCode = typeof candidate?.code === "string" ? candidate.code : undefined;
	const rawMessage =
		error instanceof Error ? error.message : typeof candidate?.message === "string" ? candidate.message : "";
	const code =
		(rawCode && /^COMPUTER_[A-Z0-9_]+$/.test(rawCode) ? rawCode : undefined) ??
		/^COMPUTER_[A-Z0-9_]+/.exec(rawMessage)?.[0];
	if (code) return new BrokerError(code, safeMessage(code));
	return new BrokerError("COMPUTER_BROKER_FAILURE", "Computer action failed.");
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function isEpoch(value: unknown): value is number | null {
	return value === null || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
}

function isButton(value: unknown): value is string | undefined {
	return value === undefined || value === "left" || value === "right" || value === "middle";
}

function isBoundedString(value: unknown, limit: number, allowControl = false): value is string {
	return typeof value === "string" && value.length <= limit && (allowControl || !/[\u0000-\u001f\u007f]/.test(value));
}

function validArgs(method: ComputerBrokerMethod, args: unknown[]): boolean {
	const epoch = args[0];
	switch (method) {
		case "screenshot":
			return args.length === 0;
		case "click":
		case "doubleClick":
			return (
				args.length >= 3 &&
				args.length <= 4 &&
				isEpoch(epoch) &&
				isFiniteNumber(args[1]) &&
				isFiniteNumber(args[2]) &&
				isButton(args[3])
			);
		case "move":
			return args.length === 3 && isEpoch(epoch) && isFiniteNumber(args[1]) && isFiniteNumber(args[2]);
		case "drag":
			return (
				args.length >= 5 &&
				args.length <= 6 &&
				isEpoch(epoch) &&
				args.slice(1, 5).every(isFiniteNumber) &&
				isButton(args[5])
			);
		case "scroll":
			return args.length === 5 && isEpoch(epoch) && args.slice(1).every(isFiniteNumber);
		case "type":
			return args.length === 2 && isEpoch(epoch) && isBoundedString(args[1], 16 * 1024, true);
		case "keypress":
			return (
				args.length === 2 &&
				isEpoch(epoch) &&
				Array.isArray(args[1]) &&
				args[1].length > 0 &&
				args[1].length <= 16 &&
				args[1].every(key => isBoundedString(key, 128))
			);
		case "wait":
			return (
				args.length === 2 &&
				isEpoch(epoch) &&
				Number.isSafeInteger(args[1]) &&
				(args[1] as number) >= 0 &&
				(args[1] as number) <= 60_000
			);
	}
}

function parseFrame(line: string, limit: number): unknown {
	if (Buffer.byteLength(line) > limit)
		throw new BrokerError("COMPUTER_BROKER_PROTOCOL", "Invalid computer broker frame.");
	try {
		return JSON.parse(line);
	} catch {
		throw new BrokerError("COMPUTER_BROKER_PROTOCOL", "Invalid computer broker frame.");
	}
}

function leaseFrame(value: unknown): LeaseFrame | null {
	const item = record(value);
	return item &&
		exactKeys(item, ["version", "type", "token"]) &&
		item.version === PROTOCOL_VERSION &&
		item.type === "lease" &&
		typeof item.token === "string" &&
		TOKEN_RE.test(item.token)
		? (item as LeaseFrame)
		: null;
}

function requestFrame(value: unknown): RequestFrame | null {
	const item = record(value);
	if (!item || !exactKeys(item, ["version", "type", "token", "id", "method", "args", "deadlineAtMs"])) return null;
	if (
		item.version !== PROTOCOL_VERSION ||
		item.type !== "request" ||
		typeof item.token !== "string" ||
		!TOKEN_RE.test(item.token)
	)
		return null;
	if (
		!isBoundedString(item.id, 128) ||
		!COMPUTER_BROKER_METHODS.includes(item.method as ComputerBrokerMethod) ||
		!Array.isArray(item.args) ||
		!(
			item.deadlineAtMs === null ||
			(typeof item.deadlineAtMs === "number" && Number.isSafeInteger(item.deadlineAtMs) && item.deadlineAtMs > 0)
		)
	)
		return null;
	const method = item.method as ComputerBrokerMethod;
	return validArgs(method, item.args) ? (item as unknown as RequestFrame) : null;
}

function responseFrame(value: unknown): ResponseFrame | null {
	const item = record(value);
	if (
		!item ||
		item.version !== PROTOCOL_VERSION ||
		item.type !== "response" ||
		!isBoundedString(item.id, 128) ||
		typeof item.ok !== "boolean"
	)
		return null;
	if (item.ok === true && exactKeys(item, ["version", "type", "id", "ok", "result"])) return item as ResponseFrame;
	const error = record(item.error);
	if (
		item.ok === false &&
		exactKeys(item, ["version", "type", "id", "ok", "error"]) &&
		error &&
		exactKeys(error, ["code", "message"]) &&
		typeof error.code === "string" &&
		/^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) &&
		isBoundedString(error.message, 512)
	)
		return item as ResponseFrame;
	return null;
}

function leaseAckFrame(value: unknown): LeaseAckFrame | null {
	const item = record(value);
	return item &&
		exactKeys(item, ["version", "type", "ok"]) &&
		item.version === PROTOCOL_VERSION &&
		item.type === "lease_ack" &&
		item.ok === true
		? (item as LeaseAckFrame)
		: null;
}

function writeFrame(socket: net.Socket, frame: ResponseFrame): void {
	const json = JSON.stringify(frame);
	if (Buffer.byteLength(json) > MAX_RESPONSE_BYTES) {
		socket.destroy();
		return;
	}
	socket.write(`${json}\n`);
}

function errorFrame(id: string, error: unknown): ResponseFrame {
	const normalized = error instanceof BrokerError ? error : nativeError(error);
	return {
		version: 1,
		type: "response",
		id,
		ok: false,
		error: { code: normalized.code, message: normalized.message.slice(0, 512) },
	};
}

function screenshotResult(value: ComputerScreenshot): Record<string, unknown> {
	const source = value.png;
	if (!source) throw new BrokerError("COMPUTER_BROKER_FAILURE", "Computer screenshot was unavailable.");
	const png =
		typeof source === "string"
			? Buffer.from(source, "base64")
			: source instanceof ArrayBuffer
				? Buffer.from(source)
				: Buffer.from(source);
	if (typeof source === "string" && png.toString("base64") !== source)
		throw new BrokerError("COMPUTER_BROKER_PROTOCOL", "Computer screenshot was unavailable.");
	if (png.byteLength === 0 || png.byteLength > MAX_PNG_BYTES)
		throw new BrokerError("COMPUTER_BROKER_FRAME_TOO_LARGE", "Computer screenshot was unavailable.");
	const result: Record<string, unknown> = { png: png.toString("base64") };
	for (const key of ["widthPx", "heightPx", "scaleX", "scaleY", "originX", "originY", "displayEpoch"] as const) {
		const field = value[key];
		if (field !== undefined) {
			if (!isFiniteNumber(field))
				throw new BrokerError("COMPUTER_BROKER_PROTOCOL", "Computer screenshot metadata was invalid.");
			result[key] = field;
		}
	}
	if (value.captureId !== undefined) {
		if (
			(typeof value.captureId !== "string" && typeof value.captureId !== "number") ||
			!isBoundedString(String(value.captureId), 512)
		)
			throw new BrokerError("COMPUTER_BROKER_PROTOCOL", "Computer screenshot metadata was invalid.");
		result.captureId = value.captureId;
	}
	return result;
}

async function execute(controller: ComputerControllerLike, frame: RequestFrame): Promise<unknown> {
	const method = controller[frame.method];
	if (typeof method !== "function") throw new BrokerError("COMPUTER_UNAVAILABLE", "Computer action is unavailable.");
	if (frame.method === "screenshot")
		return screenshotResult(
			await (method as () => ComputerScreenshot | Promise<ComputerScreenshot>).call(controller),
		);
	const args = frame.args.map(value => (value === null ? undefined : value));
	await (method as (...values: unknown[]) => unknown).apply(controller, args);
	return null;
}

function validBrokerEnvironment(env: NodeJS.ProcessEnv): { socket: string; token: string; directory: string } | null {
	const socket = env[GJC_COMPUTER_BROKER_SOCKET_ENV];
	const token = env[GJC_COMPUTER_BROKER_TOKEN_ENV];
	const directory = env[GJC_COMPUTER_BROKER_DIR_ENV];
	const required = env[GJC_COMPUTER_BROKER_REQUIRED_ENV];
	if (required !== undefined && required !== "1")
		throw new BrokerError("COMPUTER_BROKER_UNAVAILABLE", "Computer broker configuration is unavailable.");
	if (socket === undefined && token === undefined && directory === undefined) {
		if (required === "1")
			throw new BrokerError("COMPUTER_BROKER_UNAVAILABLE", "Computer broker is required but unavailable.");
		return null;
	}
	if (
		!socket ||
		!token ||
		!directory ||
		!TOKEN_RE.test(token) ||
		path.dirname(socket) !== directory ||
		path.basename(socket) !== "broker.sock"
	)
		throw new BrokerError("COMPUTER_BROKER_UNAVAILABLE", "Computer broker configuration is unavailable.");
	return { socket, token, directory };
}

function secureRuntimeDirectory(config: { socket: string; directory: string }, requireSocket: boolean): void {
	try {
		if (!path.isAbsolute(config.directory) || !path.isAbsolute(config.socket)) throw new Error("not_absolute");
		if (path.resolve(config.directory) !== config.directory || path.dirname(config.socket) !== config.directory)
			throw new Error("not_direct");
		const directory = fs.lstatSync(config.directory);
		if (
			directory.isSymbolicLink() ||
			!directory.isDirectory() ||
			(typeof process.getuid === "function" && directory.uid !== process.getuid()) ||
			(directory.mode & 0o077) !== 0
		)
			throw new Error("unsafe_directory");
		if (!requireSocket) return;
		const socket = fs.lstatSync(config.socket);
		if (
			socket.isSymbolicLink() ||
			!socket.isSocket() ||
			(typeof process.getuid === "function" && socket.uid !== process.getuid())
		)
			throw new Error("unsafe_socket");
	} catch {
		throw new BrokerError("COMPUTER_BROKER_UNAVAILABLE", "Computer broker runtime path is unavailable.");
	}
}

const MAX_PENDING_REQUESTS = 128;
type PendingRequest = {
	resolve(value: unknown): void;
	reject(error: BrokerError): void;
};
let leaseSocket: net.Socket | undefined;
let leaseConfiguration: string | undefined;
let leaseReadyPromise: Promise<void> | undefined;
const pendingRequests = new Map<string, PendingRequest>();

function clearLease(socket: net.Socket, error: BrokerError): void {
	if (leaseSocket !== socket) return;
	leaseSocket = undefined;
	leaseConfiguration = undefined;
	leaseReadyPromise = undefined;
	for (const pending of pendingRequests.values()) pending.reject(error);
	pendingRequests.clear();
}

function ensureComputerBrokerLease(config: { socket: string; token: string }): Promise<void> {
	secureRuntimeDirectory({ socket: config.socket, directory: path.dirname(config.socket) }, true);
	const identity = `${config.socket}\u0000${config.token}`;
	if (leaseSocket && leaseConfiguration === identity && !leaseSocket.destroyed && leaseReadyPromise)
		return leaseReadyPromise;
	if (leaseSocket) {
		clearLease(
			leaseSocket,
			new BrokerError("COMPUTER_BROKER_UNAVAILABLE", "Computer broker connection was replaced."),
		);
		leaseSocket.destroy();
	}
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const socket = net.createConnection(config.socket);
	const reader = new FrameReader(MAX_RESPONSE_BYTES);
	let acknowledged = false;
	let settled = false;
	const fail = (error: BrokerError): void => {
		if (!settled) {
			settled = true;
			clearTimeout(timeout);
			reject(error);
		}
		clearLease(socket, error);
		if (!socket.destroyed) socket.destroy();
	};
	const timeout = setTimeout(
		() => fail(new BrokerError("COMPUTER_BROKER_TIMEOUT", "Computer broker lease timed out.")),
		LEASE_TIMEOUT_MS,
	);
	timeout.unref();
	leaseSocket = socket;
	leaseConfiguration = identity;
	leaseReadyPromise = promise;
	socket.once("connect", () =>
		socket.write(`${JSON.stringify({ version: PROTOCOL_VERSION, type: "lease", token: config.token })}\n`),
	);
	socket.on("data", (chunk: Buffer) => {
		let frames: string[];
		try {
			frames = reader.push(chunk);
		} catch {
			fail(new BrokerError("COMPUTER_BROKER_PROTOCOL", "Invalid computer broker response."));
			return;
		}
		for (const line of frames) {
			try {
				if (!acknowledged) {
					if (Buffer.byteLength(line) > 1024 || !leaseAckFrame(parseFrame(line, 1024)))
						throw new BrokerError("COMPUTER_BROKER_PROTOCOL", "Invalid computer broker lease response.");
					acknowledged = true;
					settled = true;
					clearTimeout(timeout);
					socket.unref();
					resolve();
					continue;
				}
				const frame = responseFrame(parseFrame(line, MAX_RESPONSE_BYTES));
				if (!frame) throw new BrokerError("COMPUTER_BROKER_PROTOCOL", "Invalid computer broker response.");
				const pending = pendingRequests.get(frame.id);
				if (!pending) throw new BrokerError("COMPUTER_BROKER_PROTOCOL", "Invalid computer broker response.");
				pendingRequests.delete(frame.id);
				if (frame.ok) pending.resolve(frame.result);
				else pending.reject(new BrokerError(frame.error.code, frame.error.message));
			} catch (error) {
				fail(
					error instanceof BrokerError
						? error
						: new BrokerError("COMPUTER_BROKER_PROTOCOL", "Invalid computer broker response."),
				);
				return;
			}
		}
	});
	socket.once("error", () =>
		fail(new BrokerError("COMPUTER_BROKER_UNAVAILABLE", "Computer broker connection was lost.")),
	);
	socket.once("close", () => {
		if (!acknowledged) fail(new BrokerError("COMPUTER_BROKER_UNAVAILABLE", "Computer broker connection was lost."));
		else clearLease(socket, new BrokerError("COMPUTER_BROKER_UNAVAILABLE", "Computer broker connection was lost."));
	});
	return promise;
}

/** Starts and retains the persistent ownership lease for this inner GJC process. */
export function initializeComputerBrokerLeaseFromEnvironment(): void {
	const config = validBrokerEnvironment(process.env);
	if (!config) return;
	void ensureComputerBrokerLease(config).catch(() => undefined);
}

function bootstrapAmbientTmuxBroker(env: NodeJS.ProcessEnv): void {
	if (
		process.platform !== "darwin" ||
		process.arch !== "arm64" ||
		!env.TMUX ||
		env[GJC_COMPUTER_BROKER_REQUIRED_ENV] !== undefined ||
		!isCompiledBinary()
	)
		return;
	env[GJC_COMPUTER_BROKER_REQUIRED_ENV] = "1";
	const launch = startComputerBrokerForTmux({ env, cwd: process.cwd() });
	if (launch) Object.assign(env, launch.environment);
}

export async function acquireComputerBrokerLeaseFromEnvironment(): Promise<void> {
	bootstrapAmbientTmuxBroker(process.env);
	const config = validBrokerEnvironment(process.env);
	if (!config) return;
	await ensureComputerBrokerLease(config);
}

export function disposeComputerBrokerLease(): void {
	const socket = leaseSocket;
	if (socket)
		clearLease(socket, new BrokerError("COMPUTER_BROKER_UNAVAILABLE", "Computer broker connection was closed."));
	socket?.destroy();
}

async function request(
	config: { socket: string; token: string },
	method: ComputerBrokerMethod,
	args: unknown[],
	options: ComputerBrokerInvokeOptions = {},
): Promise<unknown> {
	if (options.signal?.aborted) throw new BrokerError("COMPUTER_CANCELLED", "Computer broker request was cancelled.");
	await ensureComputerBrokerLease(config);
	if (options.signal?.aborted) throw new BrokerError("COMPUTER_CANCELLED", "Computer broker request was cancelled.");
	const socket = leaseSocket;
	if (!socket || socket.destroyed || pendingRequests.size >= MAX_PENDING_REQUESTS)
		throw new BrokerError("COMPUTER_BROKER_UNAVAILABLE", "Computer broker connection was lost.");
	let id = crypto.randomBytes(16).toString("hex");
	while (pendingRequests.has(id)) id = crypto.randomBytes(16).toString("hex");
	const requestedTimeoutMs = options.timeoutMs;
	const timeoutMs =
		requestedTimeoutMs === undefined
			? MAX_REQUEST_DEADLINE_MS
			: Math.max(1, Math.min(Math.ceil(requestedTimeoutMs), MAX_REQUEST_DEADLINE_MS));
	const deadlineAtMs = requestedTimeoutMs === undefined ? null : Date.now() + timeoutMs;
	const pending = Promise.withResolvers<unknown>();
	pendingRequests.set(id, pending);
	try {
		socket.write(
			`${JSON.stringify({ version: PROTOCOL_VERSION, type: "request", token: config.token, id, method, args, deadlineAtMs })}\n`,
		);
	} catch {
		pendingRequests.delete(id);
		throw new BrokerError("COMPUTER_BROKER_UNAVAILABLE", "Computer broker connection was lost.");
	}
	return pending.promise;
}

function resultScreenshot(value: unknown): ComputerScreenshot {
	const item = record(value);
	if (
		!item ||
		!exactKeys(item, [
			"png",
			...["widthPx", "heightPx", "scaleX", "scaleY", "originX", "originY", "displayEpoch", "captureId"].filter(
				key => item[key] !== undefined,
			),
		]) ||
		typeof item.png !== "string"
	)
		throw new BrokerError("COMPUTER_BROKER_PROTOCOL", "Invalid computer screenshot response.");
	const png = Buffer.from(item.png, "base64");
	if (png.byteLength === 0 || png.byteLength > MAX_PNG_BYTES || png.toString("base64") !== item.png)
		throw new BrokerError("COMPUTER_BROKER_PROTOCOL", "Invalid computer screenshot response.");
	const screenshot: ComputerScreenshot = { png };
	for (const key of ["widthPx", "heightPx", "scaleX", "scaleY", "originX", "originY", "displayEpoch"] as const) {
		if (item[key] !== undefined) {
			if (!isFiniteNumber(item[key]))
				throw new BrokerError("COMPUTER_BROKER_PROTOCOL", "Invalid computer screenshot response.");
			screenshot[key] = item[key] as never;
		}
	}
	if (item.captureId !== undefined) {
		if (
			(typeof item.captureId !== "string" && typeof item.captureId !== "number") ||
			!isBoundedString(String(item.captureId), 512)
		)
			throw new BrokerError("COMPUTER_BROKER_PROTOCOL", "Invalid computer screenshot response.");
		screenshot.captureId = item.captureId;
	}
	return screenshot;
}

/** Returns null only when no broker environment exists; a partial or required broker environment fails closed. */
export function createComputerBrokerControllerFromEnvironment(): ComputerControllerLike | null {
	const config = validBrokerEnvironment(process.env);
	if (!config) return null;
	const invoke = async (
		method: ComputerBrokerMethod,
		args: unknown[],
		options?: ComputerBrokerInvokeOptions,
	): Promise<unknown> => {
		const result = await request(config, method, args, options);
		return method === "screenshot" ? resultScreenshot(result) : result;
	};
	return {
		brokerInvoke: invoke,
		screenshot: async () => (await invoke("screenshot", [])) as ComputerScreenshot,
		click: async (epoch, x, y, button) =>
			invoke("click", [epoch ?? null, x, y, ...(button === undefined ? [] : [button])]).then(() => {}),
		doubleClick: async (epoch, x, y, button) =>
			invoke("doubleClick", [epoch ?? null, x, y, ...(button === undefined ? [] : [button])]).then(() => {}),
		move: async (epoch, x, y) => invoke("move", [epoch ?? null, x, y]).then(() => {}),
		drag: async (epoch, x, y, toX, toY, button) =>
			invoke("drag", [epoch ?? null, x, y, toX, toY, ...(button === undefined ? [] : [button])]).then(() => {}),
		scroll: async (epoch, x, y, scrollX, scrollY) =>
			invoke("scroll", [epoch ?? null, x, y, scrollX, scrollY]).then(() => {}),
		type: async (epoch, text) => invoke("type", [epoch ?? null, text]).then(() => {}),
		keypress: async (epoch, keys) => invoke("keypress", [epoch ?? null, keys]).then(() => {}),
		wait: async (epoch, ms) => invoke("wait", [epoch ?? null, ms]).then(() => {}),
	};
}

function removeRuntimeDirectory(config: { socket: string; directory: string }): void {
	try {
		if (path.dirname(config.socket) === config.directory && path.basename(config.socket) === "broker.sock")
			fs.unlinkSync(config.socket);
	} catch {}
	try {
		fs.rmdirSync(config.directory);
	} catch {}
}

export interface RunComputerBrokerServerOptions {
	env?: NodeJS.ProcessEnv;
	controller?: ComputerControllerLike;
	startupTimeoutMs?: number;
}

/** Runs the hidden helper. It terminates as soon as its owner lease is closed. */
export async function runComputerBrokerServerFromEnvironment(
	options: RunComputerBrokerServerOptions = {},
): Promise<void> {
	const config = validBrokerEnvironment(options.env ?? process.env);
	if (!config) throw new BrokerError("COMPUTER_BROKER_UNAVAILABLE", "Computer broker configuration is unavailable.");
	secureRuntimeDirectory(config, false);
	const controller = options.controller ?? createNativeComputerController();
	let lease: net.Socket | undefined;
	let actionTail = Promise.resolve();
	const clients = new Set<net.Socket>();
	const done = Promise.withResolvers<void>();
	let closed = false;
	let startupTimer: NodeJS.Timeout | undefined;
	const closeAll = (): void => {
		if (closed) return;
		closed = true;
		if (startupTimer) clearTimeout(startupTimer);
		for (const client of clients) client.destroy();
		void actionTail
			.catch(() => undefined)
			.then(() => {
				server.close(() => removeRuntimeDirectory(config));
				removeRuntimeDirectory(config);
				done.resolve();
			});
	};
	const server = net.createServer(socket => {
		clients.add(socket);
		const reader = new FrameReader(MAX_REQUEST_BYTES);
		let firstFrame = true;
		const respond = (frame: ResponseFrame): void => writeFrame(socket, frame);
		const reject = (code: "COMPUTER_BROKER_AUTH" | "COMPUTER_BROKER_PROTOCOL", closeSocket = false): void => {
			if (!socket.destroyed)
				respond(
					errorFrame(
						"0",
						new BrokerError(
							code,
							code === "COMPUTER_BROKER_AUTH"
								? "Computer broker authentication failed."
								: "Invalid computer broker frame.",
						),
					),
				);
			if (closeSocket && !socket.destroyed) socket.end();
		};
		const enqueue = (request: RequestFrame): void => {
			if (request.deadlineAtMs !== null && request.deadlineAtMs <= Date.now()) {
				respond(
					errorFrame(
						request.id,
						new BrokerError("COMPUTER_CANCELLED", "Computer broker request expired before dispatch."),
					),
				);
				return;
			}
			actionTail = actionTail
				.catch(() => undefined)
				.then(async () => {
					if (socket.destroyed || socket !== lease) return;
					if (request.deadlineAtMs !== null && request.deadlineAtMs <= Date.now()) {
						respond(
							errorFrame(
								request.id,
								new BrokerError("COMPUTER_CANCELLED", "Computer broker request expired before dispatch."),
							),
						);
						return;
					}
					try {
						respond({
							version: PROTOCOL_VERSION,
							type: "response",
							id: request.id,
							ok: true,
							result: await execute(controller, request),
						});
					} catch (error) {
						respond(errorFrame(request.id, error));
					}
				});
		};
		socket.on("data", (chunk: Buffer) => {
			let frames: string[];
			try {
				frames = reader.push(chunk);
			} catch {
				reject(
					firstFrame || socket !== lease ? "COMPUTER_BROKER_AUTH" : "COMPUTER_BROKER_PROTOCOL",
					socket !== lease,
				);
				return;
			}
			for (const line of frames) {
				let parsed: unknown;
				try {
					parsed = parseFrame(line, MAX_REQUEST_BYTES);
				} catch {
					reject(
						firstFrame || socket !== lease ? "COMPUTER_BROKER_AUTH" : "COMPUTER_BROKER_PROTOCOL",
						socket !== lease,
					);
					return;
				}
				if (firstFrame) {
					firstFrame = false;
					const leaseRequest = leaseFrame(parsed);
					if (!leaseRequest || lease || leaseRequest.token !== config.token) {
						reject("COMPUTER_BROKER_AUTH", true);
						return;
					}
					lease = socket;
					if (startupTimer) clearTimeout(startupTimer);
					socket.write(`${JSON.stringify({ version: PROTOCOL_VERSION, type: "lease_ack", ok: true })}\n`);
					continue;
				}
				if (socket !== lease) {
					reject("COMPUTER_BROKER_AUTH", true);
					return;
				}
				const request = requestFrame(parsed);
				if (!request || request.token !== config.token) {
					reject(
						!request || record(parsed)?.token === config.token
							? "COMPUTER_BROKER_PROTOCOL"
							: "COMPUTER_BROKER_AUTH",
					);
					continue;
				}
				enqueue(request);
			}
		});
		socket.once("close", () => {
			clients.delete(socket);
			if (socket === lease) closeAll();
		});
		socket.once("error", () => socket.destroy());
	});
	startupTimer = setTimeout(closeAll, Math.max(1, options.startupTimeoutMs ?? 30_000));
	startupTimer.unref();
	const listening = Promise.withResolvers<void>();
	server.once("error", listening.reject);
	server.listen(config.socket, () => {
		try {
			fs.chmodSync(config.socket, 0o600);
			listening.resolve();
		} catch (error) {
			server.close();
			listening.reject(error);
		}
	});
	await listening.promise;
	server.removeListener("error", listening.reject);
	server.once("error", closeAll);
	await done.promise;
}

function sleepSynchronously(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error instanceof Error && "code" in error && error.code === "EPERM";
	}
}

function terminate(child: childProcess.ChildProcess, config: { socket: string; directory: string }): void {
	const pid = child.pid;
	if (pid !== undefined && processAlive(pid)) {
		try {
			child.kill("SIGTERM");
		} catch {}
		const termDeadline = Date.now() + TERM_TIMEOUT_MS;
		while (processAlive(pid) && Date.now() < termDeadline) sleepSynchronously(10);
		if (processAlive(pid)) {
			try {
				child.kill("SIGKILL");
			} catch {}
			const killDeadline = Date.now() + KILL_TIMEOUT_MS;
			while (processAlive(pid) && Date.now() < killDeadline) sleepSynchronously(10);
		}
		if (processAlive(pid))
			throw new BrokerError("COMPUTER_BROKER_CLEANUP_FAILED", "Computer broker cleanup could not be confirmed.");
	}
	removeRuntimeDirectory(config);
}

function socketReady(config: { socket: string; directory: string }): boolean {
	try {
		secureRuntimeDirectory(config, true);
		return true;
	} catch {
		return false;
	}
}

function brokerSpawnEnvironment(
	env: NodeJS.ProcessEnv,
	config: { socket: string; directory: string },
	token: string,
): NodeJS.ProcessEnv {
	const child: NodeJS.ProcessEnv = {};
	for (const key of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "XDG_CACHE_HOME", "GJC_PACKAGE_DIR"])
		if (env[key] !== undefined) child[key] = env[key];
	child[GJC_COMPUTER_BROKER_SOCKET_ENV] = config.socket;
	child[GJC_COMPUTER_BROKER_TOKEN_ENV] = token;
	child[GJC_COMPUTER_BROKER_DIR_ENV] = config.directory;
	return child;
}

/** Starts the detached packaged helper and waits synchronously until its private socket is ready. */
export function startComputerBrokerForTmux(options: StartComputerBrokerOptions = {}): ComputerBrokerLaunch | null {
	const env = options.env ?? process.env;
	const cwd = options.cwd ?? process.cwd();
	if (!(options.isCompiledBinary ?? isCompiledBinary)()) return null;
	const helper = process.execPath;
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-computer-broker-"));
	const socket = path.join(directory, "broker.sock");
	const token = crypto.randomBytes(32).toString("hex");
	const config = { socket, directory };
	let child: childProcess.ChildProcess | undefined;
	try {
		fs.chmodSync(directory, 0o700);
		const command = helper;
		child = (options.spawn ?? childProcess.spawn)(command, [COMPUTER_BROKER_CLI_FLAG], {
			cwd,
			detached: true,
			stdio: "ignore",
			env: brokerSpawnEnvironment(env, config, token),
		});
		const spawnedChild = child;
		spawnedChild.unref();
		let spawnFailed = false;
		spawnedChild.once("error", () => {
			spawnFailed = true;
		});
		const deadline =
			Date.now() + Math.max(1, Math.min(options.startupTimeoutMs ?? STARTUP_TIMEOUT_MS, STARTUP_TIMEOUT_MS));
		while (!socketReady(config) && Date.now() < deadline) {
			if (spawnFailed || spawnedChild.exitCode !== null) break;
			sleepSynchronously(10);
		}
		if (!socketReady(config)) {
			terminate(spawnedChild, config);
			return null;
		}
		let disposed = false;
		return {
			environment: {
				[GJC_COMPUTER_BROKER_REQUIRED_ENV]: "1",
				[GJC_COMPUTER_BROKER_SOCKET_ENV]: socket,
				[GJC_COMPUTER_BROKER_TOKEN_ENV]: token,
				[GJC_COMPUTER_BROKER_DIR_ENV]: directory,
			},
			dispose: () => {
				if (disposed) return;
				disposed = true;
				terminate(spawnedChild, config);
			},
		};
	} catch {
		if (child) terminate(child, config);
		else removeRuntimeDirectory(config);
		return null;
	}
}
