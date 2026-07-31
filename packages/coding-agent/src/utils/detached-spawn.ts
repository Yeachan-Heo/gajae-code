import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";

export interface DetachedSpawnOptions {
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	/**
	 * win32-only. Spawn the child so it owns a *hidden* console instead of no
	 * console at all, and drop `detached` to get it.
	 *
	 * Win32 `CreateProcess` treats `DETACHED_PROCESS` and `CREATE_NO_WINDOW` as
	 * mutually exclusive and `DETACHED_PROCESS` wins, so a detached child has no
	 * console whatsoever -- and every console-subsystem grandchild it later
	 * spawns must allocate a fresh **visible** one. That is the real source of
	 * the console windows: not the spawn itself (a console-less process shows
	 * nothing), but the shell children the session host runs afterwards through
	 * `@gajae-code/natives`, which is compiled and cannot pass its own flags.
	 *
	 * Setting this omits `detached` so `windowsHide` can take effect as
	 * `CREATE_NO_WINDOW`: the child gets a hidden console that its own console
	 * children inherit, and nothing is ever displayed. Verified empirically --
	 * a host spawned `detached + windowsHide` has no conhost and its children
	 * allocate visible consoles; spawned `windowsHide` alone it has a hidden
	 * conhost and its children inherit it.
	 *
	 * Only for children whose parent outlives them (the broker's session hosts).
	 * Do NOT set it for the broker itself, which must survive the CLI/Electron
	 * process that spawns it.
	 */
	hiddenConsole?: boolean;
}

/**
 * Spawns a child that never displays a console window.
 *
 * On Windows under Bun, `node:child_process` ignores `windowsHide: true` for
 * `detached: true` children, so these spawns route through `Bun.spawn` behind a
 * minimal ChildProcess-shaped facade exposing exactly the surface the callers
 * use: `pid`, `exitCode`, `signalCode`, `kill`, `unref`, and the
 * `error`/`exit`/`close` events.
 *
 * Note that `Bun.spawn` does not rescue `windowsHide` for a *detached* child
 * either -- `DETACHED_PROCESS` still wins. Suppressing the windows that shell
 * tool calls open requires `hiddenConsole`, which trades `detached` away for an
 * inheritable hidden console. See `DetachedSpawnOptions.hiddenConsole`.
 *
 * Spawn failures (e.g. a missing executable) throw synchronously, matching
 * Bun's `node:child_process` behavior that existing callers rely on.
 *
 * On other platforms (and non-Bun runtimes) this defers to
 * `node:child_process.spawn` with `detached: true` and `windowsHide: true`,
 * preserving prior behavior: there is no console to inherit off Windows, so
 * `hiddenConsole` is ignored there and process-group semantics stay unchanged.
 */
export function spawnDetachedChild(file: string, args: string[], options: DetachedSpawnOptions = {}): ChildProcess {
	if (process.platform !== "win32" || typeof Bun === "undefined") {
		return spawn(file, args, {
			detached: true,
			stdio: ["ignore", "ignore", "ignore"],
			// A detached console-subsystem child would otherwise flash a cmd window on Windows under Node.
			windowsHide: true,
			env: options.env,
			...(options.cwd ? { cwd: options.cwd } : {}),
		});
	}
	const proc = Bun.spawn([file, ...args], {
		stdio: ["ignore", "ignore", "ignore"] as never,
		// Mutually exclusive on Win32: detached wins and costs the hidden console.
		...(options.hiddenConsole ? {} : { detached: true }),
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
