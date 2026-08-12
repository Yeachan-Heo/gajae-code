import { describe, expect, it } from "bun:test";
import { homedir } from "node:os";
import { visibleWidth } from "@gajae-code/tui";
import {
	EFFECTIVE_CONFIGURATION_SOURCE_RANKS,
	type EffectiveConfigurationProvenanceEntry,
} from "../src/config/effective-configuration";
import {
	createEffectiveConfigurationScopeSelectionView,
	renderEffectiveConfigurationScopeSelectionLines,
} from "../src/config/effective-configuration-view";

const HOME = homedir().replaceAll("\\", "/");
function provenance(
	sourceId: string,
	rank: number,
	ownership: EffectiveConfigurationProvenanceEntry["ownership"],
	safePath: string,
): EffectiveConfigurationProvenanceEntry {
	return {
		sourceId,
		canonicalKey: "model.default",
		rank,
		ownership,
		safePath,
		physicalIdentity: { kind: "known", identity: sourceId },
		revision: `rev-${sourceId}`,
		digest: `digest-${sourceId}`,
		aliases: [],
		presence: "present",
		stability: "stable",
		eligibility: "eligible",
		physicalDeduplication: { identity: sourceId, memberCount: 1, collapsed: false },
	};
}

describe("scoped configuration scope-selection adapter", () => {
	it("always exposes the four semantic choices and disables project without a repo root", () => {
		const view = createEffectiveConfigurationScopeSelectionView({
			repoRoot: null,
			targetPaths: { user: `${HOME}/.config/gajae/config.yml` },
			selectedScope: "project",
		});
		const labels = view.scopes.map(scope => scope.label);

		expect(labels).toEqual(["This session", "This project", "User default", "Managed"]);
		expect(view.scopes.find(scope => scope.id === "project")).toMatchObject({
			available: false,
			writable: false,
			reason: "Project scope unavailable: no repository root.",
		});
		expect(view.scopes.find(scope => scope.id === "managed")).toMatchObject({ locked: true, writable: false });
		expect(view.selectedScope).toBeNull();
	});

	it("marks third-party discovered source records read-only while retaining exact shortened paths", () => {
		const repoRoot = `${HOME}/projects/gajae-code`;
		const projectPath = `${repoRoot}/.gjc/config.yml`;
		const userPath = `${HOME}/.config/gajae/config.yml`;
		const vendorPath = `${repoRoot}/vendor/third-party/config.yml`;
		const view = createEffectiveConfigurationScopeSelectionView({
			repoRoot,
			targetPaths: {
				project: projectPath,
				user: userPath,
			},
			sources: [
				provenance(
					"third-party-project",
					EFFECTIVE_CONFIGURATION_SOURCE_RANKS.discoveredProject,
					"discovered",
					vendorPath,
				),
				provenance("owned-project", EFFECTIVE_CONFIGURATION_SOURCE_RANKS.ownedNativeProject, "owned", projectPath),
			],
		});
		const discovered = view.sources.find(source => source.sourceId === "third-party-project");
		const project = view.scopes.find(scope => scope.id === "project");

		expect(discovered).toMatchObject({
			scope: "project",
			writable: false,
			reason: "Discovered source is read-only.",
		});
		expect(project?.targetPath).toBe("~/projects/gajae-code/.gjc/config.yml");
		expect(JSON.stringify(view)).not.toContain(projectPath);
	});

	it("clips CJK and control-bearing labels to terminal-cell width without ANSI", () => {
		const view = createEffectiveConfigurationScopeSelectionView({ repoRoot: "\u001b[31m/Users/例子/项目\u001b[0m" });
		for (const line of renderEffectiveConfigurationScopeSelectionLines(view, 16)) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(16);
			expect(line).not.toMatch(/\x1b|[\u0000-\u001f\u007f]/u);
		}
	});
});
