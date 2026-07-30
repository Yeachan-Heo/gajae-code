import {
	categorizeComputerChangePath,
	normalizeChangeSetPath,
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
		const [stdoutBytes, stderrBytes, exitCode] = await Promise.all([
			new Response(proc.stdout).arrayBuffer(),
			new Response(proc.stderr).arrayBuffer(),
			proc.exited,
		]);
		clearTimeout(timeout);
		let stdout: string;
		try {
			stdout = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(stdoutBytes);
		} catch {
			return { ok: false, stdout: "", stderr: "command stdout was not valid UTF-8" };
		}
		const stderr = new TextDecoder().decode(stderrBytes);
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
	throw new Error("unable to resolve an authoritative integration base");
}

export function parseGitNameStatus(output: string): UltragoalChangeSetPath[] {
	const rows: UltragoalChangeSetPath[] = [];
	const append = (statusCode: string, pathValue: string | undefined, oldPath: string | undefined): void => {
		if (!pathValue) return;
		let status: UltragoalChangeStatus = "unknown";
		if (statusCode.startsWith("A")) status = "added";
		else if (statusCode.startsWith("M")) status = "modified";
		else if (statusCode.startsWith("D")) status = "deleted";
		else if (statusCode.startsWith("R")) status = "renamed";
		else if (statusCode.startsWith("C")) status = "copied";
		rows.push({
			path: normalizeChangeSetPath(pathValue),
			oldPath: oldPath ? normalizeChangeSetPath(oldPath) : undefined,
			status,
			category: categorizeComputerChangePath(pathValue),
		});
	};
	if (output.includes("\0")) {
		const tokens = output.split("\0");
		let index = 0;
		while (index < tokens.length) {
			const statusCode = tokens[index++] ?? "";
			if (!statusCode) continue;
			if (statusCode.startsWith("R") || statusCode.startsWith("C")) {
				const oldPath = tokens[index++];
				append(statusCode, tokens[index++], oldPath);
			} else {
				append(statusCode, tokens[index++], undefined);
			}
		}
		return rows;
	}
	for (const line of output.split("\n")) {
		if (!line.trim()) continue;
		const [rawStatus = "", firstPath, secondPath] = line.split("\t");
		const statusCode = rawStatus.trim();
		append(
			statusCode,
			statusCode.startsWith("R") || statusCode.startsWith("C") ? secondPath : firstPath,
			statusCode.startsWith("R") || statusCode.startsWith("C") ? firstPath : undefined,
		);
	}
	return rows;
}

export function parseGitUntrackedPaths(output: string): UltragoalChangeSetPath[] {
	const paths = output.includes("\0") ? output.split("\0") : output.split(/\r?\n/);
	return paths
		.filter(pathValue => pathValue.length > 0)
		.map(pathValue => ({
			path: normalizeChangeSetPath(pathValue),
			status: "added" as UltragoalChangeStatus,
			category: categorizeComputerChangePath(pathValue),
		}));
}

export function ciDevChangedPathRows(): UltragoalChangeSetPath[] {
	const raw = process.env.CI_DEV_CHANGED_PATHS;
	if (!raw) return [];
	return raw
		.split(/\r?\n/)
		.filter(row => row.length > 0)
		.map(pathValue => ({
			path: normalizeChangeSetPath(pathValue),
			status: "unknown" as UltragoalChangeStatus,
			category: categorizeComputerChangePath(pathValue),
		}));
}

export function mergeChangeSetPaths(groups: UltragoalChangeSetPath[][]): UltragoalChangeSetPath[] {
	const byKey = new Map<string, UltragoalChangeSetPath>();
	for (const row of groups.flat()) byKey.set(`${row.oldPath ?? ""}\u0000${row.path}`, row);
	return [...byKey.values()];
}

export async function computeCheckpointChangeSet(cwd: string): Promise<UltragoalChangeSet | undefined> {
	const ciChangedPaths = ciDevChangedPathRows();
	const inGit = await spawnText(["git", "rev-parse", "--is-inside-work-tree"], { cwd, timeoutMs: 3000 });
	if (!inGit.ok || inGit.stdout.trim() !== "true") {
		if (ciChangedPaths.length === 0)
			return { source: "checkpoint-git", paths: [], captureIncomplete: true, trusted: true };
		return { source: "checkpoint-git", paths: ciChangedPaths, trusted: true };
	}
	const baseRef = await resolveGitBase(cwd);
	const base = baseRef;
	const mergeBase = await spawnText(["git", "merge-base", "HEAD", baseRef], { cwd, timeoutMs: 3000 });
	const [committed, unstaged, staged, untracked, stat, committedDiff, unstagedDiff, stagedDiff] = await Promise.all([
		spawnText(["git", "diff", "--name-status", "-z", `${base}...HEAD`], { cwd, timeoutMs: 5000 }),
		spawnText(["git", "diff", "--name-status", "-z"], { cwd, timeoutMs: 5000 }),
		spawnText(["git", "diff", "--cached", "--name-status", "-z"], { cwd, timeoutMs: 5000 }),
		spawnText(["git", "ls-files", "--others", "--exclude-standard", "-z"], { cwd, timeoutMs: 5000 }),
		spawnText(["git", "diff", "--stat", `${base}...HEAD`], { cwd, timeoutMs: 5000 }),
		spawnText(["git", "diff", `${base}...HEAD`], { cwd, timeoutMs: 5000 }),
		spawnText(["git", "diff"], { cwd, timeoutMs: 5000 }),
		spawnText(["git", "diff", "--cached"], { cwd, timeoutMs: 5000 }),
	]);
	if (!committed.ok || !unstaged.ok || !staged.ok || !untracked.ok) {
		const paths = mergeChangeSetPaths([
			committed.ok ? parseGitNameStatus(committed.stdout) : [],
			unstaged.ok ? parseGitNameStatus(unstaged.stdout) : [],
			staged.ok ? parseGitNameStatus(staged.stdout) : [],
			untracked.ok ? parseGitUntrackedPaths(untracked.stdout) : [],
			ciChangedPaths,
		]);
		return {
			source: "checkpoint-git",
			baseRef,
			mergeBase: mergeBase.ok && mergeBase.stdout.trim() ? mergeBase.stdout.trim() : undefined,
			headRef: "HEAD",
			paths,
			captureIncomplete: true,
			trusted: true,
		};
	}
	const paths = mergeChangeSetPaths([
		parseGitNameStatus(committed.stdout),
		parseGitNameStatus(unstaged.stdout),
		parseGitNameStatus(staged.stdout),
		parseGitUntrackedPaths(untracked.stdout),
		ciChangedPaths,
	]);
	return {
		source: "checkpoint-git",
		baseRef,
		mergeBase: mergeBase.ok && mergeBase.stdout.trim() ? mergeBase.stdout.trim() : undefined,
		headRef: "HEAD",
		paths,
		rawDiffStat: stat.ok ? stat.stdout : undefined,
		rawDiff:
			committedDiff.ok && unstagedDiff.ok && stagedDiff.ok
				? [committedDiff.stdout, unstagedDiff.stdout, stagedDiff.stdout].filter(Boolean).join("\n")
				: undefined,
		trusted: true,
	};
}

export function parseUnifiedDiffPaths(diff: string): UltragoalChangeSetPath[] {
	const paths: UltragoalChangeSetPath[] = [];
	for (const line of diff.split("\n")) {
		if (!line.startsWith("diff --git ")) continue;
		const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
		if (!match) continue;
		const oldPath = normalizeChangeSetPath(match[1]!);
		const newPath = normalizeChangeSetPath(match[2]!);
		paths.push({
			path: newPath,
			oldPath: oldPath === newPath ? undefined : oldPath,
			status: oldPath === newPath ? "modified" : "renamed",
			category: categorizeComputerChangePath(newPath),
		});
	}
	return paths;
}
