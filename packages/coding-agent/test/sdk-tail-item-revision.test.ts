import { expect, test } from "bun:test";
import { TailRevisionBuffer, tailItemKey, toTailItemV1 } from "../src/sdk/cli/rows";

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
});
