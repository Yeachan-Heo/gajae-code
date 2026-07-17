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
export const GJC_COMPUTER_BROKER_PID_ENV = "GJC_COMPUTER_BROKER_PID";
export const GJC_COMPUTER_BROKER_START_ENV = "GJC_COMPUTER_BROKER_START";
export const GJC_COMPUTER_BROKER_EXECUTABLE_ENV = "GJC_COMPUTER_BROKER_EXECUTABLE";
export const GJC_COMPUTER_BROKER_EXECUTABLE_SHA256_ENV = "GJC_COMPUTER_BROKER_EXECUTABLE_SHA256";
export const GJC_COMPUTER_BROKER_PGID_ENV = "GJC_COMPUTER_BROKER_PGID";

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
	unixSocketPeerPid(fd: number): number;
	darwinProcessIdentity(pid: number): { startToken: string; executable: string; pgid: number; parentPid: number };
};

function createNativeComputerController(): ComputerControllerLike {
	const { ComputerController } = loadNative<ComputerNativeBindings>();
	return new ComputerController();
}

export interface ComputerBrokerLaunch {
	environment: Record<string, string>;
	dispose(): void;
}

export type ComputerBrokerProcessIdentity = {
	pid: number;
	start: string;
	executable: string;
	/** SHA-256 of the canonical executable path; bounded and stable across identity checks. */
	executableSha256: string;
	pgid: number;
	/** Kernel parent PID is retained internally to bind the initial read to this spawn. */
	parentPid?: number;
};

type ProcessIdentityReader = (pid: number) => ComputerBrokerProcessIdentity | null;
type ProcessAliveReader = (pid: number) => boolean;

export interface StartComputerBrokerOptions {
	env?: NodeJS.ProcessEnv;
	cwd?: string;
	startupTimeoutMs?: number;
	isCompiledBinary?: () => boolean;
	helperExecutable?: string;
	spawn?: typeof childProcess.spawn;
	readProcessIdentity?: ProcessIdentityReader;
	isProcessAlive?: ProcessAliveReader;
	termTimeoutMs?: number;
	killTimeoutMs?: number;
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

function executablePathSha256(executable: string): string {
	return crypto.createHash("sha256").update(executable, "utf8").digest("hex");
}

function processIdentity(pid: number): ComputerBrokerProcessIdentity | null {
	if (!Number.isSafeInteger(pid) || pid <= 0) return null;
	try {
		const identity = loadNative<ComputerNativeBindings>().darwinProcessIdentity(pid);
		const executable = fs.realpathSync(identity.executable);
		const executableSha256 = executablePathSha256(executable);
		if (
			!/^\d+:\d+$/.test(identity.startToken) ||
			!Number.isSafeInteger(identity.pgid) ||
			identity.pgid <= 0 ||
			!Number.isSafeInteger(identity.parentPid) ||
			identity.parentPid <= 0
		)
			return null;
		return {
			pid,
			start: identity.startToken,
			executable,
			executableSha256,
			pgid: identity.pgid,
			parentPid: identity.parentPid,
		};
	} catch {
		return null;
	}
}

function sameProcessIdentity(
	expected: ComputerBrokerProcessIdentity,
	actual: ComputerBrokerProcessIdentity | null,
): boolean {
	return (
		actual !== null &&
		actual.pid === expected.pid &&
		actual.start === expected.start &&
		actual.executable === expected.executable &&
		actual.executableSha256 === expected.executableSha256 &&
		actual.pgid === expected.pgid &&
		(expected.parentPid === undefined || actual.parentPid === expected.parentPid)
	);
}

function isSpawnedHelperIdentity(
	identity: ComputerBrokerProcessIdentity,
	pid: number,
	helper: string,
	helperSha256: string,
): boolean {
	return (
		identity.pid === pid &&
		identity.executable === helper &&
		identity.executableSha256 === helperSha256 &&
		identity.pgid === pid &&
		identity.parentPid === process.pid
	);
}

function identityEnvironment(identity: ComputerBrokerProcessIdentity): Record<string, string> {
	return {
		[GJC_COMPUTER_BROKER_PID_ENV]: String(identity.pid),
		[GJC_COMPUTER_BROKER_START_ENV]: identity.start,
		[GJC_COMPUTER_BROKER_EXECUTABLE_ENV]: identity.executable,
		[GJC_COMPUTER_BROKER_EXECUTABLE_SHA256_ENV]: identity.executableSha256,
		[GJC_COMPUTER_BROKER_PGID_ENV]: String(identity.pgid),
	};
}

function environmentProcessIdentity(env: NodeJS.ProcessEnv): ComputerBrokerProcessIdentity | null {
	const pid = Number(env[GJC_COMPUTER_BROKER_PID_ENV]);
	const start = env[GJC_COMPUTER_BROKER_START_ENV];
	const executable = env[GJC_COMPUTER_BROKER_EXECUTABLE_ENV];
	const executableSha256 = env[GJC_COMPUTER_BROKER_EXECUTABLE_SHA256_ENV];
	const pgid = Number(env[GJC_COMPUTER_BROKER_PGID_ENV]);
	if (
		!Number.isSafeInteger(pid) ||
		pid <= 0 ||
		!start ||
		!executable ||
		!path.isAbsolute(executable) ||
		!executableSha256 ||
		!/^[a-f0-9]{64}$/.test(executableSha256) ||
		!Number.isSafeInteger(pgid) ||
		pgid <= 0
	)
		return null;
	return { pid, start, executable, executableSha256, pgid };
}

function validBrokerEnvironment(
	env: NodeJS.ProcessEnv,
	requireIdentity = false,
): { socket: string; token: string; directory: string; identity?: ComputerBrokerProcessIdentity } | null {
	const socket = env[GJC_COMPUTER_BROKER_SOCKET_ENV];
	const token = env[GJC_COMPUTER_BROKER_TOKEN_ENV];
	const directory = env[GJC_COMPUTER_BROKER_DIR_ENV];
	const required = env[GJC_COMPUTER_BROKER_REQUIRED_ENV];
	if (required !== undefined && required !== "1")
		throw new BrokerError("COMPUTER_BROKER_UNAVAILABLE", "Computer broker configuration is unavailable.");
	const hasIdentityMetadata = [
		GJC_COMPUTER_BROKER_PID_ENV,
		GJC_COMPUTER_BROKER_START_ENV,
		GJC_COMPUTER_BROKER_EXECUTABLE_ENV,
		GJC_COMPUTER_BROKER_EXECUTABLE_SHA256_ENV,
		GJC_COMPUTER_BROKER_PGID_ENV,
	].some(key => env[key] !== undefined);
	if (socket === undefined && token === undefined && directory === undefined) {
		if (required === "1" || hasIdentityMetadata)
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
	const identity = environmentProcessIdentity(env);
	if (requireIdentity && !identity)
		throw new BrokerError("COMPUTER_BROKER_UNAVAILABLE", "Computer broker configuration is unavailable.");
	return { socket, token, directory, ...(identity ? { identity } : {}) };
}

function requiredBrokerEnvironment(
	env: NodeJS.ProcessEnv,
): { socket: string; token: string; directory: string; identity: ComputerBrokerProcessIdentity } | null {
	const config = validBrokerEnvironment(env, true);
	if (!config) return null;
	if (!config.identity)
		throw new BrokerError("COMPUTER_BROKER_UNAVAILABLE", "Computer broker configuration is unavailable.");
	return { ...config, identity: config.identity };
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
			(directory.mode & 0o777) !== 0o700
		)
			throw new Error("unsafe_directory");
		if (!requireSocket) return;
		const socket = fs.lstatSync(config.socket);
		if (
			socket.isSymbolicLink() ||
			!socket.isSocket() ||
			(typeof process.getuid === "function" && socket.uid !== process.getuid()) ||
			(socket.mode & 0o777) !== 0o600
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

function ensureComputerBrokerLease(config: {
	socket: string;
	token: string;
	identity: ComputerBrokerProcessIdentity;
}): Promise<void> {
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
	socket.once("connect", () => {
		try {
			const fd = (socket as unknown as { _handle?: { fd?: unknown } })._handle?.fd;
			if (typeof fd !== "number" || !Number.isSafeInteger(fd) || fd < 0)
				throw new BrokerError("COMPUTER_BROKER_UNAVAILABLE", "Computer broker connection was unavailable.");
			const peerPid = loadNative<ComputerNativeBindings>().unixSocketPeerPid(fd);
			if (peerPid !== config.identity.pid || !sameProcessIdentity(config.identity, processIdentity(peerPid)))
				throw new BrokerError(
					"COMPUTER_BROKER_UNAVAILABLE",
					"Computer broker connection identity was unavailable.",
				);
			socket.write(`${JSON.stringify({ version: PROTOCOL_VERSION, type: "lease", token: config.token })}\n`);
		} catch (error) {
			fail(
				error instanceof BrokerError
					? error
					: new BrokerError("COMPUTER_BROKER_UNAVAILABLE", "Computer broker connection identity was unavailable."),
			);
		}
	});
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
	const config = requiredBrokerEnvironment(process.env);
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
	const config = requiredBrokerEnvironment(process.env);
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
	config: { socket: string; token: string; identity: ComputerBrokerProcessIdentity },
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
	const config = requiredBrokerEnvironment(process.env);
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

export type ComputerBrokerRuntimeIdentity = {
	directory: { dev: number; ino: number };
	socket?: { dev: number; ino: number };
};
type RuntimePathIdentity = ComputerBrokerRuntimeIdentity;
type QuarantinedRuntimePath = {
	directory: string;
	socket: string;
	identity: RuntimePathIdentity;
};

function pathIdentity(target: string): { dev: number; ino: number } | null {
	try {
		const stat = fs.lstatSync(target);
		return { dev: stat.dev, ino: stat.ino };
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
		throw error;
	}
}

function abandonServerAfterListenFailure(server: net.Server, closeServerForTests: boolean): void {
	if (closeServerForTests) server.close();
	else server.unref();
}

function samePathIdentity(
	expected: { dev: number; ino: number },
	actual: { dev: number; ino: number } | null,
): boolean {
	return actual !== null && actual.dev === expected.dev && actual.ino === expected.ino;
}

function captureRuntimePathIdentity(config: { socket: string; directory: string }): RuntimePathIdentity | null {
	const directory = pathIdentity(config.directory);
	if (!directory) return null;
	const socket = pathIdentity(config.socket);
	return { directory, ...(socket ? { socket } : {}) };
}

function quarantineRuntimeDirectory(
	config: { socket: string; directory: string },
	identity: RuntimePathIdentity,
): QuarantinedRuntimePath | null {
	if (path.dirname(config.socket) !== config.directory || path.basename(config.socket) !== "broker.sock")
		throw new BrokerError("COMPUTER_BROKER_CLEANUP_FAILED", "Computer broker cleanup could not be confirmed.");
	const currentDirectory = pathIdentity(config.directory);
	if (!currentDirectory) return null;
	if (!samePathIdentity(identity.directory, currentDirectory))
		throw new BrokerError("COMPUTER_BROKER_CLEANUP_FAILED", "Computer broker cleanup could not be confirmed.");
	if (identity.socket) {
		const currentSocket = pathIdentity(config.socket);
		if (currentSocket && !samePathIdentity(identity.socket, currentSocket))
			throw new BrokerError("COMPUTER_BROKER_CLEANUP_FAILED", "Computer broker cleanup could not be confirmed.");
	}
	const quarantinedDirectory = `${config.directory}.cleanup-${crypto.randomBytes(16).toString("hex")}`;
	fs.renameSync(config.directory, quarantinedDirectory);
	if (!samePathIdentity(identity.directory, pathIdentity(quarantinedDirectory)))
		throw new BrokerError("COMPUTER_BROKER_CLEANUP_FAILED", "Computer broker cleanup could not be confirmed.");
	const quarantinedSocket = path.join(quarantinedDirectory, "broker.sock");
	if (identity.socket) {
		const movedSocket = pathIdentity(quarantinedSocket);
		if (movedSocket && !samePathIdentity(identity.socket, movedSocket))
			throw new BrokerError("COMPUTER_BROKER_CLEANUP_FAILED", "Computer broker cleanup could not be confirmed.");
	}
	return { directory: quarantinedDirectory, socket: quarantinedSocket, identity };
}

function removeQuarantinedRuntime(runtime: QuarantinedRuntimePath): void {
	if (runtime.identity.socket) {
		const socket = pathIdentity(runtime.socket);
		if (socket && !samePathIdentity(runtime.identity.socket, socket))
			throw new BrokerError("COMPUTER_BROKER_CLEANUP_FAILED", "Computer broker cleanup could not be confirmed.");
		if (socket) fs.unlinkSync(runtime.socket);
	}
	const directory = pathIdentity(runtime.directory);
	if (directory && !samePathIdentity(runtime.identity.directory, directory))
		throw new BrokerError("COMPUTER_BROKER_CLEANUP_FAILED", "Computer broker cleanup could not be confirmed.");
	if (directory) fs.rmdirSync(runtime.directory);
}

function removeRuntimeDirectory(config: { socket: string; directory: string }, identity: RuntimePathIdentity): void {
	const quarantined = quarantineRuntimeDirectory(config, identity);
	if (quarantined) removeQuarantinedRuntime(quarantined);
}

export const computerBrokerTestSeams = {
	captureRuntimePathIdentity,
	removeRuntimeDirectory,
	processIdentity,
	abandonServerAfterListenFailure,
};

export interface RunComputerBrokerServerOptions {
	env?: NodeJS.ProcessEnv;
	controller?: ComputerControllerLike;
	startupTimeoutMs?: number;
	closeServerForTests?: boolean;
}

/** Runs the hidden helper. It terminates as soon as its owner lease is closed. */
export async function runComputerBrokerServerFromEnvironment(
	options: RunComputerBrokerServerOptions = {},
): Promise<void> {
	const config = validBrokerEnvironment(options.env ?? process.env);
	if (!config) throw new BrokerError("COMPUTER_BROKER_UNAVAILABLE", "Computer broker configuration is unavailable.");
	secureRuntimeDirectory(config, false);
	const controller = options.controller ?? createNativeComputerController();
	const closeServerForTests = options.closeServerForTests ?? options.controller !== undefined;
	const initialDirectoryIdentity = pathIdentity(config.directory);
	if (!initialDirectoryIdentity)
		throw new BrokerError("COMPUTER_BROKER_CLEANUP_FAILED", "Computer broker runtime path was unavailable.");
	let lease: net.Socket | undefined;
	let actionTail = Promise.resolve();
	const clients = new Set<net.Socket>();
	const done = Promise.withResolvers<void>();
	let closed = false;
	let startupTimer: NodeJS.Timeout | undefined;
	let runtimeIdentity: RuntimePathIdentity | undefined;
	const closeAll = (): void => {
		if (closed) return;
		closed = true;
		if (startupTimer) clearTimeout(startupTimer);
		for (const client of clients) client.destroy();
		void actionTail
			.catch(() => undefined)
			.then(() => {
				try {
					if (!runtimeIdentity)
						throw new BrokerError(
							"COMPUTER_BROKER_CLEANUP_FAILED",
							"Computer broker cleanup could not be confirmed.",
						);
					const quarantined = quarantineRuntimeDirectory(config, runtimeIdentity);
					if (!closeServerForTests) {
						server.unref();
						if (quarantined) removeQuarantinedRuntime(quarantined);
						done.resolve();
						return;
					}
					server.close(() => {
						try {
							if (quarantined) removeQuarantinedRuntime(quarantined);
							done.resolve();
						} catch (error) {
							done.reject(error);
						}
					});
				} catch (error) {
					server.unref();
					done.reject(error);
				}
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
			const directory = pathIdentity(config.directory);
			const socket = pathIdentity(config.socket);
			if (!samePathIdentity(initialDirectoryIdentity, directory) || !socket)
				throw new BrokerError("COMPUTER_BROKER_CLEANUP_FAILED", "Computer broker runtime path was unavailable.");
			runtimeIdentity = { directory: initialDirectoryIdentity, socket };
			listening.resolve();
		} catch (error) {
			abandonServerAfterListenFailure(server, closeServerForTests);
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

function terminate(
	child: childProcess.ChildProcess,
	config: { socket: string; directory: string },
	identity: ComputerBrokerProcessIdentity | null,
	runtimeIdentity: RuntimePathIdentity,
	readIdentity: ProcessIdentityReader,
	isAlive: ProcessAliveReader,
	termTimeoutMs: number,
	killTimeoutMs: number,
): void {
	const pid = child.pid;
	const identityState = (): "missing" | "match" | "mismatch" => {
		if (pid === undefined || !isAlive(pid)) return "missing";
		return identity && sameProcessIdentity(identity, readIdentity(pid)) ? "match" : "mismatch";
	};
	const requireSignalTarget = (): boolean => {
		const first = identityState();
		if (first === "missing") return false;
		if (first !== "match")
			throw new BrokerError("COMPUTER_BROKER_CLEANUP_FAILED", "Computer broker cleanup could not be confirmed.");
		const immediate = identityState();
		if (immediate === "missing") return false;
		if (immediate !== "match")
			throw new BrokerError("COMPUTER_BROKER_CLEANUP_FAILED", "Computer broker cleanup could not be confirmed.");
		return true;
	};
	const send = (signal: NodeJS.Signals): boolean => {
		if (!requireSignalTarget()) return false;
		try {
			if (!child.kill(signal) && identityState() !== "missing")
				throw new BrokerError("COMPUTER_BROKER_CLEANUP_FAILED", "Computer broker cleanup could not be confirmed.");
		} catch (error) {
			if (identityState() === "missing") return false;
			throw error instanceof BrokerError
				? error
				: new BrokerError("COMPUTER_BROKER_CLEANUP_FAILED", "Computer broker cleanup could not be confirmed.");
		}
		return true;
	};
	const waitForExit = (timeoutMs: number): void => {
		if (pid === undefined) return;
		const deadline = Date.now() + timeoutMs;
		while (isAlive(pid) && Date.now() < deadline) sleepSynchronously(10);
	};

	if (send("SIGTERM")) {
		waitForExit(termTimeoutMs);
		const afterTerm = identityState();
		if (afterTerm === "mismatch")
			throw new BrokerError("COMPUTER_BROKER_CLEANUP_FAILED", "Computer broker cleanup could not be confirmed.");
		if (afterTerm === "match" && send("SIGKILL")) {
			waitForExit(killTimeoutMs);
			if (identityState() !== "missing")
				throw new BrokerError("COMPUTER_BROKER_CLEANUP_FAILED", "Computer broker cleanup could not be confirmed.");
		}
	}
	removeRuntimeDirectory(config, runtimeIdentity);
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
	const helperCandidate = options.helperExecutable ?? process.execPath;
	let helper: string;
	try {
		helper = fs.realpathSync(helperCandidate);
	} catch {
		return null;
	}
	const helperSha256 = executablePathSha256(helper);
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-computer-broker-"));
	const socket = path.join(directory, "broker.sock");
	const token = crypto.randomBytes(32).toString("hex");
	const config = { socket, directory };
	const readIdentity = options.readProcessIdentity ?? processIdentity;
	const isAlive = options.isProcessAlive ?? processAlive;
	const termTimeoutMs = Math.max(1, Math.min(options.termTimeoutMs ?? TERM_TIMEOUT_MS, TERM_TIMEOUT_MS));
	const killTimeoutMs = Math.max(1, Math.min(options.killTimeoutMs ?? KILL_TIMEOUT_MS, KILL_TIMEOUT_MS));
	let runtimeIdentity: RuntimePathIdentity | undefined;
	let child: childProcess.ChildProcess | undefined;
	let childIdentity: ComputerBrokerProcessIdentity | null = null;
	try {
		fs.chmodSync(directory, 0o700);
		const directoryIdentity = pathIdentity(directory);
		if (!directoryIdentity)
			throw new BrokerError("COMPUTER_BROKER_CLEANUP_FAILED", "Computer broker runtime path was unavailable.");
		runtimeIdentity = { directory: directoryIdentity };
		child = (options.spawn ?? childProcess.spawn)(helper, [COMPUTER_BROKER_CLI_FLAG], {
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
		while (!childIdentity && Date.now() < deadline) {
			if (spawnFailed || spawnedChild.exitCode !== null || spawnedChild.pid === undefined) break;
			const observed = readIdentity(spawnedChild.pid);
			if (observed && !isSpawnedHelperIdentity(observed, spawnedChild.pid, helper, helperSha256))
				throw new BrokerError("COMPUTER_BROKER_CLEANUP_FAILED", "Computer broker identity was unavailable.");
			childIdentity = observed;
			if (!childIdentity) sleepSynchronously(10);
		}
		if (!childIdentity)
			throw new BrokerError("COMPUTER_BROKER_CLEANUP_FAILED", "Computer broker identity was unavailable.");
		while (!socketReady(config) && Date.now() < deadline) {
			if (spawnFailed || spawnedChild.exitCode !== null) break;
			sleepSynchronously(10);
		}
		if (!socketReady(config)) {
			terminate(
				spawnedChild,
				config,
				childIdentity,
				runtimeIdentity,
				readIdentity,
				isAlive,
				termTimeoutMs,
				killTimeoutMs,
			);
			return null;
		}
		const socketIdentity = pathIdentity(socket);
		if (!socketIdentity)
			throw new BrokerError("COMPUTER_BROKER_CLEANUP_FAILED", "Computer broker runtime path was unavailable.");
		const readyRuntimeIdentity = { directory: directoryIdentity, socket: socketIdentity };
		runtimeIdentity = readyRuntimeIdentity;
		let disposed = false;
		return {
			environment: {
				[GJC_COMPUTER_BROKER_REQUIRED_ENV]: "1",
				[GJC_COMPUTER_BROKER_SOCKET_ENV]: socket,
				[GJC_COMPUTER_BROKER_TOKEN_ENV]: token,
				[GJC_COMPUTER_BROKER_DIR_ENV]: directory,
				...identityEnvironment(childIdentity),
			},
			dispose: () => {
				if (disposed) return;
				disposed = true;
				terminate(
					spawnedChild,
					config,
					childIdentity,
					readyRuntimeIdentity,
					readIdentity,
					isAlive,
					termTimeoutMs,
					killTimeoutMs,
				);
			},
		};
	} catch (error) {
		let cleanupError: unknown;
		try {
			if (child && runtimeIdentity)
				terminate(
					child,
					config,
					childIdentity,
					runtimeIdentity,
					readIdentity,
					isAlive,
					termTimeoutMs,
					killTimeoutMs,
				);
			else if (runtimeIdentity) removeRuntimeDirectory(config, runtimeIdentity);
		} catch (caught) {
			cleanupError = caught;
		}
		if (cleanupError instanceof BrokerError) throw cleanupError;
		if (error instanceof BrokerError && error.code === "COMPUTER_BROKER_CLEANUP_FAILED") throw error;
		return null;
	}
}
