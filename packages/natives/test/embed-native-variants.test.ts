import { describe, expect, it } from "bun:test";

import { buildCandidateList, filterCandidatesByVariant, parseEmbedVariants } from "../scripts/embed-native";

describe("embed native variant selection", () => {
	it("parses valid EMBED_VARIANTS values", () => {
		expect(parseEmbedVariants("baseline")).toEqual(new Set(["baseline"]));
		expect(parseEmbedVariants("modern, default")).toEqual(new Set(["modern", "default"]));
		expect(parseEmbedVariants(undefined)).toBeNull();
	});

	it("rejects unknown EMBED_VARIANTS values", () => {
		expect(() => parseEmbedVariants("baseline,garbage")).toThrow(
			/Invalid EMBED_VARIANTS value\(s\): garbage.*modern, baseline, default/,
		);
	});

	it("filters x64 candidates to baseline only when requested", () => {
		const candidates = buildCandidateList("x64", "linux-x64");
		const filtered = filterCandidatesByVariant(candidates, parseEmbedVariants("baseline"), "linux-x64");

		expect(filtered).toEqual([{ variant: "baseline", filename: "pi_natives.linux-x64-baseline.node" }]);
	});

	it("keeps both x64 candidates when EMBED_VARIANTS is unset", () => {
		const candidates = buildCandidateList("x64", "linux-x64");
		const filtered = filterCandidatesByVariant(candidates, parseEmbedVariants(undefined), "linux-x64");

		expect(filtered).toEqual([
			{ variant: "modern", filename: "pi_natives.linux-x64-modern.node" },
			{ variant: "baseline", filename: "pi_natives.linux-x64-baseline.node" },
		]);
	});

	it("fails when filtering selects no target candidates", () => {
		const candidates = buildCandidateList("arm64", "darwin-arm64");

		expect(() => filterCandidatesByVariant(candidates, parseEmbedVariants("baseline"), "darwin-arm64")).toThrow(
			/selected no candidates for darwin-arm64/,
		);
	});
});
