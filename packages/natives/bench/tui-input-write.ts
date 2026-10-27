// A/B adapter: incremental input into a focused Editor with a rendered frame per key.
import "../../tui/test/render-goldens-env";
import { Editor, renderMetrics, TUI } from "../../tui/src";
import { defaultEditorTheme } from "../../tui/test/test-themes";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";
import { runAbSuite } from "./ab-adapter";

// Distinct per-run prefixes keep Editor's line-layout cache from turning samples into lookups.
const inputCorpus = Array.from({ length: 1024 }, (_, index) => `${index.toString(36)} type a line`);
const terminal = new VirtualTerminal(80, 24);
const tui = new TUI(terminal, false, { widthSettleMs: 0 });
const editor = new Editor(defaultEditorTheme);
tui.addChild(editor);
tui.setFocus(editor);
tui.start();
await terminal.waitForRender();
renderMetrics.enable();

let inputIndex = 0;
const cases = [
	{
		id: "I01",
		run: async () => {
			// Cycle so any --iterations count stays valid; the index suffix keeps each
			// text distinct from its neighbours so layout caches do not short-circuit.
			const input = `${inputCorpus[inputIndex % inputCorpus.length]!}${Math.floor(inputIndex / inputCorpus.length)}`;
			inputIndex++;
			await editor.setText("");
			let typed = "";
			let renderMs = 0;
			for (const character of input) {
				// Time the frame work (#doRender + commit) the TUI records itself, not the
				// test terminal's fixed settle delay in waitForRender().
				renderMetrics.reset();
				terminal.sendInput(character);
				typed += character;
				await terminal.waitForRender();
				const frames = renderMetrics.snapshot().renderDurations;
				if (frames.count === 0) throw new Error("typing did not render a frame");
				renderMs += frames.meanMs * frames.count;
				if ((await editor.getText()) !== typed) throw new Error("Editor did not accept the typed input");
				if (!terminal.getViewport().join("\n").includes(typed)) {
					throw new Error("Input was not visible after its rendered frame");
				}
			}
			return { measuredMs: renderMs };
		},
	},
];

await runAbSuite("tui-input-write", cases, 40).finally(async () => {
	await tui.stop();
});
