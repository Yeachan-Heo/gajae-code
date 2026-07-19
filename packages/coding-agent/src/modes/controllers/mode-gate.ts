export type ExclusiveMode = "goal" | "plan";

/** Owns the mutual-exclusion state for interactive goal and plan modes. */
export class ModeGate {
	#activeMode: ExclusiveMode | undefined;

	get activeMode(): ExclusiveMode | undefined {
		return this.#activeMode;
	}

	enter(mode: ExclusiveMode): boolean {
		if (this.#activeMode && this.#activeMode !== mode) {
			return false;
		}
		this.#activeMode = mode;
		return true;
	}

	exit(mode: ExclusiveMode): void {
		if (this.#activeMode === mode) {
			this.#activeMode = undefined;
		}
	}
}
