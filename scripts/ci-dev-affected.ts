#!/usr/bin/env bun

import { $ } from "bun";
import * as path from "node:path";
import * as fs from "node:fs/promises";

const repoRoot = path.join(import.meta.dir, "..");
const ZERO_SHA = /^0+$/;
const PACKAGE_SCOPES = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const;

export interface PackageManifest {
	name?: string;
	scripts?: Record<string, string>;
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
	optionalDependencies?: Record<string, string>;
}

export interface WorkspacePackage {
	name: string;
	dir: string;
	manifest: PackageManifest;
}

export interface Task {
	key: string;
	description: string;
	command: readonly string[];
	cwd?: string;
}

async function main(): Promise<void> {
	const dryRun = process.argv.includes("--dry-run");
	const emitFlags = process.argv.includes("--emit-flags");

	if (emitFlags) {
		await emitAffectedFlags();
		return;
	}
	const changedPaths = await getChangedPaths();
	const workspaces = await getWorkspacePackages();
	const tasks = planTasks(changedPaths, workspaces);

	printPlan(changedPaths, tasks);

	if (dryRun) {
		return;
	}

	for (const task of tasks) {
		console.log(`\n::group::${task.description}`);
		const exitCode = await runCommand(task.command, task.cwd ?? repoRoot);
		console.log("::endgroup::");
		if (exitCode !== 0) {
			process.exit(exitCode);
		}
	}
}

if (import.meta.main) {
	await main();
}

// `--emit-flags` resolves changed paths exactly as a normal run does, then
// reports whether the resulting plan needs the Rust toolchain (rust-check /
// rust-test) and/or a native build, so dev-ci can gate its Rust setup. It
// fails open (rust=true native=true) on any error or unresolved base so CI
// never skips Rust setup it actually needs.
async function emitAffectedFlags(): Promise<void> {
	let rust = true;
	let native = true;
	try {
		const paths = await getChangedPaths();
		const packages = await getWorkspacePackages();
		const planned = planTasks(paths, packages);
		const keys = new Set(planned.map(task => task.key));
		rust = keys.has("rust-check") || keys.has("rust-test");
		native = keys.has("native-build") || keys.has("native-linux-x64");
		console.log(`ci-dev-affected: rust=${rust} native=${native} (changed paths: ${paths.length})`);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.log(`ci-dev-affected: flag computation failed (${message}); failing open to rust=true native=true`);
		rust = true;
		native = true;
	}
	if (process.env.GITHUB_OUTPUT) {
		await fs.appendFile(process.env.GITHUB_OUTPUT, `rust=${rust}\nnative=${native}\n`);
	}
}

function printPlan(paths: readonly string[], plannedTasks: readonly Task[]): void {
	console.log("Dev affected-path CI");
	console.log(`Changed paths: ${paths.length}`);
	for (const changedPath of paths) {
		console.log(` - ${changedPath}`);
	}
	if (plannedTasks.length === 0) {
		console.log("No validation tasks required for changed paths.");
		return;
	}
	console.log("Planned tasks:");
	for (const task of plannedTasks) {
		const where = task.cwd ? ` (cwd: ${path.relative(repoRoot, task.cwd) || "."})` : "";
		console.log(` - ${task.description}: ${task.command.join(" ")}${where}`);
	}
}

async function getChangedPaths(): Promise<string[]> {
	const explicitPaths = Bun.env.CI_DEV_CHANGED_PATHS?.trim();
	if (explicitPaths) {
		return explicitPaths
			.split(/[\n,]/)
			.map(entry => entry.trim())
			.filter(Boolean)
			.sort();
	}

	const base = await resolveBaseRef();
	const head = Bun.env.GITHUB_SHA?.trim() || "HEAD";
	const range = base.includes("...") || base.includes("..") ? base : `${base}...${head}`;
	const diff = await $`git diff --name-only -z ${range}`.cwd(repoRoot).quiet().nothrow();
	if (diff.exitCode !== 0) {
		const stderr = diff.stderr.toString().trim();
		throw new Error(`Failed to compute changed paths for ${range}: ${stderr}`);
	}
	return new TextDecoder().decode(diff.stdout).split("\0").filter(Boolean).sort();
}

async function resolveBaseRef(): Promise<string> {
	const eventName = Bun.env.GITHUB_EVENT_NAME?.trim();
	const before = Bun.env.GITHUB_EVENT_BEFORE?.trim();
	const baseSha = Bun.env.GITHUB_BASE_SHA?.trim();
	const baseRef = Bun.env.GITHUB_BASE_REF?.trim();

	if (eventName === "pull_request" && baseRef) {
		const mergeBase = await $`git merge-base HEAD ${`origin/${baseRef}`}`.cwd(repoRoot).quiet().nothrow();
		if (mergeBase.exitCode === 0) {
			const value = mergeBase.stdout.toString().trim();
			if (value !== "") return value;
		}
		return `origin/${baseRef}`;
	}
	if (baseSha && !ZERO_SHA.test(baseSha)) {
		return baseSha;
	}
	if (before && !ZERO_SHA.test(before)) {
		return `${before}..${Bun.env.GITHUB_SHA?.trim() || "HEAD"}`;
	}

	const mergeBase = await $`git merge-base HEAD origin/dev`.cwd(repoRoot).quiet().nothrow();
	if (mergeBase.exitCode === 0) {
		const value = mergeBase.stdout.toString().trim();
		if (value !== "") return value;
	}
	return "origin/dev";
}

async function getWorkspacePackages(): Promise<WorkspacePackage[]> {
	const dirs = await getWorkspaceDirs();
	const packages: WorkspacePackage[] = [];
	for (const dir of dirs) {
		const manifest = await readPackageManifest(path.join(repoRoot, dir, "package.json"));
		if (manifest?.name) {
			packages.push({ name: manifest.name, dir, manifest });
		}
	}
	return packages.sort((left, right) => left.dir.localeCompare(right.dir));
}

async function getWorkspaceDirs(): Promise<string[]> {
	const root = await readJsonRecord(path.join(repoRoot, "package.json"));
	const workspaceConfig = root?.workspaces;
	const patterns = Array.isArray(workspaceConfig)
		? workspaceConfig.filter(isString)
		: isRecord(workspaceConfig) && Array.isArray(workspaceConfig.packages)
			? workspaceConfig.packages.filter(isString)
			: [];
	const dirs: string[] = [];
	for (const pattern of patterns) {
		if (pattern.endsWith("/*")) {
			const parent = pattern.slice(0, -2);
			const entries = await Array.fromAsync(new Bun.Glob(`${parent}/*/package.json`).scan({ cwd: repoRoot }));
			dirs.push(...entries.map(entry => path.dirname(entry)));
		} else if (await Bun.file(path.join(repoRoot, pattern, "package.json")).exists()) {
			dirs.push(pattern);
		}
	}
	return Array.from(new Set(dirs)).sort();
}

async function readPackageManifest(filePath: string): Promise<PackageManifest | null> {
	const value = await readJsonRecord(filePath);
	if (!value) return null;
	return {
		name: isString(value.name) ? value.name : undefined,
		scripts: readStringMap(value.scripts),
		dependencies: readStringMap(value.dependencies),
		devDependencies: readStringMap(value.devDependencies),
		peerDependencies: readStringMap(value.peerDependencies),
		optionalDependencies: readStringMap(value.optionalDependencies),
	};
}

async function readJsonRecord(filePath: string): Promise<Record<string, unknown> | null> {
	if (!(await Bun.file(filePath).exists())) return null;
	const parsed: unknown = await Bun.file(filePath).json();
	return isRecord(parsed) ? parsed : null;
}

function readStringMap(value: unknown): Record<string, string> | undefined {
	if (!isRecord(value)) return undefined;
	const entries = Object.entries(value).filter((entry): entry is [string, string] => isString(entry[1]));
	return Object.fromEntries(entries);
}

export function planTasks(paths: readonly string[], packages: readonly WorkspacePackage[]): Task[] {
	const tasks = new Map<string, Task>();
	const touchedPackages = findTouchedPackages(paths, packages);
	const rootPackageReleaseHarnessOnly = isRootPackageReleaseHarnessOnly(paths);
	const fullWorkspace = paths.some(isFullWorkspacePath) && !rootPackageReleaseHarnessOnly;
	const pythonChanged = paths.some(isPythonPath);
	const webChanged = paths.some(changedPath => changedPath.startsWith("python/robogjc/web/"));
	const rustChanged = paths.some(isRustPath);
	const installChanged = paths.some(isInstallPath);
	const publishChanged = paths.some(isReleasePublishPath);
	const wrapperChanged = paths.some(isUnscopedWrapperPath);
	const toolingScriptChanged = paths.some(isToolingScriptPath);
	const deepInterviewOnly = isDeepInterviewOnly(paths);
	const needsNativeRuntime = !deepInterviewOnly && (paths.some(isCodingAgentRuntimePath) || wrapperChanged || fullWorkspace);
	const workflowHarnessOnly = paths.length > 0 && paths.every(isWorkflowHarnessPath);
	const ciOnly = paths.length > 0 && paths.every(changedPath => changedPath.startsWith(".github/"));

	if (deepInterviewOnly) {
		add(tasks, "deep-interview-definitions", "Deep interview default definition tests", ["bun", "test", "packages/coding-agent/test/default-gjc-definitions.test.ts"]);
		add(tasks, "deep-interview-runtime", "Deep interview runtime tests", ["bun", "test", "packages/coding-agent/test/gjc-runtime/deep-interview-runtime.test.ts"]);
		return Array.from(tasks.values());
	}

	if (needsNativeRuntime) {
		add(tasks, "native-build", "Build native addon for CLI/test smoke", ["bun", "run", "build:native"]);
	}

	if (fullWorkspace) {
		add(tasks, "root-check", "Root TypeScript/tooling check", ["bun", "run", "check:ts"]);
		addNativeBuild(tasks);
		add(tasks, "root-test", "Root workspace TypeScript tests", ["bun", "run", "test:ts"]);
	} else if (!ciOnly && !workflowHarnessOnly) {
		const affectedPackages = expandWithDependents(touchedPackages, packages);
		if (affectedPackages.some(workspacePackage => workspacePackage.manifest.scripts?.test)) {
			addNativeBuild(tasks);
		}
		for (const workspacePackage of affectedPackages) {
			if (workspacePackage.manifest.scripts?.check) {
				add(tasks, `check:${workspacePackage.name}`, `Check ${workspacePackage.name}`, packageScriptCommand("check"), resolvePackageCwd(workspacePackage.dir));
			}
			if (workspacePackage.manifest.scripts?.test) {
				add(tasks, `test:${workspacePackage.name}`, `Test ${workspacePackage.name}`, packageScriptCommand("test"), resolvePackageCwd(workspacePackage.dir));
			}
		}
	}

	if (toolingScriptChanged && !fullWorkspace && !ciOnly && !workflowHarnessOnly) {
		add(tasks, "root-check", "Root TypeScript/tooling check", ["bun", "run", "check:ts"]);
	}
	if (wrapperChanged) {
		add(tasks, "wrapper-version", "Unscoped wrapper CLI version smoke", ["bun", "packages/gajae-code/bin/gjc.js", "--version"]);
	}
	if (publishChanged) {
		add(tasks, "release-publish-contract", "Release publish contract tests", ["bun", "run", "test:release"]);
		add(tasks, "release-publish-dry-run", "Release publish dry-run", ["bun", "scripts/ci-release-publish.ts", "--dry-run"]);
	}

	if (pythonChanged) {
		add(tasks, "python-lint", "Python lint", ["bun", "run", "lint:py"]);
		add(tasks, "python-test", "Python tests", ["bun", "run", "test:py"]);
	}
	if (webChanged) {
		add(tasks, "robogjc-web-typecheck", "robogjc web typecheck", packageScriptCommand("typecheck"), resolvePackageCwd("python/robogjc/web"));
		add(tasks, "robogjc-web-build", "robogjc web build", packageScriptCommand("build"), resolvePackageCwd("python/robogjc/web"));
	}
	if (rustChanged) {
		add(tasks, "rust-check", "Rust check", ["bun", "run", "check:rs"]);
		add(tasks, "rust-test", "Rust tests", ["bun", "run", "test:rs"]);
	}
	if (installChanged) {
		add(tasks, "install-methods", "Install method smoke tests", ["bun", "run", "ci:test:install-methods"]);
	}
	if (needsNativeRuntime) {
		add(tasks, "cli-smoke", "GJC CLI smoke test", ["bun", "run", "ci:test:smoke"]);
	}
	if (paths.some(isWorkflowOrScriptPath)) {
		add(tasks, "affected-dry-run", "Affected CI selector self-check", ["bun", "scripts/ci-dev-affected.ts", "--dry-run"]);
		add(tasks, "affected-selftest", "Affected CI selector unit tests", ["bun", "test", "scripts/ci-dev-affected.test.ts"]);
		if (paths.some(isWorkflowPath)) {
			add(tasks, "workflow-yaml-parse", "Workflow YAML parse check", ["bun", "scripts/check-workflow-yaml.ts"]);
		}
	}

	return Array.from(tasks.values());
}


function addNativeBuild(tasks: Map<string, Task>): void {
	add(tasks, "native-linux-x64", "Build linux x64 native addons", ["bash", "-lc", 'TARGET_VARIANTS="baseline modern" bun scripts/ci-build-native.ts']);
}

function add(tasks: Map<string, Task>, key: string, description: string, command: readonly string[], cwd?: string): void {
	if (!tasks.has(key)) {
		tasks.set(key, { key, description, command, cwd });
	}
}

// Build a package-script invocation that runs in the task's resolved `cwd`
// (set by the caller via `add(..., cwd)`). We deliberately use `bun run
// <script>` with a process cwd instead of `bun --cwd <dir> run <script>`:
// under Bun 1.3.14 the space-separated `--cwd <dir>` form is parsed as a bare
// `bun run` with no entrypoint, which prints the usage banner and exits 0
// without executing the script — a false green that masks check/test failures
// (issue #622).
export function packageScriptCommand(script: string): readonly string[] {
	return ["bun", "run", script];
}

// Resolve a workspace-relative package directory to an absolute path used as
// the spawned task's process cwd.
export function resolvePackageCwd(dir: string): string {
	return path.join(repoRoot, dir);
}

function findTouchedPackages(paths: readonly string[], packages: readonly WorkspacePackage[]): WorkspacePackage[] {
	return packages.filter(workspacePackage => paths.some(changedPath => changedPath === workspacePackage.dir || changedPath.startsWith(`${workspacePackage.dir}/`)));
}

function expandWithDependents(touched: readonly WorkspacePackage[], packages: readonly WorkspacePackage[]): WorkspacePackage[] {
	const workspaceByName = new Map(packages.map(workspacePackage => [workspacePackage.name, workspacePackage]));
	const selected = new Map(touched.map(workspacePackage => [workspacePackage.name, workspacePackage]));
	const queue = [...touched.map(workspacePackage => workspacePackage.name)];
	while (queue.length > 0) {
		const currentName = queue.shift();
		if (!currentName) continue;
		for (const candidate of packages) {
			if (selected.has(candidate.name)) continue;
			if (dependsOnWorkspace(candidate.manifest, currentName, workspaceByName)) {
				selected.set(candidate.name, candidate);
				queue.push(candidate.name);
			}
		}
	}
	return Array.from(selected.values()).sort((left, right) => left.dir.localeCompare(right.dir));
}

function dependsOnWorkspace(manifest: PackageManifest, dependencyName: string, workspaceByName: ReadonlyMap<string, WorkspacePackage>): boolean {
	for (const scope of PACKAGE_SCOPES) {
		const dependencies = manifest[scope];
		if (!dependencies) continue;
		const version = dependencies[dependencyName];
		if (version && (version.startsWith("workspace:") || workspaceByName.has(dependencyName))) {
			return true;
		}
	}
	return false;
}

function isFullWorkspacePath(changedPath: string): boolean {
	return [
		"package.json",
		"bunfig.toml",
		"biome.json",
		"tsconfig.json",
		"tsconfig.base.json",
		"tsconfig.tools.json",
	].includes(changedPath);
}

function isRootPackageReleaseHarnessOnly(paths: readonly string[]): boolean {
	return (
		paths.includes("package.json") &&
		paths.every(changedPath =>
			changedPath === "package.json" ||
			isReleasePublishPath(changedPath) ||
			isReleaseHarnessScriptPath(changedPath) ||
			isUnscopedWrapperPath(changedPath),
		)
	);
}

function isReleaseHarnessScriptPath(changedPath: string): boolean {
	return [
		"scripts/ci-dev-affected.ts",
		"scripts/ci-release-publish.ts",
		"scripts/install-tests/tarball.dockerfile",
		"scripts/release-publish-order.test.ts",
		"scripts/sync-versions.ts",
	].includes(changedPath);
}

function isPythonPath(changedPath: string): boolean {
	return changedPath.startsWith("python/robogjc/") && !changedPath.startsWith("python/robogjc/web/");
}

function isRustPath(changedPath: string): boolean {
	const fileName = path.basename(changedPath);
	return (
		changedPath.startsWith("crates/") ||
		changedPath.startsWith(".cargo/") ||
		["Cargo.toml", "Cargo.lock", "rust-toolchain", "rust-toolchain.toml", "rustfmt.toml", ".rustfmt.toml", "clippy.toml", ".clippy.toml"].includes(fileName)
	);
}

function isInstallPath(changedPath: string): boolean {
	return changedPath.startsWith("scripts/install") || changedPath === "Dockerfile" || changedPath === "Dockerfile.dockerignore";
}

function isCodingAgentRuntimePath(changedPath: string): boolean {
	return changedPath.startsWith("packages/coding-agent/") || changedPath.startsWith("packages/agent/") || changedPath.startsWith("packages/ai/");
}

function isDeepInterviewOnly(paths: readonly string[]): boolean {
	const allowed = new Set([
		"packages/coding-agent/src/defaults/gjc/skills/deep-interview/SKILL.md",
		"packages/coding-agent/src/gjc-runtime/deep-interview-runtime.ts",
		"packages/coding-agent/test/default-gjc-definitions.test.ts",
		"packages/coding-agent/test/gjc-runtime/deep-interview-runtime.test.ts",
	]);
	return paths.length > 0 && paths.every(changedPath => allowed.has(changedPath));
}

function isWorkflowOrScriptPath(changedPath: string): boolean {
	return isWorkflowHarnessPath(changedPath);
}

function isWorkflowPath(changedPath: string): boolean {
	return changedPath.startsWith(".github/workflows/");
}

function isWorkflowHarnessPath(changedPath: string): boolean {
	return isWorkflowPath(changedPath) || changedPath === "scripts/ci-dev-affected.ts" || changedPath === "scripts/check-workflow-yaml.ts";
}

function isToolingScriptPath(changedPath: string): boolean {
	return changedPath.startsWith("scripts/") || changedPath === "bun.lock";
}

function isReleasePublishPath(changedPath: string): boolean {
	return changedPath === "scripts/ci-release-publish.ts" || changedPath.startsWith("packages/gajae-code/");
}

function isUnscopedWrapperPath(changedPath: string): boolean {
	return changedPath.startsWith("packages/gajae-code/");
}

function isString(value: unknown): value is string {
	return typeof value === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function runCommand(command: readonly string[], cwd: string): Promise<number> {
	const [head, ...rest] = command;
	const proc = Bun.spawn([head, ...rest], {
		cwd,
		env: process.env,
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	});
	return proc.exited;
}
