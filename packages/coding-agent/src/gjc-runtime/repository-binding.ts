/**
 * Authoritative repository/worktree binding for plans and delegated tasks (#2901).
 *
 * Multi-repo parent directories must not let QA/review lanes infer a sibling repo
 * from prose. Bindings carry a validated worktree root + git common-dir identity
 * so spawn/handoff can fail closed on mismatch.
 */
import * as fssync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type GitRepository, head, repo } from "../utils/git";

export const REPOSITORY_BINDING_SCHEMA = "gjc.repository_binding.v1" as const;

export interface RepositoryBinding {
	schema: typeof REPOSITORY_BINDING_SCHEMA;
	/** Canonical realpath of the git worktree root (or resolved cwd root). */
	worktreeRoot: string;
	/** Git common dir realpath when available; null outside a git checkout. */
	commonDir: string | null;
	/** Optional repo-relative subdirectory the lane should operate under. */
	relativeSubdir?: string;
	/** Optional display path (may be non-canonical); never used for authority. */
	displayPath?: string;
	/** Optional baseline HEAD at capture time. */
	head?: string;
	/** Optional branch name at capture time (when not detached). */
	branch?: string;
}

export type RepositoryBindingErrorCode =
	| "not_a_repository"
	| "identity_mismatch"
	| "path_outside_root"
	| "invalid_binding";

export class RepositoryBindingError extends Error {
	readonly code: RepositoryBindingErrorCode;

	constructor(code: RepositoryBindingErrorCode, message: string) {
		super(message);
		this.name = "RepositoryBindingError";
		this.code = code;
	}
}

async function realpathOrResolve(target: string): Promise<string> {
	try {
		return await fs.realpath(target);
	} catch {
		return path.resolve(target);
	}
}

/** Sync realpath for path-under-root checks (handles macOS /var → /private/var). */
function realpathSyncOrResolve(target: string): string {
	try {
		return fssync.realpathSync(target);
	} catch {
		return path.resolve(target);
	}
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** Capture a durable binding from the active cwd/worktree. */
export async function captureRepositoryBinding(
	cwd: string,
	options: { relativeSubdir?: string; displayPath?: string } = {},
): Promise<RepositoryBinding> {
	const resolvedCwd = await realpathOrResolve(cwd);
	const repository = await repo.resolve(resolvedCwd);
	const worktreeRoot = repository ? await realpathOrResolve(repository.repoRoot) : resolvedCwd;
	const commonDir = repository ? await realpathOrResolve(repository.commonDir) : null;

	let headSha: string | undefined;
	let branch: string | undefined;
	if (repository) {
		const headState = await head.resolve(resolvedCwd);
		if (headState) {
			headSha = headState.commit || undefined;
			branch = headState.kind === "ref" ? headState.branchName || undefined : undefined;
		}
	}

	const binding: RepositoryBinding = {
		schema: REPOSITORY_BINDING_SCHEMA,
		worktreeRoot,
		commonDir,
		...(options.relativeSubdir ? { relativeSubdir: normalizeRelativeSubdir(options.relativeSubdir) } : {}),
		...(options.displayPath ? { displayPath: options.displayPath } : {}),
		...(headSha ? { head: headSha } : {}),
		...(branch ? { branch } : {}),
	};
	return binding;
}

function normalizeRelativeSubdir(relative: string): string {
	const normalized = relative
		.replaceAll("\\", "/")
		.replace(/^\.\/+/u, "")
		.replace(/\/+$/u, "");
	if (normalized === "" || normalized === ".") {
		throw new RepositoryBindingError("invalid_binding", "relativeSubdir must be a non-empty relative path");
	}
	if (path.isAbsolute(normalized) || normalized.split("/").includes("..")) {
		throw new RepositoryBindingError("invalid_binding", "relativeSubdir must be repo-relative without '..' segments");
	}
	return normalized;
}

/** Parse a binding from JSON/plan payload; fail closed on malformed shapes. */
export function parseRepositoryBinding(value: unknown): RepositoryBinding {
	if (!isObject(value)) {
		throw new RepositoryBindingError("invalid_binding", "repository binding must be an object");
	}
	const schema = nonEmptyString(value.schema);
	if (schema !== REPOSITORY_BINDING_SCHEMA) {
		throw new RepositoryBindingError(
			"invalid_binding",
			`repository binding schema must be ${REPOSITORY_BINDING_SCHEMA}`,
		);
	}
	const worktreeRoot = nonEmptyString(value.worktreeRoot ?? value.worktree_root);
	if (!worktreeRoot) {
		throw new RepositoryBindingError("invalid_binding", "repository binding requires worktreeRoot");
	}
	const commonDirRaw = value.commonDir ?? value.common_dir;
	const commonDir =
		commonDirRaw === null || commonDirRaw === undefined
			? null
			: (nonEmptyString(commonDirRaw) ??
				(() => {
					throw new RepositoryBindingError("invalid_binding", "commonDir must be a string or null");
				})());
	const relativeSubdirRaw = value.relativeSubdir ?? value.relative_subdir;
	const relativeSubdir =
		relativeSubdirRaw === undefined ? undefined : normalizeRelativeSubdir(String(relativeSubdirRaw));
	const displayPath = nonEmptyString(value.displayPath ?? value.display_path);
	const head = nonEmptyString(value.head);
	const branch = nonEmptyString(value.branch);
	return {
		schema: REPOSITORY_BINDING_SCHEMA,
		worktreeRoot: path.resolve(worktreeRoot),
		commonDir: commonDir === null ? null : path.resolve(commonDir),
		...(relativeSubdir ? { relativeSubdir } : {}),
		...(displayPath ? { displayPath } : {}),
		...(head ? { head } : {}),
		...(branch ? { branch } : {}),
	};
}

/** True when two bindings refer to the same repository identity (linked worktrees ok). */
export function repositoryBindingsMatch(left: RepositoryBinding, right: RepositoryBinding): boolean {
	if (left.commonDir && right.commonDir) {
		return path.resolve(left.commonDir) === path.resolve(right.commonDir);
	}
	// Non-git workspaces: require exact worktree root match.
	return path.resolve(left.worktreeRoot) === path.resolve(right.worktreeRoot);
}

/**
 * Ensure `cwd` is inside the bound repository (or the same linked worktree family).
 * Fails closed on sibling-repo drift.
 */
export async function assertCwdMatchesRepositoryBinding(
	cwd: string,
	binding: RepositoryBinding,
): Promise<RepositoryBinding> {
	const active = await captureRepositoryBinding(cwd);
	if (!repositoryBindingsMatch(active, binding)) {
		throw new RepositoryBindingError(
			"identity_mismatch",
			`Active worktree does not match plan/task repository binding. active=${active.worktreeRoot} (commonDir=${active.commonDir ?? "none"}) bound=${binding.worktreeRoot} (commonDir=${binding.commonDir ?? "none"}).`,
		);
	}
	return active;
}

/** Ensure a declared target path resolves under the bound worktree root. */
export function assertPathUnderRepositoryBinding(binding: RepositoryBinding, targetPath: string): string {
	const root = realpathSyncOrResolve(binding.worktreeRoot);
	const base = binding.relativeSubdir ? realpathSyncOrResolve(path.resolve(root, binding.relativeSubdir)) : root;
	const candidate = path.isAbsolute(targetPath) ? path.resolve(targetPath) : path.resolve(base, targetPath);
	// Prefer realpath when the path exists so macOS /var ↔ /private/var aliases match.
	const resolved = realpathSyncOrResolve(candidate);
	const relative = path.relative(root, resolved);
	if (relative.startsWith("..") || path.isAbsolute(relative)) {
		throw new RepositoryBindingError(
			"path_outside_root",
			`Path escapes bound repository root: ${targetPath} (root=${root})`,
		);
	}
	return resolved;
}

/**
 * Public identity snapshot for receipts/handoffs (no display-only fields required).
 * Always includes the schema + durable roots so downstream lanes can re-verify.
 */
export function publicRepositoryBinding(binding: RepositoryBinding): RepositoryBinding {
	return {
		schema: REPOSITORY_BINDING_SCHEMA,
		worktreeRoot: path.resolve(binding.worktreeRoot),
		commonDir: binding.commonDir === null ? null : path.resolve(binding.commonDir),
		...(binding.relativeSubdir ? { relativeSubdir: binding.relativeSubdir } : {}),
		...(binding.displayPath ? { displayPath: binding.displayPath } : {}),
		...(binding.head ? { head: binding.head } : {}),
		...(binding.branch ? { branch: binding.branch } : {}),
	};
}

/**
 * Resolve the authoritative binding for a delegated task before discovery/spawn.
 *
 * - Missing declaration → stamp from session cwd (never leave authority implicit).
 * - Declared binding → parse + fail closed unless it matches the active session worktree.
 * - relativeSubdir (when present) must resolve under the bound root.
 */
export async function resolveTaskRepositoryBinding(
	sessionCwd: string,
	declared: unknown | undefined,
): Promise<RepositoryBinding> {
	const sessionBinding = await captureRepositoryBinding(sessionCwd, { displayPath: sessionCwd });
	if (declared === undefined || declared === null) {
		return publicRepositoryBinding(sessionBinding);
	}
	const taskBinding = parseRepositoryBinding(declared);
	await assertCwdMatchesRepositoryBinding(sessionCwd, taskBinding);
	if (taskBinding.relativeSubdir) {
		assertPathUnderRepositoryBinding(taskBinding, ".");
	}
	return publicRepositoryBinding(taskBinding);
}

/**
 * Ensure an execution/isolation root (cwd or worktree) still matches the bound identity.
 * Used after isolation workspace creation so linked worktrees keep the source repository.
 */
export async function assertExecutionRootMatchesRepositoryBinding(
	executionRoot: string,
	binding: RepositoryBinding,
): Promise<RepositoryBinding> {
	return await assertCwdMatchesRepositoryBinding(executionRoot, binding);
}

/** Optional helper for tests and diagnostics. */
export function bindingFromGitRepository(
	repository: GitRepository,
	options: { relativeSubdir?: string; displayPath?: string; head?: string; branch?: string } = {},
): RepositoryBinding {
	return {
		schema: REPOSITORY_BINDING_SCHEMA,
		worktreeRoot: path.resolve(repository.repoRoot),
		commonDir: path.resolve(repository.commonDir),
		...(options.relativeSubdir ? { relativeSubdir: normalizeRelativeSubdir(options.relativeSubdir) } : {}),
		...(options.displayPath ? { displayPath: options.displayPath } : {}),
		...(options.head ? { head: options.head } : {}),
		...(options.branch ? { branch: options.branch } : {}),
	};
}
