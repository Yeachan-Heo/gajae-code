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
import { type ProjectEnvSnapshot, projectEnvSnapshot } from "@gajae-code/utils/env-file";
import { trustedCoordinatorEnv } from "../gjc-runtime/sidecar-bootstrap-env";

export const SESSION_OWNERSHIP_MODES = ["off", "observe", "enforce"] as const;
export type SessionOwnershipMode = (typeof SESSION_OWNERSHIP_MODES)[number];
export const DEFAULT_SESSION_OWNERSHIP_MODE: SessionOwnershipMode = "off";
export const SESSION_OWNERSHIP_ENV = "GJC_SESSION_OWNERSHIP";

/** Test-only seams shared by the ownership modules. Code, not environment, so a project `.env` cannot reach them. */
export interface SessionOwnershipTestHookSlot {
	/** Trusted home for this process's claims and probes. The bun test preload sets it for every test process. */
	homeOverride?: string;
	/** Replaces the resolved mode. */
	mode?: SessionOwnershipMode;
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

function readTrustedOverride(): string | undefined {
	if (LAUNCH_CWD === undefined) return undefined;
	try {
		return trustedSessionOwnershipOverride(process.env, projectEnvSnapshot(LAUNCH_CWD));
	} catch {
		return undefined;
	}
}
let cachedOverride: { readonly value: string | undefined } | undefined;
let settingSource: (() => unknown) | undefined;

/** Settings supplies the global-only `session.ownership.mode` value. Without a source the default applies. */
export function setSessionOwnershipSettingSource(source: (() => unknown) | undefined): void {
	settingSource = source;
}

/**
 * The mode for this process now. With the setting `off` it returns before reading the environment,
 * so `off` does no work beyond reading the setting.
 */
export function sessionOwnershipMode(): SessionOwnershipMode {
	const forced = sessionOwnershipTestHookSlot().mode;
	if (forced !== undefined) return forced;
	let setting: unknown;
	try {
		setting = settingSource?.();
	} catch {
		setting = undefined;
	}
	if (resolveSessionOwnershipMode(setting, undefined) === "off") return "off";
	cachedOverride ??= { value: readTrustedOverride() };
	return resolveSessionOwnershipMode(setting, cachedOverride.value);
}
