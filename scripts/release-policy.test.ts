import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { releasedBunLockContent, STABLE_GITHUB_RELEASE_FINALIZATION_JOB_NAME } from "./release";

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
	test("tag releases verify MuPDF source and natives before binaries, then prepare, publish npm, and finalize the GitHub Release", async () => {
		const ci = await workflow();
		const stages = ["release_metadata", "mupdf_source", "native", "binaries", "release_prepare", "release_approval", "publish", "release_finalize"];
		const positions = stages.map(stage => ci.indexOf(`   ${stage}:`));
		for (const position of positions) expect(position).toBeGreaterThanOrEqual(0);

		const mupdfSource = jobSection(ci, "mupdf_source");
		expect(mupdfSource).toContain("needs: [release_metadata]");
		expect(mupdfSource).toContain('node-version: "24"');
		expect(mupdfSource).toContain("retention-days: 30");
		expect(jobSection(ci, "native")).toContain("needs: [release_metadata]");
		expect(jobSection(ci, "binaries")).toContain("needs: [native, release_metadata, mupdf_source]");
		expect(jobSection(ci, "release_prepare")).toContain("needs: [native, binaries, release_metadata, nightly_gate]");
		expect(jobSection(ci, "publish")).toContain("needs: [release_prepare, release_approval, release_metadata]");
		expect(jobSection(ci, "release_finalize")).toContain("needs: [publish, release_metadata, mupdf_source]");
		for (const stage of ["mupdf_source", "native", "binaries"]) {
			const section = jobSection(ci, stage);
			expect(section).toContain("startsWith(github.ref, 'refs/tags/v')");
			expect(section).toContain("inputs.rehearsal == 'tag-build-verify'");
		}
		const prepare = jobSection(ci, "release_prepare");
		expect(prepare).toContain("needs.release_metadata.outputs.channel == 'stable'");
		expect(prepare).toContain("github.event_name != 'workflow_dispatch'");
		expect(prepare).toContain("--prepare-evidence --evidence-dir");
		const publish = jobSection(ci, "publish");
		expect(publish).toContain("Publish sealed tarballs to npm");
		const finalize = jobSection(ci, "release_finalize");
		expect(finalize).toContain("softprops/action-gh-release");
		expect(finalize).toContain("draft: false");
		expect(finalize).toContain("mupdf-release-materials/mupdf-source.tar.gz");
		expect(finalize).toContain("mupdf-release-materials/mupdf-provenance.json");
		expect(finalize).toContain("mupdf-release-materials/mupdf-built.wasm");
	});

	test("stable tags and nightly publication lanes are non-cancelling", async () => {
		const ci = await workflow();
		const concurrency = ci.slice(ci.indexOf("concurrency:\n"), ci.indexOf("\njobs:"));

		expect(concurrency).toContain("gajae-npm-release");
		expect(concurrency).toContain("startsWith(github.ref, 'refs/tags/v')");
		expect(concurrency).toContain("inputs.rehearsal == 'nightly-release'");
		expect(concurrency).not.toContain("cancel-in-progress: true");
	});

	test("publishes through npm trusted publishing, with no long-lived credential in the release path", async () => {
		const ci = await workflow();
		const publish = jobSection(ci, "publish");

		// A stale _authToken outranks OIDC and fails closed as a registry 404
		// that reads like a missing package, so no token may reach this job.
		expect(publish).not.toContain("secrets.NPM_TOKEN");
		expect(publish).not.toContain("NODE_AUTH_TOKEN:");
		expect(publish).not.toContain("NPM_CONFIG_USERCONFIG");
		expect(publish).not.toContain("_authToken");
		expect(publish).not.toContain("~/.npmrc");

		// OIDC needs the identity token and an npm new enough to exchange it.
		// The CLI pin is exact and integrity-verifiable: a mutable range inside
		// the credential-bearing job would let a drifting or compromised CLI
		// publish.
		expect(publish).toContain("id-token: write");
		expect(publish).not.toMatch(/npm@[\^~]/u);
		expect(publish).toContain('NPM_PIN_VERSION: "11.5.1"');
		expect(publish).toContain("NPM_TARBALL_SHA512:");
		expect(publish).toContain("sha512sum --check --strict");
		expect(publish).toContain('npm install -g "$tmp/npm-${NPM_PIN_VERSION}.tgz"');
		expect(publish).toContain('test "$(npm --version)" = "$NPM_PIN_VERSION"');
	});

	test("splits credential-free preparation from the minimal OIDC publish boundary", async () => {
		const ci = await workflow();
		const prepare = jobSection(ci, "release_prepare");
		const publish = jobSection(ci, "publish");

		// The preparation job does everything untrusted (dependency installs,
		// repository scripts, GitHub API reads) with read-only scopes and must
		// never hold the OIDC identity token or any write scope.
		expect(prepare).toContain("contents: read");
		expect(prepare).toContain("pull-requests: read");
		expect(prepare).not.toContain("id-token");
		expect(prepare).not.toMatch(/:\s*write/u);

		// The publish job holds only the OIDC identity token — no repository
		// scope — and performs only the irreversible publication from the fixed
		// boundary.
		expect(publish).not.toContain("contents: write");
		expect(publish).toContain("id-token: write");
		expect(publish).not.toContain("pull-requests");
		expect(publish).not.toContain("release-notes.ts");
		expect(publish).toContain("needs: [release_prepare, release_approval, release_metadata]");
	});

	test("resolves and validates release notes before the irreversible npm publication", async () => {
		const ci = await workflow();
		const prepare = jobSection(ci, "release_prepare");
		const publish = jobSection(ci, "publish");

		// Notes derivation (history fetch + GitHub API + generation) lives in the
		// preparation job, so any failure aborts the run before packages ship.
		expect(prepare).toContain("Derive and validate release notes");
		expect(prepare).toContain("bun scripts/release-notes.ts");
		// The persisted body must be deterministic: a second derivation has to
		// reproduce it byte-for-byte.
		expect(prepare).toContain("cmp --silent");
		// The finalize job consumes only the integrity-checked artifact and never
		// regenerates the body.
		const finalize = jobSection(ci, "release_finalize");
		expect(finalize).toContain("Download validated release notes");
		expect(finalize).toContain("Verify release notes integrity");
		expect(finalize.indexOf("Verify release notes integrity")).toBeLessThan(finalize.indexOf("Create GitHub Release"));
		expect(finalize).toContain("body_path: ${{ runner.temp }}/release-notes/release-notes.md");
		expect(finalize).toContain("generate_release_notes: false");
		// publish needs release_prepare (via release_approval), which guarantees
		// notes exist and passed validation before npm publish can start.
		expect(publish).toContain("needs.release_approval.result == 'success'");
	});

	test("selects the previous release anchor as an exact stable ancestor tag with a shell-safe empty fallback", async () => {
		const ci = await workflow();
		const prepare = jobSection(ci, "release_prepare");
		const notesStart = prepare.indexOf("Derive and validate release notes");
		expect(notesStart).toBeGreaterThanOrEqual(0);
		const notes = prepare.slice(notesStart);

		// Exact stable vX.Y.Z only: nightly/RC/unrelated tags cannot anchor the range.
		expect(notes).toContain("^v[0-9]+\\.[0-9]+\\.[0-9]+$");
		// Ancestor-only: a tag that does not lead to this release head is rejected.
		expect(notes).toContain('git merge-base --is-ancestor "$tag" "$SOURCE_SHA"');
		// The current release tag is never its own base.
		expect(notes).toContain('[ "$tag" = "$TAG_NAME" ] && continue');
		// No-candidate is the documented empty-notes fallback, implemented without
		// pipelines that pipefail would turn into an abort (grep -vFx exits 1).
		expect(notes).not.toContain("grep -vFx");
		expect(notes).toContain(': > "$notes"');
		// A tagged-but-unpublished version cannot anchor the range: v0.15.1 was
		// tagged, failed in this step before npm received anything, and would
		// otherwise have hidden every change 0.15.2 actually shipped.
		expect(notes).toContain('gh api "repos/$GITHUB_REPOSITORY/releases/tags/$tag"');
		expect(notes).toContain('[ "$release_draft" = "false" ]');
		// Only a definitive "no such release" skips; auth/transport/5xx fails closed.
		expect(notes).toContain("HTTP 404|Not Found");
		expect(notes).toContain('echo "Release lookup for $tag failed:');
	});

	test("gates stable tag releases on protected-main provenance with a ref-scoped OIDC subject", async () => {
		const ci = await workflow();
		const metadata = jobSection(ci, "release_metadata");
		const publish = jobSection(ci, "publish");

		// The tagged SHA must provably sit on the fetched origin/main line before
		// anything in the release graph can run (publish needs release_metadata).
		expect(metadata).toContain("Validate stable tag protected-main provenance");
		expect(metadata).toContain("+refs/heads/main:refs/remotes/origin/main");
		expect(metadata).toContain('git merge-base --is-ancestor "$SOURCE_SHA" refs/remotes/origin/main');
		expect(publish).toContain("needs: [release_prepare, release_approval, release_metadata]");

		// The OIDC subject must stay ref-scoped: an `environment:` would change
		// the token subject away from the identity the npm trusted-publisher
		// registrations (and the shipped v0.14.1 exchange) already prove. Owner
		// prerequisites (main ruleset, v* tag-creation ruleset) are documented
		// on the job instead.
		expect(publish).not.toContain("environment:");
	});

	test("executes no checkout-controlled code inside the OIDC publish boundary", async () => {
		const ci = await workflow();
		const publish = jobSection(ci, "publish");

		// The fixed publisher boundary: no checkout, no repository code, no
		// dependency installation, no cache — only pinned actions and workflow
		// shell operate on sha512-sealed artifacts.
		expect(publish).not.toContain("actions/checkout@");
		expect(publish).not.toContain("setup-bun@");
		expect(publish).not.toContain("bun ");
		expect(publish).not.toContain("scripts/");
		expect(publish).not.toContain("bun install");
		expect(publish).not.toContain("actions/cache@");
		expect(publish).not.toContain("npm ci");
		expect(publish).not.toContain("node_modules");
		// The boundary re-verifies the sealed tarball bytes before publishing.
		expect(publish).toContain("Publish sealed tarballs to npm");
		expect(publish).toContain("sha512sum --check --strict");
		expect(publish).toContain("gajae-release-oidc-publish-receipt-v1.json");
		// Registry observation must bypass the CDN-cached packument (max-age=300):
		// `npm view` made every package wait up to five minutes and timed out 0.17.5.
		expect(publish).not.toContain("npm view");
		expect(publish).toContain('"${registry}$(registry_path "$1")/$2"');
		expect(publish).toContain('"${registry}-/package/$(registry_path "$1")/dist-tags"');
	});

	test("gates the OIDC boundary on the approval environment without changing the publish subject", async () => {
		const ci = await workflow();
		const approval = jobSection(ci, "release_approval");
		const publish = jobSection(ci, "publish");

		// The approval gate runs before publish and holds the environment hook
		// with no permissions and no OIDC token, so publish's OIDC subject stays
		// ref-scoped and the trusted-publisher registrations remain valid.
		expect(approval).toContain("environment: npm-release");
		expect(approval).toContain("permissions: {}");
		expect(approval).not.toContain("id-token");
		expect(publish).toContain("needs: [release_prepare, release_approval, release_metadata]");
		expect(publish).toContain("needs.release_approval.result == 'success'");
		expect(publish).not.toContain("environment:");
	});

	test("keeps scheduled and manual nightlies out of the stable approval gate", async () => {
		const ci = await workflow();
		const approval = jobSection(ci, "release_approval");
		const publish = jobSection(ci, "publish");

		// The approval environment applies to stable releases only; nightlies
		// stay unattended once required reviewers are configured.
		expect(approval).toContain("needs.release_metadata.outputs.channel == 'stable'");
		// publish runs for nightly without the approval result, but stable
		// requires it.
		expect(publish).toContain("needs.release_metadata.outputs.channel == 'nightly' || needs.release_approval.result == 'success'");
		// release_approval depends on the preparation graph, not the other way.
		expect(approval).toContain("needs: [release_prepare, release_metadata]");
	});

	test("keeps dependency resolution out of the publish dispatch", async () => {
		const publishScript = await Bun.file(path.join(repoRoot, "scripts/ci-release-publish.ts")).text();

		// Declaration checks (`bun x tsc`) resolve/execute packages: they must be
		// dispatched only on the prepare path, never on --publish-from-evidence.
		const prepareBranch = publishScript.slice(
			publishScript.indexOf('command.mode === "prepare-evidence"'),
			publishScript.indexOf("await publishFromExpectedEvidence"),
		);
		expect(prepareBranch).toContain("await checkTypeDeclarations()");
		expect(publishScript.slice(publishScript.indexOf("await publishFromExpectedEvidence"))).not.toContain("checkTypeDeclarations");
	});

	test("observes registry state through uncached per-document reads outside the publish boundary", async () => {
		const publishScript = await Bun.file(path.join(repoRoot, "scripts/ci-release-publish.ts")).text();
		// Finalize re-observes right after publication; a CDN-cached packument read
		// (`npm view`, max-age=300) would see a stale 404 or an old dist-tag and fail it.
		expect(publishScript).not.toMatch(/\$`npm view/u);
		expect(publishScript).toContain("async function readRegistryDocument(");
		expect(publishScript).toContain('packageName.replace("/", "%2f")');
	});

	test("pins the OIDC-capable Node bootstrap to an exact patch", async () => {
		const ci = await workflow();
		const publish = jobSection(ci, "publish");

		expect(publish).toContain('node-version: "24.19.0"');
		expect(publish).not.toContain('node-version: "24"');
		expect(publish).not.toMatch(/node-version: "24\.[x*]/u);
	});

	test("keeps the release regression suites on the normal release CI path", async () => {
		const manifest = JSON.parse(await Bun.file(path.join(repoRoot, "package.json")).text()) as { scripts: Record<string, string> };
		const release = manifest.scripts["test:release"];
		expect(release).toContain("scripts/release-notes.test.ts");
		expect(release).toContain("scripts/release-retry.test.ts");
	});

	test("the release_finalize job carries the stable finalization job name", async () => {
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

	// #3139 least-privilege invariant: only release_finalize may hold contents write.
	test("pins release_finalize as the only job-level contents write permission", async () => {
		const ci = await workflow();
		const jobs = [...ci.slice(ci.indexOf("\njobs:")).matchAll(/^ {3}[a-z_][a-z0-9_]*:$/gmu)].map(job => job[0].trim().slice(0, -1));
		for (const job of jobs) {
			const section = jobSection(ci, job);
			if (job === "release_finalize") expect(section).toContain("contents: write");
			else expect(section).not.toContain("contents: write");
		}
	});

	test("runs an immutable nightly deployment only after the complete source graph passes", async () => {
		const ci = await workflow();
		const metadata = jobSection(ci, "release_metadata");
		const gate = jobSection(ci, "nightly_gate");
		const native = jobSection(ci, "native");
		const binaries = jobSection(ci, "binaries");
		const prepare = jobSection(ci, "release_prepare");
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
		expect(prepare).toContain("needs.nightly_gate.result == 'success'");
		expect(prepare).toContain("Stage nightly release version");
		expect(prepare).toContain("Persist pre-publication package evidence");
		expect(prepare).toContain("release-evidence-${{ needs.release_metadata.outputs.version }}");
		expect(prepare).toContain("Reject pre-existing release tag or release");
		expect(prepare).toContain("refusing upsert");
		expect(prepare).toContain("$2 ~ /\\^\\{\\}$/");
		expect(prepare).not.toContain("same-run retry");
		// Every preparation-side validation lands before the publish job can run.
		expect(prepare.indexOf("Reject pre-existing release tag or release")).toBeLessThan(prepare.indexOf("Derive and validate release notes"));
		expect(publish).toContain("--tag=\"$npm_tag\"");
		const finalize = jobSection(ci, "release_finalize");
		expect(finalize).toContain("--release-channel \"$RELEASE_CHANNEL\"");
		expect(finalize).toContain("fail_on_unmatched_files: true");
		expect(finalize).toContain("Verify immutable GitHub Release");
		expect(finalize.indexOf("Assemble final release evidence")).toBeLessThan(finalize.indexOf("Create GitHub Release"));
		expect(finalize).toContain("prerelease: ${{ needs.release_metadata.outputs.channel == 'nightly' }}");
		expect(finalize).toContain("make_latest: ${{ needs.release_metadata.outputs.channel != 'nightly' }}");
		expect(finalize).toContain("gajae-release-packages-expected-v1.json");
		expect(finalize).toContain("gajae-release-packages-v1.json");
		expect(finalize).toContain("gajae-release-channel-v1.json");
		expect(finalize).toContain("gajae-release-binaries-v1.json");
		expect(finalize).toContain("gajae-release-binaries.sha256");
		expect(finalize).toContain("Publish binary checksum manifest");
	});
	test("updates owned Bun lock versions without re-resolving third-party packages", () => {
		const lock = `{
  "workspaces": {
    "packages/agent": {
      "name": "@gajae-code/agent-core",
      "version": "0.12.20",
    },
  },
  "catalog": {
    "@gajae-code/agent-core": "0.12.20",
    "lucide-react": "^1.14.0",
  },
  "packages": {
    "lucide-react": ["lucide-react@1.28.0", "", {}, "sha512-frozen"],
  },
}`;

		const updated = releasedBunLockContent(lock, "0.12.20", "0.12.21");

		expect(updated).toContain('"version": "0.12.21"');
		expect(updated).toContain('"@gajae-code/agent-core": "0.12.21"');
		expect(updated).toContain('"lucide-react@1.28.0"');
		expect(updated).toContain('"sha512-frozen"');
	});

	test("fails closed when the Bun lock workspace or catalog versions do not match", () => {
		const lock = `{
  "workspaces": { "packages/agent": { "version": "0.12.20" } },
  "catalog": { "@gajae-code/agent-core": "0.12.19" },
  "packages": {}
}`;

		expect(() => releasedBunLockContent(lock, "0.12.20", "0.12.21")).toThrow(
			"no @gajae-code catalog versions matching 0.12.20",
		);
		expect(() => releasedBunLockContent(lock, "0.12.18", "0.12.21")).toThrow(
			"no workspace package versions matching 0.12.18",
		);
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

	// #4257 regression: a merge that resolves package.json conflicts with a
	// stale catalog can land with manifests at the new version while the Bun
	// lock header and root catalog still pin the old one. The release helper's
	// unit tests above only exercise fixtures, so this test runs the guard
	// against the real repository state: every @gajae-code root catalog pin
	// must be mirrored in bun.lock, and every workspace package's recorded lock
	// version must equal its manifest version.
	test("the real Bun lock header stays in lockstep with the root catalog and package manifests", async () => {
		const rootPkg = JSON.parse(await Bun.file(path.join(repoRoot, "package.json")).text()) as {
			workspaces?: { catalog?: Record<string, string> };
		};
		const catalog = rootPkg.workspaces?.catalog ?? {};
		expect(catalog["@gajae-code/coding-agent"]).toBeTypeOf("string");

		const lock = await Bun.file(path.join(repoRoot, "bun.lock")).text();
		const header = lock.split('\n  "packages": {')[0] ?? lock;

		for (const [name, version] of Object.entries(catalog)) {
			if (!name.startsWith("@gajae-code/")) continue;
			expect(header, `bun.lock must pin ${name} at ${version}`).toContain(`"${name}": "${version}"`);
		}

		const packagesRoot = path.join(repoRoot, "packages");
		for (const entry of await fs.readdir(packagesRoot, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			// Removed packages may leave stray directories behind (e.g. the
			// bridge-client dir after #4098); only packages with a manifest are
			// expected in the lock.
			const manifestPath = path.join(packagesRoot, entry.name, "package.json");
			if ((await Bun.file(manifestPath).exists()) === false) continue;
			const manifest = JSON.parse(await Bun.file(manifestPath).text()) as { version?: string };
			if (typeof manifest.version !== "string") continue;
			const match = header.match(
				new RegExp(`"packages/${entry.name}": \\{\\s*"name": "[^\"]+",\\s*"version": "([^\"]+)"`),
			);
			expect(match, `bun.lock must record packages/${entry.name}`).not.toBeNull();
			expect(match![1]!).toBe(manifest.version);
		}
	});
});
