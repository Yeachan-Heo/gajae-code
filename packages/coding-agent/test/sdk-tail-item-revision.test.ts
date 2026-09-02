import { expect, test } from "bun:test";
import { tailItemKey, toTailItemV1 } from "../src/sdk/cli/rows";

test("tail items carry the ring revision so generation:seq is unique across revisions (#5200)", () => {
	const turnOne = toTailItemV1({ kind: "transcript", generation: 1, seq: 1, payload: { role: "assistant" } }, { kind: "event", revision: 3 });
	const turnTwo = toTailItemV1({ kind: "transcript", generation: 1, seq: 1, payload: { role: "assistant" } }, { kind: "event", revision: 4 });
	expect(turnOne.revision).toBe(3);
	expect(turnTwo.revision).toBe(4);
	expect(turnOne).toMatchObject({ generation: 1, seq: 1 });
	expect(tailItemKey(turnOne)).not.toBe(tailItemKey(turnTwo));
	expect(new Set([tailItemKey(turnOne), tailItemKey(turnTwo)])).toHaveLength(2);
	// An explicit revision on the raw item wins over the fallback.
	expect(toTailItemV1({ kind: "event", revision: 9, generation: 1, seq: 0, payload: {} }, { kind: "event", revision: 3 }).revision).toBe(9);
	// Malformed revisions are dropped, never coerced.
	expect(toTailItemV1({ kind: "event", revision: 1.5, generation: 1, seq: 0, payload: {} }, { kind: "event" }).revision).toBeUndefined();
	expect(toTailItemV1({ kind: "event", revision: -1, generation: 1, seq: 0, payload: {} }, { kind: "event" }).revision).toBeUndefined();
});
