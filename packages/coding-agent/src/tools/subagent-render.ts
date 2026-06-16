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
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../modes/theme/theme";
import { renderSubagentLiveProgress } from "../task/render";
import { Ellipsis, Hasher, renderStatusLine } from "../tui";
import {
	formatDuration,
	formatStatusIcon,
	getPreviewLines,
	replaceTabs,
	type ToolUIStatus,
	truncateToWidth,
} from "./render-utils";
import { type SubagentSnapshot, type SubagentToolDetails, subagentAwaitRenderedStateSignature } from "./subagent";

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
 * and retry countdowns are never baked into cached lines.
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
	const lines = renderSubagentSnapshotBody(snapshot, expanded, theme).map(line =>
		line.length > 0 ? truncateToWidth(line, width, Ellipsis.Omit) : "",
	);
	subagentBodyRenderCount += 1;
	subagentBodyCache.set(key, lines);
	if (subagentBodyCache.size > SUBAGENT_BODY_CACHE_MAX) {
		const oldest = subagentBodyCache.keys().next().value;
		if (oldest !== undefined) subagentBodyCache.delete(oldest);
	}
	return lines;
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
	const id = theme.fg("muted", snapshot.id);
	const status = theme.fg("dim", snapshot.status);
	const duration = theme.fg("dim", formatDuration(snapshot.durationMs));
	return `${icon} ${id} ${status} ${duration}`;
}

// Heavy, cacheable per-subagent body: a pure function of (snapshot content, expanded,
// theme). No spinner frame and no wall-clock displays leak in (live progress uses
// `staticTime`), so the module body cache can never serve stale or frozen-ticking lines.
function renderSubagentSnapshotBody(snapshot: SubagentSnapshot, expanded: boolean, theme: Theme): string[] {
	const lines: string[] = [];

	// Static receipt fields (parity with the markdown content for non-await actions).
	if (snapshot.jobId !== snapshot.id) lines.push(`  ${theme.fg("dim", `Job: ${snapshot.jobId}`)}`);
	if (snapshot.agent && snapshot.agent !== "unknown") {
		lines.push(`  ${theme.fg("dim", `Agent: ${snapshot.agent} (${snapshot.agentSource})`)}`);
	}
	if (snapshot.effectiveModel) {
		if (snapshot.modelFellBack && snapshot.requestedModel) {
			lines.push(
				`  ${theme.fg("warning", `Model: ${snapshot.effectiveModel} (requested ${snapshot.requestedModel}, fell back — no credentials)`)}`,
			);
		} else {
			lines.push(`  ${theme.fg("dim", `Model: ${snapshot.effectiveModel}`)}`);
		}
	}
	if (snapshot.description) lines.push(`  ${theme.fg("dim", `Description: ${snapshot.description}`)}`);
	if (snapshot.outputRef) lines.push(`  ${theme.fg("dim", `Output: ${snapshot.outputRef}`)}`);
	if (snapshot.assignment) {
		lines.push(`  ${theme.fg("dim", "Assignment:")}`);
		for (const al of snapshot.assignment.split("\n")) lines.push(`    ${theme.fg("toolOutput", replaceTabs(al))}`);
	}

	// Defense in depth: the producer only attaches `progress` when a live producer
	// exists (subagent.ts #liveProgressFields), but the renderer also honors an
	// explicit `liveProgressAvailable: false` so stale retained progress can never
	// resurrect a live panel (AC5). `staticTime` keeps wall-clock displays out of
	// these cached lines.
	if (snapshot.progress && snapshot.liveProgressAvailable !== false) {
		for (const pl of renderSubagentLiveProgress(snapshot.progress, expanded, theme, undefined, true)) {
			lines.push(`  ${pl}`);
		}
	} else if (snapshot.liveProgressAvailable && (snapshot.status === "running" || snapshot.status === "queued")) {
		lines.push(`  ${theme.fg("dim", "running, no activity yet")}`);
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

	if (snapshot.guidance) lines.push(`  ${theme.fg("dim", snapshot.guidance)}`);
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
						icon: runningCount > 0 ? "info" : "success",
						spinnerFrame: runningCount > 0 ? options.spinnerFrame : undefined,
						title: "Subagent",
						description:
							runningCount > 0
								? `awaiting ${runningCount} of ${subagents.length}`
								: `${subagents.length} ${subagents.length === 1 ? "subagent" : "subagents"}`,
					},
					theme,
				);
				const out: string[] = [truncateToWidth(header, width, Ellipsis.Omit)];
				// Discoverability: the inline panel is a bounded preview; the session
				// observer (ctrl+s) streams the full per-subagent message history.
				if (runningCount > 0) {
					out.push(truncateToWidth(`  ${theme.fg("dim", "(ctrl+s to observe sessions)")}`, width, Ellipsis.Omit));
				}

				snapshotSignatures ??= subagents.map(snapshot => subagentAwaitRenderedStateSignature([snapshot]));
				subagents.forEach((snapshot, index) => {
					// Fresh per-subagent status line (cheap), then the cached heavy body.
					out.push(
						truncateToWidth(
							renderSubagentStatusLine(snapshot, theme, options.spinnerFrame),
							width,
							Ellipsis.Omit,
						),
					);
					out.push(...renderCachedSubagentBody(snapshot, snapshotSignatures![index]!, expanded, width, theme));
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
