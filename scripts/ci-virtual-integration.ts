#!/usr/bin/env bun

import { $ } from "bun";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { selectCanaryTests } from "./ci-risk-canary-manifest";

const repoRoot = path.join(import.meta.dir, "..");
const SOURCE_SHA = /^[a-f0-9]{40}$/;

export interface VirtualIntegrationInputs {
	readonly headSha: string;
	readonly baseSha: string;
	readonly baseShaOverride?: string;
	readonly baseRunId: string;
	readonly baseConclusion: string;
	readonly checkedOutHead: string;
	readonly baseReachable: boolean;
}

export interface GreenDevRun {
	readonly headSha: string;
	readonly databaseId: number;
	readonly conclusion: string;
}

export interface AuthorityBase {
	readonly baseSha: string;
	readonly baseRunId: string;
	readonly baseConclusion: string;
}

export interface VirtualIntegrationEvidence {
	readonly schemaVersion: 1;
	readonly subject: "ci-virtual-integration";
	readonly headSha: string;
	readonly baseSha: string;
	readonly baseRunId: string;
	readonly mergeTreeSha: string;
	readonly canaryTasks: readonly string[];
}

function canonicalEvidence(value: object): string {
	return `${JSON.stringify(value)}\n`;
}

export function virtualIntegrationError(reason: string): Error {
	return new Error(`virtual-integration-invalid: ${reason}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
	const actual = Object.keys(value);
	if (actual.length !== keys.length || actual.some(key => !keys.includes(key))) throw virtualIntegrationError("malformed evidence");
}

function requiredEnv(name: string): string {
	const value = Bun.env[name]?.trim();
	if (!value) throw virtualIntegrationError(`missing ${name}`);
	return value;
}
/**
 * Select the authoritative terminal-green dev push to use as the virtual-merge
 * base. The candidate head is integrated against the newest reachable green
 * dev state, not the stale PR event base — so cross-PR regressions from
 * intervening merges are caught and a red event base never blocks a healthy
 * candidate. `ancestorsOfHead` is the commit set that `git merge-base
 * --is-ancestor` proved contains the head; green runs are newest-first.
 *
 * Fail closed unless at least one green run is a reachable ancestor. This is
 * a pure function so the selection contract is fully unit-testable.
 */
export function selectAuthorityBase(greenRuns: readonly GreenDevRun[], ancestorsOfHead: ReadonlySet<string>): AuthorityBase {
	if (!Array.isArray(greenRuns)) throw virtualIntegrationError("green run list unavailable");
	for (const run of greenRuns) {
		if (
			run?.conclusion === "success" &&
			typeof run.headSha === "string" &&
			SOURCE_SHA.test(run.headSha) &&
			Number.isInteger(run.databaseId) &&
			ancestorsOfHead.has(run.headSha)
		) {
			return {
				baseSha: run.headSha,
				baseRunId: String(run.databaseId),
				baseConclusion: run.conclusion,
			};
		}
	}
	throw virtualIntegrationError("no reachable terminal-green dev push for the candidate head");
}

export function assertVirtualIntegrationInputs(inputs: VirtualIntegrationInputs): void {
	if (typeof inputs.headSha !== "string" || !SOURCE_SHA.test(inputs.headSha)) throw virtualIntegrationError("malformed head SHA");
	if (typeof inputs.baseSha !== "string" || !SOURCE_SHA.test(inputs.baseSha)) throw virtualIntegrationError("malformed base SHA");
	if (inputs.checkedOutHead !== inputs.headSha) throw virtualIntegrationError("stale head");
	if (inputs.baseReachable !== true) throw virtualIntegrationError("stale base");
	if (inputs.baseShaOverride !== undefined && inputs.baseShaOverride !== inputs.baseSha) throw virtualIntegrationError("base override mismatch");
	if (inputs.baseConclusion !== "success") throw virtualIntegrationError("base run not terminal-green");
	if (typeof inputs.baseRunId !== "string" || inputs.baseRunId.trim() === "") throw virtualIntegrationError("missing base run id");
}

export function buildVirtualIntegrationEvidence(inputs: VirtualIntegrationInputs, mergeTreeSha: string, canaryTasks: readonly string[]): VirtualIntegrationEvidence {
	if (typeof mergeTreeSha !== "string" || !SOURCE_SHA.test(mergeTreeSha)) throw virtualIntegrationError("malformed merge identity");
	return {
		schemaVersion: 1,
		subject: "ci-virtual-integration",
		headSha: inputs.headSha,
		baseSha: inputs.baseSha,
		baseRunId: inputs.baseRunId,
		mergeTreeSha,
		canaryTasks: [...canaryTasks],
	};
}

export function canonicalVirtualIntegrationEvidence(evidence: VirtualIntegrationEvidence): string {
	return canonicalEvidence({
		schemaVersion: evidence.schemaVersion,
		subject: evidence.subject,
		headSha: evidence.headSha,
		baseSha: evidence.baseSha,
		baseRunId: evidence.baseRunId,
		mergeTreeSha: evidence.mergeTreeSha,
		canaryTasks: [...evidence.canaryTasks],
	});
}

export function parseCanonicalVirtualIntegrationEvidence(raw: string): VirtualIntegrationEvidence {
	let decoded: unknown;
	try {
		decoded = JSON.parse(raw);
	} catch {
		throw virtualIntegrationError("malformed evidence");
	}
	if (!isRecord(decoded)) throw virtualIntegrationError("malformed evidence");
	exactKeys(decoded, ["schemaVersion", "subject", "headSha", "baseSha", "baseRunId", "mergeTreeSha", "canaryTasks"]);
	if (
		decoded.schemaVersion !== 1 ||
		decoded.subject !== "ci-virtual-integration" ||
		typeof decoded.headSha !== "string" ||
		!SOURCE_SHA.test(decoded.headSha) ||
		typeof decoded.baseSha !== "string" ||
		!SOURCE_SHA.test(decoded.baseSha) ||
		typeof decoded.baseRunId !== "string" ||
		decoded.baseRunId.trim() === "" ||
		typeof decoded.mergeTreeSha !== "string" ||
		!SOURCE_SHA.test(decoded.mergeTreeSha) ||
		!Array.isArray(decoded.canaryTasks) ||
		!decoded.canaryTasks.every(task => typeof task === "string")
	) throw virtualIntegrationError("malformed evidence");
	const evidence: VirtualIntegrationEvidence = {
		schemaVersion: 1,
		subject: "ci-virtual-integration",
		headSha: decoded.headSha,
		baseSha: decoded.baseSha,
		baseRunId: decoded.baseRunId,
		mergeTreeSha: decoded.mergeTreeSha,
		canaryTasks: [...decoded.canaryTasks],
	};
	if (raw !== canonicalVirtualIntegrationEvidence(evidence)) throw virtualIntegrationError("non-canonical evidence bytes");
	return evidence;
}

async function checkedOutHead(): Promise<string> {
	const result = await $`git rev-parse HEAD`.cwd(repoRoot).quiet().nothrow();
	if (result.exitCode !== 0) throw virtualIntegrationError("checked-out head unavailable");
	return result.stdout.toString().trim();
}

async function baseIsReachable(baseSha: string): Promise<boolean> {
	const result = await $`git rev-parse --verify origin/ci-virtual-base`.cwd(repoRoot).quiet().nothrow();
	return result.exitCode === 0 && result.stdout.toString().trim() === baseSha;
}

// Git helpers accept an explicit cwd so tests can drive real fixture repos
// instead of asserting against a synthetic tree id the runner never uses.
async function gitIn(cwd: string, args: readonly string[]): Promise<{ exitCode: number; stdout: string }> {
	const result = await $`git ${args}`.cwd(cwd).quiet().nothrow();
	return { exitCode: result.exitCode, stdout: result.stdout.toString() };
}

/**
 * Produce the virtual merge by actually merging base and head in a disposable
 * detached worktree, then reading back the resulting tree id. This is the one
 * source of the merge identity: the same worktree is what canaries run in, so
 * the recorded id can never describe a state nothing executed against.
 *
 * `git merge-tree --write-tree` would be terser but needs git >= 2.38; CI and
 * developer machines still ship 2.34, where that flag is parsed as a revision
 * and fails. A real merge is portable and additionally surfaces conflicts.
 */
export async function createVirtualMergeWorktree(
	baseSha: string,
	headSha: string,
	targetDir: string,
	repoDir = repoRoot,
): Promise<string> {
	const add = await gitIn(repoDir, ["worktree", "add", "--detach", targetDir, baseSha]);
	if (add.exitCode !== 0) throw virtualIntegrationError("merge materialization failed");
	const merge = await gitIn(targetDir, [
		"-c",
		"user.email=ci@gajae.dev",
		"-c",
		"user.name=gajae-ci",
		"merge",
		"--no-ff",
		"--no-edit",
		headSha,
	]);
	if (merge.exitCode !== 0) throw virtualIntegrationError("merge conflicts with the terminal-green base");
	const tree = await gitIn(targetDir, ["rev-parse", "HEAD^{tree}"]);
	if (tree.exitCode !== 0) throw virtualIntegrationError("merge identity unavailable");
	const mergeTreeSha = tree.stdout.trim();
	if (!SOURCE_SHA.test(mergeTreeSha)) throw virtualIntegrationError("merge identity unavailable");
	return mergeTreeSha;
}

async function virtualChangedPaths(baseSha: string, headSha: string): Promise<string[]> {
	const result = await $`git diff --name-only ${baseSha} ${headSha}`.cwd(repoRoot).quiet().nothrow();
	if (result.exitCode !== 0) throw virtualIntegrationError("changed paths unavailable");
	return result.stdout
		.toString()
		.split(/\r?\n/)
		.map(changedPath => changedPath.trim())
		.filter(Boolean);
}

async function writeVirtualIntegrationEvidence(evidence: VirtualIntegrationEvidence): Promise<void> {
	const target = path.join(repoRoot, ".ci-virtual-integration.json");
	try {
		await fs.writeFile(target, canonicalVirtualIntegrationEvidence(evidence), { flag: "wx" });
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "EEXIST") throw virtualIntegrationError("evidence target already exists");
		throw virtualIntegrationError("cannot write evidence");
	}
}

/**
 * Recreate the recorded merge in a disposable worktree and fail closed unless
 * its tree id matches the evidence. Re-merging (rather than trusting a stored
 * id) is what makes tampered evidence detectable at run time.
 */
export async function materializeVirtualMerge(
	mergeTreeSha: string,
	targetDir: string,
	options: { baseSha: string; headSha: string; repoDir?: string },
): Promise<void> {
	if (!SOURCE_SHA.test(mergeTreeSha)) throw virtualIntegrationError("malformed merge identity");
	const actual = await createVirtualMergeWorktree(
		options.baseSha,
		options.headSha,
		targetDir,
		options.repoDir ?? repoRoot,
	);
	if (actual !== mergeTreeSha) throw virtualIntegrationError("merge materialization mismatch");
}

/** Remove a worktree created by `materializeVirtualMerge`. Best effort. */
export async function removeVirtualMergeWorktree(targetDir: string, repoDir = repoRoot): Promise<void> {
	await gitIn(repoDir, ["worktree", "remove", "--force", targetDir]);
}

/**
 * `--run-canaries`: re-validate the emitted evidence against live git state and
 * run the recorded canaries inside the materialized merge. The workflow already
 * executed the candidate head before this point, so a bare `JSON.parse` of the
 * evidence would let source-controlled code hand itself an empty task list.
 * Everything here is re-derived and compared; nothing is trusted as written.
 */
export async function runCanaries(options: {
	repoDir?: string;
	runner?: (testPath: string, cwd: string) => Promise<number>;
	prepare?: (cwd: string) => Promise<void>;
} = {}): Promise<void> {
	const repoDir = options.repoDir ?? repoRoot;
	const raw = await fs.readFile(path.join(repoDir, ".ci-virtual-integration.json"), "utf-8");
	const evidence = parseCanonicalVirtualIntegrationEvidence(raw);

	const head = await gitIn(repoDir, ["rev-parse", "HEAD"]);
	if (head.exitCode !== 0) throw virtualIntegrationError("checked-out head unavailable");
	if (head.stdout.trim() !== evidence.headSha) throw virtualIntegrationError("evidence binding mismatch");
	if (options.repoDir === undefined) {
		const envBase = Bun.env.CI_VI_BASE_SHA?.trim();
		if (envBase && envBase !== evidence.baseSha) throw virtualIntegrationError("evidence binding mismatch");
		const envRunId = Bun.env.CI_VI_BASE_RUN_ID?.trim();
		if (envRunId && envRunId !== evidence.baseRunId) throw virtualIntegrationError("evidence binding mismatch");
	}

	const diff = await gitIn(repoDir, ["diff", "--name-only", evidence.baseSha, evidence.headSha]);
	if (diff.exitCode !== 0) throw virtualIntegrationError("changed paths unavailable");
	const expected = selectCanaryTests(
		diff.stdout
			.split(/\r?\n/)
			.map(changedPath => changedPath.trim())
			.filter(Boolean),
	);
	if (JSON.stringify(expected) !== JSON.stringify([...evidence.canaryTasks])) {
		throw virtualIntegrationError("canary task set mismatch");
	}

	if (expected.length === 0) {
		console.log("virtual integration: no risk-selected canaries for this merge candidate; nothing to run.");
		return;
	}

	const worktree = await fs.mkdtemp(path.join(os.tmpdir(), "ci-virtual-merge-"));
	try {
		await materializeVirtualMerge(evidence.mergeTreeSha, path.join(worktree, "merged"), {
			baseSha: evidence.baseSha,
			headSha: evidence.headSha,
			repoDir,
		});
		const mergedDir = path.join(worktree, "merged");
		const prepare = options.prepare ?? (async (cwd: string) => {
			const install = await $`bun install --frozen-lockfile`.cwd(cwd).quiet().nothrow();
			if (install.exitCode !== 0) throw virtualIntegrationError("cannot install merged worktree dependencies");
			const native = await $`bun run ci:build:native`.cwd(cwd).quiet().nothrow();
			if (native.exitCode !== 0) throw virtualIntegrationError("cannot build merged worktree native addon");
		});
		await prepare(mergedDir);
		const runner = options.runner ?? (async (testPath, cwd) => (await $`bun test ${testPath}`.cwd(cwd).nothrow()).exitCode);
		for (const testPath of expected) {
			console.log(`virtual integration canary: ${testPath}`);
			const exitCode = await runner(testPath, mergedDir);
			if (exitCode !== 0) throw virtualIntegrationError(`canary failed: ${testPath}`);
		}
		console.log(`virtual integration: ${expected.length} canary task(s) passed against the merged tree.`);
	} finally {
		await removeVirtualMergeWorktree(path.join(worktree, "merged"), repoDir);
		await fs.rm(worktree, { recursive: true, force: true });
	}
}

async function selectAuthorityBaseFromEnv(): Promise<AuthorityBase> {
	const headSha = requiredEnv("CI_VI_HEAD_SHA");
	// Fetch full history so ancestor checks resolve for any candidate base.
	const listResult = await $`gh run list --workflow "Dev CI" --branch dev --event push --status success --limit 100 --json headSha,databaseId,conclusion`
		.cwd(repoRoot)
		.quiet()
		.nothrow();
	if (listResult.exitCode !== 0) throw virtualIntegrationError("green dev run list unavailable");
	let greenRuns: unknown;
	try {
		greenRuns = JSON.parse(listResult.stdout.toString());
	} catch {
		throw virtualIntegrationError("green dev run list malformed");
	}
	if (!Array.isArray(greenRuns) || !greenRuns.every(run => isRecord(run))) {
		throw virtualIntegrationError("green dev run list malformed");
	}
	const typedGreenRuns: GreenDevRun[] = greenRuns.map(run => ({
		headSha: String((run as Record<string, unknown>).headSha ?? ""),
		databaseId: Number((run as Record<string, unknown>).databaseId),
		conclusion: String((run as Record<string, unknown>).conclusion ?? ""),
	}));
	// Build the ancestor set of the candidate head once, then let the pure
	// selector choose the newest reachable green dev push. rev-list is exact
	// and bounded by the commit graph, so an unrelated green SHA can never be
	// selected as a base for history it is not part of.
	const revListResult = await $`git rev-list ${headSha}`.cwd(repoRoot).quiet().nothrow();
	if (revListResult.exitCode !== 0) throw virtualIntegrationError("ancestor set unavailable");
	const ancestorsOfHead = new Set(
		revListResult.stdout
			.toString()
			.split(/\r?\n/)
			.map(sha => sha.trim())
			.filter(Boolean),
	);
	const authority = selectAuthorityBase(typedGreenRuns, ancestorsOfHead);
	console.log(`authority_base_sha=${authority.baseSha}`);
	console.log(`authority_base_run_id=${authority.baseRunId}`);
	console.log(`authority_base_conclusion=${authority.baseConclusion}`);
	return authority;
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	if (args.length === 1 && args[0] === "--run-canaries") {
		await runCanaries();
		return;
	}
	if (args.length === 1 && args[0] === "--select-base") {
		await selectAuthorityBaseFromEnv();
		return;
	}
	if (args.length !== 1 || args[0] !== "--validate") throw virtualIntegrationError("expected --validate, --select-base, or --run-canaries");
	const headSha = requiredEnv("CI_VI_HEAD_SHA");
	const baseSha = requiredEnv("CI_VI_BASE_SHA");
	const baseShaOverride = Bun.env.CI_VI_BASE_SHA_OVERRIDE?.trim() || undefined;
	const baseRunId = requiredEnv("CI_VI_BASE_RUN_ID");
	const baseConclusion = requiredEnv("CI_VI_BASE_CONCLUSION");
	const inputs: VirtualIntegrationInputs = {
		headSha,
		baseSha,
		...(baseShaOverride === undefined ? {} : { baseShaOverride }),
		baseRunId,
		baseConclusion,
		checkedOutHead: await checkedOutHead(),
		baseReachable: await baseIsReachable(baseSha),
	};
	assertVirtualIntegrationInputs(inputs);
	const mergeScratch = await fs.mkdtemp(path.join(os.tmpdir(), "ci-virtual-merge-"));
	const mergeDir = path.join(mergeScratch, "merged");
	let mergeTreeSha: string;
	try {
		mergeTreeSha = await createVirtualMergeWorktree(baseSha, headSha, mergeDir);
	} finally {
		await removeVirtualMergeWorktree(mergeDir).catch(() => {});
		await fs.rm(mergeScratch, { recursive: true, force: true });
	}
	const changedPaths = await virtualChangedPaths(baseSha, headSha);
	const canaryTasks = selectCanaryTests(changedPaths);
	const evidence = buildVirtualIntegrationEvidence(inputs, mergeTreeSha, canaryTasks);
	await writeVirtualIntegrationEvidence(evidence);
	console.log(`virtual integration evidence: head ${headSha}; base ${baseSha}; merge tree ${mergeTreeSha}; ${canaryTasks.length} canary task(s)`);
}

if (import.meta.main) {
	await main();
}
