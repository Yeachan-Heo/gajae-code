/**
 * Public types for the `gjc daemon` control plane.
 *
 * Deliberately compact: a small result/status surface plus a built-in
 * controller contract. There is exactly one daemon kind today (`telegram`);
 * a richer registry is intentionally deferred until a second kind exists.
 */

export type DaemonKind = "telegram" | "discord" | "slack";

export type DaemonAction = "list" | "status" | "stop" | "reload";

export type DaemonHealth = "not_configured" | "stopped" | "running" | "stale" | "stopping" | "error";

export interface DaemonRuntimeInfo {
	/** `source` when respawn goes through bun/node + the entry script; `compiled` for a single-file binary. */
	mode: "source" | "compiled";
	execPath: string;
	/** True only in source/dev mode, where a respawn loads amended TypeScript directly. */
	reloadPicksUpSourceEdits: boolean;
	/** Present when the runtime mode constrains what reload can achieve (e.g. compiled binary). */
	warning?: string;
}

export interface DaemonStatus {
	kind: DaemonKind;
	configured: boolean;
	health: DaemonHealth;
	pid?: number;
	ownerId?: string;
	startedAt?: number;
	heartbeatAt?: number;
	roots?: string[];
	rootCount?: number;
	runtime: DaemonRuntimeInfo;
	detail?: string;
}

export interface DaemonOperationOptions {
	/** How long to wait for cooperative release before escalating. */
	gracefulTimeoutMs?: number;
	/** How long to wait for the old pid to die after SIGKILL. */
	killTimeoutMs?: number;
	/** Allow hard-kill escalation / acting on a still-live owner. */
	force?: boolean;
	/** For reload: spawn a fresh owner even when none is currently running. */
	spawnIfStopped?: boolean;
}

export interface DaemonRecovery {
	/** Machine-readable recovery category for automation branching. */
	reason: "ownership_mismatch";
	/** One-line human summary of why the operation could not proceed. */
	summary: string;
	/** Ordered, copy-pasteable remediation steps. */
	steps: string[];
}

export interface DaemonOperationResult {
	kind: DaemonKind;
	action: Exclude<DaemonAction, "list">;
	ok: boolean;
	before?: DaemonStatus;
	after?: DaemonStatus;
	warnings: string[];
	message: string;
	/** Present when the operation was refused with an actionable recovery path (e.g. ownership mismatch). */
	recovery?: DaemonRecovery;
}

export interface BuiltInDaemonController {
	readonly kind: DaemonKind;
	status(): Promise<DaemonStatus>;
	stop(opts?: DaemonOperationOptions): Promise<DaemonOperationResult>;
	reload(opts?: DaemonOperationOptions): Promise<DaemonOperationResult>;
}
