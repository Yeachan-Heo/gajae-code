import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Subprocess } from "bun";

test("real Bun HTTP/2 paused peer keeps write listeners bounded and tears down on deadline", async () => {
	const home = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-write-http2-"));
	let child: Subprocess | undefined;
	let timer: Timer | undefined;
	let timedOut = false;
	try {
		const proc = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures/cursor-write-paused-peer.ts")], {
			cwd: home,
			env: {
				HOME: home,
				GJC_AGENT_DIR: path.join(home, "agent"),
				PI_CODING_AGENT_DIR: path.join(home, "agent"),
				XDG_CONFIG_HOME: path.join(home, "config"),
				XDG_CACHE_HOME: path.join(home, "cache"),
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		child = proc;
		timer = setTimeout(() => {
			timedOut = true;
			proc.kill("SIGKILL");
		}, 10_000);
		const [code, stdout, stderr] = await Promise.all([
			proc.exited,
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		expect(timedOut, `paused-peer fixture timed out: ${stderr}`).toBe(false);
		expect(code, stderr).toBe(0);
		expect(stdout).toContain("paused-peer: bounded listeners, backpressure, timeout and cleanup verified");
		expect(stderr).not.toContain("MaxListenersExceededWarning");
	} finally {
		if (timer) clearTimeout(timer);
		if (child && child.exitCode === null) {
			child.kill("SIGKILL");
			await child.exited;
		}
		await fs.rm(home, { recursive: true, force: true });
	}
}, 15_000);
