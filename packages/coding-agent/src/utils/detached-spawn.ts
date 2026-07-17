import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";

export interface DetachedSpawnOptions {
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	/** Optional file descriptor receiving both stdout and stderr (e.g. a daemon log). */
	outputFd?: number;
}

/**
 * Spawns a detached child that never opens a console window.
 *
 * On Windows under Bun, `node:child_process` ignores `windowsHide: true` for
 * `detached: true` children: every detached broker/session-host/daemon spawn
 * opens a visible console window. `Bun.spawn` honors `windowsHide` and its
 * detached children do not allocate a new console, so Windows spawns route
 * through `Bun.spawn` behind a minimal ChildProcess-shaped facade exposing
 * exactly the surface the callers use: `pid`, `exitCode`, `signalCode`,
 * `kill`, `unref`, and `error`/`exit`/`close` events.
 *
 * Spawn failures (e.g. a missing executable) throw synchronously, matching
 * Bun's `node:child_process` behavior that existing callers rely on.
 *
 * On other platforms (and non-Bun runtimes) this defers to
 * `node:child_process.spawn` with `windowsHide: true`, preserving prior
 * behavior.
 */
export function spawnDetachedChild(file: string, args: string[], options: DetachedSpawnOptions = {}): ChildProcess {
	const stdioTail =
		options.outputFd === undefined
			? (["ignore", "ignore"] as const)
			: ([options.outputFd, options.outputFd] as const);
	if (process.platform !== "win32" || typeof Bun === "undefined") {
		return spawn(file, args, {
			detached: true,
			stdio: ["ignore", ...stdioTail],
			// A detached console-subsystem child would otherwise flash a cmd window on Windows under Node.
			windowsHide: true,
			env: options.env,
			...(options.cwd ? { cwd: options.cwd } : {}),
		});
	}
	const proc = Bun.spawn([file, ...args], {
		stdio: ["ignore", ...stdioTail] as never,
		detached: true,
		windowsHide: true,
		env: options.env as Record<string, string | undefined> | undefined,
		...(options.cwd ? { cwd: options.cwd } : {}),
	});
	const emitter = new EventEmitter();
	const emitExit = (): void => {
		emitter.emit("exit", proc.exitCode, proc.signalCode);
		emitter.emit("close", proc.exitCode, proc.signalCode);
	};
	proc.exited.then(emitExit, emitExit);
	Object.defineProperties(emitter, {
		pid: { get: () => proc.pid },
		exitCode: { get: () => proc.exitCode },
		signalCode: { get: () => proc.signalCode },
	});
	const facade = emitter as unknown as ChildProcess & {
		kill: (signal?: NodeJS.Signals | number) => boolean;
		unref: () => void;
	};
	facade.kill = (signal?: NodeJS.Signals | number): boolean => {
		proc.kill(signal as never);
		return true;
	};
	facade.unref = (): void => {
		proc.unref();
	};
	return facade;
}
