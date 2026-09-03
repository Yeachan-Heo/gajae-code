/**
 * Utilities for launching an external text editor ($VISUAL / $EDITOR).
 */
import { dlopen, FFIType, ptr } from "bun:ffi";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $env, Snowflake } from "@gajae-code/utils";

/** Returns the user's preferred editor command, or undefined if not configured. */
export function getEditorCommand(): string | undefined {
	return $env.VISUAL || $env.EDITOR || undefined;
}

export interface OpenInEditorOptions {
	/** File extension for the temp file (default: ".md"). */
	extension?: string;
	/** Custom stdio configuration (default: all "inherit"). */
	stdio?: [number | "inherit", number | "inherit", number | "inherit"];
	/** Keep the file's trailing newline instead of trimming it from the returned text. */
	trimTrailingNewline?: boolean;
}

/** Remove one platform-standard trailing line terminator from editor content. */
export function trimEditorTrailingNewline(text: string): string {
	return text.replace(/\r?\n$/, "");
}

/**
 * On Windows the console input buffer is shared between the parent and the
 * child. When the parent TUI stops it restores the console to cooked mode
 * (ENABLE_LINE_INPUT | ENABLE_ECHO_INPUT) and disables
 * ENABLE_VIRTUAL_TERMINAL_INPUT. A child TUI such as Neovim then inherits
 * that cooked state: the very next keystroke is line-buffered until an
 * Enter flushes it — exactly the "first i is swallowed, Enter fixes it"
 * symptom reported in #5224.
 *
 * Neovim (via libuv's uv_tty) re-enables raw VT input on startup, but the
 * race window between the parent's restore and the child's init is enough
 * to deterministically line-buffer the first typed keystroke when the child
 * is spawned through `cmd.exe` (`shell: true`), because `cmd` itself keeps
 * the console in cooked mode while it waits for the child.
 *
 * To make the handover symmetric:
 *  - flush any pending console input left over from the parent (e.g. probe
 *    reply fragments that were already read into the kernel buffer), and
 *  - leave the console in raw VT mode (VT on, LINE/ECHO off) so the child
 *    inherits an immediately-usable mode; the caller's `ui.start()` will
 *    reconcile the mode again when the editor exits.
 */
const STD_INPUT_HANDLE = -10;
const ENABLE_LINE_INPUT = 0x0002;
const ENABLE_ECHO_INPUT = 0x0004;
const ENABLE_WINDOW_INPUT = 0x0008;
const ENABLE_VIRTUAL_TERMINAL_INPUT = 0x0200;

function prepareWindowsConsoleForExternalEditor(): void {
	if (process.platform !== "win32") return;
	try {
		const kernel32 = dlopen("kernel32.dll", {
			GetStdHandle: { args: [FFIType.i32], returns: FFIType.ptr },
			GetConsoleMode: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.bool },
			SetConsoleMode: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.bool },
			FlushConsoleInputBuffer: { args: [FFIType.ptr], returns: FFIType.bool },
		});
		const handle = kernel32.symbols.GetStdHandle(STD_INPUT_HANDLE);
		try {
			kernel32.symbols.FlushConsoleInputBuffer(handle);
		} catch {}
		const mode = new Uint32Array(1);
		const modePtr = ptr(mode);
		if (modePtr && kernel32.symbols.GetConsoleMode(handle, modePtr)) {
			const cur = mode[0]!;
			const next =
				(cur | ENABLE_VIRTUAL_TERMINAL_INPUT | ENABLE_WINDOW_INPUT) & ~(ENABLE_LINE_INPUT | ENABLE_ECHO_INPUT);
			if (next !== cur) {
				kernel32.symbols.SetConsoleMode(handle, next);
			}
		}
		kernel32.close();
	} catch {}
}

/**
 * Opens `content` in the user's external editor and returns the edited text.
 * Returns `null` if the editor exits with a non-zero code.
 *
 * The caller is responsible for stopping/starting the TUI around this call.
 */
export async function openInEditor(
	editorCmd: string,
	content: string,
	options?: OpenInEditorOptions,
): Promise<string | null> {
	const ext = options?.extension ?? ".md";
	const tmpFile = path.join(os.tmpdir(), `gjc-editor-${Snowflake.next()}${ext}`);

	try {
		await Bun.write(tmpFile, content);

		const [editor, ...editorArgs] = editorCmd.split(" ");
		const stdio = options?.stdio ?? ["inherit", "inherit", "inherit"];

		prepareWindowsConsoleForExternalEditor();

		const child = spawn(editor, [...editorArgs, tmpFile], { stdio, shell: process.platform === "win32" });
		const { promise, reject, resolve } = Promise.withResolvers<number>();
		child.once("exit", (code, signal) => resolve(code ?? (signal ? -1 : 0)));
		child.once("error", error => reject(error));
		const exitCode = await promise;

		if (exitCode === 0) {
			const text = await Bun.file(tmpFile).text();
			if (options?.trimTrailingNewline === false) {
				return text;
			}
			return trimEditorTrailingNewline(text);
		}
		return null;
	} finally {
		try {
			await fs.rm(tmpFile, { force: true });
		} catch {
			// Ignore cleanup errors
		}
	}
}
