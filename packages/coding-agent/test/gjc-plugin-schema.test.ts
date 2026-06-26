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
		for (const key of ["skills", "slash-commands", "commands", "agents"]) {
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

	test("parseManifest rejects unsupported mcp aliases", () => {
		for (const key of ["mcp", "mcpServers"]) {
			expectLoadError(
				() =>
					parseManifest(
						{
							kind: "gajae-code-plugin",
							name: "aliased",
							version: "1.0.0",
							[key]: [],
						},
						`/plugin/${key}/gajae-plugin.json`,
					),
				"unsupported_surface",
			);
		}
	});

	test("parseManifest accepts the six additive surfaces", () => {
		const manifest = parseManifest(
			{
				kind: "gajae-code-plugin",
				name: "six",
				version: "1.0.0",
				subskills: ["subskills/design/SKILL.md"],
				tools: [{ name: "domain_note", path: "tools/domain-note.ts" }],
				hooks: [{ name: "audit", event: "tool_call", target: "read", phase: "before", path: "hooks/a.ts" }],
				mcps: [{ name: "docs", transport: "stdio", command: "bun", args: ["mcp/s.ts"] }],
				system_appendix: [{ name: "policy", path: "prompts/sa.md" }],
				"agent-appendix": [{ agent: "executor", name: "guide", path: "prompts/ea.md" }],
			},
			"/plugin/gajae-plugin.json",
		);
		expect(manifest.tools[0]).toMatchObject({
			name: "domain_note",
			path: "tools/domain-note.ts",
			surface: "always-on",
		});
		expect(manifest.hooks[0]?.event).toBe("tool_call");
		expect(manifest.mcps[0]?.transport).toBe("stdio");
		expect(manifest.systemAppendix[0]?.name).toBe("policy");
		expect(manifest.agentAppendix[0]?.agent).toBe("executor");
	});

	test("parseManifest accepts absent subskills/tools as empty", () => {
		const manifest = parseManifest(
			{ kind: "gajae-code-plugin", name: "empty", version: "1.0.0" },
			"/plugin/gajae-plugin.json",
		);
		expect(manifest.subskills).toEqual([]);
		expect(manifest.tools).toEqual([]);
		expect(manifest.hooks).toEqual([]);
	});

	test("parseManifest normalizes legacy string tool shorthand", () => {
		const manifest = parseManifest(
			{ kind: "gajae-code-plugin", name: "legacy", version: "1.0.0", tools: ["tools/domain-note.ts"] },
			"/plugin/gajae-plugin.json",
		);
		expect(manifest.tools[0]).toMatchObject({
			name: "domain-note",
			path: "tools/domain-note.ts",
			surface: "subskill",
		});
	});

	test("parseManifest rejects malformed known fields", () => {
		expectLoadError(
			() =>
				parseManifest(
					{ kind: "gajae-code-plugin", name: "bad", version: "1.0.0", hooks: {} },
					"/plugin/gajae-plugin.json",
				),
			"invalid_manifest",
		);
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
