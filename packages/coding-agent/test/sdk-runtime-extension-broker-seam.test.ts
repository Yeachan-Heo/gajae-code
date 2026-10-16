import { expect, test } from "bun:test";
import * as path from "node:path";
import { parse } from "@babel/parser";
import traverse from "@babel/traverse";

const packageRoot = path.resolve(import.meta.dir, "..");
const optOutPrefix = "// broker-seam-opt-out: ";

function missingBrokerSeams(source: string, filename: string): number[] {
	const file = parse(source, { sourceFilename: filename, sourceType: "module", plugins: ["typescript"] });
	const missing: number[] = [];
	traverse(file, {
		CallExpression({ node }) {
			if (node.callee.type !== "Identifier" || node.callee.name !== "createSdkSessionRuntimeExtension") return;
			let options = node.arguments[1];
			while (options?.type === "TSAsExpression" || options?.type === "TSSatisfiesExpression") {
				options = options.expression;
			}
			const hasSeam =
				options &&
				options.type === "ObjectExpression" &&
				options.properties.some(
					property =>
						(property.type === "ObjectProperty" || property.type === "ObjectMethod") &&
						!property.computed &&
						((property.key.type === "Identifier" && property.key.name === "ensureBrokerImpl") ||
							(property.key.type === "StringLiteral" && property.key.value === "ensureBrokerImpl")),
				);
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
			`createSdkSessionRuntimeExtension(api, { ensureBrokerImpl: stub });
createSdkSessionRuntimeExtension(api, { ensureBrokerImpl });
createSdkSessionRuntimeExtension(api, { "ensureBrokerImpl": stub });
createSdkSessionRuntimeExtension(api, { ensureBrokerImpl: stub } as never);
// broker-seam-opt-out: this integration owns and stops its real broker
createSdkSessionRuntimeExtension(api, {});
// broker-seam-opt-out:
createSdkSessionRuntimeExtension(api, {});`,
			"fixture.test.ts",
		),
	).toEqual([8]);
});
