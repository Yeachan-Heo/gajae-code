import { describe, expect, test } from "bun:test";
import { connection } from "../src/i18n/en/connection";

describe("conversation connection copy", () => {
	test("never promises that only one surface writes a conversation", () => {
		// The terminal check is best effort (a terminal registered with the local broker), so the copy
		// describes what was found and what to do, not an exclusive guarantee.
		for (const [key, text] of Object.entries(connection))
			expect({ key, text }).not.toEqual({
				key,
				text: expect.stringMatching(/only one|at a time|same time|exclusive|never both/iu),
			});
	});

	test("says a terminal continues from the latest message", () => {
		expect(connection["connection.disconnectedBody"]).toContain("from its latest message");
		expect(connection["connection.confirmKept"]).toContain("from its latest message");
	});
});
