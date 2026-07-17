/**
 * macOS malloc-stack-logging launch boundary.
 *
 * On macOS, an inherited `MallocStackLogging` / `MallocStackLoggingNoCompact`
 * environment variable (from an Xcode scheme's malloc diagnostics, Instruments,
 * `launchctl setenv`, or a debug-attached shell) makes libmalloc print
 *
 *   MallocStackLogging: can't turn off malloc stack logging because it was not enabled.
 *
 * to the stderr of every TTY-attached process. Bun snapshots the spawn-default
 * environment at process startup — before any JS runs — so neither
 * `delete process.env.X` nor a real libc `unsetenv()` cleans the environment
 * that children inherit by default (verified on Bun 1.3.14). Inside the TUI,
 * every PTY-spawned child then repeats the warning straight into the rendered
 * frame and corrupts the display.
 *
 * The only way to hand children a clean startup snapshot is to start the primary
 * process with a clean environment. This module re-execs the exact invocation
 * once (darwin-only) with a `filterProcessEnv`-scrubbed environment and a
 * `GJC_MALLOC_ENV_REEXEC` loop guard, before any fast path or subprocess spawn.
 * The re-exec'd process — and therefore every downstream lane: `Bun.spawn`
 * defaults, `node:child_process`, the native PTY, the tmux owner, plugin
 * installs, and subagents — starts from a clean snapshot.
 *
 * The initial contaminated process's own libmalloc line is emitted by libc
 * before any JS runs and cannot be suppressed from inside the process; it
 * appears at most once per launch. A one-time actionable notice is written to
 * interactive stderr (outside the rendered frame) pointing at the permanent
 * `launchctl unsetenv` fix.
 */

import { filterProcessEnv } from "@gajae-code/utils/env";
import type { Subprocess } from "bun";

/** Env vars that make macOS libmalloc write to a TTY when inherited. */
export const MACOS_MALLOC_ENV_VARS = ["MallocStackLogging", "MallocStackLoggingNoCompact"] as const;

/** Loop guard set on the scrubbed re-exec so it never re-execs itself again. */
export const MALLOC_ENV_REEXEC_GUARD = "GJC_MALLOC_ENV_REEXEC";

/** True when at least one macOS malloc-stack-logging var is present in `env`. */
export function hasMacOSMallocEnv(env: Record<string, string | undefined>): boolean {
	return MACOS_MALLOC_ENV_VARS.some(name => env[name] !== undefined);
}

/**
 * True iff we must re-exec to escape a contaminated macOS startup snapshot:
 * darwin, not already inside the scrubbed re-exec, and at least one malloc var
 * present. Off darwin or on the re-exec'd child this is always false, so the
 * common launch path pays only two cheap lookups.
 */
export function shouldReexecForMacOSMallocEnv(
	env: Record<string, string | undefined>,
	platform: NodeJS.Platform,
): boolean {
	return platform === "darwin" && env[MALLOC_ENV_REEXEC_GUARD] === undefined && hasMacOSMallocEnv(env);
}

/**
 * Reconstruct the argv that re-runs the exact same program image.
 *
 * - Compiled single-file executable: argv[1] is the embedded virtual entry
 *   (`/$bunfs/…` on POSIX, `B:\~BUN\…` on Windows), which must be dropped — the
 *   executable re-embeds its own entry. Re-run `[exe, ...userArgs]`.
 * - Source / dev-link run: argv[1] is the on-disk script that must be passed
 *   back to the interpreter. Re-run `[interpreter, script, ...userArgs]`.
 */
export function buildMallocReexecArgv(argv: readonly string[], execPath: string): string[] {
	const entry = argv[1];
	const isCompiledEntry =
		typeof entry === "string" && (entry.includes("/$bunfs/") || entry.includes("~BUN") || entry.includes("%7EBUN"));
	if (isCompiledEntry) {
		return [execPath, ...argv.slice(2)];
	}
	return [execPath, ...argv.slice(1)];
}

/** One-time, human-actionable notice pointing at the permanent environment fix. */
export function formatMallocEnvNotice(): string {
	return (
		"gajae-code: detected macOS malloc-stack-logging environment variables " +
		"(MallocStackLogging / MallocStackLoggingNoCompact); relaunching once with a " +
		"scrubbed environment so they do not flood the terminal.\n" +
		"  Remove them permanently with:\n" +
		"    unset MallocStackLogging MallocStackLoggingNoCompact\n" +
		"    launchctl unsetenv MallocStackLogging\n" +
		"    launchctl unsetenv MallocStackLoggingNoCompact\n"
	);
}

/**
 * Re-exec the current process once with a scrubbed environment and propagate the
 * child's exit code. Callers MUST gate this behind `shouldReexecForMacOSMallocEnv`.
 *
 * Returns the child exit code, or `null` if the re-exec could not be spawned (in
 * which case the caller falls back to running in the current, contaminated
 * process — degraded but functional; the native PTY boundary and
 * `filterProcessEnv` still keep managed children clean).
 */
export async function reexecWithScrubbedMallocEnv(): Promise<number | null> {
	const cleanEnv = filterProcessEnv(process.env);
	cleanEnv[MALLOC_ENV_REEXEC_GUARD] = "1";
	const childArgv = buildMallocReexecArgv(process.argv, process.execPath);

	// Surface the diagnostic exactly once, before the TUI enters its alternate
	// screen, and only on an interactive terminal (piped/CI stderr is not a TTY,
	// so libmalloc stays silent there and the notice would just be noise).
	if (process.stderr.isTTY) {
		process.stderr.write(formatMallocEnvNotice());
	}

	let child: Subprocess;
	try {
		child = Bun.spawn(childArgv, {
			env: cleanEnv,
			stdin: "inherit",
			stdout: "inherit",
			stderr: "inherit",
		});
	} catch {
		return null;
	}

	// Keep the wrapper alive on SIGINT/SIGTERM so it reaps the child and
	// propagates its exit code instead of dying first, and forward the signal so
	// the scrubbed child terminates too. Interactive Ctrl-C is delivered to the
	// whole foreground process group (and the TUI's raw mode turns it into a 0x03
	// byte, not a signal, anyway), so re-forwarding is a harmless no-op once the
	// child is already handling or exiting. Targeted delivery — `kill -INT <pid>`
	// or a supervisor's `child.kill("SIGINT")` — reaches only the wrapper, so
	// without forwarding the launch would be uncancellable outside a terminal.
	const forwardSignal = (signal: NodeJS.Signals) => () => {
		try {
			child.kill(signal);
		} catch {
			// Child already gone; nothing to forward.
		}
	};
	const onSigint = forwardSignal("SIGINT");
	const onSigterm = forwardSignal("SIGTERM");
	process.on("SIGINT", onSigint);
	process.on("SIGTERM", onSigterm);
	try {
		return await child.exited;
	} finally {
		process.off("SIGINT", onSigint);
		process.off("SIGTERM", onSigterm);
	}
}
