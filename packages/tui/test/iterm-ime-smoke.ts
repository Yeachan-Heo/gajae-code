#!/usr/bin/env bun

import { Editor } from "@gajae-code/tui/components/editor";
import { Text } from "@gajae-code/tui/components/text";
import { matchesKey } from "@gajae-code/tui/keys";
import { ProcessTerminal } from "@gajae-code/tui/terminal";
import { TUI } from "@gajae-code/tui/tui";
import { defaultEditorTheme } from "./test-themes";

Bun.env.GJC_TUI_IME_CURSOR ??= "1";

function readNumberFlag(name: string, fallback: number): number {
	const args = process.argv.slice(2);
	const inline = args.find(arg => arg.startsWith(`--${name}=`));
	if (inline) {
		const value = Number.parseInt(inline.slice(name.length + 3), 10);
		return Number.isFinite(value) && value >= 0 ? value : fallback;
	}
	const index = args.indexOf(`--${name}`);
	if (index >= 0) {
		const value = Number.parseInt(args[index + 1] ?? "", 10);
		return Number.isFinite(value) && value >= 0 ? value : fallback;
	}
	return fallback;
}

class MutableTranscript {
	#lines: string[];

	constructor(lines: string[]) {
		this.#lines = [...lines];
	}

	append(line: string): void {
		this.#lines.push(line);
	}

	appendMany(lines: string[]): void {
		this.#lines.push(...lines);
	}

	invalidate(): void {
		// No cached state.
	}

	render(): string[] {
		return [...this.#lines];
	}
}

const initialLines = readNumberFlag("initial-lines", 72);
const appendMs = Math.max(100, readNumberFlag("append-ms", 700));
const burstSize = Math.max(1, readNumberFlag("burst-size", 12));
const autoExitMs = readNumberFlag("auto-exit-ms", 0);
const startedAt = Date.now();

const motifs = [
	"steady repaint anchor probe",
	"한글 조합 candidate 위치 확인",
	"cursor-only re-anchor after repaint",
	"mixed width 가나 abc 123",
];

let sequence = 0;
function nextLine(origin: string): string {
	const motif = motifs[sequence % motifs.length];
	const line = `${origin} ${String(sequence).padStart(4, "0")} :: ${motif}`;
	sequence += 1;
	return line;
}

const transcript = new MutableTranscript(Array.from({ length: initialLines }, () => nextLine("seed")));
const terminal = new ProcessTerminal();
const tui = new TUI(terminal, false);
const instructions = new Text(
	[
		"iTerm Hangul IME smoke",
		"Compose Hangul in the prompt while transcript repaint continues above.",
		`Ctrl+S pause/resume stream · Ctrl+B append ${burstSize} lines · Ctrl+C exit`,
		`soft-cursor IME mode: GJC_TUI_IME_CURSOR=${Bun.env.GJC_TUI_IME_CURSOR ?? "0"}`,
	].join("\n"),
	1,
	0,
);
const editor = new Editor(defaultEditorTheme);

tui.addChild(transcript);
tui.addChild(instructions);
tui.addChild(editor);
tui.setFocus(editor);

let streamTimer: NodeJS.Timeout | undefined;
let autoExitTimer: NodeJS.Timeout | undefined;
let streaming = true;
let stopped = false;

function appendOne(origin = "stream"): void {
	transcript.append(nextLine(origin));
	tui.requestRender(false, `smoke.${origin}`);
}

function appendBurst(origin = "burst"): void {
	transcript.appendMany(Array.from({ length: burstSize }, () => nextLine(origin)));
	tui.requestRender(false, `smoke.${origin}`);
}

function syncStreamTimer(): void {
	if (streaming) {
		if (!streamTimer) {
			streamTimer = setInterval(() => appendOne("stream"), appendMs);
		}
		return;
	}
	if (streamTimer) {
		clearInterval(streamTimer);
		streamTimer = undefined;
	}
}

function stopAndExit(code = 0): void {
	if (stopped) return;
	stopped = true;
	if (streamTimer) {
		clearInterval(streamTimer);
		streamTimer = undefined;
	}
	if (autoExitTimer) {
		clearTimeout(autoExitTimer);
		autoExitTimer = undefined;
	}
	try {
		tui.stop();
	} catch {
		// Best effort on teardown.
	}
	const elapsedMs = Date.now() - startedAt;
	console.log(`\n[iTerm IME smoke] stopped after ${elapsedMs}ms with ${sequence - initialLines} appended lines.`);
	process.exit(code);
}

tui.addInputListener(data => {
	if (matchesKey(data, "ctrl+c")) {
		stopAndExit(0);
		return { consume: true };
	}
	if (matchesKey(data, "ctrl+s")) {
		streaming = !streaming;
		syncStreamTimer();
		tui.requestRender(false, "smoke.toggle-stream");
		return { consume: true };
	}
	if (matchesKey(data, "ctrl+b")) {
		appendBurst();
		return { consume: true };
	}
	return undefined;
});

process.on("SIGINT", () => stopAndExit(0));
process.on("SIGTERM", () => stopAndExit(0));

tui.start();
syncStreamTimer();

if (autoExitMs > 0) {
	autoExitTimer = setTimeout(() => stopAndExit(0), autoExitMs);
}
