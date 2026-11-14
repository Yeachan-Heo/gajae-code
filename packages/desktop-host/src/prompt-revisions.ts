import { type CreateAgentSessionResult, getEmbeddedPromptRevision } from "@gajae-code/coding-agent/sdk";
import type { DesktopMessageRevision } from "./protocol";

/** App wire projection only; the SDK owns revision grouping and exact branch selection. */
export class PromptRevisions {
	revision(session: CreateAgentSessionResult["session"], entryId: string): DesktopMessageRevision | undefined {
		return getEmbeddedPromptRevision(session, entryId);
	}
}
