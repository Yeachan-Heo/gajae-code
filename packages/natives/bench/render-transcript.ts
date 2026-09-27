// A/B adapter: transcript rendering through public coding-agent components.
// Inventory suites `render-transcript` and `word-diff` (A-PI-DIFF, B-DIFF,
// C-HIGHLIGHT, E-H04, E-H05).
import type { AgentTool } from "@gajae-code/agent-core";
import type { AssistantMessage } from "@gajae-code/ai";
import type { TUI } from "@gajae-code/tui";
import { Settings } from "../../coding-agent/src/config/settings";
import { generateDiffString } from "../../coding-agent/src/edit/diff";
import { AssistantMessageComponent } from "../../coding-agent/src/modes/components/assistant-message";
import { renderDiff } from "../../coding-agent/src/modes/components/diff";
import { ToolExecutionComponent } from "../../coding-agent/src/modes/components/tool-execution";
import { initTheme } from "../../coding-agent/src/modes/theme/theme";
import { runAbSuite } from "./ab-adapter";

const WIDTH = 100;
const ui = { requestRender() {} } as TUI;
const tool = { name: "generic", label: "Generic" } as AgentTool;

await initTheme("dark");
await Settings.init({ inMemory: true, cwd: process.cwd() });

const markdown = (i: number) =>
	`### Result ${i}\n\nA realistic assistant response with **bold**, _italic_, and a list:\n\n- item ${i}\n- item ${i + 1}\n\n\`\`\`ts\nconst value = ${i};\nconsole.log(value);\n\`\`\`\n\n| file | status |\n| --- | --- |\n| src/${i}.ts | changed |\n`;
const toolOutput = (i: number) =>
	JSON.stringify({
		id: i,
		status: "ok",
		files: Array.from({ length: 8 }, (_, j) => ({ path: `src/file-${i}-${j}.ts`, lines: j * i, changed: j % 2 === 0 })),
		stdout: Array.from({ length: 20 }, (_, j) => `line ${j}: rendered output for ${i}`).join("\n"),
	});

const transcript = Array.from({ length: 200 }, (_, i) => {
	if (i % 2 === 0) {
		const message = { role: "assistant", content: [{ type: "text", text: markdown(i) }] } as AssistantMessage;
		return { kind: "assistant" as const, message, component: new AssistantMessageComponent(message) };
	}
	const component = new ToolExecutionComponent("generic", { command: "render", index: i }, {}, tool, ui);
	const result = { content: [{ type: "text", text: toolOutput(i) }] };
	component.updateResult(result, false);
	return { kind: "tool" as const, result, component };
});

function renderTranscript(): number {
	let lines = 0;
	for (const entry of transcript) {
		if (entry.kind === "assistant") entry.component.updateContent(entry.message);
		else entry.component.updateResult(entry.result, false);
		lines += entry.component.render(WIDTH).length;
	}
	return lines;
}

const sourceLines = Array.from({ length: 600 }, (_, i) => `\tconst value${i} = compute(alpha${i % 17}, omega${i % 23});`);
const before = sourceLines.join("\n");
const after = sourceLines.map((line, i) => (i % 7 === 0 ? line.replace("alpha", "delta") : line)).join("\n");
const wordPairs = Array.from({ length: 400 }, (_, i) => [
	`const value${i} = alpha${i % 17} + omega${i % 23};`,
	`const value${i} = delta${i % 19} + omega${i % 23};`,
]);

await runAbSuite(
	"render-transcript",
	[
		{ id: "R01", run: renderTranscript, warmup: 5 },
		{
			id: "R02",
			run: async () => {
				const diff = await generateDiffString(before, after);
				return renderDiff(diff.diff, { filePath: "fixture.ts" }).length;
			},
		},
		{
			id: "R03",
			run: () => {
				let length = 0;
				for (const [oldLine, newLine] of wordPairs) length += renderDiff(`-1|${oldLine}\n+1|${newLine}`, { filePath: "fixture.ts" }).length;
				return length;
			},
		},
	],
	50,
);
