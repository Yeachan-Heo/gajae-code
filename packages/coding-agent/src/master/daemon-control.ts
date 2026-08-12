import { spawn as childProcessSpawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { DaemonHealth, DaemonOperationOptions, DaemonRuntimeInfo } from "../daemon/control-types";
import { MASTER_OWNER_INTERNAL_ACTION } from "../daemon/operator-contract";
import { resolveGjcRuntimeSpawnInfo } from "../daemon/runtime";
import type { MasterDaemonStatus as MasterDaemonRuntimeStatus } from "./daemon";
import {
	DEFAULT_MASTER_DAEMON_HEARTBEAT_TTL_MS,
	MASTER_DAEMON_LIFECYCLE_VERSION,
	MasterDaemon,
	type MasterDaemonHeartbeatRecord,
	type MasterDaemonOptions,
	type MasterDaemonOwnerRecord,
	type MasterDaemonStateRecord,
} from "./daemon";
import { getMasterRootPaths } from "./paths";

export interface MasterDaemonStatus {
	readonly kind: "master";
	readonly configured: boolean;
	readonly health: DaemonHealth;
	readonly pid?: number;
	readonly ownerId?: string;
	readonly startedAt?: number;
	readonly heartbeatAt?: number;
	readonly roots?: readonly string[];
	readonly rootCount?: number;
	readonly runtime: DaemonRuntimeInfo;
	readonly detail?: string;
}

export interface MasterDaemonOperationResult {
	readonly ok: boolean;
	readonly warnings: readonly string[];
	readonly message: string;
}

export interface MasterDaemonLike {
	start(): Promise<void>;
	stop(options?: { readonly drain?: boolean; readonly timeoutMs?: number }): Promise<MasterDaemonOperationResult>;
	reload(options?: { readonly drain?: boolean; readonly timeoutMs?: number }): Promise<MasterDaemonOperationResult>;
	status(): Promise<MasterDaemonRuntimeStatus>;
}

export type MasterDaemonFactory =
	| ((options: MasterDaemonOptions) => MasterDaemonLike | Promise<MasterDaemonLike>)
	| (() => MasterDaemonLike | Promise<MasterDaemonLike>);

export interface MasterDaemonControllerDeps {
	/** Explicit test seam; production defaults to the durable lifecycle below. */
	readonly status?: () => MasterDaemonStatus | Promise<MasterDaemonStatus>;
	/** Explicit test seam; production defaults to the durable lifecycle below. */
	readonly reload?: () => MasterDaemonOperationResult | Promise<MasterDaemonOperationResult>;
	/** Explicit test seam; production defaults to the durable lifecycle below. */
	readonly stop?: (
		opts?: DaemonOperationOptions,
	) => MasterDaemonOperationResult | Promise<MasterDaemonOperationResult>;
	readonly daemon?: MasterDaemonLike | MasterDaemonFactory;
	readonly createDaemon?: MasterDaemonFactory;
	readonly daemonFactory?: MasterDaemonFactory;
	readonly daemonOptions?: MasterDaemonOptions | (() => MasterDaemonOptions | Promise<MasterDaemonOptions>);
	readonly masterRootDir?: string;
	readonly rootDir?: string;
	readonly configRootDir?: string;
	readonly expectedAuthorityFingerprint?: string;
	readonly authorityFingerprint?: string;
	readonly now?: () => Date;
	readonly pidAlive?: (pid: number) => boolean | Promise<boolean>;
	/** Signal delivery seam; production sends the real POSIX signal to the owner pid. */
	readonly kill?: (pid: number, signal: NodeJS.Signals) => void;
	/** Owner spawn seam; production detaches a real `gjc` owner process. */
	readonly spawn?: (command: string, args: string[]) => { unref(): void; readonly exitCode: number | null };
	readonly heartbeatTtlMs?: number;
}

export type MasterDaemonReloadResult = MasterDaemonOperationResult;

const DEFAULT_GRACEFUL_TIMEOUT_MS = 10_000;
const DEFAULT_KILL_TIMEOUT_MS = 3_000;

const DEFAULT_RUNTIME: DaemonRuntimeInfo = Object.freeze({
	mode: "source",
	execPath: process.execPath,
	reloadPicksUpSourceEdits: true,
});

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

function defaultPidAlive(pid: number): boolean {
	if (!positiveSafeInteger(pid)) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return isNodeError(error, "EPERM");
	}
}

function copyStatus(status: MasterDaemonStatus): MasterDaemonStatus {
	return {
		...status,
		...(status.roots === undefined ? {} : { roots: [...status.roots] }),
		runtime: { ...status.runtime },
	};
}

function copyResult(result: MasterDaemonOperationResult): MasterDaemonOperationResult {
	return { ...result, warnings: [...result.warnings] };
}

function validateOwner(value: unknown): asserts value is MasterDaemonOwnerRecord {
	if (!isRecord(value) || value.version !== MASTER_DAEMON_LIFECYCLE_VERSION || value.kind !== "master_daemon_owner")
		throw new Error("master daemon owner record is malformed");
	if (
		typeof value.ownerId !== "string" ||
		value.ownerId.length === 0 ||
		!positiveSafeInteger(value.pid) ||
		!positiveSafeInteger(value.fence) ||
		!finiteTimestamp(value.startedAt) ||
		!finiteTimestamp(value.heartbeatAt) ||
		value.heartbeatAt < value.startedAt
	)
		throw new Error("master daemon owner record is invalid");
}

function validateHeartbeat(value: unknown): asserts value is MasterDaemonHeartbeatRecord {
	if (
		!isRecord(value) ||
		value.version !== MASTER_DAEMON_LIFECYCLE_VERSION ||
		value.kind !== "master_daemon_heartbeat"
	)
		throw new Error("master daemon heartbeat record is malformed");
	if (
		typeof value.ownerId !== "string" ||
		value.ownerId.length === 0 ||
		!positiveSafeInteger(value.pid) ||
		!positiveSafeInteger(value.fence) ||
		!finiteTimestamp(value.heartbeatAt)
	)
		throw new Error("master daemon heartbeat record is invalid");
}

function validateState(value: unknown): asserts value is MasterDaemonStateRecord {
	if (!isRecord(value) || value.version !== MASTER_DAEMON_LIFECYCLE_VERSION || value.kind !== "master_daemon_state")
		throw new Error("master daemon state record is malformed");
	if (
		!(
			"starting" === value.state ||
			"running" === value.state ||
			"stopping" === value.state ||
			"stopped" === value.state ||
			"error" === value.state
		)
	)
		throw new Error("master daemon state value is invalid");
	if (!Array.isArray(value.masterNames) || !value.masterNames.every(item => typeof item === "string"))
		throw new Error("master daemon state master names are invalid");
	if (!Array.isArray(value.roots) || !value.roots.every(item => typeof item === "string"))
		throw new Error("master daemon state roots are invalid");
	if (
		typeof value.runtimeCount !== "number" ||
		!Number.isSafeInteger(value.runtimeCount) ||
		value.runtimeCount < 0 ||
		typeof value.currentSeq !== "number" ||
		!Number.isSafeInteger(value.currentSeq) ||
		value.currentSeq < 0
	)
		throw new Error("master daemon state counters are invalid");
	if (value.ownerId !== undefined && (typeof value.ownerId !== "string" || value.ownerId.length === 0))
		throw new Error("master daemon state owner is invalid");
	if (value.pid !== undefined && !positiveSafeInteger(value.pid))
		throw new Error("master daemon state pid is invalid");
	if (value.fence !== undefined && !positiveSafeInteger(value.fence))
		throw new Error("master daemon state fence is invalid");
	if (value.startedAt !== undefined && !finiteTimestamp(value.startedAt))
		throw new Error("master daemon state startedAt is invalid");
	if (value.heartbeatAt !== undefined && !finiteTimestamp(value.heartbeatAt))
		throw new Error("master daemon state heartbeatAt is invalid");
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

async function configuredFromRoot(root: string): Promise<boolean> {
	try {
		const entries = await fs.readdir(path.join(root, "masters"), { withFileTypes: true });
		return entries.some(entry => entry.isDirectory() && !entry.isSymbolicLink());
	} catch (error) {
		if (isNodeError(error, "ENOENT")) return false;
		throw error;
	}
}

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
	const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
	await Bun.write(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
	await fs.chmod(temporaryPath, 0o600);
	await fs.rename(temporaryPath, filePath);
	await fs.chmod(filePath, 0o600);
}

interface LifecycleSnapshot {
	readonly root: string;
	readonly owner: MasterDaemonOwnerRecord | null;
	readonly heartbeat: MasterDaemonHeartbeatRecord | null;
	readonly state: MasterDaemonStateRecord | null;
}

export class MasterDaemonController {
	readonly #statusReader: (() => MasterDaemonStatus | Promise<MasterDaemonStatus>) | undefined;
	readonly #reloadOperation: (() => MasterDaemonOperationResult | Promise<MasterDaemonOperationResult>) | undefined;
	readonly #stopOperation:
		| ((opts?: DaemonOperationOptions) => MasterDaemonOperationResult | Promise<MasterDaemonOperationResult>)
		| undefined;
	readonly #deps: MasterDaemonControllerDeps;
	#daemon: MasterDaemonLike | null = null;

	constructor(deps: MasterDaemonControllerDeps = {}) {
		this.#deps = deps;
		this.#statusReader = deps.status;
		this.#reloadOperation = deps.reload;
		this.#stopOperation = deps.stop;
		if (deps.daemon && typeof deps.daemon !== "function") this.#daemon = deps.daemon;
	}

	async status(): Promise<MasterDaemonStatus> {
		if (this.#statusReader !== undefined) return copyStatus(await this.#statusReader());
		try {
			const lifecycle = await this.#readLifecycle();
			const daemon = this.#daemon;
			const actual = daemon ? await daemon.status() : undefined;
			return await this.#statusFromLifecycle(lifecycle, actual);
		} catch (error) {
			return {
				kind: "master",
				configured: true,
				health: "error",
				runtime: { ...DEFAULT_RUNTIME },
				detail: errorMessage(error),
			};
		}
	}

	async stop(opts: DaemonOperationOptions = {}): Promise<MasterDaemonOperationResult> {
		if (this.#stopOperation !== undefined) return copyResult(await this.#stopOperation(opts));
		const daemon = await this.#resolveDaemon();
		if (!daemon) {
			const status = await this.status();
			if (status.health === "stopped" && !status.pid)
				return { ok: true, warnings: [], message: "Master daemon is already stopped." };
			if (!status.pid)
				return {
					ok: false,
					warnings: ["No durable master daemon owner PID is available."],
					message: "Master daemon stop refused: owner identity is unavailable.",
				};
			const signalled = await this.#signalOwner(status.pid, "SIGTERM");
			if (signalled.kind === "exited") return signalled.result;
			if (signalled.kind === "failed") return signalled.result;
			const graceful = await this.#waitForStopped(opts.gracefulTimeoutMs ?? DEFAULT_GRACEFUL_TIMEOUT_MS);
			if (graceful.ok || opts.force !== true) return graceful;
			// `gjc daemon stop master --force` advertises hard-kill escalation: a
			// detached owner that ignored SIGTERM must still be recoverable.
			const killed = await this.#signalOwner(status.pid, "SIGKILL");
			if (killed.kind === "exited") return killed.result;
			if (killed.kind === "failed") return killed.result;
			const forced = await this.#waitForStopped(opts.killTimeoutMs ?? DEFAULT_KILL_TIMEOUT_MS);
			if (forced.ok) return forced;
			return {
				ok: false,
				warnings: ["Master daemon owner did not exit after SIGKILL."],
				message: "Master daemon stop timed out after forced escalation.",
			};
		}
		try {
			const result = copyResult(
				await daemon.stop({ drain: opts.force !== true, timeoutMs: opts.gracefulTimeoutMs }),
			);
			if (!result.ok) return result;
			const after = await this.status();
			if (after.health !== "stopped")
				return {
					ok: false,
					warnings: [after.detail ?? "owner or heartbeat remained after stop"],
					message: "Master daemon stop failed closed: stopped state was not proven.",
				};
			return result;
		} catch (error) {
			return {
				ok: false,
				warnings: [errorMessage(error)],
				message: "Master daemon stop failed closed; the durable owner was not claimed by this controller.",
			};
		}
	}

	async reload(opts: DaemonOperationOptions = {}): Promise<MasterDaemonOperationResult> {
		if (this.#reloadOperation !== undefined) return copyResult(await this.#reloadOperation());
		const daemon = await this.#resolveDaemon();
		if (!daemon) {
			// In ordinary CLI use there is no in-process daemon object even when a
			// healthy detached owner exists. Spawning here would start a competitor that
			// the live owner's fence rejects, while this process could observe the OLD
			// owner's still-fresh heartbeat and report a reload that never happened.
			const before = await this.status();
			if (before.health === "running") return await this.#replaceDetachedOwner(before, opts);
			if (opts.spawnIfStopped === false)
				return {
					ok: true,
					warnings: [],
					message: "Master daemon is stopped and --spawn-if-stopped=false was requested; nothing to reload.",
				};
			return await this.#spawnOwner();
		}
		try {
			const result = copyResult(await daemon.reload({ drain: true, timeoutMs: opts.gracefulTimeoutMs }));
			if (!result.ok) return result;
			const after = await this.status();
			if (after.health !== "running")
				return {
					ok: false,
					warnings: [after.detail ?? "running owner and fresh heartbeat were not proven"],
					message:
						"Master daemon reload failed closed; the durable master record remains stopped and recoverable.",
				};
			return result;
		} catch (error) {
			return {
				ok: false,
				warnings: [errorMessage(error)],
				message: "Master daemon reload failed closed; the durable master record remains stopped and recoverable.",
			};
		}
	}

	/**
	 * Reloads a healthy detached owner by stopping it and starting a successor.
	 * The successor must publish a DIFFERENT owner identity than the one observed
	 * beforehand, so a stale heartbeat from the predecessor can never be mistaken
	 * for a completed reload.
	 */
	async #replaceDetachedOwner(
		before: MasterDaemonStatus,
		opts: DaemonOperationOptions,
	): Promise<MasterDaemonOperationResult> {
		const stopped = await this.stop(opts);
		if (!stopped.ok)
			return {
				ok: false,
				warnings: [...stopped.warnings],
				message: "Master daemon reload failed closed; the running owner could not be stopped.",
			};
		return await this.#spawnOwner(before.ownerId);
	}

	async #spawnOwner(supersededOwnerId?: string): Promise<MasterDaemonOperationResult> {
		const runtime = resolveGjcRuntimeSpawnInfo(process.execPath);
		const args = [...runtime.argsPrefix, "daemon", MASTER_OWNER_INTERNAL_ACTION, "--agent-dir", this.#rootDir()];
		let child: { unref(): void; readonly exitCode: number | null };
		try {
			child = this.#deps.spawn
				? this.#deps.spawn(runtime.execPath, args)
				: childProcessSpawn(runtime.execPath, args, { detached: true, stdio: "ignore", env: process.env });
			child.unref();
		} catch (error) {
			return { ok: false, warnings: [errorMessage(error)], message: "Master daemon startup failed closed." };
		}
		const deadline = Date.now() + 10_000;
		let detail = "Master daemon did not publish a running heartbeat.";
		while (Date.now() < deadline) {
			await Bun.sleep(100);
			const status = await this.status();
			// A running status carrying the superseded owner id is the predecessor's
			// lingering record, not proof that this spawn took ownership.
			if (status.health === "running" && status.ownerId !== supersededOwnerId)
				return { ok: true, warnings: [], message: "Master daemon started with durable owner and heartbeat." };
			if (status.detail) detail = status.detail;
			if (child.exitCode !== null)
				return { ok: false, warnings: [detail], message: "Master daemon startup failed closed." };
		}
		return {
			ok: false,
			warnings: [detail],
			message: "Master daemon startup timed out.",
		};
	}

	/**
	 * Delivers one signal to the detached owner. An already-exited owner is
	 * fenced and reported as a successful stop; any other signal failure is
	 * terminal for this operation.
	 */
	async #signalOwner(
		pid: number,
		signal: NodeJS.Signals,
	): Promise<
		| { kind: "signalled" }
		| { kind: "exited"; result: MasterDaemonOperationResult }
		| { kind: "failed"; result: MasterDaemonOperationResult }
	> {
		try {
			(this.#deps.kill ?? ((target, sig) => process.kill(target, sig)))(pid, signal);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ESRCH") {
				await this.#fenceExitedOwner();
				return {
					kind: "exited",
					result: {
						ok: true,
						warnings: ["Master daemon owner had already exited; stale lifecycle records were fenced."],
						message: "Master daemon stopped and stale owner lease fenced.",
					},
				};
			}
			return {
				kind: "failed",
				result: { ok: false, warnings: [errorMessage(error)], message: "Master daemon stop signal failed." },
			};
		}
		return { kind: "signalled" };
	}

	async #waitForStopped(timeoutMs = DEFAULT_GRACEFUL_TIMEOUT_MS): Promise<MasterDaemonOperationResult> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			await Bun.sleep(100);
			const status = await this.status();
			if (status.health === "stopped" || status.health === "not_configured")
				return { ok: true, warnings: [], message: "Master daemon stopped and owner lease released." };
			if (status.pid && !(await (this.#deps.pidAlive ?? defaultPidAlive)(status.pid))) {
				await this.#fenceExitedOwner();
				return {
					ok: true,
					warnings: ["Master daemon exited before releasing its lease; stale lifecycle records were fenced."],
					message: "Master daemon stopped and stale owner lease fenced.",
				};
			}
		}
		return {
			ok: false,
			warnings: ["Timed out waiting for the master daemon owner to stop."],
			message: "Master daemon stop timed out.",
		};
	}
	async #fenceExitedOwner(): Promise<void> {
		const lifecycle = await this.#readLifecycle();
		if (lifecycle.owner && (await (this.#deps.pidAlive ?? defaultPidAlive)(lifecycle.owner.pid))) return;
		const paths = getMasterRootPaths({ masterRootDir: lifecycle.root });
		await Promise.all([
			fs.unlink(paths.daemonOwnerPath).catch(error => {
				if (!isNodeError(error, "ENOENT")) throw error;
			}),
			fs.unlink(paths.daemonHeartbeatPath).catch(error => {
				if (!isNodeError(error, "ENOENT")) throw error;
			}),
		]);
		if (lifecycle.state) {
			const stoppedAt = this.#deps.now?.().getTime() ?? Date.now();
			await atomicWriteJson(paths.daemonStatePath, {
				version: MASTER_DAEMON_LIFECYCLE_VERSION,
				kind: "master_daemon_state",
				state: "stopped",
				stoppedAt,
				...(lifecycle.state.authorityFingerprint === undefined
					? {}
					: { authorityFingerprint: lifecycle.state.authorityFingerprint }),
				masterNames: [...lifecycle.state.masterNames],
				roots: [...lifecycle.state.roots],
				runtimeCount: 0,
				currentSeq: lifecycle.state.currentSeq,
				detail: "Owner process exited; stale lifecycle records were fenced by the controller.",
			});
		}
	}
	async #resolveDaemon(): Promise<MasterDaemonLike | null> {
		if (this.#daemon !== null) return this.#daemon;
		const factory =
			(typeof this.#deps.daemon === "function" ? this.#deps.daemon : undefined) ??
			this.#deps.createDaemon ??
			this.#deps.daemonFactory;
		if (factory !== undefined) {
			const options = await this.#daemonOptions();
			this.#daemon = await (factory.length === 0
				? (factory as () => MasterDaemonLike | Promise<MasterDaemonLike>)()
				: factory(options));
			return this.#daemon;
		}
		if (this.#deps.daemonOptions !== undefined) {
			const options = await this.#daemonOptions();
			this.#daemon = new MasterDaemon(options);
			return this.#daemon;
		}
		return null;
	}

	async #daemonOptions(): Promise<MasterDaemonOptions> {
		const supplied = this.#deps.daemonOptions;
		const base = supplied === undefined ? {} : typeof supplied === "function" ? await supplied() : supplied;
		return {
			...base,
			...((base.masterRootDir ?? this.#deps.masterRootDir)
				? { masterRootDir: base.masterRootDir ?? this.#deps.masterRootDir }
				: {}),
			...((base.rootDir ?? this.#deps.rootDir) ? { rootDir: base.rootDir ?? this.#deps.rootDir } : {}),
			...((base.configRootDir ?? this.#deps.configRootDir)
				? { configRootDir: base.configRootDir ?? this.#deps.configRootDir }
				: {}),
			...((base.expectedAuthorityFingerprint ??
			this.#deps.expectedAuthorityFingerprint ??
			this.#deps.authorityFingerprint)
				? {
						expectedAuthorityFingerprint:
							base.expectedAuthorityFingerprint ??
							this.#deps.expectedAuthorityFingerprint ??
							this.#deps.authorityFingerprint,
					}
				: {}),
		};
	}

	async #readLifecycle(): Promise<LifecycleSnapshot> {
		const root = this.#rootDir();
		const paths = getMasterRootPaths({ masterRootDir: root });
		const [ownerValue, heartbeatValue, stateValue] = await Promise.all([
			readJson(paths.daemonOwnerPath),
			readJson(paths.daemonHeartbeatPath),
			readJson(paths.daemonStatePath),
		]);
		let owner: MasterDaemonOwnerRecord | null = null;
		let heartbeat: MasterDaemonHeartbeatRecord | null = null;
		let state: MasterDaemonStateRecord | null = null;
		if (ownerValue !== null) {
			validateOwner(ownerValue);
			owner = ownerValue;
		}
		if (heartbeatValue !== null) {
			validateHeartbeat(heartbeatValue);
			heartbeat = heartbeatValue;
		}
		if (stateValue !== null) {
			validateState(stateValue);
			state = stateValue;
		}
		return { root, owner, heartbeat, state };
	}

	async #statusFromLifecycle(
		lifecycle: LifecycleSnapshot,
		actual?: MasterDaemonRuntimeStatus,
	): Promise<MasterDaemonStatus> {
		const { root, owner, heartbeat, state } = lifecycle;
		const configured = state !== null ? state.masterNames.length > 0 : await configuredFromRoot(root);
		const base = {
			kind: "master" as const,
			configured,
			runtime: { ...DEFAULT_RUNTIME },
			...(state?.roots === undefined ? {} : { roots: [...state.roots] }),
			...(state?.roots === undefined ? {} : { rootCount: state.roots.length }),
			...(owner === null ? {} : { pid: owner.pid, ownerId: owner.ownerId, startedAt: owner.startedAt }),
			...(heartbeat?.heartbeatAt === undefined && state?.heartbeatAt === undefined
				? {}
				: { heartbeatAt: heartbeat?.heartbeatAt ?? state?.heartbeatAt }),
			...(state?.detail === undefined ? {} : { detail: state.detail }),
		};
		if (state === null && owner === null) return { ...base, health: configured ? "stopped" : "not_configured" };
		if (state === null)
			return { ...base, health: "error", detail: "master daemon owner exists without a durable state record" };
		if (state?.state === "error")
			return { ...base, health: "error", detail: state.detail ?? "master daemon is in an error state" };
		if (state?.state === "stopped") return { ...base, health: "stopped" };
		if (state?.state === "starting" || state?.state === "stopping")
			return {
				...base,
				health: "stopping",
				detail: state.state === "starting" ? "master daemon is starting" : "master daemon is stopping",
			};
		if (owner === null || heartbeat === null)
			return {
				...base,
				health: "error",
				detail: "master daemon state claims an owner without owner/heartbeat records",
			};
		if (owner.ownerId !== heartbeat.ownerId || owner.pid !== heartbeat.pid || owner.fence !== heartbeat.fence)
			return { ...base, health: "error", detail: "master daemon owner and heartbeat fences disagree" };
		if (
			state !== null &&
			(state.ownerId !== undefined || state.pid !== undefined || state.fence !== undefined) &&
			(state.ownerId !== owner.ownerId || state.pid !== owner.pid || state.fence !== owner.fence)
		)
			return { ...base, health: "error", detail: "master daemon state and owner fences disagree" };
		const now = this.#deps.now?.().getTime() ?? Date.now();
		const ttl = this.#deps.heartbeatTtlMs ?? DEFAULT_MASTER_DAEMON_HEARTBEAT_TTL_MS;
		const fresh = Number.isFinite(now) && heartbeat.heartbeatAt <= now && now - heartbeat.heartbeatAt <= ttl;
		const alive = await (this.#deps.pidAlive ?? defaultPidAlive)(owner.pid);
		if (!fresh || !alive)
			return {
				...base,
				health: "stale",
				detail: !alive ? "master daemon owner process is not alive" : "master daemon heartbeat is stale",
			};
		if (actual && !actual.running)
			return {
				...base,
				health: "error",
				detail: "master daemon owner heartbeat is fresh but runtime is not running",
			};
		return {
			...base,
			health: "running",
			...(actual?.root === undefined ? {} : { roots: [actual.root], rootCount: 1 }),
		};
	}

	#rootDir(): string {
		if (this.#deps.masterRootDir !== undefined) return path.resolve(this.#deps.masterRootDir);
		return getMasterRootPaths({ configRootDir: this.#deps.configRootDir ?? this.#deps.rootDir }).root;
	}
}

export const MasterDaemonControl = MasterDaemonController;
