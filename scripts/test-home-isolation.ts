/**
 * Per-process HOME isolation for test runs, shared by the shard runner
 * (`scripts/run-bun-test-files.ts`) and the test preload (`scripts/test-preload.ts`).
 *
 * The runner gives every test file a private HOME before the test process starts.
 * A plain `bun test` (or a package `test` script) has no runner, so without the
 * preload every child a test spawns (`gjc`, a broker, a session host, a tmux TUI)
 * would resolve the operator's real home and write user state — session-owner
 * claims, stats, logs — under the live `~/.gjc`.
 *
 * Setting `process.env.HOME` alone does not reach those children in Bun 1.4:
 * `Bun.spawn`/`Bun.spawnSync` without an `env` option use the environment the
 * process started with, and native spawns (portable-pty) snapshot the C environ,
 * which `process.env` writes never touch. {@link applyIsolatedHome} therefore
 * writes the isolated values into all three places.
 *
 * Kept separate from the preload so the decision is unit-testable without
 * applying the preload's environment mutations as a side effect.
 */
import { CString, dlopen, FFIType } from "bun:ffi";
import * as fs from "node:fs";
import * as path from "node:path";

/** Set to the isolated HOME by whichever layer isolated it (runner or preload). */
export const TEST_ISOLATED_HOME_ENV = "GJC_TEST_ISOLATED_HOME";

/** The environment keys that select user-scope state, plus the provenance marker. */
export interface IsolatedHomeEnv {
	HOME: string;
	USERPROFILE: string;
	XDG_CONFIG_HOME: string;
	XDG_DATA_HOME: string;
	XDG_STATE_HOME: string;
	XDG_CACHE_HOME: string;
	XDG_RUNTIME_DIR: string;
	[TEST_ISOLATED_HOME_ENV]: string;
}

/** The isolated home layout under `root`: `root/home` and `root/xdg/<category>`. */
export function isolatedHomeEnv(root: string): IsolatedHomeEnv {
	const home = path.join(root, "home");
	return {
		HOME: home,
		USERPROFILE: home,
		XDG_CONFIG_HOME: path.join(root, "xdg", "config"),
		XDG_DATA_HOME: path.join(root, "xdg", "data"),
		XDG_STATE_HOME: path.join(root, "xdg", "state"),
		XDG_CACHE_HOME: path.join(root, "xdg", "cache"),
		XDG_RUNTIME_DIR: path.join(root, "xdg", "runtime"),
		[TEST_ISOLATED_HOME_ENV]: home,
	};
}

/** Create every directory of an isolated home; `XDG_RUNTIME_DIR` is owner-only as the spec requires. */
export function createIsolatedHomeDirectories(env: IsolatedHomeEnv): void {
	for (const dir of [env.HOME, env.XDG_CONFIG_HOME, env.XDG_DATA_HOME, env.XDG_STATE_HOME, env.XDG_CACHE_HOME]) {
		fs.mkdirSync(dir, { recursive: true });
	}
	fs.mkdirSync(env.XDG_RUNTIME_DIR, { recursive: true, mode: 0o700 });
}

export type HomeIsolationDecision =
	/** An isolating ancestor (the runner, a parent preload, or the test that spawned this one) chose HOME. */
	| { action: "honor"; home: string }
	| { action: "isolate"; reason: "unmarked" | "absent" | "real-home" | "unverifiable" };

export interface HomeIsolationInput {
	env: Record<string, string | undefined>;
	/** The operator's real home and its aliases, resolved without trusting `$HOME`. */
	realHomeAliases: readonly string[];
	platform?: NodeJS.Platform;
}

/**
 * Isolate unless an isolating ancestor already chose a home that is provably not
 * the operator's. The marker alone proves nothing (an environment variable has no
 * provenance), so a marked HOME that is the real home is still replaced, and so is
 * any HOME when the real home cannot be resolved to compare against.
 */
export function decideHomeIsolation(input: HomeIsolationInput): HomeIsolationDecision {
	const homeKey = (input.platform ?? process.platform) === "win32" ? "USERPROFILE" : "HOME";
	const home = input.env[homeKey];
	if (input.env[TEST_ISOLATED_HOME_ENV] === undefined) return { action: "isolate", reason: "unmarked" };
	if (!home || !path.isAbsolute(home)) return { action: "isolate", reason: "absent" };
	if (input.realHomeAliases.length === 0) return { action: "isolate", reason: "unverifiable" };
	const candidates = new Set([path.resolve(home)]);
	try {
		candidates.add(fs.realpathSync(home));
	} catch {
		// A home that does not exist yet cannot alias the real one through a symlink.
	}
	const real = new Set(input.realHomeAliases.map(alias => path.resolve(alias)));
	for (const candidate of candidates) {
		if (real.has(candidate)) return { action: "isolate", reason: "real-home" };
	}
	return { action: "honor", home };
}

type SpawnFunction = (...args: unknown[]) => unknown;

/** Give `Bun.spawn`/`Bun.spawnSync` calls that pass no `env` the startup environment plus `overlay`. */
function overlayDefaultSpawnEnvironment(childEnv: Record<string, string | undefined>): void {
	const runtime = Bun as unknown as { spawn: SpawnFunction; spawnSync: SpawnFunction };
	const withDefaultEnv = (original: SpawnFunction): SpawnFunction =>
		function spawnWithIsolatedHome(...args: unknown[]): unknown {
			// `spawn(cmd, options?)` or `spawn({ cmd, ...options })`.
			const index = Array.isArray(args[0]) ? 1 : 0;
			const options = args[index];
			if (options === undefined || options === null) {
				args[index] = { env: childEnv };
			} else if (typeof options === "object" && (options as { env?: unknown }).env === undefined) {
				args[index] = { ...options, env: childEnv };
			}
			return original(...args);
		};
	runtime.spawn = withDefaultEnv(runtime.spawn.bind(Bun));
	runtime.spawnSync = withDefaultEnv(runtime.spawnSync.bind(Bun));
}

/** Write `values` into the C environ, which native spawns snapshot, and read each one back. */
function exportToNativeEnvironment(values: Record<string, string>): void {
	const libraryName = process.platform === "darwin" ? "libc.dylib" : "libc.so.6";
	const libc = dlopen(libraryName, {
		setenv: { args: [FFIType.cstring, FFIType.cstring, FFIType.i32], returns: FFIType.i32 },
		getenv: { args: [FFIType.cstring], returns: FFIType.ptr },
	});
	try {
		for (const [key, value] of Object.entries(values)) {
			const name = Buffer.from(`${key}\0`);
			if (libc.symbols.setenv(name, Buffer.from(`${value}\0`), 1) !== 0) {
				throw new Error(`setenv(${key}) failed`);
			}
			const pointer = libc.symbols.getenv(name);
			if (pointer === null || new CString(pointer).toString() !== value) {
				throw new Error(`setenv(${key}) did not take effect`);
			}
		}
	} finally {
		libc.close();
	}
}

/**
 * Toolchain homes that default to a directory under HOME, pinned to where the
 * process's startup HOME puts them. These hold tool installs and download
 * caches, not user state: under an empty isolated HOME, a test that runs
 * `cargo` would make rustup download a whole toolchain on every run.
 */
export function inheritedToolchainHomes(
	startupEnv: Record<string, string | undefined>,
	platform: NodeJS.Platform = process.platform,
): Record<string, string> {
	const home = startupEnv[platform === "win32" ? "USERPROFILE" : "HOME"];
	if (!home || !path.isAbsolute(home)) return {};
	const pinned: Record<string, string> = {};
	if (!startupEnv.CARGO_HOME) pinned.CARGO_HOME = path.join(home, ".cargo");
	if (!startupEnv.RUSTUP_HOME) pinned.RUSTUP_HOME = path.join(home, ".rustup");
	return pinned;
}

/**
 * Make `env` the home of every child this process spawns: `process.env` (read by
 * `node:child_process`, `Bun.$`, and `{ ...process.env }` spreads), the default
 * environment of `Bun.spawn`/`Bun.spawnSync`, and the C environ.
 *
 * `startupEnv` must be the environment the process started with: it is what
 * `Bun.spawn` hands a child today, so overlaying only the isolation keys (and
 * {@link inheritedToolchainHomes}) onto it changes nothing else those children see.
 *
 * Windows has no libc `setenv`; there `USERPROFILE` reaches JS spawns only.
 */
export function applyIsolatedHome(env: IsolatedHomeEnv, startupEnv: Record<string, string | undefined>): void {
	const values: Record<string, string> = { ...inheritedToolchainHomes(startupEnv), ...env };
	Object.assign(process.env, values);
	overlayDefaultSpawnEnvironment({ ...startupEnv, ...values });
	if (process.platform !== "win32") exportToNativeEnvironment(values);
}
