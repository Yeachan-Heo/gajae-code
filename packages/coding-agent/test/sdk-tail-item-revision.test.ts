import { expect, test } from "bun:test";
import { TailRevisionBuffer, tailItemKey, toTailItemV1 } from "../src/sdk/cli/rows";
import { SessionEventStream } from "../src/sdk/host/events";

test("tail items carry the ring revision so generation:seq is unique across revisions (#5200)", () => {
	const turnOne = toTailItemV1(
		{ kind: "transcript", generation: 1, seq: 1, payload: { role: "assistant" } },
		{ kind: "event", revision: 3 },
	);
	const turnTwo = toTailItemV1(
		{ kind: "transcript", generation: 1, seq: 1, payload: { role: "assistant" } },
		{ kind: "event", revision: 4 },
	);
	expect(turnOne.revision).toBe(3);
	expect(turnTwo.revision).toBe(4);
	expect(turnOne).toMatchObject({ generation: 1, seq: 1 });
	expect(tailItemKey(turnOne)).not.toBe(tailItemKey(turnTwo));
	expect(new Set([tailItemKey(turnOne), tailItemKey(turnTwo)])).toHaveLength(2);
	// An explicit revision on the raw item wins over the fallback.
	expect(
		toTailItemV1({ kind: "event", revision: 9, generation: 1, seq: 0, payload: {} }, { kind: "event", revision: 3 })
			.revision,
	).toBe(9);
	// Malformed revisions are dropped, never coerced.
	expect(
		toTailItemV1({ kind: "event", revision: 1.5, generation: 1, seq: 0, payload: {} }, { kind: "event" }).revision,
	).toBeUndefined();
	expect(
		toTailItemV1({ kind: "event", revision: -1, generation: 1, seq: 0, payload: {} }, { kind: "event" }).revision,
	).toBeUndefined();
	const invalidFallback = toTailItemV1(
		{ kind: "event", generation: 1, seq: 0, payload: {} },
		{ kind: "event", revision: -1 },
	);
	expect(invalidFallback.revision).toBeUndefined();
	expect(() => tailItemKey(invalidFallback)).toThrow("authoritative revision");
	expect(() => tailItemKey({ kind: "event", revision: -1, generation: 1, seq: 0, payload: {} })).toThrow(
		"authoritative revision",
	);
});

test("a positioned live item cannot be keyed before its authoritative checkpoint revision", () => {
	const buffer = new TailRevisionBuffer();
	const liveBeforeCheckpoint = toTailItemV1(
		{ kind: "message_update", generation: 1, seq: 4, payload: { text: "same frame" } },
		{ kind: "event" },
	);
	const replayedCopy = toTailItemV1(
		{ kind: "message_update", generation: 1, seq: 4, payload: { text: "same frame" } },
		{ kind: "event", revision: 7 },
	);

	expect(() => tailItemKey(liveBeforeCheckpoint)).toThrow("authoritative revision");
	expect(buffer.push(liveBeforeCheckpoint)).toEqual([]);
	const releasedLiveItems = buffer.resolve(7);
	expect(releasedLiveItems).toEqual([expect.objectContaining({ revision: 7, generation: 1, seq: 4 })]);
	expect(new Set([...releasedLiveItems, replayedCopy].map(tailItemKey))).toHaveLength(1);
	// A positioned frame arriving AFTER the checkpoint without a revision is
	// stamped with the checkpoint's, not fatal. The host emits such frames
	// whenever its transcript provider is momentarily unavailable mid-turn; one
	// of them used to abort the entire tail with protocol_error, which made a
	// live, answering session unobservable to every consumer (2026-09-17/18).
	const lateLive = buffer.push(
		toTailItemV1(
			{ kind: "message_update", generation: 1, seq: 5, payload: { text: "new revision" } },
			{ kind: "event" },
		),
	);
	expect(lateLive).toEqual([expect.objectContaining({ revision: 7, generation: 1, seq: 5 })]);
	expect(() => tailItemKey(lateLive[0]!)).not.toThrow();
	// A frame that already carries its own revision keeps it, and it becomes
	// the stamp for what follows: revisions advance during a turn, and a
	// terminal frame stamped with the old checkpoint would sort before this
	// start (lifecycle order is revision-first) and never complete --until-idle.
	const stamped = buffer.push(
		toTailItemV1({ kind: "turn_start", revision: 9, generation: 1, seq: 6, payload: {} }, { kind: "event" }),
	);
	expect(stamped[0]?.revision).toBe(9);
	const terminalAfter = buffer.push(
		toTailItemV1({ kind: "turn_end", generation: 1, seq: 7, payload: {} }, { kind: "event" }),
	);
	expect(terminalAfter[0]?.revision).toBe(9);
	// Never regresses: an older explicit revision does not pull the stamp back.
	buffer.push(toTailItemV1({ kind: "activity", revision: 8, generation: 1, seq: 8, payload: {} }, { kind: "event" }));
	expect(
		buffer.push(toTailItemV1({ kind: "activity", generation: 1, seq: 9, payload: {} }, { kind: "event" }))[0]
			?.revision,
	).toBe(9);
});

test("ordinary live events read the authoritative revision at emission time", () => {
	let revision = 3;
	const stream = new SessionEventStream({ revisionProvider: () => revision });

	const turnOne = stream.emit({ kind: "turn_start" });
	revision = 4;
	const turnTwo = stream.emit({ kind: "turn_start" });
	const explicit = stream.emit({ kind: "turn_end", revision: 9 });

	expect(turnOne.revision).toBe(3);
	expect(turnTwo.revision).toBe(4);
	expect(explicit.revision).toBe(9);
});

test("an explicit revision observed before checkpoint resolution remains authoritative", () => {
	const buffer = new TailRevisionBuffer();
	const start = buffer.push(
		toTailItemV1({ kind: "turn_start", revision: 9, generation: 1, seq: 1, payload: {} }, { kind: "event" }),
	);
	expect(start[0]?.revision).toBe(9);

	// A stale checkpoint response must not downgrade the revision already carried
	// by the live frame, nor any unrevisioned frame that follows it.
	expect(buffer.resolve(7)).toEqual([]);
	const terminal = buffer.push(
		toTailItemV1({ kind: "turn_end", generation: 1, seq: 2, payload: {} }, { kind: "event" }),
	);
	expect(terminal[0]?.revision).toBe(9);
});
