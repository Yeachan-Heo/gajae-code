import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CURRENT_SESSION_VERSION } from "../../src/sdk/session-readonly/format";
import { observeEmbeddedTranscript } from "../../src/sdk/transcript-observation";
import { RESUME_CURSOR_CUSTOM_TYPE, type ResumeCursorData } from "../../src/session/resume-cursor";
import {
	type CustomEntry,
	getSessionMessageEntryId,
	type SessionHeader,
	SessionManager,
	type SessionMessageEntry,
	type TranscriptSnapshotHandle,
} from "../../src/session/session-manager";

const timestamp = "2026-11-17T15:00:00.000Z";
const sessionId = "observation-session";
const cleanups: Array<() => void> = [];

afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function fixture(entries: readonly unknown[] = []) {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gjc-transcript-observation-")));
	cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
	const cwd = path.join(root, "project");
	fs.mkdirSync(cwd);
	const file = path.join(root, "session.jsonl");
	const header: SessionHeader = { type: "session", version: CURRENT_SESSION_VERSION, id: sessionId, timestamp, cwd };
	const bytes = `${[header, ...entries].map(entry => JSON.stringify(entry)).join("\n")}\n`;
	fs.writeFileSync(file, bytes);
	return { root, file, cwd, sessionId, header, bytes };
}

function message(id: string, parentId: string | null, content = id): SessionMessageEntry {
	return { type: "message", id, parentId, timestamp, message: { role: "user", content, timestamp: 1 } };
}

function cursor(id: string, parentId: string | null, supersedes: string[] = []): CustomEntry<ResumeCursorData> {
	return {
		type: "custom",
		id,
		parentId,
		timestamp,
		customType: RESUME_CURSOR_CUSTOM_TYPE,
		data: { v: 1, bind: sessionId, op: "select", idx: 0, member: "observer-fixture", reason: "explicit", supersedes },
	};
}

/** Keep the real descriptor-bound capture; intercept only the observation's handoff. */
function capturedFixture(file: string) {
	const captured = SessionManager.captureTranscriptStrict(file);
	if (captured.kind !== "captured") throw new Error(`Fixture capture failed: ${captured.reason}`);
	const snapshot = captured.snapshot;
	const close = spyOn(snapshot, "close");
	const capture = spyOn(SessionManager, "captureTranscriptStrict").mockReturnValue(captured);
	cleanups.push(() => {
		capture.mockRestore();
		close.mockRestore();
		snapshot.close();
	});
	return { snapshot, close, capture };
}

function mutateAtRevalidation(snapshot: TranscriptSnapshotHandle, mutate: () => void) {
	const revalidate = snapshot.revalidate.bind(snapshot);
	const check = spyOn(snapshot, "revalidate").mockImplementation(() => {
		mutate();
		return revalidate();
	});
	cleanups.push(() => check.mockRestore());
	return check;
}

describe("observeEmbeddedTranscript", () => {
	it("returns the exact captured identity and ordered persisted messages without changing bytes or IDs", () => {
		const entries = [message("first", null), message("second", "first")];
		const input = fixture(entries);
		const { snapshot, close, capture } = capturedFixture(input.file);
		const result = observeEmbeddedTranscript(input);
		expect(capture).toHaveBeenCalledWith(input.file);
		expect(result.kind).toBe("observed");
		if (result.kind !== "observed") throw new Error(`Observation refused: ${result.reason}`);
		expect(result.identity).toEqual(snapshot.identity);
		expect(result.identity).not.toBe(snapshot.identity);
		expect(result.identity).toMatchObject({
			canonicalPath: input.file,
			sessionId,
			size: Buffer.byteLength(input.bytes),
			sha256: createHash("sha256").update(input.bytes).digest("hex"),
		});
		expect(result.checkpoint).toMatchObject({
			kind: "tail_unambiguous",
			headerId: sessionId,
			leafEntryId: "second",
			conversationLeafId: "second",
			snapshotDigest: result.identity.sha256,
			authority: "none",
		});
		expect(result.selectionRequired).toBe(false);
		expect(result.messages).toEqual(entries.map(entry => entry.message));
		expect(result.messages.map(getSessionMessageEntryId)).toEqual(["first", "second"]);
		expect(result.messageObservations).toEqual([
			{ kind: "content", entryId: "first" },
			{ kind: "content", entryId: "second" },
		]);
		expect(result.unresolvedCount).toBe(0);
		expect(fs.readFileSync(input.file, "utf8")).toBe(input.bytes);
		expect(close).toHaveBeenCalledTimes(1);
		expect(() => snapshot.materialize()).toThrow("transcript_handle_closed");
	});

	for (const mismatch of ["sessionId", "cwd"] as const) {
		it(`refuses an exact header ${mismatch} mismatch and closes the capture`, () => {
			const input = fixture([message("first", null)]);
			const { close } = capturedFixture(input.file);
			expect(observeEmbeddedTranscript({ ...input, [mismatch]: `${input[mismatch]}-different` })).toEqual({
				kind: "refused",
				reason: "context_mismatch",
			});
			expect(close).toHaveBeenCalledTimes(1);
			expect(fs.readFileSync(input.file, "utf8")).toBe(input.bytes);
		});
	}

	it("follows a recorded older branch rather than the last persisted message", () => {
		const root = message("root", null);
		const selected = message("selected", "root", "selected history");
		const tail = message("physical-tail", "root", "must not be guessed");
		const input = fixture([root, selected, tail, cursor("selection", "selected", ["physical-tail"])]);
		const { close } = capturedFixture(input.file);
		const result = observeEmbeddedTranscript(input);
		if (result.kind !== "observed") throw new Error(`Observation refused: ${result.reason}`);
		expect(result.checkpoint).toMatchObject({
			kind: "recorded",
			leafEntryId: "selection",
			conversationLeafId: "selected",
			cursorEntryId: "selection",
			candidateCount: 1,
			authority: "none",
		});
		expect(result.selectionRequired).toBe(false);
		expect(result.messages).toEqual([root.message, selected.message]);
		expect(result.messageObservations).toEqual([
			{ kind: "content", entryId: "root" },
			{ kind: "content", entryId: "selected" },
		]);
		expect(close).toHaveBeenCalledTimes(1);
		expect(fs.readFileSync(input.file, "utf8")).toBe(input.bytes);
	});

	it("preserves a recorded empty selection instead of falling back to historical messages", () => {
		const input = fixture([message("historical", null), cursor("empty-selection", null, ["historical"])]);
		const { close } = capturedFixture(input.file);
		const result = observeEmbeddedTranscript(input);
		if (result.kind !== "observed") throw new Error(`Observation refused: ${result.reason}`);
		expect(result.checkpoint).toMatchObject({
			kind: "recorded",
			leafEntryId: "empty-selection",
			conversationLeafId: null,
			cursorEntryId: "empty-selection",
			authority: "none",
		});
		expect(result.selectionRequired).toBe(false);
		expect(result.messages).toEqual([]);
		expect(result.messageObservations).toEqual([]);
		expect(result.unresolvedCount).toBe(0);
		expect(close).toHaveBeenCalledTimes(1);
	});

	for (const kind of ["legacy_tail", "ambiguous"] as const) {
		it(`requires selection for ${kind} without exposing a guessed context`, () => {
			const entries = [message("root", null), message("left", "root"), message("right", "root")];
			const input = fixture(kind === "ambiguous" ? [...entries, cursor("selection", "left")] : entries);
			const { close } = capturedFixture(input.file);
			const result = observeEmbeddedTranscript(input);
			if (result.kind !== "observed") throw new Error(`Observation refused: ${result.reason}`);
			expect(result.checkpoint).toMatchObject({ kind, candidateCount: 2, authority: "none" });
			expect(result.selectionRequired).toBe(true);
			expect(result.messages).toEqual([]);
			expect(result.messageObservations).toEqual([]);
			expect(result.unresolvedCount).toBe(0);
			expect(close).toHaveBeenCalledTimes(1);
		});
	}

	it("observes a header-only empty transcript without selecting a branch", () => {
		const input = fixture();
		const { close } = capturedFixture(input.file);
		const result = observeEmbeddedTranscript(input);
		if (result.kind !== "observed") throw new Error(`Observation refused: ${result.reason}`);
		expect(result.checkpoint).toMatchObject({
			kind: "empty",
			leafEntryId: null,
			conversationLeafId: null,
			candidateCount: 0,
			authority: "none",
		});
		expect(result.selectionRequired).toBe(false);
		expect(result.messages).toEqual([]);
		expect(result.messageObservations).toEqual([]);
		expect(result.unresolvedCount).toBe(0);
		expect(close).toHaveBeenCalledTimes(1);
	});

	for (const malformed of ["zero-bytes", "broken-json", "invalid-utf8", "missing-header"] as const) {
		it(`refuses ${malformed} instead of returning partial or fabricated history`, () => {
			const input = fixture([message("first", null)]);
			switch (malformed) {
				case "zero-bytes":
					fs.writeFileSync(input.file, "");
					break;
				case "broken-json":
					fs.appendFileSync(input.file, "{broken\n");
					break;
				case "invalid-utf8":
					fs.appendFileSync(input.file, Buffer.from([0xff, 0x0a]));
					break;
				case "missing-header":
					fs.writeFileSync(input.file, `${JSON.stringify(message("first", null))}\n`);
					break;
			}
			const bytes = fs.readFileSync(input.file);
			expect(observeEmbeddedTranscript(input)).toEqual({ kind: "refused", reason: "malformed" });
			expect(fs.readFileSync(input.file)).toEqual(bytes);
		});
	}

	it("preserves strict capture refusal rather than creating a missing transcript", () => {
		const input = fixture();
		fs.unlinkSync(input.file);
		const capture = SessionManager.captureTranscriptStrict(input.file);
		if (capture.kind === "captured") throw new Error("Missing transcript unexpectedly captured");
		expect(observeEmbeddedTranscript(input)).toEqual({ kind: "refused", reason: capture.reason });
		expect(fs.existsSync(input.file)).toBe(false);
	});

	for (const invalid of ["duplicate-id", "forward-parent", "duplicate-header", "unsupported-record"] as const) {
		it(`refuses an invalid ${invalid} graph and closes the capture`, () => {
			const entries: unknown[] = [message("first", null)];
			switch (invalid) {
				case "duplicate-id":
					entries.push(message("first", null));
					break;
				case "forward-parent":
					entries.push(message("second", "not-recorded"));
					break;
				case "duplicate-header":
					entries.push({ type: "session", id: "other-session", timestamp, cwd: "/other" });
					break;
				case "unsupported-record":
					entries.push({ type: "not-a-session-entry", id: "second", parentId: "first", timestamp });
					break;
			}
			const input = fixture(entries);
			const { close } = capturedFixture(input.file);
			expect(observeEmbeddedTranscript(input)).toEqual({ kind: "refused", reason: "invalid_checkpoint" });
			expect(close).toHaveBeenCalledTimes(1);
			expect(fs.readFileSync(input.file, "utf8")).toBe(input.bytes);
		});
	}

	for (const mutation of ["moved", "replaced", "changed"] as const) {
		it(`refuses a ${mutation} capture at final revalidation and closes it`, () => {
			const input = fixture([message("first", null)]);
			const { snapshot, close } = capturedFixture(input.file);
			const revalidate = mutateAtRevalidation(snapshot, () => {
				if (mutation === "changed") {
					// Same-length valid bytes still invalidate the captured digest/descriptor.
					fs.writeFileSync(input.file, input.bytes.replace('"content":"first"', '"content":"other"'));
				} else {
					fs.renameSync(input.file, `${input.file}.moved`);
					if (mutation === "replaced") fs.writeFileSync(input.file, input.bytes);
				}
			});
			expect(observeEmbeddedTranscript(input)).toEqual({ kind: "refused", reason: "stale_snapshot" });
			expect(revalidate).toHaveBeenCalledTimes(1);
			expect(close).toHaveBeenCalledTimes(1);
		});
	}

	for (const phase of ["materialize", "decode", "parse", "context", "revalidate"] as const) {
		it(`closes the capture when ${phase} fails without leaking a partial observation`, () => {
			const input = fixture(
				phase === "context"
					? [{ type: "message", id: "first", parentId: null, timestamp }]
					: [message("first", null)],
			);
			if (phase === "parse") {
				fs.writeFileSync(
					input.file,
					`${JSON.stringify({ ...input.header, version: CURRENT_SESSION_VERSION + 1 })}\n`,
				);
			}
			const { snapshot, close } = capturedFixture(input.file);
			if (phase === "materialize" || phase === "decode") {
				const materialize = spyOn(snapshot, "materialize").mockImplementation(() => {
					if (phase === "decode") return new Uint8Array([0xff]);
					throw new Error("capture read failed");
				});
				cleanups.push(() => materialize.mockRestore());
			} else if (phase === "revalidate") {
				const revalidate = spyOn(snapshot, "revalidate").mockImplementation(() => {
					throw new Error("capture revalidation failed");
				});
				cleanups.push(() => revalidate.mockRestore());
			}
			expect(observeEmbeddedTranscript(input)).toEqual({ kind: "refused", reason: "stale_snapshot" });
			expect(close).toHaveBeenCalledTimes(1);
		});
	}

	it("keeps ordered unresolved resident records and both resolved neighbors without loading payloads", () => {
		const reference = `blob:sha256:${"a".repeat(64)}`;
		const before = message("before", null);
		const unresolvedText = message("unresolved-text", "before", reference);
		const between = message("between", "unresolved-text");
		const unresolvedImage: SessionMessageEntry = {
			...message("unresolved-image", "between"),
			message: {
				role: "user",
				content: [
					{ type: "text", text: "resolved fragment must not hide the unavailable image" },
					{ type: "image", data: reference, mimeType: "image/png" },
				],
				timestamp: 1,
			},
		};
		const after = message("after", "unresolved-image");
		const input = fixture([before, unresolvedText, between, unresolvedImage, after]);
		const { close } = capturedFixture(input.file);
		const filesBefore = fs.readdirSync(input.root).sort();
		const result = observeEmbeddedTranscript(input);
		if (result.kind !== "observed") throw new Error(`Observation refused: ${result.reason}`);
		expect(result.selectionRequired).toBe(false);
		expect(result.messages).toEqual([before.message, between.message, after.message]);
		expect(result.messages.map(getSessionMessageEntryId)).toEqual(["before", "between", "after"]);
		expect(result.messageObservations).toEqual([
			{ kind: "content", entryId: "before" },
			{ kind: "unresolved", entryId: "unresolved-text", reason: "resident_payload_unavailable" },
			{ kind: "content", entryId: "between" },
			{ kind: "unresolved", entryId: "unresolved-image", reason: "resident_payload_unavailable" },
			{ kind: "content", entryId: "after" },
		]);
		expect(result.unresolvedCount).toBe(2);
		expect(result.messageObservations.length).toBe(result.messages.length + result.unresolvedCount);
		expect(fs.readdirSync(input.root).sort()).toEqual(filesBefore);
		expect(fs.readFileSync(input.file, "utf8")).toBe(input.bytes);
		expect(close).toHaveBeenCalledTimes(1);
	});

	it("does not silently drop a context consisting entirely of unavailable resident payloads", () => {
		const input = fixture([message("unavailable", null, `blob:sha256:${"b".repeat(64)}`)]);
		const result = observeEmbeddedTranscript(input);
		if (result.kind !== "observed") throw new Error(`Observation refused: ${result.reason}`);
		expect(result.messages).toEqual([]);
		expect(result.messageObservations).toEqual([
			{ kind: "unresolved", entryId: "unavailable", reason: "resident_payload_unavailable" },
		]);
		expect(result.unresolvedCount).toBe(1);
		expect(result.selectionRequired).toBe(false);
	});

	it("treats ordinary strings resembling references as resolved content", () => {
		const entries = [
			message("prose", null, `Reference in prose: blob:sha256:${"a".repeat(64)}`),
			message("invalid-ref", "prose", "blob:sha256:not-a-digest"),
		];
		const result = observeEmbeddedTranscript(fixture(entries));
		if (result.kind !== "observed") throw new Error(`Observation refused: ${result.reason}`);
		expect(result.messages).toEqual(entries.map(entry => entry.message));
		expect(result.messageObservations).toEqual([
			{ kind: "content", entryId: "prose" },
			{ kind: "content", entryId: "invalid-ref" },
		]);
		expect(result.unresolvedCount).toBe(0);
	});

	it("observes persisted ownership metadata without constructing, resuming, or admitting a manager", () => {
		const owner: CustomEntry = {
			type: "custom",
			id: "owner-metadata",
			parentId: "first",
			timestamp,
			customType: "gjc.owner_enroll",
			data: {
				v: 1,
				bind: sessionId,
				member: "existing-member",
				runtime: "native",
				pid: 123,
				processIncarnation: "existing-process",
				hostId: "existing-host",
				epoch: "existing-epoch",
			},
		};
		const input = fixture([message("first", null), owner]);
		const methods = [
			"create",
			"createForOwnerAdmission",
			"inMemory",
			"open",
			"openExistingStrict",
			"openExistingForRecoveryHydrationStrict",
			"continueRecent",
			"forkFrom",
			"forkFromCaptured",
			"openStaged",
			"openNestedManaged",
			"openStagedNestedManaged",
		] as const;
		const guards = methods.map(method => {
			const guard = spyOn(SessionManager, method).mockImplementation(() => {
				throw new Error(`Observation must not call SessionManager.${method}`);
			});
			cleanups.push(() => guard.mockRestore());
			return guard;
		});
		const filesBefore = fs.readdirSync(input.root).sort();
		const result = observeEmbeddedTranscript(input);
		if (result.kind !== "observed") throw new Error(`Observation refused: ${result.reason}`);
		expect(Object.keys(result).sort()).toEqual(
			[
				"kind",
				"identity",
				"checkpoint",
				"selectionRequired",
				"messages",
				"messageObservations",
				"unresolvedCount",
			].sort(),
		);
		expect(result.checkpoint).toMatchObject({ kind: "tail_unambiguous", authority: "none", leafEntryId: "first" });
		expect(result.messageObservations).toEqual([{ kind: "content", entryId: "first" }]);
		for (const guard of guards) expect(guard).not.toHaveBeenCalled();
		expect(fs.readdirSync(input.root).sort()).toEqual(filesBefore);
		expect(fs.readFileSync(input.file, "utf8")).toBe(input.bytes);
	});
});
