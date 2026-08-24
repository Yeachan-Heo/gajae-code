import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { currentExecutablePath } from "@gajae-code/natives";
import packageJson from "../../../package.json" with { type: "json" };
import internalSourceMarker from "./internal-source-marker-2178.txt" with { type: "file" };

export type SdkInternalAction = "broker-internal" | "session-host-internal";

export interface SdkPackageAuthority {
	generation: string;
	packageVersion: string;
	installationIdentity: string;
}

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
			packageVersion?: string;
			installationIdentity?: string;
	  }
	| {
			kind: "compiled";
			file: string;
			args: string[];
			env: NodeJS.ProcessEnv;
			cwd?: undefined;
			generation: string;
			packageVersion?: string;
			installationIdentity?: string;
	  };

type EmbeddedFile = Blob | { name: string };
const commandAuthorityPaths = new WeakMap<object, string[]>();

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

/** Returns every regular source input below a trusted runtime directory in stable order. */
function regularFilesUnder(directory: string, excludedNames: ReadonlySet<string> = new Set()): string[] {
	const files: string[] = [];
	const visit = (current: string): void => {
		for (const entry of fs
			.readdirSync(current, { withFileTypes: true })
			.sort((left, right) => left.name.localeCompare(right.name))) {
			if (excludedNames.has(entry.name)) continue;
			const candidate = path.join(current, entry.name);
			if (entry.isDirectory()) visit(candidate);
			else if (entry.isFile() || entry.isSymbolicLink()) {
				const canonical = fs.realpathSync(candidate);
				if (!containedPath(directory, canonical))
					throw new Error("SDK internal launch refused: source dependency escapes its trusted directory.");
				const stat = fs.statSync(canonical);
				if (stat.isDirectory())
					throw new Error("SDK internal launch refused: symlinked source directories are unsupported.");
				if (stat.isFile()) files.push(canonical);
			}
		}
	};
	visit(directory);
	return [...new Set(files)].sort((left, right) => left.localeCompare(right));
}

/**
 * Include local workspace runtime inputs resolved by source Bun launches. The user cache is a
 * derived loader artifact, never generation authority: loader-state validates it against the
 * current package bytes.
 */
function workspaceDependencyFiles(packageDirectory: string): string[] {
	const workspaceRoot = path.dirname(packageDirectory);
	const trustedLocalRoot = path.dirname(workspaceRoot);
	const files: string[] = [];
	const visited = new Set<string>();
	const workspaceDirectories = new Map<string, string>();
	for (const entry of fs.readdirSync(workspaceRoot, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const directory = path.join(workspaceRoot, entry.name);
		try {
			const manifest = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8")) as {
				name?: unknown;
			};
			if (typeof manifest.name === "string") workspaceDirectories.set(manifest.name, directory);
		} catch {
			// Non-package workspace directories are irrelevant to the runtime closure.
		}
	}
	const resolveWorkspaceDirectory = (name: string): string | undefined => {
		const suffix = name.slice("@gajae-code/".length);
		const candidate = path.resolve(workspaceRoot, suffix);
		if (!containedPath(trustedLocalRoot, candidate))
			throw new Error("SDK internal launch refused: workspace dependency escapes its trusted root.");
		if (fs.existsSync(candidate)) return candidate;
		const workspaceCandidate = workspaceDirectories.get(name);
		if (workspaceCandidate) return workspaceCandidate;
		let current = packageDirectory;
		while (true) {
			const nodeModulesCandidate = path.join(current, "node_modules", name);
			if (fs.existsSync(nodeModulesCandidate)) return nodeModulesCandidate;
			const parent = path.dirname(current);
			if (parent === current) return undefined;
			current = parent;
		}
	};
	const visit = (dependencyDirectory: string): void => {
		const canonicalDirectory = fs.realpathSync(dependencyDirectory);
		if (!containedPath(trustedLocalRoot, canonicalDirectory))
			throw new Error("SDK internal launch refused: resolved workspace dependency escapes its trusted root.");
		if (visited.has(canonicalDirectory)) return;
		visited.add(canonicalDirectory);
		const manifestPath = path.join(canonicalDirectory, "package.json");
		let manifest: {
			dependencies?: Record<string, unknown>;
			devDependencies?: Record<string, unknown>;
			optionalDependencies?: Record<string, unknown>;
		};
		try {
			manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as typeof manifest;
		} catch {
			throw new Error("SDK internal launch refused: workspace dependency metadata is unreadable.");
		}
		files.push(manifestPath);
		const sourceDirectory = path.join(canonicalDirectory, "src");
		const nativeDirectory = path.join(canonicalDirectory, "native");
		if (fs.existsSync(sourceDirectory)) files.push(...regularFilesUnder(sourceDirectory));
		if (fs.existsSync(nativeDirectory)) files.push(...regularFilesUnder(nativeDirectory));
		const names = new Set([
			...Object.keys(manifest.dependencies ?? {}),
			...Object.keys(manifest.devDependencies ?? {}),
			...Object.keys(manifest.optionalDependencies ?? {}),
		]);
		for (const name of names) {
			if (!name.startsWith("@gajae-code/")) continue;
			const candidate = resolveWorkspaceDirectory(name);
			if (candidate && fs.existsSync(candidate)) visit(candidate);
		}
	};
	const rootManifest = JSON.parse(fs.readFileSync(path.join(packageDirectory, "package.json"), "utf8")) as {
		dependencies?: Record<string, unknown>;
		devDependencies?: Record<string, unknown>;
		optionalDependencies?: Record<string, unknown>;
	};
	const rootNames = new Set([
		...Object.keys(rootManifest.dependencies ?? {}),
		...Object.keys(rootManifest.devDependencies ?? {}),
		...Object.keys(rootManifest.optionalDependencies ?? {}),
	]);
	for (const name of rootNames) {
		if (!name.startsWith("@gajae-code/")) continue;
		const candidate = resolveWorkspaceDirectory(name);
		if (candidate && fs.existsSync(candidate)) visit(candidate);
	}
	return files;
}

function trustedRuntimeRoot(packageDirectory: string): string {
	const canonicalPackageDirectory = fs.realpathSync(packageDirectory);
	let current = canonicalPackageDirectory;
	for (let depth = 0; depth < 8; depth++) {
		const manifestPath = path.join(current, "package.json");
		const lockfilePath = path.join(current, "bun.lock");
		if (fs.existsSync(lockfilePath)) return current;
		try {
			const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { name?: unknown };
			if (manifest.name === "gajae-code") return current;
		} catch {}
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	const packageManifest = JSON.parse(
		fs.readFileSync(path.join(canonicalPackageDirectory, "package.json"), "utf8"),
	) as {
		name?: unknown;
	};
	if (packageManifest.name === "@gajae-code/coding-agent") {
		const nodeModules = canonicalPackageDirectory.split(path.sep).lastIndexOf("node_modules");
		if (nodeModules >= 0) {
			const parts = canonicalPackageDirectory.split(path.sep);
			const root = parts.slice(0, nodeModules).join(path.sep) || path.parse(canonicalPackageDirectory).root;
			if (root && containedPath(root, canonicalPackageDirectory)) return root;
		}
		return canonicalPackageDirectory;
	}
	throw new Error("SDK internal launch refused: runtime dependency root is not lockfile-verifiable.");
}

/** Hash every resolved runtime package, not just mutable local workspace packages. */
function resolvedRuntimeDependencyFiles(packageDirectory: string): string[] {
	const trustedRoot = trustedRuntimeRoot(packageDirectory);
	const files: string[] = [];
	const visited = new Set<string>();
	const resolvePackage = (fromDirectory: string, name: string): string | undefined => {
		let current = fromDirectory;
		while (true) {
			const candidate = path.join(current, "node_modules", name);
			if (fs.existsSync(candidate)) return fs.realpathSync(candidate);
			const parent = path.dirname(current);
			if (parent === current) return undefined;
			current = parent;
		}
	};
	const visit = (directory: string, optional: boolean): void => {
		let canonical: string;
		try {
			canonical = fs.realpathSync(directory);
		} catch {
			if (optional) return;
			throw new Error("SDK internal launch refused: required runtime dependency is unresolved.");
		}
		if (!containedPath(trustedRoot, canonical))
			throw new Error("SDK internal launch refused: runtime dependency escapes its trusted root.");
		if (visited.has(canonical)) return;
		visited.add(canonical);
		const manifestPath = path.join(canonical, "package.json");
		let manifest: {
			dependencies?: Record<string, unknown>;
			optionalDependencies?: Record<string, unknown>;
			peerDependencies?: Record<string, unknown>;
		};
		try {
			manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as typeof manifest;
		} catch {
			if (optional) return;
			throw new Error("SDK internal launch refused: runtime dependency metadata is unreadable.");
		}
		if (canonical === fs.realpathSync(packageDirectory)) {
			files.push(manifestPath);
			for (const subdirectory of ["src", "bin", "vendor"]) {
				const candidate = path.join(canonical, subdirectory);
				if (fs.existsSync(candidate)) files.push(...regularFilesUnder(candidate));
			}
		} else {
			files.push(...regularFilesUnder(canonical, new Set(["node_modules"])));
		}
		const optionalNames = new Set([
			...Object.keys(manifest.optionalDependencies ?? {}),
			...Object.keys(manifest.peerDependencies ?? {}),
		]);
		const names = new Set([
			...Object.keys(manifest.dependencies ?? {}),
			...Object.keys(manifest.optionalDependencies ?? {}),
			...Object.keys(manifest.peerDependencies ?? {}),
		]);
		for (const name of names) {
			const resolved = resolvePackage(canonical, name);
			if (!resolved) {
				if (optionalNames.has(name)) continue;
				throw new Error(`SDK internal launch refused: required runtime dependency is unresolved (${name}).`);
			}
			visit(resolved, optionalNames.has(name));
		}
	};
	visit(packageDirectory, false);
	return files;
}

function trustedProjectLockfile(packageDirectory: string): string | undefined {
	const canonicalPackageDirectory = fs.realpathSync(packageDirectory);
	let current = packageDirectory;
	for (let depth = 0; depth < 8; depth++) {
		const lockfile = path.join(current, "bun.lock");
		const manifestPath = path.join(current, "package.json");
		if (fs.existsSync(lockfile) && fs.existsSync(manifestPath)) {
			try {
				const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
					name?: unknown;
					workspaces?: unknown;
				};
				if (manifest.name === "gajae-code") {
					const canonicalLockfile = fs.realpathSync(lockfile);
					if (!containedPath(current, canonicalLockfile))
						throw new Error("SDK internal launch refused: project lockfile escapes its trusted root.");
					return canonicalLockfile;
				}
				const relativePackage = path.relative(current, canonicalPackageDirectory).replaceAll(path.sep, "/");
				const belongsToKnownWorkspaceLayout =
					relativePackage === "packages/coding-agent" ||
					relativePackage.startsWith("packages/coding-agent/") ||
					relativePackage.startsWith("node_modules/@gajae-code/");
				if (manifest.workspaces !== undefined && belongsToKnownWorkspaceLayout) {
					const canonicalLockfile = fs.realpathSync(lockfile);
					if (!containedPath(current, canonicalLockfile))
						throw new Error("SDK internal launch refused: project lockfile escapes its trusted root.");
					return canonicalLockfile;
				}
			} catch {
				throw new Error("SDK internal launch refused: project lockfile metadata is unreadable.");
			}
		}
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return undefined;
}

/** Digest the actual bytes of the trusted launch inputs, not only filesystem metadata. */
function sdkPackageGeneration(kind: SdkInternalSpawnCommand["kind"], version: string, files: string[]): string {
	const hash = createHash("sha256");
	hash.update(kind);
	hash.update("\0");
	hash.update(version);
	const orderedFiles = [...new Set(files)].sort((left, right) => left.localeCompare(right));
	const identity = (file: string): string => {
		const stat = fs.statSync(file);
		return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
	};
	const before = new Map(orderedFiles.map(file => [file, identity(file)]));
	for (const file of orderedFiles) {
		hash.update("\0");
		hash.update(file);
		const contents = fs.readFileSync(file);
		hash.update(`:${contents.byteLength}:`);
		hash.update(contents);
	}
	for (const file of orderedFiles) {
		if (before.get(file) !== identity(file))
			throw new Error("SDK internal launch refused: runtime inputs changed while computing package generation.");
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
	const generationFiles = [
		path.join(canonicalPackageDirectory, "package.json"),
		...regularFilesUnder(canonicalSourceDirectory),
		...workspaceDependencyFiles(canonicalPackageDirectory),
		...resolvedRuntimeDependencyFiles(canonicalPackageDirectory),
		config,
		runtime,
	];
	const lockfile = trustedProjectLockfile(canonicalPackageDirectory);
	if (lockfile) generationFiles.push(lockfile);
	const command: SdkInternalSpawnCommand = {
		kind: "bun-source",
		file: runtime,
		args: ["--no-env-file", `--config=${config}`, cli, "sdk", action],
		env: internalEnvironment(options.environment ?? process.env, true),
		cwd: canonicalBrokerDirectory,
		generation: sdkPackageGeneration("bun-source", packageVersion, generationFiles),
		packageVersion,
		installationIdentity: canonicalPackageDirectory,
	};
	commandAuthorityPaths.set(command, [
		canonicalPackageDirectory,
		canonicalSourceDirectory,
		canonicalBrokerDirectory,
		runtime,
		...generationFiles,
	]);
	return command;
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
		const executable = compiledExecutable(options);
		const command: SdkInternalSpawnCommand = {
			kind: "compiled",
			file: executable,
			args: ["sdk", action],
			env: internalEnvironment(options.environment ?? process.env, false),
			generation: sdkPackageGeneration("compiled", "binary", [executable]),
			packageVersion: packageJson.version,
			installationIdentity: executable,
		};
		commandAuthorityPaths.set(command, [executable]);
		return command;
	}
	throw new Error("SDK internal launch refused: compiled-runtime marker evidence is inconsistent.");
}

/** Resolve the production descriptor from the statically imported marker and current Bun runtime evidence. */
export function resolveSdkInternalSpawnCommand(action: SdkInternalAction): SdkInternalSpawnCommand {
	if (authorityCache && !authorityCache.invalidated) {
		const cached = internalCommandCache.get(action);
		if (cached)
			return {
				...cached,
				env: internalEnvironment(process.env, cached.kind === "bun-source"),
			};
		const broker = internalCommandCache.get("broker-internal");
		if (broker) {
			const command: SdkInternalSpawnCommand = {
				...broker,
				args: [...broker.args.slice(0, -1), action],
				env: internalEnvironment(process.env, broker.kind === "bun-source"),
			};
			const paths = commandAuthorityPaths.get(broker);
			if (paths) commandAuthorityPaths.set(command, paths);
			internalCommandCache.set(action, command);
			return command;
		}
	}
	const command = resolveSdkInternalSpawnCommandWithEvidence(action, {});
	internalCommandCache.set(action, command);
	return command;
}

/** Resolve the current generation the production descriptor would publish, without spawning. */
type AuthorityCache = {
	authority: SdkPackageAuthority;
	invalidated: boolean;
};

let authorityCache: AuthorityCache | undefined;
const authorityWatchers = new Map<string, fs.FSWatcher>();
const internalCommandCache = new Map<SdkInternalAction, SdkInternalSpawnCommand>();

function watchAuthorityPaths(paths: string[]): void {
	for (const input of paths) {
		const directory = path.dirname(input);
		if (authorityWatchers.has(directory)) continue;
		try {
			const watcher = fs.watch(directory, () => {
				if (authorityCache) authorityCache.invalidated = true;
			});
			watcher.on("error", () => {
				if (authorityCache) authorityCache.invalidated = true;
			});
			watcher.unref();
			authorityWatchers.set(directory, watcher);
		} catch {
			if (authorityCache) authorityCache.invalidated = true;
		}
	}
}

/** Resolve the ordered, installation-bound authority used before broker retirement. */
export function resolveSdkPackageAuthority(options: { force?: boolean } = {}): SdkPackageAuthority {
	if (!options.force && authorityCache && !authorityCache.invalidated) return authorityCache.authority;
	if (options.force) {
		authorityCache = undefined;
		internalCommandCache.clear();
	}
	const command = resolveSdkInternalSpawnCommand("broker-internal");
	const authority = {
		generation: command.generation,
		packageVersion: command.packageVersion ?? packageJson.version,
		installationIdentity: command.installationIdentity ?? command.file,
	};
	const paths = commandAuthorityPaths.get(command) ?? [command.file];
	authorityCache = { authority, invalidated: false };
	internalCommandCache.set("broker-internal", command);
	watchAuthorityPaths(paths);
	return authority;
}

export function resolveSdkPackageGeneration(): string {
	return resolveSdkPackageAuthority().generation;
}

/** Test hook: injects runtime evidence without weakening the production marker authority. */
export function resolveSdkInternalSpawnCommandForTest(
	action: SdkInternalAction,
	options: SdkInternalRuntimeDescriptorTestOptions,
): SdkInternalSpawnCommand {
	return resolveSdkInternalSpawnCommandWithEvidence(action, options);
}
