import {
	categorizeComputerChangePath,
	isSettingsSchemaPath,
	normalizeRepoPath,
	type UltragoalChangeCategory,
	type UltragoalChangeSet,
	type UltragoalChangeSetPath,
	type UltragoalChangeStatus,
} from "./ultragoal-runtime";

export async function spawnText(
	command: string[],
	options: { cwd: string; timeoutMs?: number },
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
	try {
		const proc = Bun.spawn(command, { cwd: options.cwd, stdout: "pipe", stderr: "pipe" });
		const timeout = setTimeout(() => proc.kill(), options.timeoutMs ?? 5000);
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		clearTimeout(timeout);
		return { ok: exitCode === 0, stdout, stderr };
	} catch (error) {
		return { ok: false, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
	}
}

export async function resolveGitBase(cwd: string, branch?: string): Promise<string> {
	if (branch) {
		const exists = await spawnText(["git", "rev-parse", "--verify", branch], { cwd, timeoutMs: 3000 });
		if (exists.ok) return branch;
	} else {
		// Prefer the NEAREST integration base (the branch this work actually forks
		// from) rather than always `main`. A branch opened against `dev` must be
		// scoped to `dev`; using a stale `main` sweeps in unrelated trunk history
		// and mis-attributes other people's changes to this story (e.g. falsely
		// tripping change-scoped gates). Among existing candidates, pick the one
		// whose merge-base with HEAD is closest to HEAD (fewest commits ahead).
		const candidates = ["origin/dev", "dev", "origin/main", "origin/master", "main", "master"];
		let best: { ref: string; ahead: number } | undefined;
		for (const candidate of candidates) {
			const exists = await spawnText(["git", "rev-parse", "--verify", candidate], { cwd, timeoutMs: 3000 });
			if (!exists.ok) continue;
			const mergeBase = await spawnText(["git", "merge-base", "HEAD", candidate], { cwd, timeoutMs: 3000 });
			if (!mergeBase.ok || !mergeBase.stdout.trim()) continue;
			const count = await spawnText(["git", "rev-list", "--count", `${mergeBase.stdout.trim()}..HEAD`], {
				cwd,
				timeoutMs: 3000,
			});
			const ahead = Number.parseInt(count.stdout.trim(), 10);
			if (!Number.isFinite(ahead)) continue;
			if (!best || ahead < best.ahead) best = { ref: candidate, ahead };
		}
		if (best) return best.ref;
	}
	const mergeBase = await spawnText(["git", "merge-base", "HEAD", "origin/main"], { cwd, timeoutMs: 3000 });
	if (mergeBase.ok && mergeBase.stdout.trim()) return mergeBase.stdout.trim();
	return "HEAD~1";
}

export function parseGitNameStatus(output: string): UltragoalChangeSetPath[] {
	const rows: UltragoalChangeSetPath[] = [];
	for (const line of output.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const parts = trimmed.split(/\s+/);
		const statusCode = parts[0] ?? "";
		let status: UltragoalChangeStatus = "unknown";
		if (statusCode.startsWith("A")) status = "added";
		else if (statusCode.startsWith("M")) status = "modified";
		else if (statusCode.startsWith("D")) status = "deleted";
		else if (statusCode.startsWith("R")) status = "renamed";
		else if (statusCode.startsWith("C")) status = "copied";
		const pathValue = status === "renamed" || status === "copied" ? parts[2] : parts[1];
		if (!pathValue) continue;
		const oldPath = status === "renamed" || status === "copied" ? parts[1] : undefined;
		rows.push({
			path: normalizeRepoPath(pathValue),
			oldPath: oldPath ? normalizeRepoPath(oldPath) : undefined,
			status,
			category: categorizeComputerChangePath(pathValue),
		});
	}
	return rows;
}

function categorizeCiChangedPath(value: string): UltragoalChangeCategory {
	// CI_DEV_CHANGED_PATHS intentionally carries path names only. Mixed registries
	// such as settings-schema.ts require diff-level narrowing; without the diff,
	// treating the whole registry as computer-control source forces the mandatory
	// computer red-team suite on unrelated settings changes.
	if (isSettingsSchemaPath(value)) return "other";
	return categorizeComputerChangePath(value);
}

function ciDevChangedPathRows(): UltragoalChangeSetPath[] {
	const raw = process.env.CI_DEV_CHANGED_PATHS;
	if (!raw) return [];
	return raw
		.split(/\r?\n/)
		.map(row => row.trim())
		.filter(Boolean)
		.map(pathValue => ({
			path: normalizeRepoPath(pathValue),
			status: "unknown" as UltragoalChangeStatus,
			category: categorizeCiChangedPath(pathValue),
		}));
}

function mergeChangeSetPaths(groups: UltragoalChangeSetPath[][]): UltragoalChangeSetPath[] {
	const byKey = new Map<string, UltragoalChangeSetPath>();
	for (const row of groups.flat()) byKey.set(`${row.oldPath ?? ""}\u0000${row.path}`, row);
	return [...byKey.values()];
}

export async function computeCheckpointChangeSet(cwd: string): Promise<UltragoalChangeSet | undefined> {
	const ciChangedPaths = ciDevChangedPathRows();
	const inGit = await spawnText(["git", "rev-parse", "--is-inside-work-tree"], { cwd, timeoutMs: 3000 });
	if (!inGit.ok || inGit.stdout.trim() !== "true") {
		if (ciChangedPaths.length === 0) return undefined;
		return { source: "checkpoint-git", paths: ciChangedPaths, trusted: true };
	}
	const baseRef = await resolveGitBase(cwd);
	const base = baseRef;
	const mergeBase = await spawnText(["git", "merge-base", "HEAD", baseRef], { cwd, timeoutMs: 3000 });
	const [committed, unstaged, staged, stat, committedDiff, unstagedDiff, stagedDiff] = await Promise.all([
		spawnText(["git", "diff", "--name-status", `${base}...HEAD`], { cwd, timeoutMs: 5000 }),
		spawnText(["git", "diff", "--name-status"], { cwd, timeoutMs: 5000 }),
		spawnText(["git", "diff", "--cached", "--name-status"], { cwd, timeoutMs: 5000 }),
		spawnText(["git", "diff", "--stat", `${base}...HEAD`], { cwd, timeoutMs: 5000 }),
		spawnText(["git", "diff", `${base}...HEAD`], { cwd, timeoutMs: 5000 }),
		spawnText(["git", "diff"], { cwd, timeoutMs: 5000 }),
		spawnText(["git", "diff", "--cached"], { cwd, timeoutMs: 5000 }),
	]);
	if (!committed.ok && !unstaged.ok && !staged.ok && ciChangedPaths.length === 0) return undefined;
	const gitPaths = mergeChangeSetPaths([
		parseGitNameStatus(committed.stdout),
		parseGitNameStatus(unstaged.stdout),
		parseGitNameStatus(staged.stdout),
	]);
	const paths = gitPaths.length > 0 ? gitPaths : ciChangedPaths;
	return {
		source: "checkpoint-git",
		baseRef,
		mergeBase: mergeBase.ok && mergeBase.stdout.trim() ? mergeBase.stdout.trim() : undefined,
		headRef: "HEAD",
		paths,
		rawDiffStat: stat.stdout,
		rawDiff: [committedDiff.stdout, unstagedDiff.stdout, stagedDiff.stdout].filter(Boolean).join("\n"),
		trusted: true,
	};
}

export function parseUnifiedDiffPaths(diff: string): UltragoalChangeSetPath[] {
	const paths: UltragoalChangeSetPath[] = [];
	for (const line of diff.split("\n")) {
		if (!line.startsWith("diff --git ")) continue;
		const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
		if (!match) continue;
		const oldPath = normalizeRepoPath(match[1]!);
		const newPath = normalizeRepoPath(match[2]!);
		paths.push({
			path: newPath,
			oldPath: oldPath === newPath ? undefined : oldPath,
			status: oldPath === newPath ? "modified" : "renamed",
			category: categorizeComputerChangePath(newPath),
		});
	}
	return paths;
}
