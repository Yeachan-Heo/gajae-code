import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { recordDiagnosticArtifactDigest } from "../scripts/diagnostic-artifact-manifest";
import type { BuildSidecar } from "../scripts/embed-guard";
import {
	buildCandidateList,
	filterCandidatesByVariant,
	filterStaleLocalCandidates,
	parseEmbedVariants,
} from "../scripts/embed-native";

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

	it("selects only the rebuilt variant for implicit embedding after a version bump", async () => {
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-embed-stale-variant-"));
		try {
			const nativeDir = path.join(workspace, "native");
			const packageJsonPath = path.join(workspace, "package.json");
			const modernFilename = "pi_natives.linux-x64-modern.node";
			const baselineFilename = "pi_natives.linux-x64-baseline.node";
			const modernPath = path.join(nativeDir, modernFilename);
			const baselinePath = path.join(nativeDir, baselineFilename);
			await fs.mkdir(nativeDir, { recursive: true });
			await Bun.write(packageJsonPath, JSON.stringify({ version: "1.0.0" }));
			await Bun.write(modernPath, "modern-v1");
			await Bun.write(baselinePath, "baseline-v1");
			await Bun.write(`${modernPath}.build.json`, JSON.stringify({ profile: "local", version: "1.0.0" }));
			await Bun.write(`${baselinePath}.build.json`, JSON.stringify({ profile: "local", version: "1.0.0" }));
			await recordDiagnosticArtifactDigest({
				addonPath: modernPath,
				nativeDir,
				packageJsonPath,
				profile: "local",
			});

			await Bun.write(packageJsonPath, JSON.stringify({ version: "2.0.0" }));
			await Bun.write(modernPath, "modern-v2");
			await Bun.write(`${modernPath}.build.json`, JSON.stringify({ profile: "local", version: "2.0.0" }));
			await recordDiagnosticArtifactDigest({
				addonPath: modernPath,
				nativeDir,
				packageJsonPath,
				profile: "local",
			});

			const sidecars = new Map<string, BuildSidecar | null>();
			sidecars.set(modernFilename, (await Bun.file(`${modernPath}.build.json`).json()) as BuildSidecar);
			sidecars.set(baselineFilename, (await Bun.file(`${baselinePath}.build.json`).json()) as BuildSidecar);
			const candidates = buildCandidateList("x64", "linux-x64");
			const [modernCandidate, baselineCandidate] = candidates;
			if (!modernCandidate || !baselineCandidate) throw new Error("expected x64 variant candidates");
			expect(filterStaleLocalCandidates(candidates, sidecars, "2.0.0", null)).toEqual([modernCandidate]);
			expect(() =>
				filterStaleLocalCandidates([baselineCandidate], sidecars, "2.0.0", new Set(["baseline"])),
			).toThrow("pi_natives.linux-x64-baseline.node is a local build for @gajae-code/natives@1.0.0");
			const manifest = (await Bun.file(path.join(nativeDir, "diagnostic-artifact.local.json")).json()) as {
				artifacts: Record<string, string>;
			};
			expect(Object.keys(manifest.artifacts)).toEqual([modernFilename]);
		} finally {
			await fs.rm(workspace, { recursive: true, force: true });
		}
	});
});
