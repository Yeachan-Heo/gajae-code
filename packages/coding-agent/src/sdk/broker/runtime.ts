import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import internalSourceMarker from "./internal-source-marker-2178.txt" with { type: "file" };

export type SdkInternalAction = "broker-internal" | "session-host-internal";

export type SdkInternalSpawnCommand =
	| {
			kind: "bun-source";
			file: string;
			args: string[];
			env: NodeJS.ProcessEnv;
			cwd: string;
			/**
			 * Stable digest of the package tree this descriptor would spawn. A live
			 * broker publishing a different generation predates the current install
			 * and must not be reused (see ensure.ts).
			 */
			generation: string;
	  }
	| {
			kind: "compiled";
			file: string;
			args: string[];
			env: NodeJS.ProcessEnv;
			cwd?: undefined;
			generation: string;
	  };

type EmbeddedFile = Blob | { name: string };

/** Test-only injectable inputs for hostile evidence and platform grammar coverage. */
export interface SdkInternalRuntimeDescriptorTestOptions {
	execPath?: string;
	environment?: NodeJS.ProcessEnv;
	embeddedFiles?: readonly EmbeddedFile[];
	markerPath?: string;
	brokerDirectory?: string;
	cliPath?: string;
	configPath?: string;
	bunAvailable?: boolean;
}

const COMPILED_MARKER_NAME = /^internal-source-marker-2178-[A-Za-z0-9]+\.txt$/;
const POSIX_MARKER_VFS_PATH = /^\/\$bunfs\/root\/internal-source-marker-2178-[A-Za-z0-9]+\.txt$/;
const WINDOWS_MARKER_VFS_PATH = /^[A-Za-z]:\/~BUN\/(?:root\/)?internal-source-marker-2178-[A-Za-z0-9]+\.txt$/;

function isCompiledMarkerPath(markerPath: string): boolean {
	const normalized = markerPath.replaceAll("\\", "/");
	return POSIX_MARKER_VFS_PATH.test(normalized) || WINDOWS_MARKER_VFS_PATH.test(normalized);
}
function embeddedFileName(file: EmbeddedFile): string | undefined {
	return "name" in file && typeof file.name === "string" ? file.name : undefined;
}

function containedPath(parent: string, candidate: string): boolean {
	const relative = path.relative(parent, candidate);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function regularReadablePath(file: string, label: string): string {
	let canonical: string;
	try {
		canonical = fs.realpathSync(file);
		const stat = fs.statSync(canonical);
		fs.accessSync(canonical, fs.constants.R_OK);
		if (!stat.isFile()) throw new Error("not a regular file");
	} catch {
		throw new Error(`SDK internal launch refused: ${label} is not a readable regular file.`);
	}
	return canonical;
}

function internalEnvironment(environment: NodeJS.ProcessEnv, source: boolean): NodeJS.ProcessEnv {
	const isolated = { ...environment };
	delete isolated.BUN_OPTIONS;
	if (source) {
		delete isolated.PI_COMPILED;
		delete isolated.GJC_COMPILED;
	}
	return isolated;
}
function expectedPackageIdentity(packageDirectory: string): string {
	try {
		const manifest = JSON.parse(fs.readFileSync(path.join(packageDirectory, "package.json"), "utf8")) as {
			name?: unknown;
			version?: unknown;
		};
		if (manifest.name !== "@gajae-code/coding-agent") throw new Error("unexpected package name");
		if (typeof manifest.version !== "string" || manifest.version.length === 0)
			throw new Error("unexpected package version");
		return manifest.version;
	} catch {
		throw new Error("SDK internal launch refused: product package identity is invalid.");
	}
}

/**
 * Digest of the exact on-disk package a descriptor would spawn. File mtimes cover
 * same-version replacement (binary rebuild, in-place reinstall); the manifest
 * version covers package managers that preserve tarball mtimes. In-memory code
 * vintage is deliberately not an input: a process that outlived an upgrade must
 * still compute the SAME value a freshly spawned broker publishes, or every
 * ensure would retire a current broker.
 */
function sdkPackageGeneration(kind: SdkInternalSpawnCommand["kind"], version: string, files: string[]): string {
	const hash = createHash("sha256");
	hash.update(kind);
	hash.update("\0");
	hash.update(version);
	for (const file of files) {
		const stat = fs.statSync(file, { bigint: true });
		hash.update("\0");
		hash.update(file);
		hash.update(`:${stat.size}:${stat.mtimeNs}`);
	}
	return hash.digest("hex");
}

function sourceDescriptor(
	action: SdkInternalAction,
	options: SdkInternalRuntimeDescriptorTestOptions,
	markerPath: string,
): SdkInternalSpawnCommand {
	if (options.bunAvailable === false || typeof Bun === "undefined")
		throw new Error("SDK internal launch refused: Bun source runtime is unavailable.");
	const brokerDirectory = path.resolve(options.brokerDirectory ?? import.meta.dir);
	const packageDirectory = path.resolve(brokerDirectory, "../../..");
	const sourceDirectory = path.resolve(brokerDirectory, "../..");
	const runtime = regularReadablePath(path.resolve(options.execPath ?? process.execPath), "runtime executable");
	const cli = regularReadablePath(
		path.resolve(options.cliPath ?? path.join(sourceDirectory, "cli.ts")),
		"CLI entrypoint",
	);
	const config = regularReadablePath(
		path.resolve(options.configPath ?? path.join(brokerDirectory, "internal-source.bunfig.toml")),
		"isolated Bun configuration",
	);
	const marker = regularReadablePath(path.resolve(markerPath), "source marker");
	const canonicalBrokerDirectory = fs.realpathSync(brokerDirectory);
	const canonicalPackageDirectory = fs.realpathSync(packageDirectory);
	const canonicalSourceDirectory = fs.realpathSync(sourceDirectory);
	const packageVersion = expectedPackageIdentity(canonicalPackageDirectory);
	if (
		!containedPath(canonicalPackageDirectory, canonicalBrokerDirectory) ||
		!containedPath(canonicalPackageDirectory, canonicalSourceDirectory) ||
		!containedPath(canonicalSourceDirectory, cli) ||
		!containedPath(canonicalBrokerDirectory, config) ||
		!containedPath(canonicalBrokerDirectory, marker)
	)
		throw new Error("SDK internal launch refused: product runtime assets escape their trusted directories.");
	return {
		kind: "bun-source",
		file: runtime,
		args: ["--no-env-file", `--config=${config}`, cli, "sdk", action],
		env: internalEnvironment(options.environment ?? process.env, true),
		cwd: canonicalBrokerDirectory,
		generation: sdkPackageGeneration("bun-source", packageVersion, [cli, config]),
	};
}

function resolveSdkInternalSpawnCommandWithEvidence(
	action: SdkInternalAction,
	options: SdkInternalRuntimeDescriptorTestOptions,
): SdkInternalSpawnCommand {
	const markerPath = options.markerPath ?? internalSourceMarker;
	const embeddedFiles = options.embeddedFiles ?? (typeof Bun === "undefined" ? undefined : Bun.embeddedFiles);
	if (!embeddedFiles) throw new Error("SDK internal launch refused: Bun runtime evidence is unavailable.");
	const markerName = path.basename(markerPath.replaceAll("\\", "/"));
	const markerEntries = embeddedFiles.filter(file => embeddedFileName(file) === markerName);
	const compiledMarkerPath = isCompiledMarkerPath(markerPath);
	const exactCompiledArtifact = COMPILED_MARKER_NAME.test(markerName) && markerEntries.length === 1;
	const isSourceMarker = path.isAbsolute(markerPath) && !compiledMarkerPath;
	if (embeddedFiles.length === 0 && isSourceMarker) return sourceDescriptor(action, options, markerPath);
	if (exactCompiledArtifact && compiledMarkerPath) {
		const executable = regularReadablePath(path.resolve(options.execPath ?? process.execPath), "compiled executable");
		return {
			kind: "compiled",
			file: executable,
			args: ["sdk", action],
			env: internalEnvironment(options.environment ?? process.env, false),
			generation: sdkPackageGeneration("compiled", "binary", [executable]),
		};
	}
	throw new Error("SDK internal launch refused: compiled-runtime marker evidence is inconsistent.");
}

/** Resolve the production descriptor from the statically imported marker and current Bun runtime evidence. */
export function resolveSdkInternalSpawnCommand(action: SdkInternalAction): SdkInternalSpawnCommand {
	return resolveSdkInternalSpawnCommandWithEvidence(action, {});
}

/** Resolve the generation the production descriptor would publish, without spawning. */
export function resolveSdkPackageGeneration(): string {
	return resolveSdkInternalSpawnCommand("broker-internal").generation;
}

/** Test hook: injects runtime evidence without weakening the production marker authority. */
export function resolveSdkInternalSpawnCommandForTest(
	action: SdkInternalAction,
	options: SdkInternalRuntimeDescriptorTestOptions,
): SdkInternalSpawnCommand {
	return resolveSdkInternalSpawnCommandWithEvidence(action, options);
}
