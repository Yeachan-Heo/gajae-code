import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getWorktreesDir } from "@gajae-code/utils/dirs";
import { isEnoent } from "@gajae-code/utils/fs-error";

type WorktreeKind = "pr-checkout" | "task-isolation" | "empty" | "stray";

export interface WorktreeEntry {
	/** Absolute path to the worktree dir (or stray container) under `~/.gjc/wt/`. */
	path: string;
	/** Classification of what we found on disk. */
	kind: WorktreeKind;
	/** Parent repo root, when this is a registered git worktree. */
	parentRepo?: string;
	/** Branch name extracted from the parent's tracking file, when available. */
	branch?: string;
	/** When set, the entry is unhealthy and `gjc worktree clear` will remove it. */
	orphanReason?: string;
}

export async function scanWorktrees(root = getWorktreesDir()): Promise<WorktreeEntry[]> {
	let topLevel: string[];
	try {
		topLevel = await fs.readdir(root);
	} catch (err) {
		if (isEnoent(err)) return [];
		throw err;
	}

	const entries: WorktreeEntry[] = [];
	for (const name of topLevel) {
		const dir = path.join(root, name);
		const stat = await fs.stat(dir).catch(() => null);
		if (!stat?.isDirectory()) continue;

		const direct = await classifyDir(dir);
		if (direct) {
			entries.push(direct);
			continue;
		}

		// Legacy nesting: ~/.gjc/wt/<encoded-project>/<branch-or-id>
		let children: string[];
		try {
			children = await fs.readdir(dir);
		} catch {
			continue;
		}
		let nested = 0;
		for (const child of children) {
			const childDir = path.join(dir, child);
			const childStat = await fs.stat(childDir).catch(() => null);
			if (!childStat?.isDirectory()) continue;
			const childClassified = await classifyDir(childDir);
			if (childClassified) {
				entries.push(childClassified);
				nested += 1;
			}
		}
		if (nested === 0) {
			entries.push({
				path: dir,
				kind: children.length === 0 ? "empty" : "stray",
				orphanReason: children.length === 0 ? "empty directory" : "no recognizable worktree contents",
			});
		}
	}
	return entries;
}

async function classifyDir(dir: string): Promise<WorktreeEntry | null> {
	const gitEntry = path.join(dir, ".git");
	const gitStat = await fs.stat(gitEntry).catch(() => null);
	if (gitStat?.isFile()) {
		return classifyPrCheckout(dir, gitEntry);
	}
	const mergedStat = await fs.stat(path.join(dir, "merged")).catch(() => null);
	if (mergedStat?.isDirectory()) {
		return {
			path: dir,
			kind: "task-isolation",
			orphanReason: "task-isolation leftover (no live task owns it)",
		};
	}
	return null;
}

function parseGitDirPointer(contents: string): string | undefined {
	const prefix = "gitdir: ";
	if (!contents.startsWith(prefix)) return undefined;
	const pointer = contents.slice(prefix.length).replace(/[\r\n]+$/, "");
	return pointer.length > 0 && !pointer.includes("\n") ? pointer : undefined;
}

async function classifyPrCheckout(dir: string, gitEntry: string): Promise<WorktreeEntry> {
	let contents: string;
	try {
		contents = await fs.readFile(gitEntry, "utf8");
	} catch (err) {
		return {
			path: dir,
			kind: "pr-checkout",
			orphanReason: `cannot read .git file: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
	const gitDirPointer = parseGitDirPointer(contents);
	if (!gitDirPointer) {
		return { path: dir, kind: "pr-checkout", orphanReason: "malformed .git file (no gitdir line)" };
	}
	const resolvedGitEntry = await fs.realpath(gitEntry).catch(() => gitEntry);
	const parentGitDir = path.resolve(path.dirname(resolvedGitEntry), gitDirPointer);
	// parentGitDir is `<parent-repo>/.git/worktrees/<name>`; back out the repo root.
	const parentRepo = path.dirname(path.dirname(path.dirname(parentGitDir)));
	const branch = await readWorktreeBranch(path.join(parentGitDir, "HEAD"));

	const parentDirStat = await fs.stat(parentGitDir).catch(() => null);
	if (!parentDirStat?.isDirectory()) {
		return {
			path: dir,
			kind: "pr-checkout",
			parentRepo,
			branch,
			orphanReason: "parent repo no longer tracks this worktree",
		};
	}
	const parentRepoStat = await fs.stat(parentRepo).catch(() => null);
	if (!parentRepoStat?.isDirectory()) {
		return {
			path: dir,
			kind: "pr-checkout",
			parentRepo,
			branch,
			orphanReason: "parent repo missing",
		};
	}
	return { path: dir, kind: "pr-checkout", parentRepo, branch };
}

async function readWorktreeBranch(headFile: string): Promise<string | undefined> {
	try {
		const head = (await fs.readFile(headFile, "utf8")).trim();
		const refMatch = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
		return refMatch?.[1];
	} catch {
		return undefined;
	}
}
