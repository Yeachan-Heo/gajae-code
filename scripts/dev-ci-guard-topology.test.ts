import { describe, expect, test } from "bun:test";
import { parse } from "yaml";

// The dev-ci workflow wires the Telegram daemon generation guard into the sharded
// aggregate. These assertions pin the exact-revision + fail-closed topology so a
// future edit cannot (a) resurrect the removed Windows notification atomicity
// gate, (b) let a manual workflow_dispatch validate a different commit in the
// guard than the planner/shards test, or (c) drop the guard from the required
// aggregate.
interface WorkflowStep {
	name?: string;
	uses?: string;
	run?: string;
	env?: Record<string, string>;
	with?: Record<string, string | number>;
}

interface WorkflowJob {
	needs?: string[];
	if?: string;
	env?: Record<string, string>;
	permissions?: Record<string, string>;
	concurrency?: { group?: string; "cancel-in-progress"?: boolean };
	steps: WorkflowStep[];
}


interface WorkflowDocument {
	on: { workflow_dispatch: { inputs: Record<string, unknown> } };
	jobs: Record<string, WorkflowJob>;
}

async function workflow(): Promise<WorkflowDocument> {
	return parse(await Bun.file(".github/workflows/dev-ci.yml").text()) as WorkflowDocument;
}

function namedStep(job: WorkflowJob, name: string): WorkflowStep {
	const step = job.steps.find(candidate => candidate.name === name);
	if (!step) throw new Error(`Missing workflow step: ${name}`);
	return step;
}

function checkoutRef(steps: WorkflowStep[]): string | number | undefined {
	return steps.find(step => typeof step.uses === "string" && step.uses.includes("actions/checkout"))?.with?.ref;
}

function checkoutStep(steps: WorkflowStep[]): WorkflowStep {
	const step = steps.find(candidate => typeof candidate.uses === "string" && candidate.uses.includes("actions/checkout"));
	if (!step) throw new Error("Missing checkout step");
	return step;
}
function requiredJob(document: WorkflowDocument, name: string): WorkflowJob {
	const job = document.jobs[name];
	if (!job) throw new Error(`Missing workflow job: ${name}`);
	return job;
}

function requiredEnv(value: WorkflowJob | WorkflowStep): Record<string, string> {
	if (!value.env) throw new Error("Missing workflow environment");
	return value.env;
}
function requiredEnvValue(value: WorkflowJob | WorkflowStep, key: string): string {
	const result = requiredEnv(value)[key];
	if (result === undefined) throw new Error(`Missing workflow environment value: ${key}`);
	return result;
}



describe("dev-ci Telegram daemon generation guard topology", () => {
	test("does not resurrect the removed Windows notification atomicity gate", async () => {
		const raw = await Bun.file(".github/workflows/dev-ci.yml").text();
		expect(raw).not.toMatch(/notification-atomic-windows/);
		expect(raw).not.toMatch(/windows_atomic/);
		expect(raw).not.toMatch(/atomicity/i);
		const d = await workflow();
		expect(Object.keys(d.jobs)).not.toContain("notification-atomic-windows");
		expect(requiredJob(d, "affected").needs).not.toContain("notification-atomic-windows");
	});

	test("keeps the guard in the required aggregate with a fail-closed check", async () => {
		const d = await workflow();
		const affected = requiredJob(d, "affected");
		expect(affected.needs).toContain("telegram-daemon-generation");
		const aggregateStep = namedStep(affected, "Validate live affected aggregate");
		expect(requiredEnvValue(affected, "CI_DEV_TELEGRAM_GUARD_RESULT")).toBe("${{ needs.telegram-daemon-generation.result }}");
		expect(requiredEnvValue(affected, "CI_DEV_TELEGRAM_GUARD_REQUIRED")).toBe("${{ needs.affected-plan.outputs.relevant }}");
		expect(aggregateStep.run).toContain("--validate-aggregate");
		expect(requiredEnvValue(aggregateStep, "CI_DEV_AFFECTED_PLAN")).toBe(
			"${{ runner.temp }}/ci-dev-affected-evidence/.ci-dev-affected-plan.json",
		);
	});

	test("requires Windows daemon safety for chat control and Telegram daemon paths, and never accepts a required skip", async () => {
		const d = await workflow();
		const safety = requiredJob(d, "windows-telegram-daemon-safety");
		const condition = String(safety.if);
		expect(condition).toContain("chat-daemon-control.ts");
		expect(condition).toContain("daemon-control.test.ts");
		expect(condition).toContain("notifications-telegram-daemon.test.ts");
		expect(condition).toContain("telegram-daemon");
		expect(condition).toContain("packages/coding-agent/src/sdk/broker/process-incarnation.ts");
		const affected = requiredJob(d, "affected");
		const aggregateStep = namedStep(affected, "Validate live affected aggregate");
		expect(requiredEnvValue(affected, "CI_DEV_TELEGRAM_WINDOWS_RESULT")).toBe("${{ needs.windows-telegram-daemon-safety.result }}");
		expect(requiredEnvValue(affected, "CI_DEV_TELEGRAM_WINDOWS_REQUIRED")).toContain("chat-daemon-control.ts");
		expect(requiredEnvValue(affected, "CI_DEV_TELEGRAM_WINDOWS_REQUIRED")).toContain("daemon-control.test.ts");
		expect(requiredEnvValue(affected, "CI_DEV_TELEGRAM_WINDOWS_REQUIRED")).toContain("notifications-telegram-daemon.test.ts");
		expect(requiredEnvValue(affected, "CI_DEV_TELEGRAM_WINDOWS_REQUIRED")).toContain(
			"packages/coding-agent/src/sdk/broker/process-incarnation.ts",
		);
		const evidenceProducer = requiredJob(d, "affected-evidence-producer");
		const evidenceStep = namedStep(evidenceProducer, "Produce affected evidence");
		expect(requiredEnvValue(evidenceStep, "CI_DEV_TELEGRAM_WINDOWS_REQUIRED")).toContain(
			"packages/coding-agent/src/sdk/broker/process-incarnation.ts",
		);
		expect(aggregateStep.run).toContain("--validate-aggregate");
		const windowsContract = namedStep(safety, "Run Windows daemon provenance safety contract");
		expect(windowsContract.run).toContain("--test-name-pattern");
		expect(windowsContract.run).toContain("incarnation|captured-owner|owner-lock");
		expect(windowsContract.run).toContain("heartbeat fails closed");
		expect(windowsContract.run).toContain("Windows production preflight");
		expect(windowsContract.run).toContain("parent-format|transition lock");
		expect(windowsContract.run).toContain("runDaemonInternal rewrites persisted owner pid");
	});

	test("validates the same requested commit in the guard, planner, and shards (no arbitrary dispatch head)", async () => {
		const d = await workflow();
		// The explicit dispatch HEAD input is reserved for virtual integration; the guard
		// still pins the planner/shards source to github.sha and never reads it.
		const dispatchInputs = Object.keys(d.on.workflow_dispatch.inputs);
		expect(dispatchInputs).toEqual(["base_ref", "base_sha", "base_repository", "head_sha", "base_sha_override"]);
		expect(dispatchInputs).not.toContain("head_ref");
		expect(dispatchInputs).not.toContain("head_repository");


		const guard = requiredJob(d, "telegram-daemon-generation");
		// The guard head SHA never reads inputs.head_sha; for push/dispatch it is
		// github.sha — exactly the source the planner checks out.
		expect(requiredEnvValue(guard, "GITHUB_HEAD_SHA")).not.toContain("inputs.head_sha");
		expect(requiredEnvValue(guard, "GITHUB_HEAD_SHA")).toContain("github.sha");
		expect(requiredEnvValue(guard, "HEAD_REF")).not.toContain("inputs.head_ref");
		expect(requiredEnvValue(guard, "HEAD_REPOSITORY")).not.toContain("inputs.head_repository");

		const guardRef = checkoutRef(guard.steps);
		const plan = requiredJob(d, "affected-plan");
		const planRef = checkoutRef(plan.steps);
		// The guard checks out the exact same source expression as the planner, so a
		// push/workflow_dispatch validates github.sha in both, and a PR validates the PR
		// head in both — never divergent revisions.
		expect(guardRef).toBe("${{ github.event.pull_request.head.sha || github.sha }}");
		expect(guardRef).toBe(planRef);
		// The guard's authority head SHA tracks that same source.
		expect(requiredEnvValue(guard, "GITHUB_HEAD_SHA")).toContain("github.event.pull_request.head.sha");
		expect(requiredEnvValue(guard, "GITHUB_HEAD_SHA")).toContain("github.sha");

		const baseExpression = "${{ github.event_name == 'pull_request' && github.event.pull_request.base.sha || github.event_name == 'workflow_dispatch' && inputs.base_sha || github.event.before }}";
		// All consumers of the affected plan use the identical event-specific base
		// expression. In particular, dispatch cannot plan/shard one range while the
		// daemon guard validates another.
		expect(requiredEnvValue(guard, "GITHUB_BASE_SHA")).toBe(baseExpression);
		expect(requiredEnvValue(plan, "GITHUB_BASE_SHA")).toBe(baseExpression);
		const shard = requiredJob(d, "affected-shards");
		const shardRun = namedStep(shard, "Run affected task shard");
		expect(requiredEnvValue(shardRun, "GITHUB_BASE_SHA")).toBe(baseExpression);

		const authorityFetch = namedStep(guard, "Fetch and prove authoritative guard revisions").run;
		expect(authorityFetch).toContain('workflow_dispatch)');
		expect(authorityFetch).toContain('refs/heads/${BASE_REF}:refs/remotes/guard-base/${BASE_REF}');
		expect(authorityFetch).toContain('[[ "${base_ref_sha}" == "${GITHUB_BASE_SHA}" ]]');
		expect(authorityFetch).toContain('GUARD_BASE_REF_SHA=${base_ref_sha}');
		// PR authority remains pinned to the immutable queued event object, not a
		// mutable base branch ref.
		expect(authorityFetch).toContain('pull_request)');
		expect(authorityFetch).toContain('guard-base "${GITHUB_BASE_SHA}"');
		expect(checkoutStep(guard.steps).with?.["fetch-depth"]).toBe(0);
		expect(authorityFetch).not.toContain("--depth");
	});
});

describe("virtual integration job topology (issue #3350)", () => {
	test("pins the exact head and serializes the integration job", async () => {
		const d = await workflow();
		const job = requiredJob(d, "virtual-integration");
		expect(job.if).toBe("${{ github.event_name == 'workflow_dispatch' && inputs.head_sha != '' }}");
		expect(job.concurrency).toEqual({ group: "dev-ci-virtual-integration", "cancel-in-progress": false });
		expect(job.permissions).toEqual({ contents: "read", actions: "read" });
		expect(requiredEnvValue(job, "CI_VI_HEAD_SHA")).toBe("${{ inputs.head_sha }}");
		expect(requiredEnvValue(job, "CI_VI_BASE_SHA_OVERRIDE")).toBe("${{ inputs.base_sha_override }}");
		expect(checkoutStep(job.steps).with?.ref).toBe("${{ inputs.head_sha }}");
		const verify = namedStep(job, "Verify checked-out source head");
		expect(verify.run).toContain("git rev-parse HEAD");
		expect(verify.run).toContain("$CI_VI_HEAD_SHA");
	});

	test("isolates head_sha dispatches from the ordinary graph", async () => {
		const d = await workflow();
		const exclusion = "!(github.event_name == 'workflow_dispatch' && inputs.head_sha != '')";
		const ordinaryRoots = Object.entries(d.jobs)
			.filter(([name, job]) => name !== "virtual-integration" && !job.needs)
			.map(([name]) => name);
		expect(ordinaryRoots).toEqual(["affected-plan", "gjc-state-gates-matrix"]);
		for (const name of ordinaryRoots) expect(requiredJob(d, name).if).toContain(exclusion);
		expect(requiredJob(d, "virtual-integration").if).not.toContain(exclusion);
		for (const name of ["affected-evidence-producer", "affected", "gjc-state-gates"])
			expect(requiredJob(d, name).if).toContain(exclusion);
	});

	test("fails closed without retry-ish or continue-on-error behavior", async () => {
		const d = await workflow();
		const job = requiredJob(d, "virtual-integration");
		const serialized = JSON.stringify(job);
		expect(job.steps.some(step => Object.prototype.hasOwnProperty.call(step, "continue-on-error"))).toBe(false);
		expect(serialized).not.toContain("continue-on-error");
		expect(serialized).not.toMatch(/\b(?:sleep|retry)\b/i);
	});

	test("stays opt-in per merge candidate and validates only the virtual integration canaries", async () => {
		const d = await workflow();
		// head_sha is optional so ordinary dispatch runs skip the job entirely; the
		// job's own `if` is what requires it, keeping cost bounded.
		const headInput = d.on.workflow_dispatch.inputs.head_sha as { required?: boolean } | undefined;
		expect(headInput?.required).toBe(false);
		const overrideInput = d.on.workflow_dispatch.inputs.base_sha_override as { required?: boolean } | undefined;
		expect(overrideInput?.required).toBe(false);
		const job = requiredJob(d, "virtual-integration");
		expect(namedStep(job, "Validate virtual integration").run).toBe("bun scripts/ci-virtual-integration.ts --validate");
		const canaryStep = namedStep(job, "Run risk-selected canaries");
		expect(canaryStep.run).toBe("bun scripts/ci-virtual-integration.ts --run-canaries");
		expect(requiredEnvValue(canaryStep, "CI_VI_BASE_SHA")).toBe("${{ steps.green-dev.outputs.base_sha }}");
		expect(requiredEnvValue(canaryStep, "CI_VI_BASE_RUN_ID")).toBe("${{ steps.green-dev.outputs.base_run_id }}");
		expect(JSON.stringify(canaryStep)).not.toContain("JSON.parse");
		const serialized = JSON.stringify(job);
		expect(serialized).not.toContain('JSON.parse(await Bun.file(".ci-virtual-integration.json").text())');
		expect(serialized).not.toContain("scripts/ci-dev-affected.ts --matrix-json");
	});
});
