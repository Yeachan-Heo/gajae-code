import { describe, expect, test } from "bun:test";
import { PlanPreviewOverlay } from "../src/modes/components/plan-preview-overlay";
import { TranscriptViewerOverlay } from "../src/modes/components/transcript-viewer-overlay";
import { initTheme } from "../src/modes/theme/theme";

initTheme();

describe("G006 WS6 overlay mouse red team", () => {
	test("transcript ignores header, out-of-bounds, and fullscreen clicks", () => {
		let renders = 0;
		const overlay = new TranscriptViewerOverlay({
			getEntries: () => [
				{ id: "one", kind: "text", payload: { text: "first", metadata: {}, source: {} } },
				{ id: "two", kind: "text", payload: { text: "second", metadata: {}, source: {} } },
			],
			onClose: () => {},
			requestRender: () => {
				renders += 1;
			},
		});
		overlay.render(80);
		overlay.handleMouse({ kind: "click", button: 0, x: 1, y: 1 });
		overlay.handleMouse({ kind: "click", button: 0, x: 1, y: 999 });
		expect(overlay.selectedEntryId).toBe("one");
		overlay.handleMouse({ kind: "click", button: 0, x: 1, y: 999, localY: 7 });
		expect(overlay.selectedEntryId).toBe("two");
		overlay.handleInput("\n");
		overlay.handleMouse({ kind: "click", button: 0, x: 1, y: 4 });
		expect(overlay.selectedEntryId).toBe("two");
		expect(renders).toBeGreaterThan(0);
	});

	test("plan preview preserves the one-based source-line header offset and ignores outside clicks", () => {
		const overlay = new PlanPreviewOverlay(
			"first\nsecond",
			() => {},
			() => {},
		);
		overlay.handleMouse({ kind: "click", button: 0, x: 1, y: 1 });
		expect(overlay.sourceLine).toBe(1);
		overlay.handleMouse({ kind: "click", button: 0, x: 1, y: 999 });
		expect(overlay.sourceLine).toBe(1);
		overlay.handleMouse({ kind: "click", button: 0, x: 1, y: 999, localY: 3 });
		expect(overlay.sourceLine).toBe(1);
	});
});
