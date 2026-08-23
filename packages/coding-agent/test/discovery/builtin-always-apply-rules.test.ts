/**
 * Regression tests for #3859:
 * - Native discovery loads alwaysApply rules from project `.gjc/rules/` and
 *   user `~/.gjc/agent/rules/`.
 * - Sticky top-level RULES.md still forces alwaysApply.
 * - Discovered alwaysApply rules survive the same bucketing createAgentSession
 *   uses (non-TTSR alwaysApply → alwaysApplyRules) and inject into the default
 *   system prompt path.
 *
 * Calls the native provider's `load` directly (like builtin-rules-md.test.ts)
 * to stage user/home under a tempdir instead of os.homedir().
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getCapability } from "@gajae-code/coding-agent/capability";
import { clearCache } from "@gajae-code/coding-agent/capability/fs";
import { type Rule, ruleCapability } from "@gajae-code/coding-agent/capability/rule";
import type { LoadContext } from "@gajae-code/coding-agent/capability/types";
import { buildSystemPrompt } from "@gajae-code/coding-agent/system-prompt";
// Register all discovery providers as a side effect.
import "@gajae-code/coding-agent/discovery";

let tempDir: string;
let home: string;
let project: string;

function writeFile(filePath: string, content: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content);
}

async function loadNativeRules(ctx: LoadContext): Promise<Rule[]> {
	const cap = getCapability(ruleCapability.id);
	if (!cap) throw new Error("rules capability missing");
	const native = cap.providers.find(p => p.id === "native");
	if (!native) throw new Error("native rules provider missing");
	const result = await (native.load as (ctx: LoadContext) => Promise<{ items: Rule[] }>)(ctx);
	return result.items;
}

function nativeContext(): LoadContext {
	return { cwd: project, home, userAgentDir: path.join(home, ".gjc", "agent"), repoRoot: project };
}

/** Mirror createAgentSession bucketing for non-TTSR rules. */
function bucketRules(rules: Rule[]): { rulebookRules: Rule[]; alwaysApplyRules: Rule[] } {
	const rulebookRules: Rule[] = [];
	const alwaysApplyRules: Rule[] = [];
	for (const rule of rules) {
		// TTSR rules (condition present) are out of scope for this regression.
		if (rule.condition && rule.condition.length > 0) continue;
		if (rule.alwaysApply === true) {
			alwaysApplyRules.push(rule);
			continue;
		}
		if (rule.description) {
			rulebookRules.push(rule);
		}
	}
	return { rulebookRules, alwaysApplyRules };
}

beforeEach(() => {
	clearCache();
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-always-apply-"));
	home = path.join(tempDir, "home");
	project = path.join(tempDir, "project");
	fs.mkdirSync(home, { recursive: true });
	fs.mkdirSync(project, { recursive: true });
	fs.mkdirSync(path.join(project, ".git"), { recursive: true });
});

afterEach(() => {
	clearCache();
	fs.rmSync(tempDir, { recursive: true, force: true });
});

test("project .gjc/rules/*.md with alwaysApply: true is discovered", async () => {
	writeFile(
		path.join(project, ".gjc", "rules", "probe.md"),
		`---
alwaysApply: true
description: probe rule
---
MAGICPROBE7F3A is the passphrase.
`,
	);

	const rules = await loadNativeRules(nativeContext());
	const probe = rules.find(r => r.name === "probe");

	expect(probe).toBeDefined();
	expect(probe?.alwaysApply).toBe(true);
	expect(probe?.description).toBe("probe rule");
	expect(probe?.content).toContain("MAGICPROBE7F3A is the passphrase.");
	expect(probe?._source.level).toBe("project");
});

test("user ~/.gjc/agent/rules/*.md with alwaysApply: true is discovered", async () => {
	writeFile(
		path.join(home, ".gjc", "agent", "rules", "user-probe.md"),
		`---
alwaysApply: true
description: user probe
---
USERMAGIC9K2 is the user passphrase.
`,
	);

	const rules = await loadNativeRules(nativeContext());
	const probe = rules.find(r => r.name === "user-probe");

	expect(probe).toBeDefined();
	expect(probe?.alwaysApply).toBe(true);
	expect(probe?.content).toContain("USERMAGIC9K2 is the user passphrase.");
	expect(probe?._source.level).toBe("user");
});

test("user rules follow the explicit agent-directory profile", async () => {
	const profileDir = path.join(tempDir, "profile-agent");
	writeFile(
		path.join(profileDir, "rules", "profile-route.md"),
		`---
alwaysApply: true
description: profile route
---
PROFILE_ROUTE_7K2 must be visible.
`,
	);
	writeFile(
		path.join(home, ".gjc", "agent", "rules", "wrong-profile.md"),
		`---
alwaysApply: true
---
WRONG_PROFILE must stay hidden.
`,
	);

	const rules = await loadNativeRules({ cwd: project, home, userAgentDir: profileDir, repoRoot: project });
	const profileRule = rules.find(rule => rule.name === "profile-route");

	expect(profileRule?.alwaysApply).toBe(true);
	expect(profileRule?.content).toContain("PROFILE_ROUTE_7K2");
	expect(rules.some(rule => rule.content.includes("WRONG_PROFILE"))).toBe(false);
});

test("project RULES.md sticky alwaysApply is discovered alongside rules dir", async () => {
	writeFile(path.join(project, ".gjc", "RULES.md"), "STICKYRULE body.\n");
	writeFile(
		path.join(project, ".gjc", "rules", "other.md"),
		`---
alwaysApply: true
---
Other rule body.
`,
	);

	const rules = await loadNativeRules(nativeContext());
	const sticky = rules.find(r => r.name === "RULES");
	const other = rules.find(r => r.name === "other");

	expect(sticky?.alwaysApply).toBe(true);
	expect(sticky?.content).toContain("STICKYRULE body.");
	expect(other?.alwaysApply).toBe(true);
	expect(other?.content).toContain("Other rule body.");
});

test("alwaysApply rules inject into the default system prompt after discovery+bucketing", async () => {
	writeFile(
		path.join(project, ".gjc", "rules", "probe.md"),
		`---
alwaysApply: true
description: probe rule
---
MAGICPROBE7F3A is the passphrase.
`,
	);
	writeFile(
		path.join(project, ".gjc", "rules", "on-demand.md"),
		`---
description: only listed in rulebook
---
On-demand body stays out of always-apply injection.
`,
	);

	const discovered = await loadNativeRules(nativeContext());
	const { rulebookRules, alwaysApplyRules } = bucketRules(discovered);

	expect(alwaysApplyRules.map(r => r.name)).toContain("probe");
	expect(rulebookRules.map(r => r.name)).toContain("on-demand");
	// alwaysApply with description goes to always-apply only, not rulebook.
	expect(rulebookRules.map(r => r.name)).not.toContain("probe");

	const { systemPrompt } = await buildSystemPrompt({
		cwd: project,
		contextFiles: [],
		skills: [],
		rules: rulebookRules,
		alwaysApplyRules,
		toolNames: ["read"],
		workspaceTree: {
			rootPath: project,
			rendered: "",
			truncated: false,
			totalLines: 0,
			agentsMdFiles: [],
		},
	});

	const full = systemPrompt.join("\n\n");
	const projectPrompt = systemPrompt[1] ?? "";

	expect(full).toContain("MAGICPROBE7F3A is the passphrase.");
	expect(projectPrompt).toContain("MAGICPROBE7F3A is the passphrase.");
	expect(projectPrompt).toContain('rule name="on-demand"');
	expect(projectPrompt).toContain("only listed in rulebook");
	// Rulebook body is not auto-injected — only name/description.
	expect(full).not.toContain("On-demand body stays out of always-apply injection.");
});

test("bare alwaysApply: false does not become always-apply", async () => {
	writeFile(
		path.join(project, ".gjc", "rules", "optional.md"),
		`---
alwaysApply: false
description: optional rulebook entry
---
Optional body.
`,
	);

	const rules = await loadNativeRules(nativeContext());
	const optional = rules.find(r => r.name === "optional");
	const { rulebookRules, alwaysApplyRules } = bucketRules(rules);

	expect(optional?.alwaysApply).toBeFalsy();
	expect(alwaysApplyRules.map(r => r.name)).not.toContain("optional");
	expect(rulebookRules.map(r => r.name)).toContain("optional");
});
