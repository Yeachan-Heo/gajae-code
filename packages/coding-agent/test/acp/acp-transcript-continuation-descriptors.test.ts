import { describe, expect, it } from "bun:test";
import { transcriptContinuations } from "@gajae-code/coding-agent/modes/acp/acp-agent";

describe("transcriptContinuations", () => {
	it("keeps only fully specified continuation descriptors", () => {
		expect(
			transcriptContinuations({
				id: "entry-1",
				error: { code: "item_too_large" },
				continuations: [
					{
						query: "Q23",
						resourceKind: "transcript",
						resourceId: "default",
						revision: "r1",
						itemId: "entry-1",
						field: "body",
					},
					{ query: "Q23", resourceKind: "transcript", resourceId: "default", revision: "r1", itemId: "entry-1" },
					{ field: "role" },
					"body",
				],
			}),
		).toEqual([
			{
				query: "Q23",
				resourceKind: "transcript",
				resourceId: "default",
				revision: "r1",
				itemId: "entry-1",
				field: "body",
			},
		]);
	});

	it("reports no continuations for an entry that carries none", () => {
		expect(transcriptContinuations({ id: "entry-1", role: "user", body: "text" })).toEqual([]);
		expect(transcriptContinuations({ id: "entry-1", continuations: {} })).toEqual([]);
		expect(transcriptContinuations(undefined)).toEqual([]);
	});
});
