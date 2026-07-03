import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { globPaths } from "../src/glob";

let tempDir: string | undefined;

async function makeTempDir(): Promise<string> {
	tempDir = await mkdtemp(join(tmpdir(), "gajae-glob-"));
	return tempDir;
}

afterEach(async () => {
	if (tempDir) {
		await rm(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	}
});

describe("globPaths", () => {
	it("applies exclude patterns without dropping included files", async () => {
		const cwd = await makeTempDir();
		await mkdir(join(cwd, "src"), { recursive: true });
		await mkdir(join(cwd, "dist"), { recursive: true });
		await writeFile(join(cwd, "src", "keep.ts"), "export const keep = true;\n");
		await writeFile(join(cwd, "dist", "skip.ts"), "export const skip = true;\n");

		const results = await globPaths("**/*.ts", { cwd, exclude: ["dist/**"] });

		expect(results.sort()).toEqual(["src/keep.ts"]);
	});

	it("keeps default node_modules excludes precompiled with custom excludes", async () => {
		const cwd = await makeTempDir();
		await mkdir(join(cwd, "node_modules", "pkg"), { recursive: true });
		await mkdir(join(cwd, "src"), { recursive: true });
		await writeFile(join(cwd, "node_modules", "pkg", "skip.ts"), "export {};\n");
		await writeFile(join(cwd, "src", "skip.test.ts"), "export {};\n");
		await writeFile(join(cwd, "src", "keep.ts"), "export {};\n");

		const results = await globPaths("**/*.ts", { cwd, exclude: ["**/*.test.ts"] });

		expect(results.sort()).toEqual(["src/keep.ts"]);
	});
});
