import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { STABLE_GITHUB_RELEASE_FINALIZATION_JOB_NAME } from "./release";

const repoRoot = path.join(import.meta.dir, "..");
const ciWorkflowPath = path.join(repoRoot, ".github/workflows/ci.yml");
const publicSiteWorkflowPath = path.join(repoRoot, ".github/workflows/public-site-sync.yml");
const releaseScriptPath = path.join(repoRoot, "scripts/release.ts");

async function workflow(): Promise<string> {
	return Bun.file(ciWorkflowPath).text();
}

async function publicSiteWorkflow(): Promise<string> {
	return Bun.file(publicSiteWorkflowPath).text();
}
function jobSection(workflowText: string, jobName: string): string {
	const jobs = [...workflowText.matchAll(/^ {3}[a-z_][a-z0-9_]*:$/gmu)];
	const current = jobs.find(job => job[0] === `   ${jobName}:`);
	expect(current).toBeDefined();
	const start = current!.index!;
	const next = jobs.find(job => job.index! > start);
	return workflowText.slice(start, next?.index);
}

describe("stable release policy", () => {
	test("tag releases build natives, then binaries, then publish npm + the GitHub Release", async () => {
		const ci = await workflow();
		const stages = ["native", "binaries", "publish"];
		const positions = stages.map(stage => ci.indexOf(`   ${stage}:`));
		for (const position of positions) expect(position).toBeGreaterThanOrEqual(0);

		expect(jobSection(ci, "binaries")).toContain("needs: [native]");
		expect(jobSection(ci, "publish")).toContain("needs: [native, binaries]");
		for (const stage of stages) {
			expect(jobSection(ci, stage)).toContain("if: ${{ startsWith(github.ref, 'refs/tags/v') }}");
		}

		const publish = jobSection(ci, "publish");
		expect(publish).toContain("--prepare-evidence --evidence-dir");
		expect(publish).toContain("--publish-from-evidence");
		expect(publish).toContain("--release-serialization-key gajae-production-release");
		expect(publish).toContain("softprops/action-gh-release");
		expect(publish).toContain("draft: false");
	});

	test("release tags run a non-cancelling concurrency lane", async () => {
		const ci = await workflow();
		const concurrency = ci.slice(ci.indexOf("concurrency:\n"), ci.indexOf("\njobs:"));

		expect(concurrency).toContain("cancel-in-progress: ${{ !startsWith(github.ref, 'refs/tags/v') }}");
		expect(concurrency).not.toContain("cancel-in-progress: true");
	});

	test("npm token stays in an ephemeral credential file, never the home npmrc", async () => {
		const ci = await workflow();
		const publish = jobSection(ci, "publish");

		expect(publish).toContain("NPM_TOKEN: ${{ secrets.NPM_TOKEN }}");
		expect(publish).toContain("NPM_CONFIG_USERCONFIG");
		expect(publish).toContain('mktemp "$RUNNER_TEMP/npmrc.XXXXXX"');
		expect(publish).toContain("trap 'rm -f \"$npm_config\"' EXIT");
		expect(publish).not.toContain("~/.npmrc");
	});

	test("the publish job carries the stable finalization job name", async () => {
		const ci = await workflow();
		// release.ts watches this exact job to confirm the release finalized.
		expect(ci).toContain(`   ${STABLE_GITHUB_RELEASE_FINALIZATION_JOB_NAME}:`);
	});

	test("lint/typecheck and tests never run on release tags", async () => {
		const ci = await workflow();
		// The monolithic `test` job is now a sharded graph; every job in that graph,
		// plus the bounded `check` job, must stay excluded on release tags.
		for (const job of ["check", "main_plan", "main_native", "main_shards", "test"]) {
			expect(jobSection(ci, job)).toContain("!startsWith(github.ref, 'refs/tags/v')");
		}
	});

	test("the lint/typecheck job is native-free", async () => {
		const ci = await workflow();
		const check = jobSection(ci, "check");
		// The bounded check runs biome + tsc only; runtime/native checks moved to `test`.
		expect(check).toContain("bun run ci:check:full");
		expect(check).not.toContain("ci:build:native");
		expect(check).not.toContain("check:runtime");
	});

	test("the paranoid multi-job evidence/verify/sandbox chain is gone", async () => {
		const ci = await workflow();
		for (const removed of [
			"release_source_verify",
			"release_context",
			"release_github_draft",
			"release_npm_expected",
			"release_github_final_evidence",
			"release_github_verify",
			"release_github_finalize",
			"release_sandbox_disabled",
			"release_verify_only",
			"release_website_hint",
			"rust-hash",
			"relevance",
		]) {
			expect(ci).not.toContain(`   ${removed}:`);
		}
	});

	test("checks the production remote final-evidence validator only in scheduled or manual public-site sync runs", async () => {
		const publicSync = await publicSiteWorkflow();

		expect(publicSync).toContain("github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'");
		expect(publicSync).toContain("Exercise production remote final-evidence and deployed release-state validation");
		expect(publicSync).toContain("bun scripts/check-public-version-sync.ts --live");
	});

	test("rejects reused or moved tags and directs corrections to a newer stable version", async () => {
		const releaseScript = await Bun.file(releaseScriptPath).text();

		expect(releaseScript).toContain("export function isStableReleaseVersion");
		expect(releaseScript).toContain("async function assertImmutableNewTag");
		expect(releaseScript).toContain("Refusing to reuse existing local tag");
		expect(releaseScript).toContain("Refusing to reuse existing remote tag");
		expect(releaseScript).toContain("corrections require a newer version");
		expect(releaseScript).toContain("Keep the published tag immutable; do not retag, delete, or force-push it.");
		expect(releaseScript).not.toMatch(/git tag -f|git push origin v\$\{version\} --force/u);
	});
});
