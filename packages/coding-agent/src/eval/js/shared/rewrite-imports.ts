import { parse as babelParse } from "@babel/parser";

// Static ESM `import` declarations are not valid inside vm.runInContext (script-mode parsing),
// and dynamic `import(...)` would otherwise resolve specifiers against the worker module's URL
// instead of the session cwd. We rewrite both forms so they route through the worker-injected
// `__gjc_import__` helper, which resolves the specifier against the active session cwd. A real
// parser keeps imports embedded in string literals, template literals, or comments intact.

type BabelImportDeclaration = {
	type: "ImportDeclaration";
	start: number;
	end: number;
	source: { value: string };
	specifiers: ReadonlyArray<{
		type: "ImportDefaultSpecifier" | "ImportNamespaceSpecifier" | "ImportSpecifier";
		local: { name: string };
		imported?: { type: "Identifier"; name: string } | { type: "StringLiteral"; value: string };
	}>;
	attributes?: ReadonlyArray<{
		key: { type: "Identifier"; name: string } | { type: "StringLiteral"; value: string };
		value: { value: string };
	}>;
};

type BabelBindingPattern = {
	type: string;
	name?: string;
	properties?: ReadonlyArray<unknown>;
	elements?: ReadonlyArray<unknown | null>;
	argument?: unknown;
	left?: unknown;
	value?: unknown;
};

type BabelVariableDeclaration = {
	type: "VariableDeclaration";
	kind: "const" | "let" | "var";
	start: number;
	end: number;
	declarations?: ReadonlyArray<{ id: BabelBindingPattern }>;
};

type BabelClassDeclaration = {
	type: "ClassDeclaration";
	start: number;
	end: number;
	id: { start: number; end: number; name: string } | null;
};

type BabelLexicalDecl = BabelVariableDeclaration | BabelClassDeclaration;

type BabelExpressionStatement = {
	type: "ExpressionStatement";
	start: number;
	end: number;
	expression?: { type?: string };
};

type BabelProgramNode = BabelImportDeclaration | BabelLexicalDecl | BabelExpressionStatement | { type: string };

type BabelNode = { type: string; start: number; end: number; [key: string]: unknown };

function parseProgram(code: string): { program: { body: ReadonlyArray<BabelProgramNode> } } | null {
	try {
		return babelParse(code, {
			sourceType: "module",
			allowAwaitOutsideFunction: true,
			allowReturnOutsideFunction: true,
			allowImportExportEverywhere: true,
			allowNewTargetOutsideFunction: true,
			allowSuperOutsideMethod: true,
			allowUndeclaredExports: true,
			errorRecovery: true,
		}) as unknown as { program: { body: ReadonlyArray<BabelProgramNode> } };
	} catch {
		return null;
	}
}

function buildGjcImportCall(sourceLiteral: string, optionsLiteral: string | undefined): string {
	// Route every static import through the worker-injected `__gjc_import__` helper so the
	// specifier resolves against the session cwd (and `with`-attribute imports keep working).
	return optionsLiteral ? `__gjc_import__(${sourceLiteral}, ${optionsLiteral})` : `__gjc_import__(${sourceLiteral})`;
}

// Walks every node in `root`, depth-first, invoking `visit` on each one. Skips Babel's
// non-AST bookkeeping fields so we don't recurse into source locations or comment arrays.
function walkNodes(root: unknown, visit: (node: BabelNode) => void): void {
	const stack: unknown[] = [root];
	while (stack.length > 0) {
		const current = stack.pop();
		if (!current || typeof current !== "object") continue;
		if (Array.isArray(current)) {
			for (let i = current.length - 1; i >= 0; i--) stack.push(current[i]);
			continue;
		}
		const node = current as Record<string, unknown>;
		if (typeof node.type === "string") visit(node as unknown as BabelNode);
		for (const key in node) {
			if (key === "loc" || key === "extra" || key === "range") continue;
			if (key === "leadingComments" || key === "trailingComments" || key === "innerComments") continue;
			const value = node[key];
			if (value && typeof value === "object") stack.push(value);
		}
	}
}

function buildOptionsLiteral(node: BabelImportDeclaration): string | undefined {
	const attrs = node.attributes;
	if (!attrs || attrs.length === 0) return undefined;
	const pairs = attrs.map(attr => {
		const key = attr.key.type === "Identifier" ? attr.key.name : JSON.stringify(attr.key.value);
		return `${key}: ${JSON.stringify(attr.value.value)}`;
	});
	// Native dynamic import takes options as `{ with: { ... } }`. `__gjc_import__` forwards the
	// options bag verbatim, so we wrap the attribute pairs accordingly.
	return `{ with: { ${pairs.join(", ")} } }`;
}

function rewriteImportNode(node: BabelImportDeclaration): string {
	const sourceLiteral = JSON.stringify(node.source.value);
	const optionsLiteral = buildOptionsLiteral(node);
	const importCall = buildGjcImportCall(sourceLiteral, optionsLiteral);

	let defaultName: string | undefined;
	let namespaceName: string | undefined;
	const namedPairs: Array<[string, string]> = [];
	for (const spec of node.specifiers) {
		if (spec.type === "ImportDefaultSpecifier") {
			defaultName = spec.local.name;
		} else if (spec.type === "ImportNamespaceSpecifier") {
			namespaceName = spec.local.name;
		} else if (spec.type === "ImportSpecifier" && spec.imported) {
			const imported = spec.imported.type === "Identifier" ? spec.imported.name : spec.imported.value;
			namedPairs.push([imported, spec.local.name]);
		}
	}

	if (namedPairs.length > 0) {
		const inner = namedPairs.map(([imp, loc]) => (imp === loc ? imp : `${imp}: ${loc}`)).join(", ");
		const props = defaultName ? `default: ${defaultName}, ${inner}` : inner;
		return `const { ${props} } = await ${importCall};`;
	}
	if (namespaceName && defaultName) {
		return `const ${namespaceName} = await ${importCall}; const ${defaultName} = ${namespaceName}.default;`;
	}
	if (namespaceName) return `const ${namespaceName} = await ${importCall};`;
	if (defaultName) return `const ${defaultName} = (await ${importCall}).default;`;
	return `await ${importCall};`;
}

export function rewriteImports(code: string): string {
	if (!code.includes("import")) return code;

	const ast = parseProgram(code);
	if (!ast) {
		// Parser bailed entirely — let the VM surface the real syntax error.
		return code;
	}

	type Edit = { start: number; end: number; text: string };
	const edits: Edit[] = [];

	// Top-level static `import` declarations become `await __gjc_import__(...)` calls.
	for (const node of ast.program.body) {
		if (node.type !== "ImportDeclaration") continue;
		const decl = node as unknown as BabelImportDeclaration;
		edits.push({ start: decl.start, end: decl.end, text: rewriteImportNode(decl) });
	}

	// Dynamic `import(...)` expressions (anywhere) get their callee swapped for `__gjc_import__`
	// so the specifier resolves against the session cwd instead of the worker module's URL.
	walkNodes(ast, node => {
		if (node.type !== "CallExpression") return;
		const call = node as unknown as { callee?: { type?: string; start?: number; end?: number } };
		const callee = call.callee;
		if (callee?.type !== "Import" || typeof callee.start !== "number" || typeof callee.end !== "number") return;
		edits.push({ start: callee.start, end: callee.end, text: "__gjc_import__" });
	});

	if (edits.length === 0) return code;

	// Splice from the back so earlier offsets stay valid.
	edits.sort((a, b) => b.start - a.start);
	let result = code;
	for (const edit of edits) {
		result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
	}
	return result;
}

function collectBindingNames(pattern: unknown, names: string[]): void {
	if (!pattern || typeof pattern !== "object") return;
	const node = pattern as BabelBindingPattern & { parameter?: unknown };
	switch (node.type) {
		case "Identifier":
			if (typeof node.name === "string") names.push(node.name);
			return;
		case "ObjectPattern":
			for (const property of node.properties ?? []) collectBindingNames(property, names);
			return;
		case "ObjectProperty":
		case "Property":
			collectBindingNames(node.value, names);
			return;
		case "ArrayPattern":
			for (const element of node.elements ?? []) collectBindingNames(element, names);
			return;
		case "AssignmentPattern":
			collectBindingNames(node.left, names);
			return;
		case "RestElement":
			collectBindingNames(node.argument, names);
			return;
		case "TSParameterProperty":
			collectBindingNames(node.parameter, names);
			return;
		default:
			return;
	}
}

function getLexicalBindingNames(node: BabelLexicalDecl): string[] {
	const names: string[] = [];
	if (node.type === "VariableDeclaration") {
		for (const declaration of node.declarations ?? []) collectBindingNames(declaration.id, names);
	} else if (node.id) {
		names.push(node.id.name);
	}
	return names;
}

function appendGlobalBindingPublish(source: string, names: readonly string[]): string {
	if (names.length === 0) return source;
	const assignments = names.map(name => `this[${JSON.stringify(name)}] = ${name};`).join("\n");
	return `${source};\n${assignments}`;
}

/**
 * Demote top-level `const`/`let`/`class` declarations to `var` so they persist on the
 * worker's globalThis across indirect `eval` calls. Indirect eval gives each call its own
 * lexical environment, so `const x = 1` in one cell would be invisible to the next.
 * `var` and function declarations are stored on the global object and survive across cells.
 *
 *   const x = 1;             -> var x = 1;
 *   let { a, b } = obj;      -> var { a, b } = obj;
 *   class Foo extends Bar {} -> var Foo = class extends Bar {};
 *
 * When the source must run inside the async wrapper, demoted `var`s would normally become
 * function-scoped. In that mode we publish each top-level binding back to the wrapper's
 * lexical `this`, which is the worker global object.
 *
 * Nested declarations (inside functions, blocks, classes) are left alone \u2014 they're
 * scoped to their enclosing function/block regardless of `var` vs `let`/`const`.
 */
function demoteTopLevelLexicals(code: string, options: { publishGlobals?: boolean } = {}): string {
	if (!/\b(?:const|let|class)\b/.test(code)) return code;

	const ast = parseProgram(code);
	if (!ast) {
		return code;
	}

	const targets: BabelLexicalDecl[] = [];
	for (const node of ast.program.body) {
		if (node.type === "VariableDeclaration") {
			const decl = node as unknown as BabelVariableDeclaration;
			if (decl.kind === "const" || decl.kind === "let") targets.push(decl);
		} else if (node.type === "ClassDeclaration") {
			const decl = node as unknown as BabelClassDeclaration;
			if (decl.id) targets.push(decl);
		}
	}
	if (targets.length === 0) return code;

	targets.sort((a, b) => b.start - a.start);
	let result = code;
	for (const node of targets) {
		const segment = result.slice(node.start, node.end);
		const bindingNames = options.publishGlobals ? getLexicalBindingNames(node) : [];
		let replacement: string;
		if (node.type === "VariableDeclaration") {
			replacement = `var${segment.slice(node.kind.length)}`;
		} else {
			const id = node.id;
			if (!id) continue;
			const idEndInSegment = id.end - node.start;
			const tail = segment.slice(idEndInSegment);
			const hasTrailingSemi = segment.endsWith(";");
			replacement = `var ${id.name} = class${tail}${hasTrailingSemi ? "" : ";"}`;
		}
		result =
			result.slice(0, node.start) + appendGlobalBindingPublish(replacement, bindingNames) + result.slice(node.end);
	}
	return result;
}

function returnFinalExpression(code: string): { source: string; returned: boolean } {
	const ast = parseProgram(code);
	const body = ast?.program.body;
	if (!body) return { source: code, returned: false };
	let lastIndex = body.length - 1;
	while (lastIndex >= 0 && body[lastIndex]?.type === "EmptyStatement") lastIndex--;
	const last = lastIndex >= 0 ? body[lastIndex] : undefined;
	if (last?.type === "ExpressionStatement") {
		const expression = last as BabelExpressionStatement;
		const prefix = code.slice(0, expression.start);
		const statement = code.slice(expression.start, expression.end);
		const suffix = code.slice(expression.end);
		const semicolonMatch = statement.match(/;\s*$/);
		const trimmedStatement = semicolonMatch ? statement.slice(0, semicolonMatch.index) : statement;
		return { source: `${prefix}__gjc_set_final_expr__((${trimmedStatement}));${suffix}`, returned: true };
	}
	if (last?.type === "ReturnStatement") {
		// Top-level `return value;` is otherwise swallowed: it forces the cell into an async IIFE
		// wrapper that discards the returned value. Rewrite into `__gjc_set_final_expr__((expr))`
		// so the runtime can surface the value to the caller just like a trailing expression.
		const ret = last as unknown as { start: number; end: number; argument?: { start: number; end: number } | null };
		if (!ret.argument) return { source: code, returned: false };
		const prefix = code.slice(0, ret.start);
		const suffix = code.slice(ret.end);
		const expr = code.slice(ret.argument.start, ret.argument.end);
		return { source: `${prefix}__gjc_set_final_expr__((${expr}));${suffix}`, returned: true };
	}
	return { source: code, returned: false };
}

function isExecutionBoundary(type: string): boolean {
	return (
		type === "FunctionDeclaration" ||
		type === "FunctionExpression" ||
		type === "ArrowFunctionExpression" ||
		type === "ObjectMethod" ||
		type === "ClassMethod" ||
		type === "ClassPrivateMethod" ||
		type === "PrivateMethod"
	);
}

function containsAsyncWrapperSyntax(value: unknown): boolean {
	if (!value || typeof value !== "object") return false;
	if (Array.isArray(value)) {
		for (const item of value) {
			if (containsAsyncWrapperSyntax(item)) return true;
		}
		return false;
	}

	const node = value as Record<string, unknown>;
	const type = node.type;
	if (type === "ReturnStatement" || type === "AwaitExpression") return true;
	if (type === "ForOfStatement" && node.await === true) return true;
	if (typeof type === "string" && isExecutionBoundary(type)) return false;

	for (const key in node) {
		if (key === "loc" || key === "extra" || key === "range") continue;
		if (key === "leadingComments" || key === "trailingComments" || key === "innerComments") continue;
		if (containsAsyncWrapperSyntax(node[key])) return true;
	}
	return false;
}

function requiresAsyncWrapper(code: string): boolean {
	const ast = parseProgram(code);
	if (!ast) return false;
	for (const node of ast.program.body) {
		if (containsAsyncWrapperSyntax(node)) return true;
	}
	return false;
}

/**
 * Strip TypeScript syntax (type annotations, `interface`, `as`, `satisfies`, generics in
 * call expressions, etc.) before the import/lexical rewriters parse the code. We use Bun's
 * native transpiler in `ts` loader mode — fast, no JSX transforms, preserves `import`/
 * `export` declarations so the downstream Babel rewrites keep working.
 *
 * Skipped when the code parses as plain JavaScript already (Babel can accept it), so the
 * common case avoids an extra transpile pass. We detect "looks like TS" with a cheap regex
 * before invoking the transpiler.
 */
function stripTypeScript(code: string): string {
	if (!LOOKS_LIKE_TS.test(code)) return code;
	try {
		return new Bun.Transpiler({ loader: "ts" }).transformSync(code);
	} catch {
		// Transpiler failed (e.g. unrecoverable syntax). Hand the original source back so the
		// downstream rewriter / VM surfaces the real error to the user.
		return code;
	}
}

// Heuristic: any of the obvious TS-only tokens. Plain JS using `as` only inside strings
// won't match because we require a leading word boundary plus a colon/keyword neighbor.
const LOOKS_LIKE_TS =
	/(?:\binterface\s+\w|\btype\s+\w+\s*=|\b(?:as|satisfies)\s+(?:[A-Z]|\bconst\b)|:\s*(?:string|number|boolean|any|unknown|void|never|object|[A-Z]\w*)\b|<\s*[A-Z]\w*\s*[,>])/;

export function wrapCode(code: string): { source: string; asyncWrapped: boolean; finalExpressionReturned: boolean } {
	const stripped = stripTypeScript(code);
	const finalExpression = returnFinalExpression(stripped);
	const importsRewritten = rewriteImports(finalExpression.source);
	const needsAsyncWrapper = requiresAsyncWrapper(importsRewritten);
	const rewritten = {
		source: demoteTopLevelLexicals(importsRewritten, { publishGlobals: needsAsyncWrapper }),
		returned: finalExpression.returned,
	};
	if (!needsAsyncWrapper) {
		return { source: rewritten.source, asyncWrapped: false, finalExpressionReturned: rewritten.returned };
	}
	return {
		source: `(async () => {\n${rewritten.source}\n})()`,
		asyncWrapped: true,
		finalExpressionReturned: rewritten.returned,
	};
}
