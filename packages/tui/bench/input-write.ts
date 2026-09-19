// Pin capabilities before importing the renderer (also makes byte comparisons portable).
import "../test/render-goldens-env";
import { createHash } from "node:crypto";
import { highlightCode } from "@gajae-code/natives";
import { Container, Editor, Markdown, TUI } from "../src";
import { clearRenderCache } from "../src/components/markdown";
import { defaultEditorTheme, defaultMarkdownTheme } from "../test/test-themes";
import { VirtualTerminal } from "../test/virtual-terminal";

const colors = {
	comment: "\x1b[90m", keyword: "\x1b[35m", function: "\x1b[34m",
	variable: "\x1b[37m", string: "\x1b[32m", number: "\x1b[33m",
	type: "\x1b[36m", operator: "\x1b[37m", punctuation: "\x1b[37m",
};
const theme = { ...defaultMarkdownTheme, highlightCode: (code: string, lang?: string) => highlightCode(code, lang, colors).split("\n") };
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const tick = async () => {
	const pending = Promise.withResolvers<void>();
	process.nextTick(pending.resolve);
	await pending.promise;
};
class TimedTerminal extends VirtualTerminal {
	started = 0;
	elapsed = 0;
	override write(data: string): void {
		super.write(data);
		if (this.started && data.includes("\x1b[?2026l")) this.elapsed = performance.now() - this.started;
	}
}
const document = Array.from({ length: 30 }, (_, i) => `## Section ${i}\n\n**Native** highlight 한글\n\n\`\`\`typescript\nexport function value${i}(x: number) { return x + ${i}; }\n\`\`\`\n`).join("\n");
const results = [];
for (const scenario of ["transcript", "multiline-editor", "markdown-preparation"]) {
	clearRenderCache();
	const term = new TimedTerminal(100, 30);
	const tui = new TUI(term, false, { widthSettleMs: 0 });
	const transcript = new Container();
	for (let i = 0; i < 40; i++) transcript.addChild(new Markdown(`${document}\nmessage ${i}`, 0, 0, theme));
	const pending = new Markdown(document, 0, 0, theme);
	transcript.addChild(pending);
	const editor = new Editor(defaultEditorTheme);
	if (scenario === "multiline-editor") editor.setText(Array.from({ length: 1500 }, (_, i) => `row ${i} 한글 content`).join("\n"));
	tui.addChild(transcript);
	tui.addChild(editor);
	tui.setViewportAnchorComponent(transcript);
	tui.setViewportOutputSource({ identity: "fixture", revision: 0n });
	tui.setFocus(editor);
	const samples: number[] = [];
	const writes = createHash("sha256");
	try {
		tui.start();
		await term.waitForRender();
		for (let i = 0; i < 50; i++) {
			if (scenario === "markdown-preparation") tui.enqueueBeforeRender(() => pending.setText(`${document}\nlatest ${i}`));
			term.clearWriteLog();
			term.elapsed = 0;
			term.started = performance.now();
			term.sendInput("x");
			await tick();
			term.started = 0;
			if (!term.elapsed) throw new Error(`Missing synchronized write: ${scenario}/${i}`);
			if (i >= 10) samples.push(term.elapsed);
			writes.update(term.getWriteLog().join(""));
			await term.flush();
			if (!term.getViewport().join("\n").includes("x".repeat(i + 1))) throw new Error("Input not visible in same frame");
		}
		samples.sort((a, b) => a - b);
		results.push({ scenario, samples, p50: samples[20], p95: samples[38], writeSha256: writes.digest("hex"), viewportSha256: sha(term.getViewport().join("\n")) });
	} finally { tui.stop(); }
}
console.log(JSON.stringify({ bun: Bun.version, fixtureSha256: sha(document), samplesPerScenario: 40, results }, null, 2));
