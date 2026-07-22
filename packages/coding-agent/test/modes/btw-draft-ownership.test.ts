import { describe, expect, it } from "bun:test";
import { selectShutdownDraft } from "@gajae-code/coding-agent/modes/interactive-mode";

describe("/btw draft ownership", () => {
	it("never persists a side-chat composer draft during Ctrl-D shutdown", () => {
		expect(selectShutdownDraft("PRIVATE_SIDE_DRAFT_SENTINEL", true)).toBe("");
	});

	it("preserves the main composer draft when /btw is closed", () => {
		expect(selectShutdownDraft("MAIN_DRAFT_SENTINEL", false)).toBe("MAIN_DRAFT_SENTINEL");
	});
});
