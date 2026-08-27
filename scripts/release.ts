#!/usr/bin/env bun
/**
 * Release script for pi-mono
 *
 * Usage:
 *   bun scripts/release.ts <version>   Full release (preflight, version, changelog, commit, push, watch)
 *   bun scripts/release.ts watch       Watch CI for current commit
 *
 * Example: bun scripts/release.ts 3.10.0
 */

import { $, Glob } from "bun";

const changelogGlob = new Glob("packages/*/CHANGELOG.md");
const packageJsonGlob = new Glob("packages/*/package.json");
const cargoTomlGlob = new Glob("crates/*/Cargo.toml");
const stableVersionPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;


function git(args: readonly string[]) {
	return $`git -c core.fsmonitor=false -c core.untrackedCache=false ${args}`;
}

// =============================================================================
// Shared functions
// =============================================================================

interface ReleaseRunObservation {
	databaseId: number;
	status: "queued" | "in_progress" | "completed" | "waiting" | "requested" | "pending" | "action_required";
	conclusion: string | null;
	name: "CI";
	headSha: string;
	headBranch: string;
	event: string;
}

export interface ReleaseRunJobObservation {
	databaseId: number;
	status: string;
	conclusion: string | null;
	name: string;
}

export const STABLE_GITHUB_RELEASE_FINALIZATION_JOB_NAME = "release_finalize";

export type StableReleaseFinalizationReceipt =
	| { outcome: "missing" }
	| { outcome: "multiple"; jobs: readonly ReleaseRunJobObservation[] }
	| { outcome: "incomplete"; job: ReleaseRunJobObservation }
	| { outcome: "skipped"; job: ReleaseRunJobObservation }
	| { outcome: "cancelled"; job: ReleaseRunJobObservation }
	| { outcome: "failed"; job: ReleaseRunJobObservation }
	| { outcome: "success"; job: ReleaseRunJobObservation };

export function classifyStableReleaseFinalizationReceipt(
	jobs: readonly ReleaseRunJobObservation[],
): StableReleaseFinalizationReceipt {
	const finalizationJobs = jobs.filter(job => job.name === STABLE_GITHUB_RELEASE_FINALIZATION_JOB_NAME);
	if (finalizationJobs.length === 0) return { outcome: "missing" };
	if (finalizationJobs.length !== 1) return { outcome: "multiple", jobs: finalizationJobs };

	const [job] = finalizationJobs;
	if (job === undefined) throw new Error("Expected exactly one stable release finalization job");
	if (job.status !== "completed") return { outcome: "incomplete", job };
	if (job.conclusion === "success") return { outcome: "success", job };
	if (job.conclusion === "skipped") return { outcome: "skipped", job };
	if (job.conclusion === "cancelled") return { outcome: "cancelled", job };
	return { outcome: "failed", job };
}

function isObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function outputOf(result: { stdout: Uint8Array; stderr: Uint8Array }): string {
	return `${Buffer.from(result.stdout).toString()}${Buffer.from(result.stderr).toString()}`.trim();
}

function parseReleaseRuns(output: string, commitSha: string, expectedTag?: string): ReleaseRunObservation[] {
	let raw: unknown;
	try {
		raw = JSON.parse(output) as unknown;
	} catch (error) {
		throw new Error(`Cannot parse CI run query for ${commitSha}: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!Array.isArray(raw)) throw new Error(`CI run query for ${commitSha} did not return an array`);
	const statuses = new Set<ReleaseRunObservation["status"]>([
		"queued",
		"in_progress",
		"completed",
		"waiting",
		"requested",
		"pending",
		"action_required",
	]);
	const observations: ReleaseRunObservation[] = [];
	for (const entry of raw) {
		if (!isObject(entry)) throw new Error(`CI run query for ${commitSha} returned a non-object run`);
		const databaseId = entry.databaseId;
		const status = entry.status;
		const conclusion = entry.conclusion;
		const name = entry.name;
		const headSha = entry.headSha;
		const headBranch = entry.headBranch;
		const event = entry.event;
		if (typeof databaseId !== "number" || !Number.isSafeInteger(databaseId) || databaseId <= 0) throw new Error(`CI run query for ${commitSha} returned an invalid databaseId`);
		if (typeof status !== "string" || !statuses.has(status as ReleaseRunObservation["status"])) {
			throw new Error(`CI run ${databaseId} for ${commitSha} returned an invalid status`);
		}
		if (conclusion !== null && typeof conclusion !== "string") {
			throw new Error(`CI run ${databaseId} for ${commitSha} returned an invalid conclusion`);
		}
		if (name !== "CI") throw new Error(`CI run ${databaseId} for ${commitSha} is not the expected CI workflow`);
		if (headSha !== commitSha) throw new Error(`CI run ${databaseId} does not observe expected commit ${commitSha}`);
		if (typeof headBranch !== "string" || headBranch.length === 0) {
			throw new Error(`CI run ${databaseId} for ${commitSha} returned an invalid head branch`);
		}
		if (typeof event !== "string" || event.length === 0) throw new Error(`CI run ${databaseId} for ${commitSha} returned an invalid event`);
		if (expectedTag !== undefined && (headBranch !== expectedTag || event !== "push")) {
			throw new Error(`CI run ${databaseId} is not the expected push of release tag ${expectedTag}`);
		}
		observations.push({ databaseId, status: status as ReleaseRunObservation["status"], conclusion, name, headSha, headBranch, event });
	}
	return observations;
}

function parseReleaseRunJobs(output: string, runId: number): ReleaseRunJobObservation[] {
	let raw: unknown;
	try {
		raw = JSON.parse(output) as unknown;
	} catch (error) {
		throw new Error(`Cannot parse jobs for CI run ${runId}: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!isObject(raw) || !Array.isArray(raw.jobs)) throw new Error(`CI run ${runId} jobs query did not return a jobs array`);
	return raw.jobs.map((entry, index) => {
		if (!isObject(entry)) throw new Error(`CI run ${runId} jobs[${index}] is not an object`);
		const databaseId = entry.databaseId;
		const status = entry.status;
		const conclusion = entry.conclusion;
		const name = entry.name;
		if (typeof databaseId !== "number" || !Number.isSafeInteger(databaseId) || databaseId <= 0) throw new Error(`CI run ${runId} jobs[${index}] has an invalid databaseId`);
		if (typeof status !== "string" || status.length === 0) throw new Error(`CI run ${runId} jobs[${index}] has an invalid status`);
		if (conclusion !== null && typeof conclusion !== "string") throw new Error(`CI run ${runId} jobs[${index}] has an invalid conclusion`);
		if (typeof name !== "string" || name.length === 0) throw new Error(`CI run ${runId} jobs[${index}] has an invalid name`);
		return { databaseId, status, conclusion, name };
	});
}

/**
 * A read-only CI observation could not be completed.
 *
 * Distinct from a CI verdict: the release refs may already be published and the
 * workflow may be perfectly healthy. Only the observer failed, so the operator
 * must re-observe rather than cut a new version.
 */
export class ReleaseObservationError extends Error {
	override readonly name = "ReleaseObservationError";
}

/** Bounded attempt budget for a single read-only CI observation command. */
export const RELEASE_OBSERVATION_ATTEMPTS = 8;

/**
 * Backoff before re-attempting a failed observation: 2s doubling to a 30s ceiling.
 *
 * The whole budget spans roughly four minutes, which outlasts an ordinary network
 * blip or GitHub API hiccup without stalling a genuinely broken watch for long.
 */
export function releaseObservationRetryDelayMs(attempt: number): number {
	if (!Number.isInteger(attempt) || attempt < 1) throw new Error(`Observation attempt must be a positive integer, received ${attempt}`);
	return Math.min(30_000, 2_000 * 2 ** (attempt - 1));
}

/** Whether a failed observation attempt gets another try, and how long to wait first. */
export type ObservationRetryDecision = { action: "retry"; delayMs: number } | { action: "fail" };

/**
 * Decide what follows a failed observation attempt.
 *
 * Split from the command runner so the budget and backoff are provable without
 * spending the real wall-clock delays.
 */
export function decideObservationRetry(attempt: number): ObservationRetryDecision {
	if (!Number.isInteger(attempt) || attempt < 1) throw new Error(`Observation attempt must be a positive integer, received ${attempt}`);
	if (attempt >= RELEASE_OBSERVATION_ATTEMPTS) return { action: "fail" };
	return { action: "retry", delayMs: releaseObservationRetryDelayMs(attempt) };
}

/**
 * Run a read-only observation command, retrying every non-zero exit.
 *
 * The observation phase runs after the release refs are pushed, so a transient
 * `gh`/network failure must never be reported as a release failure. Retrying every
 * failure keeps the decision off brittle error-message matching; only exhausting
 * the budget is authoritative.
 */
export async function observeWithRetry<T>(
	description: string,
	run: () => Promise<{ exitCode: number | null; stdout: Uint8Array; stderr: Uint8Array }>,
	parse: (stdout: string) => T,
	sleep: (ms: number) => Promise<void> = ms => Bun.sleep(ms),
): Promise<T> {
	let lastFailure = "";
	for (let attempt = 1; attempt <= RELEASE_OBSERVATION_ATTEMPTS; attempt++) {
		const result = await run();
		if (result.exitCode === 0) {
			try {
				return parse(result.stdout.toString());
			} catch (error) {
				// A zero exit with unusable output is still an observation failure:
				// truncated or mis-shaped responses are as transient as any network
				// error, and only a trustworthy verdict may leave this loop.
				lastFailure = `unusable response: ${error instanceof Error ? error.message : String(error)}`;
			}
		} else {
			lastFailure = outputOf(result) || `exit ${result.exitCode ?? "unknown"}`;
		}
		const decision = decideObservationRetry(attempt);
		if (decision.action === "fail") break;
		console.log(`  ${description} failed (attempt ${attempt}/${RELEASE_OBSERVATION_ATTEMPTS}), retrying in ${Math.round(decision.delayMs / 1000)}s: ${lastFailure}`);
		await sleep(decision.delayMs);
	}
	throw new ReleaseObservationError(`${description} failed ${RELEASE_OBSERVATION_ATTEMPTS} times: ${lastFailure}`);
}

async function queryReleaseRuns(commitSha: string, expectedTag?: string): Promise<ReleaseRunObservation[]> {
	return observeWithRetry(`Querying CI runs for ${commitSha.slice(0, 8)}`, () =>
		expectedTag === undefined
			? $`gh run list --workflow ci.yml --commit ${commitSha} --json databaseId,status,conclusion,name,headSha,headBranch,event`.quiet().nothrow()
			: $`gh run list --workflow ci.yml --branch ${expectedTag} --commit ${commitSha} --json databaseId,status,conclusion,name,headSha,headBranch,event`.quiet().nothrow(),
		stdout => parseReleaseRuns(stdout, commitSha, expectedTag),
	);
}

async function queryReleaseRunJobs(runId: number): Promise<ReleaseRunJobObservation[]> {
	return observeWithRetry(`Querying jobs for CI run ${runId}`, () => $`gh run view ${runId} --json jobs`.quiet().nothrow(), stdout => parseReleaseRunJobs(stdout, runId));
}

async function failedJobLog(jobId: number): Promise<string> {
	const result = await $`gh run view --job ${jobId} --log-failed`.quiet().nothrow();
	if (result.exitCode !== 0) return "";
	return result.stdout.toString().trim();
}

/**
 * Print the tail of a failed job's log, best effort.
 *
 * The log is diagnostic context for a verdict that has already been decided, and
 * GitHub drops job logs on its own retention schedule (an expired log answers with
 * `BlobNotFound`). An unavailable log must never mask the failure it explains.
 */
async function printFailedJobLog(job: ReleaseRunJobObservation): Promise<void> {
	const log = await failedJobLog(job.databaseId);
	if (!log) {
		console.error(`  (no log available for ${job.name}; job ${job.databaseId})`);
		return;
	}
	const tail = log.split("\n").slice(-20).join("\n");
	console.error(`\n--- Last 20 lines of ${job.name} ---\n${tail}\n`);
}

async function reportStableReleaseFinalizationFailure(
	run: ReleaseRunObservation,
	receipt: Exclude<StableReleaseFinalizationReceipt, { outcome: "success" }>,
): Promise<void> {
	const runReference = `CI run ${run.databaseId} for release tag ${run.headBranch}`;
	switch (receipt.outcome) {
		case "missing":
			console.error(`\nRelease finalization missing:\n  - ${runReference} did not contain required job "${STABLE_GITHUB_RELEASE_FINALIZATION_JOB_NAME}". The GitHub Release was not confirmed final; inspect and rerun this CI workflow.`);
			return;
		case "multiple":
			console.error(`\nRelease finalization ambiguous:\n  - ${runReference} contained ${receipt.jobs.length} jobs named "${STABLE_GITHUB_RELEASE_FINALIZATION_JOB_NAME}". The GitHub Release was not confirmed final; inspect the CI workflow.`);
			return;
		case "incomplete":
			console.error(`\nRelease finalization incomplete:\n  - ${runReference} reported "${STABLE_GITHUB_RELEASE_FINALIZATION_JOB_NAME}" as ${receipt.job.status}. The GitHub Release was not confirmed final; inspect and rerun this CI workflow.`);
			return;
		case "skipped":
			console.error(`\nRelease finalization skipped:\n  - ${runReference} skipped "${STABLE_GITHUB_RELEASE_FINALIZATION_JOB_NAME}". Its release gates did not complete, so do not treat the tag as released; inspect the CI workflow.`);
			return;
		case "cancelled":
			console.error(`\nRelease finalization cancelled:\n  - ${runReference} cancelled "${STABLE_GITHUB_RELEASE_FINALIZATION_JOB_NAME}". The GitHub Release was not confirmed final; inspect and rerun this CI workflow.`);
			await printFailedJobLog(receipt.job);
			return;
		case "failed":
			console.error(`\nRelease finalization failed:\n  - ${runReference} concluded "${receipt.job.conclusion ?? "unknown"}" for "${STABLE_GITHUB_RELEASE_FINALIZATION_JOB_NAME}". The GitHub Release was not confirmed final; inspect the failed job log.`);
			await printFailedJobLog(receipt.job);
			return;
	}
}

async function watchCI(expectedTag?: string): Promise<boolean> {
	const commitSha = (await git(["rev-parse", "HEAD"]).text()).trim();
	if (!/^[0-9a-f]{40}$/u.test(commitSha)) throw new Error("Cannot resolve the current commit for CI observation");
	console.log(`  Commit: ${commitSha.slice(0, 8)}`);
	if (expectedTag !== undefined) console.log(`  Release tag: ${expectedTag}`);

	while (true) {
		const runs = await queryReleaseRuns(commitSha, expectedTag);
		if (runs.length === 0) {
			console.log("  Waiting for CI to start...");
			await Bun.sleep(3000);
			continue;
		}

		const failedJobs: Array<{ workflow: string; job: ReleaseRunJobObservation }> = [];
		for (const run of runs.filter(run => run.status !== "completed")) {
			for (const job of await queryReleaseRunJobs(run.databaseId)) {
				if (job.status === "completed" && job.conclusion !== "success" && job.conclusion !== "skipped") {
					failedJobs.push({ workflow: run.name, job });
				}
			}
		}

		if (failedJobs.length > 0) {
			console.error("\nCI job failed:");
			for (const { workflow, job } of failedJobs) {
				console.error(`  - ${workflow} / ${job.name} (job ${job.databaseId}): ${job.conclusion ?? "unknown"}`);
				await printFailedJobLog(job);
			}
			return false;
		}

		const pending = runs.filter(run => run.status !== "completed");
		const failed = runs.filter(run => run.status === "completed" && run.conclusion !== "success");
		const passed = runs.filter(run => run.status === "completed" && run.conclusion === "success");
		console.log(`  ${passed.length} passed, ${pending.length} pending, ${failed.length} failed`);

		if (failed.length > 0) {
			console.error("\nCI failed:");
			for (const run of failed) {
				console.error(`  - ${run.name}: ${run.conclusion}`);
				for (const job of await queryReleaseRunJobs(run.databaseId)) {
					if (job.conclusion !== "success" && job.conclusion !== "skipped") await printFailedJobLog(job);
				}
			}
			return false;
		}

		if (pending.length === 0) {
			if (expectedTag !== undefined) {
				for (const run of passed) {
					const receipt = classifyStableReleaseFinalizationReceipt(await queryReleaseRunJobs(run.databaseId));
					if (receipt.outcome !== "success") {
						await reportStableReleaseFinalizationFailure(run, receipt);
						return false;
					}
				}
			}
			console.log("  All CI checks passed!\n");
			return true;
		}
		await Bun.sleep(5000);
	}
}

function hasUnreleasedContent(content: string): boolean {
	const unreleasedMatch = content.match(/## \[Unreleased\]\s*\n([\s\S]*?)(?=## \[\d|$)/);
	if (!unreleasedMatch) return false;
	const sectionContent = unreleasedMatch[1].trim();
	return sectionContent.length > 0;
}

export function releasedChangelogContent(content: string, version: string, date: string, changelog: string): string {
	// A release with no unreleased notes still needs a semver heading: the
	// embedded changelog must identify the version shipped by the package.
	// Previously released headings are immutable history and stay in place even
	// when their body is empty, so the new heading is always inserted above them.
	const unreleasedHasContent = hasUnreleasedContent(content);
	let next = content;

	if (unreleasedHasContent) {
		next = next.replace("## [Unreleased]", `## [${version}] - ${date}`);
		// Reinstate the empty [Unreleased] heading for the next cycle. The header
		// may or may not be followed by a blank line, and losing this heading
		// silently merges the next cycle's notes into the released section.
		next = next.replace(/^# Changelog\n+/, "# Changelog\n\n## [Unreleased]\n\n");
		if (!next.includes("## [Unreleased]")) {
			throw new Error(`${changelog} lost its [Unreleased] heading; its "# Changelog" header is missing or malformed`);
		}
	} else {
		next = next.replace("## [Unreleased]", `## [Unreleased]\n\n## [${version}] - ${date}`);
	}
	return next;
}

async function updateChangelogsForRelease(version: string): Promise<void> {
	const date = new Date().toISOString().split("T")[0];

	for await (const changelog of changelogGlob.scan(".")) {
		const content = await Bun.file(changelog).text();

		if (!content.includes("## [Unreleased]")) {
			console.log(`  Skipping ${changelog}: no [Unreleased] section`);
			continue;
		}

		await Bun.write(changelog, releasedChangelogContent(content, version, date, changelog));
		console.log(`  Updated ${changelog}`);
	}
}

export function releasedBunLockContent(content: string, previousVersion: string, version: string): string {
	const packagesMarker = '\n  "packages": {';
	const packagesIndex = content.indexOf(packagesMarker);
	if (packagesIndex < 0) throw new Error('bun.lock is missing its top-level "packages" section');

	const prefix = content.slice(0, packagesIndex);
	const suffix = content.slice(packagesIndex);
	const previousWorkspaceVersion = `"version": "${previousVersion}"`;
	const workspaceVersionCount = prefix.split(previousWorkspaceVersion).length - 1;
	if (workspaceVersionCount === 0) {
		throw new Error(`bun.lock has no workspace package versions matching ${previousVersion}`);
	}

	let catalogVersionCount = 0;
	const updatedPrefix = prefix
		.replaceAll(previousWorkspaceVersion, `"version": "${version}"`)
		.replace(/("@gajae-code\/[^"]+":\s*)"([^"]+)"/g, (match, key: string, currentVersion: string) => {
			if (currentVersion !== previousVersion) return match;
			catalogVersionCount++;
			return `${key}"${version}"`;
		});
	if (catalogVersionCount === 0) {
		throw new Error(`bun.lock has no @gajae-code catalog versions matching ${previousVersion}`);
	}
	return `${updatedPrefix}${suffix}`;
}

// =============================================================================
// Subcommands
// =============================================================================

async function cmdWatch(): Promise<void> {
	console.log("\n=== Watching CI ===\n");
	try {
		const success = await watchCI();
		process.exit(success ? 0 : 1);
	} catch (error) {
		if (!(error instanceof ReleaseObservationError)) throw error;
		console.error(`\nCI observation unavailable: ${error.message}`);
		console.error("  No CI verdict was observed. Retry once connectivity returns.");
		process.exit(1);
	}
}

export function isStableReleaseVersion(version: string): boolean {
	return stableVersionPattern.test(version);
}

function parseVersion(v: string): [number, number, number] {
	const match = v.match(/^v?((?:0|[1-9]\d*))\.((?:0|[1-9]\d*))\.((?:0|[1-9]\d*))$/u);
	if (!match) throw new Error(`Invalid stable version: ${v}`);
	return [parseInt(match[1]), parseInt(match[2]), parseInt(match[3])];
}


function compareVersions(a: string, b: string): number {
	const [aMajor, aMinor, aPatch] = parseVersion(a);
	const [bMajor, bMinor, bPatch] = parseVersion(b);
	if (aMajor !== bMajor) return aMajor - bMajor;
	if (aMinor !== bMinor) return aMinor - bMinor;
	return aPatch - bPatch;
}
async function assertImmutableNewTag(version: string): Promise<void> {
	const tag = `v${version}`;
	const local = await git(["show-ref", "--verify", "--quiet", `refs/tags/${tag}`]).quiet().nothrow();
	if (local.exitCode === 0) {
		throw new Error(`Refusing to reuse existing local tag ${tag}; corrections require a newer version`);
	}
	const remote = await git(["ls-remote", "--tags", "origin", `refs/tags/${tag}`, `refs/tags/${tag}^{}`]).quiet().nothrow();
	if (remote.exitCode !== 0) throw new Error(`Cannot verify immutable remote tag ${tag}`);
	if (remote.stdout.toString().trim() !== "") {
		throw new Error(`Refusing to reuse existing remote tag ${tag}; corrections require a newer version`);
	}
}

async function fetchRemoteTags(): Promise<void> {
	const result = await git(["fetch", "--quiet", "origin", "--tags"]).quiet().nothrow();
	if (result.exitCode !== 0) throw new Error(`Cannot fetch remote tags from origin: ${outputOf(result) || `exit ${result.exitCode ?? "unknown"}`}`);
}

export function releaseAtomicPushArgs(version: string): readonly string[] {
	if (!isStableReleaseVersion(version)) throw new Error(`Release version must be exact stable X.Y.Z, received ${version}`);
	const tag = `v${version}`;
	return ["push", "--atomic", "origin", "HEAD:refs/heads/main", `refs/tags/${tag}:refs/tags/${tag}`];
}

export function assertAtomicPushRemoteState(output: string, sourceCommit: string, tag: string): void {
	const mainRef = "refs/heads/main";
	const tagRef = `refs/tags/${tag}`;
	const peeledTagRef = `${tagRef}^{}`;
	const expectedRefs = new Set([mainRef, tagRef, peeledTagRef]);
	const observed = new Map<string, string>();
	for (const line of output.trim().split("\n")) {
		if (line === "") continue;
		const fields = line.split("\t");
		if (fields.length !== 2 || !/^[0-9a-f]{40}$/u.test(fields[0]!) || !expectedRefs.has(fields[1]!)) {
			throw new Error(`Cannot verify atomic release push: malformed ls-remote output ${JSON.stringify(line)}`);
		}
		if (observed.has(fields[1]!)) throw new Error(`Cannot verify atomic release push: duplicate ref ${fields[1]!}`);
		observed.set(fields[1]!, fields[0]!);
	}
	if (observed.get(mainRef) !== sourceCommit) {
		throw new Error(`Cannot verify atomic release push: ${mainRef} does not resolve to the release commit`);
	}
	const remoteTag = observed.get(tagRef);
	if (remoteTag === undefined) {
		throw new Error(`Cannot verify atomic release push: ${tagRef} is missing`);
	}
	if ((observed.get(peeledTagRef) ?? remoteTag) !== sourceCommit) {
		throw new Error(`Cannot verify atomic release push: ${tagRef} does not peel to the release commit`);
	}
}

/**
 * Local state a rejected atomic push must undo so the same version can be
 * retried as the original transaction: the release tag and the release
 * commit (whose parent is the pre-release HEAD captured before tagging).
 */
export interface AtomicPushRollbackPlan {
	tag: string;
	preReleaseCommit: string;
}

export function planAtomicPushRollback(version: string, preReleaseCommit: string): AtomicPushRollbackPlan {
	if (!isStableReleaseVersion(version)) throw new Error(`Release version must be exact stable X.Y.Z, received ${version}`);
	if (!/^[0-9a-f]{40}$/u.test(preReleaseCommit)) throw new Error("Cannot resolve pre-release commit for atomic push rollback");
	return { tag: `v${version}`, preReleaseCommit };
}

/** Tolerantly parsed `git ls-remote` output: ref name to sha (unknown refs skipped). */
export function parseLsRemoteRefs(output: string): Map<string, string> {
	const refs = new Map<string, string>();
	for (const line of output.trim().split("\n")) {
		if (line === "") continue;
		const fields = line.split("\t");
		if (fields.length !== 2 || !/^[0-9a-f]{40}$/u.test(fields[0]!)) continue;
		refs.set(fields[1]!, fields[0]!);
	}
	return refs;
}

/** Peeled tag sha from parsed ls-remote refs (prefers the ^{} line for annotated tags). */
function peeledTagSha(refs: ReadonlyMap<string, string>, tag: string): string | undefined {
	return refs.get(`refs/tags/${tag}^{}`) ?? refs.get(`refs/tags/${tag}`);
}

export type AtomicPushFailureDisposition =
	// The remote accepted the atomic transaction even though the push command
	// reported failure; the run must continue as a success, never roll back.
	| { kind: "committed"; note: string }
	// Anything else — baseline-equal snapshots included — is ambiguous: refs
	// could have moved and been restored before the re-query, and a transient
	// tag may already have started the release workflow. Local state is always
	// preserved; an operator reconciles with durable server evidence.
	| { kind: "preserve"; note: string };

export interface AtomicPushReconciliation {
	sourceCommit: string;
	prePushMain: string;
	prePushTag: string;
	remoteReachable: boolean;
	postPushMain?: string;
	postPushTag?: string;
}

export function reconcileAtomicPushFailure(tag: string, input: AtomicPushReconciliation): AtomicPushFailureDisposition {
	if (!input.remoteReachable) {
		return {
			kind: "preserve",
			note: `The push failed AND the remote could not be re-queried, so whether the transaction committed is unknown. Local tag ${tag} and the release commit ${input.sourceCommit} are preserved untouched. Once origin is reachable, run \`git ls-remote origin refs/heads/main refs/tags/${tag} 'refs/tags/${tag}^{}'\`: if both refs resolve to ${input.sourceCommit} the release committed (rerun the script's verification, do NOT roll back); otherwise reconcile by hand with the guarded commands below.`,
		};
	}
	if (input.postPushMain === input.sourceCommit && input.postPushTag === input.sourceCommit) {
		return {
			kind: "committed",
			note: `git push reported failure, but remote refs/heads/main and ${tag} both resolve to the release commit ${input.sourceCommit}: the atomic transaction committed. Reconciling as success; no local state was rolled back.`,
		};
	}
	if (input.postPushMain === input.prePushMain && input.postPushTag === input.prePushTag) {
		return {
			kind: "preserve",
			note: `The remote currently reads as the pre-push baseline (main ${input.prePushMain}, ${tag} ${input.prePushTag === "" ? "absent" : input.prePushTag}), but a client-observed failed push does not PROVE rejection: GitHub may have committed the transaction and the refs could have been restored before this re-query, with the tag event already running. Local tag ${tag} and release commit ${input.sourceCommit} are preserved untouched. Before any rollback or retry, verify durably: no tag workflow run exists for ${tag}, and origin never carried ${input.sourceCommit}. Only then run the guarded rollback commands below; they are idempotent and safe to re-run.`,
		};
	}
	return {
		kind: "preserve",
		note: `The remote moved PARTIALLY (main: ${input.prePushMain} -> ${input.postPushMain ?? "unreadable"}, ${tag}: ${input.prePushTag === "" ? "absent" : input.prePushTag} -> ${input.postPushTag ?? "unreadable"}). Local tag ${tag} and release commit ${input.sourceCommit} are preserved untouched. Do not retry blindly: inspect origin, and only after proving neither ref carries ${input.sourceCommit} roll back locally; if only one ref carries it, repair the remote by hand before any retry.`,
	};
}

/**
 * Idempotent, per-outcome local rollback commands: each step is guarded so a
 * partially completed rollback can be re-run without the first successful
 * step failing the rest.
 */
export function localRollbackCommands(tag: string, releaseCommit: string, preReleaseCommit: string, state: { tagPresent: boolean; onReleaseCommit: boolean }): string[] {
	const commands: string[] = [];
	if (state.tagPresent) commands.push(`git show-ref --verify --quiet refs/tags/${tag} && git tag --delete ${tag}`);
	if (state.onReleaseCommit) commands.push(`test "$(git rev-parse HEAD)" = "${releaseCommit}" && git reset --hard ${preReleaseCommit}`);
	return commands;
}

export async function pushReleaseRefsAtomically(version: string): Promise<void> {
	const sourceCommit = (await git(["rev-parse", "HEAD"]).text()).trim();
	if (!/^[0-9a-f]{40}$/u.test(sourceCommit)) throw new Error("Cannot resolve release commit for atomic push");
	const preReleaseCommit = (await git(["rev-parse", "HEAD^"]).text()).trim();
	const rollbackPlan = planAtomicPushRollback(version, preReleaseCommit);
	const tag = rollbackPlan.tag;
	const remoteRefs = ["refs/heads/main", `refs/tags/${tag}`, `refs/tags/${tag}^{}`] as const;

	// Baseline BEFORE the push: without it, a failed push is ambiguous — the
	// remote may have committed the transaction while the client observed a
	// transport error — and rolling back on ambiguity can destroy the local
	// record of a release that actually shipped.
	const baseline = await git(["ls-remote", "origin", ...remoteRefs]).quiet().nothrow();
	if (baseline.exitCode !== 0) {
		throw new Error(`Cannot establish the pre-push remote baseline; refusing to push blind: ${outputOf(baseline) || `exit ${baseline.exitCode ?? "unknown"}`}`);
	}
	const baselineRefs = parseLsRemoteRefs(baseline.stdout.toString());
	const prePushMain = baselineRefs.get("refs/heads/main") ?? "";
	const prePushTag = peeledTagSha(baselineRefs, tag) ?? "";

	const push = await git(releaseAtomicPushArgs(version)).quiet().nothrow();
	if (push.exitCode !== 0) {
		const after = await git(["ls-remote", "origin", ...remoteRefs]).quiet().nothrow();
		const afterRefs = after.exitCode === 0 ? parseLsRemoteRefs(after.stdout.toString()) : new Map<string, string>();
		const disposition = reconcileAtomicPushFailure(tag, {
			sourceCommit,
			prePushMain,
			prePushTag,
			remoteReachable: after.exitCode === 0,
			postPushMain: afterRefs.get("refs/heads/main") ?? "",
			postPushTag: peeledTagSha(afterRefs, tag) ?? "",
		});
		if (disposition.kind === "committed") {
			// Fall through to the normal verification below, which re-proves the
			// remote state strictly.
			console.log(disposition.note);
		} else {
			// Preserve the complete local release state on every ambiguous
			// outcome. The guarded commands describe the rollback an operator
			// may run only after durably proving nothing shipped; each is
			// idempotent and safe to re-run in any order.
			const guarded = localRollbackCommands(tag, sourceCommit, rollbackPlan.preReleaseCommit, {
				tagPresent: true,
				onReleaseCommit: true,
			});
			throw new Error(
				`Atomic push of main and ${tag} failed with an ambiguous remote outcome: ${outputOf(push) || `exit ${push.exitCode ?? "unknown"}`}. ${disposition.note} Guarded local rollback commands (only after durable proof nothing shipped): ${guarded.join(" ; ")}`,
			);
		}
	}
	const remote = await git(["ls-remote", "origin", ...remoteRefs]).quiet().nothrow();
	if (remote.exitCode !== 0) {
		throw new Error(`Cannot verify atomic release push; do not independently push main or ${tag}: ${outputOf(remote) || `exit ${remote.exitCode ?? "unknown"}`}`);
	}
	assertAtomicPushRemoteState(remote.stdout.toString(), sourceCommit, tag);
}

async function latestVerifiedRemoteStableTag(): Promise<string> {
	const result = await git(["ls-remote", "--tags", "origin", "refs/tags/v*"]).quiet().nothrow();
	if (result.exitCode !== 0) throw new Error(`Cannot verify remote stable tags: ${outputOf(result) || `exit ${result.exitCode ?? "unknown"}`}`);
	const tags = new Set<string>();
	for (const line of result.stdout.toString().trim().split("\n")) {
		if (line === "") continue;
		const fields = line.split("\t");
		if (fields.length !== 2 || !/^[0-9a-f]{40}$/u.test(fields[0]!)) {
			throw new Error(`Cannot verify remote stable tags: malformed ls-remote output ${JSON.stringify(line)}`);
		}
		const match = fields[1]!.match(/^refs\/tags\/(v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))(?:\^\{\})?$/u);
		if (match) tags.add(match[1]!);
	}
	if (tags.size === 0) throw new Error("No stable vX.Y.Z tag exists on origin to compare against");
	return [...tags].reduce((latest, tag) => compareVersions(tag, latest) > 0 ? tag : latest);
}

async function assertReleaseVersionConsistency(version: string, publicPkgPaths: readonly string[]): Promise<void> {
	const publicPackageNames: string[] = [];
	for (const pkgPath of publicPkgPaths) {
		const manifest = await Bun.file(pkgPath).json() as unknown;
		if (!isObject(manifest) || typeof manifest.name !== "string" || typeof manifest.version !== "string" || manifest.private === true) {
			throw new Error(`Cannot verify public package release version in ${pkgPath}`);
		}
		if (manifest.version !== version) throw new Error(`Public package ${manifest.name} in ${pkgPath} has version ${manifest.version}, expected ${version}`);
		publicPackageNames.push(manifest.name);
	}

	const rootPackage = await Bun.file("package.json").json() as unknown;
	if (!isObject(rootPackage) || !isObject(rootPackage.workspaces) || !isObject(rootPackage.workspaces.catalog)) {
		throw new Error("Cannot verify root workspace catalog release versions");
	}
	const catalog = rootPackage.workspaces.catalog;
	for (const [name, catalogVersion] of Object.entries(catalog)) {
		if (!name.startsWith("@gajae-code/")) continue;
		if (catalogVersion !== version) throw new Error(`Root catalog ${name} has version ${String(catalogVersion)}, expected ${version}`);
	}
	for (const name of publicPackageNames.filter(name => name.startsWith("@gajae-code/"))) {
		if (catalog[name] !== version) throw new Error(`Root catalog does not match public package ${name} at ${version}`);
	}

	const cargoToml = await Bun.file("Cargo.toml").text();
	const workspaceVersion = cargoToml.match(/^\[workspace\.package\][\s\S]*?^version = "([^"]+)"/m)?.[1];
	if (workspaceVersion !== version) throw new Error(`Cargo workspace version ${workspaceVersion ?? "<missing>"} does not match ${version}`);
}


async function cmdRelease(version: string): Promise<void> {
	console.log("\n=== Release Script ===\n");

	// 1. Pre-flight checks
	console.log("Pre-flight checks...");

	const branch = await git(["branch", "--show-current"]).text();
	if (branch.trim() !== "main") {
		console.error(`Error: Must be on main branch (currently on '${branch.trim()}')`);
		process.exit(1);
	}
	console.log("  On main branch");

	const status = await git(["status", "--porcelain"]).text();
	if (status.trim()) {
		console.error("Error: Uncommitted changes detected. Commit or stash first.");
		console.error(status);
		process.exit(1);
	}
	console.log("  Working directory clean");

	if (!isStableReleaseVersion(version)) {
		throw new Error(`Release version must be exact stable X.Y.Z, received ${version}`);
	}
	await fetchRemoteTags();
	await assertImmutableNewTag(version);
	const latestTag = await latestVerifiedRemoteStableTag();
	if (compareVersions(version, latestTag) <= 0) {
		throw new Error(`Version ${version} must be greater than latest stable tag ${latestTag}`);
	}
	console.log(`  Version ${version} > verified origin tag ${latestTag}; tag v${version} is unused locally and on origin\n`);


	// 2. Update package versions
	console.log(`Updating package versions to ${version}…`);
	const pkgJsonPaths = await Array.fromAsync(packageJsonGlob.scan("."));

	// Filter out private packages
	const publicPkgPaths: string[] = [];
	const publicPackageVersions = new Set<string>();
	for (const pkgPath of pkgJsonPaths) {
		const pkgJson = await Bun.file(pkgPath).json();
		if (pkgJson.private) {
			console.log(`  Skipping ${pkgJson.name} (private)`);
			continue;
		}
		if (typeof pkgJson.version !== "string") throw new Error(`${pkgPath} is missing a string version`);
		publicPackageVersions.add(pkgJson.version);
		publicPkgPaths.push(pkgPath);
	}
	if (publicPackageVersions.size !== 1) {
		throw new Error(`Public packages must share one pre-release version, received ${[...publicPackageVersions].join(", ")}`);
	}
	const previousVersion = publicPackageVersions.values().next().value;
	if (previousVersion === undefined) throw new Error("No public packages found for release");
	await $`sd '"version": "[^"]+"' ${`"version": "${version}"`} ${publicPkgPaths}`;

	// Verify
	console.log("  Verifying versions:");
	for (const pkgPath of publicPkgPaths) {
		const pkgJson = await Bun.file(pkgPath).json();
		console.log(`    ${pkgJson.name}: ${pkgJson.version}`);
	}
	console.log();

	// Update @gajae-code/* catalog entries in root package.json
	console.log("Updating root catalog versions...");
	let rootPkgRaw = await Bun.file("package.json").text();
	rootPkgRaw = rootPkgRaw.replace(
		/("@gajae-code\/[^"]+":\s*)"[^"]+"/g,
		`$1"${version}"`,
	);
	await Bun.write("package.json", rootPkgRaw);
	console.log("  Updated root catalog @gajae-code/* entries");

	// 3. Update Rust workspace version
	console.log(`Updating Rust workspace version to ${version}…`);
	await $`sd '^version = "[^"]+"' ${`version = "${version}"`} Cargo.toml`;

	// Verify
	const cargoToml = await Bun.file("Cargo.toml").text();
	const versionMatch = cargoToml.match(/^\[workspace\.package\][\s\S]*?^version = "([^"]+)"/m);
	if (versionMatch) {
		console.log(`  workspace: ${versionMatch[1]}`);
	}

	// List crates using workspace version
	for await (const cargoPath of cargoTomlGlob.scan(".")) {
		const content = await Bun.file(cargoPath).text();
		if (content.includes("version.workspace = true")) {
			const nameMatch = content.match(/^name = "([^"]+)"/m);
			if (nameMatch) {
				console.log(`  ${nameMatch[1]}: ${version} (workspace)`);
			}
		}
	}
	await assertReleaseVersionConsistency(version, publicPkgPaths);
	console.log("  All public package, Cargo workspace, and @gajae-code catalog versions match");
	console.log();

	// 3b. Rename the pi-natives version sentinel so any `.node` left on disk from
	// a previous release physically cannot expose the symbol the new `index.js`
	// expects. The JS loader derives `VERSION_SENTINEL_EXPORT` from `package.json`
	// at runtime, so the only thing that has to move on the Rust side is the
	// `js_name = "__piNativesV…"` literal. `gen-enums.ts` regenerates the matching
	// entries in `packages/natives/native/{index.d.ts,index.js}` on the next napi
	// build, but bump them here too so the committed surface tracks the version
	// without waiting for a local rebuild on the release host.
	console.log(`Bumping pi-natives version sentinel to v${version}…`);
	const sentinelJsId = version.replace(/[^A-Za-z0-9]/g, "_");
	const sentinelName = `__piNativesV${sentinelJsId}`;
	const sentinelFiles = [
		"crates/pi-natives/src/lib.rs",
		"packages/natives/native/index.d.ts",
		"packages/natives/native/index.js",
	];
	await $`sd '__piNativesV[A-Za-z0-9_]+' ${sentinelName} ${sentinelFiles}`;
	const libRs = await Bun.file("crates/pi-natives/src/lib.rs").text();
	if (!libRs.includes(`js_name = "${sentinelName}"`)) {
		console.error(
			`Error: pi-natives version sentinel did not move to ${sentinelName} in crates/pi-natives/src/lib.rs. ` +
				"The `__piNativesV…` literal may have been removed or renamed; restore it before releasing.",
		);
		process.exit(1);
	}
	console.log(`  sentinel: ${sentinelName}\n`);

	// 4. Update lockfiles without re-resolving unrelated dependencies. A stable
	// release must preserve the exact third-party graph that passed review; only
	// owned workspace versions and their root catalog pins move here.
	console.log("Updating lockfiles...");
	const bunLockContent = await Bun.file("bun.lock").text();
	await Bun.write("bun.lock", releasedBunLockContent(bunLockContent, previousVersion, version));
	await $`bun install --frozen-lockfile`;
	// `cargo update --workspace` bumps only the workspace-member versions in
	// Cargo.lock to match the freshly bumped Cargo.toml, keeping every resolved
	// registry dependency exactly as tested. This intentionally does NOT do a
	// full re-resolution (`cargo generate-lockfile`): a full re-resolve fails
	// closed whenever a still-referenced transitive crate has been yanked
	// upstream (e.g. tree-sitter-perl-next 0.1.0/0.1.1), even though the
	// committed lock — and release CI, which builds from it — resolve fine.
	await $`cargo update --workspace`;
	console.log();

	// 4b. Regenerate the GJC plugin bundle so its embedded version tracks the
	// freshly bumped package version (otherwise `check:plugins` reports drift).
	console.log("Regenerating plugin bundle...");
	await $`bun run generate-plugins`;
	console.log();

	// 4c. Rebuild the native addon so the on-disk `.node` exports the freshly
	// bumped version sentinel. Otherwise the local checks below load a
	// stale addon (built against the previous sentinel) and fails. CI rebuilds
	// per platform; this keeps the maintainer's release run a single shot.
	console.log("Rebuilding native addon for the new sentinel…");
	await $`bun --cwd=packages/natives run build`;
	console.log();

	// 4d. Regenerate the telegram-daemon-generation-guard manifest so the
	// committed manifest keeps tracking `packages/natives/native/index.d.ts`,
	// whose `__piNativesV…` version sentinel the bump just rewrote. It only
	// re-records digests of the already-bumped, reviewed tree; the protected
	// daemon declaration digests are unchanged by a version bump.
	console.log("Regenerating telegram-daemon-generation-guard manifest…");
	await $`bun scripts/telegram-daemon-generation-guard.ts --write-manifest`;

	// 5. Update changelogs
	console.log("Updating CHANGELOGs...");
	await updateChangelogsForRelease(version);
	console.log();

	// 6. Run checks. Mirror the required CI `check` job exactly (`ci:check:full`,
	// native-free lint + typecheck). The heavier `bun run check` also runs
	// `check:sdk-closure` (load-sensitive SDK integration tests) and `check:rs`
	// (clippy under the local toolchain) — neither is part of CI's release gate;
	// the test suite is validated by CI's sharded jobs on the main-branch push.
	console.log("Running checks (ci:check:full, matching CI)…");
	await $`bun run ci:check:full`;
	console.log();

	// 7. Commit and tag
	console.log("Committing and tagging...");
	await git(["add", "--update"]);
	await git(["commit", "-m", `chore: bump version to ${version}`]);
	await git(["tag", "--no-sign", `v${version}`]);
	console.log();

	// 8. Push
	console.log("Pushing to remote...");
	await pushReleaseRefsAtomically(version);
	console.log();

	// 9. Watch CI. The refs are published from here on, so an observer that cannot
	// reach GitHub is reported as an observation gap — never as a CI verdict, and
	// never as a reason to cut another version.
	console.log("Watching CI...");
	let success: boolean;
	try {
		success = await watchCI(`v${version}`);
	} catch (error) {
		if (!(error instanceof ReleaseObservationError)) throw error;
		console.error(`\nCI observation unavailable: ${error.message}`);
		console.error(`  v${version} and its release commit are already pushed; this reports the observer, not the release.`);
		console.error("  Keep the published tag immutable; do not retag, delete, or force-push it.");
		console.error("  Do not cut a newer version for this failure. Re-observe once connectivity returns:");
		console.error("  bun scripts/release.ts watch");
		process.exit(1);
	}

	if (success) {
		console.log(`=== Released v${version} ===`);
	} else {
		console.error("\nStable release correction required:");
		console.error("  Keep the published tag immutable; do not retag, delete, or force-push it.");
		console.error("  Commit the fix, choose a newer X.Y.Z version, and run the release script again.");
		console.error("  Partial or conflicting npm publication cannot be repaired in place.");
		console.error("  bun scripts/release.ts <newer-version>");
		process.exit(1);

	}
}

// =============================================================================
// Main
// =============================================================================

export type ReleaseCli = { mode: "watch" } | { mode: "release"; version: string };

export function parseReleaseCli(argv: readonly string[]): ReleaseCli {
	if (argv.length !== 1) throw new Error("Release accepts exactly one argument: watch or an exact stable X.Y.Z version");
	const [argument] = argv;
	if (argument === "watch") return { mode: "watch" };
	if (argument !== undefined && isStableReleaseVersion(argument)) return { mode: "release", version: argument };
	throw new Error(`Unknown command or invalid version: ${argument ?? "<missing>"}`);
}

function printUsage(): void {
	console.error("Usage:");
	console.error("  bun scripts/release.ts <version>   Full release");
	console.error("  bun scripts/release.ts watch       Watch CI for current commit");
}

if (import.meta.main) {
	let command: ReleaseCli | undefined;
	try {
		command = parseReleaseCli(process.argv.slice(2));
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		printUsage();
		process.exitCode = 1;
	}
	if (command !== undefined) {
		if (command.mode === "watch") {
			await cmdWatch();
		} else {
			await cmdRelease(command.version);
		}
	}
}
