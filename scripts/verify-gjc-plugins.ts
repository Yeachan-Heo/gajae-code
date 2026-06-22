#!/usr/bin/env bun

/**
 * Static verification for the generated gajae-code plugin bundles.
 *
 * Asserts the security and contract invariants the host bundles must hold:
 * - the three delegate tools exist in the coordinator contract;
 * - generated MCP config uses GJC_COORDINATOR_MCP_WORKDIR_ROOTS (never the
 *   non-existent GJC_COORDINATOR_MCP_ROOTS) and omits GJC_COORDINATOR_MCP_MUTATIONS;
 * - generated command/skill text references the delegate tools;
 * - committed files match the renderer output (no hand drift).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { COORDINATOR_MCP_TOOL_NAMES } from "../packages/coding-agent/src/coordinator/contract";
import { renderPluginFiles } from "./generate-gjc-plugins";

const repoRoot = path.join(import.meta.dir, "..");
const pluginsDir = path.join(repoRoot, "plugins");

interface GateResult {
	name: string;
	ok: boolean;
	detail: string;
}

const results: GateResult[] = [];
function gate(name: string, ok: boolean, detail: string): void {
	results.push({ name, ok, detail });
}

const delegateTools = COORDINATOR_MCP_TOOL_NAMES.filter(name => name.startsWith("gjc_delegate_"));
gate(
	"delegate tools in contract",
	delegateTools.length === 3 &&
		["gjc_delegate_plan", "gjc_delegate_execute", "gjc_delegate_team"].every(t => delegateTools.includes(t)),
	`found: ${delegateTools.join(", ") || "none"}`,
);

const files = renderPluginFiles();

// Drift: committed bytes must equal renderer output.
const driftProblems: string[] = [];
for (const [rel, content] of files) {
	const target = path.join(pluginsDir, rel);
	let actual: string | null = null;
	try {
		actual = fs.readFileSync(target, "utf8");
	} catch {
		actual = null;
	}
	if (actual === null) driftProblems.push(`missing plugins/${rel}`);
	else if (actual !== content) driftProblems.push(`drift plugins/${rel}`);
}
gate("committed bundle matches renderer", driftProblems.length === 0, driftProblems.join("; ") || "in sync");

// Fail-closed env invariants across every generated .mcp.json.
const mcpFiles = [...files.keys()].filter(rel => rel.endsWith(".mcp.json"));
let mcpChecked = 0;
let workdirRootsOk = true;
let noBadRoots = true;
let noMutations = true;
for (const rel of mcpFiles) {
	const text = files.get(rel) ?? "";
	mcpChecked++;
	if (!text.includes("GJC_COORDINATOR_MCP_WORKDIR_ROOTS")) workdirRootsOk = false;
	if (text.includes("GJC_COORDINATOR_MCP_ROOTS\"") || /GJC_COORDINATOR_MCP_ROOTS[^_]/.test(text)) noBadRoots = false;
	if (text.includes("GJC_COORDINATOR_MCP_MUTATIONS")) noMutations = false;
}
gate("at least one generated MCP config", mcpChecked > 0, `mcp files: ${mcpChecked}`);
gate("MCP config uses WORKDIR_ROOTS", workdirRootsOk, "all generated MCP configs set the allowlist var");
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
	const status = result.ok ? "PASS" : "FAIL";
	process.stdout.write(`[${status}] ${result.name} — ${result.detail}\n`);
	if (!result.ok) failures++;
}
if (failures > 0) {
	process.stderr.write(`\n${failures} plugin gate(s) failed.\n`);
	process.exit(1);
}
process.stdout.write(`\nAll ${results.length} plugin gates passed.\n`);
