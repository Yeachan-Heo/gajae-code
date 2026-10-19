import { describe, expect, test } from "bun:test";
import { parse } from "yaml";
import {
	JOB_WRITE_ALLOWLIST,
	REQUIRED_READ_DEFAULT,
	evaluateWorkflowPermissions,
	readWorkflowDocuments,
} from "./check-workflow-permissions";

const CI_WORKFLOW = ".github/workflows/ci.yml";
const DEV_CI_WORKFLOW = ".github/workflows/dev-ci.yml";
const SPOOFED_VERSION_WORKFLOW = ".github/workflows/spoofed-version-sync.yml";
const RE_REVIEW_WORKFLOW = ".github/workflows/re-review.yml";

const repoRoot = `${import.meta.dir}/..`;

async function parsedWorkflow(file: string): Promise<Record<string, unknown>> {
	return parse(await Bun.file(`${repoRoot}/${file}`).text()) as Record<string, unknown>;
}

function documentRecord(value: unknown): Record<string, unknown> {
	return value as Record<string, unknown>;
}

function jobWriteScopes(document: Record<string, unknown>): string[] {
	const jobs = documentRecord(document.jobs);
	return Object.entries(jobs).flatMap(([job, value]) => {
		const permissions = documentRecord(value).permissions;
		if (typeof permissions !== "object" || permissions === null || Array.isArray(permissions)) return [];
		return Object.entries(permissions as Record<string, unknown>)
			.filter(([, scope]) => scope === "write")
			.map(([scope]) => `${job}.${scope}`);
	});
}

describe("workflow permission policy", () => {
	test("committed workflows satisfy the default-deny evaluator", async () => {
		const workflows = await readWorkflowDocuments();
		expect(evaluateWorkflowPermissions(workflows)).toEqual([]);
		expect(workflows.map(workflow => workflow.file)).toEqual([
			".github/workflows/ci.yml",
			".github/workflows/dev-ci.yml",
			".github/workflows/native-bench-ab.yml",
			".github/workflows/public-site-sync.yml",
			".github/workflows/re-review.yml",
			".github/workflows/spoofed-version-sync.yml",
		]);
	});

	test("ci.yml has an exact read-scoped workflow default and two write jobs", async () => {
		const workflows = await readWorkflowDocuments();
		const ci = workflows.find(workflow => workflow.file === CI_WORKFLOW);
		expect(ci).toBeDefined();
		const document = documentRecord(ci!.document);

		expect(REQUIRED_READ_DEFAULT).toContain(CI_WORKFLOW);
		expect(document.permissions).toEqual({ contents: "read" });
		// The full allowlist is exact so no additional write scope can be silently approved.
		expect(JOB_WRITE_ALLOWLIST).toEqual([
			{ workflow: CI_WORKFLOW, job: "release_finalize", scope: "contents" },
			{ workflow: CI_WORKFLOW, job: "publish", scope: "id-token" },
			{ workflow: RE_REVIEW_WORKFLOW, job: "request-review-on-comment", scope: "pull-requests" },
			{ workflow: RE_REVIEW_WORKFLOW, job: "request-review-on-comment", scope: "issues" },
		]);
		expect(jobWriteScopes(document)).toEqual(["publish.id-token", "release_finalize.contents"]);
	});

	test("dev-ci.yml has an exact read-scoped workflow default and no write job scope", async () => {
		const workflows = await readWorkflowDocuments();
		const devCi = workflows.find(workflow => workflow.file === DEV_CI_WORKFLOW);
		expect(devCi).toBeDefined();
		const document = documentRecord(devCi!.document);

		expect(REQUIRED_READ_DEFAULT).toContain(DEV_CI_WORKFLOW);
		expect(document.permissions).toEqual({ contents: "read" });
		expect(jobWriteScopes(document)).toEqual([]);
	});

	test("spoofed-version-sync.yml detects drift with no write scope anywhere", async () => {
		const workflows = await readWorkflowDocuments();
		const spoofedVersion = workflows.find(workflow => workflow.file === SPOOFED_VERSION_WORKFLOW);
		expect(spoofedVersion).toBeDefined();
		const document = documentRecord(spoofedVersion!.document);

		// The scheduled drift check reports; it never pushes a branch or opens a
		// pull request. dev requires an approving maintainer review, so write
		// scopes here could not remove the human step they would be bought for.
		expect(REQUIRED_READ_DEFAULT).toContain(SPOOFED_VERSION_WORKFLOW);
		expect(document.permissions).toEqual({ contents: "read" });
		expect(jobWriteScopes(document)).toEqual([]);
		expect(JOB_WRITE_ALLOWLIST.some(entry => entry.workflow === SPOOFED_VERSION_WORKFLOW)).toBe(false);
	});

	test("native-bench-ab.yml has an exact read-scoped workflow default and no write job scope", async () => {
		const workflows = await readWorkflowDocuments();
		const nativeBench = workflows.find(workflow => workflow.file === ".github/workflows/native-bench-ab.yml");
		expect(nativeBench).toBeDefined();
		const document = documentRecord(nativeBench!.document);

		expect(document.permissions).toEqual({ contents: "read" });
		expect(jobWriteScopes(document)).toEqual([]);
	});

	test("detects a ci.yml workflow contents write mutation", async () => {
		const source = await parsedWorkflow(CI_WORKFLOW);
		const document = structuredClone(source);
		const permissions = documentRecord(document.permissions);
		permissions.contents = "write";

		const violations = evaluateWorkflowPermissions([{ file: CI_WORKFLOW, document }]);
		expect(violations).toHaveLength(1);
		const violation = violations[0]!;
		// The remediation must name the exact required value; "none" is rejected too.
		expect(violation).toMatchObject({ path: "permissions.contents", actual: '"write"', expected: '"read"', workflow: CI_WORKFLOW });
		expect(violation.message).toContain(CI_WORKFLOW);
		expect(violation.message).toContain("permissions.contents");
		expect(violation.message).not.toContain("none");
	});

	test("detects a ci.yml check job contents write mutation", async () => {
		const source = await parsedWorkflow(CI_WORKFLOW);
		const document = structuredClone(source);
		const jobs = documentRecord(document.jobs);
		const check = documentRecord(jobs.check);
		check.permissions = { contents: "write" };

		const violations = evaluateWorkflowPermissions([{ file: CI_WORKFLOW, document }]);
		expect(violations).toHaveLength(1);
		const violation = violations[0]!;
		// Job scopes keep the generic non-write remediation plus the allowlist note.
		expect(violation).toMatchObject({
			path: "jobs.check.permissions.contents",
			actual: '"write"',
			expected: '"read" or "none"',
			workflow: CI_WORKFLOW,
			job: "check",
		});
		expect(violation.message).toContain(CI_WORKFLOW);
		expect(violation.message).toContain("check");
		expect(violation.message).toContain("jobs.check.permissions.contents");
		expect(violation.message).toContain('only jobs "release_finalize"');
	});

	test("detects a ci.yml check job write-all mutation", async () => {
		const source = await parsedWorkflow(CI_WORKFLOW);
		const document = structuredClone(source);
		documentRecord(documentRecord(document.jobs).check).permissions = "write-all";

		const violations = evaluateWorkflowPermissions([{ file: CI_WORKFLOW, document }]);
		const violation = violations.find(candidate => candidate.path === "jobs.check.permissions");
		expect(violation).toBeDefined();
		expect(violation).toMatchObject({ actual: '"write-all"', workflow: CI_WORKFLOW, job: "check" });
		expect(violation!.message).toContain(CI_WORKFLOW);
		expect(violation!.message).toContain("check");
		expect(violation!.message).toContain("jobs.check.permissions");
	});

	test("detects a non-mapping jobs mutation", async () => {
		const source = await parsedWorkflow(CI_WORKFLOW);
		const document = structuredClone(source);
		document.jobs = null;

		const violations = evaluateWorkflowPermissions([{ file: CI_WORKFLOW, document }]);
		const violation = violations.find(candidate => candidate.path === "jobs");
		expect(violation).toBeDefined();
		expect(violation).toMatchObject({ actual: "null", workflow: CI_WORKFLOW, expected: "a jobs mapping" });
	});

	test("detects a non-mapping job mutation", async () => {
		const source = await parsedWorkflow(CI_WORKFLOW);
		const document = structuredClone(source);
		documentRecord(document.jobs).check = null;

		const violations = evaluateWorkflowPermissions([{ file: CI_WORKFLOW, document }]);
		const violation = violations.find(candidate => candidate.path === "jobs.check");
		expect(violation).toBeDefined();
		expect(violation).toMatchObject({ actual: "null", workflow: CI_WORKFLOW, job: "check", expected: "a job mapping" });
	});

	test("detects a ci.yml workflow write-all mutation", async () => {
		const source = await parsedWorkflow(CI_WORKFLOW);
		const document = structuredClone(source);
		document.permissions = "write-all";

		const violations = evaluateWorkflowPermissions([{ file: CI_WORKFLOW, document }]);
		expect(violations.length).toBeGreaterThan(0);
		expect(violations.some(violation => violation.message.includes(CI_WORKFLOW))).toBe(true);
		expect(violations.some(violation => violation.message.includes("permissions"))).toBe(true);
		expect(violations.some(violation => violation.message.includes("write-all"))).toBe(true);
	});

	test("requires exact contents read for a required workflow permissions mapping", async () => {
		const source = await parsedWorkflow(DEV_CI_WORKFLOW);
		const document = structuredClone(source);
		document.permissions = { contents: "none" };

		const violations = evaluateWorkflowPermissions([{ file: DEV_CI_WORKFLOW, document }]);
		const violation = violations.find(candidate => candidate.path === "permissions.contents");
		expect(violation).toBeDefined();
		expect(violation).toMatchObject({ actual: '"none"', workflow: DEV_CI_WORKFLOW, expected: '"read"' });
	});

	test("requires exact contents read for a required workflow read-all default", async () => {
		const source = await parsedWorkflow(DEV_CI_WORKFLOW);
		const document = structuredClone(source);
		document.permissions = "read-all";

		const violations = evaluateWorkflowPermissions([{ file: DEV_CI_WORKFLOW, document }]);
		const violation = violations.find(candidate => candidate.path === "permissions.contents");
		expect(violation).toBeDefined();
		expect(violation).toMatchObject({ actual: "<absent>", workflow: DEV_CI_WORKFLOW, expected: '"read"' });
	});

	test("rejects an extra read scope on a required workflow default", async () => {
		const source = await parsedWorkflow(DEV_CI_WORKFLOW);
		const document = structuredClone(source);
		document.permissions = { contents: "read", actions: "read" };

		const violations = evaluateWorkflowPermissions([{ file: DEV_CI_WORKFLOW, document }]);
		expect(violations).toHaveLength(1);
		expect(violations[0]).toMatchObject({ path: "permissions.actions", actual: '"read"', workflow: DEV_CI_WORKFLOW });
		expect(violations[0]?.message).toContain(DEV_CI_WORKFLOW);
		expect(violations[0]?.message).toContain("permissions.actions");
	});

	test("reports one authoritative remediation per path for a write extra scope", async () => {
		const source = await parsedWorkflow(DEV_CI_WORKFLOW);
		const document = structuredClone(source);
		document.permissions = { contents: "write", actions: "write" };

		const violations = evaluateWorkflowPermissions([{ file: DEV_CI_WORKFLOW, document }]);
		// Each offending path gets exactly one non-contradictory expectation.
		expect(violations).toHaveLength(2);
		expect(violations.map(violation => violation.path)).toEqual(["permissions.contents", "permissions.actions"]);
		expect(violations[0]).toMatchObject({ path: "permissions.contents", actual: '"write"', expected: '"read"' });
		expect(violations[1]?.path).toBe("permissions.actions");
		expect(violations[1]?.expected).toContain("<absent>");
		expect(violations[1]?.expected).not.toContain('"read" or "none"');
	});

	test("detects a deleted dev-ci.yml workflow permissions block", async () => {
		const source = await parsedWorkflow(DEV_CI_WORKFLOW);
		const document = structuredClone(source);
		delete document.permissions;

		const violations = evaluateWorkflowPermissions([{ file: DEV_CI_WORKFLOW, document }]);
		expect(violations.length).toBeGreaterThan(0);
		expect(violations.some(violation => violation.message.includes(DEV_CI_WORKFLOW))).toBe(true);
	});

	test("allows the ci.yml publish permissions block to be removed", async () => {
		const source = await parsedWorkflow(CI_WORKFLOW);
		const document = structuredClone(source);
		delete documentRecord(documentRecord(document.jobs).publish).permissions;

		expect(evaluateWorkflowPermissions([{ file: CI_WORKFLOW, document }])).toEqual([]);
	});

	test("re-review.yml has workflow-level default-deny and job-level write permissions", async () => {
		const workflows = await readWorkflowDocuments();
		const reReview = workflows.find(workflow => workflow.file === RE_REVIEW_WORKFLOW);
		expect(reReview).toBeDefined();
		const document = documentRecord(reReview!.document);

		// Workflow-level permissions must be default-deny (empty permissions object)
		expect(document.permissions).toEqual({});

		// Job must have the required write permissions
		const jobs = documentRecord(document.jobs);
		const requestReviewOnComment = documentRecord(jobs["request-review-on-comment"]);
		const jobPermissions = documentRecord(requestReviewOnComment.permissions);
		expect(jobPermissions["pull-requests"]).toBe("write");
		expect(jobPermissions.issues).toBe("write");

		// Verify the workflow is NOT in the required read default list
		// (it uses job-level permissions instead of workflow-level)
		expect(!REQUIRED_READ_DEFAULT.includes(RE_REVIEW_WORKFLOW)).toBe(true);
	});

	test("skips deleted-author and PR-author reviews while discovering other reviewers", async () => {
		const source = await parsedWorkflow(RE_REVIEW_WORKFLOW);
		const jobs = documentRecord(source.jobs);
		const steps = documentRecord(jobs["request-review-on-comment"]).steps as unknown[];
		const getReviewers = steps.map(documentRecord).find(step => step.id === "get-reviewers");
		const reviewerScript = documentRecord(documentRecord(getReviewers).with).script as string;
		const helper = reviewerScript.match(/function latestReviewByUser\(reviews, prAuthor\) \{[\s\S]*?^\}/m);
		expect(helper).not.toBeNull();

		type Review = {
			user: { login: string; type: string } | null;
			state: string;
			submitted_at: string;
		};
		const createLatestReviewByUser = new Function(
			`${helper?.[0]}\nreturn latestReviewByUser;`,
		) as () => (reviews: Review[], prAuthor: string | undefined) => Map<string, Review>;
		const latestReviewByUser = createLatestReviewByUser();

		const selected = latestReviewByUser([
			{ user: null, state: "COMMENTED", submitted_at: "2026-10-13T00:00:00Z" },
			{
				user: { login: "pr-author", type: "User" },
				state: "COMMENTED",
				submitted_at: "2026-10-13T00:00:30Z",
			},
			{
				user: { login: "eligible-reviewer", type: "User" },
				state: "COMMENTED",
				submitted_at: "2026-10-13T00:01:00Z",
			},
		], "pr-author");

		expect([...selected.keys()]).toEqual(["eligible-reviewer"]);
	});

	test("uses chronological API order when review timestamps tie", async () => {
		const source = await parsedWorkflow(RE_REVIEW_WORKFLOW);
		const jobs = documentRecord(source.jobs);
		const steps = documentRecord(jobs["request-review-on-comment"]).steps as unknown[];
		const getReviewers = steps.map(documentRecord).find(step => step.id === "get-reviewers");
		const reviewerScript = documentRecord(documentRecord(getReviewers).with).script as string;
		const helper = reviewerScript.match(/function latestReviewByUser\(reviews, prAuthor\) \{[\s\S]*?^\}/m);
		expect(helper).not.toBeNull();

		type Review = {
			user: { login: string; type: string } | null;
			state: string;
			submitted_at: string;
		};
		const createLatestReviewByUser = new Function(
			`${helper?.[0]}\nreturn latestReviewByUser;`,
		) as () => (reviews: Review[], prAuthor: string | undefined) => Map<string, Review>;
		const latestReviewByUser = createLatestReviewByUser();
		const submittedAt = "2026-10-13T00:00:00Z";
		const cases: Array<{ reviews: Review[]; expectedState: string }> = [
			{
				reviews: [
					{ user: { login: "reviewer", type: "User" }, state: "COMMENTED", submitted_at: submittedAt },
					{ user: { login: "reviewer", type: "User" }, state: "APPROVED", submitted_at: submittedAt },
				],
				expectedState: "APPROVED",
			},
			{
				reviews: [
					{ user: { login: "reviewer", type: "User" }, state: "APPROVED", submitted_at: submittedAt },
					{ user: { login: "reviewer", type: "User" }, state: "CHANGES_REQUESTED", submitted_at: submittedAt },
				],
				expectedState: "CHANGES_REQUESTED",
			},
		];

		for (const { reviews, expectedState } of cases) {
			expect(latestReviewByUser(reviews, undefined).get("reviewer")?.state).toBe(expectedState);
		}
	});

	test("requires the exact command and allows maintainers when the PR author is deleted", async () => {
		const source = await parsedWorkflow(RE_REVIEW_WORKFLOW);
		const jobs = documentRecord(source.jobs);
		const steps = documentRecord(jobs["request-review-on-comment"]).steps as unknown[];
		const authorizeStep = steps.map(documentRecord).find(step => step.id === "authorize");
		const authorizeScript = documentRecord(documentRecord(authorizeStep).with).script as string;

		type GithubStub = {
			rest: {
				pulls: {
					get: (params: { owner: string; repo: string; pull_number: number }) => Promise<{ data: { user: null } }>;
				};
				repos: {
					getCollaboratorPermissionLevel: (params: { owner: string; repo: string; username: string }) => Promise<{ data: { permission: string } }>;
				};
			};
		};
		let pullRequestLookups = 0;
		let collaboratorError: (Error & { status: number }) | null = null;
		const github: GithubStub = {
			rest: {
				pulls: {
					get: async () => {
						pullRequestLookups += 1;
						return { data: { user: null } };
			},
			},
				repos: {
					getCollaboratorPermissionLevel: async () => {
						if (collaboratorError) {
							throw collaboratorError;
						}
						return { data: { permission: "write" } };
					},
				},
			},
		};
		const context = {
			payload: {
				comment: { user: { login: "maintainer" }, body: "/re-review" },
				issue: { pull_request: { url: "https://api.github.com/repos/Yeachan-Heo/gajae-code/pulls/6599" } },
			},
			repo: { owner: "Yeachan-Heo", repo: "gajae-code" },
			issue: { number: 6599 },
		};
		const executeAuthorizationStep = new Function(
			"github",
			"context",
			`return (async () => { ${authorizeScript} })();`,
		) as (github: GithubStub, ctx: typeof context) => Promise<string>;

		expect(await executeAuthorizationStep(github, context)).toBe("authorized");
		const unrelatedPrefixContext = {
			...context,
			payload: {
				...context.payload,
				comment: { ...context.payload.comment, body: "/re-reviewplease" },
			},
		};
		expect(await executeAuthorizationStep(github, unrelatedPrefixContext)).toBe("no-match");
		expect(pullRequestLookups).toBe(1);

		collaboratorError = Object.assign(new Error("Not Found"), { status: 404 });
		expect(await executeAuthorizationStep(github, context)).toBe("unauthorized");
		collaboratorError = Object.assign(new Error("Internal Server Error"), { status: 500 });
		await expect(executeAuthorizationStep(github, context)).rejects.toBe(collaboratorError);
	});

	test("re-review filters to requestable reviewers and passes reviewer data through the environment", async () => {
		const source = await parsedWorkflow(RE_REVIEW_WORKFLOW);
		const jobs = documentRecord(source.jobs);
		const steps = documentRecord(jobs["request-review-on-comment"]).steps as unknown[];
		const stepWithId = (id: string) => steps.map(documentRecord).find(step => step.id === id);
		const authorizationStep = documentRecord(stepWithId("authorize"));
		const reviewerSelectionStep = documentRecord(stepWithId("get-reviewers"));
		const reviewerScript = documentRecord(documentRecord(stepWithId("get-reviewers")).with).script as string;
		const requestStep = documentRecord(stepWithId("request-reviewers"));
		const requestScript = documentRecord(requestStep.with).script as string;

		expect(documentRecord(authorizationStep.with)["result-encoding"]).toBe("string");
		expect(documentRecord(reviewerSelectionStep.with)["result-encoding"]).toBe("string");
		expect(reviewerScript).toContain("getCollaboratorPermissionLevel");
		expect(reviewerScript).toContain("canRequestReviewer(collaborator.data.permission)");
		expect(reviewerScript).toContain("eligibleReviewers.push(reviewer)");
		expect(reviewerScript).toContain("return JSON.stringify(eligibleReviewers)");
		expect(requestStep.env).toEqual({ REVIEWERS_JSON: "${{ steps.get-reviewers.outputs.result }}" });
		expect(requestScript).toContain("JSON.parse(process.env.REVIEWERS_JSON)");
		expect(requestScript).not.toContain("${{");
		expect(requestScript).toContain("github.rest.pulls.requestReviewers");
		expect(requestScript).not.toContain("requested_reviewers/rerequest");
	});

	test("documents the default-branch activation point for issue_comment workflows", async () => {
		const contributing = await Bun.file(`${repoRoot}/CONTRIBUTING.md`).text();
		expect(contributing).toContain("default branch, `main`");
		expect(contributing).toContain("Merging this PR to `dev` alone does not activate `/re-review`");
	});

	test("allows re-requesting reviewers with read and triage access", async () => {
		const source = await parsedWorkflow(RE_REVIEW_WORKFLOW);
		const jobs = documentRecord(source.jobs);
		const steps = documentRecord(jobs["request-review-on-comment"]).steps as unknown[];
		const getReviewers = steps.map(documentRecord).find(step => step.id === "get-reviewers");
		const reviewerScript = documentRecord(documentRecord(getReviewers).with).script as string;
		const helper = reviewerScript.match(/function canRequestReviewer\(permission\) \{[\s\S]*?^\}/m);
		expect(helper).not.toBeNull();

		const createCanRequestReviewer = new Function(
			`${helper?.[0]}\nreturn canRequestReviewer;`,
		) as () => (permission: string) => boolean;
		const canRequestReviewer = createCanRequestReviewer();

		expect(canRequestReviewer("read")).toBe(true);
		expect(canRequestReviewer("triage")).toBe(true);
		expect(canRequestReviewer("none")).toBe(false);
	});

	type ReviewRequestParams = { owner: string; repo: string; pull_number: number; reviewers: string[] };
	type ReviewCommentParams = { owner: string; repo: string; issue_number: number; body: string };
	async function loadRequestStep() {
		const source = await parsedWorkflow(RE_REVIEW_WORKFLOW);
		const jobs = documentRecord(source.jobs);
		const steps = documentRecord(jobs["request-review-on-comment"]).steps as unknown[];
		const requestStep = steps.map(documentRecord).find(step => step.id === "request-reviewers");
		const requestScript = documentRecord(documentRecord(requestStep).with).script as string;
		return new Function("github", "context", "process", `return (async () => { ${requestScript} })();`) as (
			github: unknown,
			ctx: unknown,
			proc: unknown,
		) => Promise<void>;
	}
	const requestContext = { repo: { owner: "Yeachan-Heo", repo: "gajae-code" }, issue: { number: 6599 } };
	const requestProcess = { env: { REVIEWERS_JSON: '["previous-reviewer"]' } };

	test("re-requests previous reviewers through the standard review-request endpoint", async () => {
		const executeRequestStep = await loadRequestStep();
		const requests: ReviewRequestParams[] = [];
		const rawRoutes: string[] = [];
		const github = {
			rest: {
				pulls: {
					get: async ({ pull_number }: { pull_number: number }) => ({ data: { number: pull_number } }),
					requestReviewers: async (params: ReviewRequestParams) => {
						requests.push(params);
						return { status: 201 };
					},
				},
				issues: { createComment: async () => ({ status: 201 }) },
			},
			request: async (route: string) => {
				rawRoutes.push(route);
				return { status: 201 };
			},
		};

		await executeRequestStep(github, requestContext, requestProcess);

		expect(requests).toEqual([
			{ owner: "Yeachan-Heo", repo: "gajae-code", pull_number: 6599, reviewers: ["previous-reviewer"] },
		]);
		expect(rawRoutes).toEqual([]);
	});

	test("tells the commenter and fails the step when the review request is rejected", async () => {
		const executeRequestStep = await loadRequestStep();
		const comments: ReviewCommentParams[] = [];
		const rejection = Object.assign(new Error("Reviews may only be requested from collaborators"), { status: 422 });
		const github = {
			rest: {
				pulls: {
					get: async ({ pull_number }: { pull_number: number }) => ({ data: { number: pull_number } }),
					requestReviewers: async () => {
						throw rejection;
					},
				},
				issues: {
					createComment: async (params: ReviewCommentParams) => {
						comments.push(params);
						return { status: 201 };
					},
				},
			},
		};

		await expect(executeRequestStep(github, requestContext, requestProcess)).rejects.toBe(rejection);
		expect(comments).toHaveLength(1);
		expect(comments[0].issue_number).toBe(6599);
		expect(comments[0].body).toContain("Failed to re-request reviews");
		expect(comments[0].body).toContain("Reviews may only be requested from collaborators");
	});

	test("detects if re-review.yml has workflow-level write permissions instead of job-level", async () => {
		const source = await parsedWorkflow(RE_REVIEW_WORKFLOW);
		const document = structuredClone(source);
		document.permissions = { "pull-requests": "write", issues: "write" };

		const violations = evaluateWorkflowPermissions([{ file: RE_REVIEW_WORKFLOW, document }]);
		expect(violations.length).toBeGreaterThan(0);
		expect(violations.some(violation => violation.path.includes("permissions"))).toBe(true);
	});
});
