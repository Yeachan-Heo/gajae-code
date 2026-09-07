import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { WindowsJobMemoryProbeResult } from "@gajae-code/natives";

function safeProbeWindowsJobMemory(): WindowsJobMemoryProbeResult {
	try {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const natives = require("@gajae-code/natives") as { probeWindowsJobMemory?: () => unknown };
		if (typeof natives.probeWindowsJobMemory === "function") {
			return natives.probeWindowsJobMemory() as WindowsJobMemoryProbeResult;
		}
	} catch {
		// Native addon unbuilt or missing
	}
	return { kind: "unsupported_platform", platform: process.platform };
}

import { logger } from "@gajae-code/utils";
import type { Settings } from "../config/settings";
import { computeMemoryGuardDomain } from "../runtime/memory-domain";
import { chooseMemoryGuardAction, MemoryGuardHost, resolveMemoryGuardPolicy } from "../runtime/memory-guard";
import type { MemoryGuardPolicy } from "../runtime/memory-guard-contract";
import { resolveEffectiveMemoryLimit } from "../runtime/memory-limit";
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
	monotonicNow: () => number;
	rssBytes: () => number;
	memorySnapshot: () => Promise<MemoryPressureSnapshot>;
	runGc: () => void;
	logWarn: (msg: string, meta?: Record<string, unknown>) => void;
	listTabs: () => TabGcSnapshot[];
	releaseTab: (name: string, policy: { now: () => number; idleMs: number }) => Promise<boolean>;
	cleanupScreenshots: (opts: { now: () => number; staleMs: number }) => Promise<{ scanned: number; removed: number }>;
	screenshotArmed: () => boolean;
}

/** Request collection without synchronously stopping the main event loop. */
export function requestMemoryPressureGc(): void {
	Bun.gc(false);
}

const defaultDeps: ResourceGcDeps = {
	now: () => Date.now(),
	monotonicNow: () => performance.now(),
	rssBytes: () => process.memoryUsage().rss,
	memorySnapshot: () => sampleMemoryPressure(),
	runGc: requestMemoryPressureGc,
	logWarn: (msg, meta) => logger.warn(msg, meta),
	listTabs: () => listTabsForGc(),
	releaseTab: (name, policy) => releaseTabIfGcEligible(name, policy),
	cleanupScreenshots: opts => cleanupStaleScreenshotFallbackDirs(opts),
	screenshotArmed: () => hasCreatedScreenshotFallbackDir(),
};

// ── Controller state (process-global; tabs/browsers are module-global too) ──────────────────
const activeSessions = new Map<
	string,
	{ settings: Settings; cwd: () => string; memoryGuardGeneration: symbol; memoryGuardEnabled: boolean }
>();
const scheduler = new MemoryGuardHost({
	run: async () => {
		await sweepOnce(deps);
	},
	logDebug: (message, meta) => logger.debug(message, meta),
});
let rssWarningActive = false;
let lastScreenshotScanAt = 0;
const memoryGuardGcActive = new Set<string>();
const memoryGuardLastEvaluatedAt = new Map<string, number>();
const memoryGuardRestartAboveSince = new Map<string, number>();
let deps: ResourceGcDeps = defaultDeps;

export interface ResourceGcRegistration {
	sessionId: string;
	settings: Settings;
	cwd?: string | (() => string);
}

function resolveSessionSweepIntervalMs(settings: Settings): number {
	const memoryPolicy = resolveMemoryGuardPolicy(settings);
	return memoryPolicy.enabled
		? Math.min(resolveSweepIntervalMs(settings), memoryPolicy.checkIntervalMs)
		: resolveSweepIntervalMs(settings);
}

/**
 * Register a session with the resource GC. Starts the single shared timer on the first
 * registration. Returns an idempotent unregister function; the timer stops only when the last
 * session unregisters.
 */
export function registerResourceGcSession(reg: ResourceGcRegistration): () => void {
	const registeredCwd = reg.cwd;
	const cwd = typeof registeredCwd === "function" ? registeredCwd : () => registeredCwd ?? process.cwd();
	const registration = {
		settings: reg.settings,
		cwd,
		memoryGuardGeneration: Symbol(),
		memoryGuardEnabled: resolveMemoryGuardPolicy(reg.settings).enabled,
	};
	activeSessions.set(reg.sessionId, registration);
	const unregisterSchedule = scheduler.register({
		ownerId: reg.sessionId,
		intervalMs: resolveSessionSweepIntervalMs(reg.settings),
	});
	const unregisterSettings = reg.settings.onChanged(path => {
		if (path === "memoryGuard.enabled") {
			const enabled = resolveMemoryGuardPolicy(reg.settings).enabled;
			if (enabled !== registration.memoryGuardEnabled) {
				// Fence samples already in flight, even if the guard is re-enabled before they settle.
				registration.memoryGuardGeneration = Symbol();
				registration.memoryGuardEnabled = enabled;
			}
		}
		if (
			path === "memoryGuard.enabled" ||
			path === "memoryGuard.checkIntervalMs" ||
			path === "resourceGc.sweepIntervalMs"
		) {
			scheduler.updateInterval(reg.sessionId, resolveSessionSweepIntervalMs(reg.settings));
			if (path === "memoryGuard.enabled" && !resolveMemoryGuardPolicy(reg.settings).enabled) {
				memoryGuardGcActive.delete(reg.sessionId);
				memoryGuardRestartAboveSince.delete(reg.sessionId);
				memoryGuardLastEvaluatedAt.delete(reg.sessionId);
			}
		}
	});
	let unregistered = false;
	return () => {
		if (unregistered) return;
		unregistered = true;
		activeSessions.delete(reg.sessionId);
		memoryGuardGcActive.delete(reg.sessionId);
		memoryGuardRestartAboveSince.delete(reg.sessionId);
		memoryGuardLastEvaluatedAt.delete(reg.sessionId);
		unregisterSchedule();
		unregisterSettings();
	};
}

export async function sweepOnce(d: ResourceGcDeps = deps): Promise<void> {
	if (activeSessions.size === 0) return;
	try {
		const memorySweep = sweepMemoryPressureGuard(d);
		if (memorySweep) await memorySweep;
	} catch (error) {
		d.logWarn("Memory guard: sweep failed; continuing with browser/screenshot cleanup", { error: String(error) });
	}
	await sweepBrowserTabs(d);
	await sweepScreenshots(d);
}

export interface MemoryPressureDomain {
	hardCapBytes: number;
	totalUsageBytes: number;
	source: MemoryPressureSnapshot["source"];
}

export interface MemoryPressureSnapshot {
	hardCapBytes: number;
	totalUsageBytes: number;
	parentBytes: number;
	source: "host" | "linux_cgroup_v2" | "linux_cgroup_v1" | "windows_job" | "windows_process_job_limit";
	domains?: MemoryPressureDomain[];
}

function decodeMountInfoPath(value: string): string {
	return value.replace(/\\([0-7]{3})/g, (_match, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
}

interface CgroupDirectoryCandidate {
	directory: string;
	mountPoint: string;
	fallback: boolean;
}

function resolveCgroupDirectories(
	mountInfo: string,
	membershipPath: string,
	fsType: "cgroup" | "cgroup2",
): CgroupDirectoryCandidate[] {
	const contained: CgroupDirectoryCandidate[] = [];
	const fallbacks: CgroupDirectoryCandidate[] = [];
	const seen = new Set<string>();
	for (const line of mountInfo.split("\n")) {
		const [left, right] = line.split(" - ", 2);
		if (!left || !right) continue;
		const leftFields = left.split(" ");
		const rightFields = right.split(" ");
		if (leftFields.length < 5 || rightFields[0] !== fsType) continue;
		if (fsType === "cgroup" && !rightFields.slice(2).join(",").split(",").includes("memory")) continue;
		const mountRoot = decodeMountInfoPath(leftFields[3]!);
		const mountPoint = decodeMountInfoPath(leftFields[4]!);
		const relative = path.posix.relative(mountRoot, membershipPath);
		const directory =
			!relative.startsWith("..") && !path.posix.isAbsolute(relative)
				? path.join(mountPoint, relative)
				: path.join(mountPoint, membershipPath.replace(/^\/+/, ""));
		const key = `${directory}\0${mountPoint}`;
		if (seen.has(key)) continue;
		seen.add(key);
		const fallback = relative.startsWith("..") || path.posix.isAbsolute(relative);
		const candidate = { directory, mountPoint, fallback };
		if (!relative.startsWith("..") && !path.posix.isAbsolute(relative)) contained.push(candidate);
		else fallbacks.push(candidate);
	}
	return [...contained, ...fallbacks];
}

async function readMemoryCounter(file: string): Promise<number | null> {
	try {
		const value = (await fs.readFile(file, "utf8")).trim();
		if (value === "max" || !/^\d+$/.test(value)) return null;
		const parsed = Number(value);
		return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
	} catch {
		return null;
	}
}

type MemoryLimitCounter = { kind: "finite"; bytes: number } | { kind: "unlimited" };

async function readMemoryLimit(file: string, fsType: "cgroup" | "cgroup2"): Promise<MemoryLimitCounter | null> {
	try {
		const value = (await fs.readFile(file, "utf8")).trim();
		if (value === "max") return { kind: "unlimited" };
		if (!/^\d+$/.test(value)) return null;
		const bytes = BigInt(value);
		if (fsType === "cgroup" && bytes > BigInt(Number.MAX_SAFE_INTEGER)) return { kind: "unlimited" };
		const numericBytes = Number(bytes);
		return Number.isSafeInteger(numericBytes) ? { kind: "finite", bytes: numericBytes } : null;
	} catch {
		return null;
	}
}

function parseCgroupEntry(line: string): [string, string, string] | null {
	const first = line.indexOf(":");
	const second = first < 0 ? -1 : line.indexOf(":", first + 1);
	if (first < 0 || second < 0) return null;
	return [line.slice(0, first), line.slice(first + 1, second), line.slice(second + 1)];
}

async function sampleLinuxCgroupDirectory(
	candidate: CgroupDirectoryCandidate,
	fsType: "cgroup" | "cgroup2",
	hostBytes: number,
): Promise<MemoryPressureDomain[]> {
	const limitName = fsType === "cgroup2" ? "memory.max" : "memory.limit_in_bytes";
	const usageName = fsType === "cgroup2" ? "memory.current" : "memory.usage_in_bytes";
	const source = fsType === "cgroup2" ? "linux_cgroup_v2" : "linux_cgroup_v1";
	const domains: MemoryPressureDomain[] = [];
	let current = candidate.directory;
	while (true) {
		const [limit, usage] = await Promise.all([
			readMemoryLimit(path.join(current, limitName), fsType),
			readMemoryCounter(path.join(current, usageName)),
		]);
		if (limit !== null && usage !== null && (limit.kind === "unlimited" || limit.bytes > 0)) {
			domains.push({
				hardCapBytes: limit.kind === "unlimited" ? hostBytes : Math.min(hostBytes, limit.bytes),
				totalUsageBytes: usage,
				source,
			});
		}
		if (current === candidate.mountPoint) break;
		const parent = path.dirname(current);
		if (
			parent === current ||
			(parent !== candidate.mountPoint && !parent.startsWith(`${candidate.mountPoint}${path.sep}`))
		) {
			break;
		}
		current = parent;
	}
	return domains;
}

export async function __sampleLinuxCgroupHierarchyForTest(
	mountInfo: string,
	membership: string,
	fsType: "cgroup" | "cgroup2",
	hostBytes: number,
	parentBytes: number,
): Promise<MemoryPressureSnapshot | null> {
	const containedDomains: MemoryPressureDomain[] = [];
	const fallbackDomains: MemoryPressureDomain[] = [];
	for (const candidate of resolveCgroupDirectories(mountInfo, membership, fsType)) {
		const domains = await sampleLinuxCgroupDirectory(candidate, fsType, hostBytes);
		if (candidate.fallback) fallbackDomains.push(...domains);
		else containedDomains.push(...domains);
	}
	const domains = containedDomains.length > 0 ? containedDomains : fallbackDomains;
	if (domains.length === 0) return null;
	const selected = domains.reduce((current, domain) =>
		domain.totalUsageBytes / Math.min(hostBytes, domain.hardCapBytes) >
		current.totalUsageBytes / Math.min(hostBytes, current.hardCapBytes)
			? domain
			: current,
	);
	return {
		...selected,
		totalUsageBytes: Math.max(parentBytes, selected.totalUsageBytes),
		parentBytes,
		domains,
	};
}

async function sampleLinuxCgroupMemory(hostBytes: number, parentBytes: number): Promise<MemoryPressureSnapshot | null> {
	let cgroup: string;
	let mountInfo: string;
	try {
		[cgroup, mountInfo] = await Promise.all([
			fs.readFile("/proc/self/cgroup", "utf8"),
			fs.readFile("/proc/self/mountinfo", "utf8"),
		]);
	} catch {
		return null;
	}

	const entries = cgroup
		.split("\n")
		.map(parseCgroupEntry)
		.filter((entry): entry is [string, string, string] => entry !== null);
	const v2Membership = entries.find(parts => parts[0] === "0" && parts[1] === "")?.[2];
	const v1Membership = entries.find(parts => parts[1].split(",").includes("memory"))?.[2];
	if (v2Membership) {
		const snapshot = await __sampleLinuxCgroupHierarchyForTest(
			mountInfo,
			v2Membership,
			"cgroup2",
			hostBytes,
			parentBytes,
		);
		if (snapshot) return snapshot;
	}
	if (v1Membership) {
		return __sampleLinuxCgroupHierarchyForTest(mountInfo, v1Membership, "cgroup", hostBytes, parentBytes);
	}
	return null;
}

export function __sampleWindowsJobMemoryForTest(
	hostBytes: number,
	parentBytes: number,
	probeResult?: WindowsJobMemoryProbeResult,
): MemoryPressureSnapshot | null {
	return sampleWindowsJobMemory(hostBytes, parentBytes, probeResult);
}

function sampleWindowsJobMemory(
	hostBytes: number,
	parentBytes: number,
	result = safeProbeWindowsJobMemory(),
): MemoryPressureSnapshot | null {
	if (result.kind !== "job_snapshot") return null;
	const domains: MemoryPressureDomain[] = [];
	const jobUsage = Number(result.jobMemoryUsedBytes);
	const jobLimitRaw = result.jobMemoryLimitBytes;
	const hasJobLimit = jobLimitRaw !== undefined && jobLimitRaw !== null;
	const jobLimit = hasJobLimit ? Number(jobLimitRaw) : NaN;
	if (Number.isSafeInteger(jobUsage) && jobUsage >= 0) {
		if (hasJobLimit && Number.isSafeInteger(jobLimit) && jobLimit > 0) {
			domains.push({
				hardCapBytes: jobLimit,
				totalUsageBytes: jobUsage,
				source: "windows_job",
			});
		} else {
			// Uncapped Job Object: usage participates against policy limit (no physical RAM clamp)
			domains.push({
				hardCapBytes: Number.MAX_SAFE_INTEGER,
				totalUsageBytes: jobUsage,
				source: "windows_job",
			});
		}
	}
	const processUsage = Number(result.processPrivateUsageBytes);
	const processLimitRaw = result.processMemoryLimitBytes;
	const hasProcessLimit = processLimitRaw !== undefined && processLimitRaw !== null;
	const processLimit = hasProcessLimit ? Number(processLimitRaw) : NaN;
	if (Number.isSafeInteger(processUsage) && processUsage >= 0) {
		if (hasProcessLimit && Number.isSafeInteger(processLimit) && processLimit > 0) {
			domains.push({
				hardCapBytes: processLimit,
				totalUsageBytes: processUsage,
				source: "windows_process_job_limit",
			});
		} else {
			domains.push({
				hardCapBytes: Number.MAX_SAFE_INTEGER,
				totalUsageBytes: processUsage,
				source: "windows_process_job_limit",
			});
		}
	}
	const workingSetUsage = Number(result.processWorkingSetBytes);
	if (Number.isSafeInteger(workingSetUsage) && workingSetUsage >= 0) {
		domains.push({
			hardCapBytes: hostBytes,
			totalUsageBytes: Math.max(parentBytes, workingSetUsage),
			source: "windows_process_job_limit",
		});
	}
	if (domains.length === 0) return null;
	const selected = domains.reduce((current, candidate) =>
		candidate.totalUsageBytes / candidate.hardCapBytes > current.totalUsageBytes / current.hardCapBytes
			? candidate
			: current,
	);
	return {
		...selected,
		parentBytes,
		domains,
	};
}

async function sampleMemoryPressure(): Promise<MemoryPressureSnapshot> {
	const parentBytes = process.memoryUsage().rss;
	const hostBytes = os.totalmem();
	if (process.platform === "linux") {
		const cgroup = await sampleLinuxCgroupMemory(hostBytes, parentBytes);
		if (cgroup) return cgroup;
	}
	if (process.platform === "win32") {
		const job = sampleWindowsJobMemory(hostBytes, parentBytes);
		if (job) return job;
	}
	return { hardCapBytes: hostBytes, totalUsageBytes: parentBytes, parentBytes, source: "host" };
}

export function __selectMemoryPressureDomainForTest(
	snapshot: MemoryPressureSnapshot,
	policyLimitBytes: number | null,
): MemoryPressureSnapshot {
	const domains = snapshot.domains;
	if (!domains || domains.length === 0) return snapshot;
	const selected = domains.reduce((current, domain) => {
		const currentLimit = Math.min(current.hardCapBytes, policyLimitBytes ?? current.hardCapBytes);
		const domainLimit = Math.min(domain.hardCapBytes, policyLimitBytes ?? domain.hardCapBytes);
		return domain.totalUsageBytes / domainLimit > current.totalUsageBytes / currentLimit ? domain : current;
	});
	return {
		...snapshot,
		...selected,
		totalUsageBytes: Math.max(snapshot.parentBytes, selected.totalUsageBytes),
	};
}

function sweepMemoryPressureGuard(d: ResourceGcDeps): Promise<void> | undefined {
	let enabled = false;
	for (const [sessionId, { settings }] of activeSessions) {
		if (resolveMemoryGuardPolicy(settings).enabled) {
			enabled = true;
			continue;
		}
		memoryGuardGcActive.delete(sessionId);
		memoryGuardRestartAboveSince.delete(sessionId);
		memoryGuardLastEvaluatedAt.delete(sessionId);
	}
	if (!enabled) return undefined;
	return sweepEnabledMemoryPressureGuard(d);
}
async function sweepEnabledMemoryPressureGuard(d: ResourceGcDeps): Promise<void> {
	const now = d.monotonicNow();
	const dueSessions: Array<{ sessionId: string; policy: MemoryGuardPolicy; cwd: string; generation: symbol }> = [];
	for (const [sessionId, { settings, cwd: resolveCwd, memoryGuardGeneration }] of activeSessions) {
		const policy = resolveMemoryGuardPolicy(settings);
		const cwd = resolveCwd();
		if (!policy.enabled) {
			memoryGuardGcActive.delete(sessionId);
			memoryGuardRestartAboveSince.delete(sessionId);
			memoryGuardLastEvaluatedAt.delete(sessionId);
			continue;
		}
		const lastEvaluated = memoryGuardLastEvaluatedAt.get(sessionId);
		if (lastEvaluated !== undefined && now - lastEvaluated < policy.checkIntervalMs) continue;
		memoryGuardLastEvaluatedAt.set(sessionId, now);
		dueSessions.push({ sessionId, policy, cwd, generation: memoryGuardGeneration });
	}
	if (dueSessions.length === 0) return;

	const snapshot = await d.memorySnapshot();
	let gcRequested = false;
	const gcTelemetry: Array<{ sessionId: string; generation: symbol } & Record<string, unknown>> = [];
	for (const { sessionId, policy, generation } of dueSessions) {
		if (activeSessions.get(sessionId)?.memoryGuardGeneration !== generation) continue;
		const pressure = __selectMemoryPressureDomainForTest(snapshot, policy.policyLimitBytes);
		const limit = resolveEffectiveMemoryLimit({
			hardCapBytes: pressure.hardCapBytes,
			policyLimitBytes: policy.policyLimitBytes,
		});
		if (limit.effectiveBytes === null) {
			memoryGuardGcActive.delete(sessionId);
			memoryGuardRestartAboveSince.delete(sessionId);
			memoryGuardLastEvaluatedAt.delete(sessionId);
			continue;
		}
		const domain = computeMemoryGuardDomain({
			effectiveLimitBytes: limit.effectiveBytes,
			totalUsageBytes: pressure.totalUsageBytes,
			parentBytes: pressure.parentBytes,
			parentReserveBytes: policy.parentReserveBytes,
			workers: [],
		});
		const decision = chooseMemoryGuardAction({
			domain,
			hostSupported: false,
			workerSupported: () => false,
		});
		const usageRatio = pressure.totalUsageBytes / limit.effectiveBytes;
		if (usageRatio >= policy.gcThresholdRatio) {
			if (!memoryGuardGcActive.has(sessionId)) {
				gcRequested = true;
				gcTelemetry.push({
					sessionId,
					generation,
					parentBytes: pressure.parentBytes,
					totalUsageBytes: pressure.totalUsageBytes,
					effectiveLimitBytes: limit.effectiveBytes,
					domainSource: pressure.source,
					limitSource: limit.source,
					usageRatio,
					decision: decision.kind,
				});
			}
		} else {
			memoryGuardGcActive.delete(sessionId);
		}

		if (usageRatio < policy.restartThresholdRatio) {
			memoryGuardRestartAboveSince.delete(sessionId);
			continue;
		}
		const aboveSince = memoryGuardRestartAboveSince.get(sessionId);
		if (aboveSince === undefined) {
			memoryGuardRestartAboveSince.set(sessionId, now);
			continue;
		}
		if (now - aboveSince < policy.restartThresholdWindowMs) continue;
		d.logWarn("Memory guard: restart threshold sustained", {
			sessionId,
			parentBytes: pressure.parentBytes,
			totalUsageBytes: pressure.totalUsageBytes,
			effectiveLimitBytes: limit.effectiveBytes,
			domainSource: pressure.source,
			limitSource: limit.source,
			usageRatio,
			windowMs: policy.restartThresholdWindowMs,
			cooldownMs: policy.cooldownMs,
			decision: decision.kind,
		});
	}
	if (gcRequested) {
		try {
			d.runGc();
			for (const { sessionId, generation, ...telemetry } of gcTelemetry) {
				if (activeSessions.get(sessionId)?.memoryGuardGeneration !== generation) continue;
				memoryGuardGcActive.add(sessionId);
				d.logWarn("Memory guard: GC threshold reached", { sessionId, ...telemetry });
			}
		} catch (error) {
			d.logWarn("Memory guard: GC invocation failed; latch not set", { error: String(error) });
		}
	}
}

function ownerBrowserPolicy(snapshot: TabGcSnapshot): BrowserGcPolicy | null {
	if (!snapshot.ownerId) return null;
	const registration = activeSessions.get(snapshot.ownerId);
	if (!registration) return null;
	return resolveBrowserGcPolicy(registration.settings);
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
	for (const [sessionId, { settings }] of activeSessions) {
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
	for (const { settings } of activeSessions.values()) {
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
	deps = {
		...defaultDeps,
		...overrides,
		monotonicNow: overrides.monotonicNow ?? overrides.now ?? defaultDeps.monotonicNow,
	};
}

export function __setResourceGcSchedulerNowForTest(now: () => number): void {
	scheduler.setSchedulerNowForTest(now);
}

export async function __runResourceGcTickForTest(): Promise<void> {
	await scheduler.runTick();
}

export async function __runResourceGcTimerCallbackForTest(
	owner: { generation: number; token: number },
	deadline: number,
): Promise<void> {
	await scheduler.runTimerCallbackForTest(owner, deadline);
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
	const state = scheduler.getStateForTest();
	return {
		timerActive: state.timerActive,
		sessionCount: activeSessions.size,
		rssWarningActive,
		inProgress: state.inProgress,
		generation: state.generation,
		pendingDeadline: state.pendingDeadline,
		pendingOwner: state.pendingOwner,
		deferredDeadline: state.deferredDeadline,
		deferredGeneration: state.deferredGeneration,
		activeGeneration: state.activeGeneration,
	};
}

export function __resetResourceGcForTest(): void {
	scheduler.resetForTest();
	activeSessions.clear();
	rssWarningActive = false;
	memoryGuardGcActive.clear();
	memoryGuardRestartAboveSince.clear();
	memoryGuardLastEvaluatedAt.clear();
	lastScreenshotScanAt = 0;
	deps = defaultDeps;
}
