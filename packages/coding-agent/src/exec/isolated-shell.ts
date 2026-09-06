import * as childProcess from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import type { ShellRunOptions } from "@gajae-code/natives";
import { isCompiledBinary } from "@gajae-code/utils/env";
import {
	BASH_SHELL_WORKER_ARG,
	type BashShellWorkerRequest,
	type BashShellWorkerResponse,
	type IsolatedShellOptions,
	type IsolatedShellRunResult,
} from "./bash-shell-worker-protocol";

const CLOSE_TIMEOUT_MS = 1_000;
const STDERR_LIMIT = 8 * 1024;

type PendingRun = {
	kind: "run";
	resolve: (result: IsolatedShellRunResult) => void;
	reject: (error: Error) => void;
	onChunk?: (error: Error | null, chunk: string) => void;
	removeAbortListener?: () => void;
};

type PendingVoid = {
	kind: "void";
	resolve: () => void;
	reject: (error: Error) => void;
};

type PendingRequest = PendingRun | PendingVoid;

export interface IsolatedShellLifecycle {
	onTerminal?: (shell: IsolatedShell) => void;
	workerArgv?: string[];
}

function workerArgv(): string[] {
	return isCompiledBinary()
		? [process.execPath, BASH_SHELL_WORKER_ARG]
		: [process.execPath, path.join(import.meta.dir, "bash-shell-worker-entry.ts")];
}

function signalExitCode(signal: NodeJS.Signals): number | undefined {
	const number = os.constants.signals[signal];
	return typeof number === "number" ? 128 + number : undefined;
}

function signalFromExitCode(code: number | null): NodeJS.Signals | null {
	if (code === null || code <= 128) return null;
	const signalNumber = code - 128;
	const match = Object.entries(os.constants.signals).find(([, number]) => number === signalNumber);
	return (match?.[0] as NodeJS.Signals | undefined) ?? null;
}

function workerExitError(code: number | null, signal: NodeJS.Signals | null, stderr: string): Error {
	const status = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
	const diagnostic = stderr.trim();
	return new Error(`Isolated shell worker exited with ${status}${diagnostic ? `: ${diagnostic}` : ""}`);
}

export class IsolatedShell {
	#child: childProcess.ChildProcessWithoutNullStreams;
	#ready = Promise.withResolvers<void>();
	#exited = Promise.withResolvers<void>();
	#pending = new Map<number, PendingRequest>();
	#nextId = 1;
	#protocolToken = crypto.randomUUID();
	#supervisorPid: number | undefined;
	#runTail: Promise<void> = Promise.resolve();
	#activeRunSignals = new WeakSet<AbortSignal>();
	#dispatchedRunSignals = new WeakSet<AbortSignal>();
	#abortPromise: Promise<void> | undefined;
	#closed = false;
	#terminalNotified = false;
	#stderr = "";
	#lifecycle: IsolatedShellLifecycle;

	constructor(options?: IsolatedShellOptions, lifecycle: IsolatedShellLifecycle = {}) {
		this.#lifecycle = lifecycle;
		const [command, ...args] = lifecycle.workerArgv ?? workerArgv();
		this.#child = childProcess.spawn(command!, args, {
			cwd: process.cwd(),
			detached: process.platform !== "win32",
			env: process.env,
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		});

		const output = readline.createInterface({ input: this.#child.stdout, crlfDelay: Infinity });
		output.on("line", line => this.#handleLine(line));
		this.#child.stderr.on("data", chunk => {
			this.#stderr = `${this.#stderr}${String(chunk)}`.slice(-STDERR_LIMIT);
		});
		this.#child.once("error", error => {
			this.#terminal(error);
			this.#terminateWorker();
		});
		// `close` fires only after stdout/stderr are drained, so a supervisor's
		// flushed signal result is processed before terminal fallback settlement.
		this.#child.once("close", (code, signal) => {
			this.#exited.resolve();
			this.#handleExit(code, signal);
		});
		this.#send({ type: "init", token: this.#protocolToken, options });
	}

	isTerminal(): boolean {
		return this.#terminalNotified;
	}

	async ready(): Promise<void> {
		await this.#ready.promise;
	}

	supervisorPid(): number | undefined {
		return this.#supervisorPid ?? this.#child.pid;
	}

	isRunSignalActive(signal: AbortSignal): boolean {
		return this.#activeRunSignals.has(signal);
	}

	wasRunSignalDispatched(signal: AbortSignal): boolean {
		return this.#dispatchedRunSignals.has(signal);
	}

	async run(
		options: ShellRunOptions,
		onChunk?: (error: Error | null, chunk: string) => void,
	): Promise<IsolatedShellRunResult> {
		const predecessor = this.#runTail;
		const admission = Promise.withResolvers<void>();
		this.#runTail = admission.promise;
		try {
			await predecessor;
			await this.#ready.promise;
			if (this.#closed) throw new Error("Isolated shell worker is closed.");
			if (options.signal instanceof AbortSignal && options.signal.aborted) {
				return { exitCode: undefined, cancelled: true, timedOut: false };
			}
			if (options.signal instanceof AbortSignal) this.#activeRunSignals.add(options.signal);
			const id = this.#nextId++;
			const deferred = Promise.withResolvers<IsolatedShellRunResult>();
			const pending: PendingRun = { kind: "run", resolve: deferred.resolve, reject: deferred.reject, onChunk };
			if (options.signal instanceof AbortSignal) {
				const signal = options.signal;
				const abort = () => void this.abort().catch(() => undefined);
				signal.addEventListener("abort", abort, { once: true });
				pending.removeAbortListener = () => signal.removeEventListener("abort", abort);
			}
			this.#pending.set(id, pending);
			const { signal: _signal, ...workerOptions } = options;
			if (options.signal instanceof AbortSignal) this.#dispatchedRunSignals.add(options.signal);
			this.#send({ type: "run", token: this.#protocolToken, id, options: workerOptions });
			return await deferred.promise;
		} finally {
			if (options.signal instanceof AbortSignal) this.#activeRunSignals.delete(options.signal);
			admission.resolve();
		}
	}

	async abort(): Promise<void> {
		if (this.#closed) return;
		this.#abortPromise ??= this.#ready.promise
			.then(() => this.#requestVoid("abort"))
			.finally(() => {
				this.#abortPromise = undefined;
			});
		await this.#abortPromise;
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		try {
			const gracefulClose = this.#ready.promise.then(() => this.#requestVoid("close")).catch(() => undefined);
			const graceful = await Promise.race([
				gracefulClose.then(() => true),
				Bun.sleep(CLOSE_TIMEOUT_MS).then(() => false),
			]);
			if (graceful) await Promise.race([this.#exited.promise, Bun.sleep(CLOSE_TIMEOUT_MS)]);
		} finally {
			this.#terminateWorker();
			this.#terminal(new Error("Isolated shell worker closed."));
		}
	}

	async #requestVoid(type: "abort" | "close"): Promise<void> {
		if (this.#child.exitCode !== null || this.#child.signalCode !== null) return;
		const id = this.#nextId++;
		const deferred = Promise.withResolvers<void>();
		this.#pending.set(id, { kind: "void", resolve: deferred.resolve, reject: deferred.reject });
		this.#send({ type, token: this.#protocolToken, id });
		await deferred.promise;
	}

	#send(request: BashShellWorkerRequest): void {
		if (!this.#child.stdin.writable) throw new Error("Isolated shell worker input is closed.");
		this.#child.stdin.write(`${JSON.stringify(request)}\n`);
	}

	#handleLine(line: string): void {
		let response: BashShellWorkerResponse;
		try {
			response = JSON.parse(line) as BashShellWorkerResponse;
		} catch {
			this.#terminal(new Error(`Isolated shell worker emitted invalid protocol output: ${line}`));
			this.#terminateWorker();
			return;
		}
		if (response.token !== this.#protocolToken) {
			this.#terminal(new Error("Isolated shell worker emitted an unauthenticated protocol record."));
			this.#terminateWorker();
			return;
		}
		if (response.type === "ready") {
			this.#supervisorPid = response.supervisorPid;
			this.#ready.resolve();
			return;
		}
		if (response.type === "retiring") {
			this.#terminal(new Error(response.message));
			return;
		}
		if (response.type === "error") {
			if (response.id === undefined) {
				this.#terminal(new Error(response.message));
				this.#terminateWorker();
				return;
			}
			const pending = this.#pending.get(response.id);
			if (!pending) return;
			this.#pending.delete(response.id);
			if (pending.kind === "run") pending.removeAbortListener?.();
			pending.reject(new Error(response.message));
			return;
		}
		if (response.type === "chunk") {
			const pending = this.#pending.get(response.id);
			if (pending?.kind === "run") pending.onChunk?.(null, response.chunk);
			return;
		}
		const pending = this.#pending.get(response.id);
		if (!pending) return;
		this.#pending.delete(response.id);
		if (pending.kind === "run") pending.removeAbortListener?.();
		if (response.type === "result" && pending.kind === "run") {
			if (response.result.signal) {
				this.#closed = true;
				this.#terminal(new Error(`Isolated shell worker retired after ${response.result.signal}.`));
			}
			pending.resolve(response.result);
		} else if (response.type === "void" && pending.kind === "void") {
			pending.resolve();
		} else {
			pending.reject(new Error("Isolated shell worker returned a mismatched response."));
		}
	}

	#handleExit(code: number | null, signal: NodeJS.Signals | null): void {
		this.#closed = true;
		const activeRun = [...this.#pending.entries()].find(([, pending]) => pending.kind === "run");
		const resultSignal = signal ?? (activeRun ? signalFromExitCode(code) : null);
		if (resultSignal && activeRun) {
			const [id, pending] = activeRun;
			this.#pending.delete(id);
			if (pending.kind === "run") {
				pending.removeAbortListener?.();
				pending.resolve({
					exitCode: signalExitCode(resultSignal),
					cancelled: false,
					timedOut: false,
					signal: resultSignal,
				});
			}
		}
		this.#terminal(workerExitError(code, signal, this.#stderr));
	}

	#terminal(error: Error): void {
		if (!this.#terminalNotified) {
			this.#terminalNotified = true;
			this.#lifecycle.onTerminal?.(this);
		}
		this.#failAll(error);
	}

	#failAll(error: Error): void {
		this.#ready.reject(error);
		for (const pending of this.#pending.values()) {
			if (pending.kind === "run") pending.removeAbortListener?.();
			pending.reject(error);
		}
		this.#pending.clear();
	}

	#terminateWorker(): void {
		if (this.#child.exitCode === null && this.#child.signalCode === null) {
			if (process.platform !== "win32" && this.#supervisorPid) {
				try {
					process.kill(-this.#supervisorPid, "SIGKILL");
				} catch {}
			}
			this.#child.kill("SIGKILL");
		}
	}
}

export async function smokeTestIsolatedShell(): Promise<void> {
	if (process.platform === "win32") return;
	const persistent = new IsolatedShell();
	try {
		await persistent.run({ command: "export GJC_SHELL_SMOKE=ok", timeoutMs: 5_000 });
		const result = await persistent.run({ command: 'printf "%s" "$GJC_SHELL_SMOKE"', timeoutMs: 5_000 });
		if (result.exitCode !== 0) throw new Error(`isolated shell smoke exited ${result.exitCode}`);
	} finally {
		await persistent.close();
	}

	const markerId = crypto.randomUUID();
	const pidFile = path.join(os.tmpdir(), `gjc-shell-smoke-${markerId}.pid`);
	const readyFile = path.join(os.tmpdir(), `gjc-shell-smoke-${markerId}.ready`);
	const runtimePidFile = path.join(os.tmpdir(), `gjc-shell-smoke-${markerId}.runtime`);
	const quotedPidFile = `'${pidFile.replaceAll("'", "'\\''")}'`;
	const quotedReadyFile = `'${readyFile.replaceAll("'", "'\\''")}'`;
	const quotedRuntimePidFile = `'${runtimePidFile.replaceAll("'", "'\\''")}'`;
	let descendantPid: number | undefined;
	let runtimePid: number | undefined;
	try {
		const signalled = new IsolatedShell();
		const runPromise = signalled.run({
			command: `echo $$ > ${quotedRuntimePidFile}; /bin/sh -c 'trap "" TERM; echo $$ > "$1"; : > "$2"; sleep 5' sh ${quotedPidFile} ${quotedReadyFile} & while [ ! -s ${quotedReadyFile} ]; do sleep 0.01; done; sleep 5`,
			timeoutMs: 5_000,
		});
		for (let attempt = 0; attempt < 200 && !(await Bun.file(readyFile).exists()); attempt++) await Bun.sleep(25);
		if (!(await Bun.file(readyFile).exists()))
			throw new Error("isolated shell smoke descendant did not become ready");
		descendantPid = Number.parseInt(await Bun.file(pidFile).text(), 10);
		runtimePid = Number.parseInt(await Bun.file(runtimePidFile).text(), 10);
		const supervisorPid = signalled.supervisorPid();
		if (!supervisorPid) throw new Error("isolated shell smoke supervisor has no pid");
		process.kill(supervisorPid, "SIGTERM");
		await Bun.sleep(25);
		process.kill(runtimePid, "SIGKILL");
		const result = await runPromise;
		if (result.exitCode !== 137 || result.signal !== "SIGKILL" || result.cancelled) {
			throw new Error(`isolated shell signal smoke failed: ${JSON.stringify(result)}`);
		}
		let descendantGone = false;
		for (let attempt = 0; attempt < 40; attempt++) {
			try {
				process.kill(descendantPid, 0);
				await Bun.sleep(25);
			} catch {
				descendantGone = true;
				break;
			}
		}
		if (!descendantGone) throw new Error(`isolated shell smoke left descendant ${descendantPid} alive`);
	} finally {
		await Promise.all([
			fs.rm(pidFile, { force: true }),
			fs.rm(readyFile, { force: true }),
			fs.rm(runtimePidFile, { force: true }),
		]);
	}

	const userSignal = new IsolatedShell();
	const userSignalResult = await userSignal.run({ command: "kill -USR1 $$", timeoutMs: 5_000 });
	const expectedUserSignalExit = 128 + os.constants.signals.SIGUSR1;
	if (
		userSignalResult.exitCode !== expectedUserSignalExit ||
		userSignalResult.signal !== "SIGUSR1" ||
		userSignalResult.cancelled
	) {
		throw new Error(`isolated shell SIGUSR1 smoke failed: ${JSON.stringify(userSignalResult)}`);
	}
}
