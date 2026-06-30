import { describe, expect, test } from "bun:test";

const dockerfilePath = new URL("./tarball.dockerfile", import.meta.url);

function readPublishPackages(dockerfile: string): string[] {
	const match = dockerfile.match(/^PACKAGES=\(([^)]*)\)$/m);
	if (!match) throw new Error("tarball.dockerfile is missing PACKAGES=(...) publish list");
	return match[1].trim().split(/\s+/).filter(Boolean);
}

describe("tarball Verdaccio smoke publish list", () => {
	test("publishes native platform packages before the stable natives loader", async () => {
		const dockerfile = await Bun.file(dockerfilePath).text();
		const packages = readPublishPackages(dockerfile);
		const platformPackages = [
			"natives-darwin-arm64",
			"natives-darwin-x64",
			"natives-linux-arm64",
			"natives-linux-x64",
			"natives-win32-x64",
		];

		expect(packages).toEqual(expect.arrayContaining(platformPackages));
		const nativesIndex = packages.indexOf("natives");
		expect(nativesIndex).toBeGreaterThan(-1);
		for (const platformPackage of platformPackages) {
			expect(packages.indexOf(platformPackage)).toBeLessThan(nativesIndex);
		}
	});

	test("stages linux-x64 native artifacts into the platform package during the smoke", async () => {
		const dockerfile = await Bun.file(dockerfilePath).text();

		expect(dockerfile).toContain("stage_native_platform_artifacts \"$pkg\"");
		expect(dockerfile).toContain("natives-linux-x64) prefix=\"pi_natives.linux-x64\" ;;");
		expect(dockerfile).toContain("Expected linux-x64 native artifact matching ${prefix}*.node");
	});
});
