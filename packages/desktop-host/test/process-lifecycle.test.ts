import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

interface ShutdownCase {
	closeFails: boolean;
	deadlineMs?: number;
}
const cases: ShutdownCase[] = [{ closeFails: false }, { closeFails: true }, { closeFails: false, deadlineMs: 50 }];

test.each(cases)("signal shutdown preserves bounded exit authority (%j)", async ({ closeFails, deadlineMs }) => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-process-shutdown-"));
	const ready = path.join(root, "ready");
	const closed = path.join(root, "closed");
	const flushed = path.join(root, "flushed");
	const script = path.join(root, "probe.ts");
	const module = path.resolve(import.meta.dir, "../src/process-lifecycle.ts");
	let child: Bun.Subprocess<"pipe", "pipe", "pipe"> | undefined;
	try {
		await Bun.write(
			script,
			`
import { registerDesktopProcessShutdown } from ${JSON.stringify(module)};
registerDesktopProcessShutdown({
	async close() {
		await Bun.sleep(100);
		await Bun.write(${JSON.stringify(closed)}, "complete");
		if (${closeFails}) throw new Error("owned close rejection");
	},
	async flush() {
		await Bun.sleep(100);
		await Bun.write(${JSON.stringify(flushed)}, "complete");
	},
	onError() { process.stderr.write("observed close rejection\\n"); }
});
process.stdin.resume();
await Bun.write(${JSON.stringify(ready)}, "ready");
`,
		);
		child = Bun.spawn([process.execPath, script], {
			env: {
				PATH: process.env.PATH ?? "/usr/bin:/bin",
				HOME: root,
				...(deadlineMs === undefined ? {} : { GJC_CLEANUP_DEADLINE_MS: String(deadlineMs) }),
			},
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = Bun.readableStreamToText(child.stdout);
		const stderr = Bun.readableStreamToText(child.stderr);
		const deadline = Date.now() + 15000;
		while (!(await Bun.file(ready).exists())) {
			if (child.exitCode !== null) throw new Error(`Signal probe exited before readiness: ${await stderr}`);
			if (Date.now() >= deadline) throw new Error("Signal probe readiness timed out");
			await Bun.sleep(10);
		}
		child.kill("SIGTERM");
		expect(await child.exited).toBe(143);
		if (deadlineMs !== undefined) {
			expect(await Bun.file(closed).exists()).toBe(false);
			expect(await Bun.file(flushed).exists()).toBe(false);
			expect(await stderr).toContain(`cleanup deadline (${deadlineMs}ms) expired`);
		} else {
			expect(await Bun.file(closed).text()).toBe("complete");
			expect(await Bun.file(flushed).text()).toBe("complete");
			if (closeFails) expect(await stderr).toContain("observed close rejection");
			else expect(await stderr).not.toContain("observed close rejection");
		}
		await stdout;
	} finally {
		if (child && child.exitCode === null) {
			const owned = child;
			const force = setTimeout(() => owned.kill("SIGKILL"), 3000);
			try {
				owned.kill("SIGTERM");
				await owned.exited;
			} finally {
				clearTimeout(force);
			}
		}
		await fs.rm(root, { recursive: true, force: true });
	}
}, 30000);
