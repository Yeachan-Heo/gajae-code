import { describe, expect, test } from "bun:test";
import * as path from "node:path";

const enabled = process.env.PI_TUI_PTY_TESTS === "1";
const driver = path.resolve(import.meta.dir, "mouse-pty-driver.mjs");
const nodeBinary = process.env.NODE_BINARY ?? "node";

async function runScenario(scenario: string, environment: Record<string, string> = {}): Promise<void> {
	const child = Bun.spawn([nodeBinary, driver, scenario], {
		cwd: process.cwd(),
		env: { ...process.env, ...environment, BUN_BINARY: process.execPath },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	expect(exitCode, `${stderr}\n${stdout}`).toBe(0);
}

/**
 * POSIX-only integration lane. node-pty's native callbacks are driven by Node,
 * while the fixture itself runs under Bun and exercises ProcessTerminal.
 */
describe.skipIf(!enabled || process.platform === "win32")("mouse PTY matrix", () => {
	test("emits SGR mouse enable bytes in a plain xterm PTY", async () => {
		await runScenario("plain-enable");
	});
	test("isolates plain scenarios from inherited multiplexer markers", async () => {
		await runScenario("plain-enable", {
			TMUX: "/tmp/tmux,1,0",
			TMUX_PANE: "%42",
			STY: "screen",
			ZELLIJ: "zellij",
			GJC_TMUX_LAUNCHED: "1",
		});
	});

	test("emits SGR mouse disable bytes on graceful stop", async () => {
		await runScenario("graceful-stop");
	});

	test("restores SGR mouse modes when SIGTERM detaches the TUI", async () => {
		await runScenario("sigterm");
	});

	test("emits no SGR mouse enable bytes under a multiplexer", async () => {
		await runScenario("multiplexer");
	});

	test("does not leak SGR mouse reports into composer text", async () => {
		await runScenario("composer");
	});
});
