import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import {
	NPM_REGISTRY_URL,
	NPM_RELEASE_TAG,
	normalizeFileDependencySpec,
	packages as publishPackages,
	parseReleasePublishCli,
	planExpectedEvidencePublication,
	publishExpectedEvidencePackages,
	validateNpmRegistryUrl,
} from "./ci-release-publish";
import { PUBLIC_PACKAGE_DEFINITIONS, type PackageEvidenceRecord } from "./release-evidence";
import {
	assertAtomicPushRemoteState,
	classifyStableReleaseFinalizationReceipt,
	isStableReleaseVersion,
	parseReleaseCli,
	releaseAtomicPushArgs,
	STABLE_GITHUB_RELEASE_FINALIZATION_JOB_NAME,
} from "./release";


interface PackageManifest {
	name: string;
	version: string;
	bin?: Record<string, string>;
	dependencies?: Record<string, string>;
	private?: boolean;
	optionalDependencies?: Record<string, string>;
	files?: string[];
	os?: string[];
	cpu?: string[];
	libc?: string[];
}

const repoRoot = path.join(import.meta.dir, "..");

async function readManifest(relativePath: string): Promise<PackageManifest> {
	return (await Bun.file(path.join(repoRoot, relativePath, "package.json")).json()) as PackageManifest;
}

function evidenceRecord(definition: (typeof PUBLIC_PACKAGE_DEFINITIONS)[number]): PackageEvidenceRecord {
	return {
		dir: definition.dir,
		name: definition.name,
		version: "1.2.3",
		tarball_sha512: "a".repeat(128),
		expected_sri: "sha512-test",
		manifest_sha256: "b".repeat(64),
		unpacked_size: 0,
		file_count: 0,
		internal_dependencies: {},
	};
}

function canonicalEvidenceRecords(): PackageEvidenceRecord[] {
	return PUBLIC_PACKAGE_DEFINITIONS.map(evidenceRecord);
}

describe("unscoped gajae-code package publication", () => {
	test("manifest exposes gjc and depends on the scoped CLI package", async () => {
		const aliasManifest = await readManifest("packages/gajae-code");
		const codingAgentManifest = await readManifest("packages/coding-agent");

		expect(aliasManifest.private).toBeUndefined();
		expect(aliasManifest.name).toBe("gajae-code");
		// The unscoped wrapper may carry a patch-only hotfix version when an
		// immutable npm publish has to be superseded without republishing the
		// scoped CLI. Its dependency remains catalog-backed so the release
		// publisher resolves it to the current @gajae-code/coding-agent version.
		expect(aliasManifest.version).toMatch(/^\d+\.\d+\.\d+$/);
		expect(aliasManifest.version.split(".").slice(0, 2)).toEqual(codingAgentManifest.version.split(".").slice(0, 2));
		expect(Number(aliasManifest.version.split(".")[2])).toBeGreaterThanOrEqual(
			Number(codingAgentManifest.version.split(".")[2]),
		);
		expect(aliasManifest.bin).toEqual({ gjc: "bin/gjc.js" });
		expect(aliasManifest.dependencies?.["@gajae-code/coding-agent"]).toBe("catalog:");
		const wrapper = await Bun.file(path.join(repoRoot, "packages/gajae-code/bin/gjc.js")).text();
		expect(wrapper).toContain('import { runCli } from "@gajae-code/coding-agent/cli";');
		expect(wrapper).toContain("await runCli(process.argv.slice(2));");
	});

	test("release dependency normalization collapses repeated file prefixes", () => {
		expect(normalizeFileDependencySpec("file:../packages/ai")).toBe("file:../packages/ai");
		expect(normalizeFileDependencySpec("file:file:../packages/ai")).toBe("file:../packages/ai");
		expect(normalizeFileDependencySpec("file:file:file:///tmp/gajae-code/packages/ai")).toBe(
			"file:///tmp/gajae-code/packages/ai",
		);
		expect(normalizeFileDependencySpec("catalog:")).toBe("catalog:");
	});

	test("release publish order publishes the alias after its scoped dependency", async () => {
		const releaseScript = await Bun.file(path.join(repoRoot, "scripts/ci-release-publish.ts")).text();
		const codingAgentIndex = releaseScript.indexOf('dir: "packages/coding-agent"');
		const aliasIndex = releaseScript.indexOf('dir: "packages/gajae-code"');

		expect(codingAgentIndex).toBeGreaterThan(-1);
		expect(aliasIndex).toBeGreaterThan(codingAgentIndex);
	});

	test("native platform packages publish before the stable loader package", () => {
		const publishDirs = publishPackages.map((pkg) => pkg.dir);
		const nativesIndex = publishDirs.indexOf("packages/natives");
		const platformDirs = [
			"packages/natives-darwin-arm64",
			"packages/natives-darwin-x64",
			"packages/natives-linux-arm64",
			"packages/natives-linux-x64",
			"packages/natives-win32-x64",
		];

		expect(nativesIndex).toBeGreaterThan(-1);
		for (const dir of platformDirs) {
			const platformIndex = publishDirs.indexOf(dir);
			expect(platformIndex).toBeGreaterThan(-1);
			expect(platformIndex).toBeLessThan(nativesIndex);
		}
	});

	test("plans the real gajae-code wrapper edge before the wrapper is published", () => {
		const records = canonicalEvidenceRecords();
		const wrapper = records.find(record => record.name === "gajae-code")!;
		wrapper.internal_dependencies = { "@gajae-code/coding-agent": "1.2.3" };

		const plannedNames = planExpectedEvidencePublication(records).map(record => record.name);
		expect(plannedNames.indexOf("@gajae-code/coding-agent")).toBeLessThan(plannedNames.indexOf("gajae-code"));
	});

	test("topologically moves an early declared package behind a late dependency", () => {
		const records = canonicalEvidenceRecords();
		const utils = records.find(record => record.name === "@gajae-code/utils")!;
		utils.internal_dependencies = { "gajae-code": "1.2.3" };

		const plannedNames = planExpectedEvidencePublication(records).map(record => record.name);
		expect(plannedNames.indexOf("gajae-code")).toBeLessThan(plannedNames.indexOf("@gajae-code/utils"));
	});

	test("rejects a closed-set internal dependency cycle before registry publication begins", async () => {
		const records = canonicalEvidenceRecords();
		records.find(record => record.name === "@gajae-code/utils")!.internal_dependencies = { "@gajae-code/ai": "1.2.3" };
		records.find(record => record.name === "@gajae-code/ai")!.internal_dependencies = { "@gajae-code/utils": "1.2.3" };
		const published: string[] = [];

		await expect(publishExpectedEvidencePackages(records, async (record) => {
			published.push(record.name);
			return undefined;
		})).rejects.toThrow("dependency graph contains a cycle");
		expect(published).toEqual([]);
	});
	test("executes dependency-safe publication from canonically name-sorted evidence", async () => {
		const serializedRecords = canonicalEvidenceRecords();
		const serializedNames = serializedRecords.map(record => record.name);
		const plannedNames = publishPackages.map((pkg) => {
			const definition = PUBLIC_PACKAGE_DEFINITIONS.find(candidate => candidate.dir === pkg.dir);
			if (definition === undefined) throw new Error(`No evidence definition exists for ${pkg.dir}`);
			return definition.name;
		});
		const executedNames: string[] = [];
		const platformNames = [
			"@gajae-code/natives-darwin-arm64",
			"@gajae-code/natives-darwin-x64",
			"@gajae-code/natives-linux-arm64",
			"@gajae-code/natives-linux-x64",
			"@gajae-code/natives-win32-x64",
		];
		const nativesName = "@gajae-code/natives";

		expect(serializedNames).toEqual([...serializedNames].sort());
		for (const platformName of platformNames) {
			expect(serializedNames.indexOf(nativesName)).toBeLessThan(serializedNames.indexOf(platformName));
		}

		await publishExpectedEvidencePackages(serializedRecords, async (record) => {
			executedNames.push(record.name);
			return undefined;
		});

		expect(executedNames).toEqual(plannedNames);
		for (const platformName of platformNames) {
			expect(executedNames.indexOf(platformName)).toBeLessThan(executedNames.indexOf(nativesName));
		}
	});

	test("rejects duplicate, missing, and extra evidence records before publication", async () => {
		const records = canonicalEvidenceRecords();
		const published: string[] = [];
		const publish = async (record: PackageEvidenceRecord) => {
			published.push(record.name);
			return undefined;
		};

		await expect(publishExpectedEvidencePackages([...records, records[0]!], publish)).rejects.toThrow("duplicate package record");
		await expect(publishExpectedEvidencePackages(records.slice(1), publish)).rejects.toThrow("missing package record");
		await expect(publishExpectedEvidencePackages([
			...records,
			{ ...records[0]!, dir: "packages/unexpected", name: "@gajae-code/unexpected" },
		], publish)).rejects.toThrow("unexpected package record");
		expect(published).toEqual([]);
	});

	test("stable natives package delegates binaries to optional platform packages", async () => {
		const manifest = await readManifest("packages/natives");
		expect(manifest.files).toEqual([
			"native/index.js",
			"native/index.d.ts",
			"native/loader-state.js",
			"native/loader-state.d.ts",
			"native/embedded-addon.js",
			"README.md",
		]);
		expect(manifest.files?.some((entry) => entry === "native" || entry.endsWith(".node"))).toBe(false);
		expect(manifest.optionalDependencies).toEqual({
			"@gajae-code/natives-darwin-arm64": "workspace:*",
			"@gajae-code/natives-darwin-x64": "workspace:*",
			"@gajae-code/natives-linux-arm64": "workspace:*",
			"@gajae-code/natives-linux-x64": "workspace:*",
			"@gajae-code/natives-win32-x64": "workspace:*",
		});
	});

	test("native platform package manifests constrain host os and cpu", async () => {
		const cases: Array<[string, string, string]> = [
			["packages/natives-darwin-arm64", "darwin", "arm64"],
			["packages/natives-darwin-x64", "darwin", "x64"],
			["packages/natives-linux-arm64", "linux", "arm64"],
			["packages/natives-linux-x64", "linux", "x64"],
			["packages/natives-win32-x64", "win32", "x64"],
		];

		for (const [dir, os, cpu] of cases) {
			const manifest = await readManifest(dir);
			expect(manifest.os).toEqual([os]);
			expect(manifest.cpu).toEqual([cpu]);
			expect(manifest.files).toEqual(["native", "README.md"]);
		}
	});

	test("release publish dry-run does not rewrite source manifests", async () => {
		const manifestPaths = [
			"packages/natives/package.json",
			"packages/coding-agent/package.json",
			"packages/stats/package.json",
		];
		const before = await Promise.all(manifestPaths.map(async (relativePath) => await Bun.file(path.join(repoRoot, relativePath)).text()));
		const proc = Bun.spawn(["bun", "scripts/ci-release-publish.ts", "--dry-run"], {
			cwd: repoRoot,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, stdout, stderr] = await Promise.all([
			proc.exited,
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		expect(stderr).toBe("");
		expect(exitCode).toBe(0);
		expect(stdout).toContain("DRY RUN stage pi_natives.linux-x64 into packages/natives-linux-x64/native");
		expect(stdout).not.toContain("Building Tailwind CSS");
		const after = await Promise.all(manifestPaths.map(async (relativePath) => await Bun.file(path.join(repoRoot, relativePath)).text()));
		expect(after).toEqual(before);
	});
});

describe("release bump set equals publish set", () => {
	test("every non-private packages/* manifest is published, and every published dir is non-private", async () => {
		const { Glob } = await import("bun");

		// release.ts bumps the version of EVERY non-private packages/*/package.json.
		const bumpableDirs = new Set<string>();
		const glob = new Glob("packages/*/package.json");
		for await (const rel of glob.scan(repoRoot)) {
			const manifest = (await Bun.file(path.join(repoRoot, rel)).json()) as PackageManifest;
			if (manifest.private === true) continue;
			bumpableDirs.add(path.dirname(rel).replaceAll(path.sep, "/"));
		}

		// ci-release-publish.ts publishes exactly the dirs in its exported `packages` array.
		const publishDirs = new Set<string>(publishPackages.map((pkg) => pkg.dir));

		expect(bumpableDirs.size).toBeGreaterThan(0);
		// Any non-private package that release.ts bumps but the publisher omits would
		// ship a 0.x tag whose npm version never advances. Any published dir that is
		// private would be skipped at publish time. Both break one-release-truth.
		expect([...publishDirs].sort()).toEqual([...bumpableDirs].sort());
	});
});
describe("immutable stable release contracts", () => {
	test("publisher configuration equals the closed 14-package evidence definition", () => {
		const publishedDirs = publishPackages.map(pkg => pkg.dir).sort();
		const evidencedDirs = PUBLIC_PACKAGE_DEFINITIONS.map(definition => definition.dir).sort();

		expect(PUBLIC_PACKAGE_DEFINITIONS).toHaveLength(14);
		expect(publishedDirs).toEqual(evidencedDirs);
	});

	test("pins npm registry and latest without accepting registry redirects", async () => {
		const publisher = await Bun.file(path.join(repoRoot, "scripts/ci-release-publish.ts")).text();
		expect(NPM_REGISTRY_URL).toBe("https://registry.npmjs.org/");
		expect(NPM_RELEASE_TAG).toBe("latest");
		expect(validateNpmRegistryUrl("https://registry.npmjs.org", "test").href).toBe(NPM_REGISTRY_URL);
		expect(() => validateNpmRegistryUrl("https://registry.npmjs.org.evil.invalid/", "test")).toThrow("must be");
		expect(publisher).toContain("assertPinnedNpmConfiguration");
		expect(publisher).toContain("assertPinnedPackagePublishConfig");
		expect(publisher).toContain("--registry=${NPM_REGISTRY_URL}");
		expect(publisher).toContain("--tag=${NPM_RELEASE_TAG}");
	});

	test("pushes main and the immutable version tag in one atomic refspec transaction", async () => {
		const releaseScript = await Bun.file(path.join(repoRoot, "scripts/release.ts")).text();
		expect(releaseAtomicPushArgs("1.2.3")).toEqual([
			"push",
			"--atomic",
			"origin",
			"HEAD:refs/heads/main",
			"refs/tags/v1.2.3:refs/tags/v1.2.3",
		]);
		expect(() => releaseAtomicPushArgs("1.2.3-rc.1")).toThrow("exact stable");
		expect(releaseScript).toContain("await pushReleaseRefsAtomically(version)");
		expect(releaseScript).not.toContain('git(["push", "origin", "main"])');
	});
	test("creates an unsigned lightweight tag despite tag.gpgSign and verifies lightweight or signed tag output by peeled commit", async () => {
		const releaseScript = await Bun.file(path.join(repoRoot, "scripts/release.ts")).text();
		const sourceCommit = "a".repeat(40);
		const annotatedTagObject = "b".repeat(40);
		const tag = "v1.2.3";

		expect(releaseScript).toContain('await git(["tag", "--no-sign", `v${version}`]);');
		expect(releaseScript).toContain('["ls-remote", "origin", "refs/heads/main", `refs/tags/${tag}`, `refs/tags/${tag}^{}`]');
		expect(releaseScript).not.toContain('["ls-remote", "--refs", "origin", "refs/heads/main", `refs/tags/${tag}`]');
		expect(() => assertAtomicPushRemoteState([
			`${sourceCommit}\trefs/heads/main`,
			`${sourceCommit}\trefs/tags/${tag}`,
		].join("\n"), sourceCommit, tag)).not.toThrow();
		expect(() => assertAtomicPushRemoteState([
			`${sourceCommit}\trefs/heads/main`,
			`${annotatedTagObject}\trefs/tags/${tag}`,
			`${sourceCommit}\trefs/tags/${tag}^{}`,
		].join("\n"), sourceCommit, tag)).not.toThrow();
		expect(() => assertAtomicPushRemoteState([
			`${sourceCommit}\trefs/heads/main`,
			`${annotatedTagObject}\trefs/tags/${tag}`,
			`${"c".repeat(40)}\trefs/tags/${tag}^{}`,
		].join("\n"), sourceCommit, tag)).toThrow("does not peel to the release commit");
	});
	test("release entrypoint accepts exact stable versions only and never suggests force-retag recovery", async () => {
		const releaseScript = await Bun.file(path.join(repoRoot, "scripts/release.ts")).text();

		expect(isStableReleaseVersion("1.2.3")).toBe(true);
		expect(isStableReleaseVersion("v1.2.3")).toBe(false);
		expect(isStableReleaseVersion("1.2.3-rc.1")).toBe(false);
		expect(isStableReleaseVersion("01.2.3")).toBe(false);
		expect(releaseScript).toContain("Refusing to reuse existing remote tag");
		expect(releaseScript).toContain("corrections require a newer version");
		expect(releaseScript).not.toContain("git tag -f");
		expect(releaseScript).toContain('git(["add", "--update"])');
		expect(releaseScript).not.toContain('git(["add", "."])');

	});
	test("release entrypoints accept only their declared mode-specific arguments", () => {
		expect(parseReleasePublishCli(["--dry-run"])).toEqual({ mode: "dry-run" });
		expect(parseReleasePublishCli(["--prepare-evidence", "--evidence-dir", "release-evidence"])).toEqual({
			mode: "prepare-evidence",
			evidenceDir: "release-evidence",
		});
		expect(() => parseReleasePublishCli(["--dry-run", "--evidence-dir", "release-evidence"])).toThrow("cannot be combined");
		expect(() => parseReleasePublishCli(["--prepare-evidence", "--evidence-dir", "one", "--evidence-dir", "two"])).toThrow("requires exactly");

		expect(parseReleaseCli(["watch"])).toEqual({ mode: "watch" });
		expect(parseReleaseCli(["1.2.3"])).toEqual({ mode: "release", version: "1.2.3" });
		expect(() => parseReleaseCli(["watch", "--verbose"])).toThrow("exactly one argument");
		expect(() => parseReleaseCli(["1.2.3", "--dry-run"])).toThrow("exactly one argument");
	});
	test("requires a successful stable GitHub release finalization receipt", () => {
		const finalizationJob = (conclusion: string | null, status = "completed") => ({
			databaseId: 1,
			status,
			conclusion,
			name: STABLE_GITHUB_RELEASE_FINALIZATION_JOB_NAME,
		});

		expect(classifyStableReleaseFinalizationReceipt([]).outcome).toBe("missing");
		expect(classifyStableReleaseFinalizationReceipt([finalizationJob("skipped")]).outcome).toBe("skipped");
		expect(classifyStableReleaseFinalizationReceipt([finalizationJob("cancelled")]).outcome).toBe("cancelled");
		expect(classifyStableReleaseFinalizationReceipt([finalizationJob("failure")]).outcome).toBe("failed");
		expect(classifyStableReleaseFinalizationReceipt([finalizationJob("success")]).outcome).toBe("success");
		expect(classifyStableReleaseFinalizationReceipt([finalizationJob("success", "in_progress")]).outcome).toBe("incomplete");
	});

	test("release checks fetched remote tags, typed CI observations, and version catalogs before committing", async () => {
		const releaseScript = await Bun.file(path.join(repoRoot, "scripts/release.ts")).text();
		const assertionIndex = releaseScript.indexOf("await assertReleaseVersionConsistency(version, publicPkgPaths)");
		const commitIndex = releaseScript.indexOf('git(["commit", "-m"');

		expect(releaseScript).toContain('git(["fetch", "--quiet", "origin", "--tags"])');
		expect(releaseScript).toContain("latestVerifiedRemoteStableTag");
		expect(releaseScript).toContain("--workflow ci.yml");
		expect(releaseScript).toContain("Cannot parse CI run query");
		expect(releaseScript).toContain("headSha");
		expect(releaseScript).toContain("await watchCI(`v${version}`)");
		expect(assertionIndex).toBeGreaterThan(-1);
		expect(assertionIndex).toBeLessThan(commitIndex);
	});
});


describe("native release binary coverage", () => {
	test("release workflow builds Intel macOS (darwin-x64) binaries again", async () => {
		const workflow = await Bun.file(path.join(repoRoot, ".github/workflows/ci.yml")).text();

		// The deprecated macos-13 runner pool stays retired; Intel coverage now
		// rides the supported macos-15-intel runner.
		expect(workflow).not.toContain("{ os: macos-13, platform: darwin, arch: x64 }");
		expect(workflow).toContain("{ os: macos-15-intel, platform: darwin, arch: x64, variant: baseline }");
		expect(workflow).toContain("target_id: darwin-x64");
		expect(workflow).toContain("binary_path: packages/coding-agent/binaries/gjc-darwin-x64");
		expect(workflow).toContain("{ os: macos-14, platform: darwin, arch: arm64 }");
		expect(workflow).toContain("target_id: darwin-arm64");
		expect(workflow).toContain("pattern: pi-natives-${{ matrix.platform }}-${{ matrix.arch }}*-h${{ needs.rust-hash.outputs.hash }}");
	});

	test("tag publication requires the non-skippable SDK closure", async () => {
		const workflow = await Bun.file(path.join(repoRoot, ".github/workflows/ci.yml")).text();

		expect(workflow).toContain("sdk_closure:");
		expect(workflow).toContain("run: bun run check:sdk-closure");
		expect(workflow).toContain("needs: [check, sdk_closure, native_linux, native_release, rust-hash]");
		expect(workflow).toContain("needs.sdk_closure.result == 'success'");
		expect(workflow).toContain("needs: [release_binary, release_github_verify, rust-hash, sdk_closure]");
	});

	test("linux native platform packages declare their glibc requirement", async () => {
		// The linux native addons are built against *-unknown-linux-gnu targets
		// only (see the ci.yml build matrix), so the platform packages must set
		// "libc" to keep npm/bun from installing a glibc-linked .node on musl
		// systems (e.g. Alpine), where dlopen fails with raw relocation errors.
		for (const dir of ["packages/natives-linux-x64", "packages/natives-linux-arm64"]) {
			const manifest = await readManifest(dir);
			expect(manifest.libc).toEqual(["glibc"]);
		}

		// libc is a linux-only selector; other platform packages must not set it.
		for (const dir of ["packages/natives-darwin-arm64", "packages/natives-darwin-x64", "packages/natives-win32-x64"]) {
			const manifest = await readManifest(dir);
			expect(manifest.libc).toBeUndefined();
		}
	});

	test("installer explains missing release assets with fallback guidance", async () => {
		const installer = await Bun.file(path.join(repoRoot, "scripts/install.sh")).text();

		expect(installer).toContain("No prebuilt GJC binary was found for ${PLATFORM}-${ARCH} in ${LATEST}.");
		expect(installer).toContain("Re-run this installer with --source");
		expect(installer).toContain("Expected asset URL: $BINARY_URL");
	});

	test("install tarball smoke includes linux x64 optional natives package", async () => {
		const installer = await Bun.file(path.join(repoRoot, "scripts/install-tests/run-ci.sh")).text();
		expect(installer).toContain("stage_linux_x64_optional_package");
		expect(installer).toContain("for pkg in utils natives-linux-x64 natives ai agent tui stats coding-agent gajae-code");
		expect(installer).toContain("@gajae-code/natives-linux-x64");
		expect(installer).toContain("gajae-code-natives-[0-9]*.tgz");
	});
});
