/**
 * Debug report bundle creation.
 *
 * Creates a .tar.gz archive with session data, logs, system info, and optional profiling data.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { WorkProfile } from "@gajae-code/natives";
import {
	APP_NAME,
	getEffectiveLogPath,
	getEffectiveLogsDir,
	getLogPath,
	getLogsDir,
	getReportsDir,
	isEnoent,
	resolveEquivalentPath,
} from "@gajae-code/utils";
import type { CpuProfile, HeapSnapshot } from "./profiler";
import { collectSystemInfo, sanitizeEnv } from "./system-info";

/** Maximum number of log lines to load into memory at once. */
const MAX_LOG_LINES = 5000;

/** Maximum bytes to read from the tail of a log file (2 MB). */
const MAX_LOG_BYTES = 2 * 1024 * 1024;
/** Read last N lines from a file, reading at most `maxBytes` from the tail. */
async function readLastLines(filePath: string, n: number, maxBytes = MAX_LOG_BYTES): Promise<string> {
	try {
		const file = Bun.file(filePath);
		const size = file.size;
		const start = Math.max(0, size - maxBytes);
		const content = start > 0 ? await file.slice(start, size).text() : await file.text();
		const lines = content.split("\n");
		// If we sliced mid-file, drop the first (partial) line
		if (start > 0 && lines.length > 0) {
			lines.shift();
		}
		return lines.slice(-n).join("\n");
	} catch (err) {
		if (isEnoent(err)) return "";
		throw err;
	}
}

/**
 * Both log directories can legitimately hold dated `gjc.<date>.log` files, and a
 * reader that consults only one of them is wrong in one direction or the other.
 *
 * The *effective* directory is where this process writes — a trusted
 * `GJC_LOG_DIR` pin, which the test preload sets to a per-process temp sink
 * (issue #5618). The *canonical* directory is the config root, which carries
 * history: previous runs, other processes, and anything written through
 * `getLogsDir()` before this process pinned anything.
 *
 * Deduplicated by equivalent path, effective first. In production — and in any
 * process that never pinned `GJC_LOG_DIR` — the two resolve to the same
 * directory and this collapses to the single entry these readers have always
 * used, so nothing is listed twice and no ordering changes.
 */
function logSearchDirs(): string[] {
	const dirs: string[] = [];
	for (const resolve of [getEffectiveLogsDir, getLogsDir]) {
		const resolved = attemptPath(resolve);
		if (resolved !== undefined && !dirs.includes(resolved)) dirs.push(resolved);
	}
	return dirs;
}

/**
 * Resolve a log path, or `undefined` when it is unavailable.
 *
 * `getLogsDir()`/`getLogPath()` throw when there is no trustworthy home. That
 * must not deny the caller the *other* directory, which a pinned `GJC_LOG_DIR`
 * can still supply.
 */
function attemptPath(resolve: () => string): string | undefined {
	try {
		return resolveEquivalentPath(resolve());
	} catch {
		return undefined;
	}
}

/**
 * Today's log text, oldest content first.
 *
 * Concatenated canonical-then-effective so the tail stays chronological, and the
 * line cap is applied to the COMBINED result: capping per file would let a large
 * history file push this process's own entries out of a bundle that still looks
 * complete. When the two paths are the same file — production, and any process
 * without a `GJC_LOG_DIR` pin — this is a single read of exactly the bytes the
 * previous single-path implementation returned.
 */
async function readTodayLogText(maxLines: number): Promise<string> {
	const parts: string[] = [];
	const seen = new Set<string>();
	for (const resolve of [getLogPath, getEffectiveLogPath]) {
		const candidate = attemptPath(resolve);
		if (candidate === undefined || seen.has(candidate)) continue;
		seen.add(candidate);
		const text = await readLastLines(candidate, maxLines);
		if (text.length > 0) parts.push(text);
	}
	const combined = parts.join("\n");
	const lines = combined.split("\n");
	return lines.length > maxLines ? lines.slice(-maxLines).join("\n") : combined;
}

export interface ReportBundleOptions {
	/** Session file path */
	sessionFile: string | undefined;
	/** Settings to include */
	settings?: Record<string, unknown>;
	/** CPU profile (for performance reports) */
	cpuProfile?: CpuProfile;
	/** Heap snapshot (for memory reports) */
	heapSnapshot?: HeapSnapshot;
	/** Work profile (for work scheduling reports) */
	workProfile?: WorkProfile;
}

export interface ReportBundleResult {
	path: string;
	files: string[];
}

export interface DebugLogSource {
	getInitialText(): Promise<string>;
	hasOlderLogs(): boolean;
	loadOlderLogs(limitDays?: number): Promise<string>;
}

/**
 * Create a debug report bundle.
 *
 * Bundle contents:
 * - session.jsonl: Current session transcript
 * - artifacts/: Session artifacts directory
 * - subagents/: Subagent sessions + artifacts
 * - logs.txt: Recent log entries
 * - system.json: OS, arch, CPU, memory, versions
 * - env.json: Sanitized environment variables
 * - config.json: Resolved settings
 * - profile.cpuprofile: CPU profile (performance report only)
 * - profile.md: Markdown CPU profile (performance report only)
 * - heap.heapsnapshot: Heap snapshot (memory report only)
 * - work.folded: Work profile folded stacks (work report only)
 * - work.md: Work profile summary (work report only)
 * - work.svg: Work profile flamegraph (work report only)
 */
export async function createReportBundle(options: ReportBundleOptions): Promise<ReportBundleResult> {
	const reportsDir = getReportsDir();
	await fs.mkdir(reportsDir, { recursive: true });

	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	const outputPath = path.join(reportsDir, `gjc-report-${timestamp}.tar.gz`);

	const data: Record<string, string> = {};
	const files: string[] = [];

	// Collect system info
	const systemInfo = await collectSystemInfo();
	data["system.json"] = JSON.stringify(systemInfo, null, 2);
	files.push("system.json");

	// Sanitized environment
	data["env.json"] = JSON.stringify(sanitizeEnv(Bun.env as Record<string, string>), null, 2);
	files.push("env.json");

	// Settings/config
	if (options.settings) {
		data["config.json"] = JSON.stringify(options.settings, null, 2);
		files.push("config.json");
	}

	// Recent logs (last 1000 lines, across both log directories)
	const logs = await readTodayLogText(1000);
	if (logs) {
		data["logs.txt"] = logs;
		files.push("logs.txt");
	}

	// Session file
	if (options.sessionFile) {
		try {
			const sessionContent = await Bun.file(options.sessionFile).text();
			data["session.jsonl"] = sessionContent;
			files.push("session.jsonl");
		} catch {
			// Session file might not exist yet
		}

		// Artifacts directory (same path without .jsonl)
		const artifactsDir = options.sessionFile.slice(0, -6);
		await addDirectoryToArchive(data, files, artifactsDir, "artifacts");

		// Look for subagent sessions in the same directory
		const sessionDir = path.dirname(options.sessionFile);
		const sessionBasename = path.basename(options.sessionFile, ".jsonl");
		await addSubagentSessions(data, files, sessionDir, sessionBasename);
	}

	// CPU profile
	if (options.cpuProfile) {
		data["profile.cpuprofile"] = options.cpuProfile.data;
		files.push("profile.cpuprofile");
		data["profile.md"] = options.cpuProfile.markdown;
		files.push("profile.md");
	}

	// Heap snapshot
	if (options.heapSnapshot) {
		data["heap.heapsnapshot"] = options.heapSnapshot.data;
		files.push("heap.heapsnapshot");
	}

	// Work profile
	if (options.workProfile) {
		data["work.folded"] = options.workProfile.folded;
		files.push("work.folded");
		data["work.md"] = options.workProfile.summary;
		files.push("work.md");
		if (options.workProfile.svg) {
			data["work.svg"] = options.workProfile.svg;
			files.push("work.svg");
		}
	}

	// Write archive
	await Bun.Archive.write(outputPath, data, { compress: "gzip" });

	return { path: outputPath, files };
}

/** Add all files from a directory to the archive */
async function addDirectoryToArchive(
	data: Record<string, string>,
	files: string[],
	dirPath: string,
	archivePrefix: string,
): Promise<void> {
	try {
		const entries = await fs.readdir(dirPath, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isFile()) continue;
			const filePath = path.join(dirPath, entry.name);
			const archivePath = `${archivePrefix}/${entry.name}`;
			try {
				const content = await Bun.file(filePath).text();
				data[archivePath] = content;
				files.push(archivePath);
			} catch {
				// Skip files we can't read
			}
		}
	} catch {
		// Directory doesn't exist
	}
}

/** Find and add subagent session files */
async function addSubagentSessions(
	data: Record<string, string>,
	files: string[],
	sessionDir: string,
	parentBasename: string,
): Promise<void> {
	// Subagent sessions are named with task IDs in the same directory
	// They follow the pattern: {timestamp}_{sessionId}.jsonl
	// We look for any sessions created after the parent session
	try {
		const entries = await fs.readdir(sessionDir, { withFileTypes: true });
		const sessionFiles = entries
			.filter(e => e.isFile() && e.name.endsWith(".jsonl") && e.name !== `${parentBasename}.jsonl`)
			.map(e => e.name);

		// Limit to most recent 10 subagent sessions
		const sortedFiles = sessionFiles.sort().slice(-10);

		for (const filename of sortedFiles) {
			const filePath = path.join(sessionDir, filename);
			const archivePath = `subagents/${filename}`;
			try {
				const content = await Bun.file(filePath).text();
				data[archivePath] = content;
				files.push(archivePath);

				// Also add artifacts for this subagent session
				const artifactsDir = filePath.slice(0, -6);
				await addDirectoryToArchive(data, files, artifactsDir, `subagents/${filename.slice(0, -6)}`);
			} catch {
				// Skip files we can't read
			}
		}
	} catch {
		// Directory doesn't exist
	}
}

/** Get recent log entries for display (tail-limited to avoid OOM on large files). */
export async function getLogText(): Promise<string> {
	return readTodayLogText(MAX_LOG_LINES);
}

const LOG_FILE_PATTERN = new RegExp(`^${APP_NAME}\\.(\\d{4}-\\d{2}-\\d{2})\\.log$`);

/**
 * Today's log file: the one this process is writing when it exists, else the
 * canonical one. Both spellings share a basename, so the "is this today's file"
 * filter below is unaffected by which is chosen.
 */
async function resolveTodayLogPath(): Promise<string> {
	const effective = getEffectiveLogPath();
	if (await Bun.file(effective).exists()) return effective;
	const canonical = attemptPath(getLogPath);
	if (canonical !== undefined && (await Bun.file(canonical).exists())) return canonical;
	return effective;
}

export async function createDebugLogSource(): Promise<DebugLogSource> {
	const todayPath = await resolveTodayLogPath();
	const todayName = path.basename(todayPath);
	// Absolute paths, not bare names: entries can come from either log directory
	// (see {@link logSearchDirs}), so the name alone no longer locates the file.
	const olderFiles: string[] = [];
	const dated: { path: string; date: string }[] = [];
	const seen = new Set<string>();
	for (const dir of logSearchDirs()) {
		// A missing directory contributes nothing; the other one may still exist.
		const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
		for (const entry of entries) {
			if (!entry.isFile()) continue;
			const match = LOG_FILE_PATTERN.exec(entry.name);
			if (!match || entry.name === todayName) continue;
			const filePath = path.join(dir, entry.name);
			if (seen.has(filePath)) continue;
			seen.add(filePath);
			dated.push({ path: filePath, date: match[1]! });
		}
	}
	// Newest first. `sort` is stable, so same-date files keep the directory order
	// above (effective before canonical) and the single-directory case is ordered
	// exactly as it was before the second directory was added.
	dated.sort((a, b) => b.date.localeCompare(a.date));
	olderFiles.push(...dated.map(entry => entry.path));

	let cursor = 0;

	const getInitialText = async (): Promise<string> => {
		return readLastLines(todayPath, MAX_LOG_LINES);
	};

	const hasOlderLogs = (): boolean => cursor < olderFiles.length;

	const loadOlderLogs = async (limitDays: number = 1): Promise<string> => {
		if (!hasOlderLogs()) {
			return "";
		}
		const count = Math.max(1, limitDays);
		const slice = olderFiles.slice(cursor, cursor + count);
		cursor += slice.length;
		const chunks: string[] = [];
		for (const filePath of slice.reverse()) {
			try {
				const content = await readLastLines(filePath, MAX_LOG_LINES);
				if (content.length > 0) {
					chunks.push(content);
				}
			} catch (err) {
				if (!isEnoent(err)) {
					throw err;
				}
			}
		}
		return chunks.filter(chunk => chunk.length > 0).join("\n");
	};

	return {
		getInitialText,
		hasOlderLogs,
		loadOlderLogs,
	};
}

/** Calculate total size of artifact cache */
export async function getArtifactCacheStats(
	sessionsDir: string,
): Promise<{ count: number; totalSize: number; oldestDate: Date | null }> {
	let count = 0;
	let totalSize = 0;
	let oldestDate: Date | null = null;

	try {
		const sessions = await fs.readdir(sessionsDir, { withFileTypes: true });

		for (const session of sessions) {
			// Artifact directories don't have .jsonl extension
			if (session.isDirectory()) {
				const dirPath = path.join(sessionsDir, session.name);
				try {
					const stat = await fs.stat(dirPath);
					const files = await fs.readdir(dirPath);
					for (const file of files) {
						const filePath = path.join(dirPath, file);
						const fileStat = await fs.stat(filePath);
						if (fileStat.isFile()) {
							count++;
							totalSize += fileStat.size;
						}
					}
					if (!oldestDate || stat.mtime < oldestDate) {
						oldestDate = stat.mtime;
					}
				} catch {
					// Skip inaccessible directories
				}
			}
		}
	} catch {
		// Directory doesn't exist
	}

	return { count, totalSize, oldestDate };
}

/** Clear artifact cache older than N days */
export async function clearArtifactCache(sessionsDir: string, daysOld: number = 30): Promise<{ removed: number }> {
	const cutoff = new Date();
	cutoff.setDate(cutoff.getDate() - daysOld);
	let removed = 0;

	try {
		const sessions = await fs.readdir(sessionsDir, { withFileTypes: true });

		for (const session of sessions) {
			if (session.isDirectory()) {
				const dirPath = path.join(sessionsDir, session.name);
				try {
					const stat = await fs.stat(dirPath);
					if (stat.mtime < cutoff) {
						await fs.rm(dirPath, { recursive: true, force: true });
						removed++;
					}
				} catch {
					// Skip inaccessible directories
				}
			}
		}
	} catch {
		// Directory doesn't exist
	}

	return { removed };
}
