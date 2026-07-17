import * as os from "node:os";
import * as path from "node:path";
import { ThinkingLevel } from "@gajae-code/agent-core";
import { TERMINAL } from "@gajae-code/tui";
import { formatDuration, formatNumber, getProjectDir, pathIsWithin, relativePathWithinRoot } from "@gajae-code/utils";
import { type ThemeColor, theme } from "../../../modes/theme/theme";
import { shortenPath } from "../../../tools/render-utils";
import { getSessionAccentAnsi, getSessionAccentHex } from "../../../utils/session-color";
import { sanitizeStatusText } from "../../shared";
import { getContextUsageLevel, getContextUsageThemeColor } from "./context-thresholds";
import type { RenderedSegment, SegmentContext, StatusLineSegment, StatusLineSegmentId } from "./types";

export type { SegmentContext } from "./types";

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

function withIcon(icon: string, text: string): string {
	return icon ? `${icon} ${text}` : text;
}

function stripDisplayRoot(pwd: string): string {
	for (const root of ["/work", path.join(os.homedir(), "Projects")]) {
		const relative = relativePathWithinRoot(root, pwd);
		if (relative) return relative;
	}
	return pwd;
}

function normalizePremiumRequests(value: number): number {
	return Math.round((value + Number.EPSILON) * 100) / 100;
}

const SCRATCH_ROOTS: readonly string[] = (() => {
	const roots = new Set<string>([os.tmpdir(), path.join(os.homedir(), "tmp")]);
	if (process.platform === "win32") {
		const { TEMP, TMP, SystemRoot } = process.env;
		if (TEMP) roots.add(TEMP);
		if (TMP) roots.add(TMP);
		if (SystemRoot) roots.add(path.join(SystemRoot, "Temp"));
	} else {
		roots.add("/tmp");
		roots.add("/var/tmp");
		if (process.platform === "darwin") {
			roots.add("/private/tmp");
			roots.add("/private/var/tmp");
		}
	}
	return [...roots];
})();

function classifyProjectDir(pwd: string): { scratch: boolean; relative: string | null } {
	for (const root of SCRATCH_ROOTS) {
		if (pathIsWithin(root, pwd)) {
			return { scratch: true, relative: relativePathWithinRoot(root, pwd) };
		}
	}
	return { scratch: false, relative: null };
}

// ═══════════════════════════════════════════════════════════════════════════
// Segment Implementations
// ═══════════════════════════════════════════════════════════════════════════

const gajaeSegment: StatusLineSegment = {
	id: "gajae",
	render(_ctx) {
		return { content: theme.fg("accent", "🦞"), visible: true };
	},
};

// Legacy custom-config alias only. Public presets must use `gajae`.
const legacyPiSegment: StatusLineSegment = {
	id: "pi",
	render(_ctx) {
		return gajaeSegment.render(_ctx);
	},
};

const modelSegment: StatusLineSegment = {
	id: "model",
	render(ctx) {
		const state = ctx.session.state;
		const opts = ctx.options.model ?? {};

		let modelName = state.model?.name || state.model?.id || "no-model";
		if (modelName.startsWith("Claude ")) {
			modelName = modelName.slice(7);
		}

		let content = withIcon(theme.icon.model, modelName);

		if (ctx.session.isFastModeActive() && theme.icon.fast) {
			content += ` ${theme.icon.fast}`;
		}

		// Add thinking level with dot separator
		if (opts.showThinkingLevel !== false && state.model?.thinking) {
			const level = state.thinkingLevel ?? ThinkingLevel.Off;
			if (level !== ThinkingLevel.Off) {
				const thinkingText = theme.thinking[level as keyof typeof theme.thinking];
				if (thinkingText) {
					content += `${theme.sep.dot}${thinkingText}`;
				}
			}
		}
		// Show the context-window token percentage right next to the model /
		// reasoning effort (rather than as a trailing segment) so it stays
		// grouped with the model it describes. Disable per-preset with
		// `segmentOptions.model.showContextPercent: false`. Suppressed
		// automatically when a standalone context_pct segment is also in the
		// active layout, so the value is never shown twice.
		if (opts.showContextPercent !== false && ctx.contextPctSegmentActive !== true) {
			const pct = ctx.contextPercent;
			const window = ctx.contextWindow;
			if (window > 0) {
				if (typeof pct === "number" && Number.isFinite(pct)) {
					const color = getContextUsageThemeColor(getContextUsageLevel(pct, window));
					content += `${theme.sep.dot}${theme.fg(color, `${pct.toFixed(1)}%`)}`;
				} else {
					content += `${theme.sep.dot}${theme.fg("statusLineContext", "?")}`;
				}
			}
		}

		return { content: theme.fg("statusLineModel", content), visible: true };
	},
};

function formatGoalUsage(current: number): string {
	const used = formatNumber(current);
	return used;
}

function renderGoalMode(ctx: SegmentContext, mode: { enabled: boolean; paused: boolean }): RenderedSegment {
	const goal = ctx.session.getGoalModeState()?.goal;
	const status = goal?.status ?? (mode.paused ? "paused" : "active");

	let icon: string = theme.icon.goal;
	let color: ThemeColor = "accent";
	switch (status) {
		case "paused":
			icon = theme.icon.pause || theme.symbol("status.pending");
			color = "warning";
			break;
		case "complete":
			icon = theme.symbol("status.success");
			color = "success";
			break;
		case "dropped":
			icon = theme.symbol("status.aborted");
			color = "dim";
			break;
		default:
			break;
	}

	const parts: string[] = [withIcon(icon, "Goal")];
	const showUsage = ctx.session.settings.get("goal.statusInFooter") === true;
	if (showUsage && goal) {
		parts.push(formatGoalUsage(goal.tokensUsed));
	}
	return { content: theme.fg(color, parts.join(" ")), visible: true };
}

const modeSegment: StatusLineSegment = {
	id: "mode",
	render(ctx) {
		const pauseSuffix = theme.icon.pause ? ` ${theme.icon.pause}` : " (paused)";

		const plan = ctx.planMode;
		if (plan && (plan.enabled || plan.paused)) {
			const label = plan.paused ? `Plan${pauseSuffix}` : "Plan";
			const content = withIcon(theme.icon.plan, label);
			const color = plan.paused ? "warning" : "accent";
			return { content: theme.fg(color, content), visible: true };
		}

		const goal = ctx.goalMode;
		if (goal && (goal.enabled || goal.paused)) {
			return renderGoalMode(ctx, goal);
		}

		return { content: "", visible: false };
	},
};

const pathSegment: StatusLineSegment = {
	id: "path",
	render(ctx) {
		const opts = ctx.options.path ?? {};

		const projectDir = getProjectDir();
		const { scratch, relative } = classifyProjectDir(projectDir);
		let pwd = projectDir;

		if (opts.stripWorkPrefix !== false) {
			if (scratch) {
				if (relative) pwd = relative;
			} else {
				pwd = stripDisplayRoot(pwd);
			}
		}
		if (opts.abbreviate !== false) {
			pwd = shortenPath(pwd);
		}

		const maxLen = opts.maxLength ?? 40;
		if (pwd.length > maxLen) {
			const ellipsis = "…";
			const sliceLen = Math.max(0, maxLen - ellipsis.length);
			pwd = `${ellipsis}${pwd.slice(-sliceLen)}`;
		}

		const showScratchIcon = scratch && opts.stripWorkPrefix !== false;
		const icon = showScratchIcon ? theme.icon.scratchFolder : theme.icon.folder;
		const content = withIcon(icon, pwd);
		return { content: theme.fg("statusLinePath", content), visible: true };
	},
};

const gitSegment: StatusLineSegment = {
	id: "git",
	render(ctx) {
		const { branch, status } = ctx.git;
		if (!branch && !status) return { content: "", visible: false };

		const opts = ctx.options.git ?? {};
		const gitStatus = status;
		const isDirty = gitStatus && (gitStatus.staged > 0 || gitStatus.unstaged > 0 || gitStatus.untracked > 0);

		const showBranch = opts.showBranch !== false;
		let content = "";
		if (showBranch && branch) {
			content = withIcon(theme.icon.branch, branch);
		}

		// Add status indicators
		if (gitStatus) {
			const indicators: string[] = [];
			if (opts.showUnstaged !== false && gitStatus.unstaged > 0) {
				indicators.push(theme.fg("statusLineDirty", `*${gitStatus.unstaged}`));
			}
			if (opts.showStaged !== false && gitStatus.staged > 0) {
				indicators.push(theme.fg("statusLineStaged", `+${gitStatus.staged}`));
			}
			if (opts.showUntracked !== false && gitStatus.untracked > 0) {
				indicators.push(theme.fg("statusLineUntracked", `?${gitStatus.untracked}`));
			}
			if (indicators.length > 0) {
				const indicatorText = indicators.join(" ");
				if (!content && showBranch === false) {
					content = withIcon(theme.icon.git, indicatorText);
				} else {
					content += content ? ` ${indicatorText}` : indicatorText;
				}
			}
		}

		if (!content) return { content: "", visible: false };

		const colorName = isDirty ? "statusLineGitDirty" : "statusLineGitClean";
		return { content: theme.fg(colorName, content), visible: true };
	},
};

const prSegment: StatusLineSegment = {
	id: "pr",
	render(ctx) {
		const { pr } = ctx.git;
		if (!pr) return { content: "", visible: false };

		const label = withIcon(theme.icon.pr, `#${pr.number}`);
		const content = TERMINAL.hyperlinks ? `\x1b]8;;${pr.url}\x07${label}\x1b]8;;\x07` : label;
		return { content: theme.fg("accent", content), visible: true };
	},
};

const subagentsSegment: StatusLineSegment = {
	id: "subagents",
	render(ctx) {
		if (ctx.subagentCount === 0) {
			return { content: "", visible: false };
		}
		const content = withIcon(theme.icon.agents, `${ctx.subagentCount}`);
		return { content: theme.fg("statusLineSubagents", content), visible: true };
	},
};

const jobsSegment: StatusLineSegment = {
	id: "jobs",
	render(ctx) {
		const { jobs } = ctx;
		const visible = jobs.activeMonitorCount > 0 || jobs.activeCronCount > 0 || jobs.worstState === "failed";
		if (!visible) {
			return { content: "", visible: false };
		}
		const parts: string[] = [];
		if (jobs.activeMonitorCount > 0) {
			parts.push(withIcon(theme.icon.agents, `${jobs.activeMonitorCount}`));
		}
		if (jobs.activeCronCount > 0) {
			parts.push(withIcon(theme.icon.time, `${jobs.activeCronCount}`));
		}
		if (parts.length === 0) {
			// Nothing active but a failure is unacknowledged — keep a drill-in marker.
			parts.push(withIcon(theme.icon.warning, "jobs"));
		}
		const color: ThemeColor = jobs.worstState === "failed" ? "error" : "statusLineSubagents";
		return { content: theme.fg(color, parts.join(" ")), visible: true };
	},
};

const tokenInSegment: StatusLineSegment = {
	id: "token_in",
	render(ctx) {
		const { input } = ctx.usageStats;
		if (!input) return { content: "", visible: false };

		const content = withIcon(theme.icon.input, formatNumber(input));
		return { content: theme.fg("statusLineSpend", content), visible: true };
	},
};

const tokenOutSegment: StatusLineSegment = {
	id: "token_out",
	render(ctx) {
		const { output } = ctx.usageStats;
		if (!output) return { content: "", visible: false };

		const content = withIcon(theme.icon.output, formatNumber(output));
		return { content: theme.fg("statusLineOutput", content), visible: true };
	},
};

const tokenTotalSegment: StatusLineSegment = {
	id: "token_total",
	render(ctx) {
		// Excludes cacheRead: that field re-reads the full cached context every
		// turn, making the cumulative sum N×context_size. The dedicated cache_read
		// segment handles cache monitoring; the cost segment handles billing.
		const { input, output, cacheWrite } = ctx.usageStats;
		const total = input + output + cacheWrite;
		if (!total) return { content: "", visible: false };

		const content = withIcon(theme.icon.tokens, formatNumber(total));
		return { content: theme.fg("statusLineSpend", content), visible: true };
	},
};

const tokenRateSegment: StatusLineSegment = {
	id: "token_rate",
	render(ctx) {
		const { tokensPerSecond } = ctx.usageStats;
		if (!tokensPerSecond) return { content: "", visible: false };

		const content = withIcon(theme.icon.output, `${tokensPerSecond.toFixed(1)}/s`);
		return { content: theme.fg("statusLineOutput", content), visible: true };
	},
};

const costSegment: StatusLineSegment = {
	id: "cost",
	render(ctx) {
		const { cost, premiumRequests } = ctx.usageStats;
		const normalizedPremiumRequests = normalizePremiumRequests(premiumRequests);
		const state = ctx.session.state;
		const usingSubscription = state.model ? ctx.session.modelRegistry.isUsingOAuth(state.model) : false;

		if (!cost && !usingSubscription && !normalizedPremiumRequests) {
			return { content: "", visible: false };
		}

		const billingParts: string[] = [];
		if (cost) billingParts.push(`$${cost.toFixed(2)}`);
		if (normalizedPremiumRequests) billingParts.push(`★ ${formatNumber(normalizedPremiumRequests)}`);
		if (usingSubscription) billingParts.push("(sub)");

		return { content: theme.fg("statusLineCost", billingParts.join(" ")), visible: true };
	},
};

const contextPctSegment: StatusLineSegment = {
	id: "context_pct",
	render(ctx) {
		const pct = ctx.contextPercent;
		const window = ctx.contextWindow;
		const knownPct = typeof pct === "number" && Number.isFinite(pct) ? pct : undefined;

		const autoIcon = ctx.autoCompactEnabled && theme.icon.auto ? ` ${theme.icon.auto}` : "";
		const text = `${knownPct === undefined ? "?" : `${knownPct.toFixed(1)}%`}/${formatNumber(window)}${autoIcon}`;
		const color =
			knownPct === undefined
				? "statusLineContext"
				: getContextUsageThemeColor(getContextUsageLevel(knownPct, window));
		const content = withIcon(theme.icon.context, theme.fg(color, text));

		return { content, visible: true };
	},
};

const contextTotalSegment: StatusLineSegment = {
	id: "context_total",
	render(ctx) {
		const window = ctx.contextWindow;
		if (!window) return { content: "", visible: false };
		return {
			content: theme.fg("statusLineContext", withIcon(theme.icon.context, formatNumber(window))),
			visible: true,
		};
	},
};

const timeSpentSegment: StatusLineSegment = {
	id: "time_spent",
	render(ctx) {
		const elapsed = Date.now() - ctx.sessionStartTime;
		if (elapsed < 1000) return { content: "", visible: false };

		return { content: withIcon(theme.icon.time, formatDuration(elapsed)), visible: true };
	},
};

const timeSegment: StatusLineSegment = {
	id: "time",
	render(ctx) {
		const opts = ctx.options.time ?? {};
		const now = new Date();

		let hours = now.getHours();
		let suffix = "";
		if (opts.format === "12h") {
			suffix = hours >= 12 ? "pm" : "am";
			hours = hours % 12 || 12;
		}

		const mins = now.getMinutes().toString().padStart(2, "0");
		let timeStr = `${hours}:${mins}`;
		if (opts.showSeconds) {
			timeStr += `:${now.getSeconds().toString().padStart(2, "0")}`;
		}
		timeStr += suffix;

		return { content: withIcon(theme.icon.time, timeStr), visible: true };
	},
};

const sessionSegment: StatusLineSegment = {
	id: "session",
	render(ctx) {
		const sessionManager = ctx.session.sessionManager;
		const sessionId = sessionManager?.getSessionId?.();
		const display = sessionId?.slice(0, 8) || "new";

		return { content: withIcon(theme.icon.session, display), visible: true };
	},
};

const hostnameSegment: StatusLineSegment = {
	id: "hostname",
	render(_ctx) {
		const name = os.hostname().split(".")[0];
		return { content: withIcon(theme.icon.host, name), visible: true };
	},
};

const cacheReadSegment: StatusLineSegment = {
	id: "cache_read",
	render(ctx) {
		const { cacheRead } = ctx.usageStats;
		if (!cacheRead) return { content: "", visible: false };

		const parts = [theme.icon.cache, theme.icon.output, formatNumber(cacheRead)].filter(Boolean);
		const content = parts.join(" ");
		return { content: theme.fg("statusLineSpend", content), visible: true };
	},
};

const cacheWriteSegment: StatusLineSegment = {
	id: "cache_write",
	render(ctx) {
		const { cacheWrite } = ctx.usageStats;
		if (!cacheWrite) return { content: "", visible: false };

		const parts = [theme.icon.cache, theme.icon.input, formatNumber(cacheWrite)].filter(Boolean);
		const content = parts.join(" ");
		return { content: theme.fg("statusLineOutput", content), visible: true };
	},
};

const sessionNameSegment: StatusLineSegment = {
	id: "session_name",
	render(ctx) {
		const sessionManager = ctx.session.sessionManager;
		const name = sessionManager?.getSessionName();
		if (!name) return { content: "", visible: false };

		const ansi = getSessionAccentAnsi(getSessionAccentHex(name)) ?? theme.getFgAnsi("accent");
		return { content: `${ansi}${sanitizeStatusText(name)}\x1b[39m`, visible: true };
	},
};

function pickUsageColor(percent: number, mode: "used" | "remaining"): "muted" | "warning" | "error" {
	if (mode === "remaining") {
		if (percent <= 20) return "error";
		if (percent <= 50) return "warning";
		return "muted";
	}
	if (percent >= 80) return "error";
	if (percent >= 50) return "warning";
	return "muted";
}

function formatUsageReset(value: number, unit: "m" | "h"): string {
	if (unit === "m") {
		// total minutes (5h window: max 300)
		if (value < 60) return `${value}m`;
		const hours = Math.floor(value / 60);
		const mins = value % 60;
		return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
	}
	// total hours (7d window: max 168)
	if (value < 24) return `${value}h`;
	const days = Math.floor(value / 24);
	const hours = value % 24;
	return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
}

const usageSegment: StatusLineSegment = {
	id: "usage",
	render(ctx) {
		const u = ctx.usage;
		if (!u || u.windows.length === 0) {
			return { content: "", visible: false };
		}
		const mode = ctx.options.usage?.mode === "remaining" ? "remaining" : "used";
		const parts = u.windows.map(window => {
			const displayPercent =
				mode === "remaining" ? Math.max(0, Math.min(100, 100 - window.percent)) : window.percent;
			const pctText = theme.fg(pickUsageColor(displayPercent, mode), `${Math.round(displayPercent)}%`);
			const reset =
				window.resetValue !== undefined && window.resetUnit !== undefined
					? theme.fg("muted", ` (${formatUsageReset(window.resetValue, window.resetUnit)})`)
					: "";
			return `${window.label} ${pctText}${reset}`;
		});
		const content = withIcon(theme.icon.time, parts.join(theme.sep.dot));
		return { content, visible: true };
	},
};

// ═══════════════════════════════════════════════════════════════════════════
// Segment Registry
// ═══════════════════════════════════════════════════════════════════════════

export const SEGMENTS: Record<StatusLineSegmentId, StatusLineSegment> = {
	gajae: gajaeSegment,
	pi: legacyPiSegment,
	model: modelSegment,
	mode: modeSegment,
	path: pathSegment,
	git: gitSegment,
	pr: prSegment,
	subagents: subagentsSegment,
	jobs: jobsSegment,
	token_in: tokenInSegment,
	token_out: tokenOutSegment,
	token_total: tokenTotalSegment,
	token_rate: tokenRateSegment,
	cost: costSegment,
	context_pct: contextPctSegment,
	context_total: contextTotalSegment,
	time_spent: timeSpentSegment,
	time: timeSegment,
	session: sessionSegment,
	hostname: hostnameSegment,
	cache_read: cacheReadSegment,
	cache_write: cacheWriteSegment,
	session_name: sessionNameSegment,
	usage: usageSegment,
};

export function renderSegment(id: StatusLineSegmentId, ctx: SegmentContext): RenderedSegment {
	const segment = SEGMENTS[id];
	if (!segment) {
		return { content: "", visible: false };
	}
	return segment.render(ctx);
}

export const ALL_SEGMENT_IDS: StatusLineSegmentId[] = Object.keys(SEGMENTS) as StatusLineSegmentId[];
