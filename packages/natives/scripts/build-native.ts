import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $ } from "bun";
import { detectHostAvx2Support } from "../../../scripts/host-detect";
import { generateEnumExports } from "./gen-enums";

const repoRoot = path.join(import.meta.dir, "../../..");
const rustDir = path.join(repoRoot, "crates/pi-natives");
const nativeDir = path.join(import.meta.dir, "../native");
const packageJsonPath = path.join(import.meta.dir, "../package.json");

const crossTarget = Bun.env.CROSS_TARGET;
const targetPlatform = Bun.env.TARGET_PLATFORM || process.platform;
const targetArch = Bun.env.TARGET_ARCH || process.arch;
const configuredVariantRaw = Bun.env.TARGET_VARIANT;
const isCrossCompile = Boolean(crossTarget) || targetPlatform !== process.platform || targetArch !== process.arch;
const languageSet = Bun.env.PI_NATIVE_FULL_LANGS === "1" ? "full" : "default";

type X64Variant = "modern" | "baseline";

let configuredVariant: X64Variant | undefined;
if (configuredVariantRaw) {
	if (targetArch !== "x64") {
		throw new Error(`TARGET_VARIANT is only supported for x64 builds, got ${targetPlatform}-${targetArch}.`);
	}
	if (configuredVariantRaw !== "modern" && configuredVariantRaw !== "baseline") {
		throw new Error(`Unsupported TARGET_VARIANT: ${configuredVariantRaw}. Expected "modern" or "baseline".`);
	}
	configuredVariant = configuredVariantRaw;
}

function resolveEffectiveVariant(): X64Variant | null {
	if (targetArch !== "x64") return null;
	if (configuredVariant) return configuredVariant;
	if (isCrossCompile) {
		throw new Error("x64 cross-builds require TARGET_VARIANT=modern or TARGET_VARIANT=baseline.");
	}
	return detectHostAvx2Support() ? "modern" : "baseline";
}
const effectiveVariant = resolveEffectiveVariant();
const variantSuffix = effectiveVariant ? `-${effectiveVariant}` : "";

// Pin Rust target-cpu so x64 baseline/modern variants get a reproducible ISA floor
// instead of inheriting the host CPU when RUSTFLAGS is unset.
if (!isCrossCompile && !Bun.env.RUSTFLAGS) {
	if (effectiveVariant === "modern") {
		Bun.env.RUSTFLAGS = "-C target-cpu=x86-64-v3";
	} else if (effectiveVariant === "baseline") {
		Bun.env.RUSTFLAGS = "-C target-cpu=x86-64-v2";
	} else {
		Bun.env.RUSTFLAGS = "-C target-cpu=native";
	}
}

async function cleanupStaleTemps(dir: string): Promise<void> {
	try {
		const entries = await fs.readdir(dir);
		for (const entry of entries) {
			if (entry.includes(".tmp.") || entry.includes(".old.") || entry.includes(".new.")) {
				await fs.unlink(path.join(dir, entry)).catch(() => {});
			}
		}
	} catch {
		// Directory might not exist yet
	}
}

async function installBinary(src: string, dest: string): Promise<void> {
	const tempPath = `${dest}.tmp.${process.pid}`;

	await fs.copyFile(src, tempPath);

	try {
		// Atomic rename - works even if dest is loaded on Linux/macOS (old inode stays valid)
		await fs.rename(tempPath, dest);
	} catch {
		// On Windows, loaded DLLs cannot be overwritten via rename
		// Try delete-then-rename as fallback
		try {
			await fs.unlink(dest);
		} catch (unlinkErr) {
			if ((unlinkErr as NodeJS.ErrnoException).code !== "ENOENT") {
				await fs.unlink(tempPath).catch(() => {});
				const isWindows = process.platform === "win32";
				throw new Error(
					`Cannot replace ${path.basename(dest)}${isWindows ? " (file may be in use - close any running processes)" : ""}: ${(unlinkErr as Error).message}`,
				);
			}
		}
		try {
			await fs.rename(tempPath, dest);
		} catch (finalErr) {
			await fs.unlink(tempPath).catch(() => {});
			throw new Error(`Failed to install ${path.basename(dest)}: ${(finalErr as Error).message}`);
		}
	}
}
async function resolveBuiltAddonPath(outputDir: string, canonicalFilename: string): Promise<string> {
	// napi-rs 3.x emits `${binaryName}.${platformArchABI}.node` where
	// platformArchABI is e.g. `darwin-x64`, `linux-x64-gnu`, `win32-x64-msvc`,
	// `darwin-arm64`. Build into an isolated output dir so only this invocation's
	// outputs are considered fresh candidates.
	const entries = await fs.readdir(outputDir);

	if (entries.includes(canonicalFilename)) {
		return path.join(outputDir, canonicalFilename);
	}

	const generatedCandidates = entries.filter(entry => {
		if (!entry.startsWith(`pi_natives.${targetPlatform}-${targetArch}`) || !entry.endsWith(".node")) {
			return false;
		}
		return true;
	});

	if (generatedCandidates.length === 1) {
		return path.join(outputDir, generatedCandidates[0]);
	}

	if (generatedCandidates.length === 0) {
		throw new Error(
			`napi build succeeded but did not emit a native addon for ${targetPlatform}-${targetArch}. Expected ${canonicalFilename} or an environment-tagged variant in ${outputDir}. Directory contents: ${entries.join(", ") || "(empty)"}.`,
		);
	}

	const formattedCandidates = generatedCandidates.map(candidate => `  - ${candidate}`).join("\n");
	throw new Error(
		`napi build emitted multiple unrecognized native addons for ${targetPlatform}-${targetArch}:\n${formattedCandidates}`,
	);
}

function resolveBuildOutputDirPrefix(profileLabel: string): string {
	const buildTarget = crossTarget ?? `${targetPlatform}-${targetArch}`;
	const variantLabel = effectiveVariant ?? "default";
	return path.join(nativeDir, ".build", `${buildTarget}-${variantLabel}-${profileLabel}-`);
}

async function installGeneratedBindings(outputDir: string): Promise<void> {
	const sourcePath = path.join(outputDir, "index.d.ts");
	const destPath = path.join(nativeDir, "index.d.ts");
	try {
		await fs.copyFile(sourcePath, destPath);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to install generated index.d.ts: ${message}`);
	}
}

async function validateRecoveryFsBindings(): Promise<void> {
	const bindings = await Bun.file(path.join(nativeDir, "index.d.ts")).text();
	for (const symbol of [
		"RecoveryFsRoot",
		"RecoveryFsIdentity",
		"RecoveryFsResult",
		"openRecoveryFsRoot",
		"repairOwnerOnlyPathSecurityExpected",
		"verifyOwnerOnlyPathSecurityExpected",
	]) {
		if (!bindings.includes(symbol)) {
			throw new Error(`napi build did not generate the required recovery filesystem binding: ${symbol}`);
		}
	}
}

type NativeBuildProfile = "local" | "ci" | "dist";

export function resolveNativeBuildProfile(options: {
	isCI: boolean;
	isCrossCompile: boolean;
	explicitProfile?: string;
}): NativeBuildProfile {
	if (options.explicitProfile !== undefined && options.explicitProfile !== "") {
		if (
			options.explicitProfile === "local" ||
			options.explicitProfile === "ci" ||
			options.explicitProfile === "dist"
		) {
			return options.explicitProfile;
		}
		throw new Error(`Unsupported PI_NATIVE_PROFILE: ${options.explicitProfile}. Expected "local", "ci", or "dist".`);
	}

	return !options.isCI && !options.isCrossCompile ? "local" : "ci";
}

const isCI = Boolean(Bun.env.CI);
const profileLabel = resolveNativeBuildProfile({
	isCI,
	isCrossCompile,
	explicitProfile: Bun.env.PI_NATIVE_PROFILE,
});
const profileSuffix = ` (${profileLabel})`;

const buildOutputDirPrefix = resolveBuildOutputDirPrefix(profileLabel);

// Build napi args
const napiArgs = [
	"build",
	"--manifest-path",
	path.join(rustDir, "Cargo.toml"),
	"--package-json-path",
	packageJsonPath,
	"--platform",
	"--no-js",
	"--dts",
	"index.d.ts",
	"-o",
	"",
	"--profile",
	profileLabel,
];

if (crossTarget) napiArgs.push("--target", crossTarget);
if (languageSet === "full") napiArgs.push("--", "--features", "full-langs");

const canonicalAddonFilename = `pi_natives.${targetPlatform}-${targetArch}${variantSuffix}.node`;
const canonicalAddonPath = path.join(nativeDir, canonicalAddonFilename);

console.log(`Building pi-natives for ${targetPlatform}-${targetArch}${variantSuffix}${profileSuffix}…`);

await fs.mkdir(nativeDir, { recursive: true });
await cleanupStaleTemps(nativeDir);
await fs.mkdir(path.join(nativeDir, ".build"), { recursive: true });
const buildOutputDir = await fs.mkdtemp(buildOutputDirPrefix);
napiArgs[10] = buildOutputDir;

// Resolve napi bin directly: `bunx @napi-rs/cli` can pick up the wrong bin on
// systems where `cli` exists on PATH (e.g. Mono's /usr/bin/cli on Ubuntu).
const napiBin = Bun.which("napi", {
	PATH: `${path.join(import.meta.dir, "..", "node_modules", ".bin")}:${path.join(repoRoot, "node_modules", ".bin")}:${process.env.PATH ?? ""}`,
});
if (!napiBin) {
	throw new Error("Could not locate @napi-rs/cli `napi` binary in node_modules/.bin");
}

try {
	const buildResult = await $`${napiBin} ${napiArgs}`.nothrow();
	if (buildResult.exitCode !== 0) {
		const stderr = buildResult.stderr?.toString("utf-8") ?? "";
		throw new Error(`napi build failed${stderr ? `:\n${stderr}` : ""}`);
	}

	const builtAddonPath = await resolveBuiltAddonPath(buildOutputDir, canonicalAddonFilename);
	if (builtAddonPath !== canonicalAddonPath) {
		console.log(`Normalizing native addon filename: ${path.basename(builtAddonPath)} → ${canonicalAddonFilename}`);
		await installBinary(builtAddonPath, canonicalAddonPath);
	}

	await installGeneratedBindings(buildOutputDir);
	await validateRecoveryFsBindings();

	await Bun.write(
		`${canonicalAddonPath}.build.json`,
		`${JSON.stringify({ languageSet, profile: profileLabel, builtAt: new Date().toISOString() }, null, 2)}\n`,
	);

	await generateEnumExports();

	console.log("Build complete.");
} finally {
	await fs.rm(buildOutputDir, { recursive: true, force: true });
}
