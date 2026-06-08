/**
 * GitHub star reminder.
 *
 * On interactive launch, if `gh` is authenticated and the GJC repo is not
 * starred, the user is nudged to star it. Declining switches to a per-session
 * persuasion message injected at the before-agent-start point until the repo is
 * starred. Detection is `gh`-only: if `gh` is missing, unauthenticated, offline,
 * or fails for any non-404 reason, the feature stays completely silent.
 *
 * All state lives in a user-global file under the GJC config root and is updated
 * under a file lock with atomic temp+rename writes and a monotonic merge that
 * never lets a stale "declined"/"unstarred" write clobber a confirmed star.
 */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ImageContent, MessageAttribution } from "@gajae-code/ai";
import { getConfigRootDir, isEnoent } from "@gajae-code/utils";
import { withFileLock } from "../config/file-lock";
import type { CustomMessage } from "../session/messages";

export const STAR_REMINDER_REPO = "Yeachan-Heo/gajae-code";
export const STAR_REMINDER_CUSTOM_TYPE = "star-reminder";
export const STARRED_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const GH_TIMEOUT_MS = 5_000;

export interface StarReminderState {
	declined: boolean;
	starred: boolean;
	/** ISO-8601 timestamp of the last authoritative star check, or "" if never. */
	starredCheckedAt: string;
}

export type StarCheckStatus = "starred" | "unstarred" | "unavailable";

export interface GhResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	timedOut?: boolean;
}

export type RunGh = (args: string[], options?: { timeoutMs?: number }) => Promise<GhResult>;

export interface StarReminderDeps {
	statePath?: string;
	now?: () => Date;
	runGh?: RunGh;
	sleep?: (ms: number) => Promise<void>;
}

// --------------------------------------------------------------------------
// State path + defaults
// --------------------------------------------------------------------------

export function getStarReminderStatePath(): string {
	return path.join(getConfigRootDir(), "star-reminder.json");
}

export function defaultStarReminderState(): StarReminderState {
	return { declined: false, starred: false, starredCheckedAt: "" };
}

function resolveStatePath(deps?: StarReminderDeps): string {
	return deps?.statePath ?? getStarReminderStatePath();
}

function resolveNow(deps?: StarReminderDeps): Date {
	return deps?.now ? deps.now() : new Date();
}

function isValidState(value: unknown): value is StarReminderState {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	return typeof v.declined === "boolean" && typeof v.starred === "boolean" && typeof v.starredCheckedAt === "string";
}

// --------------------------------------------------------------------------
// State IO
// --------------------------------------------------------------------------

/** Read state without locking. Missing or malformed files return the default. */
export async function readStarReminderStateUnlocked(statePath?: string): Promise<StarReminderState> {
	const target = statePath ?? getStarReminderStatePath();
	try {
		const raw = await fs.readFile(target, "utf8");
		const parsed = JSON.parse(raw) as unknown;
		if (!isValidState(parsed)) return defaultStarReminderState();
		return { declined: parsed.declined, starred: parsed.starred, starredCheckedAt: parsed.starredCheckedAt };
	} catch (err) {
		if (isEnoent(err)) return defaultStarReminderState();
		// Malformed JSON or any read error -> treat as default; never throw to UI.
		return defaultStarReminderState();
	}
}

/** Whether a stored `starred:true` is still within the 24h cache window. */
export function isStarredCacheFresh(state: StarReminderState, now: Date = new Date()): boolean {
	if (!state.starred) return false;
	const checked = new Date(state.starredCheckedAt).getTime();
	if (Number.isNaN(checked)) return false;
	const age = now.getTime() - checked;
	return age >= 0 && age < STARRED_CACHE_TTL_MS;
}

async function writeStateAtomic(statePath: string, state: StarReminderState): Promise<void> {
	await fs.mkdir(path.dirname(statePath), { recursive: true, mode: 0o700 });
	const temp = `${statePath}.tmp.${process.pid}.${Date.now()}.${randomUUID()}`;
	try {
		await fs.writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
		await fs.rename(temp, statePath);
	} catch (err) {
		await fs.rm(temp, { force: true }).catch(() => {});
		throw err;
	}
}

/**
 * Lock-protected read-modify-write. The mutator receives the freshly re-read
 * state under the lock; callers MUST base monotonic decisions on that value,
 * not on any snapshot captured before the lock was held.
 */
export async function updateStarReminderStateLocked(
	mutator: (current: StarReminderState) => StarReminderState | Promise<StarReminderState>,
	deps?: StarReminderDeps,
): Promise<StarReminderState> {
	const statePath = resolveStatePath(deps);
	// The lock file lives next to the state file, so its parent dir must exist
	// before withFileLock tries to create the (non-recursive) lock directory.
	await fs.mkdir(path.dirname(statePath), { recursive: true, mode: 0o700 });
	return withFileLock(statePath, async () => {
		const current = await readStarReminderStateUnlocked(statePath);
		const next = await mutator(current);
		await writeStateAtomic(statePath, next);
		return next;
	});
}

// --------------------------------------------------------------------------
// Monotonic merge helpers
// --------------------------------------------------------------------------

/** A successful PUT is authoritative: always record starred and clear declined. */
export async function recordStarredFromPut(deps?: StarReminderDeps): Promise<StarReminderState> {
	const checkedAt = resolveNow(deps).toISOString();
	return updateStarReminderStateLocked(() => ({ declined: false, starred: true, starredCheckedAt: checkedAt }), deps);
}

/**
 * Record the result of a fresh `gh` star check performed by this operation.
 * - "starred": authoritative, clears declined so all reminders stop.
 * - "unstarred": may downgrade, but only when the current state is not a
 *   still-fresh confirmed star (which a concurrent process may have just
 *   written); in that case the fresher confirmation wins.
 */
export async function recordFreshStarCheck(
	status: "starred" | "unstarred",
	deps?: StarReminderDeps,
): Promise<StarReminderState> {
	const now = resolveNow(deps);
	const checkedAt = now.toISOString();
	return updateStarReminderStateLocked(current => {
		if (status === "starred") {
			return { declined: false, starred: true, starredCheckedAt: checkedAt };
		}
		// Preserve a confirmed star that is either still within the cache window
		// or was written concurrently AFTER this operation's check time. The latter
		// guards against a stale unstarred observation clobbering a newer star that
		// another process recorded while we were waiting on the lock.
		if (current.starred) {
			const currentChecked = new Date(current.starredCheckedAt).getTime();
			const newerThanThisCheck = !Number.isNaN(currentChecked) && currentChecked > now.getTime();
			if (newerThanThisCheck || isStarredCacheFresh(current, now)) {
				return current;
			}
		}
		return { declined: current.declined, starred: false, starredCheckedAt: checkedAt };
	}, deps);
}

/** Record a launch-nudge decline. Never downgrades a confirmed star. */
export async function recordDeclinedAfterNo(deps?: StarReminderDeps): Promise<StarReminderState> {
	return updateStarReminderStateLocked(current => {
		if (current.starred) return current;
		return { ...current, declined: true };
	}, deps);
}

// --------------------------------------------------------------------------
// gh helpers
// --------------------------------------------------------------------------

/** Default `gh` runner. Returns an unavailable-style result instead of throwing. */
export async function runGhDefault(args: string[], options?: { timeoutMs?: number }): Promise<GhResult> {
	const ghPath = Bun.which("gh");
	if (!ghPath) {
		return { exitCode: -1, stdout: "", stderr: "gh not found", timedOut: false };
	}
	const timeoutMs = options?.timeoutMs ?? GH_TIMEOUT_MS;
	let timedOut = false;
	try {
		const proc = Bun.spawn([ghPath, ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
		const timer = setTimeout(() => {
			timedOut = true;
			proc.kill();
		}, timeoutMs);
		try {
			const [stdout, stderr] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
			]);
			const exitCode = await proc.exited;
			return { exitCode, stdout, stderr, timedOut };
		} finally {
			clearTimeout(timer);
		}
	} catch (err) {
		return { exitCode: -1, stdout: "", stderr: err instanceof Error ? err.message : String(err), timedOut };
	}
}

function resolveRunGh(deps?: StarReminderDeps): RunGh {
	return deps?.runGh ?? runGhDefault;
}

/** Classify the star state of the repo via `gh api`. */
export async function checkGhStarred(deps?: StarReminderDeps): Promise<StarCheckStatus> {
	const runGh = resolveRunGh(deps);
	const res = await runGh(["api", `user/starred/${STAR_REMINDER_REPO}`], { timeoutMs: GH_TIMEOUT_MS });
	if (res.timedOut) return "unavailable";
	if (res.exitCode === 0) return "starred";
	// A genuine 404 from this endpoint is the unambiguous "not starred" signal.
	// gh emits "gh: Not Found (HTTP 404)" for that case. Other failures (missing
	// gh, auth, network, malformed output) must stay silent, so we key strictly
	// on the explicit HTTP 404 status rather than any "404"/"not found" substring,
	// which could appear in unrelated error text.
	if (/http[\s/]?404\b/i.test(res.stderr)) return "unstarred";
	return "unavailable";
}

/** Star the repo via `gh api -X PUT`. Returns whether the PUT succeeded. */
export async function autoStarRepo(deps?: StarReminderDeps): Promise<boolean> {
	const runGh = resolveRunGh(deps);
	const res = await runGh(["api", "-X", "PUT", `user/starred/${STAR_REMINDER_REPO}`], { timeoutMs: GH_TIMEOUT_MS });
	return res.exitCode === 0 && !res.timedOut;
}

/**
 * Determine the star state for this session, hitting `gh` only when needed.
 * A fresh cached star skips `gh`; unstarred and declined states are rechecked.
 * Authoritative results are persisted via the monotonic helpers.
 */
export async function refreshStarStateForSession(deps?: StarReminderDeps): Promise<StarCheckStatus> {
	const statePath = resolveStatePath(deps);
	const state = await readStarReminderStateUnlocked(statePath);
	if (state.starred && isStarredCacheFresh(state, resolveNow(deps))) {
		return "starred";
	}
	const status = await checkGhStarred(deps);
	if (status === "starred") {
		await recordFreshStarCheck("starred", deps);
	} else if (status === "unstarred") {
		await recordFreshStarCheck("unstarred", deps);
	}
	return status;
}

// --------------------------------------------------------------------------
// Launch nudge
// --------------------------------------------------------------------------

export interface StarReminderPromptUI {
	/** Show a yes/no confirmation. Resolves true when the user accepts. */
	confirm(title: string, message: string): Promise<boolean>;
	/** Optional guard; when it returns false the nudge is skipped silently. */
	isIdle?: () => boolean;
}

const LAUNCH_PROMPT_TITLE = "Enjoying GJC?";
const LAUNCH_PROMPT_MESSAGE = `Star ${STAR_REMINDER_REPO} on GitHub to support the project?`;

/**
 * Run the launch nudge once. Caller is responsible for the `startup.quiet`,
 * `starReminder.enabled`, and true-interactive gates. All errors are swallowed
 * so the launch path can never be broken by the reminder.
 */
export async function maybeShowLaunchStarReminder(ui: StarReminderPromptUI, deps?: StarReminderDeps): Promise<void> {
	try {
		const statePath = resolveStatePath(deps);
		const state = await readStarReminderStateUnlocked(statePath);
		// Declined users no longer see the launch prompt; the injection path
		// handles re-checks for them.
		if (state.declined) return;
		if (state.starred && isStarredCacheFresh(state, resolveNow(deps))) return;

		const status = await checkGhStarred(deps);
		if (status === "starred") {
			await recordFreshStarCheck("starred", deps);
			return;
		}
		if (status === "unavailable") return;

		// status === "unstarred". Persist this fresh unstarred evidence first so a
		// stale cached starred:true is downgraded and a subsequent No is recorded as
		// declined (recordDeclinedAfterNo only preserves a still-starred state).
		await recordFreshStarCheck("unstarred", deps);
		if (ui.isIdle && !ui.isIdle()) return;
		const accepted = await ui.confirm(LAUNCH_PROMPT_TITLE, LAUNCH_PROMPT_MESSAGE);
		if (accepted) {
			const ok = await autoStarRepo(deps);
			if (ok) await recordStarredFromPut(deps);
			// On PUT failure: stay silent and do not mark starred; a later launch
			// may prompt again while still not declined.
			return;
		}
		await recordDeclinedAfterNo(deps);
	} catch {
		// Never surface star-reminder failures to the user.
	}
}

/**
 * Schedule the launch nudge to run after the first render so the networked
 * `gh` check never blocks startup. Returns immediately.
 */
export function scheduleLaunchStarReminderAfterFirstRender(ui: StarReminderPromptUI, deps?: StarReminderDeps): void {
	setTimeout(() => {
		void maybeShowLaunchStarReminder(ui, deps);
	}, 0);
}

export interface StarReminderLaunchGateInput {
	/** The `starReminder.enabled` setting. */
	enabled: boolean;
	/** The `startup.quiet` setting. */
	quiet: boolean;
}

export interface StarReminderLaunchGate {
	/** Whether to register the decline-driven injection contributor. */
	register: boolean;
	/** Whether to schedule the launch nudge after first render. */
	schedule: boolean;
}

/**
 * Pure decision for interactive wiring. The injection contributor is registered
 * whenever the feature is enabled; the launch nudge is additionally suppressed
 * by quiet startup. Centralizing this keeps the interactive gate testable.
 */
export function starReminderLaunchGate(input: StarReminderLaunchGateInput): StarReminderLaunchGate {
	return { register: input.enabled, schedule: input.enabled && !input.quiet };
}

// --------------------------------------------------------------------------
// Decline-driven injection
// --------------------------------------------------------------------------

export interface StarReminderSessionRef {
	getSessionId(): string | undefined;
}

export type StarReminderCustomMessage = Pick<
	CustomMessage,
	"customType" | "content" | "display" | "details" | "attribution"
>;

export type InternalBeforeAgentStartContributor = (event: {
	prompt: string;
	images?: ImageContent[];
	sessionId: string | undefined;
}) => Promise<StarReminderCustomMessage | undefined>;

const PERSUASION_CONTENT =
	`The user previously declined the launch GitHub-star prompt. At an appropriate moment in this response, ` +
	`briefly and politely encourage starring https://github.com/${STAR_REMINDER_REPO} to support the project. ` +
	`Ask at most once and do not be pushy.`;

export function createStarReminderMessage(): StarReminderCustomMessage {
	const attribution: MessageAttribution = "agent";
	return {
		customType: STAR_REMINDER_CUSTOM_TYPE,
		content: PERSUASION_CONTENT,
		display: false,
		attribution,
	};
}

/**
 * Build a before-agent-start contributor that injects the persuasion message
 * once per logical session id, for declined-and-still-unstarred users only.
 */
export function createStarReminderBeforeAgentStartContributor(
	session: StarReminderSessionRef,
	deps?: StarReminderDeps,
): InternalBeforeAgentStartContributor {
	const injectedSessionIds = new Set<string>();
	return async event => {
		try {
			const state = await readStarReminderStateUnlocked(resolveStatePath(deps));
			if (!state.declined) return undefined;

			// Without a stable logical session id we cannot enforce once-per-session,
			// so prefer not injecting at all.
			const sessionId = session.getSessionId() ?? event.sessionId;
			if (!sessionId) return undefined;
			if (injectedSessionIds.has(sessionId)) return undefined;

			// Process each logical session at most once, regardless of outcome:
			// even when gh is unavailable we must not re-check (and possibly delay)
			// on every subsequent prompt in the same session.
			injectedSessionIds.add(sessionId);

			const status = await refreshStarStateForSession(deps);
			if (status !== "unstarred") return undefined;
			return createStarReminderMessage();
		} catch {
			return undefined;
		}
	};
}
