/**
 * The held-session warning (session single-owner design §3.1): a session another process holds is
 * never opened here, and the user can fork it or cancel. When the holder is a broker-launched host,
 * the user can also continue here (design §12, §13 L1), which closes that host between turns. One
 * copy and one option list for every surface that shows it: the launch before the TUI starts, the
 * resume picker and `/resume`.
 */
import { type SessionHeldError, sessionHeldWarning } from "../../session/session-ownership";
import { HookSelectorComponent } from "./hook-selector";

export type HeldSessionChoice = "fork" | "continue" | "cancel";

export interface HeldSessionWarningOptions {
	/** Offer Continue here: the holder is a broker-launched session host. */
	readonly continueHere?: boolean;
	/** Why the last Continue here did not go through, shown under the warning. */
	readonly note?: string;
}

const FORK_OPTION = "Fork into a new session — copy the conversation and continue there";
const CONTINUE_OPTION = "Continue here — close the session host and open it here";
const CANCEL_OPTION = "Cancel";

/** The selector title (Markdown, as `HookSelectorComponent` renders it) and its options, Fork first. */
export function heldSessionWarningDialog(
	error: SessionHeldError,
	options: HeldSessionWarningOptions = {},
): {
	readonly title: string;
	readonly options: string[];
} {
	const warning = sessionHeldWarning(error);
	return {
		title: [`**${warning.heading}**`, ...warning.lines, ...(options.note ? ["", options.note] : [])].join("\n"),
		options: [FORK_OPTION, ...(options.continueHere ? [CONTINUE_OPTION] : []), CANCEL_OPTION],
	};
}

/** The choice a selected option means; anything else (Escape, a closed dialog) cancels. */
export function heldSessionChoice(option: string | undefined): HeldSessionChoice {
	if (option === FORK_OPTION) return "fork";
	return option === CONTINUE_OPTION ? "continue" : "cancel";
}

/** The warning as a focused selector: Enter on Fork forks, Enter on Cancel or Escape cancels. */
export function createHeldSessionWarning(
	error: SessionHeldError,
	onChoice: (choice: HeldSessionChoice) => void,
	options: HeldSessionWarningOptions = {},
): HookSelectorComponent {
	const dialog = heldSessionWarningDialog(error, options);
	return new HookSelectorComponent(
		dialog.title,
		dialog.options,
		option => onChoice(heldSessionChoice(option)),
		() => onChoice("cancel"),
		{ acceleratorMap: { f: FORK_OPTION, h: CONTINUE_OPTION, c: CANCEL_OPTION } },
	);
}
