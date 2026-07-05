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
	it("returns each path once when patterns overlap", async () => {
		const cwd = await makeTempDir();
		await mkdir(join(cwd, "src"), { recursive: true });
		await writeFile(join(cwd, "src", "a.ts"), "export {};\n");
		await writeFile(join(cwd, "src", "b.ts"), "export {};\n");

		const results = await globPaths(["**/*.ts", "src/*.ts"], { cwd });

		expect(results.sort()).toEqual(["src/a.ts", "src/b.ts"]);
		expect(results.length).toBe(new Set(results).size);
	});

	it("anchors slash-containing gitignore patterns to the gitignore directory", async () => {
		const cwd = await makeTempDir();
		await mkdir(join(cwd, "sub"), { recursive: true });
		await mkdir(join(cwd, "other", "sub"), { recursive: true });
		await writeFile(join(cwd, ".gitignore"), "sub/skip.ts\n");
		await writeFile(join(cwd, "sub", "skip.ts"), "export {};\n");
		await writeFile(join(cwd, "other", "sub", "skip.ts"), "export {};\n");

		const results = await globPaths("**/*.ts", { cwd, gitignore: true });

		expect(results.sort()).toEqual(["other/sub/skip.ts"]);
	});

	it("anchors slash-containing directory gitignore patterns to the gitignore directory", async () => {
		const cwd = await makeTempDir();
		await mkdir(join(cwd, "sub", "dist"), { recursive: true });
		await mkdir(join(cwd, "other", "sub", "dist"), { recursive: true });
		await writeFile(join(cwd, ".gitignore"), "sub/dist/\n");
		await writeFile(join(cwd, "sub", "dist", "skip.ts"), "export {};\n");
		await writeFile(join(cwd, "other", "sub", "dist", "keep.ts"), "export {};\n");

		const results = await globPaths("**/*.ts", { cwd, gitignore: true });

		expect(results.sort()).toEqual(["other/sub/dist/keep.ts"]);
	});

	it("matches slash-free gitignore patterns at any depth", async () => {
		const cwd = await makeTempDir();
		await mkdir(join(cwd, "sub"), { recursive: true });
		await mkdir(join(cwd, "other", "sub"), { recursive: true });
		await writeFile(join(cwd, ".gitignore"), "skip.ts\n");
		await writeFile(join(cwd, "sub", "skip.ts"), "export {};\n");
		await writeFile(join(cwd, "other", "sub", "skip.ts"), "export {};\n");
		await writeFile(join(cwd, "sub", "keep.ts"), "export {};\n");

		const results = await globPaths("**/*.ts", { cwd, gitignore: true });

		expect(results.sort()).toEqual(["sub/keep.ts"]);
	});

	it("matches **/-prefixed gitignore patterns at any depth", async () => {
		const cwd = await makeTempDir();
		await mkdir(join(cwd, "sub"), { recursive: true });
		await mkdir(join(cwd, "other", "sub"), { recursive: true });
		await writeFile(join(cwd, ".gitignore"), "**/sub/skip.ts\n");
		await writeFile(join(cwd, "sub", "skip.ts"), "export {};\n");
		await writeFile(join(cwd, "other", "sub", "skip.ts"), "export {};\n");
		await writeFile(join(cwd, "sub", "keep.ts"), "export {};\n");

		const results = await globPaths("**/*.ts", { cwd, gitignore: true });

		expect(results.sort()).toEqual(["sub/keep.ts"]);
	});

	it("anchors parent-directory gitignore patterns relative to that gitignore", async () => {
		const root = await makeTempDir();
		const cwd = join(root, "proj");
		await mkdir(join(cwd, "sub"), { recursive: true });
		await mkdir(join(cwd, "other", "sub"), { recursive: true });
		await writeFile(join(root, ".gitignore"), "proj/sub/skip.ts\n");
		await writeFile(join(cwd, "sub", "skip.ts"), "export {};\n");
		await writeFile(join(cwd, "other", "sub", "skip.ts"), "export {};\n");

		const results = await globPaths("**/*.ts", { cwd, gitignore: true });

		expect(results.sort()).toEqual(["other/sub/skip.ts"]);
	});
});
