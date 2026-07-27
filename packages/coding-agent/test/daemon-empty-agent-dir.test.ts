import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { daemonPaths } from "@gajae-code/coding-agent/sdk/bus/daemon-paths";
import { runDaemonSmoke } from "@gajae-code/coding-agent/sdk/bus/telegram-daemon-cli";

/**
 * Every daemon path is built as `path.join(agentDir, "notifications")`, which
 * silently yields a *relative* path when the first segment is empty. The spawn
 * sites pass `--agent-dir` unconditionally, so `--agent-dir ""` used to make the
 * daemon write its lock, ownership, state, heartbeat and topic files into the
 * current working directory — inside whatever repository the user was in.
 *
 * `parseSdkInternalArgv` already rejects an empty `--agent-dir`; these lock the
 * same guard onto the daemon entry points.
 */

async function withTempCwd(fn: (dir: string) => Promise<void>): Promise<void> {
	// macOS resolves os.tmpdir() through a symlink, so compare against the real path.
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gjc-empty-agent-dir-")));
	const previous = process.cwd();
	process.chdir(dir);
	try {
		await fn(dir);
	} finally {
		process.chdir(previous);
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

describe("empty --agent-dir", () => {
	it("keeps daemon paths relative when the agent dir is empty (the hazard)", () => {
		// Documents *why* the guard is needed: path.join swallows the empty segment.
		expect(path.isAbsolute(daemonPaths("").dir)).toBe(false);
		expect(daemonPaths("").dir).toBe("notifications");
		// A real agent dir is unaffected.
		expect(daemonPaths("/home/u/.gjc/agent").dir).toBe("/home/u/.gjc/agent/notifications");
	});

	it("does not write daemon state into the working directory on an empty agent dir", async () => {
		await withTempCwd(async dir => {
			await runDaemonSmoke({ agentDir: "" });
			expect(fs.existsSync(path.join(dir, "notifications"))).toBe(false);
			// It falls back to its own temp dir instead of the cwd root.
			const fallback = fs.readdirSync(dir).filter(n => n.startsWith(".telegram-daemon-smoke-"));
			expect(fallback).toHaveLength(1);
		});
	});

	it("still honors an explicit agent dir", async () => {
		await withTempCwd(async dir => {
			const agentDir = path.join(dir, "agent");
			await runDaemonSmoke({ agentDir });
			expect(fs.existsSync(path.join(agentDir, "notifications"))).toBe(true);
			expect(fs.existsSync(path.join(dir, "notifications"))).toBe(false);
		});
	});
});
