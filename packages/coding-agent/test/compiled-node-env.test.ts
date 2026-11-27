import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildCompileArgs, devDefineFlags, releaseDefineFlags } from "../scripts/compile-args";

// `bun build --compile` inlines `process.env.NODE_ENV` as the literal "development"
// unless the build defines it. A shipped binary then ran every development/test-only
// branch (deep-frozen session snapshot copies, extra context clones, dev diagnostics)
// regardless of the runtime environment. NODE_ENV must stay a runtime value.
describe("compiled binary NODE_ENV", () => {
	const tempRoots: string[] = [];

	afterAll(async () => {
		await Promise.all(tempRoots.map(root => fs.rm(root, { recursive: true, force: true })));
	});

	for (const [channel, defines] of [
		["release", releaseDefineFlags],
		["dev", devDefineFlags],
	] as const) {
		it(`reads NODE_ENV from the runtime environment in ${channel} builds`, async () => {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-compiled-node-env-"));
			tempRoots.push(root);
			await Bun.write(
				path.join(root, "src", "main.ts"),
				[
					"const nodeEnv = process.env.NODE_ENV;",
					'const devOnly = process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test";',
					"console.log(JSON.stringify({ nodeEnv: nodeEnv ?? null, devOnly }));",
				].join("\n"),
			);
			// Release CI builds without NODE_ENV; `bun test` sets it, so strip it from the build too.
			const envWith = (nodeEnv: string | undefined): Record<string, string> => {
				const env: Record<string, string> = {};
				for (const [key, value] of Object.entries(Bun.env)) {
					if (key !== "NODE_ENV" && key !== "BUN_ENV" && value !== undefined) env[key] = value;
				}
				if (nodeEnv !== undefined) env.NODE_ENV = nodeEnv;
				return env;
			};
			const outfile = path.join(root, "out", "app");
			const build = Bun.spawnSync(
				buildCompileArgs({ root: ".", entrypoints: ["./src/main.ts"], outfile, defines }),
				{
					cwd: root,
					env: envWith(undefined),
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			expect(build.exitCode, build.stderr.toString()).toBe(0);

			const run = (nodeEnv: string | undefined) => {
				const result = Bun.spawnSync([outfile], {
					cwd: os.tmpdir(),
					env: envWith(nodeEnv),
					stdout: "pipe",
					stderr: "pipe",
				});
				expect(result.exitCode, result.stderr.toString()).toBe(0);
				return JSON.parse(result.stdout.toString()) as { nodeEnv: string | null; devOnly: boolean };
			};

			expect(run(undefined)).toEqual({ nodeEnv: null, devOnly: false });
			expect(run("production")).toEqual({ nodeEnv: "production", devOnly: false });
			expect(run("development")).toEqual({ nodeEnv: "development", devOnly: true });
		}, 60_000);
	}
});
