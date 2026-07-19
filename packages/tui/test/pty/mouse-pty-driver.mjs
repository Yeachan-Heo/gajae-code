import * as assert from "node:assert/strict";
import * as path from "node:path";
import * as url from "node:url";
import * as pty from "node-pty";

const scenario = process.argv[2];
const bunBinary = process.env.BUN_BINARY;
const testDir = path.dirname(url.fileURLToPath(import.meta.url));
const fixture = path.join(testDir, "mouse-pty-fixture.ts");
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined));

if (!bunBinary) throw new Error("BUN_BINARY must identify the Bun executable that runs the PTY fixture.");
if (!scenario) throw new Error("A PTY scenario is required.");


function launchFixture(env = {}) {
	let captured = "";
	const terminal = pty.spawn("/bin/sh", ["-c", 'exec "$1" "$2"', "pty-fixture", bunBinary, fixture], {
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


async function waitForOutput(output, marker) {
	const deadline = Date.now() + 3_000;
	while (!output().includes(marker)) {
		if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${JSON.stringify(marker)}; output: ${JSON.stringify(output())}`);
		await new Promise(resolve => setTimeout(resolve, 10));
	}
}

async function run() {
	if (scenario === "plain-enable") {
		const { terminal, output } = launchFixture({ PTY_FIXTURE_MOUSE: "1" });
		try {
			await waitForOutput(output, "PTY_FIXTURE_READY");
			assert.match(output(), /\x1b\[\?1000h/);
			assert.match(output(), /\x1b\[\?1006h/);
		} finally {
			terminal.kill();
		}
		return;
	}

	if (scenario === "graceful-stop") {
		const { terminal, output } = launchFixture({ PTY_FIXTURE_MOUSE: "1" });
		try {
			await waitForOutput(output, "PTY_FIXTURE_READY");
			terminal.write("__exit__\r");
			await waitForOutput(output, "PTY_FIXTURE_STOPPED");
			assert.match(output(), /\x1b\[\?1000l/);
			assert.match(output(), /\x1b\[\?1006l/);
		} finally {
			terminal.kill();
		}
		return;
	}

	if (scenario === "sigterm") {
		const { terminal, output } = launchFixture({ PTY_FIXTURE_MOUSE: "1" });
		try {
			await waitForOutput(output, "PTY_FIXTURE_READY");
			terminal.kill("SIGTERM");
			await waitForOutput(output, "PTY_FIXTURE_STOPPED");
			assert.match(output(), /\x1b\[\?1000l/);
			assert.match(output(), /\x1b\[\?1006l/);
		} finally {
			terminal.kill();
		}
		return;
	}

	if (scenario === "multiplexer") {
		const { terminal, output } = launchFixture({ PTY_FIXTURE_MOUSE: "1", TMUX: "1" });
		try {
			await waitForOutput(output, "PTY_FIXTURE_READY");
			assert.doesNotMatch(output(), /\x1b\[\?1000h/);
			assert.doesNotMatch(output(), /\x1b\[\?1006h/);
		} finally {
			terminal.kill();
		}
		return;
	}

	if (scenario === "composer") {
		const { terminal, output } = launchFixture({ PTY_FIXTURE_MOUSE: "1" });
		const mouse = "\x1b[<0;3;4M";
		try {
			await waitForOutput(output, "PTY_FIXTURE_READY");
			terminal.write("composer");
			await waitForOutput(output, 'EDITOR:"composer"');
			terminal.write(mouse);
			terminal.write("!");
			await waitForOutput(output, 'EDITOR:"composer!"');
			assert.equal(output().includes(mouse), false);
		} finally {
			terminal.kill();
		}
		return;
	}

	throw new Error(`Unknown PTY scenario: ${scenario}`);
}

await run();
