import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export type UltragoalChangeStatus = "added" | "modified" | "deleted" | "renamed" | "copied" | "unknown";
export type UltragoalChangeCategory =
	| "code"
	| "generated-binding"
	| "tool"
	| "settings-registry"
	| "prompt-doc-behavior"
	| "docs-static"
	| "other";

export interface UltragoalChangeSetPath {
	path: string;
	status: UltragoalChangeStatus;
	oldPath?: string;
	category?: UltragoalChangeCategory;
	[key: string]: unknown;
}

export interface UltragoalChangeSet {
	source: "checkpoint-git" | "review-pr" | "review-branch" | "review-worktree" | "review-spec";
	baseRef?: string;
	headRef?: string;
	mergeBase?: string;
	paths: UltragoalChangeSetPath[];
	rawDiffStat?: string;
	rawDiff?: string;
	untrackedContentHash?: string;
	untrackedContentHashVerified?: boolean;
	captureIncomplete?: boolean;
	trusted: true;
	[key: string]: unknown;
}

export function normalizeRepoPath(value: string): string {
	return value.replaceAll("\\", "/").replace(/^\.\//, "");
}

export function normalizeChangeSetPath(value: string): string {
	return value.replace(/^\.\//, "");
}

export function categorizeComputerChangePath(pathValue: string): UltragoalChangeCategory {
	const normalized = normalizeRepoPath(pathValue);
	if (normalized.startsWith("crates/pi-natives/src/computer/")) return "code";
	if (/^packages\/natives\/native\/index\.(?:d\.ts|js)$/.test(normalized)) return "generated-binding";
	if (
		normalized === "packages/coding-agent/src/tools/computer.ts" ||
		normalized.startsWith("packages/coding-agent/src/tools/computer/")
	)
		return "tool";
	if (
		normalized === "packages/coding-agent/src/config/settings-schema.ts" ||
		normalized === "packages/coding-agent/src/tools/index.ts" ||
		normalized === "packages/coding-agent/src/tools/renderers.ts"
	)
		return "settings-registry";
	if (
		normalized === "packages/coding-agent/src/prompts/tools/computer.md" ||
		normalized === "packages/coding-agent/src/defaults/gjc/skills/ultragoal/SKILL.md" ||
		normalized === "packages/coding-agent/src/prompts/agents/executor.md"
	)
		return "prompt-doc-behavior";
	if (normalized === "docs/tools/computer.md" || normalized === "docs/computer-use/README.md") return "docs-static";
	return "other";
}

export function computeUltragoalReviewSourceHash(changeSet: UltragoalChangeSet | undefined): string | undefined {
	if (!changeSet?.trusted || changeSet.captureIncomplete || changeSet.rawDiff === undefined) return undefined;
	if (changeSet.paths.some(row => row.status === "unknown")) return undefined;
	if (
		changeSet.paths.some(row => row.status === "added") &&
		(!changeSet.untrackedContentHash || changeSet.untrackedContentHashVerified !== true)
	)
		return undefined;
	const basis = {
		source: changeSet.source,
		baseRef: changeSet.baseRef,
		headRef: changeSet.headRef,
		mergeBase: changeSet.mergeBase,
		paths: changeSet.paths
			.map(row => ({
				path: normalizeRepoPath(row.path),
				status: row.status,
				oldPath: row.oldPath ? normalizeRepoPath(row.oldPath) : undefined,
			}))
			.sort((left, right) =>
				`${left.path}\u0000${left.status}\u0000${left.oldPath ?? ""}`.localeCompare(
					`${right.path}\u0000${right.status}\u0000${right.oldPath ?? ""}`,
				),
			),
		rawDiff: changeSet.rawDiff,
		untrackedContentHash: changeSet.untrackedContentHash,
	};
	return `sha256:${crypto.createHash("sha256").update(JSON.stringify(basis)).digest("hex")}`;
}

async function hashAddedFiles(cwd: string, paths: readonly UltragoalChangeSetPath[]): Promise<string | undefined> {
	try {
		const hasher = crypto.createHash("sha256");
		const root = path.resolve(cwd);
		for (const row of [...paths].sort((left, right) => left.path.localeCompare(right.path))) {
			const filePath = path.resolve(root, row.path);
			const relative = path.relative(root, filePath);
			if (relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
			const stat = await fs.lstat(filePath);
			hasher.update(row.path);
			hasher.update("\0");
			if (stat.isSymbolicLink()) {
				hasher.update("symlink\0");
				hasher.update(await fs.readlink(filePath));
			} else if (stat.isFile()) {
				hasher.update("file\0");
				hasher.update(Buffer.from(await Bun.file(filePath).arrayBuffer()));
			} else {
				return undefined;
			}
			hasher.update("\0");
		}
		return `sha256:${hasher.digest("hex")}`;
	} catch {
		return undefined;
	}
}

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
			path: normalizeRepoPath(pathValue),
			status: "unknown" as UltragoalChangeStatus,
			category: categorizeComputerChangePath(pathValue),
		}));
}

export function mergeChangeSetPaths(groups: UltragoalChangeSetPath[][]): UltragoalChangeSetPath[] {
	const byKey = new Map<string, UltragoalChangeSetPath>();
	for (const inputRow of groups.flat()) {
		const row: UltragoalChangeSetPath = {
			...inputRow,
			path: normalizeRepoPath(inputRow.path),
			...(inputRow.oldPath ? { oldPath: normalizeRepoPath(inputRow.oldPath) } : {}),
		};
		const key = `${row.oldPath ?? ""}\u0000${row.path}`;
		const existing = byKey.get(key);
		if (existing && existing.status !== "unknown" && row.status === "unknown") continue;
		byKey.set(key, row);
	}
	return [...byKey.values()];
}

export async function computeCheckpointChangeSet(cwd: string): Promise<UltragoalChangeSet | undefined> {
	let ciChangedPaths = ciDevChangedPathRows();
	const inGit = await spawnText(["git", "rev-parse", "--is-inside-work-tree"], { cwd, timeoutMs: 3000 });
	const workspace = process.env.GITHUB_WORKSPACE?.trim();
	if (workspace) {
		const topLevel = inGit.ok
			? await spawnText(["git", "rev-parse", "--show-toplevel"], { cwd, timeoutMs: 3000 })
			: undefined;
		if (!topLevel?.ok || path.resolve(topLevel.stdout.trim()) !== path.resolve(workspace)) ciChangedPaths = [];
	}
	if (!inGit.ok || inGit.stdout.trim() !== "true") {
		if (ciChangedPaths.length === 0)
			return { source: "checkpoint-git", paths: [], captureIncomplete: true, trusted: true };
		return { source: "checkpoint-git", paths: ciChangedPaths, trusted: true };
	}
	const captureWitness = await repositoryStateWitness(cwd);
	await repositoryStateWitnessTestHook?.("after-initial", cwd);
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
	const untrackedPaths = parseGitUntrackedPaths(untracked.stdout);
	const paths = mergeChangeSetPaths([
		parseGitNameStatus(committed.stdout),
		parseGitNameStatus(unstaged.stdout),
		parseGitNameStatus(staged.stdout),
		untrackedPaths,
		ciChangedPaths,
	]);
	const untrackedContentHash = await hashAddedFiles(
		cwd,
		paths.filter(row => row.status === "added"),
	);
	// #4560: the name-status, diff, and untracked reads above are independent
	// git invocations. A concurrent repository change between them yields a
	// snapshot that never existed on disk, which would let completion be
	// committed against a source basis nothing was actually reviewed at.
	// Re-read the content witness and mark the capture incomplete on
	// drift so the boundary fails closed into the full heavyweight cohort.
	const witness = await repositoryStateWitness(cwd);
	const captureDrifted = witness === undefined || witness !== captureWitness;
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
		...(untrackedContentHash ? { untrackedContentHash, untrackedContentHashVerified: true } : {}),
		captureIncomplete:
			!stat.ok ||
			!committedDiff.ok ||
			!unstagedDiff.ok ||
			!stagedDiff.ok ||
			captureDrifted ||
			(paths.some(row => row.status === "added") && !untrackedContentHash),
		trusted: true,
	};
}

/**
 * A content witness of overall repository state. HEAD and porcelain status are
 * retained for cheap structural diagnostics, but the authoritative comparison
 * also digests every tracked and non-ignored untracked path. A same-status edit
 * therefore cannot pass the capture boundary merely because Git's status text
 * stayed unchanged.
 */
type RepositoryStateWitnessTestHook = (phase: "after-initial", cwd: string) => void | Promise<void>;

let repositoryStateWitnessTestHook: RepositoryStateWitnessTestHook | undefined;

/** @internal Test-only seam; production capture has no injected mutation hook. */
export function __setRepositoryStateWitnessTestHookForTests(hook: RepositoryStateWitnessTestHook | undefined): void {
	repositoryStateWitnessTestHook = hook;
}

async function repositoryStateWitness(cwd: string): Promise<string | undefined> {
	const [head, status, tracked, untracked] = await Promise.all([
		spawnText(["git", "rev-parse", "HEAD"], { cwd, timeoutMs: 3000 }),
		spawnText(["git", "status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd, timeoutMs: 5000 }),
		spawnText(["git", "ls-files", "-z"], { cwd, timeoutMs: 5000 }),
		spawnText(["git", "ls-files", "--others", "--exclude-standard", "-z"], { cwd, timeoutMs: 5000 }),
	]);
	if (!head.ok || !status.ok || !tracked.ok || !untracked.ok) return undefined;
	const paths = [
		...new Set([
			...parseGitUntrackedPaths(tracked.stdout).map(row => row.path),
			...parseGitUntrackedPaths(untracked.stdout).map(row => row.path),
		]),
	].sort((left, right) => left.localeCompare(right));
	const content = crypto.createHash("sha256");
	const root = path.resolve(cwd);
	try {
		for (const repoPath of paths) {
			const filePath = path.resolve(root, repoPath);
			const relative = path.relative(root, filePath);
			if (relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
			content.update(repoPath);
			content.update("\u0000");
			const stat = await fs.lstat(filePath).catch(() => undefined);
			if (!stat) {
				content.update("missing\u0000");
				continue;
			}
			if (stat.isSymbolicLink()) {
				content.update("symlink\u0000");
				content.update(await fs.readlink(filePath));
			} else if (stat.isFile()) {
				content.update("file\u0000");
				content.update(Buffer.from(await Bun.file(filePath).arrayBuffer()));
			} else {
				content.update("other\u0000");
			}
			content.update("\u0000");
		}
	} catch {
		return undefined;
	}
	return `${head.stdout.trim()}\u0000${status.stdout}\u0000sha256:${content.digest("hex")}`;
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
