import { describe, expect, test } from "bun:test";
import type { DesktopAttachmentDraft } from "../src/AttachmentPicker";
import { restoreAttachments, restoreDraft, restoreDraftInOrder } from "../src/composer-draft";

function draft(id: string, name: string): DesktopAttachmentDraft {
	return { id, name, size: 12, status: "ready", attachment: { kind: "text", name, text: "line" } };
}

// A refused dispatch never delivered its payload. Whatever the user typed in the
// meantime has to survive alongside the recovered text.
describe("composer restore after a refused dispatch", () => {
	test("puts the rejected text back into an empty composer", () => {
		expect(restoreDraft("", "Message that was not sent")).toBe("Message that was not sent");
	});

	test("an attachment-only dispatch restores newest text without blank lines", () => {
		expect(restoreDraft("Newly typed message", "")).toBe("Newly typed message");
		expect(restoreDraft("", "")).toBe("");
	});

	test("keeps text typed during the dispatch below the rejected text", () => {
		expect(restoreDraft("Newly typed message", "Message that was not sent")).toBe(
			"Message that was not sent\n\nNewly typed message",
		);
	});

	test("re-adds the attachments that were sent and are gone", () => {
		const sent = [draft("a", "a.txt"), draft("b", "b.png")];
		expect(restoreAttachments([], sent).map(item => item.id)).toEqual(["a", "b"]);
	});

	test("keeps newer attachments and only restores the missing ones", () => {
		const sent = [draft("a", "a.txt"), draft("b", "b.png")];
		const current = [draft("b", "b.png"), draft("c", "c.txt")];
		expect(restoreAttachments(current, sent).map(item => item.id)).toEqual(["b", "c", "a"]);
	});

	test("returns the untouched list when everything is still selected", () => {
		const sent = [draft("a", "a.txt")];
		const current = [draft("a", "a.txt")];
		expect(restoreAttachments(current, sent)).toBe(current);
	});
});

// Stop can hand back several queued messages at once. Each arrives as its own receipt, in either
// order, and all of them must come back in the order they were sent, above whatever was typed.
describe("composer restore of several handed-back messages", () => {
	test("a later message goes below the earlier one already restored, above the typed text", () => {
		const first = restoreDraftInOrder("typed", "first", []);
		expect(first).toBe("first\n\ntyped");
		expect(restoreDraftInOrder(first, "second", ["first"])).toBe("first\n\nsecond\n\ntyped");
	});

	test("receipts arriving newest first still read oldest first", () => {
		const second = restoreDraftInOrder("typed", "second", []);
		expect(restoreDraftInOrder(second, "first", [])).toBe("first\n\nsecond\n\ntyped");
	});

	test("identical messages are both kept", () => {
		expect(restoreDraftInOrder(restoreDraftInOrder("", "same", []), "same", ["same"])).toBe("same\n\nsame");
	});

	test("a restored message the user edited is not matched, and nothing is dropped", () => {
		expect(restoreDraftInOrder("first, edited\n\ntyped", "second", ["first"])).toBe(
			"second\n\nfirst, edited\n\ntyped",
		);
		expect(restoreDraftInOrder("firstly\n\ntyped", "second", ["first"])).toBe("second\n\nfirstly\n\ntyped");
		expect(restoreDraftInOrder("first\n\nthird\n\ntyped", "fourth", ["first", "missing", "third"])).toBe(
			"first\n\nthird\n\nfourth\n\ntyped",
		);
	});
});
