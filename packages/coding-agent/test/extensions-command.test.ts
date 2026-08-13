/**
 * Issue #4291 acceptance: `/extensions` is registered, discoverable, and
 * described exactly as "Configure skills, hooks, and MCPs."; it is strictly
 * local and interactive because its dashboard mutates trusted configuration.
 */
import { describe, expect, spyOn, test } from "bun:test";
import {
	BUILTIN_SLASH_COMMAND_DEFS,
	executeBuiltinSlashCommand,
	executeLocalHeadlessBuiltinSlashCommand,
	lookupBuiltinSlashCommand,
} from "@gajae-code/coding-agent/slash-commands/builtin-registry";
import type { SlashCommandRuntime } from "@gajae-code/coding-agent/slash-commands/types";

describe("/extensions slash command registration", () => {
	test("is registered with the exact owner-contract description", () => {
		const spec = lookupBuiltinSlashCommand("extensions");
		expect(spec).toBeDefined();
		expect(spec?.description).toBe("Configure skills, hooks, and MCPs.");
	});

	test("is discoverable through the autocomplete/help defs", () => {
		const def = BUILTIN_SLASH_COMMAND_DEFS.find(entry => entry.name === "extensions");
		expect(def).toBeDefined();
		expect(def?.description).toBe("Configure skills, hooks, and MCPs.");
	});

	test("exposes an interactive TUI handler", () => {
		const spec = lookupBuiltinSlashCommand("extensions");
		expect(typeof spec?.handleTui).toBe("function");
	});

	test("opens the local dashboard but has no headless dispatch authority", async () => {
		const showCustomizationDashboard = () => {};
		const setText = () => {};
		const command = "/extensions";
		const runtime = {
			ctx: { showCustomizationDashboard, editor: { setText } },
		};
		const dashboard = spyOn(runtime.ctx, "showCustomizationDashboard");
		const editor = spyOn(runtime.ctx.editor, "setText");

		expect(await executeBuiltinSlashCommand(command, runtime as never)).toBe(true);
		expect(dashboard).toHaveBeenCalledTimes(1);
		expect(editor).toHaveBeenCalledWith("");
		expect(
			await executeLocalHeadlessBuiltinSlashCommand(command, {
				output: async () => {},
			} as unknown as SlashCommandRuntime),
		).toBe(false);
	});

	test("has no text or ACP handler", () => {
		const spec = lookupBuiltinSlashCommand("extensions");
		expect(spec?.handle).toBeUndefined();
		expect(spec?.localHeadless).not.toBe(true);
		expect(spec?.acp).not.toBe(true);
	});
});
