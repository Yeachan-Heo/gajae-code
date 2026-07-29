import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * `GJC_CONFIG_DIR` is documented as "Config root dirname under home", and
 * `dirs.ts` implements it that way (`path.join(os.homedir(), getConfigDirName())`).
 *
 * These three workflow settings readers used the value as a *full path*
 * (`GJC_CONFIG_DIR?.trim() || path.join(os.homedir(), ".gjc")`), so a user who
 * set it per the documented meaning had their settings looked up at a
 * cwd-relative path instead of under home, and silently got the built-in
 * defaults.
 *
 * The value is read at module load, so these drive a child process.
 */

const PROBE = path.join(import.meta.dir, "..", "fixtures", "config-root-settings-probe.ts");
const roots: string[] = [];

afterEach(() => {
	for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function scenario(settings: Record<string, unknown>, dirName = ".myconfig"): { home: string; repo: string } {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gjc-config-root-")));
	roots.push(root);
	const home = path.join(root, "home");
	const repo = path.join(root, "repo");
	fs.mkdirSync(path.join(home, dirName), { recursive: true });
	fs.mkdirSync(repo, { recursive: true });
	fs.writeFileSync(path.join(home, dirName, "settings.json"), JSON.stringify(settings));
	return { home, repo };
}

async function resolveIn(home: string, repo: string, configDir: string | undefined): Promise<Record<string, unknown>> {
	const env: Record<string, string | undefined> = { ...process.env, HOME: home, GJC_CONFIG_DIR: configDir };
	const proc = Bun.spawn([process.execPath, PROBE], { cwd: repo, env, stdout: "pipe", stderr: "pipe" });
	const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	if ((await proc.exited) !== 0) throw new Error(`probe failed: ${err}`);
	return JSON.parse(out.trim()) as Record<string, unknown>;
}

describe("config root is resolved under home", () => {
	it("reads ralplan settings from <home>/<GJC_CONFIG_DIR>", async () => {
		const { home, repo } = scenario({ "gjc.ralplan.maxIterations": 9 });
		const result = (await resolveIn(home, repo, ".myconfig")).ralplan as { maxIterations: number; source: string };

		expect(result.maxIterations).toBe(9);
		expect(result.source).toBe(path.join(home, ".myconfig", "settings.json"));
	});

	it("reads ultragoal settings from <home>/<GJC_CONFIG_DIR>", async () => {
		const { home, repo } = scenario({ "gjc.ultragoal.nudgeBudget": 7 });
		const result = (await resolveIn(home, repo, ".myconfig")).ultragoal as { budget: number; source: string };

		expect(result.budget).toBe(7);
		expect(result.source).toBe(path.join(home, ".myconfig", "settings.json"));
	});

	it("keeps using the default config dir name when unset", async () => {
		const { home, repo } = scenario({ "gjc.ralplan.maxIterations": 4 }, ".gjc");
		const result = (await resolveIn(home, repo, undefined)).ralplan as { maxIterations: number; source: string };

		expect(result.maxIterations).toBe(4);
		expect(result.source).toBe(path.join(home, ".gjc", "settings.json"));
	});
});
