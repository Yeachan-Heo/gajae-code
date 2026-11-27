import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { PtySession } from "@gajae-code/natives";
import xterm from "@xterm/headless";

const root = path.resolve(import.meta.dir, "../../..");
const cli = path.join(root, "packages/coding-agent/src/cli.ts");
const guard = path.join(import.meta.dir, "fixtures/resume-picker-offline.ts");
const sessionId = "daf62692-1bf6-4a9a-831d-5e041eb807ce";

function quote(argument: string): string {
	if (/["\r\n]/.test(argument)) throw new Error("Unsafe PTY argument");
	return /\s/.test(argument) ? `"${argument}"` : argument;
}

async function isolatedEnvironment(directory: string): Promise<Record<string, string>> {
	const allowed = new Set([
		"PATH",
		"SYSTEMROOT",
		"WINDIR",
		"COMSPEC",
		"PATHEXT",
		"PROCESSOR_ARCHITECTURE",
		"NUMBER_OF_PROCESSORS",
		"PROGRAMFILES",
		"PROGRAMFILES(X86)",
		"PROGRAMDATA",
	]);
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined && allowed.has(key.toUpperCase())) env[key] = value;
	}
	for (const [key, relative] of Object.entries({
		HOME: "home",
		USERPROFILE: "home",
		APPDATA: "home/roaming",
		LOCALAPPDATA: "home/local",
		TEMP: "tmp",
		TMP: "tmp",
		XDG_CONFIG_HOME: "home/config",
		XDG_CACHE_HOME: "home/cache",
		XDG_DATA_HOME: "home/data",
		GJC_CODING_AGENT_DIR: "agent",
		GJC_LOG_DIR: "logs",
	})) {
		env[key] = path.join(directory, relative);
		await fs.mkdir(env[key], { recursive: true });
	}
	const empty = path.join(directory, "empty-config");
	await Bun.write(empty, "");
	return {
		...env,
		TERM: "xterm-256color",
		COLORTERM: "truecolor",
		DO_NOT_TRACK: "1",
		GJC_NOTIFY: "off",
		GJC_AUTOMATION: "1",
		GJC_DISABLE_TELEMETRY: "1",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: empty,
		NPM_CONFIG_USERCONFIG: empty,
		NPM_CONFIG_GLOBALCONFIG: empty,
	};
}

async function sessionFixture(cwd: string, extensive: boolean, tail: string): Promise<string> {
	const entries: object[] = [
		{ type: "session", version: 5, id: sessionId, timestamp: "2026-11-02T12:00:00Z", cwd },
		{
			type: "model_change",
			id: "model",
			parentId: null,
			timestamp: "2026-11-02T12:00:00Z",
			provider: "anthropic",
			modelId: "claude-opus-4-8",
		},
	];
	let parentId = "model";
	for (let index = 0; index < (extensive ? 160 : 1); index++) {
		const userId = `user-${index}`;
		entries.push({
			type: "message",
			id: userId,
			parentId,
			timestamp: "2026-11-02T12:00:00Z",
			message: {
				role: "user",
				content: [{ type: "text", text: "Synthetic picker regression" }],
				timestamp: 1793617200000,
			},
		});
		parentId = `assistant-${index}`;
		entries.push({
			type: "message",
			id: parentId,
			parentId: userId,
			timestamp: "2026-11-02T12:00:00Z",
			message: {
				role: "assistant",
				content: [
					{
						type: "text",
						text: Array.from(
							{ length: extensive ? 24 : 1 },
							(_, line) => `SYNTHETIC-HISTORY-${index}-${line}`,
						).join("\n"),
					},
				],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-opus-4-8",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 1793617200001,
			},
		});
	}
	if (tail === "error") {
		entries.pop();
		entries.push({
			type: "message",
			id: parentId,
			parentId: `user-${extensive ? 159 : 0}`,
			timestamp: "2026-11-02T12:00:00Z",
			message: {
				role: "assistant",
				content: [],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-opus-4-8",
				stopReason: "error",
				errorMessage: "Synthetic quota error",
				timestamp: 1793617200001,
			},
		});
	}
	return `${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`;
}

// Real Windows ConPTY: VirtualTerminal.sendInput bypasses the stdin lifecycle.
const cases = [
	["picker", false, false, "terminal"],
	["picker", true, false, "terminal"],
	["picker", false, true, "terminal"],
	["picker", true, true, "terminal"],
	["picker", false, false, "error"],
	["picker", true, false, "error"],
	["cancel", false, false, "terminal"],
	["cancel", true, false, "terminal"],
	["id", false, true, "terminal"],
	["id", true, true, "terminal"],
	["fresh", false, false, "terminal"],
	["fresh", true, false, "terminal"],
] as const;
test
	.skipIf(process.platform !== "win32")
	.each(
		cases.map(
			([route, herdr, extensive, tail]) =>
				[`${route}-herdr${herdr}-large${extensive}-${tail}`, route, herdr, extensive, tail] as const,
		),
	)(
	"CLI %s preserves picker handoff",
	async (_name, route, herdr, extensive, tailKind) => {
		const workspace = path.join(root, "artifacts/resume-picker-pty");
		await fs.mkdir(workspace, { recursive: true });
		const directory = await fs.mkdtemp(path.join(workspace, "isolated-"));
		const evidence = path.join(workspace, `${route}-${herdr}-${extensive}-${tailKind}-${Date.now()}`);
		const cwd = path.join(directory, "project");
		const sessions = path.join(directory, "sessions");
		await fs.mkdir(cwd, { recursive: true });
		await fs.mkdir(sessions, { recursive: true });
		const original = await sessionFixture(cwd, extensive, tailKind);
		const file = path.join(sessions, "synthetic.jsonl");
		if (route !== "fresh") await Bun.write(file, original);
		const env = await isolatedEnvironment(directory);
		if (herdr) env.HERDR_ENV = "1";
		const args = [process.execPath, "--preload", guard];
		args.push(cli, "--no-mcp", "--no-lsp", "--no-tools", "--no-rules", "--no-title", "--session-dir", sessions);
		if (route === "picker" || route === "cancel") args.push("--resume");
		if (route === "id") args.push("--resume", sessionId);
		const terminal = new xterm.Terminal({ cols: 100, rows: 30, scrollback: 20000, allowProposedApi: true });
		const pty = new PtySession();
		let raw = "";
		let done = false;
		let ioError: Error | null = null;
		terminal.onData(data => {
			if (!done) pty.write(data);
		});
		const run = pty
			.start(
				{
					command: args.map(quote).join(" "),
					shell: "cmd.exe",
					cwd,
					env,
					unsetEnv: Object.keys(process.env).filter(key => !(key in env)),
					cols: 100,
					rows: 30,
					timeoutMs: 90000,
				},
				(error, chunk) => {
					if (error) ioError = error;
					if (chunk) {
						raw += chunk;
						terminal.write(chunk);
					}
				},
			)
			.finally(() => {
				done = true;
			});
		async function flush(): Promise<void> {
			const { promise, resolve } = Promise.withResolvers<void>();
			terminal.write("", resolve);
			await promise;
		}
		function viewport(): string[] {
			const buffer = terminal.buffer.active;
			return Array.from(
				{ length: 30 },
				(_, row) => buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? "",
			);
		}
		function editor(): string {
			const lines = viewport();
			// ConPTY can wrap a corner onto the adjacent row. Locate the long
			// horizontal borders by either corner, without accepting raw echo.
			const bottom = lines.findLastIndex(line => /─{20,}/.test(line) && (line.includes("╰") || line.includes("╯")));
			const top = lines.findLastIndex(
				(line, index) => index < bottom && /─{20,}/.test(line) && (line.includes("╭") || line.includes("╮")),
			);
			return top >= 0 && bottom > top ? lines.slice(top + 1, bottom).join("\n") : "";
		}
		async function until(predicate: () => boolean, label: string, timeout = 30000): Promise<void> {
			const deadline = Date.now() + timeout;
			while (Date.now() < deadline) {
				await flush();
				if (predicate()) return;
				if (done) break;
				await Bun.sleep(50);
			}
			throw new Error(`${label}; done=${done}; ioError=${ioError}\n${viewport().join("\n")}`);
		}
		try {
			if (route === "picker" || route === "cancel") {
				await until(() => viewport().join("\n").includes("Synthetic picker regression"), "initial picker missing");
				if (route === "cancel") {
					pty.write("\x03\x03");
					await until(() => done, "picker cancellation did not exit", 10000);
					expect((await run).exitCode).toBe(0);
					expect(raw).not.toContain("GJC Forge");
					expect(await Bun.file(file).text()).toBe(original);
					return;
				}
				pty.write("\r");
			}
			const tail = `SYNTHETIC-HISTORY-${extensive ? 159 : 0}-${extensive ? 23 : 0}`;
			await until(
				() =>
					viewport().some(line => line.includes("╭")) &&
					(route === "fresh" ||
						viewport()
							.join("\n")
							.includes(tailKind === "error" ? "Synthetic quota error" : tail)),
				"final history and editor missing",
			);
			// Canonical echo between picker teardown and app startup is a false positive.
			// Wait for the FINAL interpreted editor to remain stable before writing.
			let stable = "";
			let stableSince = Date.now();
			await until(() => {
				const current = viewport().join("\n");
				if (current !== stable) {
					stable = current;
					stableSince = Date.now();
				}
				return Date.now() - stableSince >= 1500;
			}, "final prompt never stabilized");
			const marker = "PICKER-EDITOR-INPUT-OK";
			pty.write(marker);
			let typingFailure: unknown;
			try {
				await until(() => editor().includes(marker), "no interpreted echo INSIDE final editor", 5000);
			} catch (error) {
				typingFailure = error;
			}
			await Bun.write(path.join(evidence, "typed.txt"), viewport().join("\n"));
			pty.write("\x03");
			await Bun.sleep(300);
			await flush();
			expect(editor(), "Ctrl+C must clear the draft").not.toContain(marker);
			pty.write("AFTER-CANCEL");
			await until(() => editor().includes("AFTER-CANCEL"), "Ctrl+C did not leave editor usable", 5000);
			// Respect the CLI's intentional double-Ctrl+C exit shortcut.
			await Bun.sleep(1200);
			pty.write("\x03");
			await until(() => !editor().includes("AFTER-CANCEL"), "Ctrl+C did not clear draft", 5000);
			pty.write("/quit");
			await until(() => editor().includes("/quit"), "quit command missing from editor", 5000);
			pty.write("\r");
			await until(() => done, "/quit did not exit", 10000);
			expect((await run).exitCode).toBe(0);
			expect(typingFailure).toBeUndefined();
			if (route !== "fresh") expect(await Bun.file(file).text()).toStartWith(original);
		} finally {
			if (!done) pty.kill();
			await run;
			await flush();
			await Bun.write(path.join(evidence, "raw.ansi"), raw);
			await Bun.write(path.join(evidence, "final.txt"), viewport().join("\n"));
			terminal.dispose();
			await fs.rm(directory, { recursive: true, force: true });
		}
	},
	90000,
);
