/**
 * `gjc gc` runtime — a global, liveness-only, dry-run-by-default garbage
 * collector for stale GJC session/PID records.
 *
 * Design (see .gjc/plans/ralplan/2026-06-13-1347-954f/pending-approval.md):
 * - This module is an ORCHESTRATOR only. It owns the shared PID probe, the
 *   report/exit-code policy, and text/JSON rendering. It must NOT parse private
 *   store layouts directly; every store is reached through an injectable
 *   `GcStoreAdapter` that lives next to its store owner.
 * - Liveness-only and fail-closed: only `ESRCH` (no such process) is `dead`
 *   (removable). `process.kill(pid, 0)` success, `EPERM`, and any unknown probe
 *   error all mean KEEP — a live process is never signalled or killed.
 * - Dry-run by default: nothing is deleted unless `--prune`/`--force`.
 */

import type { BigIntStats, Dirent, Stats } from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { exactRemoveDirectoryTree, exactUnlink, snapshotDirectoryTree } from "@gajae-code/natives";
import { getAgentDir, getBlobsDir, getSessionsDir, isEnoent, VERSION } from "@gajae-code/utils";
import { getDefault } from "../config/settings-schema";
import { listHarnessRootRegistriesForGc } from "../harness-control-plane/storage";
import { SessionIndex } from "../sdk/broker/session-index";
import { UnsupportedStateVersionError } from "../sdk/broker/state-version";
import {
	BLOB_REFERENCE_MAX_LENGTH,
	type CanonicalBlobEntry,
	collectBlobReferences,
	listCanonicalBlobs,
	removeCanonicalBlob,
} from "../session/blob-store";
import { FileSessionStorage, probeSessionRetirement, retireSessionTranscript } from "../session/session-storage";

import { buildGcReportText } from "./gc-render";
import { type EmptyDeleteGcReport, runEmptyDeleteGc } from "./empty-delete-gc";
import { collectSessionScopeUsage, type GcSessionScopeUsage, shouldReportSessionScope } from "./gc-session-scope";

export type GcStore = "harness_leases" | "file_locks" | "tmux_sessions" | "registry_entries" | "local_roots";

export const GC_STORES: readonly GcStore[] = [
	"harness_leases",
	"file_locks",
	"tmux_sessions",
	"registry_entries",
	"local_roots",
] as const;

/** Why a probed pid is kept instead of treated as dead. */
export type GcPidKeepReason = "alive" | "eperm" | "unknown";

export interface GcPidProbeResult {
	/** `dead` only on ESRCH; `keep` for alive/eperm/unknown (fail-closed). */
	status: "dead" | "keep";
	reason?: GcPidKeepReason;
	error?: string;
}

/** Single shared liveness contract threaded through every classifier + prune path. */
export type GcPidProbe = (pid: number) => GcPidProbeResult;

export type GcPidStatus = "dead" | "alive" | "eperm" | "unknown" | "none";

export type GcAction = "none" | "would_remove" | "removed" | "remove_failed" | "skipped";

export interface GcRecord {
	store: GcStore;
	/** Stable identifier: session id, lock dir path, worker id, tmux name, registry session id. */
	id: string;
	path?: string;
	root?: string;
	pid?: number;
	pid_status?: GcPidStatus;
	/** Store-specific classification label (e.g. "dead", "live", "unclassified", "terminal_lifecycle"). */
	status: string;
	stale: boolean;
	removable: boolean;
	action: GcAction;
	reason: string;
	detail?: string;
	error?: string;
	removed?: boolean;
}

export interface GcError {
	store: GcStore;
	scope: string;
	message: string;
}

/** Non-fatal discovery partials (e.g. traversal caps). Does not affect exit code. */
export interface GcWarning {
	store: GcStore;
	scope: string;
	message: string;
}

export interface GcCollectResult {
	records: GcRecord[];
	errors: GcError[];
	/** Optional partial-result notices; omitted by adapters that have none. */
	warnings?: GcWarning[];
}

export interface GcPruneOutcome {
	removed: boolean;
	error?: string;
	/** Set when a removable record was skipped at prune time (e.g. TOCTOU became live). */
	skipped?: string;
}

export interface GcContext {
	probe: GcPidProbe;
	force: boolean;
	env: NodeJS.ProcessEnv;
	cwd: string;
}

/**
 * A store-owned GC adapter. `collect` discovers + classifies (using the shared
 * probe) without mutating anything. `prune` removes a single record, and MUST
 * re-validate / re-probe immediately before any destructive action.
 */
export interface GcStoreAdapter {
	store: GcStore;
	collect(ctx: GcContext): Promise<GcCollectResult>;
	prune(record: GcRecord, ctx: GcContext): Promise<GcPruneOutcome>;
}

export interface GcCounts {
	discovered: number;
	stale: number;
	alive: number;
	eperm: number;
	unknown: number;
	terminal_lifecycle: number;
	unclassified: number;
	would_remove: number;
	removed: number;
	failed: number;
	errors: number;
	by_store: Record<
		GcStore,
		{ discovered: number; stale: number; would_remove: number; removed: number; failed: number }
	>;
}

export interface GcSessionIndexHealth {
	status: "healthy" | "corrupt" | "repaired" | "unsupported" | "repair_failed";
	valid_prefix_seq: number;
	snapshot_seq?: number;
	reason?: string;
	quarantine_path?: string;
}

export interface GcReport {
	dry_run: boolean;
	operation?: "dry_run" | "prune" | "repair_session_index";
	stores: Record<GcStore, GcRecord[]>;
	counts: GcCounts;
	errors: GcError[];
	/** Partial-result notices that do not fail the run (e.g. walk caps). */
	warnings: GcWarning[];
	session_index?: GcSessionIndexHealth;
	/** Managed-scope capacity, reported only when it is near or past the budget. */
	session_scope?: GcSessionScopeUsage;
	/**
	 * Disk-retention findings. Present only when `--disk` was passed; the
	 * PID-liveness axis above is unchanged by its absence or presence.
	 */
	disk?: GcDiskReport;
	empty_delete_receipts?: EmptyDeleteGcReport;
}

export interface GcRunResult {
	stdout: string;
	stderr: string;
	status: number;
}

/**
 * The shared, fail-closed PID probe. ESRCH => dead/removable; success => alive;
 * EPERM => kept (owned by another user); any other error => kept as unknown.
 */
export const gcPidProbe: GcPidProbe = (pid: number): GcPidProbeResult => {
	if (!Number.isInteger(pid) || pid <= 0) {
		return { status: "keep", reason: "unknown", error: `invalid_pid:${pid}` };
	}
	try {
		process.kill(pid, 0);
		return { status: "keep", reason: "alive" };
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ESRCH") return { status: "dead" };
		if (code === "EPERM") return { status: "keep", reason: "eperm" };
		return { status: "keep", reason: "unknown", error: code ?? String(error) };
	}
};

/** Map a `GcPidProbe` onto the harness lease probe shape (`"alive"|"dead"|"eperm"`). */
export function gcProbeToLeasePidStatus(probe: GcPidProbe): (pid: number) => "alive" | "dead" | "eperm" {
	return (pid: number) => {
		const result = probe(pid);
		if (result.status === "dead") return "dead";
		// EPERM stays eperm; unknown maps to alive so classifyLeaseStatus keeps it.
		return result.reason === "eperm" ? "eperm" : "alive";
	};
}

/** Translate a probe result into a record-friendly pid status label. */
export function gcPidStatusLabel(result: GcPidProbeResult): Exclude<GcPidStatus, "none"> {
	if (result.status === "dead") return "dead";
	return result.reason ?? "alive";
}

function emptyByStore(): GcCounts["by_store"] {
	const by = {} as GcCounts["by_store"];
	for (const store of GC_STORES) {
		by[store] = { discovered: 0, stale: 0, would_remove: 0, removed: 0, failed: 0 };
	}
	return by;
}

function emptyStores(): Record<GcStore, GcRecord[]> {
	const stores = {} as Record<GcStore, GcRecord[]>;
	for (const store of GC_STORES) stores[store] = [];
	return stores;
}

function computeCounts(stores: Record<GcStore, GcRecord[]>, errors: GcError[]): GcCounts {
	const counts: GcCounts = {
		discovered: 0,
		stale: 0,
		alive: 0,
		eperm: 0,
		unknown: 0,
		terminal_lifecycle: 0,
		unclassified: 0,
		would_remove: 0,
		removed: 0,
		failed: 0,
		errors: errors.length,
		by_store: emptyByStore(),
	};
	for (const store of GC_STORES) {
		for (const record of stores[store]) {
			counts.discovered++;
			counts.by_store[store].discovered++;
			if (record.stale) {
				counts.stale++;
				counts.by_store[store].stale++;
			}
			if (record.pid_status === "alive") counts.alive++;
			else if (record.pid_status === "eperm") counts.eperm++;
			else if (record.pid_status === "unknown") counts.unknown++;
			if (record.status === "terminal_lifecycle") counts.terminal_lifecycle++;
			if (record.status === "unclassified") counts.unclassified++;
			if (record.action === "would_remove") {
				counts.would_remove++;
				counts.by_store[store].would_remove++;
			}
			if (record.action === "removed") {
				counts.removed++;
				counts.by_store[store].removed++;
			}
			if (record.action === "remove_failed") {
				counts.failed++;
				counts.by_store[store].failed++;
			}
		}
	}
	return counts;
}

interface ParsedGcArgs {
	json: boolean;
	prune: boolean;
	repairSessionIndex: boolean;
	disk: boolean;
	help: boolean;
	emptyDeleteReceipts: boolean;
	emptyDeleteRoots: string[];
	emptyDeleteManifest?: string;
}

class GcUsageError extends Error {}

function parseGcArgs(argv: string[]): ParsedGcArgs {
	let json = false;
	let prune = false;
	let repairSessionIndex = false;
	let disk = false;
	let dryRun = false;
	let help = false;
	let emptyDeleteReceipts = false;
	const emptyDeleteRoots: string[] = [];
	let emptyDeleteManifest: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		switch (arg) {
			case "--json":
			case "-j":
				json = true;
				break;
			case "--prune":
			case "--force":
				prune = true;
				break;
			case "--repair-session-index":
				repairSessionIndex = true;
				break;
			case "--disk":
				disk = true;
				break;
			case "--dry-run":
				dryRun = true;
				break;
			case "--help":
			case "-h":
				help = true;
				break;
			case "--empty-delete-receipts":
				emptyDeleteReceipts = true;
				break;
			case "--root": {
				const value = argv[++i];
				if (!value) throw new GcUsageError("missing_root");
				emptyDeleteRoots.push(value);
				break;
			}
			case "--manifest": {
				const value = argv[++i];
				if (!value) throw new GcUsageError("missing_manifest");
				emptyDeleteManifest = value;
				break;
			}
			default:
				throw new GcUsageError(`unknown_flag:${arg}`);
		}
	}
	if (repairSessionIndex && prune) throw new GcUsageError("repair_session_index_cannot_combine_with_prune");
	if (repairSessionIndex && dryRun) throw new GcUsageError("repair_session_index_cannot_combine_with_dry_run");
	if (dryRun) prune = false;
	return { json, prune, repairSessionIndex, disk, help, emptyDeleteReceipts, emptyDeleteRoots, emptyDeleteManifest };
}

/**
 * Collect every store's records (catching hard discovery errors per adapter),
 * then optionally prune removable records with per-record revalidation.
 */
export async function collectGcReport(adapters: GcStoreAdapter[], ctx: GcContext, prune: boolean): Promise<GcReport> {
	const stores = emptyStores();
	const errors: GcError[] = [];
	const warnings: GcWarning[] = [];

	for (const adapter of adapters) {
		try {
			const result = await adapter.collect(ctx);
			stores[adapter.store].push(...result.records);
			errors.push(...result.errors);
			if (result.warnings) warnings.push(...result.warnings);
		} catch (error) {
			errors.push({
				store: adapter.store,
				scope: "collect",
				message: error instanceof Error ? error.message : String(error),
			});
		}
	}

	// Mark dry-run intent on every removable record before pruning.
	for (const store of GC_STORES) {
		for (const record of stores[store]) {
			if (record.removable) record.action = "would_remove";
		}
	}

	if (prune) {
		const adapterByStore = new Map(adapters.map(a => [a.store, a] as const));
		for (const store of GC_STORES) {
			const adapter = adapterByStore.get(store);
			if (!adapter) continue;
			for (const record of stores[store]) {
				if (!record.removable) continue;
				try {
					const outcome = await adapter.prune(record, ctx);
					if (outcome.removed) {
						record.action = "removed";
						record.removed = true;
					} else if (outcome.skipped) {
						record.action = "skipped";
						record.reason = outcome.skipped;
						record.removed = false;
					} else {
						record.action = "remove_failed";
						record.removed = false;
						record.error = outcome.error ?? "remove_failed";
					}
				} catch (error) {
					record.action = "remove_failed";
					record.removed = false;
					record.error = error instanceof Error ? error.message : String(error);
				}
			}
		}
	}

	return { dry_run: !prune, stores, counts: computeCounts(stores, errors), errors, warnings };
}

/**
 * Exit-code policy:
 * - usage/parse error => 2
 * - hard discovery errors => 1 (both modes)
 * - prune mode with a failed intended removal => 1
 * - warnings alone never fail the run
 * - otherwise => 0
 *
 * The disk axis reuses the same policy against its own errors/failures, and is
 * inert when `--disk` was not passed (`report.disk` is then undefined). A
 * fail-closed KEEP is never a failure — only a hard scan error or a reclaim
 * that was attempted and threw.
 */
export function computeExitCode(report: GcReport): number {
	if (report.errors.length > 0) return 1;
	if (!report.dry_run && report.counts.failed > 0) return 1;
	if (report.disk) {
		if (report.disk.errors.length > 0) return 1;
		if (!report.disk.dry_run && report.disk.totals.failed > 0) return 1;
	}
	return 0;
}

function resolveGcAgentDir(env: NodeJS.ProcessEnv): string {
	return env.GJC_CODING_AGENT_DIR?.trim() || env.PI_CODING_AGENT_DIR?.trim() || getAgentDir();
}

/**
 * Locate and measure the managed scope for `cwd`.
 *
 * Resolution is read-only (it never prepares or writes a scope), and any
 * failure yields `undefined` so a capacity probe cannot fail a gc run.
 */
async function collectGcSessionScope(cwd: string, agentDir: string): Promise<GcSessionScopeUsage | undefined> {
	try {
		const { resolveManagedScope } = await import("../session/internal/managed-session-scope");
		const { getSessionsDir } = await import("@gajae-code/utils");
		const resolved = resolveManagedScope({ cwd, agentDir, sessionsRoot: getSessionsDir(agentDir) });
		if (resolved.kind !== "resolved") return undefined;
		return await collectSessionScopeUsage(resolved.scope.directoryPath);
	} catch {
		return undefined;
	}
}

async function collectSessionIndexHealth(repair: boolean, agentDir: string): Promise<GcSessionIndexHealth> {
	const index = new SessionIndex(agentDir);
	try {
		if (repair) {
			const result = await index.repair();
			return {
				status: result.status === "unsupported" ? "unsupported" : result.repaired ? "repaired" : "healthy",
				valid_prefix_seq: result.validPrefixSeq,
				snapshot_seq: result.snapshotSeq,
				...(result.reason ? { reason: result.reason } : {}),
				...(result.quarantinePath ? { quarantine_path: result.quarantinePath } : {}),
			};
		}
		const diagnosis = await index.diagnose();
		return {
			status: diagnosis.status,
			valid_prefix_seq: diagnosis.validPrefixSeq,
			snapshot_seq: diagnosis.snapshotSeq,
			...(diagnosis.reason ? { reason: diagnosis.reason } : {}),
		};
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return {
			status: error instanceof UnsupportedStateVersionError ? "unsupported" : "repair_failed",
			valid_prefix_seq: 0,
			reason,
		};
	}
}

export async function runGjcGcCommand(
	argv: string[],
	cwd: string = process.cwd(),
	env: NodeJS.ProcessEnv = process.env,
	adapters?: GcStoreAdapter[],
	diskPolicy?: Partial<GcDiskPolicy>,
): Promise<GcRunResult> {
	let parsed: ParsedGcArgs;
	try {
		parsed = parseGcArgs(argv);
	} catch (error) {
		const message = error instanceof GcUsageError ? error.message : String(error);
		return { stdout: "", stderr: `gjc gc: ${message}\n`, status: 2 };
	}

	if (parsed.help) {
		return { stdout: gcHelpText(), stderr: "", status: 0 };
	}

	const resolvedAdapters = adapters ?? (await defaultGcAdapters());
	const ctx: GcContext = { probe: gcPidProbe, force: parsed.prune, env, cwd };
	const report = await collectGcReport(resolvedAdapters, ctx, parsed.prune);
	report.operation = parsed.repairSessionIndex ? "repair_session_index" : parsed.prune ? "prune" : "dry_run";
	report.session_index = await collectSessionIndexHealth(parsed.repairSessionIndex, resolveGcAgentDir(env));
	if (parsed.disk) {
		report.disk = await collectGcDiskReport({
			agentDir: resolveGcAgentDir(env),
			env,
			policy: resolveGcDiskPolicy(diskPolicy),
			prune: parsed.prune,
		});
	}
	if (parsed.emptyDeleteReceipts) {
		const roots = [...parsed.emptyDeleteRoots];
		if (parsed.emptyDeleteManifest) {
			const raw = await fsp.readFile(parsed.emptyDeleteManifest, "utf8");
			const parsedManifest = JSON.parse(raw) as { roots?: unknown };
			if (!Array.isArray(parsedManifest.roots)) {
				return { stdout: "", stderr: "gjc gc: manifest_roots_required\n", status: 2 };
			}
			for (const root of parsedManifest.roots) {
				if (typeof root !== "string" || root.length === 0) {
					return { stdout: "", stderr: "gjc gc: manifest_root_invalid\n", status: 2 };
				}
				roots.push(root);
			}
		}
		if (roots.length === 0) {
			return { stdout: "", stderr: "gjc gc: empty_delete_receipts_requires_root_or_manifest\n", status: 2 };
		}
		report.empty_delete_receipts = await runEmptyDeleteGc({ roots, prune: parsed.prune });
	}
	const scopeUsage = await collectGcSessionScope(cwd, resolveGcAgentDir(env));
	if (scopeUsage && shouldReportSessionScope(scopeUsage)) report.session_scope = scopeUsage;
	const sessionIndexFailed =
		report.session_index?.status === "corrupt" ||
		report.session_index?.status === "unsupported" ||
		report.session_index?.status === "repair_failed";
	const status = sessionIndexFailed ? 1 : computeExitCode(report);
	const stdout = parsed.json
		? `${JSON.stringify(report, null, 2)}\n`
		: `${buildGcReportText(report)}${report.disk ? buildGcDiskReportText(report.disk) : ""}`;
	return { stdout, stderr: "", status };
}

export function gcHelpText(): string {
	return [
		"gjc gc - garbage-collect stale GJC session/PID records",
		"",
		"USAGE",
		"  $ gjc gc [--prune|--force] [--disk] [--repair-session-index] [--empty-delete-receipts --root <dir>] [--json]",

		"",
		"FLAGS",
		"  --prune, --force  Actually remove stale records (default: dry-run report only)",
		"  --dry-run         Force report-only mode (overrides --prune/--force)",
		"  -j, --json        Emit machine-readable JSON",
		"  --repair-session-index  Explicitly quarantine a corrupt session-index suffix and retain its valid prefix",
		"  --disk            Also report on-disk retention (sessions, blobs, artifacts, natives, backups)",
		"  --empty-delete-receipts  Report/prune empty .gjc-delete-* under --root / --manifest",
		"  --root <dir>      Operand root for --empty-delete-receipts (repeatable)",
		"  --manifest <file> JSON {\"roots\":[...]} for --empty-delete-receipts",
		"",
		"Liveness-only: a record is removed only when its owning process is dead",
		"(ESRCH). Live / permission-denied / unknown processes are always kept.",
		"",
		"Disk retention (--disk) is a separate, opt-in axis. Without --prune it only",
		"reports reclaimable bytes per surface. Live, referenced, permission-denied or",
		"otherwise ambiguous state is always KEPT and the report says why. Session tool",
		"artifacts (`*.<tool>.log`, `.artifact-id-*`, evicted output) are reported per",
		"family. Managed worktrees under ~/.gjc/wt are never touched.",
		"",
	].join("\n");
}

/** Lazily assemble the real store adapters (kept lazy to avoid import cycles). */
export async function defaultGcAdapters(): Promise<GcStoreAdapter[]> {
	const [
		{ harnessLeasesGcAdapter, registryEntriesGcAdapter },
		{ fileLocksGcAdapter },
		{ tmuxSessionsGcAdapter },
		{ localRootsGcAdapter },
	] = await Promise.all([
		import("../harness-control-plane/gc-adapter"),
		import("../config/file-lock-gc"),
		import("./tmux-gc"),
		import("../internal-urls/local-root-gc"),
	]);
	return [
		harnessLeasesGcAdapter,
		fileLocksGcAdapter,
		tmuxSessionsGcAdapter,
		registryEntriesGcAdapter,
		localRootsGcAdapter,
	];
}

// =============================================================================
// Disk-retention axis (`gjc gc --disk`)
// =============================================================================
//
// A second, explicitly opt-in axis. The PID-liveness axis above answers "is the
// owner of this record dead?"; this one answers "are these bytes still reachable
// from anything live?". Both share the same posture: dry-run by default, and
// anything live, referenced, permission-denied, unreadable or ambiguous is KEPT
// with the reason recorded in the report.
//
// Deliberately out of scope: `~/.gjc/wt` managed worktrees. Removing a worktree
// needs evidence-based merge detection, which this axis does not have.

/** On-disk surfaces the retention axis can reclaim. */
export type GcDiskSurface = "sessions" | "blobs" | "artifacts" | "natives" | "backups";

export const GC_DISK_SURFACES: readonly GcDiskSurface[] = [
	"sessions",
	"blobs",
	"artifacts",
	"natives",
	"backups",
] as const;

export type GcDiskAction = "keep" | "would_reclaim" | "reclaimed" | "reclaim_failed";

export interface GcDiskRecord {
	surface: GcDiskSurface;
	/** Session id, blob hash, `<session id>/<filename>` artifact, natives version, or backup entry name. */
	id: string;
	path: string;
	bytes: number;
	age_days: number;
	action: GcDiskAction;
	reason: string;
	error?: string;
	/** Set when `bytes` is a floor because a walk was capped or partially unreadable. */
	partial?: true;
	/** Set when this entry was a reclaim candidate that its surface withheld on incomplete evidence. */
	withheld?: true;
}

/**
 * Per-family rollup of a surface whose growth is many small files.
 *
 * The artifacts surface writes one record per file, which answers "what may go"
 * but not "what filled the scope". A family is derived from the filename shape
 * (`*.bash.log`, `.artifact-id-*`, …) rather than a fixed list, so a tool that
 * starts writing a new kind of log is counted the day it ships.
 */
export interface GcDiskFamilyUsage {
	family: string;
	count: number;
	bytes: number;
}

/**
 * Why a surface withheld reclaim candidates because its evidence was incomplete.
 */
export interface GcDiskDeclined {
	reason: string;
	withheld: number;
	withheld_bytes: number;
}

export interface GcDiskSurfaceReport {
	surface: GcDiskSurface;
	root: string;
	scanned: number;
	scanned_bytes: number;
	reclaimable: number;
	reclaimable_bytes: number;
	reclaimed: number;
	reclaimed_bytes: number;
	kept: number;
	kept_bytes: number;
	failed: number;
	/** Set when the surface withheld reclaim candidates because its evidence was incomplete. */
	declined?: GcDiskDeclined;
	/** Per-family counts and bytes. Only surfaces whose records are individual files set this. */
	families?: GcDiskFamilyUsage[];
	records: GcDiskRecord[];
}

export interface GcDiskError {
	surface: GcDiskSurface;
	scope: string;
	message: string;
}

/** Retention policy, mirroring the `gc.*` settings one-for-one. */
export interface GcDiskPolicy {
	sessions_max_age_days: number;
	/** 0 disables the size axis; only the age axis retires transcripts then. */
	sessions_max_total_bytes: number;
	natives_keep_versions: number;
	backups_max_age_days: number;
}

export interface GcDiskReport {
	dry_run: boolean;
	policy: GcDiskPolicy;
	surfaces: Record<GcDiskSurface, GcDiskSurfaceReport>;
	totals: {
		scanned_bytes: number;
		reclaimable_bytes: number;
		reclaimed_bytes: number;
		kept_bytes: number;
		failed: number;
	};
	errors: GcDiskError[];
}

const GC_DISK_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A blob younger than this is never swept: a live session may have written the
 * bytes but not yet appended the entry that references them.
 */
const GC_DISK_BLOB_GRACE_MS = GC_DISK_DAY_MS;

/**
 * How many extra times the blob mark may re-absorb transcripts that appeared or
 * grew while it was running. Ordinary concurrent session activity settles in one
 * extra round; a store that still will not settle is not evidence anyone can
 * sweep on, so the sweep withholds instead.
 */
const GC_DISK_MARK_REMARK_ROUNDS = 2;
/**
 * How long the store must be observed completely quiet before the sweep may
 * remove anything. The mark rounds and their drift checks can each complete
 * inside an inter-append gap of a live session, so a single clean observation
 * is not evidence of quiescence: the sweep brackets its decision with a probe
 * that spans this window, which is far larger than any realistic gap between
 * two transcript appends. A store that still moves inside the window withholds
 * the sweep with `sessions_changed_during_mark` instead of reclaiming on
 * evidence it could not prove stable.
 */
const GC_DISK_MARK_QUIESCENCE_MS = 50;

/** Bound every recursive size walk so a pathological tree cannot stall `gjc gc`. */
const GC_DISK_MAX_WALK_ENTRIES = 200_000;

/** Cap per-surface record rendering; the JSON output always carries every record. */
const GC_DISK_MAX_RENDERED_RECORDS = 20;

/** Schema-backed defaults, so the CLI and the settings surface cannot drift. */
export const GC_DISK_POLICY_DEFAULTS: GcDiskPolicy = {
	sessions_max_age_days: getDefault("gc.sessions.maxAgeDays"),
	sessions_max_total_bytes: getDefault("gc.sessions.maxTotalBytes"),
	natives_keep_versions: getDefault("gc.natives.keepVersions"),
	backups_max_age_days: getDefault("gc.backups.maxAgeDays"),
};

export function resolveGcDiskPolicy(overrides: Partial<GcDiskPolicy> = {}): GcDiskPolicy {
	return {
		sessions_max_age_days: overrides.sessions_max_age_days ?? GC_DISK_POLICY_DEFAULTS.sessions_max_age_days,
		sessions_max_total_bytes: overrides.sessions_max_total_bytes ?? GC_DISK_POLICY_DEFAULTS.sessions_max_total_bytes,
		natives_keep_versions: overrides.natives_keep_versions ?? GC_DISK_POLICY_DEFAULTS.natives_keep_versions,
		backups_max_age_days: overrides.backups_max_age_days ?? GC_DISK_POLICY_DEFAULTS.backups_max_age_days,
	};
}

function gcDiskErrorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function gcDiskAgeDays(now: number, mtimeMs: number): number {
	return Math.round(((now - mtimeMs) / GC_DISK_DAY_MS) * 100) / 100;
}

function emptyGcDiskSurface(surface: GcDiskSurface, root: string): GcDiskSurfaceReport {
	return {
		surface,
		root,
		scanned: 0,
		scanned_bytes: 0,
		reclaimable: 0,
		reclaimable_bytes: 0,
		reclaimed: 0,
		reclaimed_bytes: 0,
		kept: 0,
		kept_bytes: 0,
		failed: 0,
		records: [],
	};
}

function summarizeGcDiskSurface(report: GcDiskSurfaceReport): void {
	report.scanned = report.records.length;
	report.scanned_bytes = 0;
	report.reclaimable = 0;
	report.reclaimable_bytes = 0;
	report.reclaimed = 0;
	report.reclaimed_bytes = 0;
	report.kept = 0;
	report.kept_bytes = 0;
	report.failed = 0;
	for (const record of report.records) {
		report.scanned_bytes += record.bytes;
		switch (record.action) {
			case "would_reclaim":
				report.reclaimable++;
				report.reclaimable_bytes += record.bytes;
				break;
			case "reclaimed":
				report.reclaimed++;
				report.reclaimed_bytes += record.bytes;
				break;
			case "reclaim_failed":
				report.failed++;
				report.kept_bytes += record.bytes;
				break;
			default:
				report.kept++;
				report.kept_bytes += record.bytes;
		}
	}
}

/**
 * Recursive, bounded byte count. Symlinks are never followed and never counted.
 *
 * `partial` means `bytes` is only a floor. `unreadable` is the narrower, harder
 * fact: some entry in the tree could not be enumerated or stat'd, so the walk is
 * blind to part of what it just measured. A caller about to remove the tree must
 * treat that as incomplete evidence — a recursive remove cannot finish past an
 * unreadable entry, so it would destroy the readable half and leave the rest.
 *
 * An entry that vanished mid-walk (`ENOENT`) is the opposite fact: it is gone,
 * not withheld. A vanished entry cannot block a recursive remove, so it only
 * makes `bytes` a floor and never withholds the tree.
 *
 * The walk is bounded in sizing work, not in reach: past
 * {@link GC_DISK_MAX_WALK_ENTRIES} it stops stat'ing files but keeps opening
 * directories, so a huge but perfectly readable tree stays reclaimable instead
 * of being reported as unreadable.
 */
async function measureGcDiskTree(root: string): Promise<{ bytes: number; partial: boolean; unreadable: boolean }> {
	let bytes = 0;
	let visited = 0;
	let partial = false;
	let unreadable = false;
	const stack: string[] = [root];
	while (stack.length > 0) {
		const dir = stack.pop()!;
		let entries: Dirent[];
		try {
			entries = await fsp.readdir(dir, { withFileTypes: true });
		} catch (error) {
			if (!isEnoent(error)) {
				partial = true;
				unreadable = true;
			}
			continue;
		}
		for (const entry of entries) {
			visited++;
			const child = path.join(dir, entry.name);
			if (entry.isSymbolicLink()) {
				partial = true;
				continue;
			}
			if (entry.isDirectory()) {
				stack.push(child);
				continue;
			}
			if (!entry.isFile()) continue;
			// The entry cap bounds the per-file `lstat` work, not the enumeration:
			// past it `bytes` is a floor, but every directory is still opened so
			// `unreadable` stays a complete answer for the whole tree.
			if (visited > GC_DISK_MAX_WALK_ENTRIES) {
				partial = true;
				continue;
			}
			try {
				bytes += (await fsp.lstat(child)).size;
			} catch (error) {
				partial = true;
				if (!isEnoent(error)) unreadable = true;
			}
		}
	}
	return { bytes, partial, unreadable };
}

/**
 * Session ids reachable from a live surface. `complete: false` means at least
 * one reference source could not be enumerated, in which case NO session may be
 * retired — an unproven reference is treated as a live one.
 */
interface GcSessionReferences {
	ids: Set<string>;
	complete: boolean;
	notes: string[];
}

async function collectGcSessionReferences(agentDir: string, env: NodeJS.ProcessEnv): Promise<GcSessionReferences> {
	const ids = new Set<string>();
	const notes: string[] = [];
	let complete = true;
	const incomplete = (note: string): void => {
		complete = false;
		if (!notes.includes(note)) notes.push(note);
	};

	// 1. Harness root registries and every per-session lease directory beneath
	//    their roots. A registry entry or a session directory is a reference even
	//    when its lease owner is already dead: the liveness axis reaps those.
	try {
		for (const registry of await listHarnessRootRegistriesForGc(env)) {
			if (registry.error) {
				incomplete("harness_root_registry_unreadable");
				continue;
			}
			if (registry.sessionId) ids.add(registry.sessionId);
			for (const entry of registry.roots) {
				const harnessSessions = path.join(path.resolve(entry.root), "sessions");
				try {
					for (const name of await fsp.readdir(harnessSessions)) ids.add(name);
				} catch (error) {
					if (!isEnoent(error)) incomplete("harness_session_dir_unreadable");
				}
			}
		}
	} catch {
		incomplete("harness_root_registry_scan_failed");
	}

	// 2. SDK hosts registered in the broker session index.
	const indexDir = path.join(agentDir, "sdk", "sessions");
	const indexFiles = [path.join(indexDir, "index.jsonl"), path.join(indexDir, "index.snapshot.json")];
	let indexPresent = false;
	for (const file of indexFiles) {
		try {
			await fsp.stat(file);
			indexPresent = true;
		} catch (error) {
			if (!isEnoent(error)) incomplete("sdk_session_index_unreadable");
		}
	}
	if (indexPresent) {
		try {
			const index = new SessionIndex(agentDir);
			await index.replay();
			for (const session of index.listSessions().sessions) ids.add(session.sessionId);
		} catch {
			incomplete("sdk_session_index_replay_failed");
		}
	}

	// 3. `local://` session roots: one directory per session id.
	const localRoots = path.join(env.TMPDIR?.trim() || os.tmpdir(), "gjc-local");
	try {
		for (const name of await fsp.readdir(localRoots)) ids.add(name);
	} catch (error) {
		if (!isEnoent(error)) incomplete("local_root_parent_unreadable");
	}

	return { ids, complete, notes };
}

/**
 * Whether a reference scan saw every file its conclusions depend on.
 * `complete: false` is a hard veto on reclamation for any surface whose evidence
 * lives in a file the scan could not open.
 */
interface GcDiskEvidence {
	complete: boolean;
	notes: string[];
}

function markGcDiskEvidenceIncomplete(evidence: GcDiskEvidence, note: string): void {
	evidence.complete = false;
	if (!evidence.notes.includes(note)) evidence.notes.push(note);
}

/** One managed session transcript plus its sibling artifact directory. */
interface GcDiskTranscript {
	sessionId: string;
	path: string;
	directory: string;
	bytes: number;
	mtimeMs: number;
	partial: boolean;
}

/**
 * Every managed transcript, plus whether that enumeration is complete evidence.
 *
 * A transcript that could not be enumerated or stat'd is absent from
 * `transcripts`, which leaves the session surface fail-closed by construction
 * (an unseen transcript is never retired). It does NOT leave the blob sweep
 * safe: a blob referenced only by an unseen transcript would look unreferenced,
 * so `evidence` is threaded to every surface that marks across all transcripts.
 */
interface GcDiskTranscriptScan {
	transcripts: GcDiskTranscript[];
	evidence: GcDiskEvidence;
}

/**
 * Walk every managed session transcript under `sessionsRoot` through exactly one
 * enumeration filter. Discovery and the blob sweep's staleness re-check both go
 * through here, so their two views of the store are comparable by construction;
 * anything the walk cannot read degrades `evidence` instead of quietly
 * shrinking the result.
 */
async function walkGcDiskTranscripts(input: {
	sessionsRoot: string;
	surface: GcDiskSurface;
	evidence: GcDiskEvidence;
	errors: GcDiskError[];
	visit: (transcriptPath: string, directory: string, stat: Stats) => Promise<void> | void;
}): Promise<void> {
	const { sessionsRoot, surface, evidence, errors, visit } = input;
	let projectDirs: Dirent[];
	try {
		projectDirs = await fsp.readdir(sessionsRoot, { withFileTypes: true });
	} catch (error) {
		// A missing sessions root is complete evidence: there are no transcripts.
		if (isEnoent(error)) return;
		errors.push({ surface, scope: sessionsRoot, message: gcDiskErrorText(error) });
		markGcDiskEvidenceIncomplete(evidence, "sessions_root_unreadable");
		return;
	}

	for (const projectDir of projectDirs) {
		if (!projectDir.isDirectory() || projectDir.isSymbolicLink()) continue;
		const directory = path.join(sessionsRoot, projectDir.name);
		let files: Dirent[];
		try {
			files = await fsp.readdir(directory, { withFileTypes: true });
		} catch (error) {
			errors.push({ surface, scope: directory, message: gcDiskErrorText(error) });
			markGcDiskEvidenceIncomplete(evidence, "session_project_dir_unreadable");
			continue;
		}
		for (const file of files) {
			if (!file.name.endsWith(".jsonl") || !file.isFile() || file.isSymbolicLink()) continue;
			const transcriptPath = path.join(directory, file.name);
			let stat: Stats;
			try {
				stat = await fsp.lstat(transcriptPath);
			} catch (error) {
				errors.push({ surface, scope: transcriptPath, message: gcDiskErrorText(error) });
				markGcDiskEvidenceIncomplete(evidence, "transcript_unstattable");
				continue;
			}
			await visit(transcriptPath, directory, stat);
		}
	}
}

async function discoverGcDiskTranscripts(sessionsRoot: string, errors: GcDiskError[]): Promise<GcDiskTranscriptScan> {
	const evidence: GcDiskEvidence = { complete: true, notes: [] };
	const transcripts: GcDiskTranscript[] = [];
	await walkGcDiskTranscripts({
		sessionsRoot,
		surface: "sessions",
		evidence,
		errors,
		visit: async (transcriptPath, directory, stat) => {
			const artifacts = await measureGcDiskTree(transcriptPath.slice(0, -".jsonl".length));
			transcripts.push({
				sessionId: path.basename(transcriptPath, ".jsonl"),
				path: transcriptPath,
				directory,
				bytes: stat.size + artifacts.bytes,
				mtimeMs: stat.mtimeMs,
				partial: artifacts.partial,
			});
		},
	});
	return { transcripts, evidence };
}

/**
 * Classify (and optionally retire) session transcripts. Returns the transcripts
 * that survived, which is exactly the mark set for the blob sweep.
 */
async function runGcDiskSessions(input: {
	surface: GcDiskSurfaceReport;
	transcripts: GcDiskTranscript[];
	references: GcSessionReferences;
	policy: GcDiskPolicy;
	now: number;
	prune: boolean;
}): Promise<GcDiskTranscript[]> {
	const { surface, transcripts, references, policy, now, prune } = input;
	const maxAgeMs = policy.sessions_max_age_days * GC_DISK_DAY_MS;

	// The newest transcript in each project directory is the `--continue` resume
	// target, so it is never a retention candidate regardless of age.
	const newestPerDirectory = new Map<string, GcDiskTranscript>();
	for (const transcript of transcripts) {
		const current = newestPerDirectory.get(transcript.directory);
		if (!current || transcript.mtimeMs > current.mtimeMs) newestPerDirectory.set(transcript.directory, transcript);
	}

	interface Classified {
		transcript: GcDiskTranscript;
		record: GcDiskRecord;
		/** Only transcripts kept purely because they are recent may be retired for size. */
		sizeEligible: boolean;
	}

	const classified: Classified[] = [];
	for (const transcript of transcripts) {
		const record: GcDiskRecord = {
			surface: "sessions",
			id: transcript.sessionId,
			path: transcript.path,
			bytes: transcript.bytes,
			age_days: gcDiskAgeDays(now, transcript.mtimeMs),
			action: "keep",
			reason: "",
			...(transcript.partial ? { partial: true as const } : {}),
		};
		let sizeEligible = false;
		if (!references.complete) {
			record.reason = `reference_scan_incomplete: ${references.notes.join(", ")}`;
		} else if (references.ids.has(transcript.sessionId)) {
			record.reason = "referenced_by_live_surface";
		} else if (newestPerDirectory.get(transcript.directory) === transcript) {
			record.reason = "most_recent_resumable_session";
		} else if (now - transcript.mtimeMs < maxAgeMs) {
			record.reason = `newer_than_max_age(${policy.sessions_max_age_days}d)`;
			sizeEligible = true;
		} else {
			record.action = "would_reclaim";
			record.reason = `older_than_max_age(${policy.sessions_max_age_days}d)`;
		}
		classified.push({ transcript, record, sizeEligible });
		surface.records.push(record);
	}

	// Size axis: when the store would still be over budget after the age pass,
	// retire the oldest recent-but-unreferenced transcripts until it fits. A
	// liveness keep is never overridden.
	if (policy.sessions_max_total_bytes > 0) {
		let projected = classified.reduce(
			(sum, item) => (item.record.action === "would_reclaim" ? sum : sum + item.transcript.bytes),
			0,
		);
		if (projected > policy.sessions_max_total_bytes) {
			const eligible = classified
				.filter(item => item.sizeEligible && item.record.action === "keep")
				.sort((a, b) => a.transcript.mtimeMs - b.transcript.mtimeMs);
			for (const item of eligible) {
				if (projected <= policy.sessions_max_total_bytes) break;
				item.record.action = "would_reclaim";
				item.record.reason = `over_max_total_bytes(${policy.sessions_max_total_bytes})`;
				projected -= item.transcript.bytes;
			}
		}
	}

	const storage = new FileSessionStorage();
	if (!prune) {
		// Dry run must project the prune verdict, not just the policy verdict: the
		// retention pass re-checks its own preconditions before it may call the
		// delete authority, and a candidate that fails them is never removable.
		for (const item of classified) {
			if (item.record.action !== "would_reclaim") continue;
			const probe = probeSessionRetirement(storage, surface.root, item.transcript.path);
			if (probe.kind === "retirable") continue;
			item.record.action = "keep";
			item.record.reason = `retention_declined: ${probe.reason}`;
		}
		return classified.filter(item => item.record.action !== "would_reclaim").map(item => item.transcript);
	}

	// Retirement goes through the identity-bound verified delete authority, which
	// re-reads and re-verifies the transcript. A declined retirement is a KEEP,
	// not a failure — the same posture the pid probe takes on EPERM/unknown. A
	// half-completed one is a failure: bytes are already gone.
	const survivors: GcDiskTranscript[] = [];
	for (const item of classified) {
		if (item.record.action !== "would_reclaim") {
			survivors.push(item.transcript);
			continue;
		}
		const outcome = await retireSessionTranscript(storage, surface.root, item.transcript.path);
		if (outcome.kind === "retired") {
			item.record.action = "reclaimed";
			continue;
		}
		if (outcome.kind === "cleanup_pending") {
			// The transcript survives but its artifact tree was already detached or
			// partially removed. Reporting that as a plain keep would hide a
			// destructive partial failure behind a green exit code.
			item.record.action = "reclaim_failed";
			item.record.reason = `retention_incomplete: ${outcome.reason}`;
			item.record.error = outcome.reason;
			survivors.push(item.transcript);
			continue;
		}
		item.record.action = "keep";
		item.record.reason = `retention_declined: ${outcome.reason}`;
		survivors.push(item.transcript);
	}
	return survivors;
}

/** Stream a transcript and collect every blob reference it still holds. */
async function markGcDiskBlobReferences(transcriptPath: string, into: Set<string>): Promise<boolean> {
	try {
		const decoder = new TextDecoder("utf-8");
		let carry = "";
		for await (const chunk of Bun.file(transcriptPath).stream()) {
			const text = carry + decoder.decode(chunk, { stream: true });
			collectBlobReferences(text, into);
			// Retain a reference-length tail so a hash split across chunks is still seen.
			carry = text.slice(-BLOB_REFERENCE_MAX_LENGTH);
		}
		collectBlobReferences(carry + decoder.decode(), into);
		return true;
	} catch {
		return false;
	}
}

/** What a completed mark read: the exact transcript bytes its references came from. */
interface GcDiskMarkedTranscript {
	size: number;
	mtimeMs: number;
	ctimeMs: number;
	dev: number;
	ino: number;
}

/**
 * Read one transcript's blob references and bind the result to the bytes that
 * produced it. The read is fenced by a stat before it and a stat after it: an
 * append landing between the two (or after the read but before the fence) can
 * introduce a reference the pass never saw, so the mark is only recorded when
 * both stats agree on the bytes the read had to see. Anything that moved while
 * the read was in flight degrades `evidence` instead of silently shrinking the
 * reference set.
 */
async function markGcDiskTranscript(
	transcriptPath: string,
	referenced: Set<string>,
	marked: Map<string, GcDiskMarkedTranscript>,
	evidence: GcDiskEvidence,
	errors: GcDiskError[],
): Promise<void> {
	let before: Stats;
	try {
		before = await fsp.lstat(transcriptPath);
	} catch (error) {
		markGcDiskEvidenceIncomplete(evidence, "transcript_unstattable_before_mark");
		errors.push({ surface: "blobs", scope: transcriptPath, message: gcDiskErrorText(error) });
		return;
	}
	if (!(await markGcDiskBlobReferences(transcriptPath, referenced))) {
		markGcDiskEvidenceIncomplete(evidence, "transcript_unreadable_during_mark");
		errors.push({ surface: "blobs", scope: transcriptPath, message: "transcript_unreadable_during_mark" });
		return;
	}
	let after: Stats;
	try {
		after = await fsp.lstat(transcriptPath);
	} catch (error) {
		markGcDiskEvidenceIncomplete(evidence, "transcript_unstattable_after_mark");
		errors.push({ surface: "blobs", scope: transcriptPath, message: gcDiskErrorText(error) });
		return;
	}
	if (
		before.size !== after.size ||
		before.mtimeMs !== after.mtimeMs ||
		before.ctimeMs !== after.ctimeMs ||
		before.dev !== after.dev ||
		before.ino !== after.ino
	) {
		// The transcript changed while its references were being read: the
		// reference set is not bound to a stable snapshot, so it cannot vouch
		// for any blob. Same posture as the drift rounds exhausting below.
		markGcDiskEvidenceIncomplete(evidence, "sessions_changed_during_mark");
		return;
	}
	marked.set(transcriptPath, {
		size: after.size,
		mtimeMs: after.mtimeMs,
		ctimeMs: after.ctimeMs,
		dev: after.dev,
		ino: after.ino,
	});
}

/**
 * Transcripts the store holds that nobody has accounted for: created after the
 * session walk enumerated the store, or written to after their own bytes were
 * read.
 *
 * `accounted` is the session walk's enumeration. A transcript in it that is not
 * in the mark set is one the session surface decided to retire, and a dry run
 * leaves those on disk — re-marking them would make the dry run promise fewer
 * reclaimable blobs than `--prune` actually removes.
 */
async function findGcDiskMarkDrift(input: {
	sessionsRoot: string;
	accounted: ReadonlySet<string>;
	marked: Map<string, GcDiskMarkedTranscript>;
	evidence: GcDiskEvidence;
	errors: GcDiskError[];
}): Promise<string[]> {
	const drifted: string[] = [];
	await walkGcDiskTranscripts({
		sessionsRoot: input.sessionsRoot,
		surface: "blobs",
		evidence: input.evidence,
		errors: input.errors,
		visit: (transcriptPath, _directory, stat) => {
			const mark = input.marked.get(transcriptPath);
			if (mark) {
				if (
					mark.size !== stat.size ||
					mark.mtimeMs !== stat.mtimeMs ||
					mark.ctimeMs !== stat.ctimeMs ||
					mark.dev !== stat.dev ||
					mark.ino !== stat.ino
				)
					drifted.push(transcriptPath);
				return;
			}
			if (!input.accounted.has(transcriptPath)) drifted.push(transcriptPath);
		},
	});
	return drifted;
}
/**
 * The sweep's evidence fence: re-walk the store and confirm every transcript
 * still matches the snapshot its references were read from. Returns false —
 * after degrading `evidence` to `sessions_changed_during_mark` — when anything
 * moved since the mark, so the sweep withholds rather than acting on stale
 * evidence. Run once after the mark loop converges and again immediately
 * before each removal, because the sweep itself is a window a live session can
 * write into.
 */
async function verifyGcDiskMarkFence(input: {
	sessionsRoot: string;
	accounted: ReadonlySet<string>;
	marked: Map<string, GcDiskMarkedTranscript>;
	evidence: GcDiskEvidence;
	errors: GcDiskError[];
}): Promise<boolean> {
	const drifted = await findGcDiskMarkDrift({
		sessionsRoot: input.sessionsRoot,
		accounted: input.accounted,
		marked: input.marked,
		evidence: input.evidence,
		errors: input.errors,
	});
	if (drifted.length === 0) return true;
	markGcDiskEvidenceIncomplete(input.evidence, "sessions_changed_during_mark");
	return false;
}
/**
 * Confirm the store is observably quiet before the sweep may remove anything.
 * A single fence pass can still complete inside an inter-append gap of a live
 * session, so this probes the store across {@link GC_DISK_MARK_QUIESCENCE_MS}
 * and only reports quiet when every transcript stayed unchanged for the whole
 * window. A store that keeps moving under the probe never satisfies it, which
 * is exactly the `sessions_changed_during_mark` condition the sweep must
 * withhold on instead of reclaiming on evidence it could not prove stable.
 */
async function confirmGcDiskStoreQuiet(input: {
	sessionsRoot: string;
	accounted: ReadonlySet<string>;
	marked: Map<string, GcDiskMarkedTranscript>;
	evidence: GcDiskEvidence;
	errors: GcDiskError[];
}): Promise<boolean> {
	if (!(await verifyGcDiskMarkFence(input))) return false;
	await Bun.sleep(GC_DISK_MARK_QUIESCENCE_MS);
	return await verifyGcDiskMarkFence(input);
}

/**
 * Mark and sweep the content-addressed blob store.
 *
 * A blob's only evidence of being referenced lives inside session transcripts,
 * so the sweep is sound only when every transcript was enumerated AND read.
 * `discovery` carries that verdict from the session walk; a transcript that
 * fails to stream here degrades it further. On incomplete evidence the sweep
 * still reports what it would have reclaimed and reclaims nothing, even under
 * `--prune`: an unproven reference is treated as a real one.
 *
 * The session walk is a snapshot, and a snapshot goes stale: a session started
 * or appended to while `gjc gc` was measuring the store can reference a blob the
 * mark never saw. So the mark re-walks the store, absorbs whatever appeared or
 * grew, and only sweeps once the store stops moving under it. Drift that
 * outlasts {@link GC_DISK_MARK_REMARK_ROUNDS} is incomplete evidence, not a
 * licence to delete.
 *
 * The drift rounds are themselves a window: they can converge on a transcript
 * that is mid-append, and the sweep then takes time to run. So the mark is
 * additionally fenced — each transcript's references are bound to a stable
 * stat snapshot taken around its read, the store must be observed completely
 * quiet across {@link GC_DISK_MARK_QUIESCENCE_MS} before the sweep acts, and
 * the fence is re-verified immediately before every removal. Any transcript
 * that moved at any of those points withholds the whole sweep.
 */
async function runGcDiskBlobs(input: {
	surface: GcDiskSurfaceReport;
	sessionsRoot: string;
	accounted: ReadonlySet<string>;
	survivors: GcDiskTranscript[];
	discovery: GcDiskEvidence;
	now: number;
	prune: boolean;
	errors: GcDiskError[];
}): Promise<void> {
	const { surface, sessionsRoot, accounted, survivors, discovery, now, prune, errors } = input;
	const evidence: GcDiskEvidence = { complete: discovery.complete, notes: [...discovery.notes] };
	let blobs: CanonicalBlobEntry[];
	try {
		blobs = await listCanonicalBlobs(surface.root);
	} catch (error) {
		errors.push({ surface: "blobs", scope: surface.root, message: gcDiskErrorText(error) });
		return;
	}
	if (blobs.length === 0) return;

	const referenced = new Set<string>();
	const marked = new Map<string, GcDiskMarkedTranscript>();
	let pending = survivors.map(transcript => transcript.path);
	for (let round = 0; ; round++) {
		for (const transcriptPath of pending) {
			await markGcDiskTranscript(transcriptPath, referenced, marked, evidence, errors);
		}
		// Already-incomplete evidence withholds the sweep anyway; re-walking would
		// only re-report the same failure.
		if (!evidence.complete) break;
		pending = await findGcDiskMarkDrift({ sessionsRoot, accounted, marked, evidence, errors });
		if (pending.length === 0 || !evidence.complete) break;
		if (round === GC_DISK_MARK_REMARK_ROUNDS) {
			markGcDiskEvidenceIncomplete(evidence, "sessions_changed_during_mark");
			break;
		}
	}

	// Gate the sweep on observable quiescence. The rounds can converge inside
	// an inter-append gap of a live session, and a single clean re-walk would
	// miss that; a store that keeps moving under the probe never satisfies it.
	// Only pay for the probe when a blob could actually be reclaimed.
	if (evidence.complete) {
		const couldReclaim = blobs.some(
			blob => !referenced.has(blob.hash) && now - blob.mtimeMs >= GC_DISK_BLOB_GRACE_MS,
		);
		if (couldReclaim && !(await confirmGcDiskStoreQuiet({ sessionsRoot, accounted, marked, evidence, errors }))) {
			markGcDiskEvidenceIncomplete(evidence, "sessions_changed_during_mark");
		}
	}

	let withheld = 0;
	let withheldBytes = 0;
	for (const blob of blobs) {
		const record: GcDiskRecord = {
			surface: "blobs",
			id: blob.hash,
			path: blob.path,
			bytes: blob.bytes,
			age_days: gcDiskAgeDays(now, blob.mtimeMs),
			action: "keep",
			reason: "",
		};
		if (referenced.has(blob.hash)) record.reason = "referenced_by_surviving_session";
		else if (now - blob.mtimeMs < GC_DISK_BLOB_GRACE_MS) record.reason = "within_write_grace_window";
		else if (!evidence.complete) {
			record.reason = `withheld_evidence_incomplete: ${evidence.notes.join(", ")}`;
			record.withheld = true;
			withheld++;
			withheldBytes += blob.bytes;
		} else {
			// Fence again immediately before acting: the sweep itself is a
			// window, and a transcript that moved since the last check
			// invalidates the whole mark, not just this blob.
			if (!(await verifyGcDiskMarkFence({ sessionsRoot, accounted, marked, evidence, errors }))) {
				record.reason = `withheld_evidence_incomplete: ${evidence.notes.join(", ")}`;
				record.withheld = true;
				withheld++;
				withheldBytes += blob.bytes;
			} else {
				record.action = "would_reclaim";
				record.reason = "unreferenced_by_any_surviving_session";
			}
		}
		surface.records.push(record);

		if (!prune || record.action !== "would_reclaim") continue;
		const removal = await removeCanonicalBlob(blob, {
			// The blob identity check has its own asynchronous read window. Bind the
			// transcript fence after that check and before unlink, so a reference
			// appended while the blob is being revalidated withholds the sweep.
			beforeUnlink: async () => await verifyGcDiskMarkFence({ sessionsRoot, accounted, marked, evidence, errors }),
		});
		if (removal.removed) {
			record.action = "reclaimed";
		} else if (!evidence.complete) {
			record.action = "keep";
			record.reason = `withheld_evidence_incomplete: ${evidence.notes.join(", ")}`;
			record.withheld = true;
			withheld++;
			withheldBytes += blob.bytes;
		} else if (removal.failed) {
			record.action = "reclaim_failed";
			record.reason = removal.reason;
			record.error = removal.reason;
		} else {
			record.action = "keep";
			record.reason = removal.reason;
		}
	}

	if (!evidence.complete) {
		surface.declined = {
			reason: `evidence_incomplete: ${evidence.notes.join(", ")}`,
			withheld,
			withheld_bytes: withheldBytes,
		};
	}
}

/**
 * Which family of GJC-written file a name belongs to, derived from the name's
 * shape rather than from a list of known tools.
 *
 * A published artifact is `<id>.<toolType>.log` and an ID claim is
 * `.artifact-id-<n>`, so a tool that starts writing `*.newthing.log` tomorrow is
 * counted the day it ships. Everything else falls back to its extension, so
 * nothing lands in the scope uncounted.
 */
function gcDiskArtifactFamily(name: string): string {
	const toolLog = /^\d+\.([A-Za-z0-9_-]+)\.log$/.exec(name);
	if (toolLog) return `*.${toolLog[1]}.log`;
	if (/^\.artifact-id-\d+$/.test(name)) return ".artifact-id-*";
	const extension = path.extname(name);
	return extension ? `*${extension}` : "(no extension)";
}

function countGcDiskArtifactFamily(families: Map<string, GcDiskFamilyUsage>, name: string, bytes: number): void {
	const family = gcDiskArtifactFamily(name);
	const usage = families.get(family);
	if (!usage) {
		families.set(family, { family, count: 1, bytes });
		return;
	}
	usage.count++;
	usage.bytes += bytes;
}

/**
 * The per-session artifact directories GJC writes its own tool output into:
 * `<id>.<tool>.log`, `.artifact-id-<n>` ID claims, evicted-output generations.
 *
 * The sessions surface already counts these bytes, but only as one number per
 * session and only reclaimable by retiring the whole session — so a scope filled
 * by a retained session's own tool logs was both unattributable and
 * unreclaimable. They are reported per family always, and reclaimed only for a
 * transcript that (a) no live surface references, (b) is not the newest
 * resumable transcript left in its project directory, and (c) holds a file that
 * has been still for the write-grace window.
 *
 * The walk never leaves `sessionsRoot`: directories come from the same
 * transcript enumeration the sessions surface uses, and inside one only regular
 * non-symlink files are candidates. A symlink, a subdirectory, or an unstattable
 * entry is reported as unverified and left alone — never followed, never removed.
 */
async function runGcDiskArtifacts(input: {
	surface: GcDiskSurfaceReport;
	survivors: GcDiskTranscript[];
	references: GcSessionReferences;
	agentDir: string;
	now: number;
	prune: boolean;
	errors: GcDiskError[];
}): Promise<void> {
	const { surface, survivors, references, agentDir, now, prune, errors } = input;
	const sessionIndex = new SessionIndex(agentDir);
	try {
		await sessionIndex.withLocked(async () => {
			// Recomputed over survivors: whichever transcript the sessions surface left
			// newest in a project directory is the `--continue` target, and a resumed
			// session still reads its own `artifact://` handles.
			const newestPerDirectory = new Map<string, GcDiskTranscript>();
			for (const transcript of survivors) {
				const current = newestPerDirectory.get(transcript.directory);
				if (!current || transcript.mtimeMs > current.mtimeMs)
					newestPerDirectory.set(transcript.directory, transcript);
			}

			const families = new Map<string, GcDiskFamilyUsage>();
			let withheld = 0;
			let withheldBytes = 0;

			for (const transcript of survivors) {
				const directory = transcript.path.slice(0, -".jsonl".length);
				let entries: Dirent[];
				try {
					entries = await fsp.readdir(directory, { withFileTypes: true });
				} catch (error) {
					// No artifact directory is complete evidence: this session wrote none.
					if (!isEnoent(error)) {
						errors.push({ surface: "artifacts", scope: directory, message: gcDiskErrorText(error) });
					}
					continue;
				}

				const retained = !references.complete
					? `reference_scan_incomplete: ${references.notes.join(", ")}`
					: references.ids.has(transcript.sessionId)
						? "referenced_by_live_surface"
						: newestPerDirectory.get(transcript.directory) === transcript
							? "most_recent_resumable_session"
							: undefined;

				for (const entry of entries) {
					if (surface.records.length >= GC_DISK_MAX_WALK_ENTRIES) {
						errors.push({ surface: "artifacts", scope: directory, message: "artifact_walk_capped" });
						break;
					}
					const target = path.join(directory, entry.name);
					const record: GcDiskRecord = {
						surface: "artifacts",
						id: `${transcript.sessionId}/${entry.name}`,
						path: target,
						bytes: 0,
						age_days: 0,
						action: "keep",
						reason: "",
					};

					// A symlink is never followed and never removed: following one is exactly
					// how a scope cleanup reaches bytes that are not GJC's to reclaim.
					// Anything that is not a regular file is unverified state, not an artifact.
					if (entry.isSymbolicLink() || !entry.isFile()) {
						record.reason = `unverified_entry: ${entry.isSymbolicLink() ? "symlink" : "not_a_regular_file"}`;
						record.withheld = true;
						surface.records.push(record);
						countGcDiskArtifactFamily(families, entry.name, 0);
						withheld++;
						continue;
					}

					let stat: Stats;
					try {
						stat = await fsp.lstat(target);
					} catch (error) {
						// Vanished mid-walk is the opposite of withheld: it is already gone.
						if (isEnoent(error)) continue;
						const message = gcDiskErrorText(error);
						errors.push({ surface: "artifacts", scope: target, message });
						record.reason = `entry_unverifiable: ${message}`;
						record.error = message;
						record.withheld = true;
						surface.records.push(record);
						countGcDiskArtifactFamily(families, entry.name, 0);
						withheld++;
						continue;
					}

					record.bytes = stat.size;
					record.age_days = gcDiskAgeDays(now, stat.mtimeMs);
					surface.records.push(record);
					countGcDiskArtifactFamily(families, entry.name, stat.size);

					if (retained !== undefined) {
						record.reason = retained;
						if (!references.complete) {
							record.withheld = true;
							withheld++;
							withheldBytes += record.bytes;
						}
						continue;
					}
					if (now - stat.mtimeMs < GC_DISK_BLOB_GRACE_MS) {
						record.reason = "within_write_grace_window";
						continue;
					}
					record.action = "would_reclaim";
					record.reason = "unreferenced_by_any_live_session";

					if (!prune) continue;
					const removal = await removeGcDiskEntry(target, stat);
					if (removal.removed) record.action = "reclaimed";
					else if (removal.failed) {
						record.action = "reclaim_failed";
						record.reason = removal.reason;
						record.error = removal.reason;
					} else {
						record.action = "keep";
						record.reason = removal.reason;
						if (removal.withheld) record.withheld = true;
					}
				}
			}

			surface.families = [...families.values()].sort(
				(a, b) => b.bytes - a.bytes || a.family.localeCompare(b.family),
			);
			if (!references.complete) {
				surface.declined = {
					reason: `reference_scan_incomplete: ${references.notes.join(", ")}`,
					withheld,
					withheld_bytes: withheldBytes,
				};
			}
		});
	} catch (error) {
		errors.push({
			surface: "artifacts",
			scope: surface.root,
			message: `artifact_liveness_authority_unavailable: ${gcDiskErrorText(error)}`,
		});
	}
}
/** Numeric `major.minor.patch` prefix, or undefined when the name is not a version. */
function parseGcDiskVersion(value: string): [number, number, number] | undefined {
	const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(value);
	if (!match) return undefined;
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareGcDiskVersions(a: [number, number, number], b: [number, number, number]): number {
	for (let index = 0; index < 3; index++) {
		if (a[index] !== b[index]) return a[index] - b[index];
	}
	return 0;
}

async function runGcDiskNatives(input: {
	surface: GcDiskSurfaceReport;
	policy: GcDiskPolicy;
	now: number;
	prune: boolean;
	errors: GcDiskError[];
	runningVersion: string;
}): Promise<void> {
	const { surface, policy, now, prune, errors, runningVersion } = input;
	let entries: Dirent[];
	try {
		entries = await fsp.readdir(surface.root, { withFileTypes: true });
	} catch (error) {
		if (!isEnoent(error)) errors.push({ surface: "natives", scope: surface.root, message: gcDiskErrorText(error) });
		return;
	}

	const running = parseGcDiskVersion(runningVersion);
	const versioned = entries
		.filter(entry => entry.isDirectory() && !entry.isSymbolicLink())
		.map(entry => ({ name: entry.name, version: parseGcDiskVersion(entry.name) }));
	const ordered = versioned
		.filter((entry): entry is { name: string; version: [number, number, number] } => entry.version !== undefined)
		.sort((a, b) => compareGcDiskVersions(b.version, a.version) || b.name.localeCompare(a.name));

	// Keep the running version, anything newer than it, and the configured number
	// of immediate predecessors. Everything else is a cached leftover.
	const keep = new Set<string>();
	let predecessors = 0;
	for (const entry of ordered) {
		if (!running || compareGcDiskVersions(entry.version, running) >= 0) {
			keep.add(entry.name);
			continue;
		}
		if (predecessors < policy.natives_keep_versions) {
			keep.add(entry.name);
			predecessors++;
		}
	}

	for (const entry of versioned) {
		const directory = path.join(surface.root, entry.name);
		let stat: Stats;
		try {
			stat = await fsp.lstat(directory);
		} catch (error) {
			errors.push({ surface: "natives", scope: directory, message: gcDiskErrorText(error) });
			continue;
		}
		const usage = await measureGcDiskTree(directory);
		const record: GcDiskRecord = {
			surface: "natives",
			id: entry.name,
			path: directory,
			bytes: usage.bytes,
			age_days: gcDiskAgeDays(now, stat.mtimeMs),
			action: "keep",
			reason: "",
			...(usage.partial ? { partial: true as const } : {}),
		};
		if (!entry.version) record.reason = "unrecognized_version_directory";
		else if (entry.name === runningVersion) record.reason = "running_version";
		else if (keep.has(entry.name)) record.reason = `retained_version(keepVersions=${policy.natives_keep_versions})`;
		else if (usage.unreadable) {
			// The walk could not read part of the tree this reclaim would remove, so
			// a recursive remove cannot finish: it would destroy the readable half
			// and leave the rest. Partial knowledge is never a licence to delete.
			record.reason = "withheld_evidence_incomplete: tree_unreadable";
			record.withheld = true;
		} else {
			record.action = "would_reclaim";
			record.reason = `beyond_keep_versions(${policy.natives_keep_versions})`;
		}
		surface.records.push(record);

		if (!prune || record.action !== "would_reclaim") continue;
		const removal = await removeGcDiskEntry(directory, stat);
		if (removal.removed) record.action = "reclaimed";
		else if (removal.failed) {
			record.action = "reclaim_failed";
			record.reason = removal.reason;
			record.error = removal.reason;
		} else {
			record.action = "keep";
			record.reason = removal.reason;
			if (removal.withheld) record.withheld = true;
		}
	}
}

/**
 * Remove one directory/file entry, fail-closed on identity drift. Anything that
 * changed inode or mtime between classification and removal is left alone.
 *
 * Directories use the native exact-tree remover. Its fresh descriptor-relative
 * snapshot is revalidated by the removal itself before an atomic detach, closing
 * the gap where a plain recursive `rm` could destroy readable siblings before
 * discovering that another subtree had become unreadable.
 */
async function removeGcDiskEntry(
	target: string,
	expected: Stats,
): Promise<{ removed: true } | { removed: false; reason: string; failed?: true; withheld?: true }> {
	let current: Stats;
	try {
		current = await fsp.lstat(target);
	} catch (error) {
		if (isEnoent(error)) return { removed: false, reason: "entry_disappeared" };
		return { removed: false, reason: `entry_unverifiable: ${gcDiskErrorText(error)}`, failed: true };
	}
	if (current.isSymbolicLink()) return { removed: false, reason: "entry_is_symlink" };
	if (current.ino !== expected.ino || current.dev !== expected.dev) {
		return { removed: false, reason: "entry_identity_changed" };
	}
	if (current.mtimeMs !== expected.mtimeMs) return { removed: false, reason: "entry_changed" };

	if (!current.isDirectory()) {
		try {
			await fsp.rm(target, { force: false });
			return { removed: true };
		} catch (error) {
			if (isEnoent(error)) return { removed: false, reason: "entry_disappeared" };
			return { removed: false, reason: `entry_remove_failed: ${gcDiskErrorText(error)}`, failed: true };
		}
	}

	const snapshot = snapshotDirectoryTree(target);
	if (!snapshot.ok || !snapshot.snapshot) {
		if (snapshot.code === "not_found") return { removed: false, reason: "entry_disappeared" };
		if (snapshot.code !== "reparse_point") {
			return { removed: false, reason: "withheld_evidence_incomplete: tree_unreadable", withheld: true };
		}

		let identity: BigIntStats;
		let linkParent: BigIntStats;
		try {
			identity = await fsp.lstat(target, { bigint: true });
			linkParent = await fsp.lstat(path.dirname(target), { bigint: true });
		} catch (error) {
			if (isEnoent(error)) return { removed: false, reason: "entry_disappeared" };
			return { removed: false, reason: `entry_unverifiable: ${gcDiskErrorText(error)}`, failed: true };
		}
		const detached = exactUnlink(target, {
			dev: identity.dev,
			ino: identity.ino,
			nlink: identity.nlink,
			size: identity.size,
			mtimeNs: identity.mtimeNs,
			parentDev: linkParent.dev,
			parentIno: linkParent.ino,
			directory: true,
			detachOnly: true,
			quarantineName: `${path.basename(target)}.removing`,
		});
		if ((!detached.ok && detached.code !== "cleanup_pending") || !detached.detachedPath) {
			return { removed: false, reason: `entry_remove_failed: ${detached.code ?? "unknown"}`, failed: true };
		}
		try {
			await fsp.rm(detached.detachedPath, { recursive: true, force: false });
			if (detached.retainedPlaceholderPath) await fsp.rmdir(detached.retainedPlaceholderPath);
			return { removed: true };
		} catch (error) {
			if (isEnoent(error)) return { removed: true };
			return { removed: false, reason: `entry_remove_failed: ${gcDiskErrorText(error)}`, failed: true };
		}
	}

	let parent: BigIntStats;
	try {
		parent = await fsp.lstat(path.dirname(target), { bigint: true });
	} catch (error) {
		if (isEnoent(error)) return { removed: false, reason: "entry_disappeared" };
		return { removed: false, reason: `entry_unverifiable: ${gcDiskErrorText(error)}`, failed: true };
	}

	const removal = exactRemoveDirectoryTree(target, snapshot.snapshot, {
		dev: parent.dev,
		ino: parent.ino,
	});
	if (removal.ok) return { removed: true };
	if (removal.code === "cleanup_pending" && removal.payloadDurable === true && removal.detachedPath) {
		try {
			await fsp.rm(removal.detachedPath, { recursive: true, force: false });
			return { removed: true };
		} catch (error) {
			if (isEnoent(error)) return { removed: true };
			return { removed: false, reason: `entry_remove_failed: ${gcDiskErrorText(error)}`, failed: true };
		}
	}
	if (removal.code === "not_found") return { removed: false, reason: "entry_disappeared" };
	if (removal.code === "identity_mismatch" || removal.code === "parent_mismatch") {
		return { removed: false, reason: "entry_changed" };
	}
	const retainedAtOriginal = !removal.detachedPath || path.resolve(removal.detachedPath) === path.resolve(target);
	if ((removal.code === "permission_denied" || removal.code === "io_error") && retainedAtOriginal) {
		return { removed: false, reason: "withheld_evidence_incomplete: tree_unreadable", withheld: true };
	}
	return {
		removed: false,
		reason: `entry_remove_failed: ${removal.code ?? "unknown"}`,
		failed: true,
	};
}

async function runGcDiskBackups(input: {
	surface: GcDiskSurfaceReport;
	gjcRoot: string;
	policy: GcDiskPolicy;
	now: number;
	prune: boolean;
	errors: GcDiskError[];
}): Promise<void> {
	const { surface, gjcRoot, policy, now, prune, errors } = input;
	const maxAgeMs = policy.backups_max_age_days * GC_DISK_DAY_MS;
	const candidates: Array<{ id: string; path: string }> = [];

	// `~/.gjc/backups/<entry>` — update/restore backup roots.
	try {
		for (const entry of await fsp.readdir(surface.root, { withFileTypes: true })) {
			if (entry.isSymbolicLink()) continue;
			candidates.push({ id: entry.name, path: path.join(surface.root, entry.name) });
		}
	} catch (error) {
		if (!isEnoent(error)) errors.push({ surface: "backups", scope: surface.root, message: gcDiskErrorText(error) });
	}

	// `~/.gjc/*.bak` — sibling roots left by update/restore (agent.bak, natives-*.bak).
	try {
		for (const entry of await fsp.readdir(gjcRoot, { withFileTypes: true })) {
			if (!entry.name.endsWith(".bak") || entry.isSymbolicLink()) continue;
			candidates.push({ id: entry.name, path: path.join(gjcRoot, entry.name) });
		}
	} catch (error) {
		if (!isEnoent(error)) errors.push({ surface: "backups", scope: gjcRoot, message: gcDiskErrorText(error) });
	}

	for (const candidate of candidates) {
		let stat: Stats;
		try {
			stat = await fsp.lstat(candidate.path);
		} catch (error) {
			if (!isEnoent(error)) {
				errors.push({ surface: "backups", scope: candidate.path, message: gcDiskErrorText(error) });
			}
			continue;
		}
		if (stat.isSymbolicLink()) continue;
		const usage = stat.isDirectory()
			? await measureGcDiskTree(candidate.path)
			: { bytes: stat.size, partial: false, unreadable: false };
		const record: GcDiskRecord = {
			surface: "backups",
			id: candidate.id,
			path: candidate.path,
			bytes: usage.bytes,
			age_days: gcDiskAgeDays(now, stat.mtimeMs),
			action: "keep",
			reason: "",
			...(usage.partial ? { partial: true as const } : {}),
		};
		if (now - stat.mtimeMs < maxAgeMs) record.reason = `newer_than_max_age(${policy.backups_max_age_days}d)`;
		else if (usage.unreadable) {
			// The walk could not read part of the tree this reclaim would remove, so
			// a recursive remove cannot finish: it would destroy the readable half
			// and leave the rest. Partial knowledge is never a licence to delete.
			record.reason = "withheld_evidence_incomplete: tree_unreadable";
			record.withheld = true;
		} else {
			record.action = "would_reclaim";
			record.reason = `older_than_max_age(${policy.backups_max_age_days}d)`;
		}
		surface.records.push(record);

		if (!prune || record.action !== "would_reclaim") continue;
		const removal = await removeGcDiskEntry(candidate.path, stat);
		if (removal.removed) record.action = "reclaimed";
		else if (removal.failed) {
			record.action = "reclaim_failed";
			record.reason = removal.reason;
			record.error = removal.reason;
		} else {
			record.action = "keep";
			record.reason = removal.reason;
			if (removal.withheld) record.withheld = true;
		}
	}
}

/**
 * Run the disk-retention axis. Nothing is mutated unless `prune` is true; the
 * dry-run report projects exactly the same decisions a prune would make.
 */
export async function collectGcDiskReport(input: {
	agentDir: string;
	env: NodeJS.ProcessEnv;
	policy: GcDiskPolicy;
	prune: boolean;
	now?: number;
	runningVersion?: string;
}): Promise<GcDiskReport> {
	const { agentDir, env, policy, prune } = input;
	const now = input.now ?? Date.now();
	const gjcRoot = path.dirname(path.resolve(agentDir));
	const errors: GcDiskError[] = [];
	const surfaces: Record<GcDiskSurface, GcDiskSurfaceReport> = {
		sessions: emptyGcDiskSurface("sessions", getSessionsDir(agentDir)),
		blobs: emptyGcDiskSurface("blobs", getBlobsDir(agentDir)),
		artifacts: emptyGcDiskSurface("artifacts", getSessionsDir(agentDir)),
		natives: emptyGcDiskSurface("natives", path.join(gjcRoot, "natives")),
		backups: emptyGcDiskSurface("backups", path.join(gjcRoot, "backups")),
	};

	const scan = await discoverGcDiskTranscripts(surfaces.sessions.root, errors);
	const references = await collectGcSessionReferences(agentDir, env);
	const survivors = await runGcDiskSessions({
		surface: surfaces.sessions,
		transcripts: scan.transcripts,
		references,
		policy,
		now,
		prune,
	});
	await runGcDiskBlobs({
		surface: surfaces.blobs,
		sessionsRoot: surfaces.sessions.root,
		accounted: new Set(scan.transcripts.map(transcript => transcript.path)),
		survivors,
		discovery: scan.evidence,
		now,
		prune,
		errors,
	});
	await runGcDiskArtifacts({
		surface: surfaces.artifacts,
		survivors,
		references,
		agentDir,
		now,
		prune,
		errors,
	});
	await runGcDiskNatives({
		surface: surfaces.natives,
		policy,
		now,
		prune,
		errors,
		runningVersion: input.runningVersion ?? VERSION,
	});
	await runGcDiskBackups({ surface: surfaces.backups, gjcRoot, policy, now, prune, errors });

	const totals = { scanned_bytes: 0, reclaimable_bytes: 0, reclaimed_bytes: 0, kept_bytes: 0, failed: 0 };
	for (const name of GC_DISK_SURFACES) {
		const surface = surfaces[name];
		summarizeGcDiskSurface(surface);
		// The artifacts surface re-attributes bytes the sessions surface already
		// counted inside surviving sessions, so only what it can act on is added:
		// summing its scan too would report more bytes than exist on disk.
		if (name !== "artifacts") {
			totals.scanned_bytes += surface.scanned_bytes;
			totals.kept_bytes += surface.kept_bytes;
		}
		totals.reclaimable_bytes += surface.reclaimable_bytes;
		totals.reclaimed_bytes += surface.reclaimed_bytes;
		totals.failed += surface.failed;
	}

	return { dry_run: !prune, policy, surfaces, totals, errors };
}

const GC_DISK_SURFACE_HEADINGS: Record<GcDiskSurface, string> = {
	sessions: "Session transcripts",
	blobs: "Content-addressed blobs",
	artifacts: "Session tool artifacts",
	natives: "Cached native versions",
	backups: "Update/restore backups",
};

function formatGcDiskBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const units = ["KiB", "MiB", "GiB", "TiB"];
	let value = bytes / 1024;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	return `${value.toFixed(1)} ${units[unit]}`;
}

function gcDiskActionLabel(record: GcDiskRecord): string {
	switch (record.action) {
		case "would_reclaim":
			return "would reclaim";
		case "reclaimed":
			return "reclaimed";
		case "reclaim_failed":
			return `reclaim failed${record.error ? `: ${record.error}` : ""}`;
		default:
			return "keep";
	}
}

export function buildGcDiskReportText(disk: GcDiskReport): string {
	const lines: string[] = [];
	lines.push(
		disk.dry_run
			? "gjc gc --disk — report only (no bytes reclaimed; pass --prune to reclaim)"
			: "gjc gc --disk --prune — reclaim",
	);
	lines.push(
		`  policy: sessions.maxAgeDays=${disk.policy.sessions_max_age_days} ` +
			`sessions.maxTotalBytes=${disk.policy.sessions_max_total_bytes} ` +
			`natives.keepVersions=${disk.policy.natives_keep_versions} ` +
			`backups.maxAgeDays=${disk.policy.backups_max_age_days}`,
	);
	lines.push("");

	for (const name of GC_DISK_SURFACES) {
		const surface = disk.surfaces[name];
		lines.push(`${GC_DISK_SURFACE_HEADINGS[name]} (${surface.root})`);
		lines.push(
			`  scanned=${surface.scanned} (${formatGcDiskBytes(surface.scanned_bytes)}) ` +
				(disk.dry_run
					? `reclaimable=${surface.reclaimable} (${formatGcDiskBytes(surface.reclaimable_bytes)}) `
					: `reclaimed=${surface.reclaimed} (${formatGcDiskBytes(surface.reclaimed_bytes)}) failed=${surface.failed} `) +
				`kept=${surface.kept} (${formatGcDiskBytes(surface.kept_bytes)})`,
		);
		if (surface.declined) {
			const reclaimState =
				surface.reclaimed === 0 ? "reclaimed nothing" : `reclaimed ${surface.reclaimed} before withholding`;
			lines.push(
				`  declined: ${reclaimState} — ${surface.declined.reason} ` +
					`(withheld=${surface.declined.withheld} (${formatGcDiskBytes(surface.declined.withheld_bytes)}))`,
			);
		}
		// The per-file records below say what may go; the family rollup is what
		// answers "what filled this scope?", so it is never truncated.
		for (const family of surface.families ?? []) {
			lines.push(`  family ${family.family} count=${family.count} (${formatGcDiskBytes(family.bytes)})`);
		}
		// Reclaim decisions first: they are what an operator has to audit.
		const ranked = [...surface.records].sort(
			(a, b) => Number(a.action === "keep") - Number(b.action === "keep") || b.bytes - a.bytes,
		);
		for (const record of ranked.slice(0, GC_DISK_MAX_RENDERED_RECORDS)) {
			lines.push(
				`  [${gcDiskActionLabel(record)}] ${record.path} ${formatGcDiskBytes(record.bytes)}` +
					`${record.partial ? "+" : ""} age=${record.age_days}d — ${record.reason}`,
			);
		}
		if (ranked.length > GC_DISK_MAX_RENDERED_RECORDS) {
			lines.push(`  … ${ranked.length - GC_DISK_MAX_RENDERED_RECORDS} more (use --json for the full list)`);
		}
		lines.push("");
	}

	if (disk.errors.length > 0) {
		lines.push(`Disk errors (${disk.errors.length})`);
		for (const error of disk.errors) lines.push(`  [${error.surface}/${error.scope}] ${error.message}`);
		lines.push("");
	}

	lines.push(
		`Disk summary: scanned=${formatGcDiskBytes(disk.totals.scanned_bytes)} ` +
			(disk.dry_run
				? `reclaimable=${formatGcDiskBytes(disk.totals.reclaimable_bytes)}`
				: `reclaimed=${formatGcDiskBytes(disk.totals.reclaimed_bytes)} failed=${disk.totals.failed}`) +
			` kept=${formatGcDiskBytes(disk.totals.kept_bytes)}`,
	);
	lines.push("");
	return `${lines.join("\n")}`;
}
