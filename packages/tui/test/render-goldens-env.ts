/**
 * Deterministic terminal-capability baseline for render-golden capture.
 *
 * `@gajae-code/tui/terminal-capabilities` computes `TERMINAL`/`TERMINAL_ID`
 * at module-import time from env vars (TERM_PROGRAM etc.), so the baseline
 * MUST be applied before any `@gajae-code/tui` import is evaluated. Import
 * this module FIRST in render-goldens.ts (side-effect import).
 *
 * The committed goldens were captured under this exact baseline; fixtures
 * overlay their own vars (TMUX, TERMUX_VERSION, ...) per capture on top.
 */
export const GOLDEN_BASELINE_ENV: Record<string, string | undefined> = {
	TERM: "xterm-256color",
	TERM_PROGRAM: "ghostty",
	TERM_PROGRAM_VERSION: undefined,
	COLORTERM: undefined,
	NO_COLOR: undefined,
	WT_SESSION: undefined,
	KITTY_WINDOW_ID: undefined,
	ALACRITTY_WINDOW_ID: undefined,
	TMUX: undefined,
	TERMUX_VERSION: undefined,
	SSH_TTY: undefined,
	CI: undefined,
};

for (const [key, value] of Object.entries(GOLDEN_BASELINE_ENV)) {
	if (value === undefined) delete Bun.env[key];
	else Bun.env[key] = value;
}
