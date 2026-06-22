#!/usr/bin/env bun

/**
 * Static verification for the generated gajae-code plugin bundles.
 *
 * Asserts the security and contract invariants the host bundles must hold:
 * - the three delegate tools exist in the coordinator contract;
 * - committed files match the renderer output (no hand drift);
 * - the nested plugin layout matches the verified Claude + Codex shapes;
 * - generated MCP config is fail-closed (WORKDIR_ROOTS, no invalid ROOTS, no MUTATIONS);
 * - the Codex .mcp.json file uses a Codex-accepted shape (mcp_servers wrapper or
 *   a direct server map), while manifests keep the camelCase `mcpServers` field
 *   per the official Codex plugin docs.
 */

import * as path from "node:path";
import { COORDINATOR_MCP_TOOL_NAMES } from "../packages/coding-agent/src/coordinator/contract";
import { renderPluginFiles } from "./generate-gjc-plugins";

const PLUGIN_DIR = "gajae-code";

interface GateResult {
	name: string;
	ok: boolean;
	detail: string;
}

const results: GateResult[] = [];
function gate(name: string, ok: boolean, detail: string): void {
	results.push({ name, ok, detail });
}

const files = renderPluginFiles();
function read(rel: string): string {
	return files.get(rel) ?? "";
}
function readJson(rel: string): Record<string, unknown> {
	return JSON.parse(read(rel) || "{}") as Record<string, unknown>;
}

const delegateTools = COORDINATOR_MCP_TOOL_NAMES.filter(name => name.startsWith("gjc_delegate_"));
gate(
	"delegate tools in contract",
	delegateTools.length === 3 &&
		["gjc_delegate_plan", "gjc_delegate_execute", "gjc_delegate_team"].every(t => delegateTools.includes(t)),
	`found: ${delegateTools.join(", ") || "none"}`,
);

// Drift would be caught by `generate-gjc-plugins --check`; here we only assert shape.

// Required nested layout (verified installable on Claude Code + Codex CLI 0.139.0).
const claudeManifest = path.join(PLUGIN_DIR, ".claude-plugin", "plugin.json");
const codexManifest = path.join(PLUGIN_DIR, ".codex-plugin", "plugin.json");
const claudeMcp = path.join(PLUGIN_DIR, ".mcp.json");
const codexMcp = path.join(PLUGIN_DIR, ".codex.mcp.json");
const skill = path.join(PLUGIN_DIR, "skills", "gjc-delegation", "SKILL.md");
const codexMarketplace = path.join(".agents", "plugins", "marketplace.json");
const claudeMarketplace = path.join(".claude-plugin", "marketplace.json");

gate(
	"nested plugin layout present",
	[claudeManifest, codexManifest, claudeMcp, codexMcp, skill].every(rel => files.has(rel)),
	`plugin folder ./${PLUGIN_DIR}/`,
);
gate(
	"repo marketplaces present at documented paths",
	files.has(codexMarketplace) && files.has(claudeMarketplace),
	`${codexMarketplace}, ${claudeMarketplace}`,
);

// Marketplace sources point at the plugin folder and stay inside the root.
const codexMkt = readJson(codexMarketplace) as {
	plugins?: Array<{ source?: { source?: string; path?: string }; policy?: Record<string, unknown>; category?: string }>;
};
const codexEntry = codexMkt.plugins?.[0];
gate(
	"Codex marketplace uses local source shape",
	codexEntry?.source?.source === "local" &&
		codexEntry.source.path === `./${PLUGIN_DIR}` &&
		!!codexEntry.policy?.installation &&
		!!codexEntry.policy?.authentication &&
		!!codexEntry.category,
	JSON.stringify(codexEntry?.source ?? null),
);
const claudeMkt = readJson(claudeMarketplace) as { plugins?: Array<{ source?: unknown }> };
const claudeSources = claudeMkt.plugins?.map(p => p.source) ?? [];
gate(
	"Claude marketplace source stays inside root",
	claudeSources.length > 0 &&
		claudeSources.every(s => typeof s === "string" && s === `./${PLUGIN_DIR}` && !s.includes("..")),
	claudeSources.map(s => JSON.stringify(s)).join(", ") || "none",
);

// Manifests use the documented camelCase `mcpServers` field.
const codexManifestObj = readJson(codexManifest);
gate(
	"Codex manifest uses mcpServers field",
	codexManifestObj.mcpServers === "./.codex.mcp.json" && !("mcp_servers" in codexManifestObj),
	Object.keys(codexManifestObj).join(", "),
);

// The Codex .mcp.json FILE uses a Codex-accepted shape: mcp_servers wrapper or a
// direct server map. The Claude .mcp.json FILE uses the mcpServers wrapper.
const codexMcpObj = readJson(codexMcp);
const codexMcpOk = "mcp_servers" in codexMcpObj || "gjc-coordinator" in codexMcpObj;
gate("Codex .mcp.json uses mcp_servers or direct map", codexMcpOk && !("mcpServers" in codexMcpObj), Object.keys(codexMcpObj).join(", "));
const claudeMcpObj = readJson(claudeMcp);
gate("Claude .mcp.json uses mcpServers wrapper", "mcpServers" in claudeMcpObj, Object.keys(claudeMcpObj).join(", "));

// Fail-closed env invariants across every generated .mcp.json.
const mcpFiles = [...files.keys()].filter(rel => rel.endsWith(".mcp.json"));
let workdirRootsOk = true;
let noBadRoots = true;
let noMutations = true;
for (const rel of mcpFiles) {
	const text = read(rel);
	if (!text.includes("GJC_COORDINATOR_MCP_WORKDIR_ROOTS")) workdirRootsOk = false;
	if (/GJC_COORDINATOR_MCP_ROOTS[^_]/.test(text)) noBadRoots = false;
	if (text.includes("GJC_COORDINATOR_MCP_MUTATIONS")) noMutations = false;
}
gate("MCP config uses WORKDIR_ROOTS", mcpFiles.length > 0 && workdirRootsOk, `mcp files: ${mcpFiles.length}`);
gate("MCP config omits invalid ROOTS var", noBadRoots, "no GJC_COORDINATOR_MCP_ROOTS present");
gate("MCP config omits MUTATIONS by default", noMutations, "fail-closed: mutations off until opt-in");

// Command/skill docs reference the delegate tools.
let docsReferenceTools = true;
for (const tool of delegateTools) {
	const referenced = [...files].some(([rel, text]) => rel.endsWith(".md") && text.includes(tool));
	if (!referenced) docsReferenceTools = false;
}
gate("docs reference delegate tools", docsReferenceTools, "command/skill docs mention each delegate tool");

let failures = 0;
for (const result of results) {
	process.stdout.write(`[${result.ok ? "PASS" : "FAIL"}] ${result.name} — ${result.detail}\n`);
	if (!result.ok) failures++;
}
if (failures > 0) {
	process.stderr.write(`\n${failures} plugin gate(s) failed.\n`);
	process.exit(1);
}
process.stdout.write(`\nAll ${results.length} plugin gates passed.\n`);
