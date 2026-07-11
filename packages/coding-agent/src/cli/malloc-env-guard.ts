/**
 * macOS malloc-stack-logging launch boundary.
 *
 * When a gjc process starts with `MallocStackLogging` /
 * `MallocStackLoggingNoCompact` in its environment (Xcode schemes,
 * Instruments, `launchctl setenv`, debug-attached shells), two things go
 * wrong:
 *
 * 1. libmalloc prints `MallocStackLogging: …` diagnostics to stderr whenever
 *    stderr is a TTY. Inside the TUI every PTY-spawned child repeats the
 *    warning straight into the terminal, flooding the UI.
 * 2. Bun snapshots the spawn-default environment at process startup:
 *    `delete process.env.X`, `delete Bun.env.X`, and even a real libc
 *    `unsetenv()` do NOT clean children spawned without an explicit `env`
 *    (verified on Bun 1.3.14). JS-side scrubbing therefore cannot close the
 *    leak from inside the contaminated process.
 *
 * The only complete fix from inside the process is to re-exec gjc once with a
 * scrubbed environment before doing anything else. The re-exec'd process
 * starts with a clean startup snapshot, so every child — `Bun.spawn`
 * defaults, `node:child_process`, and PTY children (portable_pty snapshots
 * the live environ) — inherits a clean env. `crates/pi-natives/src/pty.rs`
 * additionally removes the two vars on the Rust side as a belt-and-braces
 * guard for SDK embedders that never pass through `runCli()`.
 *
 * `runCli()` inlines {@link mallocEnvNeedsReexec}'s predicate so the
 * uncontaminated fast paths (`--version`, `--help`, …) never load this
 * module. Keep the two in sync.
 */
import { filterProcessEnv } from "@gajae-code/utils/spawn-env";

/** Loop guard: set on the re-exec'd child so it never re-execs again. */
export const MALLOC_ENV_REEXEC_GUARD_VAR = "GJC_MALLOC_ENV_REEXEC";

export const MACOS_MALLOC_ENV_VAR_NAMES = ["MallocStackLogging", "MallocStackLoggingNoCompact"] as const;

/** True when the current process must re-exec itself with a scrubbed env. */
export function mallocEnvNeedsReexec(
	env: Record<string, string | undefined> = process.env,
	platform: NodeJS.Platform = process.platform,
): boolean {
	if (platform !== "darwin") return false;
	if (env[MALLOC_ENV_REEXEC_GUARD_VAR]) return false;
	return MACOS_MALLOC_ENV_VAR_NAMES.some(name => env[name] !== undefined);
}

/**
 * Rebuild the exact command line of the current process for a self re-exec.
 *
 * - Source run: `argv = [bunPath, script, ...args]`, `execPath = bunPath` →
 *   `[execPath, script, ...args]`.
 * - Compiled binary: `argv = ["bun", "/$bunfs/root/<entry>", ...args]`,
 *   `execPath = <binary>` → the virtual `/$bunfs` script path must not be
 *   forwarded as a CLI argument, so it is dropped.
 */
export function buildMallocEnvReexecCommand(
	execPath: string = process.execPath,
	argv: string[] = process.argv,
): string[] {
	const script = argv[1];
	if (script !== undefined && !script.startsWith("/$bunfs")) return [execPath, ...argv.slice(1)];
	return [execPath, ...argv.slice(2)];
}

export interface MallocEnvReexecIO {
	execPath?: string;
	argv?: string[];
	env?: Record<string, string | undefined>;
	/** Test seam. Production default inherits stdio and awaits the child. */
	spawn?: (cmd: string[], env: Record<string, string>) => Promise<number>;
}

/**
 * Re-exec the current gjc invocation with the malloc env vars stripped and
 * the loop guard set. Returns the child's exit code; the caller must exit
 * with it and run nothing else.
 */
export async function reexecWithoutMallocEnv(io: MallocEnvReexecIO = {}): Promise<number> {
	const env = filterProcessEnv(io.env ?? process.env);
	env[MALLOC_ENV_REEXEC_GUARD_VAR] = "1";
	const cmd = buildMallocEnvReexecCommand(io.execPath, io.argv);
	const spawn = io.spawn ?? defaultReexecSpawn;
	return spawn(cmd, env);
}

async function defaultReexecSpawn(cmd: string[], env: Record<string, string>): Promise<number> {
	// One-time actionable notice (interactive terminals only): the vars are
	// injected from outside gjc, so tell the user how to fix the source. The
	// top-level libmalloc lines above this are printed by libc before JS runs
	// and cannot be suppressed from inside the process.
	if (process.stderr.isTTY) {
		process.stderr.write(
			"gjc: macOS malloc stack logging env detected (MallocStackLogging*); " +
				"re-executing with a clean environment. To fix the source, run: " +
				"launchctl unsetenv MallocStackLogging MallocStackLoggingNoCompact\n",
		);
	}
	const child = Bun.spawn({ cmd, env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
	// Ctrl+C is delivered by the terminal to the whole foreground process
	// group, so the child receives its own SIGINT; the parent must only stay
	// alive until the child exits. Targeted SIGTERM (e.g. `kill <parent pid>`)
	// is forwarded so the wrapper stays transparent to supervisors.
	const ignoreSignal = () => {};
	const forwardTerm = () => {
		try {
			child.kill("SIGTERM");
		} catch {
			// child already gone
		}
	};
	process.on("SIGINT", ignoreSignal);
	process.on("SIGTERM", forwardTerm);
	try {
		return await child.exited;
	} finally {
		process.off("SIGINT", ignoreSignal);
		process.off("SIGTERM", forwardTerm);
	}
}
