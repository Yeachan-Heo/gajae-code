#!/usr/bin/env bun
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parse } from "yaml";

const repoRoot = path.join(import.meta.dir, "..");
const workflowDir = path.join(repoRoot, ".github", "workflows");

export interface PermissionViolation {
	workflow: string;
	job?: string;
	path: string;
	actual: string;
	expected: string;
	message: string;
}

export interface WorkflowInput {
	file: string;
	document: unknown;
}

export const JOB_WRITE_ALLOWLIST: readonly { workflow: string; job: string; scope: string }[] = [
	{ workflow: ".github/workflows/ci.yml", job: "publish", scope: "contents" },
];

export const REQUIRED_READ_DEFAULT: readonly string[] = [
	".github/workflows/ci.yml",
	".github/workflows/dev-ci.yml",
	".github/workflows/public-site-sync.yml",
];

const EXPECTED_WORKFLOW_DEFAULT = "an explicit least-privilege permissions block";
const EXPECTED_SCOPE_VALUE = '"read", "write", or "none"';
const EXPECTED_NON_WRITE_SCOPE = '"read" or "none"';
const EXPECTED_PERMISSION_VALUE = '"read-all" or a permissions mapping';
const JOB_WRITE_ALLOWLIST_NOTE = 'only job "publish" in .github/workflows/ci.yml may hold contents: write';

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: RecordValue, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(value, key);
}

function displayValue(value: unknown): string {
	if (typeof value === "string") return JSON.stringify(value);
	if (value === null) return "null";
	if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
	try {
		return String(value);
	} catch {
		return "<unprintable>";
	}
}

function isAllowlisted(workflow: string, job: string, scope: string): boolean {
	return JOB_WRITE_ALLOWLIST.some(entry => entry.workflow === workflow && entry.job === job && entry.scope === scope);
}

function workflowViolation(
	violations: PermissionViolation[],
	workflow: string,
	permissionPath: string,
	actual: string,
	expected: string,
): void {
	violations.push({
		workflow,
		path: permissionPath,
		actual,
		expected,
		message: `${workflow}: ${permissionPath} = ${actual} (expected ${expected})`,
	});
}

function jobViolation(
	violations: PermissionViolation[],
	workflow: string,
	job: string,
	permissionPath: string,
	actual: string,
	expected: string,
): void {
	violations.push({
		workflow,
		job,
		path: permissionPath,
		actual,
		expected,
		message: `${workflow}: job "${job}": ${permissionPath} = ${actual} (expected ${expected}; ${JOB_WRITE_ALLOWLIST_NOTE})`,
	});
}

function hasViolationAt(violations: PermissionViolation[], workflow: string, permissionPath: string): boolean {
	return violations.some(violation => violation.workflow === workflow && violation.path === permissionPath);
}

function evaluateScopeMapping(
	violations: PermissionViolation[],
	workflow: string,
	permissions: RecordValue,
	pathPrefix: string,
	job: string | undefined,
	requiredReadDefault: boolean,
): void {
	for (const [scope, value] of Object.entries(permissions)) {
		const permissionPath = `${pathPrefix}.${scope}`;
		// On a required workflow default, every non-`contents` scope is forbidden
		// outright; the exact-mapping pass below owns that path's single diagnostic.
		if (requiredReadDefault && job === undefined && scope !== "contents") continue;
		if (value === "write") {
			if (job === undefined || !isAllowlisted(workflow, job, scope)) {
				// Required workflows must be exactly `contents: read`, so "none" is not a
				// valid remediation for them even though it is a non-write value.
				const writeExpected = requiredReadDefault && job === undefined && scope === "contents" ? displayValue("read") : EXPECTED_NON_WRITE_SCOPE;
				if (job === undefined) {
					workflowViolation(violations, workflow, permissionPath, displayValue(value), writeExpected);
				} else {
					jobViolation(violations, workflow, job, permissionPath, displayValue(value), writeExpected);
				}
			}
			continue;
		}
		if (value === "read" || value === "none") continue;

		const expected = requiredReadDefault && job === undefined && scope === "contents" ? displayValue("read") : EXPECTED_SCOPE_VALUE;
		const actual = displayValue(value);
		if (job === undefined) {
			workflowViolation(violations, workflow, permissionPath, actual, expected);
		} else {
			jobViolation(violations, workflow, job, permissionPath, actual, expected);
		}
	}
}

function evaluateWorkflowDefault(
	violations: PermissionViolation[],
	workflow: string,
	document: RecordValue | undefined,
): void {
	const permissions = document && hasOwn(document, "permissions") ? document.permissions : undefined;
	if (permissions === undefined || permissions === null) {
		workflowViolation(violations, workflow, "permissions", "<absent>", EXPECTED_WORKFLOW_DEFAULT);
		return;
	}

	const requiredReadDefault = REQUIRED_READ_DEFAULT.includes(workflow);
	if (permissions === "write-all") {
		workflowViolation(violations, workflow, "permissions", displayValue(permissions), EXPECTED_PERMISSION_VALUE);
	} else if (permissions === "read-all") {
		// read-all is non-writing, but required workflows still need an exact contents default.
	} else if (isRecord(permissions)) {
		evaluateScopeMapping(violations, workflow, permissions, "permissions", undefined, requiredReadDefault);
	} else {
		workflowViolation(violations, workflow, "permissions", displayValue(permissions), EXPECTED_PERMISSION_VALUE);
	}

	if (requiredReadDefault && !hasViolationAt(violations, workflow, "permissions.contents")) {
		const hasContents = isRecord(permissions) && hasOwn(permissions, "contents");
		const contents = hasContents ? permissions.contents : undefined;
		if (contents !== "read") {
			workflowViolation(violations, workflow, "permissions.contents", hasContents ? displayValue(contents) : "<absent>", displayValue("read"));
		}
	}

	// Required workflows must carry exactly `contents: read` -- extra read/none
	// scopes are still a privilege expansion over the least-privilege default.
	if (requiredReadDefault && isRecord(permissions)) {
		for (const scope of Object.keys(permissions)) {
			if (scope === "contents") continue;
			workflowViolation(violations, workflow, `permissions.${scope}`, displayValue(permissions[scope]), "<absent>; required workflows declare exactly contents: read");
		}
	}
}

function evaluateJobPermissions(violations: PermissionViolation[], workflow: string, document: RecordValue | undefined): void {
	if (!document || !hasOwn(document, "jobs")) return;

	const jobs = document.jobs;
	if (!isRecord(jobs)) {
		workflowViolation(violations, workflow, "jobs", displayValue(jobs), "a jobs mapping");
		return;
	}

	for (const [job, jobValue] of Object.entries(jobs)) {
		if (!isRecord(jobValue)) {
			jobViolation(violations, workflow, job, `jobs.${job}`, displayValue(jobValue), "a job mapping");
			continue;
		}
		if (!hasOwn(jobValue, "permissions")) continue;

		const permissions = jobValue.permissions;
		const permissionPath = `jobs.${job}.permissions`;
		if (permissions === undefined || permissions === null) {
			jobViolation(violations, workflow, job, permissionPath, displayValue(permissions), EXPECTED_PERMISSION_VALUE);
		} else if (permissions === "write-all") {
			jobViolation(violations, workflow, job, permissionPath, displayValue(permissions), EXPECTED_PERMISSION_VALUE);
		} else if (permissions === "read-all") {
			// read-all is accepted as a non-writing job override.
		} else if (isRecord(permissions)) {
			evaluateScopeMapping(violations, workflow, permissions, permissionPath, job, false);
		} else {
			jobViolation(violations, workflow, job, permissionPath, displayValue(permissions), EXPECTED_PERMISSION_VALUE);
		}
	}
}

export function evaluateWorkflowPermissions(workflows: readonly WorkflowInput[]): PermissionViolation[] {
	const violations: PermissionViolation[] = [];
	for (const workflow of workflows) {
		const document = isRecord(workflow.document) ? workflow.document : undefined;
		evaluateWorkflowDefault(violations, workflow.file, document);
		evaluateJobPermissions(violations, workflow.file, document);
	}
	return violations;
}

export async function readWorkflowDocuments(): Promise<WorkflowInput[]> {
	const entries = await fs.readdir(workflowDir, { withFileTypes: true });
	const workflowFiles = entries
		.filter(entry => entry.isFile() && /\.ya?ml$/i.test(entry.name))
		.map(entry => entry.name)
		.sort((left, right) => left.localeCompare(right));

	return Promise.all(
		workflowFiles.map(async fileName => {
			const absolutePath = path.join(workflowDir, fileName);
			const file = path.relative(repoRoot, absolutePath).split(path.sep).join("/");
			const document = parse(await fs.readFile(absolutePath, "utf8"));
			return { file, document };
		}),
	);
}

if (import.meta.main) {
	const workflows = await readWorkflowDocuments();
	const violations = evaluateWorkflowPermissions(workflows);
	if (violations.length > 0) {
		for (const violation of violations) console.error(violation.message);
		process.exitCode = 1;
	} else {
		for (const workflow of workflows) console.log(`ok ${workflow.file}`);
	}
}
