/**
 * The held-session warning (session single-owner design §3.1): a session another process holds is
 * never opened here, and the user can fork it or cancel. One copy and one option list for every
 * surface that shows it: the launch before the TUI starts, the resume picker and `/resume`.
 */
import { type SessionHeldError, sessionHeldWarning } from "../../session/session-ownership";
import { HookSelectorComponent } from "./hook-selector";

export type HeldSessionChoice = "fork" | "cancel";

const FORK_OPTION = "Fork into a new session — copy the conversation and continue there";
const CANCEL_OPTION = "Cancel";

/** The selector title (Markdown, as `HookSelectorComponent` renders it) and its options, Fork first. */
export function heldSessionWarningDialog(error: SessionHeldError): {
	readonly title: string;
	readonly options: string[];
} {
	const warning = sessionHeldWarning(error);
	return { title: [`**${warning.heading}**`, ...warning.lines].join("\n"), options: [FORK_OPTION, CANCEL_OPTION] };
}

/** The choice a selected option means; anything else (Escape, a closed dialog) cancels. */
export function heldSessionChoice(option: string | undefined): HeldSessionChoice {
	return option === FORK_OPTION ? "fork" : "cancel";
}

/** The warning as a focused selector: Enter on Fork forks, Enter on Cancel or Escape cancels. */
export function createHeldSessionWarning(
	error: SessionHeldError,
	onChoice: (choice: HeldSessionChoice) => void,
): HookSelectorComponent {
	const { title, options } = heldSessionWarningDialog(error);
	return new HookSelectorComponent(
		title,
		options,
		option => onChoice(heldSessionChoice(option)),
		() => onChoice("cancel"),
		{ acceleratorMap: { f: FORK_OPTION, c: CANCEL_OPTION } },
	);
}
