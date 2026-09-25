import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildCompileArgs, buildDevCompileArgs, buildReleaseCompileArgs } from "../scripts/compile-args";

// Issue #5940: a monolithic compiled bundle eagerly parses every lazily imported
// module, so even `gjc --version` pays for the whole app. The shared compile
// args must split code, and the split chunks must load from the compiled bunfs.
describe("compiled binary code splitting", () => {
	const tempRoots: string[] = [];

	afterAll(async () => {
		await Promise.all(tempRoots.map(root => fs.rm(root, { recursive: true, force: true })));
	});

	it("splits both dev and release compiled builds", () => {
		expect(buildDevCompileArgs()).toContain("--splitting");
		expect(buildReleaseCompileArgs("bun-linux-x64-baseline", "binaries/gjc")).toContain("--splitting");
	});

	it("loads dynamic imports from separate bunfs chunks while worker entrypoints keep their paths", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-compiled-splitting-"));
		tempRoots.push(root);
		await Bun.write(
			path.join(root, "src", "main.ts"),
			[
				'if (process.argv[2] === "worker") {',
				'\tconst worker = new Worker("./src/worker.ts", { type: "module" });',
				"\tworker.onmessage = event => {",
				"\t\tconsole.log(JSON.stringify({ worker: event.data }));",
				"\t\tworker.terminate();",
				"\t};",
				"} else {",
				'\tconst lazy = await import("./lazy");',
				"\tconsole.log(JSON.stringify({ main: import.meta.path, lazy: lazy.modulePath() }));",
				"}",
			].join("\n"),
		);
		await Bun.write(
			path.join(root, "src", "lazy.ts"),
			"export function modulePath(): string { return import.meta.path; }\n",
		);
		await Bun.write(path.join(root, "src", "worker.ts"), "self.postMessage(import.meta.path);\n");

		const outfile = path.join(root, "out", "app");
		const build = Bun.spawnSync(
			buildCompileArgs({ root: ".", entrypoints: ["./src/main.ts", "./src/worker.ts"], outfile }),
			{ cwd: root, stdout: "pipe", stderr: "pipe" },
		);
		expect(build.exitCode, build.stderr.toString()).toBe(0);

		// Run from an unrelated cwd so only the embedded bunfs can satisfy the imports.
		const runCwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-compiled-splitting-run-"));
		tempRoots.push(runCwd);
		const run = (args: string[]) => {
			const result = Bun.spawnSync([outfile, ...args], { cwd: runCwd, stdout: "pipe", stderr: "pipe" });
			expect(result.exitCode, result.stderr.toString()).toBe(0);
			return JSON.parse(result.stdout.toString()) as Record<string, string>;
		};

		const lazy = run([]);
		expect(lazy.main).toMatch(/\$bunfs\/root\//);
		expect(lazy.lazy).toMatch(/\$bunfs\/root\/lazy-[a-z0-9]+\.js$/);
		expect(lazy.lazy).not.toBe(lazy.main);

		expect(run(["worker"]).worker).toMatch(/\$bunfs\/root\/src\/worker\.js$/);
	}, 60_000);
});
