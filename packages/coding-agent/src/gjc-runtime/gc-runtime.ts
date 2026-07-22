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

import { getAgentDir } from "@gajae-code/utils";
import { SessionIndex } from "../sdk/broker/session-index";
import { UnsupportedStateVersionError } from "../sdk/broker/state-version";

import { buildGcReportText } from "./gc-render";

export type GcStore = "harness_leases" | "team_workers" | "file_locks" | "tmux_sessions" | "registry_entries";

export const GC_STORES: readonly GcStore[] = [
	"harness_leases",
	"team_workers",
	"file_locks",
	"tmux_sessions",
	"registry_entries",
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

export interface GcCollectResult {
	records: GcRecord[];
	errors: GcError[];
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
	session_index?: GcSessionIndexHealth;
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
	help: boolean;
}

class GcUsageError extends Error {}

function parseGcArgs(argv: string[]): ParsedGcArgs {
	let json = false;
	let prune = false;
	let repairSessionIndex = false;

	let dryRun = false;
	let help = false;
	for (const arg of argv) {
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

			case "--dry-run":
				dryRun = true;
				break;
			case "--help":
			case "-h":
				help = true;
				break;
			default:
				throw new GcUsageError(`unknown_flag:${arg}`);
		}
	}
	if (repairSessionIndex && prune) throw new GcUsageError("repair_session_index_cannot_combine_with_prune");
	if (repairSessionIndex && dryRun) throw new GcUsageError("repair_session_index_cannot_combine_with_dry_run");
	// Explicit --dry-run always wins over --prune/--force.
	if (dryRun) prune = false;
	return { json, prune, repairSessionIndex, help };
}

/**
 * Collect every store's records (catching hard discovery errors per adapter),
 * then optionally prune removable records with per-record revalidation.
 */
export async function collectGcReport(adapters: GcStoreAdapter[], ctx: GcContext, prune: boolean): Promise<GcReport> {
	const stores = emptyStores();
	const errors: GcError[] = [];

	for (const adapter of adapters) {
		try {
			const result = await adapter.collect(ctx);
			stores[adapter.store].push(...result.records);
			errors.push(...result.errors);
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

	return { dry_run: !prune, stores, counts: computeCounts(stores, errors), errors };
}

/**
 * Exit-code policy:
 * - usage/parse error => 2
 * - hard discovery errors => 1 (both modes)
 * - prune mode with a failed intended removal => 1
 * - otherwise => 0
 */
export function computeExitCode(report: GcReport): number {
	if (report.errors.length > 0) return 1;
	if (!report.dry_run && report.counts.failed > 0) return 1;
	return 0;
}

function resolveGcAgentDir(env: NodeJS.ProcessEnv): string {
	return env.GJC_CODING_AGENT_DIR?.trim() || env.PI_CODING_AGENT_DIR?.trim() || getAgentDir();
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
	const sessionIndexFailed =
		report.session_index?.status === "corrupt" ||
		report.session_index?.status === "unsupported" ||
		report.session_index?.status === "repair_failed";
	const status = sessionIndexFailed ? 1 : computeExitCode(report);
	const stdout = parsed.json ? `${JSON.stringify(report, null, 2)}\n` : buildGcReportText(report);
	return { stdout, stderr: "", status };
}

export function gcHelpText(): string {
	return [
		"gjc gc - garbage-collect stale GJC session/PID records",
		"",
		"USAGE",
		"  $ gjc gc [--prune|--force] [--repair-session-index] [--json]",

		"",
		"FLAGS",
		"  --prune, --force  Actually remove stale records (default: dry-run report only)",
		"  --dry-run         Force report-only mode (overrides --prune/--force)",
		"  -j, --json        Emit machine-readable JSON",
		"  --repair-session-index  Explicitly quarantine a corrupt session-index suffix and retain its valid prefix",
		"",
		"Liveness-only: a record is removed only when its owning process is dead",
		"(ESRCH). Live / permission-denied / unknown processes are always kept.",
		"",
	].join("\n");
}

/** Lazily assemble the real store adapters (kept lazy to avoid import cycles). */
export async function defaultGcAdapters(): Promise<GcStoreAdapter[]> {
	const [
		{ harnessLeasesGcAdapter, registryEntriesGcAdapter },
		{ fileLocksGcAdapter },
		{ teamWorkersGcAdapter },
		{ tmuxSessionsGcAdapter },
	] = await Promise.all([
		import("../harness-control-plane/gc-adapter"),
		import("../config/file-lock-gc"),
		import("./team-gc"),
		import("./tmux-gc"),
	]);
	return [
		harnessLeasesGcAdapter,
		teamWorkersGcAdapter,
		fileLocksGcAdapter,
		tmuxSessionsGcAdapter,
		registryEntriesGcAdapter,
	];
}
