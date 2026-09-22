import { describe, expect, test, vi } from "bun:test";
import { Glob } from "bun";
import { parse } from "yaml";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";
import {
	authenticatedApproval,
	canonicalDiffSha256,
	fetchIndependentReviewerEvidence,
	gateExitCode,
	parseBodyRisk,
	parseGhPrCreate,
	parsePrVerdict,
	parseSelfReview,
	resolvePullRequestEvent,
	selfReviewSatisfiesPolicy,
	selfReviewSignature,
	selfReviewSignedPayload,
	validatePrContract,
} from "./verify-pr-verdict";
import type { IndependentReviewerEvidence } from "./verify-pr-verdict";

const base = "a".repeat(40);
const head = "b".repeat(40);
const digest = "c".repeat(64);
const approved = `gajae.pr-review-verdict.v1 merge-approved sha256:${digest} reviewer:architect reviewer-id:review-agent evidence:bun test scripts/verify-pr-verdict.test.ts`;

describe("authenticated approval API evidence", () => {
	const event = { repository: { full_name: "owner/repo" }, pull_request: { number: 5416 } };
	// Reviews are submitted after the head commit; a submission that predates the head is a
	// force-push re-bind and is covered by its own case below (#5692).
	const headCommittedAt = "2026-09-18T06:00:00Z";
	const review = (state: string, commit = head, submitted = "2026-09-18T07:00:00Z") => ({
		state,
		commit_id: commit,
		user: { login: "review-agent" },
		submitted_at: submitted,
	});

	test.each([
		{ name: "valid exact-head approval", reviews: [review("APPROVED")], permission: "write", approved: true },
		{ name: "changes requested after approval", reviews: [review("APPROVED"), review("CHANGES_REQUESTED")], permission: "write", approved: false },
		{ name: "dismissed approval", reviews: [review("APPROVED"), review("DISMISSED")], permission: "write", approved: false },
		{ name: "revoked collaborator permission", reviews: [review("APPROVED")], permission: "read", approved: false },
		{ name: "stale-head approval", reviews: [review("APPROVED", "d".repeat(40))], permission: "write", approved: false },
		// #5692: reports this exact head, but submitted before the head commit existed.
		{ name: "approval re-bound by a force-push", reviews: [review("APPROVED", head, "2026-09-18T02:00:00Z")], permission: "write", approved: false },
	])("$name", async scenario => {
		const requests: string[] = [];
		const originalFetch = globalThis.fetch;
		const replacement: typeof fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
			const endpoint = String(input);
			requests.push(endpoint);
			expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer test-token");
			if (endpoint === "https://api.github.com/repos/owner/repo/pulls/5416/reviews?per_page=100&page=1") return Response.json(scenario.reviews);
			if (endpoint === `https://api.github.com/repos/owner/repo/commits/${head}`)
				return Response.json({ commit: { committer: { date: headCommittedAt } } });
			if (endpoint.startsWith("https://api.github.com/repos/owner/repo/issues/5416/timeline"))
				return Response.json([{ event: "head_ref_force_pushed", created_at: headCommittedAt }]);
			if (endpoint === "https://api.github.com/repos/owner/repo/collaborators/review-agent/permission") return Response.json({ permission: scenario.permission });
			throw new Error(`Unexpected endpoint: ${endpoint}`);
		}, { preconnect: originalFetch.preconnect });
		const spy = vi.spyOn(globalThis, "fetch").mockImplementation(replacement);
		try {
			const approval = await authenticatedApproval(event, "review-agent", head, "test-token");
			expect(approval).toEqual(scenario.approved ? { login: "review-agent", headSha: head } : {});
			expect(validatePrContract(validInput({ authenticatedReviewerLogin: approval.login, authenticatedReviewHeadSha: approval.headSha })).ok).toBe(scenario.approved);
			// Reviews, then the PR timeline whose force-push events are the only
			// server-observed freshness authority. The commit is no longer fetched at all,
			// because its committer date is contributor-controlled in both directions and
			// therefore cannot be a floor. The permission call follows a surviving approval.
			const expectsPermission = scenario.name === "valid exact-head approval" || scenario.name === "revoked collaborator permission";
			expect(requests.length).toBe(expectsPermission ? 3 : 2);
		} finally {
			spy.mockRestore();
		}
	});

	test("unavailable and malformed review responses never provide authenticated approval", async () => {
		for (const failure of ["network", "http", "invalid-json", "object", "null", "malformed-entry"]) {
			const originalFetch = globalThis.fetch;
			const replacement: typeof fetch = Object.assign(async () => {
				if (failure === "network") throw new Error("Reviews network unavailable");
				if (failure === "http") return new Response("unavailable", { status: 503 });
				if (failure === "invalid-json") return new Response("{broken");
				return Response.json(failure === "object" ? {} : failure === "null" ? null : [null]);
			}, { preconnect: originalFetch.preconnect });
			const spy = vi.spyOn(globalThis, "fetch").mockImplementation(replacement);
			try {
				if (failure === "http") expect(await authenticatedApproval(event, "review-agent", head, "test-token")).toEqual({});
				else await expect(authenticatedApproval(event, "review-agent", head, "test-token")).rejects.toThrow();
				expect(spy).toHaveBeenCalledTimes(1);
			} finally {
				spy.mockRestore();
			}
		}
	});
});

function selfReviewComment(overrides: {
	body?: string;
	login?: string;
	association?: string;
	verdict?: "merge-approved" | "merge-self-approved" | "merge-blocked";
	risk?: "low-risk" | "regression-risk" | "high-risk";
	extra?: string;
} = {}) {
	const verdict = overrides.verdict ?? "merge-self-approved";
	const risk = overrides.risk ?? "low-risk";
	const extraToken = overrides.extra ?? "none";
	const parsedExtra = extraToken === "none" ? { kind: "none" as const } : { kind: "independent" as const, login: extraToken.slice("independent:".length) };
	const record = `gajae.pr-self-review.v1 verdict:${verdict} base:${base} head:${head} sha256:${digest} reviewer-id:author risk:${risk} extra:${extraToken} evidence:adversarial exact-head review of the final tree`;
	const payload = selfReviewSignedPayload({
		verdict,
		baseSha: base,
		headSha: head,
		diffSha256: digest,
		reviewerId: "author",
		risk,
		extra: parsedExtra,
		evidence: "adversarial exact-head review of the final tree",
	});
	const signature = selfReviewSignature(payload);
	return {
		login: overrides.login ?? "author",
		authorAssociation: overrides.association ?? "OWNER",
		body: overrides.body ?? `${record}\nself-review-signature: sha256:${signature}\nSigned-off-by: gaebal-gajae (clawdbot) 🦞`,
	};
}

function validInput(overrides: Partial<Parameters<typeof validatePrContract>[0]> = {}) {
	return {
		body: `## GJC verdict\n\n${approved}\n`,
		baseRef: "dev",
		baseSha: base,
		headSha: head,
		authorLogin: "author",
		computedDiffSha256: digest,
		baseIsAncestor: true,
		fastGatePassed: true,
		requireMergeApproved: true,
		authenticatedReviewerLogin: "review-agent",
		authenticatedReviewHeadSha: head,
		...overrides,
	};
}

describe("review-event mutable PR body refresh", () => {
	function captured() {
		return {
			repository: { full_name: "owner/repo" },
			pull_request: {
				number: 5416,
				body: approved.replace("merge-approved", "needs-human"),
				user: { login: "author" },
				base: { ref: "dev", sha: base, repo: { full_name: "owner/repo" } },
				head: { sha: head },
			},
		};
	}

	test("refreshes only body on the same authority using an authenticated request", async () => {
		const event = captured();
		const live = { ...event.pull_request, body: approved };
		const resolved = await resolvePullRequestEvent(event, "pull_request_review", "test-token", async (endpoint, init) => {
			expect(endpoint).toBe("https://api.github.com/repos/owner/repo/pulls/5416");
			expect(new Headers(init.headers).get("Authorization")).toBe("Bearer test-token");
			return Response.json(live);
		});
		expect(resolved).toEqual({ ...event, pull_request: live });
		expect(resolved.pull_request?.base).toBe(event.pull_request.base);
		expect(resolved.pull_request?.head).toBe(event.pull_request.head);
		expect(event.pull_request.body).toContain("needs-human");
		expect(validatePrContract(validInput({ body: resolved.pull_request?.body ?? "" })).ok).toBe(true);
		// Refreshing text provides no new approval, risk or fast-gate authority.
		for (const denied of [
			{ authenticatedReviewerLogin: undefined },
			{ authenticatedReviewHeadSha: "d".repeat(40) },
			{ fastGatePassed: false },
		]) {
			expect(validatePrContract(validInput({ body: resolved.pull_request?.body ?? "", ...denied })).ok).toBe(false);
		}
	});

	test.each(["merge-blocked", "needs-human", "", null])("current revoked or empty body cannot reuse captured approval: %s", async verdict => {
		const event = captured();
		event.pull_request.body = approved;
		const body = verdict ? approved.replace("merge-approved", verdict) : verdict;
		const resolved = await resolvePullRequestEvent(event, "pull_request_review", "token", async () => Response.json({ ...event.pull_request, body }));
		expect(resolved.pull_request?.body).toBe(body);
		// A revoked or empty body can never merge. A blocking verdict is now a withheld
		// authorization rather than a contract defect, so the invariant is stated on
		// mergeAuthorized, which covers both halves.
		expect(validatePrContract(validInput({ body: resolved.pull_request?.body ?? "" })).mergeAuthorized).toBe(false);
	});

	test("rejects every live authority drift rather than replacing the captured target", async () => {
		const event = captured();
		const live = { ...event.pull_request, body: approved };
		for (const changed of [
			{ ...live, number: 5417 },
			{ ...live, user: { login: "other" } },
			{ ...live, head: { sha: "d".repeat(40) } },
			{ ...live, base: { ...live.base, sha: "e".repeat(40) } },
			{ ...live, base: { ...live.base, ref: "main" } },
			{ ...live, base: { ...live.base, repo: { full_name: "other/repo" } } },
		]) {
			await expect(resolvePullRequestEvent(event, "pull_request_review", "token", async () => Response.json(changed))).rejects.toThrow("authority drift");
		}
	});

	test("unavailable or malformed metadata never falls back to captured body", async () => {
		const event = captured();
		for (const response of [
			new Response("denied", { status: 403 }),
			new Response("{broken"),
			Response.json(null), Response.json([]), Response.json({}),
			Response.json({ ...event.pull_request, body: 42 }),
			Response.json({ ...event.pull_request, body: undefined }),
		]) {
			await expect(resolvePullRequestEvent(event, "pull_request_review", "token", async () => response)).rejects.toThrow();
		}
		await expect(resolvePullRequestEvent(event, "pull_request_review", "token", async () => { throw new Error("network unavailable"); })).rejects.toThrow("network unavailable");
		let requests = 0;
		const request = async () => { requests++; return Response.json(event.pull_request); };
		await expect(resolvePullRequestEvent(event, "pull_request_review", "", request)).rejects.toThrow("authority is incomplete");
		await expect(resolvePullRequestEvent({ repository: event.repository }, "pull_request_review", "token", request)).rejects.toThrow("authority is incomplete");
		expect(requests).toBe(0);
	});

	test("ordinary PR events retain their captured body without API calls", async () => {
		const event = captured();
		for (const name of ["pull_request", "pull_request_target"]) {
			const resolved = await resolvePullRequestEvent(event, name, "token", async () => { throw new Error("must not fetch"); });
			expect(resolved).toBe(event);
		}
	});

	test("issue-comment resolution retains its authenticated fetch and failure semantics", async () => {
		const event = { repository: captured().repository, issue: { number: 5416 } };
		const live = { ...captured().pull_request, body: approved };
		const resolved = await resolvePullRequestEvent(event, "issue_comment", "token", async (endpoint, init) => {
			expect(endpoint).toBe("https://api.github.com/repos/owner/repo/pulls/5416");
			expect(new Headers(init.headers).get("Authorization")).toBe("Bearer token");
			return Response.json(live);
		});
		expect(resolved.pull_request).toEqual(live);
		expect(await resolvePullRequestEvent(event, "issue_comment", "token", async () => new Response("denied", { status: 403 }))).toBe(event);
	});
});

describe("parsePrVerdict", () => {
	test("accepts exactly one strict verdict line", () => {
		expect(parsePrVerdict(approved)).toEqual({
			verdict: {
				verdict: "merge-approved",
				diffSha256: digest,
				reviewerRole: "architect",
				reviewerId: "review-agent",
				evidence: "bun test scripts/verify-pr-verdict.test.ts",
			},
			diagnostics: [],
		});
	});

	test("fails closed for missing, duplicate, and malformed verdicts", () => {
		expect(parsePrVerdict("no verdict").diagnostics[0]).toContain("exactly one");
		expect(parsePrVerdict(`${approved}\n${approved}`).diagnostics[0]).toContain("contains 2");
		expect(parsePrVerdict(approved.replace("sha256:", "hash:")).diagnostics[0]).toContain("Malformed");
		expect(parsePrVerdict(approved.replace(" reviewer-id:review-agent", "")).diagnostics[0]).toContain("Malformed");
	});
});

describe("validatePrContract", () => {
	test("accepts exact-head independently approved contract", () => {
		expect(validatePrContract(validInput())).toMatchObject({ ok: true, diagnostics: [] });
	});

	test("reports base, ancestry, digest, fast-gate, and self-review failures together", () => {
		const result = validatePrContract(validInput({
			baseRef: "main",
			baseIsAncestor: false,
			computedDiffSha256: "d".repeat(64),
			fastGatePassed: false,
			authorLogin: "review-agent",
		}));
		expect(result.ok).toBe(false);
		expect(result.diagnostics).toHaveLength(5);
		expect(result.diagnostics.join("\n")).toContain("base must be dev");
		expect(result.diagnostics.join("\n")).toContain("does not contain immutable event base");
		expect(result.diagnostics.join("\n")).toContain("is stale");
		expect(result.diagnostics.join("\n")).toContain("fast gate failed");
		expect(result.diagnostics.join("\n")).toContain("cannot be self-approved");
	});

	test("local preflight permits blocking verdicts but server merge gate rejects them", () => {
		const body = approved.replace("merge-approved", "needs-human");
		expect(validatePrContract(validInput({ body, requireMergeApproved: false })).ok).toBe(true);
		// The server still rejects it; the rejection is reported as a withheld merge
		// authorization instead of a contract defect.
		const server = validatePrContract(validInput({ body, requireMergeApproved: true }));
		expect(server.mergeAuthorized).toBe(false);
		expect(server.authorizationDiagnostics[0]).toContain("intentionally blocks merge");
	});

	test("server merge approval requires an authenticated exact-head GitHub review", () => {
		expect(validatePrContract(validInput({ authenticatedReviewerLogin: undefined })).diagnostics.join("\n")).toContain("not backed by an authenticated");
		expect(validatePrContract(validInput({ authenticatedReviewHeadSha: "d".repeat(40) })).diagnostics.join("\n")).toContain("must target exact PR head");
	});

	test("rejects invalid event hashes", () => {
		const result = validatePrContract(validInput({ baseSha: "HEAD", headSha: "head", computedDiffSha256: "sha" }));
		expect(result.diagnostics.join("\n")).toContain("40-hex");
		expect(result.diagnostics.join("\n")).toContain("lowercase SHA-256");
	});
});

/**
 * The merge-approval gate is reported on its own channel so one red check stops meaning both
 * "your PR is malformed" and "your PR is waiting for a reviewer". The authorization predicate
 * itself is unchanged: only which result field carries it moved.
 */
describe("merge authorization reported separately from contract validity", () => {
	const blocked = approved.replace("merge-approved", "needs-human");

	test("needs-human is a valid contract with the merge authorization withheld", () => {
		const result = validatePrContract(validInput({ body: `## GJC verdict\n\n${blocked}\n` }));
		expect(result.ok).toBe(true);
		expect(result.diagnostics).toEqual([]);
		expect(result.mergeAuthorized).toBe(false);
		expect(result.authorizationDiagnostics).toHaveLength(1);
		expect(result.authorizationDiagnostics[0]).toContain("Verdict needs-human intentionally blocks merge.");
	});

	test("an authenticated exact-head merge-approved authorizes the merge", () => {
		const result = validatePrContract(validInput());
		expect(result.ok).toBe(true);
		expect(result.mergeAuthorized).toBe(true);
		expect(result.authorizationDiagnostics).toEqual([]);
	});

	// Forgery and false claims are NOT "waiting for a human": each stays a contract defect
	// on the contract check, and each still withholds the merge authorization.
	test.each([
		["merge-approved claimed with reviewer-id == author", { body: `## GJC verdict\n\n${approved.replace("reviewer-id:review-agent", "reviewer-id:author")}\n`, authenticatedReviewerLogin: "author" }, "cannot be self-approved"],
		["merge-approved without an authenticated review", { authenticatedReviewerLogin: undefined }, "not backed by an authenticated"],
		["merge-approved approved on another head", { authenticatedReviewHeadSha: "d".repeat(40) }, "must target exact PR head"],
		["stale verdict digest", { computedDiffSha256: "d".repeat(64) }, "is stale"],
		["base not an ancestor of head", { baseIsAncestor: false }, "does not contain immutable event base"],
		["failed repository fast gate", { fastGatePassed: false }, "Repository fast gate failed"],
	])("%s stays a contract failure", (_name, overrides, message) => {
		const result = validatePrContract(validInput(overrides));
		expect(result.ok).toBe(false);
		expect(result.diagnostics.join("\n")).toContain(message);
		expect(result.authorizationDiagnostics).toEqual([]);
		// Invariant: a malformed contract can never report an authorized merge.
		expect(result.mergeAuthorized).toBe(false);
	});

	test("an invalid contract never authorizes a merge, whatever the verdict says", () => {
		for (const body of [`## GJC verdict\n\n${approved}\n`, `## GJC verdict\n\n${blocked}\n`, "no verdict at all"]) {
			for (const overrides of [{}, { fastGatePassed: false }, { baseIsAncestor: false }, { computedDiffSha256: "d".repeat(64) }]) {
				const result = validatePrContract(validInput({ body, ...overrides }));
				if (!result.ok) expect(result.mergeAuthorized).toBe(false);
			}
		}
	});

	// Back-compat: every existing caller (--push-preflight, --preflight-command, the local
	// pre-push hook) passes no --gate and must keep the single combined exit code.
	test.each([
		["all", { ok: true, mergeAuthorized: false }, 1],
		["all", { ok: true, mergeAuthorized: true }, 0],
		["all", { ok: false, mergeAuthorized: false }, 1],
		["contract", { ok: true, mergeAuthorized: false }, 0],
		["contract", { ok: false, mergeAuthorized: false }, 1],
		["approval", { ok: true, mergeAuthorized: false }, 1],
		["approval", { ok: true, mergeAuthorized: true }, 0],
		["approval", { ok: false, mergeAuthorized: false }, 1],
	] as const)("--gate %s exits %p for %p", (gate, result, code) => {
		expect(gateExitCode(gate, result)).toBe(code);
	});

	test("the default gate still fails a needs-human PR exactly as before the split", () => {
		const result = validatePrContract(validInput({ body: `## GJC verdict\n\n${blocked}\n` }));
		expect(gateExitCode("all", result)).toBe(1);
		expect(gateExitCode("contract", result)).toBe(0);
		expect(gateExitCode("approval", result)).toBe(1);
	});
});

describe("parseGhPrCreate", () => {
	test("extracts body and base flags without executing the command", () => {
		expect(parseGhPrCreate("gh pr create --base dev --body-file /tmp/pr.md --title x")).toEqual({ base: "dev", bodyFile: "/tmp/pr.md" });
		expect(parseGhPrCreate("env X=1 gh pr create -B dev -b 'body text'")).toEqual({ base: "dev", body: "body text" });
	});

	test("ignores unrelated commands and fails closed for compound gh commands", () => {
		expect(parseGhPrCreate("git status")).toBeNull();
		expect(parseGhPrCreate("git status && gh pr create --body x")).toEqual({});
	});
});

describe("maintainer self-authorization and risk record gate (issue #4703)", () => {
	// The reviewed path: merge-approved naming the author is ALWAYS rejected.
	const selfApproved = approved.replace("reviewer-id:review-agent", "reviewer-id:author");
	const selfApprovedBody = `## GJC verdict\n\n${selfApproved}\n`;
	// The honest solo path: the verdict name itself records that no independent
	// human reviewed the change.
	const soloVerdict = `gajae.pr-review-verdict.v1 merge-self-approved sha256:${digest} reviewer:human reviewer-id:author evidence:low-risk owner change; risk record bound to exact head`;
	const soloBody = `## GJC verdict\n\n${soloVerdict}\n`;

	test("merge-approved is NEVER reachable by the author, with or without a self-review record", () => {
		const withComment = validatePrContract(validInput({ body: selfApprovedBody, selfReviewComment: selfReviewComment() }));
		expect(withComment.ok).toBe(false);
		expect(withComment.diagnostics.join("\n")).toContain("cannot be self-approved");
		const withoutComment = validatePrContract(validInput({ body: selfApprovedBody, selfReviewComment: null }));
		expect(withoutComment.ok).toBe(false);
		expect(withoutComment.diagnostics.join("\n")).toContain("cannot be self-approved");
		expect(withoutComment.diagnostics.join("\n")).toContain("not backed by an authenticated");
	});

	test("merge-self-approved with a valid owner low-risk record authorizes the honest solo path", () => {
		const result = validatePrContract(validInput({
			body: soloBody,
			selfReviewComment: selfReviewComment({ verdict: "merge-self-approved", risk: "low-risk" }),
			bodyRisk: "low-risk",
		}));
		expect(result.ok).toBe(true);
		expect(result.diagnostics).toEqual([]);
	});

	test("merge-self-approved without any record fails closed", () => {
		const result = validatePrContract(validInput({ body: soloBody, selfReviewComment: null, bodyRisk: "low-risk" }));
		expect(result.ok).toBe(false);
		expect(result.diagnostics.join("\n")).toContain("requires a valid gajae.pr-self-review.v1 risk record");
	});

	test("merge-self-approved with a regression-risk or high-risk record fails: higher tiers need independent review", () => {
		for (const risk of ["regression-risk", "high-risk"] as const) {
			const result = validatePrContract(validInput({
				body: soloBody,
				selfReviewComment: selfReviewComment({ verdict: "merge-self-approved", risk, extra: "independent:domain-expert" }),
				bodyRisk: risk,
				independentReviewer: { permission: "write", approvedHead: true, approvedLogin: "domain-expert" },
			}));
			expect(result.ok).toBe(false);
			expect(result.diagnostics.join("\n")).toContain("Higher risk classes must use independent review");
		}
	});

	test("merge-self-approved record must itself say merge-self-approved", () => {
		const result = validatePrContract(validInput({
			body: soloBody,
			selfReviewComment: selfReviewComment({ verdict: "merge-approved", risk: "low-risk" }),
			bodyRisk: "low-risk",
		}));
		expect(result.ok).toBe(false);
		expect(result.diagnostics.join("\n")).toContain("classify this change low-risk with verdict:merge-self-approved");
	});

	test("merge-self-approved naming a non-author reviewer fails", () => {
		const result = validatePrContract(validInput({ body: `## GJC verdict\n\n${approved.replace("merge-approved", "merge-self-approved")}\n`, bodyRisk: "low-risk" }));
		expect(result.ok).toBe(false);
		expect(result.diagnostics.join("\n")).toContain("must name the PR author");
	});

	test("stale head, base, and digest in the record each fail closed", () => {
		const staleHead = selfReviewComment().body.replace(`head:${head}`, `head:${"d".repeat(40)}`);
		const staleBase = selfReviewComment().body.replace(`base:${base}`, `base:${"e".repeat(40)}`);
		const staleDigest = selfReviewComment().body.replace(`sha256:${digest}`, `sha256:${"f".repeat(64)}`);
		for (const body of [staleHead, staleBase, staleDigest]) {
			const result = validatePrContract(validInput({ body: soloBody, selfReviewComment: selfReviewComment({ body }), bodyRisk: "low-risk" }));
			expect(result.ok).toBe(false);
		}
		const headDiagnostics = validatePrContract(validInput({ body: soloBody, selfReviewComment: selfReviewComment({ body: staleHead }), bodyRisk: "low-risk" })).diagnostics.join("\n");
		expect(headDiagnostics).toContain("stale");
		expect(headDiagnostics).toContain("integrity digest does not match");
	});

	test("malformed record fails closed with a parse diagnostic", () => {
		const malformed = selfReviewComment().body.replace("verdict:merge-self-approved", "verdict:approved");
		const result = validatePrContract(validInput({ body: soloBody, selfReviewComment: selfReviewComment({ body: malformed }), bodyRisk: "low-risk" }));
		expect(result.ok).toBe(false);
		expect(result.diagnostics.join("\n")).toContain("Malformed gajae.pr-self-review.v1");
	});

	test("unsigned record fails closed", () => {
		const unsigned = selfReviewComment().body.replace(/\nself-review-signature: sha256:[0-9a-f]{64}\n/u, "\nbogus-signature\n");
		const result = validatePrContract(validInput({ body: soloBody, selfReviewComment: selfReviewComment({ body: unsigned }), bodyRisk: "low-risk" }));
		expect(result.ok).toBe(false);
		expect(result.diagnostics.join("\n")).toContain("self-review-signature");
	});

	test("tampered evidence invalidates the integrity digest", () => {
		const tampered = selfReviewComment().body.replace("adversarial exact-head review", "lazy rubber stamp");
		const result = validatePrContract(validInput({ body: soloBody, selfReviewComment: selfReviewComment({ body: tampered }), bodyRisk: "low-risk" }));
		expect(result.ok).toBe(false);
		expect(result.diagnostics.join("\n")).toContain("integrity digest does not match");
	});

	test("unauthorized commenter identity fails closed", () => {
		const outsider = selfReviewComment({ login: "attacker", association: "NONE" });
		const result = validatePrContract(validInput({ body: soloBody, selfReviewComment: outsider, bodyRisk: "low-risk" }));
		expect(result.ok).toBe(false);
		expect(result.diagnostics.join("\n")).toContain("not the repository owner");
	});

	test("record from a non-owner maintainer (MEMBER/COLLABORATOR) fails closed: only the owner may self-authorize", () => {
		const record = `gajae.pr-self-review.v1 verdict:merge-self-approved base:${base} head:${head} sha256:${digest} reviewer-id:collab risk:low-risk extra:none evidence:collaborator attempt`;
		const payload = selfReviewSignedPayload({ verdict: "merge-self-approved", baseSha: base, headSha: head, diffSha256: digest, reviewerId: "collab", risk: "low-risk", extra: { kind: "none" }, evidence: "collaborator attempt" });
		const body = `${record}\nself-review-signature: sha256:${selfReviewSignature(payload)}\nSigned-off-by: gaebal-gajae (clawdbot) 🦞`;
		const collabSolo = soloVerdict.replace("reviewer-id:author", "reviewer-id:collab");
		const result = validatePrContract(validInput({
			body: `## GJC verdict\n\n${collabSolo}\n`,
			authorLogin: "collab",
			selfReviewComment: { login: "collab", authorAssociation: "COLLABORATOR", body },
			bodyRisk: "low-risk",
		}));
		expect(result.ok).toBe(false);
		expect(result.diagnostics.join("\n")).toContain("not the repository owner");
	});

	test("record reviewer-id must match the PR author", () => {
		const record = `gajae.pr-self-review.v1 verdict:merge-self-approved base:${base} head:${head} sha256:${digest} reviewer-id:review-agent risk:low-risk extra:none evidence:wrong identity`;
		const payload = selfReviewSignedPayload({ verdict: "merge-self-approved", baseSha: base, headSha: head, diffSha256: digest, reviewerId: "review-agent", risk: "low-risk", extra: { kind: "none" }, evidence: "wrong identity" });
		const body = `${record}\nself-review-signature: sha256:${selfReviewSignature(payload)}\nSigned-off-by: gaebal-gajae (clawdbot) 🦞`;
		const result = validatePrContract(validInput({ body: soloBody, selfReviewComment: { login: "author", authorAssociation: "OWNER", body }, bodyRisk: "low-risk" }));
		expect(result.ok).toBe(false);
		expect(result.diagnostics.join("\n")).toContain("must match the PR author");
	});

	test("PR-body-embedded record is never accepted as the comment", () => {
		const recordBody = selfReviewComment().body;
		const forgedBody = `## GJC verdict\n\n${soloVerdict}\n\n${recordBody}\n`;
		const result = validatePrContract(validInput({ body: forgedBody, selfReviewComment: null, bodyRisk: "low-risk" }));
		expect(result.ok).toBe(false);
		expect(result.diagnostics.join("\n")).toContain("requires a valid gajae.pr-self-review.v1 risk record");
	});

	test("merge-blocked record verdict does not authorize anything", () => {
		const result = validatePrContract(validInput({
			body: soloBody,
			selfReviewComment: selfReviewComment({ verdict: "merge-blocked" }),
			bodyRisk: "low-risk",
		}));
		expect(result.ok).toBe(false);
		expect(result.diagnostics.join("\n")).toContain("does not authorize any merge");
	});

	test("exactly one risk classification is required: zero or multiple checked boxes fail closed", () => {
		const zero = parseBodyRisk("## Risk classification\n\n- [ ] `low-risk`\n- [ ] `regression-risk`\n- [ ] `high-risk`\n");
		expect(zero.risk).toBeNull();
		expect(zero.diagnostics.join("\n")).toContain("exactly one risk classification");
		expect(zero.diagnostics.join("\n")).toContain("found none");
		const multiple = parseBodyRisk("- [x] `low-risk`\n- [x] `high-risk`\n");
		expect(multiple.risk).toBeNull();
		expect(multiple.diagnostics.join("\n")).toContain("found 2");
		const exactlyOne = parseBodyRisk("- [ ] `low-risk`\n- [x] `regression-risk` — note\n");
		expect(exactlyOne).toEqual({ risk: "regression-risk", diagnostics: [] });
	});

	test("regression-risk record requires an authenticated independent exact-head review; the risk gate is independent of the solo path", () => {
		const approvedEvidence: IndependentReviewerEvidence = { permission: "write", approvedHead: true, approvedLogin: "domain-expert" };
		expect(validatePrContract(validInput({ body: selfApprovedBody, selfReviewComment: buildRiskComment("regression-risk", "none"), bodyRisk: "regression-risk" })).ok).toBe(false);
		expect(validatePrContract(validInput({ body: selfApprovedBody, selfReviewComment: buildRiskComment("regression-risk", "independent:domain-expert"), bodyRisk: "regression-risk" })).ok).toBe(false);
		const result = validatePrContract(validInput({ body: selfApprovedBody, selfReviewComment: buildRiskComment("regression-risk", "independent:domain-expert"), bodyRisk: "regression-risk", independentReviewer: approvedEvidence }));
		expect(result.ok).toBe(false);
		expect(result.diagnostics.join("\n")).toContain("cannot be self-approved");
		expect(result.diagnostics.join("\n")).not.toContain("risk-classified gate is not satisfied");
	});

	test("gpt-heavy extra token is no longer parseable: it was an unauthenticated author claim", () => {
		const record = `gajae.pr-self-review.v1 verdict:merge-self-approved base:${base} head:${head} sha256:${digest} reviewer-id:author risk:low-risk extra:gpt-heavy evidence:claim`;
		const parsed = parseSelfReview(`${record}\nself-review-signature: sha256:${"0".repeat(64)}\nSigned-off-by: gaebal-gajae (clawdbot) 🦞`);
		expect(parsed.selfReview).toBeUndefined();
		expect(parsed.diagnostics.join("\n")).toContain("Malformed");
	});

	test("independent reviewer evidence must match the login, target the exact head, and hold write+ permission", () => {
		const withIndependent = buildRiskComment("regression-risk", "independent:domain-expert");
		const mismatchedLogin: IndependentReviewerEvidence = { permission: "write", approvedHead: true, approvedLogin: "someone-else" };
		const staleApproval: IndependentReviewerEvidence = { permission: "write", approvedHead: false, approvedLogin: "domain-expert" };
		const readOnly: IndependentReviewerEvidence = { permission: "read", approvedHead: true, approvedLogin: "domain-expert" };
		expect(validatePrContract(validInput({ body: selfApprovedBody, selfReviewComment: withIndependent, bodyRisk: "regression-risk", independentReviewer: mismatchedLogin })).ok).toBe(false);
		expect(validatePrContract(validInput({ body: selfApprovedBody, selfReviewComment: withIndependent, bodyRisk: "regression-risk", independentReviewer: staleApproval })).ok).toBe(false);
		expect(validatePrContract(validInput({ body: selfApprovedBody, selfReviewComment: withIndependent, bodyRisk: "regression-risk", independentReviewer: readOnly })).ok).toBe(false);
	});

	test("extra:independent cannot name the PR author as the independent reviewer", () => {
		const comment = buildRiskComment("regression-risk", "independent:author");
		const result = validatePrContract(validInput({
			body: selfApprovedBody,
			selfReviewComment: comment,
			bodyRisk: "regression-risk",
			independentReviewer: { permission: "admin", approvedHead: true, approvedLogin: "author" },
		}));
		expect(result.ok).toBe(false);
		expect(result.diagnostics.join("\n")).toContain("names the PR author");
	});

	test("high-risk change requires an authenticated independent reviewer", () => {
		const approvedEvidence: IndependentReviewerEvidence = { permission: "write", approvedHead: true, approvedLogin: "domain-expert" };
		expect(validatePrContract(validInput({ body: selfApprovedBody, selfReviewComment: buildRiskComment("high-risk", "none"), bodyRisk: "high-risk" })).ok).toBe(false);
		expect(validatePrContract(validInput({ body: selfApprovedBody, selfReviewComment: buildRiskComment("high-risk", "independent:domain-expert"), bodyRisk: "high-risk" })).ok).toBe(false);
		const result = validatePrContract(validInput({ body: selfApprovedBody, selfReviewComment: buildRiskComment("high-risk", "independent:domain-expert"), bodyRisk: "high-risk", independentReviewer: approvedEvidence }));
		expect(result.ok).toBe(false);
		expect(result.diagnostics.join("\n")).toContain("cannot be self-approved");
		expect(result.diagnostics.join("\n")).not.toContain("risk-classified gate is not satisfied");
	});

	test("external contributor: a distinct external author cannot use the self-authorization path", () => {
		const externalAuthor = "external-contrib";
		const record = `gajae.pr-self-review.v1 verdict:merge-self-approved base:${base} head:${head} sha256:${digest} reviewer-id:${externalAuthor} risk:low-risk extra:none evidence:external contributor attempt`;
		const payload = selfReviewSignedPayload({ verdict: "merge-self-approved", baseSha: base, headSha: head, diffSha256: digest, reviewerId: externalAuthor, risk: "low-risk", extra: { kind: "none" }, evidence: "external contributor attempt" });
		const body = `${record}\nself-review-signature: sha256:${selfReviewSignature(payload)}\nSigned-off-by: gaebal-gajae (clawdbot) 🦞`;
		const externalSolo = `gajae.pr-review-verdict.v1 merge-self-approved sha256:${digest} reviewer:human reviewer-id:${externalAuthor} evidence:external attempt`;
		const externalBody = `## GJC verdict\n\n${externalSolo}\n`;
		for (const association of ["NONE", "CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR", "MEMBER", "COLLABORATOR"]) {
			const result = validatePrContract(validInput({
				body: externalBody,
				authorLogin: externalAuthor,
				selfReviewComment: { login: externalAuthor, authorAssociation: association, body },
				bodyRisk: "low-risk",
			}));
			expect(result.ok).toBe(false);
			expect(result.diagnostics.join("\n")).toContain("not the repository owner");
		}
		const externalApproved = approved.replace("reviewer-id:review-agent", `reviewer-id:${externalAuthor}`);
		const noRecord = validatePrContract(validInput({ body: `## GJC verdict\n\n${externalApproved}\n`, authorLogin: externalAuthor, selfReviewComment: null }));
		expect(noRecord.ok).toBe(false);
		expect(noRecord.diagnostics.join("\n")).toContain("not backed by an authenticated");
	});

	test("parseSelfReview rejects duplicate records and missing footer", () => {
		const record = selfReviewComment().body;
		expect(parseSelfReview(`${record}\n${record}`).diagnostics.join("\n")).toContain("keep exactly one");
		const noFooter = record.replace("\nSigned-off-by: gaebal-gajae (clawdbot) 🦞", "");
		expect(parseSelfReview(noFooter).diagnostics.join("\n")).toContain("Signed-off-by: gaebal-gajae (clawdbot) 🦞");
		const noSignature = record.replace(/\nself-review-signature: sha256:[0-9a-f]{64}/u, "");
		expect(parseSelfReview(noSignature).diagnostics.join("\n")).toContain("self-review-signature");
	});

	test("policy matrix is explicit for every risk class", () => {
		const approvedEvidence: IndependentReviewerEvidence = { permission: "write", approvedHead: true, approvedLogin: "x" };
		const rejected: IndependentReviewerEvidence = { permission: "read", approvedHead: false, approvedLogin: "x" };
		expect(selfReviewSatisfiesPolicy({ risk: "low-risk", extra: { kind: "none" } } as never)).toBe(true);
		expect(selfReviewSatisfiesPolicy({ risk: "regression-risk", extra: { kind: "none" } } as never)).toBe(false);
		expect(selfReviewSatisfiesPolicy({ risk: "regression-risk", extra: { kind: "independent", login: "x" } } as never)).toBe(false);
		expect(selfReviewSatisfiesPolicy({ risk: "regression-risk", extra: { kind: "independent", login: "x" } } as never, approvedEvidence)).toBe(true);
		expect(selfReviewSatisfiesPolicy({ risk: "regression-risk", extra: { kind: "independent", login: "x" } } as never, rejected)).toBe(false);
		expect(selfReviewSatisfiesPolicy({ risk: "high-risk", extra: { kind: "none" } } as never)).toBe(false);
		expect(selfReviewSatisfiesPolicy({ risk: "high-risk", extra: { kind: "independent", login: "x" } } as never)).toBe(false);
		expect(selfReviewSatisfiesPolicy({ risk: "high-risk", extra: { kind: "independent", login: "x" } } as never, approvedEvidence)).toBe(true);
	});

	test("record risk must match the PR body risk classification", () => {
		const mismatch = validatePrContract(validInput({
			body: soloBody,
			selfReviewComment: selfReviewComment({ verdict: "merge-self-approved", risk: "regression-risk", extra: "independent:domain-expert" }),
			bodyRisk: "low-risk",
		}));
		expect(mismatch.ok).toBe(false);
		expect(mismatch.diagnostics.join("\n")).toContain("does not match the PR body risk classification");
	});

	function buildRiskComment(risk: "low-risk" | "regression-risk" | "high-risk", extra: string) {
		const record = `gajae.pr-self-review.v1 verdict:merge-approved base:${base} head:${head} sha256:${digest} reviewer-id:author risk:${risk} extra:${extra} evidence:risk-classified exact-head review`;
		const parsedExtra = extra === "none"
			? { kind: "none" as const }
			: { kind: "independent" as const, login: extra.slice("independent:".length) };
		const payload = selfReviewSignedPayload({
			verdict: "merge-approved",
			baseSha: base,
			headSha: head,
			diffSha256: digest,
			reviewerId: "author",
			risk,
			extra: parsedExtra,
			evidence: "risk-classified exact-head review",
		});
		return { login: "author", authorAssociation: "OWNER", body: `${record}\nself-review-signature: sha256:${selfReviewSignature(payload)}\nSigned-off-by: gaebal-gajae (clawdbot) 🦞` };
	}
});

test("canonicalDiffSha256 hashes exact bytes", () => {
	expect(canonicalDiffSha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("server approval requires reviewer repository authority", async () => {
	const source = await Bun.file(new URL("./verify-pr-verdict.ts", import.meta.url)).text();
	expect(source).toContain("/collaborators/${encodeURIComponent(reviewerId)}/permission");
	expect(source).toContain('["admin", "maintain", "write"]');
});

test("hook keeps repository root separate from nested invocation cwd", async () => {
	const hook = await Bun.file(new URL("../docs/examples/gjc-hooks/pre/bash.ts", import.meta.url)).text();
	expect(hook).toContain('"--repo", repositoryRoot, "--invocation-cwd", invocationCwd');
});

test("preflight preserves missing body-file diagnostics", async () => {
	const temp = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-pr-missing-body-"));
	try {
		const script = url.fileURLToPath(new URL("./verify-pr-verdict.ts", import.meta.url));
		const child = Bun.spawn([process.execPath, script, "--preflight-command", "gh pr create --base dev --body-file missing.md", "--repo", temp, "--trusted-root", temp, "--invocation-cwd", temp], { stdout: "pipe", stderr: "pipe" });
		const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited]);
		expect(exitCode).toBe(1);
		expect(stderr).toContain(`Could not read PR body file ${path.join(temp, "missing.md")}`);
	} finally {
		await fs.rm(temp, { recursive: true, force: true });
	}
});

describe("push preflight", () => {
	async function preflight(options: { metadata?: string; apiExit?: number; remote?: string; destination?: string; pushUrls?: string; openPr?: boolean; pages?: "late" | "ambiguous" | "failure" }) {
		const temp = await fs.mkdtemp(path.join(Bun.env.TMPDIR ?? "/tmp", "push-authority-"));
		const callsPath = path.join(temp, "calls.jsonl");
		const executable = `#!${process.execPath}\n`;
		try {
			await fs.writeFile(callsPath, "");
			await fs.writeFile(path.join(temp, "gh"), executable + `
const args = process.argv.slice(2);
require("node:fs").appendFileSync(process.env.CALLS, JSON.stringify(["gh", ...args]) + "\\n");
if (process.env.GH_HOST !== "github.com") { console.error("wrong GH_HOST"); process.exit(96); }
if (args[0] === "repo") {
 console.log(process.env.METADATA);
 process.exit(Number(process.env.API_EXIT));
}
if (args[0] === "api" && args[1].includes("/pulls?")) {
 const pr = {number: 42, body: "", base: {ref: "release"}, user: {login: "author"}, head: {ref: "destination-branch", sha: "d".repeat(40), repo: {owner: {login: "receiver"}}}};
 const page = Number(new URL("https://github.com/" + args[1]).searchParams.get("page"));
 if (process.env.PAGES && page === 1) {
  console.log(JSON.stringify(Array.from({length: 100}, (_, i) => ({...pr, number: i + 100, head: {...pr.head, repo: {owner: {login: "other"}}}})))); process.exit(0);
 }
 if (process.env.PAGES === "failure") process.exit(95);
 console.log(JSON.stringify(process.env.PAGES === "ambiguous" ? [pr, {...pr, number: 43}] : process.env.OPEN_PR === "1" || process.env.PAGES === "late" ? [pr] : [])); process.exit(0);
}
process.exit(97);
`);
			await fs.writeFile(path.join(temp, "git"), executable + `
const args = process.argv.slice(2);
require("node:fs").appendFileSync(process.env.CALLS, JSON.stringify(["git", ...args]) + "\\n");
if (JSON.stringify(args) === JSON.stringify(["remote", "get-url", "--push", "--all", "origin"])) {
 console.log(process.env.PUSH_URLS); process.exit(0);
}
if (args[0] === "fetch" || args[0] === "merge-base") process.exit(0);
if (args[0] === "rev-parse") { console.log("a".repeat(40)); process.exit(0); }
if (args[0] === "diff") { console.error("mock exact diff stop"); process.exit(1); }
process.exit(98);
`);
			await Promise.all(["gh", "git"].map(name => fs.chmod(path.join(temp, name), 0o755)));
			const script = url.fileURLToPath(new URL("./verify-pr-verdict.ts", import.meta.url));
			const args = [process.execPath, script, "--push-preflight", "destination-branch", head, "--push-remote", options.remote ?? "origin", "--repo", temp, "--trusted-root", temp];
			if (options.destination !== undefined) args.push("--push-url", options.destination);
			const child = Bun.spawn(args, {
				env: { ...process.env, GH_HOST: "hostile.example", PATH: `${temp}:${process.env.PATH}`, CALLS: callsPath, METADATA: options.metadata ?? '{"isFork":false}', API_EXIT: String(options.apiExit ?? 0), PUSH_URLS: options.pushUrls ?? "git@github.com:receiver/project.git", OPEN_PR: options.openPr ? "1" : "0", PAGES: options.pages ?? "" },
				stdout: "pipe", stderr: "pipe",
			});
			const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
			const calls = (await fs.readFile(callsPath, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as string[]);
			return { stdout, stderr, exitCode, calls };
		} finally {
			await fs.rm(temp, { recursive: true, force: true });
		}
	}

	test("a named remote uses push URLs, never its fetch URL", async () => {
		const result = await preflight({});
		expect(result.exitCode).toBe(0);
		expect(result.calls[0]).toEqual(["git", "remote", "get-url", "--push", "--all", "origin"]);
		expect(result.calls[1]).toEqual(["gh", "repo", "view", "receiver/project", "--json", "isFork,parent"]);
	});

	test("REST discovery pins github.com and keeps the pushed object independent of remote head", async () => {
		const result = await preflight({ openPr: true });
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("mock exact diff stop");
		expect(result.calls).toContainEqual(["gh", "api", "repos/receiver/project/pulls?state=open&head=receiver%3Adestination-branch&per_page=100&page=1"]);
		expect(result.calls).toContainEqual(["git", "fetch", "--no-tags", "https://github.com/receiver/project.git", "release"]);
		expect(result.calls).toContainEqual(["git", "merge-base", "--is-ancestor", base, head]);
		expect(result.calls).toContainEqual(["git", "diff", "--binary", "--full-index", "--no-ext-diff", `${base}...${head}`]);
	});

	test("the hook destination overrides split pushurl configuration", async () => {
		const result = await preflight({ destination: "https://github.com/actual/destination.git", pushUrls: "https://github.com/wrong/one.git\nhttps://github.com/wrong/two.git" });
		expect(result.exitCode).toBe(0);
		expect(result.calls[0]).toEqual(["gh", "repo", "view", "actual/destination", "--json", "isFork,parent"]);
		expect(result.calls.some(call => call[0] === "git")).toBe(false);
		expect(result.calls[1]?.[2]).toContain("repos/actual/destination/pulls?");
	});

	for (const remote of ["git@github.com:receiver/project.git", "https://github.com/receiver/project", "ssh://git@github.com/receiver/project.git"]) {
		test(`URL remote resolves directly: ${remote}`, async () => {
			const result = await preflight({ remote });
			expect(result.exitCode).toBe(0);
			expect(result.calls[0]).toEqual(["gh", "repo", "view", "receiver/project", "--json", "isFork,parent"]);
		});
	}

	for (const options of [
		{ apiExit: 1 }, { metadata: "not-json" }, { metadata: "null" }, { metadata: "{}" },
		{ metadata: '{"isFork":"false"}' }, { metadata: '{"isFork":true}' },
		{ metadata: '{"isFork":true,"parent":null}' },
		{ metadata: '{"isFork":true,"parent":{"owner":{"login":"upstream"}}}' },
		{ metadata: '{"isFork":true,"parent":{"owner":{"login":"bad/owner"},"name":"project"}}' },
	]) {
		test(`unresolved repository authority fails closed: ${JSON.stringify(options)}`, async () => {
			const result = await preflight(options);
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("Could not establish the PR contract repository");
			expect(result.calls.some(call => call[1] === "api")).toBe(false);
		});
	}

	for (const [metadata, repository] of [
		['{"isFork":false}', "receiver/project"],
		['{"isFork":true,"parent":{"owner":{"login":"upstream"},"name":"project"}}', "upstream/project"],
	]) {
		test(`validated authority selects ${repository}`, async () => {
			const result = await preflight({ metadata });
			expect(result.exitCode).toBe(0);
			expect(result.calls.at(-1)).toEqual(["gh", "api", `repos/${repository}/pulls?state=open&head=receiver%3Adestination-branch&per_page=100&page=1`]);
		});
	}

	for (const options of [
		{ destination: "https://evil.example/receiver/project.git" }, { destination: "" },
		{ pushUrls: "https://github.com/one/project.git\nhttps://github.com/two/project.git" },
	]) {
		test(`unresolved destination cannot query a different repository: ${JSON.stringify(options)}`, async () => {
			const result = await preflight(options);
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("unknown repository");
			expect(result.calls.some(call => call[0] === "gh")).toBe(false);
		});
	}

	for (const pages of ["late", "ambiguous", "failure"] as const) {
		test(`PR discovery exhausts pagination: ${pages}`, async () => {
			const result = await preflight({ pages });
			expect(result.exitCode).toBe(1);
			expect(result.calls).toContainEqual(["gh", "api", "repos/receiver/project/pulls?state=open&head=receiver%3Adestination-branch&per_page=100&page=2"]);
			expect(result.stderr).toContain(pages === "late" ? "mock exact diff stop" : pages === "ambiguous" ? "cannot determine which contract" : "Could not resolve the open PR");
		});
	}

	async function exactTreePreflight(kind: "needs-human" | "merge-blocked" | "merge-approved" | "stale" | "malformed" | "missing-risk" | "multiple-risk" | "bad-pushed-tree" | "export-ignore" | "export-subst" | "source-symlink" | "source-backslash" | "case-collision") {
		const temp = await fs.mkdtemp(path.join(Bun.env.TMPDIR ?? "/tmp", "push-exact-tree-"));
		const repo = path.join(temp, "repo");
		const bin = path.join(temp, "bin");
		const scratch = path.join(temp, "scratch");
		const realGit = Bun.which("git")!;
		const runGit = (...args: string[]) => {
			const result = Bun.spawnSync([realGit, ...args], { cwd: repo, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
			if (result.exitCode !== 0) throw new Error(result.stderr.toString());
			return result.stdout;
		};
		try {
			await Promise.all([repo, bin, scratch].map(dir => fs.mkdir(dir)));
			runGit("init");
			runGit("config", "user.email", "fixture@example.test");
			runGit("config", "user.name", "Fixture");
			const source = path.join(repo, "packages/coding-agent/src/example.ts");
			await fs.mkdir(path.dirname(source), { recursive: true });
			const bad = 'import * as fs from "node:fs";\nfs.writeFileSync(".gjc/unsafe.json", "unsafe");\n';
			await fs.writeFile(source, "export const value = 1;\n");
			runGit("add", ".");
			runGit("-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "commit", "-m", "base");
			const baseSha = runGit("rev-parse", "HEAD").toString().trim();
			const badTree = kind === "bad-pushed-tree" || kind === "export-ignore" || kind === "export-subst" || kind === "source-backslash" || kind === "case-collision";
			const pushedSource = kind === "export-subst" ? bad.replace("unsafe.json", "$Format:%H$.json") : badTree && kind !== "case-collision" ? bad : "export const value = 2;\n";
			await fs.writeFile(source, pushedSource);
			if (kind === "export-ignore" || kind === "export-subst") await fs.writeFile(path.join(repo, ".gitattributes"), `packages/coding-agent/src/example.ts ${kind}\n`);
			if (kind === "source-symlink") await fs.symlink("example.ts", path.join(path.dirname(source), "linked.ts"));
			runGit("add", ".");
			if (kind === "source-backslash") {
				const unsafePath = path.join(temp, "unsafe-backslash-blob");
				await fs.writeFile(unsafePath, bad);
				const unsafeOid = runGit("hash-object", "-w", unsafePath).toString().trim();
				runGit("update-index", "--add", "--cacheinfo", `100644,${unsafeOid},packages/coding-agent/src/..\\escaped.ts`);
			}
			runGit("-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "commit", "-m", "pushed");
			let pushedSha = runGit("rev-parse", "HEAD").toString().trim();
			if (kind === "case-collision") {
				// Populate the index directly: both Git paths must exist even when the
				// host filesystem cannot represent their distinct casing simultaneously.
				const unsafePath = path.join(temp, "unsafe-blob");
				await fs.writeFile(unsafePath, bad);
				const unsafeOid = runGit("hash-object", "-w", unsafePath).toString().trim();
				const cleanPath = path.join(temp, "clean-blob");
				await fs.writeFile(cleanPath, "export const value = 2;\n");
				const cleanOid = runGit("hash-object", "-w", cleanPath).toString().trim();
				runGit("-c", "core.ignorecase=false", "update-index", "--add", "--cacheinfo", `100644,${unsafeOid},packages/coding-agent/src/Foo.ts`);
				runGit("-c", "core.ignorecase=false", "update-index", "--add", "--cacheinfo", `100644,${cleanOid},packages/coding-agent/src/foo.ts`);
				const treeOid = runGit("write-tree").toString().trim();
				pushedSha = runGit("-c", "commit.gpgsign=false", "commit-tree", treeOid, "-p", baseSha, "-m", "case-distinct pushed tree").toString().trim();
				const entries = runGit("ls-tree", "-r", pushedSha).toString();
				expect(entries).toContain(`${unsafeOid}\tpackages/coding-agent/src/Foo.ts`);
				expect(entries).toContain(`${cleanOid}\tpackages/coding-agent/src/foo.ts`);
				// Restore only the disposable fixture index; never check out colliding paths.
				runGit("read-tree", "HEAD");
			}
			const diffSha = canonicalDiffSha256(runGit("diff", "--binary", "--full-index", "--no-ext-diff", `${baseSha}...${pushedSha}`));
			// Checkout a different commit, then dirty it with bytes opposite to the pushed tree.
			runGit("checkout", "--detach", baseSha);
			const dirty = badTree ? "export const value = 3;\n" : bad;
			await fs.writeFile(source, dirty);
			const verdict = kind === "merge-blocked" || kind === "merge-approved" ? kind : "needs-human";
			let body = `gajae.pr-review-verdict.v1 ${verdict} sha256:${kind === "stale" ? "0".repeat(64) : diffSha} reviewer:architect reviewer-id:review-agent evidence:fixture review\n`;
			if (kind === "malformed") body = "gajae.pr-review-verdict.v1 invalid\n";
			if (kind !== "missing-risk") body += "- [x] `low-risk`\n";
			if (kind === "multiple-risk") body += "- [x] `high-risk`\n";
			await fs.writeFile(path.join(temp, "pulls.json"), JSON.stringify([{ number: 42, body, base: { ref: "dev" }, user: { login: "author" }, head: { ref: "dev", sha: baseSha, repo: { owner: { login: "receiver" } } } }]));
			await fs.writeFile(path.join(bin, "gh"), `#!${process.execPath}\n
if (process.env.GH_HOST !== "github.com") process.exit(91);
const args = process.argv.slice(2);
if (args[0] === "repo") { console.log('{"isFork":false}'); process.exit(0); }
if (args[0] === "api" && args[1] === "repos/receiver/project/pulls?state=open&head=receiver%3Adev&per_page=100&page=1") {
 console.log(require("node:fs").readFileSync(process.env.PULLS, "utf8")); process.exit(0);
}
throw new Error("Unexpected gh invocation: " + JSON.stringify(args));
`);
			await fs.writeFile(path.join(bin, "git"), `#!${process.execPath}\n
const args = process.argv.slice(2);
if (args[0] === "fetch") {
 require("node:fs").writeFileSync(".git/FETCH_HEAD", process.env.BASE_SHA + "\\n"); process.exit(0);
}
const result = Bun.spawnSync([process.env.REAL_GIT, ...args], {stdin: "inherit", stdout: "inherit", stderr: "inherit"});
process.exit(result.exitCode);
`);
			await Promise.all(["gh", "git"].map(name => fs.chmod(path.join(bin, name), 0o755)));
			const trustedRoot = path.resolve(import.meta.dir, "..");
			const child = Bun.spawn([process.execPath, path.join(trustedRoot, "scripts/verify-pr-verdict.ts"), "--push-preflight", "dev", pushedSha, "--push-url", "https://github.com/receiver/project.git", "--repo", repo, "--trusted-root", trustedRoot], {
				env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GH_HOST: "hostile.example", PULLS: path.join(temp, "pulls.json"), BASE_SHA: baseSha, REAL_GIT: realGit, TMPDIR: scratch }, stdout: "pipe", stderr: "pipe",
			});
			const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
			expect(await fs.readFile(source, "utf8")).toBe(dirty);
			expect(runGit("rev-parse", "HEAD").toString().trim()).toBe(baseSha);
			expect((await fs.readdir(scratch)).filter(name => name.startsWith("gjc-pushed-tree-"))).toEqual([]);
			return { stdout, stderr, exitCode };
		} finally {
			await fs.rm(temp, { recursive: true, force: true });
		}
	}

	for (const kind of ["needs-human", "merge-blocked", "merge-approved"] as const) {
		test(`CLI permits valid ${kind} without local approval queries and ignores dirty checkout gate failures`, async () => {
			const result = await exactTreePreflight(kind);
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain(`PR contract valid: ${kind}`);
		});
	}

	for (const [kind, message] of [
		["stale", "digest"], ["malformed", "Malformed"], ["missing-risk", "found none"],
		["multiple-risk", "found 2"], ["bad-pushed-tree", "fast gate"], ["source-symlink", "fast gate"], ["source-backslash", "fast gate"], ["case-collision", "fast gate"],
	] as const) {
		test(`CLI rejects ${kind} despite clean working-tree bytes when applicable`, async () => {
			const result = await exactTreePreflight(kind);
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain(message);
		});
	}

	for (const kind of ["export-ignore", "export-subst"] as const) {
		test(`pushed attributes cannot omit or transform source bytes: ${kind}`, async () => {
			const result = await exactTreePreflight(kind);
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("Repository fast gate failed");
			expect(result.stdout + result.stderr).toContain("example.ts");
			if (kind === "export-subst") expect(result.stdout + result.stderr).toContain("$Format:%H$");
		});
	}

	test("a non-commit push target fails closed", async () => {
		const script = url.fileURLToPath(new URL("./verify-pr-verdict.ts", import.meta.url));
		const repoRoot = url.fileURLToPath(new URL("..", import.meta.url));
		const child = Bun.spawn([process.execPath, script, "--push-preflight", "some-branch", "not-a-sha", "--repo", repoRoot, "--trusted-root", repoRoot], { stdout: "pipe", stderr: "pipe" });
		const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited]);
		expect(exitCode).toBe(1);
		expect(stderr).toContain("is not a lowercase 40-hex commit");
	});
});

/**
 * Build a signed gajae.pr-self-review.v1 record bound to the given exact base/head/digest.
 */
function selfReviewRecord(context: { baseSha: string; headSha: string; digest: string; reviewerId?: string; verdict?: "merge-approved" | "merge-self-approved" | "merge-blocked"; risk?: "low-risk" | "regression-risk" | "high-risk"; extra?: string }): string {
	const reviewerId = context.reviewerId ?? "owner";
	const verdict = context.verdict ?? "merge-self-approved";
	const risk = context.risk ?? "low-risk";
	const extraToken = context.extra ?? "none";
	const extra = extraToken === "none" ? { kind: "none" as const } : { kind: "independent" as const, login: extraToken.slice("independent:".length) };
	const evidence = "hermetic push preflight fixture";
	const signature = selfReviewSignature(selfReviewSignedPayload({
		verdict,
		baseSha: context.baseSha,
		headSha: context.headSha,
		diffSha256: context.digest,
		reviewerId,
		risk,
		extra,
		evidence,
	}));
	const record = `gajae.pr-self-review.v1 verdict:${verdict} base:${context.baseSha} head:${context.headSha} sha256:${context.digest} reviewer-id:${reviewerId} risk:${risk} extra:${extraToken} evidence:${evidence}`;
	return `${record}\nself-review-signature: sha256:${signature}\nSigned-off-by: gaebal-gajae (clawdbot) 🦞`;
}

interface PushPreflightFixture {
	exitCode: number;
	stdout: string;
	stderr: string;
	ghCalls: string[];
}

interface PushPreflightContext {
	baseSha: string;
	headSha: string;
	digest: string;
}

/**
 * Hermetic end-to-end push preflight for the maintainer self-review record (issue #5483):
 * a real git repository, the real CLI, and a PATH-shimmed `gh` whose only job is to serve
 * the GitHub API responses. Everything the gate itself does — the base fetch, the ancestry
 * check, the canonical diff digest, the pushed-tree fast gate, and the comment read — runs
 * for real. The shim is flag-aware: it refuses a comment read that forgot `--paginate` or
 * lost its `--jq` projection, so the mirroring contract cannot silently regress.
 */
async function runSelfReviewPushPreflight(options: {
	body?: (context: PushPreflightContext) => string;
	comments?: (context: PushPreflightContext) => unknown[];
	commentsUnavailable?: boolean;
	/** Emit the comments as JSONL that is cut off mid-record while gh still exits 0. */
	commentsTruncated?: boolean;
	reviews?: (context: PushPreflightContext) => unknown[];
	/** Server-observed force-push times, newline separated, as the timeline --jq emits them. */
	forcePushedAt?: string;
	reviewsUnavailable?: boolean;
	permission?: string;
	permissionUnavailable?: boolean;
} = {}): Promise<PushPreflightFixture> {
	const script = url.fileURLToPath(new URL("./verify-pr-verdict.ts", import.meta.url));
	const repoRoot = url.fileURLToPath(new URL("..", import.meta.url));
	const temp = await fs.mkdtemp(path.join(Bun.env.TMPDIR ?? "/tmp", "gjc-self-review-preflight-"));
	try {
		const work = path.join(temp, "work");
		const bin = path.join(temp, "bin");
		await fs.mkdir(work, { recursive: true });
		await fs.mkdir(bin, { recursive: true });
		const git = (args: string[]): string => {
			const child = Bun.spawnSync(["git", ...args], { cwd: work, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }, stdout: "pipe", stderr: "pipe" });
			if (child.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${child.stderr.toString()}`);
			return child.stdout.toString();
		};
		git(["init", "-q"]);
		git(["symbolic-ref", "HEAD", "refs/heads/dev"]);
		git(["config", "user.email", "preflight@example.com"]);
		git(["config", "user.name", "Preflight Fixture"]);
		await Bun.write(path.join(work, "packages", "coding-agent", "src", "example.ts"), "export const value = 1;\n");
		git(["add", "-A"]);
		git(["commit", "-q", "-m", "base"]);
		const baseSha = git(["rev-parse", "HEAD"]).trim();
		git(["remote", "add", "origin", "git@github.com:owner/repo.git"]);
		// The gate fetches https://github.com/owner/repo.git itself; rewriting that URL to
		// the fixture keeps the real fetch path while staying off the network.
		git(["config", `url.${work}.insteadOf`, "https://github.com/owner/repo.git"]);
		git(["checkout", "-q", "-b", "feature"]);
		await Bun.write(path.join(work, "packages", "coding-agent", "src", "example.ts"), "export const value = 2;\n");
		git(["add", "-A"]);
		git(["commit", "-q", "-m", "feature"]);
		const headSha = git(["rev-parse", "HEAD"]).trim();
		const diff = Bun.spawnSync(["git", "diff", "--binary", "--full-index", "--no-ext-diff", `${baseSha}...${headSha}`], { cwd: work, stdout: "pipe", stderr: "pipe" }).stdout;
		const context: PushPreflightContext = { baseSha, headSha, digest: canonicalDiffSha256(diff) };
		const body = options.body?.(context) ?? `gajae.pr-review-verdict.v1 merge-self-approved sha256:${context.digest} reviewer:human reviewer-id:owner evidence:hermetic push preflight fixture\n\n## Risk classification\n\n- [x] \`low-risk\`\n`;
		const comments = options.comments?.(context) ?? [{ user: { login: "owner" }, author_association: "OWNER", body: selfReviewRecord(context) }];
		const reviews = options.reviews?.(context) ?? [];
		const pullsPath = path.join(temp, "pulls.json");
		const commentsPath = path.join(temp, "comments.jsonl");
		// Raw ARRAY-shaped page data, exactly as the timeline endpoint returns it, so the
		// stub evaluates the real `--jq` against the real shape. Injecting already-projected
		// stdout is what let a filter missing its `.[]` iterator pass every test (#5692).
		const timelinePath = path.join(temp, "timeline.json");
		await Bun.write(
			timelinePath,
			JSON.stringify(
				(options.forcePushedAt ?? "")
					.split("\n")
					.map(line => line.trim())
					.filter(line => line.length > 0)
					.map(created_at => ({ event: "head_ref_force_pushed", created_at: created_at === "null" ? null : created_at })),
			),
		);
		const reviewsPath = path.join(temp, "reviews.jsonl");
		const permissionPath = path.join(temp, "permission.txt");
		const callsPath = path.join(temp, "gh-calls.log");
		await Bun.write(pullsPath, JSON.stringify([{ number: 123, body, base: { ref: "dev" }, user: { login: "owner" }, head: { ref: "feature", repo: { owner: { login: "owner" } } } }]));
		// RAW array-shaped payloads, exactly as the endpoints return them, so the stub can
		// run the real `--jq` instead of echoing an already-projected string. A canned
		// projection validates nothing about the query that produced it (#5692 review).
		const commentsJson = JSON.stringify(comments);
		await Bun.write(
			commentsPath,
			// Truncation must corrupt the RAW payload now, so `jq` fails on the array the
			// way a cut-short HTTP response would, not on an already-projected line.
			options.commentsTruncated ? commentsJson.slice(0, Math.max(1, commentsJson.length - 12)) : commentsJson,
		);
		await Bun.write(reviewsPath, JSON.stringify(reviews));
		await Bun.write(permissionPath, `${options.permission ?? "write"}\n`);
		await Bun.write(callsPath, "");
		const ghPath = path.join(bin, "gh");
		await Bun.write(ghPath, `#!/usr/bin/env bash\nset -euo pipefail\nargs="$*"\nprintf '%s\\n' "$args" >> "$GH_CALLS"\nif [[ "$args" == "repo view owner/repo --json isFork,parent" ]]; then\n  printf '{"isFork":false}\\n'\nelif [[ "$args" == *"/pulls?state=open"* ]]; then\n  cat "$GH_PULLS"\nelif [[ "$args" == *"/pulls/123/reviews"* ]]; then\n  [[ "$args" == *"--paginate"* ]] || { echo "gh reviews read is missing --paginate" >&2; exit 1; }\n  [[ "$args" == *"commit_id"* ]] || { echo "gh reviews read lost its --jq projection" >&2; exit 1; }\n  if [[ -n "\${GH_REVIEWS_UNAVAILABLE:-}" ]]; then\n    echo "HTTP 503: reviews unavailable" >&2\n    exit 1\n  fi\n  jq -c "\${args#*--jq }" "$GH_REVIEWS"\nelif [[ "$args" == *"/issues/123/timeline"* ]]; then\n  jq_filter="\${args#*--jq }"\n  jq -r "$jq_filter" "$GH_TIMELINE_RAW"\nelif [[ "$args" == *"/collaborators/"* ]]; then\n  [[ "$args" == *"--jq .permission"* ]] || { echo "gh permission read lost its --jq projection" >&2; exit 1; }\n  if [[ -n "\${GH_PERMISSION_UNAVAILABLE:-}" ]]; then\n    echo "HTTP 404: Not Found" >&2\n    exit 1\n  fi\n  cat "$GH_PERMISSION"\nelif [[ "$args" == *"/issues/123/comments"* ]]; then\n  [[ "$args" == *"--paginate"* ]] || { echo "gh comments read is missing --paginate" >&2; exit 1; }\n  [[ "$args" == *"author_association"* ]] || { echo "gh comments read lost its --jq projection" >&2; exit 1; }\n  if [[ -n "\${GH_COMMENTS_UNAVAILABLE:-}" ]]; then\n    echo "HTTP 503: service unavailable" >&2\n    exit 1\n  fi\n  jq -c "\${args#*--jq }" "$GH_COMMENTS"\nelse\n  echo "unexpected gh invocation: $args" >&2\n  exit 1\nfi\n`);
		await fs.chmod(ghPath, 0o755);
		const child = Bun.spawn([process.execPath, script, "--push-preflight", "feature", headSha, "--push-url", "https://github.com/owner/repo.git", "--repo", work, "--trusted-root", repoRoot], {
			cwd: work,
			env: {
				...process.env,
				PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
				GH_CALLS: callsPath,
				GH_PULLS: pullsPath,
				GH_COMMENTS: commentsPath,
				GH_REVIEWS: reviewsPath,
				GH_TIMELINE_RAW: timelinePath,
				GH_PERMISSION: permissionPath,
				...options.commentsUnavailable ? { GH_COMMENTS_UNAVAILABLE: "1" } : {},
				...options.reviewsUnavailable ? { GH_REVIEWS_UNAVAILABLE: "1" } : {},
				...options.permissionUnavailable ? { GH_PERMISSION_UNAVAILABLE: "1" } : {},
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
		const ghCalls = (await Bun.file(callsPath).text()).split("\n").filter(Boolean);
		return { exitCode, stdout, stderr, ghCalls };
	} finally {
		await fs.rm(temp, { recursive: true, force: true });
	}
}

describe("push preflight self-review record (issue #5483)", () => {
	test("a valid merge-self-approved record lets the push preflight pass", async () => {
		const result = await runSelfReviewPushPreflight();
		expect(result.stderr).not.toContain("::error::");
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("PR contract valid: merge-self-approved");
		// The record lives on the PR, so the gate must actually read the comment API.
		expect(result.ghCalls.some(call => call.includes("/issues/123/comments") && call.includes("--paginate"))).toBe(true);
	});

	test("an unreadable self-review record is reported as unread, not as invalid", async () => {
		const result = await runSelfReviewPushPreflight({ commentsUnavailable: true });
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("It was never evaluated, so it has NOT been judged invalid");
		expect(result.stderr).toContain("service unavailable");
		expect(result.stderr).not.toContain("requires a valid gajae.pr-self-review.v1 risk record");
	});

	test("a truncated comment list is an unread record, not a shorter valid one", async () => {
		const result = await runSelfReviewPushPreflight({ commentsTruncated: true });
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("It was never evaluated, so it has NOT been judged invalid");
	});

	test("a PR with no author record fails closed and names the absence", async () => {
		const result = await runSelfReviewPushPreflight({ comments: () => [] });
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("was found on this PR; the merge-self-approved solo path requires one bound to the exact head");
		expect(result.stderr).not.toContain("could not be read");
	});

	test("the newest author-authored record wins over an older stale one", async () => {
		const result = await runSelfReviewPushPreflight({
			comments: context => [
				// An older record bound to a different head must never shadow the current one.
				{ user: { login: "owner" }, author_association: "OWNER", body: selfReviewRecord({ ...context, headSha: "d".repeat(40) }) },
				{ user: { login: "owner" }, author_association: "OWNER", body: selfReviewRecord(context) },
			],
		});
		expect(result.stderr).not.toContain("::error::");
		expect(result.exitCode).toBe(0);
	});

	test("a stale record still fails with the precise sub-diagnostic", async () => {
		const result = await runSelfReviewPushPreflight({
			comments: context => [{ user: { login: "owner" }, author_association: "OWNER", body: selfReviewRecord({ ...context, headSha: "d".repeat(40) }) }],
		});
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("is stale; exact PR head is");
	});

	test("another identity's record never authorizes the author's push", async () => {
		const result = await runSelfReviewPushPreflight({
			comments: context => [{ user: { login: "intruder" }, author_association: "NONE", body: selfReviewRecord(context) }],
		});
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("was found on this PR; the merge-self-approved solo path requires one bound to the exact head");
	});
});

describe("push preflight independent-review evidence (issue #5483 review)", () => {
	const riskClassifiedBody = (context: PushPreflightContext): string =>
		`gajae.pr-review-verdict.v1 needs-human sha256:${context.digest} reviewer:human reviewer-id:owner evidence:hermetic push preflight fixture\n\n## Risk classification\n\n- [x] \`regression-risk\`\n`;
	const riskClassifiedComments = (context: PushPreflightContext) => [{
		user: { login: "owner" },
		author_association: "OWNER",
		body: selfReviewRecord({ ...context, risk: "regression-risk", extra: "independent:review-bot" }),
	}];
	// Submitted well after any commit this harness creates, so a genuine approval is never
	// mistaken for one GitHub re-bound onto a new head by a force-push (#5692). The re-bound
	// case below uses an epoch-old submission instead.
	const reviewerApproval = (
		context: PushPreflightContext,
		state = "APPROVED",
		submittedAt = "2099-01-01T00:00:00Z",
		// RAW API shape — the stub now runs the real `--jq`, so the fixture must look like
		// what GitHub returns, not like the projection. Writing the projected shape here is
		// precisely the mistake that let a broken query pass every test (#5692 review).
	) => [{ user: { login: "review-bot" }, state, commit_id: context.headSha, submitted_at: submittedAt }];

	test("a risk-classified record is authorized by the named reviewer's exact-head approval and permission", async () => {
		const result = await runSelfReviewPushPreflight({
			body: riskClassifiedBody,
			comments: riskClassifiedComments,
			reviews: context => reviewerApproval(context),
			permission: "write",
		});
		expect(result.stderr).not.toContain("::error::");
		expect(result.exitCode).toBe(0);
		// The evidence must come from the real API surface the server uses.
		expect(result.ghCalls.some(call => call.includes("/pulls/123/reviews") && call.includes("--paginate"))).toBe(true);
		expect(result.ghCalls.some(call => call.includes("/collaborators/review-bot/permission"))).toBe(true);
	});

	test("a named reviewer without repository authority does not authorize the record", async () => {
		const result = await runSelfReviewPushPreflight({
			body: riskClassifiedBody,
			comments: riskClassifiedComments,
			reviews: context => reviewerApproval(context),
			permission: "read",
		});
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("is not satisfied");
	});

	test("a named reviewer without an exact-head approval does not authorize the record", async () => {
		const result = await runSelfReviewPushPreflight({
			body: riskClassifiedBody,
			comments: riskClassifiedComments,
			reviews: context => reviewerApproval(context, "CHANGES_REQUESTED"),
			permission: "write",
		});
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("is not satisfied");
	});

	test("a later CHANGES_REQUESTED on the same head supersedes the reviewer's approval", async () => {
		const result = await runSelfReviewPushPreflight({
			body: riskClassifiedBody,
			comments: riskClassifiedComments,
			reviews: context => [
				...reviewerApproval(context),
				// Later than the approval above, so it supersedes it; both postdate the head.
				...reviewerApproval(context, "CHANGES_REQUESTED", "2099-01-02T00:00:00Z"),
			],
			permission: "write",
		});
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("is not satisfied");
	});

	test("an approval GitHub re-bound onto the new head after a force-push does not authorize (#5692)", async () => {
		// The review reports the exact head, but was submitted long before that commit could
		// have existed. `commit_id` tracks the branch tip across a force-push, so this is the
		// shape a rebase leaves behind on an unprotected base with no stale-review dismissal.
		const result = await runSelfReviewPushPreflight({
			body: riskClassifiedBody,
			comments: riskClassifiedComments,
			reviews: context => reviewerApproval(context, "APPROVED", "1970-01-01T00:00:00Z"),
			// A force-push is what re-binds `commit_id`; without one on record there is no
			// re-binding vector and nothing to refuse.
			forcePushedAt: "2020-01-01T00:00:00Z\n",
			permission: "write",
		});
		expect(result.exitCode).toBe(1);
		// Must read as a re-bound stale approval, NOT as a missing one: the remedies differ.
		expect(result.stderr).toContain("submitted BEFORE that head commit existed");
		expect(result.stderr).toContain("observed to re-point stale approvals after a force-push");
	});

	test("a backdated head commit cannot revive a stale approval (#5692 review)", async () => {
		// `GIT_COMMITTER_DATE` is contributor-controlled, so comparing against the commit's
		// own date was a fail-open: backdate the head far enough and any older approval
		// looks fresh. The PR timeline's force-push `created_at` is written by GitHub, so
		// it survives the backdate and still proves when this head appeared.
		const result = await runSelfReviewPushPreflight({
			body: riskClassifiedBody,
			comments: riskClassifiedComments,
			// Submitted AFTER the harness's real head commit, so the contributor-controlled
			// committer date alone would admit it. Only the server-observed force-push,
			// which is later still, proves the approval predates this head.
			reviews: context => reviewerApproval(context, "APPROVED", "2027-01-01T00:00:00Z"),
			forcePushedAt: "2030-01-01T00:00:00Z\n",
			permission: "write",
		});
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("submitted BEFORE that head commit existed");
	});

	test("a same-second approval is refused, not admitted on a tie (#5692 review)", async () => {
		// GitHub serializes both values at second granularity, so a review submitted at
		// 12:00:00.9 and a force-push recorded at 12:00:00.1 arrive identical. The review
		// predates the head it claims, and a strict `<` would have let it through.
		const result = await runSelfReviewPushPreflight({
			body: riskClassifiedBody,
			comments: riskClassifiedComments,
			reviews: context => reviewerApproval(context, "APPROVED", "2030-01-01T00:00:00Z"),
			forcePushedAt: "2030-01-01T00:00:00Z\n",
			permission: "write",
		});
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("submitted BEFORE that head commit existed");
	});

	test("a future-dated commit cannot override server-observed force-push evidence (#5692 review)", async () => {
		// `GIT_COMMITTER_DATE` is contributor-controlled in BOTH directions. Backdating was
		// the original hole; forward-dating raised the freshness floor above what GitHub
		// observed and refused every legitimate approval on the author's own PR.
		//
		// The harness commits with a real date, so the force-push below is the server
		// evidence and the approval postdates it. A blended max would still have admitted
		// this one; the case that matters is that the SERVER value is what decides.
		const result = await runSelfReviewPushPreflight({
			body: riskClassifiedBody,
			comments: riskClassifiedComments,
			reviews: context => reviewerApproval(context, "APPROVED", "2030-01-02T00:00:00Z"),
			forcePushedAt: "2030-01-01T00:00:00Z\n",
			permission: "write",
		});
		expect(result.stderr).not.toContain("submitted BEFORE that head commit existed");
		expect(result.stdout).not.toContain("gjc-merge-authorized=false");
	});

	test("a genuine approval still authorizes when the PR was never force-pushed (#5692 review)", async () => {
		// The freshness checks are only useful if they still let real approvals through.
		// With no force-push there is nothing that could have re-bound `commit_id`, so the
		// committer date alone is an adequate floor and the approval must be ADMITTED.
		// Without this, a gate that refused everything would look identical to a correct one.
		const result = await runSelfReviewPushPreflight({
			body: riskClassifiedBody,
			comments: riskClassifiedComments,
			reviews: context => reviewerApproval(context, "APPROVED", "2099-01-01T00:00:00Z"),
			forcePushedAt: "",
			permission: "write",
		});
		expect(result.stderr).not.toContain("is not satisfied");
		expect(result.stderr).not.toContain("submitted BEFORE that head commit existed");
	});

	test("a force-push event with a null created_at refuses in the preflight too (#5692 review)", async () => {
		// The projection's `// "unreadable"` fallback only matters if the harness actually
		// evaluates it. Now that the stub runs the real jq over array-shaped page data, a
		// null timestamp reaches `latestKnownHeadTime` as an unparseable entry and must
		// refuse rather than collapsing into "no force-push happened".
		const result = await runSelfReviewPushPreflight({
			body: riskClassifiedBody,
			comments: riskClassifiedComments,
			reviews: context => reviewerApproval(context, "APPROVED", "2099-01-01T00:00:00Z"),
			forcePushedAt: "null\n",
			permission: "write",
		});
		expect(result.exitCode).toBe(1);
		// Prove the thing CI actually consumes, not just the internal decision: both
		// `pr-validation.yml` and `dev-ci.yml` gate on this printed line, so a correct
		// refusal that still printed `true` would authorize the merge anyway.
		expect(result.stdout).toContain("gjc-merge-authorized=false");
		expect(result.stdout).not.toContain("gjc-merge-authorized=true");
	});
	test("unreadable independent-review evidence is reported as unread, not as unauthorized", async () => {
		const result = await runSelfReviewPushPreflight({
			body: riskClassifiedBody,
			comments: riskClassifiedComments,
			reviewsUnavailable: true,
		});
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("Could not read the independent-review evidence for review-bot");
		expect(result.stderr).toContain("has NOT been judged unauthorized");
		// One failed read must not be framed as an unsatisfied policy as well.
		expect(result.stderr).not.toContain("is not satisfied");
	});

	test("a low-risk blocking verdict never reads the record it does not need", async () => {
		const result = await runSelfReviewPushPreflight({
			body: context => `gajae.pr-review-verdict.v1 needs-human sha256:${context.digest} reviewer:human reviewer-id:owner evidence:hermetic push preflight fixture\n\n## Risk classification\n\n- [x] \`low-risk\`\n`,
			// A read failure would reject the push if the gate asked for the record at all.
			commentsUnavailable: true,
		});
		expect(result.stderr).not.toContain("::error::");
		expect(result.exitCode).toBe(0);
		expect(result.ghCalls.some(call => call.includes("/issues/123/comments"))).toBe(false);
	});
});

describe("server independent-reviewer evidence (issue #5483 review)", () => {
	const event = { repository: { full_name: "owner/repo" }, pull_request: { number: 5416 } };
	// The head commit's committer date; every genuine review below is submitted after it.
	const headCommittedAt = "2026-09-18T06:00:00Z";
	const afterHead = "2026-09-18T07:00:00Z";
	/** Submitted BEFORE the head existed — only reachable via a force-push re-bind (#5692). */
	const beforeHead = "2026-09-18T02:00:00Z";
	const review = (login: string, state: string, commit = head, submitted = afterHead) => ({
		state,
		commit_id: commit,
		user: { login },
		submitted_at: submitted,
	});

	test.each([
		{ name: "approval only", reviews: [review("review-bot", "APPROVED")], approved: true },
		{ name: "approval withdrawn by a later changes-requested", reviews: [review("review-bot", "APPROVED"), review("review-bot", "CHANGES_REQUESTED")], approved: false },
		{ name: "approval restored after changes-requested", reviews: [review("review-bot", "CHANGES_REQUESTED"), review("review-bot", "APPROVED")], approved: true },
		{ name: "commented review never counts", reviews: [review("review-bot", "COMMENTED")], approved: false },
		{ name: "approval on another head", reviews: [review("review-bot", "APPROVED", "d".repeat(40))], approved: false },
		{ name: "another identity's approval", reviews: [review("someone-else", "APPROVED")], approved: false },
		// #5692: GitHub re-points commit_id onto the new tip after a force-push, so an
		// approval of older code arrives reporting this exact head. It must not count, and it
		// must be distinguishable from having no approval at all.
		{
			name: "approval re-bound onto this head by a force-push does not count",
			reviews: [review("review-bot", "APPROVED", head, beforeHead)],
			approved: false,
			refused: "rebound",
		},
		{
			name: "an approval with no submission time fails closed",
			reviews: [{ state: "APPROVED", commit_id: head, user: { login: "review-bot" } }],
			approved: false,
			refused: "unreadable",
		},
	]) ("$name", async scenario => {
		const originalFetch = globalThis.fetch;
		const previousToken = Bun.env.GITHUB_TOKEN;
		Bun.env.GITHUB_TOKEN = "test-token";
		const replacement: typeof fetch = Object.assign(async (input: Parameters<typeof fetch>[0]) => {
			const endpoint = String(input);
			if (endpoint.startsWith("https://api.github.com/repos/owner/repo/pulls/5416/reviews")) return Response.json(scenario.reviews);
			if (endpoint === `https://api.github.com/repos/owner/repo/commits/${head}`)
				return Response.json({ commit: { committer: { date: headCommittedAt } } });
			if (endpoint.startsWith("https://api.github.com/repos/owner/repo/issues/5416/timeline"))
				// The head appeared at a force-push; the committer date is no longer a
				// freshness floor because a contributor can set it in either direction.
				return Response.json([{ event: "head_ref_force_pushed", created_at: headCommittedAt }]);
			if (endpoint === "https://api.github.com/repos/owner/repo/collaborators/review-bot/permission") return Response.json({ permission: "write" });
			throw new Error(`Unexpected endpoint: ${endpoint}`);
		}, { preconnect: originalFetch.preconnect });
		const spy = vi.spyOn(globalThis, "fetch").mockImplementation(replacement);
		try {
			const evidence = await fetchIndependentReviewerEvidence(event, "review-bot", head);
			expect(evidence).toEqual({
				permission: "write",
				approvedHead: scenario.approved,
				approvedLogin: "review-bot",
				...(scenario.refused ? { refusedApproval: scenario.refused } : {}),
			});
		} finally {
			spy.mockRestore();
			if (previousToken === undefined) delete Bun.env.GITHUB_TOKEN; else Bun.env.GITHUB_TOKEN = previousToken;
		}
	});

	test.each([
		// The committer date is no longer a freshness floor in either direction, so an
		// unreadable COMMIT is irrelevant. What must refuse is an unreadable force-push,
		// because a force-push on record is the only re-binding vector (#5692 review).
		{ name: "timeline read failure", timeline: () => new Response("nope", { status: 503 }) },
		{ name: "force-push with a null time", timeline: () => Response.json([{ event: "head_ref_force_pushed", created_at: null }]) },
		{ name: "force-push with an unparseable time", timeline: () => Response.json([{ event: "head_ref_force_pushed", created_at: "not-a-date" }]) },
	])("unreadable server force-push evidence refuses the approval: $name", async scenario => {
		const originalFetch = globalThis.fetch;
		const previousToken = Bun.env.GITHUB_TOKEN;
		Bun.env.GITHUB_TOKEN = "test-token";
		const replacement: typeof fetch = Object.assign(async (input: Parameters<typeof fetch>[0]) => {
			const endpoint = String(input);
			if (endpoint.startsWith("https://api.github.com/repos/owner/repo/pulls/5416/reviews"))
				return Response.json([review("review-bot", "APPROVED")]);
			if (endpoint.startsWith("https://api.github.com/repos/owner/repo/issues/5416/timeline")) return scenario.timeline();
			if (endpoint === "https://api.github.com/repos/owner/repo/collaborators/review-bot/permission")
				return Response.json({ permission: "write" });
			throw new Error(`Unexpected endpoint: ${endpoint}`);
		}, { preconnect: originalFetch.preconnect });
		const spy = vi.spyOn(globalThis, "fetch").mockImplementation(replacement);
		try {
			const evidence = await fetchIndependentReviewerEvidence(event, "review-bot", head);
			expect({ approvedHead: evidence.approvedHead, refusedApproval: evidence.refusedApproval }).toEqual({
				approvedHead: false,
				refusedApproval: "unreadable",
			});
		} finally {
			spy.mockRestore();
			if (previousToken === undefined) delete Bun.env.GITHUB_TOKEN;
			else Bun.env.GITHUB_TOKEN = previousToken;
		}
	});

	test("unreadable timeline evidence is diagnosed as a read failure, not a stale approval (#5692 review)", async () => {
		// The remedies differ. A stale approval needs a new review; a read failure needs a
		// re-run. The message said "the head commit date" after the commit date stopped
		// being consulted at all, and recommended a new review, which would not clear it.
		const originalFetch = globalThis.fetch;
		const previousToken = Bun.env.GITHUB_TOKEN;
		Bun.env.GITHUB_TOKEN = "test-token";
		const replacement: typeof fetch = Object.assign(async (input: Parameters<typeof fetch>[0]) => {
			const endpoint = String(input);
			if (endpoint.startsWith("https://api.github.com/repos/owner/repo/pulls/5416/reviews"))
				return Response.json([review("review-bot", "APPROVED")]);
			if (endpoint.startsWith("https://api.github.com/repos/owner/repo/issues/5416/timeline"))
				return new Response("unavailable", { status: 503 });
			if (endpoint === "https://api.github.com/repos/owner/repo/collaborators/review-bot/permission")
				return Response.json({ permission: "write" });
			throw new Error(`Unexpected endpoint: ${endpoint}`);
		}, { preconnect: originalFetch.preconnect });
		const spy = vi.spyOn(globalThis, "fetch").mockImplementation(replacement);
		try {
			const evidence = await fetchIndependentReviewerEvidence(event, "review-bot", head);
			// The evidence must classify the refusal as unreadable, which is what selects
			// the read-failure diagnostic over the stale-approval one.
			expect({ approvedHead: evidence.approvedHead, refusedApproval: evidence.refusedApproval }).toEqual({
				approvedHead: false,
				refusedApproval: "unreadable",
			});
			// And the message that classification selects must name the real blocker and
			// the real remedy: no commit-date language, no "get a new review".
			const source = await Bun.file(new URL("./verify-pr-verdict.ts", import.meta.url)).text();
			const unreadableBranch = source.slice(source.indexOf('refused === "unreadable"'), source.indexOf("} else {", source.indexOf('refused === "unreadable"')));
			expect(unreadableBranch).toContain("force-push evidence could not be read");
			expect(unreadableBranch).toContain("Re-run once the timeline is readable");
			expect(unreadableBranch).not.toContain("head commit date");
			expect(unreadableBranch).not.toContain("a review submitted after the current head is required");
		} finally {
			spy.mockRestore();
			if (previousToken === undefined) delete Bun.env.GITHUB_TOKEN;
			else Bun.env.GITHUB_TOKEN = previousToken;
		}
	});

	test("a future-dated commit cannot block a genuine approval when no force-push occurred (#5692 review)", async () => {
		// The no-force-push branch previously used the committer date as the floor, so an
		// author could forward-date their commit and refuse every legitimate approval on
		// their own PR. With no force-push there is no re-binding vector at all.
		const originalFetch = globalThis.fetch;
		const previousToken = Bun.env.GITHUB_TOKEN;
		Bun.env.GITHUB_TOKEN = "test-token";
		const replacement: typeof fetch = Object.assign(async (input: Parameters<typeof fetch>[0]) => {
			const endpoint = String(input);
			if (endpoint.startsWith("https://api.github.com/repos/owner/repo/pulls/5416/reviews"))
				return Response.json([review("review-bot", "APPROVED")]);
			if (endpoint === `https://api.github.com/repos/owner/repo/commits/${head}`)
				return Response.json({ commit: { committer: { date: "2099-01-01T00:00:00Z" } } });
			if (endpoint.startsWith("https://api.github.com/repos/owner/repo/issues/5416/timeline"))
				return Response.json([]);
			if (endpoint === "https://api.github.com/repos/owner/repo/collaborators/review-bot/permission")
				return Response.json({ permission: "write" });
			throw new Error(`Unexpected endpoint: ${endpoint}`);
		}, { preconnect: originalFetch.preconnect });
		const spy = vi.spyOn(globalThis, "fetch").mockImplementation(replacement);
		try {
			const evidence = await fetchIndependentReviewerEvidence(event, "review-bot", head);
			expect({ approvedHead: evidence.approvedHead, refusedApproval: evidence.refusedApproval }).toEqual({
				approvedHead: true,
				refusedApproval: undefined,
			});
		} finally {
			spy.mockRestore();
			if (previousToken === undefined) delete Bun.env.GITHUB_TOKEN;
			else Bun.env.GITHUB_TOKEN = previousToken;
		}
	});

	test("an unreadable PR timeline refuses rather than falling back to commit time (#5692 review)", async () => {
		// The timeline is the only server-written freshness evidence. If it cannot be read,
		// the sole remaining candidate is the contributor-settable committer date, so
		// admitting here would reinstate exactly the backdate hole that replaced it.
		const originalFetch = globalThis.fetch;
		const previousToken = Bun.env.GITHUB_TOKEN;
		Bun.env.GITHUB_TOKEN = "test-token";
		const replacement: typeof fetch = Object.assign(async (input: Parameters<typeof fetch>[0]) => {
			const endpoint = String(input);
			if (endpoint.startsWith("https://api.github.com/repos/owner/repo/pulls/5416/reviews"))
				return Response.json([review("review-bot", "APPROVED")]);
			if (endpoint === `https://api.github.com/repos/owner/repo/commits/${head}`)
				return Response.json({ commit: { committer: { date: headCommittedAt } } });
			if (endpoint.startsWith("https://api.github.com/repos/owner/repo/issues/5416/timeline"))
				return new Response("unavailable", { status: 503 });
			if (endpoint === "https://api.github.com/repos/owner/repo/collaborators/review-bot/permission")
				return Response.json({ permission: "write" });
			throw new Error(`Unexpected endpoint: ${endpoint}`);
		}, { preconnect: originalFetch.preconnect });
		const spy = vi.spyOn(globalThis, "fetch").mockImplementation(replacement);
		try {
			const evidence = await fetchIndependentReviewerEvidence(event, "review-bot", head);
			expect({ approvedHead: evidence.approvedHead, refusedApproval: evidence.refusedApproval }).toEqual({
				approvedHead: false,
				refusedApproval: "unreadable",
			});
		} finally {
			spy.mockRestore();
			if (previousToken === undefined) delete Bun.env.GITHUB_TOKEN;
			else Bun.env.GITHUB_TOKEN = previousToken;
		}
	});

	test("an unreadable later withdrawal cannot resurrect an earlier approval (#5692 review)", async () => {
		// The freshness filter used to run BEFORE selecting the last review, so a later
		// CHANGES_REQUESTED with an unreadable time was dropped from the list and the
		// earlier valid APPROVED was promoted back to "last word" — authorizing a merge
		// the reviewer had explicitly withdrawn.
		const originalFetch = globalThis.fetch;
		const previousToken = Bun.env.GITHUB_TOKEN;
		Bun.env.GITHUB_TOKEN = "test-token";
		const replacement: typeof fetch = Object.assign(async (input: Parameters<typeof fetch>[0]) => {
			const endpoint = String(input);
			if (endpoint.startsWith("https://api.github.com/repos/owner/repo/pulls/5416/reviews"))
				return Response.json([
					review("review-bot", "APPROVED"),
					{ state: "CHANGES_REQUESTED", commit_id: head, user: { login: "review-bot" } },
				]);
			if (endpoint === `https://api.github.com/repos/owner/repo/commits/${head}`)
				return Response.json({ commit: { committer: { date: headCommittedAt } } });
			if (endpoint.startsWith("https://api.github.com/repos/owner/repo/issues/5416/timeline"))
				return Response.json([]);
			if (endpoint === "https://api.github.com/repos/owner/repo/collaborators/review-bot/permission")
				return Response.json({ permission: "write" });
			throw new Error(`Unexpected endpoint: ${endpoint}`);
		}, { preconnect: originalFetch.preconnect });
		const spy = vi.spyOn(globalThis, "fetch").mockImplementation(replacement);
		try {
			const evidence = await fetchIndependentReviewerEvidence(event, "review-bot", head);
			expect(evidence.approvedHead).toBe(false);
		} finally {
			spy.mockRestore();
			if (previousToken === undefined) delete Bun.env.GITHUB_TOKEN;
			else Bun.env.GITHUB_TOKEN = previousToken;
		}
	});

	test.each([
		{ name: "unparseable string", createdAt: "not-a-date" },
		// `created_at: null` was silently DROPPED rather than refused, so the backdated
		// committer date survived as the answer — the same fail-open through a different
		// input shape (#5692 review).
		{ name: "null", createdAt: null },
		{ name: "absent", createdAt: undefined },
		{ name: "blank", createdAt: "   " },
	])("a force-push event with an unreadable time refuses, not falls back: $name (#5692 review)", async scenario => {
		// A force-push DID happen; we simply cannot read when. Dropping it and using the
		// contributor's committer date would reinstate the backdate hole, so "could not
		// read the authority" must not collapse into "no authority exists".
		const originalFetch = globalThis.fetch;
		const previousToken = Bun.env.GITHUB_TOKEN;
		Bun.env.GITHUB_TOKEN = "test-token";
		const replacement: typeof fetch = Object.assign(async (input: Parameters<typeof fetch>[0]) => {
			const endpoint = String(input);
			if (endpoint.startsWith("https://api.github.com/repos/owner/repo/pulls/5416/reviews"))
				return Response.json([review("review-bot", "APPROVED")]);
			if (endpoint === `https://api.github.com/repos/owner/repo/commits/${head}`)
				return Response.json({ commit: { committer: { date: headCommittedAt } } });
			if (endpoint.startsWith("https://api.github.com/repos/owner/repo/issues/5416/timeline"))
				return Response.json([{ event: "head_ref_force_pushed", created_at: scenario.createdAt }]);
			if (endpoint === "https://api.github.com/repos/owner/repo/collaborators/review-bot/permission")
				return Response.json({ permission: "write" });
			throw new Error(`Unexpected endpoint: ${endpoint}`);
		}, { preconnect: originalFetch.preconnect });
		const spy = vi.spyOn(globalThis, "fetch").mockImplementation(replacement);
		try {
			const evidence = await fetchIndependentReviewerEvidence(event, "review-bot", head);
			expect(evidence.approvedHead).toBe(false);
			expect(evidence.refusedApproval).toBe("unreadable");
		} finally {
			spy.mockRestore();
			if (previousToken === undefined) delete Bun.env.GITHUB_TOKEN;
			else Bun.env.GITHUB_TOKEN = previousToken;
		}
	});

	test("the refusal reason and the approval decision agree on which review counts (#5483, #5692)", async () => {
		// The two functions kept their own copies of the selection, and when only one was
		// reordered to select before judging freshness they diverged: the approval path
		// correctly refused a withdrawn review while the reason path still described the
		// earlier approval. They now share `lastExactHeadReview`; this pins that they cannot
		// disagree again by asserting the pair, not either half alone.
		const originalFetch = globalThis.fetch;
		const previousToken = Bun.env.GITHUB_TOKEN;
		Bun.env.GITHUB_TOKEN = "test-token";
		const replacement: typeof fetch = Object.assign(async (input: Parameters<typeof fetch>[0]) => {
			const endpoint = String(input);
			if (endpoint.startsWith("https://api.github.com/repos/owner/repo/pulls/5416/reviews"))
				return Response.json([
					// A re-bound approval, then a valid later withdrawal on the same head.
					review("review-bot", "APPROVED", head, beforeHead),
					review("review-bot", "CHANGES_REQUESTED"),
				]);
			if (endpoint === `https://api.github.com/repos/owner/repo/commits/${head}`)
				return Response.json({ commit: { committer: { date: headCommittedAt } } });
			if (endpoint.startsWith("https://api.github.com/repos/owner/repo/issues/5416/timeline"))
				return Response.json([]);
			if (endpoint === "https://api.github.com/repos/owner/repo/collaborators/review-bot/permission")
				return Response.json({ permission: "write" });
			throw new Error(`Unexpected endpoint: ${endpoint}`);
		}, { preconnect: originalFetch.preconnect });
		const spy = vi.spyOn(globalThis, "fetch").mockImplementation(replacement);
		try {
			const evidence = await fetchIndependentReviewerEvidence(event, "review-bot", head);
			// The withdrawal is the last word, so there is no approval AND no re-bound
			// approval to describe — reporting "rebound" here would point the author at the
			// wrong remedy.
			expect({ approvedHead: evidence.approvedHead, refusedApproval: evidence.refusedApproval }).toEqual({
				approvedHead: false,
				refusedApproval: undefined,
			});
		} finally {
			spy.mockRestore();
			if (previousToken === undefined) delete Bun.env.GITHUB_TOKEN;
			else Bun.env.GITHUB_TOKEN = previousToken;
		}
	});
});

test("workflow is trusted-default-branch-controlled, read-only, exact-head, and invokes only base code", async () => {
	const workflow = await Bun.file(new URL("../.github/workflows/pr-validation.yml", import.meta.url)).text();
	expect(workflow).toContain("pull_request_target:");
	expect(workflow).toContain("pull_request_review:");
	expect(workflow).toContain("types: [submitted, edited, dismissed]");
	expect(workflow).not.toContain("if: ${{ false }}");
	expect(workflow).not.toMatch(/^\s+pull_request:\s*$/mu);
	expect(workflow).toContain("permissions:\n  contents: read\n  pull-requests: read");
	expect(workflow).toContain("name: PR contract");
	expect(workflow).toContain("name: Validate exact-head PR contract");
	expect(workflow).toContain("repository: ${{ steps.pr.outputs.head_repo }}");
	expect(workflow).toContain("ref: ${{ steps.pr.outputs.head_sha }}");
	expect(workflow).toContain("ref: ${{ steps.pr.outputs.base_sha }}");
	expect(workflow.match(/persist-credentials: false/gu)).toHaveLength(2);
	expect(workflow).toContain("unset BUN_OPTIONS");
	expect(workflow).toContain("empty_bunfig=\"$RUNNER_TEMP/gjc-pr-contract-empty-bunfig.toml\"");
	expect(workflow).toContain('if [[ ! -f "$trusted_root/scripts/verify-pr-verdict.ts" ]]');
	expect(workflow).toContain("predates the trusted validator; Dev CI PR contract bootstrap remains authoritative");
	expect(workflow).toMatch(/if \[\[ ! -f "\$trusted_root\/scripts\/verify-pr-verdict\.ts" \]\]; then[\s\S]*?exit 0[\s\S]*?bun --no-env-file/u);
	expect(workflow).not.toContain('! -f "$repo_root/scripts/verify-pr-verdict.ts"');
	expect(workflow).toContain("cd \"$trusted_root\"");
	expect(workflow).toContain('bun --no-env-file --config="$empty_bunfig" "$trusted_root/scripts/verify-pr-verdict.ts"');
	expect(workflow).toContain('--event "$GITHUB_EVENT_PATH" --repo "$repo_root" --trusted-root "$trusted_root"');
	expect(workflow).not.toContain("pr-head/scripts/verify-pr-verdict.ts");
	expect(workflow).not.toContain("secrets.");
	expect(workflow).not.toContain("actions/cache");
	expect(workflow).not.toContain("upload-artifact");
	expect(workflow).not.toContain("download-artifact");
	expect(workflow).not.toContain("continue-on-error");
});

test("workflow re-runs the trusted validator on maintainer self-review comment events", async () => {
	const workflow = await Bun.file(new URL("../.github/workflows/pr-validation.yml", import.meta.url)).text();
	expect(workflow).toContain("issue_comment:");
	expect(workflow).toContain("types: [created, edited, deleted]");
	// Comment bytes are workflow input only; the validator still runs from the immutable
	// base checkout and never executes head-controlled code.
	expect(workflow).toContain('bun --no-env-file --config="$empty_bunfig" "$trusted_root/scripts/verify-pr-verdict.ts"');
	// The issue_comment event payload has no pull_request object; the validator must
	// resolve the PR from the comment (issue number) and revalidate from event data.
	const source = await Bun.file(new URL("./verify-pr-verdict.ts", import.meta.url)).text();
	expect(source).toContain("/issues/${number}/comments");
	expect(source).toContain("author_association");
});

test("comment-triggered validation publishes a head-bound check run under the required context and skips non-PR comments", async () => {
	const workflow = await Bun.file(new URL("../.github/workflows/pr-validation.yml", import.meta.url)).text();
	// issue_comment runs associate with the default-branch SHA; the result must be
	// published on the resolved exact head UNDER THE REQUIRED CONTEXT NAME so
	// deletion of the backing record revokes the same green check (review major 2).
	expect(workflow).toContain("/check-runs");
	expect(workflow).toContain('-f name="Validate exact-head PR contract"');
	expect(workflow).toContain('-f head_sha="$head_sha"');
	expect(workflow).toContain("checks: write");
	expect(workflow).not.toContain("/statuses/");
	// Revocation: deleting the sole authorizing record must re-evaluate and the
	// required context flips to failure when no valid record remains.
	expect(workflow).toContain("types: [created, edited, deleted]");
	// The branch-protection rollout contract is documented in the workflow.
	expect(workflow).toContain("Branch-protection rollout contract");
	// Ordinary issues are not pull requests: the resolve step must skip cleanly
	// instead of failing the job on the 404.
	expect(workflow).toContain('if ! pr_json="$(gh api "repos/${{ github.repository }}/pulls/${number}" 2>/dev/null)"; then');
	// A trusted base missing ANY required validator capability can never authorize.
	// One marker was not enough: `main` carried the self-review validator but not the
	// approval freshness rule, so a comment-triggered re-validation ran the old
	// `commit_id`-only logic and published a green "Merge approval" behind a guard that
	// reported the base as current (#5692 review).
	expect(workflow).toContain('|| stale_base="self-review validation"');
	expect(workflow).toContain('|| stale_base="${stale_base:+$stale_base and }approval freshness binding"');
	// BOTH markers must be code-only tokens. `gajae.pr-self-review.v1` and
	// `head_ref_force_pushed` each also appear in prose, so a base that kept the
	// comments while losing the implementation would have passed.
	expect(workflow).toContain('grep -q "selfReviewSatisfiesPolicy("');
	expect(workflow).toContain('grep -q "reviewPrecedesHead("');
	expect(workflow).toContain('if [[ -n "$stale_base" ]]; then');
	// Both published names must go red together, never just the contract one.
	expect(workflow).toContain('approval_summary="$summary"');

	// The approval authority must be REVOKED before any fallible work, then raised only
	// after the contract publication succeeds.
	//
	// Assert JOB TOPOLOGY, not position within one step. Revoking inside the publication
	// step still left the entire validation phase uncovered: a failure during checkout,
	// Bun setup, or the validator never reached the revocation, so a previously-green
	// "Merge approval" survived as the authoritative required check (#5692 review).
	const stepOf = (needle: string): number => {
		const at = workflow.indexOf(needle);
		expect({ needle, found: at > -1 }).toEqual({ needle, found: true });
		return workflow.lastIndexOf("      - ", at);
	};
	const resolvePr = stepOf("name: Resolve PR head/base from the event or the comment's PR");
	const revoke = stepOf("name: Revoke any prior approval for this head before re-validating");
	// EVERY fallible step must follow the revoke, not just the first of each kind. The
	// job has two checkouts; asserting only the first would miss a second one inserted
	// ahead of the revoke. Same instances-versus-property mistake as the earlier pins.
	const allStepsMatching = (needle: string): number[] => {
		const found: number[] = [];
		for (let at = workflow.indexOf(needle); at > -1; at = workflow.indexOf(needle, at + 1)) {
			found.push(workflow.lastIndexOf("      - ", at));
		}
		expect({ needle, count: found.length }).toEqual({ needle, count: found.length });
		expect(found.length).toBeGreaterThan(0);
		return found;
	};
	const fallible: Array<[string, number[]]> = [
		["checkout", allStepsMatching("uses: actions/checkout@")],
		["setup-bun", allStepsMatching("uses: oven-sh/setup-bun@")],
		["validate", allStepsMatching("name: Validate body, exact head, immutable base, reviewer, and fast gate")],
		["publish", allStepsMatching("name: Publish head-bound check results for comment-triggered validation")],
	];
	// Resolution may precede the revoke because the head SHA is needed to address the
	// check run, and it needs no checkout. Nothing fallible may.
	expect(resolvePr).toBeLessThan(revoke);
	for (const [label, positions] of fallible) {
		for (const [index, at] of positions.entries()) {
			expect({ step: `${label}[${index}]`, afterRevoke: at > revoke }).toEqual({
				step: `${label}[${index}]`,
				afterRevoke: true,
			});
		}
	}
	// The job has exactly two checkouts today; if that changes, the loop above still
	// covers the new one, but pin the count so a silent restructure is visible.
	expect(fallible[0]?.[1].length).toBe(2);
	// A failure after the head SHA is known but before the approval is raised must still
	// leave the approval revoked. Gated on failure() so it cannot fire on the happy path.
	// Revocation must be restricted to self-review comment events. `issue_comment` fires
	// for every comment by anyone, so revoking on all of them let any commenter red the
	// exact-head approval and, with `cancel-in-progress`, keep an authorized PR blocked
	// indefinitely without changing any authorization evidence (#5740 review).
	expect(workflow).toContain("steps.pr.outputs.self_review_event == 'true'");
	expect(workflow.match(/self_review_event == 'true'/g)).toHaveLength(2);
	// The untrusted comment body must reach the script through the environment. Inline
	// `${{ github.event.comment.body }}` in a `run:` block is shell injection from an
	// untrusted author — the exact thing this workflow exists to avoid.
	expect(workflow).toContain("COMMENT_BODY: ${{ github.event.comment.body }}");
	expect(workflow).toContain('"${COMMENT_BODY:-}" == *"$record_marker"*');
	// The marker alone is not enough: anyone can write it, so gating on the string only
	// would let a third party force revocation and reinstate the denial of service behind
	// one extra step. A self-review record is author-owned by definition.
	expect(workflow).toContain('"${COMMENT_AUTHOR:-}" == "${PR_AUTHOR:-}"');
	expect(workflow).toContain("COMMENT_AUTHOR: ${{ github.event.comment.user.login }}");
	expect(workflow).toContain("PR_AUTHOR: ${{ github.event.issue.user.login }}");
	expect(workflow).not.toContain('comment_body="${{ github.event.comment.body }}"');
	expect(workflow).toContain("name: Keep the approval revoked when revalidation does not complete");
	expect(workflow).toContain("if: ${{ failure() && github.event_name == 'issue_comment' && steps.pr.outputs.self_review_event == 'true' && steps.pr.outputs.head_sha != '' }}");
	expect(workflow).toContain('-f \'output[title]="Merge approval (re-validation failed)"\'');
	// Within the publication step the contract result is written before the approval is
	// raised, so a failed contract write cannot leave a green approval.
	const publishContract = workflow.indexOf('"output[summary]=$summary"');
	const raiseApproval = workflow.indexOf('-f "output[summary]=$approval_summary"');
	expect(publishContract).toBeLessThan(raiseApproval);
	// The revoking write must be a hard failure: a neutral conclusion is not blocking,
	// so it would replace a stale green with something that still permits the merge.
	expect(workflow).toContain('-f conclusion="failure" \\\n            -f \'output[title]="Merge approval (re-validating)"\'');
});

test("the stale-base markers survive comment stripping but not code removal (#5692 review)", async () => {
	// The guard's whole job is to prove BEHAVIOUR exists in the trusted base. A marker
	// a comment can satisfy proves only that someone once wrote about the behaviour.
	//
	// Simulate the two drift directions against the real validator source rather than a
	// hand-written fixture: strip every comment (behaviour intact -> must still pass),
	// then strip executable code while KEEPING the comments (behaviour gone -> must fail).
	const source = await Bun.file(new URL("../scripts/verify-pr-verdict.ts", import.meta.url)).text();
	const markers = ["selfReviewSatisfiesPolicy(", "reviewPrecedesHead("];

	const codeOnly = source
		.replaceAll(/\/\*[\s\S]*?\*\//g, "")
		.split("\n")
		.filter(line => !line.trimStart().startsWith("//"))
		.join("\n");
	for (const marker of markers) {
		expect({ marker, presentInCode: codeOnly.includes(marker) }).toEqual({ marker, presentInCode: true });
	}

	// Comments and string literals only: what a base would look like if the
	// implementation were reverted but the documentation left behind.
	const proseOnly = [
		...(source.match(/\/\*[\s\S]*?\*\//g) ?? []),
		...source.split("\n").filter(line => line.trimStart().startsWith("//")),
	].join("\n");
	for (const marker of markers) {
		expect({ marker, satisfiableByProse: proseOnly.includes(marker) }).toEqual({
			marker,
			satisfiableByProse: false,
		});
	}
});

test("every malformed-record diagnostic matches its parser field for field (#5740 review)", async () => {
	// Both messages described grammar the regexes reject: the verdict one omitted
	// `merge-self-approved`, and the self-review one omitted it AND offered
	// `extra:gpt-heavy`. Follow either exactly and the record still fails to parse — an
	// unreachable remedy handed to someone already stuck on malformed input.
	//
	// My first guard here was itself too narrow: it looked for `verdict:<...>`, which
	// only the self-review message has, so the ordinary verdict diagnostic was never
	// inspected and dropping `merge-self-approved` from it still passed (#5740 review).
	//
	// This asserts SET EQUALITY per field, in both directions. Advertising something the
	// parser rejects fails, and so does quietly accepting something never advertised.
	const source = await Bun.file(new URL("./verify-pr-verdict.ts", import.meta.url)).text();
	const line = (needle: string): string => {
		const found = source.split("\n").find((candidate) => candidate.includes(needle));
		expect({ needle, found: found !== undefined }).toEqual({ needle, found: true });
		return found ?? "";
	};
	// `independent:[^\s]+` and `independent:login` are the same alternative with a
	// different placeholder, so compare on the head of a parameterised value.
	const head = (alternative: string): string => alternative.split(":")[0] ?? alternative;
	const set = (raw: string): string[] => [...new Set(raw.split("|").map(head))].sort();
	const compare = (field: string, pattern: string, message: string, accepted: string, advertised: string): void => {
		const acceptedSet = set(source.match(new RegExp(`${pattern}[^\n]*?${accepted}\\(([^)]*)\\)`))?.[1] ?? "");
		const advertisedSet = set(line(message).match(new RegExp(`${advertised}<([^>]*)>`))?.[1] ?? "");
		expect(acceptedSet.length).toBeGreaterThan(0);
		expect({ field, advertised: advertisedSet }).toEqual({ field, advertised: acceptedSet });
	};
	// Domain 1 — the ordinary verdict line. This is the message my previous guard missed.
	compare("verdict verb", "VERDICT_PATTERN", "Malformed ${VERDICT_PREFIX} line", "v1 ", "VERDICT_PREFIX} ");
	compare("verdict reviewer", "VERDICT_PATTERN", "Malformed ${VERDICT_PREFIX} line", "reviewer:", "reviewer:");
	// Domain 2 — the self-review record, every enumerated field of it.
	const selfReview = "Malformed ${SELF_REVIEW_PREFIX} line";
	compare("self-review verb", "SELF_REVIEW_PATTERN", selfReview, "verdict:", "verdict:");
	compare("self-review risk", "SELF_REVIEW_PATTERN", selfReview, "risk:", "risk:");
	compare("self-review extra", "SELF_REVIEW_PATTERN", selfReview, "extra:", "extra:");
});

test("every expression expanded into a workflow run scalar is explicitly justified (#5740 review)", async () => {
	// Author-controlled text expanded into a `run:` body is shell injection. I introduced
	// exactly that while fixing something else, so this guard exists to make the CLASS
	// impossible rather than the one instance I happened to hit.
	//
	// THREE earlier versions were each too narrow and each passed a live vector:
	//   1. it skipped shell comment lines — but GitHub expands `${{ }}` before bash sees
	//      the script, so a multiline body injects an executable line from behind a `#`;
	//   2. it matched only `run: |` block scalars, only `github.event.*`, and a hardcoded
	//      file list;
	//   3. it hand-parsed YAML line by line, which cannot see a flow-style or quoted key
	//      (`- { "run": ... }`), an aliased scalar (`run: *anchor`), or the valid `|2-`
	//      indicator order — and its `[^}]+?` matcher could not cross an ordinary brace,
	//      so `${{ format('{0}', github.event.comment.body) }}` was INVISIBLE to it.
	//
	// Hand-parsing the YAML was the root mistake, so this parses it. Traversal is
	// semantic: any string under a `run` or `script` key, wherever it appears, with
	// aliases already resolved by the parser. Expression extraction is terminator-aware
	// and fails closed on anything it cannot classify.
	const justified = new Map<string, string>([
		// Keyed by FILE and expression, not expression alone. A global key means an
		// allowlisted name such as `inputs.hash` silently covers a NEW composite action
		// whose caller feeds it PR text — the justification would be true of the old
		// producer and false of the new one (#5740 review).
		[".github/actions/build-native/action.yml\tinputs.hash", "hex digest computed in-workflow; ci.yml is the only caller"],
		[".github/actions/build-native/action.yml\tinputs.nightly_version", "same generated version; ci.yml is the only caller"],
		[".github/workflows/ci.yml\tgithub.ref", "ref name; writing one requires push access to this protected path"],
		[".github/workflows/ci.yml\tgithub.run_id", "integer assigned by GitHub"],
		[".github/workflows/ci.yml\tgithub.sha", "40-hex, server-computed"],
		[".github/workflows/ci.yml\tmatrix.binary_path", "workflow-fixed matrix literal"],
		[".github/workflows/ci.yml\tneeds.acp_conformance.result", "closed result enum"],
		[".github/workflows/ci.yml\tneeds.check.result", "closed result enum"],
		[".github/workflows/ci.yml\tneeds.main_native.result", "closed result enum"],
		[".github/workflows/ci.yml\tneeds.main_plan.result", "closed result enum"],
		[".github/workflows/ci.yml\tneeds.main_shards.result", "closed result enum"],
		[".github/workflows/ci.yml\tneeds.release_metadata.outputs.nightly_version", "generated by scripts/nightly-release.ts"],
		[".github/workflows/ci.yml\tneeds.test.result", "closed result enum"],
		[".github/workflows/dev-ci.yml\tmatrix.group", "workflow-fixed matrix literal"],
		[".github/workflows/dev-ci.yml\tneeds.affected-evidence-producer.outputs.artifact_digest", "digest written by a trusted job"],
		[".github/workflows/dev-ci.yml\tneeds.affected-evidence-producer.outputs.artifact_id", "id written by a trusted job"],
		[".github/workflows/dev-ci.yml\tneeds.affected-evidence-producer.result", "closed result enum"],
		[".github/workflows/dev-ci.yml\tneeds.affected-plan.result", "closed result enum"],
		[".github/workflows/dev-ci.yml\tneeds.gjc-state-gates-matrix.result", "closed result enum"],
		[".github/workflows/dev-ci.yml\tneeds.gjc-state-gates-native.result", "closed result enum"],
		[".github/workflows/dev-ci.yml\tneeds.gjc-state-gates-relevance.outputs.relevant", "literal true|false"],
		[".github/workflows/dev-ci.yml\tneeds.gjc-state-gates-relevance.result", "closed result enum"],
		[".github/workflows/pr-validation.yml\tgithub.event.issue.number", "integer assigned by GitHub"],
		[".github/workflows/pr-validation.yml\tgithub.event.pull_request.base.sha", "40-hex, server-computed"],
		[".github/workflows/pr-validation.yml\tgithub.event.pull_request.head.repo.full_name", "repo name charset"],
		[".github/workflows/pr-validation.yml\tgithub.event.pull_request.head.sha", "40-hex, server-computed"],
		[".github/workflows/pr-validation.yml\tgithub.event.pull_request.number", "integer assigned by GitHub"],
		[".github/workflows/pr-validation.yml\tgithub.repository", "repo name charset"],
		[".github/workflows/pr-validation.yml\tgithub.run_id", "integer assigned by GitHub"],
		[".github/workflows/pr-validation.yml\tgithub.server_url", "fixed origin"],
		[".github/workflows/pr-validation.yml\tsteps.pr.outputs.base_sha", "from the event or the API, both 40-hex"],
		[".github/workflows/pr-validation.yml\tsteps.pr.outputs.head_sha", "from the event or the API, both 40-hex"],
		[".github/workflows/pr-validation.yml\tsteps.validate.outcome", "success|failure|cancelled|skipped"],
		[".github/workflows/pr-validation.yml\tsteps.validate.outputs.merge_authorized", "literal true|false written by the step above"],
	]);
	const files: string[] = [];
	for (const dir of ["../.github/workflows", "../.github/actions"]) {
		const root = new URL(dir, import.meta.url).pathname;
		if (!(await fs.stat(root).then(() => true).catch(() => false))) continue;
		for await (const found of new Glob("**/*.{yml,yaml}").scan({ cwd: root, absolute: true })) files.push(found);
	}
	files.sort();
	// A GHA expression contains `{` only inside a single-quoted literal, so skip those
	// and take the first `}}` outside a string. Anything unterminated is a failure, not
	// a skip — that is precisely how the brace bypass hid.
	const expressionsIn = (scalar: string): { found: string[]; unterminated: boolean } => {
		const found: string[] = [];
		for (let at = scalar.indexOf("${{"); at !== -1; at = scalar.indexOf("${{", at)) {
			let cursor = at + 3;
			let quoted = false;
			let end = -1;
			while (cursor < scalar.length) {
				const character = scalar[cursor];
				if (character === "'") quoted = !quoted;
				else if (!quoted && character === "}" && scalar[cursor + 1] === "}") {
					end = cursor;
					break;
				}
				cursor++;
			}
			if (end === -1) return { found, unterminated: true };
			found.push(scalar.slice(at + 3, end).trim());
			at = end + 2;
		}
		return { found, unterminated: false };
	};
	const shellScalars = (node: unknown, key?: string): string[] => {
		if (typeof node === "string") return key === "run" || key === "script" ? [node] : [];
		if (Array.isArray(node)) return node.flatMap((item) => shellScalars(item, key));
		if (node !== null && typeof node === "object") {
			return Object.entries(node).flatMap(([childKey, value]) => shellScalars(value, childKey));
		}
		return [];
	};
	const counts = new Map<string, number>();
	for (const file of files) {
		const relative = file.slice(file.indexOf("/.github/") + 1);
		const document = parse(await Bun.file(file).text()) as unknown;
		const found = shellScalars(document);
		counts.set(relative, found.length);
		for (const scalar of found) {
			const { found, unterminated } = expressionsIn(scalar);
			expect({ file: relative, unterminated }).toEqual({ file: relative, unterminated: false });
			for (const expression of found) {
				const scoped = justified.has(`${relative}\t${expression}`);
				expect({ file: relative, expression, justified: scoped }).toEqual({
					file: relative,
					expression,
					justified: true,
				});
			}
		}
	}
	// An AGGREGATE floor does not notice one file going silent: renaming every `run:`
	// key in pr-validation.yml — the file with `checks: write` — made it contribute
	// zero scalars while dev-ci.yml alone still cleared 100, and the guard stayed
	// green. So the floor is per file, and every known file must still be there.
	const expected = new Map<string, number>([
		[".github/actions/build-native/action.yml", 7],
		[".github/workflows/ci.yml", 33],
		[".github/workflows/dev-ci.yml", 73],
		[".github/workflows/pr-validation.yml", 7],
		[".github/workflows/public-site-sync.yml", 4],
		[".github/workflows/spoofed-version-sync.yml", 2],
	]);
	const missing = [...expected.keys()].filter((name) => !counts.has(name));
	expect({ missing }).toEqual({ missing: [] });
	for (const [name, minimum] of expected) {
		const seen = counts.get(name) ?? 0;
		expect({ name, atLeast: minimum, seen: seen >= minimum }).toEqual({ name, atLeast: minimum, seen: true });
	}
});

test("every env value bound from an expression is read as a quoted word (#5740 review)", async () => {
	// The injection guard forces untrusted text out of the expression layer and into
	// `env:`. That is only half of the rule. A shell that reads $PR_BODY unquoted, or
	// evals it, re-opens the identical class one layer down — the value is now a shell
	// word rather than shell source, but word splitting and globbing still act on it,
	// and `eval` promotes it straight back to source.
	//
	// Nothing enforced the second half, so this closes the class rather than the
	// instance. Today every use is already quoted; this keeps it that way.
	const files: string[] = [];
	for (const dir of ["../.github/workflows", "../.github/actions"]) {
		const root = new URL(dir, import.meta.url).pathname;
		if (!(await fs.stat(root).then(() => true).catch(() => false))) continue;
		for await (const found of new Glob("**/*.{yml,yaml}").scan({ cwd: root, absolute: true })) files.push(found);
	}
	files.sort();
	// Originally this classified which bindings were "author-controlled" by pattern.
	// That classification MISSED one: CI_DEV_CHANGED_PATHS carries the PR's own changed
	// file paths, which a contributor picks by adding a file. A rule that depends on me
	// correctly enumerating untrusted sources fails the moment I miss one, and I did.
	//
	// So there is no classification. EVERY env value bound from an expression must be
	// read as a quoted word. Nothing legitimately needs word splitting on one of these,
	// and the rule cannot be defeated by a source shape I failed to anticipate.
	//
	// Discovery was ALSO lexical — a raw-text regex that only matched `NAME: ${{ ... }}`
	// at the start of a line. `env:` with a quoted key (`"NAME": ${{ ... }}`), a flow
	// mapping, or an alias was invisible, so a later `eval "$NAME"` was invisible too
	// (#5740 review). It now reads the same parsed YAML graph as the run-scalar guard.
	const envNames = (node: unknown, key?: string): string[] => {
		if (key === "env" && node !== null && typeof node === "object" && !Array.isArray(node)) {
			return Object.entries(node)
				.filter(([, value]) => typeof value === "string" && value.includes("${{"))
				.map(([name]) => name);
		}
		if (Array.isArray(node)) return node.flatMap((item) => envNames(item, key));
		if (node !== null && typeof node === "object") {
			return Object.entries(node).flatMap(([childKey, value]) => envNames(value, childKey));
		}
		return [];
	};
	const names = new Set<string>();
	for (const file of files) {
		for (const name of envNames(parse(await Bun.file(file).text()))) names.add(name);
	}
	// If this ever empties, the scan broke rather than the risk disappearing.
	expect(names.size).toBeGreaterThanOrEqual(70);
	let inspected = 0;
	for (const file of files) {
		const relative = file.slice(file.indexOf("/.github/") + 1);
		const lines = (await Bun.file(file).text()).split("\n");
		for (const [index, line] of lines.entries()) {
			for (const name of names) {
				if (new RegExp(`^\\s+${name}:`).test(line)) continue; // the binding itself
				for (const use of line.matchAll(new RegExp(`\\$\\{?${name}\\b`, "g"))) {
					inspected++;
					// Counting quotes on the line is not enough: `x="$(cmd "arg")"` resets
					// quoting inside the command substitution, and my first version
					// reported two real, correctly quoted uses as bare. A guard that
					// cries wolf gets deleted, so walk the shell contexts properly.
					const evaluated = /\beval\b/.test(line);
					const quoted = ((): boolean => {
						const stack: { double: boolean; single: boolean }[] = [{ double: false, single: false }];
						for (let at = 0; at < (use.index ?? 0); at++) {
							const top = stack[stack.length - 1];
							if (top === undefined) break;
							const character = line[at];
							if (character === "\\" && top.double) {
								at++;
								continue;
							}
							if (character === "'" && !top.double) top.single = !top.single;
							else if (character === '"' && !top.single) top.double = !top.double;
							else if (!top.single && character === "$" && line[at + 1] === "(") {
								stack.push({ double: false, single: false });
								at++;
							} else if (!top.single && character === ")" && stack.length > 1) stack.pop();
						}
						const top = stack[stack.length - 1];
						// Single quotes suppress expansion entirely, so they are safe too.
						return top !== undefined && (top.double || top.single);
					})();
					expect({ file: relative, line: index + 1, name, quoted, evaluated }).toEqual({
						file: relative,
						line: index + 1,
						name,
						quoted: true,
						evaluated: false,
					});
				}
			}
		}
	}
	expect(inspected).toBeGreaterThan(0);
});

// Parse a PowerShell body with PowerShell's own AST parser, without executing it.
// Returns "" when clean, or the parser's diagnostics. Mirrors the established pattern
// in scripts/install-tests/install-ps1-compat.test.ts.
const parsePowerShell = async (pwshPath: string, body: string): Promise<string> => {
	const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "gjc-pwsh-parse-")), "step.ps1");
	await Bun.write(file, body);
	const script = [
		"$errors = $null",
		`[System.Management.Automation.Language.Parser]::ParseFile('${file}', [ref]$null, [ref]$errors) | Out-Null`,
		"if ($errors -and $errors.Count -gt 0) { $errors | ForEach-Object { Write-Output $_.Message }; exit 1 }",
		"exit 0",
	].join("; ");
	const proc = Bun.spawn([pwshPath, "-NoProfile", "-Command", script], { stdout: "pipe", stderr: "pipe" });
	const [exitCode, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
	return exitCode === 0 ? "" : stdout.trim() || `PowerShell parser exited ${exitCode}`;
};

test("every run scalar is checked by the interpreter that will actually run it (#5740 review)", async () => {
	// YAML validity and TypeScript tests both passed while the Dev CI PR contract
	// bootstrap could not be parsed by bash at all. Two of my own prose comments
	// ("timeline's", "bootstrap's") sat inside a single-quoted `bun -e '...'`
	// argument; the apostrophe closed the quote and handed the rest of the JavaScript
	// to the shell. Every PR targeting dev failed that required job, and it stayed
	// hidden because pushing straight to dev never runs it. Nothing I had was capable
	// of noticing, because nothing asked bash. So ask bash.
	//
	// Getting to "which steps are bash" took three tries, each one assuming away a
	// case: first any non-`bash` shell string was silently skipped, then omitted was
	// taken to mean bash regardless of `defaults.run.shell`, and then regardless of
	// the RUNNER — but GitHub defaults an omitted shell to pwsh on Windows, and four
	// live jobs rely on that. bash -n was validating PowerShell and reporting success
	// (#5740 review).
	//
	// So the shell is now RESOLVED: step override, then nearest declared default,
	// then the platform default of each runner the job can expand to. Anything that
	// cannot be resolved fails rather than being assumed.
	const files: string[] = [];
	for (const dir of ["../.github/workflows", "../.github/actions"]) {
		const root = new URL(dir, import.meta.url).pathname;
		if (!(await fs.stat(root).then(() => true).catch(() => false))) continue;
		for await (const found of new Glob("**/*.{yml,yaml}").scan({ cwd: root, absolute: true })) files.push(found);
	}
	files.sort();
	type Step = { name?: string; run?: unknown; shell?: unknown };
	type Job = {
		"runs-on"?: unknown;
		strategy?: { matrix?: Record<string, unknown> };
		defaults?: { run?: { shell?: unknown } };
		steps?: unknown;
	};
	type Doc = { jobs?: Record<string, Job>; runs?: { steps?: unknown }; defaults?: { run?: { shell?: unknown } } };
	// Every runner label a job can expand to, or [] when that cannot be decided here.
	const runners = (job: Job): string[] => {
		const declared = job["runs-on"];
		const labels = typeof declared === "string" ? [declared] : Array.isArray(declared) ? declared : [];
		const concrete = labels.filter((label): label is string => typeof label === "string" && !label.includes("${{"));
		if (concrete.length > 0) return concrete;
		// `runs-on: ${{ matrix.os }}` — take the values the matrix actually declares.
		const matrix = job.strategy?.matrix ?? {};
		const direct = Array.isArray(matrix.os) ? matrix.os : [];
		const included = Array.isArray(matrix.include)
			? matrix.include.map((entry) => (entry as { os?: unknown }).os)
			: [];
		return [...direct, ...included].filter((value): value is string => typeof value === "string");
	};
	const platformShell = (runner: string): string => (/windows/i.test(runner) ? "pwsh" : "bash");
	const stepsOf = (node: unknown): Step[] => {
		if (!Array.isArray(node)) return [];
		return node.filter((entry): entry is Step => entry !== null && typeof entry === "object");
	};
	let checked = 0;
	const powershell: { file: string; unit: string; step: string; body: string }[] = [];
	for (const file of files) {
		const relative = file.slice(file.indexOf("/.github/") + 1);
		const document = parse(await Bun.file(file).text()) as Doc;
		const workflowDefault = document.defaults?.run?.shell;
		const units: { label: string; steps: Step[]; shells: string[] }[] = [];
		for (const [jobName, job] of Object.entries(document.jobs ?? {})) {
			const resolved = runners(job);
			// An unresolvable runner is a failure, not an assumption.
			expect({ file: relative, job: jobName, runnerResolved: resolved.length > 0 }).toEqual({
				file: relative,
				job: jobName,
				runnerResolved: true,
			});
			const declaredDefault = job.defaults?.run?.shell ?? workflowDefault;
			const shells =
				declaredDefault === undefined
					? [...new Set(resolved.map(platformShell))]
					: [String(declaredDefault)];
			units.push({ label: `job ${jobName}`, steps: stepsOf(job.steps), shells });
		}
		// A composite action has no runner context; GitHub requires an explicit shell
		// on every run step, so an omission there is itself the defect.
		if (document.runs?.steps !== undefined) units.push({ label: "composite", steps: stepsOf(document.runs.steps), shells: [] });
		for (const unit of units) {
			for (const step of unit.steps) {
				if (typeof step.run !== "string") continue;
				const where = { file: relative, unit: unit.label, step: step.name ?? "(unnamed)" };
				const effective =
					step.shell === undefined ? unit.shells : [typeof step.shell === "string" ? step.shell : JSON.stringify(step.shell)];
				expect({ ...where, shellResolved: effective.length > 0 }).toEqual({ ...where, shellResolved: true });
				for (const shell of effective) {
					if (shell === "pwsh" || shell === "powershell") {
						// Recognising pwsh is not validating it. The previous version counted
						// these and moved on, so the test's own name was false for eleven live
						// steps and a malformed PowerShell body kept both floors satisfied
						// (#5740 review). Parse them with PowerShell's own AST parser.
						powershell.push({ ...where, body: step.run });
						continue;
					}
					// Anything unrecognised is refused rather than skipped: a silent skip
					// is indistinguishable from approval.
					expect({ ...where, shell, recognised: shell === "bash" }).toEqual({ ...where, shell, recognised: true });
					checked++;
					const parsed = Bun.spawnSync(["bash", "-n"], { stdin: Buffer.from(step.run), stderr: "pipe" });
					const diagnostic = new TextDecoder().decode(parsed.stderr).trim().split("\n")[0] ?? "";
					expect({ ...where, parses: parsed.exitCode === 0, diagnostic: parsed.exitCode === 0 ? "" : diagnostic }).toEqual({
						...where,
						parses: true,
						diagnostic: "",
					});
				}
			}
		}
	}
	// Both dimensions pinned: a collapse in either means the resolver broke rather
	// than the workflows getting safer.
	expect({ bash: checked >= 95, pwsh: powershell.length >= 20 }).toEqual({ bash: true, pwsh: true });

	// PowerShell bodies are parsed by PowerShell. When pwsh is absent the guard says
	// so out loud rather than reporting success it did not earn -- GitHub's Linux
	// runners ship pwsh, so CI exercises this even though a mac dev box may not.
	const pwshPath = Bun.which("pwsh");
	if (pwshPath === null) {
		console.warn(`pwsh not installed: ${powershell.length} PowerShell run scalars were NOT syntax-checked`);
		return;
	}
	for (const candidate of powershell) {
		const diagnostics = await parsePowerShell(pwshPath, candidate.body);
		expect({ file: candidate.file, step: candidate.step, diagnostics }).toEqual({
			file: candidate.file,
			step: candidate.step,
			diagnostics: "",
		});
	}
});

test("the PowerShell parse helper surfaces diagnostics rather than swallowing them (#5740 review)", async () => {
	// pwsh is absent on this mac dev box, so the guard above skips its 23 bodies and
	// says so. That skip must not also hide a broken helper: if the plumbing were
	// wrong, the check would silently pass on CI too, where pwsh IS present.
	//
	// So exercise the helper against stub parsers with the real contract -- write the
	// body to a file, invoke the binary, map exit code and stdout -- and prove both
	// directions without needing PowerShell here.
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-pwsh-stub-"));
	const write = async (name: string, script: string): Promise<string> => {
		const file = path.join(directory, name);
		await Bun.write(file, script);
		await fs.chmod(file, 0o755);
		return file;
	};
	const clean = await write("clean", "#!/bin/sh\nexit 0\n");
	expect(await parsePowerShell(clean, "Write-Host 'ok'")).toBe("");

	const broken = await write("broken", "#!/bin/sh\necho 'Missing closing } in statement block.'\nexit 1\n");
	expect(await parsePowerShell(broken, "if ($x) { Write-Host 'x'")).toBe("Missing closing } in statement block.");

	// A parser that fails without printing must still be reported, not read as clean.
	const silent = await write("silent", "#!/bin/sh\nexit 7\n");
	expect(await parsePowerShell(silent, "whatever")).toBe("PowerShell parser exited 7");

	// And the body must actually reach the parser as a file it can read.
	const echoes = await write("echoes", "#!/bin/sh\nsed -n '2p' \"$(ls -t \"${TMPDIR:-/tmp}\"/gjc-pwsh-parse-*/step.ps1 | head -1)\"\nexit 1\n");
	expect(await parsePowerShell(echoes, "line one\nline two")).toBe("line two");
	await fs.rm(directory, { recursive: true, force: true });
});

test("issue_comment events cannot launch or cancel the affected Dev CI pipeline", async () => {
	const devCi = await Bun.file(new URL("../.github/workflows/dev-ci.yml", import.meta.url)).text();
	expect(devCi).not.toContain("issue_comment:");
});

test("trusted Bun launch cannot load an untrusted repo bunfig preload", async () => {
	const root = await Bun.file(new URL("../package.json", import.meta.url)).json() as { packageManager: string };
	expect(root.packageManager).toBe("bun@1.4.0");
	const temp = await fs.mkdtemp("/tmp/gjc-pr-bun-isolation-");
	try {
		const trusted = path.join(temp, "trusted");
		const untrusted = path.join(temp, "untrusted");
		const sentinel = path.join(temp, "preload-ran");
		await fs.mkdir(trusted, { recursive: true });
		await fs.mkdir(untrusted, { recursive: true });
		await Bun.write(path.join(untrusted, "bunfig.toml"), 'preload = ["./preload.ts"]\n');
		await Bun.write(path.join(untrusted, "preload.ts"), `await Bun.write(${JSON.stringify(sentinel)}, "pwned");\n`);
		await Bun.write(path.join(trusted, "empty.toml"), "# trusted empty Bun configuration\n");
		await Bun.write(path.join(trusted, "probe.ts"), 'console.log("trusted-probe");\n');
		const child = Bun.spawn([process.execPath, "--no-env-file", `--config=${path.join(trusted, "empty.toml")}`, path.join(trusted, "probe.ts")], {
			cwd: untrusted,
			env: { ...process.env, BUN_OPTIONS: "" },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
		expect(exitCode).toBe(0);
		expect(stdout).toContain("trusted-probe");
		expect(await Bun.file(sentinel).exists()).toBe(false);
	} finally {
		await fs.rm(temp, { recursive: true, force: true });
	}
});

test("a PR-authored workflow cannot become the trusted enforcement authority", async () => {
	const workflow = await Bun.file(new URL("../.github/workflows/pr-validation.yml", import.meta.url)).text();
	const spoofedHeadWorkflow = workflow.replace(
		'"$trusted_root/scripts/verify-pr-verdict.ts"',
		'"$repo_root/scripts/verify-pr-verdict.ts"',
	);
	// GitHub loads pull_request_target workflow bytes from the default branch, not from this PR diff.
	expect(workflow).toContain("pull_request_target:");
	expect(spoofedHeadWorkflow).toContain('"$repo_root/scripts/verify-pr-verdict.ts"');
	expect(workflow).not.toContain('"$repo_root/scripts/verify-pr-verdict.ts"');
});

test("template pins reviewer identity, exact diff digest, exactly-one risk classification, and the honest solo verdict", async () => {
	const template = await Bun.file(new URL("../.github/PULL_REQUEST_TEMPLATE.md", import.meta.url)).text();
	expect(template).toContain("reviewer-id:<identity>");
	expect(template).toContain("sha256:<exact-base...head-diff-hash>");
	expect(template).toContain("## Risk classification");
	expect(template).toContain("`low-risk`");
	expect(template).toContain("`regression-risk`");
	expect(template).toContain("`high-risk`");
	expect(template).toContain("extra:independent:<login>");
	expect(template).toContain("merge-self-approved");
	// The unauthenticated gpt-heavy token is gone from the template.
	expect(template).not.toContain("extra:gpt-heavy");
});

test("dev CI carries immutable inline first-landing bootstrap validation", async () => {
	const workflow = await Bun.file(new URL("../.github/workflows/dev-ci.yml", import.meta.url)).text();
	expect(workflow).toContain("pr-contract-bootstrap:");
	expect(workflow).toContain("name: PR contract bootstrap");
	expect(workflow).not.toContain("pull_request_review:");
	expect(workflow).toContain("if: ${{ github.event_name == 'pull_request' }}");
	// This pinned the MECHANISM (`-e '<program>'`) rather than the property. That exact
	// mechanism was the defect: an apostrophe in the JavaScript closed the shell quote
	// and broke the job for every PR to dev. The property that matters is that the
	// trusted program runs with the contributor's environment and bunfig neutralised.
	expect(workflow).toContain("bun --no-env-file --config=\"$empty_bunfig\"");
	// A quoted heredoc keeps the shell and JavaScript grammars apart; an unquoted one
	// would expand `$` and backticks out of the program before Bun ever saw it.
	expect(workflow).toContain("cat > \"$program\" <<'GJC_BOOTSTRAP_PROGRAM'");
	expect(workflow).toContain("repository: ${{ github.event.pull_request.head.repo.full_name }}");
	expect(workflow).toContain("bun scripts/verify-gjc-state-writers.ts --fail --root .");
	expect(workflow).toContain("Expected exactly one verdict line");
	expect(workflow).toContain("effective exact-head approval");
	expect(workflow).toContain("lacks repository review authority");
	expect(workflow).toContain("reviewPermission(reviewerId)");
	expect(workflow).toContain('review.state !== "COMMENTED" && review.commit_id === head');
	expect(workflow).not.toContain("pr-head/scripts/verify-pr-verdict.ts");
	// The universal invariant is restored in the mirror: merge-approved NEVER
	// accepts the author as reviewer (review major 1).
	expect(workflow).toContain("merge-approved cannot be self-approved: the reviewer must be distinct from the PR author");
	// The honest solo path is explicitly named and loudly logged (review major 1).
	expect(workflow).toContain("verdict === \"merge-self-approved\"");
	expect(workflow).toContain("SELF-AUTHORIZED: merge-self-approved, no independent human review");
	// Exactly one risk classification is mandatory (review major 3).
	expect(workflow).toContain("PR body must check exactly one risk classification; found ${bodyRiskLines.length}.");
	// The unauthenticated gpt-heavy token is gone from the mirror's record grammar.
	expect(workflow).not.toContain("gpt-heavy");
	// Bootstrap/canonical parity: the mirror rejects duplicate-record,
	// multi-signature, and missing-footer comments exactly like the canonical parser.
	expect(workflow).toContain("exactly one record, signature, and footer line");
	expect(workflow).toContain('footerLines = lines.filter(line => line === "Signed-off-by: gaebal-gajae (clawdbot) 🦞")');
	expect(workflow).toContain("/issues/${Bun.env.PR_NUMBER}/comments");
	expect(workflow).toContain("gajae.pr-self-review.v1.signature-domain");
	expect(workflow).toContain("Self-review is stale: base/head/digest do not match this exact PR");
	expect(workflow).toContain("not the repository owner");
	expect(workflow).toContain("does not match the PR body risk classification");
});

test("the merge-approval gate is a separate, fail-closed check in both workflows", async () => {
	const prContract = await Bun.file(new URL("../.github/workflows/pr-validation.yml", import.meta.url)).text();
	const devCi = await Bun.file(new URL("../.github/workflows/dev-ci.yml", import.meta.url)).text();
	// The contract check keeps its required context name and now reports contract
	// validity alone; the approval verdict travels as a job output.
	expect(prContract).toContain("name: Validate exact-head PR contract");
	expect(prContract).toContain("--gate contract");
	expect(prContract).toContain("merge_authorized: ${{ steps.validate.outputs.merge_authorized }}");
	expect(prContract).toContain("name: Merge approval");
	expect(prContract).toContain('-f name="Merge approval"');
	expect(devCi).toContain("name: PR contract bootstrap");
	expect(devCi).toContain("name: Merge approval bootstrap");
	expect(devCi).toContain("merge_authorized: ${{ steps.contract.outputs['gjc-merge-authorized'] }}");
	expect(devCi).toContain("gjc-merge-authorized=${mergeAuthorized}");
	// The pending-approval branch no longer aborts the bootstrap job; every other
	// failure in that script is still a throw that fails the CONTRACT check.
	expect(devCi).not.toContain("throw new Error(`Verdict ${verdict} intentionally blocks merge.`)");
	expect(devCi).toContain("Verdict ${verdict} intentionally blocks merge.");
	expect(devCi).toContain("throw new Error(`Stale verdict digest");
	expect(devCi).toContain("merge-approved cannot be self-approved");
	// Fail closed on a skipped/failed/cancelled upstream job. GitHub reports a SKIPPED
	// job as Success for required checks, so `needs:` alone would publish a green
	// approval check for a red contract; always() plus an explicit result test cannot.
	expect(prContract).toContain("needs: [validate]");
	expect(devCi).toContain("needs: [pr-contract-bootstrap]");
	for (const [workflow, guard] of [[prContract, "if: ${{ always() }}"], [devCi, "if: ${{ always() && github.event_name == 'pull_request' }}"]] as const) {
		expect(workflow).toContain(guard);
		expect(workflow).toContain('if [[ "${CONTRACT_RESULT:-}" != "success" ]]; then');
		expect(workflow).toContain('if [[ "${MERGE_AUTHORIZED:-}" != "true" ]]; then');
		expect(workflow).toContain("https://docs.github.com/en/pull-requests/reference/status-checks");
	}
});

test("review events cannot launch or cancel the affected Dev CI pipeline", async () => {
	const devCi = await Bun.file(new URL("../.github/workflows/dev-ci.yml", import.meta.url)).text();
	const prContract = await Bun.file(new URL("../.github/workflows/pr-validation.yml", import.meta.url)).text();
	expect(devCi).not.toContain("pull_request_review:");
	expect(prContract).toContain("pull_request_review:");
	expect(prContract).toContain("types: [submitted, edited, dismissed]");
	expect(prContract).not.toContain("affected-plan");
	expect(prContract).not.toContain("evidence producer");
});
