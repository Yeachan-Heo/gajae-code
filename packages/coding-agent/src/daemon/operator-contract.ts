/**
 * Shared operator contract for the `gjc daemon` command surface.
 *
 * One source of truth for the beginner-safe operational vocabulary so the
 * guided human surface and the machine-readable JSON never drift:
 * - the terse action verbs plus operator aliases (e.g. `restart` -> `reload`),
 * - process exit codes,
 * - concise vs. `--verbose` human rendering of statuses and results, and
 * - actionable recovery guidance for a token/chat ownership mismatch.
 *
 * The full roots/debug payload lives behind `--verbose` (human) or `--json`
 * (automation); the default human output stays a concise per-daemon result.
 */

import type { DaemonAction, DaemonOperationResult, DaemonRecovery, DaemonStatus } from "./control-types";

/** Canonical daemon actions accepted as the leading verb. */
export const DAEMON_CANONICAL_ACTIONS: readonly DaemonAction[] = ["list", "status", "stop", "reload"];

/**
 * Operator-friendly aliases resolved to a canonical action. `restart` is the
 * routine "reload if running, otherwise start" verb; it maps onto `reload`,
 * whose default already spawns a fresh owner when none is running.
 */
export const DAEMON_ACTION_ALIASES: Readonly<Record<string, DaemonAction>> = {
	restart: "reload",
};

/** Every token accepted in the leading action position (canonical + aliases). */
export const DAEMON_ACTION_TOKENS: readonly string[] = [
	...DAEMON_CANONICAL_ACTIONS,
	...Object.keys(DAEMON_ACTION_ALIASES),
];

/** Resolve a leading verb (canonical or alias) to its canonical action. */
export function resolveDaemonAction(token: string | undefined): DaemonAction | undefined {
	if (token === undefined) return undefined;
	if ((DAEMON_CANONICAL_ACTIONS as readonly string[]).includes(token)) return token as DaemonAction;
	return DAEMON_ACTION_ALIASES[token];
}

/** Exit codes for `gjc daemon`. Backward compatible: success 0, any failure 1. */
export const DAEMON_EXIT = { ok: 0, failure: 1 } as const;

/** Human-facing headline when a spawn/reload is refused by a live foreign identity. */
export const OWNERSHIP_MISMATCH_MESSAGE =
	"refused: a live Telegram daemon with a different bot token or chat already owns this workspace";

/** Structured, actionable recovery for a token/chat ownership mismatch. */
export function ownershipMismatchRecovery(): DaemonRecovery {
	return {
		reason: "ownership_mismatch",
		summary: "A live Telegram daemon owned by a different bot token or chat already holds this workspace.",
		steps: [
			"Confirm the intended bot token and chat with `gjc notify` (or edit notifications.telegram in your config).",
			"If the running daemon is stale or unwanted, stop it with `gjc daemon stop --force`, then rerun `gjc daemon restart`.",
			"If it is the correct daemon, no action is needed — this workspace attaches automatically once the identities match.",
		],
	};
}

function timestamp(ms: number | undefined): string | undefined {
	if (ms === undefined) return undefined;
	const date = new Date(ms);
	return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/**
 * Render one daemon status. Concise by default (single head line + any
 * actionable warning); `--verbose` adds runtime detail and the full roots list.
 */
export function formatDaemonStatus(status: DaemonStatus, opts: { verbose?: boolean } = {}): string {
	const lines: string[] = [];
	if (!status.configured) {
		lines.push(`${status.kind}: not configured`);
		if (status.runtime.warning) lines.push(`  warning: ${status.runtime.warning}`);
		return lines.join("\n");
	}

	const meta: string[] = [];
	if (status.pid !== undefined) meta.push(`pid ${status.pid}`);
	if (status.ownerId) meta.push(`owner ${status.ownerId}`);
	const rootCount = status.rootCount ?? status.roots?.length ?? 0;
	if (rootCount > 0) meta.push(`${rootCount} root${rootCount === 1 ? "" : "s"}`);

	let head = `${status.kind}: ${status.health}`;
	if (meta.length > 0) head += ` (${meta.join(", ")})`;
	if (status.detail) head += ` — ${status.detail}`;
	lines.push(head);
	if (status.runtime.warning) lines.push(`  warning: ${status.runtime.warning}`);

	if (opts.verbose) {
		lines.push(`  runtime: ${status.runtime.mode} (${status.runtime.execPath})`);
		const started = timestamp(status.startedAt);
		if (started) lines.push(`  started: ${started}`);
		const heartbeat = timestamp(status.heartbeatAt);
		if (heartbeat) lines.push(`  heartbeat: ${heartbeat}`);
		const roots = status.roots ?? [];
		lines.push(`  roots: ${rootCount}`);
		for (const root of roots) lines.push(`    - ${root}`);
	}

	return lines.join("\n");
}

/**
 * Render one operation result. Keeps the stable `<kind> <action>: ok|failed —
 * <message>` head line, then any warnings, then actionable recovery steps.
 */
export function formatDaemonResult(result: DaemonOperationResult): string {
	const lines = [`${result.kind} ${result.action}: ${result.ok ? "ok" : "failed"} — ${result.message}`];
	for (const warning of result.warnings) lines.push(`  warning: ${warning}`);
	if (result.recovery) {
		lines.push(`  ${result.recovery.summary}`);
		lines.push("  to recover:");
		result.recovery.steps.forEach((step, i) => {
			lines.push(`    ${i + 1}. ${step}`);
		});
	}
	return lines.join("\n");
}
