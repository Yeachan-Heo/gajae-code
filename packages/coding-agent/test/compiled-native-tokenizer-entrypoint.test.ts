import { describe, expect, it } from "bun:test";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "../../..");
const devBuildScriptPath = path.join(repoRoot, "packages/coding-agent/scripts/build-binary.ts");
const releaseBuildScriptPath = path.join(repoRoot, "scripts/ci-release-build-binaries.ts");

describe("compiled binary native tokenizer entrypoint", () => {
	it("dev binary build embeds the lazy native tokenizer module", async () => {
		const source = await Bun.file(devBuildScriptPath).text();

		expect(source).toContain('const nativeTokenizerEntrypoint = "../natives/native/index.js";');
		expect(source).toContain("nativeTokenizerEntrypoint,");
	});

	it("release binary build embeds the lazy native tokenizer module", async () => {
		const source = await Bun.file(releaseBuildScriptPath).text();

		expect(source).toContain('const nativeTokenizerEntrypoint = "./packages/natives/native/index.js";');
		expect(source).toContain("nativeTokenizerEntrypoint,");
		expect(source).toContain("...workerEntrypoints,");
	});
});
