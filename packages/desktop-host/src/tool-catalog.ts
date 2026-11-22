import type { CreateAgentSessionResult } from "@gajae-code/coding-agent/sdk";
import type { DesktopToolList } from "./tool-protocol";

type Session = CreateAgentSessionResult["session"];

/**
 * Answers `tools.list` for a live session. `tools.list` is a projected control method, so the
 * Host does not redact this result when it emits it: every string passes through `redact` here.
 */
export function projectToolCatalog(
	session: Pick<Session, "getAllToolNames" | "getActiveToolNames">,
	redact: (text: string) => string,
): DesktopToolList {
	return {
		available: session.getAllToolNames().map(name => redact(name)),
		active: session.getActiveToolNames().map(name => redact(name)),
	};
}
