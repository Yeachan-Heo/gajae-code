import type { TUI } from "../tui";
import { sliceByColumn, visibleWidth } from "../utils";
import { Text } from "./text";

/**
 * Loader component that drives display refresh at ~60fps so callers whose
 * message colorizer is time-dependent (e.g. shimmer/KITT) animate smoothly.
 *
 * Two cadences are interleaved on a single timer:
 *   - **Render tick** (every `RENDER_INTERVAL_MS`) → asks the TUI to redraw.
 *     The TUI already throttles at 16ms (`MIN_RENDER_INTERVAL_MS`), so this
 *     is the natural upper bound; static messageColorFns produce identical
 *     output and the differ drops the no-op redraw at ~zero cost.
 *   - **Spinner advance** (every `SPINNER_ADVANCE_MS`) → bumps the spinner
 *     frame index. Decoupled from the render cadence so the spinner keeps
 *     its classic ~12.5fps step pace regardless of shimmer state.
 */
const RENDER_INTERVAL_MS = 16;
const SPINNER_ADVANCE_MS = 80;

export class Loader extends Text {
	#frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
	#currentFrame = 0;
	#intervalId?: NodeJS.Timeout;
	#ui: TUI | null = null;
	#lastSpinnerTick = 0;

	constructor(
		ui: TUI,
		private spinnerColorFn: (str: string) => string,
		private messageColorFn: (str: string) => string,
		private message: string = "Loading...",
		spinnerFrames?: string[],
	) {
		super("", 1, 0);
		this.#ui = ui;
		if (spinnerFrames && spinnerFrames.length > 0) {
			this.#frames = spinnerFrames;
		}
		this.start();
	}

	render(width: number): string[] {
		const lines = ["", ...super.render(width)];
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (visibleWidth(line) > width) {
				lines[i] = sliceByColumn(line, 0, width, true);
			}
		}
		return lines;
	}

	start() {
		this.#lastSpinnerTick = performance.now();
		this.#updateDisplay();
		this.#intervalId = setInterval(() => {
			const now = performance.now();
			if (now - this.#lastSpinnerTick >= SPINNER_ADVANCE_MS) {
				this.#currentFrame = (this.#currentFrame + 1) % this.#frames.length;
				this.#lastSpinnerTick = now;
			}
			this.#updateDisplay();
		}, RENDER_INTERVAL_MS);
		// Don't let the animation timer keep the event loop alive on its own.
		this.#intervalId?.unref?.();
	}

	stop() {
		if (this.#intervalId) {
			clearInterval(this.#intervalId);
			this.#intervalId = undefined;
		}
	}

	setMessage(message: string) {
		this.message = message;
		this.#updateDisplay();
	}

	#updateDisplay() {
		const frame = this.#frames[this.#currentFrame];
		this.setText(`${this.spinnerColorFn(frame)} ${this.messageColorFn(this.message)}`);
		if (this.#ui) {
			this.#ui.requestRender();
		}
	}
}
