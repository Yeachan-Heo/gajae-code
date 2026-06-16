import type { TUI } from "../tui";
import { sliceByColumn, visibleWidth } from "../utils";
import { Text } from "./text";

/**
 * Loader component that drives display refresh at ~60fps so callers whose
 * message colorizer is time-dependent (e.g. shimmer/KITT) animate smoothly.
 *
 * Two cadences are interleaved on a single timer:
 *   - **Recompute tick** (every `RENDER_INTERVAL_MS`) → recomposes the spinner +
 *     colorized message every 16ms. A redraw is requested only when that composed
 *     text actually changed since the last tick (`#lastDisplayed`), so animated
 *     colorizers (shimmer/KITT) and spinner-frame advances still repaint, while
 *     static loaders skip the redundant no-op render requests between advances.
 *   - **Spinner advance** (every `SPINNER_ADVANCE_MS`) → bumps the spinner
 *     frame index. Decoupled from the recompute cadence so the spinner keeps
 *     its classic ~12.5fps step pace regardless of shimmer state.
 *
 * The animation timer is `unref`'d so an active loader never keeps the event
 * loop alive on its own.
 */
const RENDER_INTERVAL_MS = 16;
const SPINNER_ADVANCE_MS = 80;

export class Loader extends Text {
	#frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
	#currentFrame = 0;
	#intervalId?: NodeJS.Timeout;
	#ui: TUI | null = null;
	#lastSpinnerTick = 0;
	#lastDisplayed?: string;

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

	dispose(): void {
		this.stop();
	}

	setMessage(message: string) {
		this.message = message;
		this.#updateDisplay();
	}

	#updateDisplay() {
		const frame = this.#frames[this.#currentFrame];
		const next = `${this.spinnerColorFn(frame)} ${this.messageColorFn(this.message)}`;
		// Only touch the component and ask the TUI to repaint when the rendered
		// text actually changed. Time-dependent colorizers (shimmer/KITT) produce
		// new text every tick and still animate; static loaders skip the ~16ms
		// no-op render requests between 80ms spinner advances. Output is unchanged
		// because a suppressed frame would have produced a no-op write anyway.
		if (next === this.#lastDisplayed) return;
		this.#lastDisplayed = next;
		this.setText(next);
		this.#ui?.requestRender(false, "loader");
	}
}
