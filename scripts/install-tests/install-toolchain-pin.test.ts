import { describe, expect, test } from "bun:test";

const DOCKERFILES = ["binary.dockerfile", "source.dockerfile", "tarball.dockerfile"] as const;

async function readDockerfile(name: string): Promise<string> {
	return Bun.file(new URL(`./${name}`, import.meta.url)).text();
}

describe("install-test Dockerfiles use the rust-toolchain.toml pin", () => {
	for (const name of DOCKERFILES) {
		test(`${name} does not install a moving nightly`, async () => {
			const dockerfile = await readDockerfile(name);
			expect(dockerfile).not.toMatch(/--default-toolchain\s+nightly\b/);
			expect(dockerfile).toContain("--default-toolchain none");
		});

		test(`${name} installs the pinned toolchain after copying the repo`, async () => {
			const dockerfile = await readDockerfile(name);
			const copyIndex = dockerfile.indexOf("COPY . .");
			const installIndex = dockerfile.indexOf("rustup toolchain install");
			const buildIndex = dockerfile.indexOf("bun --cwd=packages/natives run build");
			expect(copyIndex).toBeGreaterThan(-1);
			expect(installIndex).toBeGreaterThan(copyIndex);
			expect(buildIndex).toBeGreaterThan(installIndex);
			expect(dockerfile).toContain("rustup show active-toolchain");
		});
	}
});
