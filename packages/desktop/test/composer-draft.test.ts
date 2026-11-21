import { describe, expect, test } from "bun:test";
import type { DesktopAttachmentDraft } from "../src/AttachmentPicker";
import { restoreAttachments, restoreDraft } from "../src/composer-draft";

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
