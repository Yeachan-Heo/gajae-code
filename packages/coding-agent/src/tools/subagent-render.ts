/**
 * TUI renderer for the `subagent` tool.
 *
 * The await panel surfaces each awaited subagent's live streaming status at
 * parity with the inline `task` panel by reusing `renderSubagentLiveProgress`.
 * Falls back to a `running, no activity yet` placeholder when a live producer
 * exists but has not emitted yet, and to a static status line when no live
 * producer is available (resumed-from-disk or backward-compat records).
 */
import type { Component } from "@gajae-code/tui";
import { Text } from "@gajae-code/tui";
import { formatNumber } from "@gajae-code/utils";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../modes/theme/theme";
import { providerRetryPhaseLabel } from "../task/provider-retry-status";
import { Ellipsis, Hasher, renderStatusLine } from "../tui";
import {
	formatDuration,
	formatStatusIcon,
	getPreviewLines,
	replaceTabs,
	type ToolUIStatus,
	truncateToWidth,
} from "./render-utils";
import {
	SUBAGENT_ACTIVITY_BUCKET_MS,
	type SubagentLiveProgress,
	type SubagentSnapshot,
	type SubagentToolDetails,
	subagentAwaitRenderedStateSignature,
} from "./subagent";

export { subagentAwaitRenderedStateSignature } from "./subagent";

const PREVIEW_LINES_COLLAPSED = 1;
const PREVIEW_LINES_EXPANDED = 4;
const PREVIEW_LINE_WIDTH = 80;

/**
 * Bounded, content-addressed cache for each subagent's heavy body lines (the
 * indented receipt fields + `renderSubagentLiveProgress` -> `renderAgentProgress`
 * output). It is module-level so it survives the built-in renderer recreating the
 * result component on every partial update (`tool-execution.ts` clears the content
 * box and re-invokes `renderResult`), which a per-component `let cached` cannot.
 *
 * The cached body is a PURE function of its key: the per-subagent rendered-state
 * signature (reused from the producer; excludes time-derived churn), expanded
 * state, width, and the actual Theme instance identity. `spinnerFrame` and all
 * wall-clock displays are deliberately kept OUT of the cached body — the animated
 * spinner and the fresh duration live in the cheap per-subagent status line, and
 * `renderSubagentLiveProgress` is invoked with `staticTime` so current-tool elapsed
 * and retry countdowns are never baked into cached lines. Snapshots with an active
 * retry anywhere in their nested task tree bypass this cache and render dynamically.
 */
const SUBAGENT_BODY_CACHE_MAX = 128;
const subagentBodyCache = new Map<bigint, string[]>();
let subagentBodyRenderCount = 0;

// Stable identity per Theme instance so a theme change (preview, symbol preset,
// color-blind reload, custom-theme reload, or in-memory swap) never reuses stale
// ANSI/glyph strings — distinct Theme objects get distinct ids even when the theme
// name is unchanged (e.g. the "<in-memory>" name).
const themeIdentity = new WeakMap<Theme, number>();
let nextThemeId = 1;
function themeIdentityId(theme: Theme): number {
	let id = themeIdentity.get(theme);
	if (id === undefined) {
		id = nextThemeId++;
		themeIdentity.set(theme, id);
	}
	return id;
}

/** Test-only seam (PR3 deterministic cache-hit assertions). */
export const subagentBodyCacheTestHooks = {
	get bodyRenders(): number {
		return subagentBodyRenderCount;
	},
	get size(): number {
		return subagentBodyCache.size;
	},
	reset(): void {
		subagentBodyRenderCount = 0;
		subagentBodyCache.clear();
	},
};

function snapshotHasActiveRetry(snapshot: SubagentSnapshot): boolean {
	if (snapshot.liveProgressAvailable === false || !snapshot.progress) return false;
	return hasActiveProviderRetryInProgress(snapshot.progress);
}

function hasActiveProviderRetryInProgress(progress: SubagentLiveProgress): boolean {
	return progress.status === "running" && progress.retryState !== undefined;
}

function providerProgressAgeLabel(progress: SubagentLiveProgress["retryState"], nowMs: number): string {
	if (progress?.lastProviderProgressAtMs === undefined) return "no provider events yet";
	const ageSeconds = Math.max(0, Math.floor((nowMs - progress.lastProviderProgressAtMs) / 1000));
	return `last provider progress ${ageSeconds}s ago`;
}

function collectProviderDegradationGroups(
	progress: readonly SubagentLiveProgress[],
): Array<{ provider: string; count: number }> {
	const counts = new Map<string, number>();
	for (const item of progress) {
		if (item.status !== "running" || !item.retryState) continue;
		const provider = item.retryState.provider ?? "provider";
		counts.set(provider, (counts.get(provider) ?? 0) + 1);
	}
	return Array.from(counts, ([provider, count]) => ({ provider, count }))
		.filter(group => group.count > 1)
		.sort((a, b) => b.count - a.count || a.provider.localeCompare(b.provider));
}

function boundSubagentBodyLines(lines: string[], width: number): string[] {
	return lines.map(line => (line.length > 0 ? truncateToWidth(replaceTabs(line), width, Ellipsis.Omit) : ""));
}

function renderCachedSubagentBody(
	snapshot: SubagentSnapshot,
	signature: string,
	expanded: boolean,
	width: number,
	theme: Theme,
): string[] {
	const key = new Hasher().str(signature).bool(expanded).u32(width).u32(themeIdentityId(theme)).digest();
	const hit = subagentBodyCache.get(key);
	if (hit) {
		// Refresh LRU recency.
		subagentBodyCache.delete(key);
		subagentBodyCache.set(key, hit);
		return hit;
	}
	const lines = boundSubagentBodyLines(renderSubagentSnapshotBody(snapshot, expanded, theme), width);
	subagentBodyRenderCount += 1;
	subagentBodyCache.set(key, lines);
	if (subagentBodyCache.size > SUBAGENT_BODY_CACHE_MAX) {
		const oldest = subagentBodyCache.keys().next().value;
		if (oldest !== undefined) subagentBodyCache.delete(oldest);
	}
	return lines;
}

function renderDynamicSubagentBody(
	snapshot: SubagentSnapshot,
	expanded: boolean,
	width: number,
	theme: Theme,
): string[] {
	subagentBodyRenderCount += 1;
	return boundSubagentBodyLines(renderSubagentSnapshotBody(snapshot, expanded, theme, false), width);
}

function statusIconKind(status: SubagentSnapshot["status"]): ToolUIStatus {
	switch (status) {
		case "completed":
		case "already_completed":
			return "success";
		case "failed":
			return "error";
		case "cancelled":
		case "not_found":
			return "warning";
		case "queued":
			return "pending";
		default:
			return "info";
	}
}

// Cheap, dynamic per-subagent status line: the spinner may animate and the duration
// is the snapshot's own (fresh) value, so this line is rebuilt every frame and is
// NOT part of the cached body.
function renderSubagentStatusLine(snapshot: SubagentSnapshot, theme: Theme, spinnerFrame: number | undefined): string {
	const icon = formatStatusIcon(
		statusIconKind(snapshot.status),
		theme,
		snapshot.status === "running" ? spinnerFrame : undefined,
	);
	const id = theme.fg("muted", truncateToWidth(replaceTabs(snapshot.id), PREVIEW_LINE_WIDTH, Ellipsis.Unicode));
	const retryState = snapshot.liveProgressAvailable !== false ? snapshot.progress?.retryState : undefined;
	const status = retryState
		? theme.fg(
				"warning",
				`provider degraded · ${providerRetryPhaseLabel(retryState.kind)} · ${providerProgressAgeLabel(retryState, Date.now())}`,
			)
		: theme.fg("dim", snapshot.status);
	const duration = theme.fg("dim", formatDuration(snapshot.durationMs));
	const live = snapshot.liveProgressAvailable !== false ? snapshot.progress : undefined;
	return `${icon} ${id} ${status} ${duration}${live ? formatLiveStats(live, theme, Date.now()) : ""}`;
}

// Live stats ride the cheap status line (rebuilt every render), never the cached
// body. Quantize age to the producer cadence so incidental renders do not churn it.
function formatLiveStats(progress: SubagentLiveProgress, theme: Theme, nowMs: number): string {
	const parts: string[] = [];
	if (progress.toolCount) parts.push(`${progress.toolCount} ${progress.toolCount === 1 ? "tool" : "tools"}`);
	if (progress.contextTokens) {
		parts.push(
			progress.contextWindow
				? `${formatNumber(progress.contextTokens)}/${formatNumber(progress.contextWindow)} ctx`
				: `${formatNumber(progress.contextTokens)} ctx`,
		);
	}
	if (progress.lastActivityMs !== undefined && progress.status === "running") {
		const ageMs = Math.max(0, nowMs - progress.lastActivityMs);
		const ageBucketMs = Math.floor(ageMs / SUBAGENT_ACTIVITY_BUCKET_MS) * SUBAGENT_ACTIVITY_BUCKET_MS;
		parts.push(`last activity ${formatDuration(ageBucketMs)} ago`);
	}
	return parts.map(part => `${theme.sep.dot}${theme.fg("dim", part)}`).join("");
}

function renderSubagentLiveProgress(
	progress: SubagentLiveProgress,
	expanded: boolean,
	theme: Theme,
	spinnerFrame?: number,
	staticTime = false,
): string[] {
	const lines: string[] = [];
	const prefix = theme.fg("dim", theme.tree.last);
	const iconColor = progress.status === "failed" || progress.status === "aborted" ? "error" : "accent";
	const icon = formatStatusIcon(
		progress.status === "completed" ? "success" : progress.status === "failed" ? "error" : "info",
		theme,
		progress.status === "running" ? spinnerFrame : undefined,
	);
	let statusLine = `${prefix} ${theme.fg(iconColor, icon)} ${theme.fg("accent", progress.id)}`;
	if (progress.fastMode && theme.icon.fast) statusLine += ` ${theme.icon.fast}`;
	if (progress.retryState && progress.status === "running") {
		statusLine += ` ${theme.fg("warning", "provider degraded")}`;
	}
	lines.push(statusLine);

	const continuePrefix = "   ";
	if (progress.status === "running") {
		const tool = progress.currentTool ?? progress.recentTool;
		if (tool) lines.push(`${continuePrefix}${theme.tree.hook} ${theme.fg("muted", tool)}`);
	}
	if (progress.recentOutputSummary) {
		const count = progress.recentOutputSummary.lineCount;
		lines.push(
			`${continuePrefix}${theme.tree.hook} ${theme.fg("dim", `recent output available (${count} ${count === 1 ? "line" : "lines"})`)}`,
		);
	}
	if (progress.retryState && progress.status === "running") {
		const retry = progress.retryState;
		const attemptLabel = retry.unbounded
			? `attempt ${retry.attempt}, unbounded`
			: `attempt ${retry.attempt} of ${retry.maxAttempts}, bounded`;
		const progressAge = staticTime ? "" : ` · ${providerProgressAgeLabel(retry, Date.now())}`;
		let waitLabel = "";
		if (!staticTime) {
			const remainingMs = Math.max(0, retry.startedAtMs + retry.delayMs - Date.now());
			waitLabel = remainingMs > 0 ? ` in ${formatDuration(remainingMs)}` : " now";
		}
		lines.push(
			`${continuePrefix}${theme.tree.hook} ${theme.fg("warning", `${providerRetryPhaseLabel(retry.kind)} · retrying ${attemptLabel}${waitLabel}${progressAge}`)}`,
		);
	}
	if (progress.retryFailure && progress.status !== "running") {
		const attempts = progress.retryFailure.attempt;
		lines.push(
			`${continuePrefix}${theme.tree.hook} ${theme.fg("error", `auto-retry gave up after ${attempts} attempt${attempts === 1 ? "" : "s"}`)}`,
		);
	}
	if (
		expanded &&
		progress.status === "running" &&
		!progress.currentTool &&
		!progress.recentTool &&
		!progress.recentOutputSummary
	) {
		lines.push(`${continuePrefix}${theme.fg("dim", "running, no approved activity summary yet")}`);
	}
	return lines;
}

// Heavy per-subagent body. The cache path uses staticTime=true; the bounded dynamic
// path opts into wall-clock displays when an active retry exists in the nested tree.
function renderSubagentSnapshotBody(
	snapshot: SubagentSnapshot,
	expanded: boolean,
	theme: Theme,
	staticTime = true,
): string[] {
	const lines: string[] = [];

	// Static receipt fields (parity with the markdown content for non-await actions).
	if (snapshot.jobId !== snapshot.id) lines.push(`  ${theme.fg("dim", `Job: ${snapshot.jobId}`)}`);
	if (snapshot.agent && snapshot.agent !== "unknown") {
		lines.push(`  ${theme.fg("dim", `Agent: ${snapshot.agent} (${snapshot.agentSource})`)}`);
	}
	if (snapshot.effectiveModel) {
		// Fast mode is a property of the tier this model runs under, so the ⚡ glyph
		// belongs on the model line rather than the id.
		const fastSuffix = snapshot.fastMode && theme.icon.fast ? ` ${theme.icon.fast}` : "";
		if (snapshot.modelFellBack && snapshot.requestedModel) {
			lines.push(
				`  ${theme.fg("warning", `Model: ${snapshot.effectiveModel} (requested ${snapshot.requestedModel}, fell back — no credentials)`)}${fastSuffix}`,
			);
		} else {
			lines.push(`  ${theme.fg("dim", `Model: ${snapshot.effectiveModel}`)}${fastSuffix}`);
		}
	}
	if (snapshot.description) lines.push(`  ${theme.fg("dim", `Description: ${snapshot.description}`)}`);
	if (snapshot.outputRef) lines.push(`  ${theme.fg("dim", `Output: ${snapshot.outputRef}`)}`);
	if (snapshot.setupFailureSummary) {
		lines.push(`  ${theme.fg("error", `Setup failure: ${snapshot.setupFailureSummary}`)}`);
	}
	if (snapshot.localErrorSummary) {
		const local = snapshot.localErrorSummary;
		lines.push(`  ${theme.fg("error", `Local failure (${local.kind}): ${local.summary}`)}`);
		// Kind-conditional guidance: an overflow is a staging limit that
		// reproduces on re-issue; a snapshot failure is a serialization
		// defect. Rendering the wrong one mislabels the failure mode.
		const guidance =
			local.kind === "local_buffer_overflow"
				? "Local gjc staging-buffer limit, not a provider or context-window failure; re-issuing reproduces it."
				: local.kind === "local_snapshot_failure"
					? "Local gjc event-serialization defect, not a provider failure; safe to retry."
					: undefined;
		if (guidance) lines.push(`  ${theme.fg("dim", guidance)}`);
	}
	if (snapshot.assignment) {
		lines.push(`  ${theme.fg("dim", "Assignment:")}`);
		for (const al of snapshot.assignment.split("\n")) lines.push(`    ${theme.fg("toolOutput", replaceTabs(al))}`);
	}
	if (snapshot.steerMessage) {
		lines.push(`  ${theme.fg("accent", `Steer (${snapshot.steerState ?? "queued"})`)}`);
		const maxLines = expanded ? PREVIEW_LINES_EXPANDED : PREVIEW_LINES_COLLAPSED;
		for (const pl of getPreviewLines(snapshot.steerMessage, maxLines, PREVIEW_LINE_WIDTH, Ellipsis.Unicode)) {
			lines.push(`    ${theme.fg("toolOutput", replaceTabs(pl))}`);
		}
	}

	// Defense in depth: the producer only attaches `progress` when a live producer
	// exists (subagent.ts #liveProgressFields), but the renderer also honors an
	// explicit `liveProgressAvailable: false` so stale retained progress can never
	// resurrect a live panel (AC5). `staticTime` keeps wall-clock displays out of
	// cached lines when the body is served by the cache.
	if (snapshot.progress && snapshot.liveProgressAvailable !== false) {
		for (const pl of renderSubagentLiveProgress(snapshot.progress, expanded, theme, undefined, staticTime)) {
			lines.push(`  ${pl}`);
		}
	} else if (snapshot.liveProgressAvailable && (snapshot.status === "running" || snapshot.status === "queued")) {
		lines.push(`  ${theme.fg("dim", "running, no approved activity summary yet")}`);
	}

	const preview = snapshot.errorText?.trim() || snapshot.resultText?.trim();
	if (preview) {
		const maxLines = expanded ? PREVIEW_LINES_EXPANDED : PREVIEW_LINES_COLLAPSED;
		const tone = snapshot.errorText ? "error" : "dim";
		for (const pl of getPreviewLines(preview, maxLines, PREVIEW_LINE_WIDTH, Ellipsis.Unicode)) {
			lines.push(`  ${theme.fg(tone, replaceTabs(pl))}`);
		}
		if (snapshot.truncated) {
			lines.push(
				`  ${theme.fg("dim", "Preview truncated; use the output ref or explicit ids with `verbosity=full` for more.")}`,
			);
		}
	}

	if (snapshot.guidance) {
		for (const line of getPreviewLines(snapshot.guidance, 1, PREVIEW_LINE_WIDTH, Ellipsis.Unicode)) {
			lines.push(`  ${theme.fg("dim", replaceTabs(line))}`);
		}
	}

	return lines;
}

export const subagentToolRenderer = {
	inline: true,

	renderCall(_args: unknown, _options: RenderResultOptions, theme: Theme): Component {
		return new Text(renderStatusLine({ icon: "pending", title: "Subagent" }, theme), 0, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: SubagentToolDetails },
		options: RenderResultOptions,
		theme: Theme,
	): Component {
		const subagents = result.details?.subagents ?? [];
		if (subagents.length === 0) {
			const fallback = result.content.find(c => c.type === "text")?.text || "No subagents";
			return new Text(theme.fg("dim", truncateToWidth(fallback, 100)), 0, 0);
		}

		const runningCount = subagents.filter(s => s.status === "running").length;
		const failedCount = subagents.filter(s => s.status === "failed" || s.status === "not_found").length;
		const interrupted = result.details?.interrupted === true;

		// Each snapshot's rendered-state signature is constant for this component
		// instance, so compute them at most once; the heavy per-subagent bodies are
		// cached module-side and keyed by that signature.
		let snapshotSignatures: string[] | undefined;
		return {
			render(width: number): string[] {
				const expanded = options.expanded;

				// Cheap dynamic header: may animate with `spinnerFrame` and is rebuilt
				// every frame, but it is a single status line plus an optional hint, so
				// it is never gated by the heavy body cache.
				const header = renderStatusLine(
					{
						icon: interrupted ? "warning" : runningCount > 0 ? "info" : failedCount > 0 ? "error" : "success",
						spinnerFrame: !interrupted && runningCount > 0 ? options.spinnerFrame : undefined,
						title: interrupted ? "Subagent await interrupted" : failedCount > 0 ? "Subagent failed" : "Subagent",
						description: interrupted
							? "child subagents continue"
							: runningCount > 0
								? `awaiting ${runningCount} of ${subagents.length}`
								: failedCount > 0
									? `${failedCount} ${failedCount === 1 ? "subagent" : "subagents"} failed`
									: `${subagents.length} ${subagents.length === 1 ? "subagent" : "subagents"}`,
					},
					theme,
				);
				const out: string[] = [truncateToWidth(replaceTabs(header), width, Ellipsis.Omit)];
				// Discoverability: the inline panel is a bounded preview; the session
				// observer (ctrl+s) streams the full per-subagent message history.
				if (runningCount > 0) {
					out.push(
						truncateToWidth(
							replaceTabs(`  ${theme.fg("dim", "(ctrl+s to observe sessions)")}`),
							width,
							Ellipsis.Omit,
						),
					);
				}
				const liveProgress = subagents.flatMap(snapshot =>
					snapshot.progress && snapshot.liveProgressAvailable !== false ? [snapshot.progress] : [],
				);
				for (const group of collectProviderDegradationGroups(liveProgress)) {
					out.push(
						truncateToWidth(
							replaceTabs(
								`  ${theme.fg("warning", `provider degraded: ${group.count} subagents retrying on ${group.provider}`)}`,
							),
							width,
							Ellipsis.Omit,
						),
					);
				}

				snapshotSignatures ??= subagents.map(
					snapshot =>
						`${subagentAwaitRenderedStateSignature([snapshot], result.details)}:${snapshot.setupFailureSummary ?? ""}:${snapshot.localErrorSummary?.summary ?? ""}`,
				);
				subagents.forEach((snapshot, index) => {
					// Fresh per-subagent status line (cheap), then a cached or dynamic body.
					out.push(
						truncateToWidth(
							replaceTabs(renderSubagentStatusLine(snapshot, theme, options.spinnerFrame)),
							width,
							Ellipsis.Omit,
						),
					);
					out.push(
						...(snapshotHasActiveRetry(snapshot)
							? renderDynamicSubagentBody(snapshot, expanded, width, theme)
							: renderCachedSubagentBody(snapshot, snapshotSignatures![index]!, expanded, width, theme)),
					);
				});
				return out;
			},
			invalidate() {
				// The heavy body cache is content-addressed (keyed by the rendered-state
				// signature, width, expanded, and theme), so there is no instance-local
				// state to clear here.
			},
		};
	},

	mergeCallAndResult: true,
};
