import type { DesktopSession } from "@gajae-code/desktop-host/protocol";
import { t } from "./i18n";

/** Slot inside the Session work toolbar button, after its icon. It renders nothing. */
export function SessionWorkProgress(_props: { session: DesktopSession }) {
	return null;
}

/** Accessible name and tooltip of the Session work toolbar button. */
export function sessionWorkLabel(_session: DesktopSession): string {
	return t("shell.sessionWork");
}
