// A/B adapter: TUI frame construction and rendering through public TUI entrypoints.
// Inventory suite `tui-render-frame` (B-TTY-WRITER, C-TEXT, C-POWER, C-APPEARANCE,
// E-TUI-MARKDOWN, E-TUI-RENDER-FRAME).
import { clearRenderCache, Markdown } from "../../tui/src/components/markdown";
import { Text } from "../../tui/src/components/text";
import { TUI } from "../../tui/src/tui";
import { makeRecordedSession } from "../../tui/test/replay-harness";
import { defaultMarkdownTheme } from "../../tui/test/test-themes";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";
import { runAbSuite } from "./ab-adapter";

const COLS = 120;
const ROWS = 40;

function transcriptLines(): string[] {
	const fixture = makeRecordedSession(260, 0x6002, COLS, ROWS);
	const lines: string[] = [];
	for (const [index, turn] of fixture.turns.entries()) {
		lines.push(`> ${turn.userText}`);
		lines.push(`**assistant ${index + 1}** ${turn.assistantChunks.join("")}`);
		if (turn.outputBlock) lines.push("```text", ...turn.outputBlock, "```");
		if (turn.toolLines) lines.push(...turn.toolLines);
	}
	return lines;
}

function markdownChunk(index: number): string {
	return [
		`## Section ${index}`,
		"Markdown rendering should preserve inline **bold**, _italic_, `code`, ~~deleted~~ text, links like https://example.test/path, and enough words to exercise wrapping.",
		"",
		"- first bullet with enough text to wrap at narrow widths",
		"  - nested bullet that should keep indentation stable",
		"",
		"| Column | Detail |",
		"| --- | --- |",
		`| ${index} | table cell with a longish value and **markdown** content |`,
		"",
		"> quoted text with _emphasis_ that wraps across terminal widths.",
		"",
		"```ts",
		`export function sample${index}(value: string): string {`,
		"\treturn value.trim().toUpperCase();",
		"}",
		"```",
	].join("\n");
}

const term = new VirtualTerminal(COLS, ROWS);
const tui = new TUI(term);
tui.start();
tui.addChild(new Text(transcriptLines().join("\n"), 1, 0));

async function renderFrame(): Promise<void> {
	const before = term.getWriteLog().length;
	tui.requestRender(false, "ab.tui-render-frame");
	await term.waitForRender();
	if (term.getWriteLog().length === before) throw new Error("render did not flush");
}

const markdownMessages = Array.from({ length: 20 }, (_, index) => markdownChunk(index));

await runAbSuite(
	"tui-render-frame",
	[
		{ id: "F01", run: renderFrame },
		{
			id: "F02",
			run: () => {
				// Global render/parse caches would otherwise turn every sample into a lookup.
				clearRenderCache();
				let lines = 0;
				for (const message of markdownMessages) lines += new Markdown(message, 0, 0, defaultMarkdownTheme).render(COLS).length;
				return lines;
			},
		},
	],
	100,
);
tui.stop();
