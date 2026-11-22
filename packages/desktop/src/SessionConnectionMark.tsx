import type { DesktopSession, DesktopSessionConnection } from "@gajae-code/desktop-host/protocol";
import { SquareTerminal, Unplug } from "lucide-react";
import { t } from "./i18n";

export type ReadOnlyConnection = Exclude<DesktopSessionConnection["state"], "connected">;

/** The conversation's connection state; rows without one (another surface's) count as connected. */
export function connectionState(session: Pick<DesktopSession, "connection"> | undefined) {
	return session?.connection?.state ?? "connected";
}

export const connectionIcons = { disconnected: Unplug, elsewhere: SquareTerminal } as const;

/** A quiet header chip naming a read-only conversation's state; nothing for a connected one. */
export function SessionConnectionBadge({ session }: { session: Pick<DesktopSession, "connection"> }) {
	const state = connectionState(session);
	if (state === "connected") return null;
	const Icon = connectionIcons[state];
	return (
		<span className="connection-badge" data-state={state}>
			<Icon aria-hidden="true" />
			{t(state === "disconnected" ? "connection.badgeDisconnected" : "connection.badgeElsewhere")}
		</span>
	);
}

/** Accessible text for a sidebar row's mark, joined into the row's name; empty when connected. */
export function connectionMarkLabel(session: Pick<DesktopSession, "connection">): string {
	const state = connectionState(session);
	if (state === "connected") return "";
	return t(state === "disconnected" ? "connection.markDisconnected" : "connection.markElsewhere");
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
