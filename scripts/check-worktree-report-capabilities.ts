#!/usr/bin/env bun

import { parse } from "@babel/parser";
import traverse, { type NodePath, type Scope } from "@babel/traverse";
import * as t from "@babel/types";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export const RULES = {
	forbiddenImport: "WTR001_FORBIDDEN_IMPORT",
	forbiddenCall: "WTR002_FORBIDDEN_CALL",
	forbiddenMember: "WTR003_FORBIDDEN_MEMBER",
	unknownBinding: "WTR004_UNKNOWN_BINDING",
	registryEdge: "WTR005A_REGISTRY_FACTORY_EDGE",
	workerEdge: "WTR005B_VALID_RUN_WORKER_EDGE",
	dynamicImport: "WTR005C_DYNAMIC_IMPORT_FORBIDDEN",
	mutation: "WTR006_WRITE_OR_MUTATION",
	process: "WTR007_UNAPPROVED_PROCESS",
	getterTiming: "WTR008_FACTORY_GETTER_TIMING",
	scannerApi: "WTR009_SCANNER_API",
	dirsBaseline: "WTR010_BASELINE_DIRS_EDGE",
} as const;

export interface Finding {
	path: string;
	line: number;
	column: number;
	rule: string;
	symbol: string;
}

export interface VerifyOptions {
	repoRoot?: string;
	roots?: string[];
	graphRoot?: string;
}

type Role = "cli" | "command" | "worker" | "scanner" | "fixture";
interface Origin {
	source: string;
	name: string;
}

const DEFAULT_ROOTS = [
	"packages/coding-agent/src/cli.ts",
	"packages/coding-agent/src/commands/worktree.ts",
	"packages/coding-agent/src/cli/worktree-cli.ts",
	"packages/coding-agent/src/cli/worktree-scanner.ts",
];
const CLI_STATIC_IMPORTS: Readonly<Record<string, ReadonlySet<string>>> = {
	"@gajae-code/utils/postmortem": new Set(),
	"@gajae-code/utils/cli": new Set(["Args", "CliConfig", "Command", "CommandEntry", "Flags", "run"]),
	"@gajae-code/utils/dirs": new Set([
		"APP_NAME",
		"formatBunRuntimeError",
		"getWorktreesDir",
		"MIN_BUN_VERSION",
		"VERSION",
	]),
	"./cli/fixture-report": new Set(["runFixtureReport"]),
	"./gjc-runtime/tmux-owner-isolation-cli": new Set([
		"isTmuxOwnerIsolationCliArgv",
		"runTmuxOwnerIsolationCliFromStdin",
	]),
};
const CLI_DEFAULT_COMMAND_IMPORTS = new Set([
	"./commands/codex-native-hook",
	"./commands/state",
	"./commands/setup",
	"./commands/acp",
	"./commands/skills",
	"./commands/session",
	"./commands/harness",
	"./commands/coordinator",
	"./commands/team",
	"./commands/ultragoal",
	"./commands/gc",
	"./commands/ralplan",
	"./commands/config",
	"./commands/stats",
	"./commands/notify",
	"./commands/sdk",
	"./commands/daemon",
	"./commands/web-search",
	"./commands/local-provider",
	"./commands/mcp-serve",
	"./commands/mcp",
	"./commands/contribution-prep",
	"./commands/deep-interview",
	"./commands/migrate",
	"./commands/rlm",
	"./commands/update",
	"./commands/plugin",
	"./commands/completion",
	"./commands/launch",
]);
interface DynamicImportBaseline {
	count: number;
	signature: string;
}
const CLI_DYNAMIC_IMPORT_BASELINE: ReadonlyMap<string, DynamicImportBaseline> = new Map([
	["@gajae-code/utils/cli", { count: 2, signature: "destructure:renderRootHelp" }],
	["./cli/fast-help", { count: 2, signature: "destructure:getExtraHelpText" }],
	["@gajae-code/ai/utils/h2-fetch", { count: 1, signature: "destructure:installH2Fetch" }],
	["./cli/nofile-limit", { count: 1, signature: "destructure:warnIfMacOSNoFileLimitTooLow" }],
	["./cli/notify-cli", { count: 1, signature: "destructure:parseNotifyArgs,runNotifyCommand" }],
	["./sdk/bus/chat-daemon-cli", { count: 1, signature: "destructure:runChatDaemonInternal" }],
	["@gajae-code/stats", { count: 1, signature: "destructure:smokeTestSyncWorker" }],
	[
		"@gajae-code/natives",
		{
			count: 1,
			signature: "destructure:h01FindBestFuzzyMatch,h02ScoreSequenceFuzzy,h06FormatHashLines",
		},
	],
	["./cli/malloc-env-guard", { count: 1, signature: "destructure:reexecWithScrubbedMallocEnv" }],
]);
const SCANNER_FS_PROMISES = new Set(["FileHandle", "lstat", "open", "readdir"]);
const SCANNER_FS = new Set(["BigIntStats", "constants"]);
const MUTATING_MEMBERS = new Set([
	"appendFile",
	"appendFileSync",
	"chmod",
	"copyFile",
	"copyFileSync",
	"exec",
	"execFile",
	"fork",
	"mkdir",
	"mkdirSync",
	"prune",
	"rename",
	"renameSync",
	"rm",
	"rmSync",
	"rmdir",
	"rmdirSync",
	"spawn",
	"truncate",
	"unlink",
	"unlinkSync",
	"write",
	"writeFile",
	"writeFileSync",
	"writev",
]);
const FORBIDDEN_SCANNER_MEMBERS = new Set([
	"close",
	"opendir",
	"opendirSync",
	"read",
	"readFile",
	"readFileSync",
	"realpath",
	"realpathSync",
	"stat",
	"statSync",
	"write",
	"writeFile",
	"writev",
]);
const REFLECTIVE_MEMBERS = new Set([
	"constructor",
	"prototype",
	"__proto__",
	"__defineGetter__",
	"__defineSetter__",
	"__lookupGetter__",
	"__lookupSetter__",
]);
const SCANNER_PATH_CALLS = new Set(["dirname", "isAbsolute", "join", "normalize", "relative"]);
const SCANNER_PATH_MEMBERS = new Set(["sep"]);
const SAFE_GLOBAL_MEMBERS: Readonly<Record<string, ReadonlySet<string>>> = {
	Buffer: new Set(["alloc", "allocUnsafe", "byteLength", "from", "isBuffer"]),
	JSON: new Set(["stringify"]),
	Math: new Set(["min"]),
	Promise: new Set(["resolve"]),
	String: new Set(["fromCharCode"]),
};
const SAFE_GLOBAL_CONSTRUCTORS = new Set(["Error", "Map", "Set", "TextDecoder"]);

function rootIdentifier(expression: t.Expression | t.Super): t.Identifier | undefined {
	let current: t.Expression | t.Super = expression;
	while (t.isMemberExpression(current) || t.isOptionalMemberExpression(current)) current = current.object;
	return t.isIdentifier(current) ? current : undefined;
}

function roleFor(relativePath: string): Role {
	if (relativePath === "packages/coding-agent/src/cli.ts") return "cli";
	if (relativePath === "packages/coding-agent/src/commands/worktree.ts") return "command";
	if (relativePath === "packages/coding-agent/src/cli/worktree-cli.ts") return "worker";
	if (relativePath === "packages/coding-agent/src/cli/worktree-scanner.ts") return "scanner";
	if (relativePath.endsWith("/fixtures/worktree-report-capabilities/allowed.ts")) return "scanner";
	return "fixture";
}
function isCommandRunPath(pathNode: NodePath<t.Node>): boolean {
	const functionNode = pathNode.getFunctionParent()?.node;
	return t.isClassMethod(functionNode) && !functionNode.computed && t.isIdentifier(functionNode.key, { name: "run" });
}

function location(node: t.Node): { line: number; column: number } {
	return {
		line: node.loc?.start.line ?? 1,
		column: (node.loc?.start.column ?? 0) + 1,
	};
}

function addFinding(findings: Finding[], file: string, node: t.Node, rule: string, symbol: string): void {
	const { line, column } = location(node);
	findings.push({ path: file, line, column, rule, symbol });
}

function parseSource(source: string): t.File | undefined {
	try {
		return parse(source, {
			sourceType: "module",
			plugins: ["typescript", "importAttributes", "dynamicImport", "classProperties", "topLevelAwait"],
		});
	} catch {
		return undefined;
	}
}

function importedName(specifier: t.ImportSpecifier | t.ImportDefaultSpecifier | t.ImportNamespaceSpecifier): string {
	if (t.isImportDefaultSpecifier(specifier)) return "default";
	if (t.isImportNamespaceSpecifier(specifier)) return "namespace";
	return t.isIdentifier(specifier.imported) ? specifier.imported.name : specifier.imported.value;
}

function bindingOrigin(scope: Scope, name: string, seen = new Set<t.Node>()): Origin | undefined {
	const binding = scope.getBinding(name);
	if (!binding || seen.has(binding.path.node)) return undefined;
	seen.add(binding.path.node);
	const node = binding.path.node;
	if (t.isImportSpecifier(node) || t.isImportDefaultSpecifier(node) || t.isImportNamespaceSpecifier(node)) {
		const declaration = binding.path.parent;
		return t.isImportDeclaration(declaration)
			? { source: declaration.source.value, name: importedName(node) }
			: undefined;
	}
	if (!t.isVariableDeclarator(node) || !node.init) return undefined;
	const init = unwrapTransparentExpression(node.init);
	if (t.isIdentifier(init)) return bindingOrigin(binding.path.scope, init.name, seen);
	if (t.isMemberExpression(init) && !init.computed && t.isIdentifier(init.object)) {
		const object = bindingOrigin(binding.path.scope, init.object.name, seen);
		const name = memberName(init);
		return object?.name === "namespace" && name ? { source: object.source, name } : undefined;
	}
	return undefined;
}

function unwrapTransparentExpression(node: t.Node | null | undefined): t.Node | undefined {
	let current = node ?? undefined;
	while (
		current &&
		(t.isTSAsExpression(current) ||
			t.isTSTypeAssertion(current) ||
			t.isTSNonNullExpression(current) ||
			t.isTypeCastExpression(current) ||
			t.isParenthesizedExpression(current) ||
			t.isTSSatisfiesExpression(current))
	) {
		current = current.expression;
	}
	return current;
}

function scopedExpressionOrigin(expression: t.Node | null | undefined, scope: Scope): Origin | undefined {
	const unwrapped = unwrapTransparentExpression(expression);
	if (t.isIdentifier(unwrapped)) return bindingOrigin(scope, unwrapped.name);
	if (!t.isMemberExpression(unwrapped)) return undefined;
	const object = scopedExpressionOrigin(unwrapped.object, scope);
	const name = memberName(unwrapped);
	return object && name ? { source: object.source, name } : undefined;
}

type OpenFlag = "O_RDONLY" | "O_NOFOLLOW" | "O_NONBLOCK";

function openFlag(expression: t.Node | null | undefined, scope: Scope, expected: OpenFlag): boolean {
	if (!t.isMemberExpression(expression) || expression.computed) return false;
	if (!t.isIdentifier(expression.object, { name: "constants" })) return false;
	if (!t.isIdentifier(expression.property, { name: expected })) return false;
	const origin = bindingOrigin(scope, "constants");
	return origin?.source === "node:fs" && origin.name === "constants";
}

function isReadonlyOpenFlags(expression: t.Node | null | undefined, scope: Scope): boolean {
	if (!t.isBinaryExpression(expression, { operator: "|" })) return false;
	if (!t.isBinaryExpression(expression.left, { operator: "|" })) return false;
	return (
		openFlag(expression.left.left, scope, "O_RDONLY") &&
		openFlag(expression.left.right, scope, "O_NOFOLLOW") &&
		openFlag(expression.right, scope, "O_NONBLOCK")
	);
}

function staticImportSource(call: t.CallExpression): string | undefined {
	if (!t.isImport(call.callee) || call.arguments.length !== 1) return undefined;
	const argument = call.arguments[0];
	return t.isStringLiteral(argument) ? argument.value : undefined;
}

function staticStringValue(node: t.Node | null | undefined): string | undefined {
	if (t.isStringLiteral(node)) return node.value;
	if (t.isTemplateLiteral(node) && node.expressions.length === 0) return node.quasis[0]?.value.cooked ?? undefined;
	if (t.isBinaryExpression(node, { operator: "+" })) {
		const left = staticStringValue(node.left);
		const right = staticStringValue(node.right);
		if (left !== undefined && right !== undefined) return left + right;
	}
	return undefined;
}

function memberName(member: t.MemberExpression | t.OptionalMemberExpression): string | undefined {
	if (member.computed) return staticStringValue(member.property);
	return t.isIdentifier(member.property) ? member.property.name : undefined;
}

function isAllowedScannerImport(statement: t.ImportDeclaration): boolean {
	if (statement.source.value === "node:path") {
		return statement.specifiers.length === 1 && t.isImportNamespaceSpecifier(statement.specifiers[0]);
	}
	const allowed = statement.source.value === "node:fs" ? SCANNER_FS : SCANNER_FS_PROMISES;
	if (statement.source.value !== "node:fs" && statement.source.value !== "node:fs/promises") return false;
	return statement.specifiers.every((specifier) => {
		if (!t.isImportSpecifier(specifier)) return false;
		const name = importedName(specifier);
		return allowed.has(name) && specifier.local.name === name;
	});
}

function isAllowedCommandImport(statement: t.ImportDeclaration): boolean {
	if (statement.source.value !== "@gajae-code/utils/cli") return false;
	const allowed = new Set(["Args", "Command", "CommandCtor", "Flags"]);
	return statement.specifiers.every((specifier) => {
		if (!t.isImportSpecifier(specifier)) return false;
		const name = importedName(specifier);
		return allowed.has(name) && specifier.local.name === name;
	});
}

function isAllowedWorkerImport(statement: t.ImportDeclaration): boolean {
	if (statement.source.value !== "./worktree-scanner") return false;
	const allowed = new Set(["scanWorktrees", "WorktreeDiagnostic", "WorktreeScannerPlatform", "WorktreeRootError"]);
	return statement.specifiers.every((specifier) => {
		if (!t.isImportSpecifier(specifier)) return false;
		const name = importedName(specifier);
		return allowed.has(name) && specifier.local.name === name;
	});
}
function exactNamedImports(statement: t.ImportDeclaration, expected: ReadonlySet<string>): boolean {
	if (statement.specifiers.length !== expected.size) return false;
	const actual = new Set<string>();
	for (const specifier of statement.specifiers) {
		if (!t.isImportSpecifier(specifier)) return false;
		const name = importedName(specifier);
		if (specifier.local.name !== name) return false;
		actual.add(name);
	}
	return actual.size === expected.size && [...expected].every((name) => actual.has(name));
}

function validateImports(ast: t.File, file: string, role: Role, findings: Finding[]): void {
	if (role === "cli") {
		const seen = new Set<string>();
		for (const statement of ast.program.body) {
			if (t.isExportAllDeclaration(statement) || (t.isExportNamedDeclaration(statement) && statement.source)) {
				addFinding(findings, file, statement, RULES.unknownBinding, "cli-reexport");
				continue;
			}
			if (!t.isImportDeclaration(statement)) continue;
			const source = statement.source.value;
			const expected = CLI_STATIC_IMPORTS[source];
			const valid = expected !== undefined && !seen.has(source) && exactNamedImports(statement, expected);
			if (!valid) {
				const rule = source === "@gajae-code/utils/dirs" ? RULES.dirsBaseline : RULES.forbiddenImport;
				addFinding(findings, file, statement, rule, source);
			}
			seen.add(source);
		}
		for (const source of Object.keys(CLI_STATIC_IMPORTS)) {
			if (!seen.has(source))
				addFinding(
					findings,
					file,
					ast.program,
					source === "@gajae-code/utils/dirs" ? RULES.dirsBaseline : RULES.forbiddenImport,
					`missing:${source}`,
				);
		}
		return;
	}
	for (const statement of ast.program.body) {
		if (t.isExportAllDeclaration(statement) || (t.isExportNamedDeclaration(statement) && statement.source)) {
			addFinding(findings, file, statement, RULES.unknownBinding, "reexport");
			continue;
		}
		if (!t.isImportDeclaration(statement)) continue;
		const allowed =
			role === "scanner"
				? isAllowedScannerImport(statement)
				: role === "command"
					? isAllowedCommandImport(statement)
					: role === "worker"
						? isAllowedWorkerImport(statement)
						: false;
		if (!allowed) {
			const rule = statement.source.value.includes("dirs") ? RULES.dirsBaseline : RULES.forbiddenImport;
			addFinding(findings, file, statement, rule, statement.source.value);
		}
	}
}

function findAuthoritativeRegistryEntry(ast: t.File): t.ObjectExpression[] {
	const entries: t.ObjectExpression[] = [];
	for (const statement of ast.program.body) {
		if (!t.isExportNamedDeclaration(statement) || !t.isVariableDeclaration(statement.declaration)) continue;
		for (const declaration of statement.declaration.declarations) {
			if (!t.isIdentifier(declaration.id, { name: "commands" }) || !t.isArrayExpression(declaration.init)) continue;
			for (const element of declaration.init.elements) {
				if (!t.isObjectExpression(element)) continue;
				const name = element.properties.find(
					(property) =>
						t.isObjectProperty(property) &&
						!property.computed &&
						((t.isIdentifier(property.key) && property.key.name === "name") ||
							(t.isStringLiteral(property.key) && property.key.value === "name")),
				);
				if (t.isObjectProperty(name) && t.isStringLiteral(name.value) && name.value.value === "worktree")
					entries.push(element);
			}
		}
	}
	return entries;
}

function validateRegistry(ast: t.File, file: string, findings: Finding[]): void {
	const entries = findAuthoritativeRegistryEntry(ast);
	if (entries.length !== 1) {
		addFinding(findings, file, ast.program, RULES.registryEdge, `count:${entries.length}`);
		return;
	}
	const entry = entries[0]!;
	const aliases = entry.properties.find(
		(property) =>
			t.isObjectProperty(property) &&
			!property.computed &&
			((t.isIdentifier(property.key) && property.key.name === "aliases") ||
				(t.isStringLiteral(property.key) && property.key.value === "aliases")),
	);
	const exactAliases =
		t.isObjectProperty(aliases) &&
		t.isArrayExpression(aliases.value) &&
		aliases.value.elements.length === 1 &&
		t.isStringLiteral(aliases.value.elements[0], { value: "wt" });
	const exactEntry = entry.properties.length === 3 && exactAliases;
	const load = entry.properties.find(
		(property) =>
			(t.isObjectProperty(property) || t.isObjectMethod(property)) &&
			!property.computed &&
			((t.isIdentifier(property.key) && property.key.name === "load") ||
				(t.isStringLiteral(property.key) && property.key.value === "load")),
	);
	const loadFunction = t.isObjectProperty(load) && t.isArrowFunctionExpression(load.value) ? load.value : undefined;
	const body = loadFunction?.body;
	if (
		!exactEntry ||
		!loadFunction?.async ||
		loadFunction.params.length !== 0 ||
		!t.isBlockStatement(body) ||
		body.body.length !== 2
	) {
		addFinding(findings, file, load ?? entry, RULES.registryEdge, "load-shape");
		return;
	}
	const declaration = body.body[0];
	const returned = body.body[1];
	const declarator =
		t.isVariableDeclaration(declaration) && declaration.kind === "const" && declaration.declarations.length === 1
			? declaration.declarations[0]
			: undefined;
	const awaited = declarator && t.isAwaitExpression(declarator.init) ? declarator.init.argument : undefined;
	const source = t.isCallExpression(awaited) ? staticImportSource(awaited) : undefined;
	const selected = declarator?.id;
	const exactSelection =
		t.isObjectPattern(selected) &&
		selected.properties.length === 1 &&
		t.isObjectProperty(selected.properties[0]) &&
		!selected.properties[0].computed &&
		t.isIdentifier(selected.properties[0].key, {
			name: "createWorktreeCommand",
		}) &&
		t.isIdentifier(selected.properties[0].value, {
			name: "createWorktreeCommand",
		});
	const call = t.isReturnStatement(returned) && t.isCallExpression(returned.argument) ? returned.argument : undefined;
	const exactCall =
		call &&
		t.isIdentifier(call.callee, { name: "createWorktreeCommand" }) &&
		call.arguments.length === 1 &&
		t.isIdentifier(call.arguments[0], { name: "getWorktreesDir" });
	if (source !== "./commands/worktree" || !exactSelection || !exactCall) {
		addFinding(findings, file, load ?? entry, RULES.registryEdge, "load-contract");
	}
	let edgeCount = 0;
	traverse(ast, {
		CallExpression(pathNode) {
			if (staticImportSource(pathNode.node) === "./commands/worktree") edgeCount += 1;
		},
	});
	if (edgeCount !== 1) addFinding(findings, file, entry, RULES.dynamicImport, `registry-count:${edgeCount}`);
}

function namedInitializer(statements: readonly t.Statement[], name: string): t.Expression | null | undefined {
	for (const statement of statements) {
		if (!t.isVariableDeclaration(statement) || statement.kind !== "const") continue;
		for (const declaration of statement.declarations) {
			if (t.isIdentifier(declaration.id, { name })) return declaration.init;
		}
	}
	return undefined;
}

function isMemberOf(expression: t.Node | null | undefined, object: string, property: string): boolean {
	return (
		t.isMemberExpression(expression) &&
		t.isIdentifier(expression.object, { name: object }) &&
		memberName(expression) === property
	);
}

function isCoalescedFlag(expression: t.Node | null | undefined, property: string): boolean {
	return (
		t.isLogicalExpression(expression, { operator: "??" }) &&
		isMemberOf(expression.left, "flags", property) &&
		t.isBooleanLiteral(expression.right, { value: false })
	);
}

function isActionSelection(expression: t.Node | null | undefined): boolean {
	return (
		t.isConditionalExpression(expression) &&
		t.isBinaryExpression(expression.test, { operator: "===" }) &&
		isMemberOf(expression.test.left, "args", "action") &&
		t.isStringLiteral(expression.test.right, { value: "clear" }) &&
		t.isStringLiteral(expression.consequent, { value: "clear" }) &&
		t.isStringLiteral(expression.alternate, { value: "list" })
	);
}

function isNegatedIdentifier(expression: t.Node | null | undefined, name: string): boolean {
	return t.isUnaryExpression(expression, { operator: "!" }) && t.isIdentifier(expression.argument, { name });
}

function isActionComparison(expression: t.Node | null | undefined, value: string): boolean {
	return (
		t.isBinaryExpression(expression, { operator: "===" }) &&
		t.isIdentifier(expression.left, { name: "action" }) &&
		t.isStringLiteral(expression.right, { value })
	);
}
function isValidPositionals(expression: t.Node | null | undefined): boolean {
	return (
		t.isLogicalExpression(expression, { operator: "&&" }) &&
		t.isBinaryExpression(expression.left, { operator: "<=" }) &&
		isMemberOf(expression.left.left, "argv", "length") &&
		t.isNumericLiteral(expression.left.right, { value: 1 }) &&
		t.isLogicalExpression(expression.right, { operator: "||" }) &&
		t.isBinaryExpression(expression.right.left, { operator: "===" }) &&
		isMemberOf(expression.right.left.left, "argv", "length") &&
		t.isNumericLiteral(expression.right.left.right, { value: 0 }) &&
		t.isBinaryExpression(expression.right.right, { operator: "===" }) &&
		t.isMemberExpression(expression.right.right.left) &&
		expression.right.right.left.computed &&
		t.isIdentifier(expression.right.right.left.object, { name: "argv" }) &&
		t.isNumericLiteral(expression.right.right.left.property, { value: 0 }) &&
		t.isIdentifier(expression.right.right.right, { name: "action" })
	);
}

function isValidSelection(expression: t.Node | null | undefined): boolean {
	if (!t.isLogicalExpression(expression, { operator: "&&" })) return false;
	const right = expression.right;
	return (
		t.isIdentifier(expression.left, { name: "validPositionals" }) &&
		t.isLogicalExpression(right, { operator: "||" }) &&
		t.isLogicalExpression(right.left, { operator: "&&" }) &&
		isActionComparison(right.left.left, "clear") &&
		isNegatedIdentifier(right.left.right, "all") &&
		t.isLogicalExpression(right.right, { operator: "&&" }) &&
		t.isLogicalExpression(right.right.left, { operator: "&&" }) &&
		isActionComparison(right.right.left.left, "list") &&
		isNegatedIdentifier(right.right.left.right, "all") &&
		isNegatedIdentifier(right.right.right, "dryRun")
	);
}

function callUsesBinding(ast: t.File, call: t.CallExpression, identifier: t.Identifier): boolean {
	let matches = false;
	traverse(ast, {
		CallExpression(pathNode) {
			if (pathNode.node !== call || !t.isIdentifier(pathNode.node.callee)) return;
			matches = pathNode.scope.getBinding(pathNode.node.callee.name)?.identifier === identifier;
		},
	});
	return matches;
}
function bindingReferencedOnlyByCall(ast: t.File, call: t.CallExpression, identifier: t.Identifier): boolean {
	let matches = false;
	traverse(ast, {
		CallExpression(pathNode) {
			if (pathNode.node !== call || !t.isIdentifier(pathNode.node.callee)) return;
			const binding = pathNode.scope.getBinding(pathNode.node.callee.name);
			matches =
				binding?.identifier === identifier &&
				binding.referencePaths.length === 1 &&
				binding.referencePaths[0]?.node === pathNode.node.callee;
		},
	});
	return matches;
}
function callUsesUnboundIdentifier(ast: t.File, call: t.CallExpression, name: string): boolean {
	let unbound = false;
	traverse(ast, {
		CallExpression(pathNode) {
			if (pathNode.node === call) unbound = pathNode.scope.getBinding(name) === undefined;
		},
	});
	return unbound;
}

function countCallsUsingBinding(ast: t.File, functionNode: t.Function, identifier: t.Identifier): number {
	let count = 0;
	traverse(ast, {
		CallExpression(pathNode) {
			if (
				pathNode.getFunctionParent()?.node === functionNode &&
				t.isIdentifier(pathNode.node.callee) &&
				pathNode.scope.getBinding(pathNode.node.callee.name)?.identifier === identifier
			)
				count++;
		},
	});
	return count;
}
function hasBindingAlias(ast: t.File, functionNode: t.Function, identifier: t.Identifier): boolean {
	let aliased = false;
	traverse(ast, {
		VariableDeclarator(pathNode) {
			if (
				pathNode.getFunctionParent()?.node === functionNode &&
				t.isIdentifier(pathNode.node.init) &&
				pathNode.scope.getBinding(pathNode.node.init.name)?.identifier === identifier
			)
				aliased = true;
		},
	});
	return aliased;
}
function assignmentTargetContainsName(node: t.Node | null | undefined, names: ReadonlySet<string>): boolean {
	if (!node) return false;
	if (t.isIdentifier(node)) return names.has(node.name);
	if (t.isAssignmentPattern(node)) return assignmentTargetContainsName(node.left, names);
	if (t.isRestElement(node)) return assignmentTargetContainsName(node.argument, names);
	if (t.isArrayPattern(node)) return node.elements.some((element) => assignmentTargetContainsName(element, names));
	if (t.isObjectPattern(node))
		return node.properties.some((property) =>
			t.isRestElement(property)
				? assignmentTargetContainsName(property.argument, names)
				: assignmentTargetContainsName(property.value, names),
		);
	if (t.isVariableDeclaration(node))
		return node.declarations.some((declaration) => assignmentTargetContainsName(declaration.id, names));
	if (
		t.isTSAsExpression(node) ||
		t.isTSTypeAssertion(node) ||
		t.isTypeCastExpression(node) ||
		t.isTSNonNullExpression(node) ||
		t.isTSSatisfiesExpression(node)
	)
		return assignmentTargetContainsName(node.expression, names);
	return false;
}

function hasIdentifierMutation(ast: t.File, names: ReadonlySet<string>): boolean {
	let mutated = false;
	traverse(ast, {
		AssignmentExpression(pathNode) {
			if (assignmentTargetContainsName(pathNode.node.left, names)) mutated = true;
		},
		UpdateExpression(pathNode) {
			if (t.isIdentifier(pathNode.node.argument) && names.has(pathNode.node.argument.name)) mutated = true;
		},
		ForOfStatement(pathNode) {
			if (assignmentTargetContainsName(pathNode.node.left, names)) mutated = true;
		},
		ForInStatement(pathNode) {
			if (assignmentTargetContainsName(pathNode.node.left, names)) mutated = true;
		},
	});
	return mutated;
}

function validateScannerCapabilityBindings(ast: t.File, file: string, findings: Finding[]): void {
	let openBinding: Scope["bindings"][string] | undefined;
	let constantsBinding: Scope["bindings"][string] | undefined;
	traverse(ast, {
		ImportSpecifier(pathNode) {
			const declaration = pathNode.parentPath.node;
			if (!t.isImportDeclaration(declaration) || declaration.importKind === "type" || pathNode.node.importKind === "type") return;
			const imported = importedName(pathNode.node);
			const source = declaration.source.value;
			if (source === "node:fs/promises" && imported === "open")
				openBinding = pathNode.scope.getBinding(pathNode.node.local.name);
			if (source === "node:fs" && imported === "constants")
				constantsBinding = pathNode.scope.getBinding(pathNode.node.local.name);
		},
	});
	const mutationTarget = (
		node: t.Node | null | undefined,
		scope: Scope,
	): { open: boolean; member: boolean } => {
		if (!node) return { open: false, member: false };
		const unwrapped = unwrapTransparentExpression(node);
		if (unwrapped !== node) return mutationTarget(unwrapped, scope);
		if (t.isIdentifier(node)) {
			const binding = scope.getBinding(node.name);
			const origin = bindingOrigin(scope, node.name);
			return {
				open:
					binding === openBinding ||
					(origin?.source === "node:fs/promises" && origin.name === "open") ||
					binding === constantsBinding ||
					(origin?.source === "node:fs" && origin.name === "constants"),
				member:
					origin?.source === "node:fs" &&
					["O_RDONLY", "O_NOFOLLOW", "O_NONBLOCK"].includes(origin.name),
			};
		}
		if (t.isMemberExpression(node)) {
			const objectOrigin = scopedExpressionOrigin(node.object, scope);
			return {
				open: false,
				member:
					objectOrigin?.source === "node:fs" &&
					objectOrigin.name === "constants" &&
					["O_RDONLY", "O_NOFOLLOW", "O_NONBLOCK"].includes(memberName(node) ?? ""),
			};
		}
		if (t.isAssignmentPattern(node)) return mutationTarget(node.left, scope);
		if (t.isRestElement(node)) return mutationTarget(node.argument, scope);
		if (t.isArrayPattern(node)) {
			return node.elements.reduce<{ open: boolean; member: boolean }>(
				(result, element) => {
					const target = mutationTarget(element, scope);
					return { open: result.open || target.open, member: result.member || target.member };
				},
				{ open: false, member: false },
			);
		}
		if (t.isObjectPattern(node)) {
			return node.properties.reduce<{ open: boolean; member: boolean }>(
				(result, property) => {
					const target = mutationTarget(t.isRestElement(property) ? property.argument : property.value, scope);
					return { open: result.open || target.open, member: result.member || target.member };
				},
				{ open: false, member: false },
			);
		}
		return { open: false, member: false };
	};
	traverse(ast, {
		AssignmentExpression(pathNode) {
			const target = mutationTarget(pathNode.node.left, pathNode.scope);
			if (target.open) addFinding(findings, file, pathNode.node, RULES.mutation, "assignment");
			if (target.member) addFinding(findings, file, pathNode.node, RULES.mutation, "member-assignment");
		},
		UpdateExpression(pathNode) {
			const target = mutationTarget(pathNode.node.argument, pathNode.scope);
			if (target.open) addFinding(findings, file, pathNode.node, RULES.mutation, "assignment");
			if (target.member) addFinding(findings, file, pathNode.node, RULES.mutation, "member-assignment");
		},
		ForOfStatement(pathNode) {
			const target = mutationTarget(pathNode.node.left, pathNode.scope);
			if (target.open) addFinding(findings, file, pathNode.node, RULES.mutation, "assignment");
			if (target.member) addFinding(findings, file, pathNode.node, RULES.mutation, "member-assignment");
		},
		ForInStatement(pathNode) {
			const target = mutationTarget(pathNode.node.left, pathNode.scope);
			if (target.open) addFinding(findings, file, pathNode.node, RULES.mutation, "assignment");
			if (target.member) addFinding(findings, file, pathNode.node, RULES.mutation, "member-assignment");
		},
		UnaryExpression(pathNode) {
			if (pathNode.node.operator !== "delete") return;
			const target = mutationTarget(pathNode.node.argument, pathNode.scope);
			if (target.member) addFinding(findings, file, pathNode.node, RULES.mutation, "member-assignment");
		},
	});
}
function hasTypeReference(annotation: t.Node | null | undefined, name: string): boolean {
	return (
		t.isTSTypeAnnotation(annotation) &&
		t.isTSTypeReference(annotation.typeAnnotation) &&
		t.isIdentifier(annotation.typeAnnotation.typeName, { name })
	);
}

function validateCommandFlow(ast: t.File, file: string, findings: Finding[]): void {
	let factory: t.FunctionDeclaration | undefined;
	let factoryParam: t.Identifier | undefined;
	let factoryCount = 0;
	for (const statement of ast.program.body) {
		if (!t.isExportNamedDeclaration(statement) || !t.isFunctionDeclaration(statement.declaration)) continue;
		const candidate = statement.declaration;
		if (
			t.isIdentifier(candidate.id, { name: "createWorktreeCommand" }) &&
			candidate.params.length === 1 &&
			t.isIdentifier(candidate.params[0], { name: "getWorktreesDir" })
		) {
			factory = candidate;
			factoryParam = candidate.params[0];
			factoryCount++;
		}
	}
	const factoryContractOkay =
		factoryCount === 1 &&
		!!factory &&
		!factory.async &&
		!factory.generator &&
		factory.body.body.length === 1 &&
		!!factoryParam &&
		hasTypeReference(factoryParam.typeAnnotation, "WorktreeRootGetter") &&
		hasTypeReference(factory.returnType, "CommandCtor");
	const returned = factory?.body.body.find((statement) => t.isReturnStatement(statement));
	const commandClass =
		returned &&
		t.isReturnStatement(returned) &&
		t.isClassExpression(returned.argument) &&
		t.isIdentifier(returned.argument.id, { name: "Worktree" }) &&
		t.isIdentifier(returned.argument.superClass, { name: "Command" })
			? returned.argument
			: undefined;
	let commandSuperclassBindingOkay = false;
	if (commandClass) {
		traverse(ast, {
			ClassExpression(pathNode) {
				if (pathNode.node !== commandClass || !t.isIdentifier(commandClass.superClass)) return;
				const binding = pathNode.scope.getBinding(commandClass.superClass.name);
				const bindingNode = binding?.path.node;
				commandSuperclassBindingOkay =
					t.isImportSpecifier(bindingNode) &&
					t.isImportDeclaration(binding?.path.parent) &&
					binding.path.parent.source.value === "@gajae-code/utils/cli" &&
					importedName(bindingNode) === "Command";
			},
		});
	}
	const hasComputedAuthority = commandClass?.body.body.some(
		(member) => (t.isClassMethod(member) || t.isClassProperty(member)) && member.computed,
	);
	const hasRunField = commandClass?.body.body.some(
		(member) =>
			t.isClassProperty(member) &&
			((t.isIdentifier(member.key) && member.key.name === "run") ||
				(t.isStringLiteral(member.key) && member.key.value === "run")),
	);
	const runMethods =
		commandClass?.body.body.filter(
			(member): member is t.ClassMethod =>
				t.isClassMethod(member) && !member.computed && t.isIdentifier(member.key, { name: "run" }),
		) ?? [];
	const runMethod = runMethods[0];
	traverse(ast, {
		ClassMethod(pathNode) {
			if (pathNode.node === runMethod || pathNode.node.computed || !t.isIdentifier(pathNode.node.key, { name: "run" })) return;
			addFinding(findings, file, pathNode.node, RULES.getterTiming, "run-count");
		},
		CallExpression(pathNode) {
			if (pathNode.getFunctionParent()) return;
			if (
				t.isMemberExpression(pathNode.node.callee) &&
				t.isIdentifier(pathNode.node.callee.object, { name: "process" }) &&
				["write"].includes(memberName(pathNode.node.callee) ?? "")
			)
				addFinding(findings, file, pathNode.node, RULES.getterTiming, "terminal-sink");
		},
	});
	if (runMethods.length !== 1 || hasComputedAuthority || hasRunField)
		addFinding(findings, file, commandClass ?? factory ?? ast.program, RULES.getterTiming, "run-count");
	if (!runMethod) {
		addFinding(findings, file, factory ?? ast.program, RULES.workerEdge, "missing-run");
		return;
	}
	const statements = runMethod.body.body;
	if (statements.length !== 14) addFinding(findings, file, runMethod, RULES.getterTiming, "phase-shape");
	let commandShapeOkay = true;
	traverse(ast, {
		ReturnStatement(pathNode) {
			if (pathNode.getFunctionParent()?.node !== runMethod) return;
			const guard = statements[7];
			if (!t.isIfStatement(guard) || pathNode.parentPath?.node !== guard.consequent) commandShapeOkay = false;
		},
		UnaryExpression(pathNode) {
			if (
				pathNode.getFunctionParent()?.node === runMethod &&
				pathNode.node.operator === "void" &&
				t.isMemberExpression(pathNode.node.argument) &&
				t.isIdentifier(pathNode.node.argument.object, { name: "result" })
			)
				commandShapeOkay = false;
		},
		ThrowStatement(pathNode) {
			if (pathNode.getFunctionParent()?.node === runMethod) commandShapeOkay = false;
		},
	});
	const terminalSinks = { stdout: 0, stderr: 0, exitCode: 0 };
	traverse(ast, {
		CallExpression(pathNode) {
			if (pathNode.getFunctionParent()?.node !== runMethod || !t.isMemberExpression(pathNode.node.callee)) return;
			const object = pathNode.node.callee.object;
			const member = memberName(pathNode.node.callee);
			if (t.isMemberExpression(object) && t.isIdentifier(object.object, { name: "process" })) {
				if (member === "write" && t.isIdentifier(object.property)) terminalSinks[object.property.name as "stdout" | "stderr"]++;
			}
		},
		AssignmentExpression(pathNode) {
			if (pathNode.getFunctionParent()?.node !== runMethod || !t.isMemberExpression(pathNode.node.left)) return;
			const member = memberName(pathNode.node.left);
			if (t.isIdentifier(pathNode.node.left.object, { name: "process" }) && member === "exitCode") terminalSinks.exitCode++;
		},
	});
	if (terminalSinks.stdout !== 2 || terminalSinks.stderr !== 2 || terminalSinks.exitCode !== 2)
		commandShapeOkay = false;
	if (!commandShapeOkay) addFinding(findings, file, runMethod, RULES.getterTiming, "phase-shape");
	const indexOf = (predicate: (statement: t.Statement) => boolean) => statements.findIndex(predicate);
	let parseCall: t.CallExpression | undefined;
	const parseIndex = indexOf((statement) => {
		if (!t.isVariableDeclaration(statement) || statement.kind !== "const" || statement.declarations.length !== 1)
			return false;
		const declaration = statement.declarations[0];
		if (
			!t.isObjectPattern(declaration?.id) ||
			declaration.id.properties.length !== 3 ||
			!t.isAwaitExpression(declaration.init) ||
			!t.isCallExpression(declaration.init.argument)
		)
			return false;
		const names = declaration.id.properties.map((property) =>
			t.isObjectProperty(property) &&
			t.isIdentifier(property.key) &&
			t.isIdentifier(property.value, { name: property.key.name })
				? property.key.name
				: "",
		);
		if (names.length !== 3 || !["args", "flags", "argv"].every((name) => names.includes(name))) return false;
		const call = declaration.init.argument;
		if (
			!t.isMemberExpression(call.callee) ||
			!t.isThisExpression(call.callee.object) ||
			memberName(call.callee) !== "parse" ||
			call.arguments.length !== 1 ||
			!t.isIdentifier(call.arguments[0], { name: "Worktree" })
		)
			return false;
		parseCall = call;
		return true;
	});
	const positionalsIndex = indexOf(
		(statement) =>
			t.isVariableDeclaration(statement) &&
			statement.kind === "const" &&
			statement.declarations.length === 1 &&
			t.isIdentifier(statement.declarations[0].id, { name: "validPositionals" }) &&
			isValidPositionals(statement.declarations[0].init),
	);
	const validIndex = indexOf(
		(statement) =>
			t.isVariableDeclaration(statement) &&
			statement.kind === "const" &&
			statement.declarations.some(
				(declaration) => t.isIdentifier(declaration.id, { name: "valid" }) && isValidSelection(declaration.init),
			),
	);
	const guardIndex = indexOf(
		(statement) =>
			t.isIfStatement(statement) &&
			t.isUnaryExpression(statement.test, { operator: "!" }) &&
			t.isIdentifier(statement.test.argument, { name: "valid" }) &&
			t.isBlockStatement(statement.consequent) &&
			statement.alternate === null &&
			t.isReturnStatement(statement.consequent.body.at(-1)),
	);
	let getterCall: t.CallExpression | undefined;
	const getterIndex = indexOf(
		(statement) =>
			t.isVariableDeclaration(statement) &&
			statement.kind === "const" &&
			statement.declarations.some((declaration) => {
				if (
					!t.isIdentifier(declaration.id, { name: "root" }) ||
					!t.isCallExpression(declaration.init) ||
					!t.isIdentifier(declaration.init.callee, { name: "getWorktreesDir" }) ||
					declaration.init.arguments.length !== 0
				)
					return false;
				getterCall = declaration.init;
				return true;
			}),
	);
	const parsedValuesOkay =
		isActionSelection(namedInitializer(statements, "action")) &&
		isCoalescedFlag(namedInitializer(statements, "all"), "all") &&
		isCoalescedFlag(namedInitializer(statements, "dryRun"), "dry-run") &&
		isCoalescedFlag(namedInitializer(statements, "json"), "json");
	let workerName: string | undefined;
	const importIndex = indexOf((statement) => {
		if (!t.isVariableDeclaration(statement) || statement.kind !== "const") return false;
		return statement.declarations.some((declaration) => {
			const init = declaration.init;
			if (
				!t.isAwaitExpression(init) ||
				!t.isCallExpression(init.argument) ||
				staticImportSource(init.argument) !== "../cli/worktree-cli" ||
				!t.isObjectPattern(declaration.id)
			)
				return false;
			const property = declaration.id.properties.find(
				(item) =>
					t.isObjectProperty(item) &&
					!item.computed &&
					t.isIdentifier(item.key, { name: "runWorktreeCommand" }) &&
					t.isIdentifier(item.value, { name: "runWorktreeCommand" }),
			);
			if (declaration.id.properties.length !== 1) return false;
			if (t.isObjectProperty(property) && t.isIdentifier(property.value)) {
				workerName = property.value.name;
				return true;
			}
			return false;
		});
	});
	let resultIdentifier: t.Identifier | undefined;
	const callIndex = indexOf(
		(statement) =>
			t.isVariableDeclaration(statement) &&
			statement.kind === "const" &&
			statement.declarations.some((declaration) => {
				const init = t.isAwaitExpression(declaration.init) ? declaration.init.argument : declaration.init;
				if (
					!workerName ||
					!t.isIdentifier(declaration.id, { name: "result" }) ||
					!t.isCallExpression(init) ||
					!t.isIdentifier(init.callee, { name: workerName }) ||
					init.arguments.length !== 1 ||
					!t.isObjectExpression(init.arguments[0])
				)
					return false;
				resultIdentifier = declaration.id;
				const properties = new Map<string, t.ObjectProperty>();
				for (const property of init.arguments[0].properties) {
					if (!t.isObjectProperty(property) || property.computed || !t.isIdentifier(property.key)) return false;
					if (properties.has(property.key.name)) return false;
					properties.set(property.key.name, property);
				}
				const required = ["root", "platform", "action", "json", "dryRun"];
				if (properties.size !== required.length || required.some((name) => !properties.has(name))) return false;
				const value = (name: string) => properties.get(name)!.value;
				const platform = value("platform");
				const platformOkay =
					t.isConditionalExpression(platform) &&
					t.isBinaryExpression(platform.test, { operator: "===" }) &&
					t.isMemberExpression(platform.test.left) &&
					t.isIdentifier(platform.test.left.object, { name: "process" }) &&
					memberName(platform.test.left) === "platform" &&
					t.isStringLiteral(platform.test.right, { value: "win32" }) &&
					t.isStringLiteral(platform.consequent, { value: "win32" }) &&
					t.isStringLiteral(platform.alternate, { value: "posix" });
				return (
					t.isIdentifier(value("root"), { name: "root" }) &&
					t.isIdentifier(value("action"), { name: "action" }) &&
					t.isIdentifier(value("json"), { name: "json" }) &&
					t.isIdentifier(value("dryRun"), { name: "dryRun" }) &&
					platformOkay
				);
			}),
	);
	let workerCall: t.CallExpression | undefined;
	for (const statement of statements) {
		if (!t.isVariableDeclaration(statement)) continue;
		for (const declaration of statement.declarations) {
			const init = t.isAwaitExpression(declaration.init) ? declaration.init.argument : declaration.init;
			if (t.isCallExpression(init) && workerName && t.isIdentifier(init.callee, { name: workerName }))
				workerCall = init;
		}
	}
	const shadowed =
		workerName &&
		statements.some((statement) => {
			if (t.isFunctionDeclaration(statement) && t.isIdentifier(statement.id, { name: workerName })) return true;
			if (
				t.isVariableDeclaration(statement) &&
				statement.declarations.some((declaration) => t.isIdentifier(declaration.id, { name: workerName }))
			)
				return true;
			return (
				t.isExpressionStatement(statement) &&
				t.isAssignmentExpression(statement.expression) &&
				t.isIdentifier(statement.expression.left, { name: workerName })
			);
		});
	const getterBindingOkay =
		!!getterCall &&
		!!factoryParam &&
		callUsesBinding(ast, getterCall, factoryParam) &&
		bindingReferencedOnlyByCall(ast, getterCall, factoryParam);
	let workerBindingOkay = false;
	let workerIdentifier: t.Identifier | undefined;
	if (workerCall && workerName) {
		const importStatement = statements[importIndex];
		const declaration = t.isVariableDeclaration(importStatement) ? importStatement.declarations[0] : undefined;
		const property = t.isObjectPattern(declaration?.id) ? declaration.id.properties[0] : undefined;
		if (t.isObjectProperty(property) && t.isIdentifier(property.value)) {
			workerIdentifier = property.value;
			workerBindingOkay = callUsesBinding(ast, workerCall, property.value);
		}
	}
	const workerCallCount = workerIdentifier ? countCallsUsingBinding(ast, runMethod, workerIdentifier) : 0;
	const workerAliased = workerIdentifier ? hasBindingAlias(ast, runMethod, workerIdentifier) : false;
	const globalProcessOkay = !!workerCall && callUsesUnboundIdentifier(ast, workerCall, "process");
	const workerReferencesOkay =
		!!workerCall && !!workerIdentifier && bindingReferencedOnlyByCall(ast, workerCall, workerIdentifier);
	const frozenArguments = !hasIdentifierMutation(
		ast,
		new Set([
			"action",
			"all",
			"createWorktreeCommand",
			"dryRun",
			"getWorktreesDir",
			"json",
			"process",
			"root",
			"runWorktreeCommand",
			"valid",
			"argv",
			"validPositionals",
		]),
	);
	let parseCalls = 0;
	traverse(ast, {
		CallExpression(pathNode) {
			if (
				pathNode.getFunctionParent()?.node === runMethod &&
				t.isMemberExpression(pathNode.node.callee) &&
				t.isThisExpression(pathNode.node.callee.object) &&
				memberName(pathNode.node.callee) === "parse"
			)
				parseCalls++;
		},
	});
	let resultRendered = false;
	if (resultIdentifier) {
		traverse(ast, {
			MemberExpression(pathNode) {
				if (
					t.isIdentifier(pathNode.node.object, { name: resultIdentifier!.name }) &&
					pathNode.scope.getBinding(resultIdentifier!.name)?.identifier === resultIdentifier &&
					["stdout", "stderr", "exitCode"].includes(memberName(pathNode.node) ?? "")
				)
					resultRendered = true;
			},
		});
	}
	const noEarlyTerminal =
		parseIndex < 0 ||
		statements
			.slice(0, parseIndex)
			.every((statement) => !t.isReturnStatement(statement) && !t.isThrowStatement(statement));
	const ordered =
		parseCalls === 1 &&
		factoryContractOkay &&
		commandSuperclassBindingOkay &&
		!!factoryParam &&
		!!parseCall &&
		parsedValuesOkay &&
		parseIndex === 0 &&
		noEarlyTerminal &&
		positionalsIndex === 5 &&
		validIndex === 6 &&
		guardIndex === 7 &&
		getterIndex === 8 &&
		importIndex === 9 &&
		callIndex === 10 &&
		statements.length === 14 &&
		getterBindingOkay &&
		workerBindingOkay &&
		workerCallCount === 1 &&
		!workerAliased &&
		resultRendered &&
		globalProcessOkay &&
		workerReferencesOkay &&
		frozenArguments &&
		!shadowed;
	if (!ordered) addFinding(findings, file, runMethod, RULES.getterTiming, "parse-valid-getter-import-call");
	let getterCalls = 0;
	let workerImports = 0;
	traverse(ast, {
		CallExpression(pathNode) {
			if (t.isIdentifier(pathNode.node.callee, { name: "getWorktreesDir" })) getterCalls += 1;
			if (staticImportSource(pathNode.node) === "../cli/worktree-cli") workerImports += 1;
		},
	});
	if (getterCalls !== 1) addFinding(findings, file, runMethod, RULES.getterTiming, `getter-count:${getterCalls}`);
	if (workerImports !== 1) addFinding(findings, file, runMethod, RULES.workerEdge, `count:${workerImports}`);
}
function workerOptionMember(
	node: t.Node | null | undefined,
	property: "root" | "platform",
	scope: Scope,
	optionsParameter: t.Identifier,
): boolean {
	return (
		t.isMemberExpression(node) &&
		!node.computed &&
		t.isIdentifier(node.object, { name: optionsParameter.name }) &&
		scope.getBinding(node.object.name)?.identifier === optionsParameter &&
		t.isIdentifier(node.property, { name: property })
	);
}

function containsIdentifier(node: t.Node | null | undefined, names: ReadonlySet<string>): boolean {
	if (!node) return false;
	if (t.isIdentifier(node) && names.has(node.name)) return true;
	for (const key of t.VISITOR_KEYS[node.type] ?? []) {
		const value = (node as unknown as Record<string, unknown>)[key];
		if (Array.isArray(value) && value.some((item) => containsIdentifier(childNode(item), names))) return true;
		if (!Array.isArray(value) && containsIdentifier(childNode(value), names)) return true;
	}
	return false;
}
function validateWorkerFlow(ast: t.File, file: string, findings: Finding[]): void {
	const exportedRun = ast.program.body.find(
		(statement) =>
			t.isExportNamedDeclaration(statement) &&
			t.isFunctionDeclaration(statement.declaration) &&
			t.isIdentifier(statement.declaration.id, { name: "runWorktreeCommand" }),
	);
	const authoritativeRun =
		exportedRun && t.isExportNamedDeclaration(exportedRun) && t.isFunctionDeclaration(exportedRun.declaration)
			? exportedRun.declaration
			: undefined;
	if (!authoritativeRun) {
		addFinding(findings, file, ast.program, RULES.scannerApi, "worker-scan-contract");
		return;
	}
	const optionsParameter =
		authoritativeRun.params.length === 1 && t.isIdentifier(authoritativeRun.params[0])
			? authoritativeRun.params[0]
			: undefined;
	if (!optionsParameter) {
		addFinding(findings, file, authoritativeRun, RULES.scannerApi, "worker-scan-contract");
		return;
	}
	const bodyStatements = authoritativeRun.body.body;
	const tryStatement = bodyStatements[1];
	const returnKeys = new Set(["stdout", "stderr", "exitCode"]);
	const diagnosticsDeclaration = bodyStatements[0];
	const diagnosticsIdentity =
		t.isVariableDeclaration(diagnosticsDeclaration) &&
		diagnosticsDeclaration.declarations.length === 1 &&
		t.isIdentifier(diagnosticsDeclaration.declarations[0]?.id, { name: "diagnostics" })
			? diagnosticsDeclaration.declarations[0].id
			: undefined;
	const scanErrorDeclaration = ast.program.body
		.flatMap(statement => t.isVariableDeclaration(statement) ? statement.declarations : [])
		.find(declaration => t.isIdentifier(declaration.id, { name: "SCAN_ERROR_TEXT" }));
	const scanErrorIdentity =
		scanErrorDeclaration && t.isIdentifier(scanErrorDeclaration.id)
			? scanErrorDeclaration.id
			: undefined;
	const formatDeclaration = ast.program.body
		.map(statement => t.isFunctionDeclaration(statement) ? statement : undefined)
		.find(declaration => declaration?.id?.name === "formatDiagnostic");
	const formatIdentity =
		formatDeclaration && t.isIdentifier(formatDeclaration.id)
			? formatDeclaration.id
			: undefined;
	const rootErrorSpecifier = ast.program.body
		.filter((statement): statement is t.ImportDeclaration =>
			t.isImportDeclaration(statement) && statement.source.value === "./worktree-scanner",
		)
		.flatMap(statement => statement.specifiers)
		.find(
			(specifier): specifier is t.ImportSpecifier =>
				t.isImportSpecifier(specifier) &&
				(t.isIdentifier(specifier.imported)
					? specifier.imported.name === "WorktreeRootError"
					: specifier.imported.value === "WorktreeRootError"),
		);
	const rootErrorIdentity = rootErrorSpecifier?.local;
	const exactIdentifier = (
		node: t.Node | null | undefined,
		name: string,
		identity: t.Identifier | undefined,
	): boolean =>
		t.isIdentifier(node, { name }) &&
		identity !== undefined &&
		(node === identity || BINDING_IDENTITIES.get(node) === identity);
	const exactOptionsMember = (
		node: t.Node | null | undefined,
		property: "action" | "json" | "dryRun",
	): boolean =>
		t.isMemberExpression(node) &&
		!node.computed &&
		exactIdentifier(node.object, optionsParameter.name, optionsParameter) &&
		memberName(node) === property;
	const scanErrorDefinitionOkay =
		scanErrorDeclaration?.init !== null &&
		t.isStringLiteral(scanErrorDeclaration?.init, { value: "managed worktree root cannot be read" });
	const formatDefinitionOkay = (() => {
		if (
			!formatDeclaration ||
			formatDeclaration.async ||
			formatDeclaration.generator ||
			formatDeclaration.params.length !== 1 ||
			!t.isIdentifier(formatDeclaration.params[0]) ||
			formatDeclaration.body.body.length !== 1
		)
			return false;
		const returned = formatDeclaration.body.body[0];
		if (!t.isReturnStatement(returned) || !t.isTemplateLiteral(returned.argument)) return false;
		const template = returned.argument;
		const parameter = formatDeclaration.params[0];
		const member = (node: t.Expression | t.TSType, property: "path" | "message"): boolean =>
			t.isMemberExpression(node) &&
			!node.computed &&
			exactIdentifier(node.object, parameter.name, parameter) &&
			memberName(node) === property;
		return (
			template.quasis.length === 3 &&
			template.expressions.length === 2 &&
			(template.quasis[0]?.value.cooked ?? "") === "diagnostic  " &&
			(template.quasis[1]?.value.cooked ?? "") === "  " &&
			(template.quasis[2]?.value.cooked ?? "") === "" &&
			member(template.expressions[0]!, "path") &&
			member(template.expressions[1]!, "message")
		);
	})();
	const isJsonCall = (node: t.Node | null | undefined, argument: t.Node | null | undefined): boolean =>
		t.isCallExpression(node) &&
		t.isMemberExpression(node.callee) &&
		!node.callee.computed &&
		t.isIdentifier(node.callee.object, { name: "JSON" }) &&
		BINDING_IDENTITIES.get(node.callee.object) === undefined &&
		memberName(node.callee) === "stringify" &&
		node.arguments.length === 1 &&
		node.arguments[0] === argument;
	const isDiagnosticsLength = (node: t.Node | null | undefined): boolean =>
		t.isMemberExpression(node) &&
		!node.computed &&
		exactIdentifier(node.object, "diagnostics", diagnosticsIdentity) &&
		memberName(node) === "length";
	const isDiagnosticsLengthOrZero = (node: t.Node | null | undefined): boolean =>
		t.isNumericLiteral(node, { value: 0 }) || isDiagnosticsLength(node);
	const isExactJsonValue = (node: t.Node | null | undefined): boolean => {
		if (t.isConditionalExpression(node)) {
			return (
				exactOptionsMember(node.test, "dryRun") &&
				isExactJsonValue(node.consequent) &&
				isExactJsonValue(node.alternate)
			);
		}
		if (exactIdentifier(node, "diagnostics", diagnosticsIdentity)) return true;
		if (!t.isObjectExpression(node)) return false;
		const fields = new Map(
			node.properties.flatMap((item) =>
				t.isObjectProperty(item) && !item.computed && t.isIdentifier(item.key) ? [[item.key.name, item.value] as const] : [],
			),
		);
		if (fields.size !== node.properties.length) return false;
		if (fields.size === 1 && fields.has("wouldRemove")) {
			const wouldRemove = fields.get("wouldRemove");
			return t.isArrayExpression(wouldRemove) && wouldRemove.elements.length === 0;
		}
		if (fields.size === 2 && fields.has("removed") && fields.has("kept")) {
			return t.isNumericLiteral(fields.get("removed"), { value: 0 }) && isDiagnosticsLengthOrZero(fields.get("kept"));
		}
		if (fields.size === 1 && fields.has("kept")) return isDiagnosticsLength(fields.get("kept"));
		if (fields.size === 1 && fields.has("removed")) return t.isNumericLiteral(fields.get("removed"), { value: 0 });
		if (fields.size !== 1 || !fields.has("error")) return false;
		const errorObject = fields.get("error");
		if (!t.isObjectExpression(errorObject)) return false;
		const errorFields = new Map(
			errorObject.properties.flatMap((item) =>
				t.isObjectProperty(item) && !item.computed && t.isIdentifier(item.key) ? [[item.key.name, item.value] as const] : [],
			),
		);
		return errorFields.size === 2 && t.isStringLiteral(errorFields.get("code"), { value: "worktree_scan_failed" }) && exactIdentifier(errorFields.get("message"), "SCAN_ERROR_TEXT", scanErrorIdentity);
	};
	const isDiagnosticMapJoin = (node: t.Node | null | undefined): boolean => {
		if (!t.isCallExpression(node) || !t.isMemberExpression(node.callee) || node.callee.computed || memberName(node.callee) !== "join") return false;
		if (node.arguments.length !== 1 || !t.isStringLiteral(node.arguments[0], { value: "\n" })) return false;
		const map = node.callee.object;
		return (
			t.isCallExpression(map) &&
			t.isMemberExpression(map.callee) &&
			!map.callee.computed &&
			memberName(map.callee) === "map" &&
			exactIdentifier(map.callee.object, "diagnostics", diagnosticsIdentity) &&
			map.arguments.length === 1 &&
			exactIdentifier(map.arguments[0], "formatDiagnostic", formatIdentity)
		);
	};
	const isKeptMapJoin = (node: t.Node | null | undefined): boolean => {
		if (!t.isCallExpression(node) || !t.isMemberExpression(node.callee) || node.callee.computed || memberName(node.callee) !== "join") return false;
		if (node.arguments.length !== 1 || !t.isStringLiteral(node.arguments[0], { value: "\n" })) return false;
		const map = node.callee.object;
		if (!t.isCallExpression(map) || !t.isMemberExpression(map.callee) || map.callee.computed || memberName(map.callee) !== "map") return false;
		const callback = map.arguments[0];
		if (!exactIdentifier(map.callee.object, "diagnostics", diagnosticsIdentity) || map.arguments.length !== 1 || !t.isArrowFunctionExpression(callback) || callback.params.length !== 1 || !t.isIdentifier(callback.params[0])) return false;
		return (
			t.isTemplateLiteral(callback.body) &&
			callback.body.quasis.length === 2 &&
			(callback.body.quasis[0]?.value.cooked ?? "") === "kept    " &&
			(callback.body.quasis[1]?.value.cooked ?? "") === "" &&
			callback.body.expressions.length === 1 &&
			t.isMemberExpression(callback.body.expressions[0]) &&
			!callback.body.expressions[0].computed &&
			t.isIdentifier(callback.body.expressions[0].object, { name: callback.params[0].name }) &&
			memberName(callback.body.expressions[0]) === "path"
		);
	};
	const isApprovedTemplate = (node: t.TemplateLiteral, key: string): boolean => {
		const quasis = node.quasis.map((quasi) => quasi.value.cooked ?? "");
		const expression = node.expressions[0];
		if (key === "stdout" && quasis.length === 2 && node.expressions.length === 1 && quasis[0] === "" && quasis[1] === "\n") {
			const argument = t.isCallExpression(expression) ? expression.arguments[0] : undefined;
			return isJsonCall(expression, argument) && isExactJsonValue(argument);
		}
		if (key === "stderr" && quasis.length === 2 && node.expressions.length === 1 && quasis[0] === "error: " && quasis[1] === "\n" && exactIdentifier(expression, "SCAN_ERROR_TEXT", scanErrorIdentity)) return true;
		if (key === "stdout" && quasis.length === 3 && node.expressions.length === 2 && quasis[0] === "" && quasis[1] === "\n\n" && quasis[2] === " total\n")
			return isDiagnosticMapJoin(expression) && isDiagnosticsLength(node.expressions[1]);
		if (key === "stdout" && quasis.length === 3 && node.expressions.length === 2 && quasis[0] === "" && quasis[1] === "\n\n0 removed · " && quasis[2] === " kept\n")
			return isKeptMapJoin(expression) && isDiagnosticsLength(node.expressions[1]);
		return false;
	};
	const jsonTemplatePayload = (node: t.Node | null | undefined): t.Node | undefined => {
		if (!t.isTemplateLiteral(node) || node.quasis.length !== 2 || node.expressions.length !== 1) return undefined;
		if ((node.quasis[0]?.value.cooked ?? "") !== "" || (node.quasis[1]?.value.cooked ?? "") !== "\n")
			return undefined;
		const expression = node.expressions[0];
		if (!t.isCallExpression(expression)) return undefined;
		const argument = expression.arguments[0];
		return isJsonCall(expression, argument) ? childNode(argument) : undefined;
	};
	const isErrorJsonValue = (node: t.Node | null | undefined): boolean => {
		if (!t.isObjectExpression(node) || node.properties.length !== 1) return false;
		const errorProperty = node.properties[0];
		if (!t.isObjectProperty(errorProperty) || errorProperty.computed || !t.isIdentifier(errorProperty.key, { name: "error" }))
			return false;
		const error = errorProperty.value;
		if (!t.isObjectExpression(error) || error.properties.length !== 2) return false;
		const fields = new Map<string, t.Node>();
		for (const property of error.properties) {
			if (!t.isObjectProperty(property) || property.computed || !t.isIdentifier(property.key)) return false;
			fields.set(property.key.name, property.value);
		}
		return (
			t.isStringLiteral(fields.get("code"), { value: "worktree_scan_failed" }) &&
			exactIdentifier(fields.get("message"), "SCAN_ERROR_TEXT", scanErrorIdentity)
		);
	};
	const isErrorStdout = (node: t.Node): boolean => isErrorJsonValue(jsonTemplatePayload(node));
	const isErrorStderr = (node: t.Node): boolean =>
		t.isTemplateLiteral(node) && isApprovedTemplate(node, "stderr");
	const isSuccessStdout = (node: t.Node): boolean =>
		(t.isStringLiteral(node) &&
			(node.value === "No agent-managed worktrees found.\n" ||
				node.value === "No worktrees are eligible for removal; cleanup is report-only.\n")) ||
		(t.isTemplateLiteral(node) &&
			isApprovedTemplate(node, "stdout") &&
			!isErrorJsonValue(jsonTemplatePayload(node)));
	const validReturnObject = (
		node: t.Node | null | undefined,
		expected: "error" | "success",
	): boolean => {
		if (t.isConditionalExpression(node))
			return (
				expected === "error" &&
				exactOptionsMember(node.test, "json") &&
				validReturnObject(node.consequent, expected) &&
				validReturnObject(node.alternate, expected)
			);
		if (!t.isObjectExpression(node) || node.properties.length !== 3) return false;
		const properties = new Map<string, t.ObjectProperty>();
		for (const property of node.properties) {
			if (!t.isObjectProperty(property) || property.computed || !t.isIdentifier(property.key) || properties.has(property.key.name)) return false;
			properties.set(property.key.name, property);
		}
		if (properties.size !== returnKeys.size || [...returnKeys].some(key => !properties.has(key))) return false;
		const stdout = properties.get("stdout")!.value;
		const stderr = properties.get("stderr")!.value;
		const exitCode = properties.get("exitCode")!.value;
		if (expected === "error") {
			if (!t.isNumericLiteral(exitCode, { value: 1 })) return false;
			return (
				(isErrorStdout(stdout) && t.isStringLiteral(stderr, { value: "" })) ||
				(t.isStringLiteral(stdout, { value: "" }) && isErrorStderr(stderr))
			);
		}
		return (
			t.isNumericLiteral(exitCode, { value: 0 }) &&
			t.isStringLiteral(stderr, { value: "" }) &&
			isSuccessStdout(stdout)
		);
	};
	const singleReturn = (statement: t.Statement | null | undefined): t.ReturnStatement | undefined => {
		if (t.isReturnStatement(statement)) return statement;
		if (t.isBlockStatement(statement) && statement.body.length === 1 && t.isReturnStatement(statement.body[0]))
			return statement.body[0];
		return undefined;
	};
	const objectFields = (node: t.Node | null | undefined): Map<string, t.Node> | undefined => {
		if (!t.isObjectExpression(node)) return undefined;
		const fields = new Map<string, t.Node>();
		for (const property of node.properties) {
			if (!t.isObjectProperty(property) || property.computed || !t.isIdentifier(property.key) || fields.has(property.key.name))
				return undefined;
			fields.set(property.key.name, property.value);
		}
		return fields.size === node.properties.length ? fields : undefined;
	};
	const returnStdout = (statement: t.Statement | null | undefined): t.Node | undefined => {
		const returned = singleReturn(statement);
		if (!returned || !validReturnObject(returned.argument, "success")) return undefined;
		return objectFields(returned.argument)?.get("stdout");
	};
	const jsonStdoutPayload = (statement: t.Statement | null | undefined): t.Node | undefined => {
		const stdout = returnStdout(statement);
		return jsonTemplatePayload(stdout);
	};
	const isWouldRemoveValue = (node: t.Node | null | undefined): boolean => {
		const fields = objectFields(node);
		const wouldRemove = fields?.get("wouldRemove");
		return fields?.size === 1 && t.isArrayExpression(wouldRemove) && wouldRemove.elements.length === 0;
	};
	const isRemovedKeptValue = (
		node: t.Node | null | undefined,
		kept: (value: t.Node | undefined) => boolean,
	): boolean => {
		const fields = objectFields(node);
		return (
			fields?.size === 2 &&
			t.isNumericLiteral(fields.get("removed"), { value: 0 }) &&
			kept(fields.get("kept"))
		);
	};
	const isExactIf = (
		statement: t.Statement | undefined,
		test: (node: t.Expression) => boolean,
	): statement is t.IfStatement =>
		t.isIfStatement(statement) && statement.alternate === null && test(statement.test);
	const isDiagnosticsZero = (node: t.Node): boolean =>
		t.isBinaryExpression(node, { operator: "===" }) &&
		isDiagnosticsLength(node.left) &&
		t.isNumericLiteral(node.right, { value: 0 });
	const listStatement = bodyStatements[2];
	const clearStatement = bodyStatements[3];
	const jsonStatement = bodyStatements[4];
	const finalStatement = bodyStatements[5];
	const listBlock =
		isExactIf(
			listStatement,
			test =>
				t.isBinaryExpression(test, { operator: "===" }) &&
				exactOptionsMember(test.left, "action") &&
				t.isStringLiteral(test.right, { value: "list" }),
		) && t.isBlockStatement(listStatement.consequent)
			? listStatement.consequent.body
			: undefined;
	const clearBlock =
		isExactIf(
			clearStatement,
			test =>
				t.isLogicalExpression(test, { operator: "||" }) &&
				exactOptionsMember(test.left, "dryRun") &&
				isDiagnosticsZero(test.right),
		) && t.isBlockStatement(clearStatement.consequent)
			? clearStatement.consequent.body
			: undefined;
	const jsonBlock =
		isExactIf(jsonStatement, test => exactOptionsMember(test, "json")) &&
		t.isBlockStatement(jsonStatement.consequent)
			? jsonStatement.consequent.body
			: undefined;
	const listJsonReturn =
		listBlock &&
		isExactIf(listBlock[0], test => exactOptionsMember(test, "json"))
			? singleReturn(listBlock[0].consequent)
			: undefined;
	const listEmptyReturn =
		listBlock && isExactIf(listBlock[1], isDiagnosticsZero)
			? singleReturn(listBlock[1].consequent)
			: undefined;
	const clearJsonReturn =
		clearBlock && isExactIf(clearBlock[0], test => exactOptionsMember(test, "json"))
			? singleReturn(clearBlock[0].consequent)
			: undefined;
	const clearPayload = jsonStdoutPayload(clearJsonReturn);
	const branchShapeOkay =
		listBlock?.length === 3 &&
		clearBlock?.length === 2 &&
		jsonBlock?.length === 1 &&
		exactIdentifier(jsonStdoutPayload(listJsonReturn), "diagnostics", diagnosticsIdentity) &&
		t.isStringLiteral(returnStdout(listEmptyReturn), { value: "No agent-managed worktrees found.\n" }) &&
		t.isTemplateLiteral(returnStdout(listBlock[2])) &&
		(returnStdout(listBlock[2]) as t.TemplateLiteral).quasis[1]?.value.cooked === "\n\n" &&
		t.isConditionalExpression(clearPayload) &&
		exactOptionsMember(clearPayload.test, "dryRun") &&
		isWouldRemoveValue(clearPayload.consequent) &&
		isRemovedKeptValue(clearPayload.alternate, value => t.isNumericLiteral(value, { value: 0 })) &&
		t.isStringLiteral(returnStdout(clearBlock[1]), {
			value: "No worktrees are eligible for removal; cleanup is report-only.\n",
		}) &&
		isRemovedKeptValue(jsonStdoutPayload(jsonBlock[0]), value => isDiagnosticsLength(value)) &&
		t.isTemplateLiteral(returnStdout(finalStatement)) &&
		(returnStdout(finalStatement) as t.TemplateLiteral).quasis[1]?.value.cooked === "\n\n0 removed · ";
	let invalidReturn = false;
	traverse(ast, {
		ReturnStatement(pathNode) {
			if (pathNode.getFunctionParent()?.node !== authoritativeRun) return;
			const inHandler =
				tryStatement &&
				t.isTryStatement(tryStatement) &&
				tryStatement.handler !== null &&
				pathNode.findParent(candidate => candidate.node === tryStatement.handler) !== null;
			if (!validReturnObject(pathNode.node.argument, inHandler ? "error" : "success"))
				invalidReturn = true;
		},
	});
	const catchGuardOkay = (() => {
		if (!t.isTryStatement(tryStatement) || !tryStatement.handler) return false;
		const handler = tryStatement.handler;
		if (!t.isIdentifier(handler.param) || handler.body.body.length !== 2) return false;
		const guard = handler.body.body[0];
		if (
			!t.isIfStatement(guard) ||
			guard.alternate !== null ||
			!t.isUnaryExpression(guard.test, { operator: "!" }) ||
			!t.isBinaryExpression(guard.test.argument, { operator: "instanceof" }) ||
			!exactIdentifier(guard.test.argument.left, handler.param.name, handler.param) ||
			!exactIdentifier(guard.test.argument.right, "WorktreeRootError", rootErrorIdentity)
		)
			return false;
		const thrown = t.isBlockStatement(guard.consequent)
			? guard.consequent.body.length === 1 ? guard.consequent.body[0] : undefined
			: guard.consequent;
		return (
			t.isThrowStatement(thrown) &&
			exactIdentifier(thrown.argument, handler.param.name, handler.param) &&
			t.isReturnStatement(handler.body.body[1])
		);
	})();
	const scanExpression = tryStatement && t.isTryStatement(tryStatement)
		? tryStatement.block.body[0]
		: undefined;
	const scanAssignment =
		t.isExpressionStatement(scanExpression) && t.isAssignmentExpression(scanExpression.expression)
			? scanExpression.expression
			: undefined;
	let scanShapeOkay =
		bodyStatements.length === 6 &&
		scanErrorDefinitionOkay &&
		formatDefinitionOkay &&
		rootErrorIdentity !== undefined &&
		t.isTryStatement(tryStatement) &&
		tryStatement.finalizer === null &&
		catchGuardOkay &&
		tryStatement.block.body.length === 1 &&
		scanAssignment !== undefined &&
		exactIdentifier(scanAssignment.left, "diagnostics", diagnosticsIdentity) &&
		t.isAwaitExpression(scanAssignment.right) &&
		t.isCallExpression(scanAssignment.right.argument) &&
		t.isIdentifier(scanAssignment.right.argument.callee, { name: "scanWorktrees" });
	let diagnosticsReferencesOkay = true;
	let finalReturnHasDiagnostics = false;
	traverse(ast, {
		Identifier(pathNode) {
			if (
				pathNode.node.name !== "diagnostics" ||
				BINDING_IDENTITIES.get(pathNode.node) !== diagnosticsIdentity ||
				!pathNode.isReferencedIdentifier()
			)
				return;
			const parent = pathNode.parentPath;
			const approved =
				(parent?.isMemberExpression() &&
					parent.node.object === pathNode.node &&
					["length", "map"].includes(memberName(parent.node) ?? "")) ||
				(parent?.isCallExpression() &&
					t.isMemberExpression(parent.node.callee) &&
					t.isIdentifier(parent.node.callee.object, { name: "JSON" }) &&
					memberName(parent.node.callee) === "stringify" &&
					parent.node.arguments[0] === pathNode.node);
			if (!approved) diagnosticsReferencesOkay = false;
			if (pathNode.findParent((candidate) => candidate.isReturnStatement())?.node === bodyStatements.at(-1))
				finalReturnHasDiagnostics = true;
		},
	});
	if (!scanShapeOkay || !branchShapeOkay || !diagnosticsReferencesOkay || !finalReturnHasDiagnostics || invalidReturn)
		addFinding(findings, file, authoritativeRun, RULES.scannerApi, "worker-scan-contract");
	const authoritativeMutated = hasIdentifierMutation(
		ast,
		new Set([optionsParameter.name, "runWorktreeCommand", "scanWorktrees", "SCAN_ERROR_TEXT", "formatDiagnostic"]),
	);
	if (authoritativeMutated) addFinding(findings, file, authoritativeRun, RULES.scannerApi, "worker-scan-contract");
	let validCalls = 0;
	let totalCalls = 0;
	let consumedCalls = 0;
	traverse(ast, {
		CallExpression(pathNode) {
			const callOrigin = scopedExpressionOrigin(pathNode.node.callee, pathNode.scope);
			if (callOrigin?.source !== "./worktree-scanner" || callOrigin.name !== "scanWorktrees") return;
			totalCalls++;
			if (
				pathNode.getFunctionParent()?.node !== authoritativeRun ||
				!t.isIdentifier(pathNode.node.callee, { name: "scanWorktrees" }) ||
				pathNode.findParent((parent) => parent.isIfStatement()) !== null
			)
				return;
			if (
				authoritativeRun.body.body.some(
					(statement) =>
						t.isReturnStatement(statement) && (statement.start ?? Number.MAX_SAFE_INTEGER) < (pathNode.node.start ?? 0),
				)
			)
				return;
			const binding = pathNode.scope.getBinding("scanWorktrees");
			const directImport =
				binding &&
				t.isImportSpecifier(binding.path.node) &&
				t.isImportDeclaration(binding.path.parent) &&
				binding.path.parent.source.value === "./worktree-scanner" &&
				importedName(binding.path.node) === "scanWorktrees" &&
				binding.referencePaths.length === 1 &&
				binding.referencePaths[0]?.node === pathNode.node.callee;
			const argument = pathNode.node.arguments[0];
			if (
				!directImport ||
				pathNode.node.arguments.length !== 1 ||
				!t.isObjectExpression(argument) ||
				argument.properties.length !== 2
			)
				return;
			const properties = new Map<string, t.ObjectProperty>();
			for (const property of argument.properties) {
				if (t.isObjectProperty(property) && !property.computed && t.isIdentifier(property.key))
					properties.set(property.key.name, property);
			}
			if (
				properties.size === 2 &&
				workerOptionMember(properties.get("root")?.value, "root", pathNode.scope, optionsParameter) &&
				workerOptionMember(properties.get("platform")?.value, "platform", pathNode.scope, optionsParameter)
			) {
				validCalls++;
				const awaitPath = pathNode.parentPath;
				const assignmentPath = awaitPath.isAwaitExpression() ? awaitPath.parentPath : undefined;
				const diagnosticsBinding = pathNode.scope.getBinding("diagnostics");
				if (
					assignmentPath?.isAssignmentExpression() &&
					assignmentPath.node.operator === "=" &&
					t.isIdentifier(assignmentPath.node.left, { name: "diagnostics" }) &&
					diagnosticsBinding &&
					t.isVariableDeclarator(diagnosticsBinding.path.node) &&
					t.isIdentifier(diagnosticsBinding.path.node.id, { name: "diagnostics" }) &&
					diagnosticsBinding.constantViolations.length === 1 &&
					diagnosticsBinding.constantViolations[0]?.node === assignmentPath.node &&
					diagnosticsBinding.referencePaths.some(
						(reference) => (reference.node.start ?? 0) > (pathNode.node.end ?? Number.MAX_SAFE_INTEGER),
					)
				)
					consumedCalls++;
			}
		},
	});
	if (totalCalls !== 1 || validCalls !== 1 || consumedCalls !== 1)
		addFinding(findings, file, ast.program, RULES.scannerApi, "worker-scan-contract");
}

function destructuredImportSignature(pathNode: NodePath<t.CallExpression>): string | undefined {
	const awaited = pathNode.parentPath;
	if (!awaited.isAwaitExpression() || !awaited.parentPath?.isVariableDeclarator()) return undefined;
	const pattern = awaited.parentPath.node.id;
	if (!t.isObjectPattern(pattern) || pattern.properties.length === 0) return undefined;
	const names: string[] = [];
	for (const property of pattern.properties) {
		if (
			!t.isObjectProperty(property) ||
			property.computed ||
			!t.isIdentifier(property.key) ||
			!t.isIdentifier(property.value, { name: property.key.name }) ||
			names.includes(property.key.name)
		)
			return undefined;
		names.push(property.key.name);
	}
	return `destructure:${names.sort().join(",")}`;
}

function defaultImportSignature(pathNode: NodePath<t.CallExpression>): string | undefined {
	const member = pathNode.parentPath;
	if (
		!member.isMemberExpression() ||
		member.node.object !== pathNode.node ||
		member.node.computed ||
		!t.isIdentifier(member.node.property, { name: "then" }) ||
		!member.parentPath?.isCallExpression() ||
		member.parentPath.node.callee !== member.node ||
		member.parentPath.node.arguments.length !== 1
	)
		return undefined;
	const callback = member.parentPath.node.arguments[0];
	if (
		!t.isArrowFunctionExpression(callback) ||
		callback.params.length !== 1 ||
		!t.isIdentifier(callback.params[0]) ||
		!t.isMemberExpression(callback.body) ||
		callback.body.computed ||
		!t.isIdentifier(callback.body.object, { name: callback.params[0].name }) ||
		!t.isIdentifier(callback.body.property, { name: "default" })
	)
		return undefined;
	return "then:default";
}

function dynamicImportBaseline(source: string): DynamicImportBaseline | undefined {
	return CLI_DEFAULT_COMMAND_IMPORTS.has(source)
		? { count: 1, signature: "then:default" }
		: CLI_DYNAMIC_IMPORT_BASELINE.get(source);
}

function validateDynamicImports(ast: t.File, file: string, role: Role, findings: Finding[]): void {
	const observedBaseline = new Map<string, number>();
	traverse(ast, {
		CallExpression(pathNode) {
			if (!t.isImport(pathNode.node.callee)) return;
			const source = staticImportSource(pathNode.node);
			if (role === "cli") {
				if (source === "./commands/worktree") {
					const parent = pathNode.parentPath;
					const awaitExpression = parent.isAwaitExpression() ? parent.parentPath : parent;
					const declaration = awaitExpression?.isVariableDeclarator() ? awaitExpression.node : undefined;
					const pattern = declaration?.id;
					const exact =
						t.isObjectPattern(pattern) &&
						pattern.properties.length === 1 &&
						t.isObjectProperty(pattern.properties[0]) &&
						!pattern.properties[0].computed &&
						t.isIdentifier(pattern.properties[0].key, { name: "createWorktreeCommand" }) &&
						t.isIdentifier(pattern.properties[0].value, { name: "createWorktreeCommand" });
					if (!exact) addFinding(findings, file, pathNode.node, RULES.dynamicImport, source);
					return;
				}
				const baseline = source ? dynamicImportBaseline(source) : undefined;
				const signature = destructuredImportSignature(pathNode) ?? defaultImportSignature(pathNode);
				if (!source || !baseline || signature !== baseline.signature) {
					addFinding(findings, file, pathNode.node, RULES.dynamicImport, source ?? "computed");
					return;
				}
				observedBaseline.set(source, (observedBaseline.get(source) ?? 0) + 1);
				return;
			}
			const allowed = role === "command" && source === "../cli/worktree-cli";
			if (!allowed) addFinding(findings, file, pathNode.node, RULES.dynamicImport, source ?? "computed");
		},
	});
	if (role !== "cli") return;
	for (const source of CLI_DEFAULT_COMMAND_IMPORTS) {
		const actual = observedBaseline.get(source) ?? 0;
		if (actual !== 1)
			addFinding(findings, file, ast.program, RULES.dynamicImport, `baseline-count:${source}:${actual}`);
	}
	for (const [source, baseline] of CLI_DYNAMIC_IMPORT_BASELINE) {
		const actual = observedBaseline.get(source) ?? 0;
		if (actual !== baseline.count)
			addFinding(findings, file, ast.program, RULES.dynamicImport, `baseline-count:${source}:${actual}`);
	}
}
function directOpenCall(node: t.Node | null | undefined, scope: Scope): t.CallExpression | undefined {
	const expression = t.isAwaitExpression(node) ? node.argument : node;
	if (!t.isCallExpression(expression)) return undefined;
	const origin = scopedExpressionOrigin(expression.callee, scope);
	return origin?.source === "node:fs/promises" && origin.name === "open" ? expression : undefined;
}
function hasDirectOpenOwner(pathNode: NodePath<t.CallExpression>): boolean {
	const awaited = pathNode.parentPath;
	const ownerFunction = pathNode.getFunctionParent();
	if (!awaited.isAwaitExpression() || !ownerFunction) return false;
	const owner = awaited.parentPath;
	if (
		owner.isVariableDeclarator() &&
		owner.node.init === awaited.node &&
		t.isIdentifier(owner.node.id) &&
		!owner.parentPath?.parentPath?.isExportNamedDeclaration()
	) {
		const binding = owner.scope.getBinding(owner.node.id.name);
		return binding?.path.getFunctionParent()?.node === ownerFunction.node;
	}
	if (owner.isAssignmentExpression() && owner.node.right === awaited.node && t.isIdentifier(owner.node.left)) {
		const binding = owner.scope.getBinding(owner.node.left.name);
		return binding?.path.getFunctionParent()?.node === ownerFunction.node;
	}
	return false;
}

function directOpenMember(node: t.Node | null | undefined, scope: Scope): boolean {
	return t.isMemberExpression(node) && directOpenCall(node.object, scope) !== undefined;
}
function childNode(value: unknown): t.Node | undefined {
	return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string"
		? (value as t.Node)
		: undefined;
}

const BINDING_IDENTITIES = new WeakMap<t.Identifier, t.Identifier>();
const HANDLE_VALUE_REFERENCES = new WeakSet<t.Identifier>();
function containsHandleReference(node: t.Node | null | undefined, handles: ReadonlySet<t.Identifier>): boolean {
	if (!node) return false;
	if (
		t.isIdentifier(node) &&
		HANDLE_VALUE_REFERENCES.has(node) &&
		handles.has(BINDING_IDENTITIES.get(node) ?? node)
	)
		return true;
	for (const key of t.VISITOR_KEYS[node.type] ?? []) {
		const value = (node as unknown as Record<string, unknown>)[key];
		if (Array.isArray(value)) {
			if (value.some((item) => containsHandleReference(childNode(item), handles))) return true;
		} else if (containsHandleReference(childNode(value), handles)) {
			return true;
		}
	}
	return false;
}

function isAllowedHandleCall(node: t.Node | null | undefined, handles: ReadonlySet<t.Identifier>): boolean {
	const expression = t.isAwaitExpression(node) ? node.argument : node;
	return (
		t.isCallExpression(expression) &&
		t.isMemberExpression(expression.callee) &&
		t.isIdentifier(expression.callee.object) &&
		handles.has(BINDING_IDENTITIES.get(expression.callee.object) ?? expression.callee.object) &&
		["stat", "read", "close"].includes(memberName(expression.callee) ?? "")
	);
}
function exactBigintOptions(node: t.Node | null | undefined): boolean {
	if (!t.isObjectExpression(node) || node.properties.length !== 1) return false;
	const property = node.properties[0];
	return (
		t.isObjectProperty(property) &&
		!property.computed &&
		t.isIdentifier(property.key, { name: "bigint" }) &&
		t.isBooleanLiteral(property.value, { value: true })
	);
}

function exactReaddirOptions(node: t.Node | null | undefined): boolean {
	if (!t.isObjectExpression(node) || node.properties.length !== 2) return false;
	const properties = new Map<string, t.Node>();
	for (const property of node.properties) {
		if (
			!t.isObjectProperty(property) ||
			property.computed ||
			!t.isIdentifier(property.key) ||
			properties.has(property.key.name)
		)
			return false;
		properties.set(property.key.name, property.value);
	}
	return (
		t.isBooleanLiteral(properties.get("withFileTypes"), { value: true }) &&
		t.isStringLiteral(properties.get("encoding"), { value: "buffer" })
	);
}

function sameReadPosition(left: t.Node, right: t.Node): boolean {
	return (
		(t.isNumericLiteral(left) && t.isNumericLiteral(right) && left.value === right.value) ||
		(t.isIdentifier(left) && t.isIdentifier(right) && left.name === right.name)
	);
}

function immutableNumericBinding(scope: Scope, name: string, value: number): boolean {
	const binding = scope.getBinding(name);
	const declaration = binding?.path.node;
	return (
		binding?.constant === true &&
		t.isVariableDeclarator(declaration) &&
		t.isIdentifier(declaration.id, { name }) &&
		t.isNumericLiteral(declaration.init, { value }) &&
		t.isVariableDeclaration(binding.path.parent) &&
		binding.path.parent.kind === "const"
	);
}

function validReadOffset(node: t.Node, scope: Scope): boolean {
	if (t.isNumericLiteral(node)) return Number.isSafeInteger(node.value) && node.value >= 0;
	if (!t.isIdentifier(node)) return false;
	const binding = scope.getBinding(node.name);
	const declaration = binding?.path.node;
	if (
		!binding ||
		!t.isVariableDeclarator(declaration) ||
		!t.isIdentifier(declaration.id, { name: node.name }) ||
		!t.isNumericLiteral(declaration.init, { value: 0 }) ||
		!t.isVariableDeclaration(binding.path.parent) ||
		binding.path.parent.kind !== "let" ||
		binding.constantViolations.length === 0
	)
		return false;
	return binding.constantViolations.every((violation) => {
		if (!violation.isAssignmentExpression()) return false;
		const assignment = violation.node;
		return (
			assignment.operator === "+=" &&
			t.isIdentifier(assignment.left, { name: node.name }) &&
			t.isMemberExpression(assignment.right) &&
			!assignment.right.computed &&
			t.isIdentifier(assignment.right.property, { name: "bytesRead" })
		);
	});
}

function exactReadLength(node: t.Node, buffer: t.Identifier, offset: t.Node, scope: Scope): boolean {
	if (t.isNumericLiteral(node)) return Number.isSafeInteger(node.value) && node.value > 0 && node.value <= 8192;
	if (
		!t.isCallExpression(node) ||
		!t.isMemberExpression(node.callee) ||
		node.callee.computed ||
		!t.isIdentifier(node.callee.object, { name: "Math" }) ||
		scope.getBinding("Math") ||
		!t.isIdentifier(node.callee.property, { name: "min" }) ||
		node.arguments.length !== 2 ||
		!t.isIdentifier(node.arguments[0], { name: "CHUNK_BYTES" }) ||
		!immutableNumericBinding(scope, "CHUNK_BYTES", 8192)
	)
		return false;
	const remaining = node.arguments[1];
	return (
		t.isBinaryExpression(remaining, { operator: "-" }) &&
		t.isMemberExpression(remaining.left) &&
		!remaining.left.computed &&
		t.isIdentifier(remaining.left.object, { name: buffer.name }) &&
		t.isIdentifier(remaining.left.property, { name: "length" }) &&
		((t.isIdentifier(offset) && t.isIdentifier(remaining.right, { name: offset.name })) ||
			(t.isNumericLiteral(offset) && t.isNumericLiteral(remaining.right) && remaining.right.value === offset.value))
	);
}

function exactReadCall(args: readonly t.Node[], scope: Scope): boolean {
	if (args.length !== 4 || !t.isIdentifier(args[0]) || !sameReadPosition(args[1], args[3])) return false;
	const offset = args[1];
	if (!validReadOffset(offset, scope)) return false;
	return exactReadLength(args[2], args[0], offset, scope);
}

function exactScannerCallSignature(name: string, args: readonly t.Node[], scope: Scope): boolean {
	if (name === "lstat") return args.length === 2 && exactBigintOptions(args[1]);
	if (name === "readdir") return args.length === 2 && exactReaddirOptions(args[1]);
	if (name === "open") return args.length === 2 && isReadonlyOpenFlags(args[1], scope);
	if (name === "stat") return args.length === 1 && exactBigintOptions(args[0]);
	if (name === "close") return args.length === 0;
	if (name === "read") return exactReadCall(args, scope);
	return false;
}

function allowedObjectAssign(node: t.CallExpression): boolean {
	return (
		t.isMemberExpression(node.callee) &&
		!node.callee.computed &&
		t.isIdentifier(node.callee.object, { name: "Object" }) &&
		memberName(node.callee) === "assign" &&
		node.arguments.length === 2 &&
		t.isNewExpression(node.arguments[0]) &&
		t.isIdentifier(node.arguments[0].callee, { name: "Error" }) &&
		t.isObjectExpression(node.arguments[1])
	);
}
function validatePrivilegedImportReferences(ast: t.File, file: string, findings: Finding[]): void {
	traverse(ast, {
		ImportSpecifier(pathNode) {
			const declaration = pathNode.parentPath.node;
			if (
				!t.isImportDeclaration(declaration) ||
				declaration.source.value !== "node:fs/promises" ||
				declaration.importKind === "type" ||
				pathNode.node.importKind === "type"
			)
				return;
			const binding = pathNode.scope.getBinding(pathNode.node.local.name);
			if (!binding) {
				addFinding(findings, file, pathNode.node, RULES.unknownBinding, "unresolved-privileged-import");
				return;
			}
			const capability = importedName(pathNode.node);
			for (const reference of binding.referencePaths) {
				const directCall =
					reference.parentPath?.isCallExpression() && reference.parentPath.node.callee === reference.node;
				if (!directCall)
					addFinding(findings, file, reference.node, RULES.unknownBinding, `capability-transfer:${capability}`);
			}
		},
	});
}
function reflectivePatternKey(property: t.ObjectProperty): string | undefined {
	if (property.computed) return staticStringValue(property.key);
	return t.isIdentifier(property.key) ? property.key.name : t.isStringLiteral(property.key) ? property.key.value : undefined;
}

function validateReflectiveAccess(ast: t.File, file: string, role: Role, findings: Finding[]): void {
	const reject = (node: t.Node, name: string | undefined): void => {
		if (name && REFLECTIVE_MEMBERS.has(name))
			addFinding(findings, file, node, RULES.forbiddenMember, `reflective-member:${name}`);
	};
	traverse(ast, {
		MemberExpression(pathNode) {
			reject(pathNode.node, memberName(pathNode.node));
			if (
				role === "cli" &&
				t.isMetaProperty(pathNode.node.object) &&
				t.isIdentifier(pathNode.node.object.meta, { name: "import" }) &&
				t.isIdentifier(pathNode.node.object.property, { name: "meta" }) &&
				memberName(pathNode.node) !== "main"
			)
				addFinding(
					findings,
					file,
					pathNode.node,
					RULES.forbiddenMember,
					`import-meta:${memberName(pathNode.node) ?? "computed"}`,
				);
			if (
				role === "cli" &&
				pathNode.node.computed &&
				!(
					t.isIdentifier(pathNode.node.object) &&
					["argv", "normalizedArgv"].includes(pathNode.node.object.name)
				)
			)
				addFinding(findings, file, pathNode.node, RULES.unknownBinding, "computed-member");
		},
		OptionalMemberExpression(pathNode) {
			const name = memberName(pathNode.node);
			reject(pathNode.node, name);
			const root = rootIdentifier(pathNode.node);
			if (
				role === "cli" &&
				root &&
				["Bun", "process"].includes(root.name) &&
				!pathNode.scope.getBinding(root.name)
			)
				addFinding(
					findings,
					file,
					pathNode.node,
					RULES.unknownBinding,
					`optional-privileged-member:${name ?? "computed"}`,
				);
			if (role === "cli" && pathNode.node.computed)
				addFinding(findings, file, pathNode.node, RULES.unknownBinding, "computed-member");
		},
		MetaProperty(pathNode) {
			if (
				role !== "cli" ||
				!t.isIdentifier(pathNode.node.meta, { name: "import" }) ||
				!t.isIdentifier(pathNode.node.property, { name: "meta" })
			)
				return;
			const parent = pathNode.parentPath;
			const allowedMain =
				parent?.isMemberExpression() &&
				parent.node.object === pathNode.node &&
				memberName(parent.node) === "main";
			if (!allowedMain)
				addFinding(findings, file, pathNode.node, RULES.unknownBinding, "import-meta-transfer");
		},
		ObjectProperty(pathNode) {
			if (!pathNode.parentPath?.isObjectPattern()) return;
			if (pathNode.node.computed && !t.isStringLiteral(pathNode.node.key))
				addFinding(findings, file, pathNode.node, RULES.unknownBinding, "computed-pattern");
			reject(pathNode.node, reflectivePatternKey(pathNode.node));
		},
		Identifier(pathNode) {
			const reflectiveGlobal = ["Object", "Reflect", "globalThis", "global"].includes(pathNode.node.name);
			const parent = pathNode.parentPath;
			const allowedScannerObjectAssign =
				role === "scanner" &&
				pathNode.node.name === "Object" &&
				parent?.isMemberExpression() &&
				parent.node.object === pathNode.node &&
				parent.parentPath?.isCallExpression() &&
				parent.parentPath.node.callee === parent.node &&
				allowedObjectAssign(parent.parentPath.node);
			if (
				reflectiveGlobal &&
				!allowedScannerObjectAssign &&
				!pathNode.scope.getBinding(pathNode.node.name) &&
				pathNode.isReferencedIdentifier()
			)
				addFinding(
					findings,
					file,
					pathNode.node,
					RULES.forbiddenMember,
					`reflective-global:${pathNode.node.name}`,
				);
		},
	});
}

function validateCapabilities(ast: t.File, file: string, role: Role, findings: Finding[]): void {
	validateReflectiveAccess(ast, file, role, findings);
	if (role === "cli") {
		let processTitleAssignments = 0;
		let processExitCodeAssignments = 0;
		let processExitCalls = 0;
		traverse(ast, {
			Identifier(pathNode) {
				const name = pathNode.node.name;
				if (
					["Bun", "process"].includes(name) &&
					!pathNode.scope.getBinding(name) &&
					pathNode.isReferencedIdentifier()
				) {
					const parent = pathNode.parentPath;
					const directMemberObject =
						((parent?.isMemberExpression() || parent?.isOptionalMemberExpression()) &&
							parent.node.object === pathNode.node);
					if (!directMemberObject)
						addFinding(
							findings,
							file,
							pathNode.node,
							name === "process" ? RULES.process : RULES.forbiddenCall,
							`${name === "process" ? "process-transfer" : "capability-transfer"}:${name}`,
						);
				}
				if (name === "commands" && pathNode.isReferencedIdentifier()) {
					const parent = pathNode.parentPath;
					const allowedSome =
						parent?.isMemberExpression() &&
						parent.node.object === pathNode.node &&
						!parent.node.computed &&
						t.isIdentifier(parent.node.property, { name: "some" });
					const payloadObject = parent?.parentPath;
					const payloadCall = payloadObject?.parentPath;
					const payloadOrigin = payloadCall?.isCallExpression()
						? scopedExpressionOrigin(payloadCall.node.callee, pathNode.scope)
						: undefined;
					const allowedPayload =
						parent?.isObjectProperty() &&
						parent.node.value === pathNode.node &&
						!parent.node.computed &&
						t.isIdentifier(parent.node.key, { name: "commands" }) &&
						payloadObject?.isObjectExpression() &&
						payloadCall?.isCallExpression() &&
						payloadCall.node.arguments.includes(payloadObject.node) &&
						payloadOrigin?.source === "@gajae-code/utils/cli" &&
						payloadOrigin.name === "run";
					if (!allowedSome && !allowedPayload)
						addFinding(findings, file, pathNode.node, RULES.mutation, "registry-mutation");
				}
				if (pathNode.scope.getBinding(name) || !["eval", "require", "fetch", "Function", "WebSocket"].includes(name))
					return;
				const parent = pathNode.parentPath;
				const propertyKey =
					parent?.isMemberExpression() && parent.node.property === pathNode.node && !parent.node.computed;
				const declarationKey =
					parent?.isObjectProperty() &&
					parent.node.key === pathNode.node &&
					parent.node.value !== pathNode.node &&
					!parent.node.computed;
				if (!propertyKey && !declarationKey) addFinding(findings, file, pathNode.node, RULES.forbiddenCall, name);
			},
			CallExpression(pathNode) {
				const callee = unwrapTransparentExpression(pathNode.node.callee);
				if (t.isImport(callee)) return;
				if (!t.isIdentifier(callee) && !t.isMemberExpression(callee) && !t.isSuper(callee))
					addFinding(findings, file, pathNode.node, RULES.unknownBinding, "unsupported-callee");
				if (
					t.isMemberExpression(callee) &&
					t.isIdentifier(callee.object, { name: "process" }) &&
					!pathNode.scope.getBinding("process") &&
					memberName(callee) === "exit"
				) {
					processExitCalls++;
					if (pathNode.node.arguments.length !== 1 || !t.isNumericLiteral(pathNode.node.arguments[0], { value: 1 }))
						addFinding(findings, file, pathNode.node, RULES.process, "process.exit");
				}
				const root = t.isMemberExpression(callee) ? rootIdentifier(callee) : undefined;
				if (
					t.isMemberExpression(callee) &&
					t.isIdentifier(root, { name: "commands" }) &&
					["copyWithin", "fill", "pop", "push", "reverse", "shift", "sort", "splice", "unshift"].includes(
						memberName(callee) ?? "",
					)
				)
					addFinding(findings, file, callee, RULES.mutation, "registry-mutation");
				if (
					t.isMemberExpression(callee) &&
					t.isIdentifier(callee.object, { name: "process" }) &&
					!pathNode.scope.getBinding("process") &&
					memberName(callee) === "getBuiltinModule"
				)
					addFinding(findings, file, callee, RULES.forbiddenCall, "process.getBuiltinModule");
				if (t.isMemberExpression(callee) && ["apply", "bind", "call"].includes(memberName(callee) ?? ""))
					addFinding(
						findings,
						file,
						callee,
						RULES.unknownBinding,
						`indirect-invocation:${memberName(callee)}`,
					);
			},
			MemberExpression(pathNode) {
				const node = pathNode.node;
				if (t.isIdentifier(node.object, { name: "process" }) && !pathNode.scope.getBinding("process")) {
					const allowed = [
						"argv",
						"env",
						"execPath",
						"exit",
						"exitCode",
						"platform",
						"stderr",
						"stdout",
						"title",
					].includes(memberName(node) ?? "");
					if (!allowed) addFinding(findings, file, node, RULES.process, `process.${memberName(node) ?? "computed"}`);
					const processMember = memberName(node);
					if (["exit", "getBuiltinModule", "stderr", "stdout"].includes(processMember ?? "")) {
						const parent = pathNode.parentPath;
						const directCall = parent?.isCallExpression() && parent.node.callee === node;
						const directWrite =
							(processMember === "stderr" || processMember === "stdout") &&
							parent?.isMemberExpression() &&
							parent.node.object === node &&
							!parent.node.computed &&
							t.isIdentifier(parent.node.property, { name: "write" });
						if (!directCall && !directWrite)
							addFinding(findings, file, node, RULES.process, `process-transfer:${processMember}`);
					}
				}
				if (t.isIdentifier(node.object, { name: "Bun" }) && !pathNode.scope.getBinding("Bun")) {
					const allowed = memberName(node) === "version" || memberName(node) === "semver";
					if (!allowed)
						addFinding(findings, file, node, RULES.forbiddenMember, `Bun.${memberName(node) ?? "computed"}`);
				}
				const root = rootIdentifier(node);
				if (
					(t.isIdentifier(root, { name: "globalThis" }) || t.isIdentifier(root, { name: "Deno" })) &&
					!pathNode.scope.getBinding(root.name)
				)
					addFinding(findings, file, node, RULES.forbiddenMember, `${root.name}.${memberName(node) ?? "computed"}`);
			},
			AssignmentExpression(pathNode) {
				const left = pathNode.node.left;
				const directProcessMember =
					t.isMemberExpression(left) &&
					t.isIdentifier(left.object, { name: "process" }) &&
					!pathNode.scope.getBinding("process")
						? memberName(left)
						: undefined;
				const nestedProcessMember =
					t.isMemberExpression(left) &&
					t.isMemberExpression(left.object) &&
					t.isIdentifier(left.object.object, { name: "process" }) &&
					!pathNode.scope.getBinding("process")
						? memberName(left.object)
						: undefined;
				if (pathNode.node.operator === "=" && (directProcessMember === "title" || directProcessMember === "exitCode")) {
					if (directProcessMember === "title") processTitleAssignments++;
					else processExitCodeAssignments++;
					return;
				}
				const root = t.isMemberExpression(left) ? rootIdentifier(left) : undefined;
				if (t.isIdentifier(root, { name: "process" }) && !pathNode.scope.getBinding("process"))
					addFinding(
						findings,
						file,
						left,
						RULES.process,
						`process.${directProcessMember ?? nestedProcessMember ?? "nested"}`,
					);
				addFinding(findings, file, left, RULES.mutation, "assignment");
			},
			NewExpression(pathNode) {
				if (!t.isIdentifier(pathNode.node.callee) || pathNode.scope.getBinding(pathNode.node.callee.name)) return;
				if (["Function", "WebSocket"].includes(pathNode.node.callee.name))
					addFinding(findings, file, pathNode.node.callee, RULES.forbiddenCall, pathNode.node.callee.name);
			},
			OptionalCallExpression(pathNode) {
				const callee = pathNode.node.callee;
				const allowed =
					t.isOptionalMemberExpression(callee) &&
					!callee.computed &&
					t.isIdentifier(callee.property, { name: "includes" });
				if (!allowed) addFinding(findings, file, pathNode.node, RULES.unknownBinding, "optional-call");
			},
			TaggedTemplateExpression(pathNode) {
				addFinding(findings, file, pathNode.node, RULES.forbiddenCall, "tagged-template");
			},
			UpdateExpression(pathNode) {
				if (!t.isIdentifier(pathNode.node.argument))
					addFinding(findings, file, pathNode.node, RULES.mutation, "update");
			},
		});
		if (processTitleAssignments !== 1 || processExitCodeAssignments !== 3 || processExitCalls !== 1)
			addFinding(findings, file, ast.program, RULES.process, "process-assignment-baseline");
		return;
	}
	validatePrivilegedImportReferences(ast, file, findings);
	validateScannerCapabilityBindings(ast, file, findings);
	const handles = new Set<t.Identifier>();
	traverse(ast, {
		Identifier(pathNode) {
			const identity = pathNode.scope.getBinding(pathNode.node.name)?.identifier;
			if (identity) BINDING_IDENTITIES.set(pathNode.node, identity);
			if (identity && pathNode.isReferencedIdentifier() && !pathNode.findParent((parent) => parent.isTSType()))
				HANDLE_VALUE_REFERENCES.add(pathNode.node);
		},
	});
	// Discover handle bindings to a fixed point before checking any use. This is
	// deliberately independent of source order: closures and backward aliases
	// must see assignments that occur later in the module.
	let changed = true;
	while (changed) {
		changed = false;
		traverse(ast, {
			VariableDeclarator(pathNode) {
				if (!t.isIdentifier(pathNode.node.id)) return;
				const identity = pathNode.scope.getBinding(pathNode.node.id.name)?.identifier;
				const init = unwrapTransparentExpression(pathNode.node.init);
				const sourceIdentity =
					t.isIdentifier(init) ? BINDING_IDENTITIES.get(init) ?? pathNode.scope.getBinding(init.name)?.identifier : undefined;
				if (
					identity &&
					(directOpenCall(pathNode.node.init, pathNode.scope) || (sourceIdentity && handles.has(sourceIdentity))) &&
					!handles.has(identity)
				) {
					handles.add(identity);
					changed = true;
				}
			},
			AssignmentExpression(pathNode) {
				if (!t.isIdentifier(pathNode.node.left)) return;
				const identity = pathNode.scope.getBinding(pathNode.node.left.name)?.identifier;
				const right = unwrapTransparentExpression(pathNode.node.right);
				const sourceIdentity =
					t.isIdentifier(right) ? BINDING_IDENTITIES.get(right) ?? pathNode.scope.getBinding(right.name)?.identifier : undefined;
				if (
					identity &&
					(directOpenCall(pathNode.node.right, pathNode.scope) || (sourceIdentity && handles.has(sourceIdentity))) &&
					!handles.has(identity)
				) {
					handles.add(identity);
					changed = true;
				}
			},
		});
	}
	traverse(ast, {
		Identifier(pathNode) {
			const name = pathNode.node.name;
			const identity = pathNode.scope.getBinding(name)?.identifier;
			if (identity) BINDING_IDENTITIES.set(pathNode.node, identity);
			if (identity) return;
			const parent = pathNode.parentPath;
			const nonValuePropertyKey =
				parent?.isObjectProperty() &&
				parent.node.key === pathNode.node &&
				parent.node.value !== pathNode.node &&
				!parent.node.computed;
			const memberProperty =
				parent?.isMemberExpression() && parent.node.property === pathNode.node && !parent.node.computed;
			const memberObject = parent?.isMemberExpression() && parent.node.object === pathNode.node;
			if (nonValuePropertyKey || memberProperty) return;
			if (name === "process") {
				if (!memberObject) addFinding(findings, file, pathNode.node, RULES.process, "process");
				return;
			}
			if (name === "Bun" && memberObject) return;
			if (["Bun", "eval", "fetch", "Function", "require", "WebSocket"].includes(name))
				addFinding(findings, file, pathNode.node, RULES.forbiddenCall, name);
		},
		VariableDeclarator(pathNode) {
			const init = pathNode.node.init;
			if (t.isIdentifier(init) && !pathNode.scope.getBinding(init.name))
				addFinding(findings, file, init, RULES.forbiddenCall, init.name);
			const privileged = scopedExpressionOrigin(init, pathNode.scope);
			if (privileged?.source === "node:fs/promises")
				addFinding(findings, file, pathNode.node, RULES.unknownBinding, `capability-transfer:${privileged.name}`);
			const openCall = directOpenCall(init, pathNode.scope);
			if (openCall) {
				const flags = openCall.arguments[1];
				if (!isReadonlyOpenFlags(flags, pathNode.scope))
					addFinding(findings, file, openCall, RULES.scannerApi, "open:write-mode");
				if (t.isIdentifier(pathNode.node.id)) {
					const identity = pathNode.scope.getBinding(pathNode.node.id.name)?.identifier;
					if (identity) handles.add(identity);
				}
				else addFinding(findings, file, pathNode.node, RULES.scannerApi, "FileHandle.extraction");
			}
			if (t.isIdentifier(init) && handles.has(BINDING_IDENTITIES.get(init) ?? init))
				addFinding(findings, file, pathNode.node, RULES.scannerApi, "FileHandle.extraction");
			if (t.isObjectPattern(pathNode.node.id) && t.isIdentifier(init) && handles.has(BINDING_IDENTITIES.get(init) ?? init))
				addFinding(findings, file, pathNode.node, RULES.scannerApi, "FileHandle.extraction");
			if (
				t.isMemberExpression(init) &&
				((t.isIdentifier(init.object) && handles.has(BINDING_IDENTITIES.get(init.object) ?? init.object)) || directOpenMember(init, pathNode.scope))
			)
				addFinding(findings, file, pathNode.node, RULES.scannerApi, "FileHandle.extraction");
			if (
				containsHandleReference(init, handles) &&
				!isAllowedHandleCall(init, handles) &&
				!t.isIdentifier(init) &&
				!t.isMemberExpression(init)
			)
				addFinding(findings, file, pathNode.node, RULES.scannerApi, "FileHandle.extraction");
		},
		AssignmentExpression(pathNode) {
			const left = pathNode.node.left;
			const right = pathNode.node.right;
			const unwrappedRight = unwrapTransparentExpression(right);
			if (t.isIdentifier(unwrappedRight) && !pathNode.scope.getBinding(unwrappedRight.name))
				addFinding(findings, file, unwrappedRight, RULES.forbiddenCall, unwrappedRight.name);
			const aliasedOrigin = scopedExpressionOrigin(right, pathNode.scope);
			if (aliasedOrigin)
				addFinding(
					findings,
					file,
					pathNode.node,
					RULES.unknownBinding,
					`alias-assignment:${aliasedOrigin.source}:${aliasedOrigin.name}`,
				);
			if (
				(t.isIdentifier(right) && handles.has(BINDING_IDENTITIES.get(right) ?? right)) ||
				(t.isMemberExpression(right) &&
					(t.isIdentifier(right.object) && handles.has(BINDING_IDENTITIES.get(right.object) ?? right.object) || directOpenMember(right, pathNode.scope)))
			)
				addFinding(findings, file, pathNode.node, RULES.scannerApi, "FileHandle.extraction");
			if (containsHandleReference(right, handles) && !isAllowedHandleCall(right, handles))
				addFinding(findings, file, pathNode.node, RULES.scannerApi, "FileHandle.extraction");
			const openCall = directOpenCall(right, pathNode.scope);
			if (!openCall) return;
			const flags = openCall.arguments[1];
			if (!isReadonlyOpenFlags(flags, pathNode.scope))
				addFinding(findings, file, openCall, RULES.scannerApi, "open:write-mode");
			if (t.isIdentifier(left)) {
				const identity = pathNode.scope.getBinding(left.name)?.identifier;
				if (identity) handles.add(identity);
			}
			else addFinding(findings, file, pathNode.node, RULES.scannerApi, "FileHandle.extraction");
		},
	});
	traverse(ast, {
		CallExpression(pathNode) {
			const callee = unwrapTransparentExpression(pathNode.node.callee);
			if (t.isImport(callee)) return;
			if (!t.isIdentifier(callee) && !t.isMemberExpression(callee) && !t.isSuper(callee))
				addFinding(findings, file, pathNode.node, RULES.unknownBinding, "unsupported-callee");
			if (pathNode.node.arguments.some((argument) => containsHandleReference(childNode(argument), handles)))
				addFinding(findings, file, pathNode.node, RULES.scannerApi, "FileHandle.extraction");
			for (const argument of pathNode.node.arguments) {
				const origin = scopedExpressionOrigin(argument, pathNode.scope);
				if (origin?.source === "node:fs/promises")
					addFinding(findings, file, pathNode.node, RULES.unknownBinding, `capability-transfer:${origin.name}`);
			}
			if (t.isIdentifier(callee)) {
				const binding = pathNode.scope.getBinding(callee.name);
				if (!binding) addFinding(findings, file, callee, RULES.forbiddenCall, callee.name);
				const origin = scopedExpressionOrigin(callee, pathNode.scope);
				if (origin && MUTATING_MEMBERS.has(origin.name))
					addFinding(findings, file, callee, RULES.mutation, `${origin.source}:${origin.name}`);
				if (origin?.source === "node:fs/promises") {
					if (role !== "scanner") {
						addFinding(findings, file, callee, RULES.scannerApi, origin.name);
					} else if (origin.name === "open" && !isReadonlyOpenFlags(pathNode.node.arguments[1], pathNode.scope)) {
						addFinding(findings, file, pathNode.node, RULES.scannerApi, "open:write-mode");
					} else if (!exactScannerCallSignature(origin.name, pathNode.node.arguments, pathNode.scope)) {
						addFinding(findings, file, pathNode.node, RULES.scannerApi, `${origin.name}:signature`);
					}
					if (role === "scanner" && origin.name === "open" && !hasDirectOpenOwner(pathNode))
						addFinding(findings, file, pathNode.node, RULES.scannerApi, "FileHandle.extraction");
				}
				return;
			}
			if (!t.isMemberExpression(callee)) return;
			if (directOpenMember(callee, pathNode.scope))
				addFinding(findings, file, callee, RULES.scannerApi, "FileHandle.extraction");
			const allowedDryRunCall =
				role === "command" &&
				t.isIdentifier(callee.object, { name: "flags" }) &&
				t.isStringLiteral(callee.property, { value: "dry-run" });
			if (callee.computed && !allowedDryRunCall)
				addFinding(findings, file, callee, RULES.unknownBinding, "computed-call");
			const name = memberName(callee);
			if (!name) {
				return;
			}
			const root = rootIdentifier(callee);
			if (root && !pathNode.scope.getBinding(root.name) && root.name !== "process") {
				const allowed =
					(root.name === "Bun" &&
						t.isMemberExpression(callee.object) &&
						memberName(callee.object) === "semver" &&
						name === "order") ||
					(root.name === "Object" && name === "assign" && allowedObjectAssign(pathNode.node)) ||
					SAFE_GLOBAL_MEMBERS[root.name]?.has(name) === true;
				if (!allowed) addFinding(findings, file, callee, RULES.forbiddenMember, `${root.name}.${name}`);
			}
			if (t.isIdentifier(callee.object, { name: "process" }) && !pathNode.scope.getBinding("process")) {
				const allowed = role === "command" && isCommandRunPath(pathNode) && ["stdout", "stderr"].includes(name);
				if (!allowed) addFinding(findings, file, callee, RULES.process, `process.${name}`);
			}
			const objectOrigin = scopedExpressionOrigin(callee.object, pathNode.scope);
			const indirectInvocation = ["apply", "bind", "call"].includes(name);
			if (indirectInvocation)
				addFinding(findings, file, callee, RULES.unknownBinding, `indirect-invocation:${name}`);
			if (
				indirectInvocation &&
				t.isMemberExpression(callee.object) &&
				t.isIdentifier(callee.object.object) &&
				handles.has(BINDING_IDENTITIES.get(callee.object.object) ?? callee.object.object)
			)
				addFinding(findings, file, callee, RULES.scannerApi, "FileHandle.extraction");
			if (objectOrigin && MUTATING_MEMBERS.has(name))
				addFinding(findings, file, callee, RULES.mutation, `${objectOrigin.source}:${name}`);
			if (role === "scanner" && objectOrigin?.source === "node:path" && !SCANNER_PATH_CALLS.has(name))
				addFinding(findings, file, callee, RULES.scannerApi, `path.${name}`);
			if (
				name === "bind" &&
				t.isMemberExpression(callee.object) &&
				t.isIdentifier(callee.object.object) &&
				handles.has(BINDING_IDENTITIES.get(callee.object.object) ?? callee.object.object)
			)
				addFinding(findings, file, callee, RULES.scannerApi, "FileHandle.extraction");
			if (t.isIdentifier(callee.object) && handles.has(BINDING_IDENTITIES.get(callee.object) ?? callee.object)) {
				if (role !== "scanner" || !["stat", "read", "close"].includes(name))
					addFinding(findings, file, callee, RULES.scannerApi, `FileHandle.${name}`);
				if (role === "scanner" && !exactScannerCallSignature(name, pathNode.node.arguments, pathNode.scope))
					addFinding(findings, file, pathNode.node, RULES.scannerApi, `FileHandle.${name}:signature`);
			} else if (role === "scanner" && FORBIDDEN_SCANNER_MEMBERS.has(name)) {
				addFinding(findings, file, callee, RULES.scannerApi, name);
			}
		},
		ReturnStatement(pathNode) {
			if (containsHandleReference(pathNode.node.argument, handles))
				addFinding(findings, file, pathNode.node, RULES.scannerApi, "FileHandle.extraction");
			const origin = scopedExpressionOrigin(pathNode.node.argument, pathNode.scope);
			if (origin?.source === "node:fs/promises")
				addFinding(findings, file, pathNode.node, RULES.unknownBinding, `capability-transfer:${origin.name}`);
		},
		ThrowStatement(pathNode) {
			if (containsHandleReference(pathNode.node.argument, handles))
				addFinding(findings, file, pathNode.node, RULES.scannerApi, "FileHandle.extraction");
		},
		YieldExpression(pathNode) {
			if (containsHandleReference(pathNode.node.argument, handles))
				addFinding(findings, file, pathNode.node, RULES.scannerApi, "FileHandle.extraction");
		},
		ForOfStatement(pathNode) {
			if (containsHandleReference(pathNode.node.right, handles))
				addFinding(findings, file, pathNode.node, RULES.scannerApi, "FileHandle.extraction");
		},
		ForInStatement(pathNode) {
			if (containsHandleReference(pathNode.node.right, handles))
				addFinding(findings, file, pathNode.node, RULES.scannerApi, "FileHandle.extraction");
		},
		ExportNamedDeclaration(pathNode) {
			const leaked =
				(t.isVariableDeclaration(pathNode.node.declaration) &&
					containsHandleReference(pathNode.node.declaration, handles)) ||
				pathNode.node.specifiers.some(
					(specifier) => t.isExportSpecifier(specifier) && handles.has(BINDING_IDENTITIES.get(specifier.local) ?? specifier.local),
				);
			if (leaked) addFinding(findings, file, pathNode.node, RULES.scannerApi, "FileHandle.extraction");
			for (const specifier of pathNode.node.specifiers) {
				if (!t.isExportSpecifier(specifier) || !t.isIdentifier(specifier.local)) continue;
				const origin = bindingOrigin(pathNode.scope, specifier.local.name);
				if (origin?.source === "node:fs/promises")
					addFinding(findings, file, specifier, RULES.unknownBinding, `capability-transfer:${origin.name}`);
			}
		},
		ExportDefaultDeclaration(pathNode) {
			if (containsHandleReference(pathNode.node.declaration, handles))
				addFinding(findings, file, pathNode.node, RULES.scannerApi, "FileHandle.extraction");
			const origin = scopedExpressionOrigin(pathNode.node.declaration, pathNode.scope);
			if (origin?.source === "node:fs/promises")
				addFinding(findings, file, pathNode.node, RULES.unknownBinding, `capability-transfer:${origin.name}`);
		},
		ClassProperty(pathNode) {
			if (containsHandleReference(pathNode.node.value, handles))
				addFinding(findings, file, pathNode.node, RULES.scannerApi, "FileHandle.extraction");
		},
		ClassPrivateProperty(pathNode) {
			if (containsHandleReference(pathNode.node.value, handles))
				addFinding(findings, file, pathNode.node, RULES.scannerApi, "FileHandle.extraction");
		},
		NewExpression(pathNode) {
			if (pathNode.node.arguments.some((argument) => containsHandleReference(childNode(argument), handles)))
				addFinding(findings, file, pathNode.node, RULES.scannerApi, "FileHandle.extraction");
			const callee = pathNode.node.callee;
			if (
				t.isIdentifier(callee) &&
				!pathNode.scope.getBinding(callee.name) &&
				!SAFE_GLOBAL_CONSTRUCTORS.has(callee.name)
			)
				addFinding(findings, file, callee, RULES.forbiddenCall, callee.name);
		},
		MemberExpression(pathNode) {
			if (t.isCallExpression(pathNode.parent) && pathNode.parent.callee === pathNode.node) return;
			const allowedDryRunMember =
				role === "command" &&
				t.isIdentifier(pathNode.node.object, { name: "flags" }) &&
				t.isStringLiteral(pathNode.node.property, { value: "dry-run" });
			const allowedArgvMember =
				role === "command" &&
				isCommandRunPath(pathNode) &&
				t.isIdentifier(pathNode.node.object, { name: "argv" }) &&
				pathNode.scope.getBinding("argv") !== undefined &&
				pathNode.node.computed &&
				t.isNumericLiteral(pathNode.node.property, { value: 0 });
			if (pathNode.node.computed && !allowedDryRunMember && !allowedArgvMember)
				addFinding(findings, file, pathNode.node, RULES.unknownBinding, "computed-member");
			const name = memberName(pathNode.node);
			if (!name) return;
			const root = rootIdentifier(pathNode.node);
			if (root && !pathNode.scope.getBinding(root.name) && root.name !== "process") {
				const allowed = SAFE_GLOBAL_MEMBERS[root.name]?.has(name) === true;
				if (!allowed) addFinding(findings, file, pathNode.node, RULES.forbiddenMember, `${root.name}.${name}`);
			}
			const objectOrigin = scopedExpressionOrigin(pathNode.node.object, pathNode.scope);
			if (role === "scanner" && objectOrigin?.source === "node:path" && !SCANNER_PATH_MEMBERS.has(name))
				addFinding(findings, file, pathNode.node, RULES.scannerApi, `path.${name}`);
			if (t.isIdentifier(pathNode.node.object, { name: "process" }) && !pathNode.scope.getBinding("process")) {
				const allowed =
					role === "command" &&
					isCommandRunPath(pathNode) &&
					["exitCode", "platform", "stderr", "stdout"].includes(name);
				if (!allowed) addFinding(findings, file, pathNode.node, RULES.process, `process.${name}`);
			}
		},
		AssignmentExpression(pathNode) {
			if (t.isIdentifier(pathNode.node.left)) return;
			if (!t.isMemberExpression(pathNode.node.left)) {
				addFinding(findings, file, pathNode.node, RULES.mutation, "assignment");
				return;
			}
			const name = memberName(pathNode.node.left);
			const allowedScannerState =
				role === "scanner" &&
				t.isIdentifier(pathNode.node.left.object, { name: "state" }) &&
				["halted", "reserved", "visited"].includes(name ?? "");
			const allowedExit =
				role === "command" &&
				isCommandRunPath(pathNode) &&
				t.isIdentifier(pathNode.node.left.object, { name: "process" }) &&
				name === "exitCode";
			if (!allowedScannerState && !allowedExit)
				addFinding(findings, file, pathNode.node, RULES.mutation, "member-assignment");
		},
		OptionalCallExpression(pathNode) {
			addFinding(findings, file, pathNode.node, RULES.unknownBinding, "optional-call");
		},
		TaggedTemplateExpression(pathNode) {
			addFinding(findings, file, pathNode.node, RULES.forbiddenCall, "tagged-template");
		},
		UpdateExpression(pathNode) {
			const argument = pathNode.node.argument;
			const allowed =
				t.isIdentifier(argument) ||
				(role === "scanner" &&
					t.isMemberExpression(argument) &&
					t.isIdentifier(argument.object, { name: "state" }) &&
					memberName(argument) === "visited");
			if (!allowed) addFinding(findings, file, pathNode.node, RULES.mutation, "update");
		},
	});
}
function validateScannerExportSurface(ast: t.File, file: string, findings: Finding[]): void {
	const expected = new Set([
		"MAX_ENTRIES",
		"WorktreeRootErrorCode",
		"WorktreeRootError",
		"MAX_DEPTH",
		"MAX_NAME_UTF8_BYTES",
		"MAX_METADATA_BYTES",
		"METADATA_RESERVATION_BYTES",
		"MAX_TOTAL_METADATA_BYTES",
		"WorktreeScannerPlatform",
		"ScanWorktreesOptions",
		"WorktreeKind",
		"WorktreeDiagnostic",
		"scanWorktrees",
	]);
	const actual = new Set<string>();
	let scanDeclaration: t.FunctionDeclaration | undefined;
	for (const statement of ast.program.body) {
		if (
			t.isExportDefaultDeclaration(statement) ||
			t.isExportAllDeclaration(statement) ||
			(t.isExportNamedDeclaration(statement) && statement.source)
		) {
			addFinding(findings, file, statement, RULES.scannerApi, "export-surface");
			continue;
		}
		if (!t.isExportNamedDeclaration(statement)) continue;
		if (statement.declaration) {
			const declaration = statement.declaration;
			if (t.isFunctionDeclaration(declaration) && t.isIdentifier(declaration.id, { name: "scanWorktrees" }))
				scanDeclaration = declaration;
			if (t.isVariableDeclaration(declaration)) {
				for (const variable of declaration.declarations) {
					if (t.isIdentifier(variable.id)) actual.add(variable.id.name);
					else addFinding(findings, file, variable, RULES.scannerApi, "export-surface");
				}
			} else if (
				t.isFunctionDeclaration(declaration) ||
				t.isClassDeclaration(declaration) ||
				t.isTSTypeAliasDeclaration(declaration) ||
				t.isTSInterfaceDeclaration(declaration)
			) {
				if (declaration.id) actual.add(declaration.id.name);
			}
		}
		if (statement.specifiers.length > 0) {
			for (const specifier of statement.specifiers) {
				addFinding(findings, file, specifier, RULES.scannerApi, "export-surface");
			}
		}
	}
	if (actual.size !== expected.size || [...expected].some((name) => !actual.has(name))) {
		addFinding(findings, file, ast.program, RULES.scannerApi, "export-surface");
	}
	if (scanDeclaration) {
		const calls = new Set<string>();
		const functions = new Map<t.Identifier, t.Function>();
		const handleBindings = new Set<t.Identifier>();
		traverse(ast, {
			FunctionDeclaration(pathNode) {
				if (pathNode.node.id) {
					const identity = pathNode.scope.getBinding(pathNode.node.id.name)?.identifier;
					if (identity) functions.set(identity, pathNode.node);
				}
			},
			VariableDeclarator(pathNode) {
				if (!t.isIdentifier(pathNode.node.id)) return;
				const identity = pathNode.scope.getBinding(pathNode.node.id.name)?.identifier;
				if (identity && directOpenCall(pathNode.node.init, pathNode.scope)) handleBindings.add(identity);
				if (
					!t.isArrowFunctionExpression(pathNode.node.init) &&
					!t.isFunctionExpression(pathNode.node.init)
				)
					return;
				functions.set(identity!, pathNode.node.init);
			},
			AssignmentExpression(pathNode) {
				if (!t.isIdentifier(pathNode.node.left)) return;
				const identity = pathNode.scope.getBinding(pathNode.node.left.name)?.identifier;
				if (identity && directOpenCall(pathNode.node.right, pathNode.scope)) handleBindings.add(identity);
			},
		});
		// The graph uses binding identities, not source names. Thus shadowed or
		// unrelated objects cannot contribute capabilities.
		let changed = true;
		while (changed) {
			changed = false;
			traverse(ast, {
				VariableDeclarator(pathNode) {
					if (!t.isIdentifier(pathNode.node.id)) return;
					const target = pathNode.scope.getBinding(pathNode.node.id.name)?.identifier;
					const init = unwrapTransparentExpression(pathNode.node.init);
					const source = t.isIdentifier(init)
						? BINDING_IDENTITIES.get(init) ?? pathNode.scope.getBinding(init.name)?.identifier
						: undefined;
					if (target && source && handleBindings.has(source) && !handleBindings.has(target)) {
						handleBindings.add(target);
						changed = true;
					}
				},
				AssignmentExpression(pathNode) {
					if (!t.isIdentifier(pathNode.node.left)) return;
					const target = pathNode.scope.getBinding(pathNode.node.left.name)?.identifier;
					const right = unwrapTransparentExpression(pathNode.node.right);
					const source = t.isIdentifier(right)
						? BINDING_IDENTITIES.get(right) ?? pathNode.scope.getBinding(right.name)?.identifier
						: undefined;
					if (target && source && handleBindings.has(source) && !handleBindings.has(target)) {
						handleBindings.add(target);
						changed = true;
					}
				},
			});
		}
		let scanIdentity: t.Identifier | undefined;
		traverse(ast, {
			Program(pathNode) {
				scanIdentity = pathNode.scope.getBinding("scanWorktrees")?.identifier;
				pathNode.stop();
			},
		});
		const seen = new Set<t.Node>();
		type Completion =
			| "normal"
			| "return"
			| "throw"
			| "break"
			| "continue"
			| `break:${string}`
			| `continue:${string}`;
		type CompletionSet = Set<Completion>;
		const normal = (): CompletionSet => new Set<Completion>(["normal"]);
		const labeledCompletion = (kind: "break" | "continue", label: string): Completion =>
			`${kind}:${label}`;
		const statementCompletion = (statement: t.Statement): CompletionSet => {
			if (t.isReturnStatement(statement)) return new Set(["return"]);
			if (t.isThrowStatement(statement)) return new Set(["throw"]);
			if (t.isBreakStatement(statement))
				return new Set([statement.label ? labeledCompletion("break", statement.label.name) : "break"]);
			if (t.isContinueStatement(statement))
				return new Set([statement.label ? labeledCompletion("continue", statement.label.name) : "continue"]);
			if (t.isBlockStatement(statement)) return blockCompletion(statement.body);
			if (t.isIfStatement(statement)) {
				const branches =
					t.isBooleanLiteral(statement.test) ? (statement.test.value ? [statement.consequent] : statement.alternate ? [statement.alternate] : []) :
					[statement.consequent, ...(statement.alternate ? [statement.alternate] : [])];
				if (!branches.length) return normal();
				const result = new Set<Completion>();
				for (const branch of branches) for (const completion of statementCompletion(branch)) result.add(completion);
				if (!statement.alternate && !t.isBooleanLiteral(statement.test, { value: true })) result.add("normal");
				return result;
			}
			if (t.isTryStatement(statement)) {
				const tryResult = statementCompletion(statement.block);
				const baseResult = new Set<Completion>();
				for (const completion of tryResult) {
					if (completion === "throw" && statement.handler) {
						for (const caught of statementCompletion(statement.handler.body)) baseResult.add(caught);
					} else {
						baseResult.add(completion);
					}
				}
				if (!statement.finalizer) return baseResult;
				const finalizerResult = statementCompletion(statement.finalizer);
				if (!finalizerResult.has("normal"))
					return new Set([...finalizerResult].filter((completion) => completion !== "normal"));
				const result = new Set<Completion>(baseResult);
				for (const completion of finalizerResult) if (completion !== "normal") result.add(completion);
				return result;
			}
			const loopBody = (
				body: t.Statement,
				test: t.Expression | null,
				doWhile: boolean,
				label?: string,
			): CompletionSet => {
				if (!doWhile && t.isBooleanLiteral(test, { value: false })) return normal();
				const bodyResult = statementCompletion(body);
				const result = new Set<Completion>();
				if (!doWhile && test !== null && !t.isBooleanLiteral(test, { value: true })) result.add("normal");
				if (bodyResult.has("return")) result.add("return");
				if (bodyResult.has("throw")) result.add("throw");
				if (bodyResult.has("break") || (label && bodyResult.has(labeledCompletion("break", label))))
					result.add("normal");
				for (const completion of bodyResult) {
					if (
						(completion.startsWith("break:") && completion !== labeledCompletion("break", label ?? "")) ||
						(completion.startsWith("continue:") && completion !== labeledCompletion("continue", label ?? ""))
					)
						result.add(completion);
				}
				if (test === null || t.isBooleanLiteral(test, { value: true })) return result;
				if (
					bodyResult.has("normal") ||
					bodyResult.has("continue") ||
					(label !== undefined && bodyResult.has(labeledCompletion("continue", label)))
				)
					result.add("normal");
				return result;
			};
			const labeledLoop = (body: t.Statement, label: string): CompletionSet | undefined => {
				if (t.isWhileStatement(body)) return loopBody(body.body, body.test, false, label);
				if (t.isForStatement(body)) return loopBody(body.body, body.test ?? null, false, label);
				if (t.isDoWhileStatement(body)) return loopBody(body.body, body.test, true, label);
				return undefined;
			};
			if (t.isLabeledStatement(statement)) {
				const loopResult = labeledLoop(statement.body, statement.label.name);
				if (loopResult) return loopResult;
				const result = new Set<Completion>();
				for (const completion of statementCompletion(statement.body)) {
					if (completion === labeledCompletion("break", statement.label.name)) result.add("normal");
					else result.add(completion);
				}
				return result;
			}
			if (t.isWhileStatement(statement)) return loopBody(statement.body, statement.test, false);
			if (t.isForStatement(statement)) return loopBody(statement.body, statement.test ?? null, false);
			if (t.isDoWhileStatement(statement)) return loopBody(statement.body, statement.test, true);
			return normal();
		};
		function blockCompletion(statements: readonly t.Statement[]): CompletionSet {
			const result = new Set<Completion>();
			let fallsThrough = true;
			for (const statement of statements) {
				if (!fallsThrough) break;
				const completion = statementCompletion(statement);
				for (const value of completion) if (value !== "normal") result.add(value);
				fallsThrough = completion.has("normal");
			}
			if (fallsThrough) result.add("normal");
			return result;
		}
		const isDefinitelyDead = (pathNode: NodePath<t.CallExpression>): boolean => {
			let current: NodePath<t.Node> | null = pathNode;
			while (current?.parentPath) {
				const parent: NodePath<t.Node> = current.parentPath;
				if (parent.isBlockStatement()) {
					const index = parent.node.body.indexOf(current.node as t.Statement);
					if (index >= 0 && !blockCompletion(parent.node.body.slice(0, index)).has("normal")) return true;
				}
				if (parent.isIfStatement()) {
					if (parent.node.consequent === current.node && t.isBooleanLiteral(parent.node.test, { value: false })) return true;
					if (parent.node.alternate === current.node && t.isBooleanLiteral(parent.node.test, { value: true })) return true;
				}
				if (parent.isWhileStatement() || parent.isForStatement()) {
					if (parent.node.body === current.node && t.isBooleanLiteral(parent.node.test, { value: false })) return true;
				}
				if (parent.isLogicalExpression() && parent.node.right === current.node) {
					if ((parent.node.operator === "&&" && t.isBooleanLiteral(parent.node.left, { value: false })) ||
						(parent.node.operator === "||" && t.isBooleanLiteral(parent.node.left, { value: true }))) return true;
				}
				if (parent.isConditionalExpression()) {
					if (parent.node.consequent === current.node && t.isBooleanLiteral(parent.node.test, { value: false })) return true;
					if (parent.node.alternate === current.node && t.isBooleanLiteral(parent.node.test, { value: true })) return true;
				}
				current = parent;
			}
			return false;
		};
		const collect = (node: t.Function): void => {
			if (seen.has(node)) return;
			seen.add(node);
			let unsupportedControlFlow = false;
			traverse(ast, {
				SwitchStatement(pathNode) {
					if (pathNode.getFunctionParent()?.node === node) unsupportedControlFlow = true;
				},
			});
			if (unsupportedControlFlow)
				addFinding(findings, file, node, RULES.scannerApi, "scanner-flow:unsupported-control-flow");
			traverse(ast, {
				CallExpression(pathNode) {
					if (pathNode.getFunctionParent()?.node !== node || isDefinitelyDead(pathNode)) return;
					const callee = unwrapTransparentExpression(pathNode.node.callee);
					if (t.isIdentifier(callee)) {
						const binding = pathNode.scope.getBinding(callee.name)?.identifier;
						const target = binding ? functions.get(binding) : undefined;
						if (target) collect(target);
						const origin = scopedExpressionOrigin(callee, pathNode.scope);
						if (origin?.source === "node:fs/promises" && ["lstat", "readdir", "open"].includes(origin.name))
							calls.add(origin.name);
					} else if (t.isMemberExpression(callee) && !callee.computed && t.isIdentifier(callee.object)) {
						const origin = scopedExpressionOrigin(callee, pathNode.scope);
						if (origin?.source === "node:fs/promises" && ["lstat", "readdir", "open"].includes(origin.name))
							calls.add(origin.name);
						const object = pathNode.scope.getBinding(callee.object.name)?.identifier;
						const member = memberName(callee);
						if (object && handleBindings.has(object) && member && ["stat", "read", "close"].includes(member))
							calls.add(`handle.${member}`);
					}
				},
			});
		};
		if (scanIdentity) {
			const target = functions.get(scanIdentity);
			if (target) collect(target);
		}
		for (const required of ["lstat", "readdir", "open", "handle.stat", "handle.read", "handle.close"]) {
			if (!calls.has(required)) addFinding(findings, file, scanDeclaration, RULES.scannerApi, `scanner-flow:${required}`);
		}
	}
	if (hasIdentifierMutation(ast, new Set(["scanWorktrees"])))
		addFinding(findings, file, scanDeclaration ?? ast.program, RULES.scannerApi, "scanner-binding-mutation");
}

function localSpecifier(specifier: string): boolean {
	return specifier.startsWith(".") || specifier.startsWith("/");
}

interface GraphConfig {
	aliases: Array<{ pattern: string; target: string }>;
	error?: string;
}
type JsonRecord = { [key: string]: unknown };
function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
async function workspacePathAliases(repoRoot: string): Promise<GraphConfig> {
	const aliases: Array<{ pattern: string; target: string }> = [];
	const repoAbsolute = path.resolve(repoRoot);
	const repoReal = await fs.realpath(repoAbsolute).catch(() => undefined);
	const readConfig = async (file: string, seen = new Set<string>()): Promise<string> => {
		const absolute = path.resolve(file);
		if (seen.has(absolute)) throw new Error("tsconfig-extends-cycle");
		const nextSeen = new Set(seen).add(absolute);
		const real = await fs.realpath(absolute).catch(() => undefined);
		if (!real || !repoReal || (real !== repoReal && !real.startsWith(repoReal + path.sep))) throw new Error("tsconfig-out-of-repo");
		let raw: string;
		try {
			raw = await fs.readFile(real, "utf8");
		} catch {
			throw new Error("tsconfig-read");
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			throw new Error("tsconfig-parse");
		}
		if (!isRecord(parsed)) throw new Error("invalid-tsconfig");
		const options = parsed.compilerOptions;
		if (options !== undefined && !isRecord(options)) throw new Error("invalid-tsconfig-options");
		const compilerOptions = (options ?? {}) as JsonRecord;
		let inheritedBase = path.dirname(real);
		if (parsed.extends !== undefined) {
			if (typeof parsed.extends !== "string" || !parsed.extends.startsWith(".")) throw new Error("unsupported-tsconfig-extends");
			inheritedBase = await readConfig(
				path.resolve(path.dirname(real), parsed.extends.endsWith(".json") ? parsed.extends : `${parsed.extends}.json`),
				nextSeen,
			);
		}
		const rawBaseUrl = compilerOptions.baseUrl;
		if (rawBaseUrl !== undefined && typeof rawBaseUrl !== "string") throw new Error("invalid-tsconfig-baseUrl");
		const base = rawBaseUrl === undefined ? inheritedBase : path.resolve(path.dirname(real), rawBaseUrl);
		const baseReal = await fs.realpath(base).catch(() => undefined);
		if (!baseReal || !repoReal || (baseReal !== repoReal && !baseReal.startsWith(repoReal + path.sep))) throw new Error("out-of-repo-baseUrl");
		const paths = compilerOptions.paths;
		if (paths !== undefined && !isRecord(paths)) throw new Error("invalid-tsconfig-paths");
		for (const [pattern, rawTargets] of Object.entries(paths ?? {})) {
			if (!pattern.includes("*") || !Array.isArray(rawTargets) || rawTargets.length !== 1 || typeof rawTargets[0] !== "string")
				throw new Error("unsupported-path-alias");
			const target = rawTargets[0];
			if (!target.includes("*")) throw new Error("unsupported-path-alias");
			const targetBase = path.resolve(base, target.replace("*", ""));
			const targetReal = await fs.realpath(path.dirname(targetBase)).catch(() => undefined);
			if (!targetReal || (targetReal !== repoReal && !targetReal.startsWith(repoReal + path.sep)))
				throw new Error("out-of-repo-path-alias");
			for (let index = aliases.length - 1; index >= 0; index--) if (aliases[index]?.pattern === pattern) aliases.splice(index, 1);
			aliases.push({ pattern, target: path.resolve(base, target) });
		}
		return base;
	};
	try {
		await readConfig(path.join(repoAbsolute, "tsconfig.json"));
		return { aliases };
	} catch (error) {
		const finiteCodes = new Set([
			"tsconfig-out-of-repo",
			"tsconfig-extends-cycle",
			"invalid-tsconfig",
			"invalid-tsconfig-options",
			"unsupported-tsconfig-extends",
			"invalid-tsconfig-baseUrl",
			"out-of-repo-baseUrl",
			"invalid-tsconfig-paths",
			"unsupported-path-alias",
			"out-of-repo-path-alias",
			"tsconfig-read",
			"tsconfig-parse",
		]);
		const code = error instanceof Error && finiteCodes.has(error.message) ? error.message : "invalid-tsconfig";
		return { aliases: [], error: code };
	}
}
async function containedRegularFile(repoRoot: string, relativeOrAbsolute: string): Promise<string | undefined> {
	const repoReal = await fs.realpath(repoRoot).catch(() => undefined);
	const candidate = path.isAbsolute(relativeOrAbsolute) ? relativeOrAbsolute : path.resolve(repoRoot, relativeOrAbsolute);
	const real = await fs.realpath(candidate).catch(() => undefined);
	if (!repoReal || !real || (real !== repoReal && !real.startsWith(repoReal + path.sep))) return undefined;
	try {
		return (await fs.stat(real)).isFile() ? real : undefined;
	} catch {
		return undefined;
	}
}
function graphCandidates(base: string): string[] {
	const extensions = [".ts", ".tsx", ".js", ".jsx"];
	return [base, ...extensions.map((ext) => `${base}${ext}`), ...extensions.map((ext) => path.join(base, `index${ext}`))];
}
async function resolveGraphPaths(repoRoot: string, importer: string, specifier: string, config: GraphConfig): Promise<string[]> {
	if (specifier.startsWith("node:")) return [];
	const importerAbsolute = path.resolve(repoRoot, importer);
	let bases: string[] = [];
	if (localSpecifier(specifier)) bases = [path.resolve(path.dirname(importerAbsolute), specifier)];
	else {
		for (const alias of config.aliases) {
			const [prefix, suffix] = alias.pattern.split("*");
			if (specifier.startsWith(prefix) && specifier.endsWith(suffix ?? "")) {
				const wildcard = specifier.slice(prefix.length, suffix ? -suffix.length : undefined);
				bases.push(alias.target.replace("*", wildcard));
			}
		}
	}
	const repoReal = await fs.realpath(repoRoot).catch(() => undefined);
	if (!repoReal) return [];
	const safe: string[] = [];
	let escaped = false;
	for (const candidate of [...new Set(bases.flatMap((base) => graphCandidates(base)))]) {
		const real = await fs.realpath(candidate).catch(() => undefined);
		if (!real) continue;
		if (real !== repoReal && !real.startsWith(repoReal + path.sep)) {
			escaped = true;
			continue;
		}
		if ((await fs.stat(real).catch(() => undefined))?.isFile()) safe.push(candidate);
	}
	return escaped ? [] : safe;
}

interface SelectedGraphItem {
	path: string;
	exportName: string;
	role: Role;
	binding?: BindingDescriptor;
}
interface BindingDescriptor {
	file: string;
	localName: string;
	declarationStart: number;
	valueKind: "function" | "class" | "variable" | "default" | "unknown";
}
type ExpectedRoleMap = Map<string, Role>;
function isTypeOnlyImport(statement: t.ImportDeclaration): boolean {
	return (
		statement.importKind === "type" ||
		(statement.specifiers.length > 0 &&
			statement.specifiers.every((specifier) => t.isImportSpecifier(specifier) && specifier.importKind === "type"))
	);
}
function isTypeOnlyExport(statement: t.ExportNamedDeclaration | t.ExportAllDeclaration): boolean {
	if (statement.exportKind === "type") return true;
	return (
		t.isExportNamedDeclaration(statement) &&
		statement.specifiers.length > 0 &&
		statement.specifiers.every((specifier) => t.isExportSpecifier(specifier) && specifier.exportKind === "type")
	);
}
function validateGraphBridge(
	ast: t.File,
	file: string,
	findings: Finding[],
	approvedAliases: ReadonlyArray<{ pattern: string; target: string }> = [],
): void {
	const approvedAlias = (source: string): boolean =>
		approvedAliases.some(({ pattern, target }) => {
			if (target.startsWith("node:")) return false;
			const [prefix, suffix = ""] = pattern.split("*");
			return source.startsWith(prefix ?? "") && source.endsWith(suffix);
		});
	for (const statement of ast.program.body) {
		let safe = false;
		if (t.isImportDeclaration(statement)) {
			safe = isTypeOnlyImport(statement);
		} else if (t.isExportNamedDeclaration(statement)) {
			const source = statement.source?.value;
			safe =
				source !== undefined &&
				!source.startsWith("node:") &&
				(localSpecifier(source) || approvedAlias(source)) &&
				statement.specifiers.length > 0 &&
				statement.specifiers.every(
					(specifier) =>
						t.isExportSpecifier(specifier) &&
						t.isIdentifier(specifier.local) &&
						t.isIdentifier(specifier.exported) &&
						specifier.exported.name !== "default" &&
						specifier.exportKind !== "type",
				);
			if (isTypeOnlyExport(statement)) safe = true;
		} else if (t.isExportAllDeclaration(statement)) {
			safe = isTypeOnlyExport(statement) || (!statement.source.value.startsWith("node:") && (localSpecifier(statement.source.value) || approvedAlias(statement.source.value)));
		} else {
			safe = t.isTSInterfaceDeclaration(statement) || t.isTSTypeAliasDeclaration(statement);
		}
		if (!safe) addFinding(findings, file, statement, RULES.unknownBinding, "unsafe-bridge");
	}
}
async function validateReachableGraph(
	repoRoot: string,
	cliRoot: string,
	findings: Finding[],
): Promise<{ reachable: Set<string>; expectedRoles: ExpectedRoleMap }> {
	const config = await workspacePathAliases(repoRoot);
	if (config.error) {
		findings.push({ path: cliRoot, line: 1, column: 1, rule: RULES.unknownBinding, symbol: "tsconfig:" + config.error });
		return { reachable: new Set(), expectedRoles: new Map() };
	}
	const modules = new Map<string, t.File | null>();
	const loadErrors = new Set<string>();
	const load = async (file: string): Promise<t.File | undefined> => {
		if (modules.has(file)) return modules.get(file) ?? undefined;
		try {
			const contained = await containedRegularFile(repoRoot, file);
			if (!contained) throw new Error("module-realpath-escape");
			const source = await fs.readFile(contained, "utf8");
			const ast = parseSource(source);
			if (!ast) {
				modules.set(file, null);
				if (!loadErrors.has(file)) {
					loadErrors.add(file);
					findings.push({ path: file, line: 1, column: 1, rule: RULES.unknownBinding, symbol: "parse" });
				}
				return undefined;
			}
			modules.set(file, ast);
			return ast;
		} catch {
			modules.set(file, null);
			if (!loadErrors.has(file)) {
				loadErrors.add(file);
				findings.push({ path: file, line: 1, column: 1, rule: RULES.unknownBinding, symbol: "read-error" });
			}
			return undefined;
		}
	};
	const resolve = async (importer: string, specifier: string, node: t.Node): Promise<string | undefined> => {
		if (specifier.startsWith("node:")) return undefined;
		const candidates = await resolveGraphPaths(repoRoot, importer, specifier, config);
		if (candidates.length !== 1) {
			addFinding(findings, importer, node, RULES.unknownBinding, candidates.length ? `ambiguous-edge:${specifier}` : `unresolved-edge:${specifier}`);
			return undefined;
		}
		return path.relative(repoRoot, candidates[0]!).split(path.sep).join("/");
	};
	const exportedBinding = async (file: string, name: string, seen = new Set<string>()): Promise<BindingDescriptor[]> => {
		const key = `${file}\0${name}`;
		if (seen.has(key)) return [];
		seen.add(key);
		const ast = await load(file);
		if (!ast) return [];
		resolutionVisited.add(file);
		const candidates = new Map<string, BindingDescriptor>();
		const addCandidate = (candidate: BindingDescriptor): void => {
			candidates.set(`${candidate.file}\0${candidate.declarationStart}\0${candidate.localName}`, candidate);
		};
		for (const statement of ast.program.body) {
			const declaration = t.isExportNamedDeclaration(statement) ? statement.declaration : statement;
			if (t.isExportNamedDeclaration(statement) && statement.source) {
				if (isTypeOnlyExport(statement)) {
					if (statement.specifiers.some((specifier) => t.isExportSpecifier(specifier) && t.isIdentifier(specifier.exported) && specifier.exported.name === name))
						addFinding(findings, file, statement, RULES.unknownBinding, "type-only-selection");
					continue;
				}
				const specifier = statement.specifiers.find(
					(item) => t.isExportSpecifier(item) && t.isIdentifier(item.exported) && item.exported.name === name,
				);
				if (specifier && t.isExportSpecifier(specifier)) {
					if (specifier.exportKind === "type") {
						addFinding(findings, file, statement, RULES.unknownBinding, "type-only-selection");
						continue;
					}
					const target = await resolve(file, statement.source.value, statement);
					for (const result of target ? await exportedBinding(target, t.isIdentifier(specifier.local) ? specifier.local.name : name, seen) : [])
						addCandidate(result);
				}
			}
			if (t.isExportAllDeclaration(statement)) {
				if (isTypeOnlyExport(statement)) {
					continue;
				}
				const target = await resolve(file, statement.source.value, statement);
				for (const result of target ? await exportedBinding(target, name, new Set(seen)) : []) addCandidate(result);
			}
			if (t.isExportNamedDeclaration(statement) && !statement.source && statement.specifiers.length) {
				const specifier = statement.specifiers.find(
					(item) => t.isExportSpecifier(item) && t.isIdentifier(item.exported) && item.exported.name === name,
				);
				if (specifier && t.isExportSpecifier(specifier)) {
					if (specifier.exportKind === "type") {
						addFinding(findings, file, statement, RULES.unknownBinding, "type-only-selection");
						continue;
					}
					if (isTypeOnlyExport(statement)) {
						addFinding(findings, file, statement, RULES.unknownBinding, "type-only-selection");
						continue;
					}
					const localName = t.isIdentifier(specifier.local) ? specifier.local.name : undefined;
					const localDeclaration = localName
						? ast.program.body.find((candidate) => {
								const declaration = t.isExportNamedDeclaration(candidate) ? candidate.declaration : candidate;
								return (
									(t.isFunctionDeclaration(declaration) || t.isClassDeclaration(declaration)) &&
									declaration.id?.name === localName
								) || (t.isVariableDeclaration(declaration) &&
									declaration.declarations.some((item) => t.isIdentifier(item.id, { name: localName })));
							})
						: undefined;
					if (localDeclaration && localName) {
						const declaration = t.isExportNamedDeclaration(localDeclaration) ? localDeclaration.declaration : localDeclaration;
						addCandidate({
							file,
							localName,
							declarationStart: declaration?.start ?? localDeclaration.start ?? 0,
							valueKind: t.isFunctionDeclaration(declaration) ? "function" : t.isClassDeclaration(declaration) ? "class" : "variable",
						});
						continue;
					}
					const imported = ast.program.body.find(
						(item): item is t.ImportDeclaration =>
							t.isImportDeclaration(item) && item.specifiers.some((s) => t.isIdentifier(s.local, { name: specifier.local.name })),
					);
					if (imported) {
						const local = imported.specifiers.find((s) => t.isIdentifier(s.local, { name: specifier.local.name }));
						const target = await resolve(file, imported.source.value, imported);
						const selected = local && t.isImportSpecifier(local) ? importedName(local) : local && t.isImportDefaultSpecifier(local) ? "default" : "namespace";
						if (isTypeOnlyImport(imported) || (local && "importKind" in local && local.importKind === "type") || selected === "namespace") {
							addFinding(findings, file, statement, RULES.unknownBinding, selected === "namespace" ? "namespace-selection" : "type-only-selection");
						} else {
							for (const result of target ? await exportedBinding(target, selected, new Set(seen)) : []) addCandidate(result);
						}
					} else addCandidate({ file, localName: specifier.local.name, declarationStart: statement.start ?? 0, valueKind: "unknown" });
				}
			}
			if (
				t.isExportNamedDeclaration(statement) &&
				((t.isFunctionDeclaration(declaration) || t.isClassDeclaration(declaration)) && declaration.id?.name === name ||
					t.isVariableDeclaration(declaration) && declaration.declarations.some((item) => t.isIdentifier(item.id, { name })))
			)
				addCandidate({
					file,
					localName: name,
					declarationStart: declaration.start ?? statement.start ?? 0,
					valueKind: t.isFunctionDeclaration(declaration) ? "function" : t.isClassDeclaration(declaration) ? "class" : "variable",
				});
		}
		if (name === "default" && ast.program.body.some((statement) => t.isExportDefaultDeclaration(statement)))
			addCandidate({ file, localName: "default", declarationStart: ast.program.body.find((statement) => t.isExportDefaultDeclaration(statement))?.start ?? 0, valueKind: "default" });
		return [...candidates.values()];
	};
	const queue: SelectedGraphItem[] = [{ path: cliRoot, exportName: "commands", role: "cli" }];
	const expectedRoles: ExpectedRoleMap = new Map([[cliRoot, "cli"]]);
	const enqueue = (item: SelectedGraphItem): void => {
		const prior = expectedRoles.get(item.path);
		if (prior && prior !== item.role) {
			addFinding(findings, item.path, { type: "Program", loc: undefined } as t.Node, RULES.unknownBinding, `conflicting-role:${prior},${item.role}`);
			return;
		}
		expectedRoles.set(item.path, item.role);
		queue.push(item);
	};
	const seenItems = new Set<string>();
	const resolutionVisited = new Set<string>();
	const reachable = new Set<string>();
	while (queue.length) {
		const item = queue.shift()!;
		const key = `${item.path}\0${item.exportName}\0${item.role}`;
		if (seenItems.has(key)) continue;
		seenItems.add(key);
		const ast = await load(item.path);
		if (!ast) {
			if (!loadErrors.has(item.path)) addFinding(findings, item.path, { type: "Program", loc: undefined } as t.Node, RULES.unknownBinding, "unresolved-root");
			continue;
		}
		if (item.binding) {
			const exact = ast.program.body.some((statement) => {
				const declaration = t.isExportNamedDeclaration(statement) ? statement.declaration : undefined;
				if (!declaration || (declaration.start ?? -1) !== item.binding!.declarationStart) return false;
				if (t.isFunctionDeclaration(declaration) || t.isClassDeclaration(declaration))
					return declaration.id?.name === item.binding!.localName &&
						item.binding!.valueKind === (t.isFunctionDeclaration(declaration) ? "function" : "class");
				if (t.isVariableDeclaration(declaration))
					return declaration.declarations.length === 1 &&
						t.isIdentifier(declaration.declarations[0]?.id, { name: item.binding!.localName }) &&
						item.binding!.valueKind === "variable";
				return false;
			});
			if (!exact) {
				addFinding(findings, item.path, ast.program, RULES.unknownBinding, "selected-binding-mismatch");
				continue;
			}
		}
		reachable.add(item.path);
		if (item.role === "cli") {
			const edges: t.CallExpression[] = [];
			traverse(ast, { CallExpression(p) { if (staticImportSource(p.node) === "./commands/worktree") edges.push(p.node); } });
			if (edges.length !== 1) addFinding(findings, item.path, ast.program, RULES.registryEdge, `selected-edge-count:${edges.length}`);
			if (edges.length === 1) {
				const target = await resolve(item.path, "./commands/worktree", edges[0]!);
				const targets = target ? await exportedBinding(target, "createWorktreeCommand") : [];

				if (targets.length === 1) enqueue({ path: targets[0]!.file, exportName: "createWorktreeCommand", role: "command", binding: targets[0]! });
				else addFinding(findings, item.path, edges[0]!, RULES.registryEdge, "selected-command-ambiguous");
			}
		} else if (item.role === "command" || item.role === "worker") {
			const specifier = item.role === "command" ? "../cli/worktree-cli" : "./worktree-scanner";
			const name = item.role === "command" ? "runWorktreeCommand" : "scanWorktrees";
			const target = await resolve(item.path, specifier, ast.program);
			const targets = target ? await exportedBinding(target, name) : [];
			if (targets.length === 1) enqueue({ path: targets[0]!.file, exportName: name, role: item.role === "command" ? "worker" : "scanner", binding: targets[0]! });
			else addFinding(findings, item.path, ast.program, RULES.workerEdge, `selected-${name}-ambiguous`);
		}
	}
	for (const role of ["cli", "command", "worker", "scanner"] as Role[]) {
		const count = [...seenItems].filter((item) => item.endsWith(`\0${role}`)).length;
		if (count !== 1) findings.push({ path: cliRoot, line: 1, column: 1, rule: RULES.workerEdge, symbol: `reachable-${role}:${count}` });
	}
	for (const file of resolutionVisited) {
		if (expectedRoles.has(file)) continue;
		const ast = await load(file);
		if (!ast) continue;
		validateGraphBridge(ast, file, findings, config.aliases);
		for (const statement of ast.program.body) {
			if (
				(t.isImportDeclaration(statement) && isTypeOnlyImport(statement)) ||
				((t.isExportNamedDeclaration(statement) || t.isExportAllDeclaration(statement)) && isTypeOnlyExport(statement))
			)
				continue;
			const source =
				t.isImportDeclaration(statement) || t.isExportNamedDeclaration(statement) || t.isExportAllDeclaration(statement)
					? statement.source?.value
					: undefined;
			if (!source || source.startsWith("node:")) continue;
			const target = await resolve(file, source, statement);
			if (target) {
				resolutionVisited.add(target);
				await load(target);
			} else {
				addFinding(findings, file, statement, RULES.unknownBinding, `unresolved-edge:${source}`);
			}
		}
	}
	return { reachable, expectedRoles };
}
export function sortFindings(findings: readonly Finding[]): Finding[] {
	const unique = new Map<string, Finding>();
	for (const finding of findings) {
		unique.set(`${finding.path}\0${finding.line}\0${finding.column}\0${finding.rule}\0${finding.symbol}`, finding);
	}
	return [...unique.values()].sort(
		(a, b) =>
			compareText(a.path, b.path) ||
			a.line - b.line ||
			a.column - b.column ||
			compareText(a.rule, b.rule) ||
			compareText(a.symbol, b.symbol),
	);
}

function compareText(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

export function formatFinding(finding: Finding): string {
	return `${finding.path}:${finding.line}:${finding.column} ${finding.rule} ${finding.symbol}`;
}

export function analyzeSource(source: string, relativePath: string): Finding[] {
	return analyzeSourceWithRole(source, relativePath);
}
function analyzeSourceWithRole(source: string, relativePath: string, roleOverride?: Role): Finding[] {
	const ast = parseSource(source);
	if (!ast) {
		return [
			{
				path: relativePath,
				line: 1,
				column: 1,
				rule: RULES.unknownBinding,
				symbol: "parse",
			},
		];
	}
	const role = roleOverride ?? roleFor(relativePath);
	const findings: Finding[] = [];
	validateImports(ast, relativePath, role, findings);
	validateDynamicImports(ast, relativePath, role, findings);
	validateCapabilities(ast, relativePath, role, findings);
	if (role === "scanner" && relativePath === "packages/coding-agent/src/cli/worktree-scanner.ts")
		validateScannerExportSurface(ast, relativePath, findings);
	if (role === "cli") validateRegistry(ast, relativePath, findings);
	if (role === "command") validateCommandFlow(ast, relativePath, findings);
	if (role === "worker") validateWorkerFlow(ast, relativePath, findings);
	return sortFindings(findings);
}

export async function verifyWorktreeReportCapabilities(options: VerifyOptions = {}): Promise<Finding[]> {
	const repoRoot = path.resolve(options.repoRoot ?? path.join(import.meta.dir, ".."));
	const requestedRoots = options.roots ?? [];
	const isolatedGraphRoot = options.graphRoot;
	const roots = isolatedGraphRoot ? [isolatedGraphRoot] : [...DEFAULT_ROOTS];
	const findings: Finding[] = [];
	const seenRequested = new Set<string>(roots.map((root) => path.resolve(repoRoot, root)));
	for (const root of requestedRoots) {
		const canonical = root.split("/").join("/");
		const segments = canonical.split("/");
		const valid =
			canonical.length > 0 &&
			canonical === path.posix.normalize(canonical) &&
			!canonical.startsWith("/") &&
			!canonical.includes("\\") &&
			!segments.includes(".") &&
			!segments.includes("..") &&
			!path.posix.isAbsolute(canonical);
		const absolute = path.resolve(repoRoot, canonical);
		if (!valid || seenRequested.has(absolute)) {
			findings.push({
				path: root,
				line: 1,
				column: 1,
				rule: RULES.unknownBinding,
				symbol: seenRequested.has(absolute) ? "duplicate-root" : "invalid-replacement-root",
			});
			continue;
		}
		seenRequested.add(absolute);
		roots.push(canonical);
	}
	const cliRoot = isolatedGraphRoot ?? DEFAULT_ROOTS[0]!;
	const repoReal = await fs.realpath(repoRoot).catch(() => undefined);
	const cliReal = await fs.realpath(path.resolve(repoRoot, cliRoot)).catch(() => undefined);
	if (!repoReal || !cliReal || !(cliReal === repoReal || cliReal.startsWith(repoReal + path.sep))) {
		findings.push({ path: cliRoot, line: 1, column: 1, rule: RULES.unknownBinding, symbol: "root-realpath-escape" });
	}
	const { reachable, expectedRoles } = await validateReachableGraph(repoRoot, cliRoot, findings);
	for (const root of roots) {
		if (root !== cliRoot && reachable.has(root)) continue;
		const absolute = await containedRegularFile(repoRoot, root);
		if (!absolute) {
			findings.push({ path: root, line: 1, column: 1, rule: RULES.unknownBinding, symbol: "unresolved-root" });
			continue;
		}
		let source: string;
		try {
			source = await fs.readFile(absolute, "utf8");
		} catch {
			findings.push({ path: root, line: 1, column: 1, rule: RULES.unknownBinding, symbol: "unresolved-root" });
			continue;
		}
		findings.push(...analyzeSourceWithRole(source, root.replaceAll(path.sep, "/"), expectedRoles.get(root)));
	}
	for (const root of reachable) {
		const absolute = await containedRegularFile(repoRoot, root);
		if (!absolute) {
			findings.push({ path: root, line: 1, column: 1, rule: RULES.unknownBinding, symbol: "unresolved-root" });
			continue;
		}
		let source: string;
		try {
			source = await fs.readFile(absolute, "utf8");
		} catch {
			findings.push({ path: root, line: 1, column: 1, rule: RULES.unknownBinding, symbol: "read-error" });
			continue;
		}
		findings.push(...analyzeSourceWithRole(source, root, expectedRoles.get(root)));
	}
	return sortFindings(findings);
}

export interface MainOptions {
	verify?: () => Promise<Finding[]>;
	write?: (text: string) => unknown;
}

export async function main(_argv: readonly string[] = process.argv, options: MainOptions = {}): Promise<number> {
	const findings = await (options.verify ?? verifyWorktreeReportCapabilities)();
	const write = options.write ?? ((text: string) => process.stderr.write(text));
	for (const finding of findings) write(`${formatFinding(finding)}\n`);
	return findings.length === 0 ? 0 : 1;
}

if (import.meta.main) process.exitCode = await main();
