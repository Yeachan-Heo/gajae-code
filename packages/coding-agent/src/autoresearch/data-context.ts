/**
 * Autoresearch data context: RLM data-description loading, GATED to explicit
 * `data` or `mixed` mission mode only.
 *
 * This is the AC-16 no-inference rule at the consumption end: a mission mode is
 * never inferred from the presence of a data file, so in `web` mode a data
 * description must NOT be loaded — not an explicit `--data` flag, and not a
 * project-root `DATA.md` auto-load. `data` and `mixed` modes may load one.
 */
import { loadRlmDataContext, type RlmDataContext } from "../rlm/data-context";

export type { RlmDataContext };

export type AutoresearchDataContextMode = "web" | "mixed" | "data";

export interface AutoresearchDataContextInput {
	cwd: string;
	mode: AutoresearchDataContextMode;
	/** Explicit data path (resolved against `cwd`). Optional. */
	dataFlag?: string;
}

/**
 * Load the data description for a mission, or return null when the mode does
 * not permit one. `web` mode always returns null without touching the
 * filesystem; `data`/`mixed` delegate to the RLM loader (explicit `--data`
 * path wins over project-root `DATA.md`, which auto-loads when present).
 */
export async function loadAutoresearchDataContext(input: AutoresearchDataContextInput): Promise<RlmDataContext | null> {
	if (input.mode === "web") {
		// AC-16 consumption gate: never infer or attach data context in web mode.
		return null;
	}
	return loadRlmDataContext(input.cwd, input.dataFlag);
}
