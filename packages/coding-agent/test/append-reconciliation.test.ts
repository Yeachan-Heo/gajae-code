import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	type CommittedTranscriptRead,
	type DurableAppendOutcome,
	reconcileUncertainAppend,
	SessionManager,
} from "../src/session/session-manager";

// An uncertain append may or may not have landed. Only a transcript that is actually
// readable and belongs to this session can settle it; anything else has to come back
// indeterminate so the caller neither retries (duplicating) nor assumes success.

const SESSION_ID = "01a1b5b3-12fe-7136-9c85-ad1b859d6ca8";

function snapshotRead(sessionId: string, entryIds: string[]): CommittedTranscriptRead {
	return {
		kind: "snapshot",
		snapshot: {
			sessionFile: "/tmp/transcript.jsonl",
			sessionId,
			entryIds,
			leafId: entryIds.at(-1) ?? null,
			digest: "0".repeat(64),
			size: 1,
		},
	};
}

const unknownWith = (id: string | null): Extract<DurableAppendOutcome, { kind: "unknown" }> => ({
	kind: "unknown",
	id,
	error: new Error("write interrupted"),
});

describe("uncertain append reconciliation", () => {
	it("reports committed only when the transcript carries the id", () => {
		expect(reconcileUncertainAppend(unknownWith("a1"), snapshotRead(SESSION_ID, ["a1"]), SESSION_ID)).toEqual({
			kind: "committed",
			id: "a1",
		});
	});

	it("reports not_committed when a readable transcript of this session lacks the id", () => {
		expect(reconcileUncertainAppend(unknownWith("a1"), snapshotRead(SESSION_ID, ["b2"]), SESSION_ID)).toEqual({
			kind: "not_committed",
		});
	});

	it("never claims not_committed without a readable transcript", () => {
		expect(reconcileUncertainAppend(unknownWith("a1"), { kind: "absent" }, SESSION_ID)).toEqual({
			kind: "indeterminate",
			reason: "absent_transcript",
		});
		expect(
			reconcileUncertainAppend(unknownWith("a1"), { kind: "unsupported", reason: "version" }, SESSION_ID),
		).toEqual({ kind: "indeterminate", reason: "unsupported_transcript" });
	});

	it("is indeterminate when the append cannot name its entry", () => {
		// A near-limit failure carries no id, so its absence proves nothing.
		expect(reconcileUncertainAppend(unknownWith(null), snapshotRead(SESSION_ID, ["b2"]), SESSION_ID)).toEqual({
			kind: "indeterminate",
			reason: "entry_id_unknown",
		});
	});

	it("treats another session's transcript as a conflict rather than evidence", () => {
		expect(
			reconcileUncertainAppend(
				unknownWith("a1"),
				snapshotRead("01a1b5b3-12fe-7136-9c85-ad1b859d6ca9", ["a1"]),
				SESSION_ID,
			),
		).toEqual({ kind: "conflict", reason: "different_session" });
	});

	it("flags a committed outcome the transcript does not show", () => {
		expect(
			reconcileUncertainAppend({ kind: "committed", id: "a1" }, snapshotRead(SESSION_ID, ["b2"]), SESSION_ID),
		).toEqual({ kind: "conflict", reason: "missing_committed_entry" });
	});
});

// The rules above are pure. This ties them to a real transcript so the ids and the
// session identity they assume are the ones the manager actually produces.

const roots: string[] = [];
const managers: SessionManager[] = [];

afterEach(async () => {
	for (const manager of managers.splice(0)) await manager.closeStrict().catch(() => undefined);
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("reconciliation against a real transcript", () => {
	it("settles an uncertain append from the committed snapshot", async () => {
		const root = await fs.mkdtemp(path.join(import.meta.dirname, ".tmp-append-reconcile-"));
		roots.push(root);
		const cwd = path.join(root, "workspace");
		const agentDir = path.join(root, "agent");
		await fs.mkdir(cwd, { recursive: true });
		await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
		const manager = SessionManager.create(cwd, SessionManager.managedDestination(cwd, agentDir));
		managers.push(manager);
		const id = manager.appendMessage({ role: "user" as const, content: "root", timestamp: 1 });
		await manager.ensureOnDisk();
		const read = await manager.captureCommittedSnapshot();

		expect(reconcileUncertainAppend(unknownWith(id), read, manager.getSessionId())).toEqual({
			kind: "committed",
			id,
		});
		expect(reconcileUncertainAppend(unknownWith("deadbeef"), read, manager.getSessionId())).toEqual({
			kind: "not_committed",
		});
	});
});
