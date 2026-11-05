#!/usr/bin/env bun

/**
 * Static verification helper for the G002 rebrand/MCP/local-tool gates.
 *
 * This script intentionally reports every gate before exiting non-zero when any
 * contract is still unmet. It is evidence-oriented: use it to support the team
 * verification lane without broad implementation changes.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import traverse, { type NodePath } from "@babel/traverse";
import { parse } from "@babel/parser";
import type * as Babel from "@babel/types";

const repoRoot = path.join(import.meta.dir, "..");
const EXPECTED_DEFINITIONS = ["autoresearch", "deep-interview", "ralplan", "ultragoal"] as const;
const EXPECTED_ROLE_AGENTS = ["architect", "critic", "executor", "planner"] as const;
const EXPECTED_PUBLIC_PACKAGE_VERSION_CATALOG_KEY = "@gajae-code/coding-agent";
const ALLOWED_PUBLIC_PACKAGE_VERSIONS = new Map<string, string>();
const ALLOWED_PRIVATE_PACKAGE_VERSIONS = new Map<string, string>([
	["@gajae-code/orchestration-token-benchmark", "0.0.1"],
	["@gajae-code/typescript-edit-benchmark", "0.0.1"],
]);
const ALLOWED_UNSCOPED_PACKAGE_NAMES = new Set<string>(["gajae-code"]);
const ALLOWED_PACKAGE_BINARIES = new Map<string, readonly string[]>([
	["@gajae-code/ai", ["pi-ai"]],
	["@gajae-code/coding-agent", ["gjc", "가재씨"]],
	["gajae-code", ["gjc", "가재씨"]],
	["@gajae-code/stats", ["gjc-stats"]],
	["@gajae-code/typescript-edit-benchmark", ["typescript-edit-benchmark"]],
]);
const PUBLIC_DOC_FILES = ["README.md", "packages/coding-agent/README.md"] as const;
const LEGACY_NAME_PATTERNS: readonly RegExp[] = [
	new RegExp("@oh-my" + "-pi", "u"),
	new RegExp("oh-my" + "-pi", "u"),
	new RegExp("pi-coding-agent", "u"),
	new RegExp(("om" + "p") + String.raw`\.sh`, "u"),
	new RegExp("qa\." + ("om" + "p") + String.raw`\.sh`, "u"),
];
const FORBIDDEN_PUBLIC_DOC_PATTERNS: readonly RegExp[] = [
	// MCP is a public product surface since #4283/#4284 (`gjc mcp`, `/extensions`,
	// docs/standalone-mcp.md); only removed-doc names stay forbidden in public docs.
	...LEGACY_NAME_PATTERNS,
	/mcp-config/u,
	/mcp-server\.md/u,
]
const FORBIDDEN_EXA_MCP_DOC_PATTERNS: readonly RegExp[] = [
	/Exa MCP/u,
	/web_search_exa/u,
	/mcp\.exa/u,
	/without EXA_API_KEY/u,
	/fall(?:s| back)? to MCP/u,
	/public MCP/u,
	/\(or mcp\)/u,
	/Exa search provider and Exa MCP/u,
];
const EXA_MCP_DOC_FILES = ["docs/tools/web_search.md", "docs/environment-variables.md", "README.md"] as const;
const GENERATED_DOCS_INDEX = "packages/coding-agent/src/internal-urls/docs-index.generated.ts";
const FORBIDDEN_SKILL_PATTERNS: readonly RegExp[] = [
	new RegExp(String.raw`\b` + "om" + "x" + String.raw`\s+(team|state|question|ultragoal|ralplan|deep-interview)`, "u"),
	/\$ralph/u,
	/\$autopilot/u,
	/\$autoresearch/u,
	/\$autoresearch-goal/u,
	/\$performance-goal/u,
	/\$ultraqa/u,
	/\$ultrawork/u,
	/MCP/u,
	/\/mcp/u,
];
const FORBIDDEN_PUBLIC_WORKFLOW_EXPORT_BLOCKS = [
	"./commands/ralph",
	"./commands/ultraqa",
	"./commands/ultrawork",
	"./commands/performance-goal",
] as const;
const FORBIDDEN_WORKFLOW_SURFACE_TOKENS = [
	"autopilot",
	"autoresearch-goal",
	"performance-goal",
	"ralph",
	"ultraqa",
	"ultrawork",
	"visual-ralph",
] as const;
const REQUIRED_PRIVATE_EXPORT_BLOCKS = [
	"./mcp",
	"./mcp/*",
	"./runtime-mcp",
	"./runtime-mcp/*",
	"./commands/gjc-runtime-bridge",
	"./capability/mcp",
	"./config/mcp-schema",
	"./discovery/mcp-json",
	"./exa",
	"./exa/*",
	"./exa/mcp-client",
	"./internal-urls/mcp-protocol",
	"./modes/components/runtime-mcp-add-wizard",
	"./modes/controllers/runtime-mcp-command-controller",
	"./slash-commands/helpers/mcp",
] as const;
const FORBIDDEN_PACKAGE_IMPORTS = [
	"@gajae-code/coding-agent/mcp",
	"@gajae-code/coding-agent/runtime-mcp/index",
	"@gajae-code/coding-agent/runtime-mcp/manager",
	"@gajae-code/coding-agent/commands/gjc-runtime-bridge",
	"@gajae-code/coding-agent/capability/mcp",
	"@gajae-code/coding-agent/config/mcp-schema",
	"@gajae-code/coding-agent/discovery/mcp-json",
	"@gajae-code/coding-agent/exa",
	"@gajae-code/coding-agent/exa/factory",
	"@gajae-code/coding-agent/exa/mcp-client",
	"@gajae-code/coding-agent/exa/search",
	"@gajae-code/coding-agent/exa/types",
	"@gajae-code/coding-agent/internal-urls/mcp-protocol",
	"@gajae-code/coding-agent/modes/components/runtime-mcp-add-wizard",
	"@gajae-code/coding-agent/modes/controllers/runtime-mcp-command-controller",
	"@gajae-code/coding-agent/slash-commands/helpers/mcp",
] as const;
const FORBIDDEN_PACKAGE_SYMBOLS = [
	{
		specifier: "@gajae-code/coding-agent",
		symbols: ["exaTools", "callExaTool", "searchTools", "researcherTools", "websetsTools"],
	},
	{
		specifier: "@gajae-code/coding-agent/tools",
		symbols: ["exaTools", "callExaTool", "searchTools", "researcherTools", "websetsTools"],
	},
] as const;
const REQUIRED_LOCAL_TOOL_FILES = [
	"packages/coding-agent/src/tools/read.ts",
	"packages/coding-agent/src/tools/write.ts",
	"packages/coding-agent/src/edit/index.ts",
	"packages/coding-agent/src/tools/bash.ts",
	"packages/coding-agent/src/tools/find.ts",
	"packages/coding-agent/src/tools/search.ts",
	"packages/coding-agent/src/tools/ast-grep.ts",
	"packages/coding-agent/src/tools/ast-edit.ts",
] as const;

interface GateResult {
	name: string;
	passed: boolean;
	details: string[];
}

if (import.meta.main) {
const results: GateResult[] = [];

results.push(await verifyRebrandSurface());
results.push(await verifyPackageVersionAndBinaryAllowlist());
results.push(await verifyVisibleDefinitions());
results.push(await verifyPublicDefinitionContent());
results.push(await verifyBroadWorkflowExposure());
results.push(await verifyMcpQuarantine());
results.push(await verifyLocalToolsPreserved());
results.push(await verifyRustBoundary());

for (const result of results) {
	console.log(`${result.passed ? "PASS" : "FAIL"} ${result.name}`);
	for (const detail of result.details) {
		console.log(`  - ${detail}`);
	}
}

const failed = results.filter(result => !result.passed);
if (failed.length > 0) {
	console.error(`\nG002 gate verification failed: ${failed.map(result => result.name).join(", ")}`);
	process.exit(1);
}

console.log("\nG002 gate verification passed.");
}

async function verifyRebrandSurface(): Promise<GateResult> {
	const rootPackage = await readJson("package.json");
	const codingPackage = await readJson("packages/coding-agent/package.json");
	const bin = isRecord(codingPackage.bin) ? codingPackage.bin : {};
	const details: string[] = [];

	const rootName = typeof rootPackage.name === "string" ? rootPackage.name : "<missing>";
	const codingName = typeof codingPackage.name === "string" ? codingPackage.name : "<missing>";
	const hasGjcBin = typeof bin.gjc === "string";
	const hasLegacyBin = ("om" + "p") in bin;

	details.push(`root package name: ${rootName}`);
	details.push(`coding-agent package name: ${codingName}`);
	details.push(`bin keys: ${Object.keys(bin).sort().join(", ") || "<none>"}`);

	return {
		name: "rebrand CLI/package surface",
		passed: rootName === "gajae-code" && codingName.includes("gajae") && hasGjcBin && !hasLegacyBin,
		details,
	};
}


async function readExpectedPublicPackageVersion(): Promise<string> {
	const rootPackageJson = await readJson("package.json");
	const workspaces = isRecord(rootPackageJson.workspaces) ? rootPackageJson.workspaces : null;
	const catalog = isRecord(workspaces?.catalog) ? workspaces.catalog : null;
	const version = catalog?.[EXPECTED_PUBLIC_PACKAGE_VERSION_CATALOG_KEY];
	if (typeof version !== "string" || version.trim().length === 0) {
		throw new Error(`Missing ${EXPECTED_PUBLIC_PACKAGE_VERSION_CATALOG_KEY} in root workspace catalog`);
	}
	return version;
}

async function verifyPackageVersionAndBinaryAllowlist(): Promise<GateResult> {
	const packagePaths = listPackageJsonPaths();
	const versionFindings: string[] = [];
	const nameFindings: string[] = [];
	const binaryFindings: string[] = [];

	const expectedPublicPackageVersion = await readExpectedPublicPackageVersion();
	for (const relativePath of packagePaths) {
		const packageJson = await readJson(relativePath);
		const packageName = typeof packageJson.name === "string" ? packageJson.name : "<missing>";
		const packageVersion = typeof packageJson.version === "string" ? packageJson.version : "<missing>";
		const isPrivate = packageJson.private === true;

		if (relativePath === "package.json") {
			if (packageName !== "gajae-code") nameFindings.push(`${relativePath}: expected gajae-code, found ${packageName}`);
			continue;
		}

		if (!packageName.startsWith("@gajae-code/") && !ALLOWED_UNSCOPED_PACKAGE_NAMES.has(packageName)) {
			nameFindings.push(`${relativePath}: package name ${packageName} is outside @gajae-code scope`);
		}

		const allowedPrivateVersion = ALLOWED_PRIVATE_PACKAGE_VERSIONS.get(packageName);
		const allowedPublicVersion = ALLOWED_PUBLIC_PACKAGE_VERSIONS.get(packageName);
		const expectedVersion =
			isPrivate && allowedPrivateVersion ? allowedPrivateVersion : allowedPublicVersion ?? expectedPublicPackageVersion;
		if (packageVersion !== expectedVersion) {
			versionFindings.push(`${relativePath}: ${packageName} version ${packageVersion} != ${expectedVersion}`);
		}

		const bin = isRecord(packageJson.bin) ? packageJson.bin : undefined;
		const actualBins = bin ? Object.keys(bin).sort() : [];
		const allowedBins = [...(ALLOWED_PACKAGE_BINARIES.get(packageName) ?? [])].sort();
		const unexpectedBins = actualBins.filter(name => !allowedBins.includes(name));
		const missingBins = allowedBins.filter(name => !actualBins.includes(name));
		const legacyBins = actualBins.filter(name => new RegExp(`^(${"om" + "p"}|${"om" + "x"}|pi-coding-agent)$`, "u").test(name));
		if (unexpectedBins.length > 0 || missingBins.length > 0 || legacyBins.length > 0) {
			binaryFindings.push(
				`${relativePath}: bins actual=${actualBins.join(",") || "<none>"} allowed=${allowedBins.join(",") || "<none>"} legacy=${legacyBins.join(",") || "<none>"}`,
			);
		}
	}

	const cargoWorkspace = await readText("Cargo.toml");
	const cargoVersion = /^version\s*=\s*"([^"]+)"/mu.exec(cargoWorkspace)?.[1] ?? "<missing>";
	if (cargoVersion !== expectedPublicPackageVersion) {
		versionFindings.push(`Cargo.toml workspace.package version ${cargoVersion} != ${expectedPublicPackageVersion}`);
	}

	return {
		name: "package version/binary allowlist",
		passed: versionFindings.length === 0 && nameFindings.length === 0 && binaryFindings.length === 0,
		details: [
			`package name findings: ${nameFindings.join("; ") || "<none>"}`,
			`version findings: ${versionFindings.join("; ") || "<none>"}`,
			`binary findings: ${binaryFindings.join("; ") || "<none>"}`,
		],
	};
}

async function verifyVisibleDefinitions(): Promise<GateResult> {
	const otherDefinitionRoots = [".gjc/skills", ".gjc/agents", ".gjc/commands", ".gjc/rules"];
	const otherDefinitions: string[] = [];
	const details: string[] = [];
	const bundledSkills = readVisibleEntries("packages/coding-agent/src/defaults/gjc/skills").filter(entry =>
		fs.existsSync(path.join(repoRoot, "packages/coding-agent/src/defaults/gjc/skills", entry, "SKILL.md")),
	);
	const bundledRoleAgents = readVisibleEntries("packages/coding-agent/src/prompts/agents").filter(entry =>
		EXPECTED_ROLE_AGENTS.includes(entry as (typeof EXPECTED_ROLE_AGENTS)[number]),
	);

	for (const root of otherDefinitionRoots) {
		const entries = readVisibleEntries(root);
		for (const entry of entries) otherDefinitions.push(`${root}/${entry}`);
		details.push(`${root}: ${entries.join(", ") || "<empty/absent>"}`);
	}

	const expectedSkills = [...EXPECTED_DEFINITIONS].sort();
	const expectedRoleAgents = [...EXPECTED_ROLE_AGENTS].sort();
	const skills = [...bundledSkills].sort();
	const roleAgents = [...bundledRoleAgents].sort();
	const ignoredDefinitions = getIgnoredDefinitionPaths([
		...expectedSkills.map(name => `packages/coding-agent/src/defaults/gjc/skills/${name}/SKILL.md`),
		...expectedRoleAgents.map(name => `packages/coding-agent/src/prompts/agents/${name}.md`),
	]);
	details.push(`expected bundled workflow skills: ${expectedSkills.join(", ")}`);
	details.push(`actual bundled workflow skills: ${skills.join(", ") || "<none>"}`);
	details.push(`expected bundled role agents: ${expectedRoleAgents.join(", ")}`);
	details.push(`actual bundled role agents: ${roleAgents.join(", ") || "<none>"}`);
	details.push(`repo-visible .gjc definitions: ${otherDefinitions.join(", ") || "<none>"}`);
	details.push(`gitignored default definitions: ${ignoredDefinitions.join(", ") || "<none>"}`);

	return {
		name: "bundled workflow skills and source role-agent definitions",
		passed:
			arraysEqual(skills, expectedSkills) &&
			arraysEqual(roleAgents, expectedRoleAgents) &&
			otherDefinitions.length === 0 &&
			ignoredDefinitions.length === 0,
		details,
	};
}

function readVisibleEntries(root: string): string[] {
	const absolute = path.join(repoRoot, root);
	if (!fs.existsSync(absolute)) return [];
	return fs
		.readdirSync(absolute, { withFileTypes: true })
		.filter(entry => entry.isDirectory() || entry.name.endsWith(".md") || entry.name.endsWith(".toml"))
		.map(entry => entry.name.replace(/\.(md|toml)$/u, ""))
		.sort();
}

function getIgnoredDefinitionPaths(paths: readonly string[]): string[] {
	const ignored: string[] = [];
	for (const filePath of paths) {
		const result = Bun.spawnSync(["git", "check-ignore", filePath], { cwd: repoRoot, stdout: "pipe", stderr: "pipe" });
		if (result.exitCode === 0) ignored.push(filePath);
	}
	return ignored;
}

async function verifyPublicDefinitionContent(): Promise<GateResult> {
	const findings: string[] = [];
	for (const definition of EXPECTED_DEFINITIONS) {
		const relativePath = `packages/coding-agent/src/defaults/gjc/skills/${definition}/SKILL.md`;
		const text = await readText(relativePath);
		for (const pattern of FORBIDDEN_SKILL_PATTERNS) {
			if (pattern.test(text)) findings.push(`${relativePath}: ${pattern.source}`);
		}
	}
	for (const agent of EXPECTED_ROLE_AGENTS) {
		const relativePath = `packages/coding-agent/src/prompts/agents/${agent}.md`;
		const text = await readText(relativePath);
		if (new RegExp(String.raw`\b` + "om" + "x" + String.raw`\b`, "iu").test(text)) findings.push(`${relativePath}: contains GJC team runtime naming`);
		for (const pattern of FORBIDDEN_SKILL_PATTERNS) {
			if (pattern.test(text)) findings.push(`${relativePath}: ${pattern.source}`);
		}
	}

	return {
		name: "approved bundled workflow skill and role-agent content",
		passed: findings.length === 0,
		details: [`forbidden bundled source references: ${findings.join(", ") || "<none>"}`],
	};
}


async function verifyBroadWorkflowExposure(): Promise<GateResult> {
	const findings: string[] = [];
	const codingPackage = await readJson("packages/coding-agent/package.json");
	const exportsRecord = isRecord(codingPackage.exports) ? codingPackage.exports : {};
	for (const exportKey of FORBIDDEN_PUBLIC_WORKFLOW_EXPORT_BLOCKS) {
		if (exportsRecord[exportKey] !== null) findings.push(`packages/coding-agent/package.json exports ${exportKey} is not blocked`);
	}

	const publicDefinitionRoots = [".gjc/skills", ".gjc/agents", ".gjc/commands", ".gjc/rules"];
	for (const root of publicDefinitionRoots) {
		const absolute = path.join(repoRoot, root);
		if (!fs.existsSync(absolute)) continue;
		for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
			findings.push(`${root}/${entry.name}: repo-visible default definitions should not be committed`);
		}
	}

	const activeSkillTexts = EXPECTED_DEFINITIONS.map(definition => {
		const relativePath = `packages/coding-agent/src/defaults/gjc/skills/${definition}/SKILL.md`;
		return [relativePath, fs.readFileSync(path.join(repoRoot, relativePath), "utf8")] as const;
	});
	for (const [relativePath, text] of activeSkillTexts) {
		for (const token of FORBIDDEN_WORKFLOW_SURFACE_TOKENS) {
			const pattern = new RegExp(`(?:\\$|\\bgjc\\s+|\\b${"om" + "x"}\\s+)${escapeRegExp(token)}\\b`, "u");
			if (pattern.test(text)) findings.push(`${relativePath}: exposes ${token}`);
		}
	}

	return {
		name: "broad workflow/agent exposure scan",
		passed: findings.length === 0,
		details: [`findings: ${findings.join("; ") || "<none>"}`],
	};
}

function getStaticMcpMemberName(member: Babel.ObjectMethod | Babel.ObjectProperty | Babel.SpreadElement): string | undefined {
	if (member.type === "SpreadElement") return undefined;
	if (member.computed) return member.key.type === "StringLiteral" ? member.key.value : undefined;
	if (member.key.type === "Identifier") return member.key.name;
	if (member.key.type === "StringLiteral") return member.key.value;
	return undefined;
}

function unwrapMcpPropertyValue(value: Babel.ObjectProperty["value"]): Babel.ObjectProperty["value"] {
	let expression = value;
	while (
		expression.type === "ParenthesizedExpression" ||
		expression.type === "TSAsExpression" ||
		expression.type === "TSTypeAssertion" ||
		expression.type === "TSSatisfiesExpression" ||
		expression.type === "TSNonNullExpression"
	) {
		expression = expression.expression;
	}
	return expression;
}

function getStaticMcpString(value: Babel.ObjectProperty["value"]): string | undefined {
	const expression = unwrapMcpPropertyValue(value);
	return expression.type === "StringLiteral" ? expression.value : undefined;
}

function getStaticMcpAliases(entry: Babel.ObjectExpression): string[] | undefined {
	const aliasProperties = entry.properties.filter(member => getStaticMcpMemberName(member) === "aliases");
	if (aliasProperties.length === 0) return [];
	const aliasProperty = aliasProperties[0];
	if (aliasProperties.length !== 1 || aliasProperty?.type !== "ObjectProperty") return undefined;

	const aliasesValue = unwrapMcpPropertyValue(aliasProperty.value);
	if (aliasesValue.type !== "ArrayExpression") return undefined;
	const aliases: string[] = [];
	for (const element of aliasesValue.elements) {
		if (!element || element.type === "SpreadElement") return undefined;
		const alias = getStaticMcpString(element);
		if (alias === undefined) return undefined;
		aliases.push(alias);
	}
	return aliases;
}

function getMcpHandlerBody(member: Babel.ObjectMethod | Babel.ObjectProperty): Babel.BlockStatement | undefined {
	if (member.type === "ObjectMethod") return member.body;
	if (member.value.type === "ArrowFunctionExpression" || member.value.type === "FunctionExpression") {
		return member.value.body.type === "BlockStatement" ? member.value.body : undefined;
	}
	return undefined;
}

function hasExactMcpHandlerParameters(member: Babel.ObjectMethod | Babel.ObjectProperty): boolean {
	const parameters =
		member.type === "ObjectMethod"
			? member.params
			: member.value.type === "ArrowFunctionExpression" || member.value.type === "FunctionExpression"
				? member.value.params
				: undefined;
	const command = parameters?.[0];
	const runtime = parameters?.[1];
	const body = getMcpHandlerBody(member);
	const shadowedParameter = body?.body.some(
		statement =>
			statement.type === "FunctionDeclaration" &&
			(statement.id?.name === "command" || statement.id?.name === "runtime"),
	);
	return (
		parameters?.length === 2 &&
		command?.type === "Identifier" &&
		command.name === "command" &&
		runtime?.type === "Identifier" &&
		runtime.name === "runtime" &&
		!shadowedParameter
	);
}

function hasMcpMemberAccessChain(expression: Babel.Expression, root: string, properties: readonly string[]): boolean {
	let current = expression;
	for (let index = properties.length - 1; index >= 0; index--) {
		if (
			current.type !== "MemberExpression" ||
			current.computed ||
			current.property.type !== "Identifier" ||
			current.property.name !== properties[index] ||
			current.object.type === "Super"
		) {
			return false;
		}
		current = current.object;
	}
	return current.type === "Identifier" && current.name === root;
}

function isExactMcpFallback(statement: Babel.Statement): boolean {
	if (statement.type !== "IfStatement" || statement.alternate !== null) return false;
	const condition = statement.test;
	if (
		condition.type !== "LogicalExpression" ||
		condition.operator !== "&&" ||
		condition.left.type !== "UnaryExpression" ||
		condition.left.operator !== "!" ||
		!hasMcpMemberAccessChain(condition.left.argument, "runtime", ["ctx", "session", "hasExactMcpControls"]) ||
		condition.right.type !== "UnaryExpression" ||
		condition.right.operator !== "!" ||
		!hasMcpMemberAccessChain(condition.right.argument, "runtime", ["ctx", "session", "hasSessionMcpControls"])
	) {
		return false;
	}
	const fallback = statement.consequent;
	if (fallback.type !== "ReturnStatement" || !fallback.argument || fallback.argument.type !== "ObjectExpression") return false;
	if (fallback.argument.properties.length !== 1) return false;
	const prompt = fallback.argument.properties[0];
	return (
		prompt?.type === "ObjectProperty" &&
		!prompt.computed &&
		getStaticMcpMemberName(prompt) === "prompt" &&
		prompt.value.type === "MemberExpression" &&
		!prompt.value.computed &&
		prompt.value.object.type === "Identifier" &&
		prompt.value.object.name === "command" &&
		prompt.value.property.type === "Identifier" &&
		prompt.value.property.name === "text"
	);
}

function isSessionMcpTuiHandler(statement: Babel.Statement): boolean {
	if (statement.type !== "IfStatement" || statement.alternate !== null) return false;
	const condition = statement.test;
	const fallback = statement.consequent;
	return (
		condition.type === "UnaryExpression" &&
		condition.operator === "!" &&
		hasMcpMemberAccessChain(condition.argument, "runtime", ["ctx", "session", "hasExactMcpControls"]) &&
		fallback.type === "ReturnStatement" &&
		fallback.argument?.type === "CallExpression" &&
		!fallback.argument.optional &&
		fallback.argument.callee.type === "Identifier" &&
		fallback.argument.callee.name === "handleSessionMcpTui" &&
		fallback.argument.arguments.length === 2 &&
		fallback.argument.arguments[0]?.type === "Identifier" &&
		fallback.argument.arguments[0].name === "command" &&
		fallback.argument.arguments[1]?.type === "Identifier" &&
		fallback.argument.arguments[1].name === "runtime"
	);
}

function isMcpFilterMember(expression: Babel.Node, object: string, property: string): boolean {
	return (
		expression.type === "MemberExpression" &&
		!expression.computed &&
		expression.object.type === "Identifier" &&
		expression.object.name === object &&
		expression.property.type === "Identifier" &&
		expression.property.name === property
	);
}

function isApprovedMcpRegistryFilter(expression: Babel.Node, parameterName: string): boolean {
	if (expression.type !== "LogicalExpression" || expression.operator !== "&&") return false;
	const utilityQuarantine = expression.left;
	if (
		utilityQuarantine.type !== "UnaryExpression" ||
		utilityQuarantine.operator !== "!" ||
		utilityQuarantine.argument.type !== "CallExpression" ||
		utilityQuarantine.argument.optional ||
		utilityQuarantine.argument.arguments.length !== 1 ||
		!isMcpFilterMember(utilityQuarantine.argument.callee, "QUARANTINED_UTILITY_SLASH_COMMANDS", "has")
	) {
		return false;
	}
	const quarantinedCommandName = utilityQuarantine.argument.arguments[0];
	if (!quarantinedCommandName || !isMcpFilterMember(quarantinedCommandName, parameterName, "name")) return false;

	const retainedDescriptorFilter = expression.right;
	if (retainedDescriptorFilter.type !== "LogicalExpression" || retainedDescriptorFilter.operator !== "||") {
		return false;
	}
	const importSessionExclusion = retainedDescriptorFilter.left;
	return (
		importSessionExclusion.type === "BinaryExpression" &&
		importSessionExclusion.operator === "!==" &&
		isMcpFilterMember(importSessionExclusion.left, parameterName, "name") &&
		importSessionExclusion.right.type === "StringLiteral" &&
		importSessionExclusion.right.value === "import-session" &&
		retainedDescriptorFilter.right.type === "Identifier" &&
		retainedDescriptorFilter.right.name === "IMPORT_SESSION_RETAINED_DESCRIPTOR_AUTHORITY_AVAILABLE"
	);
}

function isActiveMcpRegistryFilterReference(identifierPath: NodePath<Babel.Identifier>): boolean {
	const memberPath = identifierPath.parentPath;
	if (
		!memberPath?.isMemberExpression() ||
		memberPath.node.object !== identifierPath.node ||
		memberPath.node.computed ||
		memberPath.node.property.type !== "Identifier" ||
		memberPath.node.property.name !== "filter"
	) {
		return false;
	}
	const callPath = memberPath.parentPath;
	if (
		!callPath?.isCallExpression() ||
		callPath.node.callee !== memberPath.node ||
		callPath.node.optional ||
		callPath.node.arguments.length !== 1
	) {
		return false;
	}
	const declarationPath = callPath.parentPath;
	if (
		!declarationPath?.isVariableDeclarator() ||
		declarationPath.node.init !== callPath.node ||
		declarationPath.node.id.type !== "Identifier" ||
		declarationPath.node.id.name !== "ACTIVE_BUILTIN_SLASH_COMMAND_REGISTRY"
	) {
		return false;
	}
	const variableDeclarationPath = declarationPath.parentPath;
	if (
		!variableDeclarationPath?.isVariableDeclaration() ||
		variableDeclarationPath.node.kind !== "const" ||
		variableDeclarationPath.node.declarations.length !== 1
	) {
		return false;
	}
	const callback = callPath.node.arguments[0];
	if (
		callback?.type !== "ArrowFunctionExpression" ||
		callback.async ||
		callback.generator ||
		callback.params.length !== 1 ||
		callback.params[0]?.type !== "Identifier" ||
		callback.body.type === "BlockStatement"
	) {
		return false;
	}
	return isApprovedMcpRegistryFilter(callback.body, callback.params[0].name);
}

function isSafeMcpLookupSet(
	statement: Babel.Statement,
	key: { name: string; member?: string },
	commandName: string,
): boolean {
	if (statement.type !== "ExpressionStatement" || statement.expression.type !== "CallExpression") return false;
	const call = statement.expression;
	if (
		call.optional ||
		!isMcpFilterMember(call.callee, "BUILTIN_SLASH_COMMAND_LOOKUP", "set") ||
		call.arguments.length !== 2
	) {
		return false;
	}
	const keyArgument = call.arguments[0];
	const commandArgument = call.arguments[1];
	return (
		keyArgument !== undefined &&
		keyArgument.type !== "SpreadElement" &&
		keyArgument.type !== "ArgumentPlaceholder" &&
		(key.member
			? keyArgument.type === "MemberExpression" &&
				!keyArgument.computed &&
				keyArgument.object.type === "Identifier" &&
				keyArgument.object.name === key.name &&
				keyArgument.property.type === "Identifier" &&
				keyArgument.property.name === key.member
			: keyArgument.type === "Identifier" && keyArgument.name === key.name) &&
		commandArgument?.type === "Identifier" &&
		commandArgument.name === commandName
	);
}

function isSafeMcpLookupLoop(statement: Babel.ForOfStatement): boolean {
	if (
		statement.await ||
		statement.right.type !== "Identifier" ||
		statement.right.name !== "ACTIVE_BUILTIN_SLASH_COMMAND_REGISTRY" ||
		statement.left.type !== "VariableDeclaration" ||
		statement.left.kind !== "const" ||
		statement.left.declarations.length !== 1 ||
		statement.left.declarations[0]?.id.type !== "Identifier" ||
		statement.left.declarations[0].id.name !== "command" ||
		statement.body.type !== "BlockStatement" ||
		statement.body.body.length !== 2
	) {
		return false;
	}
	const [commandLookup, aliasLoop] = statement.body.body;
	return (
		commandLookup !== undefined &&
		isSafeMcpLookupSet(commandLookup, { name: "command", member: "name" }, "command") &&
		aliasLoop?.type === "ForOfStatement" &&
		!aliasLoop.await &&
		aliasLoop.left.type === "VariableDeclaration" &&
		aliasLoop.left.kind === "const" &&
		aliasLoop.left.declarations.length === 1 &&
		aliasLoop.left.declarations[0]?.id.type === "Identifier" &&
		aliasLoop.left.declarations[0].id.name === "alias" &&
		aliasLoop.right.type === "LogicalExpression" &&
		aliasLoop.right.operator === "??" &&
		hasMcpMemberAccessChain(aliasLoop.right.left, "command", ["aliases"]) &&
		aliasLoop.right.right.type === "ArrayExpression" &&
		aliasLoop.right.right.elements.length === 0 &&
		aliasLoop.body.type === "BlockStatement" &&
		aliasLoop.body.body.length === 1 &&
		isSafeMcpLookupSet(aliasLoop.body.body[0]!, { name: "alias" }, "command")
	);
}

function isExpectedMcpLookupDeclaration(identifierPath: NodePath<Babel.Identifier>): boolean {
	const declaratorPath = identifierPath.parentPath;
	if (!declaratorPath?.isVariableDeclarator() || declaratorPath.node.id !== identifierPath.node) return false;
	const declarationPath = declaratorPath.parentPath;
	const initializer = declaratorPath.node.init;
	return (
		declarationPath?.isVariableDeclaration() === true &&
		declarationPath.node.kind === "const" &&
		declarationPath.node.declarations.length === 1 &&
		initializer?.type === "NewExpression" &&
		initializer.callee.type === "Identifier" &&
		initializer.callee.name === "Map" &&
		initializer.arguments.length === 0
	);
}

function isExpectedMcpLookupGet(identifierPath: NodePath<Babel.Identifier>): boolean {
	const memberPath = identifierPath.parentPath;
	if (
		!memberPath?.isMemberExpression() ||
		memberPath.node.object !== identifierPath.node ||
		memberPath.node.computed ||
		memberPath.node.optional ||
		memberPath.node.property.type !== "Identifier" ||
		memberPath.node.property.name !== "get"
	) {
		return false;
	}
	const callPath = memberPath.parentPath;
	if (!callPath?.isCallExpression() || callPath.node.callee !== memberPath.node || callPath.node.optional) return false;
	const resultPath = callPath.parentPath;
	if (
		resultPath?.isOptionalMemberExpression() &&
		resultPath.node.object === callPath.node &&
		!resultPath.node.computed &&
		resultPath.node.property.type === "Identifier" &&
		resultPath.node.property.name === "handle"
	) {
		const dispatchPath = resultPath.parentPath;
		return dispatchPath?.isOptionalCallExpression() === true && dispatchPath.node.callee === resultPath.node;
	}
	if (
		resultPath?.isVariableDeclarator() &&
		resultPath.node.init === callPath.node &&
		resultPath.node.id.type === "Identifier" &&
		resultPath.node.id.name === "command" &&
		resultPath.parentPath?.isVariableDeclaration() &&
		resultPath.parentPath.node.kind === "const"
	) {
		const functionPath = resultPath.getFunctionParent();
		return (
			functionPath?.node.type === "FunctionDeclaration" &&
			(functionPath.node.id?.name === "executeBuiltinSlashCommand" ||
				functionPath.node.id?.name === "executeLocalHeadlessBuiltinSlashCommand")
		);
	}
	if (resultPath?.isReturnStatement() && resultPath.node.argument === callPath.node) {
		const functionPath = resultPath.getFunctionParent();
		return functionPath?.node.type === "FunctionDeclaration" && functionPath.node.id?.name === "lookupBuiltinSlashCommand";
	}
	return false;
}

function isExpectedMcpLookupSet(identifierPath: NodePath<Babel.Identifier>): boolean {
	const memberPath = identifierPath.parentPath;
	if (
		!memberPath?.isMemberExpression() ||
		memberPath.node.object !== identifierPath.node ||
		memberPath.node.computed ||
		memberPath.node.optional ||
		memberPath.node.property.type !== "Identifier" ||
		memberPath.node.property.name !== "set"
	) {
		return false;
	}
	const callPath = memberPath.parentPath;
	if (!callPath?.isCallExpression() || callPath.node.callee !== memberPath.node || callPath.node.optional) return false;
	const statementPath = callPath.parentPath;
	if (!statementPath?.isExpressionStatement()) return false;
	let ancestor: NodePath<Babel.Node> | null = statementPath.parentPath;
	while (ancestor) {
		if (ancestor.isForOfStatement() && isSafeMcpLookupLoop(ancestor.node)) return true;
		ancestor = ancestor.parentPath;
	}
	return false;
}

function hasOnlyExpectedMcpLookupUse(program: Babel.File, required: boolean): boolean {
	let declarationCount = 0;
	let populationWrites = 0;
	let reads = 0;
	let hasUnverifiedReference = false;
	traverse(program, {
		Identifier(identifierPath) {
			if (identifierPath.node.name !== "BUILTIN_SLASH_COMMAND_LOOKUP") return;
			if (identifierPath.parentPath?.isVariableDeclarator() && identifierPath.parentPath.node.id === identifierPath.node) {
				declarationCount++;
				if (!isExpectedMcpLookupDeclaration(identifierPath)) hasUnverifiedReference = true;
				return;
			}
			if (isExpectedMcpLookupGet(identifierPath)) {
				reads++;
				return;
			}
			if (isExpectedMcpLookupSet(identifierPath)) {
				populationWrites++;
				return;
			}
			hasUnverifiedReference = true;
		},
	});
	if (!required) return declarationCount === 0 && populationWrites === 0 && reads === 0 && !hasUnverifiedReference;
	return declarationCount === 1 && populationWrites === 2 && reads > 0 && !hasUnverifiedReference;
}

function isExpectedQuarantinedUtilitySetDeclaration(identifierPath: NodePath<Babel.Identifier>): boolean {
	const declaratorPath = identifierPath.parentPath;
	if (!declaratorPath?.isVariableDeclarator() || declaratorPath.node.id !== identifierPath.node) return false;
	const declarationPath = declaratorPath.parentPath;
	const initializer = declaratorPath.node.init;
	const entries =
		initializer?.type === "NewExpression" && initializer.arguments.length === 1 ? initializer.arguments[0] : undefined;
	const entry = entries?.type === "ArrayExpression" ? entries.elements[0] : undefined;
	return (
		declarationPath?.isVariableDeclaration() === true &&
		declarationPath.node.kind === "const" &&
		declarationPath.node.declarations.length === 1 &&
		initializer?.type === "NewExpression" &&
		initializer.callee.type === "Identifier" &&
		initializer.callee.name === "Set" &&
		initializer.arguments.length === 1 &&
		entries?.type === "ArrayExpression" &&
		entries.elements.length === 1 &&
		entry?.type === "StringLiteral" &&
		entry.value === "agents"
	);
}

function isExpectedQuarantinedUtilitySetHas(identifierPath: NodePath<Babel.Identifier>): boolean {
	const memberPath = identifierPath.parentPath;
	if (
		!memberPath?.isMemberExpression() ||
		memberPath.node.object !== identifierPath.node ||
		memberPath.node.computed ||
		memberPath.node.optional ||
		memberPath.node.property.type !== "Identifier" ||
		memberPath.node.property.name !== "has"
	) {
		return false;
	}
	const callPath = memberPath.parentPath;
	return (
		callPath?.isCallExpression() === true &&
		callPath.node.callee === memberPath.node &&
		!callPath.node.optional &&
		callPath.node.arguments.length === 1
	);
}

function hasOnlyExpectedQuarantinedUtilitySetUse(program: Babel.File, required: boolean): boolean {
	let declarationCount = 0;
	let references = 0;
	let hasUnverifiedReference = false;
	traverse(program, {
		Identifier(identifierPath) {
			if (identifierPath.node.name !== "QUARANTINED_UTILITY_SLASH_COMMANDS") return;
			if (identifierPath.parentPath?.isVariableDeclarator() && identifierPath.parentPath.node.id === identifierPath.node) {
				declarationCount++;
				if (!isExpectedQuarantinedUtilitySetDeclaration(identifierPath)) hasUnverifiedReference = true;
				return;
			}
			references++;
			if (!isExpectedQuarantinedUtilitySetHas(identifierPath)) hasUnverifiedReference = true;
		},
	});
	if (!required) return declarationCount === 0 && references === 0 && !hasUnverifiedReference;
	return declarationCount === 1 && references === 1 && !hasUnverifiedReference;
}

function isSafeMcpMetadataMapReference(identifierPath: NodePath<Babel.Identifier>): boolean {
	const memberPath = identifierPath.parentPath;
	if (
		!memberPath?.isMemberExpression() ||
		memberPath.node.object !== identifierPath.node ||
		memberPath.node.computed ||
		memberPath.node.property.type !== "Identifier" ||
		memberPath.node.property.name !== "map"
	) {
		return false;
	}
	const callPath = memberPath.parentPath;
	if (
		!callPath?.isCallExpression() ||
		callPath.node.callee !== memberPath.node ||
		callPath.node.optional ||
		callPath.node.arguments.length !== 1
	) {
		return false;
	}
	const callback = callPath.node.arguments[0];
	const callbackParameter = callback?.type === "ArrowFunctionExpression" ? callback.params[0] : undefined;
	if (
		callback?.type !== "ArrowFunctionExpression" ||
		callback.async ||
		callback.generator ||
		callback.params.length !== 1 ||
		callbackParameter?.type !== "Identifier" ||
		callback.body.type !== "ObjectExpression"
	) {
		return false;
	}
	const expectedProperties = ["name", "description", "subcommands", "inlineHint", "priority"];
	return (
		callback.body.properties.length === expectedProperties.length &&
		callback.body.properties.every((property, index) => {
			const expectedProperty = expectedProperties[index];
			return (
				property.type === "ObjectProperty" &&
				!property.computed &&
				!property.shorthand &&
				getStaticMcpMemberName(property) === expectedProperty &&
				property.value.type === "MemberExpression" &&
				!property.value.computed &&
				property.value.object.type === "Identifier" &&
				property.value.object.name === callbackParameter.name &&
				property.value.property.type === "Identifier" &&
				property.value.property.name === expectedProperty
			);
		})
	);
}

function hasOnlyExpectedActiveMcpRegistryUse(program: Babel.File): boolean {
	let activeRegistryDeclarations = 0;
	let referenceCount = 0;
	let lookupReferences = 0;
	let metadataReferences = 0;
	let exportReferences = 0;
	let hasUnverifiedReference = false;
	let hasUnverifiedDeclaration = false;
	traverse(program, {
		Identifier(identifierPath) {
			if (identifierPath.node.name !== "ACTIVE_BUILTIN_SLASH_COMMAND_REGISTRY") return;
			const parentPath = identifierPath.parentPath;
			if (parentPath?.isVariableDeclarator() && parentPath.node.id === identifierPath.node) {
				activeRegistryDeclarations++;
				const declarationPath = parentPath.parentPath;
				if (
					!declarationPath?.isVariableDeclaration() ||
					declarationPath.node.kind !== "const" ||
					declarationPath.node.declarations.length !== 1
				) {
					hasUnverifiedDeclaration = true;
				}
				return;
			}
			referenceCount++;
			if (parentPath?.isForOfStatement() && parentPath.node.right === identifierPath.node) {
				if (isSafeMcpLookupLoop(parentPath.node)) lookupReferences++;
				else hasUnverifiedReference = true;
				return;
			}
			if (
				parentPath?.isVariableDeclarator() &&
				parentPath.node.init === identifierPath.node &&
				parentPath.node.id.type === "Identifier" &&
				parentPath.node.id.name === "BUILTIN_SLASH_COMMANDS_INTERNAL" &&
				parentPath.parentPath?.parentPath?.isExportNamedDeclaration()
			) {
				exportReferences++;
				return;
			}
			if (isSafeMcpMetadataMapReference(identifierPath)) metadataReferences++;
			else hasUnverifiedReference = true;
		},
	});
	if (activeRegistryDeclarations === 0) return referenceCount === 0;
	return (
		activeRegistryDeclarations === 1 &&
		!hasUnverifiedDeclaration &&
		!hasUnverifiedReference &&
		lookupReferences === 1 &&
		metadataReferences === 1 &&
		exportReferences === 1
	);
}

function hasOnlyExpectedMcpRegistryUse(
	program: Babel.File,
	registryDeclaration: Babel.VariableDeclarator,
): boolean {
	let referenceCount = 0;
	let hasActiveRegistryDeclaration = false;
	let hasExpectedFilterReference = false;
	traverse(program, {
		Identifier(identifierPath) {
			if (
				identifierPath.node.name === "ACTIVE_BUILTIN_SLASH_COMMAND_REGISTRY" &&
				identifierPath.parentPath?.isVariableDeclarator() &&
				identifierPath.parentPath.node.id === identifierPath.node
			) {
				hasActiveRegistryDeclaration = true;
			}
			if (
				identifierPath.node.name !== "BUILTIN_SLASH_COMMAND_REGISTRY" ||
				identifierPath.node === registryDeclaration.id
			) {
				return;
			}
			referenceCount++;
			if (isActiveMcpRegistryFilterReference(identifierPath)) hasExpectedFilterReference = true;
		},
	});
	if (!hasActiveRegistryDeclaration) {
		return (
			referenceCount === 0 &&
			hasOnlyExpectedActiveMcpRegistryUse(program) &&
			hasOnlyExpectedMcpLookupUse(program, false) &&
			hasOnlyExpectedQuarantinedUtilitySetUse(program, false)
		);
	}
	return (
		referenceCount === 1 &&
		hasExpectedFilterReference &&
		hasOnlyExpectedActiveMcpRegistryUse(program) &&
		hasOnlyExpectedMcpLookupUse(program, true) &&
		hasOnlyExpectedQuarantinedUtilitySetUse(program, true)
	);
}

export function findMcpBuiltinQuarantineFindings(builtinRegistry: string): string[] {
	let registry: Babel.ArrayExpression | undefined;
	let registryDeclaration: Babel.VariableDeclarator | undefined;
	let source: Babel.File;
	try {
		source = parse(builtinRegistry, { sourceType: "module", plugins: ["typescript"] });
		for (const statement of source.program.body) {
			if (statement.type !== "VariableDeclaration") continue;
			for (const declaration of statement.declarations) {
				if (declaration.id.type !== "Identifier" || declaration.id.name !== "BUILTIN_SLASH_COMMAND_REGISTRY") continue;
				if (statement.kind !== "const" || declaration.init?.type !== "ArrayExpression") {
					return ["root slash-command registry could not be isolated"];
				}
				registry = declaration.init;
				registryDeclaration = declaration;
				break;
			}
			if (registry) break;
		}
	} catch {
		return ["root slash-command registry could not be parsed"];
	}
	if (!registry || !registryDeclaration) return ["root slash-command registry could not be isolated"];
	if (!hasOnlyExpectedMcpRegistryUse(source, registryDeclaration)) {
		return ["root slash-command registry has an unverified additional use or mutation"];
	}

	const mcpEntries: Babel.ObjectExpression[] = [];
	for (const element of registry.elements) {
		if (!element) continue;
		if (element.type === "SpreadElement") return ["root slash-command registry contains an unverified spread"];
		if (element.type !== "ObjectExpression") return ["root slash-command registry contains an unverified entry"];
		if (element.properties.some(property => property.type === "SpreadElement")) {
			return ["root slash-command registry entry contains an unverified spread"];
		}
		const hasUnverifiedPrototype = element.properties.some(
			property =>
				property.type === "ObjectProperty" &&
				!property.computed &&
				!property.shorthand &&
				getStaticMcpMemberName(property) === "__proto__",
		);
		if (hasUnverifiedPrototype) {
			return ["root slash-command registry entry contains an unverified prototype"];
		}
		if (
			element.properties.some(
				property =>
					property.type !== "SpreadElement" && property.computed && property.key.type !== "StringLiteral",
			)
		) {
			return ["root slash-command registry entry contains an unverified computed property"];
		}

		const nameProperties = element.properties.filter(
			(property): property is Babel.ObjectProperty =>
				property.type === "ObjectProperty" && getStaticMcpMemberName(property) === "name",
		);
		if (nameProperties.length !== 1) return ["root slash-command registry contains an unverified command name"];
		const nameProperty = nameProperties[0];
		const name = nameProperty ? getStaticMcpString(nameProperty.value) : undefined;
		if (name === undefined) return ["root slash-command registry contains an unverified command name"];

		const aliases = getStaticMcpAliases(element);
		if (aliases === undefined) return ["root slash-command registry contains unverified aliases"];
		if (name === "mcp" || aliases.includes("mcp")) mcpEntries.push(element);
	}

	if (mcpEntries.length === 0) return [];
	const findings: string[] = [];
	if (mcpEntries.length > 1) findings.push("multiple root /mcp builtins are registered");
	for (const entry of mcpEntries) {
		if (entry.properties.some(property => getStaticMcpMemberName(property) === "handle")) {
			findings.push("root /mcp builtin has an unrestricted default handler");
		}

		const tuiHandlers = entry.properties.filter(
			(property): property is Babel.ObjectMethod | Babel.ObjectProperty =>
				getStaticMcpMemberName(property) === "handleTui" && property.type !== "SpreadElement",
		);
		if (tuiHandlers.length !== 1) {
			findings.push("root /mcp builtin must define exactly one TUI-only handler");
			continue;
		}
		if (!hasExactMcpHandlerParameters(tuiHandlers[0]!)) {
			findings.push("root /mcp TUI handler parameters must be command and runtime identifiers");
			continue;
		}
		const handlerBody = getMcpHandlerBody(tuiHandlers[0]!);
		if (
			!handlerBody ||
			!handlerBody.body[0] ||
			!handlerBody.body[1] ||
			!isExactMcpFallback(handlerBody.body[0]) ||
			!isSessionMcpTuiHandler(handlerBody.body[1])
		) {
			findings.push("root /mcp TUI handler must fall through without exact MCP controls");
		}
	}
	return findings;
}

export function findMcpTuiMetadataFindings(slashCommandsSource: string, interactiveModeSource: string): string[] {
	try {
		const slashCommands = parse(slashCommandsSource, { sourceType: "module", plugins: ["typescript"] });
		const interactiveMode = parse(interactiveModeSource, { sourceType: "module", plugins: ["typescript"] });
		const filterIsSafe = slashCommands.program.body.some(statement => {
			if (statement.type !== "ExportNamedDeclaration" || statement.declaration?.type !== "FunctionDeclaration") {
				return false;
			}
			const declaration = statement.declaration;
			const [exactCapabilityBranch, sessionCapabilityBranch, filteredReturn] = declaration.body.body;
			if (
				declaration.id?.name !== "getBuiltinSlashCommandsForSession" ||
				declaration.params.length !== 2 ||
				declaration.params[0]?.type !== "Identifier" ||
				declaration.params[0].name !== "hasExactMcpControls" ||
				declaration.params[1]?.type !== "Identifier" ||
				declaration.params[1].name !== "session" ||
				declaration.body.body.length !== 3 ||
				exactCapabilityBranch?.type !== "IfStatement" ||
				exactCapabilityBranch.test.type !== "Identifier" ||
				exactCapabilityBranch.test.name !== "hasExactMcpControls" ||
				exactCapabilityBranch.alternate !== null ||
				exactCapabilityBranch.consequent.type !== "ReturnStatement" ||
				exactCapabilityBranch.consequent.argument?.type !== "Identifier" ||
				exactCapabilityBranch.consequent.argument.name !== "BUILTIN_SLASH_COMMANDS" ||
				sessionCapabilityBranch?.type !== "IfStatement" ||
				sessionCapabilityBranch.alternate !== null ||
				sessionCapabilityBranch.test.type !== "OptionalMemberExpression" ||
				!sessionCapabilityBranch.test.optional ||
				sessionCapabilityBranch.test.computed ||
				sessionCapabilityBranch.test.object.type !== "Identifier" ||
				sessionCapabilityBranch.test.object.name !== "session" ||
				sessionCapabilityBranch.test.property.type !== "Identifier" ||
				sessionCapabilityBranch.test.property.name !== "hasSessionMcpControls" ||
				sessionCapabilityBranch.consequent.type !== "ReturnStatement" ||
				sessionCapabilityBranch.consequent.argument?.type !== "CallExpression" ||
				sessionCapabilityBranch.consequent.argument.optional ||
				sessionCapabilityBranch.consequent.argument.callee.type !== "Identifier" ||
				sessionCapabilityBranch.consequent.argument.callee.name !== "getSessionMcpSlashCommands" ||
				sessionCapabilityBranch.consequent.argument.arguments.length !== 1 ||
				sessionCapabilityBranch.consequent.argument.arguments[0]?.type !== "Identifier" ||
				sessionCapabilityBranch.consequent.argument.arguments[0].name !== "session" ||
				filteredReturn?.type !== "ReturnStatement" ||
				filteredReturn.argument?.type !== "CallExpression" ||
				filteredReturn.argument.optional ||
				filteredReturn.argument.callee.type !== "MemberExpression" ||
				filteredReturn.argument.callee.computed ||
				filteredReturn.argument.callee.object.type !== "Identifier" ||
				filteredReturn.argument.callee.object.name !== "BUILTIN_SLASH_COMMANDS" ||
				filteredReturn.argument.callee.property.type !== "Identifier" ||
				filteredReturn.argument.callee.property.name !== "filter"
			) {
				return false;
			}
			const predicate = filteredReturn.argument.arguments[0];
			return (
				filteredReturn.argument.arguments.length === 1 &&
				predicate?.type === "ArrowFunctionExpression" &&
				!predicate.async &&
				!predicate.generator &&
				predicate.params.length === 1 &&
				predicate.params[0]?.type === "Identifier" &&
				predicate.params[0].name === "command" &&
				predicate.body.type === "BinaryExpression" &&
				predicate.body.operator === "!==" &&
				predicate.body.left.type === "MemberExpression" &&
				!predicate.body.left.computed &&
				predicate.body.left.object.type === "Identifier" &&
				predicate.body.left.object.name === "command" &&
				predicate.body.left.property.type === "Identifier" &&
				predicate.body.left.property.name === "name" &&
				predicate.body.right.type === "StringLiteral" &&
				predicate.body.right.value === "mcp"
		);
		});
		const interactiveClass = interactiveMode.program.body
			.map(statement => (statement.type === "ExportNamedDeclaration" ? statement.declaration : statement))
			.find(
				(declaration): declaration is Babel.ClassDeclaration =>
					declaration?.type === "ClassDeclaration" && declaration.id?.name === "InteractiveMode",
			);
		if (!interactiveClass) throw new Error("InteractiveMode class is missing");
		const method = (name: string): Babel.ClassMethod | Babel.ClassPrivateMethod | undefined =>
			interactiveClass.body.body.find((member): member is Babel.ClassMethod | Babel.ClassPrivateMethod => {
				if (member.type !== "ClassMethod" && member.type !== "ClassPrivateMethod") return false;
				return name.startsWith("#")
					? member.key.type === "PrivateName" && member.key.id.name === name.slice(1)
					: member.key.type === "Identifier" && member.key.name === name;
			});
		const refreshHelper = method("#refreshSessionBuiltinSlashCommandVisibility");
		const thisPrivate = (node: Babel.Node, property: string): boolean =>
			node.type === "MemberExpression" &&
			!node.computed &&
			node.object.type === "ThisExpression" &&
			node.property.type === "PrivateName" &&
			node.property.id.name === property;
		const refreshBody = refreshHelper?.body.body ?? [];
		const commandNameMember = (node: Babel.Node, parameter: string): boolean =>
			node.type === "MemberExpression" &&
			!node.computed &&
			!node.optional &&
			node.object.type === "Identifier" &&
			node.object.name === parameter &&
			node.property.type === "Identifier" &&
			node.property.name === "name";
		const isExpectedBuiltinCommandNamesDeclaration = (statement: Babel.Statement): boolean => {
			if (
				statement.type !== "VariableDeclaration" ||
				statement.kind !== "const" ||
				statement.declarations.length !== 1
			) {
				return false;
			}
			const declaration = statement.declarations[0];
			const initializer = declaration?.init;
			if (
				declaration?.id.type !== "Identifier" ||
				declaration.id.name !== "builtinCommandNames" ||
				initializer?.type !== "NewExpression" ||
				initializer.callee.type !== "Identifier" ||
				initializer.callee.name !== "Set" ||
				initializer.arguments.length !== 1
			) {
				return false;
			}
			const names = initializer.arguments[0];
			if (
				names?.type !== "CallExpression" ||
				names.optional ||
				names.arguments.length !== 1 ||
				names.callee.type !== "MemberExpression" ||
				names.callee.computed ||
				names.callee.optional ||
				names.callee.object.type !== "Identifier" ||
				names.callee.object.name !== "BUILTIN_SLASH_COMMANDS" ||
				names.callee.property.type !== "Identifier" ||
				names.callee.property.name !== "map"
			) {
				return false;
			}
			const mapper = names.arguments[0];
			return (
				mapper?.type === "ArrowFunctionExpression" &&
				!mapper.async &&
				!mapper.generator &&
				mapper.params.length === 1 &&
				mapper.params[0]?.type === "Identifier" &&
				mapper.params[0].name === "command" &&
				commandNameMember(mapper.body, "command")
			);
		};
		const builtinCommandNamesDeclarationIndices = refreshBody.flatMap((statement, index) =>
			isExpectedBuiltinCommandNamesDeclaration(statement) ? [index] : [],
		);
		const isExpectedBuiltinCommandNamesTail = (element: Babel.Node | null | undefined): boolean => {
			if (element?.type !== "SpreadElement") return false;
			const filter = element.argument;
			if (
				filter.type !== "CallExpression" ||
				filter.optional ||
				filter.arguments.length !== 1 ||
				filter.callee.type !== "MemberExpression" ||
				filter.callee.computed ||
				filter.callee.optional ||
				!thisPrivate(filter.callee.object, "baseSlashCommands") ||
				filter.callee.property.type !== "Identifier" ||
				filter.callee.property.name !== "filter"
			) {
				return false;
			}
			const predicate = filter.arguments[0];
			if (
				predicate?.type !== "ArrowFunctionExpression" ||
				predicate.async ||
				predicate.generator ||
				predicate.params.length !== 1 ||
				predicate.params[0]?.type !== "Identifier" ||
				predicate.params[0].name !== "command" ||
				predicate.body.type !== "UnaryExpression" ||
				predicate.body.operator !== "!" ||
				predicate.body.argument.type !== "CallExpression" ||
				predicate.body.argument.optional ||
				predicate.body.argument.arguments.length !== 1 ||
				!isMcpFilterMember(predicate.body.argument.callee, "builtinCommandNames", "has")
			) {
				return false;
			}
			return commandNameMember(predicate.body.argument.arguments[0]!, "command");
		};
		const isExpectedPreviousSlashCommandTail = (statement: Babel.Statement): boolean => {
			if (
				statement.type !== "VariableDeclaration" ||
				statement.kind !== "const" ||
				statement.declarations.length !== 1
			) {
				return false;
			}
			const declaration = statement.declarations[0];
			const initializer = declaration?.init;
			if (
				declaration?.id.type !== "Identifier" ||
				declaration.id.name !== "previousSlashCommandTail" ||
				initializer?.type !== "CallExpression" ||
				initializer.optional ||
				initializer.arguments.length !== 1 ||
				initializer.callee.type !== "MemberExpression" ||
				initializer.callee.computed ||
				initializer.callee.optional ||
				!thisPrivate(initializer.callee.object, "resolvedSlashCommands") ||
				initializer.callee.property.type !== "Identifier" ||
				initializer.callee.property.name !== "slice"
			) {
				return false;
			}
			const offset = initializer.arguments[0];
			return (
				offset?.type === "MemberExpression" &&
				!offset.computed &&
				!offset.optional &&
				thisPrivate(offset.object, "baseSlashCommands") &&
				offset.property.type === "Identifier" &&
				offset.property.name === "length"
			);
		};
		const previousSlashCommandTailIndices = refreshBody.flatMap((statement, index) =>
			isExpectedPreviousSlashCommandTail(statement) ? [index] : [],
		);
		const constructor = method("constructor");
		const refreshCommands = method("refreshSlashCommandState");
		const constructorBody = constructor?.body.body ?? [];
		const constructorExactCapabilityAssignments: Babel.AssignmentExpression[] = [];
		const constructorSessionCapabilityAssignments: Babel.AssignmentExpression[] = [];
		if (constructor) {
			traverse(interactiveMode, {
				AssignmentExpression(assignmentPath) {
					if (
						assignmentPath.findParent(parentPath => parentPath.node === constructor) &&
						thisPrivate(assignmentPath.node.left, "sessionBuiltinMcpVisible")
					) {
						constructorExactCapabilityAssignments.push(assignmentPath.node);
					}
					if (
						assignmentPath.findParent(parentPath => parentPath.node === constructor) &&
						thisPrivate(assignmentPath.node.left, "sessionBuiltinSessionMcpVisible")
					) {
						constructorSessionCapabilityAssignments.push(assignmentPath.node);
					}
				},
			});
		}
		const isSessionArgument = (node: Babel.Node | null | undefined, capability: string): boolean =>
			node?.type === "ConditionalExpression" &&
			((node.test.type === "MemberExpression" && thisPrivate(node.test, capability)) ||
				(node.test.type === "Identifier" && node.test.name === capability)) &&
			node.consequent.type === "MemberExpression" &&
			!node.consequent.computed &&
			node.consequent.object.type === "ThisExpression" &&
			node.consequent.property.type === "Identifier" &&
			node.consequent.property.name === "session" &&
			node.alternate.type === "Identifier" &&
			node.alternate.name === "undefined";
		const initSlashCommandsIndex = constructorBody.findIndex(
			statement =>
				statement.type === "VariableDeclaration" &&
				statement.kind === "const" &&
				statement.declarations.some(
					declaration =>
						declaration.id.type === "Identifier" &&
						declaration.id.name === "sessionBuiltinSlashCommands" &&
						declaration.init?.type === "CallExpression" &&
						declaration.init.callee.type === "Identifier" &&
						declaration.init.callee.name === "getBuiltinSlashCommandsForSession" &&
						declaration.init.arguments.length === 2 &&
						declaration.init.arguments[0]?.type === "MemberExpression" &&
						thisPrivate(declaration.init.arguments[0], "sessionBuiltinMcpVisible") &&
						isSessionArgument(declaration.init.arguments[1], "sessionBuiltinSessionMcpVisible"),
				),
		);
		const exactInitializationAssignmentIndex = constructorBody.findIndex(
			statement =>
				statement.type === "ExpressionStatement" &&
				statement.expression.type === "AssignmentExpression" &&
				constructorExactCapabilityAssignments.includes(statement.expression) &&
				statement.expression.operator === "=" &&
				thisPrivate(statement.expression.left, "sessionBuiltinMcpVisible") &&
				statement.expression.right.type === "MemberExpression" &&
				!statement.expression.right.computed &&
				statement.expression.right.object.type === "MemberExpression" &&
				!statement.expression.right.object.computed &&
				statement.expression.right.object.object.type === "ThisExpression" &&
				statement.expression.right.object.property.type === "Identifier" &&
				statement.expression.right.object.property.name === "session" &&
				statement.expression.right.property.type === "Identifier" &&
				statement.expression.right.property.name === "hasExactMcpControls",
		);
		const sessionInitializationAssignmentIndex = constructorBody.findIndex(
			statement =>
				statement.type === "ExpressionStatement" &&
				statement.expression.type === "AssignmentExpression" &&
				constructorSessionCapabilityAssignments.includes(statement.expression) &&
				statement.expression.operator === "=" &&
				thisPrivate(statement.expression.left, "sessionBuiltinSessionMcpVisible") &&
				statement.expression.right.type === "MemberExpression" &&
				!statement.expression.right.computed &&
				statement.expression.right.object.type === "MemberExpression" &&
				!statement.expression.right.object.computed &&
				statement.expression.right.object.object.type === "ThisExpression" &&
				statement.expression.right.object.property.type === "Identifier" &&
				statement.expression.right.object.property.name === "session" &&
				statement.expression.right.property.type === "Identifier" &&
				statement.expression.right.property.name === "hasSessionMcpControls",
		);
		const initialization =
			constructorExactCapabilityAssignments.length === 1 &&
			constructorSessionCapabilityAssignments.length === 1 &&
			exactInitializationAssignmentIndex >= 0 &&
			sessionInitializationAssignmentIndex >= 0 &&
			exactInitializationAssignmentIndex < sessionInitializationAssignmentIndex &&
			sessionInitializationAssignmentIndex < initSlashCommandsIndex;
		const baseSlashCommandsAssignments = constructorBody.filter(
			statement =>
				statement.type === "ExpressionStatement" &&
				statement.expression.type === "AssignmentExpression" &&
				thisPrivate(statement.expression.left, "baseSlashCommands"),
		);
		const baseSlashCommandsIndex = constructorBody.findIndex(statement => {
			if (
				baseSlashCommandsAssignments.length !== 1 ||
				statement.type !== "ExpressionStatement" ||
				statement.expression.type !== "AssignmentExpression" ||
				statement.expression.operator !== "=" ||
				!thisPrivate(statement.expression.left, "baseSlashCommands") ||
				statement.expression.right.type !== "ArrayExpression"
			) {
				return false;
			}
			const elements = statement.expression.right.elements;
			return (
				elements.length === 3 &&
				elements[0]?.type === "SpreadElement" &&
				elements[0].argument.type === "Identifier" &&
				elements[0].argument.name === "sessionBuiltinSlashCommands" &&
				elements[1]?.type === "SpreadElement" &&
				elements[1].argument.type === "Identifier" &&
				elements[1].argument.name === "hookCommands" &&
				elements[2]?.type === "SpreadElement" &&
				elements[2].argument.type === "Identifier" &&
				elements[2].argument.name === "customCommands"
			);
		});
		const initSlashCommands = initSlashCommandsIndex >= 0 && initSlashCommandsIndex < baseSlashCommandsIndex;
		const isCapabilitySnapshot = (statement: Babel.Statement | undefined, name: string): boolean =>
			statement?.type === "VariableDeclaration" &&
			statement.kind === "const" &&
			statement.declarations.length === 1 &&
			statement.declarations[0]?.id.type === "Identifier" &&
			statement.declarations[0].id.name === name &&
			statement.declarations[0].init?.type === "MemberExpression" &&
			!statement.declarations[0].init.computed &&
			statement.declarations[0].init.object.type === "MemberExpression" &&
			!statement.declarations[0].init.object.computed &&
			statement.declarations[0].init.object.object.type === "ThisExpression" &&
			statement.declarations[0].init.object.property.type === "Identifier" &&
			statement.declarations[0].init.object.property.name === "session" &&
			statement.declarations[0].init.property.type === "Identifier" &&
			statement.declarations[0].init.property.name === name;
		const capabilitySnapshotIsExact = isCapabilitySnapshot(refreshBody[0], "hasExactMcpControls");
		const capabilitySnapshotIsSession = isCapabilitySnapshot(refreshBody[1], "hasSessionMcpControls");
		const capabilityNoopGuard = refreshBody[2];
		const capabilityNoopReturn =
			capabilityNoopGuard?.type === "IfStatement" &&
			capabilityNoopGuard.alternate === null &&
			capabilityNoopGuard.test.type === "LogicalExpression" &&
			capabilityNoopGuard.test.operator === "&&" &&
			capabilityNoopGuard.test.left.type === "BinaryExpression" &&
			capabilityNoopGuard.test.left.operator === "===" &&
			capabilityNoopGuard.test.left.left.type === "Identifier" &&
			capabilityNoopGuard.test.left.left.name === "hasExactMcpControls" &&
			thisPrivate(capabilityNoopGuard.test.left.right, "sessionBuiltinMcpVisible") &&
			capabilityNoopGuard.test.right.type === "BinaryExpression" &&
			capabilityNoopGuard.test.right.operator === "===" &&
			capabilityNoopGuard.test.right.left.type === "Identifier" &&
			capabilityNoopGuard.test.right.left.name === "hasSessionMcpControls" &&
			thisPrivate(capabilityNoopGuard.test.right.right, "sessionBuiltinSessionMcpVisible") &&
			capabilityNoopGuard.consequent.type === "ReturnStatement" &&
			capabilityNoopGuard.consequent.argument === null
				? capabilityNoopGuard.consequent
				: undefined;
		const refreshCapabilityFlagIndex = refreshBody.findIndex(
			statement =>
				statement.type === "ExpressionStatement" &&
				statement.expression.type === "AssignmentExpression" &&
				statement.expression.operator === "=" &&
				thisPrivate(statement.expression.left, "sessionBuiltinMcpVisible") &&
				statement.expression.right.type === "Identifier" &&
				statement.expression.right.name === "hasExactMcpControls",
		);
		const refreshSessionCapabilityFlagIndex = refreshBody.findIndex(
			statement =>
				statement.type === "ExpressionStatement" &&
				statement.expression.type === "AssignmentExpression" &&
				statement.expression.operator === "=" &&
				thisPrivate(statement.expression.left, "sessionBuiltinSessionMcpVisible") &&
				statement.expression.right.type === "Identifier" &&
				statement.expression.right.name === "hasSessionMcpControls",
		);
		const rebuildSlashCommandsIndex = refreshBody.findIndex(
			statement => {
				if (
					statement.type !== "ExpressionStatement" ||
					statement.expression.type !== "AssignmentExpression" ||
					statement.expression.operator !== "=" ||
					!thisPrivate(statement.expression.left, "baseSlashCommands") ||
					statement.expression.right.type !== "ArrayExpression"
				) {
					return false;
				}
				const elements = statement.expression.right.elements;
				const sessionBuiltins = elements[0];
				return (
					elements.length === 2 &&
					builtinCommandNamesDeclarationIndices.length === 1 &&
					builtinCommandNamesDeclarationIndices[0]! < refreshBody.indexOf(statement) &&
					previousSlashCommandTailIndices.length === 1 &&
					previousSlashCommandTailIndices[0]! < refreshBody.indexOf(statement) &&
					sessionBuiltins?.type === "SpreadElement" &&
					sessionBuiltins.argument.type === "CallExpression" &&
					sessionBuiltins.argument.callee.type === "Identifier" &&
					sessionBuiltins.argument.callee.name === "getBuiltinSlashCommandsForSession" &&
					sessionBuiltins.argument.arguments.length === 2 &&
					sessionBuiltins.argument.arguments[0]?.type === "Identifier" &&
					sessionBuiltins.argument.arguments[0].name === "hasExactMcpControls" &&
					isSessionArgument(sessionBuiltins.argument.arguments[1], "hasSessionMcpControls") &&
					isExpectedBuiltinCommandNamesTail(elements[1])
				);
			},
		);
		const rebuildResolvedSlashCommandsIndex = refreshBody.findIndex(
			statement => {
				if (
					statement.type !== "ExpressionStatement" ||
					statement.expression.type !== "AssignmentExpression" ||
					statement.expression.operator !== "=" ||
					!thisPrivate(statement.expression.left, "resolvedSlashCommands") ||
					statement.expression.right.type !== "ArrayExpression"
				) {
					return false;
				}
				const elements = statement.expression.right.elements;
				const baseCommands = elements[0];
				const preservedTail = elements[1];
				return (
					elements.length === 2 &&
					previousSlashCommandTailIndices.length === 1 &&
					previousSlashCommandTailIndices[0]! < refreshBody.indexOf(statement) &&
					baseCommands?.type === "SpreadElement" &&
					thisPrivate(baseCommands.argument, "baseSlashCommands") &&
					preservedTail?.type === "SpreadElement" &&
					preservedTail.argument.type === "Identifier" &&
					preservedTail.argument.name === "previousSlashCommandTail"
				);
			},
		);
		const updateAutocompleteIndex = refreshBody.findIndex(
			statement =>
				statement.type === "ExpressionStatement" &&
				statement.expression.type === "CallExpression" &&
				statement.expression.callee.type === "MemberExpression" &&
				statement.expression.callee.property.type === "Identifier" &&
				statement.expression.callee.property.name === "setAutocompleteProvider" &&
				statement.expression.arguments.length === 1 &&
				statement.expression.arguments[0]?.type === "CallExpression" &&
				statement.expression.arguments[0].callee.type === "MemberExpression" &&
				statement.expression.arguments[0].callee.property.type === "Identifier" &&
				statement.expression.arguments[0].callee.property.name === "createAutocompleteProvider" &&
				statement.expression.arguments[0].arguments[0]?.type === "MemberExpression" &&
				thisPrivate(statement.expression.arguments[0].arguments[0], "resolvedSlashCommands"),
		);
		let hasUnexpectedRefreshExit = false;
		if (refreshHelper) {
			traverse(interactiveMode, {
				ReturnStatement(returnPath) {
					if (
						returnPath.getFunctionParent()?.node === refreshHelper &&
						returnPath.node !== capabilityNoopReturn
					) {
						hasUnexpectedRefreshExit = true;
					}
				},
				ThrowStatement(throwPath) {
					if (throwPath.getFunctionParent()?.node === refreshHelper) hasUnexpectedRefreshExit = true;
				},
			});
		}
		const refreshActionsAreReachable =
			refreshBody.length === 10 &&
			capabilitySnapshotIsExact &&
			capabilitySnapshotIsSession &&
			capabilityNoopReturn !== undefined &&
			!hasUnexpectedRefreshExit &&
			previousSlashCommandTailIndices.length === 1 &&
			previousSlashCommandTailIndices[0] === 3 &&
			builtinCommandNamesDeclarationIndices.length === 1 &&
			builtinCommandNamesDeclarationIndices[0] === 4 &&
			rebuildSlashCommandsIndex === 5 &&
			refreshCapabilityFlagIndex === 6 &&
			refreshSessionCapabilityFlagIndex === 7 &&
			rebuildResolvedSlashCommandsIndex === 8 &&
			updateAutocompleteIndex === 9;
		const refreshBodyStatements = refreshCommands?.body.body ?? [];
		const loadIndex = refreshBodyStatements.findIndex(
			statement =>
				statement.type === "VariableDeclaration" &&
				statement.declarations.some(
					declaration =>
						declaration.id.type === "Identifier" &&
						declaration.id.name === "fileCommands" &&
						declaration.init?.type === "AwaitExpression" &&
						declaration.init.argument.type === "CallExpression" &&
						declaration.init.argument.callee.type === "Identifier" &&
						declaration.init.argument.callee.name === "loadSlashCommands",
				),
		);
		const refreshIndices = refreshBodyStatements.flatMap((statement, index) =>
			statement.type === "ExpressionStatement" &&
			statement.expression.type === "CallExpression" &&
			thisPrivate(statement.expression.callee, "refreshSessionBuiltinSlashCommandVisibility")
				? [index]
				: [],
		);
		return filterIsSafe &&
			initialization &&
			initSlashCommands &&
			baseSlashCommandsIndex > initSlashCommandsIndex &&
			refreshActionsAreReachable &&
			loadIndex >= 0 &&
			refreshIndices.length >= 2 &&
			refreshIndices[0]! < loadIndex &&
			refreshIndices.at(-1)! > loadIndex
			? []
			: ["ordinary TUI /mcp metadata is not filtered by the exact MCP capability"];
	} catch {
		return ["ordinary TUI /mcp metadata is not filtered by the exact MCP capability"];
	}
}

async function verifyMcpQuarantine(): Promise<GateResult> {
	const codingPackage = await readJson("packages/coding-agent/package.json");
	const exportsRecord = isRecord(codingPackage.exports) ? codingPackage.exports : {};
	const mcpExportKeys = Object.keys(exportsRecord).filter(key => key === "./mcp" || key.startsWith("./mcp/") || key === "./runtime-mcp" || key.startsWith("./runtime-mcp/") || key === "./commands/gjc-runtime-bridge");
	const exposedMcpKeys = mcpExportKeys.filter(key => exportsRecord[key] !== null);
	const blockedMcpKeys = REQUIRED_PRIVATE_EXPORT_BLOCKS.filter(key => exportsRecord[key] === null);
	const missingPrivateBlocks = REQUIRED_PRIVATE_EXPORT_BLOCKS.filter(key => exportsRecord[key] !== null);
	const builtinRegistry = await readText("packages/coding-agent/src/slash-commands/builtin-registry.ts");
	const acpBuiltins = await readText("packages/coding-agent/src/slash-commands/acp-builtins.ts");
	const slashCommands = await readText("packages/coding-agent/src/extensibility/slash-commands.ts");
	const interactiveMode = await readText("packages/coding-agent/src/modes/interactive-mode.ts");
	// The root /mcp TUI entry is a supported control surface only for sessions
	// holding the exact MCP capability. Nested subcommands such as `/aside mcp`
	// and this guarded TUI command must not become default or ACP MCP access.
	const exposesMcpBuiltin = /^\t\tname:\s*["']mcp["']/m.test(builtinRegistry);
	const mcpBuiltinQuarantineFindings = findMcpBuiltinQuarantineFindings(builtinRegistry);
	const mcpTuiMetadataFindings = findMcpTuiMetadataFindings(slashCommands, interactiveMode);
	const importsMcpBuiltinHandler = builtinRegistry.includes("handleMcpAcp");
	const acpReferencesMcpHandler = acpBuiltins.includes("handleMcpAcp");
	const acpAdvertisesMcpCommand = /name:\s*["']mcp["']/.test(acpBuiltins);
	const exaProvider = await readText("packages/coding-agent/src/web/search/providers/exa.ts");
	const exaRequiresApiKey = exaProvider.includes("return !!getEnvApiKey(\"exa\")");
	const exaUsesPublicMcpFallback =
		exaProvider.includes("callExaMcpSearch") ||
		exaProvider.includes("callExaTool") ||
		exaProvider.includes("mcp.exa.ai") ||
		exaProvider.includes("../../../exa/mcp-client");
	const internalMcpPaths = [
		"packages/coding-agent/src/runtime-mcp",
		"packages/coding-agent/src/slash-commands/helpers/mcp.ts",
	];
	const presentInternalMcpPaths = internalMcpPaths.filter(relativePath => fs.existsSync(path.join(repoRoot, relativePath)));
	const publicDocFindings = await findPublicDocFindings();
	const exaMcpDocFindings = await findExaMcpDocFindings();
	const forbiddenImportFindings = await probeForbiddenPackageImports();
	const forbiddenSymbolFindings = await probeForbiddenPackageSymbols();
	const removedPublicDocsStillPresent = [
		"docs/mcp-config.md",
		"docs/mcp-runtime-lifecycle.md",
		"docs/mcp-server-tool-authoring.md",
		"docs/mcp-protocol-transports.md",
	].filter(relativePath => fs.existsSync(path.join(repoRoot, relativePath)));
	const details = [
		`exposed private package keys: ${exposedMcpKeys.join(", ") || "<none>"}`,
		`blocked private package keys: ${blockedMcpKeys.join(", ") || "<none>"}`,
		`missing private export blocks: ${missingPrivateBlocks.join(", ") || "<none>"}`,
		`root /mcp literal-name builtin registered: ${exposesMcpBuiltin}`,
		`root /mcp builtin restricted to exact-config TUI: ${exposesMcpBuiltin && mcpBuiltinQuarantineFindings.length === 0}`,
		`root /mcp builtin quarantine findings: ${mcpBuiltinQuarantineFindings.join(", ") || "<none>"}`,
		`ordinary TUI /mcp metadata findings: ${mcpTuiMetadataFindings.join(", ") || "<none>"}`,
		`default /mcp handler imported: ${importsMcpBuiltinHandler}`,
		`ACP /mcp command advertised: ${acpAdvertisesMcpCommand}`,
		`ACP MCP handler referenced: ${acpReferencesMcpHandler}`,
		`Exa search requires EXA_API_KEY: ${exaRequiresApiKey}`,
		`Exa public MCP fallback present: ${exaUsesPublicMcpFallback}`,
		`private MCP implementation paths retained: ${presentInternalMcpPaths.join(", ") || "<none>"}`,
		`public doc findings: ${publicDocFindings.join(", ") || "<none>"}`,
		`Exa MCP fallback doc findings: ${exaMcpDocFindings.join(", ") || "<none>"}`,
		`forbidden package imports still resolving: ${forbiddenImportFindings.join(", ") || "<none>"}`,
		`forbidden package symbols still exported: ${forbiddenSymbolFindings.join(", ") || "<none>"}`,
		`removed public MCP docs still present: ${removedPublicDocsStillPresent.join(", ") || "<none>"}`,
	];

	return {
		name: "MCP quarantine/no unrestricted default MCP access",
		passed:
			exposedMcpKeys.length === 0 &&
			missingPrivateBlocks.length === 0 &&
			forbiddenImportFindings.length === 0 &&
			forbiddenSymbolFindings.length === 0 &&
			publicDocFindings.length === 0 &&
			exaMcpDocFindings.length === 0 &&
			removedPublicDocsStillPresent.length === 0 &&
			mcpBuiltinQuarantineFindings.length === 0 &&
			mcpTuiMetadataFindings.length === 0 &&
			!importsMcpBuiltinHandler &&
			!acpAdvertisesMcpCommand &&
			!acpReferencesMcpHandler &&
			exaRequiresApiKey &&
			!exaUsesPublicMcpFallback,
		details,
	};
}


async function findPublicDocFindings(): Promise<string[]> {
	const findings: string[] = [];
	for (const relativePath of PUBLIC_DOC_FILES) {
		const text = await readText(relativePath);
		for (const pattern of FORBIDDEN_PUBLIC_DOC_PATTERNS) {
			if (pattern.test(text)) findings.push(`${relativePath}: ${pattern.source}`);
		}
	}
	return findings;
}

// Parse only the generator's literal format. Never import/evaluate the corpus:
// it contains unrelated MCP documentation, and executable source is not evidence.
export function parseEmbeddedDocs(source: string): Map<string, string> {
	const lines = source.split("\n");
	if (
		lines[0] !== "// Auto-generated by scripts/generate-docs-index.ts - DO NOT EDIT" ||
		lines[1] !== 'Reflect.set(globalThis, Symbol.for("gjc.docs-index.generated.loaded"), true);' ||
		lines[2] !== "" ||
		lines[4] !== "" ||
		lines[5] !== "export const EMBEDDED_DOCS: Readonly<Record<string, string>> = {" ||
		lines.at(-2) !== "};" ||
		lines.at(-1) !== ""
	) {
		throw new Error("unexpected generated docs format");
	}
	const filenamesMatch = /^export const EMBEDDED_DOC_FILENAMES: readonly string\[\] = (\[.*\]);$/u.exec(lines[3] ?? "");
	if (!filenamesMatch) throw new Error("missing embedded doc filenames");
	const filenames: unknown = JSON.parse(filenamesMatch[1]!);
	if (!Array.isArray(filenames) || !filenames.every(name => typeof name === "string")) {
		throw new Error("invalid embedded doc filenames");
	}
	const docs = new Map<string, string>();
	const jsonString = String.raw`"(?:[^"\\\r\n]|\\.)*"`;
	const entryPattern = new RegExp(`^\\t(${jsonString}): (${jsonString}),$`, "u");
	for (const line of lines.slice(6, -2)) {
		const entry = entryPattern.exec(line);
		if (!entry) throw new Error("invalid embedded doc entry");
		const key: string = JSON.parse(entry[1]!);
		const content: string = JSON.parse(entry[2]!);
		if (docs.has(key)) throw new Error(`duplicate embedded doc: ${key}`);
		docs.set(key, content);
	}
	if (!arraysEqual(filenames, [...docs.keys()])) throw new Error("embedded doc filenames do not match entries");
	return docs;
}

export async function findExaMcpDocFindings(readDoc: (relativePath: string) => Promise<string> = readText): Promise<string[]> {
	const findings: string[] = [];
	const inspect = (label: string, text: string): void => {
		for (const pattern of FORBIDDEN_EXA_MCP_DOC_PATTERNS) {
			if (pattern.test(text)) findings.push(`${label}: ${pattern.source}`);
		}
	};
	for (const relativePath of EXA_MCP_DOC_FILES) {
		inspect(relativePath, await readDoc(relativePath));
	}
	try {
		const docs = parseEmbeddedDocs(await readDoc(GENERATED_DOCS_INDEX));
		for (const relativePath of EXA_MCP_DOC_FILES) {
			const key = relativePath.replace(/^docs\//u, "");
			const text = docs.get(key);
			if (text !== undefined) {
				inspect(`${GENERATED_DOCS_INDEX}#${key}`, text);
			} else if (relativePath.startsWith("docs/")) {
				findings.push(`${GENERATED_DOCS_INDEX}: missing embedded doc ${key}`);
			}
		}
	} catch (error) {
		findings.push(`${GENERATED_DOCS_INDEX}: invalid corpus (${error instanceof Error ? error.message : String(error)})`);
	}
	return findings;
}

async function probeForbiddenPackageImports(): Promise<string[]> {
	const findings: string[] = [];
	for (const specifier of FORBIDDEN_PACKAGE_IMPORTS) {
		const proc = Bun.spawn({
			cmd: ["bun", "-e", `import(${JSON.stringify(specifier)}).then(() => process.exit(0)).catch(() => process.exit(1))`],
			cwd: repoRoot,
			stdout: "ignore",
			stderr: "ignore",
		});
		const exitCode = await proc.exited;
		if (exitCode === 0) findings.push(specifier);
	}
	return findings;
}

async function probeForbiddenPackageSymbols(): Promise<string[]> {
	const findings: string[] = [];
	for (const entry of FORBIDDEN_PACKAGE_SYMBOLS) {
		const source = [
			`const m = await import(${JSON.stringify(entry.specifier)});`,
			`const symbols = ${JSON.stringify(entry.symbols)};`,
			`const found = symbols.filter(symbol => Object.prototype.hasOwnProperty.call(m, symbol));`,
			`if (found.length > 0) { console.error(found.join(",")); process.exit(0); }`,
			`process.exit(1);`,
		].join("\n");
		const proc = Bun.spawn({
			cmd: ["bun", "-e", source],
			cwd: repoRoot,
			stdout: "ignore",
			stderr: "pipe",
		});
		const stderr = await new Response(proc.stderr).text();
		const exitCode = await proc.exited;
		if (exitCode === 0) findings.push(`${entry.specifier}: ${stderr.trim()}`);
	}
	return findings;
}

async function verifyLocalToolsPreserved(): Promise<GateResult> {
	const missing = REQUIRED_LOCAL_TOOL_FILES.filter(relativePath => !fs.existsSync(path.join(repoRoot, relativePath)));
	const toolRegistry = `${await readText("packages/coding-agent/src/tools/index.ts")}\n${await readText("packages/coding-agent/src/tools/descriptors.ts")}`;
	const requiredRegistryNames = ["read", "write", "edit", "bash", "find", "search", "ast_grep", "ast_edit"];
	const missingRegistryNames = requiredRegistryNames.filter(name => !toolRegistry.includes(`${name}:`));

	return {
		name: "inline/local tools preserved",
		passed: missing.length === 0 && missingRegistryNames.length === 0,
		details: [
			`required local tool files missing: ${missing.join(", ") || "<none>"}`,
			`required local tool registry entries missing: ${missingRegistryNames.join(", ") || "<none>"}`,
		],
	};
}

async function verifyRustBoundary(): Promise<GateResult> {
	const runRsTask = await readText("scripts/run-rs-task.ts");
	const hasScopeHook = runRsTask.includes('runCommand(["bun", "scripts/check-rust-scope.ts"])');
	const hasScopeScript = fs.existsSync(path.join(repoRoot, "scripts/check-rust-scope.ts"));
	return {
		name: "TS/Rust boundary",
		passed: hasScopeHook && hasScopeScript,
		details: [
			`scripts/check-rust-scope.ts present: ${hasScopeScript}`,
			`check:rs invokes Rust scope guard: ${hasScopeHook}`,
		],
	};
}

function listPackageJsonPaths(): string[] {
	const paths = ["package.json"];
	const packagesRoot = path.join(repoRoot, "packages");
	for (const entry of fs.readdirSync(packagesRoot, { withFileTypes: true })) {
		if (entry.isDirectory()) paths.push(path.join("packages", entry.name, "package.json"));
	}
	return paths.filter(relativePath => fs.existsSync(path.join(repoRoot, relativePath))).sort();
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

async function readJson(relativePath: string): Promise<Record<string, unknown>> {
	const text = await readText(relativePath);
	return JSON.parse(text) as Record<string, unknown>;
}

async function readText(relativePath: string): Promise<string> {
	return Bun.file(path.join(repoRoot, relativePath)).text();
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}
