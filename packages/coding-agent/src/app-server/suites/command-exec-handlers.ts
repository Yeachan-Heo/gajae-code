import { PtySession } from "@gajae-code/natives";
import type { HandlerContext, HandlerResult, MethodHandler } from "./handlers";

type Stream = "stdout" | "stderr";
type ExecRecord = {
	id: string;
	connectionId: string;
	context?: HandlerContext;
	child?: Bun.Subprocess<"pipe", "pipe", "pipe">;
	pty?: PtySession;
	stdout: Uint8Array[];
	stderr: Uint8Array[];
	stdoutBytes: number;
	stderrBytes: number;
	cap: number | null;
	stdoutCapReached: boolean;
	stderrCapReached: boolean;
	timedOut: boolean;
	settled: boolean;
	key: string;
	done: Promise<void>;
	resolveDone: () => void;
	timeoutTimer?: ReturnType<typeof setTimeout>;
};

const executions = new Map<string, ExecRecord>();
const decoder = new TextDecoder();

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}
function invalid(): HandlerResult {
	return { ok: false, errorKey: "invalidParams" };
}
function connectionIdOf(context?: HandlerContext): string {
	return context?.connectionId ?? "";
}
function key(id: string, context?: HandlerContext): string {
	return `${connectionIdOf(context)}\u0000${id}`;
}
function validBase64(value: string): boolean {
	if (value.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return false;
	const normalized = value.replace(/=+$/, "");
	return Buffer.from(value, "base64").toString("base64").replace(/=+$/, "") === normalized;
}
function validSize(value: unknown): value is { rows: number; cols: number } {
	const p = record(value);
	return (
		!!p &&
		Number.isSafeInteger(p.rows) &&
		Number.isSafeInteger(p.cols) &&
		(p.rows as number) >= 0 &&
		(p.cols as number) >= 0
	);
}
function emit(exec: ExecRecord, stream: Stream, bytes: Uint8Array, capReached: boolean): void {
	try {
		exec.context?.emitTo?.(exec.connectionId, "command/exec/outputDelta", {
			processId: exec.id,
			stream,
			deltaBase64: Buffer.from(bytes).toString("base64"),
			capReached,
		});
	} catch {
		// Transport failure must not leak the child.
	}
}
function capture(exec: ExecRecord, stream: Stream, bytes: Uint8Array, streamOutput: boolean): void {
	if (bytes.byteLength === 0) return;
	const isStdout = stream === "stdout";
	const used = isStdout ? exec.stdoutBytes : exec.stderrBytes;
	const remaining = exec.cap === null ? bytes.byteLength : Math.max(0, exec.cap - used);
	const accepted = bytes.subarray(0, remaining);
	const truncated = accepted.byteLength < bytes.byteLength;
	if (isStdout) {
		exec.stdoutBytes += accepted.byteLength;
		if (accepted.byteLength) exec.stdout.push(new Uint8Array(accepted));
		exec.stdoutCapReached ||= truncated;
	} else {
		exec.stderrBytes += accepted.byteLength;
		if (accepted.byteLength) exec.stderr.push(new Uint8Array(accepted));
		exec.stderrCapReached ||= truncated;
	}
	if (streamOutput && (accepted.byteLength > 0 || truncated)) emit(exec, stream, accepted, truncated);
}
function finish(exec: ExecRecord): void {
	if (exec.timeoutTimer) clearTimeout(exec.timeoutTimer);
	if (!exec.settled) {
		exec.settled = true;
		executions.delete(exec.key);
		exec.resolveDone();
	}
}
function text(chunks: Uint8Array[]): string {
	return decoder.decode(Buffer.concat(chunks.map(chunk => Buffer.from(chunk))));
}

export const commandExecHandler: MethodHandler = async (params, context): Promise<HandlerResult> => {
	const p = record(params);
	if (
		!p ||
		!Array.isArray(p.command) ||
		p.command.length === 0 ||
		!p.command.every(value => typeof value === "string")
	)
		return invalid();
	if (
		typeof p.tty !== "boolean" ||
		typeof p.streamStdin !== "boolean" ||
		typeof p.streamStdoutStderr !== "boolean" ||
		typeof p.disableOutputCap !== "boolean" ||
		typeof p.disableTimeout !== "boolean"
	)
		return invalid();
	if (p.tty && p.size !== undefined && !validSize(p.size)) return invalid();
	if (!p.tty && p.size !== undefined) return invalid();
	if (
		p.timeoutMs !== undefined &&
		(typeof p.timeoutMs !== "number" || !Number.isSafeInteger(p.timeoutMs) || p.timeoutMs < 0)
	)
		return invalid();
	if (
		p.outputBytesCap !== undefined &&
		(typeof p.outputBytesCap !== "number" || !Number.isSafeInteger(p.outputBytesCap) || p.outputBytesCap < 0)
	)
		return invalid();
	if (
		p.env !== undefined &&
		(typeof p.env !== "object" ||
			p.env === null ||
			Array.isArray(p.env) ||
			!Object.values(p.env as Record<string, unknown>).every(value => value === null || typeof value === "string"))
	)
		return invalid();
	const id = typeof p.processId === "string" && p.processId.length > 0 ? p.processId : crypto.randomUUID();
	const registryKey = key(id, context);
	if (executions.has(registryKey)) return { ok: false, errorKey: "conflict" };
	let resolveDone!: () => void;
	const exec: ExecRecord = {
		id,
		connectionId: connectionIdOf(context),
		context,
		stdout: [],
		stderr: [],
		stdoutBytes: 0,
		stderrBytes: 0,
		cap: p.disableOutputCap ? null : ((p.outputBytesCap as number | undefined) ?? 1024 * 1024),
		stdoutCapReached: false,
		stderrCapReached: false,
		timedOut: false,
		settled: false,
		done: new Promise(resolve => {
			resolveDone = resolve;
		}),
		resolveDone,
		key: registryKey,
	} as ExecRecord & { key: string };
	executions.set(registryKey, exec);
	const env = p.env
		? (Object.fromEntries(
				Object.entries(p.env as Record<string, unknown>).filter(([, value]) => typeof value === "string"),
			) as Record<string, string>)
		: undefined;
	const timeoutMs = p.disableTimeout ? undefined : (p.timeoutMs as number | undefined);
	const streamOutput = p.streamStdoutStderr === true || p.tty === true;
	try {
		if (p.tty) {
			const pty = new PtySession();
			exec.pty = pty;
			const started = pty.start(
				{
					command: `exec ${(p.command as string[]).map(value => `'${value.replaceAll("'", `"'"'`)}'`).join(" ")}`,
					cwd: typeof p.cwd === "string" ? p.cwd : undefined,
					env,
					cols: validSize(p.size) ? p.size.cols : undefined,
					rows: validSize(p.size) ? p.size.rows : undefined,
					timeoutMs,
				},
				(error, chunk) => {
					if (!error && chunk) capture(exec, "stdout", Buffer.from(chunk), streamOutput);
				},
			);
			void started
				.then(result => {
					exec.timedOut ||= result.timedOut;
					finish(exec);
				})
				.catch(() => finish(exec));
		} else {
			exec.child = Bun.spawn(p.command as string[], {
				cwd: typeof p.cwd === "string" ? p.cwd : undefined,
				env: env ? { ...process.env, ...env } : undefined,
				stdin: p.streamStdin ? "pipe" : "ignore",
				stdout: "pipe",
				stderr: "pipe",
			});
			const child = exec.child;
			void Promise.all([
				(async () => {
					for await (const chunk of child.stdout) capture(exec, "stdout", chunk as Uint8Array, streamOutput);
				})(),
				(async () => {
					for await (const chunk of child.stderr) capture(exec, "stderr", chunk as Uint8Array, streamOutput);
				})(),
			])
				.then(async () => {
					await child.exited;
					finish(exec);
				})
				.catch(() => finish(exec));
		}
		if (timeoutMs !== undefined)
			exec.timeoutTimer = setTimeout(() => {
				if (!exec.settled) {
					exec.timedOut = true;
					try {
						exec.child?.kill("SIGTERM");
						exec.pty?.kill();
					} catch {}
				}
			}, timeoutMs);
		await exec.done;
		return {
			ok: true,
			result: {
				exitCode: exec.timedOut ? 124 : (exec.child?.exitCode ?? 0),
				stdout: text(exec.stdout),
				stderr: text(exec.stderr),
			},
		};
	} catch (error) {
		finish(exec);
		return { ok: false, errorKey: (error as { code?: unknown })?.code === "ENOENT" ? "notFound" : "internalError" };
	}
};

export const commandExecWriteHandler: MethodHandler = (params, context): HandlerResult => {
	const p = record(params);
	if (
		!p ||
		typeof p.processId !== "string" ||
		typeof p.closeStdin !== "boolean" ||
		(p.deltaBase64 !== undefined && typeof p.deltaBase64 !== "string")
	)
		return invalid();
	if (typeof p.deltaBase64 === "string" && !validBase64(p.deltaBase64)) return invalid();
	const exec = executions.get(key(p.processId, context));
	if (!exec) return { ok: false, errorKey: "notFound" };
	try {
		if (p.deltaBase64) {
			const bytes = Buffer.from(p.deltaBase64, "base64");
			if (exec.pty) exec.pty.write(decoder.decode(bytes));
			else if (exec.child?.stdin) {
				exec.child.stdin.write(bytes);
				exec.child.stdin.flush();
			}
		}
		if (p.closeStdin && exec.child?.stdin) exec.child.stdin.end();
		return { ok: true, result: {} };
	} catch {
		return { ok: false, errorKey: "internalError" };
	}
};

export const commandExecResizeHandler: MethodHandler = (params, context): HandlerResult => {
	const p = record(params);
	if (!p || typeof p.processId !== "string" || !validSize(p.size)) return invalid();
	const exec = executions.get(key(p.processId, context));
	if (!exec) return { ok: false, errorKey: "notFound" };
	if (!exec.pty) return { ok: false, errorKey: "notSupported" };
	try {
		exec.pty.resize(p.size.cols, p.size.rows);
		return { ok: true, result: {} };
	} catch {
		return { ok: false, errorKey: "internalError" };
	}
};

export const commandExecTerminateHandler: MethodHandler = async (params, context): Promise<HandlerResult> => {
	const p = record(params);
	if (!p || typeof p.processId !== "string") return invalid();
	const exec = executions.get(key(p.processId, context));
	if (!exec) return { ok: false, errorKey: "notFound" };
	try {
		exec.child?.kill("SIGTERM");
		exec.pty?.kill();
		await exec.done;
		return { ok: true, result: {} };
	} catch {
		return { ok: false, errorKey: "internalError" };
	}
};

export const commandExecHandlers: Record<string, MethodHandler> = {
	"command/exec": commandExecHandler,
	"command/exec/write": commandExecWriteHandler,
	"command/exec/resize": commandExecResizeHandler,
	"command/exec/terminate": commandExecTerminateHandler,
};
