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
	concurrency?: { group: string; "cancel-in-progress"?: string | boolean };
	steps: WorkflowStep[];
}

interface WorkflowDocument {
	on: { workflow_dispatch: { inputs: Record<string, unknown> } };
	concurrency?: { group: string };
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

	test("keeps the guard in the required aggregate with a fail-closed scoped check", async () => {
		const d = await workflow();
		const guard = requiredJob(d, "telegram-daemon-generation");
		const guardCondition = String(guard.if);
		expect(guardCondition).toContain("telegram-daemon");
		expect(guardCondition).toContain("chat-daemon");
		expect(guardCondition).toContain("telegram-daemon-generation-guard.ts");
		const affected = requiredJob(d, "affected");
		expect(affected.needs).toContain("telegram-daemon-generation");
		const aggregateStep = namedStep(affected, "Validate live affected aggregate");
		expect(requiredEnvValue(affected, "CI_DEV_TELEGRAM_GUARD_RESULT")).toBe("${{ needs.telegram-daemon-generation.result }}");
		expect(requiredEnvValue(affected, "CI_DEV_TELEGRAM_GUARD_REQUIRED")).toContain("telegram-daemon-generation-guard.ts");
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
		expect(windowsContract.run).toContain("provider owner state contains transport authority");
		expect(windowsContract.run).toContain("constructing or restarting provider transport cannot mutate session lifecycle");
	});

	test("keeps affected validation pinned while reserving an explicit virtual-integration dispatch head", async () => {
		const d = await workflow();
		const dispatchInputs = Object.keys(d.on.workflow_dispatch.inputs);
		expect(dispatchInputs).toEqual(["base_ref", "base_sha", "base_repository", "head_sha", "base_sha_override"]);
		expect(dispatchInputs).not.toContain("head_ref");
		expect(dispatchInputs).not.toContain("head_repository");

		const guard = requiredJob(d, "telegram-daemon-generation");
		// Dispatch validation binds the guard head to inputs.head_sha; PR/push runs use
		// their event source.
		expect(requiredEnvValue(guard, "GITHUB_HEAD_SHA")).toContain("github.sha");
		expect(requiredEnvValue(guard, "HEAD_REF")).not.toContain("inputs.head_ref");
		expect(requiredEnvValue(guard, "HEAD_REPOSITORY")).not.toContain("inputs.head_repository");

		const guardRef = checkoutRef(guard.steps);
		const plan = requiredJob(d, "affected-plan");
		const planRef = checkoutRef(plan.steps);
		// The guard checks out the exact same event-specific source expression as the planner.
		expect(guardRef).toBe(
			"${{ github.event_name == 'workflow_dispatch' && inputs.head_sha || github.event_name == 'pull_request' && github.event.pull_request.head.sha || github.sha }}",
		);
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
	test("binds stable virtual integration admission to an authoritative terminal-green base", async () => {
		const d = await workflow();
		const virtual = requiredJob(d, "virtual-integration");
		expect(virtual.needs).toEqual(["affected-plan", "affected"]);
		expect(virtual.if).toBe("${{ always() && ((github.event_name == 'pull_request' && needs.affected.result == 'success') || (github.event_name == 'workflow_dispatch' && inputs.head_sha != '')) }}");
		expect(requiredEnvValue(virtual, "CI_VI_HEAD_SHA")).toBe("${{ github.event_name == 'pull_request' && github.event.pull_request.head.sha || inputs.head_sha }}");
		expect(requiredEnvValue(virtual, "CI_VI_REQUIRED")).toBe("${{ github.event_name == 'workflow_dispatch' && 'true' || needs.affected-plan.outputs.has_risk_canaries }}");
		// The base is no longer pinned to the stale event base at the job level;
		// it is selected per-step from the authoritative terminal-green dev push.
		expect(virtual.env).not.toHaveProperty("CI_VI_BASE_SHA");
		const source = await Bun.file(".github/workflows/dev-ci.yml").text();
		// Every candidate must serialize: each one selects a dev base and materializes
		// a merge, so concurrent runs could validate incompatible integration states.
		// Candidates must serialize on one non-cancelling lane with schema-valid keys
		// only: GitHub Actions concurrency has exactly `group` and
		// `cancel-in-progress`; unknown keys make the workflow fail actionlint.
		expect(source).toContain("group: dev-ci-virtual-integration\n      cancel-in-progress: false");
		expect(d.concurrency?.group).not.toContain("'dev-ci-virtual-integration'");
		expect(source).toContain("format('dev-ci-dispatch-{0}', github.run_id)");
		expect(source).not.toMatch(/^\s+queue:/m);
		expect(source).toContain("Select authoritative terminal-green dev base");
		expect(source).toContain("bun scripts/ci-virtual-integration.ts --select-base");
		expect(source).toContain("CI_VI_BASE_SHA: ${{ steps.green-dev.outputs.base_sha }}");
		expect(source).toContain("No authoritative terminal-green dev base selected");
		expect(source).toContain("Provision pinned Rust toolchain for canary native build");
		expect(source).toContain("toolchain: nightly-2026-04-29");
		expect(source).toContain("Run risk-selected canaries in the materialized merge");
	});

	// Regression for the shared Windows CI blocker seen on PRs #3423/#3422/#3325 and
	// the #3424/#3425/#3426/#3428 burst: `bun test <path>` only treats the argument as
	// a path when it resolves; otherwise Bun silently degrades it to a *name filter*,
	// matches zero files, and exits 1 with
	//   note: To treat the "<path>" filter as a path, run "bun test ./<path>"
	// On Windows runners the bare relative form failed to resolve, so
	// `resident-cache-win32-gate.windows.test.ts` (added by #3344, 1439fd109) turned
	// every affected PR red for a reason unrelated to its own diff. The `./` prefix
	// forces unambiguous path interpretation on every platform.
	//
	// This pins the invariant for all workflow test invocations, not just the one that
	// broke, so the next added Windows step cannot reintroduce the same class of
	// failure. A bare-path invocation is also silently *wrong* rather than loud: a
	// filter that matches nothing can pass locally on Linux and fail only on Windows.
	test("every workflow bun test invocation addresses files by explicit relative path", async () => {
		const source = await Bun.file(".github/workflows/dev-ci.yml").text();
		const offenders: string[] = [];
		for (const rawLine of source.split(/\r?\n/)) {
			const line = rawLine.trim();
			if (!line.startsWith("bun test ")) continue;
			const [firstArg] = line.slice("bun test ".length).trim().split(/\s+/);
			if (!firstArg || firstArg.startsWith("-")) continue; // whole-suite or flag-only run
			if (firstArg.startsWith("./") || firstArg.startsWith("$")) continue;
			offenders.push(line);
		}
		expect(offenders).toEqual([]);
	});
	test("every workflow bun test invocation is guarded by its own exit-code check", async () => {
		const source = await Bun.file(".github/workflows/dev-ci.yml").text();
		const lines = source.split(/\r?\n/).map(line => line.trim());
		const offenders: string[] = [];
		for (let index = 0; index < lines.length; index++) {
			if (!lines[index]!.startsWith("bun test ")) continue;
			const next = lines[index + 1] ?? "";
			// A `pwsh` run block must check $LASTEXITCODE right after each bun test;
			// otherwise a failure is masked by the next invocation overwriting it.
			if (next !== "if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }") offenders.push(lines[index]!);
		}
		expect(offenders).toEqual([]);
	});
	test("builds and restores Linux native addons before GJC state-gate shards", async () => {
		const d = await workflow();
		const native = requiredJob(d, "gjc-state-gates-native");
		const matrix = requiredJob(d, "gjc-state-gates-matrix");
		expect(native.steps.some(step => step.uses?.includes("actions/checkout"))).toBe(true);
		expect(native.steps.some(step => step.uses?.includes("dtolnay/rust-toolchain"))).toBe(true);
		const build = namedStep(native, "Build required Linux native addon variants");
		expect(build.run).toBe("bun run ci:build:native");
		expect(requiredEnvValue(build, "TARGET_PLATFORM")).toBe("linux");
		expect(requiredEnvValue(build, "TARGET_ARCH")).toBe("x64");
		expect(requiredEnvValue(build, "TARGET_VARIANTS")).toBe("baseline modern");
		const verify = namedStep(native, "Verify required native addon variants");
		expect(verify.run).toContain("pi_natives.linux-x64-baseline.node");
		expect(verify.run).toContain("pi_natives.linux-x64-modern.node");
		const upload = namedStep(native, "Upload state-gate native addon(s)");
		expect(upload.with?.name).toBe("dev-state-gates-native-${{ github.run_id }}");
		expect(matrix.needs).toEqual(["gjc-state-gates-native"]);
		const download = namedStep(matrix, "Download state-gate native addon(s)");
		expect(download.with?.name).toBe("dev-state-gates-native-${{ github.run_id }}");
		expect(download.with?.path).toBe("packages/natives/native");
		const matrixVerify = namedStep(matrix, "Verify state-gate native addon variants");
		expect(matrixVerify.run).toContain("pi_natives.linux-x64-baseline.node");
		expect(matrixVerify.run).toContain("pi_natives.linux-x64-modern.node");
	});
	test("virtual integration serializes every merge candidate without cancellation", async () => {
		const d = await workflow();
		const virtual = requiredJob(d, "virtual-integration");
		const raw = virtual.concurrency;
		expect(raw).toBeDefined();
		expect(raw!.group).toBe("dev-ci-virtual-integration");
		expect(raw!["cancel-in-progress"]).toBe(false);
		// Regression for the dev workflow_dispatch zero-step "Virtual integration
		// validation" terminal-red incident burst (runs 33025650533..33038420275):
		// the job block previously carried an unsupported `queue: max` key that is
		// outside GitHub Actions' documented concurrency schema and made every
		// static workflow gate fail. Concurrency admits only group +
		// cancel-in-progress; queue depth is platform-controlled.
		expect(Object.keys(raw!).sort()).toEqual(["cancel-in-progress", "group"]);
	});
});
