import { beforeAll, describe, expect, it } from "bun:test";
import {
	PlanPreviewOverlay,
	planSnapshotHash,
	serializePlanReviewComments,
} from "../src/modes/components/plan-preview-overlay";
import { initTheme } from "../src/modes/theme/theme";

const content = "# Plan\nfirst\nsecond\nthird\nfourth\nfifth\nsixth\nseventh";
const hash = planSnapshotHash(content);
const comment = { id: "c1", startLine: 2, endLine: 8, text: "Tighten this", snapshotHash: hash, createdAt: 1 };

beforeAll(() => initTheme());
describe("PlanPreviewOverlay", () => {
	it("serializes the refine and approved comment payload byte-for-byte", () => {
		const block = serializePlanReviewComments(content, hash, [comment], "Also check tests.");
		expect(block).toBe(
			`Plan review comments (snapshot ${hash.slice(0, 8)}):\n- L2-L8: Tighten this\n> first\n> second\n> third\n> fourth\n> fifth\n> sixth\nAlso check tests.`,
		);
		expect(
			`## Reviewer comments\n\nThese comments are guidance to apply during implementation; they do not reopen planning.\n\n${block}`,
		).toBe(
			`## Reviewer comments\n\nThese comments are guidance to apply during implementation; they do not reopen planning.\n\nPlan review comments (snapshot ${hash.slice(0, 8)}):\n- L2-L8: Tighten this\n> first\n> second\n> third\n> fourth\n> fifth\n> sixth\nAlso check tests.`,
		);
	});
	it("has preview, comment input, and action bar focus transitions", () => {
		const overlay = new PlanPreviewOverlay(
			content,
			() => {},
			() => {},
		);
		expect(overlay.focusState).toBe("preview");
		overlay.handleInput("c");
		expect(overlay.focusState).toBe("commentInput");
		overlay.handleInput("\x1b");
		expect(overlay.focusState).toBe("preview");
		overlay.handleInput("\t");
		expect(overlay.focusState).toBe("actionBar");
		overlay.handleInput("\t");
		expect(overlay.focusState).toBe("preview");
	});
	it("maps wrapped raw source rows back to their source line for mouse comments", () => {
		const overlay = new PlanPreviewOverlay(
			`# Heading\n${"a long source line that wraps at narrow viewport widths ".repeat(3)}\nthird`,
			() => {},
			() => {},
		);
		overlay.render(40);
		overlay.handleMouse({ kind: "click", localY: 3 } as never);
		expect(overlay.sourceLine).toBe(2);
		overlay.handleInput("c");
		overlay.handleInput("x");
		overlay.handleInput("\r");
		expect(overlay.comments[0]?.startLine).toBe(2);
		expect(serializePlanReviewComments(overlay.content ?? "", overlay.snapshotHash, overlay.comments)).toContain(
			`> ${overlay.lines[1]}`,
		);
	});
	it("accepts notes through the comment input focus", () => {
		let result: { notes: string } | undefined;
		const overlay = new PlanPreviewOverlay(
			content,
			value => {
				result = value;
			},
			() => {},
		);
		overlay.handleInput("n");
		overlay.handleInput("n");
		overlay.handleInput("o");
		overlay.handleInput("t");
		overlay.handleInput("e");
		overlay.handleInput("\r");
		overlay.handleInput("\t");
		overlay.handleInput("\r");
		expect(result?.notes).toBe("note");
	});
	it("pages a large plan and renders an explicit empty state", () => {
		const overlay = new PlanPreviewOverlay(
			Array.from({ length: 80 }, (_, i) => `line ${i + 1}`).join("\n"),
			() => {},
			() => {},
		);
		overlay.handleInput("\x1b[6~");
		expect(overlay.pageOffset).toBeGreaterThan(0);
		const empty = new PlanPreviewOverlay(
			null,
			() => {},
			() => {},
		);
		expect(empty.render(80).join("\n")).toContain("empty or missing");
	});
	it("opens the external editor and refreshes the snapshot without stale comments", async () => {
		let externalEditorCalls = 0;
		const overlay = new PlanPreviewOverlay(
			content,
			() => {},
			() => {},
			{
				externalEditorKey: "Ctrl+G",
				externalEditorKeys: ["ctrl+g"],
				onExternalEditor: async () => {
					externalEditorCalls += 1;
					return "# Updated plan\nchanged";
				},
			},
		);
		overlay.handleInput("c");
		overlay.handleInput("stale");
		overlay.handleInput("\r");
		expect(overlay.comments).toHaveLength(1);
		expect(overlay.render(120).join("\n")).toContain("Ctrl+G:edit");
		overlay.handleInput("\x07");
		await Promise.resolve();
		await Promise.resolve();
		expect(externalEditorCalls).toBe(1);
		expect(overlay.content).toBe("# Updated plan\nchanged");
		expect(overlay.snapshotHash).toBe(planSnapshotHash("# Updated plan\nchanged"));
		expect(overlay.comments).toHaveLength(0);
	});
});
