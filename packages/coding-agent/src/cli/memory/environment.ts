/** Resolve the ambient inputs required by memory commands at the CLI boundary. */

import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { MemoryEnvironment, RepositoryRemote, RepositorySnapshot } from "@gajae-code/memory-core";
import { getAgentDir, getMemoryRootDir } from "@gajae-code/utils";

import type { Settings } from "../../config/settings";
import { resolveSessionIdFromSources, type SessionIdSources } from "../../gjc-runtime/session-resolution";
import { type GitRepository, remote, repo } from "../../utils/git";

export interface MemoryGitDependencies {
	readonly repo: Pick<typeof repo, "resolve">;
	readonly remote: Pick<typeof remote, "list" | "url">;
}

export interface MemoryGitSyncDependencies {
	readonly repo: Pick<typeof repo, "resolveSync">;
	readonly remote: {
		readonly list: (cwd: string) => readonly string[];
		readonly url: (cwd: string, name: string) => string | undefined;
	};
}

export interface MemoryEnvironmentSyncBuildOptions {
	readonly settings: Pick<Settings, "getAgentDir">;
	readonly cwd: string;
	readonly clock?: () => Date;
	readonly asOf?: string | Date | null;
	readonly deterministic?: boolean;
	readonly session?: SessionIdSources;
	readonly sessionSources?: SessionIdSources;
	readonly env?: { readonly GJC_SESSION_ID?: string | undefined };
	readonly git?: MemoryGitSyncDependencies;
}

export interface MemoryEnvironmentBuildOptions {
	readonly settings: Pick<Settings, "getAgentDir">;
	readonly cwd: string;
	readonly clock?: () => Date;
	readonly asOf?: string | Date | null;
	readonly deterministic?: boolean;
	readonly session?: SessionIdSources;
	readonly sessionSources?: SessionIdSources;
	readonly env?: { readonly GJC_SESSION_ID?: string | undefined };
	readonly git?: MemoryGitDependencies;
}

export interface ReadOnlyMemoryEnvironmentBuildOptions extends Omit<MemoryEnvironmentBuildOptions, "settings"> {
	/** Explicit agent directory override for callers that have already resolved it. */
	readonly agentDir?: string;
	/** An already-resolved settings object; it is never loaded by this route. */
	readonly settings?: Pick<Settings, "getAgentDir">;
}

const DEFAULT_GIT: MemoryGitDependencies = { repo, remote };

function runGitSync(cwd: string, args: readonly string[]): string | null {
	try {
		const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore" });
		if (result.exitCode !== 0) return null;
		return new TextDecoder().decode(result.stdout).trim();
	} catch {
		return null;
	}
}

function listGitRemotesSync(cwd: string): readonly string[] {
	const output = runGitSync(cwd, ["remote"]);
	if (output === null) throw new Error("memory remote discovery failed");
	return output.split(/\r?\n/).filter(name => name.length > 0);
}

function gitRemoteUrlSync(cwd: string, name: string): string | undefined {
	const output = runGitSync(cwd, ["remote", "get-url", name]);
	return output === null || output.length === 0 ? undefined : output;
}

const DEFAULT_GIT_SYNC: MemoryGitSyncDependencies = {
	repo,
	remote: {
		list: listGitRemotesSync,
		url: gitRemoteUrlSync,
	},
};

async function canonicalPath(target: string): Promise<string> {
	try {
		return await fs.realpath(target);
	} catch {
		return path.resolve(target);
	}
}
function canonicalPathSync(target: string): string {
	try {
		return fsSync.realpathSync(target);
	} catch {
		return path.resolve(target);
	}
}

function sessionSources(options: {
	readonly session?: SessionIdSources;
	readonly sessionSources?: SessionIdSources;
	readonly env?: { readonly GJC_SESSION_ID?: string | undefined };
}): SessionIdSources {
	const sources = options.sessionSources ?? options.session ?? {};
	return {
		flagValue: sources.flagValue,
		payloadSessionId: sources.payloadSessionId,
		envSessionId: sources.envSessionId ?? (options.env ?? process.env).GJC_SESSION_ID,
	};
}

function resolveAsOf(now: Date, asOf: string | Date | null | undefined, deterministic: boolean): string | null {
	if (asOf instanceof Date) return asOf.toISOString();
	if (asOf !== undefined) return asOf;
	return deterministic ? now.toISOString() : null;
}

async function remoteSnapshot(cwd: string, git: MemoryGitDependencies): Promise<readonly RepositoryRemote[]> {
	const names = await git.remote.list(cwd);
	const remotes = await Promise.all(
		names.map(async name => {
			const url = await git.remote.url(cwd, name);
			if (typeof url !== "string" || url.length === 0) return null;
			return { name, url } satisfies RepositoryRemote;
		}),
	);
	return remotes.filter((value): value is RepositoryRemote => value !== null);
}
function remoteSnapshotSync(cwd: string, git: MemoryGitSyncDependencies): readonly RepositoryRemote[] {
	return git.remote
		.list(cwd)
		.map(name => {
			const url = git.remote.url(cwd, name);
			if (typeof url !== "string" || url.length === 0) return null;
			return { name, url } satisfies RepositoryRemote;
		})
		.filter((value): value is RepositoryRemote => value !== null);
}

/** Build the repository snapshot consumed by memory-core without probing it there. */
export async function buildRepositorySnapshot(
	cwd: string,
	git: MemoryGitDependencies = DEFAULT_GIT,
): Promise<RepositorySnapshot | null> {
	const repository: GitRepository | null = await git.repo.resolve(cwd);
	if (repository === null) return null;

	const [worktreeRoot, commonDir, gitDir, remotes] = await Promise.all([
		canonicalPath(repository.repoRoot),
		canonicalPath(repository.commonDir),
		canonicalPath(repository.gitDir),
		remoteSnapshot(cwd, git),
	]);

	return {
		worktreeRoot,
		commonDir,
		isLinkedWorktree: gitDir !== commonDir,
		remotes,
	};
}

/** Build a synchronous repository snapshot with the same normalization as the async boundary. */
export function buildRepositorySnapshotSync(
	cwd: string,
	git: MemoryGitSyncDependencies = DEFAULT_GIT_SYNC,
): RepositorySnapshot | null {
	const repository: GitRepository | null = git.repo.resolveSync(cwd);
	if (repository === null) return null;

	const worktreeRoot = canonicalPathSync(repository.repoRoot);
	const commonDir = canonicalPathSync(repository.commonDir);
	const gitDir = canonicalPathSync(repository.gitDir);
	const remotes = remoteSnapshotSync(cwd, git);

	return {
		worktreeRoot,
		commonDir,
		isLinkedWorktree: gitDir !== commonDir,
		remotes,
	};
}

/** Build a complete memory environment from explicit, injectable boundary inputs. */
export async function buildMemoryEnvironment(options: MemoryEnvironmentBuildOptions): Promise<MemoryEnvironment> {
	const now = options.clock?.() ?? new Date();
	const deterministic = options.deterministic ?? false;
	const session = resolveSessionIdFromSources(sessionSources(options));
	const repository = await buildRepositorySnapshot(options.cwd, options.git);

	return {
		memoryRoot: getMemoryRootDir(options.settings.getAgentDir()),
		repository,
		sessionId: session?.gjcSessionId ?? null,
		now,
		deterministic,
		asOf: resolveAsOf(now, options.asOf, deterministic),
	};
}

/** Build a complete memory environment synchronously for hyperlink resolution. */
export function buildMemoryEnvironmentSync(options: MemoryEnvironmentSyncBuildOptions): MemoryEnvironment {
	const now = options.clock?.() ?? new Date();
	const deterministic = options.deterministic ?? false;
	const session = resolveSessionIdFromSources(sessionSources(options));
	const repository = buildRepositorySnapshotSync(options.cwd, options.git);

	return {
		memoryRoot: getMemoryRootDir(options.settings.getAgentDir()),
		repository,
		sessionId: session?.gjcSessionId ?? null,
		now,
		deterministic,
		asOf: resolveAsOf(now, options.asOf, deterministic),
	};
}

/**
 * Build a memory environment without loading persistent settings.
 *
 * `Settings.loadForScope` has no non-persistent load mode: it opens agent
 * storage and can migrate legacy settings before returning. Read-only memory
 * commands therefore carry only the resolved directory. An explicit
 * `agentDir` (or injected settings object) wins; otherwise `getAgentDir()`
 * preserves the shared `GJC_CODING_AGENT_DIR`/default resolution.
 */
export async function buildReadOnlyMemoryEnvironment(
	options: ReadOnlyMemoryEnvironmentBuildOptions,
): Promise<MemoryEnvironment> {
	const { agentDir, settings, ...environmentOptions } = options;
	const resolvedAgentDir = agentDir ?? settings?.getAgentDir() ?? getAgentDir();
	return buildMemoryEnvironment({
		...environmentOptions,
		settings: { getAgentDir: () => resolvedAgentDir },
	});
}
