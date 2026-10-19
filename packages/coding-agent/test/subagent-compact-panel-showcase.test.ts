import { describe, expect, it } from "bun:test";
import {
	renderSubagentCompactPanelShowcase,
	SUBAGENT_COMPACT_PANEL_SHOWCASE_ENTRIES,
	SUBAGENT_COMPACT_PANEL_STATE_IDS,
} from "./fixtures/tui/subagent-compact-panel-showcase";

describe("subagent compact panel showcase (#6774)", () => {
	it("covers every state at the canonical viewports plus the ASCII and narrow variants", () => {
		const keys = SUBAGENT_COMPACT_PANEL_SHOWCASE_ENTRIES.map(
			entry => `${entry.stateId}/${entry.columns}x${entry.rows}/${entry.renderMode}`,
		);
		expect(new Set(keys).size).toBe(keys.length);
		expect(keys).toHaveLength(26);
		for (const stateId of SUBAGENT_COMPACT_PANEL_STATE_IDS) {
			expect(keys.some(key => key.startsWith(`${stateId}/`))).toBe(true);
		}
	});

	it("renders collapsed compact states in at most four rows and covers every overflowing tail", async () => {
		for (const entry of SUBAGENT_COMPACT_PANEL_SHOWCASE_ENTRIES) {
			const rendered = await renderSubagentCompactPanelShowcase(entry);
			for (const viewport of rendered.viewports) {
				expect(viewport.terminalText.split("\n")).toHaveLength(entry.rows + 1);
				if (entry.renderMode === "ascii-no-color") expect(viewport.terminalAnsiText).toBe(viewport.terminalText);
			}
			if (entry.stateId.startsWith("compact-collapsed-")) {
				expect(rendered.panelLines).toBeLessThanOrEqual(4);
				expect(rendered.viewportOverflowRows).toBe(0);
			}
			if (rendered.viewportOverflowRows > 0) {
				expect(rendered.viewports.map(viewport => viewport.scroll)).toEqual(["top", "middle", "bottom"]);
				expect(rendered.viewports.at(-1)!.firstRow + entry.rows).toBe(rendered.panelLines);
			}
		}
	});

	it("shows the full timeout receipt instead of the compact summary for a final result", async () => {
		const rendered = await renderSubagentCompactPanelShowcase({
			stateId: "compact-final-timeout",
			columns: 120,
			rows: 36,
			renderMode: "ascii-no-color",
		});
		const all = rendered.viewports.map(viewport => viewport.terminalText).join("");
		expect(all).toContain("still running after the await timeout");
		expect(all).not.toContain("to list each");
	});
});
