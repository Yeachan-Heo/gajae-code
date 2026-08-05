/**
 * Process tree management utilities for Bun subprocesses.
 *
 * - Track managed child processes for cleanup on shutdown (postmortem).
 * - Drain stdout/stderr to avoid subprocess pipe deadlocks.
 * - Cross-platform tree kill for process groups (Windows taskkill, Unix -pid).
 * - Convenience helpers: captureText / execText, AbortSignal, timeouts.
 */

import { nativeProcessBindings } from "./native-process";
import type { Spawn, Subprocess } from "bun";

type InMask = "pipe" | "ignore" | Buffer | Uint8Array | null;

/** A Bun subprocess with stdout/stderr always piped (stdin may vary). */
type PipedSubprocess<In extends InMask = InMask> = Subprocess<In, "pipe", "pipe">;

// ── Exceptions ───────────────────────────────────────────────────────────────

/**
 * Base for all exceptions representing child process nonzero exit, killed, or
 * cancellation.
 */
export abstract class Exception extends Error {
	constructor(
		message: string,
		public readonly exitCode: number,
		public readonly stderr: string,
	) {
		super(message);
		this.name = this.constructor.name;
	}
	abstract readonly aborted: boolean;
}

/** Exception for nonzero exit codes (not cancellation). */
export class NonZeroExitError extends Exception {
	static readonly MAX_TRACE = 32 * 1024;

	constructor(exitCode: number, stderr: string) {
		super(`Process exited with code ${exitCode}:\n${stderr}`, exitCode, stderr);
	}
	get aborted() {
		return false;
	}
}

/** Exception for explicit process abortion (via signal). */
export class AbortError extends Exception {
	constructor(
		public readonly reason: unknown,
		stderr: string,
	) {
		const msg = reason instanceof Error ? reason.message : String(reason ?? "aborted");
		super(`Operation cancelled: ${msg}`, -1, stderr);
	}
	get aborted() {
		return true;
	}
}

/** Exception for process timeout. */
export class TimeoutError extends AbortError {
	constructor(timeout: number, stderr: string) {
		super(new Error(`Timed out after ${Math.round(timeout / 1000)}s`), stderr);
	}
}

// ── Wait / Exec types ────────────────────────────────────────────────────────

/** Options for waiting for process exit and capturing output. */
export interface WaitOptions {
	allowNonZero?: boolean;
	allowAbort?: boolean;
	stderr?: "full" | "buffer";
}

/** Result from wait and exec. */
export interface ExecResult {
	stdout: string;
	stderr: string;
	exitCode: number | null;
	ok: boolean;
	exitError?: Exception;
}

// ── ChildProcess ─────────────────────────────────────────────────────────────

/**
 * ChildProcess wraps a managed subprocess, capturing stderr tail, providing
 * cross-platform kill/detach logic plus AbortSignal integration.
 *
 * Stdout is exposed directly from the underlying Bun subprocess; consumers
 * must read it (via text(), wait(), etc.) to prevent pipe deadlock.
 * Stderr is eagerly drained into an internal buffer.
 */
export class ChildProcess<In extends InMask = InMask> {
	#nothrow = false;
	#stderrTail = "";
	#stderrChunks: Uint8Array[] = [];
	#exitReason?: Exception;
	#exitReasonPending?: Exception;
	#stderrDone: Promise<void>;
	#exited: Promise<number>;
	#stderrStream?: ReadableStream<Uint8Array>;

	constructor(
		readonly proc: PipedSubprocess<In>,
		readonly exposeStderr: boolean,
	) {
		// Eagerly drain stderr into a truncated tail string + raw chunks.
		const dec = new TextDecoder();
		const trim = () => {
			if (this.#stderrTail.length > NonZeroExitError.MAX_TRACE)
				this.#stderrTail = this.#stderrTail.slice(-NonZeroExitError.MAX_TRACE);
		};
		let stderrStream = proc.stderr;
		if (exposeStderr) {
			const [teeStream, drainStream] = stderrStream.tee();
			this.#stderrStream = teeStream;
			stderrStream = drainStream;
		}
		this.#stderrDone = (async () => {
			try {
				for await (const chunk of stderrStream) {
					this.#stderrChunks.push(chunk);
					this.#stderrTail += dec.decode(chunk, { stream: true });
					trim();
				}
			} catch {}
			this.#stderrTail += dec.decode();
			trim();
		})();

		// Normalize Bun's exited promise into our exitReason / exitedCleanly model.
		const { promise, resolve, reject } = Promise.withResolvers<number>();
		this.#exited = promise;

		proc.exited
			.catch(() => null)
			.then(async exitCode => {
				if (this.#exitReasonPending) {
					this.#exitReason = this.#exitReasonPending;
					reject(this.#exitReasonPending);
					return;
				}
				if (exitCode === 0) {
					resolve(0);
					return;
				}

				await this.#stderrDone;

				if (exitCode !== null) {
					this.#exitReason = new NonZeroExitError(exitCode, this.#stderrTail);
					resolve(exitCode);
					return;
				}

				const ex = this.proc.killed
					? new AbortError(new Error("process killed"), this.#stderrTail)
					: new NonZeroExitError(-1, this.#stderrTail);
				this.#exitReason = ex;
				reject(ex);
			});
	}

	// ── Properties ───────────────────────────────────────────────────────

	get pid() {
		return this.proc.pid;
	}
	get exited() {
		return this.#exited;
	}
	get exitCode() {
		return this.proc.exitCode;
	}
	get exitReason() {
		return this.#exitReason;
	}
	get killed() {
		return this.proc.killed;
	}
	get stdin(): Bun.SpawnOptions.WritableToIO<In> {
		return this.proc.stdin;
	}

	/** Raw stdout stream. Must be consumed to prevent pipe deadlock. */
	get stdout() {
		return this.proc.stdout;
	}

	/** Optional stderr stream (only when requested in spawn options). */
	get stderr() {
		return this.#stderrStream;
	}

	get exitedCleanly(): Promise<number> {
		if (this.#nothrow) return this.#exited;
		return this.#exited.then(code => {
			if (code !== 0) throw new NonZeroExitError(code, this.#stderrTail);
			return code;
		});
	}

	/** Returns the truncated stderr tail (last 32KB). */
	peekStderr() {
		return this.#stderrTail;
	}

	nothrow(): this {
		this.#nothrow = true;
		return this;
	}

	kill(reason?: Exception) {
		if (reason && !this.#exitReasonPending) this.#exitReasonPending = reason;
		if (!this.proc.killed)
			void nativeProcessBindings()
				.Process.fromPid(this.proc.pid)
				?.terminate()
				?.catch(e => void e);
	}

	// ── Output helpers ───────────────────────────────────────────────────

	async text(): Promise<string> {
		const p = new Response(this.stdout).text();
		if (this.#nothrow) return p;
		const [text] = await Promise.all([p, this.exitedCleanly]);
		return text;
	}

	async blob(): Promise<Blob> {
		const p = new Response(this.stdout).blob();
		if (this.#nothrow) return p;
		const [blob] = await Promise.all([p, this.exitedCleanly]);
		return blob;
	}

	async json(): Promise<unknown> {
		return new Response(this.stdout).json();
	}

	async arrayBuffer(): Promise<ArrayBuffer> {
		return new Response(this.stdout).arrayBuffer();
	}

	async bytes(): Promise<Uint8Array> {
		return new Response(this.stdout).bytes();
	}

	// ── Wait ─────────────────────────────────────────────────────────────

	async wait(opts?: WaitOptions): Promise<ExecResult> {
		const { allowNonZero = false, allowAbort = false, stderr: stderrMode = "buffer" } = opts ?? {};

		const stdoutP = new Response(this.stdout).text();
		const stderrP =
			stderrMode === "full"
				? this.#stderrDone.then(() => new TextDecoder().decode(Buffer.concat(this.#stderrChunks)))
				: this.#stderrDone.then(() => this.#stderrTail);

		const [stdout, stderr] = await Promise.all([stdoutP, stderrP]);

		let exitError: Exception | undefined;
		try {
			await this.#exited;
		} catch (err) {
			if (err instanceof Exception) exitError = err;
			else throw err;
		}

		if (!exitError) exitError = this.exitReason;
		if (!exitError && this.exitCode !== null && this.exitCode !== 0) {
			exitError = new NonZeroExitError(this.exitCode, this.#stderrTail);
		}

		const exitCode = this.exitCode ?? (exitError && !exitError.aborted ? exitError.exitCode : null);
		const ok = exitCode === 0;

		if (exitError) {
			if ((exitError.aborted && !allowAbort) || (!exitError.aborted && !allowNonZero)) throw exitError;
		}

		return { stdout, stderr, exitCode, ok, exitError };
	}

	// ── Signal / timeout ─────────────────────────────────────────────────

	attachSignal(signal: AbortSignal): void {
		const onAbort = () => this.kill(new AbortError(signal.reason, "<cancelled>"));
		if (signal.aborted) return void onAbort();
		signal.addEventListener("abort", onAbort, { once: true });
		this.#exited.catch(() => {}).finally(() => signal.removeEventListener("abort", onAbort));
	}

	attachTimeout(ms: number): void {
		if (ms <= 0 || this.proc.killed) return;
		Promise.race([
			Bun.sleep(ms).then(() => true),
			this.proc.exited.then(
				() => false,
				() => false,
			),
		]).then(timedOut => {
			if (timedOut) this.kill(new TimeoutError(ms, this.#stderrTail));
		});
	}

	[Symbol.dispose](): void {
		if (this.proc.exitCode !== null) return;
		this.kill(new AbortError("process disposed", this.#stderrTail));
	}
}

// ── Spawn / exec ─────────────────────────────────────────────────────────────

/** Options for child spawn. Always pipes stdout/stderr. */
type ChildSpawnOptions<In extends InMask = InMask> = Omit<
	Spawn.SpawnOptions<In, "pipe", "pipe">,
	"stdout" | "stderr" | "detached"
> & {
	signal?: AbortSignal;
	detached?: boolean;
	stderr?: "full" | null;
};

/** Spawn a child process with piped stdout/stderr. */
export function spawn<In extends InMask = InMask>(cmd: string[], opts?: ChildSpawnOptions<In>): ChildProcess<In> {
	const { timeout = -1, signal, stderr, ...rest } = opts ?? {};
	const child = Bun.spawn(cmd, {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		windowsHide: true,
		...rest,
	});
	const cp = new ChildProcess(child, stderr === "full");
	if (signal) cp.attachSignal(signal);
	if (timeout > 0) cp.attachTimeout(timeout);
	return cp;
}

/** Options for exec. */
export interface ExecOptions extends Omit<ChildSpawnOptions, "stderr" | "stdin">, WaitOptions {
	input?: string | Buffer | Uint8Array;
}

/** Spawn, wait, and return captured output. */
export async function exec(cmd: string[], opts?: ExecOptions): Promise<ExecResult> {
	const { input, stderr, allowAbort, allowNonZero, ...spawnOpts } = opts ?? {};
	const stdin = typeof input === "string" ? Buffer.from(input) : input;
	const resolved: ChildSpawnOptions = stdin === undefined ? spawnOpts : { ...spawnOpts, stdin };
	using child = spawn(cmd, resolved);
	return await child.wait({ stderr, allowAbort, allowNonZero });
}

// ── Signal combinators ───────────────────────────────────────────────────────

type SignalValue = AbortSignal | number | null | undefined;

/** Combine AbortSignals and timeout values into a single signal. */
export function combineSignals(...signals: SignalValue[]): AbortSignal | undefined {
	let timeout: number | undefined;

	let n = 0;
	for (let i = 0; i < signals.length; i++) {
		const s = signals[i];
		if (s instanceof AbortSignal) {
			if (s.aborted) return s;
			if (i !== n) signals[n] = s;
			n++;
		} else if (typeof s === "number" && s > 0) {
			timeout = timeout === undefined ? s : Math.min(timeout, s);
		}
	}
	if (timeout !== undefined) {
		signals[n] = AbortSignal.timeout(timeout);
		n++;
	}
	switch (n) {
		case 0:
			return undefined;
		case 1:
			return signals[0] as AbortSignal;
		default:
			return AbortSignal.any(signals.slice(0, n) as AbortSignal[]);
	}
}
