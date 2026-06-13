import type { AgentTool } from "@gajae-code/agent-core";
import type { AssistantMessage } from "@gajae-code/ai";
import type { TUI } from "@gajae-code/tui";
import { initTheme } from "../src/modes/theme/theme";
import { AssistantMessageComponent } from "../src/modes/components/assistant-message";
import { ToolExecutionComponent } from "../src/modes/components/tool-execution";
import { Settings } from "../src/config/settings";

const WIDTH = 100;
const MESSAGE_COUNT = 1000;
const WARMUP_RUNS = 5;
const RUNS = 50;
const OUT = process.argv[2];

const ui = { requestRender() {} } as TUI;

const markdown = (i: number) => `### Result ${i}\n\nHere is a realistic assistant response with **bold**, _italic_, and a list:\n\n- item ${i}\n- item ${i + 1}\n\n\`\`\`ts\nconst value = ${i};\nconsole.log(value);\n\`\`\`\n\n| file | status |\n| --- | --- |\n| src/${i}.ts | changed |\n`;

const toolOutput = (i: number) => JSON.stringify({
	id: i,
	status: "ok",
	files: Array.from({ length: 8 }, (_, j) => ({ path: `src/file-${i}-${j}.ts`, lines: j * i, changed: j % 2 === 0 })),
	stdout: Array.from({ length: 20 }, (_, j) => `line ${j}: rendered output for ${i}`).join("\n"),
});

const tool = {
	name: "generic",
	label: "Generic",
} as AgentTool;

function buildTranscript() {
	return Array.from({ length: MESSAGE_COUNT }, (_, i) => {
		if (i % 2 === 0) {
			const message: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: markdown(i) }],
			};
			return { kind: "assistant" as const, message, component: new AssistantMessageComponent(message) };
		}
		const component = new ToolExecutionComponent("generic", { command: "render", index: i }, {}, tool, ui);
		const result = { content: [{ type: "text", text: toolOutput(i) }] };
		component.updateResult(result, false);
		return { kind: "tool" as const, result, component };
	});
}

function renderTranscript(components: ReturnType<typeof buildTranscript>): number {
	let lines = 0;
	for (const entry of components) {
		if (entry.kind === "assistant") {
			entry.component.updateContent(entry.message);
		} else {
			entry.component.updateResult(entry.result, false);
		}
		lines += entry.component.render(WIDTH).length;
	}
	return lines;
}

function percentile(values: number[], pct: number): number {
	const sorted = [...values].sort((a, b) => a - b);
	const index = Math.min(sorted.length - 1, Math.ceil((pct / 100) * sorted.length) - 1);
	return sorted[index] ?? 0;
}

await initTheme("dark");
await Settings.init({ inMemory: true, cwd: process.cwd() });
const components = buildTranscript();
for (let i = 0; i < WARMUP_RUNS; i++) renderTranscript(components);

const samples: number[] = [];
let renderedLines = 0;
for (let i = 0; i < RUNS; i++) {
	const start = Bun.nanoseconds();
	renderedLines = renderTranscript(components);
	samples.push((Bun.nanoseconds() - start) / 1e6);
}

const result = {
	bench: "coding-agent-render-transcript",
	metadata: {
		messageCount: MESSAGE_COUNT,
		width: WIDTH,
		runs: RUNS,
		warmupRuns: WARMUP_RUNS,
		renderedLines,
		bun: Bun.version,
		platform: process.platform,
		arch: process.arch,
	},
	metrics: {
		minMs: Math.min(...samples),
		meanMs: samples.reduce((sum, value) => sum + value, 0) / samples.length,
		p50Ms: percentile(samples, 50),
		p95Ms: percentile(samples, 95),
		maxMs: Math.max(...samples),
	},
	samplesMs: samples,
};

const json = `${JSON.stringify(result, null, 2)}\n`;
if (OUT) {
	await Bun.write(OUT, json);
} else {
	process.stdout.write(json);
}
