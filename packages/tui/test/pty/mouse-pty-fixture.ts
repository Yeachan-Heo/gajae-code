import { Editor } from "../../src/components/editor";
import { emergencyTerminalRestore, ProcessTerminal } from "../../src/terminal";
import { TUI } from "../../src/tui";
import { defaultEditorTheme } from "../test-themes";

const terminal = new ProcessTerminal();
const tui = new TUI(terminal, undefined, { enableMouse: process.env.PTY_FIXTURE_MOUSE === "1" });
const editor = new Editor(defaultEditorTheme);
let stopped = false;

function stop(graceful = false): void {
	if (stopped) return;
	stopped = true;
	if (graceful) tui.stop();
	else emergencyTerminalRestore();
	process.stdout.write("\nPTY_FIXTURE_STOPPED\n");
	process.exit(0);
}

editor.onChange = text => process.stdout.write(`\nEDITOR:${JSON.stringify(text)}\n`);
editor.onSubmit = text => {
	if (text === "__exit__") stop(true);
};

tui.addChild(editor);
tui.setFocus(editor);
tui.start();

process.once("SIGTERM", stop);
process.once("SIGINT", stop);

// node-pty may emit output before the parent has attached its onData listener.
// Yield briefly so the readiness marker and terminal mode bytes are observable.
await Bun.sleep(25);
process.stdout.write("\nPTY_FIXTURE_READY\n");
