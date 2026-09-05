import * as childProcess from "node:child_process";
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

function workerArgv(): string[] {
	return isCompiledBinary()
		? [process.execPath, BASH_SHELL_WORKER_ARG]
		: [process.execPath, path.join(import.meta.dir, "bash-shell-worker-entry.ts")];
}

function signalExitCode(signal: NodeJS.Signals): number | undefined {
	const number = os.constants.signals[signal];
	return typeof number === "number" ? 128 + number : undefined;
}

function workerExitError(code: number | null, signal: NodeJS.Signals | null, stderr: string): Error {
	const status = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
	const diagnostic = stderr.trim();
	return new Error(`Isolated shell worker exited with ${status}${diagnostic ? `: ${diagnostic}` : ""}`);
}

export class IsolatedShell {
	#child: childProcess.ChildProcessWithoutNullStreams;
	#ready = Promise.withResolvers<void>();
	#pending = new Map<number, PendingRequest>();
	#nextId = 1;
	#closed = false;
	#stderr = "";

	constructor(options?: IsolatedShellOptions) {
		const [command, ...args] = workerArgv();
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
		this.#child.once("error", error => this.#failAll(error));
		this.#child.once("exit", (code, signal) => this.#handleExit(code, signal));
		this.#send({ type: "init", options });
	}

	async run(
		options: ShellRunOptions,
		onChunk?: (error: Error | null, chunk: string) => void,
	): Promise<IsolatedShellRunResult> {
		await this.#ready.promise;
		if (this.#closed) throw new Error("Isolated shell worker is closed.");
		const id = this.#nextId++;
		const deferred = Promise.withResolvers<IsolatedShellRunResult>();
		const pending: PendingRun = { kind: "run", resolve: deferred.resolve, reject: deferred.reject, onChunk };
		if (options.signal instanceof AbortSignal) {
			const signal = options.signal;
			const abort = () => void this.abort();
			signal.addEventListener("abort", abort, { once: true });
			pending.removeAbortListener = () => signal.removeEventListener("abort", abort);
		}
		this.#pending.set(id, pending);
		const { signal: _signal, ...workerOptions } = options;
		this.#send({ type: "run", id, options: workerOptions });
		return await deferred.promise;
	}

	async abort(): Promise<void> {
		if (this.#closed) return;
		await this.#ready.promise;
		await this.#requestVoid("abort");
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		try {
			await this.#ready.promise;
			await Promise.race([this.#requestVoid("close"), Bun.sleep(CLOSE_TIMEOUT_MS)]);
		} finally {
			this.#terminateWorker();
		}
	}

	async #requestVoid(type: "abort" | "close"): Promise<void> {
		if (this.#child.exitCode !== null || this.#child.signalCode !== null) return;
		const id = this.#nextId++;
		const deferred = Promise.withResolvers<void>();
		this.#pending.set(id, { kind: "void", resolve: deferred.resolve, reject: deferred.reject });
		this.#send({ type, id });
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
			this.#failAll(new Error(`Isolated shell worker emitted invalid protocol output: ${line}`));
			return;
		}
		if (response.type === "ready") {
			this.#ready.resolve();
			return;
		}
		if (response.type === "error") {
			if (response.id === undefined) {
				this.#failAll(new Error(response.message));
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
			pending.resolve(response.result);
		} else if (response.type === "void" && pending.kind === "void") {
			pending.resolve();
		} else {
			pending.reject(new Error("Isolated shell worker returned a mismatched response."));
		}
	}

	#handleExit(code: number | null, signal: NodeJS.Signals | null): void {
		this.#closed = true;
		if (signal) {
			const activeRun = [...this.#pending.entries()].find(([, pending]) => pending.kind === "run");
			if (activeRun) {
				const [id, pending] = activeRun;
				this.#pending.delete(id);
				if (pending.kind === "run") {
					pending.removeAbortListener?.();
					pending.resolve({
						exitCode: signalExitCode(signal),
						cancelled: false,
						timedOut: false,
						signal,
					});
				}
			}
		}
		this.#failAll(workerExitError(code, signal, this.#stderr));
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
		if (this.#child.exitCode !== null || this.#child.signalCode !== null) return;
		if (process.platform !== "win32" && this.#child.pid) {
			try {
				process.kill(-this.#child.pid, "SIGKILL");
				return;
			} catch {
				// Fall back to terminating the worker itself if its process group is already gone.
			}
		}
		this.#child.kill("SIGKILL");
	}
}
