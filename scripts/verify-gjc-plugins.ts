#!/usr/bin/env bun

/**
 * Static verification for the generated gajae-code plugin bundles.
 *
 * Asserts the security and contract invariants the host bundles must hold:
 * - the three delegate tools exist in the coordinator contract;
 * - committed files exactly match the renderer output, including no unexpected installable files;
 * - the nested plugin layout matches the verified Claude + Codex shapes;
 * - generated MCP config is fail-closed (WORKDIR_ROOTS, no invalid ROOTS, no MUTATIONS);
 * - the Codex .mcp.json file uses a Codex-accepted shape (mcp_servers wrapper or
 *   a direct server map), while manifests keep the camelCase `mcpServers` field
 *   per the official Codex plugin docs.
 * - every generated installable file uses the exact Coordinator MCP command and omits
 *   tmux machine ingress.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { COORDINATOR_MCP_TOOL_NAMES } from "../packages/coding-agent/src/coordinator/contract";
import { findUnexpectedPluginFiles, renderPluginFiles } from "./generate-gjc-plugins";

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

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function coordinatorMcpServer(config: Record<string, unknown>): Record<string, unknown> | undefined {
	const servers = record(config.mcpServers) ?? record(config.mcp_servers) ?? config;
	return record(servers["gjc-coordinator"]);
}

function hasCanonicalCoordinatorMcpCommand(server: Record<string, unknown> | undefined): boolean {
	return (
		server?.command === "gjc" &&
		Array.isArray(server.args) &&
		server.args.length === 2 &&
		server.args[0] === "mcp-serve" &&
		server.args[1] === "coordinator"
	);
}

const delegateTools = COORDINATOR_MCP_TOOL_NAMES.filter(name => name.startsWith("gjc_delegate_"));
const delegateToolSet = new Set<string>(delegateTools);
gate(
	"delegate tools in contract",
	delegateTools.length === 3 &&
		["gjc_delegate_plan", "gjc_delegate_execute", "gjc_delegate_team"].every(tool =>
			delegateToolSet.has(tool),
		),
	`found: ${delegateTools.join(", ") || "none"}`,
);

// The generator's --check enforces byte-for-byte content and the complete file set;
// this verifier independently rejects unexpected on-disk installable files.

// Required nested layout (verified installable on Claude Code + Codex CLI 0.139.0).
const claudeManifest = path.join(PLUGIN_DIR, ".claude-plugin", "plugin.json");
const codexManifest = path.join(PLUGIN_DIR, ".codex-plugin", "plugin.json");
const claudeMcp = path.join(PLUGIN_DIR, ".mcp.json");
const codexMcp = path.join(PLUGIN_DIR, ".codex.mcp.json");
const skill = path.join(PLUGIN_DIR, "skills", "gjc-delegation", "SKILL.md");
const codexMarketplace = path.join(".agents", "plugins", "marketplace.json");
const claudeMarketplace = path.join(".claude-plugin", "marketplace.json");
const unexpectedPluginFiles = findUnexpectedPluginFiles(files);
gate(
	"no unexpected installable plugin files",
	unexpectedPluginFiles.length === 0,
	unexpectedPluginFiles.join(", ") || "none",
);

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
const coordinatorMcpServers = [claudeMcpObj, codexMcpObj].map(coordinatorMcpServer);
gate(
	"coordinator MCP uses the exact shipped command and args",
	coordinatorMcpServers.every(hasCanonicalCoordinatorMcpCommand),
	JSON.stringify(coordinatorMcpServers.map(server => ({ command: server?.command, args: server?.args }))),
);

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

function normalizeShellContinuations(contents: string): string {
	return contents.replace(/\\\r?\n[ \t]*/g, " ");
}

const tmuxMachineIngressOperations = [
	"capture-pane",
	"pipe-pane",
	"send-keys",
	"load-buffer",
	"paste-buffer",
	"set-buffer",
] as const;
const tmuxMachineIngressOperationPattern = new RegExp(`\\b(?:${tmuxMachineIngressOperations.join("|")})\\b`, "g");
const tmuxMachineIngressOperationTest = new RegExp(tmuxMachineIngressOperationPattern.source);
const directMachineTmuxRoutePattern =
	/(?:\btmux\s+watch\b|(?:scripts\/)?gjc-session\/(?:prompt|tail|watch)(?:\.sh)?\b|\bgjc-session\s+(?:prompt|tail|watch)\b|(?:\.\/)?(?:scripts\/)?gjc-session\/create\.sh(?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'|[^\s]+)){3}|\bgjc-session\s+create(?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'|[^\s]+)){3})/g;

// Rendered bundles are text, so normalize statically provable shell/JS values and scan the results
// in addition to direct operation spellings.
type StaticValue = string | string[];

function splitTopLevel(source: string, delimiter: string): string[] {
	const parts: string[] = [];
	let start = 0;
	let depth = 0;
	let quote: "'" | '"' | "`" | null = null;
	for (let index = 0; index < source.length; index++) {
		const char = source[index];
		if (quote) {
			if (char === "\\") {
				index++;
			} else if (char === quote) {
				quote = null;
			}
			continue;
		}
		if (char === "'" || char === '"' || char === "`") {
			quote = char;
		} else if (char === "(" || char === "[" || char === "{") {
			depth++;
		} else if (char === ")" || char === "]" || char === "}") {
			depth--;
		} else if (char === delimiter && depth === 0) {
			parts.push(source.slice(start, index));
			start = index + 1;
		}
	}
	parts.push(source.slice(start));
	return parts;
}

function wrappedBy(source: string, opener: string, closer: string): boolean {
	if (!source.startsWith(opener) || !source.endsWith(closer)) return false;
	let depth = 0;
	let quote: "'" | '"' | "`" | null = null;
	for (let index = 0; index < source.length; index++) {
		const char = source[index];
		if (quote) {
			if (char === "\\") {
				index++;
			} else if (char === quote) {
				quote = null;
			}
			continue;
		}
		if (char === "'" || char === '"' || char === "`") {
			quote = char;
		} else if (char === opener) {
			depth++;
		} else if (char === closer && --depth === 0) {
			return index === source.length - 1;
		}
	}
	return false;
}

function expandShellVariables(source: string, values: ReadonlyMap<string, StaticValue>): string | null {
	let unresolved = false;
	const expanded = source.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (match, braced, bare) => {
		const value = values.get(braced ?? bare);
		if (typeof value !== "string") {
			unresolved = true;
			return match;
		}
		return value;
	});
	return unresolved ? null : expanded;
}

function templateInterpolationEnd(source: string, start: number): number | null {
	let depth = 1;
	let quote: "'" | '"' | "`" | null = null;
	for (let index = start; index < source.length; index++) {
		const char = source[index];
		if (quote) {
			if (char === "\\") {
				index++;
			} else if (char === quote) {
				quote = null;
			}
			continue;
		}
		if (char === "'" || char === '"' || char === "`") {
			quote = char;
		} else if (char === "{") {
			depth++;
		} else if (char === "}" && --depth === 0) {
			return index;
		}
	}
	return null;
}

function evaluateStaticString(expression: string, values: ReadonlyMap<string, StaticValue>, depth = 0): string | null {
	if (depth > 12) return null;
	const source = expression.trim();
	if (!source) return null;
	if (wrappedBy(source, "(", ")")) return evaluateStaticString(source.slice(1, -1), values, depth + 1);

	const concatenated = splitTopLevel(source, "+");
	if (concatenated.length > 1) {
		const parts = concatenated.map(part => evaluateStaticString(part, values, depth + 1));
		return parts.every((part): part is string => part !== null) ? parts.join("") : null;
	}

	const join = source.match(/^(\[[\s\S]*\])\.join\(([\s\S]*)\)$/);
	if (join) {
		const array = evaluateStaticArray(join[1], values, depth + 1);
		const separator = evaluateStaticString(join[2], values, depth + 1);
		return array && separator !== null ? array.join(separator) : null;
	}

	const first = source[0];
	if ((first === "'" || first === '"') && source.at(-1) === first) {
		const literal = source.slice(1, -1).replace(/\\([\\'"$`])/g, "$1");
		return first === "'" ? literal : expandShellVariables(literal, values);
	}
	if (first === "`" && source.at(-1) === "`") {
		let value = "";
		const template = source.slice(1, -1);
		for (let index = 0; index < template.length; index++) {
			if (template[index] !== "$" || template[index + 1] !== "{") {
				value += template[index];
				continue;
			}
			const end = templateInterpolationEnd(template, index + 2);
			if (end === null) return null;
			const interpolation = evaluateStaticString(template.slice(index + 2, end), values, depth + 1);
			if (interpolation === null) return null;
			value += interpolation;
			index = end;
		}
		return value.replace(/\\([\\`$])/g, "$1");
	}

	const shellVariable = source.match(/^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/);
	if (shellVariable) {
		const value = values.get(shellVariable[1]);
		return typeof value === "string" ? value : null;
	}
	const namedValue = values.get(source);
	if (typeof namedValue === "string") return namedValue;
	return /^[A-Za-z0-9_./:-]+$/.test(source) ? source : null;
}

function shellWords(source: string): string[] {
	const words: string[] = [];
	let word = "";
	let quote: "'" | '"' | null = null;
	for (let index = 0; index < source.length; index++) {
		const char = source[index];
		if (quote) {
			word += char;
			if (char === "\\") {
				word += source[++index] ?? "";
			} else if (char === quote) {
				quote = null;
			}
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			word += char;
		} else if (/\s/.test(char)) {
			if (word) words.push(word);
			word = "";
		} else {
			word += char;
		}
	}
	if (word) words.push(word);
	return words;
}

function evaluateStaticArray(expression: string, values: ReadonlyMap<string, StaticValue>, depth = 0): string[] | null {
	if (depth > 12) return null;
	const source = expression.trim();
	const namedValue = values.get(source);
	if (Array.isArray(namedValue)) return namedValue;
	const body = wrappedBy(source, "[", "]")
		? source.slice(1, -1)
		: wrappedBy(source, "(", ")")
			? source.slice(1, -1)
			: null;
	if (body === null) return null;
	const elements = source.startsWith("[") ? splitTopLevel(body, ",") : shellWords(body);
	const valuesByElement = elements.map(element => evaluateStaticString(element, values, depth + 1));
	return valuesByElement.every((value): value is string => value !== null) ? valuesByElement : null;
}

function normalizedStaticValues(contents: string): string[] {
	const values = new Map<string, StaticValue>();
	const normalized: string[] = [];
	const assignmentPattern =
		/(?:^|[;{\n])\s*(?:(?:export|local|readonly)\s+)?(?:(?:const|let|var)\s+)?([A-Za-z_$][A-Za-z0-9_$]*)(?:\s*:[^=;\n]+)?\s*=\s*([^;\n]+)/g;
	for (const match of contents.matchAll(assignmentPattern)) {
		const name = match[1];
		const expression = match[2];
		const array = evaluateStaticArray(expression, values);
		const value = array ?? evaluateStaticString(expression, values);
		if (value === null) continue;
		values.set(name, value);
		normalized.push(Array.isArray(value) ? value.join(" ") : value);
	}

	for (const match of contents.matchAll(/\[[^\]\r\n]+\](?:\.join\([^\)\r\n]*\))?/g)) {
		const value = match[0].includes(".join(")
			? evaluateStaticString(match[0], values)
			: evaluateStaticArray(match[0], values)?.join(" ") ?? null;
		if (value !== null) normalized.push(value);
	}
	for (const match of contents.matchAll(/`(?:\\.|[^`\r\n])*`/g)) {
		const value = evaluateStaticString(match[0], values);
		if (value !== null) normalized.push(value);
	}
	for (const match of contents.matchAll(/(?:"(?:\\.|[^"\r\n])*"|'(?:\\.|[^'\r\n])*'|`(?:\\.|[^`\r\n])*`)(?:\s*\+\s*(?:"(?:\\.|[^"\r\n])*"|'(?:\\.|[^'\r\n])*'|`(?:\\.|[^`\r\n])*`))+/g)) {
		const value = evaluateStaticString(match[0], values);
		if (value !== null) normalized.push(value);
	}
	return normalized;
}

function machineTmuxRouteReferences(contents: string): string[] {
	const normalizedContents = normalizeShellContinuations(contents);
	const references = new Set<string>();
	for (const match of normalizedContents.matchAll(tmuxMachineIngressOperationPattern)) {
		references.add(match[0]);
	}
	for (const match of normalizedContents.matchAll(directMachineTmuxRoutePattern)) {
		references.add(match[0]);
	}
	for (const value of normalizedStaticValues(normalizedContents)) {
		if (tmuxMachineIngressOperationTest.test(value)) references.add(`normalized:${value}`);
	}
	return [...references];
}

const installableMachineRouteReferences = [...files].flatMap(([rel, text]) =>
	machineTmuxRouteReferences(text).map(reference => `${rel}:${reference}`),
);
const machineTmuxRouteRegressionFixtures = [
	"tmux pipe-pane -t owner 'sink'",
	'"$TMUX_BIN" pipe-pane -t owner "sink"',
	"$TMUX_BIN \\\n  pipe-pane -t owner sink",
	'$TMUX_BIN capture-pane -p -t owner',
	'["capture", "pane"].join("-")',
	'["pipe", "pane"].join("-")',
	'./scripts/gjc-session/create.sh bot /repo --print "task"',
	"scripts/gjc-session/create.sh bot /repo positional-prompt",
	"gjc-session create bot /repo --file task.md",
	"gjc-session create bot /repo resume",
	"gjc-session create bot /repo \\\n  positional-prompt",
	'op=capture; op="${op}-pane"; tmux "$op" -p',
	'op=pipe; op="${op}-pane"; cmd=(tmux "$op" -t owner sink); "${cmd[@]}"',
	"['pipe-', 'pane'].join('')",
	'const cmd = ["tmux", ["pipe-", "pane"].join("")]; Bun.spawn(cmd[0], { args: cmd.slice(1) })',
	'const operation = "capture" + "-pane"; tmux "$operation" -p',
	'const operation = `send-${"keys"}`; tmux "$operation" -t owner C-m',
	'const operation = "load-" + "buffer"; tmux "$operation" -b owner',
	'const operation = `paste-${"buffer"}`; tmux "$operation" -b owner',
	'tmux_executable=tmux; operation=load; operation="${operation}-buffer"; argv=("$tmux_executable" "$operation" -b owner); "${argv[@]}"',
	'run_tmux() { local command=tmux; "$command" "$@"; }; operation=send; operation="${operation}-keys"; run_tmux "$operation" -t owner C-m',
	"tmux set-buffer prompt",
	'const operation = ["set", "buffer"].join("-"); tmux "$operation" prompt',
];
const uncoveredMachineTmuxRoutes = machineTmuxRouteRegressionFixtures.filter(
	fixture => machineTmuxRouteReferences(fixture).length === 0,
);
gate(
	"tmux machine-ingress matcher covers regression fixtures",
	uncoveredMachineTmuxRoutes.length === 0,
	uncoveredMachineTmuxRoutes.join(", ") || "all covered",
);
gate(
	"all generated installable files omit tmux machine ingress",
	installableMachineRouteReferences.length === 0,
	installableMachineRouteReferences.join(", ") || "none",
);

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
