import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as url from "node:url";
import {
	canonicalDiffSha256,
	parseBodyRisk,
	parseGhPrCreate,
	parsePrVerdict,
	parseSelfReview,
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
	expect(root.packageManager).toBe("bun@1.3.14");
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
