import { logger } from "@gajae-code/utils";
import type { Settings } from "../config/settings";
import { listTabsForGc, releaseTabIfGcEligible, type TabGcSnapshot } from "./browser/tab-supervisor";
import { cleanupStaleScreenshotFallbackDirs, hasCreatedScreenshotFallbackDir } from "./computer-gc";

/**
 * Mandatory, session-aware resource garbage collector.
 *
 * A single process-wide, reference-counted, unref'd, non-overlapping interval sweeps:
 *  - browser tabs (the heavyweight resource: one worker thread per tab + Chrome child
 *    processes) via an idle sweep and an opportunistic RSS-pressure sweep, and
 *  - stale computer-use screenshot fallback directories on disk (lazy-armed + throttled).
 *
 * Eviction targets ONLY alive, non-in-flight, GJC-managed headless/spawned tabs owned by a
 * registered session; connected/real-Chrome/held/in-flight tabs and ownerless tabs are never
 * touched. RSS is the GJC parent-process RSS only (`process.memoryUsage().rss`); pressure
 * eviction is best-effort and never force-evicts.
 */

const DEFAULT_SWEEP_INTERVAL_MS = 30_000;
const BYTES_PER_MB = 1024 * 1024;

export interface BrowserGcPolicy {
	enabled: boolean;
	idleMs: number;
	rssLimitBytes: number;
}

export interface ComputerGcPolicy {
	enabled: boolean;
	staleMs: number;
	scanIntervalMs: number;
}

export function resolveBrowserGcPolicy(settings: Settings): BrowserGcPolicy {
	return {
		enabled: settings.get("browser.gc.enabled"),
		idleMs: settings.get("browser.gc.idleMs"),
		rssLimitBytes: settings.get("browser.gc.rssLimitMb") * BYTES_PER_MB,
	};
}

export function resolveComputerGcPolicy(settings: Settings): ComputerGcPolicy {
	return {
		enabled: settings.get("computer.screenshotGc.enabled"),
		staleMs: settings.get("computer.screenshotGc.staleMs"),
		scanIntervalMs: settings.get("computer.screenshotGc.scanIntervalMs"),
	};
}

export function resolveSweepIntervalMs(settings: Settings): number {
	return settings.get("resourceGc.sweepIntervalMs");
}

/** Injectable seams so the controller is fully testable without real browsers/filesystem/RSS. */
export interface ResourceGcDeps {
	now: () => number;
	rssBytes: () => number;
	logWarn: (msg: string, meta?: Record<string, unknown>) => void;
	listTabs: () => TabGcSnapshot[];
	releaseTab: (name: string, policy: { now: () => number; idleMs: number }) => Promise<boolean>;
	cleanupScreenshots: (opts: { now: () => number; staleMs: number }) => Promise<{ scanned: number; removed: number }>;
	screenshotArmed: () => boolean;
}

const defaultDeps: ResourceGcDeps = {
	now: () => Date.now(),
	rssBytes: () => process.memoryUsage().rss,
	logWarn: (msg, meta) => logger.warn(msg, meta),
	listTabs: () => listTabsForGc(),
	releaseTab: (name, policy) => releaseTabIfGcEligible(name, policy),
	cleanupScreenshots: opts => cleanupStaleScreenshotFallbackDirs(opts),
	screenshotArmed: () => hasCreatedScreenshotFallbackDir(),
};

// ── Controller state (process-global; tabs/browsers are module-global too) ──────────────────
const activeSessions = new Map<string, Settings>();

interface ScheduleOwner {
	generation: number;
	token: number;
}

interface DeferredSchedule {
	generation: number;
	deadline: number;
}

interface WorkOwner {
	generation: number;
	source: "timer" | "external";
}

let pendingTimer: NodeJS.Timeout | null = null;
let pendingDeadline: number | null = null;
let pendingOwner: ScheduleOwner | null = null;
let deferredSchedule: DeferredSchedule | null = null;
let inProgressOwner: WorkOwner | null = null;
let stopped = false;
let timerGeneration = 0;
let nextTimerToken = 0;
let schedulerNow = (): number => performance.now();
let rssWarningActive = false;
let lastScreenshotScanAt = 0;
let deps: ResourceGcDeps = defaultDeps;

export interface ResourceGcRegistration {
	sessionId: string;
	settings: Settings;
}

/**
 * Register a session with the resource GC. Starts the single shared timer on the first
 * registration. Returns an idempotent unregister function; the timer stops only when the last
 * session unregisters.
 */
export function registerResourceGcSession(reg: ResourceGcRegistration): () => void {
	const isNewSession = !activeSessions.has(reg.sessionId);
	activeSessions.set(reg.sessionId, reg.settings);
	stopped = false;
	if (isNewSession) {
		const deadline = schedulerNow() + resolveSweepIntervalMs(reg.settings);
		if (
			inProgressOwner?.generation === timerGeneration &&
			(pendingDeadline === null || pendingDeadline <= deadline)
		) {
			deferSchedule(timerGeneration, deadline);
		} else {
			requestSchedule(deadline);
		}
	}
	let unregistered = false;
	return () => {
		if (unregistered) return;
		unregistered = true;
		activeSessions.delete(reg.sessionId);
		if (activeSessions.size === 0) stopTimer();
	};
}

function currentSweepIntervalMs(): number {
	let min = Number.POSITIVE_INFINITY;
	for (const settings of activeSessions.values()) min = Math.min(min, resolveSweepIntervalMs(settings));
	return Number.isFinite(min) ? min : DEFAULT_SWEEP_INTERVAL_MS;
}

function clearPendingSchedule(): void {
	if (pendingTimer) clearTimeout(pendingTimer);
	pendingTimer = null;
	pendingDeadline = null;
	pendingOwner = null;
}

function requestSchedule(deadline: number): void {
	if (stopped || activeSessions.size === 0) return;
	if (pendingDeadline !== null && pendingDeadline <= deadline) return;
	clearPendingSchedule();
	const owner = { generation: timerGeneration, token: ++nextTimerToken };
	pendingDeadline = deadline;
	pendingOwner = owner;
	pendingTimer = setTimeout(
		() => {
			void handleTimerCallback(owner, deadline);
		},
		Math.max(0, deadline - schedulerNow()),
	);
	pendingTimer.unref?.();
}

function deferSchedule(generation: number, deadline: number): void {
	if (generation !== timerGeneration) return;
	if (deferredSchedule?.generation === generation) {
		deferredSchedule.deadline = Math.min(deferredSchedule.deadline, deadline);
		return;
	}
	deferredSchedule = { generation, deadline };
}

async function handleTimerCallback(owner: ScheduleOwner, deadline: number): Promise<void> {
	if (pendingOwner?.generation !== owner.generation || pendingOwner.token !== owner.token) return;
	pendingTimer = null;
	pendingDeadline = null;
	pendingOwner = null;
	if (inProgressOwner) {
		deferSchedule(owner.generation, deadline);
		return;
	}
	await runTick(owner.generation, "timer");
}

function reconcileCurrentSchedule(): void {
	if (stopped || activeSessions.size === 0 || inProgressOwner) return;
	const normalDeadline = schedulerNow() + currentSweepIntervalMs();
	const deferredDeadline = deferredSchedule?.generation === timerGeneration ? deferredSchedule.deadline : null;
	if (deferredDeadline !== null) deferredSchedule = null;
	requestSchedule(deferredDeadline === null ? normalDeadline : Math.min(deferredDeadline, normalDeadline));
}

function stopTimer(): void {
	stopped = true;
	timerGeneration++;
	clearPendingSchedule();
	deferredSchedule = null;
}

async function runTick(generation = timerGeneration, source: WorkOwner["source"] = "external"): Promise<void> {
	if (inProgressOwner || activeSessions.size === 0) return;
	const owner: WorkOwner = { generation, source };
	inProgressOwner = owner;
	try {
		await sweepOnce(deps);
	} catch (err) {
		logger.debug("resource GC sweep failed", { error: (err as Error).message });
	} finally {
		if (inProgressOwner === owner) inProgressOwner = null;
		// A stale completion only releases its own work lock. Once that lock is released, current
		// generation demand (which may have deferred behind it) can be reconciled independently.
		reconcileCurrentSchedule();
	}
}

export async function sweepOnce(d: ResourceGcDeps = deps): Promise<void> {
	if (activeSessions.size === 0) return;
	await sweepBrowserTabs(d);
	await sweepScreenshots(d);
}

function ownerBrowserPolicy(snapshot: TabGcSnapshot): BrowserGcPolicy | null {
	if (!snapshot.ownerId) return null;
	const settings = activeSessions.get(snapshot.ownerId);
	if (!settings) return null;
	return resolveBrowserGcPolicy(settings);
}

/** Coarse, ordering-only eligibility; the live recheck in releaseTabIfGcEligible is authoritative. */
function isCoarselyEligible(snapshot: TabGcSnapshot): boolean {
	return (
		(snapshot.state === "alive" || snapshot.state === "dead") &&
		snapshot.pendingCount === 0 &&
		(snapshot.kindTag === "headless" || snapshot.kindTag === "spawned")
	);
}

/** Collect idle, non-in-flight, GJC-managed, owned-and-enabled tabs, sorted LRU (oldest first). */
function collectIdleCandidates(d: ResourceGcDeps): Array<{ snapshot: TabGcSnapshot; policy: BrowserGcPolicy }> {
	const candidates: Array<{ snapshot: TabGcSnapshot; policy: BrowserGcPolicy }> = [];
	for (const snapshot of d.listTabs()) {
		if (!isCoarselyEligible(snapshot)) continue;
		const policy = ownerBrowserPolicy(snapshot);
		if (!policy?.enabled) continue;
		if (d.now() - snapshot.lastUsedAt <= policy.idleMs) continue;
		candidates.push({ snapshot, policy });
	}
	candidates.sort((a, b) => a.snapshot.lastUsedAt - b.snapshot.lastUsedAt);
	return candidates;
}

async function sweepBrowserTabs(d: ResourceGcDeps): Promise<void> {
	// Reclamation honors IR-1 strictly: ONLY idle, non-in-flight, GJC-managed, owned tabs are ever
	// evicted. RSS pressure never relaxes that boundary — it only drives the warning below.
	for (const { snapshot, policy } of collectIdleCandidates(d)) {
		await d.releaseTab(snapshot.name, { now: d.now, idleMs: policy.idleMs });
	}
	evaluateRssPressureWarning(d);
}

/** Owners whose own RSS limit is exceeded by the single shared parent-process RSS sample. */
function pressuredOwnerIds(d: ResourceGcDeps): Set<string> {
	const rss = d.rssBytes();
	const owners = new Set<string>();
	for (const [sessionId, settings] of activeSessions) {
		const policy = resolveBrowserGcPolicy(settings);
		if (policy.enabled && rss > policy.rssLimitBytes) owners.add(sessionId);
	}
	return owners;
}

/**
 * RSS pressure is a best-effort warning signal only. Because eviction is always idle-gated
 * (IR-1), when parent-process RSS stays over an enabled owner's limit and no idle, unheld tab
 * remains to reclaim for a pressured owner, we warn exactly once per continuous episode and
 * never force-evict. The warning episode resets when RSS recovers or a reclaimable tab appears.
 */
function evaluateRssPressureWarning(d: ResourceGcDeps): void {
	const pressured = pressuredOwnerIds(d);
	if (pressured.size === 0) {
		rssWarningActive = false;
		return;
	}
	const reclaimableRemains = collectIdleCandidates(d).some(
		c => c.snapshot.state === "alive" && c.snapshot.ownerId !== undefined && pressured.has(c.snapshot.ownerId),
	);
	if (reclaimableRemains) {
		rssWarningActive = false;
		return;
	}
	if (!rssWarningActive) {
		rssWarningActive = true;
		d.logWarn("Browser GC: RSS over limit but no safe (idle, unheld) browser tabs are evictable", {
			rssBytes: d.rssBytes(),
		});
	}
}

async function sweepScreenshots(d: ResourceGcDeps): Promise<void> {
	if (!d.screenshotArmed()) return;

	let staleMs: number | null = null;
	let scanIntervalMs = Number.POSITIVE_INFINITY;
	for (const settings of activeSessions.values()) {
		const policy = resolveComputerGcPolicy(settings);
		if (!policy.enabled) continue;
		staleMs = staleMs === null ? policy.staleMs : Math.min(staleMs, policy.staleMs);
		scanIntervalMs = Math.min(scanIntervalMs, policy.scanIntervalMs);
	}
	if (staleMs === null) return; // no session has screenshot GC enabled

	const now = d.now();
	if (now - lastScreenshotScanAt < scanIntervalMs) return;
	lastScreenshotScanAt = now;
	await d.cleanupScreenshots({ now: d.now, staleMs });
}

// ── Test-only seams ─────────────────────────────────────────────────────────────────────────
export function __setResourceGcDepsForTest(overrides: Partial<ResourceGcDeps>): void {
	deps = { ...defaultDeps, ...overrides };
}

export function __setResourceGcSchedulerNowForTest(now: () => number): void {
	schedulerNow = now;
}

export async function __runResourceGcTickForTest(): Promise<void> {
	await runTick();
}

export async function __runResourceGcTimerCallbackForTest(
	owner: { generation: number; token: number },
	deadline: number,
): Promise<void> {
	await handleTimerCallback(owner, deadline);
}

export function __getResourceGcStateForTest(): {
	timerActive: boolean;
	sessionCount: number;
	rssWarningActive: boolean;
	inProgress: boolean;
	generation: number;
	pendingDeadline: number | null;
	pendingOwner: { generation: number; token: number } | null;
	deferredDeadline: number | null;
	deferredGeneration: number | null;
	activeGeneration: number | null;
} {
	return {
		timerActive: pendingTimer !== null,
		sessionCount: activeSessions.size,
		rssWarningActive,
		inProgress: inProgressOwner !== null,
		generation: timerGeneration,
		pendingDeadline,
		pendingOwner: pendingOwner ? { ...pendingOwner } : null,
		deferredDeadline: deferredSchedule?.deadline ?? null,
		deferredGeneration: deferredSchedule?.generation ?? null,
		activeGeneration: inProgressOwner?.generation ?? null,
	};
}

export function __resetResourceGcForTest(): void {
	stopTimer();
	activeSessions.clear();
	inProgressOwner = null;
	deferredSchedule = null;
	rssWarningActive = false;
	lastScreenshotScanAt = 0;
	nextTimerToken = 0;
	schedulerNow = (): number => performance.now();
	deps = defaultDeps;
}
