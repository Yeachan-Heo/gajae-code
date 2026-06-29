import { settings } from "../../config/settings";

export type TerminalBellEvent = "complete" | "approval" | "ask";

const BEL = "\x07";

function enabledForEvent(event: TerminalBellEvent): boolean {
	if (!settings.get("notifications.terminalBell")) return false;
	switch (event) {
		case "complete":
			return settings.get("notifications.bellOnComplete");
		case "approval":
			return settings.get("notifications.bellOnApproval");
		case "ask":
			return settings.get("notifications.bellOnAsk");
	}
}

export function ringTerminalBell(
	event: TerminalBellEvent,
	output: Pick<NodeJS.WriteStream, "write"> = process.stdout,
): void {
	if (!enabledForEvent(event)) return;
	try {
		output.write(BEL);
	} catch {
		// Best-effort local notification only.
	}
}

export function classifyHookSelectorBellEvent(title: string): TerminalBellEvent {
	const normalized = title.toLowerCase();
	if (normalized.includes("approval") || normalized.includes("approve") || normalized.includes("plan ready")) {
		return "approval";
	}
	return "ask";
}
