import * as fs from "node:fs";

import { type Component, truncateToWidth, visibleWidth } from "@gajae-code/tui";
import { formatCount, getProjectDir } from "@gajae-code/utils";
import { $ } from "bun";
import type { AppKeybinding, KeybindingsManager } from "../../config/keybindings";
import { KEYBINDINGS } from "../../config/keybindings";
import { settings } from "../../config/settings";
import type { StatusLinePreset, StatusLineSegmentId, StatusLineSeparatorStyle } from "../../config/settings-schema";
import { theme } from "../../modes/theme/theme";
import type { AgentSession } from "../../session/agent-session";
import { readVisibleSkillActiveState, type SkillActiveEntry } from "../../skill-state/active-state";
import * as git from "../../utils/git";
import { getSessionAccentAnsi, getSessionAccentHex } from "../../utils/session-color";
import type { ActionRegistry, FocusDomain } from "../action-registry";
import { EMPTY_JOBS_SNAPSHOT, type JobsSnapshot } from "../jobs-observer";
import { sanitizeStatusText } from "../shared";
import { renderSkillHudBar } from "./skill-hud/render";
import {
	canReuseCachedPr,
	createPrCacheContext,
	isSamePrCacheContext,
	type PrCacheContext,
	resolveCurrentBranch,
} from "./status-line/git-utils";
import { getPreset } from "./status-line/presets";
import { renderSegment, type SegmentContext } from "./status-line/segments";
import { getSeparator } from "./status-line/separators";
import { calculateTokensPerSecond } from "./status-line/token-rate";
import type { SeparatorDef } from "./status-line/types";

export interface StatusLineSegmentOptions {
	model?: { showThinkingLevel?: boolean; showContextPercent?: boolean };
	path?: { abbreviate?: boolean; maxLength?: number; stripWorkPrefix?: boolean };
	git?: { showBranch?: boolean; showStaged?: boolean; showUnstaged?: boolean; showUntracked?: boolean };
	time?: { format?: "12h" | "24h"; showSeconds?: boolean };
	usage?: { mode?: "used" | "remaining" };
}

export interface StatusLineSettings {
	preset?: StatusLinePreset;
	leftSegments?: StatusLineSegmentId[];
	rightSegments?: StatusLineSegmentId[];
	separator?: StatusLineSeparatorStyle;
	segmentOptions?: StatusLineSegmentOptions;
	previewHighlightSegment?: StatusLineSegmentId;
	showHookStatus?: boolean;
	showSkillHud?: boolean;
	sessionAccent?: boolean;
	maxRows?: number;
}

export interface StatusLineComponentOptions {
	version?: string;
	actionRegistry?: ActionRegistry<void>;
	getKeybindings?: () => KeybindingsManager;
	focusDomain?: FocusDomain;
}

export interface StatusLineActionHint {
	id: AppKeybinding;
	content: string;
}

const ACTION_HINT_PRIORITY: readonly AppKeybinding[] = [
	"app.message.sendNow",
	"app.message.queue",
	"app.message.followUp",
	"app.message.dequeue",
	"app.commandPalette.open",
	"app.plan.toggle",
	"app.mode.cycle",
	"app.thinking.cycle",
	"app.model.select",
	"app.model.cycleForward",
	"app.history.search",
	"app.session.togglePath",
	"app.session.toggleSort",
	"app.session.rename",
	"app.session.delete",
	"app.tree.foldOrUp",
	"app.tree.unfoldOrDown",
];

/**
 * Produces whole, bound action hints for the current focus domain. The registry
 * remains the authority for availability; KEYBINDINGS remains the authority for
 * whether an action has a binding and the active manager supplies overrides.
 */
export function getAvailableActionHints(
	actionRegistry: ActionRegistry<void> | undefined,
	getKeybindings: (() => KeybindingsManager) | undefined,
	width: number,
	domain: FocusDomain = "composer",
): StatusLineActionHint[] {
	if (!actionRegistry || !getKeybindings || width <= 0) return [];
	const keybindings = getKeybindings();
	const available = actionRegistry.all().filter(action => actionRegistry.isAvailable(action.id));

	const byId = new Map(available.map(action => [action.id, action]));
	const candidates = ACTION_HINT_PRIORITY.map(id => byId.get(id))
		.filter((action): action is NonNullable<typeof action> => action !== undefined)
		.filter(action => action.domains.includes(domain));
	const selected: StatusLineActionHint[] = [];
	let used = 0;
	for (const action of candidates) {
		const bindingId = action.bindingId ?? action.id;
		if (!(bindingId in KEYBINDINGS)) continue;
		const keys = keybindings.getKeys(bindingId);
		if (keys.length === 0) continue;
		const content = theme.fg("dim", keybindings.getDisplayString(bindingId)) + theme.fg("muted", ` ${action.title}`);
		const nextWidth = visibleWidth(content) + (selected.length === 0 ? 0 : 3);
		if (used + nextWidth > width) break;
		selected.push({ id: action.id, content });
		used += nextWidth;
	}
	return selected;
}

interface CollectedStatusSegments {
	ctx: SegmentContext;
	separatorDef: SeparatorDef;
	bgAnsi: string;
	fgAnsi: string;
	sepAnsi: string;
	left: string[];
	leftSegIds: StatusLineSegmentId[];
	right: string[];
	previewHighlightSegment: StatusLineSegmentId | undefined;
	sessionAccent: boolean | undefined;
	leftSepWidth: number;
	rightSepWidth: number;
	leftCapWidth: number;
	rightCapWidth: number;
}

// StatusLineComponent
// ═══════════════════════════════════════════════════════════════════════════

export class StatusLineComponent implements Component {
	#settings: StatusLineSettings = {};
	#cachedBranch: string | null | undefined = undefined;
	#cachedBranchRepoId: string | null | undefined = undefined;
	#branchProjectDir: string | undefined;
	#branchLastFetch = 0;
	#branchInFlight = false;
	#gitWatcher: fs.FSWatcher | null = null;
	#onBranchChange: (() => void) | null = null;
	#autoCompactEnabled: boolean = true;
	#hookStatuses: Map<string, string> = new Map();
	#subagentCount: number = 0;
	#jobs: JobsSnapshot = EMPTY_JOBS_SNAPSHOT;
	#sessionStartTime: number = Date.now();
	#planModeStatus: { enabled: boolean; paused: boolean } | null = null;
	#goalModeStatus: { enabled: boolean; paused: boolean } | null = null;
	#skillHudEntries: SkillActiveEntry[] = [];
	#skillHudLastFetch = 0;
	#skillHudInFlight = false;
	#version: string | undefined;
	#actionRegistry: ActionRegistry<void> | undefined;
	#getKeybindings: (() => KeybindingsManager) | undefined;
	#focusDomain: FocusDomain;

	#resolvedSettingsCache:
		| (Required<Pick<StatusLineSettings, "leftSegments" | "rightSegments" | "separator" | "segmentOptions">> &
				StatusLineSettings)
		| undefined;
	#resolvedSettingsFingerprint: string | undefined;
	#renderedRowsCache: { key: string; rows: string[] } | undefined;
	#renderedRowsCacheHits = 0;
	#renderedRowsCacheMisses = 0;

	// Git status caching (1s TTL)
	#cachedGitStatus: { staged: number; unstaged: number; untracked: number } | null = null;
	#gitStatusLastFetch = 0;
	#gitStatusInFlight = false;

	// PR lookup caching (invalidated on branch/repo context changes)
	#cachedPr: { number: number; url: string } | null | undefined = undefined;
	#cachedPrContext: PrCacheContext | undefined = undefined;
	#prLookupInFlight = false;
	#defaultBranch?: string;
	#lastTokensPerSecond: number | null = null;
	#lastTokensPerSecondTimestamp: number | null = null;

	// Provider usage caching (5-min TTL, OAuth/sub only)
	#cachedUsage: SegmentContext["usage"] = null;
	#usageFetchedAt = 0;
	#usageInFlight = false;

	constructor(
		private readonly session: AgentSession,
		options: StatusLineComponentOptions = {},
	) {
		this.#settings = {
			preset: settings.get("statusLine.preset"),
			leftSegments: settings.get("statusLine.leftSegments"),
			rightSegments: settings.get("statusLine.rightSegments"),
			separator: settings.get("statusLine.separator"),
			showHookStatus: settings.get("statusLine.showHookStatus"),
			showSkillHud: settings.get("statusLine.showSkillHud"),
			segmentOptions: settings.getGroup("statusLine").segmentOptions,
			sessionAccent: settings.get("statusLine.sessionAccent"),
			maxRows: settings.get("statusLine.maxRows"),
		};
		this.#version = options.version?.trim() || undefined;
		this.#actionRegistry = options.actionRegistry;
		this.#getKeybindings = options.getKeybindings;
		this.#focusDomain = options.focusDomain ?? "composer";
	}

	updateSettings(settings: StatusLineSettings): void {
		this.#settings = { ...this.#settings, previewHighlightSegment: undefined, ...settings };
	}

	setActionRegistry(actionRegistry: ActionRegistry<void>, getKeybindings: () => KeybindingsManager): void {
		this.#actionRegistry = actionRegistry;
		this.#getKeybindings = getKeybindings;
		this.#renderedRowsCache = undefined;
	}

	setFocusDomain(domain: FocusDomain): void {
		if (this.#focusDomain === domain) return;
		this.#focusDomain = domain;
		this.#renderedRowsCache = undefined;
	}

	setAutoCompactEnabled(enabled: boolean): void {
		this.#autoCompactEnabled = enabled;
	}

	setSubagentCount(count: number): void {
		this.#subagentCount = count;
	}

	setJobs(jobs: JobsSnapshot): void {
		this.#jobs = jobs;
	}

	setSessionStartTime(time: number): void {
		this.#sessionStartTime = time;
	}

	setPlanModeStatus(status: { enabled: boolean; paused: boolean } | undefined): void {
		this.#planModeStatus = status ?? null;
	}

	setGoalModeStatus(status: { enabled: boolean; paused: boolean } | undefined): void {
		this.#goalModeStatus = status ?? null;
	}

	setSkillHudEntriesForTest(entries: SkillActiveEntry[]): void {
		this.#skillHudEntries = entries;
		this.#skillHudLastFetch = Date.now();
	}

	setHookStatus(key: string, text: string | undefined): void {
		if (text === undefined) {
			this.#hookStatuses.delete(key);
		} else {
			this.#hookStatuses.set(key, text);
		}
	}

	watchBranch(onBranchChange: () => void): void {
		this.#onBranchChange = onBranchChange;
		this.#setupGitWatcher();
	}

	#setupGitWatcher(): void {
		if (this.#gitWatcher) {
			this.#gitWatcher.close();
			this.#gitWatcher = null;
		}

		const gitHeadPath = git.repo.resolveSync(getProjectDir())?.headPath ?? null;
		if (!gitHeadPath) return;

		try {
			this.#gitWatcher = fs.watch(gitHeadPath, () => {
				this.#invalidateGitCaches();
				if (this.#onBranchChange) {
					this.#onBranchChange();
				}
			});
		} catch {
			this.#invalidateGitCaches();
		}
	}

	dispose(): void {
		if (this.#gitWatcher) {
			this.#gitWatcher.close();
			this.#gitWatcher = null;
		}
	}

	invalidate(): void {
		this.#invalidateGitCaches();
	}

	#invalidateGitCaches(): void {
		this.#cachedBranch = undefined;
		this.#cachedBranchRepoId = undefined;
		this.#branchProjectDir = undefined;
		this.#cachedPrContext = undefined;
		this.#branchLastFetch = 0;
		this.#branchInFlight = false;
		this.#renderedRowsCache = undefined;
	}
	#getCurrentBranch(): string | null {
		const now = Date.now();
		const projectDir = getProjectDir();
		const withinTtl =
			this.#cachedBranch !== undefined &&
			this.#branchProjectDir === projectDir &&
			Date.now() - this.#branchLastFetch < 1000;
		if (withinTtl || this.#branchInFlight) {
			return this.#cachedBranch ?? null;
		}

		this.#branchInFlight = true;
		try {
			const current = resolveCurrentBranch(projectDir);
			this.#cachedBranchRepoId = current.repoId;
			this.#cachedBranch = current.branch;
			this.#branchProjectDir = projectDir;
			return this.#cachedBranch ?? null;
		} catch {
			this.#cachedBranchRepoId = null;
			this.#cachedBranch = null;
			this.#branchProjectDir = projectDir;
			return null;
		} finally {
			this.#branchLastFetch = now;
			this.#branchInFlight = false;
		}
	}

	#isDefaultBranch(branch: string): boolean {
		if (this.#defaultBranch === undefined) {
			this.#defaultBranch = "main";
			(async () => {
				const resolved = await git.branch.default(getProjectDir());
				if (resolved) {
					this.#defaultBranch = resolved;
					if (this.#onBranchChange) {
						this.#onBranchChange();
					}
				}
			})();
		}
		return branch === this.#defaultBranch;
	}

	#getGitStatus(): { staged: number; unstaged: number; untracked: number } | null {
		if (this.#gitStatusInFlight || Date.now() - this.#gitStatusLastFetch < 1000) {
			return this.#cachedGitStatus;
		}

		this.#gitStatusInFlight = true;

		(async () => {
			try {
				this.#cachedGitStatus = await git.status.summary(getProjectDir());
			} catch {
				this.#cachedGitStatus = null;
			} finally {
				this.#gitStatusLastFetch = Date.now();
				this.#gitStatusInFlight = false;
			}
		})();

		return this.#cachedGitStatus;
	}

	#lookupPr(): { number: number; url: string } | null {
		const branch = this.#getCurrentBranch();
		const currentContext = branch ? createPrCacheContext(branch, this.#cachedBranchRepoId ?? null) : null;

		if (canReuseCachedPr(this.#cachedPr, this.#cachedPrContext, currentContext)) {
			return this.#cachedPr ?? null;
		}

		const stalePr = this.#cachedPr;

		// Don't look up if no branch, detached HEAD, default branch, or already in flight
		if (!branch || branch === "detached" || this.#isDefaultBranch(branch) || this.#prLookupInFlight) {
			return stalePr ?? null;
		}

		this.#prLookupInFlight = true;
		const lookupContext = currentContext;

		// Fire async lookup, keep stale value visible until resolved
		(async () => {
			// Helper: only write cache if branch/repo context hasn't changed since launch
			const setCachedPr = (value: { number: number; url: string } | null) => {
				const latestBranch = this.#getCurrentBranch();
				const latestContext = latestBranch
					? createPrCacheContext(latestBranch, this.#cachedBranchRepoId ?? null)
					: undefined;
				if (lookupContext && isSamePrCacheContext(latestContext, lookupContext)) {
					this.#cachedPr = value;
					this.#cachedPrContext = lookupContext;
				}
			};
			try {
				// Requires `gh repo set-default` to be configured; fails gracefully if not
				const result = await $`gh pr view --json number,url`.quiet().nothrow();
				if (result.exitCode !== 0) {
					setCachedPr(null);
					return;
				}
				const pr = JSON.parse(result.stdout.toString()) as { number: number; url: string };
				if (typeof pr.number === "number") {
					setCachedPr({ number: pr.number, url: pr.url });
				} else {
					setCachedPr(null);
				}
			} catch {
				setCachedPr(null);
			} finally {
				this.#prLookupInFlight = false;
				if (this.#onBranchChange) {
					this.#onBranchChange();
				}
			}
		})();

		return stalePr ?? null;
	}

	#getTokensPerSecond(): number | null {
		let lastAssistantTimestamp: number | null = null;
		for (let i = this.session.state.messages.length - 1; i >= 0; i--) {
			const message = this.session.state.messages[i];
			if (message?.role === "assistant") {
				lastAssistantTimestamp = message.timestamp;
				break;
			}
		}

		if (lastAssistantTimestamp === null) {
			this.#lastTokensPerSecond = null;
			this.#lastTokensPerSecondTimestamp = null;
			return null;
		}

		const rate = calculateTokensPerSecond(this.session.state.messages, this.session.isStreaming);
		if (rate !== null) {
			this.#lastTokensPerSecond = rate;
			this.#lastTokensPerSecondTimestamp = lastAssistantTimestamp;
			return rate;
		}

		if (this.#lastTokensPerSecondTimestamp === lastAssistantTimestamp) {
			return this.#lastTokensPerSecond;
		}

		return null;
	}

	#refreshSkillHudInBackground(): void {
		if (this.#settings.showSkillHud === false) return;
		const now = Date.now();
		if (this.#skillHudInFlight || now - this.#skillHudLastFetch < 1000) return;
		const getCwd = this.session.sessionManager?.getCwd;
		const getSessionId = this.session.sessionManager?.getSessionId;
		const cwd = typeof getCwd === "function" ? getCwd.call(this.session.sessionManager) : getProjectDir();
		const sessionId = typeof getSessionId === "function" ? getSessionId.call(this.session.sessionManager) : undefined;
		this.#skillHudInFlight = true;
		void readVisibleSkillActiveState(cwd, sessionId, { tier: "hud" })
			.then(state => {
				this.#skillHudEntries = state?.active_skills ?? [];
			})
			.catch(() => {
				this.#skillHudEntries = [];
			})
			.finally(() => {
				this.#skillHudLastFetch = Date.now();
				this.#skillHudInFlight = false;
			});
	}

	/**
	 * Background-refresh the OAuth quota report. Guarded by a 5-min TTL on both
	 * success (cache lifetime) and error (backoff). Exposed (non-private) so
	 * unit tests can verify the backoff invariant.
	 */
	refreshUsageInBackground(): void {
		const now = Date.now();
		if (this.#usageInFlight) return;
		if (this.#usageFetchedAt > 0 && now - this.#usageFetchedAt < 5 * 60_000) return;
		const fetcher = (this.session as { fetchUsageReports?: () => Promise<unknown> }).fetchUsageReports;
		if (typeof fetcher !== "function") return;
		this.#usageInFlight = true;
		void fetcher
			.call(this.session)
			.then(reports => {
				this.#cachedUsage = this.#normalizeUsageReports(reports);
				this.#usageFetchedAt = Date.now();
				if (this.#onBranchChange) {
					this.#onBranchChange();
				}
			})
			.catch(() => {
				// Backoff on error: stamp the fetch time so the 5-min TTL guard
				// also acts as an error budget. Without this, every render
				// kicks off another fetch (gated only by #usageInFlight),
				// which hammers the endpoint during a network outage / 5xx.
				this.#usageFetchedAt = Date.now();
			})
			.finally(() => {
				this.#usageInFlight = false;
			});
	}

	#normalizeUsageReports(reports: unknown): SegmentContext["usage"] {
		if (!Array.isArray(reports)) return null;
		const windows: NonNullable<SegmentContext["usage"]>["windows"] = [];
		const seen = new Set<string>();
		const now = Date.now();

		const codexWindowLabel = (windowId: string | undefined, fallback: string): string => {
			if (windowId && /^\d+[hd]$/.test(windowId)) return windowId;
			return fallback;
		};
		const codexResetUnit = (label: string): "m" | "h" => (label.endsWith("d") ? "h" : "m");

		const pushWindow = (
			key: string,
			label: string,
			fraction: number,
			resetsAt: number | undefined,
			resetUnit: "m" | "h",
		) => {
			if (seen.has(key)) return;
			seen.add(key);
			windows.push({
				label,
				percent: fraction * 100,
				resetValue:
					typeof resetsAt === "number"
						? Math.max(0, Math.round((resetsAt - now) / (resetUnit === "m" ? 60_000 : 3_600_000)))
						: undefined,
				resetUnit,
			});
		};

		for (const report of reports) {
			if (!report || typeof report !== "object") continue;
			const provider = (report as { provider?: unknown }).provider;
			const providerId = typeof provider === "string" ? provider : undefined;
			const limits = (report as { limits?: unknown }).limits;
			if (!Array.isArray(limits)) continue;
			for (const limit of limits) {
				if (!limit || typeof limit !== "object") continue;
				const l = limit as {
					id?: unknown;
					scope?: { windowId?: string; tier?: string; modelId?: string };
					window?: { id?: string; resetsAt?: number };
					amount?: { usedFraction?: number };
				};
				const fraction = l.amount?.usedFraction;
				if (typeof fraction !== "number") continue;
				const id = typeof l.id === "string" ? l.id : "";
				const windowId = l.scope?.windowId ?? l.window?.id;
				const tier = l.scope?.tier;
				const modelId = l.scope?.modelId;
				const resetsAt = l.window?.resetsAt;

				if (providerId === "openai-codex") {
					if (id === "openai-codex:primary" || (!id && !!windowId && windowId !== "7d" && !modelId)) {
						const label = codexWindowLabel(windowId, "primary");
						pushWindow("codex:primary", label, fraction, resetsAt, codexResetUnit(label));
					} else if (id === "openai-codex:secondary" || (!id && windowId === "7d" && !modelId)) {
						const label = codexWindowLabel(windowId, "secondary");
						pushWindow("codex:secondary", label, fraction, resetsAt, codexResetUnit(label));
					}
				} else if (windowId === "5h" && !tier) {
					pushWindow(`${providerId ?? "provider"}:5h`, "5h", fraction, resetsAt, "m");
				} else if (windowId === "7d" && !tier) {
					pushWindow(`${providerId ?? "provider"}:7d`, "7d", fraction, resetsAt, "h");
				}
			}
		}

		return windows.length > 0 ? { windows } : null;
	}

	#buildSegmentContext(
		width: number,
		effectiveSettings: Required<
			Pick<StatusLineSettings, "leftSegments" | "rightSegments" | "separator" | "segmentOptions">
		> &
			StatusLineSettings,
	): SegmentContext {
		const state = this.session.state;

		// Trigger background fetch (5-min TTL); render uses cached value
		this.refreshUsageInBackground();

		// Get usage statistics
		const aggregateUsageStats = this.session.sessionManager?.getUsageStatistics() ?? {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			premiumRequests: 0,
			cost: 0,
		};
		const usageStats = {
			...aggregateUsageStats,
			tokensPerSecond: this.#getTokensPerSecond(),
		};

		const contextUsage = this.session.getContextUsage?.();
		const contextWindow = contextUsage?.contextWindow ?? state.model?.contextWindow ?? 0;
		const contextPercent = contextUsage?.percent ?? null;
		// Suppress the inline model percentage when a standalone context_pct
		// segment is also rendered, so the value is not shown twice.
		const contextPctSegmentActive =
			effectiveSettings.leftSegments.includes("context_pct") ||
			effectiveSettings.rightSegments.includes("context_pct");

		return {
			session: this.session,
			width,
			options: effectiveSettings.segmentOptions ?? {},
			planMode: this.#planModeStatus,
			goalMode: this.#goalModeStatus,
			usageStats,
			contextPercent,
			contextWindow,
			contextPctSegmentActive,
			autoCompactEnabled: this.#autoCompactEnabled,
			subagentCount: this.#subagentCount,
			jobs: this.#jobs,
			sessionStartTime: this.#sessionStartTime,
			git: {
				branch: this.#getCurrentBranch(),
				status: this.#getGitStatus(),
				pr: this.#lookupPr(),
			},
			usage: this.#cachedUsage,
		};
	}

	#settingsFingerprint(): string {
		return JSON.stringify(this.#settings);
	}

	#resolveSettings(): Required<
		Pick<StatusLineSettings, "leftSegments" | "rightSegments" | "separator" | "segmentOptions">
	> &
		StatusLineSettings {
		const fingerprint = this.#settingsFingerprint();
		if (this.#resolvedSettingsCache && this.#resolvedSettingsFingerprint === fingerprint) {
			return this.#resolvedSettingsCache;
		}

		const preset = this.#settings.preset ?? "default";
		const presetDef = getPreset(preset);
		const useCustomSegments = preset === "custom";
		const mergedSegmentOptions: StatusLineSettings["segmentOptions"] = {};

		for (const [segment, options] of Object.entries(presetDef.segmentOptions ?? {})) {
			mergedSegmentOptions[segment as keyof StatusLineSegmentOptions] = { ...(options as Record<string, unknown>) };
		}

		for (const [segment, options] of Object.entries(this.#settings.segmentOptions ?? {})) {
			const current = mergedSegmentOptions[segment as keyof StatusLineSegmentOptions] ?? {};
			mergedSegmentOptions[segment as keyof StatusLineSegmentOptions] = {
				...(current as Record<string, unknown>),
				...(options as Record<string, unknown>),
			};
		}

		const leftSegments = useCustomSegments
			? (this.#settings.leftSegments ?? presetDef.leftSegments)
			: presetDef.leftSegments;
		const rightSegments = useCustomSegments
			? (this.#settings.rightSegments ?? presetDef.rightSegments)
			: presetDef.rightSegments;

		this.#resolvedSettingsFingerprint = fingerprint;
		this.#resolvedSettingsCache = {
			...this.#settings,
			leftSegments,
			rightSegments,
			separator: this.#settings.separator ?? presetDef.separator,
			segmentOptions: mergedSegmentOptions,
		};
		return this.#resolvedSettingsCache;
	}

	#groupWidth(parts: string[], capWidth: number, sepWidth: number): number {
		if (parts.length === 0) return 0;
		const partsWidth = parts.reduce((sum, part) => sum + visibleWidth(part), 0);
		const sepTotal = Math.max(0, parts.length - 1) * (sepWidth + 2);
		return partsWidth + sepTotal + 2 + capWidth;
	}

	#renderStatusGroup(
		parts: string[],
		direction: "left" | "right",
		separatorDef: SeparatorDef,
		bgAnsi: string,
		fgAnsi: string,
		sepAnsi: string,
	): string {
		if (parts.length === 0) return "";
		const sep = direction === "left" ? separatorDef.left : separatorDef.right;
		const cap = separatorDef.endCaps
			? direction === "left"
				? separatorDef.endCaps.right
				: separatorDef.endCaps.left
			: "";
		const capPrefix = separatorDef.endCaps?.useBgAsFg ? bgAnsi.replace("\x1b[48;", "\x1b[38;") : bgAnsi + sepAnsi;
		const capText = cap ? `${capPrefix}${cap}\x1b[0m` : "";

		let content = bgAnsi + fgAnsi;
		content += ` ${parts.join(` ${sepAnsi}${sep}${fgAnsi} `)} `;
		content += "\x1b[0m";

		if (capText) {
			return direction === "right" ? capText + content : content + capText;
		}
		return content;
	}

	#shrinkPathToWidth(content: string, ctx: SegmentContext, shrinkBy: number): string | null {
		const currentPathVW = visibleWidth(content);
		const minPathVW = 8; // icon + ellipsis + a few chars
		const shrinkable = currentPathVW - minPathVW;
		if (shrinkable <= 0 || shrinkBy <= 0) return null;
		const targetShrink = Math.min(shrinkable, shrinkBy);
		const currentMaxLen = ctx.options.path?.maxLength ?? 40;
		let newMaxLen = Math.max(4, Math.min(currentMaxLen, currentPathVW) - targetShrink);
		const pathCtx = (maxLen: number): SegmentContext => ({
			...ctx,
			options: { ...ctx.options, path: { ...ctx.options.path, maxLength: maxLen } },
		});
		let reRendered = renderSegment("path", pathCtx(newMaxLen));
		if (!reRendered.visible || !reRendered.content) return null;
		// maxLength governs path text, not icon prefix; iterate to compensate.
		for (let i = 0; i < 8; i++) {
			const saved = currentPathVW - visibleWidth(reRendered.content);
			if (saved >= targetShrink) break;
			const nextMaxLen = Math.max(4, newMaxLen - (targetShrink - saved));
			if (nextMaxLen >= newMaxLen) break; // no progress or hit floor
			newMaxLen = nextMaxLen;
			const adjusted = renderSegment("path", pathCtx(newMaxLen));
			if (!adjusted.visible || !adjusted.content) break;
			reRendered = adjusted;
		}
		return reRendered.content;
	}

	#collectStatusSegments(
		width: number,
		effectiveSettings: Required<
			Pick<StatusLineSettings, "leftSegments" | "rightSegments" | "separator" | "segmentOptions">
		> &
			StatusLineSettings,
	): CollectedStatusSegments {
		const ctx = this.#buildSegmentContext(width, effectiveSettings);
		const separatorDef = getSeparator(effectiveSettings.separator ?? "powerline-thin", theme);

		// Use the subtle surface tone (the same elevated background as user-message
		// bubbles) instead of the heavy `statusLineBg` block, so the rail layers
		// just above the base background as a quiet zone rather than a solid bar.
		// Resolving through a semantic slot keeps it correct across every theme.
		const bgAnsi = theme.getBgAnsi("userMessageBg");
		const fgAnsi = theme.getFgAnsi("text");
		const sepAnsi = theme.getFgAnsi("statusLineSep");

		const previewHighlightSegment = effectiveSettings.previewHighlightSegment;
		const highlightSegment = (segId: StatusLineSegmentId, content: string): string =>
			previewHighlightSegment === segId ? `\x1b[7m${content}\x1b[27m` : content;

		const left: string[] = [];
		const leftSegIds: StatusLineSegmentId[] = [];
		for (const segId of effectiveSettings.leftSegments) {
			const rendered = renderSegment(segId, ctx);
			if (rendered.visible && rendered.content) {
				left.push(highlightSegment(segId, rendered.content));
				leftSegIds.push(segId);
			}
		}

		const right: string[] = [];
		const actionHints = getAvailableActionHints(this.#actionRegistry, this.#getKeybindings, width, this.#focusDomain);
		for (const segId of effectiveSettings.rightSegments) {
			const rendered = renderSegment(segId, ctx);
			if (rendered.visible && rendered.content) {
				right.push(highlightSegment(segId, rendered.content));
			}
		}
		right.push(...actionHints.map(hint => hint.content));

		const runningBackgroundJobs =
			this.session.getAsyncJobSnapshot()?.running.filter(job => job.metadata?.monitor !== true).length ?? 0;
		if (runningBackgroundJobs > 0) {
			const icon = theme.icon.agents ? `${theme.icon.agents} ` : "";
			const label = `${formatCount("job", runningBackgroundJobs)} running`;
			right.push(theme.fg("statusLineSubagents", `${icon}${label}`));
		}
		if (this.#version) {
			right.push(theme.fg("dim", `v${this.#version}`));
		}

		return {
			ctx,
			separatorDef,
			bgAnsi,
			fgAnsi,
			sepAnsi,
			left,
			leftSegIds,
			right,
			previewHighlightSegment,
			sessionAccent: effectiveSettings.sessionAccent,
			leftSepWidth: visibleWidth(separatorDef.left),
			rightSepWidth: visibleWidth(separatorDef.right),
			leftCapWidth: separatorDef.endCaps ? visibleWidth(separatorDef.endCaps.right) : 0,
			rightCapWidth: separatorDef.endCaps ? visibleWidth(separatorDef.endCaps.left) : 0,
		};
	}

	#resolveMaxRows(): number {
		const raw = this.#settings.maxRows ?? 1;
		if (!Number.isFinite(raw)) return 1;
		return Math.max(1, Math.min(3, Math.trunc(raw)));
	}

	#buildStatusLine(width: number, precollected?: CollectedStatusSegments): string {
		const seg = precollected ?? this.#collectStatusSegments(width, this.#resolveSettings());
		const { ctx, separatorDef, bgAnsi, fgAnsi, sepAnsi, previewHighlightSegment } = seg;
		const { leftSepWidth, rightSepWidth, leftCapWidth, rightCapWidth } = seg;
		const left = [...seg.left];
		const leftIds = [...seg.leftSegIds];
		const right = [...seg.right];
		const topFillWidth = Math.max(0, width);

		let leftWidth = this.#groupWidth(left, leftCapWidth, leftSepWidth);
		let rightWidth = this.#groupWidth(right, rightCapWidth, rightSepWidth);
		const totalWidth = () => leftWidth + rightWidth + (left.length > 0 && right.length > 0 ? 1 : 0);

		if (topFillWidth > 0) {
			// Shrink path before dropping right-side telemetry — path is the only elastic segment,
			// and presets such as default-usage should not hide usage just because cwd is long.
			const pathIdx = leftIds.indexOf("path");
			if (pathIdx >= 0 && totalWidth() > topFillWidth) {
				const overflow = totalWidth() - topFillWidth;
				const shrunk = this.#shrinkPathToWidth(left[pathIdx], ctx, overflow);
				if (shrunk !== null) {
					left[pathIdx] = previewHighlightSegment === "path" ? `\x1b[7m${shrunk}\x1b[27m` : shrunk;
					leftWidth = this.#groupWidth(left, leftCapWidth, leftSepWidth);
				}
			}
			while (totalWidth() > topFillWidth && right.length > 0) {
				right.pop();
				rightWidth = this.#groupWidth(right, rightCapWidth, rightSepWidth);
			}
			while (totalWidth() > topFillWidth && left.length > 0) {
				left.pop();
				leftIds.pop();
				leftWidth = this.#groupWidth(left, leftCapWidth, leftSepWidth);
			}
		}

		const leftGroup = this.#renderStatusGroup(left, "left", separatorDef, bgAnsi, fgAnsi, sepAnsi);
		const rightGroup = this.#renderStatusGroup(right, "right", separatorDef, bgAnsi, fgAnsi, sepAnsi);
		if (!leftGroup && !rightGroup) return "";

		if (topFillWidth === 0 || left.length === 0 || right.length === 0) {
			return leftGroup + (leftGroup && rightGroup ? " " : "") + rightGroup;
		}

		leftWidth = this.#groupWidth(left, leftCapWidth, leftSepWidth);
		rightWidth = this.#groupWidth(right, rightCapWidth, rightSepWidth);
		const gapWidth = Math.max(1, topFillWidth - leftWidth - rightWidth);
		const sessionName = seg.sessionAccent !== false ? this.session.sessionManager?.getSessionName() : undefined;
		const accentHex = sessionName ? getSessionAccentHex(sessionName) : undefined;
		const gapColor = getSessionAccentAnsi(accentHex) ?? theme.getFgAnsi("border");
		const gapFill = `${gapColor}${theme.boxRound.horizontal.repeat(gapWidth)}\x1b[39m`;
		return leftGroup + gapFill + rightGroup;
	}

	/**
	 * Multi-row status line. When `maxRows > 1` and the single-line layout would
	 * overflow, segments wrap onto additional left-justified rows instead of
	 * being dropped. Falls back to the polished justified single row whenever
	 * everything fits on one line.
	 */
	#buildStatusRows(width: number, maxRows: number): string[] {
		const effectiveSettings = this.#resolveSettings();
		const seg = this.#collectStatusSegments(width, effectiveSettings);
		const cacheKey = JSON.stringify({
			width,
			maxRows,
			settings: this.#resolvedSettingsFingerprint,
			left: seg.left,
			leftSegIds: seg.leftSegIds,
			right: seg.right,
			separator: effectiveSettings.separator,
			previewHighlightSegment: seg.previewHighlightSegment,
			sessionAccent: seg.sessionAccent,
			theme: [seg.bgAnsi, seg.fgAnsi, seg.sepAnsi],
			rowLayout: {
				separatorLeft: seg.separatorDef.left,
				separatorRight: seg.separatorDef.right,
				separatorEndCapLeft: seg.separatorDef.endCaps?.left,
				separatorEndCapRight: seg.separatorDef.endCaps?.right,
				separatorEndCapUseBgAsFg: seg.separatorDef.endCaps?.useBgAsFg,
				borderFgAnsi: theme.getFgAnsi("border"),
				boxRoundHorizontal: theme.boxRound.horizontal,
			},
			context: [seg.ctx.contextPercent, seg.ctx.contextWindow],
			usageStats: seg.ctx.usageStats,
			usage: seg.ctx.usage,
			git: seg.ctx.git,
			modes: [seg.ctx.planMode, seg.ctx.goalMode, seg.ctx.autoCompactEnabled],
			runtime: [seg.ctx.subagentCount, seg.ctx.jobs, seg.ctx.sessionStartTime],
			sessionName: seg.sessionAccent !== false ? this.session.sessionManager?.getSessionName() : undefined,
			asyncJobs: this.session
				.getAsyncJobSnapshot()
				?.running.filter(job => job.metadata?.monitor !== true)
				.map(job => job.id ?? job.metadata ?? job)
				.join(","),
			version: this.#version,
		});
		if (this.#renderedRowsCache?.key === cacheKey) {
			this.#renderedRowsCacheHits++;
			return [...this.#renderedRowsCache.rows];
		}
		this.#renderedRowsCacheMisses++;

		if (seg.left.length === 0 && seg.right.length === 0) {
			this.#renderedRowsCache = { key: cacheKey, rows: [] };
			return [];
		}

		const topFillWidth = Math.max(1, width);
		const leftWidth = this.#groupWidth(seg.left, seg.leftCapWidth, seg.leftSepWidth);
		const rightWidth = this.#groupWidth(seg.right, seg.rightCapWidth, seg.rightSepWidth);
		const gap = seg.left.length > 0 && seg.right.length > 0 ? 1 : 0;
		const fitsSingleRow = leftWidth + rightWidth + gap <= topFillWidth;

		let rows: string[];
		if (maxRows <= 1 || fitsSingleRow) {
			const single = this.#buildStatusLine(width, seg);
			rows = single ? [single] : [];
		} else {
			const items: { content: string; isPath: boolean }[] = [
				...seg.left.map((content, i) => ({ content, isPath: seg.leftSegIds[i] === "path" })),
				...seg.right.map(content => ({ content, isPath: false })),
			];

			for (const item of items) {
				if (!item.isPath) continue;
				const alone = this.#groupWidth([item.content], seg.leftCapWidth, seg.leftSepWidth);
				if (alone > topFillWidth) {
					const shrunk = this.#shrinkPathToWidth(item.content, seg.ctx, alone - topFillWidth);
					if (shrunk !== null) item.content = shrunk;
				}
			}

			const packedRows: string[][] = [];
			let current: string[] = [];
			for (const item of items) {
				if (current.length === 0) {
					current.push(item.content);
					continue;
				}
				const tentative = [...current, item.content];
				if (this.#groupWidth(tentative, seg.leftCapWidth, seg.leftSepWidth) <= topFillWidth) {
					current = tentative;
				} else {
					packedRows.push(current);
					current = [item.content];
					if (packedRows.length >= maxRows) break;
				}
			}
			if (packedRows.length < maxRows && current.length > 0) {
				packedRows.push(current);
			}

			rows = packedRows.map(row =>
				this.#renderStatusGroup(row, "left", seg.separatorDef, seg.bgAnsi, seg.fgAnsi, seg.sepAnsi),
			);
		}

		this.#renderedRowsCache = { key: cacheKey, rows };
		return [...rows];
	}

	getTopBorder(width: number): { content: string; width: number } {
		const content = this.#buildStatusLine(width);
		return {
			content,
			width: visibleWidth(content),
		};
	}

	/**
	 * Multi-row-aware content for the settings preview: the wrapped rows joined
	 * with newlines so a single `Text` renders them stacked. Honors the current
	 * `maxRows`; identical to the single status line when `maxRows` is 1 or when
	 * everything fits on one row.
	 */
	getPreviewContent(width: number): string {
		return this.#buildStatusRows(width, this.#resolveMaxRows()).join("\n");
	}

	getCacheStatsForTest(): { rowHits: number; rowMisses: number } {
		return { rowHits: this.#renderedRowsCacheHits, rowMisses: this.#renderedRowsCacheMisses };
	}

	invalidateBranchForTest(): void {
		this.#invalidateGitCaches();
	}

	setCachedPrForTest(pr: { number: number; url: string } | null): void {
		const branch = this.#getCurrentBranch();
		this.#cachedPr = pr;
		this.#cachedPrContext = branch ? createPrCacheContext(branch, this.#cachedBranchRepoId ?? null) : undefined;
	}

	render(width: number): string[] {
		const lines: string[] = [];
		this.#refreshSkillHudInBackground();
		const skillHud = this.#settings.showSkillHud === false ? null : renderSkillHudBar(this.#skillHudEntries, width);
		if (skillHud) {
			lines.push(skillHud);
		}

		const statusRows = this.#buildStatusRows(width, this.#resolveMaxRows());
		for (const statusRow of statusRows) {
			if (statusRow) lines.push(truncateToWidth(statusRow, width));
		}

		const showHooks = this.#settings.showHookStatus ?? true;
		if (showHooks && this.#hookStatuses.size > 0) {
			const sortedStatuses = Array.from(this.#hookStatuses.entries())
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([, text]) => sanitizeStatusText(text));
			const hookLine = sortedStatuses.join(" ");
			lines.push(truncateToWidth(hookLine, width));
		}

		return lines;
	}
}
