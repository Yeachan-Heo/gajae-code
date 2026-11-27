import { expect, test } from "bun:test";
import * as path from "node:path";
import { parse } from "@babel/parser";
import traverse, { type Binding, type Scope } from "@babel/traverse";
import type { Node, ObjectExpression, ObjectMethod, ObjectProperty } from "@babel/types";

const packageRoot = path.resolve(import.meta.dir, "..");
const optOutPrefix = "// broker-seam-opt-out: ";

function isGuaranteedBrokerFunction(value: Node, scope: Scope, seen: ReadonlySet<Binding> = new Set()): boolean {
	let expression = value;
	while (
		expression.type === "TSAsExpression" ||
		expression.type === "TSTypeAssertion" ||
		expression.type === "TSNonNullExpression" ||
		expression.type === "TSSatisfiesExpression"
	) {
		expression = expression.expression;
	}
	if (expression.type === "ArrowFunctionExpression" || expression.type === "FunctionExpression") return true;
	if (expression.type === "Identifier") {
		if (expression.name === "undefined") return false;
		const binding = scope.getBinding(expression.name);
		if (!binding?.constant || binding.constantViolations.length > 0 || seen.has(binding)) return false;
		if (binding.path.isFunctionDeclaration()) return true;
		if (binding.kind !== "const" || !binding.path.isVariableDeclarator()) return false;
		const initializer = binding.path.node.init;
		if (!initializer) return false;
		const next = new Set(seen);
		next.add(binding);
		return isGuaranteedBrokerFunction(initializer, binding.path.scope, next);
	}
	if (expression.type === "ConditionalExpression") {
		return (
			isGuaranteedBrokerFunction(expression.consequent, scope, seen) &&
			isGuaranteedBrokerFunction(expression.alternate, scope, seen)
		);
	}
	if (expression.type === "LogicalExpression") {
		return (
			isGuaranteedBrokerFunction(expression.left, scope, seen) &&
			isGuaranteedBrokerFunction(expression.right, scope, seen)
		);
	}
	return false;
}

function isBrokerSeamProperty(property: ObjectMethod | ObjectProperty): boolean {
	return (
		!property.computed &&
		((property.key.type === "Identifier" && property.key.name === "ensureBrokerImpl") ||
			(property.key.type === "StringLiteral" && property.key.value === "ensureBrokerImpl"))
	);
}

function hasGuaranteedBrokerSeam(options: ObjectExpression, scope: Scope): boolean {
	let seam: ObjectMethod | ObjectProperty | undefined;
	let seamIndex = -1;
	let lastUnknownOverrideIndex = -1;
	for (const [index, property] of options.properties.entries()) {
		if (property.type === "SpreadElement") {
			lastUnknownOverrideIndex = index;
			continue;
		}
		if (property.computed) lastUnknownOverrideIndex = index;
		if ((property.type === "ObjectProperty" || property.type === "ObjectMethod") && isBrokerSeamProperty(property)) {
			seam = property;
			seamIndex = index;
		}
	}
	if (!seam || lastUnknownOverrideIndex > seamIndex) return false;
	if (seam.type === "ObjectMethod") return seam.kind === "method";
	return isGuaranteedBrokerFunction(seam.value, scope);
}
function missingBrokerSeams(source: string, filename: string): number[] {
	const file = parse(source, { sourceFilename: filename, sourceType: "module", plugins: ["typescript"] });
	const missing: number[] = [];
	traverse(file, {
		CallExpression(callPath) {
			const { node } = callPath;
			if (node.callee.type !== "Identifier" || node.callee.name !== "createSdkSessionRuntimeExtension") return;
			let options = node.arguments[1];
			while (
				options?.type === "TSAsExpression" ||
				options?.type === "TSSatisfiesExpression" ||
				options?.type === "TSTypeAssertion" ||
				options?.type === "TSNonNullExpression"
			) {
				options = options.expression;
			}
			const hasSeam = options?.type === "ObjectExpression" && hasGuaranteedBrokerSeam(options, callPath.scope);
			const line = node.loc?.start.line;
			if (line === undefined) throw new Error(`Missing call location in ${filename}`);
			const previousLine = source.split("\n")[line - 2]?.trim() ?? "";
			const optedOut =
				previousLine.startsWith(optOutPrefix) && previousLine.slice(optOutPrefix.length).trim().length > 0;
			if (!hasSeam && !optedOut) missing.push(line);
		},
	});
	return missing;
}

test("runtime-extension test calls explicitly isolate broker discovery", async () => {
	const violations: string[] = [];
	for (const root of ["src", "test"]) {
		for await (const filename of new Bun.Glob("**/*.test.ts").scan(path.join(packageRoot, root))) {
			const relative = path.join(root, filename);
			const source = await Bun.file(path.join(packageRoot, relative)).text();
			if (!source.includes("createSdkSessionRuntimeExtension")) continue;
			for (const line of missingBrokerSeams(source, relative)) violations.push(`${relative}:${line}`);
		}
	}
	expect(violations.sort()).toEqual([]);
});

test("broker seam guard checks the options object, not nested properties or source text", () => {
	expect(
		missingBrokerSeams(
			`// ensureBrokerImpl is not an option here
createSdkSessionRuntimeExtension(api, { createTransport: () => ({ ensureBrokerImpl: stub }) });
createSdkSessionRuntimeExtension(api, options);
createSdkSessionRuntimeExtension(api);`,
			"fixture.test.ts",
		),
	).toEqual([2, 3, 4]);
	expect(
		missingBrokerSeams(
			`const stub = () => {};
const ensureBrokerImpl = () => {};
function namedBroker() {}
createSdkSessionRuntimeExtension(api, { ensureBrokerImpl: stub });
createSdkSessionRuntimeExtension(api, { ensureBrokerImpl });
createSdkSessionRuntimeExtension(api, { "ensureBrokerImpl": stub });
createSdkSessionRuntimeExtension(api, { ensureBrokerImpl: stub } as never);
createSdkSessionRuntimeExtension(api, { ensureBrokerImpl: namedBroker });
// broker-seam-opt-out: this integration owns and stops its real broker
createSdkSessionRuntimeExtension(api, {});
// broker-seam-opt-out:
createSdkSessionRuntimeExtension(api, {});`,
			"fixture.test.ts",
		),
	).toEqual([12]);
	expect(
		missingBrokerSeams(
			`const stub = () => {};
createSdkSessionRuntimeExtension(api, { ensureBrokerImpl: undefined });
createSdkSessionRuntimeExtension(api, { ensureBrokerImpl: void 0 });
createSdkSessionRuntimeExtension(api, { ensureBrokerImpl: null });
createSdkSessionRuntimeExtension(api, { ensureBrokerImpl: undefined as never });
createSdkSessionRuntimeExtension(api, { ensureBrokerImpl: stub });`,
			"fixture.test.ts",
		),
	).toEqual([2, 3, 4, 5]);
	expect(
		missingBrokerSeams(
			`const stub = () => {};
const ensureBrokerImpl = () => {};
const maybeBrokerImpl = Math.random() ? stub : undefined;
const overrides = { ensureBrokerImpl: undefined };
createSdkSessionRuntimeExtension(api, { ...overrides, ensureBrokerImpl: stub });
createSdkSessionRuntimeExtension(api, { ensureBrokerImpl: stub, ...overrides });
createSdkSessionRuntimeExtension(api, { get ensureBrokerImpl() { return undefined; } });
createSdkSessionRuntimeExtension(api, { set ensureBrokerImpl(value) {} });
createSdkSessionRuntimeExtension(api, { ensureBrokerImpl: maybeBrokerImpl });
createSdkSessionRuntimeExtension(api, { ensureBrokerImpl });
createSdkSessionRuntimeExtension(api, { ensureBrokerImpl: stub });`,
			"fixture.test.ts",
		),
	).toEqual([6, 7, 8, 9]);
});
