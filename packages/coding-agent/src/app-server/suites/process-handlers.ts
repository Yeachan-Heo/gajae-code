import { isAbsolute } from "node:path";
import { PtySession } from "@gajae-code/natives";
import type { HandlerContext, HandlerResult, MethodHandler } from "./handlers";

type OutputStream = "stdout" | "stderr";
type ProcessRecord = {
	key: string;
	processHandle: string;
	connectionId: string;
	context?: HandlerContext;
	command: string[];
	cwd: string;
	tty: boolean;
	streamStdin: boolean;
	streamOutput: boolean;
	outputBytesCap: number | null;
	child?: Bun.Subprocess<"pipe", "pipe", "pipe">;
	pty?: PtySession;
	stdinClosed: boolean;
	settled: boolean;
	finalizePromise?: Promise<void>;
	resolveDone: () => void;
	done: Promise<void>;
	stdout: OutputState;
	stderr: OutputState;
	timeoutTimer?: ReturnType<typeof setTimeout>;
	hardKillTimer?: ReturnType<typeof setTimeout>;
};

type OutputState = {
	chunks: Uint8Array[];
	capturedBytes: number;
	capReached: boolean;
};

type ProcessParams = Record<string, unknown>;

const processRegistry = new Map<string, ProcessRecord>();
const textDecoder = new TextDecoder();

function isRecord(value: unknown): value is ProcessParams {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function connectionIdOf(context: HandlerContext | undefined): string {
	return context?.connectionId ?? "";
}

function registryKey(processHandle: string, context: HandlerContext | undefined): string {
	return `${connectionIdOf(context)}\u0000${processHandle}`;
}

function ok(): HandlerResult {
	return { ok: true, result: {} };
}

function invalidParams(): HandlerResult {
	return { ok: false, errorKey: "invalidParams" };
}

function emit(record: ProcessRecord, method: string, params: unknown): void {
	try {
		record.context?.emitTo?.(record.connectionId, method, params);
	} catch {
		// A disconnected or failed transport must not prevent process cleanup.
	}
}

function outputState(): OutputState {
	return { chunks: [], capturedBytes: 0, capReached: false };
}

function mergedEnvironment(overrides: unknown): Record<string, string> | undefined {
	if (overrides === undefined || overrides === null) return undefined;
	if (!isRecord(overrides)) return undefined;
	const environment: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (typeof value === "string") environment[key] = value;
	}
	for (const [key, value] of Object.entries(overrides)) {
		if (value === null) delete environment[key];
		else if (typeof value === "string") environment[key] = value;
	}
	return environment;
}

function validEnvironment(value: unknown): boolean {
	if (value === undefined || value === null) return true;
	if (!isRecord(value)) return false;
	return Object.values(value).every(entry => entry === null || typeof entry === "string");
}

function validBase64(value: string): boolean {
	if (value.length === 0) return true;
	if (value.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return false;
	const firstPadding = value.indexOf("=");
	if (firstPadding >= 0 && firstPadding < value.length - (value.endsWith("==") ? 2 : 1)) return false;
	const normalized = value.replace(/=+$/, "");
	return Buffer.from(value, "base64").toString("base64").replace(/=+$/, "") === normalized;
}

function decodeBase64(value: unknown): Uint8Array | HandlerResult {
	if (typeof value !== "string" || !validBase64(value)) return invalidParams();
	return new Uint8Array(Buffer.from(value, "base64"));
}

function validSize(value: unknown): value is { rows: number; cols: number } {
	if (!isRecord(value)) return false;
	return (
		typeof value.rows === "number" &&
		Number.isInteger(value.rows) &&
		value.rows >= 0 &&
		value.rows <= 65535 &&
		typeof value.cols === "number" &&
		Number.isInteger(value.cols) &&
		value.cols >= 0 &&
		value.cols <= 65535
	);
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function ptyCommand(command: string[]): string {
	return `exec ${command.map(shellQuote).join(" ")}`;
}

function outputBytes(record: ProcessRecord, stream: OutputStream): OutputState {
	return stream === "stdout" ? record.stdout : record.stderr;
}

function captureOutput(record: ProcessRecord, stream: OutputStream, chunk: Uint8Array): void {
	if (chunk.byteLength === 0) return;
	const state = outputBytes(record, stream);
	const cap = record.outputBytesCap;
	let accepted = chunk;
	let truncated = false;
	if (cap !== null) {
		const remaining = Math.max(0, cap - state.capturedBytes);
		if (chunk.byteLength > remaining) {
			accepted = chunk.subarray(0, remaining);
			truncated = true;
		}
	}
	if (accepted.byteLength > 0) {
		state.capturedBytes += accepted.byteLength;
		if (!record.streamOutput) state.chunks.push(new Uint8Array(accepted));
	}
	if (truncated) state.capReached = true;
	if (record.streamOutput) {
		if (accepted.byteLength > 0 || truncated) {
			emit(record, "process/outputDelta", {
				processHandle: record.processHandle,
				stream,
				deltaBase64: Buffer.from(accepted).toString("base64"),
				capReached: truncated,
			});
		}
	}
}

function capturedText(state: OutputState): string {
	if (state.chunks.length === 0) return "";
	const bytes = Buffer.concat(state.chunks.map(chunk => Buffer.from(chunk)));
	return textDecoder.decode(bytes);
}

function clearTimers(record: ProcessRecord): void {
	if (record.timeoutTimer !== undefined) clearTimeout(record.timeoutTimer);
	if (record.hardKillTimer !== undefined) clearTimeout(record.hardKillTimer);
	record.timeoutTimer = undefined;
	record.hardKillTimer = undefined;
}

async function finalize(record: ProcessRecord, exitCode: number): Promise<void> {
	if (record.finalizePromise) return record.finalizePromise;
	record.finalizePromise = (async () => {
		clearTimers(record);
		if (processRegistry.get(record.key) === record) processRegistry.delete(record.key);
		record.settled = true;
		emit(record, "process/exited", {
			processHandle: record.processHandle,
			exitCode,
			stdout: record.streamOutput ? "" : capturedText(record.stdout),
			stdoutCapReached: record.stdout.capReached,
			stderr: record.streamOutput ? "" : capturedText(record.stderr),
			stderrCapReached: record.stderr.capReached,
		});
		record.resolveDone();
	})();
	return record.finalizePromise;
}

async function pumpStream(
	record: ProcessRecord,
	stream: OutputStream,
	input: ReadableStream<Uint8Array> | null,
): Promise<void> {
	if (!input) return;
	const reader = input.getReader();
	try {
		while (true) {
			const next = await reader.read();
			if (next.done) break;
			if (next.value) captureOutput(record, stream, next.value);
		}
	} catch {
		// The child may close a stream concurrently with termination.
	} finally {
		reader.releaseLock();
	}
}

function normalizeExitCode(code: unknown, fallback: number): number {
	return typeof code === "number" && Number.isInteger(code) ? code : fallback;
}

function scheduleHardKill(record: ProcessRecord): void {
	if (record.hardKillTimer !== undefined) return;
	record.hardKillTimer = setTimeout(() => {
		if (record.settled) return;
		try {
			if (record.child) record.child.kill("SIGKILL");
			else record.pty?.kill();
		} catch {
			// The exit watcher remains responsible for settling the record.
		}
	}, 500);
}

function scheduleTimeout(record: ProcessRecord, timeoutMs: number | null | undefined): void {
	if (timeoutMs === undefined || timeoutMs === null) return;
	record.timeoutTimer = setTimeout(() => {
		if (record.settled) return;
		try {
			if (record.child) record.child.kill("SIGTERM");
			else record.pty?.kill();
		} catch {
			// The exit watcher remains responsible for settling the record.
		}
		scheduleHardKill(record);
	}, timeoutMs);
}

function newRecord(
	params: ProcessParams,
	context: HandlerContext | undefined,
	streamStdin: boolean,
	streamOutput: boolean,
	outputBytesCap: number | null,
): ProcessRecord {
	let resolveDone!: () => void;
	const done = new Promise<void>(resolve => {
		resolveDone = resolve;
	});
	const processHandle = params.processHandle as string;
	return {
		key: registryKey(processHandle, context),
		processHandle,
		connectionId: connectionIdOf(context),
		context,
		command: params.command as string[],
		cwd: params.cwd as string,
		tty: params.tty === true,
		streamStdin,
		streamOutput,
		outputBytesCap,
		stdinClosed: false,
		settled: false,
		resolveDone,
		done,
		stdout: outputState(),
		stderr: outputState(),
	};
}

function spawnParams(params: unknown):
	| {
			params: ProcessParams;
			command: string[];
			cwd: string;
			processHandle: string;
			tty: boolean;
			streamStdin: boolean;
			streamOutput: boolean;
			outputBytesCap: number | null;
			timeoutMs: number | null | undefined;
			size?: { rows: number; cols: number };
			env?: Record<string, string>;
	  }
	| HandlerResult {
	if (!isRecord(params)) return invalidParams();
	const command = params.command;
	const cwd = params.cwd;
	const processHandle = params.processHandle;
	if (
		!Array.isArray(command) ||
		command.length === 0 ||
		!command.every(value => typeof value === "string") ||
		typeof cwd !== "string" ||
		!isAbsolute(cwd) ||
		typeof processHandle !== "string" ||
		processHandle.length === 0
	)
		return invalidParams();
	const tty = params.tty === true;
	if (params.tty !== undefined && typeof params.tty !== "boolean") return invalidParams();
	if (params.streamStdin !== undefined && typeof params.streamStdin !== "boolean") return invalidParams();
	if (params.streamStdoutStderr !== undefined && typeof params.streamStdoutStderr !== "boolean")
		return invalidParams();
	if (!validEnvironment(params.env)) return invalidParams();
	if (params.outputBytesCap !== undefined && params.outputBytesCap !== null) {
		if (
			typeof params.outputBytesCap !== "number" ||
			!Number.isSafeInteger(params.outputBytesCap) ||
			params.outputBytesCap < 0
		)
			return invalidParams();
	}
	if (params.timeoutMs !== undefined && params.timeoutMs !== null) {
		if (typeof params.timeoutMs !== "number" || !Number.isSafeInteger(params.timeoutMs) || params.timeoutMs < 0)
			return invalidParams();
	}
	if (params.size !== undefined && params.size !== null && !validSize(params.size)) return invalidParams();
	if (!tty && params.size !== undefined && params.size !== null) return invalidParams();
	const env = mergedEnvironment(params.env);
	return {
		params,
		command,
		cwd,
		processHandle,
		tty,
		streamStdin: tty || params.streamStdin === true,
		streamOutput: tty || params.streamStdoutStderr === true,
		outputBytesCap:
			params.outputBytesCap === undefined || params.outputBytesCap === null ? null : params.outputBytesCap,
		timeoutMs: params.timeoutMs as number | null | undefined,
		size: params.size && params.size !== null ? (params.size as { rows: number; cols: number }) : undefined,
		env,
	};
}

export const processSpawnHandler: MethodHandler = async (params, context) => {
	const parsed = spawnParams(params);
	if (!("command" in parsed)) return parsed;
	const { command, cwd, processHandle, tty, streamStdin, streamOutput, outputBytesCap, timeoutMs, size, env } = parsed;
	const key = registryKey(processHandle, context);
	if (processRegistry.has(key)) return { ok: false, errorKey: "conflict" };
	const record = newRecord(parsed.params, context, streamStdin, streamOutput, outputBytesCap);
	try {
		if (tty) {
			const session = new PtySession();
			record.pty = session;
			processRegistry.set(key, record);
			const started = session.start(
				{
					command: ptyCommand(command),
					cwd,
					env,
					cols: size?.cols,
					rows: size?.rows,
					timeoutMs: timeoutMs === null ? undefined : timeoutMs,
				},
				(error, chunk) => {
					if (error || !chunk) return;
					captureOutput(record, "stdout", Buffer.from(chunk));
				},
			);
			void started
				.then(result =>
					finalize(record, normalizeExitCode(result.exitCode, result.cancelled ? 137 : result.timedOut ? 124 : 0)),
				)
				.catch(() => finalize(record, 1));
			scheduleTimeout(record, timeoutMs);
			return ok();
		}
		const child = Bun.spawn(command, {
			cwd,
			env,
			stdin: streamStdin ? "pipe" : "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		record.child = child;
		processRegistry.set(key, record);
		const outputDone = Promise.all([
			pumpStream(record, "stdout", child.stdout),
			pumpStream(record, "stderr", child.stderr),
		]);
		void child.exited
			.then(async exitCode => {
				await outputDone;
				await finalize(record, normalizeExitCode(exitCode, 1));
			})
			.catch(async () => {
				await outputDone;
				await finalize(record, 1);
			});
		scheduleTimeout(record, timeoutMs);
		return ok();
	} catch (error) {
		if (processRegistry.get(key) === record) processRegistry.delete(key);
		const code = (error as { code?: unknown })?.code;
		return { ok: false, errorKey: code === "ENOENT" ? "notFound" : "internalError" };
	}
};

export const processWriteStdinHandler: MethodHandler = (params, context) => {
	if (!isRecord(params) || typeof params.processHandle !== "string" || params.processHandle.length === 0)
		return invalidParams();
	if (params.deltaBase64 !== undefined && params.deltaBase64 !== null && typeof params.deltaBase64 !== "string")
		return invalidParams();
	if (params.closeStdin !== undefined && typeof params.closeStdin !== "boolean") return invalidParams();
	const record = processRegistry.get(registryKey(params.processHandle, context));
	if (!record || record.settled) return { ok: false, errorKey: "notFound" };
	const closeStdin = params.closeStdin === true;
	if (record.stdinClosed) return { ok: false, errorKey: "notSupported" };
	if (!record.streamStdin) return { ok: false, errorKey: "notSupported" };
	if (record.tty && closeStdin) return { ok: false, errorKey: "notSupported" };
	let bytes: Uint8Array | undefined;
	if (params.deltaBase64 !== undefined && params.deltaBase64 !== null) {
		const decoded = decodeBase64(params.deltaBase64);
		if (!decoded || !(decoded instanceof Uint8Array)) return decoded;
		bytes = decoded;
	}
	try {
		if (bytes && bytes.byteLength > 0) {
			if (record.pty) {
				record.pty.write(textDecoder.decode(bytes));
			} else if (record.child?.stdin) {
				record.child.stdin.write(bytes);
				record.child.stdin.flush();
			} else {
				return { ok: false, errorKey: "notFound" };
			}
		}
		if (closeStdin && record.child?.stdin) {
			record.child.stdin.end();
			record.stdinClosed = true;
		}
		return ok();
	} catch {
		return { ok: false, errorKey: "internalError" };
	}
};

export const processResizePtyHandler: MethodHandler = (params, context) => {
	if (!isRecord(params) || typeof params.processHandle !== "string" || params.processHandle.length === 0)
		return invalidParams();
	if (!validSize(params.size)) return invalidParams();
	const record = processRegistry.get(registryKey(params.processHandle, context));
	if (!record || record.settled) return { ok: false, errorKey: "notFound" };
	if (!record.tty || !record.pty) return { ok: false, errorKey: "notSupported" };
	try {
		record.pty.resize(params.size.cols, params.size.rows);
		return ok();
	} catch {
		return { ok: false, errorKey: "internalError" };
	}
};

export const processKillHandler: MethodHandler = (params, context) => {
	if (!isRecord(params) || typeof params.processHandle !== "string" || params.processHandle.length === 0)
		return invalidParams();
	const record = processRegistry.get(registryKey(params.processHandle, context));
	if (!record || record.settled) return { ok: false, errorKey: "notFound" };
	try {
		if (record.child) record.child.kill("SIGTERM");
		else record.pty?.kill();
		scheduleHardKill(record);
		return ok();
	} catch {
		return { ok: false, errorKey: "internalError" };
	}
};

export const processHandlers: Record<string, MethodHandler> = {
	"process/spawn": processSpawnHandler,
	"process/writeStdin": processWriteStdinHandler,
	"process/resizePty": processResizePtyHandler,
	"process/kill": processKillHandler,
};

export function getProcessRegistrySize(): number {
	return processRegistry.size;
}

export async function disposeProcesses(): Promise<void> {
	const records = [...processRegistry.values()];
	for (const record of records) {
		try {
			if (record.child) record.child.kill("SIGKILL");
			else record.pty?.kill();
		} catch {
			// The exit watcher remains responsible for settling the record.
		}
	}
	await Promise.all(records.map(record => record.done));
}
