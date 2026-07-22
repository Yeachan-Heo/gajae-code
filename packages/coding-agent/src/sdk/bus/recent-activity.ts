/**
 * Recent-activity session picker (G006).
 *
 * Ranks GJC sessions by session-history file mtime (most recent first) and
 * enriches each with terminal-breadcrumb info, so a remote lifecycle client can
 * pick a repo to create in or a recent session to resume without typing raw
 * paths. Dependency-light + injectable so it is unit-testable over a temp dir.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { verifyOwnerOnlyPathSecurity } from "@gajae-code/natives";
import { getAgentDir, getSessionsDir } from "@gajae-code/utils";
import { FileSessionStorage, type SessionStorageSnapshot } from "../../session/session-storage";
import {
	type LogicalSessionCandidate,
	listManagedSessionCandidates,
	type ManagedSessionScope,
	resolveManagedSessionScope,
} from "../session-directory";

/** One ranked recent-session entry surfaced to the picker. */
export interface RecentSessionEntry {
	/** Session id from the validated managed candidate header. */
	sessionId: string;
	/** Validated workspace path recorded by the managed candidate. */
	path?: string;
	/** Branch, when recoverable from the header. */
	branch?: string;
	/** A short title (first user message), when recoverable. */
	title?: string;
	/** Absolute path of the session history (state) file. */
	sessionStateFile: string;
	/** Last-activity epoch-millis (history file mtime). */
	mtimeMs: number;
	/** True when a terminal breadcrumb points at this session file. */
	currentTerminal?: boolean;
	/** True when this history is an internal helper/sub-agent session. */
	internal?: boolean;
}

export interface RecentActivityDeps {
	/** Workspace whose managed sessions will be listed readonly. */
	cwd: string;
	/** Agent directory used to resolve the managed session scope. */
	agentDir?: string;
	/** Explicit managed root for isolated tests. */
	sessionsRoot?: string;
	/** Optional breadcrumb session-file paths (current terminals). */
	breadcrumbPaths?: string[];
	/** Max entries to return (default 20). */
	limit?: number;
	/** Include internal helper/sub-agent sessions (default true). */
	includeInternal?: boolean;
	/** Search every validated v2 workspace scope below the session root (default false). */
	allWorkspaces?: boolean;
	/** Injection seam for tests. */
	readInitialLines?: (file: string, maxLines: number) => string[];
}

class ManagedCandidateChangedError extends Error {}
class ManagedCandidateUnavailableError extends Error {}

const CHANGED_CANDIDATE_WARNING = "Ignored managed session candidate that changed during inspection.";

function isAppendExtension(bytes: Uint8Array, candidate: LogicalSessionCandidate): boolean {
	return (
		bytes.byteLength >= candidate.identity.size &&
		createHash("sha256").update(bytes.subarray(0, candidate.identity.size)).digest("hex") ===
			candidate.identity.sha256
	);
}

function readCandidateInitialLines(
	candidate: LogicalSessionCandidate,
	readInitialLines: ((file: string, maxLines: number) => string[]) | undefined,
	appendBase?: LogicalSessionCandidate,
): string[] {
	if (readInitialLines) return readInitialLines(candidate.path, 8);
	if (candidate.provenance !== "legacy") {
		const security = verifyOwnerOnlyPathSecurity(candidate.path, "file");
		if (!security.ok) throw new ManagedCandidateUnavailableError("Managed session metadata path is unsafe.");
	}
	let snapshot: SessionStorageSnapshot;
	try {
		snapshot = new FileSessionStorage().readSnapshotSync(candidate.path);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ELOOP" || code === "ENOTDIR")
			throw new ManagedCandidateUnavailableError("Managed session metadata is unavailable.");
		throw error;
	}
	const sameFile = snapshot.stat.dev === candidate.identity.dev && snapshot.stat.ino === candidate.identity.ino;
	const digest = createHash("sha256").update(snapshot.bytes).digest("hex");
	const exactIdentity =
		sameFile &&
		snapshot.stat.size === candidate.identity.size &&
		snapshot.stat.mtimeNs === candidate.identity.mtimeNs &&
		digest === candidate.identity.sha256;
	if (appendBase && (!sameFile || !isAppendExtension(snapshot.bytes, appendBase)))
		throw new ManagedCandidateUnavailableError("Managed session no longer extends the verified transcript.");
	if (!exactIdentity) {
		if (sameFile && isAppendExtension(snapshot.bytes, candidate))
			throw new ManagedCandidateChangedError("Managed session was appended after ownership was verified.");
		throw new ManagedCandidateUnavailableError("Managed session changed without an append-only extension.");
	}
	return Buffer.from(snapshot.bytes).toString("utf8").split("\n").slice(0, 8);
}

/** Best-effort header metadata extraction from a session file's first line. */
function headerMeta(line: string | undefined): { branch?: string; title?: string } {
	if (!line) return {};
	try {
		const obj = JSON.parse(line) as Record<string, unknown>;
		const branch = typeof obj.branch === "string" ? obj.branch : undefined;
		const title = typeof obj.title === "string" ? obj.title : undefined;
		return { branch, title };
	} catch {
		return {};
	}
}

/** Detect task-tool helper sessions from the durable early session_init metadata entry. */
function isInternalSession(lines: readonly string[]): boolean {
	for (const line of lines.slice(1)) {
		if (!line.trim()) continue;
		try {
			const obj = JSON.parse(line) as unknown;
			if (typeof obj === "object" && obj !== null && (obj as { type?: unknown }).type === "session_init") {
				return true;
			}
		} catch {
			// Ignore malformed JSONL entries; classification is best-effort.
		}
	}
	return false;
}

/** Lists readonly managed candidates, optionally across every validated v2 workspace scope, ranked by history-file mtime. */
export type ListRecentSessionsResult =
	| { kind: "complete"; entries: RecentSessionEntry[]; warnings: readonly string[] }
	| { kind: "error"; code: "scope_unavailable" | "managed_scan_failed"; message: string };

async function resolveRecentScopes(
	deps: RecentActivityDeps,
): Promise<
	| { kind: "complete"; scopes: ManagedSessionScope[]; warnings: string[] }
	| { kind: "error"; code: "scope_unavailable"; message: string }
> {
	const agentDir = deps.agentDir ?? getAgentDir();
	const sessionsRoot = deps.sessionsRoot ?? getSessionsDir(agentDir);
	const current = await resolveManagedSessionScope({
		cwd: deps.cwd,
		agentDir,
		sessionsRoot,
	});
	if (!deps.allWorkspaces) {
		if (current.kind !== "resolved") return { kind: "error", code: "scope_unavailable", message: current.message };
		return { kind: "complete", scopes: [current.scope], warnings: [] };
	}
	try {
		const root = await fs.lstat(sessionsRoot);
		if (!root.isDirectory() || root.isSymbolicLink() || !verifyOwnerOnlyPathSecurity(sessionsRoot, "directory").ok) {
			return {
				kind: "error",
				code: "scope_unavailable",
				message: "The managed sessions root is not a safe directory.",
			};
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "complete", scopes: [], warnings: [] };
		return { kind: "error", code: "scope_unavailable", message: "The managed sessions root could not be inspected." };
	}
	const warnings: string[] = [];
	const scopes = current.kind === "resolved" ? [current.scope] : [];
	const seen = new Set(scopes.map(scope => scope.directoryPath));

	const addResolvedScope = async (cwd: string, expectedDirectory?: string): Promise<void> => {
		const resolved = await resolveManagedSessionScope({
			cwd,
			agentDir,
			sessionsRoot,
		});
		if (resolved.kind !== "resolved") {
			if (resolved.code !== "cwd_missing" && resolved.code !== "cwd_not_directory")
				warnings.push("Ignored invalid managed session scope binding.");
			return;
		}
		if (expectedDirectory !== undefined && resolved.scope.directoryPath !== expectedDirectory) {
			warnings.push("Ignored invalid managed session scope binding.");
			return;
		}
		if (!seen.has(resolved.scope.directoryPath)) {
			seen.add(resolved.scope.directoryPath);
			scopes.push(resolved.scope);
		}
	};
	try {
		const directories = await fs.readdir(sessionsRoot, { withFileTypes: true });
		for (const directory of directories) {
			if (!directory.isDirectory() || directory.isSymbolicLink() || !directory.name.startsWith("v2-")) continue;
			try {
				const binding = JSON.parse(
					await fs.readFile(path.join(sessionsRoot, directory.name, ".gjc-managed-session-scope.v2.json"), "utf8"),
				) as { canonicalPath?: unknown };
				if (typeof binding.canonicalPath !== "string") {
					warnings.push("Ignored invalid managed session scope binding.");
					continue;
				}
				await addResolvedScope(binding.canonicalPath, path.join(sessionsRoot, directory.name));
			} catch {
				warnings.push("Ignored unreadable managed session scope binding.");
			}
		}
		for (const directory of directories) {
			if (!directory.isDirectory() || directory.isSymbolicLink() || directory.name.startsWith("v2-")) continue;
			try {
				const files = await fs.readdir(path.join(sessionsRoot, directory.name), {
					withFileTypes: true,
				});
				for (const file of files) {
					if (!file.isFile() || file.isSymbolicLink() || !file.name.endsWith(".jsonl")) continue;
					try {
						const snapshot = new FileSessionStorage().readSnapshotSync(
							path.join(sessionsRoot, directory.name, file.name),
						);
						const newline = snapshot.bytes.indexOf(0x0a);
						if (newline < 0) continue;
						const header = JSON.parse(Buffer.from(snapshot.bytes.subarray(0, newline)).toString("utf8")) as {
							cwd?: unknown;
							type?: unknown;
						};
						if (header.type === "session" && typeof header.cwd === "string") await addResolvedScope(header.cwd);
					} catch {
						warnings.push("Ignored unreadable legacy managed session candidate.");
					}
				}
			} catch {
				warnings.push("Ignored unreadable legacy managed session directory.");
			}
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "complete", scopes, warnings };
		return { kind: "error", code: "scope_unavailable", message: "The managed sessions root could not be read." };
	}
	return { kind: "complete", scopes, warnings };
}

export async function listRecentSessions(deps: RecentActivityDeps): Promise<ListRecentSessionsResult> {
	const limit = deps.limit ?? 20;
	const includeInternal = deps.includeInternal ?? true;
	const readInitialLines = deps.readInitialLines;
	const breadcrumbs = new Set((deps.breadcrumbPaths ?? []).map(candidate => path.resolve(candidate)));
	const resolved = await resolveRecentScopes(deps);
	if (resolved.kind === "error") return resolved;
	const warnings = [...resolved.warnings];
	const candidates: Array<{ scope: ManagedSessionScope; candidate: LogicalSessionCandidate }> = [];
	for (const scope of resolved.scopes) {
		const listed = await listManagedSessionCandidates({ scope });
		if (listed.kind !== "complete") {
			return { kind: "error", code: "managed_scan_failed", message: listed.message };
		}
		candidates.push(...listed.owned.map(candidate => ({ scope, candidate })));
		warnings.push(
			...listed.invalid
				.filter(
					invalid =>
						!deps.allWorkspaces || (invalid.code !== "cwd_not_found" && invalid.code !== "cwd_not_directory"),
				)
				.map(invalid => `Ignored invalid managed session candidate: ${invalid.code}`),
		);
	}

	const entries: RecentSessionEntry[] = [];
	for (const { scope, candidate } of candidates) {
		let selected = candidate;
		let initialLines: string[] | undefined;
		try {
			initialLines = readCandidateInitialLines(selected, readInitialLines);
		} catch (error) {
			if (error instanceof ManagedCandidateChangedError) {
				const refreshed = await listManagedSessionCandidates({ scope });
				if (refreshed.kind !== "complete")
					return { kind: "error", code: "managed_scan_failed", message: refreshed.message };
				const sameFile = refreshed.owned.find(
					current =>
						path.resolve(current.path) === path.resolve(candidate.path) &&
						current.identity.dev === candidate.identity.dev &&
						current.identity.ino === candidate.identity.ino,
				);
				if (sameFile) {
					try {
						initialLines = readCandidateInitialLines(sameFile, readInitialLines, candidate);
						selected = sameFile;
					} catch (retryError) {
						if (
							!(retryError instanceof ManagedCandidateChangedError) &&
							!(retryError instanceof ManagedCandidateUnavailableError)
						)
							return {
								kind: "error",
								code: "managed_scan_failed",
								message: `Could not read managed session metadata: ${
									retryError instanceof Error ? retryError.message : String(retryError)
								}`,
							};
					}
				}
			} else if (!(error instanceof ManagedCandidateUnavailableError)) {
				return {
					kind: "error",
					code: "managed_scan_failed",
					message: `Could not read managed session metadata: ${
						error instanceof Error ? error.message : String(error)
					}`,
				};
			}
			if (!initialLines) {
				warnings.push(CHANGED_CANDIDATE_WARNING);
				continue;
			}
		}
		const meta = headerMeta(initialLines[0]);
		const internal = isInternalSession(initialLines);
		if (internal && !includeInternal) continue;
		entries.push({
			sessionId: selected.sessionId,
			path: selected.cwd,
			branch: meta.branch,
			title: meta.title,
			sessionStateFile: selected.path,
			mtimeMs: selected.identity.mtimeMs,
			currentTerminal: breadcrumbs.has(path.resolve(selected.path)) || undefined,
			internal: internal || undefined,
		});
	}
	entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
	return {
		kind: "complete",
		entries: entries.slice(0, limit),
		warnings,
	};
}
