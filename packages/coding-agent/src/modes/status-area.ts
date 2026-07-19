import type { Loader } from "@gajae-code/tui";
import { StatusRowReserve } from "./components/status-row-reserve";
import type { InteractiveModeContext } from "./types";

type StatusAreaContext = Pick<InteractiveModeContext, "ui" | "statusContainer">;

/**
 * Single owner of transient status-slot install and teardown.
 *
 * Process terminals cannot report the user's scrollback position, so removing
 * status rows contracts the bottom area and forces a repaint that can replace
 * transcript rows the user is browsing. Every transient loader (working,
 * retry, compaction, handoff, summary, debug-report) MUST be installed with
 * {@link addLoader} and torn down with {@link removeLoader}: teardown records
 * the visible rows into a high-water {@link StatusRowReserve} before removing
 * only that loader, so completion, cancel, error, retry, and compaction
 * transitions never contract the status area.
 *
 * `statusContainer.clear()` remains reserved for whole-session resets —
 * switching, creating, or forking a session, replacing the transcript
 * identity, and shutdown — where the entire screen is legitimately rebuilt
 * and the reservation must die with it. Clearing drops the reserve component;
 * the next capture lazily re-creates it and stale registry entries are pruned
 * on the next measure.
 */
export class StatusArea {
	#reserve: StatusRowReserve | undefined = undefined;
	#transient = new Set<Loader>();

	constructor(private ctx: StatusAreaContext) {}

	#measureLiveLines = (width: number): number => {
		let lines = 0;
		for (const loader of this.#transient) {
			// Prune loaders removed behind our back (e.g. a full-session clear).
			if (!this.ctx.statusContainer.children.includes(loader)) {
				this.#transient.delete(loader);
				continue;
			}
			lines += loader.render(width).length;
		}
		return lines;
	};

	/** Installs a transient loader and records its rows into the reserve. */
	addLoader(loader: Loader): void {
		this.#transient.add(loader);
		this.ctx.statusContainer.addChild(loader);
		this.capture();
	}

	/**
	 * Records the current transient rows into the high-water reserve. Called
	 * automatically by {@link addLoader} and {@link removeLoader}.
	 */
	capture(): void {
		if (!this.ctx.ui.terminal?.isProcessTerminal) return;
		const width = this.ctx.ui.terminal.columns;
		if (!this.#reserve || !this.ctx.statusContainer.children.includes(this.#reserve)) {
			// Nothing to reserve yet: avoid installing an empty component.
			if (this.#measureLiveLines(width) === 0) return;
			this.#reserve = new StatusRowReserve(this.#measureLiveLines);
			this.ctx.statusContainer.addChild(this.#reserve);
		}
		this.#reserve.capture(width);
	}

	/**
	 * Targeted teardown for one transient loader: stop it, record its rows
	 * into the reserve, then remove only that child. Never contracts the
	 * status area and never touches sibling components.
	 */
	removeLoader(loader: Loader | undefined): void {
		if (!loader) return;
		loader.stop();
		if (this.#transient.has(loader)) this.capture();
		this.#transient.delete(loader);
		this.ctx.statusContainer.removeChild(loader);
	}
}
