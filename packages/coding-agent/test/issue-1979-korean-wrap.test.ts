import { beforeAll, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@gajae-code/ai";
import { resetSettingsForTest, Settings } from "@gajae-code/coding-agent/config/settings";
import { AssistantMessageComponent } from "@gajae-code/coding-agent/modes/components/assistant-message";
import { HookSelectorComponent } from "@gajae-code/coding-agent/modes/components/hook-selector";
import { IrcSplitViewComponent } from "@gajae-code/coding-agent/modes/components/irc-sidebar";
import { IrcObservationLedger } from "@gajae-code/coding-agent/modes/irc-observation-ledger";
import { getThemeByName, setThemeInstance, theme } from "@gajae-code/coding-agent/modes/theme/theme";
import { Container, Text, TUI, visibleWidth } from "@gajae-code/tui";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

const WIDTH = 20;
const CONTENT_WIDTH = WIDTH - 2; // Assistant Markdown's left and right padding.
const SUFFIX = "끝-ISSUE-1979-SUFFIX";
const OPTION_LABELS = ["계속 진행", "다른 선택지를 입력"];

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true, cwd: process.cwd() });
	const themeInstance = await getThemeByName("red-claw");
	if (!themeInstance) throw new Error("Failed to load test theme");
	setThemeInstance(themeInstance);
});

function assistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-5.5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

function stripControls(text: string): string {
	return Bun.stripANSI(text).replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/gu, "");
}

function assertRowWidths(rows: string[], width: number): void {
	for (const [index, row] of rows.entries()) {
		expect(
			visibleWidth(row),
			`width ${width}, row ${index}: ${JSON.stringify(stripControls(row))}`,
		).toBeLessThanOrEqual(width);
	}
}

function compactWhitespace(text: string): string {
	return text.replaceAll(/\s/gu, "");
}

function occurrences(text: string, needle: string): number {
	return text.split(needle).length - 1;
}

function assertOrderedProse(rows: string[], width: number): void {
	const rendered = compactWhitespace(stripControls(rows.join("\n")));
	const markers = ["가나다라마바사아자", "가\u302e", "漢字,", "gpt-5.5!", "색상", "링크", "🙂‍↔️", SUFFIX];
	let cursor = 0;
	for (const marker of markers) {
		const compactMarker = compactWhitespace(marker);
		const index = rendered.indexOf(compactMarker, cursor);
		expect(index, `width ${width} must retain ${JSON.stringify(marker)} in prose order`).toBeGreaterThanOrEqual(
			cursor,
		);
		cursor = index + compactMarker.length;
	}
	expect(occurrences(rendered, compactWhitespace(SUFFIX)), `width ${width} must retain the complete suffix once`).toBe(
		1,
	);
	for (const grapheme of ["\u302e", "漢", "字"]) {
		expect(
			occurrences(rendered, grapheme),
			`width ${width} must retain ${JSON.stringify(grapheme)} exactly once`,
		).toBe(1);
	}
}

describe("issue #1979 Korean assistant prose wrap", () => {
	it("keeps Korean tone-mark prose bounded and lossless through selector lifecycle and resize reflow", async () => {
		// This is exactly one padded Markdown row at WIDTH: 9 composed Hangul syllables
		// occupy CONTENT_WIDTH cells. The following prose exercises CJK, punctuation,
		// ANSI/OSC input handling, the inline model name, and grapheme adjacency.
		const exactBoundary = "가나다라마바사아자";
		expect(visibleWidth(exactBoundary)).toBe(CONTENT_WIDTH);
		const toneMarkedSyllable = "가\u302e";
		expect(visibleWidth(toneMarkedSyllable)).toBe(2);
		expect(visibleWidth(`${exactBoundary}${toneMarkedSyllable}`)).toBe(CONTENT_WIDTH + 2);
		expect(visibleWidth(`${exactBoundary.slice(0, -1)}${toneMarkedSyllable}`)).toBe(CONTENT_WIDTH);
		const prose = `${exactBoundary}${toneMarkedSyllable}漢字, gpt-5.5! \x1b[36m색상\x1b[0m \x1b]8;;https://example.test\x07링크\x1b]8;;\x07🙂‍↔️${SUFFIX}`;

		const terminal = new VirtualTerminal(WIDTH, 24);
		const tui = new TUI(terminal);
		const chatContainer = new Container();
		const assistant = new AssistantMessageComponent(assistantMessage(prose));
		chatContainer.addChild(assistant);
		const splitView = new IrcSplitViewComponent(chatContainer, new IrcObservationLedger(), () => theme);
		const pendingMessagesContainer = new Container();
		const statusContainer = new Container();
		statusContainer.addChild(new Text("widget: ready", 1, 0));
		const todoContainer = new Container();
		const btwContainer = new Container();
		const statusLine = new Text("status: connected", 1, 0);
		const hookWidgetContainerAbove = new Container();
		const editorContainer = new Container();
		const editor = new Text("editor: ready", 1, 0);
		editorContainer.addChild(editor);
		const hookWidgetContainerBelow = new Container();

		const selected: string[] = [];
		const selector = new HookSelectorComponent(
			"응답 선택",
			OPTION_LABELS,
			option => selected.push(option),
			() => {},
			{
				customInput: { optionLabel: OPTION_LABELS[1]!, onSubmit: () => {} },
				tui,
			},
		);

		tui.addChild(splitView);
		tui.addChild(pendingMessagesContainer);
		tui.addChild(statusContainer);
		tui.addChild(todoContainer);
		tui.addChild(btwContainer);
		tui.addChild(statusLine);
		tui.addChild(hookWidgetContainerAbove);
		tui.addChild(editorContainer);
		tui.addChild(hookWidgetContainerBelow);
		tui.setBottomPinnedComponent(statusLine);
		try {
			tui.start();
			await terminal.waitForRender();

			const assistantRows = assistant.render(WIDTH);
			assertRowWidths(assistantRows, WIDTH);
			assertOrderedProse(assistantRows, WIDTH);

			const editorViewport = terminal.getViewport();
			assertRowWidths(editorViewport, WIDTH);
			const editorText = stripControls(editorViewport.join("\n"));
			assertOrderedProse(editorViewport, WIDTH);
			expect(editorText).toContain("status: connected");
			expect(editorText).toContain("widget: ready");
			expect(editorText).toContain("editor: ready");

			// Mirror production's editor-to-selector replacement after the transcript
			// and pinned status rail have already rendered together.
			editorContainer.detachChild(editor);
			editorContainer.clear();
			editorContainer.addChild(selector);
			tui.requestRender();
			await terminal.waitForRender();

			const initialViewport = terminal.getViewport();
			assertRowWidths(initialViewport, WIDTH);
			const initialText = stripControls(initialViewport.join("\n"));
			assertOrderedProse(initialViewport, WIDTH);
			expect(initialText).toContain("status: connected");
			expect(initialText).toContain("widget: ready");
			for (const label of OPTION_LABELS) expect(compactWhitespace(initialText)).toContain(compactWhitespace(label));

			// Focused labels may wrap and non-focused labels may truncate; only
			// coexistence with lossless assistant prose is asserted here.
			selector.handleInput("\x1b[B");
			selector.handleInput("\r");
			expect(selector.hasActiveInlineInput()).toBe(true);
			selector.handleInput("\x1b");
			expect(selector.hasActiveInlineInput()).toBe(false);
			expect(selected).toEqual([]);

			terminal.resize(WIDTH - 1, 24);
			await terminal.waitForRender();
			const narrowedViewport = terminal.getViewport();
			assertRowWidths(narrowedViewport, WIDTH - 1);
			const narrowedText = stripControls(narrowedViewport.join("\n"));
			assertOrderedProse(narrowedViewport, WIDTH - 1);
			for (const label of OPTION_LABELS) expect(compactWhitespace(narrowedText)).toContain(compactWhitespace(label));
			terminal.resize(WIDTH + 1, 24);
			await terminal.waitForRender();
			const reflowedViewport = terminal.getViewport();
			assertRowWidths(reflowedViewport, WIDTH + 1);
			const reflowedText = stripControls(reflowedViewport.join("\n"));
			assertOrderedProse(reflowedViewport, WIDTH + 1);
			for (const label of OPTION_LABELS) expect(compactWhitespace(reflowedText)).toContain(compactWhitespace(label));
		} finally {
			tui.stop();
		}
	});
});
