import { settings } from "../../config/settings";

export type TerminalBellEvent = "complete" | "approval" | "ask";

const BEL = "\x07";

function getBellSetting(key: Parameters<typeof settings.get>[0]): boolean {
	try {
		return Boolean(settings.get(key));
	} catch {
		// Some component-level tests exercise UI helpers before Settings.init().
		// Terminal bells are purely best-effort, so an unavailable settings store
		// must not make the UI path throw.
		return false;
	}
}

function enabledForEvent(event: TerminalBellEvent): boolean {
	if (!getBellSetting("notifications.terminalBell")) return false;
	switch (event) {
		case "complete":
			return getBellSetting("notifications.bellOnComplete");
		case "approval":
			return getBellSetting("notifications.bellOnApproval");
		case "ask":
			return getBellSetting("notifications.bellOnAsk");
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
