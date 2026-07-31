import { ThinkingLevel } from "@gajae-code/agent-core";
import type { AssistantMessage, Usage } from "@gajae-code/ai";
import type { TUI } from "@gajae-code/tui";
import { settings } from "../../../src/config/settings";
import { AssistantMessageComponent } from "../../../src/modes/components/assistant-message";
import { BashExecutionComponent } from "../../../src/modes/components/bash-execution";
import { CustomMessageComponent } from "../../../src/modes/components/custom-message";
import { EvalExecutionComponent } from "../../../src/modes/components/eval-execution";
import { ProviderOnboardingSelectorComponent } from "../../../src/modes/components/provider-onboarding-selector";
import { ToolExecutionComponent } from "../../../src/modes/components/tool-execution";
import { TreeSelectorComponent } from "../../../src/modes/components/tree-selector";
import { UserMessageComponent } from "../../../src/modes/components/user-message";
import { WelcomeComponent } from "../../../src/modes/components/welcome";
import { theme } from "../../../src/modes/theme/theme";
import type { CustomMessage } from "../../../src/session/messages";
import type { SessionTreeNode } from "../../../src/session/session-manager";

/**
 * Deterministic production-backed consumer atlas for light-theme compliance.
 *
 * Instantiates the exact production components missing from the notifications
 * showcase surface and renders them with fixed copy, a no-op TUI, and no
 * network or filesystem I/O.
 */

export const LIGHT_THEME_CONSUMER_ATLAS_VIEWPORTS = [
	{ id: "80x128", columns: 80, rows: 128 },
	{ id: "120x128", columns: 120, rows: 128 },
	{ id: "160x128", columns: 160, rows: 128 },
] as const;

export type LightThemeConsumerAtlasViewport = (typeof LIGHT_THEME_CONSUMER_ATLAS_VIEWPORTS)[number];
export const LIGHT_THEME_CONSUMER_ATLAS_KEY_DISPLAY_PLATFORM = "darwin" as const;
export const LIGHT_THEME_CONSUMER_ATLAS_TRUE_COLOR = true;

export const LIGHT_THEME_CONSUMER_ATLAS_PRODUCTION_IMPORTS = [
	"packages/coding-agent/src/modes/components/provider-onboarding-selector.ts",
	"packages/coding-agent/src/modes/components/assistant-message.ts",
	"packages/coding-agent/src/modes/components/user-message.ts",
	"packages/coding-agent/src/modes/components/custom-message.ts",
	"packages/coding-agent/src/modes/components/tool-execution.ts",
	"packages/coding-agent/src/modes/components/bash-execution.ts",
	"packages/coding-agent/src/modes/components/eval-execution.ts",
	"packages/coding-agent/src/modes/components/welcome.ts",
	"packages/coding-agent/src/modes/components/tree-selector.ts",
	"packages/coding-agent/src/modes/theme/theme.ts",
] as const;

export const LIGHT_THEME_CONSUMER_ATLAS_PRODUCTION_SYMBOLS = [
	"ProviderOnboardingSelectorComponent",
	"AssistantMessageComponent",
	"UserMessageComponent",
	"CustomMessageComponent",
	"ToolExecutionComponent",
	"BashExecutionComponent",
	"EvalExecutionComponent",
	"TreeSelectorComponent",
	"WelcomeComponent",
	"getThinkingBorderColor",
] as const;

const SHOWCASE_TIMESTAMP_MS = 1_700_000_042_000;
const SHOWCASE_CWD = "/showcase";

const NOOP_TUI = {
	requestRender(): void {},
} as TUI;

const EMPTY_USAGE: Usage = {
	input: 128,
	output: 64,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 192,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const THINKING_LEVELS = [
	ThinkingLevel.Off,
	ThinkingLevel.Minimal,
	ThinkingLevel.Low,
	ThinkingLevel.Medium,
	ThinkingLevel.High,
	ThinkingLevel.XHigh,
] as const;

function makeAssistantMessage(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"],
	errorMessage?: string,
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "gjc-showcase",
		usage: EMPTY_USAGE,
		stopReason,
		errorMessage,
		timestamp: SHOWCASE_TIMESTAMP_MS,
	};
}

function makeCustomMessage(): CustomMessage {
	return {
		role: "custom",
		customType: "atlas-skill",
		content: "Custom atlas skill summary for light-theme evidence.",
		display: true,
		timestamp: SHOWCASE_TIMESTAMP_MS,
	};
}

function makeCompactionTree(): SessionTreeNode[] {
	return [
		{
			entry: {
				type: "compaction",
				id: "atlas-compaction",
				parentId: null,
				timestamp: new Date(SHOWCASE_TIMESTAMP_MS).toISOString(),
				summary: "Deterministic atlas compaction",
				firstKeptEntryId: "atlas-first-kept",
				tokensBefore: 10_000,
			},
			children: [],
		},
	];
}

function renderComponent(component: { render(width: number): string[] }, columns: number): string[] {
	return component.render(columns);
}

/**
 * Render the full consumer atlas for one viewport width/height.
 * Theme must already be configured by the caller. Restores
 * `display.showTokenUsage` after the assistant usage trailer is captured.
 */
export function renderLightThemeConsumerAtlas(viewport: LightThemeConsumerAtlasViewport): string {
	const lines: string[] = [];
	const disposables: Array<{ dispose(): void }> = [];

	const previousShowTokenUsage = settings.get("display.showTokenUsage");
	settings.set("display.showTokenUsage", true);

	try {
		lines.push(theme.bold(theme.fg("accent", "Consumer atlas")));
		lines.push(theme.fg("dim", "Exact production component inventory"));
		lines.push("");

		const provider = new ProviderOnboardingSelectorComponent(
			() => {},
			() => {},
		);
		lines.push(...renderComponent(provider, viewport.columns));
		lines.push("");

		const assistant = new AssistantMessageComponent(
			makeAssistantMessage(
				[
					{ type: "thinking", thinking: "Plan the deterministic consumer atlas path." },
					{ type: "text", text: "Atlas assistant body with header, thinking, error, and usage." },
				],
				"error",
				"showcase provider error",
			),
		);
		assistant.setUsageInfo(EMPTY_USAGE);
		lines.push(...renderComponent(assistant, viewport.columns));
		lines.push("");

		const user = new UserMessageComponent("Atlas user prompt: restore retained config.");
		lines.push(...renderComponent(user, viewport.columns));
		lines.push("");

		const custom = new CustomMessageComponent(makeCustomMessage());
		lines.push(...renderComponent(custom, viewport.columns));
		lines.push("");

		const pendingTool = new ToolExecutionComponent(
			"showcase-pending",
			{ command: "printf pending" },
			{},
			undefined,
			NOOP_TUI,
			SHOWCASE_CWD,
		);
		disposables.push(pendingTool);
		lines.push(...renderComponent(pendingTool, viewport.columns));
		lines.push("");

		const successTool = new ToolExecutionComponent(
			"showcase-success",
			{ command: "printf success" },
			{},
			undefined,
			NOOP_TUI,
			SHOWCASE_CWD,
		);
		successTool.updateResult({ content: [{ type: "text", text: "tool success output" }], isError: false }, false);
		disposables.push(successTool);
		lines.push(...renderComponent(successTool, viewport.columns));
		lines.push("");

		const errorTool = new ToolExecutionComponent(
			"showcase-error",
			{ command: "printf error" },
			{},
			undefined,
			NOOP_TUI,
			SHOWCASE_CWD,
		);
		errorTool.updateResult({ content: [{ type: "text", text: "tool error output" }], isError: true }, false);
		disposables.push(errorTool);
		lines.push(...renderComponent(errorTool, viewport.columns));
		lines.push("");

		const bash = new BashExecutionComponent("printf atlas-bash", NOOP_TUI, false);
		bash.appendOutput("atlas bash stdout\n");
		bash.setComplete(0, false);
		disposables.push(bash);
		lines.push(...renderComponent(bash, viewport.columns));
		lines.push("");

		const evalComponent = new EvalExecutionComponent('print("atlas-eval")', NOOP_TUI, false, "python");
		evalComponent.appendOutput("atlas eval stdout\n");
		evalComponent.setComplete(0, false);
		disposables.push(evalComponent);
		lines.push(...renderComponent(evalComponent, viewport.columns));
		lines.push("");

		const welcome = new WelcomeComponent(
			"0.0.0-atlas",
			"gjc-showcase",
			"anthropic",
			[{ name: "atlas-session", timeAgo: "1m" }],
			[],
			"ascii",
			{
				keyDisplayContext: { platform: LIGHT_THEME_CONSUMER_ATLAS_KEY_DISPLAY_PLATFORM },
				trueColor: LIGHT_THEME_CONSUMER_ATLAS_TRUE_COLOR,
			},
		);
		disposables.push(welcome);
		lines.push(...renderComponent(welcome, viewport.columns));
		lines.push("");
		const tree = new TreeSelectorComponent(
			makeCompactionTree(),
			"atlas-compaction",
			40,
			() => {},
			() => {},
		);
		disposables.push(tree);
		lines.push(...renderComponent(tree, viewport.columns));
		lines.push("");

		lines.push(theme.bold(theme.fg("accent", "Thinking border levels")));
		for (const level of THINKING_LEVELS) {
			const paint = theme.getThinkingBorderColor(level);
			lines.push(paint(`thinking-${level}`));
		}

		if (lines.length > viewport.rows) {
			throw new Error(`Consumer atlas exceeds ${viewport.id}: rendered ${lines.length} rows for ${viewport.rows}`);
		}
		while (lines.length < viewport.rows) lines.push("");
		return `${lines.map(line => line ?? "").join("\n")}\n`;
	} finally {
		for (const disposable of disposables) disposable.dispose();
		settings.set("display.showTokenUsage", previousShowTokenUsage);
	}
}
