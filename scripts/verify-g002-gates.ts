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

const repoRoot = path.join(import.meta.dir, "..");
const EXPECTED_DEFINITIONS = ["deep-interview", "ralplan", "team", "ultragoal"] as const;
const EXPECTED_ROLE_AGENTS = ["architect", "critic", "executor", "planner"] as const;
const EXPECTED_PUBLIC_PACKAGE_VERSION = "0.2.2";
const ALLOWED_PUBLIC_PACKAGE_VERSIONS = new Map<string, string>();
const ALLOWED_PRIVATE_PACKAGE_VERSIONS = new Map<string, string>([["@gajae-code/typescript-edit-benchmark", "0.0.1"]]);
const ALLOWED_UNSCOPED_PACKAGE_NAMES = new Set<string>(["gajae-code"]);
const ALLOWED_PACKAGE_BINARIES = new Map<string, readonly string[]>([
	["@gajae-code/ai", ["pi-ai"]],
	["@gajae-code/coding-agent", ["gjc"]],
	["gajae-code", ["gjc"]],
	["@gajae-code/stats", ["gjc-stats"]],
	["@gajae-code/swarm-extension", ["gjc-swarm"]],
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
	...LEGACY_NAME_PATTERNS,
	/MCP/u,
	/\/mcp/u,
	/mcp-config/u,
	/mcp-server/u,
];
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
	"./autoresearch",
	"./autoresearch/*",
	"./autoresearch/tools/*",
	"./commands/autoresearch",
	"./commands/ralph",
	"./commands/ultraqa",
	"./commands/ultrawork",
	"./commands/performance-goal",
] as const;
const FORBIDDEN_WORKFLOW_SURFACE_TOKENS = [
	"autopilot",
	"autoresearch",
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


async function verifyPackageVersionAndBinaryAllowlist(): Promise<GateResult> {
	const packagePaths = listPackageJsonPaths();
	const versionFindings: string[] = [];
	const nameFindings: string[] = [];
	const binaryFindings: string[] = [];

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
			isPrivate && allowedPrivateVersion
				? allowedPrivateVersion
				: allowedPublicVersion ?? EXPECTED_PUBLIC_PACKAGE_VERSION;
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
	if (cargoVersion !== EXPECTED_PUBLIC_PACKAGE_VERSION) {
		versionFindings.push(`Cargo.toml workspace.package version ${cargoVersion} != ${EXPECTED_PUBLIC_PACKAGE_VERSION}`);
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

async function verifyMcpQuarantine(): Promise<GateResult> {
	const codingPackage = await readJson("packages/coding-agent/package.json");
	const exportsRecord = isRecord(codingPackage.exports) ? codingPackage.exports : {};
	const mcpExportKeys = Object.keys(exportsRecord).filter(key => key === "./mcp" || key.startsWith("./mcp/") || key === "./runtime-mcp" || key.startsWith("./runtime-mcp/") || key === "./commands/gjc-runtime-bridge");
	const exposedMcpKeys = mcpExportKeys.filter(key => exportsRecord[key] !== null);
	const blockedMcpKeys = REQUIRED_PRIVATE_EXPORT_BLOCKS.filter(key => exportsRecord[key] === null);
	const missingPrivateBlocks = REQUIRED_PRIVATE_EXPORT_BLOCKS.filter(key => exportsRecord[key] !== null);
	const builtinRegistry = await readText("packages/coding-agent/src/slash-commands/builtin-registry.ts");
	const acpBuiltins = await readText("packages/coding-agent/src/slash-commands/acp-builtins.ts");
	const exposesMcpBuiltin = /name:\s*["']mcp["']/.test(builtinRegistry);
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
		`default /mcp builtin registered: ${exposesMcpBuiltin}`,
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
		name: "MCP quarantine/no default discoverable MCP",
		passed:
			exposedMcpKeys.length === 0 &&
			missingPrivateBlocks.length === 0 &&
			forbiddenImportFindings.length === 0 &&
			forbiddenSymbolFindings.length === 0 &&
			publicDocFindings.length === 0 &&
			exaMcpDocFindings.length === 0 &&
			removedPublicDocsStillPresent.length === 0 &&
			!exposesMcpBuiltin &&
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

async function findExaMcpDocFindings(): Promise<string[]> {
	const findings: string[] = [];
	const files = [
		"docs/tools/web_search.md",
		"docs/environment-variables.md",
		"README.md",
		"packages/coding-agent/src/internal-urls/docs-index.generated.ts",
	] as const;
	for (const relativePath of files) {
		const text = await readText(relativePath);
		for (const pattern of FORBIDDEN_EXA_MCP_DOC_PATTERNS) {
			if (pattern.test(text)) findings.push(`${relativePath}: ${pattern.source}`);
		}
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
	const toolIndex = await readText("packages/coding-agent/src/tools/index.ts");
	const requiredRegistryNames = ["read", "write", "edit", "bash", "find", "search", "ast_grep", "ast_edit"];
	const missingRegistryNames = requiredRegistryNames.filter(name => !toolIndex.includes(`${name}:`));

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
