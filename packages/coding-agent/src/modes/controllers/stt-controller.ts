import { visibleWidth } from "@gajae-code/tui";
import { STTController, type SttState } from "../../stt";
import { theme } from "../theme/theme";

interface SttEditor {
	cursorOverride: string | undefined;
	cursorOverrideWidth: number | undefined;
	getUseTerminalCursor(): boolean;
	insertText(text: string): void;
	setUseTerminalCursor(enabled: boolean): void;
}

interface SttUi {
	getShowHardwareCursor(): boolean;
	requestRender(): void;
	setShowHardwareCursor(enabled: boolean): void;
}

export interface SttModeContext {
	editor: SttEditor;
	showStatus(message: string): void;
	showWarning(message: string): void;
	ui: SttUi;
	updateEditorChrome(): void;
}

/** Coordinates STT state with the interactive composer presentation. */
export class SttModeController {
	readonly #stt = new STTController();
	#animationInterval: NodeJS.Timeout | undefined;
	#hue = 0;
	#previousShowHardwareCursor: boolean | undefined;
	#previousUseTerminalCursor: boolean | undefined;

	async toggle(ctx: SttModeContext): Promise<void> {
		await this.#stt.toggle(ctx.editor, {
			showWarning: message => ctx.showWarning(message),
			showStatus: message => ctx.showStatus(message),
			onStateChange: state => this.#onStateChange(ctx, state),
		});
	}

	dispose(ctx: Pick<SttModeContext, "editor" | "ui">): void {
		this.#cleanupAnimation(ctx);
		this.#stt.dispose();
	}

	#onStateChange(ctx: SttModeContext, state: SttState): void {
		if (state === "recording") {
			this.#previousShowHardwareCursor = ctx.ui.getShowHardwareCursor();
			this.#previousUseTerminalCursor = ctx.editor.getUseTerminalCursor();
			ctx.ui.setShowHardwareCursor(false);
			ctx.editor.setUseTerminalCursor(false);
			this.#startAnimation(ctx);
		} else if (state === "transcribing") {
			this.#stopAnimation();
			this.#setMicCursor(ctx.editor, { r: 200, g: 200, b: 200 });
		} else {
			this.#cleanupAnimation(ctx);
		}
		ctx.updateEditorChrome();
		ctx.ui.requestRender();
	}

	#setMicCursor(editor: SttEditor, color: { r: number; g: number; b: number }): void {
		editor.cursorOverride = `\x1b[38;2;${color.r};${color.g};${color.b}m${theme.icon.mic}\x1b[0m`;
		editor.cursorOverrideWidth = visibleWidth(editor.cursorOverride);
	}

	#startAnimation(ctx: Pick<SttModeContext, "editor" | "ui">): void {
		if (this.#animationInterval) return;
		this.#hue = 0;
		this.#updateMicIcon(ctx.editor);
		this.#animationInterval = setInterval(() => {
			this.#hue = (this.#hue + 8) % 360;
			this.#updateMicIcon(ctx.editor);
			ctx.ui.requestRender();
		}, 60);
	}

	#updateMicIcon(editor: SttEditor): void {
		const c = hsvToRgb(this.#hue, 0.9, 1);
		this.#setMicCursor(editor, c);
	}

	#stopAnimation(): void {
		if (this.#animationInterval) {
			clearInterval(this.#animationInterval);
			this.#animationInterval = undefined;
		}
	}

	#cleanupAnimation(ctx: Pick<SttModeContext, "editor" | "ui">): void {
		this.#stopAnimation();
		ctx.editor.cursorOverride = undefined;
		ctx.editor.cursorOverrideWidth = undefined;
		if (this.#previousShowHardwareCursor !== undefined) {
			ctx.ui.setShowHardwareCursor(this.#previousShowHardwareCursor);
			this.#previousShowHardwareCursor = undefined;
		}
		if (this.#previousUseTerminalCursor !== undefined) {
			ctx.editor.setUseTerminalCursor(this.#previousUseTerminalCursor);
			this.#previousUseTerminalCursor = undefined;
		}
	}
}

function hsvToRgb(h: number, s: number, v: number): { r: number; g: number; b: number } {
	const c = v * s;
	const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
	const m = v - c;
	const [r, g, b] =
		h < 60
			? [c, x, 0]
			: h < 120
				? [x, c, 0]
				: h < 180
					? [0, c, x]
					: h < 240
						? [0, x, c]
						: h < 300
							? [x, 0, c]
							: [c, 0, x];
	return { r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255) };
}
