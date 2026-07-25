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
			".github/workflows/public-site-sync.yml",
		]);
	});

	test("ci.yml has an exact read-scoped workflow default and one write job", async () => {
		const workflows = await readWorkflowDocuments();
		const ci = workflows.find(workflow => workflow.file === CI_WORKFLOW);
		expect(ci).toBeDefined();
		const document = documentRecord(ci!.document);

		expect(REQUIRED_READ_DEFAULT).toContain(CI_WORKFLOW);
		expect(document.permissions).toEqual({ contents: "read" });
		expect(JOB_WRITE_ALLOWLIST).toEqual([{ workflow: CI_WORKFLOW, job: "publish", scope: "contents" }]);
		expect(jobWriteScopes(document)).toEqual(["publish.contents"]);
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
		expect(violation.message).toContain('only job "publish"');
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
});
