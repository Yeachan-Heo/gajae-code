import { describe, expect, it } from "bun:test";
import { diffMentalModelContent } from "@gajae-code/coding-agent/hindsight/mental-models";

function legacyDiffMentalModelContent(previous: string | null, current: string, maxLines = 200): string {
	const prev = previous ? previous.split("\n").slice(0, 1_000) : [];
	const curr = current ? current.split("\n").slice(0, 1_000) : [];
	const lcs = legacyLcs(prev, curr);
	const out: string[] = [];
	let i = 0;
	let j = 0;
	let k = 0;
	while (i < prev.length && j < curr.length && k < lcs.length) {
		if (prev[i] === lcs[k] && curr[j] === lcs[k]) {
			out.push(`  ${prev[i]}`);
			i++;
			j++;
			k++;
			continue;
		}
		if (prev[i] !== lcs[k]) {
			out.push(`- ${prev[i]}`);
			i++;
			continue;
		}
		out.push(`+ ${curr[j]}`);
		j++;
	}
	while (i < prev.length) out.push(`- ${prev[i++]}`);
	while (j < curr.length) out.push(`+ ${curr[j++]}`);
	if ((previous ? previous.split("\n").length : 0) > 1_000 || (current ? current.split("\n").length : 0) > 1_000) {
		out.push("… input capped at 1000 lines per side before diff");
	}
	if (out.length > maxLines) {
		const dropped = out.length - maxLines;
		return `${out.slice(0, maxLines).join("\n")}\n… ${dropped} more line${dropped === 1 ? "" : "s"} elided`;
	}
	return out.join("\n");
}

function legacyLcs(a: string[], b: string[]): string[] {
	const table: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
	for (let i = 0; i < a.length; i++) {
		for (let j = 0; j < b.length; j++) {
			table[i + 1]![j + 1] = a[i] === b[j] ? table[i]![j]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
		}
	}
	const out: string[] = [];
	let i = a.length;
	let j = b.length;
	while (i > 0 && j > 0) {
		if (a[i - 1] === b[j - 1]) {
			out.push(a[i - 1]!);
			i--;
			j--;
		} else if (table[i - 1]![j]! >= table[i]![j - 1]!) {
			i--;
		} else {
			j--;
		}
	}
	return out.reverse();
}

const fixtures = [
	{
		name: "current",
		previous: "alpha\nbeta\ngamma",
		current: "alpha\nzeta\ngamma",
	},
	{
		name: "local-edit",
		previous: Array.from({ length: 80 }, (_, i) => `line ${i}`).join("\n"),
		current: Array.from({ length: 80 }, (_, i) =>
			i === 17 ? "line 17 edited" : i === 42 ? "line 42 edited" : `line ${i}`,
		).join("\n"),
	},
	{
		name: "repeated-line",
		previous: ["repeat", "left", "repeat", "middle", "repeat", "tail"].join("\n"),
		current: ["repeat", "right", "repeat", "middle", "repeat", "tail"].join("\n"),
	},
	{
		name: "ambiguous-tie-break",
		previous: ["A", "B", "A"].join("\n"),
		current: ["B", "A", "A"].join("\n"),
	},
	{
		name: "1000x1000",
		previous: Array.from({ length: 1_000 }, (_, i) => `line ${i}`).join("\n"),
		current: Array.from({ length: 1_000 }, (_, i) => (i % 10 === 0 ? `line ${i} edited` : `line ${i}`)).join("\n"),
	},
];

describe("mental-model LCS render parity", () => {
	for (const fixture of fixtures) {
		it(`matches legacy render output for ${fixture.name}`, () => {
			expect(diffMentalModelContent(fixture.previous, fixture.current, 4_000)).toBe(
				legacyDiffMentalModelContent(fixture.previous, fixture.current, 4_000),
			);
		});
	}
});
