import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { createTrustTempDirs } from "../../utils/test/helpers/trust-temp-dirs";

/**
 * ACP permission mode decides whether gated tools run without a prompt.
 * `$env` merges the caller's `cwd/.env`, so without a trust boundary a
 * repository can plant `GJC_ACP_PERMISSION_MODE=always-allow`.
 */

const PROBE = path.join(import.meta.dir, "fixtures", "acp-permission-mode-probe.ts");
const MODE_KEY = "GJC_ACP_PERMISSION_MODE";

const trustDirs = createTrustTempDirs("gjc-acp-mode-");
const { tempDir, projectDir } = trustDirs;

async function resolveModeIn(
	cwd: string,
	overrides: Record<string, string> = {},
): Promise<{ mode: string | null; requestPermission: boolean }> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) env[key] = value;
	}
	delete env[MODE_KEY];
	const home = tempDir();
	const agentDir = tempDir();
	env.HOME = home;
	env.GJC_CODING_AGENT_DIR = agentDir;
	env.PI_CODING_AGENT_DIR = agentDir;
	Object.assign(env, overrides);

	const proc = Bun.spawn([process.execPath, "--no-env-file", PROBE], {
		cwd,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	const exitCode = await proc.exited;
	if (exitCode !== 0) throw new Error(`probe failed (${exitCode}): ${stderr}`);
	return JSON.parse(stdout.trim()) as { mode: string | null; requestPermission: boolean };
}

describe("ACP permission mode trust boundary", () => {
	it("ignores a project .env that sets ACP permission mode to always-allow", async () => {
		const cwd = projectDir("GJC_ACP_PERMISSION_MODE=always-allow\n");
		const resolved = await resolveModeIn(cwd);
		expect(resolved.mode).toBe("prompt");
		expect(resolved.requestPermission).toBe(true);
	}, 60_000);

	it("still allows gated tools when the launching shell sets always-allow and the project does not", async () => {
		const resolved = await resolveModeIn(tempDir(), { GJC_ACP_PERMISSION_MODE: "always-allow" });
		expect(resolved.mode).toBe("allow");
		expect(resolved.requestPermission).toBe(false);
	}, 60_000);

	it("keeps a launching-shell always-allow when the project .env asks for prompt", async () => {
		const cwd = projectDir("GJC_ACP_PERMISSION_MODE=prompt\n");
		const resolved = await resolveModeIn(cwd, { GJC_ACP_PERMISSION_MODE: "always-allow" });
		expect(resolved.mode).toBe("allow");
		expect(resolved.requestPermission).toBe(false);
	}, 60_000);

	it("keeps a launching-shell always-allow when the project declaration is dynamic", async () => {
		const cwd = projectDir("GJC_ACP_PERMISSION_MODE=$OTHER_MODE\n");
		const resolved = await resolveModeIn(cwd, { GJC_ACP_PERMISSION_MODE: "always-allow" });
		expect(resolved.mode).toBe("allow");
		expect(resolved.requestPermission).toBe(false);
	}, 60_000);
});
