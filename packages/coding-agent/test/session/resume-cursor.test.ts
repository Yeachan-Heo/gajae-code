import { describe, expect, it } from "bun:test";
import {
	isResumeMetadata,
	OWNER_ENROLL_CUSTOM_TYPE,
	type OwnerEnrollData,
	RESUME_CURSOR_CUSTOM_TYPE,
	RESUME_CURSOR_MAX_SUPERSEDES,
	type ResumeCursorData,
	reduceResumeTranscript,
	resolveResumeCheckpoint,
} from "../../src/session/resume-cursor";
import type { FileEntry, SessionEntry, SessionHeader } from "../../src/session/session-manager";

const digest = "caller-digest-including-raw-marker-bytes";
const timestamp = "2026-11-16T00:00:00.000Z";

function header(id = "header"): SessionHeader {
	return { type: "session", version: 3, id, timestamp, cwd: "/project" };
}

function message(id: string, parentId: string | null = null): SessionEntry {
	return { type: "message", id, parentId, timestamp, message: { role: "user", content: id, timestamp: 0 } };
}

function custom(id: string, parentId: string | null, customType: string, data: unknown): SessionEntry {
	return { type: "custom", id, parentId, timestamp, customType, data };
}

function cursorData(overrides: Partial<ResumeCursorData> = {}): ResumeCursorData {
	return {
		v: 1,
		bind: "header",
		op: "operation",
		idx: 0,
		member: "member",
		reason: "explicit",
		supersedes: [],
		...overrides,
	};
}

function cursor(id: string, parentId: string | null, overrides: Partial<ResumeCursorData> = {}): SessionEntry {
	return custom(id, parentId, RESUME_CURSOR_CUSTOM_TYPE, cursorData(overrides));
}

function ownerData(overrides: Partial<OwnerEnrollData> = {}): OwnerEnrollData {
	return {
		v: 1,
		bind: "header",
		member: "member",
		runtime: "sdk",
		pid: 42,
		processIncarnation: "process-incarnation",
		hostId: "host",
		epoch: "epoch",
		...overrides,
	};
}

function marker(id: string, parentId: string | null, overrides: Partial<OwnerEnrollData> = {}): SessionEntry {
	return custom(id, parentId, OWNER_ENROLL_CUSTOM_TYPE, ownerData(overrides));
}

function parents(entries: readonly SessionEntry[]): Array<[string, string | null]> {
	return entries.map(entry => [entry.id, entry.parentId]);
}

function deepFreeze(value: unknown): void {
	if (value === null || typeof value !== "object") return;
	for (const child of Object.values(value)) deepFreeze(child);
	Object.freeze(value);
}

describe("resume transcript reduction", () => {
	it("returns an empty checkpoint for a header and enrollment-only transcript", () => {
		const entries = [header(), marker("owner-1", null), marker("owner-2", "owner-1")];
		const result = reduceResumeTranscript(entries, digest);
		expect(result.checkpoint).toEqual({
			kind: "empty",
			headerId: "header",
			leafEntryId: null,
			conversationLeafId: null,
			candidates: [],
			candidateCount: 0,
			snapshotDigest: digest,
			authority: "none",
		});
		expect(result.executableEntries).toEqual([]);
		expect(result.markerEvidence).toEqual([
			{ entryId: "owner-1", data: ownerData() },
			{ entryId: "owner-2", data: ownerData() },
		]);
		expect(result.diagnostics).toEqual([]);
		expect(resolveResumeCheckpoint([header()], digest)).toEqual(result.checkpoint);
	});

	it("reduces a linear graph and contracts marker chains without mutating frozen input", () => {
		const entries: FileEntry[] = [
			header(),
			message("root"),
			marker("owner-1", "root"),
			marker("owner-2", "owner-1"),
			message("reply", "owner-2"),
			{ type: "model_change", id: "model", parentId: "reply", timestamp, model: "provider/model" },
		];
		const before = JSON.stringify(entries);
		deepFreeze(entries);
		const result = reduceResumeTranscript(entries, digest);
		expect(parents(result.executableEntries)).toEqual([
			["root", null],
			["reply", "root"],
			["model", "reply"],
		]);
		expect(result.checkpoint).toEqual({
			kind: "tail_unambiguous",
			headerId: "header",
			leafEntryId: "model",
			conversationLeafId: "reply",
			candidates: ["model"],
			candidateCount: 1,
			snapshotDigest: digest,
			authority: "none",
		});
		expect(result.executableEntries[1]).not.toBe(entries[4]);
		expect(JSON.stringify(entries)).toBe(before);
		expect((entries[4] as SessionEntry).parentId).toBe("owner-2");
	});

	it("does not let a stale-H marker-only append compete with a peer's advanced leaf", () => {
		const entries = [header(), message("H"), message("peer-advanced", "H")];
		const result = reduceResumeTranscript([...entries, marker("stale-owner", "H")], digest);
		expect(result.checkpoint).toEqual(resolveResumeCheckpoint(entries, digest));
		expect(result.checkpoint.candidates).toEqual(["peer-advanced"]);
		expect(parents(result.executableEntries)).toEqual([
			["H", null],
			["peer-advanced", "H"],
		]);
		expect(result.markerEvidence.map(evidence => evidence.entryId)).toEqual(["stale-owner"]);
	});

	it("does not resurrect a superseded H or select a peer when stale-H markers arrive", () => {
		const entries = [
			header(),
			message("H"),
			message("peer"),
			cursor("peer-pin", "peer", { supersedes: ["H"], reason: "pin" }),
		];
		const result = reduceResumeTranscript([...entries, marker("stale-owner", "H")], digest);
		expect(result.checkpoint).toEqual(resolveResumeCheckpoint(entries, digest));
		expect(result.checkpoint.candidates).toEqual(["peer-pin"]);
		expect(result.checkpoint.leafEntryId).toBe("peer-pin");
		expect(result.checkpoint.conversationLeafId).toBe("peer");
		expect(parents(result.executableEntries)).toEqual([
			["H", null],
			["peer", null],
			["peer-pin", "peer"],
		]);

		const branched = [header(), message("H"), message("peer"), message("peer-advanced", "peer")];
		const ambiguousLegacy = reduceResumeTranscript([...branched, marker("stale-owner", "H")], digest);
		expect(ambiguousLegacy.checkpoint).toEqual(resolveResumeCheckpoint(branched, digest));
		expect(ambiguousLegacy.checkpoint.candidates).toEqual(["H", "peer-advanced"]);
	});

	it("exposes the complete legacy branch set and only a deterministic display tail", () => {
		const entries = [header(), message("root"), message("left", "root"), message("right", "root")];
		entries[2].timestamp = "2099-01-01T00:00:00.000Z";
		entries[3].timestamp = "1900-01-01T00:00:00.000Z";
		const result = reduceResumeTranscript(entries, digest);
		expect(result.checkpoint).toEqual({
			kind: "legacy_tail",
			headerId: "header",
			leafEntryId: "right",
			conversationLeafId: "right",
			candidates: ["left", "right"],
			candidateCount: 2,
			snapshotDigest: digest,
			authority: "none",
		});
		expect(parents(result.executableEntries)).toEqual([
			["root", null],
			["left", "root"],
			["right", "root"],
		]);
	});

	it("records a sequential cursor handoff and follows its subsequent executable descendants", () => {
		const entries = [
			header(),
			message("root"),
			message("left", "root"),
			message("right", "root"),
			cursor("first-pin", "left", { supersedes: ["right"] }),
			cursor("handoff", "right", { supersedes: ["first-pin"], member: "peer", op: "handoff" }),
			message("continued", "handoff"),
		];
		const checkpoint = resolveResumeCheckpoint(entries, digest);
		expect(checkpoint.kind).toBe("recorded");
		expect(checkpoint.candidates).toEqual(["continued"]);
		expect(checkpoint.leafEntryId).toBe("continued");
		expect(checkpoint.cursorEntryId).toBe("handoff");
		expect(checkpoint.conversationLeafId).toBe("continued");
		expect(parents(reduceResumeTranscript(entries, digest).executableEntries)).toEqual([
			["root", null],
			["left", "root"],
			["right", "root"],
			["first-pin", "left"],
			["handoff", "right"],
			["continued", "handoff"],
		]);
	});

	it("does not use arrival order, member, or op/idx to resolve concurrent cursor branches", () => {
		const entries = [
			header(),
			message("root"),
			message("left", "root"),
			message("right", "root"),
			cursor("left-pin", "left", { supersedes: ["right"], idx: 17 }),
			cursor("right-pin", "right", { supersedes: ["left"], idx: 18 }),
		];
		const checkpoint = resolveResumeCheckpoint(entries, digest);
		expect(checkpoint.kind).toBe("ambiguous");
		expect(checkpoint.candidates).toEqual(["left-pin", "right-pin"]);
		expect(checkpoint.candidateCount).toBe(2);
		expect(checkpoint.leafEntryId).toBeNull();
		expect(checkpoint.conversationLeafId).toBeNull();
		expect(checkpoint.cursorEntryId).toBeUndefined();
		expect(checkpoint.authority).toBe("none");
		const withStaleMarker = reduceResumeTranscript([...entries, marker("stale-owner", "left")], digest);
		expect(withStaleMarker.checkpoint).toEqual(checkpoint);
		expect(parents(withStaleMarker.executableEntries)).toEqual([
			["root", null],
			["left", "root"],
			["right", "root"],
			["left-pin", "left"],
			["right-pin", "right"],
		]);
	});

	it("does not combine or deduplicate supersedes across separate cursor chunks", () => {
		const result = reduceResumeTranscript(
			[
				header(),
				message("left"),
				message("right"),
				cursor("first", "right", { supersedes: ["left"], idx: 0 }),
				cursor("second", "first", { supersedes: ["left"], idx: 0 }),
			],
			digest,
		);
		expect(result.checkpoint.kind).toBe("recorded");
		expect(result.checkpoint.candidates).toEqual(["second"]);
		expect(result.checkpoint.cursorEntryId).toBe("second");
		expect(result.diagnostics).toEqual([]);
		expect(parents(result.executableEntries)).toEqual([
			["left", null],
			["right", null],
			["first", "right"],
			["second", "first"],
		]);
	});

	for (const count of [257, 1000]) {
		it(`applies every independent partial chunk immediately across ${count} candidates`, () => {
			const ids = Array.from({ length: count }, (_, index) => `leaf-${index}`);
			const entries: FileEntry[] = [header(), ...ids.map(id => message(id))];
			expect(resolveResumeCheckpoint(entries, digest).candidates).toEqual(ids);
			let parentId: string | null = null;
			for (let start = 0, idx = 0; start < count; start += RESUME_CURSOR_MAX_SUPERSEDES, idx++) {
				const end = Math.min(start + RESUME_CURSOR_MAX_SUPERSEDES, count);
				const id = `chunk-${idx}`;
				entries.push(cursor(id, parentId, { idx, supersedes: ids.slice(start, end) }));
				const result = reduceResumeTranscript(entries, digest);
				const expectedCandidates = [...ids.slice(end), id];
				expect(result.checkpoint.candidates).toEqual(expectedCandidates);
				expect(result.checkpoint.candidateCount).toBe(expectedCandidates.length);
				expect(result.checkpoint.kind).toBe(end === count ? "recorded" : "ambiguous");
				expect(result.checkpoint.leafEntryId).toBe(end === count ? id : null);
				expect(result.diagnostics).toEqual([]);
				expect(parents(result.executableEntries).slice(-idx - 1)).toEqual(
					Array.from({ length: idx + 1 }, (_, chunk) => [
						`chunk-${chunk}`,
						chunk === 0 ? null : `chunk-${chunk - 1}`,
					]),
				);
				parentId = id;
			}
		});
	}

	it("supports a null-root cursor without inventing a conversational ancestor", () => {
		const checkpoint = resolveResumeCheckpoint(
			[header(), message("old"), cursor("fork", null, { reason: "fork_init", supersedes: ["old"] })],
			digest,
		);
		expect(checkpoint.kind).toBe("recorded");
		expect(checkpoint.candidates).toEqual(["fork"]);
		expect(checkpoint.leafEntryId).toBe("fork");
		expect(checkpoint.cursorEntryId).toBe("fork");
		expect(checkpoint.conversationLeafId).toBeNull();
	});

	it("allows earlier nonleaf references and supersedes cursors outside the selected ancestry", () => {
		const entries = [
			header(),
			message("root"),
			message("left", "root"),
			message("right", "root"),
			cursor("left-pin", "left", { supersedes: ["root"] }),
		];
		const partial = reduceResumeTranscript(entries, digest);
		expect(partial.checkpoint.kind).toBe("ambiguous");
		expect(partial.checkpoint.candidates).toEqual(["right", "left-pin"]);
		expect(partial.diagnostics).toEqual([]);
		const result = reduceResumeTranscript(
			[...entries, cursor("right-pin", "right", { supersedes: ["left-pin"] })],
			digest,
		);
		expect(result.checkpoint.candidates).toEqual(["right-pin"]);
		expect(result.checkpoint.kind).toBe("recorded");
		expect(result.checkpoint.cursorEntryId).toBe("right-pin");
		expect(result.checkpoint.conversationLeafId).toBe("right");
	});

	it("keeps a null-root malformed-metadata-only transcript empty, not executable", () => {
		const result = reduceResumeTranscript(
			[
				header(),
				custom("bad", null, RESUME_CURSOR_CUSTOM_TYPE, null),
				marker("copied", "bad", { bind: "other-header" }),
			],
			digest,
		);
		expect(result.checkpoint.kind).toBe("empty");
		expect(result.checkpoint.candidates).toEqual([]);
		expect(result.executableEntries).toEqual([]);
		expect(result.markerEvidence).toEqual([]);
		expect(result.diagnostics).toEqual([
			{ entryId: "bad", reason: "invalid_resume_cursor" },
			{ entryId: "copied", reason: "invalid_owner_enroll" },
		]);
	});

	it("contracts bind-mismatched copied metadata and children to the containing header's graph", () => {
		const entries = [
			header("copy"),
			message("root"),
			cursor("copied-cursor", "root"),
			marker("copied-owner", "copied-cursor"),
			message("child", "copied-owner"),
		];
		const result = reduceResumeTranscript(entries, digest);
		expect(result.checkpoint.headerId).toBe("copy");
		expect(result.checkpoint.kind).toBe("tail_unambiguous");
		expect(result.checkpoint.candidates).toEqual(["child"]);
		expect(result.markerEvidence).toEqual([]);
		expect(result.diagnostics).toEqual([
			{ entryId: "copied-cursor", reason: "invalid_resume_cursor" },
			{ entryId: "copied-owner", reason: "invalid_owner_enroll" },
		]);
		expect(parents(result.executableEntries)).toEqual([
			["root", null],
			["child", "root"],
		]);
	});

	const malformedCursors: Array<[string, unknown]> = [
		["absent data", undefined],
		["array data", []],
		["unsupported version", { ...cursorData(), v: 2 }],
		["missing member", { v: 1, bind: "header", op: "operation", idx: 0, reason: "pin", supersedes: [] }],
		["wrong operation type", { ...cursorData(), op: 7 }],
		["negative index", cursorData({ idx: -1 })],
		["fractional index", cursorData({ idx: 0.5 })],
		["nonfinite index", cursorData({ idx: Number.POSITIVE_INFINITY })],
		["string index", { ...cursorData(), idx: "0" }],
		["unknown reason", { ...cursorData(), reason: "tail" }],
		["non-array supersedes", { ...cursorData(), supersedes: "root" }],
		["non-string reference", { ...cursorData(), supersedes: [1] }],
		["duplicate references", cursorData({ supersedes: ["root", "root"] })],
		["missing reference", cursorData({ supersedes: ["missing"] })],
		["header reference", cursorData({ supersedes: ["header"] })],
		["enrollment reference", cursorData({ supersedes: ["owner"] })],
		["inert metadata reference", cursorData({ supersedes: ["inert"] })],
		["self reference", cursorData({ supersedes: ["bad"] })],
		["later reference", cursorData({ supersedes: ["later"] })],
	];
	for (const [name, data] of malformedCursors) {
		it(`makes a cursor with ${name} inert without promoting it to a leaf`, () => {
			const result = reduceResumeTranscript(
				[
					header(),
					message("root"),
					marker("owner", "root"),
					custom("inert", "owner", RESUME_CURSOR_CUSTOM_TYPE, null),
					custom("bad", "inert", RESUME_CURSOR_CUSTOM_TYPE, data),
					message("later", "bad"),
				],
				digest,
			);
			expect(result.checkpoint.kind).toBe("tail_unambiguous");
			expect(result.checkpoint.candidates).toEqual(["later"]);
			expect(result.checkpoint.cursorEntryId).toBeUndefined();
			expect(parents(result.executableEntries)).toEqual([
				["root", null],
				["later", "root"],
			]);
			expect(result.diagnostics).toEqual([
				{ entryId: "inert", reason: "invalid_resume_cursor" },
				{ entryId: "bad", reason: "invalid_resume_cursor" },
			]);
		});
	}

	for (const supersedes of [
		["left", "missing"],
		["left", "left"],
	]) {
		it(`applies no part of an invalid supersedes list ${JSON.stringify(supersedes)}`, () => {
			const result = reduceResumeTranscript(
				[header(), message("left"), message("right"), cursor("bad", "right", { supersedes })],
				digest,
			);
			expect(result.checkpoint.kind).toBe("legacy_tail");
			expect(result.checkpoint.candidates).toEqual(["left", "right"]);
			expect(parents(result.executableEntries)).toEqual([
				["left", null],
				["right", null],
			]);
			expect(result.diagnostics).toEqual([{ entryId: "bad", reason: "invalid_resume_cursor" }]);
		});
	}

	it("rejects a single oversized chunk without applying any of its supersedes", () => {
		const ids = Array.from({ length: 257 }, (_, index) => `leaf-${index}`);
		const result = reduceResumeTranscript(
			[header(), ...ids.map(id => message(id)), cursor("oversized", null, { supersedes: ids })],
			digest,
		);
		expect(result.checkpoint.kind).toBe("legacy_tail");
		expect(result.checkpoint.candidates).toEqual(ids);
		expect(result.checkpoint.candidateCount).toBe(257);
		expect(result.checkpoint.leafEntryId).toBe("leaf-256");
		expect(result.diagnostics).toEqual([{ entryId: "oversized", reason: "invalid_resume_cursor" }]);
	});

	it("keeps valid partial chunks real when another chunk is malformed", () => {
		const entries = [
			header(),
			message("left"),
			message("middle"),
			message("right"),
			cursor("chunk-0", "left", { supersedes: ["middle"] }),
			cursor("bad-chunk", "chunk-0", { idx: 1, supersedes: ["right", "right"] }),
			message("continued", "bad-chunk"),
		];
		const result = reduceResumeTranscript(entries, digest);
		expect(result.checkpoint.kind).toBe("ambiguous");
		expect(result.checkpoint.candidates).toEqual(["right", "continued"]);
		expect(parents(result.executableEntries)).toEqual([
			["left", null],
			["middle", null],
			["right", null],
			["chunk-0", "left"],
			["continued", "chunk-0"],
		]);
		const completed = reduceResumeTranscript(
			[...entries, cursor("chunk-2", "bad-chunk", { idx: 2, supersedes: ["right", "continued"] })],
			digest,
		);
		expect(completed.checkpoint.kind).toBe("recorded");
		expect(completed.checkpoint.candidates).toEqual(["chunk-2"]);
		expect(completed.checkpoint.conversationLeafId).toBe("left");
		expect(parents(completed.executableEntries).slice(-1)).toEqual([["chunk-2", "chunk-0"]]);
	});

	it("accepts required v1 fields with extra uninterpreted data and preserves supplied digest exactly", () => {
		const entries = [
			header(),
			message("root"),
			custom("owner", "root", OWNER_ENROLL_CUSTOM_TYPE, { ...ownerData(), future: "raw marker bytes" }),
			custom("pin", "owner", RESUME_CURSOR_CUSTOM_TYPE, { ...cursorData({ reason: "pin" }), future: true }),
		];
		const before = JSON.stringify(entries);
		deepFreeze(entries);
		const result = reduceResumeTranscript(entries, digest);
		expect(result.checkpoint.kind).toBe("recorded");
		expect(result.checkpoint.snapshotDigest).toBe(digest);
		expect(result.checkpoint.authority).toBe("none");
		expect(result.checkpoint.conversationLeafId).toBe("root");
		expect(result.markerEvidence).toEqual([
			{ entryId: "owner", data: { ...ownerData(), future: "raw marker bytes" } },
		]);
		expect(result.diagnostics).toEqual([]);
		expect(parents(result.executableEntries)).toEqual([
			["root", null],
			["pin", "root"],
		]);
		expect(JSON.stringify(entries)).toBe(before);
		expect(resolveResumeCheckpoint(entries, "different-raw-snapshot-digest").snapshotDigest).toBe(
			"different-raw-snapshot-digest",
		);
	});

	for (const [name, data] of [
		["missing data", undefined],
		["unsupported version", { ...ownerData(), v: 2 }],
		["bad runtime", { ...ownerData(), runtime: null }],
		["bad pid", { ...ownerData(), pid: "42" }],
		["infinite pid", { ...ownerData(), pid: Number.POSITIVE_INFINITY }],
		["missing incarnation", { ...ownerData(), processIncarnation: undefined }],
		["bad host", { ...ownerData(), hostId: 1 }],
		["bad epoch", { ...ownerData(), epoch: null }],
	] as Array<[string, unknown]>) {
		it(`contracts an enrollment with ${name} without changing the branch set`, () => {
			const result = reduceResumeTranscript(
				[header(), message("left"), message("right"), custom("bad-owner", "left", OWNER_ENROLL_CUSTOM_TYPE, data)],
				digest,
			);
			expect(result.checkpoint.kind).toBe("legacy_tail");
			expect(result.checkpoint.candidates).toEqual(["left", "right"]);
			expect(result.checkpoint.leafEntryId).toBe("right");
			expect(result.markerEvidence).toEqual([]);
			expect(result.diagnostics).toEqual([{ entryId: "bad-owner", reason: "invalid_owner_enroll" }]);
		});
	}

	it("reserves only custom metadata, leaving custom messages conversational", () => {
		const customMessage: SessionEntry = {
			type: "custom_message",
			id: "visible",
			parentId: null,
			timestamp,
			customType: RESUME_CURSOR_CUSTOM_TYPE,
			content: "actual conversation",
			display: true,
		};
		const entries = [header(), customMessage, custom("extension", "visible", "other.extension", {})];
		expect(isResumeMetadata(cursor("pin", null))).toBe(true);
		expect(isResumeMetadata(custom("bad", null, RESUME_CURSOR_CUSTOM_TYPE, null))).toBe(true);
		expect(isResumeMetadata(marker("owner", null))).toBe(true);
		expect(isResumeMetadata(custom("bad-owner", null, OWNER_ENROLL_CUSTOM_TYPE, null))).toBe(true);
		expect(isResumeMetadata(customMessage)).toBe(false);
		expect(isResumeMetadata(message("message"))).toBe(false);
		expect(isResumeMetadata(custom("extension", null, "other.extension", {}))).toBe(false);
		const result = reduceResumeTranscript(entries, digest);
		expect(result.checkpoint.candidates).toEqual(["extension"]);
		expect(result.checkpoint.conversationLeafId).toBe("visible");
		expect(result.diagnostics).toEqual([]);
	});

	it("uses compaction and branch summaries as conversational ancestors, not custom cursor data", () => {
		const entries: FileEntry[] = [
			header(),
			message("root"),
			{
				type: "compaction",
				id: "compact",
				parentId: "root",
				timestamp,
				summary: "summary",
				firstKeptEntryId: "root",
				tokensBefore: 100,
			},
			cursor("after-compact", "compact"),
		];
		expect(resolveResumeCheckpoint(entries, digest).conversationLeafId).toBe("compact");
		entries.push({
			type: "branch_summary",
			id: "summary",
			parentId: "after-compact",
			timestamp,
			fromId: "root",
			summary: "branch",
		});
		entries.push(cursor("after-summary", "summary"));
		const checkpoint = resolveResumeCheckpoint(entries, digest);
		expect(checkpoint.candidates).toEqual(["after-summary"]);
		expect(checkpoint.cursorEntryId).toBe("after-summary");
		expect(checkpoint.conversationLeafId).toBe("summary");
	});
});

describe("resume transcript graph validation", () => {
	const invalidGraphs: Array<[string, unknown, string]> = [
		["missing header", [message("root")], "missing_header"],
		["multiple headers", [header(), header("second")], "multiple_headers"],
		["late header", [message("root"), header()], "invalid_header"],
		["malformed header", [{ ...header(), cwd: null }], "invalid_header"],
		["duplicate executable ids", [header(), message("same"), message("same")], "duplicate_id"],
		["duplicate header id", [header(), message("header")], "duplicate_id"],
		["duplicate inert metadata ids", [header(), marker("same", null), marker("same", null)], "duplicate_id"],
		["missing parent", [header(), message("child", "absent")], "missing_or_forward_parent"],
		["forward parent", [header(), message("child", "later"), message("later")], "missing_or_forward_parent"],
		["header as parent", [header(), message("child", "header")], "missing_or_forward_parent"],
		["self cycle", [header(), message("self", "self")], "missing_or_forward_parent"],
		["two-node cycle", [header(), message("a", "b"), message("b", "a")], "missing_or_forward_parent"],
		[
			"inert marker forward edge",
			[header(), marker("owner", "later"), message("later")],
			"missing_or_forward_parent",
		],
		[
			"malformed cursor missing parent",
			[header(), custom("bad", "missing", RESUME_CURSOR_CUSTOM_TYPE, null)],
			"missing_or_forward_parent",
		],
		["null entry", [header(), null], "unsupported_entry_shape"],
		["array entry", [header(), []], "unsupported_entry_shape"],
		["unknown entry type", [header(), { ...message("unknown"), type: "future_entry" }], "unsupported_entry_shape"],
		["missing parent field", [header(), { type: "message", id: "missing", timestamp }], "unsupported_entry_shape"],
		["non-string id", [header(), { ...message("bad"), id: 7 }], "unsupported_entry_shape"],
		["non-string timestamp", [header(), { ...message("bad"), timestamp: 7 }], "unsupported_entry_shape"],
		[
			"missing custom type",
			[header(), { type: "custom", id: "bad", parentId: null, timestamp }],
			"unsupported_entry_shape",
		],
		["non-array transcript", null, "unsupported_entries_shape"],
	];
	for (const [name, entries, reason] of invalidGraphs) {
		it(`rejects ${name} rather than selecting a partial transcript tail`, () => {
			const before = JSON.stringify(entries);
			deepFreeze(entries);
			const result = reduceResumeTranscript(entries as readonly FileEntry[], digest);
			expect(result.checkpoint.kind).toBe("invalid");
			expect(result.checkpoint.candidates).toEqual([]);
			expect(result.checkpoint.candidateCount).toBe(0);
			expect(result.checkpoint.leafEntryId).toBeNull();
			expect(result.checkpoint.conversationLeafId).toBeNull();
			expect(result.checkpoint.snapshotDigest).toBe(digest);
			expect(result.checkpoint.authority).toBe("none");
			expect(result.executableEntries).toEqual([]);
			expect(result.markerEvidence).toEqual([]);
			expect(result.diagnostics.map(diagnostic => diagnostic.reason)).toEqual([reason]);
			expect(JSON.stringify(entries)).toBe(before);
		});
	}
});
