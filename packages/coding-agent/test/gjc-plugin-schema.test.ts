import { describe, expect, test } from "bun:test";
import {
	GjcPluginLoadError,
	type GjcPluginLoadErrorCode,
	parseManifest,
	parseSubskillFrontmatter,
} from "../src/extensibility/gjc-plugins";

function expectLoadError(fn: () => unknown, code: GjcPluginLoadErrorCode): void {
	try {
		fn();
	} catch (error) {
		expect(error).toBeInstanceOf(GjcPluginLoadError);
		expect((error as GjcPluginLoadError).code).toBe(code);
		return;
	}
	throw new Error(`Expected ${code} load error`);
}

describe("GJC plugin schema", () => {
	test("parseManifest rejects forbidden extension surfaces", () => {
		for (const key of ["skills", "slash-commands", "commands", "hooks", "mcp", "mcpServers"]) {
			expectLoadError(
				() =>
					parseManifest(
						{
							kind: "gajae-code-plugin",
							name: "forbidden",
							version: "1.0.0",
							subskills: [],
							tools: [],
							[key]: [],
						},
						`/plugin/${key}/gajae-plugin.json`,
					),
				"forbidden_surface",
			);
		}
	});

	test("parseManifest rejects invalid kind", () => {
		expectLoadError(
			() =>
				parseManifest(
					{ kind: "claude-plugin", name: "wrong", version: "1.0.0", subskills: [], tools: [] },
					"/plugin/gajae-plugin.json",
				),
			"invalid_kind",
		);
	});

	test("parseSubskillFrontmatter rejects missing required fields", () => {
		const valid = {
			name: "design",
			binds_to: "ralplan",
			phase: "planner",
			activation_arg: "design",
			description: "Design guidance",
		};

		for (const field of Object.keys(valid)) {
			const fm = { ...valid } as Record<string, unknown>;
			delete fm[field];
			expectLoadError(
				() => parseSubskillFrontmatter(fm, `/plugin/subskills/${field}/SKILL.md`),
				"invalid_frontmatter",
			);
		}
	});
});
