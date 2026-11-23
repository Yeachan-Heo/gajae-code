import type { DesktopSession, DesktopSessionConnection } from "@gajae-code/desktop-host/protocol";
import { SquareTerminal, Unplug } from "lucide-react";
import { t } from "./i18n";

export type ReadOnlyConnection = Exclude<DesktopSessionConnection["state"], "connected">;

/**
 * The conversation's connection state. Only a row an earlier build saved without a transcript path,
 * not yet placed in the shared store, has none; it counts as connected here, and the Host answers
 * its requests with why it cannot be opened.
 */
export function connectionState(session: Pick<DesktopSession, "connection"> | undefined) {
	return session?.connection?.state ?? "connected";
}

export const connectionIcons = { disconnected: Unplug, elsewhere: SquareTerminal } as const;

/** A quiet header chip naming a read-only conversation's state; nothing for a connected one. */
export function SessionConnectionBadge({ session }: { session: Pick<DesktopSession, "connection"> }) {
	const state = connectionState(session);
	if (state === "connected") return null;
	const Icon = connectionIcons[state];
	const leftover = state === "elsewhere" && session.connection?.holder === "earlier-app";
	return (
		<span className="connection-badge" data-state={state}>
			<Icon aria-hidden="true" />
			{t(
				state === "disconnected"
					? "connection.badgeDisconnected"
					: leftover
						? "connection.badgeLeftover"
						: "connection.badgeElsewhere",
			)}
		</span>
	);
}

/** Accessible text for a sidebar row's mark, joined into the row's name; empty when connected. */
export function connectionMarkLabel(session: Pick<DesktopSession, "connection">): string {
	const state = connectionState(session);
	if (state === "connected") return "";
	if (state === "disconnected") return t("connection.markDisconnected");
	return t(session.connection?.holder === "earlier-app" ? "connection.markLeftover" : "connection.markElsewhere");
}

/** The sidebar row's small, non-alarming mark beside the title. */
export function SessionConnectionMark({ session }: { session: Pick<DesktopSession, "connection"> }) {
	const state = connectionState(session);
	if (state === "connected") return null;
	const Icon = connectionIcons[state];
	return (
		<span className="connection-mark" data-state={state} title={connectionMarkLabel(session)}>
			<Icon aria-hidden="true" />
		</span>
	);
}
