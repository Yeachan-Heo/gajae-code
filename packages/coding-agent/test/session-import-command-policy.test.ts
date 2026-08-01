import { describe, expect, it } from "bun:test";
import { ACP_BUILTIN_SLASH_COMMANDS, executeAcpBuiltinSlashCommand } from "../src/slash-commands/acp-builtins";
import {
	executeBuiltinSlashCommand,
	executeLocalHeadlessBuiltinSlashCommand,
	lookupBuiltinSlashCommand,
} from "../src/slash-commands/builtin-registry";
import type {
	AcpBuiltinCommandRuntime,
	SlashCommandRuntime,
	TuiSlashCommandRuntime,
} from "../src/slash-commands/types";

describe("session import command transport policy", () => {
	it("is never advertised or dispatched over ACP", async () => {
		expect(ACP_BUILTIN_SLASH_COMMANDS.some(command => command.name === "import-session")).toBe(false);
		const runtime = {
			output: async () => {
				throw new Error("ACP denial must happen before output or discovery");
			},
		} as unknown as AcpBuiltinCommandRuntime;
		expect(await executeAcpBuiltinSlashCommand("/import-session codex", runtime)).toBe(false);
	});

	it("retains a local handler and routes through the local TUI/headless adapter", async () => {
		const spec = lookupBuiltinSlashCommand("import-session");
		expect(spec).toMatchObject({ acp: false, localHeadless: true, allowArgs: true });
		expect(typeof spec?.handle).toBe("function");
		const output: string[] = [];
		const runtime = {
			ctx: {
				session: {},
				sessionManager: { getCwd: () => "/workspace" },
				settings: {},
				showStatus: (text: string) => output.push(text),
				refreshSlashCommandState: () => {},
				editor: { setText: () => {} },
			},
		} as unknown as TuiSlashCommandRuntime;
		expect(await executeBuiltinSlashCommand("/import-session unsupported", runtime)).toBe(true);
		expect(output).toEqual(["Usage: /import-session codex [session-id ...]"]);
	});

	it("dispatches through the explicit trusted local headless policy", async () => {
		const output: string[] = [];
		const runtime = {
			output: (text: string) => output.push(text),
		} as unknown as SlashCommandRuntime;
		expect(await executeLocalHeadlessBuiltinSlashCommand("/import-session unsupported", runtime)).toEqual({
			consumed: true,
		});
		expect(output).toEqual(["Usage: /import-session codex [session-id ...]"]);
	});
});
