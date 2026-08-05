/**
 * Disk-retention pass for `gjc gc --disk`.
 *
 * Orthogonal to the PID-liveness reaper: this axis reclaims aged/unreferenced
 * on-disk cache directories. First surface: versioned natives addons under
 * `~/.gjc/natives/<version>/` (see packages/natives/native/loader-state.js).
 *
 * Contract (mirrors liveness GC):
 * - Opt-in via `--disk`; without it this module is never invoked.
 * - Dry-run by default; only `--prune` deletes.
 * - Fail-closed: current version, newer-than-current caches, non-semver names,
 *   and unreadable entries are kept with an explicit reason.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getNativesDir, isEnoent } from "@gajae-code/utils";

import type { GcAction } from "./gc-runtime";

/** Surfaces this slice can reclaim. Expand in follow-ups (sessions, blobs, backups). */
export type GcDiskSurface = "natives_versions";

export const GC_DISK_SURFACES: readonly GcDiskSurface[] = ["natives_versions"] as const;

/** Default: keep the running natives version plus this many older predecessors. */
export const DEFAULT_NATIVES_KEEP_VERSIONS = 2;

/** Bound directory size walks so a pathological tree cannot stall `gjc gc`. */
const MAX_SIZE_ENTRIES = 50_000;

export interface GcDiskCandidate {
	surface: GcDiskSurface;
	/** Stable identifier (e.g. natives package version). */
	id: string;
	path: string;
	bytes: number;
	/** True when size walk hit the entry budget (bytes may be a lower bound). */
	bytes_truncated?: boolean;
	status: string;
	removable: boolean;
	action: GcAction;
	reason: string;
	detail?: string;
	error?: string;
	removed?: boolean;
}

export interface GcDiskCounts {
	discovered: number;
	kept: number;
	would_remove: number;
	removed: number;
	failed: number;
	reclaimable_bytes: number;
	reclaimed_bytes: number;
	by_surface: Record<
		GcDiskSurface,
		{
			discovered: number;
			kept: number;
			would_remove: number;
			removed: number;
			failed: number;
			reclaimable_bytes: number;
			reclaimed_bytes: number;
		}
	>;
}

export interface GcDiskPolicy {
	natives_keep_versions: number;
	natives_current_version: string;
	natives_dir: string;
}

export interface GcDiskReport {
	dry_run: boolean;
	policy: GcDiskPolicy;
	surfaces: Record<GcDiskSurface, GcDiskCandidate[]>;
	counts: GcDiskCounts;
	errors: Array<{ surface: GcDiskSurface; scope: string; message: string }>;
}

export interface GcDiskCollectOptions {
	nativesDir: string;
	currentNativesVersion: string;
	/** Number of strictly older predecessors to keep (in addition to current). */
	keepVersions: number;
}

export interface GcDiskDeps {
	nativesDir?: string;
	currentNativesVersion?: string;
	keepVersions?: number;
}

function emptyBySurface(): GcDiskCounts["by_surface"] {
	const by = {} as GcDiskCounts["by_surface"];
	for (const surface of GC_DISK_SURFACES) {
		by[surface] = {
			discovered: 0,
			kept: 0,
			would_remove: 0,
			removed: 0,
			failed: 0,
			reclaimable_bytes: 0,
			reclaimed_bytes: 0,
		};
	}
	return by;
}

function emptySurfaces(): Record<GcDiskSurface, GcDiskCandidate[]> {
	const surfaces = {} as Record<GcDiskSurface, GcDiskCandidate[]>;
	for (const surface of GC_DISK_SURFACES) surfaces[surface] = [];
	return surfaces;
}

function computeDiskCounts(surfaces: Record<GcDiskSurface, GcDiskCandidate[]>): GcDiskCounts {
	const counts: GcDiskCounts = {
		discovered: 0,
		kept: 0,
		would_remove: 0,
		removed: 0,
		failed: 0,
		reclaimable_bytes: 0,
		reclaimed_bytes: 0,
		by_surface: emptyBySurface(),
	};
	for (const surface of GC_DISK_SURFACES) {
		for (const candidate of surfaces[surface]) {
			counts.discovered++;
			counts.by_surface[surface].discovered++;
			if (candidate.action === "would_remove") {
				counts.would_remove++;
				counts.by_surface[surface].would_remove++;
				counts.reclaimable_bytes += candidate.bytes;
				counts.by_surface[surface].reclaimable_bytes += candidate.bytes;
			} else if (candidate.action === "removed") {
				counts.removed++;
				counts.by_surface[surface].removed++;
				counts.reclaimed_bytes += candidate.bytes;
				counts.by_surface[surface].reclaimed_bytes += candidate.bytes;
			} else if (candidate.action === "remove_failed") {
				counts.failed++;
				counts.by_surface[surface].failed++;
			} else {
				counts.kept++;
				counts.by_surface[surface].kept++;
			}
		}
	}
	return counts;
}

/** True when `version` is a parseable semver Bun can order. */
export function isOrderableSemver(version: string): boolean {
	try {
		// order against itself: invalid versions throw or return NaN-ish behavior.
		return Bun.semver.order(version, version) === 0;
	} catch {
		return false;
	}
}

/**
 * Compare two orderable semver strings. Returns negative if a < b, 0 if equal,
 * positive if a > b. Callers must gate with {@link isOrderableSemver}.
 */
export function compareSemver(a: string, b: string): number {
	return Bun.semver.order(a, b);
}

/**
 * Resolve the installed `@gajae-code/natives` package version (the key used for
 * `~/.gjc/natives/<version>/` by the loader). Fail-closed callers should treat
 * an unresolved version as "keep everything".
 */
export async function resolveCurrentNativesVersion(): Promise<string> {
	const mainUrl = import.meta.resolve("@gajae-code/natives");
	const mainPath = fileURLToPath(mainUrl);
	// main is packages/natives/native/index.js → package root is parent of native/
	const packageJsonPath = path.join(path.dirname(mainPath), "..", "package.json");
	const raw = await Bun.file(packageJsonPath).text();
	const parsed = JSON.parse(raw) as { version?: unknown };
	if (typeof parsed.version !== "string" || parsed.version.trim().length === 0) {
		throw new Error(`natives_package_missing_version:${packageJsonPath}`);
	}
	return parsed.version.trim();
}

export async function directoryByteSize(
	root: string,
	maxEntries: number = MAX_SIZE_ENTRIES,
): Promise<{ bytes: number; truncated: boolean }> {
	let bytes = 0;
	let entries = 0;
	let truncated = false;
	const stack: string[] = [root];

	while (stack.length > 0) {
		const current = stack.pop();
		if (!current) break;
		if (entries >= maxEntries) {
			truncated = true;
			break;
		}
		entries++;

		let stat: Awaited<ReturnType<typeof fs.lstat>>;
		try {
			stat = await fs.lstat(current);
		} catch (error) {
			if (isEnoent(error)) continue;
			// Permission or other errors: count what we have so far; caller may still keep.
			truncated = true;
			continue;
		}

		if (stat.isSymbolicLink()) {
			// Do not follow symlinks; count the link node only (size often 0 on some FS).
			bytes += stat.size;
			continue;
		}
		if (stat.isFile()) {
			bytes += stat.size;
			continue;
		}
		if (!stat.isDirectory()) {
			bytes += stat.size;
			continue;
		}

		let children: string[];
		try {
			children = await fs.readdir(current);
		} catch {
			truncated = true;
			continue;
		}
		for (const name of children) stack.push(path.join(current, name));
	}

	return { bytes, truncated };
}

/**
 * Classify version directories under nativesDir.
 *
 * Keep set = { current } ∪ top `keepVersions` versions strictly older than current.
 * Also keep: non-semver names, versions newer than current, unreadable entries.
 */
export async function collectNativesVersionCandidates(
	options: GcDiskCollectOptions,
): Promise<{ candidates: GcDiskCandidate[]; errors: GcDiskReport["errors"] }> {
	const candidates: GcDiskCandidate[] = [];
	const errors: GcDiskReport["errors"] = [];
	const { nativesDir, currentNativesVersion, keepVersions } = options;

	if (!Number.isInteger(keepVersions) || keepVersions < 0) {
		errors.push({
			surface: "natives_versions",
			scope: "policy",
			message: `invalid_keep_versions:${keepVersions}`,
		});
		return { candidates, errors };
	}

	if (!isOrderableSemver(currentNativesVersion)) {
		errors.push({
			surface: "natives_versions",
			scope: "policy",
			message: `invalid_current_natives_version:${currentNativesVersion}`,
		});
		return { candidates, errors };
	}

	let dirents: string[];
	try {
		dirents = await fs.readdir(nativesDir);
	} catch (error) {
		if (isEnoent(error)) return { candidates, errors };
		errors.push({
			surface: "natives_versions",
			scope: nativesDir,
			message: error instanceof Error ? error.message : String(error),
		});
		return { candidates, errors };
	}

	const versionDirs: Array<{ version: string; path: string }> = [];
	for (const name of dirents) {
		const full = path.join(nativesDir, name);
		let stat: Awaited<ReturnType<typeof fs.lstat>>;
		try {
			stat = await fs.lstat(full);
		} catch (error) {
			if (isEnoent(error)) continue;
			candidates.push({
				surface: "natives_versions",
				id: name,
				path: full,
				bytes: 0,
				status: "unreadable",
				removable: false,
				action: "none",
				reason: "natives_version_unreadable",
				detail: error instanceof Error ? error.message : String(error),
			});
			continue;
		}

		if (!stat.isDirectory() || stat.isSymbolicLink()) {
			// Only plain version directories are reclaimable; leave files/symlinks alone.
			candidates.push({
				surface: "natives_versions",
				id: name,
				path: full,
				bytes: 0,
				status: "non_directory",
				removable: false,
				action: "none",
				reason: "natives_entry_not_a_version_directory",
			});
			continue;
		}

		if (!isOrderableSemver(name)) {
			candidates.push({
				surface: "natives_versions",
				id: name,
				path: full,
				bytes: 0,
				status: "non_semver",
				removable: false,
				action: "none",
				reason: "natives_version_not_orderable_semver",
			});
			continue;
		}

		versionDirs.push({ version: name, path: full });
	}

	const older = versionDirs
		.filter(v => compareSemver(v.version, currentNativesVersion) < 0)
		.sort((a, b) => compareSemver(b.version, a.version));
	const keptOlder = new Set(older.slice(0, keepVersions).map(v => v.version));

	for (const entry of versionDirs) {
		const size = await directoryByteSize(entry.path);
		const sizeDetail = size.truncated ? "size_walk_truncated" : undefined;

		if (entry.version === currentNativesVersion) {
			candidates.push({
				surface: "natives_versions",
				id: entry.version,
				path: entry.path,
				bytes: size.bytes,
				bytes_truncated: size.truncated || undefined,
				status: "current",
				removable: false,
				action: "none",
				reason: "natives_current_version",
				detail: sizeDetail,
			});
			continue;
		}

		if (compareSemver(entry.version, currentNativesVersion) > 0) {
			candidates.push({
				surface: "natives_versions",
				id: entry.version,
				path: entry.path,
				bytes: size.bytes,
				bytes_truncated: size.truncated || undefined,
				status: "newer_than_current",
				removable: false,
				action: "none",
				reason: "natives_version_newer_than_running",
				detail: sizeDetail,
			});
			continue;
		}

		if (keptOlder.has(entry.version)) {
			const rank = older.findIndex(v => v.version === entry.version) + 1;
			candidates.push({
				surface: "natives_versions",
				id: entry.version,
				path: entry.path,
				bytes: size.bytes,
				bytes_truncated: size.truncated || undefined,
				status: "retained_predecessor",
				removable: false,
				action: "none",
				reason: "natives_predecessor_within_keep_versions",
				detail: [sizeDetail, `predecessor_rank=${rank}`, `keep_versions=${keepVersions}`].filter(Boolean).join(" "),
			});
			continue;
		}

		candidates.push({
			surface: "natives_versions",
			id: entry.version,
			path: entry.path,
			bytes: size.bytes,
			bytes_truncated: size.truncated || undefined,
			status: "excess_predecessor",
			removable: true,
			action: "would_remove",
			reason: "natives_version_beyond_keep_versions",
			detail: [sizeDetail, `keep_versions=${keepVersions}`, `current=${currentNativesVersion}`]
				.filter(Boolean)
				.join(" "),
		});
	}

	// Stable report order: newest first among orderable, then others by id.
	candidates.sort((a, b) => {
		const aOrder = isOrderableSemver(a.id);
		const bOrder = isOrderableSemver(b.id);
		if (aOrder && bOrder) return compareSemver(b.id, a.id);
		if (aOrder !== bOrder) return aOrder ? -1 : 1;
		return a.id.localeCompare(b.id);
	});

	return { candidates, errors };
}

/**
 * Remove a single natives version directory. Re-validates path containment and
 * that the entry is still a directory before deleting (TOCTOU fail-closed).
 */
export async function pruneNativesVersionCandidate(
	candidate: GcDiskCandidate,
	options: Pick<GcDiskCollectOptions, "nativesDir" | "currentNativesVersion">,
): Promise<{ removed: boolean; error?: string; skipped?: string }> {
	if (candidate.surface !== "natives_versions") {
		return { removed: false, skipped: "wrong_surface" };
	}
	if (!candidate.removable) {
		return { removed: false, skipped: "not_removable" };
	}
	if (candidate.id === options.currentNativesVersion) {
		return { removed: false, skipped: "natives_current_version" };
	}

	const resolvedRoot = path.resolve(options.nativesDir);
	const resolvedTarget = path.resolve(candidate.path);
	const relative = path.relative(resolvedRoot, resolvedTarget);
	if (
		relative === "" ||
		relative.startsWith("..") ||
		path.isAbsolute(relative) ||
		relative.includes(path.sep) ||
		relative !== candidate.id
	) {
		return { removed: false, skipped: "path_escape_or_mismatch" };
	}

	try {
		const stat = await fs.lstat(resolvedTarget);
		if (!stat.isDirectory() || stat.isSymbolicLink()) {
			return { removed: false, skipped: "no_longer_a_directory" };
		}
	} catch (error) {
		if (isEnoent(error)) return { removed: false, skipped: "already_absent" };
		return { removed: false, error: error instanceof Error ? error.message : String(error) };
	}

	try {
		await fs.rm(resolvedTarget, { recursive: true, force: false });
		return { removed: true };
	} catch (error) {
		return { removed: false, error: error instanceof Error ? error.message : String(error) };
	}
}

export async function resolveGcDiskCollectOptions(
	deps: GcDiskDeps = {},
	env: NodeJS.ProcessEnv = process.env,
): Promise<GcDiskCollectOptions> {
	const nativesDir = deps.nativesDir?.trim() || env.GJC_NATIVES_DIR?.trim() || getNativesDir();
	const currentNativesVersion = deps.currentNativesVersion?.trim() || (await resolveCurrentNativesVersion());
	const keepVersions = deps.keepVersions !== undefined ? deps.keepVersions : DEFAULT_NATIVES_KEEP_VERSIONS;
	return { nativesDir, currentNativesVersion, keepVersions };
}

/**
 * Collect + optionally prune all disk surfaces for this slice.
 */
export async function collectGcDiskReport(options: GcDiskCollectOptions, prune: boolean): Promise<GcDiskReport> {
	const surfaces = emptySurfaces();
	const errors: GcDiskReport["errors"] = [];

	const natives = await collectNativesVersionCandidates(options);
	surfaces.natives_versions.push(...natives.candidates);
	errors.push(...natives.errors);

	if (prune) {
		for (const candidate of surfaces.natives_versions) {
			if (!candidate.removable) continue;
			const outcome = await pruneNativesVersionCandidate(candidate, options);
			if (outcome.removed) {
				candidate.action = "removed";
				candidate.removed = true;
			} else if (outcome.skipped) {
				candidate.action = "skipped";
				candidate.reason = outcome.skipped;
				candidate.removed = false;
			} else {
				candidate.action = "remove_failed";
				candidate.removed = false;
				candidate.error = outcome.error ?? "remove_failed";
			}
		}
	}

	return {
		dry_run: !prune,
		policy: {
			natives_keep_versions: options.keepVersions,
			natives_current_version: options.currentNativesVersion,
			natives_dir: options.nativesDir,
		},
		surfaces,
		counts: computeDiskCounts(surfaces),
		errors,
	};
}

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const units = ["KiB", "MiB", "GiB", "TiB"] as const;
	let value = bytes / 1024;
	let unitIndex = 0;
	while (value >= 1024 && unitIndex < units.length - 1) {
		value /= 1024;
		unitIndex++;
	}
	const rounded = value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1);
	return `${rounded} ${units[unitIndex]}`;
}
