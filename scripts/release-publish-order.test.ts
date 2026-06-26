import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { normalizeFileDependencySpec, packages as publishPackages } from "./ci-release-publish";

interface PackageManifest {
	name: string;
	version: string;
	bin?: Record<string, string>;
	dependencies?: Record<string, string>;
	private?: boolean;
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
});
