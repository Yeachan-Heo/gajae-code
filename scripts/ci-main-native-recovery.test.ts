import { describe, expect, test } from "bun:test";
import { parse } from "yaml";

interface WorkflowStep {
	name?: string;
	id?: string;
	if?: string;
	uses?: string;
	run?: string;
	"continue-on-error"?: boolean;
	env?: Record<string, string>;
	with?: Record<string, string | number>;
}

interface WorkflowJob {
	name?: string;
	if?: string;
	needs?: string[];
	steps: WorkflowStep[];
}

interface WorkflowDocument {
	jobs: Record<string, WorkflowJob>;
}

const RUN_SCOPED_ARTIFACT = "main-native-${{ github.run_id }}";
const RESTORE_STEP = "Restore native addon(s) from this run";
const REBUILD_STEP = "Rebuild native addon(s) when this run's artifact has expired";

async function workflow(): Promise<WorkflowDocument> {
	return parse(await Bun.file(".github/workflows/ci.yml").text()) as WorkflowDocument;
}

function job(document: WorkflowDocument, name: string): WorkflowJob {
	const found = document.jobs[name];
	if (!found) throw new Error(`Missing workflow job: ${name}`);
	return found;
}

function step(target: WorkflowJob, name: string): WorkflowStep {
	const found = target.steps.find(candidate => candidate.name === name);
	if (!found) throw new Error(`Missing workflow step: ${name}`);
	return found;
}

// `main-native-<run_id>` is retained for one day because a normal run consumes it
// inside that same run. Re-running a run older than that finds no artifact, and
// before #5715 the shard and conformance lanes failed on the expired artifact even
// though the code under test was fine. The contract is: restore tolerantly, then
// rebuild the same variants from the same source when nothing was restored.
describe("main CI native addon recovery", () => {
	test("the shard lane restores tolerantly and rebuilds the same variants on a miss", async () => {
		const document = await workflow();
		const shards = job(document, "main_shards");
		const restore = step(shards, RESTORE_STEP);
		expect(restore["continue-on-error"]).toBe(true);
		expect(restore.if).toBe("${{ matrix.native }}");
		expect(restore.with?.name).toBe(RUN_SCOPED_ARTIFACT);
		expect(restore.with?.path).toBe("packages/natives/native");
		const rebuild = step(shards, REBUILD_STEP);
		// The rebuild is gated on the restore actually missing, so the normal path
		// never pays for a second native build.
		expect(restore.id).toBe("native_restore");
		expect(rebuild.if).toBe("${{ matrix.native && steps.native_restore.outcome == 'failure' }}");
		expect(rebuild.env).toMatchObject({ TARGET_PLATFORM: "linux", TARGET_ARCH: "x64", TARGET_VARIANTS: "baseline modern" });
		expect(rebuild.run).toContain("bun run ci:build:native");
	});

	test("the ACP conformance lane recovers the same way without a matrix gate", async () => {
		const document = await workflow();
		const conformance = job(document, "acp_conformance");
		const restore = step(conformance, RESTORE_STEP);
		expect(restore["continue-on-error"]).toBe(true);
		expect(restore.if).toBeUndefined();
		expect(restore.with?.name).toBe(RUN_SCOPED_ARTIFACT);
		const rebuild = step(conformance, REBUILD_STEP);
		expect(rebuild.if).toBe("${{ steps.native_restore.outcome == 'failure' }}");
		expect(rebuild.run).toContain("bun run ci:build:native");
	});

	test("every download of the run-scoped artifact is tolerant, so no lane hard-fails on expiry", async () => {
		const document = await workflow();
		const consumers: Array<{ job: string; step: string; tolerant: boolean }> = [];
		for (const [name, target] of Object.entries(document.jobs)) {
			for (const candidate of target.steps) {
				if (!candidate.uses?.includes("actions/download-artifact")) continue;
				if (candidate.with?.name !== RUN_SCOPED_ARTIFACT) continue;
				consumers.push({ job: name, step: candidate.name ?? "<unnamed>", tolerant: candidate["continue-on-error"] === true });
			}
		}
		expect(consumers).toEqual([
			{ job: "main_shards", step: RESTORE_STEP, tolerant: true },
			{ job: "acp_conformance", step: RESTORE_STEP, tolerant: true },
		]);
	});
});
