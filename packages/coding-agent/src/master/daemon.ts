import { randomBytes, randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Model } from "@gajae-code/ai/core";
import { ModelRegistry } from "../config/model-registry";
import { resolveModelFromSettings } from "../config/model-resolver";
import { Settings } from "../config/settings";
import { discoverAuthStorage } from "../sdk/session";
import type { AuthStorage } from "../session/auth-storage";
import { assertCoordinatorAuthorityUnchanged, freezeCoordinatorAuthority } from "./authority";
import { createMasterCoordinatorGateway, type MasterCoordinatorGateway } from "./coordinator-gateway";
import { MasterDomainStore } from "./domain-store";
import type { MemoryContract } from "./memory-contract";
import { getMasterRootPaths, type MasterPathOptions } from "./paths";
import type { MasterRuntime, MasterRuntimeOptions, MasterRuntimeStatusSnapshot, MasterRuntimeStore } from "./runtime";
import { createMasterRuntime } from "./runtime";
import { createMasterSdk, type MasterSdk, type MasterSdkOptions } from "./sdk";
import type { MasterListItem, MasterProvider, ProviderHealth } from "./types";

export const MASTER_DAEMON_LIFECYCLE_VERSION = 1 as const;
export const DEFAULT_MASTER_DAEMON_HEARTBEAT_MS = 5_000;
export const DEFAULT_MASTER_DAEMON_HEARTBEAT_TTL_MS = 30_000;

export type MasterDaemonLifecycleState = "starting" | "running" | "stopping" | "stopped" | "error";

export interface MasterDaemonOwnerRecord {
	readonly version: typeof MASTER_DAEMON_LIFECYCLE_VERSION;
	readonly kind: "master_daemon_owner";
	readonly ownerId: string;
	readonly pid: number;
	readonly fence: number;
	readonly startedAt: number;
	readonly heartbeatAt: number;
	readonly authorityFingerprint?: string;
}

export interface MasterDaemonHeartbeatRecord {
	readonly version: typeof MASTER_DAEMON_LIFECYCLE_VERSION;
	readonly kind: "master_daemon_heartbeat";
	readonly ownerId: string;
	readonly pid: number;
	readonly fence: number;
	readonly heartbeatAt: number;
}

export interface MasterDaemonStateRecord {
	readonly version: typeof MASTER_DAEMON_LIFECYCLE_VERSION;
	readonly kind: "master_daemon_state";
	readonly state: MasterDaemonLifecycleState;
	readonly ownerId?: string;
	readonly pid?: number;
	readonly fence?: number;
	readonly startedAt?: number;
	readonly heartbeatAt?: number;
	readonly stoppedAt?: number;
	readonly authorityFingerprint?: string;
	readonly masterNames: readonly string[];
	readonly roots: readonly string[];
	readonly runtimeCount: number;
	readonly currentSeq: number;
	readonly detail?: string;
}

export interface MasterDaemonStoreFactory {
	open?(
		options: Record<string, unknown>,
	): Promise<MasterRuntimeStore | MasterDomainStore> | MasterRuntimeStore | MasterDomainStore;
	create?(
		options: Record<string, unknown>,
	): Promise<MasterRuntimeStore | MasterDomainStore> | MasterRuntimeStore | MasterDomainStore;
}

export type MasterDaemonRuntimeFactory = (
	masterName: string,
	store: MasterRuntimeStore | MasterDomainStore,
) => MasterRuntime | Promise<MasterRuntime>;

export interface MasterDaemonOptions {
	readonly masterRootDir?: string;
	readonly rootDir?: string;
	readonly configRootDir?: string;
	readonly stores?:
		| readonly (MasterRuntimeStore | MasterDomainStore)[]
		| ReadonlyMap<string, MasterRuntimeStore | MasterDomainStore>
		| Record<string, MasterRuntimeStore | MasterDomainStore>;
	readonly domainStores?:
		| readonly (MasterRuntimeStore | MasterDomainStore)[]
		| ReadonlyMap<string, MasterRuntimeStore | MasterDomainStore>
		| Record<string, MasterRuntimeStore | MasterDomainStore>;
	readonly storeFactory?: MasterDaemonStoreFactory;
	readonly openStore?: (
		options: Record<string, unknown>,
	) => Promise<MasterRuntimeStore | MasterDomainStore> | MasterRuntimeStore | MasterDomainStore;
	readonly coordinatorGateway?: MasterCoordinatorGateway | Record<string, unknown>;
	readonly coordinator?: MasterCoordinatorGateway | Record<string, unknown>;
	readonly memory?: MemoryContract;
	readonly model?: Model;
	readonly authStorage?: AuthStorage;
	readonly modelRegistry?: ModelRegistry;
	readonly providerHealth?: MasterRuntimeOptions["providerHealth"];
	readonly providers?: MasterRuntimeOptions["providers"];
	readonly assertAuthorityUnchanged?: MasterRuntimeOptions["assertAuthorityUnchanged"];
	readonly assertAuthority?: MasterRuntimeOptions["assertAuthority"];
	readonly expectedAuthorityFingerprint?: string;
	/** Alias accepted by durable-store callers when naming the frozen fingerprint. */
	readonly authorityFingerprint?: string;
	readonly createRuntime?: MasterDaemonRuntimeFactory;
	readonly runtimeFactory?: MasterDaemonRuntimeFactory;
	readonly runtimeOptions?: Omit<MasterRuntimeOptions, "masterName" | "domainStore" | "store">;
	readonly sdk?: MasterSdk;
	readonly sdkOptions?: Omit<MasterSdkOptions, "stores" | "domainStores" | "runtimes">;
	readonly createSdk?: (options: MasterSdkOptions) => Promise<MasterSdk> | MasterSdk;
	readonly now?: () => Date;
	readonly autoStart?: boolean;
	/** Test/embedding escape hatch; production ownership is enabled by default. */
	readonly manageOwnership?: boolean;
	readonly ownerId?: string;
	readonly ownerHeartbeatMs?: number;
	readonly ownerHeartbeatTtlMs?: number;
	readonly pid?: number;
	readonly pidAlive?: (pid: number) => boolean | Promise<boolean>;
}

export interface MasterDaemonStatus {
	readonly kind: "master";
	readonly configured: boolean;
	readonly running: boolean;
	readonly draining: boolean;
	readonly masterNames: readonly string[];
	readonly runtimeCount: number;
	readonly currentSeq: number;
	readonly root?: string;
	readonly runtimes: readonly MasterRuntimeStatusSnapshot[];
}

export interface MasterDaemonOperationResult {
	readonly ok: boolean;
	readonly warnings: readonly string[];
	readonly message: string;
}

function storesFrom(value: MasterDaemonOptions["stores"]): Map<string, MasterRuntimeStore | MasterDomainStore> {
	if (value === undefined) return new Map();
	if (value instanceof Map) return new Map(value);
	if (Array.isArray(value)) return new Map(value.map(store => [store.masterName, store] as const));
	return new Map(Object.entries(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function positiveSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function finiteTimestamp(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function canonicalAuthorityFingerprint(value: unknown): value is string {
	return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function randomFence(): number {
	const bytes = randomBytes(6).readUIntBE(0, 6);
	return Date.now() * 1_000 + bytes;
}

function defaultPidAlive(pid: number): boolean {
	if (!positiveSafeInteger(pid)) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return isNodeError(error, "EPERM");
	}
}

async function fsyncDirectory(directory: string): Promise<void> {
	if (process.platform === "win32") return;
	let handle: FileHandle | undefined;
	try {
		handle = await fs.open(directory, "r");
		await handle.sync();
	} catch (error) {
		if (!isNodeError(error, "EINVAL") && !isNodeError(error, "ENOTSUP") && !isNodeError(error, "EOPNOTSUPP"))
			throw error;
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
	await fs.mkdir(directory, { recursive: true, mode: 0o700 });
	const stat = await fs.lstat(directory);
	if (!stat.isDirectory() || stat.isSymbolicLink())
		throw new Error(`master daemon path is not a private directory: ${directory}`);
	await fs.chmod(directory, 0o700);
}

async function lstatOrNull(filePath: string): Promise<Stats | null> {
	try {
		return await fs.lstat(filePath);
	} catch (error) {
		if (isNodeError(error, "ENOENT")) return null;
		throw error;
	}
}

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
	const directory = path.dirname(filePath);
	await ensurePrivateDirectory(directory);
	const existing = await lstatOrNull(filePath);
	if (existing?.isSymbolicLink() || (existing !== null && !existing.isFile()))
		throw new Error(`master daemon path is not a regular file: ${filePath}`);
	const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
	let handle: FileHandle | undefined;
	try {
		handle = await fs.open(temporary, "wx", 0o600);
		await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
		await handle.sync();
		await handle.chmod(0o600);
		await handle.close();
		handle = undefined;
		await fs.rename(temporary, filePath);
		await fs.chmod(filePath, 0o600);
		await fsyncDirectory(directory);
	} finally {
		await handle?.close().catch(() => undefined);
		await fs.rm(temporary, { force: true }).catch(() => undefined);
	}
}

async function exclusiveCreateJson(filePath: string, value: unknown): Promise<void> {
	const directory = path.dirname(filePath);
	await ensurePrivateDirectory(directory);
	const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
	let handle: FileHandle | undefined;
	try {
		handle = await fs.open(temporary, "wx", 0o600);
		await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
		await handle.sync();
		await handle.chmod(0o600);
		await handle.close();
		handle = undefined;
		await fs.link(temporary, filePath);
		await fsyncDirectory(directory);
	} finally {
		await handle?.close().catch(() => undefined);
		await fs.rm(temporary, { force: true }).catch(() => undefined);
	}
}

async function readJson(filePath: string): Promise<unknown | null> {
	try {
		const stat = await fs.lstat(filePath);
		if (!stat.isFile() || stat.isSymbolicLink())
			throw new Error(`master daemon path is not a regular file: ${filePath}`);
		return JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
	} catch (error) {
		if (isNodeError(error, "ENOENT")) return null;
		if (error instanceof SyntaxError) throw new Error(`master daemon JSON is malformed: ${filePath}`);
		throw error;
	}
}

function ownerMatches(
	left: MasterDaemonOwnerRecord,
	right: Pick<MasterDaemonOwnerRecord, "ownerId" | "pid" | "fence">,
): boolean {
	return left.ownerId === right.ownerId && left.pid === right.pid && left.fence === right.fence;
}

function validateOwner(value: unknown): asserts value is MasterDaemonOwnerRecord {
	if (!isRecord(value) || value.version !== MASTER_DAEMON_LIFECYCLE_VERSION || value.kind !== "master_daemon_owner")
		throw new Error("master daemon owner record is malformed");
	if (
		!positiveSafeInteger(value.pid) ||
		!positiveSafeInteger(value.fence) ||
		typeof value.ownerId !== "string" ||
		value.ownerId.length === 0
	)
		throw new Error("master daemon owner identity is malformed");
	if (!finiteTimestamp(value.startedAt) || !finiteTimestamp(value.heartbeatAt) || value.heartbeatAt < value.startedAt)
		throw new Error("master daemon owner timestamps are malformed");
	if (value.authorityFingerprint !== undefined && !canonicalAuthorityFingerprint(value.authorityFingerprint))
		throw new Error("master daemon owner authority fingerprint is malformed");
}

function validateHeartbeat(value: unknown): asserts value is MasterDaemonHeartbeatRecord {
	if (
		!isRecord(value) ||
		value.version !== MASTER_DAEMON_LIFECYCLE_VERSION ||
		value.kind !== "master_daemon_heartbeat"
	)
		throw new Error("master daemon heartbeat record is malformed");
	if (
		!positiveSafeInteger(value.pid) ||
		!positiveSafeInteger(value.fence) ||
		typeof value.ownerId !== "string" ||
		value.ownerId.length === 0
	)
		throw new Error("master daemon heartbeat identity is malformed");
	if (!finiteTimestamp(value.heartbeatAt)) throw new Error("master daemon heartbeat timestamp is malformed");
}

function asRuntimeOptions(
	options: MasterDaemonOptions,
	masterName: string,
	store: MasterRuntimeStore | MasterDomainStore,
	providerHealth: MasterRuntimeOptions["providerHealth"],
	assertAuthority: MasterRuntimeOptions["assertAuthorityUnchanged"],
): MasterRuntimeOptions {
	return {
		...(options.runtimeOptions ?? {}),
		masterName,
		domainStore: store,
		coordinatorGateway:
			options.coordinatorGateway ??
			options.coordinator ??
			options.runtimeOptions?.coordinatorGateway ??
			options.runtimeOptions?.coordinator,
		memory: options.memory ?? options.runtimeOptions?.memory,
		model: options.model ?? options.runtimeOptions?.model,
		authStorage: options.authStorage ?? options.runtimeOptions?.authStorage,
		modelRegistry: options.modelRegistry ?? options.runtimeOptions?.modelRegistry,
		providerHealth,
		providers: options.providers ?? options.runtimeOptions?.providers,
		assertAuthorityUnchanged:
			assertAuthority ?? options.runtimeOptions?.assertAuthorityUnchanged ?? options.assertAuthorityUnchanged,
		assertAuthority: options.runtimeOptions?.assertAuthority ?? options.assertAuthority,
		now: options.now ?? options.runtimeOptions?.now,
	};
}

function providerHealthReader(store: MasterRuntimeStore | MasterDomainStore): MasterRuntimeOptions["providerHealth"] {
	const candidate = store as MasterRuntimeStore & {
		readProviderHealth?: () => Promise<ProviderHealth>;
		providerHealth?: () => Promise<ProviderHealth>;
	};
	if (typeof candidate.readProviderHealth === "function") return async () => await candidate.readProviderHealth!();
	if (typeof candidate.providerHealth === "function") return async () => await candidate.providerHealth!();
	if (typeof candidate.snapshot === "function" || typeof candidate.readSnapshot === "function") {
		return async () => {
			const snapshot = await (candidate.snapshot ?? candidate.readSnapshot)!.call(candidate);
			return snapshot.providerHealth;
		};
	}
	return {
		configuredProviders: [],
		activeProviders: [],
		degradedProviders: [],
		operational: false,
	};
}

export class MasterDaemon {
	readonly #options: MasterDaemonOptions;
	readonly #stores = new Map<string, MasterRuntimeStore | MasterDomainStore>();
	readonly #runtimes = new Map<string, MasterRuntime>();
	#sdk: MasterSdk | null;
	#running = false;
	#draining = false;
	#startPromise: Promise<void> | null = null;
	#stopPromise: Promise<MasterDaemonOperationResult> | null = null;
	#heartbeatTimer: NodeJS.Timeout | null = null;
	#owner: MasterDaemonOwnerRecord | null = null;
	#authorityFingerprint: string | undefined;

	constructor(options: MasterDaemonOptions = {}) {
		this.#options = options;
		this.#sdk = options.sdk ?? null;
		for (const [name, store] of storesFrom(options.stores ?? options.domainStores)) this.#stores.set(name, store);
		this.#authorityFingerprint = options.expectedAuthorityFingerprint ?? options.authorityFingerprint;
		if (options.autoStart) void this.start().catch(() => undefined);
	}

	get running(): boolean {
		return this.#running;
	}

	get draining(): boolean {
		return this.#draining;
	}

	get sdk(): MasterSdk | null {
		return this.#sdk;
	}

	get stores(): ReadonlyMap<string, MasterRuntimeStore | MasterDomainStore> {
		return this.#stores;
	}

	get runtimes(): ReadonlyMap<string, MasterRuntime> {
		return this.#runtimes;
	}

	get masterRootDir(): string {
		return this.#rootDir();
	}

	async start(): Promise<void> {
		if (this.#running) return;
		if (this.#startPromise) return await this.#startPromise;
		const task = this.#startInternal();
		this.#startPromise = task;
		try {
			await task;
		} finally {
			if (this.#startPromise === task) this.#startPromise = null;
		}
	}

	async restore(): Promise<void> {
		await this.start();
	}

	async stop(
		options: { readonly drain?: boolean; readonly timeoutMs?: number } = {},
	): Promise<MasterDaemonOperationResult> {
		if (this.#stopPromise) return await this.#stopPromise;
		const task = this.#stopInternal(options);
		this.#stopPromise = task;
		try {
			return await task;
		} finally {
			if (this.#stopPromise === task) this.#stopPromise = null;
		}
	}

	async close(): Promise<void> {
		await this.stop();
	}

	async reload(
		options: { readonly drain?: boolean; readonly timeoutMs?: number } = {},
	): Promise<MasterDaemonOperationResult> {
		const stopped = await this.stop({ drain: options.drain ?? true, timeoutMs: options.timeoutMs });
		if (!stopped.ok) return { ...stopped, message: "Master daemon reload was not attempted after stop warnings." };
		this.#runtimes.clear();
		try {
			await this.start();
			return { ok: true, warnings: [], message: "Master daemon reloaded with durable owner and heartbeat." };
		} catch (error) {
			const detail = errorMessage(error);
			await this.#writeState("stopped", detail).catch(() => undefined);
			return {
				ok: false,
				warnings: [detail],
				message: "Master daemon reload failed; the durable master records remain stopped and recoverable.",
			};
		}
	}

	async status(): Promise<MasterDaemonStatus> {
		return {
			kind: "master",
			configured:
				this.#stores.size > 0 ||
				this.#options.masterRootDir !== undefined ||
				this.#options.rootDir !== undefined ||
				this.#options.configRootDir !== undefined,
			running: this.#running,
			draining: this.#draining,
			masterNames: [...this.#stores.keys()].sort(),
			runtimeCount: this.#runtimes.size,
			currentSeq: this.#sdk?.state.currentSeq ?? 0,
			root: this.#rootDir(),
			runtimes: [...this.#runtimes.values()].map(runtime => runtime.status()),
		};
	}

	getRuntime(masterName: string): MasterRuntime | undefined {
		return this.#runtimes.get(masterName);
	}

	getStore(masterName: string): MasterRuntimeStore | MasterDomainStore | undefined {
		return this.#stores.get(masterName);
	}

	async reloadMaster(masterName: string): Promise<void> {
		const runtime = this.#runtimes.get(masterName);
		if (!runtime) throw new Error(`Unknown master: ${masterName}`);
		await runtime.reload();
	}

	async #startInternal(): Promise<void> {
		this.#draining = false;
		try {
			await this.#restoreStores();
			await this.#assertStoreAuthority();
			if (this.#stores.size === 0) throw new Error("No durable master records are available to restore.");
		} catch (error) {
			await this.#writeState("error", errorMessage(error)).catch(() => undefined);
			throw error;
		}
		if (this.#options.manageOwnership !== false) {
			try {
				await this.#acquireOwner();
			} catch (error) {
				await this.#releaseOwner().catch(() => undefined);
				await this.#writeState("error", errorMessage(error)).catch(() => undefined);
				throw error;
			}
		}
		try {
			await this.#writeState("starting");
			for (const [masterName, store] of this.#stores) {
				if (this.#runtimes.has(masterName)) continue;
				const runtime = await this.#makeRuntime(masterName, store);
				this.#runtimes.set(masterName, runtime);
			}
			for (const runtime of this.#runtimes.values()) await runtime.start();
			if (!this.#sdk) {
				const sdkOptions: MasterSdkOptions = {
					...(this.#options.sdkOptions ?? {}),
					stores: this.#stores,
					runtimes: this.#runtimes,
					providerEffects: this.#options.sdkOptions?.providerEffects ?? this.#providerEffects(),
					claims: this.#options.sdkOptions?.claims ?? this.#claims(),
				};
				this.#sdk = this.#options.createSdk
					? await this.#options.createSdk(sdkOptions)
					: await createMasterSdk(sdkOptions);
			} else if (!this.#sdk.state.running) await this.#sdk.start();
			this.#running = true;
			await this.#writeState("running");
			if (this.#options.manageOwnership !== false) this.#startHeartbeat();
		} catch (error) {
			const detail = errorMessage(error);
			await this.#stopRuntimeResources().catch(() => undefined);
			this.#running = false;
			this.#runtimes.clear();
			if (this.#options.manageOwnership !== false) {
				await this.#writeState("stopped", detail).catch(() => undefined);
				await this.#releaseOwner().catch(() => undefined);
			} else await this.#writeState("error", detail).catch(() => undefined);
			throw error;
		}
	}

	async #stopInternal(options: {
		readonly drain?: boolean;
		readonly timeoutMs?: number;
	}): Promise<MasterDaemonOperationResult> {
		if (!this.#running && this.#runtimes.size === 0) {
			if (this.#options.manageOwnership !== false && this.#owner !== null) {
				await this.#releaseOwner().catch(() => undefined);
			}
			return { ok: true, warnings: [], message: "Master daemon already stopped." };
		}
		this.#draining = options.drain === true;
		const warnings: string[] = [];
		if (this.#options.manageOwnership !== false)
			await this.#writeState("stopping").catch(error => warnings.push(errorMessage(error)));
		this.#stopHeartbeat();
		for (const runtime of this.#runtimes.values()) {
			try {
				await runtime.stop({ drain: this.#draining, timeoutMs: options.timeoutMs });
			} catch (error) {
				warnings.push(`${runtime.masterName}: ${errorMessage(error)}`);
			}
		}
		if (this.#sdk) await this.#sdk.stop().catch(error => warnings.push(`sdk: ${errorMessage(error)}`));
		this.#running = false;
		this.#draining = false;
		if (this.#options.manageOwnership !== false) {
			await this.#writeState("stopped", warnings.length > 0 ? warnings.join(" ") : undefined).catch(error => {
				warnings.push(errorMessage(error));
			});
			await this.#releaseOwner().catch(error => warnings.push(errorMessage(error)));
		}
		return {
			ok: warnings.length === 0,
			warnings,
			message:
				warnings.length === 0
					? "Master daemon stopped and owner lease released."
					: "Master daemon stopped with warnings; owner lease was fenced.",
		};
	}

	async #stopRuntimeResources(): Promise<void> {
		this.#stopHeartbeat();
		for (const runtime of this.#runtimes.values()) await runtime.stop();
		if (this.#sdk) await this.#sdk.stop();
	}

	async #restoreStores(): Promise<void> {
		const listOptions = {
			...(this.#options.masterRootDir === undefined ? {} : { masterRootDir: this.#options.masterRootDir }),
			...(this.#options.rootDir === undefined ? {} : { rootDir: this.#options.rootDir }),
			...(this.#options.configRootDir === undefined ? {} : { configRootDir: this.#options.configRootDir }),
		};
		const records: readonly MasterListItem[] = await MasterDomainStore.list(listOptions);
		for (const record of records) {
			if (this.#stores.has(record.masterName)) continue;
			const store = await this.#openStore(record.masterName, record.defaultWorkdir, record.maxConcurrentWorkers);
			this.#stores.set(record.masterName, store);
		}
	}

	async #assertStoreAuthority(): Promise<void> {
		let observed: string | undefined;
		for (const store of this.#stores.values()) {
			const record = typeof store.readRecord === "function" ? await store.readRecord() : undefined;
			if (!record) {
				if (this.#authorityFingerprint !== undefined)
					throw new Error("Master record authority fingerprint is unavailable.");
				continue;
			}
			const fingerprint = (record as Record<string, unknown>).authorityFingerprint;
			if (typeof fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(fingerprint)) {
				if (this.#authorityFingerprint !== undefined)
					throw new Error("Master record authority fingerprint is invalid.");
				continue;
			}
			if (observed === undefined) observed = fingerprint;
			else if (observed !== fingerprint)
				throw new Error("Master records disagree on Coordinator authority fingerprint.");
			if (this.#authorityFingerprint !== undefined && fingerprint !== this.#authorityFingerprint)
				throw new Error("Coordinator authority fingerprint changed from the frozen master authority.");
		}
		if (this.#authorityFingerprint === undefined) this.#authorityFingerprint = observed;
	}

	async #openStore(
		masterName: string,
		defaultWorkdir: string,
		maxConcurrentWorkers: number,
	): Promise<MasterRuntimeStore | MasterDomainStore> {
		const options = {
			masterName,
			defaultWorkdir,
			maxConcurrentWorkers,
			...(this.#authorityFingerprint === undefined
				? {}
				: { expectedAuthorityFingerprint: this.#authorityFingerprint }),
			...(this.#options.masterRootDir === undefined ? {} : { masterRootDir: this.#options.masterRootDir }),
			...(this.#options.rootDir === undefined ? {} : { rootDir: this.#options.rootDir }),
			...(this.#options.configRootDir === undefined ? {} : { configRootDir: this.#options.configRootDir }),
		};
		if (this.#options.openStore) return await this.#options.openStore(options);
		if (this.#options.storeFactory?.open) return await this.#options.storeFactory.open(options);
		return await MasterDomainStore.open(options);
	}

	async #makeRuntime(masterName: string, store: MasterRuntimeStore | MasterDomainStore): Promise<MasterRuntime> {
		const factory = this.#options.createRuntime ?? this.#options.runtimeFactory;
		if (factory) return await factory(masterName, store);
		const providerHealth =
			this.#options.providerHealth ??
			this.#options.providers ??
			this.#options.runtimeOptions?.providerHealth ??
			providerHealthReader(store);
		const authorityCheck = this.#options.assertAuthorityUnchanged ?? this.#options.assertAuthority;
		return createMasterRuntime(asRuntimeOptions(this.#options, masterName, store, providerHealth, authorityCheck));
	}

	#providerEffects(): NonNullable<MasterSdkOptions["providerEffects"]> {
		return {
			onWorkerHello: async frame => {
				let registered = false;
				for (const store of this.#stores.values()) {
					const register = (
						store as MasterDomainStore & {
							registerProviderWorker?: (input: {
								provider: MasterProvider;
								workerId: string;
								ttlMs: number;
							}) => Promise<unknown>;
						}
					).registerProviderWorker;
					if (typeof register !== "function") continue;
					try {
						await register.call(store, { provider: frame.provider, workerId: frame.workerId, ttlMs: 86_400_000 });
						registered = true;
					} catch (error) {
						if ((error as { code?: unknown })?.code !== "PROVIDER_NOT_CONFIGURED") throw error;
					}
				}
				if (!registered) throw new Error(`Provider ${frame.provider} is not configured for any master.`);
			},
		};
	}

	#claims(): NonNullable<MasterSdkOptions["claims"]> {
		return {
			request: async frame => {
				const store = this.#stores.get(frame.masterName);
				if (!(store instanceof MasterDomainStore)) throw new Error(`Unknown durable master: ${frame.masterName}`);
				const authorization = await store.mintClaimAuthorization({
					workerSessionId: frame.workerSessionId,
					requestedMasterName: frame.masterName,
					ingress: frame.ingress,
					idempotencyKey: frame.idempotencyKey,
				});
				return { ...authorization };
			},
			approve: async frame => {
				for (const store of this.#stores.values()) {
					if (!(store instanceof MasterDomainStore)) continue;
					if ((await store.getClaim(frame.claimId)) === null) continue;
					const result = await store.approveClaim({
						claimId: frame.claimId,
						ingress: frame.ingress,
						actorKind: "user",
						authenticated: true,
						idempotencyKey: frame.idempotencyKey,
					});
					return { ...result };
				}
				throw new Error(`Unknown ownership claim: ${frame.claimId}`);
			},
		};
	}

	#rootDir(): string {
		if (this.#options.masterRootDir !== undefined) return path.resolve(this.#options.masterRootDir);
		const sdkRoot = this.#options.sdkOptions?.masterRootDir;
		if (sdkRoot !== undefined) return path.resolve(sdkRoot);
		for (const store of this.#stores.values()) {
			const root = (store as { masterRootDir?: unknown }).masterRootDir;
			if (typeof root === "string" && root.length > 0) return path.resolve(root);
		}
		const pathOptions: MasterPathOptions = {
			configRootDir: this.#options.configRootDir ?? this.#options.rootDir,
		};
		return getMasterRootPaths(pathOptions).root;
	}

	#daemonPaths() {
		return getMasterRootPaths({ masterRootDir: this.#rootDir() });
	}

	#nowMs(): number {
		const value = this.#options.now?.().getTime() ?? Date.now();
		if (!Number.isFinite(value) || value < 0) throw new Error("Master daemon clock returned an invalid timestamp.");
		return value;
	}

	async #acquireOwner(): Promise<void> {
		const paths = this.#daemonPaths();
		await ensurePrivateDirectory(paths.root);
		await ensurePrivateDirectory(paths.daemonDir);
		const pid = this.#options.pid ?? process.pid;
		if (!positiveSafeInteger(pid)) throw new Error("Master daemon owner PID is invalid.");
		const now = this.#nowMs();
		const ownerId = this.#options.ownerId ?? `master-daemon-${randomUUID()}`;
		const candidate: MasterDaemonOwnerRecord = {
			version: MASTER_DAEMON_LIFECYCLE_VERSION,
			kind: "master_daemon_owner",
			ownerId,
			pid,
			fence: randomFence(),
			startedAt: now,
			heartbeatAt: now,
			...(this.#authorityFingerprint === undefined ? {} : { authorityFingerprint: this.#authorityFingerprint }),
		};
		const existingValue = await readJson(paths.daemonOwnerPath);
		if (existingValue !== null) {
			validateOwner(existingValue);
			const alive = await (this.#options.pidAlive ?? defaultPidAlive)(existingValue.pid);
			const age = now - existingValue.heartbeatAt;
			if (alive || age < 0) throw new Error("A live master daemon owner already holds the durable owner fence.");
			const before = `${JSON.stringify(existingValue, null, 2)}\n`;
			const observed = await fs.readFile(paths.daemonOwnerPath, "utf8");
			if (observed.trim() !== before.trim())
				throw new Error("Master daemon owner changed during stale-owner recovery.");
			await fs.unlink(paths.daemonOwnerPath);
		}
		try {
			await exclusiveCreateJson(paths.daemonOwnerPath, candidate);
		} catch (error) {
			const current = await readJson(paths.daemonOwnerPath).catch(() => null);
			if (current !== null || isNodeError(error, "EEXIST"))
				throw new Error("Master daemon owner fence is held by another process.");
			throw error;
		}
		this.#owner = candidate;
		await this.#writeHeartbeat(now);
	}

	#startHeartbeat(): void {
		this.#stopHeartbeat();
		const interval = this.#options.ownerHeartbeatMs ?? DEFAULT_MASTER_DAEMON_HEARTBEAT_MS;
		if (!Number.isSafeInteger(interval) || interval < 1)
			throw new Error("Master daemon heartbeat interval is invalid.");
		this.#heartbeatTimer = setInterval(() => {
			void this.#heartbeat().catch(error => {
				void this.#handleHeartbeatFailure(error);
			});
		}, interval);
		this.#heartbeatTimer.unref?.();
	}

	#stopHeartbeat(): void {
		if (this.#heartbeatTimer !== null) clearInterval(this.#heartbeatTimer);
		this.#heartbeatTimer = null;
	}

	async #heartbeat(): Promise<void> {
		if (!this.#owner || !this.#running) return;
		const paths = this.#daemonPaths();
		const currentValue = await readJson(paths.daemonOwnerPath);
		if (currentValue === null) throw new Error("Master daemon owner fence disappeared.");
		validateOwner(currentValue);
		if (!ownerMatches(currentValue, this.#owner)) throw new Error("Master daemon owner fence changed.");
		const now = this.#nowMs();
		this.#owner = { ...this.#owner, heartbeatAt: now };
		await this.#writeHeartbeat(now);
		await this.#writeState("running");
	}

	async #handleHeartbeatFailure(error: unknown): Promise<void> {
		if (!this.#owner) return;
		const detail = `Master daemon heartbeat failed: ${errorMessage(error)}`;
		this.#stopHeartbeat();
		await this.#stopRuntimeResources().catch(() => undefined);
		this.#running = false;
		this.#draining = false;
		await this.#writeState("error", detail).catch(() => undefined);
		await this.#releaseOwner().catch(() => undefined);
	}

	async #writeHeartbeat(heartbeatAt = this.#nowMs()): Promise<void> {
		if (!this.#owner) return;
		const heartbeat: MasterDaemonHeartbeatRecord = {
			version: MASTER_DAEMON_LIFECYCLE_VERSION,
			kind: "master_daemon_heartbeat",
			ownerId: this.#owner.ownerId,
			pid: this.#owner.pid,
			fence: this.#owner.fence,
			heartbeatAt,
		};
		await atomicWriteJson(this.#daemonPaths().daemonHeartbeatPath, heartbeat);
	}

	async #writeState(state: MasterDaemonLifecycleState, detail?: string): Promise<void> {
		const now = this.#nowMs();
		const roots: string[] = [];
		for (const store of this.#stores.values()) {
			const record =
				typeof store.readRecord === "function" ? await store.readRecord().catch(() => undefined) : undefined;
			if (record && typeof record.defaultWorkdir === "string" && !roots.includes(record.defaultWorkdir))
				roots.push(record.defaultWorkdir);
		}
		const value: MasterDaemonStateRecord = {
			version: MASTER_DAEMON_LIFECYCLE_VERSION,
			kind: "master_daemon_state",
			state,
			...(this.#owner === null
				? {}
				: {
						ownerId: this.#owner.ownerId,
						pid: this.#owner.pid,
						fence: this.#owner.fence,
						startedAt: this.#owner.startedAt,
						heartbeatAt: this.#owner.heartbeatAt,
					}),
			...(state === "stopped" ? { stoppedAt: now } : {}),
			...(this.#authorityFingerprint === undefined ? {} : { authorityFingerprint: this.#authorityFingerprint }),
			masterNames: [...this.#stores.keys()].sort(),
			roots,
			runtimeCount: this.#runtimes.size,
			currentSeq: this.#sdk?.state.currentSeq ?? 0,
			...(detail === undefined ? {} : { detail }),
		};
		await atomicWriteJson(this.#daemonPaths().daemonStatePath, value);
	}

	async #releaseOwner(): Promise<void> {
		this.#stopHeartbeat();
		const owner = this.#owner;
		if (!owner) return;
		const paths = this.#daemonPaths();
		const currentValue = await readJson(paths.daemonOwnerPath);
		if (currentValue !== null) {
			validateOwner(currentValue);
			if (!ownerMatches(currentValue, owner)) throw new Error("Master daemon owner fence changed before release.");
			await fs.rm(paths.daemonOwnerPath, { force: false });
			await fsyncDirectory(paths.daemonDir);
		}
		const heartbeatValue = await readJson(paths.daemonHeartbeatPath);
		if (heartbeatValue !== null) {
			validateHeartbeat(heartbeatValue);
			if (
				heartbeatValue.ownerId === owner.ownerId &&
				heartbeatValue.pid === owner.pid &&
				heartbeatValue.fence === owner.fence
			)
				await fs.rm(paths.daemonHeartbeatPath, { force: false });
		}
		this.#owner = null;
	}
}

export const ManagedMasterDaemon = MasterDaemon;
export const MasterDaemonRuntime = MasterDaemon;
export const MasterManagedDaemon = MasterDaemon;
export async function createMasterDaemon(options: MasterDaemonOptions = {}): Promise<MasterDaemon> {
	const daemon = new MasterDaemon(options);
	await daemon.start();
	return daemon;
}
export const createManagedMasterDaemon = createMasterDaemon;
export async function runMasterDaemon(options: MasterDaemonOptions = {}): Promise<MasterDaemon> {
	return await createMasterDaemon(options);
}
export async function runMasterDaemonInternal(masterRootDir?: string): Promise<void> {
	const authority = await freezeCoordinatorAuthority();
	const settings = await Settings.init();
	const authStorage = await discoverAuthStorage();
	const modelRegistry = new ModelRegistry(authStorage);
	const model = resolveModelFromSettings({
		settings,
		availableModels: modelRegistry.getAvailable(),
		modelRegistry,
	});
	if (model === undefined) throw new Error("No authenticated model is available for master sessions.");
	const coordinatorGateway = await createMasterCoordinatorGateway({ authority });
	const daemon = new MasterDaemon({
		...(masterRootDir === undefined ? {} : { masterRootDir }),
		expectedAuthorityFingerprint: authority.fingerprint,
		model,
		authStorage,
		modelRegistry,
		coordinatorGateway,
		assertAuthorityUnchanged: async () =>
			await assertCoordinatorAuthorityUnchanged(authority, authority.env as NodeJS.ProcessEnv),
	});
	await daemon.start();
	const lifecycle = Promise.withResolvers<void>();
	const stop = () => lifecycle.resolve();
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
	try {
		await lifecycle.promise;
	} finally {
		process.off("SIGINT", stop);
		process.off("SIGTERM", stop);
		await daemon.stop({ drain: true });
	}
}
