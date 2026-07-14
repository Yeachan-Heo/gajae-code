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
	test("creates a draft only after exact-SHA CI verification, records expected/final package evidence, verifies binaries, then finalizes before hinting", async () => {
		const ci = await workflow();
		const stages = [
			"release_github_draft",
			"release_npm_expected",
			"release_npm_publish",
			"release_github_final_evidence",
			"release_github_verify",
			"release_github_finalize",
			"release_website_hint",
		];
		const positions = stages.map(stage => ci.indexOf(`   ${stage}:`));
		for (const position of positions) expect(position).toBeGreaterThanOrEqual(0);
		for (let index = 1; index < positions.length; index += 1) {
			expect(positions[index]!).toBeGreaterThan(positions[index - 1]!);
		}

		expect(jobSection(ci, "release_github_draft")).toContain("needs.release_source_verify.result == 'success'");
		expect(jobSection(ci, "release_npm_expected")).toContain("--prepare-evidence --evidence-dir");
		expect(jobSection(ci, "release_npm_publish")).toContain("--publish-from-evidence --evidence-dir");
		expect(jobSection(ci, "release_npm_publish")).toContain("--release-serialization-key gajae-production-release");
		expect(jobSection(ci, "release_github_final_evidence")).toContain("gajae-release-packages-v1.json");
		expect(jobSection(ci, "release_github_verify")).toContain("gajae-release-packages-v1.json");
		expect(jobSection(ci, "release_github_finalize")).toContain("--verify-stable-finalization");
		expect(jobSection(ci, "release_github_finalize")).toContain("gh release edit \"$RELEASE_TAG\" --draft=false --prerelease=false");
		expect(jobSection(ci, "release_github_finalize")).toContain(`name: ${STABLE_GITHUB_RELEASE_FINALIZATION_JOB_NAME}`);
	});

	test("serializes production release refs globally without cancelling them while retaining per-ref CI concurrency", async () => {
		const ci = await workflow();
		const concurrency = ci.slice(ci.indexOf("concurrency:\n"), ci.indexOf("\njobs:"));

		expect(concurrency).toContain("'production-release'");
		expect(concurrency).toContain("startsWith(github.ref, 'refs/tags/v')");
		expect(concurrency).toContain("github.event_name == 'workflow_dispatch' && inputs.release_mode == 'production'");
		expect(concurrency).toContain("format('{0}-{1}', github.workflow, github.ref)");
		expect(concurrency).toContain("cancel-in-progress: ${{ !(");
		expect(concurrency).not.toContain("cancel-in-progress: true");
		expect(ci.indexOf("concurrency:\n")).toBeLessThan(ci.indexOf("   release_npm_publish:"));
		expect(ci.indexOf("concurrency:\n")).toBeLessThan(ci.indexOf("   release_github_finalize:"));
	});

	test("proves the exact tag SHA passed main CI before any release write", async () => {
		const ci = await workflow();
		const sourceVerify = jobSection(ci, "release_source_verify");
		const draft = jobSection(ci, "release_github_draft");
		const finalEvidence = jobSection(ci, "release_github_final_evidence");
		const finalize = jobSection(ci, "release_github_finalize");

		expect(sourceVerify).toContain("test \"$(git rev-parse \"$RELEASE_TAG^{commit}\")\" = \"$SOURCE_SHA\"");
		expect(sourceVerify).toContain("actions/workflows/ci.yml/runs?branch=main&event=push");
		expect(sourceVerify).toContain('.head_sha == $source_sha and .head_branch == "main" and .event == "push" and .conclusion == "success"');
		expect(draft).toContain("needs: [release_binary, release_context, release_source_verify]");
		expect(finalEvidence).toContain("needs.release_source_verify.result == 'success'");
		expect(finalize).toContain("needs.release_source_verify.result == 'success'");
	});

	test("binds retained expected evidence to the exact source SHA, upload run, and successful main-CI run", async () => {
		const ci = await workflow();
		const expected = jobSection(ci, "release_npm_expected");

		expect(expected).toContain("gajae-release-evidence-$RELEASE_TAG-$SOURCE_SHA");
		expect(expected).toContain(".workflow_run.head_sha == $source_sha");
		expect(expected).toContain("evidence-provenance.json");
		expect(expected).toContain(".retained_in_run_id == $retained_run_id");
		expect(expected).toContain("source_verification_run_id");
		expect(expected).toContain(".head_sha == $source_sha and .head_branch == \"main\" and .event == \"push\" and .conclusion == \"success\"");
		expect(expected).not.toContain("if gh release download");
		expect(expected).toContain("Draft release has no expected evidence asset; uploading the reproduced immutable asset.");
	});

	test("treats only confirmed absent release assets as upload candidates and fails closed on operational lookup errors", async () => {
		const ci = await workflow();
		const draft = jobSection(ci, "release_github_draft");
		const expected = jobSection(ci, "release_npm_expected");
		const finalEvidence = jobSection(ci, "release_github_final_evidence");

		expect(draft).toContain("case \"$release_status\" in");
		expect(draft).toContain("404) echo \"No release exists yet; creating the immutable draft.\"");
		expect(draft).toContain("Release lookup failed with HTTP $release_status; refusing to create or mutate a release.");
		expect(expected).toContain("expected_asset_present=\"$(jq -r");
		expect(expected).toContain("if [ \"$expected_asset_present\" = true ]; then");
		expect(finalEvidence).toContain("final_asset_present=\"$(jq -r");
		expect(finalEvidence).toContain("if [ \"$final_asset_present\" = true ]; then");
		expect(ci).not.toContain("if gh release download");
	});

	test("skip_npm and partial publication cannot finalize a stable release or trigger website sync", async () => {
		const ci = await workflow();
		const expected = jobSection(ci, "release_npm_expected");
		const publish = jobSection(ci, "release_npm_publish");
		const finalize = jobSection(ci, "release_github_finalize");
		const hint = jobSection(ci, "release_website_hint");

		expect(expected).toContain("needs.release_context.outputs.skip-npm != 'true'");
		expect(publish).toContain("needs.release_npm_expected.result == 'success'");
		expect(finalize).toContain("needs.release_npm_publish.result == 'success'");
		expect(finalize).toContain("needs.release_github_verify.result == 'success'");
		expect(hint).toContain("needs.release_github_finalize.result == 'success'");
	});

	test("confines the npm token to a read-only ephemeral-credential job and separates GitHub writes", async () => {
		const ci = await workflow();
		const publish = jobSection(ci, "release_npm_publish");
		const finalEvidence = jobSection(ci, "release_github_final_evidence");
		const finalize = jobSection(ci, "release_github_finalize");

		expect(publish).toContain("contents: read");
		expect(publish).not.toContain("contents: write");
		expect(publish).toContain("NPM_TOKEN: ${{ secrets.NPM_TOKEN }}");
		expect(publish).toContain("NPM_CONFIG_USERCONFIG");
		expect(publish).toContain("mktemp \"$RUNNER_TEMP/gajae-release-npmrc.XXXXXX\"");
		expect(publish).toContain("trap 'rm -f \"$npm_config\"' EXIT");
		expect(publish).not.toContain("~/.npmrc");
		expect(publish).not.toContain("gh release upload");

		expect(finalEvidence).toContain("contents: write");
		expect(finalEvidence).toContain("gh release upload");
		expect(finalEvidence).not.toContain("NPM_TOKEN");
		expect(finalize).toContain("contents: write");
		expect(finalize).not.toContain("actions: read");
		expect(finalize).not.toContain("NPM_TOKEN");
		expect(finalize).toContain("--pattern \"$expected_asset\" --pattern \"$final_asset\"");
	});

	test("checks the production remote final-evidence validator only in scheduled or manual public-site sync runs", async () => {
		const publicSync = await publicSiteWorkflow();

		expect(publicSync).toContain("github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'");
		expect(publicSync).toContain("Exercise production remote final-evidence and deployed release-state validation");
		expect(publicSync).toContain("bun scripts/check-public-version-sync.ts --live");
	});

	test("production finalization is fail-closed and manual sandbox and verification modes are non-enabling", async () => {
		const ci = await workflow();
		const context = jobSection(ci, "release_context");
		const sandbox = jobSection(ci, "release_sandbox_disabled");
		const verifyOnly = jobSection(ci, "release_verify_only");
		const draft = jobSection(ci, "release_github_draft");

		expect(ci).toContain("options: [sandbox, verify_only, production]");
		expect(context).toContain("PRODUCTION_ENABLED: ${{ vars.RELEASE_SYNC_PRODUCTION_ENABLED }}");
		expect(context).toContain("$PRODUCTION_ENABLED\" != \"true");
		expect(ci).not.toContain("simulate_invalid_trigger_token");
		expect(context).not.toContain("SIMULATE_INVALID_TRIGGER_TOKEN");
		expect(sandbox).toContain("permissions: {}");
		expect(sandbox).toContain("Sandbox publishing is intentionally disabled");
		expect(verifyOnly).not.toContain("contents: write");
		expect(verifyOnly).not.toContain("NPM_TOKEN");
		expect(draft).toContain("needs.release_context.outputs.production-enabled == 'true'");
	});

	test("uses only the dedicated Trigger App for a warning-only Actions workflow hint", async () => {
		const ci = await workflow();
		const hint = jobSection(ci, "release_website_hint");

		expect(hint).toContain("continue-on-error: true");
		expect(hint).toContain("environment: website-release-sync-trigger");
		expect(hint).toContain("GJ_RELEASE_SYNC_TRIGGER_APP_ID");
		expect(hint).toContain("GJ_RELEASE_SYNC_TRIGGER_PRIVATE_KEY");
		expect(hint).toContain("actions/create-github-app-token@a8d616148505b5069dccd32f177bb87d7f39123b");
		expect(hint).toContain("gh workflow run sync-release.yml");
		expect(hint).toContain("--repo Yeachan-Heo/gajae-code-website");
		expect(hint).toContain("--ref main");
		expect(hint).not.toContain("repository_dispatch");
		expect(hint).not.toContain("GJ_RELEASE_SYNC_WRITER");
		expect(hint).not.toMatch(/\bPAT\b/u);
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
