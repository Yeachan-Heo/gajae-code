import * as childProcess from "node:child_process";
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


function getNativesDir() {
	const xdgDataHome = process.env.XDG_DATA_HOME;
	if (xdgDataHome && fs.existsSync(path.join(xdgDataHome, "gjc"))) {
		return path.join(xdgDataHome, "gjc", "natives");
	}
	return path.join(os.homedir(), ".gjc", "natives");
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
 * Decide whether the loader should mirror the package's `native/<filename>.node`
 * into the per-version cache directory (`~/.gjc/natives/<version>/`) before loading.
 *
 * Windows-only safety net for `bun install -g` updates: when a previous `gjc`
 * process is running, bun cannot overwrite the locked `.node` inside
 * `node_modules/@gajae-code/natives/native/`, leaving an old binary next to a
 * newer `index.js` and producing `<sym> is not a function` crashes on the next
 * launch. Staging into the version-pinned cache:
 *   1. Gives every package version its own filesystem path, so concurrent gjc
 *      processes never collide on the same file.
 *   2. Makes the running process keep its handle on the cache copy, freeing bun
 *      to overwrite the `node_modules` copy on subsequent updates.
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
	const stagedCandidates = stageFromNodeModules ? addonFilenames.map(filename => path.join(versionedDir, filename)) : [];
	let releaseCandidates;
	if (isCompiledBinary) {
		releaseCandidates = [...compiledCandidates, ...baseReleaseCandidates];
	} else if (stageFromNodeModules) {
		releaseCandidates = [...stagedCandidates, ...baseReleaseCandidates];
	} else {
		releaseCandidates = baseReleaseCandidates;
	}
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
		try {
			const bindings = requireCandidate(candidate);
			validateCandidate(bindings, candidate);
			return { bindings, errors };
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			errors.push(`${describeCandidate(candidate)}: ${message}`);
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
 * @param {{ targetPath: string; embeddedPath: string; sizeOf: (path: string) => number | null }} input
 * @returns {boolean}
 */
export function cachedEmbeddedExtractionIsFresh({ targetPath, embeddedPath, sizeOf }) {
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

function runCommand(command, args) {
	try {
		const result = childProcess.spawnSync(command, args, { encoding: "utf-8" });
		if (result.error) return null;
		if (result.status !== 0) return null;
		return (result.stdout || "").trim();
	} catch {
		return null;
	}
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
		const output = runCommand("powershell.exe", [
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			"[System.Runtime.Intrinsics.X86.Avx2]::IsSupported",
		]);
		return output && output.toLowerCase() === "true";
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
			// Guard against intra-version drift: a cached extraction written by an earlier
			// build of the same version carries the same version sentinel but can expose a
			// different native surface (e.g. a symbol added mid-cycle). The embedded addon
			// is the source of truth, so reuse the cached file only when it matches the
			// embedded payload size and re-extract otherwise.
			const sizeOf = candidate => {
				try {
					return fs.statSync(candidate).size;
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
 * Mirror the optional-package or legacy bundled `native/<filename>.node` into
 * `versionedDir/<filename>.node` on Windows installs so the running process
 * keeps its OS-level handle on a versioned cache path, never on the
 * `node_modules` copy that bun must overwrite on update. No-op on non-Windows,
 * in workspace dev, and for compiled binaries — see `shouldStageNodeModulesAddon`.
 */
function maybeStageNodeModulesAddon(ctx, errors) {
	if (!ctx.stageFromNodeModules) return null;

	let stagedPath = null;
	const sourceDirs = [...ctx.optionalPackageNativeDirs, ctx.nativeDir];
	for (const filename of ctx.addonFilenames) {
		const targetPath = path.join(ctx.versionedDir, filename);

		if (fs.existsSync(targetPath)) {
			stagedPath = stagedPath || targetPath;
			continue;
		}
		const sourcePath = sourceDirs.map(sourceDir => path.join(sourceDir, filename)).find(candidate => fs.existsSync(candidate));
		if (!sourcePath) continue;

		try {
			fs.mkdirSync(ctx.versionedDir, { recursive: true });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			errors.push(`staged addon dir: ${message}`);
			continue;
		}

		try {
			// `copyFileSync` is atomic on Windows (CopyFileW) and avoids holding
			// two large buffers in JS for the read/write dance.
			fs.copyFileSync(sourcePath, targetPath);
			stagedPath = stagedPath || targetPath;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			errors.push(`staged addon copy (${filename}): ${message}`);
		}
	}
	return stagedPath;
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
	if (typeof bindings.renameNoReplacePath !== "function") {
		throw new Error(`Loaded ${candidate} but it lacks required atomic publish capability \`renameNoReplacePath\`.`);
	}
	if (typeof bindings.probeWindowsJobMemory !== "function") {
		throw new Error(`Loaded ${candidate} but it lacks required memory probe capability \`probeWindowsJobMemory\`.`);
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
	const stagedCandidate =
		embeddedCandidates.length > 0 || embeddedIsAuthoritative
			? null
			: (options.stageNodeModulesAddon ?? maybeStageNodeModulesAddon)(ctx, errors);
	const prepended = [...embeddedCandidates, stagedCandidate].filter(c => typeof c === "string");
	const runtimeCandidates = embeddedIsAuthoritative ? prepended : prepended.length > 0 ? [...prepended, ...ctx.candidates] : ctx.candidates;
	const loaded = loadFromCandidates({
		candidates: runtimeCandidates,
		requireCandidate: options.requireCandidate ?? (candidate => require_(candidate)),
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
