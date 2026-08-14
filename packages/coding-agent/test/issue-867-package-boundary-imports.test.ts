import { describe, expect, it } from "bun:test";
import * as path from "node:path";

const PACKAGE_ROOT = path.resolve(import.meta.dir, "..");
const SRC_ROOT = path.join(PACKAGE_ROOT, "src");
const WORKSPACE_PACKAGES_ROOT = path.resolve(PACKAGE_ROOT, "..");
const PACKAGE_NAME = path.basename(PACKAGE_ROOT);

const MODULE_SPECIFIER_RE =
	/(?:import\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?|export\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)|import\s*\()(["'])([^"']+)\1/g;

function isWorkspacePackageSourcePath(resolvedPath: string): boolean {
	const relativeToPackages = path.relative(WORKSPACE_PACKAGES_ROOT, resolvedPath);
	if (relativeToPackages.startsWith("..") || path.isAbsolute(relativeToPackages)) return false;
	const parts = relativeToPackages.split(path.sep);
	return parts.length >= 3 && parts[0] !== PACKAGE_NAME && parts[1] === "src";
}

async function collectWorkspaceSourceImports(): Promise<string[]> {
	const violations: string[] = [];
	const glob = new Bun.Glob("**/*.ts");

	for await (const relativeFile of glob.scan({ cwd: SRC_ROOT, onlyFiles: true })) {
		const filePath = path.join(SRC_ROOT, relativeFile);
		const source = await Bun.file(filePath).text();

		for (const match of source.matchAll(MODULE_SPECIFIER_RE)) {
			const specifier = match[2];
			if (!specifier?.startsWith(".")) continue;

			const resolvedPath = path.resolve(path.dirname(filePath), specifier);
			if (!isWorkspacePackageSourcePath(resolvedPath)) continue;

			violations.push(`${path.relative(PACKAGE_ROOT, filePath)} imports ${specifier}`);
		}
	}

	return violations.sort();
}

describe("published package import boundaries", () => {
	it("does not import sibling workspace package source files through relative paths", async () => {
		await expect(collectWorkspaceSourceImports()).resolves.toEqual([]);
	});
});
