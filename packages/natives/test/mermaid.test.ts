import { describe, expect, it } from "bun:test";
import { renderMermaidAscii } from "../native/index.js";

interface GoldenCase {
	id: string;
	source: string;
	options?: Parameters<typeof renderMermaidAscii>[1];
	output?: string;
	error?: string;
}

interface AcceptedDivergence {
	caseId: string;
	reason: string;
}

const { cases } = (await Bun.file(new URL("./fixtures/goldens/mermaid/typescript.json", import.meta.url)).json()) as {
	cases: GoldenCase[];
};
const { divergences } = (await Bun.file(
	new URL("./fixtures/goldens/mermaid/accepted-divergences.json", import.meta.url),
).json()) as { divergences: AcceptedDivergence[] };

describe("native Mermaid renderer", () => {
	it("matches the pre-port corpus or an explicitly accepted divergence", () => {
		const acceptedById = new Map(divergences.map(divergence => [divergence.caseId, divergence]));
		expect(acceptedById.size).toBe(divergences.length);
		for (const divergence of divergences) {
			expect(divergence.reason.trim(), `empty reason for ${divergence.caseId}`).not.toBe("");
		}

		const observedDivergences: string[] = [];
		for (const fixture of cases) {
			let actual: { output: string } | { error: string };
			try {
				actual = { output: renderMermaidAscii(fixture.source, fixture.options) };
			} catch (error) {
				actual = { error: error instanceof Error ? error.message : String(error) };
			}

			const expected = fixture.output === undefined ? { error: fixture.error } : { output: fixture.output };
			if (JSON.stringify(actual) === JSON.stringify(expected)) continue;

			observedDivergences.push(fixture.id);
			expect(acceptedById.get(fixture.id), `unlisted Mermaid divergence: ${fixture.id}`).toBeDefined();
		}

		expect(observedDivergences.sort()).toEqual([...acceptedById.keys()].sort());
	});

	it("renders a Unicode flowchart without terminal color escapes by default", () => {
		const output = renderMermaidAscii("flowchart TD\nA[Start] --> B[Stop]");
		expect(output).toContain("Start");
		expect(output).toContain("Stop");
		expect(output).not.toContain("\u001b[");
	});
});
