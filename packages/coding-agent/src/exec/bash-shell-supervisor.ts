import { dlopen, FFIType, ptr } from "bun:ffi";
import * as childProcess from "node:child_process";
import { createHmac } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import type { Process as NativeProcess } from "@gajae-code/natives";
import { isCompiledBinary } from "@gajae-code/utils/env";
import { parseLinuxProcParentPid, parseLinuxProcStartTime, parseLinuxProcState } from "../gjc-runtime/linux-proc";
import { processIncarnation } from "../sdk/broker/process-incarnation";
import { fatalCatchableSignals, signalExitCode } from "./bash-shell-signals";
import {
	BASH_SHELL_RUNTIME_ARG,
	type BashShellWorkerRequest,
	type BashShellWorkerResponse,
} from "./bash-shell-worker-protocol";

type NativeProcessBindings = { Process: typeof NativeProcess };

function darwinUniqueProcessId(pid: number, incarnation: string): string | undefined {
	if (process.platform !== "darwin") return undefined;
	try {
		const proc = dlopen("/usr/lib/libproc.dylib", {
			proc_pidinfo: {
				args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32],
				returns: FFIType.i32,
			},
		});
		const info = new Uint8Array(56);
		const read = proc.symbols.proc_pidinfo(pid, 17, 0, ptr(info), info.byteLength);
		proc.close();
		if (read !== info.byteLength || processIncarnation(pid) !== incarnation) return undefined;
		return new DataView(info.buffer).getBigUint64(16, true).toString();
	} catch {
		return undefined;
	}
}

function runtimeArgv(): string[] {
	return isCompiledBinary()
		? [process.execPath, BASH_SHELL_RUNTIME_ARG]
		: [process.execPath, path.join(import.meta.dir, "bash-shell-runtime-entry.ts")];
}

function enableLinuxChildSubreaper(): void {
	if (process.platform !== "linux") return;
	try {
		const libc = dlopen("libc.so.6", {
			prctl: {
				args: [FFIType.i32, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64],
				returns: FFIType.i32,
			},
		});
		libc.symbols.prctl(36, 1, 0, 0, 0);
		libc.close();
	} catch {}
}

async function reapLinuxSubreaperChildren(): Promise<void> {
	if (process.platform !== "linux") return;
	for (let wave = 0; wave < 3; wave++) {
		await Bun.sleep(wave === 0 ? 5 : 25);
		let entries: string[];
		try {
			entries = await fs.readdir("/proc");
		} catch {
			return;
		}
		for (const entry of entries) {
			if (!/^\d+$/.test(entry)) continue;
			const pid = Number.parseInt(entry, 10);
			let stat: string;
			try {
				stat = await Bun.file(`/proc/${pid}/stat`).text();
			} catch {
				continue;
			}
			if (parseLinuxProcParentPid(stat) !== process.pid) continue;
			const startTime = parseLinuxProcStartTime(stat);
			if (!startTime) continue;
			try {
				const current = await Bun.file(`/proc/${pid}/stat`).text();
				if (parseLinuxProcStartTime(current) !== startTime || parseLinuxProcParentPid(current) !== process.pid)
					continue;
				const { Process } = require("@gajae-code/natives") as NativeProcessBindings;
				const owned = Process.fromPid(pid);
				if (owned?.incarnation === `linux:${startTime}`) owned.killTree(9);
			} catch {}
		}
	}
}

async function reapLinuxAdoptedZombies(excludedPid: number | undefined): Promise<void> {
	if (process.platform !== "linux") return;
	let entries: string[];
	try {
		entries = await fs.readdir("/proc");
	} catch {
		return;
	}
	for (const entry of entries) {
		if (!/^\d+$/.test(entry)) continue;
		const pid = Number.parseInt(entry, 10);
		if (pid === excludedPid) continue;
		let stat: string;
		try {
			stat = await Bun.file(`/proc/${pid}/stat`).text();
		} catch {
			continue;
		}
		if (parseLinuxProcParentPid(stat) !== process.pid || parseLinuxProcState(stat) !== "Z") continue;
		try {
			const libc = dlopen("libc.so.6", {
				waitpid: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
			});
			const status = new Int32Array(1);
			libc.symbols.waitpid(pid, ptr(status), 1);
			libc.close();
		} catch {}
	}
}

function signalFromExit(code: number | null, signal: NodeJS.Signals | null): NodeJS.Signals | null {
	if (signal) return signal;
	if (code === null || code <= 128) return null;
	const signalNumber = code - 128;
	const match = Object.entries(os.constants.signals).find(([, number]) => number === signalNumber);
	return (match?.[0] as NodeJS.Signals | undefined) ?? null;
}

export function createUtf8LineDecoder(
	onLine: (line: string) => void,
	options?: { maxBufferedBytes?: number; onOverflow?: () => void },
): {
	push(chunk: Uint8Array): void;
	end(): void;
} {
	const decoder = new TextDecoder();
	let buffer = "";
	let bufferedBytes = 0;
	let overflowed = false;
	// Native minimization supports 4 MiB each for original and transformed text.
	// JSON escaping can expand every control byte to six ASCII bytes, so a 64 MiB
	// envelope safely bounds the worst supported pair plus result metadata.
	const maxBufferedBytes = options?.maxBufferedBytes ?? 64 * 1024 * 1024;
	const drain = (): void => {
		for (;;) {
			const newline = buffer.indexOf("\n");
			if (newline < 0) return;
			const line = buffer.slice(0, newline);
			bufferedBytes = Math.max(0, bufferedBytes - Buffer.byteLength(`${line}\n`));
			onLine(line);
			buffer = buffer.slice(newline + 1);
		}
	};
	return {
		push(chunk) {
			if (overflowed) return;
			bufferedBytes += chunk.byteLength;
			if (bufferedBytes > maxBufferedBytes) {
				overflowed = true;
				buffer = "";
				options?.onOverflow?.();
				return;
			}
			buffer += decoder.decode(chunk, { stream: true });
			drain();
		},
		end() {
			if (overflowed) return;
			buffer += decoder.decode();
			drain();
		},
	};
}

export function parseAuthenticatedWorkerResponse(
	line: string,
	protocolToken: string | undefined,
): BashShellWorkerResponse | undefined {
	if (!protocolToken) return undefined;
	try {
		const response = JSON.parse(line) as BashShellWorkerResponse;
		return response.token === protocolToken ? response : undefined;
	} catch {
		return undefined;
	}
}

export async function runBashShellSupervisor(): Promise<void> {
	enableLinuxChildSubreaper();
	for (const signal of fatalCatchableSignals()) {
		try {
			// This is a dedicated internal supervisor process. Remove the CLI's
			// postmortem listeners before installing the ownership-preserving no-op;
			// an appended listener cannot prevent an earlier handler from exiting.
			process.removeAllListeners(signal);
			process.on(signal, () => undefined);
		} catch {
			// The runtime may not expose every POSIX signal on every Unix target.
		}
	}

	const [command, ...args] = runtimeArgv();
	const worker = childProcess.spawn(command!, args, {
		cwd: process.cwd(),
		detached: false,
		env: { ...process.env, GJC_ISOLATED_SHELL_RUNTIME: "1" },
		stdio: ["pipe", "pipe", "pipe"],
		windowsHide: true,
	});
	const zombieReaper = setInterval(() => void reapLinuxAdoptedZombies(worker.pid), 25);
	zombieReaper.unref();
	const pendingRuns: number[] = [];
	let terminating = false;
	let protocolToken: string | undefined;
	let ownershipLedgerPath: string | undefined;

	const terminateRuntime = (): void => {
		if (terminating) return;
		terminating = true;
		if (worker.exitCode === null && worker.signalCode === null) worker.kill("SIGKILL");
		else process.exit(1);
	};

	const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
	input.on("line", line => {
		let request: BashShellWorkerRequest;
		try {
			request = JSON.parse(line) as BashShellWorkerRequest;
			if (!protocolToken) protocolToken = request.token;
			if (!request.token || request.token !== protocolToken) return;
			if (request.type === "run") pendingRuns.push(request.id);
		} catch {
			return;
		}
		if (request.type === "init" && request.ownershipLedger && worker.pid) {
			ownershipLedgerPath = request.ownershipLedger.path;
			const runtimeIncarnation = processIncarnation(worker.pid);
			if (!runtimeIncarnation) {
				terminateRuntime();
				return;
			}
			const darwinUniqueId = darwinUniqueProcessId(worker.pid, runtimeIncarnation);
			if (process.platform === "darwin" && !darwinUniqueId) {
				terminateRuntime();
				return;
			}
			const payload = `${worker.pid}:${runtimeIncarnation}:${darwinUniqueId ?? ""}`;
			const signature = createHmac("sha256", request.ownershipLedger.token).update(payload).digest("hex");
			void fs
				.appendFile(
					request.ownershipLedger.path,
					`${JSON.stringify({ pid: worker.pid, incarnation: runtimeIncarnation, darwinUniqueId, signature })}\n`,
					{ encoding: "utf8", mode: 0o600 },
				)
				.then(() => {
					if (worker.stdin.writable) worker.stdin.write(`${line}\n`);
				})
				.catch(terminateRuntime);
			return;
		}
		if (worker.stdin.writable) worker.stdin.write(`${line}\n`);
	});
	input.once("close", terminateRuntime);

	const outputDecoder = createUtf8LineDecoder(
		line => {
			const response = parseAuthenticatedWorkerResponse(line, protocolToken);
			if (!response) return;
			if ((response.type === "result" || response.type === "error") && response.id !== undefined) {
				const index = pendingRuns.indexOf(response.id);
				if (index >= 0) pendingRuns.splice(index, 1);
			}
			const forwarded = response.type === "ready" ? { ...response, supervisorPid: process.pid } : response;
			const writeForwarded = () => process.stdout.write(`${JSON.stringify(forwarded)}\n`);
			if (response.type === "ready" && ownershipLedgerPath) {
				const path = ownershipLedgerPath;
				ownershipLedgerPath = undefined;
				void fs.rm(path, { force: true }).then(writeForwarded).catch(terminateRuntime);
				return;
			}
			writeForwarded();
		},
		{
			onOverflow: () => {
				if (protocolToken) {
					const response = {
						type: "error",
						token: protocolToken,
						message: "Shell worker protocol record exceeded the byte limit.",
					} satisfies BashShellWorkerResponse;
					process.stdout.write(`${JSON.stringify(response)}\n`);
				}
				terminateRuntime();
			},
		},
	);
	worker.stdout.on("data", chunk => outputDecoder.push(chunk));
	worker.stdout.once("end", outputDecoder.end);
	worker.stderr.pipe(process.stderr);

	const exited = Promise.withResolvers<void>();
	worker.once("error", error => {
		if (!protocolToken) {
			process.exit(1);
			return;
		}
		process.stdout.write(
			`${JSON.stringify({ type: "error", token: protocolToken, message: error.message } satisfies BashShellWorkerResponse)}\n`,
			() => {
				process.exit(1);
			},
		);
	});
	worker.once("exit", async (code, signal) => {
		clearInterval(zombieReaper);
		const resultSignal = signalFromExit(code, signal);
		if (code === 0 && resultSignal === null) {
			await reapLinuxSubreaperChildren();
			// The runtime has already flushed its final protocol response and its
			// reparented descendants have been reaped. Let the live guardian retire
			// the remaining owned process group without any stale post-exit PGID use.
			process.exit(0);
			return;
		}
		const activeRunId = pendingRuns[0];
		if (!protocolToken) {
			process.exit(1);
			return;
		}
		const response: BashShellWorkerResponse | undefined =
			resultSignal && activeRunId !== undefined
				? {
						type: "result",
						token: protocolToken,
						id: activeRunId,
						result: {
							exitCode: signalExitCode(resultSignal),
							cancelled: false,
							timedOut: false,
							signal: resultSignal,
						},
					}
				: undefined;
		if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
		const retiring = {
			type: "retiring",
			token: protocolToken,
			message: `Shell runtime exited with ${resultSignal ?? `code ${code ?? "unknown"}`}.`,
		} satisfies BashShellWorkerResponse;
		process.stdout.write(`${JSON.stringify(retiring)}\n`);
		await reapLinuxSubreaperChildren();
		process.exit(1);
	});

	await exited.promise;
}
