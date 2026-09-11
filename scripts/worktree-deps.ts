/**
 * Worktree dependency diagnostics (issue #5484).
 *
 * A checkout created with `git worktree add` starts with no `node_modules/` and
 * no built native addon, so `bun test` dies on a bare
 * `Cannot find module '@gajae-code/...'` error that names neither the cause nor
 * the fix. This module is the single source of truth for that diagnosis:
 * `scripts/test-preload.ts` fails fast with it, and `dev:doctor --worktree`
 * reports it.
 *
 * The decision core takes injected probes so the table stays unit-testable; the
 * defaults read the real filesystem and Bun's resolver.
 */
import * as fs from "node:fs";
import * as path from "node:path";

/** Worktree-safe setup command documented in AGENTS.md / README. */
export const WORKTREE_SETUP_COMMAND = "bun run setup:worktree";
/** The exact steps `setup:worktree` expands to (kept in sync by scripts/install-dev.test.ts). */
export const WORKTREE_SETUP_STEPS = "bun install && bun run build:native";
/** Entry point whose import exercises the real native-addon loader. */
export const NATIVE_ENTRY_PATH = path.join("packages", "natives", "native", "index.js");

export type WorkspaceDependencyStatus = "ready" | "missing-node-modules" | "unresolved-workspace-packages";

export interface WorkspaceDependencySnapshot {
	repoRoot: string;
	nodeModulesDir: string;
	nodeModulesPresent: boolean;
	/** Workspace packages that declare a root entry point and must resolve for tests. */
	workspacePackages: string[];
	unresolvedPackages: string[];
	status: WorkspaceDependencyStatus;
}

export interface WorkspaceDependencyProbe {
	repoRoot: string;
	nodeModulesExists?: (nodeModulesDir: string) => boolean;
	resolvePackage?: (specifier: string, fromDir: string) => string;
	listWorkspacePackages?: (repoRoot: string) => string[];
}

export interface NativeAddonProbeResult {
	ok: boolean;
	entryPath: string;
	output: string;
}

export interface WorktreeReport {
	snapshot: WorkspaceDependencySnapshot;
	native: NativeAddonProbeResult;
	ok: boolean;
}

/** Shared remediation block every worktree diagnostic ends with. */
const WORKTREE_SETUP_HELP = [
	"  Fix (worktree-safe):",
	`    ${WORKTREE_SETUP_COMMAND}    # ${WORKTREE_SETUP_STEPS}`,
	"",
	"  Do NOT run `bun run install:dev` in a worktree: it repoints the global `gjc`",
	"  symlink, rewrites git hooks, and overwrites user-level defaults for your",
	"  primary checkout.",
];

function defaultNodeModulesExists(nodeModulesDir: string): boolean {
	try {
		return fs.statSync(nodeModulesDir).isDirectory();
	} catch {
		return false;
	}
}

function defaultResolvePackage(specifier: string, fromDir: string): string {
	return Bun.resolveSync(specifier, fromDir);
}

/**
 * A workspace package is probe-able only when its manifest exposes a root entry
 * point. The platform prebuilt packages (`@gajae-code/natives-linux-x64`, …)
 * intentionally export only `./package.json`, so they are mobile artifacts, not
 * importable test dependencies, and must not be reported as unresolved.
 */
function hasRootEntryPoint(manifest: Record<string, unknown>): boolean {
	if (typeof manifest.main === "string" || typeof manifest.module === "string") return true;
	const exportsField = manifest.exports;
	if (typeof exportsField === "string") return true;
	return typeof exportsField === "object" && exportsField !== null && "." in exportsField;
}

/** Workspace package names tests must be able to `import` in this checkout. */
export function listWorkspacePackageNames(repoRoot: string): string[] {
	const packagesDir = path.join(repoRoot, "packages");
	let entries: string[];
	try {
		entries = fs.readdirSync(packagesDir);
	} catch {
		return [];
	}
	const names: string[] = [];
	for (const entry of entries.sort()) {
		let manifest: Record<string, unknown>;
		try {
			const parsed: unknown = JSON.parse(fs.readFileSync(path.join(packagesDir, entry, "package.json"), "utf8"));
			if (typeof parsed !== "object" || parsed === null) continue;
			manifest = parsed as Record<string, unknown>;
		} catch {
			continue;
		}
		const name = manifest.name;
		if (typeof name !== "string" || !name.startsWith("@gajae-code/")) continue;
		if (!hasRootEntryPoint(manifest)) continue;
		names.push(name);
	}
	return names;
}

export function inspectWorkspaceDependencies(probe: WorkspaceDependencyProbe): WorkspaceDependencySnapshot {
	const { repoRoot } = probe;
	const nodeModulesDir = path.join(repoRoot, "node_modules");
	const nodeModulesPresent = (probe.nodeModulesExists ?? defaultNodeModulesExists)(nodeModulesDir);
	const resolvePackage = probe.resolvePackage ?? defaultResolvePackage;
	const workspacePackages = nodeModulesPresent ? (probe.listWorkspacePackages ?? listWorkspacePackageNames)(repoRoot) : [];
	const unresolvedPackages: string[] = [];
	if (nodeModulesPresent) {
		for (const specifier of workspacePackages) {
			try {
				resolvePackage(specifier, repoRoot);
			} catch {
				unresolvedPackages.push(specifier);
			}
		}
	}
	const status: WorkspaceDependencyStatus = !nodeModulesPresent
		? "missing-node-modules"
		: unresolvedPackages.length > 0
			? "unresolved-workspace-packages"
			: "ready";
	return { repoRoot, nodeModulesDir, nodeModulesPresent, workspacePackages, unresolvedPackages, status };
}

/** The fail-fast message the test preload throws when the checkout cannot run tests. */
export function formatWorkspaceDependencyFailure(snapshot: WorkspaceDependencySnapshot): string {
	const reason =
		snapshot.status === "missing-node-modules"
			? `node_modules/ is absent at ${snapshot.nodeModulesDir}.`
			: `node_modules/ exists but these workspace packages do not resolve: ${snapshot.unresolvedPackages.join(", ")}.`;
	return [
		"",
		"✗ Workspace dependencies are not installed in this checkout.",
		"",
		`  ${reason}`,
		"",
		"  Tests cannot resolve @gajae-code/* workspace packages, so every run fails with a",
		'  bare "Cannot find module" error before the suite starts. This is expected in a',
		"  fresh `git worktree add` checkout.",
		"",
		...WORKTREE_SETUP_HELP,
		"",
	].join("\n");
}

/**
 * Import the natives entry point in a child process so the real loader decides
 * whether any candidate `.node` (workspace build, optional package, versioned
 * cache, or installed location) actually loads.
 */
export function probeNativeAddon(repoRoot: string): NativeAddonProbeResult {
	const entryPath = path.join(repoRoot, NATIVE_ENTRY_PATH);
	if (!fs.existsSync(entryPath)) {
		return { ok: false, entryPath, output: `${NATIVE_ENTRY_PATH} is missing from this checkout.` };
	}
	const result = Bun.spawnSync([process.execPath, entryPath], {
		cwd: repoRoot,
		stdout: "pipe",
		stderr: "pipe",
		timeout: 60_000,
	});
	const output = `${result.stdout.toString()}${result.stderr.toString()}`.trim();
	return { ok: result.exitCode === 0, entryPath, output };
}

export function inspectWorktree(repoRoot: string): WorktreeReport {
	const snapshot = inspectWorkspaceDependencies({ repoRoot });
	const native = probeNativeAddon(repoRoot);
	return { snapshot, native, ok: snapshot.status === "ready" && native.ok };
}

function indentBlock(text: string, maxLines: number): string {
	const lines = text.split("\n").slice(0, maxLines);
	return lines.map(line => `      ${line}`).join("\n");
}

/** Human-readable `dev:doctor --worktree` report. */
export function formatWorktreeReport(report: WorktreeReport): string {
	const { snapshot, native } = report;
	const lines = [
		`Worktree readiness: ${snapshot.repoRoot}`,
		`  node_modules:       ${snapshot.nodeModulesPresent ? "present" : "ABSENT"} (${snapshot.nodeModulesDir})`,
		snapshot.status === "ready"
			? `  workspace packages: ${snapshot.workspacePackages.length}/${snapshot.workspacePackages.length} resolve`
			: snapshot.status === "missing-node-modules"
				? "  workspace packages: unknown (node_modules absent)"
				: `  workspace packages: unresolved: ${snapshot.unresolvedPackages.join(", ")}`,
		`  native addon:       ${native.ok ? "loads" : "UNAVAILABLE"} (${native.entryPath})`,
	];
	if (!native.ok && native.output) lines.push(indentBlock(native.output, 20));
	if (report.ok) {
		lines.push("", "✓ This checkout can resolve workspace dependencies and load the native addon.");
		return lines.join("\n");
	}
	lines.push(
		"",
		"✗ This checkout cannot run the test suite.",
		"",
		...WORKTREE_SETUP_HELP,
	);
	return lines.join("\n");
}
