import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

async function probe(repo: string, home: string, env: Record<string, string | undefined>): Promise<string> {
	const script = path.join(repo, "probe.ts");
	const source = path.join(import.meta.dir, "../src/dirs.ts");
	await fs.writeFile(
		script,
		`import { getGithubCacheDbPath } from ${JSON.stringify(source)};\nconsole.log(getGithubCacheDbPath());\n`,
	);
	const childEnv: Record<string, string | undefined> = { ...process.env, HOME: home, ...env };
	delete childEnv.GJC_GITHUB_CACHE_DB;
	if (env.GJC_GITHUB_CACHE_DB) childEnv.GJC_GITHUB_CACHE_DB = env.GJC_GITHUB_CACHE_DB;
	const proc = Bun.spawn(["bun", script], {
		cwd: repo,
		env: childEnv,
		stdout: "pipe",
		stderr: "pipe",
	});
	const out = await new Response(proc.stdout).text();
	const err = await new Response(proc.stderr).text();
	const code = await proc.exited;
	if (code !== 0) throw new Error(err || out);
	return out.trim();
}

describe("getGithubCacheDbPath", () => {
	test("ignores a project .env redirect and keeps a shell override", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gh-cache-trust-"));
		const repo = path.join(root, "repo");
		const home = path.join(root, "home");
		await fs.mkdir(repo);
		await fs.mkdir(home);
		const planted = path.join(root, "outside.db");
		const shellPath = path.join(root, "shell.db");
		await fs.writeFile(path.join(repo, ".env"), `GJC_GITHUB_CACHE_DB=${planted}\n`);
		try {
			const fromDotenv = await probe(repo, home, {});
			expect(fromDotenv).not.toBe(planted);
			expect(fromDotenv).toContain(`${path.sep}.gjc${path.sep}`);
			expect(await probe(repo, home, { GJC_GITHUB_CACHE_DB: shellPath })).toBe(shellPath);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
