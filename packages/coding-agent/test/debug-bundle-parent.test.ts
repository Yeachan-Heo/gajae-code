import { describe, expect, it } from "bun:test";
import { sessionBelongsToParent } from "../src/debug/report-bundle-parent";

describe("sessionBelongsToParent", () => {
	it("accepts a child header and rejects a neighbor", () => {
		const child = JSON.stringify({ parentSession: "/tmp/sessions/parent.jsonl" });
		const neighbor = JSON.stringify({ parentSession: "/tmp/sessions/other.jsonl" });
		expect(sessionBelongsToParent(child, "parent")).toBe(true);
		expect(sessionBelongsToParent(neighbor, "parent")).toBe(false);
		expect(sessionBelongsToParent("not-json", "parent")).toBe(false);
	});
});
