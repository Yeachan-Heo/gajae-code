import type { Model } from "@gajae-code/ai";

/**
 * A single line in the `/fast status` report: a labelled model and whether fast
 * mode is effective for it. The `fast` flag is resolved by the caller
 * (`buildFastStatusReport`) so each row can use the correct service tier — the
 * main session tier for the current model / `modelRoles` roles, or the subagent
 * tier (`task.serviceTier`) for `task.agentModelOverrides` roles.
 */
export interface FastStatusRow {
	/** Display label, e.g. "현재 모델", "DEFAULT", "EXECUTOR". */
	label: string;
	/** Resolved model for this row, if any. */
	model?: Model;
	/** Whether fast mode is effective for this row's model. */
	fast: boolean;
}

export interface FormatFastStatusReportArgs {
	rows: FastStatusRow[];
	/** The active theme's fast icon token (`theme.icon.fast`). */
	iconFast: string;
	/** Optional decorator for inactive ("off") text, e.g. theme dim in the TUI. */
	formatInactive?: (text: string) => string;
}

/** Title line of the `/fast status` report. */
export const FAST_STATUS_TITLE = "Fast 모드 상태";

/** The inactive marker shown for rows where fast mode does not apply. */
export const FAST_STATUS_OFF = "off";

/**
 * Format a multiline `/fast status` report. Pure and shared by the CLI
 * (`handle`) and TUI (`handleTui`) command branches so the two never drift.
 * Each row's fast/off state is decided by the caller (see
 * {@link buildFastStatusReport}) so per-row service-tier differences are honored.
 */
export function formatFastStatusReport(args: FormatFastStatusReportArgs): string {
	const { rows, iconFast } = args;
	const formatInactive = args.formatInactive ?? ((text: string) => text);
	const lines: string[] = [FAST_STATUS_TITLE];
	for (const row of rows) {
		if (!row.model) {
			lines.push(`${row.label}: ${formatInactive(FAST_STATUS_OFF)}`);
			continue;
		}
		const ref = `${row.model.provider}/${row.model.id}`;
		lines.push(`${row.label}: ${ref} ${row.fast ? iconFast : formatInactive(FAST_STATUS_OFF)}`);
	}
	return lines.join("\n");
}

/** Minimal session surface needed to build the `/fast status` report. */
export interface FastStatusSessionLike {
	readonly model?: Model;
	/** Fast predicate against the main session tier (current model + `modelRoles`). */
	isFastForProvider(provider?: string): boolean;
	/**
	 * Current-model EFFECTIVE fast state (intent minus any provider auto-disable).
	 * Used for the current-model row so it matches what the next request does.
	 * Optional so lightweight fakes can omit it; falls back to `isFastForProvider`.
	 */
	isFastModeActive?(): boolean;
	/** Fast predicate against the effective subagent tier (`task.agentModelOverrides` roles). */
	isFastForSubagentProvider(provider?: string): boolean;
	resolveRoleModelWithThinking(role: string): { model?: Model };
}

/** A role to enumerate in the report, with the tier source its subagent runs under. */
export interface FastStatusRoleTarget {
	id: string;
	label: string;
	/**
	 * True for `task.agentModelOverrides` roles (executor/architect/planner/critic)
	 * that run under `task.serviceTier`; false for `modelRoles` roles (default)
	 * that run under the main session tier.
	 */
	isSubagentRole: boolean;
}

export interface BuildFastStatusReportArgs {
	session: FastStatusSessionLike;
	/** Role targets to enumerate, in display order. */
	roleTargets: ReadonlyArray<FastStatusRoleTarget>;
	/** The active theme's fast icon token (`theme.icon.fast`). */
	iconFast: string;
	/** Optional decorator for inactive ("off") text, e.g. theme dim in the TUI. */
	formatInactive?: (text: string) => string;
}

/**
 * Build the `/fast status` report from a live session: the active/current model
 * followed by each assigned role (subagent) model. Unassigned roles are skipped
 * so the report mirrors the `/model` selector, which only badges assigned roles.
 *
 * Subagent roles (`task.agentModelOverrides`) are evaluated against the
 * effective subagent tier (`task.serviceTier`), while the current model and
 * `modelRoles` roles use the main session tier — matching where each model
 * actually runs.
 */
export function buildFastStatusReport(args: BuildFastStatusReportArgs): string {
	const { session, roleTargets, iconFast, formatInactive } = args;
	// Current-model row uses the EFFECTIVE predicate (intent minus any provider
	// auto-disable) so it matches the next request; `modelRoles` rows below stay
	// on pure intent. Fall back to intent when a fake omits `isFastModeActive`.
	const currentFast = session.isFastModeActive
		? session.isFastModeActive()
		: session.isFastForProvider(session.model?.provider);
	const rows: FastStatusRow[] = [{ label: "현재 모델", model: session.model, fast: currentFast }];
	for (const target of roleTargets) {
		const resolved = session.resolveRoleModelWithThinking(target.id);
		if (resolved.model) {
			const fast = target.isSubagentRole
				? session.isFastForSubagentProvider(resolved.model.provider)
				: session.isFastForProvider(resolved.model.provider);
			rows.push({ label: target.label, model: resolved.model, fast });
		}
	}
	return formatFastStatusReport({ rows, iconFast, formatInactive });
}
