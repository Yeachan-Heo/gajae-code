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
	test("tag releases resolve metadata, build natives, then binaries, then publish npm + the GitHub Release", async () => {
		const ci = await workflow();
		const stages = ["release_metadata", "native", "binaries", "publish"];
		const positions = stages.map(stage => ci.indexOf(`   ${stage}:`));
		for (const position of positions) expect(position).toBeGreaterThanOrEqual(0);

		expect(jobSection(ci, "native")).toContain("needs: [release_metadata]");
		expect(jobSection(ci, "binaries")).toContain("needs: [native, release_metadata]");
		expect(jobSection(ci, "publish")).toContain("needs: [native, binaries, release_metadata, nightly_gate]");
		for (const stage of ["native", "binaries"]) {
			const section = jobSection(ci, stage);
			expect(section).toContain("startsWith(github.ref, 'refs/tags/v')");
			expect(section).toContain("inputs.rehearsal == 'tag-build-verify'");
		}
		const publish = jobSection(ci, "publish");
		expect(publish).toContain("needs.release_metadata.outputs.channel == 'stable'");
		expect(publish).toContain("github.event_name != 'workflow_dispatch'");
		expect(publish).toContain("--prepare-evidence --evidence-dir");
		expect(publish).toContain("--publish-from-evidence");
		expect(publish).toContain("gajae-production-release");
		expect(publish).toContain("softprops/action-gh-release");
		expect(publish).toContain("draft: false");
	});

	test("stable tags and nightly publication lanes are non-cancelling", async () => {
		const ci = await workflow();
		const concurrency = ci.slice(ci.indexOf("concurrency:\n"), ci.indexOf("\njobs:"));

		expect(concurrency).toContain("gajae-npm-release");
		expect(concurrency).toContain("startsWith(github.ref, 'refs/tags/v')");
		expect(concurrency).toContain("inputs.rehearsal == 'nightly-release'");
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

	// #3139 least-privilege invariant: CI keeps its workflow default read-scoped.
	test("pins the ci.yml workflow default to contents read", async () => {
		const ci = await workflow();
		const header = ci.slice(0, ci.indexOf("\njobs:"));
		const permissionsStart = header.indexOf("\npermissions:");
		const permissionsEnd = header.indexOf("\n\n", permissionsStart);
		const permissions = header.slice(permissionsStart, permissionsEnd);

		expect(header).toMatch(/permissions:\n   contents: read/u);
		expect(permissions).not.toMatch(/:\s+write(?:\s|$)/u);
	});

	// #3139 least-privilege invariant: only publish may hold contents write.
	test("pins publish as the only job-level contents write permission", async () => {
		const ci = await workflow();
		const jobs = [...ci.slice(ci.indexOf("\njobs:")).matchAll(/^ {3}[a-z_][a-z0-9_]*:$/gmu)].map(job => job[0].trim().slice(0, -1));
		for (const job of jobs) {
			const section = jobSection(ci, job);
			if (job === "publish") expect(section).toContain("contents: write");
			else expect(section).not.toContain("contents: write");
		}
	});

	test("runs an immutable nightly deployment only after the complete source graph passes", async () => {
		const ci = await workflow();
		const metadata = jobSection(ci, "release_metadata");
		const gate = jobSection(ci, "nightly_gate");
		const native = jobSection(ci, "native");
		const binaries = jobSection(ci, "binaries");
		const publish = jobSection(ci, "publish");
		const nativeAction = await Bun.file(path.join(repoRoot, ".github/actions/build-native/action.yml")).text();

		expect(ci).toContain('cron: "23 4 * * *"');
		expect(ci).toContain("options: [tag-build-verify, main-nontag, nightly-release]");
		expect(jobSection(ci, "check")).toContain("inputs.rehearsal == 'nightly-release'");
		expect(jobSection(ci, "test")).toContain("inputs.rehearsal == 'nightly-release'");
		expect(metadata).toContain("bun scripts/nightly-release.ts version");
		expect(metadata).toContain("expected_ref=refs/heads/dev");
		expect(metadata).toContain('if [ "$EVENT_NAME" = schedule ]');
		expect(metadata).toContain("expected_ref=refs/heads/main");
		expect(metadata).toContain("git show -s --format=%cI");
		expect(metadata).toContain("Stable release tag must be exact vX.Y.Z");
		expect(metadata).toContain("does not match package version");
		expect(gate).toContain("needs: [check, test]");
		expect(gate).toContain("needs.check.result");
		expect(gate).toContain("needs.test.result");
		expect(native).toContain("nightly_version: ${{ needs.release_metadata.outputs.nightly_version }}");
		expect(nativeAction).toContain("bun scripts/nightly-release.ts stage");
		expect(nativeAction).toContain("PI_NATIVE_PROFILE:");
		expect(binaries).toContain("Stage nightly release version");
		expect(publish).toContain("needs.nightly_gate.result == 'success'");
		expect(publish).toContain("--release-channel \"$RELEASE_CHANNEL\"");
		expect(publish).toContain("Persist pre-publication package evidence");
		expect(publish).toContain("release-evidence-${{ needs.release_metadata.outputs.version }}");
		expect(publish).toContain("Reject pre-existing release tag or release");
		expect(publish).toContain("refusing upsert");
		expect(publish).toContain("$2 ~ /\\^\\{\\}$/");
		expect(publish).not.toContain("same-run retry");
		expect(publish).toContain("fail_on_unmatched_files: true");
		expect(publish).toContain("Verify immutable GitHub Release");
		expect(publish.indexOf("Reject pre-existing release tag or release")).toBeLessThan(publish.indexOf("Publish packages to npm"));
		expect(publish).toContain("gajae-nightly-release");
		expect(publish).toContain("prerelease: ${{ needs.release_metadata.outputs.channel == 'nightly' }}");
		expect(publish).toContain("make_latest: ${{ needs.release_metadata.outputs.channel != 'nightly' }}");
		expect(publish).toContain("gajae-release-packages-expected-v1.json");
		expect(publish).toContain("gajae-release-packages-v1.json");
		expect(publish).toContain("gajae-release-channel-v1.json");
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
