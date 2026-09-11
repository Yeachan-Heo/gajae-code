import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

import { currentExecutablePath } from "@gajae-code/natives";

import internalSourceMarker from "./internal-source-marker-2178.txt" with { type: "file" };

export type SdkInternalAction = "broker-internal" | "session-host-internal";

export type SdkInternalSpawnCommand =
	| {
			kind: "bun-source";
			file: string;
			args: string[];
			env: NodeJS.ProcessEnv;
			cwd: string;
	  }
	| {
			kind: "compiled";
			file: string;
			args: string[];
			env: NodeJS.ProcessEnv;
			cwd?: undefined;
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

function regularExecutablePath(file: string, label: string): string {
	const canonical = regularReadablePath(file, label);
	try {
		fs.accessSync(canonical, fs.constants.X_OK);
	} catch {
		throw new Error(`SDK internal launch refused: ${label} is not an executable regular file.`);
	}
	return canonical;
}

function isBunVirtualExecutablePath(file: string): boolean {
	const normalized = file.replaceAll("\\", "/").toLowerCase();
	return (
		normalized === "/$bunfs" || normalized.startsWith("/$bunfs/") || /^(?:[a-z]:)?\/~bun(?:\/|$)/.test(normalized)
	);
}

/**
 * Bun normally exposes the compiled application's on-disk path through
 * `process.execPath`. Some single-file builds instead expose their virtual
 * bundle entry there. Exact compiled-marker evidence proves this is the
 * bundled GJC process; the fallback comes from the OS current-image query,
 * never argv or PATH.
 */
function compiledExecutable(options: SdkInternalRuntimeDescriptorTestOptions): string {
	const execPath = options.execPath ?? process.execPath;
	try {
		return regularExecutablePath(path.resolve(execPath), "compiled executable");
	} catch (error) {
		if (!isBunVirtualExecutablePath(execPath)) throw error;
		const currentExecutable = currentExecutablePath();
		if (!currentExecutable) throw error;
		return regularExecutablePath(currentExecutable, "compiled executable");
	}
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
function expectedPackageName(packageDirectory: string): void {
	try {
		const manifest = JSON.parse(fs.readFileSync(path.join(packageDirectory, "package.json"), "utf8")) as {
			name?: unknown;
		};
		if (manifest.name !== "@gajae-code/coding-agent") throw new Error("unexpected package name");
	} catch {
		throw new Error("SDK internal launch refused: product package identity is invalid.");
	}
}

type SdkInternalRuntimeEvidence = { kind: "bun-source" | "compiled"; markerPath: string };

/**
 * Classify this process's runtime from exact marker and embedded-file evidence.
 * Both the spawn descriptor and the published runtime image derive from this one
 * authority; neither may fall back to argv or PATH.
 */
function classifySdkInternalRuntime(options: SdkInternalRuntimeDescriptorTestOptions): SdkInternalRuntimeEvidence {
	const markerPath = options.markerPath ?? internalSourceMarker;
	const embeddedFiles = options.embeddedFiles ?? (typeof Bun === "undefined" ? undefined : Bun.embeddedFiles);
	if (!embeddedFiles) throw new Error("SDK internal launch refused: Bun runtime evidence is unavailable.");
	const markerName = path.basename(markerPath.replaceAll("\\", "/"));
	const markerEntries = embeddedFiles.filter(file => embeddedFileName(file) === markerName);
	const compiledMarkerPath = isCompiledMarkerPath(markerPath);
	const exactCompiledArtifact = COMPILED_MARKER_NAME.test(markerName) && markerEntries.length === 1;
	const isSourceMarker = path.isAbsolute(markerPath) && !compiledMarkerPath;
	if (embeddedFiles.length === 0 && isSourceMarker) return { kind: "bun-source", markerPath };
	if (exactCompiledArtifact && compiledMarkerPath) return { kind: "compiled", markerPath };
	throw new Error("SDK internal launch refused: compiled-runtime marker evidence is inconsistent.");
}

/**
 * The image a source-runtime internal spawn executes: this process's own Bun.
 * It is the spawn command file, so it must be executable, not merely readable.
 */
function sourceRuntimeImage(options: SdkInternalRuntimeDescriptorTestOptions): string {
	if (options.bunAvailable === false || typeof Bun === "undefined")
		throw new Error("SDK internal launch refused: Bun source runtime is unavailable.");
	return regularExecutablePath(path.resolve(options.execPath ?? process.execPath), "runtime executable");
}

/** The runtime image alone, without the source-tree assets a full spawn also proves. */
function provenRuntimeImage(options: SdkInternalRuntimeDescriptorTestOptions): string {
	const evidence = classifySdkInternalRuntime(options);
	return evidence.kind === "bun-source" ? sourceRuntimeImage(options) : compiledExecutable(options);
}

/**
 * The image the same classification names, without the on-disk proof a spawn
 * requires. A proof-first publication is exactly backwards for the broker that
 * matters here: a runtime deleted between this process's exec and its
 * publication makes `regularExecutablePath` throw, so the one broker that can
 * never spawn would publish no evidence and read as reusable forever.
 *
 * Publishing the classified path instead moves the verdict to the reader, which
 * already retires only on proven absence. It is evidence, never a spawn source.
 * A Bun virtual bundle path is not publishable: nothing on disk backs it, so a
 * reader would probe `ENOENT` and retire a healthy compiled broker.
 */
function classifiedRuntimeImage(options: SdkInternalRuntimeDescriptorTestOptions): string | undefined {
	const evidence = classifySdkInternalRuntime(options);
	const execPath = options.execPath ?? process.execPath;
	if (evidence.kind === "bun-source") {
		// Without Bun there is no source runtime to name; `execPath` would be some
		// other interpreter, which is worse evidence than none.
		if (options.bunAvailable === false || typeof Bun === "undefined") return undefined;
		return isBunVirtualExecutablePath(execPath) ? undefined : path.resolve(execPath);
	}
	if (!isBunVirtualExecutablePath(execPath)) return path.resolve(execPath);
	const currentExecutable = currentExecutablePath();
	if (!currentExecutable || isBunVirtualExecutablePath(currentExecutable)) return undefined;
	return path.resolve(currentExecutable);
}

/** Publication evidence: the proven image, else the classified path, else nothing. */
function publishedRuntimeImage(options: SdkInternalRuntimeDescriptorTestOptions): string | undefined {
	try {
		return provenRuntimeImage(options);
	} catch {
		try {
			return classifiedRuntimeImage(options);
		} catch {
			return undefined;
		}
	}
}

function sourceDescriptor(
	action: SdkInternalAction,
	options: SdkInternalRuntimeDescriptorTestOptions,
	markerPath: string,
): SdkInternalSpawnCommand {
	const runtime = sourceRuntimeImage(options);
	const brokerDirectory = path.resolve(options.brokerDirectory ?? import.meta.dir);
	const packageDirectory = path.resolve(brokerDirectory, "../../..");
	const sourceDirectory = path.resolve(brokerDirectory, "../..");
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
	expectedPackageName(canonicalPackageDirectory);
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
	};
}

function resolveSdkInternalSpawnCommandWithEvidence(
	action: SdkInternalAction,
	options: SdkInternalRuntimeDescriptorTestOptions,
): SdkInternalSpawnCommand {
	const evidence = classifySdkInternalRuntime(options);
	if (evidence.kind === "bun-source") return sourceDescriptor(action, options, evidence.markerPath);
	return {
		kind: "compiled",
		file: compiledExecutable(options),
		args: ["sdk", action],
		env: internalEnvironment(options.environment ?? process.env, false),
	};
}

/**
 * The on-disk image internal SDK spawns from this process execute, or
 * `undefined` only when runtime evidence cannot be classified at all. It comes
 * from the same marker authority a spawn uses, but deliberately not from the
 * source-tree assets a spawn also proves (CLI entrypoint, isolated Bun config,
 * package identity): a failure to read one of those says nothing about the
 * runtime image, and publishing `undefined` for it would blind every reader.
 *
 * An image the classification names but this process can no longer prove is
 * still published. `undefined` means only "no evidence" -- readers keep such a
 * broker reusable, so a broker whose own image vanished before it published
 * must not hide behind it.
 */
export function sdkInternalRuntimeImage(): string | undefined {
	return publishedRuntimeImage({});
}

/** A stat that has not answered by here is inconclusive, never proof of absence. */
const RUNTIME_IMAGE_PROBE_TIMEOUT_MS = 1_000;

/**
 * Only these prove the image is gone. Every other failure (`EACCES`, `EPERM`,
 * `ELOOP`, `EIO`, a sandbox that hides the path from this caller, anything
 * unrecognized) describes the caller's view, not the image: the broker may still
 * execute a file this process cannot even inspect.
 */
function isProvenRuntimeImageAbsence(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | null)?.code;
	return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * Whether a published runtime image is still a regular file on disk. A resident broker keeps
 * answering requests after the executable it was started from is deleted (a
 * Homebrew Bun upgrade removing the Cellar path, an install directory swapped
 * underneath it), yet every internal spawn it then attempts is refused. Callers
 * use this to retire such an incumbent before a session launch reaches it, so it
 * answers `true` on every inconclusive outcome, including a probe that outlives
 * its bound: a false retirement kills a healthy broker.
 */
export async function isSdkInternalRuntimeImagePresent(file: string): Promise<boolean> {
	const probe = fsp.stat(path.resolve(file)).then(
		stats => stats.isFile(),
		(error: unknown) => !isProvenRuntimeImageAbsence(error),
	);
	const inconclusive = Promise.withResolvers<boolean>();
	const timer: NodeJS.Timeout = setTimeout(() => inconclusive.resolve(true), RUNTIME_IMAGE_PROBE_TIMEOUT_MS);
	try {
		return await Promise.race([probe, inconclusive.promise]);
	} finally {
		clearTimeout(timer);
	}
}

/** Resolve the production descriptor from the statically imported marker and current Bun runtime evidence. */
export function resolveSdkInternalSpawnCommand(action: SdkInternalAction): SdkInternalSpawnCommand {
	return resolveSdkInternalSpawnCommandWithEvidence(action, {});
}

/** Test hook: injects runtime evidence without weakening the production marker authority. */
export function resolveSdkInternalSpawnCommandForTest(
	action: SdkInternalAction,
	options: SdkInternalRuntimeDescriptorTestOptions,
): SdkInternalSpawnCommand {
	return resolveSdkInternalSpawnCommandWithEvidence(action, options);
}

/** Test hook: the publication decision under injected evidence, same authority as production. */
export function sdkInternalRuntimeImageForTest(options: SdkInternalRuntimeDescriptorTestOptions): string | undefined {
	return publishedRuntimeImage(options);
}
