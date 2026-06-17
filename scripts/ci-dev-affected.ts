#!/usr/bin/env bun

import { $ } from "bun";
import * as path from "node:path";
import * as fs from "node:fs/promises";

const repoRoot = path.join(import.meta.dir, "..");
const ZERO_SHA = /^0+$/;
const PACKAGE_SCOPES = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const;
// Keys for tasks that compile the @gajae-code/natives addon. They run once in
// the dedicated dev-ci native-build job (not as matrix shards) and publish the
// built `.node` files as an artifact the runtime-dependent shards download.
// Declared here (before the top-level `await main()`) so it is initialized for
// every CLI mode despite top-level await halting later module statements.
const NATIVE_BUILD_KEYS: ReadonlySet<string> = new Set(["native-build", "native-linux-x64"]);
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

// Machine-readable descriptor for one planned task, emitted by `--matrix-json`
// so dev-ci can fan the plan out across runners. `native`/`rust` declare the
// per-task setup a single shard needs (prebuilt native addon / Rust toolchain);
// `nativeBuild` marks the addon-compilation tasks that run once in the dedicated
// native-build job rather than as shards.
export interface TaskMatrixEntry {
	key: string;
	description: string;
	command: readonly string[];
	cwd?: string;
	native: boolean;
	rust: boolean;
	nativeBuild: boolean;
}

async function main(): Promise<void> {
	const dryRun = process.argv.includes("--dry-run");

	if (process.argv.includes("--emit-flags")) {
		await emitAffectedFlags();
		return;
	}
	if (process.argv.includes("--matrix-json")) {
		await emitMatrix();
		return;
	}
	if (process.argv.includes("--native-build")) {
		await runNativeBuild();
		return;
	}
	const taskArg = process.argv.find(arg => arg.startsWith("--task="));
	if (taskArg) {
		await runSingleTask(taskArg.slice("--task=".length));
		return;
	}
	const changedPaths = await getChangedPaths();
	const tasks = await resolvePlannedTasks(changedPaths);

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

// CI runs in one of two planning modes:
//   - "pr": pull_request runs get a fast, narrowly targeted plan (run only the
//     tests/checks directly relevant to the changed paths).
//   - "push": push-to-dev (and any non-PR event) gets the broader/full affected
//     suite so the complete validation still runs once a change lands on dev.
// The mode is derived from GITHUB_EVENT_NAME, which GitHub sets on every job of
// a run, so the planner and every shard resolve the same mode deterministically.
export type PlanMode = "pr" | "push";

export function resolvePlanMode(): PlanMode {
	return Bun.env.GITHUB_EVENT_NAME?.trim() === "pull_request" ? "pr" : "push";
}

// Resolve the plan for the current changed paths and CI mode. PR mode builds the
// targeted plan from a filesystem index of test files (for source→test mapping);
// push mode reuses the broad affected planner unchanged.
async function resolvePlannedTasks(paths: readonly string[]): Promise<Task[]> {
	const packages = await getWorkspacePackages();
	if (resolvePlanMode() === "pr") {
		const testFiles = await gatherTestFiles();
		return planTargetedTasks(paths, packages, testFiles);
	}
	return planTasks(paths, packages);
}

// Repo-relative list of TypeScript test files, used by PR-mode targeting to map
// a changed source file to its directly-named test. node_modules is excluded so
// the index is identical whether or not dependencies are installed (the planner
// job skips install; shards install before running) — keeping plans stable.
async function gatherTestFiles(): Promise<string[]> {
	const patterns = ["packages/**/*.test.ts", "packages/**/*.test.tsx", "scripts/**/*.test.ts"];
	const found = new Set<string>();
	for (const pattern of patterns) {
		for await (const entry of new Bun.Glob(pattern).scan({ cwd: repoRoot })) {
			const normalized = entry.split(path.sep).join("/");
			if (!normalized.includes("node_modules/")) {
				found.add(normalized);
			}
		}
	}
	return Array.from(found).sort();
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

function isNativeBuildKey(key: string): boolean {
	return NATIVE_BUILD_KEYS.has(key);
}

// Tasks that load the @gajae-code/natives addon at runtime and therefore need a
// prebuilt `.node` present in `packages/natives/native/`. By construction (see
// planTasks) every such task only appears in a plan that also includes a native
// build task, so the shard can always download the artifact built once upstream.
function taskNeedsNative(key: string): boolean {
	return (
		key === "root-test" ||
		key === "cli-smoke" ||
		key === "wrapper-version" ||
		key === "deep-interview-definitions" ||
		key === "deep-interview-runtime" ||
		key.startsWith("test:")
	);
}

// Tasks that need the Rust toolchain (and nextest) provisioned on their shard.
function taskNeedsRust(key: string): boolean {
	return key === "rust-check" || key === "rust-test";
}

// Build the machine-readable descriptor list for the current changed-path plan.
// `cwd` is emitted repo-relative so the JSON stays portable across runners.
export function describeTasks(tasks: readonly Task[]): TaskMatrixEntry[] {
	return tasks.map(task => ({
		key: task.key,
		description: task.description,
		command: task.command,
		cwd: task.cwd ? path.relative(repoRoot, task.cwd) || "." : undefined,
		native: taskNeedsNative(task.key),
		rust: taskNeedsRust(task.key),
		nativeBuild: isNativeBuildKey(task.key),
	}));
}

// `--matrix-json` prints the planned tasks as a JSON array on stdout (consumed
// by tests and for debugging). Under GitHub Actions it also appends the dev-ci
// planner outputs: `matrix` (the shard include list, excluding native-build
// tasks), `has_tasks`, `has_native`, and the resolved `changed_paths` so every
// downstream job reuses the planner's exact diff via CI_DEV_CHANGED_PATHS
// instead of re-resolving the base ref on each runner.
async function emitMatrix(): Promise<void> {
	const paths = await getChangedPaths();
	const tasks = await resolvePlannedTasks(paths);
	const entries = describeTasks(tasks);

	console.log(JSON.stringify(entries));

	const githubOutput = process.env.GITHUB_OUTPUT;
	if (!githubOutput) {
		return;
	}
	const shards = entries
		.filter(entry => !entry.nativeBuild)
		.map(entry => ({ key: entry.key, description: entry.description, native: entry.native, rust: entry.rust }));
	const hasNative = entries.some(entry => entry.nativeBuild);
	const lines = [
		`matrix=${JSON.stringify({ include: shards })}`,
		`has_tasks=${shards.length > 0}`,
		`has_native=${hasNative}`,
		"changed_paths<<__GJC_PATHS_EOF__",
		...paths,
		"__GJC_PATHS_EOF__",
		"",
	];
	await fs.appendFile(githubOutput, lines.join("\n"));
}

// `--native-build` runs every native build task in the current plan exactly
// once. The dedicated dev-ci native-build job uses it so the expensive native
// compile happens a single time per run instead of on each runtime shard.
async function runNativeBuild(): Promise<void> {
	const paths = await getChangedPaths();
	const tasks = (await resolvePlannedTasks(paths)).filter(task => isNativeBuildKey(task.key));
	if (tasks.length === 0) {
		console.log("ci-dev-affected: no native build tasks in plan; nothing to build.");
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

// `--task=<key>` runs exactly one planned task selected by key. Matrix shards
// use this to execute their single assigned task. An unknown key is a hard
// error so plan drift between the planner and a shard fails loudly instead of
// silently skipping validation.
async function runSingleTask(key: string): Promise<void> {
	const paths = await getChangedPaths();
	const tasks = await resolvePlannedTasks(paths);
	const task = tasks.find(candidate => candidate.key === key);
	if (!task) {
		const known = tasks.map(candidate => candidate.key).join(", ") || "(none)";
		console.error(`ci-dev-affected: task '${key}' is not in the current plan. Planned tasks: ${known}`);
		process.exit(1);
		return;
	}
	console.log(`\n::group::${task.description}`);
	const exitCode = await runCommand(task.command, task.cwd ?? repoRoot);
	console.log("::endgroup::");
	if (exitCode !== 0) {
		process.exit(exitCode);
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
		addNativeBuild(tasks);
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

// PR-mode targeted planner. For each changed path it emits the smallest safe set
// of tasks instead of the broad affected suite:
//   - docs/changelog-only -> nothing expensive
//   - workflow / CI harness scripts -> yaml-parse + ci-selftest + ci-dry-run
//   - a changed test file -> run exactly that test file (test:<path>)
//   - a source file with a directly-named test -> run that test file only
//   - a source file with no mapped test -> owning package check + relevant smoke
//   - rust/python/web/install changes -> their scoped check+test
// A genuine full-workspace config change still escalates to root check + test.
// Native builds are added once (native-linux-x64) only when a planned task needs
// the addon at runtime; the dedicated job restores it from cache when no native
// source changed, so PRs never rebuild native per shard.
export function planTargetedTasks(paths: readonly string[], packages: readonly WorkspacePackage[], testFiles: readonly string[]): Task[] {
	const tasks = new Map<string, Task>();
	const relevant = paths.filter(changedPath => !isDocOrChangelogPath(changedPath));
	if (relevant.length === 0) {
		return [];
	}

	const fullWorkspace = relevant.some(isFullWorkspacePath) && !isRootPackageReleaseHarnessOnly(relevant);
	let needCiSelftest = false;
	let needYamlParse = false;

	if (fullWorkspace) {
		add(tasks, "root-check", "Root TypeScript/tooling check", ["bun", "run", "check:ts"]);
		addNativeBuild(tasks);
		add(tasks, "root-test", "Root workspace TypeScript tests", ["bun", "run", "test:ts"]);
	}

	for (const changedPath of relevant) {
		if (isFullWorkspacePath(changedPath)) continue;
		if (isWorkflowPath(changedPath)) {
			needYamlParse = true;
			needCiSelftest = true;
			continue;
		}
		if (isCiHarnessScriptPath(changedPath)) {
			needCiSelftest = true;
			continue;
		}
		if (isPythonPath(changedPath)) {
			add(tasks, "python-lint", "Python lint", ["bun", "run", "lint:py"]);
			add(tasks, "python-test", "Python tests", ["bun", "run", "test:py"]);
			continue;
		}
		if (isWebPath(changedPath)) {
			add(tasks, "robogjc-web-typecheck", "robogjc web typecheck", packageScriptCommand("typecheck"), resolvePackageCwd("python/robogjc/web"));
			add(tasks, "robogjc-web-build", "robogjc web build", packageScriptCommand("build"), resolvePackageCwd("python/robogjc/web"));
			continue;
		}
		if (isRustPath(changedPath)) {
			add(tasks, "rust-check", "Rust check", ["bun", "run", "check:rs"]);
			add(tasks, "rust-test", "Rust tests", ["bun", "run", "test:rs"]);
			continue;
		}
		if (isInstallPath(changedPath)) {
			add(tasks, "install-methods", "Install method smoke tests", ["bun", "run", "ci:test:install-methods"]);
			continue;
		}

		const mappedTests = mappedTestsFor(changedPath, packages, testFiles);
		if (mappedTests.length > 0) {
			for (const testFile of mappedTests) {
				addTestFileTask(tasks, testFile);
			}
			continue;
		}

		const owner = owningPackage(changedPath, packages);
		if (owner) {
			if (owner.manifest.scripts?.check) {
				add(tasks, `check:${owner.name}`, `Check ${owner.name}`, packageScriptCommand("check"), resolvePackageCwd(owner.dir));
			}
			if (isCodingAgentRuntimePath(changedPath)) {
				add(tasks, "cli-smoke", "GJC CLI smoke test", ["bun", "run", "ci:test:smoke"]);
			}
			if (isUnscopedWrapperPath(changedPath)) {
				add(tasks, "wrapper-version", "Unscoped wrapper CLI version smoke", ["bun", "packages/gajae-code/bin/gjc.js", "--version"]);
			}
			if (isReleasePublishPath(changedPath)) {
				add(tasks, "release-publish-contract", "Release publish contract tests", ["bun", "run", "test:release"]);
				add(tasks, "release-publish-dry-run", "Release publish dry-run", ["bun", "scripts/ci-release-publish.ts", "--dry-run"]);
			}
			continue;
		}

		// Unmapped root-level code/config (no owning package, no mapped test):
		// fall back to the root tooling typecheck rather than the full suite.
		if (isCodeIshPath(changedPath)) {
			add(tasks, "root-check", "Root TypeScript/tooling check", ["bun", "run", "check:ts"]);
		}
	}

	if (needCiSelftest) {
		add(tasks, "ci-selftest", "Affected CI selector unit tests", ["bun", "test", "scripts/ci-dev-affected.test.ts"]);
		add(tasks, "ci-dry-run", "Affected CI selector dry-run", ["bun", "scripts/ci-dev-affected.ts", "--dry-run"]);
	}
	if (needYamlParse) {
		add(tasks, "yaml-parse", "Workflow YAML parse check", ["bun", "scripts/check-workflow-yaml.ts"]);
	}

	ensureNativeBuild(tasks);

	return Array.from(tasks.values());
}

// Add a task that runs exactly one test file. Keyed as `test:<repo-relative-path>`
// so the matrix shard name stays small and directly traceable to the file.
function addTestFileTask(tasks: Map<string, Task>, testFile: string): void {
	add(tasks, `test:${testFile}`, `Test ${testFile}`, ["bun", "test", testFile]);
}

// Resolve the directly-named test(s) for a changed path: the changed file itself
// if it is a test, otherwise test files whose basename is `<base>.test.ts(x)` and
// which live within the changed file's owning package (or its directory for
// root-level files). Returns [] when there is no direct mapping.
function mappedTestsFor(changedPath: string, packages: readonly WorkspacePackage[], testFiles: readonly string[]): string[] {
	if (isTestFilePath(changedPath)) {
		return [changedPath];
	}
	const base = path.posix.basename(changedPath).replace(/\.(tsx?|jsx?|mts|cts)$/, "");
	if (base === "") {
		return [];
	}
	const wanted = new Set([`${base}.test.ts`, `${base}.test.tsx`]);
	const owner = owningPackage(changedPath, packages);
	const scopePrefix = owner ? `${owner.dir}/` : `${path.posix.dirname(changedPath)}/`;
	return testFiles.filter(testFile => wanted.has(path.posix.basename(testFile)) && testFile.startsWith(scopePrefix));
}

function owningPackage(changedPath: string, packages: readonly WorkspacePackage[]): WorkspacePackage | undefined {
	return packages.find(workspacePackage => changedPath === workspacePackage.dir || changedPath.startsWith(`${workspacePackage.dir}/`));
}

// Ensure a single native build task is present whenever any planned task loads
// the native addon at runtime, preserving the invariant that native-consuming
// shards always have an artifact to download.
function ensureNativeBuild(tasks: Map<string, Task>): void {
	const keys = Array.from(tasks.keys());
	if (keys.some(taskNeedsNative) && !keys.some(isNativeBuildKey)) {
		addNativeBuild(tasks);
	}
}

function isDocOrChangelogPath(changedPath: string): boolean {
	return changedPath.endsWith(".md") || changedPath.startsWith("docs/") || changedPath.startsWith(".gjc/");
}

function isTestFilePath(changedPath: string): boolean {
	return /\.test\.tsx?$/.test(changedPath);
}

function isCiHarnessScriptPath(changedPath: string): boolean {
	return changedPath === "scripts/ci-dev-affected.ts" || changedPath === "scripts/ci-dev-affected.test.ts" || changedPath === "scripts/check-workflow-yaml.ts";
}

function isWebPath(changedPath: string): boolean {
	return changedPath.startsWith("python/robogjc/web/");
}

function isCodeIshPath(changedPath: string): boolean {
	return /\.(tsx?|jsx?|mts|cts|mjs|cjs|json|jsonc|toml|ya?ml|sh)$/.test(changedPath) || changedPath === "bun.lock";
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
