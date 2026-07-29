import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Two SDK bus reads went through the merged view that includes the caller's
 * `cwd/.env`:
 *
 * - `notificationsEnabled()` decides whether the session control/answer channel
 *   opens at all. Its siblings in `config.ts` and `session-control.ts` already
 *   read an injected env record, so this direct read was the outlier.
 * - the Telegram reference client falls back to `GJC_TG_BOT_TOKEN`, which selects
 *   the bot that receives the session's notifications and the operator's replies.
 *   That client is normally run from inside a repository.
 *
 * `projectEnv` is parsed at module load from `process.cwd()`, so these drive a
 * child process with a controlled cwd.
 */

const PROBE = path.join(import.meta.dir, "fixtures", "sdk-bus-token-probe.ts");
const KEYS = ["GJC_NOTIFICATIONS", "GJC_NOTIFICATIONS_TOKEN", "GJC_TG_BOT_TOKEN"] as const;

interface Resolved {
	enabled: boolean;
	botToken: string | null;
}

const tempDirs: string[] = [];

function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-bus-trust-"));
	tempDirs.push(dir);
	return dir;
}

function projectDir(dotenv?: string): string {
	const dir = tempDir();
	if (dotenv !== undefined) fs.writeFileSync(path.join(dir, ".env"), dotenv);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function resolveIn(cwd: string, overrides: Record<string, string> = {}): Promise<Resolved> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) env[key] = value;
	}
	for (const key of KEYS) delete env[key];
	// `$credentialEnv` also consults the agent `.env`, the GJC config `.env`,
	// `~/.env` and the login shell rc files; keep all of them neutral.
	env.HOME = tempDir();
	env.GJC_CODING_AGENT_DIR = tempDir();
	Object.assign(env, overrides);

	const proc = Bun.spawn([process.execPath, PROBE], { cwd, env, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	const exitCode = await proc.exited;
	if (exitCode !== 0) throw new Error(`probe failed (${exitCode}): ${stderr}`);
	return JSON.parse(stdout.trim()) as Resolved;
}

describe("SDK bus token trust boundary", () => {
	it("keeps notifications disabled and no bot token by default", async () => {
		const resolved = await resolveIn(projectDir());
		expect(resolved.enabled).toBe(false);
		expect(resolved.botToken).toBeNull();
	});

	it("does not let the project .env enable the notifications channel", async () => {
		expect((await resolveIn(projectDir("GJC_NOTIFICATIONS_TOKEN=attacker-token\n"))).enabled).toBe(false);
	});

	it("does not let the project .env enable it through the flag either", async () => {
		expect((await resolveIn(projectDir("GJC_NOTIFICATIONS=1\n"))).enabled).toBe(false);
	});

	it("ignores a Telegram bot token planted by the project .env", async () => {
		expect((await resolveIn(projectDir("GJC_TG_BOT_TOKEN=attacker-bot\n"))).botToken).toBeNull();
	});

	it("still honors inherited notification settings", async () => {
		const resolved = await resolveIn(projectDir(), {
			GJC_NOTIFICATIONS_TOKEN: "operator-token",
			GJC_TG_BOT_TOKEN: "operator-bot",
		});
		expect(resolved.enabled).toBe(true);
		expect(resolved.botToken).toBe("operator-bot");
	});

	it("does not let the project .env override inherited settings", async () => {
		const resolved = await resolveIn(projectDir("GJC_TG_BOT_TOKEN=attacker-bot\n"), {
			GJC_TG_BOT_TOKEN: "operator-bot",
		});
		expect(resolved.botToken).toBe("operator-bot");
	});
});
