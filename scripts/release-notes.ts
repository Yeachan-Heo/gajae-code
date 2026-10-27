#!/usr/bin/env bun
/**
 * Derives GitHub Release notes for a release range in the historical
 * `## What's Changed` / `## New Contributors` / `**Full Changelog**` shape.
 *
 * `generate_release_notes: true` cannot describe a curated release. GitHub
 * derives its notes from pull requests merged into the target branch, so a
 * release assembled by cherry-picking onto `main` produces an empty body with
 * nothing but a compare link (v0.14.1 shipped exactly that).
 *
 * Attribution here is deliberately conservative, because the naive lookups are
 * actively misleading on a curated release:
 *
 *   - `GET /commits/{sha}/pulls` returns *every* pull request whose branch
 *     contains the commit. On 0.14.1 that credited shipped fixes to the
 *     32-commit `feat(autoresearch)!` workflow swap the release deliberately
 *     excluded, and to the promotion PR that carried everything.
 *   - Picking the smallest candidate is not enough either: a huge excluded PR
 *     can still be the only candidate.
 *
 * So a candidate pull request is accepted only when this release actually
 * ships it (see `SHIPPED_COVERAGE_THRESHOLD`), including the squash/merge OID
 * GitHub assigns when a PR lands; otherwise the entry falls back to a commit
 * link, which can never advertise unshipped work.
 *
 * Usage:
 *   bun scripts/release-notes.ts --base <tag> --head <rev> --repo <owner/name> --out <path>
 *   bun scripts/release-notes.ts --base v0.14.0 --head HEAD --repo o/n   # stdout
 */

import { $ } from "bun";

/** A pull request must land this share of its commits to be credited. */
export const SHIPPED_COVERAGE_THRESHOLD = 0.5;

const SUBJECT_PR_REF = /\s\(#(\d{1,7})\)$/u;
const BUMP_SUBJECT = /^chore: bump version to /u;

export interface ReleaseCommit {
	sha: string;
	subject: string;
	/**
	 * Git author display name from `%an`. It is NOT a GitHub login and must
	 * never be rendered as an `@` mention without a resolved `githubLogin`.
	 */
	author: string;
	/** Resolved GitHub login for the author, when the API provides one. */
	githubLogin?: string;
	/**
	 * Cherry-pick origin OID when this commit was cherry-picked AND GitHub still
	 * has that commit; else undefined. An origin GitHub never saw is not an
	 * attribution key (see `isKnownCommit`).
	 */
	originSha?: string;
}

export interface CandidatePullRequest {
	number: number;
	title: string;
	author: string;
	/** Subjects of every commit the pull request contains. */
	commitSubjects: readonly string[];
	/** OIDs of every commit the pull request contains (coverage is by identity). */
	commitOids: readonly string[];
	/** Squash or merge commit OID on the target repository, when GitHub provides it. */
	mergeCommitOid?: string;
}

export type Attribution =
	| { kind: "pull-request"; pullRequest: CandidatePullRequest }
	| { kind: "commit"; commit: ReleaseCommit };

export interface ReleaseNotesInput {
	repo: string;
	baseTag: string;
	headTag: string;
	commits: readonly ReleaseCommit[];
	/** Candidate pull requests keyed by commit sha. */
	candidatesBySha: ReadonlyMap<string, readonly CandidatePullRequest[]>;
	/** Every pull request this run knows about, keyed by number. */
	pullRequestsByNumber: ReadonlyMap<number, CandidatePullRequest>;
	/** Earliest merged pull request number per author login. */
	firstMergedPullRequestByAuthor: ReadonlyMap<string, number>;
}

/** Strips a trailing `(#1234)` so squashed and branch subjects compare equal. */
export function normalizeSubject(subject: string): string {
	return subject.replace(SUBJECT_PR_REF, "").trim();
}

export function parseSubjectPullRequestRef(subject: string): number | undefined {
	const match = subject.match(SUBJECT_PR_REF);
	return match ? Number(match[1]) : undefined;
}

/**
 * Share of `pullRequest`'s commits this release ships, compared by commit
 * OID (cherry-pick origins included). A shipped squash/merge OID is definitive
 * evidence even when none of the branch commit OIDs survive on the target
 * branch. Subject text cannot be used here:
 * duplicate subjects would count one shipped commit multiple times and push
 * a partially shipped candidate over the credit threshold.
 */
export function shippedCoverage(pullRequest: CandidatePullRequest, shippedOids: ReadonlySet<string>): number {
	if (pullRequest.mergeCommitOid !== undefined && shippedOids.has(pullRequest.mergeCommitOid)) return 1;
	if (pullRequest.commitOids.length === 0) return 0;
	let shipped = 0;
	for (const oid of pullRequest.commitOids) {
		if (shippedOids.has(oid)) shipped++;
	}
	return shipped / pullRequest.commitOids.length;
}

/**
 * A subject-embedded `(#N)` identifies the intended pull request, but it is
 * credited only when the release ships at least the same coverage threshold
 * as an API-discovered candidate, including its squash/merge OID. Otherwise
 * the smallest candidate this release actually ships wins, and an unshipped
 * candidate is rejected.
 */
export function attributeCommit(
	commit: ReleaseCommit,
	input: Pick<ReleaseNotesInput, "candidatesBySha" | "pullRequestsByNumber">,
	shippedSubjects: ReadonlySet<string>,
	shippedOids: ReadonlySet<string>,
): Attribution {
	const referenced = parseSubjectPullRequestRef(commit.subject);
	if (referenced !== undefined) {
		const pullRequest = input.pullRequestsByNumber.get(referenced);
		if (pullRequest && shippedCoverage(pullRequest, shippedOids) >= SHIPPED_COVERAGE_THRESHOLD) {
			return { kind: "pull-request", pullRequest };
		}
	}

	const normalized = normalizeSubject(commit.subject);
	const accepted = (input.candidatesBySha.get(commit.sha) ?? [])
		.filter(candidate => candidate.commitSubjects.some(subject => normalizeSubject(subject) === normalized))
		.filter(candidate => shippedCoverage(candidate, shippedOids) >= SHIPPED_COVERAGE_THRESHOLD)
		.sort((left, right) => left.commitSubjects.length - right.commitSubjects.length || left.number - right.number);

	const smallest = accepted[0];
	return smallest ? { kind: "pull-request", pullRequest: smallest } : { kind: "commit", commit };
}

export function buildReleaseNotes(input: ReleaseNotesInput): string {
	const repoUrl = `https://github.com/${input.repo}`;
	const shippedSubjects = new Set(input.commits.map(commit => normalizeSubject(commit.subject)));
	const shippedOids = new Set(input.commits.map(commit => commit.originSha ?? commit.sha));

	const lines: string[] = [];
	const credited = new Set<number>();
	for (const commit of input.commits) {
		const attribution = attributeCommit(commit, input, shippedSubjects, shippedOids);
		if (attribution.kind === "pull-request") {
			const { number, title, author } = attribution.pullRequest;
			if (credited.has(number)) continue;
			credited.add(number);
			lines.push(`* ${title} by @${author} in ${repoUrl}/pull/${number}`);
			continue;
		}
		const { sha, subject, author, githubLogin } = attribution.commit;
		// A Git display name is not a GitHub login: rendering it as `@name`
		// would publish an invalid or misleading mention.
		const credit = githubLogin !== undefined ? `@${githubLogin}` : author;
		lines.push(`* ${subject} by ${credit} in ${repoUrl}/commit/${sha.slice(0, 10)}`);
	}

	// A contributor is new when the release contains the earliest pull request
	// they ever merged. Ordered by that pull request so the list is stable.
	const newContributors = [...input.firstMergedPullRequestByAuthor]
		.filter(([, first]) => credited.has(first))
		.sort((left, right) => left[1] - right[1]);

	const sections = [`## What's Changed`, ...lines];
	if (newContributors.length > 0) {
		sections.push("", "## New Contributors");
		for (const [author, first] of newContributors) {
			sections.push(`* @${author} made their first contribution in ${repoUrl}/pull/${first}`);
		}
	}
	sections.push("", `**Full Changelog**: ${repoUrl}/compare/${input.baseTag}...${input.headTag}`, "");
	return sections.join("\n");
}

async function git(args: readonly string[]): Promise<string> {
	const result = await $`git ${args}`.quiet().nothrow();
	if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString().trim()}`);
	return result.stdout.toString();
}

/** stderr patterns that mean "definitely nothing exists", not "lookup failed". */
const EXPLICIT_EMPTY_PATTERNS: readonly RegExp[] = [
	/could not resolve to a PullRequest/iu,
	/no pull requests? found/iu,
];

/**
 * True only for an explicit no-result response: a successful exit, or a
 * failure whose stderr positively identifies "does not exist". Anything else
 * (auth, transport, rate limit, server error) must fail closed, because
 * deriving notes from a partially reachable GitHub silently drops attribution
 * and new-contributor detection, and the release cannot be redone once the
 * published packages are immutable.
 */
export function isExplicitEmptyGhResult(exitCode: number, stderr: string): boolean {
	if (exitCode === 0) return true;
	return EXPLICIT_EMPTY_PATTERNS.some(pattern => pattern.test(stderr));
}

/** stderr patterns that mean "this repository has no such commit", not "lookup failed". */
const UNKNOWN_COMMIT_PATTERNS: readonly RegExp[] = [
	/no commit found for sha/iu,
];

/**
 * True only when GitHub positively answers that a commit OID is unknown to the
 * repository (HTTP 422 on a commit endpoint). Like `isExplicitEmptyGhResult`
 * this is an answer, not a failure; every other non-zero exit still fails
 * closed.
 */
export function isUnknownCommitGhResult(exitCode: number, stderr: string): boolean {
	if (exitCode === 0) return false;
	return UNKNOWN_COMMIT_PATTERNS.some(pattern => pattern.test(stderr));
}
/**
 * True for a GitHub rate-limit refusal, the one failure that is worth waiting
 * out instead of failing the release: the request was well-formed and the quota
 * replenishes on a known schedule.
 */
export function isRateLimitedGhResult(exitCode: number, stderr: string): boolean {
	if (exitCode === 0) return false;
	return /rate limit exceeded|secondary rate limit|abuse detection/iu.test(stderr);
}

/** stderr patterns for a read GitHub dropped in flight, not a refusal or a "does not exist" answer. */
const TRANSIENT_GH_PATTERNS: readonly RegExp[] = [
	// `gh --jq` over a truncated or empty response body.
	/unexpected end of JSON input/iu,
	/\bHTTP 50[0234]\b/u,
	/connection reset by peer|unexpected EOF|i\/o timeout|TLS handshake timeout/iu,
];

/**
 * True for a transport-level failure where the same read can succeed on retry.
 * A large release window issues hundreds of reads, so one dropped response is
 * likely. Before this check it failed release-note derivation after the tag was
 * already immutable (v0.18.12 failed twice on "unexpected end of JSON input").
 * Retrying does not change which results count as complete. A failure that
 * persists still fails closed.
 */
export function isTransientGhResult(exitCode: number, stderr: string): boolean {
	if (exitCode === 0) return false;
	return TRANSIENT_GH_PATTERNS.some(pattern => pattern.test(stderr));
}

const GH_TRANSIENT_ATTEMPTS = 4;

/** Runs a read-only gh call, retrying only transient transport failures with exponential backoff. */
async function runGh(args: readonly string[]): Promise<$.ShellOutput> {
	for (let attempt = 1; ; attempt++) {
		const result = await $`gh ${args}`.quiet().nothrow();
		if (attempt >= GH_TRANSIENT_ATTEMPTS || !isTransientGhResult(result.exitCode, result.stderr.toString())) {
			return result;
		}
		await Bun.sleep(1_000 * 2 ** attempt);
	}
}

/**
 * Milliseconds to wait for a quota window to reopen, from a UNIX-second reset
 * stamp. Clamped: a missing/absurd stamp still waits a usable minimum, and a
 * far-future stamp cannot park the release for longer than the ceiling.
 */
export function rateLimitWaitMs(resetAtSeconds: number | undefined, nowMs: number, ceilingMs = 90_000): number {
	const resetAtMs = resetAtSeconds === undefined ? Number.NaN : resetAtSeconds * 1000;
	if (!Number.isFinite(resetAtMs)) return Math.min(15_000, ceilingMs);
	return Math.min(Math.max(resetAtMs - nowMs + 2_000, 5_000), ceilingMs);
}

/** Live search-endpoint quota, or undefined when it cannot be read. */
async function searchQuotaResetSeconds(): Promise<{ remaining: number; reset: number } | undefined> {
	const result = await $`gh api rate_limit --jq '.resources.search | "\(.remaining) \(.reset)"'`.quiet().nothrow();
	if (result.exitCode !== 0) return undefined;
	const [remaining, reset] = result.stdout.toString().trim().split(/\s+/u).map(Number);
	if (!Number.isFinite(remaining) || !Number.isFinite(reset)) return undefined;
	return { remaining: remaining as number, reset: reset as number };
}

/**
 * Search-endpoint call, paced against the live quota.
 *
 * Search is the scarce endpoint here — an installation token gets 30 requests a
 * minute, and a large release window needs one paginated query per contributing
 * author, which exhausts it. Notes must stay COMPLETE (see
 * `isExplicitEmptyGhResult`: a partially reachable GitHub silently drops
 * attribution and new-contributor detection, and an immutable publish cannot be
 * redone), so a limit is waited out here rather than skipped.
 */
async function ghSearch(args: readonly string[]): Promise<string> {
	for (let attempt = 0; ; attempt++) {
		const quota = await searchQuotaResetSeconds();
		if (quota && quota.remaining <= 1) {
			await Bun.sleep(rateLimitWaitMs(quota.reset, Date.now()));
		}
		const result = await runGh(args);
		if (result.exitCode === 0) return result.stdout.toString();
		const stderr = result.stderr.toString().trim();
		if (attempt >= 5 || !isRateLimitedGhResult(result.exitCode, stderr)) {
			throw new Error(`gh ${args.join(" ")} failed (exit ${result.exitCode}): ${stderr}`);
		}
		await Bun.sleep(rateLimitWaitMs((await searchQuotaResetSeconds())?.reset, Date.now()));
	}
}

async function gh(args: readonly string[]): Promise<string> {
	const result = await runGh(args);
	if (result.exitCode !== 0) {
		throw new Error(`gh ${args.join(" ")} failed (exit ${result.exitCode}): ${result.stderr.toString().trim()}`);
	}
	return result.stdout.toString();
}

async function ghAllowExplicitEmpty(args: readonly string[]): Promise<string | undefined> {
	const result = await runGh(args);
	if (result.exitCode !== 0) {
		const stderr = result.stderr.toString().trim();
		if (isExplicitEmptyGhResult(result.exitCode, stderr)) return undefined;
		throw new Error(`gh ${args.join(" ")} failed (exit ${result.exitCode}): ${stderr}`);
	}
	return result.stdout.toString();
}

async function collectCommits(repo: string, baseTag: string, head: string): Promise<ReleaseCommit[]> {
	const raw = await git(["log", "--no-merges", "--reverse", "--format=%H%x1f%s%x1f%an", `${baseTag}..${head}`]);
	const commits: ReleaseCommit[] = [];
	for (const line of raw.split("\n")) {
		if (line.trim() === "") continue;
		const [sha, subject, author] = line.split("\x1f");
		if (sha === undefined || subject === undefined || author === undefined) continue;
		// The release script's own version bump is machinery, not a change.
		if (BUMP_SUBJECT.test(subject)) continue;
		const originSha = await cherryPickOrigin(sha);
		const attributable = originSha !== sha && (await isKnownCommit(repo, originSha));
		commits.push({ sha, subject, author, ...(attributable ? { originSha } : {}) });
	}
	return commits;
}

async function cherryPickOrigin(sha: string): Promise<string> {
	const body = await git(["show", "-s", "--format=%b", sha]);
	return body.match(/cherry picked from commit ([0-9a-f]{40})/u)?.[1] ?? sha;
}

/**
 * Whether GitHub can still resolve a commit OID in this repository.
 *
 * A `(cherry picked from commit …)` trailer routinely names a commit GitHub
 * never saw: the source was a local worktree branch, or a branch that was
 * force-pushed away and garbage collected. Using such an OID as the attribution
 * key made every commit lookup fail with HTTP 422 "No commit found for SHA",
 * which failed the whole release-notes derivation (v0.15.1 died on exactly
 * that, after its tag was already immutable). An unknown origin carries no
 * attribution, so the shipped OID is used instead.
 */
async function isKnownCommit(repo: string, sha: string): Promise<boolean> {
	const result = await runGh(["api", `repos/${repo}/commits/${sha}`, "--jq", ".sha"]);
	if (result.exitCode === 0) return true;
	const stderr = result.stderr.toString().trim();
	if (isUnknownCommitGhResult(result.exitCode, stderr)) return false;
	throw new Error(`gh api repos/${repo}/commits/${sha} failed (exit ${result.exitCode}): ${stderr}`);
}

async function loadPullRequest(repo: string, number: number): Promise<CandidatePullRequest | undefined> {
	const raw = await ghAllowExplicitEmpty(["pr", "view", String(number), "--repo", repo, "--json", "number,title,author,commits"]);
	if (raw === undefined || raw.trim() === "") return undefined;
	const parsed = JSON.parse(raw) as {
		number: number;
		title: string;
		author: { login: string };
		commits: { messageHeadline: string; oid: string }[];
	};
	const mergeCommitRaw = await gh(["api", `repos/${repo}/pulls/${number}`, "--jq", ".merge_commit_sha // \"\""]);
	const mergeCommitOid = mergeCommitRaw.trim();
	return {
		number: parsed.number,
		title: parsed.title,
		author: parsed.author.login,
		commitSubjects: parsed.commits.map(commit => commit.messageHeadline),
		commitOids: parsed.commits.map(commit => commit.oid),
		...(mergeCommitOid === "" ? {} : { mergeCommitOid }),
	};
}

async function candidateNumbers(repo: string, sha: string): Promise<number[]> {
	const raw = await gh([
		"api",
		"--paginate",
		`repos/${repo}/commits/${sha}/pulls?per_page=100`,
		"--jq",
		".[] | select(.merged_at != null) | .number",
	]);
	if (raw.trim() === "") return [];
	return raw.trim().split(/\s+/u).map(Number);
}

/** Picks the earliest MERGED pull request by merge timestamp, not creation time. */
export function earliestMergedPullRequest(pullRequests: readonly { number: number; mergedAt: string }[]): number | undefined {
	let earliest: { number: number; mergedAt: string } | undefined;
	for (const pr of pullRequests) {
		if (earliest === undefined || pr.mergedAt < earliest.mergedAt || (pr.mergedAt === earliest.mergedAt && pr.number < earliest.number)) {
			earliest = pr;
		}
	}
	return earliest?.number;
}

async function firstMergedPullRequest(repo: string, author: string): Promise<number | undefined> {
	// The search API cannot sort by merge time and its CLI JSON surface does not
	// expose merge timestamps reliably. Paginate the REST search results and
	// select the minimum explicit merge timestamp across the complete result set.
	const raw = await ghSearch([
		"api",
		"--paginate",
		`search/issues?q=repo:${repo}+author:${author}+is:pr+is:merged&sort=created&order=asc&per_page=100`,
		"--jq",
		".items[] | select(.pull_request.merged_at != null) | {number, mergedAt: .pull_request.merged_at} | @json",
	]);
	if (raw.trim() === "") return undefined;
	const pullRequests = raw.trim().split(/\r?\n/u).map(line => JSON.parse(line) as { number: number; mergedAt: string });
	return earliestMergedPullRequest(pullRequests);
}

/**
 * Resolves the GitHub login authoring a commit. The API reports `null` when
 * the commit email is not linked to any account; that is an explicit answer,
 * not a failure, and yields `undefined` (the caller renders the Git display
 * name without `@`). Transport/API failures throw via the strict gh path.
 */
async function resolveCommitLogin(repo: string, sha: string): Promise<string | undefined> {
	const raw = await gh(["api", `repos/${repo}/commits/${sha}`, "--jq", ".author.login // \"\""]);
	const login = raw.trim();
	return login === "" || login === "null" ? undefined : login;
}

export async function deriveReleaseNotes(repo: string, baseTag: string, head: string, headTag: string): Promise<string> {
	const commits = await collectCommits(repo, baseTag, head);
	const pullRequestsByNumber = new Map<number, CandidatePullRequest>();
	const candidatesBySha = new Map<string, readonly CandidatePullRequest[]>();

	const ensure = async (number: number): Promise<CandidatePullRequest | undefined> => {
		const cached = pullRequestsByNumber.get(number);
		if (cached) return cached;
		const loaded = await loadPullRequest(repo, number);
		if (loaded) pullRequestsByNumber.set(number, loaded);
		return loaded;
	};

	for (const commit of commits) {
		const referenced = parseSubjectPullRequestRef(commit.subject);

		if (referenced !== undefined && (await ensure(referenced))) continue;
		const candidates: CandidatePullRequest[] = [];
		for (const number of await candidateNumbers(repo, commit.originSha ?? commit.sha)) {
			const loaded = await ensure(number);
			if (loaded) candidates.push(loaded);
		}
		candidatesBySha.set(commit.sha, candidates);
	}

	const shippedSubjects = new Set(commits.map(commit => normalizeSubject(commit.subject)));
	const shippedOids = new Set(commits.map(commit => commit.originSha ?? commit.sha));
	const firstMergedPullRequestByAuthor = new Map<string, number>();
	for (const commit of commits) {
		const attribution = attributeCommit(commit, { candidatesBySha, pullRequestsByNumber }, shippedSubjects, shippedOids);
		if (attribution.kind !== "pull-request") {
			// Fallback commits credit by login only when one is resolved;
			// otherwise the Git display name is rendered without `@`.
			commit.githubLogin = await resolveCommitLogin(repo, commit.originSha ?? commit.sha);
			continue;
		}
		const { author } = attribution.pullRequest;
		if (firstMergedPullRequestByAuthor.has(author)) continue;
		const first = await firstMergedPullRequest(repo, author);
		if (first !== undefined) firstMergedPullRequestByAuthor.set(author, first);
	}

	return buildReleaseNotes({
		repo,
		baseTag,
		headTag,
		commits,
		candidatesBySha,
		pullRequestsByNumber,
		firstMergedPullRequestByAuthor,
	});
}

export interface ReleaseNotesCli {
	repo: string;
	base: string;
	head: string;
	headTag: string;
	out?: string;
}

export function parseReleaseNotesCli(argv: readonly string[]): ReleaseNotesCli {
	const values = new Map<string, string>();
	for (let index = 0; index < argv.length; index += 2) {
		const flag = argv[index];
		const value = argv[index + 1];
		if (flag === undefined || !flag.startsWith("--") || value === undefined) {
			throw new Error("Usage: release-notes.ts --base <tag> --head <rev> --repo <owner/name> [--head-tag <tag>] [--out <path>]");
		}
		values.set(flag.slice(2), value);
	}
	const repo = values.get("repo");
	const base = values.get("base");
	if (repo === undefined || base === undefined) throw new Error("--repo and --base are required");
	const head = values.get("head") ?? "HEAD";
	return { repo, base, head, headTag: values.get("head-tag") ?? head, out: values.get("out") };
}

if (import.meta.main) {
	try {
		const cli = parseReleaseNotesCli(process.argv.slice(2));
		const notes = await deriveReleaseNotes(cli.repo, cli.base, cli.head, cli.headTag);
		if (cli.out === undefined) process.stdout.write(notes);
		else await Bun.write(cli.out, notes);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
