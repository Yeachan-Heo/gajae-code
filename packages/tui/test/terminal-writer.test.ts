import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

describe.skipIf(process.platform === "win32")("Unix terminal writer", () => {
	it("loads the native writer on first TTY write and flushes ordered UTF-8 bytes on exit", () => {
		const terminalUrl = pathToFileURL(path.join(import.meta.dir, "../src/terminal.ts")).href;
		const frames = ["frame-1\r\n\x1b[31m한글𠀀é\uD800", "\x1b[0mframe-2\r\n"];
		const payload = frames.join("");
		const script = `
const terminalUrl = ${JSON.stringify(terminalUrl)};
const nativePaths = () => Object.keys(require.cache).filter(file => file.includes("/packages/natives/native/"));
await import(terminalUrl);
if (nativePaths().length !== 0) throw new Error("native addon loaded while importing the terminal");
Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
const { ProcessTerminal } = await import(terminalUrl);
const terminal = new ProcessTerminal();
for (const frame of ${JSON.stringify(frames)}) terminal.write(frame);
if (nativePaths().length === 0) throw new Error("first terminal write did not load the native writer");
process.exit(0);
`;
		const env: Record<string, string> = { ...process.env } as Record<string, string>;
		delete env.BUN_ENV;
		delete env.NODE_ENV;
		delete env.GJC_TUI_WRITE_LOG;
		delete env.PI_TUI_WRITE_LOG;
		const reference = Bun.spawnSync({
			cmd: [
				process.execPath,
				"--eval",
				`for (const frame of ${JSON.stringify(frames)}) process.stdout.write(frame);`,
			],
			env,
			stderr: "pipe",
			stdout: "pipe",
		});
		expect(reference.exitCode, reference.stderr.toString()).toBe(0);
		const result = Bun.spawnSync({
			cmd: [process.execPath, "--eval", script],
			env,
			stderr: "pipe",
			stdout: "pipe",
		});
		expect(result.exitCode, result.stderr.toString()).toBe(0);
		expect(result.stdout).toEqual(reference.stdout);
		expect(result.stdout).toEqual(Buffer.from(payload, "utf8"));
	});
});

describe.skipIf(process.platform !== "win32")("Windows console code page restore", () => {
	it("calls restore_console_code_pages_for_render before writing to stdout", () => {
		const terminalWriterUrl = pathToFileURL(path.join(import.meta.dir, "../src/terminal-writer.ts")).href;
		const script = `
const terminalWriterUrl = ${JSON.stringify(terminalWriterUrl)};

let restoreCalled = false;
let writeCalledAfterRestore = false;

const originalRequire = require;
const requireProxy = function(mod) {
	if (mod === "@gajae-code/natives") {
		return {
			restoreConsoleCodePagesForRender: () => {
				restoreCalled = true;
			},
		};
	}
	return originalRequire(mod);
};

const Module = require("module");
const originalRequireFunction = Module.prototype.require;
Module.prototype.require = requireProxy;

const originalWrite = process.stdout.write;
process.stdout.write = function(data) {
	if (restoreCalled) {
		writeCalledAfterRestore = true;
	}
	return originalWrite.call(this, data);
};

const mod = await import(terminalWriterUrl);
mod.writeTerminalOutput("test");

if (!restoreCalled) throw new Error("restoreConsoleCodePagesForRender was not called");
if (!writeCalledAfterRestore) throw new Error("write was not called after restore");

process.exit(0);
`;

		const result = Bun.spawnSync({
			cmd: [process.execPath, "--eval", script],
			stderr: "pipe",
			stdout: "pipe",
		});

		if (result.exitCode !== 0) {
			console.error("stderr:", result.stderr.toString());
		}
		expect(result.exitCode).toBe(0);
	});
});
