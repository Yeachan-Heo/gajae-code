import { describe, expect, test } from "bun:test";
import {
	type CandidatePullRequest,
	type ReleaseCommit,
	SHIPPED_COVERAGE_THRESHOLD,
	attributeCommit,
	buildReleaseNotes,
	earliestMergedPullRequest,
	isExplicitEmptyGhResult,
	isRateLimitedGhResult,
	isTransientGhResult,
	isUnknownCommitGhResult,
	rateLimitWaitMs,
	normalizeSubject,
	parseReleaseNotesCli,
	parseSubjectPullRequestRef,
	shippedCoverage,
} from "./release-notes";

const repo = "Yeachan-Heo/gajae-code";

function commit(sha: string, subject: string, author = "Yeachan-Heo"): ReleaseCommit {
	return { sha, subject, author };
}

function pullRequest(
	number: number,
	title: string,
	commitSubjects: readonly string[],
	author = "Yeachan-Heo",
	commitOids?: readonly string[],
	mergeCommitOid?: string,
): CandidatePullRequest {
	return {
		number,
		title,
		author,
		commitSubjects,
		commitOids: commitOids ?? commitSubjects.map((_, index) => `${number}-oid-${index}`),
		...(mergeCommitOid === undefined ? {} : { mergeCommitOid }),
	};
}

function notes(input: {
	commits: readonly ReleaseCommit[];
	candidatesBySha?: ReadonlyMap<string, readonly CandidatePullRequest[]>;
	pullRequestsByNumber?: ReadonlyMap<number, CandidatePullRequest>;
	firstMergedPullRequestByAuthor?: ReadonlyMap<string, number>;
}): string {
	return buildReleaseNotes({
		repo,
		baseTag: "v0.14.0",
		headTag: "v0.14.1",
		commits: input.commits,
		candidatesBySha: input.candidatesBySha ?? new Map(),
		pullRequestsByNumber: input.pullRequestsByNumber ?? new Map(),
		firstMergedPullRequestByAuthor: input.firstMergedPullRequestByAuthor ?? new Map(),
	});
}

function createSeededRandom(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
		return state / 0x1_0000_0000;
	};
}

function generatedStderr(random: () => number, maxLength = 96): string {
	const characters = " abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789:.,_-/\n\t[](){}";
	const length = Math.floor(random() * (maxLength + 1));
	let text = "";
	for (let index = 0; index < length; index++) {
		text += characters[Math.floor(random() * characters.length)];
	}
	return text;
}

function generatedRefusalContext(random: () => number): string {
	const words = ["request", "authorization", "repository", "lookup", "permission", "scope", "resource", "denied"];
	const count = 1 + Math.floor(random() * 5);
	const context: string[] = [];
	for (let index = 0; index < count; index++) {
		context.push(words[Math.floor(random() * words.length)]!);
	}
	return context.join(" ");
}

const SUPPORTED_TRANSIENT_GH_ERRORS = [
	"unexpected end of JSON input",
	"HTTP 500: Internal Server Error",
	"HTTP 502: Bad Gateway",
	"HTTP 503: Service Unavailable",
	"HTTP 504: Gateway Timeout",
	"connection reset by peer",
	"unexpected EOF",
	"i/o timeout",
	"TLS handshake timeout",
] as const;

describe("subject parsing", () => {
	test("reads and strips a trailing pull request reference", () => {
		expect(parseSubjectPullRequestRef("fix(ai): bound the connect phase (#4666)")).toBe(4666);
		expect(normalizeSubject("fix(ai): bound the connect phase (#4666)")).toBe("fix(ai): bound the connect phase");
	});

	test("ignores issue references that are not a trailing pull request suffix", () => {
		expect(parseSubjectPullRequestRef("docs(changelog): record the fix from #4606")).toBeUndefined();
		expect(parseSubjectPullRequestRef("fix(natives): stop the AVX2 probe (#4652) flashing")).toBeUndefined();
	});

	test("normalizing is idempotent so squashed and branch subjects compare equal", () => {
		const squashed = normalizeSubject("feat(provider): add oMLX profiles (#4607)");
		expect(normalizeSubject(squashed)).toBe(squashed);
		expect(squashed).toBe(normalizeSubject("feat(provider): add oMLX profiles"));
	});
});

describe("shipped coverage", () => {
	test("measures the share of a pull request the release carries", () => {
		const pr = pullRequest(4607, "feat(provider): add oMLX profiles", ["a", "b", "c", "d"]);
		expect(shippedCoverage(pr, new Set(["4607-oid-0", "4607-oid-1", "4607-oid-2", "4607-oid-3"]))).toBe(1);
		expect(shippedCoverage(pr, new Set(["4607-oid-0", "4607-oid-1"]))).toBe(0.5);
		expect(shippedCoverage(pr, new Set(["4607-oid-0"]))).toBe(0.25);
	});

	test("treats a pull request with no commits as unshipped instead of dividing by zero", () => {
		expect(shippedCoverage(pullRequest(1, "empty", []), new Set(["a"]))).toBe(0);
	});

	test("accepts a shipped squash commit when branch OIDs differ", () => {
		const pr = pullRequest(4608, "fix(provider): squash the release fix", ["branch commit"], "Yeachan-Heo", ["branch-oid"], "squash-oid");
		expect(shippedCoverage(pr, new Set(["squash-oid"]))).toBe(1);
	});
});

describe("attribution", () => {
	test("a subject reference wins over any candidate", () => {
		const referenced = pullRequest(4666, "fix(ai): bound the Anthropic connect phase", ["fix(ai): bound the Anthropic connect phase"], "Yeachan-Heo", ["aaa"]);
		const contained = pullRequest(4430, "feat(autoresearch)!: replace the team workflow", ["fix(ai): bound the connect phase (#4666)"]);
		const subject = "fix(ai): bound the connect phase (#4666)";

		const attribution = attributeCommit(
			commit("aaa", subject),
			{ candidatesBySha: new Map([["aaa", [contained]]]), pullRequestsByNumber: new Map([[4666, referenced]]) },
			new Set([normalizeSubject(subject)]),
			new Set(["aaa"]),
		);

		expect(attribution).toEqual({ kind: "pull-request", pullRequest: referenced });
	});

	test("rejects a referenced pull request when the release ships below the coverage threshold", () => {
		const referenced = pullRequest(4667, "fix(ai): partially shipped", ["fix(ai): partially shipped", "second", "third", "fourth"], "Yeachan-Heo", ["o1", "o2", "o3", "o4"]);
		const shipped = commit("o1", "fix(ai): partially shipped (#4667)");

		const attribution = attributeCommit(
			shipped,
			{ candidatesBySha: new Map(), pullRequestsByNumber: new Map([[4667, referenced]]) },
			new Set([normalizeSubject(shipped.subject)]),
			new Set(["o1"]),
		);

		expect(attribution).toEqual({ kind: "commit", commit: shipped });
	});

	test("credits a referenced pull request through its squash commit", () => {
		const referenced = pullRequest(4668, "fix(ai): squash attribution", ["branch commit"], "Yeachan-Heo", ["branch-oid"], "squash-oid");
		const shipped = commit("squash-oid", "fix(ai): squash attribution (#4668)");

		const attribution = attributeCommit(
			shipped,
			{ candidatesBySha: new Map(), pullRequestsByNumber: new Map([[4668, referenced]]) },
			new Set([normalizeSubject(shipped.subject)]),
			new Set(["squash-oid"]),
		);

		expect(attribution).toEqual({ kind: "pull-request", pullRequest: referenced });
	});

	test("rejects a containing pull request the release does not ship", () => {
		// The 0.14.1 case: the autoresearch swap contained two shipped test
		// commits, but the release excluded the swap itself.
		const swap = pullRequest(
			4430,
			"feat(autoresearch)!: replace the team workflow",
			["test(computer): add a red-team suite", ...Array.from({ length: 31 }, (_, index) => `unshipped ${index}`)],
		);
		const shipped = commit("bbb", "test(computer): add a red-team suite");

		const attribution = attributeCommit(
			shipped,
			{ candidatesBySha: new Map([["bbb", [swap]]]), pullRequestsByNumber: new Map() },
			new Set([shipped.subject]),
			new Set(["bbb"]),
		);

		expect(attribution).toEqual({ kind: "commit", commit: shipped });
	});

	test("prefers the smallest fully shipped pull request over a larger one", () => {
		const subject = "feat(provider): add oMLX profiles";
		const promotion = pullRequest(4676, "release: promote blockers to main", [subject, "second"]);
		const owner = pullRequest(4607, "feat(provider): add built-in oMLX profiles", [subject]);

		const attribution = attributeCommit(
			commit("ccc", subject),
			{ candidatesBySha: new Map([["ccc", [promotion, owner]]]), pullRequestsByNumber: new Map() },
			new Set([subject, "second"]),
			new Set(["4676-oid-0", "4676-oid-1", "4607-oid-0"]),
		);

		expect(attribution).toEqual({ kind: "pull-request", pullRequest: owner });
	});

	test("a candidate that does not contain the commit never wins", () => {
		const unrelated = pullRequest(4000, "unrelated", ["something else"]);
		const orphan = commit("ddd", "fix(x): orphan change");

		expect(
			attributeCommit(
				orphan,
				{ candidatesBySha: new Map([["ddd", [unrelated]]]), pullRequestsByNumber: new Map() },
				new Set([orphan.subject, "something else"]),
				new Set(["ddd", "4000-oid-0"]),
			),
		).toEqual({ kind: "commit", commit: orphan });
	});

	test("coverage exactly at the threshold is accepted", () => {
		const subject = "fix(a): half";
		const half = pullRequest(10, "half shipped", [subject, "unshipped"]);
		expect(shippedCoverage(half, new Set(["10-oid-0"]))).toBe(SHIPPED_COVERAGE_THRESHOLD);
		expect(
			attributeCommit(
				commit("eee", subject),
				{ candidatesBySha: new Map([["eee", [half]]]), pullRequestsByNumber: new Map() },
				new Set([subject]),
				new Set(["eee", "10-oid-0"]),
			),
		).toEqual({ kind: "pull-request", pullRequest: half });
	});

	test("duplicate subjects cannot inflate coverage: only the actually shipped OID counts", () => {
		// Regression: subject-based coverage counted the duplicated subject
		// twice (2/4 = 0.5) although only one of the four commits shipped.
		const partial = pullRequest(11, "partially shipped", ["dup", "dup", "c", "d"], "Yeachan-Heo", ["o1", "o2", "o3", "o4"]);
		const shipped = commit("fff111", "dup");
		expect(shippedCoverage(partial, new Set(["fff111", "o1"]))).toBe(0.25);
		const attribution = attributeCommit(
			shipped,
			{ candidatesBySha: new Map([["fff111", [partial]]]), pullRequestsByNumber: new Map() },
			new Set(["dup"]),
			new Set(["fff111", "o1"]),
		);
		expect(attribution).toEqual({ kind: "commit", commit: shipped });
	});
});

describe("notes body", () => {
	test("keeps the historical section order and compare link", () => {
		const body = notes({ commits: [commit("fff", "fix(x): direct push")] });
		expect(body.startsWith("## What's Changed\n")).toBe(true);
		// No resolved login: the Git display name renders without an `@` mention.
		expect(body).toContain(`* fix(x): direct push by Yeachan-Heo in https://github.com/${repo}/commit/fff`);
		expect(body).not.toContain("@Yeachan-Heo");
		expect(body.trimEnd().endsWith(`**Full Changelog**: https://github.com/${repo}/compare/v0.14.0...v0.14.1`)).toBe(true);
	});

	test("credits the resolved GitHub login for fallback commits, never a display-name mention", () => {
		const withLogin: ReleaseCommit = { sha: "abc", subject: "fix(y): direct push", author: "Yeachan Heo", githubLogin: "Yeachan-Heo" };
		const withoutLogin: ReleaseCommit = { sha: "def", subject: "fix(z): direct push", author: "Some Display Name" };
		const body = notes({ commits: [withLogin, withoutLogin] });

		expect(body).toContain(`* fix(y): direct push by @Yeachan-Heo in https://github.com/${repo}/commit/abc`);
		expect(body).toContain(`* fix(z): direct push by Some Display Name in https://github.com/${repo}/commit/def`);
		expect(body).not.toContain("@Some Display Name");
	});

	test("credits a pull request once even when several of its commits ship", () => {
		const pr = pullRequest(4607, "feat(provider): add oMLX profiles", ["first (#4607)", "second (#4607)"], "Yeachan-Heo", ["a1", "a2"]);
		const body = notes({
			commits: [commit("a1", "first (#4607)"), commit("a2", "second (#4607)")],
			pullRequestsByNumber: new Map([[4607, pr]]),
		});

		expect(body.match(/pull\/4607/gu)).toHaveLength(1);
		expect(body).not.toContain("/commit/a2");
	});

	test("omits the contributors section when nobody is new", () => {
		const pr = pullRequest(4666, "fix(ai): bound the connect phase", ["fix(ai): bound the connect phase (#4666)"]);
		const body = notes({
			commits: [commit("b1", "fix(ai): bound the connect phase (#4666)")],
			pullRequestsByNumber: new Map([[4666, pr]]),
			firstMergedPullRequestByAuthor: new Map([["Yeachan-Heo", 1]]),
		});

		expect(body).not.toContain("New Contributors");
	});

	test("lists a contributor whose first merged pull request is in this release", () => {
		const first = pullRequest(4635, "fix(usage): preserve probe limits", ["fix(usage): preserve probe limits (#4635)"], "asdfqwerzxcc", ["c1"]);
		const repeat = pullRequest(4666, "fix(ai): bound the connect phase", ["fix(ai): bound the connect phase (#4666)"], "Yeachan-Heo", ["c2"]);
		const body = notes({
			commits: [commit("c1", "fix(usage): preserve probe limits (#4635)"), commit("c2", "fix(ai): bound the connect phase (#4666)")],
			pullRequestsByNumber: new Map([
				[4635, first],
				[4666, repeat],
			]),
			firstMergedPullRequestByAuthor: new Map([
				["asdfqwerzxcc", 4635],
				["Yeachan-Heo", 1],
			]),
		});

		expect(body).toContain(`* @asdfqwerzxcc made their first contribution in https://github.com/${repo}/pull/4635`);
		expect(body).not.toContain("@Yeachan-Heo made their first contribution");
	});
});

describe("cli", () => {
	test("requires repo and base", () => {
		expect(() => parseReleaseNotesCli(["--base", "v0.14.0"])).toThrow("--repo and --base are required");
		expect(() => parseReleaseNotesCli(["--repo", "o/n"])).toThrow("--repo and --base are required");
	});

	test("defaults head and head tag, and reads the output path", () => {
		expect(parseReleaseNotesCli(["--repo", "o/n", "--base", "v0.14.0"])).toEqual({
			repo: "o/n",
			base: "v0.14.0",
			head: "HEAD",
			headTag: "HEAD",
			out: undefined,
		});
		expect(parseReleaseNotesCli(["--repo", "o/n", "--base", "v0.14.0", "--head-tag", "v0.14.1", "--out", "/tmp/n.md"])).toEqual({
			repo: "o/n",
			base: "v0.14.0",
			head: "HEAD",
			headTag: "v0.14.1",
			out: "/tmp/n.md",
		});
	});

	test("rejects a dangling flag instead of silently dropping it", () => {
		expect(() => parseReleaseNotesCli(["--repo", "o/n", "--base"])).toThrow("Usage");
	});
});

describe("fail-closed gh result classification", () => {
	test("treats success and explicit not-found as empty, everything else as failure", () => {
		// Explicit success and explicit no-result responses are the only empty outcomes.
		expect(isExplicitEmptyGhResult(0, "")).toBe(true);
		expect(isExplicitEmptyGhResult(1, "GraphQL: Could not resolve to a PullRequest with the number of 999999.")).toBe(true);
		expect(isExplicitEmptyGhResult(1, "no pull requests found")).toBe(true);
	});

	test("fails closed on auth, transport, and API errors", () => {
		expect(isExplicitEmptyGhResult(1, "gh: To authenticate, please run `gh auth login`.")).toBe(false);
		expect(isExplicitEmptyGhResult(1, "HTTP 403: Resource not accessible by integration")).toBe(false);
		expect(isExplicitEmptyGhResult(1, "HTTP 500: Internal Server Error")).toBe(false);
		expect(isExplicitEmptyGhResult(1, "dial tcp: lookup api.github.com: no such host")).toBe(false);
		expect(isExplicitEmptyGhResult(1, "API rate limit exceeded")).toBe(false);
		// A bare/unknown failure must never be mistaken for an explicit empty.
		expect(isExplicitEmptyGhResult(1, "")).toBe(false);
		expect(isExplicitEmptyGhResult(128, "fatal: something else")).toBe(false);
	});

	test("classifies only a 422 unknown-commit answer as an absent commit", () => {
		// v0.15.1 failed here: three shipped commits carried `(cherry picked from
		// commit …)` trailers naming OIDs GitHub had garbage collected, and the
		// strict commit lookup turned that answer into a release failure.
		expect(isUnknownCommitGhResult(1, "gh: No commit found for SHA: 741dce2324ef7d47fce4707e5a69a435ea13fc03 (HTTP 422)")).toBe(true);
		// Success is not an "unknown commit" answer; every other failure fails closed.
		expect(isUnknownCommitGhResult(0, "")).toBe(false);
		expect(isUnknownCommitGhResult(1, "HTTP 403: Resource not accessible by integration")).toBe(false);
		expect(isUnknownCommitGhResult(1, "HTTP 500: Internal Server Error")).toBe(false);
		expect(isUnknownCommitGhResult(1, "API rate limit exceeded")).toBe(false);
		expect(isUnknownCommitGhResult(1, "")).toBe(false);
	});
});

describe("first merged pull request selection", () => {
	test("selects by merge time, not creation time", () => {
		// #10 was created first but merged last; #12 was created later but merged first.
		expect(earliestMergedPullRequest([
			{ number: 10, mergedAt: "2026-02-01T00:00:00Z" },
			{ number: 12, mergedAt: "2026-01-15T00:00:00Z" },
			{ number: 11, mergedAt: "2026-01-20T00:00:00Z" },
		])).toBe(12);
		expect(earliestMergedPullRequest([])).toBeUndefined();
	});

	test("breaks merge-time ties by the lower pull request number", () => {
		expect(earliestMergedPullRequest([
			{ number: 9, mergedAt: "2026-01-15T00:00:00Z" },
			{ number: 7, mergedAt: "2026-01-15T00:00:00Z" },
		])).toBe(7);
	});

	test("considers an earliest merge beyond the first fifty results", () => {
		const laterCreated = Array.from({ length: 50 }, (_, index) => ({
			number: index + 1,
			mergedAt: `2026-02-${String(index + 1).padStart(2, "0")}T00:00:00Z`,
		}));
		expect(earliestMergedPullRequest([
			...laterCreated,
			{ number: 999, mergedAt: "2026-01-01T00:00:00Z" },
		])).toBe(999);
	});
});

describe("search quota pacing", () => {
	test("classifies only rate-limit refusals as waitable", () => {
		expect(
			isRateLimitedGhResult(
				1,
				"gh: API rate limit exceeded for installation. If you reach out to GitHub Support ... (HTTP 403)",
			),
		).toBe(true);
		expect(isRateLimitedGhResult(1, "You have exceeded a secondary rate limit")).toBe(true);
		// A success is never a rate limit, and every other refusal still fails closed:
		// notes derived from a partially reachable GitHub drop attribution silently.
		expect(isRateLimitedGhResult(0, "")).toBe(false);
		expect(isRateLimitedGhResult(1, "HTTP 403: Resource not accessible by integration")).toBe(false);
		expect(isRateLimitedGhResult(1, "HTTP 500: Internal Server Error")).toBe(false);
		expect(isRateLimitedGhResult(1, "could not resolve to a PullRequest")).toBe(false);
	});

	test("waits past the reported reset, with a floor and a ceiling", () => {
		const now = 1_787_400_000_000;
		expect(rateLimitWaitMs(now / 1000 + 30, now)).toBe(32_000);
		// Already-elapsed and missing stamps still wait a usable minimum.
		expect(rateLimitWaitMs(now / 1000 - 600, now)).toBe(5_000);
		expect(rateLimitWaitMs(undefined, now)).toBe(15_000);
		// A far-future stamp cannot park the release indefinitely.
		expect(rateLimitWaitMs(now / 1000 + 86_400, now)).toBe(90_000);
		expect(rateLimitWaitMs(Number.NaN, now)).toBe(15_000);
	});
});

describe("transient gh failures", () => {
	test("retries only dropped responses, never refusals or explicit answers", () => {
		expect(
			isTransientGhResult(
				1,
				"gh api --paginate repos/Yeachan-Heo/gajae-code/commits/2ce24e0d/pulls?per_page=100 --jq ... failed (exit 1): unexpected end of JSON input",
			),
		).toBe(true);
		expect(isTransientGhResult(1, "HTTP 502: Bad Gateway")).toBe(true);
		expect(isTransientGhResult(1, "HTTP 500: Internal Server Error")).toBe(true);
		expect(isTransientGhResult(1, "read tcp 10.0.0.1:443: connection reset by peer")).toBe(true);
		// A success, a permission refusal, an unknown OID, and "no PR" are answers, not drops.
		expect(isTransientGhResult(0, "unexpected end of JSON input")).toBe(false);
		expect(isTransientGhResult(1, "HTTP 403: Resource not accessible by integration")).toBe(false);
		expect(isTransientGhResult(1, "HTTP 501: Not Implemented")).toBe(false);
		expect(isTransientGhResult(1, "HTTP 422: No commit found for SHA: abc")).toBe(false);
		expect(isTransientGhResult(1, "could not resolve to a PullRequest")).toBe(false);
	});

	test("keeps successful exits non-transient for seeded arbitrary stderr", () => {
		const random = createSeededRandom(0x6821_cafe);

		for (let sample = 0; sample < 256; sample++) {
			expect(isTransientGhResult(0, generatedStderr(random))).toBe(false);
		}
		for (const error of SUPPORTED_TRANSIENT_GH_ERRORS) {
			const stderr = `${generatedStderr(random)} ${error} ${generatedStderr(random)}`;
			expect(isTransientGhResult(0, stderr)).toBe(false);
		}
	});

	test("keeps generated supported transport errors transient for nonzero exits", () => {
		const random = createSeededRandom(0x6821_cafe);

		for (const error of SUPPORTED_TRANSIENT_GH_ERRORS) {
			for (let sample = 0; sample < 16; sample++) {
				const exitCode = 1 + Math.floor(random() * 255);
				const stderr = `${generatedStderr(random)} ${error} ${generatedStderr(random)}`;
				expect(isTransientGhResult(exitCode, stderr)).toBe(true);
			}
		}
	});

	test("keeps generated explicit refusals non-transient for nonzero exits", () => {
		const random = createSeededRandom(0x6821_cafe);
		const refusalCodes = [400, 401, 403, 404, 409, 422, 429, 501];
		const refusalDetails = [
			"Bad credentials",
			"Resource not accessible by integration",
			"Not Found",
			"Validation Failed",
			"API rate limit exceeded",
			"No commit found for SHA: abcdef0123456789",
			"Not Implemented",
		];

		for (const status of refusalCodes) {
			for (let sample = 0; sample < 16; sample++) {
				const exitCode = 1 + Math.floor(random() * 255);
				const detail = refusalDetails[Math.floor(random() * refusalDetails.length)]!;
				const context = generatedRefusalContext(random);
				expect(isTransientGhResult(exitCode, `${context}: HTTP ${status}: ${detail}`)).toBe(false);
			}
		}

		for (let sample = 0; sample < 16; sample++) {
			const exitCode = 1 + Math.floor(random() * 255);
			const context = generatedRefusalContext(random);
			expect(isTransientGhResult(exitCode, `${context}: could not resolve to a PullRequest`)).toBe(false);
		}
	});
});
