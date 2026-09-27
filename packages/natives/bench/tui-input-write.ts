// A/B adapter: incremental input into a focused Editor with a rendered frame per key.
import "../../tui/test/render-goldens-env";
import { Editor, TUI } from "../../tui/src";
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

let inputIndex = 0;
const cases = [
	{
		id: "I01",
		run: async () => {
			const input = inputCorpus[inputIndex++]!;
			await editor.setText("");
			let typed = "";
			for (const character of input) {
				terminal.sendInput(character);
				typed += character;
				await terminal.waitForRender();
				if ((await editor.getText()) !== typed) throw new Error("Editor did not accept the typed input");
				if (!terminal.getViewport().join("\n").includes(typed)) {
					throw new Error("Input was not visible after its rendered frame");
				}
			}
		},
	},
];

await runAbSuite("tui-input-write", cases, 40).finally(async () => {
	await tui.stop();
});
