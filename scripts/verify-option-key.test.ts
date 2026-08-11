import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as plistlib from "./_plist-helpers";

const repoRoot = path.join(import.meta.dir, "..");
const scriptPath = path.join(repoRoot, "scripts", "verify-option-key.sh");

const tempRoots: string[] = [];

function makeExecutable(file: string, content: string): void {
	fs.writeFileSync(file, content);
	fs.chmodSync(file, 0o755);
}

function makeSandbox(): { root: string; binDir: string } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-option-key-test-"));
	tempRoots.push(root);
	const binDir = path.join(root, "bin");
	fs.mkdirSync(binDir, { recursive: true });
	return { root, binDir };
}

/**
 * Write a stub `defaults` command that serves pre-built plist files
 * based on the domain argument.
 *
 * The stub imitates `defaults export <domain> <output-path>`:
 * it copies the matching fixture plist to the output path and exits 0,
 * or exits 1 if no fixture is registered for the domain.
 */
function writeDefaultsStub(
	binDir: string,
	fixtures: { iterm?: string; terminal?: string; input?: string; itermFail?: boolean },
): void {
	const lines = ["#!/bin/sh", 'domain="$2"', 'output="$3"', ""];
	if (fixtures.iterm !== undefined) {
		lines.push(
			`if [ "$domain" = "com.googlecode.iterm2" ]; then`,
			`  ${fixtures.itermFail ? "exit 1" : `cp "${fixtures.iterm}" "$output"`}`,
			`  exit 0`,
			`fi`,
		);
	} else {
		lines.push(
			`if [ "$domain" = "com.googlecode.iterm2" ]; then exit 1; fi`,
		);
	}
	if (fixtures.terminal !== undefined) {
		lines.push(
			`if [ "$domain" = "com.apple.Terminal" ]; then`,
			`  cp "${fixtures.terminal}" "$output"`,
			`  exit 0`,
			`fi`,
		);
	} else {
		lines.push(`if [ "$domain" = "com.apple.Terminal" ]; then exit 1; fi`);
	}
	if (fixtures.input !== undefined) {
		lines.push(
			`if [ "$domain" = "com.apple.HIToolbox" ]; then`,
			`  cp "${fixtures.input}" "$output"`,
			`  exit 0`,
			`fi`,
		);
	} else {
		lines.push(`if [ "$domain" = "com.apple.HIToolbox" ]; then exit 1; fi`);
	}
	lines.push('echo "unknown domain: $domain" >&2', "exit 1");
	makeExecutable(path.join(binDir, "defaults"), lines.join("\n"));
}

function writeBunStub(binDir: string): void {
	makeExecutable(
		path.join(binDir, "bun"),
		'#!/bin/sh\nif [ "$1" = "--version" ]; then echo "1.3.14"; exit 0; fi\nexit 0\n',
	);
}

function writeGjcStub(binDir: string): void {
	makeExecutable(
		path.join(binDir, "gjc"),
		'#!/bin/sh\ncase "$1" in\n  --version) echo "gjc/0.12.16"; exit 0;;\n  --smoke-test) exit 0;;\nesac\nexit 0\n',
	);
}

interface RunResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

async function runScript(
	binDir: string,
	envOverrides?: Record<string, string>,
): Promise<RunResult> {
	const proc = Bun.spawn(["sh", scriptPath], {
		env: {
			...process.env,
			PATH: `${binDir}:/usr/bin:/bin`,
			...envOverrides,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { exitCode, stdout, stderr };
}

/** Build a valid iTerm2 plist with the given profiles. */
function writeItermFixture(
	root: string,
	profiles: Array<{
		name: string;
		leftOption: number;
		rightOption: number;
		keyboardMap?: Record<string, { Keycode: number; Modifiers: number }>;
	}>,
): string {
	const filePath = path.join(root, "iterm.plist");
	const bookmarks = profiles.map((p) => ({
		Name: p.name,
		"Option Key Sends": p.leftOption,
		"Right Option Key Sends": p.rightOption,
		"Keyboard Map": p.keyboardMap ?? {},
	}));
	plistlib.write(filePath, { "New Bookmarks": bookmarks });
	return filePath;
}

function writeTerminalFixture(
	root: string,
	profileName: string,
	useOptionAsMetaKey: boolean,
): string {
	const filePath = path.join(root, "terminal.plist");
	plistlib.write(filePath, {
		"Default Window Settings": profileName,
		"Startup Window Settings": profileName,
		"Window Settings": {
			[profileName]: { useOptionAsMetaKey },
		},
	});
	return filePath;
}

function writeInputFixture(root: string): string {
	const filePath = path.join(root, "input.plist");
	plistlib.write(filePath, {
		AppleCurrentKeyboardLayoutInputSourceID: "com.apple.keylayout.ABC",
		AppleSelectedInputSources: [
			{ InputSourceKind: "Keyboard Layout", "KeyboardLayout Name": "ABC" },
		],
	});
	return filePath;
}

afterEach(() => {
	for (const root of tempRoots) {
		fs.rmSync(root, { recursive: true, force: true });
	}
	tempRoots.length = 0;
});

describe("verify-option-key.sh", () => {
	describe("iTerm2 value 2 (OPT_ESC) passes", () => {
		test("both Default and tmux profiles with value 2 pass", async () => {
			const { root, binDir } = makeSandbox();
			const itermFix = writeItermFixture(root, [
				{ name: "Default", leftOption: 2, rightOption: 2 },
				{ name: "tmux", leftOption: 2, rightOption: 2 },
			]);
			const inputFix = writeInputFixture(root);
			writeDefaultsStub(binDir, { iterm: itermFix, input: inputFix });
			writeBunStub(binDir);
			writeGjcStub(binDir);

			const result = await runScript(binDir, { TERM_PROGRAM: "iTerm.app" });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("PASS");
			expect(result.stdout).toContain("value 2");
		});
	});

	describe("iTerm2 value 1 (OPT_META) fails", () => {
		test("value 1 for left option fails with exit 1", async () => {
			const { root, binDir } = makeSandbox();
			const itermFix = writeItermFixture(root, [
				{ name: "Default", leftOption: 1, rightOption: 2 },
				{ name: "tmux", leftOption: 2, rightOption: 2 },
			]);
			const inputFix = writeInputFixture(root);
			writeDefaultsStub(binDir, { iterm: itermFix, input: inputFix });
			writeBunStub(binDir);
			writeGjcStub(binDir);

			const result = await runScript(binDir, { TERM_PROGRAM: "iTerm.app" });

			expect(result.exitCode).toBe(1);
			expect(result.stdout).toContain("FAIL");
			expect(result.stdout).toContain("expected 2");
		});

		test("value 1 for right option fails with exit 1", async () => {
			const { root, binDir } = makeSandbox();
			const itermFix = writeItermFixture(root, [
				{ name: "Default", leftOption: 2, rightOption: 2 },
				{ name: "tmux", leftOption: 2, rightOption: 1 },
			]);
			const inputFix = writeInputFixture(root);
			writeDefaultsStub(binDir, { iterm: itermFix, input: inputFix });
			writeBunStub(binDir);
			writeGjcStub(binDir);

			const result = await runScript(binDir, { TERM_PROGRAM: "iTerm.app" });

			expect(result.exitCode).toBe(1);
			expect(result.stdout).toContain("FAIL");
			expect(result.stdout).toContain("expected 2");
		});
	});

	describe("duplicate Default/tmux profiles fail", () => {
		test("duplicate Default profile name fails with exit 1", async () => {
			const { root, binDir } = makeSandbox();
			const itermFix = writeItermFixture(root, [
				{ name: "Default", leftOption: 2, rightOption: 2 },
				{ name: "Default", leftOption: 2, rightOption: 2 },
				{ name: "tmux", leftOption: 2, rightOption: 2 },
			]);
			const inputFix = writeInputFixture(root);
			writeDefaultsStub(binDir, { iterm: itermFix, input: inputFix });
			writeBunStub(binDir);
			writeGjcStub(binDir);

			const result = await runScript(binDir, { TERM_PROGRAM: "iTerm.app" });

			expect(result.exitCode).toBe(1);
			expect(result.stdout).toContain("FAIL");
			expect(result.stdout).toContain("duplicate");
		});

		test("duplicate tmux profile name fails with exit 1", async () => {
			const { root, binDir } = makeSandbox();
			const itermFix = writeItermFixture(root, [
				{ name: "Default", leftOption: 2, rightOption: 2 },
				{ name: "tmux", leftOption: 2, rightOption: 2 },
				{ name: "tmux", leftOption: 2, rightOption: 2 },
			]);
			const inputFix = writeInputFixture(root);
			writeDefaultsStub(binDir, { iterm: itermFix, input: inputFix });
			writeBunStub(binDir);
			writeGjcStub(binDir);

			const result = await runScript(binDir, { TERM_PROGRAM: "iTerm.app" });

			expect(result.exitCode).toBe(1);
			expect(result.stdout).toContain("FAIL");
			expect(result.stdout).toContain("duplicate");
		});
	});

	describe("physical-keycode Option+Q/I mappings fail", () => {
		test("Option+Q physical keycode 0x0c with Option mask fails", async () => {
			const { root, binDir } = makeSandbox();
			const itermFix = writeItermFixture(root, [
				{
					name: "Default",
					leftOption: 2,
					rightOption: 2,
					keyboardMap: {
						"0xc-80000": { Keycode: 0x0c, Modifiers: 0x80000 },
					},
				},
				{ name: "tmux", leftOption: 2, rightOption: 2 },
			]);
			const inputFix = writeInputFixture(root);
			writeDefaultsStub(binDir, { iterm: itermFix, input: inputFix });
			writeBunStub(binDir);
			writeGjcStub(binDir);

			const result = await runScript(binDir, { TERM_PROGRAM: "iTerm.app" });

			expect(result.exitCode).toBe(1);
			expect(result.stdout).toContain("FAIL");
			expect(result.stdout).toContain("Option+Q");
		});

		test("Option+I physical keycode 0x22 with Option mask fails", async () => {
			const { root, binDir } = makeSandbox();
			const itermFix = writeItermFixture(root, [
				{ name: "Default", leftOption: 2, rightOption: 2 },
				{
					name: "tmux",
					leftOption: 2,
					rightOption: 2,
					keyboardMap: {
						"0x22-80000": { Keycode: 0x22, Modifiers: 0x80000 },
					},
				},
			]);
			const inputFix = writeInputFixture(root);
			writeDefaultsStub(binDir, { iterm: itermFix, input: inputFix });
			writeBunStub(binDir);
			writeGjcStub(binDir);

			const result = await runScript(binDir, { TERM_PROGRAM: "iTerm.app" });

			expect(result.exitCode).toBe(1);
			expect(result.stdout).toContain("FAIL");
			expect(result.stdout).toContain("Option+I");
		});
	});

	describe("character-code Option+Q/I mappings fail", () => {
		test("Option+Q character code 0x71 with Option mask fails", async () => {
			const { root, binDir } = makeSandbox();
			const itermFix = writeItermFixture(root, [
				{
					name: "Default",
					leftOption: 2,
					rightOption: 2,
					keyboardMap: {
						"0x71-80000": { Keycode: 0x71, Modifiers: 0x80000 },
					},
				},
				{ name: "tmux", leftOption: 2, rightOption: 2 },
			]);
			const inputFix = writeInputFixture(root);
			writeDefaultsStub(binDir, { iterm: itermFix, input: inputFix });
			writeBunStub(binDir);
			writeGjcStub(binDir);

			const result = await runScript(binDir, { TERM_PROGRAM: "iTerm.app" });

			expect(result.exitCode).toBe(1);
			expect(result.stdout).toContain("FAIL");
			expect(result.stdout).toContain("Option+Q");
		});

		test("Option+I character code 0x69 with Option mask fails", async () => {
			const { root, binDir } = makeSandbox();
			const itermFix = writeItermFixture(root, [
				{ name: "Default", leftOption: 2, rightOption: 2 },
				{
					name: "tmux",
					leftOption: 2,
					rightOption: 2,
					keyboardMap: {
						"0x69-80000": { Keycode: 0x69, Modifiers: 0x80000 },
					},
				},
			]);
			const inputFix = writeInputFixture(root);
			writeDefaultsStub(binDir, { iterm: itermFix, input: inputFix });
			writeBunStub(binDir);
			writeGjcStub(binDir);

			const result = await runScript(binDir, { TERM_PROGRAM: "iTerm.app" });

			expect(result.exitCode).toBe(1);
			expect(result.stdout).toContain("FAIL");
			expect(result.stdout).toContain("Option+I");
		});
	});

	describe("non-Darwin execution fails", () => {
		test("missing defaults command fails with exit 1", async () => {
			const { root, binDir } = makeSandbox();
			// Do NOT write a defaults stub — only bun and gjc
			writeBunStub(binDir);
			writeGjcStub(binDir);

			const result = await runScript(binDir, { TERM_PROGRAM: "iTerm.app" });

			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("defaults");
		});
	});

	describe("Terminal.app fallback", () => {
		test("Terminal.app with useOptionAsMetaKey=true passes when iTerm absent", async () => {
			const { root, binDir } = makeSandbox();
			const terminalFix = writeTerminalFixture(root, "Basic", true);
			const inputFix = writeInputFixture(root);
			writeDefaultsStub(binDir, {
				itermFail: true,
				terminal: terminalFix,
				input: inputFix,
			});
			writeBunStub(binDir);
			writeGjcStub(binDir);

			const result = await runScript(binDir, { TERM_PROGRAM: "Apple_Terminal" });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("PASS");
		});
	});
});
