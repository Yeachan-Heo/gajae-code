import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { normalizeFileDependencySpec, packages as publishPackages } from "./ci-release-publish";

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
}

const repoRoot = path.join(import.meta.dir, "..");

async function readManifest(relativePath: string): Promise<PackageManifest> {
	return (await Bun.file(path.join(repoRoot, relativePath, "package.json")).json()) as PackageManifest;
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
			bumpableDirs.add(path.dirname(rel));
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

describe("native release binary coverage", () => {
	test("release workflow builds Intel macOS (darwin-x64) binaries again", async () => {
		const workflow = await Bun.file(path.join(repoRoot, ".github/workflows/ci.yml")).text();

		// The deprecated macos-13 runner pool stays retired; Intel coverage now
		// rides the supported macos-15-intel runner.
		expect(workflow).not.toContain("{ os: macos-13, platform: darwin, arch: x64 }");
		expect(workflow).toContain("{ os: macos-15-intel, platform: darwin, arch: x64 }");
		expect(workflow).toContain("target_id: darwin-x64");
		expect(workflow).toContain("binary_path: packages/coding-agent/binaries/gjc-darwin-x64");
		expect(workflow).toContain("{ os: macos-14, platform: darwin, arch: arm64 }");
		expect(workflow).toContain("target_id: darwin-arm64");
		expect(workflow).toContain("pattern: pi-natives-${{ matrix.platform }}-${{ matrix.arch }}*-h${{ needs.rust-hash.outputs.hash }}");
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
