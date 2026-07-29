import { describe, expect, it } from "bun:test";
import {
	type SessionManagerRevisionSnapshot,
	toSessionManagerCheckpointRevisionStrings,
} from "../../src/session/session-manager";

describe("toSessionManagerCheckpointRevisionStrings", () => {
	it("converts every revision to a canonical decimal string", () => {
		const snapshot: SessionManagerRevisionSnapshot = {
			entry: 0,
			leaf: 1,
			headerExport: 2,
			label: 3,
			replayMetadata: 4,
		};
		expect(toSessionManagerCheckpointRevisionStrings(snapshot)).toEqual({
			entry: "0",
			leaf: "1",
			headerExport: "2",
			label: "3",
			replayMetadata: "4",
		});
	});

	it("rejects negative and unsafe revision values before serialization", () => {
		expect(() =>
			toSessionManagerCheckpointRevisionStrings({
				entry: -1,
				leaf: 1,
				headerExport: 2,
				label: 3,
				replayMetadata: 4,
			}),
		).toThrow("invalid_session_manager_revision:entry");
		expect(() =>
			toSessionManagerCheckpointRevisionStrings({
				entry: Number.MAX_SAFE_INTEGER + 1,
				leaf: 1,
				headerExport: 2,
				label: 3,
				replayMetadata: 4,
			}),
		).toThrow("invalid_session_manager_revision:entry");
	});
});
