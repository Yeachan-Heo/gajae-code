import { beforeAll, describe, expect, it } from "bun:test";
import { InspectorPanel } from "../../../src/modes/components/extensions/inspector-panel";
import type { Extension } from "../../../src/modes/components/extensions/types";
import * as themeModule from "../../../src/modes/theme/theme";

const previews: ReadonlyArray<{
	kind: Extension["kind"];
	heading: string;
	raw: unknown;
	trigger?: string;
}> = [
	{ kind: "context-file", heading: "Preview:", raw: { content: "context" } },
	{ kind: "tool", heading: "Arguments:", raw: { parameters: { properties: {} } } },
	{ kind: "skill", heading: "Instruction:", raw: { prompt: "instruction" } },
	{ kind: "mcp", heading: "Connection:", raw: { transport: "stdio" } },
	{ kind: "slash-command", heading: "Trigger:", raw: null, trigger: "/test" },
];

describe("InspectorPanel narrow widths", () => {
	beforeAll(async () => {
		await themeModule.initTheme(false, undefined, undefined, "red-claw", "blue-crab");
	});

	it("renders every preview separator when the right pane is narrower than its padding", () => {
		for (const preview of previews) {
			const extension: Extension = {
				id: `${preview.kind}:test`,
				kind: preview.kind,
				name: "test",
				displayName: "Test",
				path: "/tmp/test",
				source: { provider: "native", providerName: "Native", level: "native" },
				state: "active",
				raw: preview.raw,
				...(preview.trigger ? { trigger: preview.trigger } : {}),
			};
			const panel = new InspectorPanel();
			panel.setExtension(extension);

			for (const width of [0, 1]) {
				const lines = panel.render(width).map(line => Bun.stripANSI(line));
				const headingIndex = lines.indexOf(preview.heading);
				expect(headingIndex).toBeGreaterThanOrEqual(0);
				expect(lines[headingIndex + 1]).toBe("");
			}
		}
	});
});
