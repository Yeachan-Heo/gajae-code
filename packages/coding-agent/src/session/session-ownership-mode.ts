/**
 * Session ownership mode and test seams (design §2.3, §7.3).
 *
 * - `off`: no claims and no lock calls; the process is invisible to other processes' claims.
 * - `observe`: claims and the write-path detector run, and nothing is refused.
 * - `enforce`: refusals as each later step enables them.
 *
 * The mode comes from the user setting `session.ownership.mode`, which is global-only, so a project
 * cannot set it. The environment override `GJC_SESSION_OWNERSHIP` is read only when the operator
 * set it (not a project `.env`) and can only lower the mode.
 *
 * A leaf module: Settings imports it to supply the setting, so it imports nothing from config.
 */
import { logger } from "@gajae-code/utils";
import { type ProjectEnvSnapshot, projectEnvSnapshot } from "@gajae-code/utils/env-file";
import { trustedCoordinatorEnv } from "../gjc-runtime/sidecar-bootstrap-env";

export const SESSION_OWNERSHIP_MODES = ["off", "observe", "enforce"] as const;
export type SessionOwnershipMode = (typeof SESSION_OWNERSHIP_MODES)[number];
/**
 * The mode when the operator set none. It is the effective default: `Settings.getGlobal` returns no
 * value for an unset key, so the resolver falls back to this, and the schema default only mirrors it
 * for display (a test keeps the two equal).
 */
export const DEFAULT_SESSION_OWNERSHIP_MODE: SessionOwnershipMode = "observe";
export const SESSION_OWNERSHIP_ENV = "GJC_SESSION_OWNERSHIP";

/** Test-only seams shared by the ownership modules. Code, not environment, so a project `.env` cannot reach them. */
export interface SessionOwnershipTestHookSlot {
	/** Trusted home for this process's claims and probes. The bun test preload sets it for every test process. */
	homeOverride?: string;
	/** Replaces the resolved mode. */
	mode?: SessionOwnershipMode;
	/**
	 * The strict seam (design §2.5): a write the detector flags throws `SessionWriteWithoutClaimError`
	 * instead of only being logged and counted. Entry-path and control-matrix tests turn it on.
	 */
	strictWriteDetection?: boolean;
	/**
	 * Where ownership counters are written. While `homeOverride` is set (every test process), counts
	 * go here or nowhere, so a test never writes the operator's stats database.
	 */
	statsDbPath?: string;
}

/**
 * One slot per process, under a versioned `globalThis` symbol, so two copies of the ownership
 * modules share it and the test preload can fill it without importing them.
 */
const TEST_HOOKS_KEY = Symbol.for("gajae-code.session-ownership.test-hooks.v1");

export function sessionOwnershipTestHookSlot(): SessionOwnershipTestHookSlot {
	const store = globalThis as unknown as Record<symbol, SessionOwnershipTestHookSlot | undefined>;
	let slot = store[TEST_HOOKS_KEY];
	if (!slot) {
		slot = {};
		store[TEST_HOOKS_KEY] = slot;
	}
	return slot;
}

const RANK: Record<SessionOwnershipMode, number> = { off: 0, observe: 1, enforce: 2 };

function parseMode(value: unknown): SessionOwnershipMode | undefined {
	return typeof value === "string" && (SESSION_OWNERSHIP_MODES as readonly string[]).includes(value)
		? (value as SessionOwnershipMode)
		: undefined;
}

/**
 * The effective mode: the setting (an invalid value reads as the default), lowered by `override`
 * when that is a valid, lower mode. `override` never raises the mode.
 */
export function resolveSessionOwnershipMode(setting: unknown, override: string | undefined): SessionOwnershipMode {
	const configured = parseMode(setting) ?? DEFAULT_SESSION_OWNERSHIP_MODE;
	if (configured === "off") return "off";
	const lowered = parseMode(override?.trim().toLowerCase());
	return lowered !== undefined && RANK[lowered] < RANK[configured] ? lowered : configured;
}

/**
 * `GJC_SESSION_OWNERSHIP` as the operator set it. A value that matches the project dotenv
 * snapshot was loaded by Bun from the repository and is ignored, as is any value when that
 * snapshot could not be read in full.
 */
export function trustedSessionOwnershipOverride(
	env: NodeJS.ProcessEnv,
	snapshot: ProjectEnvSnapshot,
): string | undefined {
	if (snapshot.incomplete) return undefined;
	return trustedCoordinatorEnv(SESSION_OWNERSHIP_ENV, env, snapshot);
}

/**
 * Remove a project-supplied `GJC_SESSION_OWNERSHIP` from `env` before it reaches a child. A child in
 * another directory (a `--tmux --worktree` launch runs `--no-env-file` there) checks provenance against
 * that directory's `.env`, so it would trust this project's value. Called beside the `HERDR_BIN_PATH`
 * drop, with the same startup snapshot.
 */
export function dropProjectSuppliedSessionOwnershipOverride(
	env: NodeJS.ProcessEnv,
	snapshot: ProjectEnvSnapshot,
): void {
	if (env[SESSION_OWNERSHIP_ENV] === undefined) return;
	if (trustedCoordinatorEnv(SESSION_OWNERSHIP_ENV, env, snapshot) === undefined) delete env[SESSION_OWNERSHIP_ENV];
}

/**
 * Bun loads the project `.env` from the launch directory, so provenance is checked there. A launch
 * directory that is already gone leaves no snapshot to check against, and the override is ignored.
 */
const LAUNCH_CWD = ((): string | undefined => {
	try {
		return process.cwd();
	} catch {
		return undefined;
	}
})();

/** The override as read once for this process: the trusted value, or why the variable was ignored. */
interface OverrideRead {
	readonly value: string | undefined;
	readonly ignored?: "project_env" | "unreadable";
}

function readOverride(): OverrideRead {
	const raw = process.env[SESSION_OWNERSHIP_ENV];
	if (raw === undefined || raw.trim() === "") return { value: undefined };
	if (LAUNCH_CWD === undefined) return { value: undefined, ignored: "unreadable" };
	try {
		const value = trustedSessionOwnershipOverride(process.env, projectEnvSnapshot(LAUNCH_CWD));
		return value === undefined ? { value, ignored: "project_env" } : { value };
	} catch {
		return { value: undefined, ignored: "unreadable" };
	}
}

let cachedOverride: OverrideRead | undefined;
let reportedOverride = false;

/** An ignored override fails quietly for the user, so say why once, at debug level. */
function reportIgnoredOverride(read: OverrideRead, configured: SessionOwnershipMode, effective: SessionOwnershipMode) {
	if (reportedOverride) return;
	let reason: string | undefined;
	if (read.ignored === "project_env") reason = "it was set by the project .env, not the operator";
	else if (read.ignored === "unreadable") reason = "the project .env could not be checked";
	else if (read.value !== undefined) {
		const requested = parseMode(read.value.trim().toLowerCase());
		if (requested === undefined) reason = "its value is not off, observe or enforce";
		else if (effective === configured && requested !== configured) reason = "it can only lower the configured mode";
	}
	if (reason === undefined) return;
	reportedOverride = true;
	logger.debug(`${SESSION_OWNERSHIP_ENV} ignored: ${reason}`, { configured });
}

/** Test-only: forget the cached override, so a test can change the environment. */
export function resetSessionOwnershipModeForTests(): void {
	cachedOverride = undefined;
	reportedOverride = false;
}

/** Test-only: whether this process has read `GJC_SESSION_OWNERSHIP` since the last reset. */
export function sessionOwnershipOverrideWasRead(): boolean {
	return cachedOverride !== undefined;
}

/** `fresh` asks for the value on disk now, past any cache, where the source has one. */
export type SessionOwnershipSettingSource = (options?: { readonly fresh?: boolean }) => unknown;

let settingSource: SessionOwnershipSettingSource | undefined;

/**
 * Settings supplies the operator's global `session.ownership.mode` value: the process settings, or,
 * before `Settings.init`, the agent directory's config file. Without a source the default applies.
 */
export function setSessionOwnershipSettingSource(source: SessionOwnershipSettingSource | undefined): void {
	settingSource = source;
}

function readSettingSource(options?: { readonly fresh?: boolean }): unknown {
	try {
		return settingSource?.(options);
	} catch {
		return undefined;
	}
}

/**
 * The mode as the operator has it now, for a refusal decision (5a). A refusal needs `enforce` both
 * here and in the mode its factory read, so this can only lower a decision: `gjc config set
 * session.ownership.mode off` reaches a running process's next refusal. It reads the config file
 * again in a process without global settings; with them, it reads their (hot-reloaded) value.
 */
export function liveSessionOwnershipMode(): SessionOwnershipMode {
	const forced = sessionOwnershipTestHookSlot().mode;
	if (forced !== undefined) return forced;
	const value = readSettingSource({ fresh: true });
	if (resolveSessionOwnershipMode(value, undefined) === "off") return "off";
	cachedOverride ??= readOverride();
	return resolveSessionOwnershipMode(value, cachedOverride.value);
}

/**
 * The mode for this process now. With the setting `off` it returns before reading the environment,
 * so `off` does no work beyond reading the setting.
 */
export function sessionOwnershipMode(): SessionOwnershipMode {
	return sessionOwnershipModeFor(undefined);
}

/**
 * The mode for a `session.ownership.mode` value read from settings other than the global instance
 * (a launch that opens its session before `Settings.init`, or a scoped load), with the same override.
 * A missing or invalid value, as from settings that never loaded the operator's config file (an
 * embedding's `Settings.isolated()`), falls back to the setting source, so the operator's `off` still
 * applies. A valid explicit value wins.
 */
export function sessionOwnershipModeFor(setting: unknown): SessionOwnershipMode {
	const forced = sessionOwnershipTestHookSlot().mode;
	if (forced !== undefined) return forced;
	const value = parseMode(setting) === undefined ? readSettingSource() : setting;
	const configured = resolveSessionOwnershipMode(value, undefined);
	// `off` is the kill switch: it returns before the environment is read at all.
	if (configured === "off") return "off";
	cachedOverride ??= readOverride();
	const effective = resolveSessionOwnershipMode(value, cachedOverride.value);
	reportIgnoredOverride(cachedOverride, configured, effective);
	return effective;
}
