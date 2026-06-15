import { beforeAll, describe, expect, test, vi } from "bun:test";
import type { Model } from "@gajae-code/ai";
import { getThemeByName, setThemeInstance, theme } from "@gajae-code/coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@gajae-code/coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@gajae-code/coding-agent/slash-commands/builtin-registry";
import { Text } from "@gajae-code/tui";

function model(provider: string, id: string): Model {
	return { provider, id } as unknown as Model;
}

function stripAnsi(text: string): string {
	return text
		.replace(/\x1b\[[0-9;]*m/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

function createTuiRuntime() {
	const added: unknown[] = [];
	const showStatus = vi.fn();
	const requestRender = vi.fn();
	const setText = vi.fn();
	const session = {
		model: model("anthropic", "claude-sonnet-4-5"),
		isFastForProvider: (provider?: string) => provider === "anthropic",
		isFastForSubagentProvider: (provider?: string) => provider === "anthropic",
		resolveRoleModelWithThinking: (role: string) => {
			if (role === "default") return { model: model("anthropic", "claude-sonnet-4-5") };
			if (role === "executor") return { model: model("openai", "gpt-5") };
			return { model: undefined };
		},
		// The status branch must use the provider-aware predicate, never this.
		isFastModeEnabled: () => {
			throw new Error("/fast status must not call isFastModeEnabled");
		},
	};
	const ctx = {
		session,
		chatContainer: {
			addChild: (child: unknown) => {
				added.push(child);
			},
		},
		ui: { requestRender },
		editor: { setText },
		showStatus,
	};
	return {
		runtime: { ctx: ctx as unknown as InteractiveModeContext, handleBackgroundCommand: () => {} },
		added,
		showStatus,
		requestRender,
		setText,
	};
}

describe("/fast status TUI rendering", () => {
	beforeAll(async () => {
		const installed = await getThemeByName("red-claw");
		if (!installed) throw new Error("Failed to load theme for /fast status TUI test");
		setThemeInstance(installed);
	});
	test("AC-5: renders a multiline transcript panel, clears the editor, and never uses showStatus", async () => {
		const { runtime, added, showStatus, requestRender, setText } = createTuiRuntime();

		const result = await executeBuiltinSlashCommand("/fast status", runtime);

		expect(result).toBe(true);
		// Multiline transcript rendering — not a single-line status toast.
		expect(showStatus).not.toHaveBeenCalled();
		expect(requestRender).toHaveBeenCalled();
		expect(setText).toHaveBeenCalledWith("");

		const textChildren = added.filter((child): child is Text => child instanceof Text);
		expect(textChildren.length).toBeGreaterThan(0);

		const rendered = stripAnsi(textChildren.map(child => child.render(220).join("\n")).join("\n"));
		expect(rendered).toContain(`현재 모델: anthropic/claude-sonnet-4-5 ${theme.icon.fast}`);
		expect(rendered).toContain("DEFAULT: anthropic/claude-sonnet-4-5");
		expect(rendered).toContain("EXECUTOR: openai/gpt-5 off");
		// The OpenAI executor row under claude-only scope shows no fast glyph.
		expect(rendered).not.toContain(`openai/gpt-5 ${theme.icon.fast}`);
	});
});
