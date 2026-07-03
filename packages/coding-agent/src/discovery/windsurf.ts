/**
 * Windsurf (Codeium) Provider
 *
 * Loads configuration from Windsurf's config locations:
 * - User: ~/.codeium/windsurf
 * - Project: .windsurf
 *
 * Supports:
 * - Rules from .windsurf/rules/*.md and ~/.codeium/windsurf/memories/global_rules.md
 * - Legacy .windsurfrules file
 *
 * MCP servers are intentionally NOT inherited live from Windsurf config: GJC
 * owns MCP runtime execution. Copy definitions into GJC's own mcp.json instead.
 */

import { registerProvider } from "../capability";
import { readFile } from "../capability/fs";
import { type Rule, ruleCapability } from "../capability/rule";
import type { LoadContext, LoadResult } from "../capability/types";
import { buildRuleFromMarkdown, createSourceMeta, getProjectPath, getUserPath, loadFilesFromDir } from "./helpers";

const PROVIDER_ID = "windsurf";
const DISPLAY_NAME = "Windsurf";
const PRIORITY = 50;

// =============================================================================
// Rules
// =============================================================================

async function loadRules(ctx: LoadContext): Promise<LoadResult<Rule>> {
	const items: Rule[] = [];
	const warnings: string[] = [];

	// User-level: ~/.codeium/windsurf/memories/global_rules.md
	const userPath = getUserPath(ctx, "windsurf", "memories/global_rules.md");
	if (userPath) {
		const content = await readFile(userPath);
		if (content) {
			const source = createSourceMeta(PROVIDER_ID, userPath, "user");
			items.push(buildRuleFromMarkdown("global_rules.md", content, userPath, source, { ruleName: "global_rules" }));
		}
	}

	// Project-level: .windsurf/rules/*.md
	const projectRulesDir = getProjectPath(ctx, "windsurf", "rules");
	if (projectRulesDir) {
		const result = await loadFilesFromDir<Rule>(ctx, projectRulesDir, PROVIDER_ID, "project", {
			extensions: ["md"],
			transform: (name, content, path, source) =>
				buildRuleFromMarkdown(name, content, path, source, { stripNamePattern: /\.md$/ }),
		});
		items.push(...result.items);
		if (result.warnings) warnings.push(...result.warnings);
	}

	return { items, warnings };
}

// =============================================================================
// Provider Registration
// =============================================================================

registerProvider<Rule>(ruleCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load rules from Windsurf (.windsurf/rules/*.md, memories/global_rules.md, .windsurfrules)",
	priority: PRIORITY,
	load: loadRules,
});
