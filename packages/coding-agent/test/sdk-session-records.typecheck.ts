import type { AgentMessage } from "@gajae-code/agent-core";
import type { EntryPatchRecord, HeaderPatchRecord, SessionPatchRecord } from "@gajae-code/coding-agent";

declare const message: AgentMessage;

const header: HeaderPatchRecord = {
	type: "header_patch",
	patch: { cwd: "/workspace", title: "Session", titleSource: "user", starred: true },
};
const entry: EntryPatchRecord = { type: "entry_patch", entryId: "message-entry", patch: { message } };
const writerPatches: SessionPatchRecord[] = [header, entry];

// @ts-expect-error Header records cannot carry entry-only metadata.
const invalidHeader: HeaderPatchRecord = { type: "header_patch", patch: { entryId: "message-entry" } };

// @ts-expect-error Public entry patches require AgentMessage payloads, not arbitrary scalar values.
const invalidEntry: EntryPatchRecord = { type: "entry_patch", entryId: "message-entry", patch: { message: "invalid" } };

void [writerPatches, invalidHeader, invalidEntry];
