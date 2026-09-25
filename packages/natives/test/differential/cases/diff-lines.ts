import * as Diff from "diff";
import { diffLines } from "../../../native/index.js";
import type { DifferentialCase } from "../harness";
import { defineDifferential } from "../harness";

export interface DiffLinesInput {
	oldStr: string;
	newStr: string;
}

const inputs: DiffLinesInput[] = [
	{ oldStr: "", newStr: "" },
	{ oldStr: "alpha\n", newStr: "alpha\nbeta\n" },
	{ oldStr: "alpha\r\nbeta\r\n", newStr: "alpha\nbeta\n" },
	{ oldStr: "\uFEFFalpha\n", newStr: "alpha\n" },
	{ oldStr: "wide 界\ncombining e\u0301\n", newStr: "wide 界\ncombining é\n" },
	{ oldStr: "same\nold\n", newStr: "same\nnew\n" },
];

export const diffLinesCases: DifferentialCase<DiffLinesInput>[] = inputs.map((input, index) => ({
	id: `case-${String(index + 1).padStart(2, "0")}`,
	input,
}));

type DiffLinesOutput = Array<{ added: boolean; removed: boolean; value: string }>;

export const diffLinesDifferential = defineDifferential<DiffLinesInput, DiffLinesOutput>({
	module: "diff-lines",
	cases: diffLinesCases,
	reference: input =>
		Diff.diffLines(input.oldStr, input.newStr).map(part => ({
			added: part.added ?? false,
			removed: part.removed ?? false,
			value: part.value,
		})),
	native: input => diffLines(input.oldStr, input.newStr),
});
