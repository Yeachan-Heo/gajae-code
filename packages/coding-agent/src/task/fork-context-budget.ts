import type { ForkContextMode } from "./types";

export const FORK_CONTEXT_TOKEN_BUDGET_BY_MODE = {
	none: 0,
	receipt: 2000,
	"last-turn": 4000,
	bounded: 8000,
	full: 15000,
} as const satisfies Record<ForkContextMode, number>;
