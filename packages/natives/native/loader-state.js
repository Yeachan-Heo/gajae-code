import { dlopen, ptr } from "bun:ffi";
import * as childProcess from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import packageJson from "../package.json" with { type: "json" };
import { embeddedAddon } from "./embedded-addon.js";

/**
 * Native addon loader for `@gajae-code/natives`.
 *
 * Owns every step between "Node imports `native/index.js`" and "the right
 * `pi_natives.<platform>-<arch>*.node` is required, validated, and returned":
 * platform/variant detection, candidate-path resolution, on-disk staging from
 * `node_modules` (Windows update safety), embedded-addon extraction (Bun
 * standalone binaries), version-sentinel validation, and the aggregated error
 * surface for diagnostic-friendly failures.
 *
 * `native/index.js` is reduced to one `loadNative()` call plus the generated
 * surface-area exports between `MARKER_START`/`MARKER_END` (rewritten by
 * `scripts/gen-enums.ts`); everything else lives here so the pure helpers stay
 * unit-testable without triggering the side-effectful module-load path.
 *
 * Background (issue #823): `bun build --compile --define PI_COMPILED=true`
 * substitutes the bare identifier `PI_COMPILED`, NOT `process.env.PI_COMPILED`,
 * so a runtime read of the env var returns `undefined`. Older CommonJS loader
 * code also saw the original build-host absolute path in `__filename`; ESM
 * `import.meta.url` is rewritten to the bunfs URL. The embedded-addon
 * presence (true iff the build pipeline ran `embed:native`, false in the
 * post-build `--reset` stub) is the authoritative compiled-mode signal.
 */

const SUPPORTED_PLATFORMS = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64", "win32-x64"];
const OPTIONAL_PACKAGE_BY_PLATFORM_TAG = {
	"darwin-arm64": "@gajae-code/natives-darwin-arm64",
	"darwin-x64": "@gajae-code/natives-darwin-x64",
	"linux-arm64": "@gajae-code/natives-linux-arm64",
	"linux-x64": "@gajae-code/natives-linux-x64",
	"win32-x64": "@gajae-code/natives-win32-x64",
};
const WINDOWS_GENERIC_READ = 0x80000000;
const WINDOWS_FILE_SHARE_READ = 0x00000001;
const WINDOWS_OPEN_EXISTING = 3;
const WINDOWS_FILE_ATTRIBUTE_NORMAL = 0x00000080;
let windowsKernel32;
const STAGED_CANDIDATE_ATTEMPT = Symbol("stagedCandidateAttempt");

class StagedCandidateChangedError extends Error {
	constructor(message = "staged addon changed before load") {
		super(message);
		this.name = "StagedCandidateChangedError";
	}
}

function getNativesDir() {
	const xdgDataHome = process.env.XDG_DATA_HOME;
	if (xdgDataHome && fs.existsSync(path.join(xdgDataHome, "gjc"))) {
		return path.join(xdgDataHome, "gjc", "natives");
	}
	return path.join(os.homedir(), ".gjc", "natives");
}

function safeFileSnapshot(file) {
	const stat = fs.lstatSync(file);
	if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("native addon path is not a regular file");
	const noFollow = fs.constants.O_NOFOLLOW ?? 0;
	const fd = fs.openSync(file, fs.constants.O_RDONLY | noFollow);
	try {
		const opened = fs.fstatSync(fd);
		if (!opened.isFile()) throw new Error("native addon path is not a regular file");
		const bytes = fs.readFileSync(fd);
		return {
			bytes,
			hash: createHash("sha256").update(bytes).digest("hex"),
			identity: `${opened.dev}:${opened.ino}:${opened.size}:${opened.mtimeMs}`,
		};
	} finally {
		fs.closeSync(fd);
	}
}

function safeDirectoryPath(directory) {
	const resolved = path.resolve(directory);
	const parsed = path.parse(resolved);
	let current = parsed.root;
	for (const part of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
		current = path.join(current, part);
		try {
			const stat = fs.lstatSync(current);
			if (stat.isSymbolicLink() || (!stat.isDirectory() && current !== resolved)) return false;
		} catch (error) {
			if (error?.code === "ENOENT") return true;
			return false;
		}
	}
	try {
		const stat = fs.lstatSync(resolved);
		return stat.isDirectory() && !stat.isSymbolicLink();
	} catch (error) {
		return error?.code === "ENOENT";
	}
}

function isMissingPathError(error) {
	return error?.code === "ENOENT" || error?.message === "ENOENT";
}

function stagedAddonPath(versionedDir, filename, hash) {
	return path.join(versionedDir, `.content-${hash}-${filename}`);
}

function rejectInstalledAddonFallbacks(ctx) {
	if (!Array.isArray(ctx.candidates)) return;
	ctx.candidates = [];
}

function recordStagedSnapshot(ctx, candidate, snapshot) {
	ctx.stagedCandidateSnapshots ??= new Map();
	ctx.stagedCandidateSnapshots.set(candidate, snapshot);
}

function recordStagedSourceSnapshot(ctx, candidate, sourcePath, snapshot) {
	ctx.stagedSourceSnapshots ??= new Map();
	ctx.stagedSourceSnapshots.set(candidate, { sourcePath, snapshot });
}

function validateStagedCandidate(ctx, candidate) {
	const expected = ctx.stagedCandidateSnapshots?.get(candidate);
	if (!expected) return;
	const current = safeFileSnapshot(candidate);
	if (current.hash !== expected.hash) throw new StagedCandidateChangedError();
	const source = ctx.stagedSourceSnapshots?.get(candidate);
	if (source) {
		const currentSource = safeFileSnapshot(source.sourcePath);
		if (currentSource.hash !== source.snapshot.hash) throw new StagedCandidateChangedError();
	}
}

function windowsKernel32Bindings() {
	if (windowsKernel32) return windowsKernel32;
	windowsKernel32 = dlopen("kernel32.dll", {
		CreateFileW: {
			args: ["ptr", "u32", "u32", "ptr", "u32", "u32", "i64"],
			returns: "i64",
		},
		CloseHandle: { args: ["i64"], returns: "u32" },
		GetLastError: { args: [], returns: "u32" },
	});
	return windowsKernel32;
}

/**
 * Hold a Windows read handle that denies write/delete sharing from validation
 * through pathname-based native loading. CreateFile's sharing check is
 * symmetric: acquisition also fails while any existing writer/deleter could
 * mutate or replace the staged file.
 */
function acquireStagedCandidateLease(candidate) {
	if (process.platform !== "win32") return () => {};
	const widePath = new Uint16Array(candidate.length + 1);
	for (let index = 0; index < candidate.length; index++) widePath[index] = candidate.charCodeAt(index);
	const kernel32 = windowsKernel32Bindings();
	const handle = kernel32.symbols.CreateFileW(
		ptr(widePath),
		WINDOWS_GENERIC_READ,
		WINDOWS_FILE_SHARE_READ,
		null,
		WINDOWS_OPEN_EXISTING,
		WINDOWS_FILE_ATTRIBUTE_NORMAL,
		0n,
	);
	if (handle === -1n) {
		throw new Error(`staged addon lease refused (win32=${kernel32.symbols.GetLastError()})`);
	}
	let released = false;
	return () => {
		if (released) return;
		released = true;
		if (kernel32.symbols.CloseHandle(handle) === 0)
			throw new Error(`staged addon lease release failed (win32=${kernel32.symbols.GetLastError()})`);
	};
}

// =========================================================================
// Pure helpers — re-exported for unit tests in `packages/natives/test/`.
// =========================================================================

/**
 * @param {{
 *   embeddedAddon: { platformTag: string; version: string; files: unknown[] } | null | undefined;
 *   env: Record<string, string | undefined>;
 *   importMetaUrl: string | null | undefined;
 * }} input
 * @returns {boolean}
 */
export function detectCompiledBinary({ embeddedAddon, env, importMetaUrl }) {
	if (embeddedAddon) return true;
	if (env && env.PI_COMPILED) return true;
	if (typeof importMetaUrl === "string") {
		if (importMetaUrl.includes("$bunfs")) return true;
		if (importMetaUrl.includes("~BUN")) return true;
		if (importMetaUrl.includes("%7EBUN")) return true;
	}
	return false;
}

/**
 * @param {{ tag: string; arch: string; variant: "modern" | "baseline" | null | undefined }} input
 * @returns {string[]}
 */
export function getAddonFilenames({ tag, arch, variant }) {
	const defaultFilename = `pi_natives.${tag}.node`;
	if (arch !== "x64" || !variant) return [defaultFilename];
	const baselineFilename = `pi_natives.${tag}-baseline.node`;
	const modernFilename = `pi_natives.${tag}-modern.node`;
	if (variant === "modern") {
		return [modernFilename, baselineFilename, defaultFilename];
	}
	return [baselineFilename, defaultFilename];
}

/**
 * @param {string} platformTag
 * @returns {string[]}
 */
export function getOptionalPackageNames(platformTag) {
	const packageName = OPTIONAL_PACKAGE_BY_PLATFORM_TAG[platformTag];
	return packageName ? [packageName] : [];
}

/**
 * @param {{ packageNames: string[]; requireResolve: (id: string) => string }} input
 * @returns {string[]}
 */
export function resolveOptionalPackageNativeDirs({ packageNames, requireResolve }) {
	const dirs = [];
	for (const packageName of packageNames) {
		try {
			const manifestPath = requireResolve(`${packageName}/package.json`);
			dirs.push(path.join(path.dirname(manifestPath), "native"));
		} catch {
			// Optional dependency is absent on non-matching platforms or older installs.
		}
	}
	return dirs;
}

/**
 * Decide whether the loader should snapshot installed package addons into the
 * per-version cache directory (`~/.gjc/natives/<version>/`) before loading.
 *
 * Windows-only safety net for `bun install -g` updates: when a previous `gjc`
 * process is running, bun cannot overwrite the locked `.node` inside
 * `node_modules/@gajae-code/natives/native/`, leaving an old binary next to a
 * newer `index.js` and producing `<sym> is not a function` crashes on the next
 * launch. Content-addressed staging gives each byte set its own immutable path,
 * so concurrent gjc processes never collide and bun can overwrite the
 * `node_modules` copy on subsequent updates.
 * Disabled on non-Windows (no file-lock problem), in workspace dev (`nativeDir`
 * is not inside a `node_modules` segment), and for compiled binaries (handled
 * by `maybeExtractEmbeddedAddon`).
 *
 * @param {{ platform: NodeJS.Platform | string; isCompiledBinary: boolean; nativeDir: string }} input
 * @returns {boolean}
 */
export function shouldStageNodeModulesAddon({ platform, isCompiledBinary, nativeDir }) {
	if (platform !== "win32") return false;
	if (isCompiledBinary) return false;
	// Check both separators independently of the host's `path.sep`: this helper
	// is shared by the loader (running on Windows with `\`) and the test suite
	// (typically running on POSIX hosts when CI executes the regression test).
	return nativeDir.includes("\\node_modules\\") || nativeDir.includes("/node_modules/");
}

/**
 * @param {{
 *   addonFilenames: string[];
 *   isCompiledBinary: boolean;
 *   stageFromNodeModules?: boolean;
 *   isWorkspaceLoad?: boolean;
 *   optionalPackageNativeDirs?: string[];
 *   nativeDir: string;
 *   execDir: string;
 *   versionedDir: string;
 *   userDataDir: string;
 * }} input
 * @returns {string[]}
 */
export function resolveLoaderCandidates({
	addonFilenames,
	isCompiledBinary,
	stageFromNodeModules = false,
	isWorkspaceLoad = false,
	optionalPackageNativeDirs = [],
	nativeDir,
	execDir,
	versionedDir,
	userDataDir,
}) {
	const workspaceCandidates = addonFilenames.map(filename => path.join(nativeDir, filename));
	const optionalPackageCandidates = optionalPackageNativeDirs.flatMap(optionalNativeDir =>
		addonFilenames.map(filename => path.join(optionalNativeDir, filename)),
	);
	const legacyReleaseCandidates = addonFilenames.flatMap(filename => [
		path.join(nativeDir, filename),
		path.join(execDir, filename),
	]);
	const legacyExecCandidates = addonFilenames.map(filename => path.join(execDir, filename));
	const baseReleaseCandidates = isWorkspaceLoad
		? [...workspaceCandidates, ...optionalPackageCandidates, ...legacyExecCandidates]
		: [...optionalPackageCandidates, ...legacyReleaseCandidates];
	const compiledCandidates = addonFilenames.flatMap(filename => [
		path.join(versionedDir, filename),
		path.join(userDataDir, filename),
	]);
	let releaseCandidates;
	if (isCompiledBinary) {
		releaseCandidates = [...compiledCandidates, ...baseReleaseCandidates];
	} else releaseCandidates = baseReleaseCandidates;
	// Staged paths are content-addressed and therefore cannot be resolved until
	// the current package bytes have been snapshotted. `loadNative()` prepends
	// those paths after staging; never synthesize the retired fixed cache path.
	void stageFromNodeModules;
	return [...new Set(releaseCandidates)];
}

/**
 * Deterministically try candidate paths in order using injected operations.
 * This leaves file loading and compatibility policy at the call site while
 * making fallback behavior testable without a native addon on disk.
 *
 * @template T
 * @param {{
 *   candidates: string[];
 *   requireCandidate: (candidate: string) => T;
 *   validateCandidate: (bindings: T, candidate: string) => void;
 *   describeCandidate: (candidate: string) => string;
 * }} input
 * @returns {{ bindings: T | null; errors: string[] }}
 */
export function loadFromCandidates({ candidates, requireCandidate, validateCandidate, describeCandidate }) {
	const errors = [];
	for (const candidate of candidates) {
		let attempt;
		try {
			attempt = requireCandidate(candidate);
			const bindings = attempt?.[STAGED_CANDIDATE_ATTEMPT] ? attempt.bindings : attempt;
			validateCandidate(bindings, candidate);
			return { bindings, errors };
		} catch (err) {
			if (err instanceof StagedCandidateChangedError) throw err;
			const message = err instanceof Error ? err.message : String(err);
			errors.push(`${describeCandidate(candidate)}: ${message}`);
		} finally {
			try {
				if (attempt?.[STAGED_CANDIDATE_ATTEMPT]) attempt.release();
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				throw new StagedCandidateChangedError(`staged addon lease release failed: ${message}`);
			}
		}
	}
	return { bindings: null, errors };
}

/**
 * Decide whether a previously extracted embedded addon may be reused. A cached
 * extraction from an earlier build of the same version carries the same version
 * sentinel yet can expose a different native surface, so it is fresh only when
 * its byte size matches the embedded payload. `sizeOf` returns the byte size of
 * a path, or `null` when it cannot be inspected.
 * @param {{ targetPath: string; embeddedPath: string; sizeOf: (path: string) => number | null; isSafe?: (path: string) => boolean }} input
 * @returns {boolean}
 */
export function cachedEmbeddedExtractionIsFresh({ targetPath, embeddedPath, sizeOf, isSafe = () => true }) {
	if (!isSafe(targetPath)) return false;
	const cachedSize = sizeOf(targetPath);
	if (cachedSize === null) return false;
	const embeddedSize = sizeOf(embeddedPath);
	if (embeddedSize === null) return false;
	return cachedSize === embeddedSize;
}

// =========================================================================
// Side-effectful loader. Everything below runs only when `loadNative()` is
// called from `native/index.js` — tests that only import the pure helpers
// above pay nothing for variant detection, subprocess spawns, or fs probes.
// =========================================================================

// Keep the synchronous fallback below Bun's default 5 s test budget. The
// remaining margin covers spawnSync's return path after the kill is delivered
// and prevents a wedged PowerShell process from starving native loading.
const WIN32_AVX2_PROBE_TIMEOUT_MS = 4_000;
const WIN32_AVX2_PROBE_MAX_BUFFER = 4 * 1024;
const WIN32_AVX2_PROBE_WARNING_CODE = "GJC_WIN32_AVX2_PROBE";

function emitWin32Avx2ProbeDiagnostic(kind) {
	process.emitWarning(`Windows AVX2 probe inconclusive (${kind}); using baseline variant.`, {
		code: WIN32_AVX2_PROBE_WARNING_CODE,
	});
}

function spawnFailureDiagnostic(result) {
	if (result.error?.code === "ETIMEDOUT" || result.signal === "SIGKILL") return "timeout";
	if (result.error) return "spawn_error";
	if (result.status !== 0) return "nonzero_exit";
	return "non_decisive_output";
}

function runCommand(command, args, report) {
	try {
		// `windowsHide` keeps probes console-less: from a detached, console-less
		// parent (e.g. the SDK broker) spawning a console app like powershell.exe
		// would otherwise allocate and flash a visible console window per call
		// (#4652). It is ignored on POSIX.
		const result = childProcess.spawnSync(command, args, {
			encoding: "utf-8",
			windowsHide: true,
			timeout: WIN32_AVX2_PROBE_TIMEOUT_MS,
			killSignal: "SIGKILL",
			maxBuffer: WIN32_AVX2_PROBE_MAX_BUFFER,
		});
		if (result.error || result.status !== 0) {
			report?.(spawnFailureDiagnostic(result));
			return null;
		}
		return (result.stdout || "").trim();
	} catch {
		report?.("spawn_error");
		return null;
	}
}

// `IsProcessorFeaturePresent(PF_AVX2_INSTRUCTIONS_AVAILABLE)` — the kernel's
// authoritative AVX2 answer (also honors OS emulation policy), usable without
// a subprocess on every supported Windows build.
const WIN32_PF_AVX2_INSTRUCTIONS_AVAILABLE = 40;

// In-process `kernel32.dll!IsProcessorFeaturePresent` probe. Returns undefined
// when it cannot run (non-Bun runtime, FFI unavailable, or call failure) so the
// caller can fall back to a hidden PowerShell probe.
function probeWin32Avx2InProcess() {
	if (typeof Bun === "undefined") return undefined;
	try {
		// Not a static import: loader-state is plain JS that must also parse
		// under Node, where "bun:ffi" does not exist.
		const { dlopen } = createRequire(import.meta.url)("bun:ffi");
		const kernel32 = dlopen("kernel32.dll", {
			IsProcessorFeaturePresent: { args: ["i32"], returns: "bool" },
		});
		return Boolean(kernel32.symbols.IsProcessorFeaturePresent(WIN32_PF_AVX2_INSTRUCTIONS_AVAILABLE));
	} catch {
		return undefined;
	}
}

// Hidden PowerShell fallback. `Add-Type` P/Invoke works on both stock Windows
// PowerShell 5.1 (.NET Framework, which has no System.Runtime.Intrinsics) and
// pwsh 7+. Any probe failure fails safe to `false` (baseline variant).
function probeWin32Avx2ViaPowerShell(run = runCommand, report = emitWin32Avx2ProbeDiagnostic) {
	const output = run("powershell.exe", [
		"-NoProfile",
		"-NonInteractive",
		"-Command",
		"Add-Type -Namespace GjcNative -Name Cpu -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern bool IsProcessorFeaturePresent(int feature);'; " +
			`[GjcNative.Cpu]::IsProcessorFeaturePresent(${WIN32_PF_AVX2_INSTRUCTIONS_AVAILABLE})`,
	], report);
	if (output === null) return false;
	const normalized = output.toLowerCase();
	if (normalized === "true") return true;
	if (normalized === "false") return false;
	report("non_decisive_output");
	return false;
}

export function detectWin32Avx2Support(
	probe = probeWin32Avx2InProcess,
	run = runCommand,
	report = emitWin32Avx2ProbeDiagnostic,
) {
	const probed = probe();
	if (probed !== undefined) return probed;
	return probeWin32Avx2ViaPowerShell(run, report);
}

function getVariantOverride() {
	const value = process.env.PI_NATIVE_VARIANT;
	if (!value) return null;
	if (value === "modern" || value === "baseline") return value;
	return null;
}

function detectAvx2Support() {
	if (process.arch !== "x64") {
		return false;
	}

	if (process.platform === "linux") {
		try {
			const cpuInfo = fs.readFileSync("/proc/cpuinfo", "utf8");
			return /\bavx2\b/i.test(cpuInfo);
		} catch {
			return false;
		}
	}

	if (process.platform === "darwin") {
		const leaf7 = runCommand("sysctl", ["-n", "machdep.cpu.leaf7_features"]);
		if (leaf7 && /\bAVX2\b/i.test(leaf7)) {
			return true;
		}
		const features = runCommand("sysctl", ["-n", "machdep.cpu.features"]);
		return Boolean(features && /\bAVX2\b/i.test(features));
	}

	if (process.platform === "win32") {
		return detectWin32Avx2Support();
	}

	return false;
}

function resolveCpuVariant(override) {
	if (process.arch !== "x64") return null;
	if (override) return override;
	return detectAvx2Support() ? "modern" : "baseline";
}

function embeddedAddonCandidates(selectedVariant) {
	if (!embeddedAddon) return [];
	const files = embeddedAddon.files;
	const candidates = process.arch !== "x64"
		? [files.find(file => file.variant === "default"), ...files]
		: selectedVariant === "modern"
			? [files.find(file => file.variant === "modern"), files.find(file => file.variant === "baseline")]
			: [files.find(file => file.variant === "baseline")];
	return [...new Set(candidates.filter(Boolean))];
}

function maybeExtractEmbeddedAddons(ctx, errors) {
	if (!ctx.isCompiledBinary || !embeddedAddon) return [];
	if (embeddedAddon.platformTag !== ctx.platformTag || embeddedAddon.version !== ctx.packageVersion) return [];

	const extracted = [];
	for (const embeddedFile of embeddedAddonCandidates(ctx.selectedVariant)) {
		const targetPath = path.join(ctx.versionedDir, embeddedFile.filename);
		if (fs.existsSync(targetPath)) {
			try {
				const cachedIdentity = fs.lstatSync(targetPath);
				const cachedStat = fs.statSync(targetPath);
				if (cachedIdentity.isSymbolicLink() || !cachedIdentity.isFile() || cachedStat.nlink !== 1) {
					fs.unlinkSync(targetPath);
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				errors.push(`embedded addon cache (${embeddedFile.filename}): ${message}`);
				continue;
			}
		}
		if (fs.existsSync(targetPath)) {
			// Guard against intra-version drift: a cached extraction written by an earlier
			// build of the same version carries the same version sentinel but can expose a
			// different native surface (e.g. a symbol added mid-cycle). The embedded addon
			// is the source of truth, so reuse the cached file only when it matches the
			// embedded payload size and re-extract otherwise.
			const sizeOf = candidate => {
				try {
					const identity = fs.lstatSync(candidate);
					const stat = fs.statSync(candidate);
					if (identity.isSymbolicLink() || !identity.isFile() || stat.nlink !== 1) return null;
					return stat.size;
				} catch {
					return null;
				}
			};
			if (cachedEmbeddedExtractionIsFresh({ targetPath, embeddedPath: embeddedFile.filePath, sizeOf })) {
				extracted.push(targetPath);
				continue;
			}
		}

		try {
			fs.mkdirSync(ctx.versionedDir, { recursive: true });
			const buffer = fs.readFileSync(embeddedFile.filePath);
			const tempPath = `${targetPath}.tmp.${process.pid}`;
			fs.writeFileSync(tempPath, buffer);
			fs.renameSync(tempPath, targetPath);
			extracted.push(targetPath);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			errors.push(`embedded addon write (${embeddedFile.filename}): ${message}`);
		}
	}
	return extracted;
}

/**
 * Publish one verified package snapshot under a content-addressed name. The
 * destination is created with a no-replace hard link, so concurrent creators
 * either reuse the byte-identical winner or fail closed without overwriting it.
 */
function publishStagedAddon(ctx, filename, sourcePath, sourceSnapshot) {
	const versionedDir = typeof ctx.versionedDir === "string" ? ctx.versionedDir : null;
	if (!versionedDir) throw new Error("staged addon context is incomplete");
	if (!safeDirectoryPath(versionedDir)) throw new Error("staged addon directory is not safe");
	try {
		fs.mkdirSync(versionedDir, { recursive: true });
	} catch (error) {
		throw new Error(`staged addon directory: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!safeDirectoryPath(versionedDir)) throw new Error("staged addon directory is not safe");

	const targetPath = stagedAddonPath(versionedDir, filename, sourceSnapshot.hash);
	try {
		const winner = safeFileSnapshot(targetPath);
		if (winner.hash !== sourceSnapshot.hash) throw new Error("staged addon drift: winner contains different bytes");
		recordStagedSnapshot(ctx, targetPath, winner);
		recordStagedSourceSnapshot(ctx, targetPath, sourcePath, sourceSnapshot);
		return targetPath;
	} catch (error) {
		if (!isMissingPathError(error)) throw error;
	}

	const temporaryPath = `${targetPath}.tmp-${process.pid}-${randomUUID()}`;
	const noFollow = fs.constants.O_NOFOLLOW ?? 0;
	let fd;
	try {
		fd = fs.openSync(
			temporaryPath,
			fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow,
			0o600,
		);
		fs.writeFileSync(fd, sourceSnapshot.bytes);
		fs.fsyncSync(fd);
		fs.closeSync(fd);
		fd = undefined;

		try {
			// A hard link publishes the complete temporary file atomically and
			// fails with EEXIST rather than replacing a concurrent winner.
			fs.linkSync(temporaryPath, targetPath);
		} catch (publishError) {
			const code = publishError && typeof publishError === "object" ? publishError.code : undefined;
			if (code === "EPERM" || code === "ENOTSUP" || code === "EOPNOTSUPP") {
				try {
					fs.copyFileSync(temporaryPath, targetPath, fs.constants.COPYFILE_EXCL);
				} catch (copyError) {
					const copyCode = copyError && typeof copyError === "object" ? copyError.code : undefined;
					if (copyCode !== "EEXIST") throw copyError;
				}
				if (fs.existsSync(targetPath)) {
					const staged = safeFileSnapshot(targetPath);
					if (staged.hash !== sourceSnapshot.hash)
						throw new Error("staged addon drift: winner contains different bytes");
					recordStagedSnapshot(ctx, targetPath, staged);
					recordStagedSourceSnapshot(ctx, targetPath, sourcePath, sourceSnapshot);
					return targetPath;
				}
				throw publishError;
			}
			try {
				const winner = safeFileSnapshot(targetPath);
				if (winner.hash !== sourceSnapshot.hash)
					throw new Error("staged addon drift: winner contains different bytes");
				recordStagedSnapshot(ctx, targetPath, winner);
				recordStagedSourceSnapshot(ctx, targetPath, sourcePath, sourceSnapshot);
				return targetPath;
			} catch (winnerError) {
				if (!isMissingPathError(winnerError)) throw winnerError;
				throw publishError;
			}
		}

		const staged = safeFileSnapshot(targetPath);
		if (staged.hash !== sourceSnapshot.hash) throw new Error("staged addon drift: bytes do not match source snapshot");
		recordStagedSnapshot(ctx, targetPath, staged);
		recordStagedSourceSnapshot(ctx, targetPath, sourcePath, sourceSnapshot);
		return targetPath;
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
		try {
			fs.unlinkSync(temporaryPath);
		} catch {}
	}
}

/**
 * Stage every current installed-package addon in variant order. The source
 * snapshot is captured once per package path and reused for publication;
 * immutable winners are retained for other processes and launches.
 */
export function maybeStageNodeModulesAddon(ctx, errors) {
	if (!ctx.stageFromNodeModules || ctx.isCompiledBinary || !ctx.platformTag?.startsWith("win32-")) return [];
	const versionedDir = typeof ctx.versionedDir === "string" ? ctx.versionedDir : null;
	const addonFilenames = Array.isArray(ctx.addonFilenames) ? ctx.addonFilenames : [];
	const optionalPackageNativeDirs = Array.isArray(ctx.optionalPackageNativeDirs)
		? ctx.optionalPackageNativeDirs.filter(directory => typeof directory === "string")
		: [];
	const nativeDir = typeof ctx.nativeDir === "string" ? ctx.nativeDir : null;
	if (!versionedDir || addonFilenames.length === 0 || (!nativeDir && optionalPackageNativeDirs.length === 0)) {
		errors.push("staged addon context is incomplete");
		return [];
	}

	const sourceDirs = [...optionalPackageNativeDirs, ...(nativeDir ? [nativeDir] : [])];
	const sourceSnapshots = new Map();
	const stagedCandidates = [];
	for (const filename of addonFilenames) {
		let sourcePath = null;
		let sourceSnapshot = null;
		let sourceError = null;
		for (const sourceDir of sourceDirs) {
			const candidate = path.join(sourceDir, filename);
			try {
				sourcePath = candidate;
				sourceSnapshot = sourceSnapshots.get(candidate) ?? safeFileSnapshot(candidate);
				sourceSnapshots.set(candidate, sourceSnapshot);
				break;
			} catch (error) {
				if (isMissingPathError(error)) continue;
				sourcePath = candidate;
				sourceError = error;
				break;
			}
		}
		if (!sourcePath) continue;

		// Once an installed artifact has been selected for staging, its direct
		// pathname is no longer a fallback. This also covers drift and partial
		// winners, which must fail closed rather than execute an unverified file.
		rejectInstalledAddonFallbacks(ctx);
		if (sourceError || !sourceSnapshot) {
			const message = sourceError instanceof Error ? sourceError.message : String(sourceError ?? "unavailable");
			errors.push(`staged addon source (${filename}): ${message}`);
			continue;
		}

		try {
			stagedCandidates.push(publishStagedAddon(ctx, filename, sourcePath, sourceSnapshot));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			errors.push(`staged addon publish (${filename}): ${message}`);
		}
	}
	return stagedCandidates;
}

export function validateLoadedBindings(ctx, bindings, candidate) {
	if (typeof bindings[ctx.versionSentinelExport] !== "function") {
		throw new Error(
			`Loaded ${candidate} but it does not expose the @gajae-code/natives@${ctx.packageVersion} ` +
				`version sentinel \`${ctx.versionSentinelExport}\`. The .node file on disk is from a different ` +
				"release than this loader — reinstall to re-sync.",
		);
	}
	if (typeof bindings.__piNativesPublishOutcomeV1 !== "function") {
		throw new Error(
			`Loaded ${candidate} but it lacks retained-publish capability sentinel ` +
			"`__piNativesPublishOutcomeV1`; trying the next compatible artifact.",
		);
	}
	if (typeof bindings.secureWriteSkillFile !== "function") {
		throw new Error(
			`Loaded ${candidate} but it lacks required secure skill publication capability ` +
			"`secureWriteSkillFile`; trying the next compatible artifact.",
		);
	}
	if (typeof bindings.renameNoReplacePath !== "function") {
		throw new Error(`Loaded ${candidate} but it lacks required atomic publish capability \`renameNoReplacePath\`.`);
	}
	if (typeof bindings.probeWindowsJobMemory !== "function") {
		throw new Error(`Loaded ${candidate} but it lacks required memory probe capability \`probeWindowsJobMemory\`.`);
	}
	if (typeof bindings.currentExecutablePath !== "function") {
		throw new Error(`Loaded ${candidate} but it lacks required executable identity capability \`currentExecutablePath\`.`);
	}
}

function buildHelpMessage(ctx) {
	if (ctx.isCompiledBinary) {
		const expectedPaths = ctx.addonFilenames.map(filename => `  ${path.join(ctx.versionedDir, filename)}`).join("\n");
		const downloadHints = ctx.addonFilenames
			.map(filename => {
				const downloadUrl = `https://github.com/Yeachan-Heo/gajae-code/releases/latest/download/${filename}`;
				const targetPath = path.join(ctx.versionedDir, filename);
				return `  curl -fsSL "${downloadUrl}" -o "${targetPath}"`;
			})
			.join("\n");
		return (
			`The compiled binary should extract one of:\n${expectedPaths}\n\n` +
			`If missing, delete ${ctx.versionedDir} and re-run, or download manually:\n${downloadHints}`
		);
	}
	return (
		"If installed via npm/bun, try reinstalling: bun install @gajae-code/natives\n" +
		"If developing locally, build with: bun --cwd=packages/natives run build\n" +
		"Optional x64 variants: TARGET_VARIANT=baseline|modern bun --cwd=packages/natives run build"
	);
}

/**
 * Initialize the loader context: resolves every path, variant, and policy
 * decision once so the inner load loop stays a pure require/validate pipeline.
 * Called from `loadNative()` rather than at module scope so importing pure
 * helpers from this file doesn't trigger AVX2 detection or filesystem probes.
 */
function initLoaderContext(require_) {
	const platformTag = `${process.platform}-${process.arch}`;
	const packageVersion = packageJson.version;
	const nativeDir = path.join(import.meta.dir, "..", "native");
	const execDir = path.dirname(process.execPath);
	const versionedDir = path.join(getNativesDir(), packageVersion);
	const userDataDir =
		process.platform === "win32"
			? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "gjc")
			: path.join(os.homedir(), ".local", "bin");

	const isCompiledBinary = detectCompiledBinary({
		embeddedAddon,
		env: process.env,
		importMetaUrl: import.meta.url,
	});
	const stageFromNodeModules = shouldStageNodeModulesAddon({
		platform: process.platform,
		isCompiledBinary,
		nativeDir,
	});
	const isWorkspaceLoad =
		!isCompiledBinary && !nativeDir.includes("\\node_modules\\") && !nativeDir.includes("/node_modules/");

	const selectedVariant = resolveCpuVariant(getVariantOverride());
	const addonFilenames = getAddonFilenames({ tag: platformTag, arch: process.arch, variant: selectedVariant });
	const addonLabel = selectedVariant ? `${platformTag} (${selectedVariant})` : platformTag;
	const optionalPackageNativeDirs = resolveOptionalPackageNativeDirs({
		packageNames: getOptionalPackageNames(platformTag),
		requireResolve: id => require_.resolve(id),
	});


	const candidates = resolveLoaderCandidates({
		addonFilenames,
		isCompiledBinary,
		stageFromNodeModules,
		isWorkspaceLoad,
		optionalPackageNativeDirs,
		nativeDir,
		execDir,
		versionedDir,
		userDataDir,
	});

	// Version sentinel emitted by the Rust addon under a `js_name` that encodes
	// the package version (`__piNativesV{major}_{minor}_{patch}`).
	// `scripts/release.ts` bumps the name in `crates/pi-natives/src/lib.rs` in
	// lock-step with the version, so a `.node` from a different release
	// physically cannot expose the symbol this loader is looking for. That
	// turns the silent `<sym> is not a function` crash from a Windows
	// locked-file update into an actionable load-time error.
	const versionSentinelExport = `__piNativesV${packageVersion.replace(/[^A-Za-z0-9]/g, "_")}`;

	return {
		platformTag,
		packageVersion,
		nativeDir,
		versionedDir,
		isCompiledBinary,
		stageFromNodeModules,
		selectedVariant,
		addonFilenames,
		optionalPackageNativeDirs,
		addonLabel,
		candidates,
		versionSentinelExport,
	};
}

/** Embedded standalone payloads are the complete trust boundary for their matching build. */
export function embeddedAddonIsAuthoritative(ctx, addon = embeddedAddon) {
	return (
		ctx.isCompiledBinary && addon?.platformTag === ctx.platformTag && addon.version === ctx.packageVersion
	);
}

export function loadNative(options = {}) {
	const require_ = options.requireCandidate ? null : createRequire(import.meta.url);
	const ctx = options.context ?? initLoaderContext(require_);

	const errors = [];
	const embeddedCandidates = (options.extractEmbeddedAddons ?? maybeExtractEmbeddedAddons)(ctx, errors);
	const embeddedIsAuthoritative = embeddedAddonIsAuthoritative(ctx);
	const stagedResult =
		embeddedCandidates.length > 0 || embeddedIsAuthoritative
			? []
			: (options.stageNodeModulesAddon ?? maybeStageNodeModulesAddon)(ctx, errors);
	const stagedCandidates = Array.isArray(stagedResult)
		? stagedResult.filter(candidate => typeof candidate === "string")
		: typeof stagedResult === "string"
			? [stagedResult]
			: [];
	const prepended = [...embeddedCandidates, ...stagedCandidates];
	const baseCandidates = Array.isArray(ctx.candidates) ? ctx.candidates : [];
	const runtimeCandidates = embeddedIsAuthoritative
		? prepended
		: prepended.length > 0
			? [...prepended, ...baseCandidates]
			: baseCandidates;
	const loaded = loadFromCandidates({
		candidates: runtimeCandidates,
		requireCandidate: candidate => {
			let releaseLease;
			if (ctx.stagedCandidateSnapshots?.has(candidate)) {
				try {
					releaseLease = (options.acquireStagedCandidateLease ?? acquireStagedCandidateLease)(candidate);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					throw new StagedCandidateChangedError(`staged addon lease unavailable: ${message}`);
				}
			}
			try {
				validateStagedCandidate(ctx, candidate);
				const bindings = options.requireCandidate ? options.requireCandidate(candidate) : require_(candidate);
				return releaseLease ? { [STAGED_CANDIDATE_ATTEMPT]: true, bindings, release: releaseLease } : bindings;
			} catch (error) {
				releaseLease?.();
				throw error;
			}
		},
		validateCandidate: options.validateCandidate ?? ((bindings, candidate) => validateLoadedBindings(ctx, bindings, candidate)),
		describeCandidate: candidate => candidate,
	});
	if (loaded.bindings) return loaded.bindings;
	errors.push(...loaded.errors);

	if (!SUPPORTED_PLATFORMS.includes(ctx.platformTag)) {
		throw new Error(
			`Unsupported platform: ${ctx.platformTag}\n` +
				`Supported platforms: ${SUPPORTED_PLATFORMS.join(", ")}\n` +
				"If you need support for this platform, please open an issue.",
		);
	}
	const details = errors.map(error => `- ${error}`).join("\n");
	throw new Error(
		`Failed to load pi_natives native addon for ${ctx.addonLabel}.\n\nTried:\n${details}\n\n${buildHelpMessage(ctx)}`,
	);
}
