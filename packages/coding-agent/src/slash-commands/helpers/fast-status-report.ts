import type { Model } from "@gajae-code/ai";

/**
 * A single line in the `/fast status` report: a labelled model whose fast-mode
 * applicability is decided per the model's provider.
 */
export interface FastStatusRow {
	/** Display label, e.g. "현재 모델", "DEFAULT", "EXECUTOR". */
	label: string;
	/** Resolved model for this row, if any. */
	model?: Model;
}

export interface FormatFastStatusReportArgs {
	rows: FastStatusRow[];
	/**
	 * Provider-aware fast predicate. This MUST be the provider-aware check
	 * (`AgentSession.isFastForProvider`), never the provider-agnostic
	 * `isFastModeEnabled()`, so a scoped tier (e.g. `claude-only`) reports
	 * correctly per row.
	 */
	isFastForProvider: (provider?: string) => boolean;
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
 * Format a multiline, provider-aware `/fast status` report. Pure and shared by
 * the CLI (`handle`) and TUI (`handleTui`) command branches so the two never
 * drift.
 */
export function formatFastStatusReport(args: FormatFastStatusReportArgs): string {
	const { rows, isFastForProvider, iconFast } = args;
	const formatInactive = args.formatInactive ?? ((text: string) => text);
	const lines: string[] = [FAST_STATUS_TITLE];
	for (const row of rows) {
		if (!row.model) {
			lines.push(`${row.label}: ${formatInactive(FAST_STATUS_OFF)}`);
			continue;
		}
		const ref = `${row.model.provider}/${row.model.id}`;
		const fast = isFastForProvider(row.model.provider);
		lines.push(`${row.label}: ${ref} ${fast ? iconFast : formatInactive(FAST_STATUS_OFF)}`);
	}
	return lines.join("\n");
}

/** Minimal session surface needed to build the `/fast status` report. */
export interface FastStatusSessionLike {
	readonly model?: Model;
	isFastForProvider(provider?: string): boolean;
	resolveRoleModelWithThinking(role: string): { model?: Model };
}

export interface BuildFastStatusReportArgs {
	session: FastStatusSessionLike;
	/** Role targets to enumerate, in display order. */
	roleTargets: ReadonlyArray<{ id: string; label: string }>;
	/** The active theme's fast icon token (`theme.icon.fast`). */
	iconFast: string;
	/** Optional decorator for inactive ("off") text, e.g. theme dim in the TUI. */
	formatInactive?: (text: string) => string;
}

/**
 * Build the `/fast status` report from a live session: the active/current model
 * followed by each assigned role (subagent) model. Unassigned roles are skipped
 * so the report mirrors the `/model` selector, which only badges assigned roles.
 */
export function buildFastStatusReport(args: BuildFastStatusReportArgs): string {
	const { session, roleTargets, iconFast, formatInactive } = args;
	const rows: FastStatusRow[] = [{ label: "현재 모델", model: session.model }];
	for (const target of roleTargets) {
		const resolved = session.resolveRoleModelWithThinking(target.id);
		if (resolved.model) {
			rows.push({ label: target.label, model: resolved.model });
		}
	}
	return formatFastStatusReport({
		rows,
		isFastForProvider: provider => session.isFastForProvider(provider),
		iconFast,
		formatInactive,
	});
}
