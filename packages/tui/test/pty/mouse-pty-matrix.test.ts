import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { IPty } from "node-pty";

const enabled = process.env.PI_TUI_PTY_TESTS === "1";
const fixture = resolve(import.meta.dir, "mouse-pty-fixture.ts");
const baseEnv = Object.fromEntries(
	Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
);

type PtyModule = typeof import("node-pty");

let pty: PtyModule | undefined;
let capabilityReason = "PTY capability probe was not run.";

async function probePtyCapability(): Promise<boolean> {
	try {
		pty = await import("node-pty");
		const probe = pty.spawn("/bin/sh", ["-c", "exit 0"], {
			name: "xterm-256color",
			cols: 80,
			rows: 24,
			cwd: process.cwd(),
			env: { ...baseEnv, TERM: "xterm-256color" },
		});
		const exited = await new Promise<boolean>(resolveProbe => {
			const timeout = setTimeout(() => resolveProbe(false), 1_000);
			probe.onExit(() => {
				clearTimeout(timeout);
				resolveProbe(true);
			});
		});
		if (!exited) {
			probe.kill();
			capabilityReason = "node-pty capability probe timed out waiting for /bin/sh to exit.";
			return false;
		}
		return true;
	} catch (error) {
		capabilityReason = `node-pty capability probe failed: ${error instanceof Error ? error.message : String(error)}`;
		return false;
	}
}

const ptyAvailable = enabled && process.platform !== "win32" ? await probePtyCapability() : false;

function launchFixture(env: Record<string, string> = {}): { terminal: IPty; output: () => string } {
	if (!pty) throw new Error(capabilityReason);
	let captured = "";
	const terminal = pty.spawn("/bin/sh", ["-c", 'exec "$1" "$2"', "pty-fixture", process.execPath, fixture], {
		name: "xterm-256color",
		cols: 80,
		rows: 24,
		cwd: process.cwd(),
		env: { ...baseEnv, TERM: "xterm-256color", ...env },
	});
	terminal.onData(data => {
		captured += data;
	});
	terminal.onExit(event => {
		captured += `\nPTY_FIXTURE_EXIT:${event.exitCode}:${event.signal}\n`;
	});
	return { terminal, output: () => captured };
}

async function waitForOutput(output: () => string, marker: string): Promise<void> {
	const deadline = Date.now() + 3_000;
	while (!output().includes(marker)) {
		if (Date.now() >= deadline)
			throw new Error(`Timed out waiting for ${JSON.stringify(marker)}; output: ${JSON.stringify(output())}`);
		await Bun.sleep(10);
	}
}

/**
 * POSIX-only integration lane. Terminal ownership is intentionally exercised in
 * CI where node-pty can allocate a real pseudo terminal; normal unit tests do
 * not require native PTY bindings.
 */
describe.skipIf(!enabled || process.platform === "win32")("mouse PTY matrix", () => {
	test("requires a usable PTY capability when explicitly enabled", () => {
		expect(ptyAvailable, capabilityReason).toBe(true);
	});
	test("emits SGR mouse enable bytes in a plain xterm PTY", async () => {
		const { terminal, output } = launchFixture({ PTY_FIXTURE_MOUSE: "1" });
		try {
			await waitForOutput(output, "PTY_FIXTURE_READY");
			expect(output()).toContain("\x1b[?1000h");
			expect(output()).toContain("\x1b[?1006h");
		} finally {
			terminal.kill();
		}
	});

	test("emits SGR mouse disable bytes on graceful stop", async () => {
		const { terminal, output } = launchFixture({ PTY_FIXTURE_MOUSE: "1" });
		try {
			await waitForOutput(output, "PTY_FIXTURE_READY");
			terminal.write("__exit__\r");
			await waitForOutput(output, "PTY_FIXTURE_STOPPED");
			expect(output()).toContain("\x1b[?1000l");
			expect(output()).toContain("\x1b[?1006l");
		} finally {
			terminal.kill();
		}
	});

	test("restores SGR mouse modes when SIGTERM detaches the TUI", async () => {
		const { terminal, output } = launchFixture({ PTY_FIXTURE_MOUSE: "1" });
		try {
			await waitForOutput(output, "PTY_FIXTURE_READY");
			terminal.kill("SIGTERM");
			await waitForOutput(output, "PTY_FIXTURE_STOPPED");
			expect(output()).toContain("\x1b[?1000l");
			expect(output()).toContain("\x1b[?1006l");
		} finally {
			terminal.kill();
		}
	});

	test("emits no SGR mouse enable bytes under a multiplexer", async () => {
		const { terminal, output } = launchFixture({ PTY_FIXTURE_MOUSE: "1", TMUX: "1" });
		try {
			await waitForOutput(output, "PTY_FIXTURE_READY");
			expect(output()).not.toContain("\x1b[?1000h");
			expect(output()).not.toContain("\x1b[?1006h");
		} finally {
			terminal.kill();
		}
	});

	test("does not leak SGR mouse reports into composer text", async () => {
		const { terminal, output } = launchFixture({ PTY_FIXTURE_MOUSE: "1" });
		const mouse = "\x1b[<0;3;4M";
		try {
			await waitForOutput(output, "PTY_FIXTURE_READY");
			terminal.write("composer");
			await waitForOutput(output, 'EDITOR:"composer"');
			terminal.write(mouse);
			terminal.write("!");
			await waitForOutput(output, 'EDITOR:"composer!"');
			expect(output()).toContain('EDITOR:"composer!"');
			expect(output()).not.toContain(mouse);
		} finally {
			terminal.kill();
		}
	});
});
