import * as fs from "node:fs";

import { resolveOAuthStorageProvider } from "@gajae-code/ai/core";
import { type Component, truncateToWidth, visibleWidth } from "@gajae-code/tui";
import { formatCount, getProjectDir, logger } from "@gajae-code/utils";
import { getShellConfig } from "@gajae-code/utils/shell-config";
import {
	type AppKeybinding,
	KEYBINDINGS,
	type KeybindingsManager,
	type KeyDisplayContext,
} from "../../config/keybindings";
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
	normalizeStatusLineCommandOptions,
	runStatusLineCommand,
	type StatusLineCommandOptions,
} from "./status-line/command";
import { lookupCurrentPrCached } from "./status-line/gh";
import {
	canReuseCachedPr,
	createPrCacheContext,
	isSamePrCacheContext,
	type PrCacheContext,
	resolveCurrentBranch,
} from "./status-line/git-utils";
import { getPreset } from "./status-line/presets";
import { buildPriorityRow, type PriorityItemSet } from "./status-line/priority-row";
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
	command?: StatusLineCommandOptions;
}

export interface StatusLineSettings {
	preset?: StatusLinePreset;
	leftSegments?: StatusLineSegmentId[];
	rightSegments?: StatusLineSegmentId[];
	separator?: StatusLineSeparatorStyle;
	segmentOptions?: StatusLineSegmentOptions;
	previewHighlightSegment?: StatusLineSegmentId;
	previewHighlightStyle?: "focus" | "selected";
	showHookStatus?: boolean;
	showSkillHud?: boolean;
	showActionHints?: boolean;
	sessionAccent?: boolean;
	maxRows?: number;
}

export interface StatusLineComponentOptions {
	version?: string;
	actionRegistry?: ActionRegistry<void>;
	getKeybindings?: () => KeybindingsManager;
	focusDomain?: FocusDomain;
	keyDisplayContext?: KeyDisplayContext;
	onUpdate?: () => void;
}

export interface StatusLineActionHint {
	id: AppKeybinding;
	content: string;
}

export interface StatusLinePreviewParts {
	left: string[];
	leftIds: StatusLineSegmentId[];
	right: string[];
	rightIds: (StatusLineSegmentId | null)[];
	separator: SeparatorDef;
}

const ACTION_HINT_PRIORITY: readonly AppKeybinding[] = [
	"app.message.sendNow",
	"app.message.followUp",
	"app.message.queue",
	"app.message.dequeue",
	"app.commandPalette.open",
	"app.plan.toggle",
	"app.mode.cycle",
	"app.model.cycleForward",
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
	keyDisplayContext?: KeyDisplayContext,
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
		const content =
			theme.fg("dim", keybindings.getDisplayString(bindingId, keyDisplayContext)) +
			theme.fg("muted", ` ${action.title}`);
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
	/** Parallel to `right`; null for action hints, job counts and the version tag. */
	rightSegIds: (StatusLineSegmentId | null)[];
	previewHighlightSegment: StatusLineSegmentId | undefined;
	previewHighlightStyle: "focus" | "selected";
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
	#onUpdate: (() => void) | null = null;
	#disposed = false;
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
	#keyDisplayContext: KeyDisplayContext | undefined;

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
	#cachedUsageReports: unknown = null;
	#cachedUsageProvider: string | undefined;
	#usageFetchedAt = 0;
	#usageInFlight = false;

	// Configured command segment cache. Command execution is always backgrounded;
	// rendering only reads these bounded, last-known values.
	#commandConfigKey: string | undefined;
	#commandOutput: string | null = null;
	#commandFailed = false;
	#commandFetchedAt = 0;
	#commandInFlightKey: string | undefined;
	#commandAbortController: AbortController | undefined;
	#commandRefreshTimer: ReturnType<typeof setTimeout> | undefined;
	#commandDiagnosticKey: string | undefined;

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
		this.#keyDisplayContext = options.keyDisplayContext;
		this.#onUpdate = options.onUpdate ?? null;
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
		this.#disposed = true;
		this.#onBranchChange = null;
		this.#onUpdate = null;
		this.#cancelCommandExecution();
		this.#clearCommandRefreshTimer();
		if (this.#gitWatcher) {
			this.#gitWatcher.close();
			this.#gitWatcher = null;
		}
	}

	#notifyUpdate(): void {
		if (this.#onUpdate) this.#onUpdate();
		else this.#onBranchChange?.();
	}

	#logCommandDiagnostic(key: string, message: string, details: Record<string, unknown> = {}): void {
		if (this.#commandDiagnosticKey === key) return;
		this.#commandDiagnosticKey = key;
		logger.warn(message, details);
	}

	#clearCommandRefreshTimer(): void {
		if (this.#commandRefreshTimer) {
			clearTimeout(this.#commandRefreshTimer);
			this.#commandRefreshTimer = undefined;
		}
	}

	#cancelCommandExecution(): void {
		this.#commandAbortController?.abort();
		this.#commandAbortController = undefined;
		this.#commandInFlightKey = undefined;
	}

	#disableCommandSegment(): void {
		this.#clearCommandRefreshTimer();
		this.#cancelCommandExecution();
		this.#commandConfigKey = undefined;
		this.#commandOutput = null;
		this.#commandFailed = false;
		this.#commandFetchedAt = 0;
		this.#commandDiagnosticKey = undefined;
	}

	#armCommandRefreshTimer(key: string, refreshMs: number): void {
		this.#clearCommandRefreshTimer();
		if (this.#disposed || this.#commandConfigKey !== key) return;
		this.#commandRefreshTimer = setTimeout(
			() => {
				this.#commandRefreshTimer = undefined;
				if (this.#disposed || this.#commandConfigKey !== key) return;
				this.#notifyUpdate();
			},
			Math.max(0, refreshMs),
		);
		this.#commandRefreshTimer.unref?.();
	}

	#trustedCommandOptions(): StatusLineCommandOptions | undefined {
		const globalLeft = this.session.settings.getGlobal("statusLine.leftSegments");
		const globalRight = this.session.settings.getGlobal("statusLine.rightSegments");
		const includesCommand = (value: unknown): boolean => Array.isArray(value) && value.includes("command");
		if (!includesCommand(globalLeft) && !includesCommand(globalRight)) return undefined;

		const globalSegmentOptions = this.session.settings.getGlobal("statusLine.segmentOptions");
		if (!globalSegmentOptions || typeof globalSegmentOptions !== "object" || Array.isArray(globalSegmentOptions)) {
			return undefined;
		}
		const commandOptions = (globalSegmentOptions as Record<string, unknown>).command;
		const resolved = normalizeStatusLineCommandOptions(commandOptions);
		return resolved.command ? resolved : undefined;
	}

	#refreshCommandInBackground(options: StatusLineCommandOptions | undefined): string {
		const resolved = normalizeStatusLineCommandOptions(options);
		const key = JSON.stringify(resolved);
		if (this.#commandConfigKey !== key) {
			this.#clearCommandRefreshTimer();
			this.#cancelCommandExecution();
			this.#commandConfigKey = key;
			this.#commandOutput = null;
			this.#commandFailed = false;
			this.#commandFetchedAt = 0;
			this.#commandDiagnosticKey = undefined;
			this.#renderedRowsCache = undefined;
		}

		if (!resolved.command) {
			this.#commandFailed = true;
			this.#logCommandDiagnostic(key, "Status line command segment is configured without a command");
			return key;
		}

		const now = Date.now();
		if (this.#commandInFlightKey === key) return key;
		const elapsed = now - this.#commandFetchedAt;
		if (this.#commandFetchedAt > 0 && elapsed < resolved.refreshMs) {
			this.#armCommandRefreshTimer(key, resolved.refreshMs - elapsed);
			return key;
		}
		this.#clearCommandRefreshTimer();

		this.#commandInFlightKey = key;
		const abortController = new AbortController();
		this.#commandAbortController = abortController;
		let shellConfig: { shell: string; args: string[]; env: Record<string, string> };
		try {
			shellConfig = getShellConfig(this.session.settings.getGlobal("shellPath"));
		} catch (error) {
			if (this.#commandInFlightKey === key && this.#commandAbortController === abortController) {
				this.#commandInFlightKey = undefined;
				this.#commandAbortController = undefined;
			}
			this.#commandFailed = true;
			this.#commandFetchedAt = Date.now();
			this.#logCommandDiagnostic(key, "Status line command shell configuration failed", {
				error: sanitizeStatusText(error instanceof Error ? error.message : String(error)).slice(0, 256),
			});
			this.#armCommandRefreshTimer(key, resolved.refreshMs);
			return key;
		}

		void runStatusLineCommand(resolved.command, {
			cwd: getProjectDir(),
			shell: shellConfig.shell,
			shellArgs: shellConfig.args,
			env: shellConfig.env,
			timeoutMs: resolved.timeoutMs,
			signal: abortController.signal,
		})
			.then(result => {
				if (this.#disposed || this.#commandConfigKey !== key) return;
				this.#commandFetchedAt = Date.now();
				if (result.timedOut || result.exitCode !== 0) {
					this.#commandFailed = true;
					this.#logCommandDiagnostic(key, "Status line command failed", {
						exitCode: result.exitCode,
						timedOut: result.timedOut,
						stderr: result.stderr,
						outputTruncated: result.outputTruncated,
					});
				} else {
					this.#commandOutput = result.stdout;
					this.#commandFailed = false;
					this.#commandDiagnosticKey = undefined;
				}
				this.#renderedRowsCache = undefined;
				this.#notifyUpdate();
			})
			.catch(error => {
				if (this.#disposed || this.#commandConfigKey !== key) return;
				this.#commandFetchedAt = Date.now();
				this.#commandFailed = true;
				this.#logCommandDiagnostic(key, "Status line command could not start", {
					error: sanitizeStatusText(error instanceof Error ? error.message : String(error)).slice(0, 256),
				});
				this.#renderedRowsCache = undefined;
				this.#notifyUpdate();
			})
			.finally(() => {
				if (this.#commandInFlightKey !== key || this.#commandAbortController !== abortController) return;
				this.#commandInFlightKey = undefined;
				this.#commandAbortController = undefined;
				this.#armCommandRefreshTimer(key, resolved.refreshMs);
			});
		return key;
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
		if (!lookupContext) {
			this.#prLookupInFlight = false;
			return stalePr ?? null;
		}

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
				const pr = await lookupCurrentPrCached(`${lookupContext.repoId ?? ""}\0${lookupContext.branch}`);
				setCachedPr(pr);
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
				this.#cachedUsageReports = reports;
				this.#cachedUsageProvider = this.#activeUsageProvider();
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
		const activeProvider = this.#activeUsageProvider();

		if (!activeProvider || !Array.isArray(reports)) return null;
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
			const providerId = typeof provider === "string" ? resolveOAuthStorageProvider(provider) : undefined;
			if (providerId !== activeProvider) continue;
			const limits = (report as { limits?: unknown }).limits;
			if (!Array.isArray(limits)) continue;
			for (const limit of limits) {
				if (!limit || typeof limit !== "object") continue;
				const l = limit as {
					id?: unknown;
					scope?: { provider?: unknown; windowId?: string; tier?: string; modelId?: string };
					window?: { id?: string; resetsAt?: number };
					amount?: { usedFraction?: number };
				};
				const fraction = l.amount?.usedFraction;
				if (typeof fraction !== "number") continue;
				const id = typeof l.id === "string" ? l.id : "";
				const scopeProvider =
					typeof l.scope?.provider === "string" ? resolveOAuthStorageProvider(l.scope.provider) : undefined;
				if (scopeProvider !== undefined && scopeProvider !== providerId) continue;
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
				} else if (windowId === "7d" && !tier && providerId !== "grok-build" && providerId !== "xai") {
					pushWindow(`${providerId ?? "provider"}:7d`, "7d", fraction, resetsAt, "h");
				} else if (providerId === "grok-build" && id === "grok-build:weekly" && windowId === "weekly" && !tier) {
					pushWindow("grok-build:weekly", "weekly", fraction, resetsAt, "h");
				}
			}
		}

		return windows.length > 0 ? { windows } : null;
	}

	#activeUsageProvider(): string | undefined {
		const model = this.session.state.model ?? this.session.model;
		if (!model || typeof model !== "object") return undefined;
		const provider = (model as { provider?: unknown }).provider;
		return typeof provider === "string" && provider.length > 0 ? resolveOAuthStorageProvider(provider) : undefined;
	}

	#syncCachedUsageForActiveProvider(): void {
		const activeProvider = this.#activeUsageProvider();
		if (this.#cachedUsageProvider === activeProvider) return;
		this.#cachedUsageProvider = activeProvider;
		this.#cachedUsage = this.#normalizeUsageReports(this.#cachedUsageReports);
	}

	#buildSegmentContext(
		width: number,
		effectiveSettings: Required<
			Pick<StatusLineSettings, "leftSegments" | "rightSegments" | "separator" | "segmentOptions">
		> &
			StatusLineSettings,
	): SegmentContext {
		const state = this.session.state;

		this.#syncCachedUsageForActiveProvider();
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
		// Never spawn a gh lookup when no pr segment is rendered; the pr segment
		// treats a null value as hidden, so gating here is behavior-identical.
		const prSegmentActive =
			effectiveSettings.leftSegments.includes("pr") || effectiveSettings.rightSegments.includes("pr");
		const commandSegmentActive =
			effectiveSettings.leftSegments.includes("command") || effectiveSettings.rightSegments.includes("command");
		const commandOptions = commandSegmentActive ? this.#trustedCommandOptions() : undefined;
		const commandKey = commandOptions ? this.#refreshCommandInBackground(commandOptions) : undefined;
		if (!commandKey) this.#disableCommandSegment();

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
				pr: prSegmentActive ? this.#lookupPr() : null,
			},
			usage: this.#cachedUsage,
			command: commandKey
				? {
						output: this.#commandOutput,
						failed: this.#commandFailed,
						pending: this.#commandInFlightKey === commandKey,
					}
				: undefined,
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

	/**
	 * Render the overflow cue for evicted status segments.
	 *
	 * Deliberately bypasses `#renderStatusGroup`: that primitive spends two
	 * padding cells plus any end cap before content (see `#groupWidth`), so it
	 * cannot produce marker-only output at one or two columns. Emits the bare
	 * marker with no padding and no caps so the final `truncateToWidth` in
	 * `render()` stays a defensive guard rather than the thing that decides
	 * whether the cue survives.
	 *
	 * `…+N` needs `2 + digits(N)` cells. When that does not fit, the count is
	 * intentionally omitted rather than truncated into a wrong number, so the
	 * cue is either exact or countless — never misleading.
	 */
	#renderOverflowMarker(count: number, available: number): string {
		if (available <= 0 || count <= 0) return "";
		const withCount = `…+${count}`;
		const text = visibleWidth(withCount) <= available ? withCount : "…";
		return truncateToWidth(theme.fg("dim", text), available);
	}

	#renderPreviewHighlight(content: string, style: "focus" | "selected"): string {
		const bgColor = style === "selected" ? "warning" : "text";
		const bgAnsi = theme.getFgAnsi(bgColor).replace("\x1b[38;", "\x1b[48;");
		const fgAnsi = theme.getBgAnsi("selectedBg").replace("\x1b[48;", "\x1b[38;");
		return `${bgAnsi}${fgAnsi}> ${Bun.stripANSI(content)} <\x1b[0m`;
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
		const previewHighlightStyle = effectiveSettings.previewHighlightStyle ?? "focus";
		const highlightSegment = (segId: StatusLineSegmentId, content: string): string =>
			previewHighlightSegment === segId ? this.#renderPreviewHighlight(content, previewHighlightStyle) : content;

		const left: string[] = [];
		const leftSegIds: StatusLineSegmentId[] = [];
		for (const segId of effectiveSettings.leftSegments) {
			if (segId === "command" && !ctx.command) continue;
			const rendered = renderSegment(segId, ctx);
			if (rendered.visible && rendered.content) {
				left.push(highlightSegment(segId, rendered.content));
				leftSegIds.push(segId);
			}
		}

		const right: string[] = [];
		const rightSegIds: (StatusLineSegmentId | null)[] = [];
		const actionHints =
			effectiveSettings.showActionHints === false
				? []
				: getAvailableActionHints(
						this.#actionRegistry,
						this.#getKeybindings,
						width,
						this.#focusDomain,
						this.#keyDisplayContext,
					);
		for (const segId of effectiveSettings.rightSegments) {
			if (segId === "command" && !ctx.command) continue;
			const rendered = renderSegment(segId, ctx);
			if (rendered.visible && rendered.content) {
				right.push(highlightSegment(segId, rendered.content));
				rightSegIds.push(segId);
			}
		}
		for (const hint of actionHints) {
			right.push(hint.content);
			rightSegIds.push(null);
		}

		const runningBackgroundJobs =
			this.session.getAsyncJobSnapshot()?.running.filter(job => job.metadata?.monitor !== true).length ?? 0;
		if (runningBackgroundJobs > 0) {
			const icon = theme.icon.agents ? `${theme.icon.agents} ` : "";
			const label = `${formatCount("job", runningBackgroundJobs)} running`;
			right.push(theme.fg("statusLineSubagents", `${icon}${label}`));
			rightSegIds.push(null);
		}
		if (this.#version) {
			right.push(theme.fg("dim", `v${this.#version}`));
			rightSegIds.push(null);
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
			rightSegIds,
			previewHighlightSegment,
			previewHighlightStyle,
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

	/**
	 * Which priority items this layout is carrying, and where.
	 *
	 * Context % has no segment of its own in most presets — it rides inside the
	 * `model` segment — so `model` inherits the context rank whenever it does.
	 * Items whose data is absent (no context window, no active goal) carry no
	 * priority at all, which keeps a rail with nothing to protect evicting
	 * exactly as it always did.
	 */
	#priorityItems(seg: CollectedStatusSegments): {
		include: PriorityItemSet;
		inlineContextPct: boolean;
	} {
		const collected = (id: StatusLineSegmentId): boolean =>
			seg.leftSegIds.includes(id) || seg.rightSegIds.includes(id);
		const inlineContextPct =
			seg.ctx.options.model?.showContextPercent !== false && seg.ctx.contextPctSegmentActive !== true;
		const goalMode = seg.ctx.goalMode;

		return {
			inlineContextPct,
			include: {
				context:
					seg.ctx.contextWindow > 0 && (collected("context_pct") || (collected("model") && inlineContextPct)),
				goal: collected("mode") && goalMode !== null && (goalMode.enabled || goalMode.paused),
				model: collected("model"),
			},
		};
	}

	/**
	 * Eviction rank: 0 is ordinary telemetry and goes first, 3 is context % and
	 * goes last. The model name outranks telemetry but loses to the goal
	 * indicator, matching context % > goal > model.
	 */
	#priorityRanker(seg: CollectedStatusSegments): (id: StatusLineSegmentId | null) => number {
		const { include, inlineContextPct } = this.#priorityItems(seg);
		const anyPriority = include.context || include.goal;

		return (id: StatusLineSegmentId | null): number => {
			if (id === null || !anyPriority) return 0;
			if (id === "context_pct") return include.context ? 3 : 0;
			if (id === "model") {
				if (include.context && inlineContextPct) return 3;
				return include.model ? 1 : 0;
			}
			if (id === "mode") return include.goal ? 2 : 0;
			return 0;
		};
	}

	/**
	 * Priority row for a layout that could not keep everything the user needs on
	 * screen, or null when the normal rail already carries context %, the goal
	 * indicator and the model name.
	 *
	 * Context % has no segment of its own in most presets — it rides inside the
	 * `model` segment — so losing `model` silently loses the highest-priority
	 * item too. Survival is therefore resolved per item, not per segment.
	 */
	#priorityRowFor(
		seg: CollectedStatusSegments,
		survivingLeftIds: readonly (StatusLineSegmentId | null)[],
		survivingRightIds: readonly (StatusLineSegmentId | null)[],
		width: number,
	): string | null {
		const survived = (id: StatusLineSegmentId): boolean =>
			survivingLeftIds.includes(id) || survivingRightIds.includes(id);

		const { include, inlineContextPct } = this.#priorityItems(seg);
		if (!include.context && !include.goal) return null;

		const contextLost = include.context && !survived("context_pct") && !(inlineContextPct && survived("model"));
		const goalLost = include.goal && !survived("mode");
		const modelLost = include.model && !survived("model");
		if (!contextLost && !goalLost && !modelLost) return null;

		return buildPriorityRow(seg.ctx, width, include);
	}

	#buildStatusLine(width: number, precollected?: CollectedStatusSegments): string {
		const seg = precollected ?? this.#collectStatusSegments(width, this.#resolveSettings());
		const { ctx, separatorDef, bgAnsi, fgAnsi, sepAnsi, previewHighlightSegment, previewHighlightStyle } = seg;
		const { leftSepWidth, rightSepWidth, leftCapWidth, rightCapWidth } = seg;
		const topFillWidth = Math.max(0, width);

		const rank = this.#priorityRanker(seg);

		/**
		 * Evict against `budget`: shrink the path first, then drop the
		 * lowest-priority segment still standing — right side before left, tail
		 * first within a side, which is the historical order for everything that
		 * carries no priority. Context %, the goal indicator and the model name
		 * outrank ordinary telemetry and are therefore the last to go. Runs from
		 * the original segment lists each time so the marker reservation can be
		 * recomputed without compounding evictions.
		 */
		const layout = (budget: number) => {
			const left = [...seg.left];
			const leftIds = [...seg.leftSegIds];
			const right = [...seg.right];
			const rightIds = [...seg.rightSegIds];
			let leftWidth = this.#groupWidth(left, leftCapWidth, leftSepWidth);
			let rightWidth = this.#groupWidth(right, rightCapWidth, rightSepWidth);
			const totalWidth = () => leftWidth + rightWidth + (left.length > 0 && right.length > 0 ? 1 : 0);
			let dropped = 0;

			if (topFillWidth > 0) {
				// Shrink path before dropping right-side telemetry — path is the only elastic segment,
				// and presets such as default-usage should not hide usage just because cwd is long.
				const pathIdx = leftIds.indexOf("path");
				if (pathIdx >= 0 && totalWidth() > budget) {
					const overflow = totalWidth() - budget;
					const shrunk = this.#shrinkPathToWidth(left[pathIdx], ctx, overflow);
					if (shrunk !== null) {
						left[pathIdx] =
							previewHighlightSegment === "path"
								? this.#renderPreviewHighlight(shrunk, previewHighlightStyle)
								: shrunk;
						leftWidth = this.#groupWidth(left, leftCapWidth, leftSepWidth);
					}
				}
				// Lowest rank loses first; equal ranks fall back to the historical
				// right-then-left, tail-first order.
				while (totalWidth() > budget && (left.length > 0 || right.length > 0)) {
					let victimSide: "left" | "right" | null = null;
					let victimIndex = -1;
					let victimRank = Number.POSITIVE_INFINITY;
					for (let index = right.length - 1; index >= 0; index -= 1) {
						const candidate = rank(rightIds[index]);
						if (candidate < victimRank) {
							victimRank = candidate;
							victimSide = "right";
							victimIndex = index;
						}
					}
					for (let index = left.length - 1; index >= 0; index -= 1) {
						const candidate = rank(leftIds[index]);
						if (candidate < victimRank) {
							victimRank = candidate;
							victimSide = "left";
							victimIndex = index;
						}
					}
					if (victimSide === null) break;
					if (victimSide === "right") {
						right.splice(victimIndex, 1);
						rightIds.splice(victimIndex, 1);
						rightWidth = this.#groupWidth(right, rightCapWidth, rightSepWidth);
					} else {
						left.splice(victimIndex, 1);
						leftIds.splice(victimIndex, 1);
						leftWidth = this.#groupWidth(left, leftCapWidth, leftSepWidth);
					}
					dropped += 1;
				}
			}
			return { left, right, leftIds, rightIds, leftWidth, rightWidth, dropped };
		};

		// First pass with the full budget establishes whether anything is lost at
		// all. Only after loss is detected do we reserve marker cells, so a rail
		// that already fits is byte-identical to before.
		let placed = layout(topFillWidth);
		let reserved = 0;
		if (placed.dropped > 0 && topFillWidth > 0) {
			// Re-evict against the reduced budget so the cue never overflows the
			// rail. Reserving cells can push out another segment, which can in turn
			// widen the count (9 -> 10 gains a digit), so converge instead of
			// reserving once: otherwise the exact count would degrade to a bare
			// marker even when the rail had room for it.
			for (let pass = 0; pass < 4; pass += 1) {
				const needed = Math.min(topFillWidth, visibleWidth(`…+${placed.dropped}`));
				if (needed <= reserved) break;
				reserved = needed;
				placed = layout(Math.max(0, topFillWidth - reserved));
			}
		}
		const marker = this.#renderOverflowMarker(placed.dropped, reserved);
		// Nothing survived that the user actually needs? Spend the rail on the
		// priority row instead of an overflow marker. Suppressing the marker here
		// is deliberate: at these widths its cells are worth more as context %.
		const priorityRow = this.#priorityRowFor(seg, placed.leftIds, placed.rightIds, topFillWidth);
		if (priorityRow !== null) return priorityRow;

		const leftGroup = this.#renderStatusGroup(placed.left, "left", separatorDef, bgAnsi, fgAnsi, sepAnsi);
		const rightGroup = this.#renderStatusGroup(placed.right, "right", separatorDef, bgAnsi, fgAnsi, sepAnsi);
		if (!leftGroup && !rightGroup) return marker;

		if (topFillWidth === 0 || placed.left.length === 0 || placed.right.length === 0) {
			return leftGroup + (leftGroup && rightGroup ? " " : "") + rightGroup + marker;
		}

		const gapWidth = Math.max(1, topFillWidth - placed.leftWidth - placed.rightWidth - visibleWidth(marker));
		const sessionName = seg.sessionAccent !== false ? this.session.sessionManager?.getSessionName() : undefined;
		const accentHex = sessionName ? getSessionAccentHex(sessionName) : undefined;
		const gapColor = getSessionAccentAnsi(accentHex) ?? theme.getFgAnsi("border");
		const gapFill = `${gapColor}${theme.boxRound.horizontal.repeat(gapWidth)}\x1b[39m`;
		return leftGroup + gapFill + rightGroup + marker;
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
			let dropped = 0;
			for (let index = 0; index < items.length; index += 1) {
				const item = items[index];
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
					if (packedRows.length >= maxRows) {
						// `current` holds the item that opened the row we cannot admit,
						// and everything after it is never visited: all of it is lost.
						dropped = items.length - index;
						current = [];
						break;
					}
				}
			}
			if (current.length > 0) {
				if (packedRows.length < maxRows) packedRows.push(current);
				else dropped += current.length;
			}

			// Prune every row down to what actually fits. Without this, an oversized
			// row survives here and the defensive truncation in `render()` trims it
			// into a lone ellipsis, which reads exactly like the overflow cue on a row
			// that is not supposed to carry one. Emptied rows are removed rather than
			// emitted blank, so at tiny widths the marker ends up alone on one row.
			for (let index = packedRows.length - 1; index >= 0; index -= 1) {
				const row = packedRows[index];
				while (row.length > 0 && this.#groupWidth(row, seg.leftCapWidth, seg.leftSepWidth) > topFillWidth) {
					row.pop();
					dropped += 1;
				}
				if (row.length === 0) packedRows.splice(index, 1);
			}

			// Wrapping is supposed to be the lossless path. When even `maxRows` rows
			// cannot hold everything, the priority row beats a partial rail plus a
			// count of what is missing.
			if (dropped > 0) {
				const priorityRow = this.#priorityRowFor(seg, [], [], topFillWidth);
				if (priorityRow !== null) {
					this.#renderedRowsCache = { key: cacheKey, rows: [priorityRow] };
					return [priorityRow];
				}
			}

			// Reserve marker cells on whichever row ends up last, evicting from its
			// tail until the cue fits. Never opens a new row: that would contradict
			// maxRows. Emptying that row is fine -- the marker then occupies it alone.
			// Popping it instead would move the marker onto a row that carries no
			// reservation, and the defensive truncation in `render()` would recreate
			// the lookalike-ellipsis failure one row further up.
			let marker = "";
			if (dropped > 0 && topFillWidth > 0) {
				let reserved = Math.min(topFillWidth, visibleWidth(`…+${dropped}`));
				while (packedRows.length > 0) {
					const lastRow = packedRows[packedRows.length - 1];
					if (this.#groupWidth(lastRow, seg.leftCapWidth, seg.leftSepWidth) + reserved <= topFillWidth) break;
					if (lastRow.length === 0) break;
					lastRow.pop();
					dropped += 1;
					reserved = Math.min(topFillWidth, visibleWidth(`…+${dropped}`));
				}
				marker = this.#renderOverflowMarker(dropped, reserved);
			}

			rows = packedRows.map((row, index) => {
				const rendered = this.#renderStatusGroup(
					row,
					"left",
					seg.separatorDef,
					seg.bgAnsi,
					seg.fgAnsi,
					seg.sepAnsi,
				);
				return index === packedRows.length - 1 ? rendered + marker : rendered;
			});
			// Every content row was pruned away, so the cue is the only thing left.
			if (packedRows.length === 0 && marker) rows = [marker];
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

	getPreviewContentForSettings(width: number, previewSettings: StatusLineSettings): string {
		const previousSettings = this.#settings;
		this.#settings = { ...previousSettings, previewHighlightSegment: undefined, ...previewSettings };
		try {
			return this.#buildStatusRows(width, this.#resolveMaxRows()).join("\n");
		} finally {
			this.#settings = previousSettings;
		}
	}

	#placePreviewSegments(
		seg: CollectedStatusSegments,
		width: number,
	): {
		left: string[];
		leftIds: StatusLineSegmentId[];
		right: string[];
		rightIds: (StatusLineSegmentId | null)[];
	} {
		const {
			ctx,
			previewHighlightSegment,
			previewHighlightStyle,
			leftSepWidth,
			rightSepWidth,
			leftCapWidth,
			rightCapWidth,
		} = seg;
		const rank = this.#priorityRanker(seg);
		const layout = (budget: number) => {
			const left = [...seg.left];
			const leftIds = [...seg.leftSegIds];
			const right = [...seg.right];
			const rightIds = [...seg.rightSegIds];
			let leftWidth = this.#groupWidth(left, leftCapWidth, leftSepWidth);
			let rightWidth = this.#groupWidth(right, rightCapWidth, rightSepWidth);
			const totalWidth = () => leftWidth + rightWidth + (left.length > 0 && right.length > 0 ? 1 : 0);
			let dropped = 0;

			const pathIdx = leftIds.indexOf("path");
			if (pathIdx >= 0 && totalWidth() > budget) {
				const shrunk = this.#shrinkPathToWidth(left[pathIdx], ctx, totalWidth() - budget);
				if (shrunk !== null) {
					left[pathIdx] =
						previewHighlightSegment === "path"
							? this.#renderPreviewHighlight(shrunk, previewHighlightStyle)
							: shrunk;
					leftWidth = this.#groupWidth(left, leftCapWidth, leftSepWidth);
				}
			}
			while (totalWidth() > budget && (left.length > 0 || right.length > 0)) {
				let victimSide: "left" | "right" | null = null;
				let victimIndex = -1;
				let victimRank = Number.POSITIVE_INFINITY;
				for (let index = right.length - 1; index >= 0; index -= 1) {
					const candidate = rank(rightIds[index]);
					if (candidate < victimRank) {
						victimRank = candidate;
						victimSide = "right";
						victimIndex = index;
					}
				}
				for (let index = left.length - 1; index >= 0; index -= 1) {
					const candidate = rank(leftIds[index]);
					if (candidate < victimRank) {
						victimRank = candidate;
						victimSide = "left";
						victimIndex = index;
					}
				}
				if (victimSide === null) break;
				if (victimSide === "right") {
					right.splice(victimIndex, 1);
					rightIds.splice(victimIndex, 1);
					rightWidth = this.#groupWidth(right, rightCapWidth, rightSepWidth);
				} else {
					left.splice(victimIndex, 1);
					leftIds.splice(victimIndex, 1);
					leftWidth = this.#groupWidth(left, leftCapWidth, leftSepWidth);
				}
				dropped += 1;
			}
			return { left, leftIds, right, rightIds, dropped };
		};

		let placed = layout(Math.max(0, width));
		let reserved = 0;
		if (placed.dropped > 0 && width > 0) {
			for (let pass = 0; pass < 4; pass += 1) {
				const needed = Math.min(width, visibleWidth(`…+${placed.dropped}`));
				if (needed <= reserved) break;
				reserved = needed;
				placed = layout(Math.max(0, width - reserved));
			}
		}
		return placed;
	}

	getPreviewPartsForSettings(width: number, previewSettings: StatusLineSettings): StatusLinePreviewParts {
		const previousSettings = this.#settings;
		this.#settings = { ...previousSettings, ...previewSettings };
		this.#resolvedSettingsCache = undefined;
		this.#resolvedSettingsFingerprint = undefined;
		try {
			const seg = this.#collectStatusSegments(width, this.#resolveSettings());
			const placed = this.#placePreviewSegments(seg, width);
			return { ...placed, separator: seg.separatorDef };
		} finally {
			this.#settings = previousSettings;
			this.#resolvedSettingsCache = undefined;
			this.#resolvedSettingsFingerprint = undefined;
		}
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
		const skillHudRows =
			this.#settings.showSkillHud === false ? null : renderSkillHudBar(this.#skillHudEntries, width);
		if (skillHudRows) {
			for (const skillHudRow of skillHudRows) {
				if (skillHudRow) lines.push(truncateToWidth(skillHudRow, width));
			}
		}

		const statusRows = this.#buildStatusRows(width, this.#resolveMaxRows());
		for (const statusRow of statusRows) {
			if (!statusRow) continue;
			// Guard on the truncated value: at width 0 the truncation collapses to an
			// empty string, and emitting that would add a blank row rather than none.
			const truncated = truncateToWidth(statusRow, width);
			if (truncated) lines.push(truncated);
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
