/**
 * Startup crash nudge.
 *
 * One rate-limited status line saying unreported crash signatures exist.
 * **Nothing is ever transmitted by this piece** — it reads local state only and
 * points at `gjc crash report`, which has its own consent flow.
 *
 * Honest default statement: this is on by default and it *does* change startup
 * output by design (one bounded line, at most once per 24h per agent dir).
 * `crashReport.nudge: false` disables it.
 */
import { type CrashIndex, type CrashStatePaths, listCrashSignatures, recordCrashStateEvent } from "./index-store";

export const CRASH_NUDGE_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface CrashNudgeGateInput {
	/** The `crashReport.nudge` setting. */
	enabled: boolean;
	/** True only for a real interactive TUI launch. */
	interactive: boolean;
	/** The `startup.quiet` setting. */
	quiet: boolean;
}

/**
 * Pure gate for the launch wiring. Print mode, SDK/ACP hosts, workers, daemons
 * and `--version`/`--help` never reach interactive launch, so gating on the
 * interactive surface is what suppresses them.
 */
export function crashNudgeGate(input: CrashNudgeGateInput): boolean {
	return input.enabled && input.interactive && !input.quiet;
}

export interface CrashNudgeDecision {
	show: boolean;
	message?: string;
}

/**
 * Decide whether to nudge from the compacted index alone.
 *
 * Fires when an unreported, unacknowledged signature gained records since
 * `lastNudgedAt`, at most once per 24h. Acknowledgement is explicit (the
 * dismiss action in `gjc crash report`); an ignored line never counts as one.
 */
export function decideCrashNudge(index: CrashIndex, now: number): CrashNudgeDecision {
	if (now - index.lastNudgedAt < CRASH_NUDGE_INTERVAL_MS) return { show: false };
	const pending = listCrashSignatures(index).filter(
		signature =>
			signature.reportedAt === undefined &&
			signature.acknowledgedAt === undefined &&
			signature.lastSeen > index.lastNudgedAt,
	);
	const newest = pending[0];
	if (!newest) return { show: false };
	const others = pending.length > 1 ? ` (+${pending.length - 1} more)` : "";
	const message =
		`${pending.length} unreported crash signature${pending.length === 1 ? "" : "s"}: ` +
		`${newest.errorName} ×${newest.lifetimeCount}${others}. ` +
		"Run `gjc crash report` to review — nothing is sent without your confirmation.";
	return { show: true, message };
}

export interface CrashNudgeDeps {
	paths: CrashStatePaths;
	index: CrashIndex;
	now?: () => Date;
}

/**
 * Emit the nudge through the caller's status surface and persist the rate-limit
 * stamp through the journal, so a rebuilt index cannot reset it within the
 * journal window. Never throws.
 */
export async function maybeShowCrashNudge(
	showStatus: (message: string) => void,
	deps: CrashNudgeDeps,
): Promise<boolean> {
	try {
		const now = (deps.now ?? (() => new Date()))().getTime();
		const decision = decideCrashNudge(deps.index, now);
		if (!decision.show || !decision.message) return false;
		showStatus(decision.message);
		await recordCrashStateEvent({ kind: "nudged", at: now }, { paths: deps.paths, now });
		return true;
	} catch {
		return false;
	}
}
