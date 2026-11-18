import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	type AppendReconciliationInput,
	type CommittedTranscriptRead,
	type DurableAppendOutcome,
	reconcileUncertainAppend,
	SessionManager,
} from "../src/session/session-manager";

// An uncertain append may or may not have landed. Only a transcript read after the
// outcome, belonging to this session, plus a discarded local attempt can settle it;
// anything less has to come back indeterminate so the caller neither duplicates the
// entry nor assumes it exists.

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

const reconcile = (
	outcome: DurableAppendOutcome,
	read: CommittedTranscriptRead,
	residentAttempt: AppendReconciliationInput["residentAttempt"] = "discarded",
) => reconcileUncertainAppend({ outcome, read, sessionId: SESSION_ID, residentAttempt });

describe("uncertain append reconciliation", () => {
	it("reports committed when the transcript carries the id", () => {
		expect(reconcile(unknownWith("a1"), snapshotRead(SESSION_ID, ["a1"]))).toEqual({ kind: "committed", id: "a1" });
	});

	it("reports not_committed only for a readable same-session transcript without the id", () => {
		expect(reconcile(unknownWith("a1"), snapshotRead(SESSION_ID, ["b2"]))).toEqual({ kind: "not_committed" });
	});

	it("never claims not_committed while this process may still hold the attempt", () => {
		// A retained entry is republished by the next rewrite, so retrying duplicates it.
		for (const residentAttempt of ["retained", "unknown"] as const)
			expect(reconcile(unknownWith("a1"), snapshotRead(SESSION_ID, ["b2"]), residentAttempt)).toEqual({
				kind: "indeterminate",
				reason: "resident_attempt_retained",
			});
	});

	it("never claims not_committed without a readable transcript", () => {
		expect(reconcile(unknownWith("a1"), { kind: "absent" })).toEqual({
			kind: "indeterminate",
			reason: "absent_transcript",
		});
		expect(reconcile(unknownWith("a1"), { kind: "unsupported", reason: "version" })).toEqual({
			kind: "indeterminate",
			reason: "unsupported_transcript",
		});
	});

	it("is indeterminate when the append cannot name its entry", () => {
		expect(reconcile(unknownWith(null), snapshotRead(SESSION_ID, ["b2"]))).toEqual({
			kind: "indeterminate",
			reason: "entry_id_unknown",
		});
	});

	it("treats another session's transcript as a conflict rather than evidence", () => {
		expect(reconcile(unknownWith("a1"), snapshotRead("01a1b5b3-12fe-7136-9c85-ad1b859d6ca9", ["a1"]))).toEqual({
			kind: "conflict",
			reason: "different_session",
		});
		// The session check precedes the committed branch, so a committed claim from
		// another session conflicts instead of reading as a success.
		expect(reconcile({ kind: "committed", id: "a1" }, snapshotRead("other", ["a1"]))).toEqual({
			kind: "conflict",
			reason: "different_session",
		});
	});

	it("confirms a committed outcome the transcript carries", () => {
		expect(reconcile({ kind: "committed", id: "a1" }, snapshotRead(SESSION_ID, ["a1"]))).toEqual({
			kind: "committed",
			id: "a1",
		});
	});

	it("flags a committed outcome the transcript does not show", () => {
		expect(reconcile({ kind: "committed", id: "a1" }, snapshotRead(SESSION_ID, ["b2"]))).toEqual({
			kind: "conflict",
			reason: "missing_committed_entry",
		});
	});

	it("refuses to reconcile an outcome that is not uncertain", () => {
		// Widened or JavaScript callers can pass these; silence would read as evidence.
		expect(reconcile({ kind: "accepted", id: "a1" }, snapshotRead(SESSION_ID, ["a1"]))).toEqual({
			kind: "indeterminate",
			reason: "outcome_not_uncertain",
		});
		expect(
			reconcile({ kind: "not_committed", error: new Error("refused") }, snapshotRead(SESSION_ID, ["a1"])),
		).toEqual({ kind: "indeterminate", reason: "outcome_not_uncertain" });
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
		const sessionId = manager.getSessionId();
		const settle = (outcome: DurableAppendOutcome) =>
			reconcileUncertainAppend({ outcome, read, sessionId, residentAttempt: "discarded" });

		expect(settle(unknownWith(id))).toEqual({ kind: "committed", id });
		expect(settle(unknownWith("deadbeef"))).toEqual({ kind: "not_committed" });
	});
});
