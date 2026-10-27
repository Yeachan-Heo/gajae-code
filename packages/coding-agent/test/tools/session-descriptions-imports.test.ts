import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { parse } from "@babel/parser";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..", "..");
const srcRoot = path.join(repoRoot, "packages", "coding-agent", "src");
const sessionDescriptionsPath = path.join(srcRoot, "tools", "session-descriptions.ts");
const descriptorsPath = path.join(srcRoot, "tools", "descriptors.ts");
const forbiddenPaths = new Set([
	path.join(srcRoot, "tools", "index.ts"),
	descriptorsPath,
	path.join(srcRoot, "task", "index.ts"),
]);

async function resolveSourcePath(importerPath: string, specifier: string): Promise<string | undefined> {
	if (!specifier.startsWith(".")) return undefined;
	const basePath = path.resolve(path.dirname(importerPath), specifier);
	const candidates = path.extname(basePath)
		? [basePath]
		: [
				`${basePath}.ts`,
				`${basePath}.tsx`,
				`${basePath}.js`,
				`${basePath}.jsx`,
				path.join(basePath, "index.ts"),
				path.join(basePath, "index.tsx"),
				path.join(basePath, "index.js"),
				path.join(basePath, "index.jsx"),
			];
	for (const candidate of candidates) {
		if (await Bun.file(candidate).exists()) return path.resolve(candidate);
	}
	return undefined;
}

async function directSpecifiers(sourcePath: string): Promise<string[]> {
	const source = await Bun.file(sourcePath).text();
	const parsed = parse(source, { sourceType: "module", plugins: ["typescript"] });
	const specifiers: string[] = [];
	for (const statement of parsed.program.body) {
		if (
			statement.type === "ImportDeclaration" ||
			statement.type === "ExportNamedDeclaration" ||
			statement.type === "ExportAllDeclaration"
		) {
			const sourceNode = statement.source;
			if (sourceNode?.type === "StringLiteral") specifiers.push(sourceNode.value);
		}
	}
	return specifiers;
}

async function resolveLoaderImplementationPaths(descriptorsSource: string): Promise<string[]> {
	const parsed = parse(descriptorsSource, { sourceType: "module", plugins: ["typescript"] });
	const declaration = parsed.program.body.find(
		statement =>
			statement.type === "VariableDeclaration" &&
			statement.declarations.some(item => item.id.type === "Identifier" && item.id.name === "loaders"),
	);
	if (declaration?.type !== "VariableDeclaration") {
		throw new Error("Could not find the loaders table in descriptors.ts");
	}
	const loaderObject = declaration.declarations.find(
		item => item.id.type === "Identifier" && item.id.name === "loaders",
	)?.init;
	if (loaderObject?.type !== "ObjectExpression") {
		throw new Error("The loaders table must be an object literal");
	}

	const specifiers = new Set<string>();
	const visit = (node: object, found: Set<string>, visited: WeakSet<object>): void => {
		if (visited.has(node)) return;
		visited.add(node);
		const value = node as { type?: unknown; callee?: { type?: unknown }; arguments?: unknown[] };
		if (value.type === "CallExpression" && value.callee?.type === "Import") {
			const firstArgument = value.arguments?.[0] as { type?: unknown; value?: unknown } | undefined;
			if (firstArgument?.type === "StringLiteral" && typeof firstArgument.value === "string") {
				found.add(firstArgument.value);
			}
		}
		for (const child of Object.values(node)) {
			if (Array.isArray(child)) {
				for (const entry of child) if (entry && typeof entry === "object") visit(entry, found, visited);
			} else if (child && typeof child === "object") {
				visit(child, found, visited);
			}
		}
	};
	for (const property of loaderObject.properties) {
		if (property.type !== "ObjectProperty" || property.value.type !== "ArrowFunctionExpression") continue;
		const loaderName =
			property.key.type === "Identifier"
				? property.key.name
				: property.key.type === "StringLiteral"
					? property.key.value
					: "computed loader";
		const loaderSpecifiers = new Set<string>();
		visit(property.value, loaderSpecifiers, new WeakSet<object>());
		expect(
			loaderSpecifiers.size,
			`could not identify an implementation import for loader ${loaderName}`,
		).toBeGreaterThan(0);
		for (const specifier of loaderSpecifiers) specifiers.add(specifier);
	}

	const resolvedPaths: string[] = [];
	for (const specifier of specifiers) {
		const resolved = await resolveSourcePath(descriptorsPath, specifier);
		if (!resolved) throw new Error(`Could not resolve tool loader module ${specifier} from descriptors.ts`);
		resolvedPaths.push(resolved);
	}
	return resolvedPaths;
}

async function valueImportSpecifiers(sourcePath: string): Promise<string[]> {
	const source = await Bun.file(sourcePath).text();
	const imports = await new Bun.Transpiler({ loader: "ts" }).scanImports(source);
	return imports.map(entry => entry.path);
}

function isWithinSrc(sourcePath: string): boolean {
	const relative = path.relative(srcRoot, sourcePath);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

describe("session descriptions import boundaries", () => {
	it("keeps direct imports and transitive value imports outside tool implementations", async () => {
		for (const loaderPath of await resolveLoaderImplementationPaths(await Bun.file(descriptorsPath).text())) {
			forbiddenPaths.add(loaderPath);
		}

		for (const specifier of await directSpecifiers(sessionDescriptionsPath)) {
			const resolved = specifier.startsWith(".")
				? await resolveSourcePath(sessionDescriptionsPath, specifier)
				: path.isAbsolute(specifier)
					? path.resolve(specifier)
					: undefined;
			if (specifier.startsWith(".") || path.isAbsolute(specifier)) {
				expect(
					resolved,
					`could not resolve direct import ${specifier} from ${sessionDescriptionsPath}`,
				).toBeDefined();
			}
			if (resolved) {
				expect(
					forbiddenPaths.has(resolved),
					`forbidden direct import chain:\n  ${sessionDescriptionsPath}\n  -> ${resolved}`,
				).toBe(false);
			}
		}

		const pending: Array<{ sourcePath: string; chain: string[] }> = [
			{ sourcePath: sessionDescriptionsPath, chain: [sessionDescriptionsPath] },
		];
		const visited = new Set<string>();
		while (pending.length > 0) {
			const current = pending.pop();
			if (!current || visited.has(current.sourcePath)) continue;
			visited.add(current.sourcePath);
			for (const specifier of await valueImportSpecifiers(current.sourcePath)) {
				if (!specifier.startsWith(".")) continue;
				if (specifier.endsWith(".md")) continue;
				const resolved = await resolveSourcePath(current.sourcePath, specifier);
				if (!resolved || !isWithinSrc(resolved)) continue;
				const chain = [...current.chain, resolved];
				expect(
					forbiddenPaths.has(resolved),
					`forbidden value import chain:\n${chain.map(entry => `  ${entry}`).join("\n  -> ")}`,
				).toBe(false);
				if (!visited.has(resolved)) pending.push({ sourcePath: resolved, chain });
			}
		}
	});
});
