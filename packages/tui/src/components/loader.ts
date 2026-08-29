import { type AnimationRegistration, registerAnimationCallback } from "../animation-scheduler";
import { isRemoteTerminalSession, isUnderTerminalMultiplexer } from "../terminal-capabilities";
import type { TUI } from "../tui";
import { sliceByColumn, visibleWidth } from "../utils";
import { Text } from "./text";

const SPINNER_ADVANCE_MS = 80;

/**
 * Compatibility options for existing loader call sites.
 *
 * @deprecated `timeDependentColor` preserves the historical smooth-animation
 * contract: direct local terminals reevaluate colorizers at 60 fps, while
 * remote or multiplexed terminals stay on the shared 80 ms cadence to avoid
 * output churn. The field remains accepted for downstream callers while they
 * migrate to an explicit animation policy.
 */
export interface LoaderOptions {
	timeDependentColor?: boolean;
	/** Request a layout-only repaint when the loader is outside the transcript anchor. */
	renderScope?: "full" | "layout";
}

const SMOOTH_ANIMATION_MS = 16;

function resolveAnimationCadence(options: LoaderOptions): 16 | 80 {
	if (options.timeDependentColor !== true) return SPINNER_ADVANCE_MS;
	return isRemoteTerminalSession() || isUnderTerminalMultiplexer() ? SPINNER_ADVANCE_MS : SMOOTH_ANIMATION_MS;
}

/** Test-only performance counters for advisory baseline tests. */
export const __loaderPerfCounters = {
	liveIntervals: 0,
	startedIntervals: 0,
	callbackInvocations: 0,
	renderRequests: 0,
	reset(): void {
		this.liveIntervals = 0;
		this.startedIntervals = 0;
		this.callbackInvocations = 0;
		this.renderRequests = 0;
	},
};

export class Loader extends Text {
	#frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
	#currentFrame = 0;
	#animation?: AnimationRegistration;
	#ui: TUI | null = null;
	#lastSpinnerTick = 0;
	#lastDisplayed?: string;

	constructor(
		ui: TUI,
		private spinnerColorFn: (str: string) => string,
		private messageColorFn: (str: string) => string,
		private message: string = "Loading...",
		spinnerFrames?: string[],
		private options: LoaderOptions = {},
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
		if (this.#animation) return;
		this.#lastSpinnerTick = performance.now();
		this.#updateDisplay();
		__loaderPerfCounters.liveIntervals += 1;
		__loaderPerfCounters.startedIntervals += 1;
		this.#animation = registerAnimationCallback(now => {
			__loaderPerfCounters.callbackInvocations += 1;
			if (now - this.#lastSpinnerTick >= SPINNER_ADVANCE_MS) {
				this.#currentFrame = (this.#currentFrame + 1) % this.#frames.length;
				this.#lastSpinnerTick = now;
			}
			this.#updateDisplay();
		}, resolveAnimationCadence(this.options));
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
		__loaderPerfCounters.renderRequests += 1;
		if (this.options.renderScope === "layout") this.#ui?.requestLayoutRender("loader");
		else this.#ui?.requestRender(false, "loader");
	}
}
