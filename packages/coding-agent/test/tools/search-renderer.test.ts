import { describe, expect, it } from "bun:test";
import { sanitizeText } from "@gajae-code/utils";
import { getThemeByName } from "../../src/modes/theme/theme";
import { searchToolRenderer } from "../../src/tools/search";

describe("searchToolRenderer", () => {
	it("keeps summary and truncation rows inside the collapsed line budget", async () => {
		const theme = await getThemeByName("red-claw");
		expect(theme).toBeDefined();
		const uiTheme = theme!;

		const result = {
			content: [
				{
					type: "text",
					text: ["alpha:1", "alpha:2", "", "beta:1", "beta:2", "", "gamma:1", "gamma:2"].join("\n"),
				},
			],
			details: {
				matchCount: 6,
				fileCount: 3,
				fileLimitReached: 3,
			},
		};

		const collapsed = searchToolRenderer.renderResult(
			result as never,
			{ expanded: false, isPartial: false },
			uiTheme,
			{
				pattern: "needle",
			},
		);
		const renderedLines = sanitizeText(collapsed.render(200).join("\n")).split("\n");
		const bodyLines = renderedLines.slice(1);

		expect(bodyLines).toHaveLength(6);
		expect(bodyLines.at(-1)).toContain("truncated: first 3 files (skip to paginate)");
		expect(bodyLines.some(line => line.includes("1 more match"))).toBe(true);
		expect(bodyLines.some(line => line.includes("gamma:1"))).toBe(false);
	});
});
