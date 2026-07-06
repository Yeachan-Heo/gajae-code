import { type AnimationRegistration, registerAnimationCallback } from "../animation-scheduler";
import type { TUI } from "../tui";
import { sliceByColumn, visibleWidth } from "../utils";
import { Text } from "./text";

const SPINNER_ADVANCE_MS = 80;

export interface LoaderOptions {
	timeDependentColor?: boolean;
}

/** Test-only performance counters for advisory baseline tests. */
export const __loaderPerfCounters = {
	liveIntervals: 0,
	startedIntervals: 0,
	reset(): void {
		this.liveIntervals = 0;
		this.startedIntervals = 0;
	},
};

export class Loader extends Text {
	#frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
	#currentFrame = 0;
	#animation?: AnimationRegistration;
	#ui: TUI | null = null;
	#lastSpinnerTick = 0;
	#lastDisplayed?: string;
	#timeDependentColor: boolean;

	constructor(
		ui: TUI,
		private spinnerColorFn: (str: string) => string,
		private messageColorFn: (str: string) => string,
		private message: string = "Loading...",
		spinnerFrames?: string[],
		options: LoaderOptions = {},
	) {
		super("", 1, 0);
		this.#ui = ui;
		this.#timeDependentColor = options.timeDependentColor ?? false;
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
		if (this.#animation) return;
		this.#lastSpinnerTick = performance.now();
		this.#updateDisplay();
		__loaderPerfCounters.liveIntervals += 1;
		__loaderPerfCounters.startedIntervals += 1;
		this.#animation = registerAnimationCallback(
			now => {
				if (now - this.#lastSpinnerTick >= SPINNER_ADVANCE_MS) {
					this.#currentFrame = (this.#currentFrame + 1) % this.#frames.length;
					this.#lastSpinnerTick = now;
				}
				this.#updateDisplay();
			},
			this.#timeDependentColor ? 16 : 80,
		);
	}

	stop() {
		if (this.#animation) {
			this.#animation.unregister();
			__loaderPerfCounters.liveIntervals = Math.max(0, __loaderPerfCounters.liveIntervals - 1);
			this.#animation = undefined;
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
		if (next === this.#lastDisplayed) return;
		this.#lastDisplayed = next;
		this.setText(next);
		this.#ui?.requestRender(false, "loader");
	}
}
