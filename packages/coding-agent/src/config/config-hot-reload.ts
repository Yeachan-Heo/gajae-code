import { createHash } from "node:crypto";
import * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const DEBOUNCE_QUIET_MS = 45;
const DEBOUNCE_MAX_MS = 300;
const WATCH_RECOVERY_INITIAL_MS = 100;
const WATCH_RECOVERY_MAX_MS = 5_000;

export interface ConfigHotReloadPaths {
	readonly configPath: string;
	readonly modelsPath: string;
}

export interface ConfigHotReloadFileSnapshot {
	readonly path: string;
	readonly text: string | null;
	readonly identity: string;
}

export interface ConfigHotReloadCandidate {
	readonly revision: number;
	readonly config: ConfigHotReloadFileSnapshot;
	readonly models: ConfigHotReloadFileSnapshot;
}

export type ConfigHotReloadErrorOperation = "watch" | "read" | "validate" | "apply";

/** A path-free diagnostic for watcher, snapshot, and callback failures. */
export class ConfigHotReloadError extends Error {
	readonly operation: ConfigHotReloadErrorOperation;
	readonly code: string | undefined;

	constructor(operation: ConfigHotReloadErrorOperation, code?: string) {
		super(
			code
				? `Configuration hot reload ${operation} failed (${code})`
				: `Configuration hot reload ${operation} failed`,
		);
		this.name = "ConfigHotReloadError";
		this.operation = operation;
		this.code = code;
	}
}

export interface ConfigHotReloadWatcherOptions {
	/** Validate the snapshots without mutating live state before a candidate may supersede queued work. */
	readonly onValidate: (candidate: ConfigHotReloadCandidate) => void | Promise<void>;
	/** Apply these text snapshots, not a second read of their paths, and honor abort before commit. */
	readonly onCandidate: (candidate: ConfigHotReloadCandidate, signal: AbortSignal) => void | Promise<void>;
	readonly onError: (error: ConfigHotReloadError) => void;
}

interface FileSources {
	readonly config: ConfigHotReloadFileSnapshot;
	readonly models: ConfigHotReloadFileSnapshot;
}

interface Binding {
	readonly generation: number;
	readonly paths: ConfigHotReloadPaths;
	readonly watchers: Map<string, nodeFs.FSWatcher>;
	readonly watcherIdentities: Map<string, string>;
	watcherRecoveryTimer: NodeJS.Timeout | undefined;
	watcherRecoveryDelayMs: number;
	watcherDirectoryDiscoveryFailed: boolean;
	initializing: boolean;
	baselineIdentity: string | undefined;
	initialReadFailed: boolean;
	debounceStartedAt: number | undefined;
	debounceTimer: NodeJS.Timeout | undefined;
	scanning: boolean;
	scanRequested: boolean;
}

interface PendingCandidate {
	readonly binding: Binding;
	readonly candidate: ConfigHotReloadCandidate;
}

interface RunningCandidate extends PendingCandidate {
	readonly controller: AbortController;
}

function failureCode(error: unknown): string | undefined {
	if (!error || typeof error !== "object" || !("code" in error) || typeof error.code !== "string") return undefined;
	return /^[A-Z0-9_]+$/.test(error.code) ? error.code : undefined;
}

function missingFile(error: unknown): boolean {
	if (!error || typeof error !== "object" || !("code" in error) || typeof error.code !== "string") return false;
	return error.code === "ENOENT" || error.code === "ENOTDIR";
}

function identityFor(filePath: string, text: string | null): string {
	const hash = createHash("sha256");
	hash.update(filePath);
	hash.update("\0");
	hash.update(text === null ? "missing" : "present\0");
	if (text !== null) hash.update(text);
	return hash.digest("hex");
}

function pairIdentity(sources: FileSources): string {
	return `${sources.config.identity}:${sources.models.identity}`;
}

function pathsIdentity(paths: ConfigHotReloadPaths): string {
	return `${paths.configPath}\0${paths.modelsPath}`;
}

async function existingDirectory(filePath: string): Promise<string> {
	let current = path.dirname(filePath);
	for (;;) {
		try {
			const stat = await fs.stat(current);
			if (stat.isDirectory()) return current;
		} catch (error) {
			if (!missingFile(error)) throw error;
		}
		const parent = path.dirname(current);
		if (parent === current) return current;
		current = parent;
	}
}

async function existingDirectoryAncestors(filePath: string): Promise<Set<string>> {
	let current = await existingDirectory(filePath);
	const directories = new Set<string>();
	for (;;) {
		directories.add(current);
		const parent = path.dirname(current);
		if (parent === current) return directories;
		current = parent;
	}
}

function nextPathComponent(directory: string, filePath: string): string | undefined {
	const relativePath = path.relative(directory, filePath);
	if (
		!relativePath ||
		path.isAbsolute(relativePath) ||
		relativePath === ".." ||
		relativePath.startsWith(`..${path.sep}`)
	) {
		return undefined;
	}
	return relativePath.split(path.sep, 1)[0];
}

function normalizePaths(paths: ConfigHotReloadPaths): ConfigHotReloadPaths {
	if (!path.isAbsolute(paths.configPath) || !path.isAbsolute(paths.modelsPath)) {
		throw new TypeError("Configuration hot reload paths must be absolute");
	}
	return Object.freeze({
		configPath: path.resolve(paths.configPath),
		modelsPath: path.resolve(paths.modelsPath),
	});
}

/** Watches resolved config and models files and delivers immutable source snapshots. */
export class ConfigHotReloadWatcher {
	readonly #onCandidate: ConfigHotReloadWatcherOptions["onCandidate"];
	readonly #onValidate: ConfigHotReloadWatcherOptions["onValidate"];
	readonly #onError: ConfigHotReloadWatcherOptions["onError"];
	readonly #reportedErrors = new Set<string>();
	#binding: Binding | undefined;
	#pending: PendingCandidate | undefined;
	#running: RunningCandidate | undefined;
	#revision = 0;
	#highestQueuedRevision = 0;
	#generation = 0;
	#started = false;
	#disposed = false;

	constructor(options: ConfigHotReloadWatcherOptions) {
		this.#onCandidate = options.onCandidate;
		this.#onValidate = options.onValidate;
		this.#onError = options.onError;
	}

	/** Establishes the initial fingerprint baseline without emitting a candidate. */
	async start(paths: ConfigHotReloadPaths): Promise<void> {
		if (this.#disposed) throw new Error("Configuration hot reload watcher is disposed");
		if (this.#started) throw new Error("Configuration hot reload watcher has already started");
		const normalizedPaths = normalizePaths(paths);
		this.#started = true;
		const binding = this.#newBinding(normalizedPaths);
		this.#binding = binding;
		await this.#initializeBinding(binding);
	}

	/** Rebinds after session or configuration-root changes, fencing old work. */
	async rebind(paths: ConfigHotReloadPaths): Promise<void> {
		if (!this.#started) throw new Error("Configuration hot reload watcher has not started");
		if (this.#disposed) throw new Error("Configuration hot reload watcher is disposed");
		const normalizedPaths = normalizePaths(paths);
		this.#retireBinding(this.#binding);
		this.#pending = undefined;
		this.#running?.controller.abort();
		const binding = this.#newBinding(normalizedPaths);
		this.#binding = binding;
		await this.#initializeBinding(binding);
	}

	/** Closes all watches and cancels or fences pending and in-flight callbacks. */
	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#generation += 1;
		this.#pending = undefined;
		this.#running?.controller.abort();
		this.#retireBinding(this.#binding);
		this.#binding = undefined;
	}

	#newBinding(paths: ConfigHotReloadPaths): Binding {
		return {
			generation: ++this.#generation,
			paths,
			watchers: new Map(),
			watcherIdentities: new Map(),
			watcherRecoveryTimer: undefined,
			watcherRecoveryDelayMs: WATCH_RECOVERY_INITIAL_MS,
			watcherDirectoryDiscoveryFailed: false,
			initializing: true,
			baselineIdentity: undefined,
			initialReadFailed: false,
			debounceStartedAt: undefined,
			debounceTimer: undefined,
			scanning: false,
			scanRequested: false,
		};
	}

	async #initializeBinding(binding: Binding): Promise<void> {
		let before: FileSources | undefined;
		try {
			before = await this.#readSources(binding);
		} catch {
			if (this.#isCurrent(binding)) {
				binding.initialReadFailed = true;
			}
		}
		if (!this.#isCurrent(binding)) return;
		await this.#refreshWatchers(binding);
		if (!this.#isCurrent(binding)) return;

		let after: FileSources | undefined;
		try {
			after = await this.#readSources(binding);
		} catch {}
		if (!this.#isCurrent(binding)) return;

		if (before) {
			binding.baselineIdentity = pairIdentity(before);
			if (after && pairIdentity(after) !== binding.baselineIdentity) {
				binding.baselineIdentity = pairIdentity(after);
				this.#validateCandidate(binding, this.#candidate(after));
			}
		} else if (after) {
			binding.baselineIdentity = pairIdentity(after);
			binding.initialReadFailed = false;
			this.#validateCandidate(binding, this.#candidate(after));
		}

		binding.initializing = false;
		if (binding.scanRequested) void this.#scan(binding);
		this.#pump();
	}

	#isCurrent(binding: Binding): boolean {
		return !this.#disposed && this.#binding === binding && this.#generation === binding.generation;
	}

	#retireBinding(binding: Binding | undefined): void {
		if (!binding) return;
		if (binding.debounceTimer) clearTimeout(binding.debounceTimer);
		binding.debounceTimer = undefined;
		if (binding.watcherRecoveryTimer) clearTimeout(binding.watcherRecoveryTimer);
		binding.watcherRecoveryTimer = undefined;
		for (const watcher of binding.watchers.values()) watcher.close();
		binding.watchers.clear();
		binding.watcherIdentities.clear();
	}

	async #readSources(binding: Binding): Promise<FileSources> {
		const read = async (filePath: string): Promise<ConfigHotReloadFileSnapshot> => {
			let text: string | null;
			try {
				text = await Bun.file(filePath).text();
			} catch (error) {
				if (missingFile(error)) {
					text = null;
				} else {
					if (this.#isCurrent(binding)) this.#report("read", error, filePath);
					throw error;
				}
			}
			this.#clearErrors("read", filePath);
			return Object.freeze({ path: filePath, text, identity: identityFor(filePath, text) });
		};
		const [config, models] = await Promise.all([read(binding.paths.configPath), read(binding.paths.modelsPath)]);
		return Object.freeze({ config, models });
	}

	async #refreshWatchers(binding: Binding): Promise<void> {
		if (!this.#isCurrent(binding)) return;
		let desired = await this.#desiredWatchDirectories(binding);
		if (!this.#isCurrent(binding)) return;
		const attempted = new Set<string>();
		for (let attempt = 0; attempt < 3; attempt += 1) {
			for (const directory of desired.keys()) await this.#openWatcher(binding, directory, attempted);
			const verified = await this.#desiredWatchDirectories(binding);
			if (!this.#isCurrent(binding)) return;
			const stable =
				desired.size === verified.size && [...desired.keys()].every(directory => verified.has(directory));
			if (stable) {
				desired = verified;
				break;
			}
			desired = verified;
		}
		for (const directory of desired.keys()) await this.#openWatcher(binding, directory, attempted);
		for (const [directory, watcher] of binding.watchers) {
			if (desired.has(directory)) continue;
			watcher.close();
			binding.watchers.delete(directory);
			binding.watcherIdentities.delete(directory);
		}
		if (
			binding.watcherDirectoryDiscoveryFailed ||
			desired.size === 0 ||
			[...desired.keys()].some(directory => !binding.watchers.has(directory))
		) {
			this.#scheduleWatcherRecovery(binding);
		} else {
			this.#clearWatcherRecovery(binding);
		}
	}

	async #desiredWatchDirectories(binding: Binding): Promise<Map<string, Set<string>>> {
		let lookupFailed = false;
		const findDirectories = async (filePath: string): Promise<Set<string>> => {
			try {
				return await existingDirectoryAncestors(filePath);
			} catch (error) {
				if (this.#isCurrent(binding)) {
					lookupFailed = true;
					this.#report("watch", error, filePath);
				}
				return new Set();
			}
		};
		const [configDirectories, modelsDirectories] = await Promise.all([
			findDirectories(binding.paths.configPath),
			findDirectories(binding.paths.modelsPath),
		]);
		if (this.#isCurrent(binding)) {
			binding.watcherDirectoryDiscoveryFailed = lookupFailed;
			if (lookupFailed) this.#scheduleWatcherRecovery(binding);
		}
		const desired = new Map<string, Set<string>>();
		for (const [targetPath, directories] of [
			[binding.paths.configPath, configDirectories],
			[binding.paths.modelsPath, modelsDirectories],
		] as const) {
			for (const directory of directories) {
				const component = nextPathComponent(directory, targetPath);
				if (!component) continue;
				const components = desired.get(directory) ?? new Set<string>();
				components.add(component);
				desired.set(directory, components);
			}
		}
		return desired;
	}

	#candidate(sources: FileSources): ConfigHotReloadCandidate {
		return Object.freeze({
			revision: ++this.#revision,
			config: sources.config,
			models: sources.models,
		});
	}

	async #openWatcher(binding: Binding, directory: string, attempted: Set<string>): Promise<void> {
		if (attempted.has(directory)) return;
		try {
			const stat = await fs.stat(directory);
			if (!this.#isCurrent(binding)) return;
			const identity = `${stat.dev}:${stat.ino}`;
			if (binding.watchers.has(directory)) {
				if (binding.watcherIdentities.get(directory) === identity) return;
				binding.watchers.get(directory)!.close();
				binding.watchers.delete(directory);
				binding.watcherIdentities.delete(directory);
			}
			const watcher = nodeFs.watch(directory, (eventType, filename) => {
				if (filename === null) {
					this.#scheduleScan(binding);
					return;
				}
				const name = filename.toString();
				if (eventType === "rename" && name === path.basename(directory)) {
					binding.watchers.delete(directory);
					binding.watcherIdentities.delete(directory);
					watcher.close();
					this.#scheduleScan(binding);
					return;
				}
				if (!this.#matchesWatchedPath(binding, directory, name)) return;
				this.#scheduleScan(binding);
			});
			watcher.unref?.();
			watcher.on("error", error => {
				if (!this.#isCurrent(binding)) return;
				binding.watchers.delete(directory);
				binding.watcherIdentities.delete(directory);
				watcher.close();
				this.#report("watch", error, directory);
				this.#scheduleWatcherRecovery(binding);
			});
			binding.watchers.set(directory, watcher);
			binding.watcherIdentities.set(directory, identity);
			this.#clearErrors("watch", directory);
		} catch (error) {
			if (!this.#isCurrent(binding)) return;
			attempted.add(directory);
			this.#report("watch", error, directory);
			this.#scheduleWatcherRecovery(binding);
		}
	}

	#scheduleWatcherRecovery(binding: Binding): void {
		if (!this.#isCurrent(binding) || binding.watcherRecoveryTimer) return;
		const delay = binding.watcherRecoveryDelayMs;
		binding.watcherRecoveryDelayMs = Math.min(delay * 2, WATCH_RECOVERY_MAX_MS);
		binding.watcherRecoveryTimer = setTimeout(() => {
			binding.watcherRecoveryTimer = undefined;
			if (this.#isCurrent(binding)) void this.#scan(binding);
		}, delay);
		binding.watcherRecoveryTimer.unref?.();
	}

	#clearWatcherRecovery(binding: Binding): void {
		if (binding.watcherRecoveryTimer) clearTimeout(binding.watcherRecoveryTimer);
		binding.watcherRecoveryTimer = undefined;
		binding.watcherRecoveryDelayMs = WATCH_RECOVERY_INITIAL_MS;
	}

	#matchesWatchedPath(binding: Binding, directory: string, filename: string): boolean {
		return [binding.paths.configPath, binding.paths.modelsPath].some(
			filePath => nextPathComponent(directory, filePath) === filename,
		);
	}

	#scheduleScan(binding: Binding): void {
		if (!this.#isCurrent(binding)) return;
		const now = performance.now();
		binding.debounceStartedAt ??= now;
		if (binding.debounceTimer) clearTimeout(binding.debounceTimer);
		const deadline = Math.min(now + DEBOUNCE_QUIET_MS, binding.debounceStartedAt + DEBOUNCE_MAX_MS);
		binding.debounceTimer = setTimeout(
			() => {
				binding.debounceTimer = undefined;
				binding.debounceStartedAt = undefined;
				void this.#scan(binding);
			},
			Math.max(0, deadline - now),
		);
		binding.debounceTimer.unref?.();
	}

	async #scan(binding: Binding): Promise<void> {
		if (!this.#isCurrent(binding)) return;
		if (binding.initializing || binding.scanning) {
			binding.scanRequested = true;
			return;
		}
		binding.scanning = true;
		try {
			do {
				binding.scanRequested = false;
				await this.#refreshWatchers(binding);
				if (!this.#isCurrent(binding)) return;
				let sources: FileSources;
				try {
					sources = await this.#readSources(binding);
				} catch {
					if (!this.#isCurrent(binding)) return;
					continue;
				}
				if (!this.#isCurrent(binding)) return;
				const identity = pairIdentity(sources);
				const recoveringInitialRead = binding.baselineIdentity === undefined && binding.initialReadFailed;
				if (binding.baselineIdentity === undefined) {
					binding.baselineIdentity = identity;
					if (!recoveringInitialRead) continue;
					binding.initialReadFailed = false;
				}
				if (!recoveringInitialRead && binding.baselineIdentity === identity) continue;
				binding.baselineIdentity = identity;
				this.#validateCandidate(binding, this.#candidate(sources));
			} while (binding.scanRequested && this.#isCurrent(binding));
		} finally {
			binding.scanning = false;
			if (binding.scanRequested && this.#isCurrent(binding)) void this.#scan(binding);
		}
	}

	#validateCandidate(binding: Binding, candidate: ConfigHotReloadCandidate): void {
		const resource = pathsIdentity(binding.paths);
		void Promise.resolve()
			.then(() => {
				if (!this.#isCurrent(binding)) return;
				return this.#onValidate(candidate);
			})
			.then(() => {
				if (!this.#isCurrent(binding)) return;
				this.#clearErrors("validate", resource);
				this.#queueCandidate(binding, candidate);
			})
			.catch(error => {
				if (this.#isCurrent(binding)) this.#report("validate", error, resource);
			});
	}

	#queueCandidate(binding: Binding, candidate: ConfigHotReloadCandidate): void {
		const pendingRevision = this.#pending?.binding === binding ? this.#pending.candidate.revision : -1;
		const runningRevision = this.#running?.binding === binding ? this.#running.candidate.revision : -1;
		if (candidate.revision <= Math.max(this.#highestQueuedRevision, pendingRevision, runningRevision)) return;
		this.#highestQueuedRevision = candidate.revision;
		this.#pending = { binding, candidate };
		const running = this.#running;
		if (running && (running.binding !== binding || running.candidate.revision < candidate.revision)) {
			running.controller.abort();
		}
		this.#pump();
	}

	#pump(): void {
		if (this.#disposed || this.#running || !this.#pending || this.#pending.binding.initializing) {
			return;
		}
		const pending = this.#pending;
		this.#pending = undefined;
		if (!this.#isCurrent(pending.binding)) return;
		const running: RunningCandidate = { ...pending, controller: new AbortController() };
		this.#running = running;
		let succeeded = false;
		void Promise.resolve()
			.then(async () => {
				if (!this.#isCurrent(running.binding) || running.controller.signal.aborted) return;
				await this.#onCandidate(running.candidate, running.controller.signal);
				succeeded = true;
			})
			.catch(error => {
				if (!running.controller.signal.aborted && this.#isCurrent(running.binding)) {
					this.#report("apply", error, pathsIdentity(running.binding.paths));
				}
			})
			.finally(() => {
				if (this.#running === running) this.#running = undefined;
				if (succeeded && !running.controller.signal.aborted && this.#isCurrent(running.binding)) {
					this.#clearErrors("apply", pathsIdentity(running.binding.paths));
				}
				this.#pump();
			});
	}

	#errorKey(operation: ConfigHotReloadErrorOperation, resource: string | undefined, code: string | undefined): string {
		const resourceIdentity = createHash("sha256")
			.update(resource ?? "global")
			.digest("hex");
		return `${operation}:${resourceIdentity}:${code ?? "unknown"}`;
	}

	#clearErrors(operation: ConfigHotReloadErrorOperation, resource: string): void {
		const prefix = this.#errorKey(operation, resource, undefined).slice(0, -"unknown".length);
		for (const key of this.#reportedErrors) {
			if (key.startsWith(prefix)) this.#reportedErrors.delete(key);
		}
	}

	#report(operation: ConfigHotReloadErrorOperation, error: unknown, resource?: string): void {
		const key = this.#errorKey(operation, resource, failureCode(error));
		if (this.#reportedErrors.has(key)) return;
		this.#reportedErrors.add(key);
		try {
			this.#onError(new ConfigHotReloadError(operation, failureCode(error)));
		} catch {
			// Diagnostics must not destabilize the watcher.
		}
	}
}
