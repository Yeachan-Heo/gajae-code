import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $ } from "bun";

/** Physical workspace identity, independent of a UI's session-storage directory. */
export interface SessionFamilyWorkspace {
	readonly cwd: string;
	readonly root: string;
	readonly device: string;
	readonly inode: string;
	readonly gitCommonDirectory: string | null;
}

export class SessionFamilyWorkspaceError extends Error {
	readonly code: "uncertain" | "identity_conflict";

	constructor(code: "uncertain" | "identity_conflict", message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "SessionFamilyWorkspaceError";
		this.code = code;
	}
}

function containsPath(parent: string, child: string): boolean {
	const relative = path.relative(parent, child);
	return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

/** Different worktrees are distinct roots; sharing a Git object database does not alias their files. */
export function sessionFamilyWorkspacesOverlap(left: SessionFamilyWorkspace, right: SessionFamilyWorkspace): boolean {
	return (
		(left.device === right.device && left.inode === right.inode) ||
		containsPath(left.root, right.root) ||
		containsPath(right.root, left.root)
	);
}

async function exists(file: string): Promise<boolean> {
	try {
		await fs.lstat(file);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

async function gitMarker(cwd: string): Promise<string | undefined> {
	for (let current = cwd; ; current = path.dirname(current)) {
		if (await exists(path.join(current, ".git"))) return current;
		// A bare repository has no ordinary working-tree root. Never misclassify it
		// as an unrelated non-Git directory merely because it lacks a .git entry.
		if ((await exists(path.join(current, "HEAD"))) && (await exists(path.join(current, "objects")))) {
			throw new SessionFamilyWorkspaceError("uncertain", "A bare or ambiguous Git workspace is unsupported.");
		}
		if (path.dirname(current) === current) return undefined;
	}
}

async function gitPath(cwd: string, selector: "--show-toplevel" | "--git-common-dir"): Promise<string> {
	// Inherited GIT_DIR/GIT_WORK_TREE and command-line config injection can describe
	// a different repository from the actual admitted directory.
	const environment: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined && !key.startsWith("GIT_")) environment[key] = value;
	}
	environment.GIT_OPTIONAL_LOCKS = "0";
	environment.GIT_TERMINAL_PROMPT = "0";
	const result = await $`git rev-parse --path-format=absolute ${selector}`.cwd(cwd).env(environment).nothrow().quiet();
	if (result.exitCode !== 0) {
		throw new SessionFamilyWorkspaceError("uncertain", "Git workspace identity could not be established.");
	}
	const output = result.text();
	const value = output.endsWith("\n") ? output.slice(0, -1) : output;
	if (!path.isAbsolute(value) || value.includes("\0")) {
		throw new SessionFamilyWorkspaceError("uncertain", "Git returned an invalid workspace identity.");
	}
	return await fs.realpath(value);
}

/** No lexical-path or failed-Git fallback is an ownership proof. */
export async function resolveSessionFamilyWorkspace(cwd: string): Promise<SessionFamilyWorkspace> {
	try {
		const canonicalCwd = await fs.realpath(cwd);
		if (!(await fs.stat(canonicalCwd)).isDirectory()) {
			throw new SessionFamilyWorkspaceError("uncertain", "The workspace is not an accessible directory.");
		}
		const marker = await gitMarker(canonicalCwd);
		const root = marker === undefined ? canonicalCwd : await gitPath(canonicalCwd, "--show-toplevel");
		if (!containsPath(root, canonicalCwd) || (marker !== undefined && root !== marker)) {
			throw new SessionFamilyWorkspaceError(
				"identity_conflict",
				"Git and filesystem workspace identities disagree.",
			);
		}
		const gitCommonDirectory = marker === undefined ? null : await gitPath(canonicalCwd, "--git-common-dir");
		const stat = await fs.stat(root, { bigint: true });
		if (!stat.isDirectory()) {
			throw new SessionFamilyWorkspaceError("uncertain", "The workspace root is not an accessible directory.");
		}
		if ((await fs.realpath(cwd)) !== canonicalCwd || (await gitMarker(canonicalCwd)) !== marker) {
			throw new SessionFamilyWorkspaceError("identity_conflict", "Workspace identity changed during inspection.");
		}
		return { cwd: canonicalCwd, root, device: String(stat.dev), inode: String(stat.ino), gitCommonDirectory };
	} catch (error) {
		if (error instanceof SessionFamilyWorkspaceError) throw error;
		throw new SessionFamilyWorkspaceError("uncertain", "Workspace identity could not be established.", {
			cause: error,
		});
	}
}

/** Recheck under the admission transaction, and again before writable initialization. */
export async function assertSessionFamilyWorkspaceUnchanged(expected: SessionFamilyWorkspace): Promise<void> {
	const actual = await resolveSessionFamilyWorkspace(expected.cwd);
	if (
		actual.root !== expected.root ||
		actual.device !== expected.device ||
		actual.inode !== expected.inode ||
		actual.gitCommonDirectory !== expected.gitCommonDirectory
	) {
		throw new SessionFamilyWorkspaceError("identity_conflict", "Workspace authority changed after inspection.");
	}
}
