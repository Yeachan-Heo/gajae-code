#!/usr/bin/env bun

import { $ } from "bun";
import * as path from "node:path";
import * as fs from "node:fs/promises";

const repoRoot = path.join(import.meta.dir, "..");
const ZERO_SHA = /^0+$/;
const PACKAGE_SCOPES = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const;
// The coding-agent package has hundreds of test files; keep affected validation
// below the shard timeout by splitting package-wide/full-workspace TypeScript
// suites across the matrix. Dev keeps the default; Main CI full mode overrides
// via CI_CODING_AGENT_TEST_SHARDS to bound the long tail.
const DEFAULT_CODING_AGENT_TEST_SHARDS = 8;

function codingAgentTestShards(): number {
	return positiveIntFromEnv("CI_CODING_AGENT_TEST_SHARDS", DEFAULT_CODING_AGENT_TEST_SHARDS);
}

// Number of nextest partitions the rust-test suite is split into. Dev runs one
// unpartitioned rust-test task; Main CI full mode raises this to bound the
// rust-test long tail.
const DEFAULT_RUST_TEST_PARTITIONS = 1;

function rustTestPartitions(): number {
	return positiveIntFromEnv("CI_RUST_TEST_PARTITIONS", DEFAULT_RUST_TEST_PARTITIONS);
}

function positiveIntFromEnv(name: string, fallback: number): number {
	const raw = Bun.env[name]?.trim();
	if (!raw) return fallback;
	const parsed = Number.parseInt(raw, 10);
	return Number.isInteger(parsed) && parsed >= 1 ? parsed : fallback;
}

// True when Main CI requests the deterministic full plan via `CI_FORCE_FULL`.
function isForceFullMode(): boolean {
	const raw = Bun.env.CI_FORCE_FULL?.trim();
	return raw === "1" || raw === "true";
}
// SDK host lifecycle and coordinator prompt-control changes need the stable first
// package shard in addition to targeted coverage. Keep this list limited to the
// stateful surfaces whose regressions depend on broader package ordering.
const CODING_AGENT_SHARD_ONE_COVERAGE_PATHS = [
	"packages/coding-agent/src/sdk/bus/",
	"packages/coding-agent/src/sdk/host/",
	"packages/coding-agent/src/coordinator-mcp/",
	"packages/coding-agent/test/sdk-host-wiring.test.ts",
	"packages/coding-agent/test/coordinator-mcp/send-prompt-concurrency.test.ts",
] as const;


// Keys for tasks that compile the @gajae-code/natives addon. They run once in
// the dedicated dev-ci native-build job (not as matrix shards) and publish the
// built `.node` files as an artifact the runtime-dependent shards download.
// Declared here (before the top-level `await main()`) so it is initialized for
// every CLI mode despite top-level await halting later module statements.
const NATIVE_BUILD_KEYS: ReadonlySet<string> = new Set(["native-build", "native-linux-x64"]);

// Behavioral-owner tests cover entrypoint contracts whose names intentionally do
// not follow the source-file basename convention. They supplement, rather than
// replace, direct-basename test selection and owner fallback tasks.
const BEHAVIORAL_OWNER_TESTS: Readonly<Record<string, readonly string[]>> = {
	"artifacts/architecture-2383-eval.json": ["packages/ai/test/anthropic-cache-eval.integration.test.ts"],
	"packages/coding-agent/src/main.ts": ["packages/coding-agent/test/startup-update-contract.test.ts"],
};

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
	identity?: string;
	description: string;
	command: readonly string[];
	cwd?: string;
	capabilities?: TaskCapabilities;
	phase?: "legacy" | "native-producer" | "ts-build" | "cargo-build" | "python";
}

export interface TaskCapabilities {
	rust: boolean;
	nextest: boolean;
	nativeConsumer: boolean;
	nativeProducer: boolean;
}

export interface TsInventoryUnit {
	id: string;
	name: string;
	dir: string;
	nativeConsumer: boolean;
	nativeProducer: boolean;
}

export interface CargoInventoryUnit {
	id: string;
	name: string;
	manifestPath: string;
	supported: true;
	nativeAddonSource: boolean;
}

export interface CargoWorkspaceEmergency {
	id: "cargo-workspace-emergency";
	key: "cargo-build:emergency:workspace";
	identity: "emergency:cargo-workspace:root";
	command: readonly ["cargo", "build", "--workspace"];
	cwd: ".";
	capabilities: TaskCapabilities;
	allowedReasons: readonly ["cargo-name-ambiguity"];
}

export interface BuildInventory {
	schemaVersion: 1;
	typescript: readonly TsInventoryUnit[];
	cargo: readonly CargoInventoryUnit[];
	emergency: { cargoWorkspaceBuild?: CargoWorkspaceEmergency };
}

// Machine-readable descriptor for one planned task, emitted by `--matrix-json`
// so dev-ci can fan the plan out across runners. `native`/`rust` declare the
// per-task setup a single shard needs (prebuilt native addon / Rust toolchain);
// `nativeBuild` marks the addon-compilation tasks that run once in the dedicated
// native-build job rather than as shards.
export interface TaskMatrixEntry {
	key: string;
	identity: string;
	description: string;
	command: readonly string[];
	cwd?: string;
	native: boolean;
	rust: boolean;
	nextest: boolean;
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
	if (process.argv.includes("--validate-plan")) {
		if (!(await loadCanonicalPlan())) throw new Error("affected-plan-invalid: canonical plan is required");
		return;
	}
	if (process.argv.includes("--validate-shard-receipts")) {
		await validateShardReceipts();
		return;
	}
	if (process.argv.includes("--validate-aggregate")) {
		await validateAggregate();
		return;
	}
	if (process.argv.includes("--write-affected-evidence")) {
		await writeAffectedEvidence();
		return;
	}
	if (process.argv.includes("--validate-affected-evidence")) {
		await validateAffectedEvidence();
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


// CI runs in one of two planning modes:
//   - "pr": pull_request runs get a fast, narrowly targeted plan (run only the
//     tests/checks directly relevant to the changed paths).
//   - "push": push-to-dev (and any non-PR event) gets the broader/full affected
//     suite so the complete validation still runs once a change lands on dev.
// The mode is derived from GITHUB_EVENT_NAME, which GitHub sets on every job of
// a run, so the planner and every shard resolve the same mode deterministically.
export type PlanMode = "pr" | "push";

export function resolvePlanMode(): PlanMode {
	const explicitMode = Bun.env.CI_DEV_PLAN_MODE?.trim();
	if (explicitMode === "pr" || explicitMode === "push") {
		return explicitMode;
	}
	return Bun.env.GITHUB_EVENT_NAME?.trim() === "pull_request" ? "pr" : "push";
}

// Resolve the plan for the current changed paths and CI mode. PR mode builds the
// targeted plan from a filesystem index of test files (for source→test mapping);
// push mode reuses the broad affected planner unchanged.
// Main CI full mode: emit the complete task union regardless of changed paths so
// every check runs on `main`, and short-circuit the changed-path / canonical-plan
// machinery entirely. It is deterministic, so the planner and every shard resolve
// the identical plan without a shared plan artifact.
export function planFullTasks(packages: readonly WorkspacePackage[]): Task[] {
	const tasks = new Map<string, Task>();
	addNativeBuild(tasks);
	addWorkspaceTestTasks(tasks, packages);
	add(tasks, "rust-check", "Rust check", ["bun", "run", "check:rs"]);
	addRustTestTasks(tasks);
	add(tasks, "cli-smoke", "GJC CLI smoke test", ["bun", "run", "ci:test:smoke"]);
	addPythonTasks(tasks);
	add(tasks, "runtime-check", "Runtime checks (needs native addon)", ["bun", "run", "check:runtime"], resolvePackageCwd("packages/coding-agent"));
	// root-check (ci:check:full) is intentionally omitted: Main CI runs it in the
	// dedicated native-free `check` job, so emitting it here would double-run it.
	return Array.from(tasks.values());
}

// Emit the rust-test task, split into nextest partitions when configured. Each
// partition shards the test set (not a repeated full run) via `cargo nextest run
// --partition count:i/N`, wired through run-rs-task.ts.
function addRustTestTasks(tasks: Map<string, Task>): void {
	const partitions = rustTestPartitions();
	if (partitions <= 1) {
		add(tasks, "rust-test", "Rust tests", ["bun", "run", "test:rs"]);
		return;
	}
	for (let index = 1; index <= partitions; index++) {
		add(
			tasks,
			`rust-test:partition-${index}-of-${partitions}`,
			`Rust tests partition ${index}/${partitions}`,
			["bun", "scripts/run-rs-task.ts", "test:rs", `count:${index}/${partitions}`],
		);
	}
}


function addPythonTasks(tasks: Map<string, Task>): void {
	add(tasks, "python-check", "Python SDK type check", ["bun", "run", "check:py-sdk"], undefined, { rust: false, nextest: false, nativeConsumer: false, nativeProducer: false }, "python");
	add(tasks, "python-test", "Python SDK tests", ["bun", "run", "test:py-sdk"], undefined, { rust: false, nextest: false, nativeConsumer: true, nativeProducer: false }, "python");
	add(tasks, "python-build-smoke", "Python SDK build smoke", ["bun", "run", "ci:test:py-sdk-build"], undefined, { rust: false, nextest: false, nativeConsumer: false, nativeProducer: false }, "python");
}
async function resolvePlannedTasks(paths: readonly string[]): Promise<Task[]> {
	if (isForceFullMode()) return planFullTasks(await getWorkspacePackages());
	const fromArtifact = await loadCanonicalPlan();
	if (fromArtifact) return fromArtifact;
	const normalizedPaths = normalizeChangedPaths(paths);
	const packages = await getWorkspacePackages();
	const legacy = resolvePlanMode() === "pr"
		? planTargetedTasks(normalizedPaths, packages, await gatherTestFiles())
		: planTasks(normalizedPaths, packages);
	if (normalizedPaths.length > 0 && normalizedPaths.every(isDocOrChangelogPath)) return legacy;
	return appendBuildTasks(legacy, normalizedPaths, packages, await loadBuildInventory());
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
		key === "python-test" ||
		key === "root-test" ||
		key === "root-check" ||
		key === "check:@gajae-code/coding-agent" ||
		key === "cli-smoke" ||
		key === "runtime-check" ||
		key === "wrapper-version" ||
		key === "deep-interview-definitions" ||
		key === "deep-interview-runtime" ||
		key === "bridge-client-sdk-package-smoke" ||
		key.startsWith("test:")
	);
}

// rust-test may be split into nextest partitions (`rust-test:partition-i-of-N`)
// in Main CI full mode; treat every partition like the single rust-test task.
function isRustTestKey(key: string): boolean {
	return key === "rust-test" || key.startsWith("rust-test:partition-");
}

// Tasks that need the Rust toolchain (and nextest) provisioned on their shard.
function taskNeedsRust(key: string): boolean {
	return key === "rust-check" || isRustTestKey(key) || key === "ci-selftest" || key === "ci-dry-run" || key === "affected-selftest" || key === "affected-dry-run";
}

// Build the machine-readable descriptor list for the current changed-path plan.
// `cwd` is emitted repo-relative so the JSON stays portable across runners.
export function describeTasks(tasks: readonly Task[]): TaskMatrixEntry[] {
	return tasks.map(task => ({
		key: task.key,
		identity: canonicalTaskIdentity(task),
		description: task.description,
		command: task.command,
		cwd: task.cwd ? path.relative(repoRoot, task.cwd) || "." : undefined,
		native: task.capabilities?.nativeConsumer ?? taskNeedsNative(task.key),
		rust: task.capabilities?.rust ?? taskNeedsRust(task.key),
		nextest: task.capabilities?.nextest ?? isRustTestKey(task.key),
		nativeBuild: task.capabilities?.nativeProducer ?? isNativeBuildKey(task.key),
	}));
}

// `--matrix-json` prints the planned tasks as a JSON array on stdout (consumed
// by tests and for debugging). Under GitHub Actions it also appends the dev-ci
// planner outputs: `matrix`, `has_tasks`, `has_native`, and the canonical Darwin
// smoke flag. Downstream jobs reuse the planner's exact diff via
// CI_DEV_CHANGED_PATHS instead of re-resolving the base ref on each runner.
// Paths that affect the compiled tab-worker smoke graph. Keep this authoritative
// predicate in the planner: dev-ci consumes its emitted flag rather than copying
// path checks into individual jobs.
export function isDarwinArm64TabWorkerSmokePath(changedPath: string): boolean {
	// The compiled worker recursively loads browser, eval, scraper, and utility
	// helpers. Directory ownership is deliberately conservative so a newly-added
	// helper in those graph roots cannot silently bypass the Darwin smoke.
	return changedPath.startsWith("packages/coding-agent/src/tools/browser/") ||
		changedPath.startsWith("packages/coding-agent/src/tools/puppeteer/") ||
		changedPath.startsWith("packages/coding-agent/src/eval/js/") ||
		changedPath.startsWith("packages/coding-agent/src/web/scrapers/") ||
		changedPath.startsWith("packages/coding-agent/src/utils/") ||
		changedPath.startsWith("packages/utils/src/") ||
		changedPath === "packages/coding-agent/src/tools/tool-errors.ts" ||
		changedPath === "packages/coding-agent/src/tools/path-utils.ts" ||
		changedPath === "packages/coding-agent/src/cli.ts" ||
		changedPath === "packages/coding-agent/scripts/build-binary.ts" ||
		changedPath === "packages/coding-agent/scripts/compile-args.ts" ||
		changedPath.startsWith("packages/natives/") ||
		changedPath === "scripts/ci-build-native.ts";
}

export function needsDarwinArm64TabWorkerSmoke(paths: readonly string[]): boolean {
	return paths.some(isDarwinArm64TabWorkerSmokePath);
}

// Paths whose Windows drive-letter vs Volume-GUID canonicalization and Bun
// `node:fs` resident-cache write semantics the fix governs. On Ubuntu the
// windows-canonical-path regression suite is skipped by `describe.skipIf`, so a
// Linux shard cannot verify the ENOENT fix; dev-ci consumes this emitted flag to
// run and require the windows-latest job whenever any of these change.
export function isWindowsSessionPathRegressionPath(changedPath: string): boolean {
	return changedPath === "packages/coding-agent/src/session/internal/managed-session-scope.ts" ||
		changedPath === "packages/coding-agent/src/session/blob-store.ts" ||
		changedPath === "packages/coding-agent/src/session/session-manager.ts" ||
		changedPath === "packages/coding-agent/test/session-manager/windows-canonical-path.test.ts";
}

export function needsWindowsSessionPathRegression(paths: readonly string[]): boolean {
	return paths.some(isWindowsSessionPathRegressionPath);
}

// Main CI full mode: emit a lean matrix from the deterministic full plan. It
// deliberately skips the dev source-sha/checkout asserts, the canonical plan
// artifact, plan digest, and the Darwin smoke flag — Main CI re-derives the same
// full plan on every shard and gates on a simple aggregate job, not evidence
// receipts.
async function emitFullMatrix(): Promise<void> {
	const tasks = planFullTasks(await getWorkspacePackages());
	const entries = describeTasks(tasks);
	console.log(JSON.stringify(entries));

	const githubOutput = process.env.GITHUB_OUTPUT;
	if (!githubOutput) return;
	const shards = tasks
		.filter(task => task.capabilities?.nativeProducer !== true && task.phase !== "python")
		.map(task => {
			const entry = describeTasks([task])[0]!;
			return { key: entry.key, identity: entry.identity, description: entry.description, native: entry.native, rust: entry.rust, nextest: entry.nextest };
		});
	const hasNative = entries.some(entry => entry.nativeBuild);
	const hasPython = tasks.some(task => task.phase === "python");
	const lines = [
		`matrix=${JSON.stringify({ include: shards })}`,
		`has_tasks=${shards.length > 0}`,
		`has_native=${hasNative}`,
		`has_python=${hasPython}`,
		"",
	];
	await fs.appendFile(githubOutput, lines.join("\n"));
}

async function emitMatrix(): Promise<void> {
	if (isForceFullMode()) return emitFullMatrix();
	const sourceSha = await resolveSourceSha();
	await requireCommitObject(sourceSha, "source head");
	await assertCheckedOutSourceHead(sourceSha);
	const paths = normalizeChangedPaths(await getChangedPaths());
	const mode = resolvePlanMode();
	const tasks = await resolvePlannedTasks(paths);
	const entries = describeTasks(tasks);
	const canonical = JSON.stringify({ schemaVersion: 1, sourceSha, mode, paths, tasks: serializeTasks(tasks) });
	const digest = new Bun.CryptoHasher("sha256").update(canonical).digest("hex");
	await Bun.write(path.join(repoRoot, ".ci-dev-affected-plan.json"), canonical);
	console.log(JSON.stringify(entries));

	const githubOutput = process.env.GITHUB_OUTPUT;
	if (!githubOutput) return;
	const shards = tasks
		.filter(task => task.capabilities?.nativeProducer !== true && task.phase !== "python")
		.map(task => {
			const entry = describeTasks([task])[0]!;
			return { key: entry.key, identity: entry.identity, description: entry.description, native: entry.native, rust: entry.rust, nextest: entry.nextest };
		});
	const hasNative = entries.some(entry => entry.nativeBuild);
	const hasPython = tasks.some(task => task.phase === "python");
	const hasDarwinArm64TabWorkerSmoke = needsDarwinArm64TabWorkerSmoke(paths);
	const hasWindowsSessionPath = needsWindowsSessionPathRegression(paths);
	const lines = [
		`matrix=${JSON.stringify({ include: shards })}`,
		`has_tasks=${shards.length > 0}`,
		`has_native=${hasNative}`,
		`has_python=${hasPython}`,
		`has_darwin_arm64_tab_worker_smoke=${hasDarwinArm64TabWorkerSmoke}`,
		`has_windows_session_path=${hasWindowsSessionPath}`,
		`plan_digest=${digest}`,
		`plan_source_sha=${sourceSha}`,
		`plan_mode=${mode}`,
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
	if (isForceFullMode()) return [];
	const explicitPaths = Bun.env.CI_DEV_CHANGED_PATHS?.trim();
	if (explicitPaths) {
		return explicitPaths
			.split(/[\n,]/)
			.map(entry => entry.trim())
			.filter(Boolean)
			.sort();
	}

	const base = await resolveBaseRef();
	const head = await resolveSourceSha();
	await requireCommitObject(base, "base");
	await requireCommitObject(head, "source head");
	const range = `${base}..${head}`;
	const diff = await $`git diff --name-only -z ${range}`.cwd(repoRoot).quiet().nothrow();
	if (diff.exitCode !== 0) {
		const stderr = diff.stderr.toString().trim();
		throw new Error(`Failed to compute changed paths for ${range}: ${stderr}`);
	}
	return new TextDecoder().decode(diff.stdout).split("\0").filter(Boolean).sort();
}

async function requireCommitObject(ref: string, label: string): Promise<void> {
	const result = await $`git cat-file -e ${`${ref}^{commit}`}`.cwd(repoRoot).quiet().nothrow();
	if (result.exitCode !== 0) throw new Error(`Failed to compute changed paths: ${label} '${ref}' is not available`);
}

async function resolveSourceSha(): Promise<string> {
	const configured = Bun.env.CI_DEV_SOURCE_SHA?.trim() || Bun.env.GITHUB_SHA?.trim();
	if (configured) return configured;
	const checkedOut = await $`git rev-parse HEAD`.cwd(repoRoot).quiet().nothrow();
	if (checkedOut.exitCode !== 0) throw new Error("Failed to resolve source head");
	return checkedOut.stdout.toString().trim();
}

async function assertCheckedOutSourceHead(sourceSha: string): Promise<void> {
	const checkedOut = await $`git rev-parse HEAD`.cwd(repoRoot).quiet().nothrow();
	if (checkedOut.exitCode !== 0 || checkedOut.stdout.toString().trim() !== sourceSha) {
		throw new Error(`Failed to publish affected plan: checked-out SHA does not match source head '${sourceSha}'`);
	}
}

async function resolveBaseRef(): Promise<string> {
	const eventName = Bun.env.GITHUB_EVENT_NAME?.trim();
	const before = Bun.env.GITHUB_EVENT_BEFORE?.trim();
	const baseSha = Bun.env.GITHUB_BASE_SHA?.trim();
	const baseRef = Bun.env.GITHUB_BASE_REF?.trim();

	// A PR event supplies its immutable base commit. Prefer it over the mutable
	// branch ref: the base branch can be force-pushed after the event is queued,
	// leaving the current origin/<baseRef> unrelated to the checked-out PR head.
	if (eventName === "pull_request" && baseSha && !ZERO_SHA.test(baseSha)) {
		return baseSha;
	}
	if (eventName === "pull_request" && baseRef) {
		const mergeBase = await $`git merge-base HEAD ${`origin/${baseRef}`}`.cwd(repoRoot).quiet().nothrow();
		if (mergeBase.exitCode === 0) {
			const value = mergeBase.stdout.toString().trim();
			if (value !== "") return value;
		}
		if (baseSha && !ZERO_SHA.test(baseSha)) return baseSha;
		return `origin/${baseRef}`;
	}
	if (baseSha && !ZERO_SHA.test(baseSha)) {
		return baseSha;
	}
	if (eventName === "pull_request" && baseRef) {
		return `origin/${baseRef}`;
	}
	if (before && !ZERO_SHA.test(before)) {
		return before;
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
		add(tasks, "root-check", "Root TypeScript/tooling check", ["bun", "run", "ci:check:full"]);
		addNativeBuild(tasks);
		addWorkspaceTestTasks(tasks, packages);
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
				addPackageTestTasks(tasks, workspacePackage);
			}
		}
	}
	if (needsDarwinArm64TabWorkerSmoke(paths)) {
		add(tasks, "install-methods", "Install method smoke tests", ["bun", "run", "ci:test:install-methods"]);
	}

	if (toolingScriptChanged && !fullWorkspace && !ciOnly && !workflowHarnessOnly) {
		add(tasks, "root-check", "Root TypeScript/tooling check", ["bun", "run", "ci:check:full"]);
	}
	if (wrapperChanged) {
		add(tasks, "wrapper-version", "Unscoped wrapper CLI version smoke", ["bun", "packages/gajae-code/bin/gjc.js", "--version"]);
	}
	if (publishChanged) {
		addReleasePublishTasks(tasks);
	}
	if (paths.some(isBridgeClientSdkPackageSmokePath)) {
		add(tasks, "bridge-client-sdk-package-smoke", "Bridge-client SDK package smoke", ["bun", "packages/coding-agent/scripts/build-sdk-package-smoke.ts"]);
	}

	if (paths.some(isPythonPath)) {
		addPythonTasks(tasks);
		addNativeBuild(tasks);
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
		add(tasks, "affected-selftest", "Affected CI selector unit tests", ["bun", "test", "scripts/ci-dev-affected.test.ts", "scripts/dev-ci-guard-topology.test.ts"]);
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
		add(tasks, "root-check", "Root TypeScript/tooling check", ["bun", "run", "ci:check:full"]);
		addNativeBuild(tasks);
		addWorkspaceTestTasks(tasks, packages);
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
		if (isRustPath(changedPath)) {
			add(tasks, "rust-check", "Rust check", ["bun", "run", "check:rs"]);
			add(tasks, "rust-test", "Rust tests", ["bun", "run", "test:rs"]);
			continue;
		}
		if (isPythonPath(changedPath)) {
			addPythonTasks(tasks);
			continue;
		}
		if (isInstallPath(changedPath)) {
			add(tasks, "install-methods", "Install method smoke tests", ["bun", "run", "ci:test:install-methods"]);
			continue;
		}
		if (isReleasePublishPath(changedPath)) {
			addReleasePublishTasks(tasks);
			if (isUnscopedWrapperPath(changedPath)) {
				add(tasks, "wrapper-version", "Unscoped wrapper CLI version smoke", ["bun", "packages/gajae-code/bin/gjc.js", "--version"]);
			}
		}
		if (isBridgeClientSdkPackageSmokePath(changedPath)) {
			add(tasks, "bridge-client-sdk-package-smoke", "Bridge-client SDK package smoke", ["bun", "packages/coding-agent/scripts/build-sdk-package-smoke.ts"]);
			const bridgeClientOwner = owningPackage(changedPath, packages);
			if (bridgeClientOwner?.manifest.scripts?.check) {
				add(
					tasks,
					`check:${bridgeClientOwner.name}`,
					`Check ${bridgeClientOwner.name}`,
					packageScriptCommand("check"),
					resolvePackageCwd(bridgeClientOwner.dir),
				);
			}
		}


		const mappedTests = mappedTestsFor(changedPath, packages, testFiles);
		for (const testFile of mappedTests) {
			addTestFileTask(tasks, testFile);
		}
		for (const testFile of behavioralTestsFor(changedPath)) {
			addTestFileTask(tasks, testFile);
		}
		if (isCodingAgentShardOneCoveragePath(changedPath)) {
			addCodingAgentTestShard(tasks, 1);
		}

		if (mappedTests.length > 0) {
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
			continue;
		}

		// Unmapped root-level code/config (no owning package, no mapped test):
		// fall back to the root tooling typecheck rather than the full suite.
		if (isCodeIshPath(changedPath)) {
			add(tasks, "root-check", "Root TypeScript/tooling check", ["bun", "run", "ci:check:full"]);
		}
	}

	if (needsDarwinArm64TabWorkerSmoke(relevant)) {
		add(tasks, "install-methods", "Install method smoke tests", ["bun", "run", "ci:test:install-methods"]);
	}
	if (needCiSelftest) {
		add(tasks, "ci-selftest", "Affected CI selector unit tests", ["bun", "test", "scripts/ci-dev-affected.test.ts", "scripts/dev-ci-guard-topology.test.ts"]);
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

function addWorkspaceTestTasks(tasks: Map<string, Task>, packages: readonly WorkspacePackage[]): void {
	add(tasks, "root-test:release", "Root release contract tests", ["bun", "run", "test:release"]);
	for (const workspacePackage of packages) {
		if (workspacePackage.manifest.scripts?.test) {
			addPackageTestTasks(tasks, workspacePackage);
		}
	}
}

function addPackageTestTasks(tasks: Map<string, Task>, workspacePackage: WorkspacePackage): void {
	if (workspacePackage.name !== "@gajae-code/coding-agent") {
		add(tasks, `test:${workspacePackage.name}`, `Test ${workspacePackage.name}`, packageScriptCommand("test"), resolvePackageCwd(workspacePackage.dir));
		return;
	}

	const total = codingAgentTestShards();
	for (let shard = 1; shard <= total; shard++) {
		addCodingAgentTestShard(tasks, shard, total);
	}
}

function addCodingAgentTestShard(tasks: Map<string, Task>, shard: number, total: number = codingAgentTestShards()): void {
	add(
		tasks,
		`test:@gajae-code/coding-agent:shard-${shard}-of-${total}`,
		`Test @gajae-code/coding-agent shard ${shard}/${total}`,
		["bun", "test", `--shard=${shard}/${total}`],
		resolvePackageCwd("packages/coding-agent"),
	);
}

// Resolve the directly-named test(s) for a changed path: the changed file itself
// if it is a test, otherwise test files whose basename is `<base>.test.ts(x)` and
// which live within the changed file's owning package (or its directory for
// root-level files). Returns [] when there is no unique direct mapping, so basename
// collisions fall back to package-level checks instead of selecting arbitrary tests.
function mappedTestsFor(changedPath: string, packages: readonly WorkspacePackage[], testFiles: readonly string[]): string[] {
	if (isTestFilePath(changedPath)) {
		return testFiles.includes(changedPath) ? [changedPath] : [];
	}
	const base = path.posix.basename(changedPath).replace(/\.(tsx?|jsx?|mts|cts)$/, "");
	if (base === "") {
		return [];
	}
	const wanted = new Set([`${base}.test.ts`, `${base}.test.tsx`]);
	const owner = owningPackage(changedPath, packages);
	const scopePrefix = owner ? `${owner.dir}/` : `${path.posix.dirname(changedPath)}/`;
	const matches = testFiles.filter(
		testFile => wanted.has(path.posix.basename(testFile)) && testFile.startsWith(scopePrefix),
	);
	return matches.length === 1 ? matches : [];
}

// Resolve explicit behavioral-owner tests. Unlike mappedTestsFor(), these tests
// are additive because an entrypoint's package-level check and smoke coverage
// remain necessary even when it owns a dedicated contract test.
function behavioralTestsFor(changedPath: string): readonly string[] {
	return BEHAVIORAL_OWNER_TESTS[changedPath] ?? [];
}

function isCodingAgentShardOneCoveragePath(changedPath: string): boolean {
	return CODING_AGENT_SHARD_ONE_COVERAGE_PATHS.some(coveragePath =>
		coveragePath.endsWith("/") ? changedPath.startsWith(coveragePath) : changedPath === coveragePath,
	);
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
	return changedPath === "scripts/ci-dev-affected.ts" || changedPath === "scripts/ci-dev-affected.test.ts" || changedPath === "scripts/dev-ci-guard-topology.test.ts" || changedPath === "scripts/check-workflow-yaml.ts";
}


function isCodeIshPath(changedPath: string): boolean {
	return /\.(tsx?|jsx?|mts|cts|mjs|cjs|json|jsonc|toml|ya?ml|sh)$/.test(changedPath) || changedPath === "bun.lock";
}


function addNativeBuild(tasks: Map<string, Task>): void {
	add(tasks, "native-linux-x64", "Build linux x64 native addons", ["bash", "-lc", 'TARGET_VARIANTS="baseline modern" bun scripts/ci-build-native.ts']);
}

function add(
	tasks: Map<string, Task>,
	key: string,
	description: string,
	command: readonly string[],
	cwd?: string,
	capabilities?: TaskCapabilities,
	phase?: Task["phase"],
): void {
	if (!tasks.has(key)) {
		tasks.set(key, { key, description, command, cwd, capabilities, phase });
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

export function expandWithDependents(touched: readonly WorkspacePackage[], packages: readonly WorkspacePackage[]): WorkspacePackage[] {
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

function addReleasePublishTasks(tasks: Map<string, Task>): void {
	add(tasks, "release-publish-contract", "Release publish contract tests", ["bun", "run", "test:release"]);
	add(tasks, "release-publish-dry-run", "Release publish dry-run", ["bun", "scripts/ci-release-publish.ts", "--dry-run"]);
	addTestFileTask(tasks, "scripts/release-evidence.test.ts");
}


function isPythonPath(changedPath: string): boolean {
	return changedPath.startsWith("python/gjc-sdk/");
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

function isBridgeClientSdkPackageSmokePath(changedPath: string): boolean {
	return (
		changedPath.startsWith("packages/bridge-client/") ||
		changedPath.startsWith("packages/coding-agent/src/sdk/client/")
	);
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


const BUILD_INVENTORY_PATH = path.join(repoRoot, "scripts/ci-dev-affected-build-inventory.json");
const NATIVE_PRODUCER: Task = {
	key: "native-linux-x64",
	identity: "native:linux-x64:baseline-modern",
	description: "Build linux x64 native addons",
	command: ["bash", "-lc", 'TARGET_VARIANTS="baseline modern" bun scripts/ci-build-native.ts'],
	cwd: repoRoot,
	capabilities: { rust: true, nextest: false, nativeConsumer: false, nativeProducer: true },
	phase: "native-producer",
};

export function normalizeChangedPaths(paths: readonly string[]): string[] {
	const normalized = paths.map(entry => entry.replaceAll("\\", "/").trim()).map(entry => entry.replace(/^\.\//, ""));
	for (const entry of normalized) {
		if (!entry || entry.startsWith("/") || /^[A-Za-z]:\//.test(entry) || entry === ".." || entry.startsWith("../") || entry.includes("/../") || entry.split("/").some(part => part === "." || part === "")) {
			throw new Error(`affected-path-invalid: unsafe changed path '${entry}'`);
		}
	}
	return Array.from(new Set(normalized)).sort();
}

export async function loadBuildInventory(inventoryPath = BUILD_INVENTORY_PATH): Promise<BuildInventory> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(await Bun.file(inventoryPath).text());
	} catch (error) {
		throw new Error(`inventory-invalid: cannot read build inventory (${error instanceof Error ? error.message : String(error)})`);
	}
	if (!isRecord(parsed) || parsed.schemaVersion !== 1 || !Array.isArray(parsed.typescript) || !Array.isArray(parsed.cargo) || !isRecord(parsed.emergency)) {
		throw new Error("inventory-invalid: malformed build inventory");
	}
	assertExactKeys(parsed, ["schemaVersion", "typescript", "cargo", "emergency"], "build inventory");
	const inventory: BuildInventory = {
		schemaVersion: 1,
		typescript: parsed.typescript.map(parseTsInventoryUnit),
		cargo: parsed.cargo.map(parseCargoInventoryUnit),
		emergency: parseEmergency(parsed.emergency),
	};
	assertInventory(inventory);
	await assertTypeScriptInventoryLive(inventory);
	await expandCargoDependents(inventory.cargo, inventory.cargo, false);
	return inventory;
}

function parseTsInventoryUnit(value: unknown): TsInventoryUnit {
	if (!isRecord(value) || !isString(value.id) || !isString(value.name) || !isString(value.dir) || typeof value.nativeConsumer !== "boolean" || typeof value.nativeProducer !== "boolean") throw new Error("inventory-invalid: malformed TypeScript unit");
	assertExactKeys(value, ["id", "name", "dir", "nativeConsumer", "nativeProducer"], "TypeScript unit");
	return { id: value.id, name: value.name, dir: normalizeInventoryPath(value.dir), nativeConsumer: value.nativeConsumer, nativeProducer: value.nativeProducer };
}
function parseCargoInventoryUnit(value: unknown): CargoInventoryUnit {
	if (!isRecord(value) || !isString(value.id) || !isString(value.name) || !isString(value.manifestPath) || value.supported !== true || typeof value.nativeAddonSource !== "boolean") throw new Error("inventory-invalid: malformed Cargo unit");
	assertExactKeys(value, ["id", "name", "manifestPath", "supported", "nativeAddonSource"], "Cargo unit");
	return { id: value.id, name: value.name, manifestPath: normalizeInventoryPath(value.manifestPath), supported: true, nativeAddonSource: value.nativeAddonSource };
}
function parseEmergency(value: Record<string, unknown>): BuildInventory["emergency"] {
	if (Object.keys(value).some(key => key !== "cargoWorkspaceBuild")) throw new Error("inventory-invalid: unexpected emergency field");
	const emergency = value.cargoWorkspaceBuild;
	if (emergency === undefined) return {};
	if (!isRecord(emergency) || emergency.id !== "cargo-workspace-emergency" || emergency.key !== "cargo-build:emergency:workspace" || emergency.identity !== "emergency:cargo-workspace:root" || !Array.isArray(emergency.command) || emergency.command.join("\0") !== "cargo\0build\0--workspace" || emergency.cwd !== "." || !isRecord(emergency.capabilities) || emergency.allowedReasons === undefined || !Array.isArray(emergency.allowedReasons) || emergency.allowedReasons.join("\0") !== "cargo-name-ambiguity") throw new Error("inventory-invalid: malformed cargo workspace emergency");
	assertExactKeys(emergency, ["id", "key", "identity", "command", "cwd", "capabilities", "allowedReasons"], "cargo workspace emergency");
	const capabilities = emergency.capabilities;
	if (capabilities.rust !== true || capabilities.nextest !== false || capabilities.nativeConsumer !== false || capabilities.nativeProducer !== false) throw new Error("inventory-invalid: malformed cargo workspace emergency capabilities");
	assertExactKeys(capabilities, ["rust", "nextest", "nativeConsumer", "nativeProducer"], "cargo workspace emergency capabilities");
	return { cargoWorkspaceBuild: { id: "cargo-workspace-emergency", key: "cargo-build:emergency:workspace", identity: "emergency:cargo-workspace:root", command: ["cargo", "build", "--workspace"], cwd: ".", capabilities: { rust: true, nextest: false, nativeConsumer: false, nativeProducer: false }, allowedReasons: ["cargo-name-ambiguity"] } };
}
function normalizeInventoryPath(value: string): string {
	const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
	if (!normalized || normalized.startsWith("/") || normalized.includes("../") || normalized.split("/").some(part => !part || part === ".")) throw new Error("inventory-invalid: unsafe inventory path");
	return normalized;
}
function assertInventory(inventory: BuildInventory): void {
	const unique = (values: readonly string[], label: string) => { if (new Set(values).size !== values.length) throw new Error(`inventory-invalid: duplicate ${label}`); };
	unique(inventory.typescript.map(unit => unit.id), "TypeScript id");
	unique(inventory.typescript.map(unit => unit.name), "TypeScript name");
	unique(inventory.typescript.map(unit => unit.dir), "TypeScript directory");
	unique(inventory.cargo.map(unit => unit.id), "Cargo id");
	unique(inventory.cargo.map(unit => unit.manifestPath), "Cargo manifest path");
	const nativeSources = inventory.cargo.filter(unit => unit.nativeAddonSource);
	if (nativeSources.length !== 1 || nativeSources[0]?.id !== "pi-natives") throw new Error("inventory-invalid: pi-natives must be the sole native addon source");
	const counts = new Map<string, number>();
	for (const unit of inventory.cargo) counts.set(unit.name, (counts.get(unit.name) ?? 0) + 1);
	if (Array.from(counts.values()).some(count => count > 1) && !inventory.emergency.cargoWorkspaceBuild) throw new Error("inventory-invalid: duplicate Cargo names require workspace emergency");
}

async function assertTypeScriptInventoryLive(inventory: BuildInventory): Promise<void> {
	const workspaces = await getWorkspacePackages();
	const buildable = workspaces.filter(workspacePackage => workspacePackage.name !== "@gajae-code/natives" && workspacePackage.manifest.scripts?.build);
	const classified = inventory.typescript.filter(unit => !unit.nativeProducer);
	const buildableNames = new Set(buildable.map(workspacePackage => workspacePackage.name));
	const classifiedNames = new Set(classified.map(unit => unit.name));
	if (buildableNames.size !== classifiedNames.size || Array.from(buildableNames).some(name => !classifiedNames.has(name))) {
		throw new Error("inventory-drift: TypeScript build-capable workspaces are not fully classified");
	}
	for (const unit of inventory.typescript) {
		const manifest = await readPackageManifest(path.join(repoRoot, unit.dir, "package.json"));
		if (!manifest || manifest.name !== unit.name || (!unit.nativeProducer && !manifest.scripts?.build)) throw new Error(`inventory-drift: TypeScript build unit ${unit.id} does not match its package manifest`);
	}
}

async function appendBuildTasks(legacy: readonly Task[], paths: readonly string[], packages: readonly WorkspacePackage[], inventory: BuildInventory): Promise<Task[]> {
	const withoutNative = legacy.filter(task => !isNativeBuildKey(task.key));
	const buildPaths = paths.filter(changedPath => !isDocOrChangelogPath(changedPath));
	const selectedTs = selectTsBuildUnits(buildPaths, packages, inventory);
	const cargo = await selectCargoBuildTasks(buildPaths, inventory, packages);
	const legacyNeedsProducer = legacy.some(task => isNativeBuildKey(task.key)) || legacy.some(task => taskNeedsNative(task.key));
	const cargoNeedsProducer = inventory.cargo
		.filter(unit => unit.nativeAddonSource)
		.some(unit => cargo.some(task => task.key === inventory.emergency.cargoWorkspaceBuild?.key || task.identity === stableIdentity("cargo", unit.id, unit.manifestPath)));
	const needsProducer = legacyNeedsProducer || selectedTs.some(unit => unit.nativeConsumer || unit.nativeProducer) || cargoNeedsProducer;
	const tsTasks = selectedTs.map(unit => ({ key: `ts-build:${stableIdentity("ts", unit.id, unit.dir)}`, identity: stableIdentity("ts", unit.id, unit.dir), description: `Build ${unit.name}`, command: ["bun", "run", "build"] as const, cwd: resolvePackageCwd(unit.dir), capabilities: { rust: false, nextest: false, nativeConsumer: unit.nativeConsumer, nativeProducer: unit.nativeProducer }, phase: "ts-build" as const }));
	return [...withoutNative, ...(needsProducer ? [NATIVE_PRODUCER] : []), ...tsTasks, ...cargo];
}
function selectTsBuildUnits(paths: readonly string[], packages: readonly WorkspacePackage[], inventory: BuildInventory): TsInventoryUnit[] {
	const selected = allBuildFallback(paths, packages)
		? packages
		: expandWithDependents(findTouchedPackages(paths, packages), packages);
	const names = new Set(selected.map(unit => unit.name));
	return inventory.typescript.filter(unit => names.has(unit.name)).sort(compareTsUnits);
}
function allBuildFallback(paths: readonly string[], packages: readonly WorkspacePackage[]): boolean {
	return paths.some(changedPath =>
		isFullWorkspacePath(changedPath) ||
		changedPath === "bun.lock" ||
		changedPath.startsWith("tsconfig") ||
		isWorkflowHarnessPath(changedPath) ||
		changedPath === "scripts/ci-dev-affected-build-inventory.json" ||
		(!isDocOrChangelogPath(changedPath) && !owningPackage(changedPath, packages)),
	);
}
function compareTsUnits(left: TsInventoryUnit, right: TsInventoryUnit): number { return left.dir.localeCompare(right.dir) || left.name.localeCompare(right.name) || left.id.localeCompare(right.id); }
function stableIdentity(domain: string, id: string, location: string): string { return `${domain}:${toBase64Url(id)}:${toBase64Url(location)}`; }
function toBase64Url(value: string): string { return Buffer.from(value).toString("base64url"); }

async function selectCargoBuildTasks(paths: readonly string[], inventory: BuildInventory, packages: readonly WorkspacePackage[]): Promise<Task[]> {
	const supported = inventory.cargo.filter(unit => unit.supported);
	const fallbackAll = paths.some(changedPath =>
		changedPath === "Cargo.toml" ||
		changedPath === "Cargo.lock" ||
		changedPath === "rust-toolchain.toml" ||
		changedPath.startsWith(".cargo/") ||
		isFullWorkspacePath(changedPath) ||
		isWorkflowHarnessPath(changedPath) ||
		changedPath === "scripts/ci-dev-affected-build-inventory.json" ||
		(!isDocOrChangelogPath(changedPath) && !changedPath.startsWith("crates/") && !owningPackage(changedPath, packages)),
	);
	if (!fallbackAll && !paths.some(isRustPath)) return [];
	const cargoChanged = paths.filter(isRustPath);
	const fallback = fallbackAll || cargoChanged.some(changed => !supported.some(unit => changed === unit.manifestPath || changed.startsWith(`${path.posix.dirname(unit.manifestPath)}/`)));
	let selected = fallback ? supported : supported.filter(unit => cargoChanged.some(changed => changed === unit.manifestPath || changed.startsWith(`${path.posix.dirname(unit.manifestPath)}/`)));
	if (!fallback) selected = await expandCargoDependents(selected, supported, true);
	if (requiresCargoWorkspaceEmergency(selected, supported)) {
		const emergency = inventory.emergency.cargoWorkspaceBuild;
		if (!emergency) throw new Error("inventory-invalid: duplicate selected Cargo name has no emergency");
		return [{
			key: emergency.key,
			identity: emergency.identity,
			description: "Build Cargo workspace",
			command: emergency.command,
			cwd: repoRoot,
			capabilities: emergency.capabilities,
			phase: "cargo-build",
		}];
	}
	return selected.sort((left, right) => left.manifestPath.localeCompare(right.manifestPath) || left.id.localeCompare(right.id)).map(unit => ({ key: `cargo-build:${stableIdentity("cargo", unit.id, unit.manifestPath)}`, identity: stableIdentity("cargo", unit.id, unit.manifestPath), description: `Build Cargo crate ${unit.name}`, command: ["cargo", "build", "--package", unit.name] as const, cwd: repoRoot, capabilities: { rust: true, nextest: false, nativeConsumer: false, nativeProducer: false }, phase: "cargo-build" as const }));
}

export function requiresCargoWorkspaceEmergency(
	selected: readonly CargoInventoryUnit[],
	supported: readonly CargoInventoryUnit[],
): boolean {
	const counts = new Map<string, number>();
	for (const unit of supported) counts.set(unit.name, (counts.get(unit.name) ?? 0) + 1);
	return selected.some(unit => (counts.get(unit.name) ?? 0) > 1);
}

async function expandCargoDependents(
	initial: readonly CargoInventoryUnit[],
	supported: readonly CargoInventoryUnit[],
	fallbackOnMetadataFailure: boolean,
): Promise<CargoInventoryUnit[]> {
	const metadata = await $`cargo metadata --format-version=1 --no-deps`.cwd(repoRoot).quiet().nothrow();
	if (metadata.exitCode !== 0) {
		if (fallbackOnMetadataFailure) return [...supported];
		throw new Error(`inventory-drift: cargo metadata failed: ${metadata.stderr.toString().trim()}`);
	}
	let decoded: unknown;
	try {
		decoded = JSON.parse(metadata.stdout.toString());
	} catch {
		if (fallbackOnMetadataFailure) return [...supported];
		throw new Error("inventory-drift: cargo metadata was not JSON");
	}
	if (!isRecord(decoded) || !Array.isArray(decoded.packages) || !Array.isArray(decoded.workspace_members) || !decoded.workspace_members.every(isString)) {
		if (fallbackOnMetadataFailure) return [...supported];
		throw new Error("inventory-drift: cargo metadata workspace inventory missing");
	}
	const byManifest = new Map<string, CargoInventoryUnit>();
	for (const unit of supported) byManifest.set(path.resolve(repoRoot, unit.manifestPath), unit);
	const byPackageId = new Map<string, CargoInventoryUnit>();
	for (const entry of decoded.packages) {
		if (!isRecord(entry) || !isString(entry.id) || !isString(entry.name) || !isString(entry.manifest_path)) continue;
		const unit = byManifest.get(path.resolve(entry.manifest_path));
		if (unit) {
			if (unit.name !== entry.name || byPackageId.has(entry.id)) throw new Error("inventory-drift: Cargo registry mapping mismatch");
			byPackageId.set(entry.id, unit);
		}
	}
	if (byPackageId.size !== supported.length) throw new Error("inventory-drift: supported Cargo inventory does not match metadata");
	const workspaceMemberIds = new Set(decoded.workspace_members as string[]);
	if (workspaceMemberIds.size !== supported.length || Array.from(workspaceMemberIds).some(id => !byPackageId.has(id))) {
		throw new Error("inventory-drift: Cargo workspace contains unclassified members");
	}
	const reverse = new Map<string, string[]>();
	for (const entry of decoded.packages) {
		if (!isRecord(entry) || !isString(entry.id) || !Array.isArray(entry.dependencies)) continue;
		for (const dependency of entry.dependencies) {
			if (!isRecord(dependency) || !isString(dependency.path)) continue;
			const dependencyUnit = byManifest.get(path.resolve(dependency.path, "Cargo.toml"));
			if (dependencyUnit) reverse.set(dependencyUnit.id, [...(reverse.get(dependencyUnit.id) ?? []), entry.id]);
		}
	}
	const selected = new Map(initial.map(unit => [unit.id, unit]));
	const queue = [...selected.keys()];
	while (queue.length > 0) {
		const current = queue.shift(); if (!current) continue;
		for (const packageId of reverse.get(current) ?? []) { const unit = byPackageId.get(packageId); if (unit && !selected.has(unit.id)) { selected.set(unit.id, unit); queue.push(unit.id); } }
	}
	return Array.from(selected.values());
}
function isWorkflowHarnessPath(changedPath: string): boolean {
	return (
		isWorkflowPath(changedPath) ||
		changedPath === "scripts/ci-dev-affected.ts" ||
		changedPath === "scripts/ci-dev-affected.test.ts" ||
		changedPath === "scripts/dev-ci-guard-topology.test.ts" ||
		changedPath === "scripts/check-workflow-yaml.ts"
	);
}

function isToolingScriptPath(changedPath: string): boolean {
	return changedPath.startsWith("scripts/") || changedPath === "bun.lock";
}

function isReleasePublishPath(changedPath: string): boolean {
	return (
		changedPath === "scripts/ci-release-publish.ts" ||
		changedPath === "scripts/release-evidence.ts" ||
		changedPath.startsWith("packages/bridge-client/") ||
		changedPath.startsWith("packages/gajae-code/") ||
		changedPath.startsWith("packages/natives-") ||
		changedPath === "packages/natives/package.json"
	);
}

function isUnscopedWrapperPath(changedPath: string): boolean {
	return changedPath.startsWith("packages/gajae-code/");
}

function isString(value: unknown): value is string {
	return typeof value === "string";
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
	if (Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))) throw new Error(`inventory-invalid: unexpected ${label} field`);
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

function serializeTasks(tasks: readonly Task[]): Task[] {
	return tasks.map(task => {
		const cwd = task.cwd ? path.relative(repoRoot, task.cwd) || "." : ".";
		return {
			key: task.key,
			identity: canonicalTaskIdentity(task),
			description: task.description,
			command: task.command,
			cwd,
			capabilities: task.capabilities ?? {
				rust: taskNeedsRust(task.key),
				nextest: isRustTestKey(task.key),
				nativeConsumer: taskNeedsNative(task.key),
				nativeProducer: isNativeBuildKey(task.key),
			},
			phase: task.phase ?? "legacy",
		};
	});
}

function canonicalTaskIdentity(task: Task): string {
	const cwd = task.cwd ? path.relative(repoRoot, task.cwd) || "." : ".";
	return task.identity ?? `legacy:${toBase64Url(task.key)}:${toBase64Url(cwd)}`;
}

export interface AffectedAggregateResults {
	plan: string;
	native: string;
	shards: string;
	python: string;
	windowsDoctor: string;
	windowsDoctorRequired: string;
	telegramGuard: string;
	telegramGuardRequired: string;
	telegramWindows: string;
	telegramWindowsRequired: string;
	hasNative: string;
	hasTasks: string;
	hasPython: string;
	darwinArm64TabWorkerSmoke: string;
	darwinArm64TabWorkerSmokeRequired: string;
}

export function validateAffectedAggregate(results: AffectedAggregateResults): void {
	if (results.plan !== "success") throw new Error("planner did not succeed");
	if (results.hasNative !== "true" && results.hasNative !== "false") throw new Error(`planner emitted invalid has_native=${results.hasNative}`);
	if (results.hasTasks !== "true" && results.hasTasks !== "false") throw new Error(`planner emitted invalid has_tasks=${results.hasTasks}`);
	if (results.hasPython !== "true" && results.hasPython !== "false") throw new Error(`planner emitted invalid has_python=${results.hasPython}`);
	if (results.native !== (results.hasNative === "true" ? "success" : "skipped")) throw new Error(results.hasNative === "true" ? "required native build did not succeed" : "unplanned native build was not skipped");
	if (results.shards !== (results.hasTasks === "true" ? "success" : "skipped")) throw new Error(results.hasTasks === "true" ? "required affected shards did not succeed" : "unplanned affected shards were not skipped");
	if (results.python !== (results.hasPython === "true" ? "success" : "skipped")) throw new Error(results.hasPython === "true" ? "required Python matrix did not succeed" : "unplanned Python matrix was not skipped");
	if (results.windowsDoctorRequired !== "true" && results.windowsDoctorRequired !== "false") throw new Error(`planner emitted invalid windows_doctor_required=${results.windowsDoctorRequired}`);
	if (results.windowsDoctor !== (results.windowsDoctorRequired === "true" ? "success" : "skipped")) throw new Error(results.windowsDoctorRequired === "true" ? "required Windows dev:doctor did not succeed" : "unplanned Windows dev:doctor was not skipped");
	if (results.darwinArm64TabWorkerSmokeRequired !== "true" && results.darwinArm64TabWorkerSmokeRequired !== "false") throw new Error(`planner emitted invalid darwin_arm64_tab_worker_smoke_required=${results.darwinArm64TabWorkerSmokeRequired}`);
	if (results.darwinArm64TabWorkerSmoke !== (results.darwinArm64TabWorkerSmokeRequired === "true" ? "success" : "skipped")) throw new Error(results.darwinArm64TabWorkerSmokeRequired === "true" ? "required Darwin arm64 tab-worker smoke did not succeed" : "unplanned Darwin arm64 tab-worker smoke was not skipped");
	if (results.telegramGuardRequired !== "true" && results.telegramGuardRequired !== "false") throw new Error(`planner emitted invalid telegram_guard_required=${results.telegramGuardRequired}`);
	if (results.telegramGuard !== (results.telegramGuardRequired === "true" ? "success" : "skipped")) throw new Error(results.telegramGuardRequired === "true" ? "required Telegram daemon generation guard did not succeed" : "unplanned Telegram daemon generation guard was not skipped");
	if (results.telegramWindowsRequired !== "true" && results.telegramWindowsRequired !== "false") throw new Error(`planner emitted invalid telegram_windows_required=${results.telegramWindowsRequired}`);
	if (results.telegramWindows !== (results.telegramWindowsRequired === "true" ? "success" : "skipped")) throw new Error(results.telegramWindowsRequired === "true" ? "required Windows Telegram daemon safety did not succeed" : "unplanned Windows Telegram daemon safety was not skipped");
}

async function validateAggregate(): Promise<void> {
	const results: AffectedAggregateResults = {
		plan: Bun.env.CI_DEV_PLAN_RESULT?.trim() || "",
		native: Bun.env.CI_DEV_NATIVE_RESULT?.trim() || "",
		shards: Bun.env.CI_DEV_SHARDS_RESULT?.trim() || "",
		python: Bun.env.CI_DEV_PYTHON_RESULT?.trim() || "",
		windowsDoctor: Bun.env.CI_DEV_WINDOWS_DOCTOR_RESULT?.trim() || "",
		windowsDoctorRequired: Bun.env.CI_DEV_WINDOWS_DOCTOR_REQUIRED?.trim() || "",
		telegramGuard: Bun.env.CI_DEV_TELEGRAM_GUARD_RESULT?.trim() || "",
		telegramGuardRequired: Bun.env.CI_DEV_TELEGRAM_GUARD_REQUIRED?.trim() || "",
		telegramWindows: Bun.env.CI_DEV_TELEGRAM_WINDOWS_RESULT?.trim() || "",
		telegramWindowsRequired: Bun.env.CI_DEV_TELEGRAM_WINDOWS_REQUIRED?.trim() || "",
		hasNative: Bun.env.CI_DEV_HAS_NATIVE?.trim() || "",
		hasTasks: Bun.env.CI_DEV_HAS_TASKS?.trim() || "",
		hasPython: Bun.env.CI_DEV_HAS_PYTHON?.trim() || "",
		darwinArm64TabWorkerSmoke: Bun.env.CI_DEV_DARWIN_ARM64_TAB_WORKER_SMOKE_RESULT?.trim() || "",
		darwinArm64TabWorkerSmokeRequired: Bun.env.CI_DEV_DARWIN_ARM64_TAB_WORKER_SMOKE_REQUIRED?.trim() || "",
	};


	console.log(`affected-plan: ${results.plan}`);
	console.log(`affected-native: ${results.native}`);
	console.log(`affected-shards: ${results.shards}`);
	console.log(`affected-python-matrix: ${results.python}`);
	console.log(`planned native work: ${results.hasNative}`);
	console.log(`planned shard work: ${results.hasTasks}`);
	console.log(`planned Python work: ${results.hasPython}`);
	console.log(`windows-dev-doctor: ${results.windowsDoctor}`);
	console.log(`planned Windows dev:doctor: ${results.windowsDoctorRequired}`);
	console.log(`darwin-arm64 tab-worker smoke: ${results.darwinArm64TabWorkerSmoke}`);
	console.log(`planned Darwin arm64 tab-worker smoke: ${results.darwinArm64TabWorkerSmokeRequired}`);
	console.log(`telegram-daemon-generation: ${results.telegramGuard}`);
	console.log(`planned Telegram daemon generation: ${results.telegramGuardRequired}`);
	console.log(`windows-telegram-daemon-safety: ${results.telegramWindows}`);
	console.log(`planned Windows Telegram daemon safety: ${results.telegramWindowsRequired}`);
	validateAffectedAggregate(results);
	const tasks = await loadCanonicalPlan();
	if (!tasks) throw new Error("affected-plan-invalid: aggregate requires a canonical plan");
	validatePlanCapabilities(tasks, results, Bun.env.CI_DEV_PLAN_MODE?.trim() || resolvePlanMode());
	console.log("Affected path validation: all required shards passed");
}

function validatePlanCapabilities(tasks: readonly Task[], results: Pick<AffectedAggregateResults, "hasNative" | "hasTasks" | "hasPython">, mode: string): void {
	if (mode !== "pr" && mode !== "push") throw new Error("affected-plan-invalid: invalid plan mode");
	const expectedHasNative = String(tasks.some(task => task.capabilities?.nativeProducer === true));
	const expectedHasTasks = String(tasks.some(task => task.capabilities?.nativeProducer !== true && task.phase !== "python"));
	const expectedHasPython = String(tasks.some(task => task.phase === "python"));
	if (results.hasNative !== expectedHasNative || results.hasTasks !== expectedHasTasks || results.hasPython !== expectedHasPython) throw new Error("affected-plan-invalid: plan capability flags mismatch");
}

const AFFECTED_EVIDENCE_MANIFEST = ".ci-dev-affected-evidence.json";
const AFFECTED_EVIDENCE_RECEIPT = ".ci-dev-affected-evidence.receipt.json";
const AFFECTED_PLAN_NAME = ".ci-dev-affected-plan.json";
const AFFECTED_SHARD_DIR = ".ci-dev-shard-receipts";
const SHA256 = /^[a-f0-9]{64}$/;
const SOURCE_SHA = /^[a-f0-9]{40}$/;

type EvidenceChild = { name: string; sha256: string };
type EvidenceTask = { key: string; identity: string };
type ReplayScope = { repository: string; workflow: string; runId: string };
type AffectedEvidenceManifest = {
	schemaVersion: 1; subject: "ci-dev-affected-evidence"; sourceSha: string; planDigest: string; planMode: PlanMode;
	replayScope: ReplayScope; aggregateResults: AffectedAggregateResults; taskIdentities: EvidenceTask[]; childEvidence: EvidenceChild[];
};
type DetachedEvidenceReceipt = {
	schemaVersion: 1; subject: "ci-dev-affected-evidence"; manifestSha256: string; sourceSha: string; planDigest: string; replayScope: ReplayScope;
};

function sha256(value: string | Uint8Array): string { return new Bun.CryptoHasher("sha256").update(value).digest("hex"); }
function canonicalEvidence(value: object): string { return `${JSON.stringify(value)}\n`; }
function evidenceRoot(): string { return path.resolve(requiredEnv("CI_DEV_EVIDENCE_ROOT")); }
function evidenceError(reason: string): Error { return new Error(`affected-evidence-invalid: ${reason}`); }
function exactKeys(value: Record<string, unknown>, keys: readonly string[], reason: string): void {
	if (Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))) throw evidenceError(reason);
}
function requiredEnv(name: string): string { const value = Bun.env[name]?.trim(); if (!value) throw evidenceError(`missing ${name}`); return value; }

function isMissingError(error: unknown): boolean { return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"; }
async function checkedEvidencePath(root: string, relative: string, finalKind: "file" | "directory"): Promise<string> {
	const resolvedRoot = path.resolve(root);
	const target = path.resolve(resolvedRoot, relative);
	if (!target.startsWith(`${resolvedRoot}${path.sep}`)) throw evidenceError("path escaped staging root");
	let rootStat: import("node:fs").Stats;
	try { rootStat = await fs.lstat(resolvedRoot); } catch (error) { if (isMissingError(error)) throw evidenceError("missing staging root"); throw error; }
	if (rootStat.isSymbolicLink()) throw evidenceError("symlink staging root");
	if (!rootStat.isDirectory()) throw evidenceError("non-directory staging root");
	let current = resolvedRoot;
	for (const piece of path.relative(resolvedRoot, target).split(path.sep)) {
		current = path.join(current, piece);
		let stat: import("node:fs").Stats;
		try { stat = await fs.lstat(current); } catch (error) { if (isMissingError(error)) throw evidenceError("missing evidence object"); throw error; }
		if (stat.isSymbolicLink()) throw evidenceError("symlink evidence object");
		const final = current === target;
		if (final ? (finalKind === "file" ? !stat.isFile() : !stat.isDirectory()) : !stat.isDirectory()) {
			throw evidenceError(final ? `non-${finalKind} evidence object` : "non-directory evidence parent");
		}
	}
	return target;
}
async function readEvidenceBytes(root: string, relative: string): Promise<Uint8Array> { return new Uint8Array(await fs.readFile(await checkedEvidencePath(root, relative, "file"))); }
function decodeEvidenceJson(raw: Uint8Array): string { try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw); } catch { throw evidenceError("malformed UTF-8 evidence"); } }
async function readEvidenceFile(root: string, relative: string): Promise<string> { return decodeEvidenceJson(await readEvidenceBytes(root, relative)); }
async function checkEvidenceDirectory(root: string, relative: string): Promise<string> { return checkedEvidencePath(root, relative, "directory"); }

function expectedEvidenceTasks(tasks: readonly Task[]): EvidenceTask[] {
	return tasks.filter(task => task.capabilities?.nativeProducer !== true && task.phase !== "python").map(task => ({ key: task.key, identity: canonicalTaskIdentity(task) }));
}
function expectedEvidenceNames(tasks: readonly Task[]): string[] {
	return [AFFECTED_PLAN_NAME, ...expectedEvidenceTasks(tasks).map((_, index) => `${AFFECTED_SHARD_DIR}/${index}.json`)];
}
function canonicalReplayScope(): ReplayScope {
	return { repository: requiredEnv("GITHUB_REPOSITORY"), workflow: requiredEnv("GITHUB_WORKFLOW"), runId: requiredEnv("GITHUB_RUN_ID") };
}
function aggregateFromEnv(): AffectedAggregateResults {
	return {
		plan: requiredEnv("CI_DEV_PLAN_RESULT"),
		native: requiredEnv("CI_DEV_NATIVE_RESULT"),
		shards: requiredEnv("CI_DEV_SHARDS_RESULT"),
		python: requiredEnv("CI_DEV_PYTHON_RESULT"),
		windowsDoctor: requiredEnv("CI_DEV_WINDOWS_DOCTOR_RESULT"),
		windowsDoctorRequired: requiredEnv("CI_DEV_WINDOWS_DOCTOR_REQUIRED"),
		telegramGuard: requiredEnv("CI_DEV_TELEGRAM_GUARD_RESULT"),
		telegramGuardRequired: requiredEnv("CI_DEV_TELEGRAM_GUARD_REQUIRED"),
		telegramWindows: requiredEnv("CI_DEV_TELEGRAM_WINDOWS_RESULT"),
		telegramWindowsRequired: requiredEnv("CI_DEV_TELEGRAM_WINDOWS_REQUIRED"),
		hasNative: requiredEnv("CI_DEV_HAS_NATIVE"),
		hasTasks: requiredEnv("CI_DEV_HAS_TASKS"),
		hasPython: requiredEnv("CI_DEV_HAS_PYTHON"),
		darwinArm64TabWorkerSmoke: requiredEnv("CI_DEV_DARWIN_ARM64_TAB_WORKER_SMOKE_RESULT"),
		darwinArm64TabWorkerSmokeRequired: requiredEnv("CI_DEV_DARWIN_ARM64_TAB_WORKER_SMOKE_REQUIRED"),
	};
}
function parseAggregate(value: unknown): AffectedAggregateResults {
	if (!isRecord(value)) throw evidenceError("malformed aggregate results");
	exactKeys(
		value,
		[
			"plan",
			"native",
			"shards",
			"windowsDoctor",
			"python",
			"windowsDoctorRequired",
			"telegramGuard",
			"telegramGuardRequired",
			"telegramWindows",
			"telegramWindowsRequired",
			"hasNative",
			"hasTasks",
			"hasPython",
			"darwinArm64TabWorkerSmoke",
			"darwinArm64TabWorkerSmokeRequired",
		],
		"unexpected aggregate results field",
	);
	if (!Object.values(value).every(isString)) throw evidenceError("malformed aggregate results");
	return {
		plan: value.plan as string,
		native: value.native as string,
		shards: value.shards as string,
		python: value.python as string,
		windowsDoctor: value.windowsDoctor as string,
		windowsDoctorRequired: value.windowsDoctorRequired as string,
		telegramGuard: value.telegramGuard as string,
		telegramGuardRequired: value.telegramGuardRequired as string,
		telegramWindows: value.telegramWindows as string,
		telegramWindowsRequired: value.telegramWindowsRequired as string,
		hasNative: value.hasNative as string,
		hasTasks: value.hasTasks as string,
		hasPython: value.hasPython as string,
		darwinArm64TabWorkerSmoke: value.darwinArm64TabWorkerSmoke as string,
		darwinArm64TabWorkerSmokeRequired: value.darwinArm64TabWorkerSmokeRequired as string,
	};
}
function parseReplayScope(value: unknown): ReplayScope {
	if (!isRecord(value)) throw evidenceError("malformed replay scope");
	exactKeys(value, ["repository", "workflow", "runId"], "unexpected replay scope field");
	if (!isString(value.repository) || !isString(value.workflow) || !isString(value.runId) || !value.repository || !value.workflow || !value.runId) throw evidenceError("malformed replay scope");
	return { repository: value.repository, workflow: value.workflow, runId: value.runId };
}
function parseEvidenceTasks(value: unknown): EvidenceTask[] {
	if (!Array.isArray(value)) throw evidenceError("malformed task identities");
	return value.map(entry => { if (!isRecord(entry)) throw evidenceError("malformed task identity"); exactKeys(entry, ["key", "identity"], "unexpected task identity field"); if (!isString(entry.key) || !isString(entry.identity) || !entry.key || !entry.identity) throw evidenceError("malformed task identity"); return { key: entry.key, identity: entry.identity }; });
}
function parseEvidenceChildren(value: unknown): EvidenceChild[] {
	if (!Array.isArray(value)) throw evidenceError("malformed child evidence");
	return value.map(entry => { if (!isRecord(entry)) throw evidenceError("malformed child evidence"); exactKeys(entry, ["name", "sha256"], "unexpected child evidence field"); if (!isString(entry.name) || !isString(entry.sha256) || !SHA256.test(entry.sha256)) throw evidenceError("malformed child evidence"); return { name: entry.name, sha256: entry.sha256 }; });
}
function parseCanonicalManifest(raw: string): AffectedEvidenceManifest {
	let decoded: unknown; try { decoded = JSON.parse(raw); } catch { throw evidenceError("malformed manifest"); }
	if (!isRecord(decoded)) throw evidenceError("malformed manifest");
	exactKeys(decoded, ["schemaVersion", "subject", "sourceSha", "planDigest", "planMode", "replayScope", "aggregateResults", "taskIdentities", "childEvidence"], "unexpected manifest field");
	if (decoded.schemaVersion !== 1 || decoded.subject !== "ci-dev-affected-evidence" || !isString(decoded.sourceSha) || !SOURCE_SHA.test(decoded.sourceSha) || !isString(decoded.planDigest) || !SHA256.test(decoded.planDigest) || (decoded.planMode !== "pr" && decoded.planMode !== "push")) throw evidenceError("malformed manifest");
	const manifest: AffectedEvidenceManifest = { schemaVersion: 1, subject: "ci-dev-affected-evidence", sourceSha: decoded.sourceSha, planDigest: decoded.planDigest, planMode: decoded.planMode, replayScope: parseReplayScope(decoded.replayScope), aggregateResults: parseAggregate(decoded.aggregateResults), taskIdentities: parseEvidenceTasks(decoded.taskIdentities), childEvidence: parseEvidenceChildren(decoded.childEvidence) };
	if (raw !== canonicalEvidence(manifest)) throw evidenceError("non-canonical manifest bytes");
	return manifest;
}
function parseCanonicalReceipt(raw: string): DetachedEvidenceReceipt {
	let decoded: unknown; try { decoded = JSON.parse(raw); } catch { throw evidenceError("malformed receipt"); }
	if (!isRecord(decoded)) throw evidenceError("malformed receipt");
	exactKeys(decoded, ["schemaVersion", "subject", "manifestSha256", "sourceSha", "planDigest", "replayScope"], "unexpected receipt field");
	if (decoded.schemaVersion !== 1 || decoded.subject !== "ci-dev-affected-evidence" || !isString(decoded.manifestSha256) || !SHA256.test(decoded.manifestSha256) || !isString(decoded.sourceSha) || !SOURCE_SHA.test(decoded.sourceSha) || !isString(decoded.planDigest) || !SHA256.test(decoded.planDigest)) throw evidenceError("malformed receipt");
	const receipt: DetachedEvidenceReceipt = { schemaVersion: 1, subject: "ci-dev-affected-evidence", manifestSha256: decoded.manifestSha256, sourceSha: decoded.sourceSha, planDigest: decoded.planDigest, replayScope: parseReplayScope(decoded.replayScope) };
	if (raw !== canonicalEvidence(receipt)) throw evidenceError("non-canonical receipt bytes");
	return receipt;
}

async function readValidatedEvidencePlan(root: string): Promise<{ tasks: Task[]; raw: Uint8Array; mode: PlanMode }> {
	const raw = await readEvidenceBytes(root, AFFECTED_PLAN_NAME);
	let decoded: unknown; try { decoded = JSON.parse(decodeEvidenceJson(raw)); } catch { throw evidenceError("malformed canonical plan"); }
	if (!isRecord(decoded) || (decoded.mode !== "pr" && decoded.mode !== "push")) throw evidenceError("malformed canonical plan");
	const planPath = path.join(root, AFFECTED_PLAN_NAME);
	const original = Bun.env.CI_DEV_AFFECTED_PLAN;
	Bun.env.CI_DEV_AFFECTED_PLAN = planPath;
	try { const tasks = await loadCanonicalPlan(); if (!tasks) throw evidenceError("missing canonical plan"); return { tasks, raw, mode: decoded.mode }; }
	finally { if (original === undefined) delete Bun.env.CI_DEV_AFFECTED_PLAN; else Bun.env.CI_DEV_AFFECTED_PLAN = original; }
}
async function collectChildEvidence(root: string, tasks: readonly Task[]): Promise<EvidenceChild[]> {
	const expected = expectedEvidenceNames(tasks);
	const shardTasks = expectedEvidenceTasks(tasks);
	if (shardTasks.length === 0) {
		try { await fs.lstat(path.join(root, AFFECTED_SHARD_DIR)); throw evidenceError("unexpected shard receipt directory"); } catch (error) { if (error instanceof Error && error.message.startsWith("affected-evidence-invalid")) throw error; if (!isMissingError(error)) throw error; }
	} else {
		const directory = await checkEvidenceDirectory(root, AFFECTED_SHARD_DIR);
		const entries = await fs.readdir(directory);
		if (entries.length !== shardTasks.length || entries.some(entry => !/^\d+\.json$/.test(entry))) throw evidenceError("shard receipt set does not match canonical plan");
	}
	const children: EvidenceChild[] = [];
	for (const [index, name] of expected.entries()) {
		const rawBytes = await readEvidenceBytes(root, name);
		const raw = decodeEvidenceJson(rawBytes);
		if (index > 0) {
			let value: unknown; try { value = JSON.parse(raw); } catch { throw evidenceError("malformed shard receipt"); }
			const expectedTask = shardTasks[index - 1]!;
			if (!isRecord(value) || Object.keys(value).length !== 2 || value.key !== expectedTask.key || value.identity !== expectedTask.identity) throw evidenceError("shard receipt set does not match canonical plan");
		}
		children.push({ name, sha256: sha256(rawBytes) });
	}
	return children;
}
async function writeAffectedEvidence(): Promise<void> {
	const root = evidenceRoot();
	const { tasks, raw: planRaw, mode: planMode } = await readValidatedEvidencePlan(root);
	const results = aggregateFromEnv(); validateAffectedAggregate(results);
	const digest = requiredEnv("CI_DEV_PLAN_DIGEST");
	const mode = requiredEnv("CI_DEV_PLAN_MODE");
	if (mode !== "pr" && mode !== "push") throw evidenceError("invalid CI_DEV_PLAN_MODE");
	if (mode !== planMode) throw evidenceError("plan mode mismatch");
	validatePlanCapabilities(tasks, results, mode);
	if (sha256(planRaw) !== digest) throw evidenceError("plan digest mismatch");
	const manifestPath = path.join(root, AFFECTED_EVIDENCE_MANIFEST); const receiptPath = path.join(root, AFFECTED_EVIDENCE_RECEIPT);
	for (const target of [manifestPath, receiptPath]) { try { await fs.lstat(target); throw evidenceError("evidence target already exists"); } catch (error) { if (error instanceof Error && error.message.startsWith("affected-evidence-invalid")) throw error; if (!isMissingError(error)) throw error; } }
	const manifest: AffectedEvidenceManifest = { schemaVersion: 1, subject: "ci-dev-affected-evidence", sourceSha: requiredEnv("CI_DEV_SOURCE_SHA"), planDigest: digest, planMode: mode, replayScope: canonicalReplayScope(), aggregateResults: results, taskIdentities: expectedEvidenceTasks(tasks), childEvidence: await collectChildEvidence(root, tasks) };
	let wroteManifest = false;
	try {
		await fs.writeFile(manifestPath, canonicalEvidence(manifest), { flag: "wx" }); wroteManifest = true;
		const finalized = await readEvidenceBytes(root, AFFECTED_EVIDENCE_MANIFEST);
		if (Bun.env.CI_DEV_INJECT_EVIDENCE_POST_MANIFEST_FAILURE === "true") throw evidenceError("injected post-manifest failure");
		const receipt: DetachedEvidenceReceipt = { schemaVersion: 1, subject: "ci-dev-affected-evidence", manifestSha256: sha256(finalized), sourceSha: manifest.sourceSha, planDigest: manifest.planDigest, replayScope: manifest.replayScope };
		await fs.writeFile(receiptPath, canonicalEvidence(receipt), { flag: "wx" });
		console.log(`affected evidence produced: ${manifest.childEvidence.length} child evidence file(s)`);
	} catch (error) { if (wroteManifest) await fs.rm(manifestPath, { force: true }); throw error; }
}
async function validateAffectedEvidence(): Promise<void> {
	const root = evidenceRoot();
	const receiptRaw = await readEvidenceFile(root, AFFECTED_EVIDENCE_RECEIPT);
	const manifestBytes = await readEvidenceBytes(root, AFFECTED_EVIDENCE_MANIFEST);
	const manifestRaw = decodeEvidenceJson(manifestBytes);
	const receipt = parseCanonicalReceipt(receiptRaw);
	if (receipt.manifestSha256 !== sha256(manifestBytes)) throw evidenceError("manifest digest mismatch");
	const manifest = parseCanonicalManifest(manifestRaw);
	const { tasks, raw: planRaw, mode: planMode } = await readValidatedEvidencePlan(root);
	const expectedReplay = canonicalReplayScope(); const expectedSource = requiredEnv("CI_DEV_SOURCE_SHA"); const expectedDigest = requiredEnv("CI_DEV_PLAN_DIGEST");
	if (manifest.sourceSha !== expectedSource || receipt.sourceSha !== expectedSource || manifest.planDigest !== expectedDigest || receipt.planDigest !== expectedDigest || JSON.stringify(manifest.replayScope) !== JSON.stringify(expectedReplay) || JSON.stringify(receipt.replayScope) !== JSON.stringify(expectedReplay)) throw evidenceError("replay binding mismatch");
	if (manifest.planMode !== requiredEnv("CI_DEV_PLAN_MODE") || manifest.planMode !== planMode || sha256(planRaw) !== expectedDigest) throw evidenceError("plan binding mismatch");
	validateAffectedAggregate(manifest.aggregateResults);
	const liveAggregate = aggregateFromEnv();
	if (JSON.stringify(manifest.aggregateResults) !== JSON.stringify(liveAggregate)) throw evidenceError("aggregate result mismatch");
	validatePlanCapabilities(tasks, liveAggregate, manifest.planMode);
	const expectedTasks = expectedEvidenceTasks(tasks);
	if (JSON.stringify(manifest.taskIdentities) !== JSON.stringify(expectedTasks)) throw evidenceError("task identity mismatch");
	const children = await collectChildEvidence(root, tasks);
	if (JSON.stringify(manifest.childEvidence) !== JSON.stringify(children)) throw evidenceError("child evidence mismatch");
	console.log(`affected evidence validated: ${children.length} child evidence file(s)`);
}

async function validateShardReceipts(): Promise<void> {
	const tasks = await loadCanonicalPlan();
	if (!tasks) throw new Error("affected-plan-invalid: shard receipt validation requires a canonical plan");
	const expected = tasks
		.filter(task => task.capabilities?.nativeProducer !== true && task.phase !== "python")
		.map(task => ({ key: task.key, identity: canonicalTaskIdentity(task) }))
		.sort((left, right) => left.key.localeCompare(right.key));
	const receiptDir = path.resolve(repoRoot, Bun.env.CI_DEV_SHARD_RECEIPTS?.trim() || ".ci-dev-shard-receipts");
	const actual: Array<{ key: string; identity: string }> = [];
	for await (const entry of new Bun.Glob("*.json").scan({ cwd: receiptDir })) {
		const value = await Bun.file(path.join(receiptDir, entry)).json();
		if (!isRecord(value) || !isString(value.key) || !isString(value.identity) || Object.keys(value).length !== 2) throw new Error("affected-plan-invalid: malformed shard receipt");
		actual.push({ key: value.key, identity: value.identity });
	}
	actual.sort((left, right) => left.key.localeCompare(right.key));
	if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("affected-plan-invalid: shard receipt set does not match canonical plan");
}

async function loadCanonicalPlan(): Promise<Task[] | null> {
	const planFile = Bun.env.CI_DEV_AFFECTED_PLAN?.trim();
	if (!planFile) return null;
	let rawPlan: string;
	let decoded: unknown;
	try {
		rawPlan = await Bun.file(planFile).text();
		decoded = JSON.parse(rawPlan);
	} catch {
		throw new Error("affected-plan-invalid: cannot read canonical plan");
	}
	if (!isRecord(decoded) || decoded.schemaVersion !== 1 || !isString(decoded.sourceSha) || (decoded.mode !== "pr" && decoded.mode !== "push") || !Array.isArray(decoded.paths) || !decoded.paths.every(isString) || !Array.isArray(decoded.tasks)) throw new Error("affected-plan-invalid: malformed canonical plan");
	if (Object.keys(decoded).length !== 5 || Object.keys(decoded).some(key => !["schemaVersion", "sourceSha", "mode", "paths", "tasks"].includes(key))) throw new Error("affected-plan-invalid: unexpected top-level field");
	const decodedPaths = decoded.paths as string[];
	const paths = normalizeChangedPaths(decodedPaths);
	if (paths.length !== decodedPaths.length || paths.some((entry, index) => entry !== decodedPaths[index])) throw new Error("affected-plan-invalid: paths are not canonical");
	const expectedSha = Bun.env.CI_DEV_PLAN_SOURCE_SHA?.trim();
	const expectedDigest = Bun.env.CI_DEV_PLAN_DIGEST?.trim();
	if (!expectedSha || !expectedDigest) throw new Error("affected-plan-invalid: missing expected digest or source SHA");
	if (decoded.sourceSha !== expectedSha) throw new Error("affected-plan-invalid: source SHA mismatch");
	const checkedOut = await $`git rev-parse HEAD`.cwd(repoRoot).quiet().nothrow();
	if (checkedOut.exitCode !== 0 || checkedOut.stdout.toString().trim() !== expectedSha) throw new Error("affected-plan-invalid: checked-out SHA mismatch");
	const actual = new Bun.CryptoHasher("sha256").update(rawPlan).digest("hex");
	if (actual !== expectedDigest) throw new Error("affected-plan-invalid: digest mismatch");
	const tasks = decoded.tasks.map(deserializeTask);
	if (
		new Set(tasks.map(task => task.key)).size !== tasks.length ||
		new Set(tasks.map(task => task.identity)).size !== tasks.length
	) throw new Error("affected-plan-invalid: duplicate task key or identity");
	const matrixKey = Bun.env.CI_DEV_MATRIX_KEY?.trim();
	if (matrixKey) {
		const task = tasks.find(candidate => candidate.key === matrixKey);
		if (!task || !task.capabilities) throw new Error("affected-plan-invalid: matrix task mismatch");
		if (task.capabilities.rust !== (Bun.env.CI_DEV_MATRIX_RUST === "true") || task.capabilities.nextest !== (Bun.env.CI_DEV_MATRIX_NEXTEST === "true") || task.capabilities.nativeConsumer !== (Bun.env.CI_DEV_MATRIX_NATIVE === "true")) throw new Error("affected-plan-invalid: matrix capabilities mismatch");
	}
	return tasks;
}
function deserializeTask(value: unknown): Task {
	if (!isRecord(value) || !isString(value.key) || !isString(value.description) || !Array.isArray(value.command) || !value.command.every(isString) || (value.cwd !== undefined && !isString(value.cwd))) throw new Error("affected-plan-invalid: malformed task");
	assertTaskKeys(value);
	if (!isString(value.identity) || value.identity.length === 0) throw new Error("affected-plan-invalid: missing task identity");
	const capabilities = value.capabilities;
	if (!isRecord(capabilities) || typeof capabilities.rust !== "boolean" || typeof capabilities.nextest !== "boolean" || typeof capabilities.nativeConsumer !== "boolean" || typeof capabilities.nativeProducer !== "boolean") throw new Error("affected-plan-invalid: missing task capabilities");
	assertExactKeys(capabilities, ["rust", "nextest", "nativeConsumer", "nativeProducer"], "task capabilities");
	if (value.cwd !== undefined && value.cwd !== ".") normalizeInventoryPath(value.cwd);
	const phase = value.phase;
	if (phase !== "legacy" && phase !== "native-producer" && phase !== "ts-build" && phase !== "cargo-build" && phase !== "python") throw new Error("affected-plan-invalid: missing task phase");
	return {
		key: value.key,
		identity: value.identity,
		description: value.description,
		command: value.command,
		cwd: isString(value.cwd) ? path.resolve(repoRoot, value.cwd) : undefined,
		capabilities: {
			rust: capabilities.rust as boolean,
			nextest: capabilities.nextest as boolean,
			nativeConsumer: capabilities.nativeConsumer as boolean,
			nativeProducer: capabilities.nativeProducer as boolean,
		},
		phase,
	};
}
function assertTaskKeys(value: Record<string, unknown>): void {
	const allowed = ["key", "identity", "description", "command", "cwd", "capabilities", "phase"];
	if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error("affected-plan-invalid: malformed task");
}

if (import.meta.main) {
	await main();
}
