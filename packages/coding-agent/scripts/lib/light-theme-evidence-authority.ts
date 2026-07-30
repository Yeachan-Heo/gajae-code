export const LIGHT_THEME_EVIDENCE_CANONICAL_OUTPUT = ".gjc/qa/gjc-light-theme-compliance/current";
export const LIGHT_THEME_EVIDENCE_CAPTURE_TOOL_VERSION = "gjc-light-theme-compliance-v3";
export const LIGHT_THEME_EVIDENCE_CANONICAL_COMMAND = `bun packages/coding-agent/scripts/capture-light-theme-compliance-showcase.ts --output ${LIGHT_THEME_EVIDENCE_CANONICAL_OUTPUT}`;
export const LIGHT_THEME_EVIDENCE_REVIEW_REQUIREMENTS = [
	"Recompute every leaf hash and byte length before visual inspection.",
	"Inspect all 180 entries without sampling, including every consumer-atlas, CJK, overflow, no-color, and 256-color key.",
	"Reject any requested/resolved/key/sentinel mismatch, bad semantic wrap, hidden tail, or unresolved finding.",
] as const;
export const LIGHT_THEME_EVIDENCE_SOURCE_PATHS = [
	".github/workflows/dev-ci.yml",
	"docs/theme.md",
	"docs/ui-design-visual-qa.md",
	"scripts/ci-dev-affected.test.ts",
	"scripts/ci-dev-affected.ts",
	"scripts/verify-gjc-ui-redesign.ts",
	"bun.lock",
	"packages/agent/package.json",
	"packages/agent/src/thinking.ts",
	"packages/ai/package.json",
	"packages/ai/src/model-thinking.ts",
	"packages/coding-agent/CHANGELOG.md",
	"packages/coding-agent/package.json",
	"packages/coding-agent/scripts/capture-light-theme-compliance-showcase.ts",
	"packages/coding-agent/scripts/ci-light-theme-evidence.ts",
	"packages/coding-agent/scripts/lib/light-theme-evidence-authority.ts",
	"packages/coding-agent/scripts/lib/terminal-visual-evidence.ts",
	"packages/coding-agent/src/config/settings-schema.ts",
	"packages/coding-agent/src/config/settings.ts",
	"packages/coding-agent/src/internal-urls/docs-index.generated.ts",
	"packages/coding-agent/src/modes/DESIGN.md",
	"packages/coding-agent/src/modes/jobs-observer.ts",
	"packages/coding-agent/src/modes/shared.ts",
	"packages/coding-agent/src/session/session-manager.ts",
	"packages/coding-agent/src/setup/model-onboarding-guidance.ts",
	"packages/coding-agent/src/tools/json-tree.ts",
	"packages/coding-agent/src/tools/output-meta.ts",
	"packages/coding-agent/src/tools/render-utils.ts",
	"packages/coding-agent/src/tools/renderers.ts",
	"packages/coding-agent/src/utils/lang-from-path.ts",
	"packages/coding-agent/src/utils/session-color.ts",
	"packages/coding-agent/src/utils/sixel.ts",
	"packages/coding-agent/test/capture-light-theme-compliance-showcase.test.ts",
	"packages/coding-agent/test/ci-light-theme-evidence.test.ts",
	"packages/coding-agent/test/fixtures/tui/light-theme-compliance-showcase.ts",
	"packages/coding-agent/test/fixtures/tui/light-theme-consumer-atlas.ts",
	"packages/coding-agent/test/fixtures/tui/notifications-settings-showcase.ts",
	"packages/coding-agent/test/gjc-ui-redesign.test.ts",
	"packages/coding-agent/test/light-theme-compliance.test.ts",
	"packages/coding-agent/test/settings-manager.test.ts",
	"packages/natives/package.json",
	"packages/natives/native/embedded-addon.js",
	"packages/natives/native/index.js",
	"packages/natives/native/loader-state.js",
	"packages/tui/package.json",
	"packages/utils/package.json",
	"crates/pi-natives/Cargo.toml",
	"Cargo.lock",
] as const;

export const LIGHT_THEME_EVIDENCE_SOURCE_TREES = [
	"packages/coding-agent/src/modes/components",
	"packages/coding-agent/src/modes/theme",
	"packages/coding-agent/src/modes/utils",
	"packages/coding-agent/src/tui",
	"packages/tui/src",
	"packages/natives/scripts",
	"packages/utils/src",
	"crates/pi-natives/src",
] as const;

export function isLightThemeEvidenceAuthorityPath(changedPath: string): boolean {
	return (
		(LIGHT_THEME_EVIDENCE_SOURCE_PATHS as readonly string[]).includes(changedPath) ||
		LIGHT_THEME_EVIDENCE_SOURCE_TREES.some(tree => changedPath === tree || changedPath.startsWith(`${tree}/`))
	);
}

export function needsLightThemeEvidence(paths: readonly string[]): boolean {
	return paths.some(isLightThemeEvidenceAuthorityPath);
}
