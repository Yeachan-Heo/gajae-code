import { describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as url from "node:url";
import {
	authenticatedApproval,
	canonicalDiffSha256,
	parseBodyRisk,
	parseGhPrCreate,
	parsePrVerdict,
	parseSelfReview,
	resolvePullRequestEvent,
	resolvePushedSourceTarget,
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

describe("pushed source host path containment", () => {
	const prefix = "packages/coding-agent/src/";

	test.each([
		"..\\outside.ts",
		"nested/..\\..\\outside.ts",
		"nested\\example.ts",
		"\\outside.ts",
		"C:\\outside.ts",
		"\\\\server\\share\\outside.ts",
	])("Windows rejects Git backslash filename %s before materialization", suffix => {
		expect(resolvePushedSourceTarget("C:\\scratch\\tree", prefix + suffix, path.win32)).toBeNull();
	});

	test.each([
		"carrier:unsafe.ts",
		"carrier.ts:unsafe.ts:$DATA",
		"directory:stream/unsafe.ts",
		"directory::$INDEX_ALLOCATION/unsafe.ts",
	])("Windows rejects NTFS stream syntax while POSIX preserves literal colons: %s", suffix => {
		const name = prefix + suffix;
		expect(resolvePushedSourceTarget("C:\\scratch\\tree", name, path.win32)).toBeNull();
		expect(resolvePushedSourceTarget("/scratch/tree", name, path.posix)).toBe(`/scratch/tree/${name}`);
	});

	test.each([
		"/packages/coding-agent/src/example.ts",
		"C:/packages/coding-agent/src/example.ts",
		"C:packages/coding-agent/src/example.ts",
		"packages\\coding-agent\\src\\example.ts",
		`${prefix}../outside.ts`,
		`${prefix}./example.ts`,
		`${prefix}/example.ts`,
		`${prefix}nested/../../outside.ts`,
		prefix,
	])("rejects noncanonical or out-of-scope Git path %s on either host", name => {
		expect(resolvePushedSourceTarget("C:\\scratch\\tree", name, path.win32)).toBeNull();
		expect(resolvePushedSourceTarget("/scratch/tree", name, path.posix)).toBeNull();
	});

	test("resolves valid nested source paths using the executing host semantics", () => {
		const name = `${prefix}nested/example.ts`;
		expect(resolvePushedSourceTarget("C:\\scratch\\tree", name, path.win32)).toBe("C:\\scratch\\tree\\packages\\coding-agent\\src\\nested\\example.ts");
		expect(resolvePushedSourceTarget("/scratch/tree", name, path.posix)).toBe(`/scratch/tree/${name}`);
		expect(resolvePushedSourceTarget("scratch", name)).toBe(path.resolve("scratch", name));
	});

	test("POSIX preserves literal backslashes rather than imposing Windows filename rules", () => {
		const name = `${prefix}..\\outside.ts`;
		expect(resolvePushedSourceTarget("/scratch/tree", name, path.posix)).toBe(`/scratch/tree/${name}`);
	});
});

describe("authenticated approval API evidence", () => {
	const event = { repository: { full_name: "owner/repo" }, pull_request: { number: 5416 } };
	const review = (state: string, commit = head) => ({ state, commit_id: commit, user: { login: "review-agent" } });

	test.each([
		{ name: "valid exact-head approval", reviews: [review("APPROVED")], permission: "write", approved: true },
		{ name: "changes requested after approval", reviews: [review("APPROVED"), review("CHANGES_REQUESTED")], permission: "write", approved: false },
		{ name: "dismissed approval", reviews: [review("APPROVED"), review("DISMISSED")], permission: "write", approved: false },
		{ name: "revoked collaborator permission", reviews: [review("APPROVED")], permission: "read", approved: false },
		{ name: "stale-head approval", reviews: [review("APPROVED", "d".repeat(40))], permission: "write", approved: false },
	])("$name", async scenario => {
		const requests: string[] = [];
		const originalFetch = globalThis.fetch;
		const replacement: typeof fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
			const endpoint = String(input);
			requests.push(endpoint);
			expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer test-token");
			if (endpoint === "https://api.github.com/repos/owner/repo/pulls/5416/reviews?per_page=100&page=1") return Response.json(scenario.reviews);
			if (endpoint === "https://api.github.com/repos/owner/repo/collaborators/review-agent/permission") return Response.json({ permission: scenario.permission });
			throw new Error(`Unexpected endpoint: ${endpoint}`);
		}, { preconnect: originalFetch.preconnect });
		const spy = vi.spyOn(globalThis, "fetch").mockImplementation(replacement);
		try {
			const approval = await authenticatedApproval(event, "review-agent", head, "test-token");
			expect(approval).toEqual(scenario.approved ? { login: "review-agent", headSha: head } : {});
			expect(validatePrContract(validInput({ authenticatedReviewerLogin: approval.login, authenticatedReviewHeadSha: approval.headSha })).ok).toBe(scenario.approved);
			expect(requests.length).toBe(scenario.name === "valid exact-head approval" || scenario.name === "revoked collaborator permission" ? 2 : 1);
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
		expect(validatePrContract(validInput({ body: resolved.pull_request?.body ?? "" })).ok).toBe(false);
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
		expect(validatePrContract(validInput({ body, requireMergeApproved: true })).diagnostics[0]).toContain("intentionally blocks merge");
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

	async function exactTreePreflight(kind: "needs-human" | "merge-blocked" | "merge-approved" | "stale" | "malformed" | "missing-risk" | "multiple-risk" | "bad-pushed-tree" | "export-ignore" | "export-subst" | "source-symlink" | "case-collision") {
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
			const badTree = kind === "bad-pushed-tree" || kind === "export-ignore" || kind === "export-subst" || kind === "case-collision";
			const pushedSource = kind === "export-subst" ? bad.replace("unsafe.json", "$Format:%H$.json") : badTree && kind !== "case-collision" ? bad : "export const value = 2;\n";
			await fs.writeFile(source, pushedSource);
			if (kind === "export-ignore" || kind === "export-subst") await fs.writeFile(path.join(repo, ".gitattributes"), `packages/coding-agent/src/example.ts ${kind}\n`);
			if (kind === "source-symlink") await fs.symlink("example.ts", path.join(path.dirname(source), "linked.ts"));
			runGit("add", ".");
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
		["multiple-risk", "found 2"], ["bad-pushed-tree", "fast gate"], ["source-symlink", "fast gate"], ["case-collision", "fast gate"],
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
	// A trusted base that predates self-review validation can never authorize.
	expect(workflow).toContain("predates self-review validation");
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
	expect(workflow).toContain("bun --no-env-file --config=\"$empty_bunfig\" -e '");
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

test("review events cannot launch or cancel the affected Dev CI pipeline", async () => {
	const devCi = await Bun.file(new URL("../.github/workflows/dev-ci.yml", import.meta.url)).text();
	const prContract = await Bun.file(new URL("../.github/workflows/pr-validation.yml", import.meta.url)).text();
	expect(devCi).not.toContain("pull_request_review:");
	expect(prContract).toContain("pull_request_review:");
	expect(prContract).toContain("types: [submitted, edited, dismissed]");
	expect(prContract).not.toContain("affected-plan");
	expect(prContract).not.toContain("evidence producer");
});
