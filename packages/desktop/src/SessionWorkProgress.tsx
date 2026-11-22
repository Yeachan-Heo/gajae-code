import type { DesktopSession } from "@gajae-code/desktop-host/protocol";
import { t } from "./i18n";
import { todoProgress } from "./TodoPanel";

/**
 * Task progress inside the Session work toolbar button, after its icon: a compact `done/total`
 * chip whenever the session has tasks. It is the always-visible sign of the list, which itself
 * lives in the Session work card. The button's accessible name already says the same, so the
 * chip is hidden from assistive technology.
 */
export function SessionWorkProgress({ session }: { session: DesktopSession }) {
	const { done, total } = todoProgress(session.todos);
	if (total === 0) return null;
	return (
		<span className={`session-work-progress${done === total ? " complete" : ""}`} aria-hidden="true">
			{t("todo.progressChip", { done, total })}
		</span>
	);
}

/** Accessible name and tooltip of the Session work toolbar button, with task progress when there is a list. */
export function sessionWorkLabel(session: DesktopSession): string {
	const { done, total } = todoProgress(session.todos);
	return total === 0 ? t("shell.sessionWork") : t("todo.sessionWorkLabel", { done, total });
}
