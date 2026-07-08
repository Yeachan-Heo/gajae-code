/**
 * Windows psmux detection and tmux-binary resolution.
 *
 * Recent psmux releases (see docs/compatibility.md in the psmux repo) close
 * the round-trip gap for set-option / show-options user options and the
 * set-window-option profile values gjc emits, which is what unblocks the
 * native Windows gjc --tmux path. This module detects that capability so gjc
 * can pick psmux when tmux is missing on Windows, and so callers can decide
 * whether to treat a given tmux binary as psmux (affecting e.g. the untagged
 * diagnostic wording and namespace handling).
 *
 * The probe is intentionally lightweight: it runs a single tmux -V (or
 * --version) once per process and caches the verdict. Cache invalidation
 * knobs:
 *   - force: true re-probes on every call (used by tests).
 *   - GJC_PSMUX_FORCE_DETECT=1 re-probes each call.
 *   - GJC_PSMUX_DETECTION=off skips probing entirely.
 */

export const GJC_PSMUX_COMMAND_ENV = "GJC_PSMUX_COMMAND";
export const GJC_PSMUX_DETECTION_ENV = "GJC_PSMUX_DETECTION";
export const GJC_PSMUX_FORCE_DETECT_ENV = "GJC_PSMUX_FORCE_DETECT";

/** Names that psmux installs as the canonical executable / alias. */
export const PSMUX_BINARY_NAMES = ["psmux", "pmux", "tmux"] as const;

/** Substrings that uniquely identify psmux in version/help output. */
const PSMUX_VERSION_MARKERS = ["psmux", "pmux"] as const;

export type PsmuxSpawnRunner = (
	command: string,
	args: string[],
) => { exitCode: number | null; stdout?: string; stderr?: string };

/**
 * Resolves a tmux-class binary name (e.g. "psmux", "tmux") to an absolute
 * filesystem path or returns null when the binary cannot be located. The
 * default implementation uses `Bun.which`; production callers leave it
 * alone and unit tests inject a stub via `__setBinaryResolverForTests`
 * so the version-banner probe can be exercised hermetically.
 */
export type BinaryResolver = (candidate: string) => string | null;

const DEFAULT_BINARY_RESOLVER: BinaryResolver = candidate => {
	if (!candidate) return null;
	const stripped = candidate.trim().replace(/^["']|["']$/g, "");
	if (!stripped) return null;
	if (Bun.which(stripped)) return stripped;
	return null;
};

let activeBinaryResolver: BinaryResolver = DEFAULT_BINARY_RESOLVER;

/** @internal Test-only seam; production code never calls this. */
export function __setBinaryResolverForTests(resolver: BinaryResolver | null): void {
	activeBinaryResolver = resolver ?? DEFAULT_BINARY_RESOLVER;
}

interface CacheEntry {
	command: string;
	isPsmux: boolean;
}

const detectionCache = new Map<string, CacheEntry>();

export function envDisabled(value: string | undefined): boolean {
	const normalized = value?.trim().toLowerCase();
	return normalized === "0" || normalized === "false" || normalized === "off" || normalized === "no";
}

/**
 * GJC_PSMUX_FORCE_DETECT opt-in re-probe switch. Any non-empty value other
 * than a "disabled" sentinel forces a fresh probe on every call. The unset
 * (undefined) case must NOT force probing, otherwise the in-process cache
 * never engages.
 */
function envForcesProbe(value: string | undefined): boolean {
	if (value === undefined) return false;
	if (envDisabled(value)) return false;
	return value.trim().length > 0;
}

function readSpawnRunner(): PsmuxSpawnRunner {
	return (command, args) => {
		try {
			const result = Bun.spawnSync({
				cmd: [command, ...args],
				stdout: "pipe",
				stderr: "pipe",
				env: process.env,
			});
			return {
				exitCode: result.exitCode,
				stdout: result.stdout.toString(),
				stderr: result.stderr.toString(),
			};
		} catch {
			return { exitCode: -1, stdout: "", stderr: "" };
		}
	};
}

function probeVersionOutput(command: string, runner: PsmuxSpawnRunner): string {
	const flags = ["-V", "--version"];
	for (const flag of flags) {
		const result = runner(command, [flag]);
		const text = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.toLowerCase();
		if (result.exitCode === 0 && text.trim().length > 0) return text;
	}
	return "";
}

function outputMentionsPsmux(output: string): boolean {
	if (!output) return false;
	return PSMUX_VERSION_MARKERS.some(marker => output.includes(marker));
}

function normalizedCommandBaseName(command: string): string {
	const normalized = command
		.trim()
		.replace(/^['"]|['"]$/g, "")
		.replace(/\\/g, "/");
	const basename = normalized.slice(normalized.lastIndexOf("/") + 1).toLowerCase();
	return basename.endsWith(".exe") ? basename.slice(0, -4) : basename;
}

function isNamedPsmuxCommand(command: string): boolean {
	const basename = normalizedCommandBaseName(command);
	return basename === "psmux" || basename === "pmux";
}

function resolveBinaryPath(candidate: string): string | null {
	return activeBinaryResolver(candidate);
}

function detectPsmuxForCommand(command: string, runner: PsmuxSpawnRunner): boolean {
	const resolved = resolveBinaryPath(command);
	if (!resolved) return false;
	const output = probeVersionOutput(resolved, runner);
	return outputMentionsPsmux(output);
}

/**
 * Decide whether command resolves to a psmux binary by probing its version
 * output. The result is cached per process unless force is set or
 * GJC_PSMUX_FORCE_DETECT=1.
 */
export function detectPsmux(
	command: string,
	options: { force?: boolean; env?: NodeJS.ProcessEnv; runner?: PsmuxSpawnRunner } = {},
): boolean {
	const env = options.env ?? process.env;
	const explicit = env[GJC_PSMUX_COMMAND_ENV]?.trim();
	if (explicit) {
		// The override is authoritative on its own — we trust the user's
		// GJC_PSMUX_COMMAND value when they name a psmux-class binary, even
		// when the binary cannot be located on PATH in the current process.
		// This keeps the override usable from CI runners and from test
		// environments where Bun.which would otherwise return null.
		const normalized = explicit.toLowerCase();
		if (
			normalized === "psmux" ||
			normalized === "pmux" ||
			normalized.endsWith("/psmux") ||
			normalized.endsWith("/pmux") ||
			normalized.endsWith("\\psmux") ||
			normalized.endsWith("\\pmux")
		) {
			return true;
		}
		const explicitPath = resolveBinaryPath(explicit);
		if (explicitPath && explicitPath === resolveBinaryPath(command)) return true;
	}
	if (envDisabled(env[GJC_PSMUX_DETECTION_ENV])) return false;
	const force = options.force === true || envForcesProbe(env[GJC_PSMUX_FORCE_DETECT_ENV]);
	const useCache = !force && !options.force;
	if (useCache) {
		const cached = detectionCache.get(command);
		if (cached) return cached.isPsmux;
	}
	const runner = options.runner ?? readSpawnRunner();
	const isPsmux = detectPsmuxForCommand(command, runner);
	if (useCache) detectionCache.set(command, { command, isPsmux });
	return isPsmux;
}

export interface ResolveGjcTmuxBinaryOptions {
	platform?: NodeJS.Platform;
	env?: NodeJS.ProcessEnv;
	runner?: PsmuxSpawnRunner;
}

export interface ResolvedTmuxBinary {
	command: string;
	isPsmux: boolean;
	viaExplicitOverride: boolean;
}

/**
 * Resolve the tmux command GJC should invoke. Honors the existing
 * GJC_TMUX_COMMAND / GJC_TEAM_TMUX_COMMAND overrides; on Windows when no
 * override is set, psmux (installed as psmux, pmux, or tmux) is picked
 * automatically so the default gjc --tmux flow lands on a real multiplexer.
 */
export function resolveGjcTmuxBinary(options: ResolveGjcTmuxBinaryOptions = {}): ResolvedTmuxBinary {
	const env = options.env ?? process.env;
	const platform = options.platform ?? process.platform;
	const runner = options.runner ?? readSpawnRunner();
	const explicit = env.GJC_TMUX_COMMAND?.trim() || env.GJC_TEAM_TMUX_COMMAND?.trim();
	if (explicit) {
		const isPsmux =
			platform === "win32" && isNamedPsmuxCommand(explicit) ? true : detectPsmux(explicit, { env, runner });
		return { command: explicit, isPsmux, viaExplicitOverride: true };
	}
	if (platform === "win32") {
		for (const candidate of PSMUX_BINARY_NAMES) {
			if (resolveBinaryPath(candidate)) {
				const isPsmux = isNamedPsmuxCommand(candidate) ? true : detectPsmux(candidate, { env, runner });
				return { command: candidate, isPsmux, viaExplicitOverride: false };
			}
		}
	}
	const tmuxPath = resolveBinaryPath("tmux");
	if (tmuxPath) {
		const isPsmux = detectPsmux("tmux", { env, runner });
		return { command: "tmux", isPsmux, viaExplicitOverride: false };
	}
	return { command: "tmux", isPsmux: false, viaExplicitOverride: false };
}

/** Test-only helper: drop the in-process detection cache. */
export function clearPsmuxDetectionCache(): void {
	detectionCache.clear();
}

export interface PsmuxProbe {
	command: string;
	versionOutput: string;
	isPsmux: boolean;
}

export function probePsmux(
	command: string,
	options: { env?: NodeJS.ProcessEnv; runner?: PsmuxSpawnRunner; force?: boolean } = {},
): PsmuxProbe {
	const env = options.env ?? process.env;
	const runner = options.runner ?? readSpawnRunner();
	const resolved = resolveBinaryPath(command);
	if (!resolved) return { command, versionOutput: "", isPsmux: false };
	if (options.force) clearPsmuxDetectionCache();
	const output = probeVersionOutput(resolved, runner);
	const isPsmux = outputMentionsPsmux(output) || env[GJC_PSMUX_COMMAND_ENV]?.trim() === resolved;
	return { command: resolved, versionOutput: output, isPsmux };
}
