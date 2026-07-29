import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as barrel from "../src/extensibility/gjc-plugins";

/**
 * The GJC bundle lifecycle is only safe if it is the sole writer. These tests
 * pin the public boundary so a caller cannot reach a mutation primitive and
 * commit a replacement that bypasses the create-only rule.
 */

/** Symbols that would let a caller mutate bundle state outside the lifecycle. */
const FORBIDDEN_EXPORTS = [
	"runGjcBundleTransaction",
	"candidateRegistryEntry",
	"resolveGjcBundleCandidate",
	"writeRegistry",
	"writeRegistryUnlocked",
	"updateRegistry",
	"withRegistryLock",
];

/** The lifecycle API callers are expected to use instead. */
const REQUIRED_EXPORTS = [
	"installGjcBundle",
	"previewGjcBundleUpdate",
	"applyGjcBundleUpdate",
	"listGjcBundles",
	"getGjcBundle",
	"setGjcBundleEnabled",
	"setGjcBundleSurfaceEnabled",
];

const srcRoot = path.join(import.meta.dir, "..", "src");
const gjcPluginsRoot = path.join(srcRoot, "extensibility", "gjc-plugins");
/** Only these modules may reference the writers: the owner and the primitives. */
const WRITER_OWNERS = new Set([
	path.join(gjcPluginsRoot, "lifecycle.ts"),
	path.join(gjcPluginsRoot, "installer.ts"),
	path.join(gjcPluginsRoot, "registry.ts"),
]);

async function typescriptFilesIn(root: string): Promise<string[]> {
	const entries = await fs.readdir(root, { withFileTypes: true });
	const nested = await Promise.all(
		entries.map(async entry => {
			const full = path.join(root, entry.name);
			if (entry.isDirectory()) return typescriptFilesIn(full);
			return entry.isFile() && full.endsWith(".ts") ? [full] : [];
		}),
	);
	return nested.flat();
}

describe("GJC plugin public boundary", () => {
	test("the barrel exposes no bundle mutation primitive", () => {
		const exported = new Set(Object.keys(barrel));
		for (const name of FORBIDDEN_EXPORTS) expect(exported.has(name)).toBe(false);
	});

	test("the barrel still exposes the lifecycle API", () => {
		const exported = new Set(Object.keys(barrel));
		for (const name of REQUIRED_EXPORTS) expect(exported.has(name)).toBe(true);
	});

	test("no production module outside the lifecycle owners references a writer", async () => {
		const files = await typescriptFilesIn(srcRoot);
		const offenders: string[] = [];
		for (const file of files) {
			if (WRITER_OWNERS.has(file)) continue;
			const text = await fs.readFile(file, "utf8");
			for (const name of ["writeRegistry", "writeRegistryUnlocked", "updateRegistry", "withRegistryLock"]) {
				if (new RegExp(`\\b${name}\\b`).test(text)) offenders.push(`${path.relative(srcRoot, file)}:${name}`);
			}
			if (/\brunGjcBundleTransaction\b/.test(text)) {
				offenders.push(`${path.relative(srcRoot, file)}:runGjcBundleTransaction`);
			}
		}
		expect(offenders).toEqual([]);
	});

	test("package exports do not expose the writer modules as public subpaths", async () => {
		const manifest = JSON.parse(await fs.readFile(path.join(import.meta.dir, "..", "package.json"), "utf8")) as {
			exports: Record<string, unknown>;
		};
		// A wildcard subpath would otherwise resolve
		// `@gajae-code/coding-agent/extensibility/gjc-plugins/installer`, making the
		// narrowed barrel cosmetic. Both writer modules must be explicitly blocked.
		expect(manifest.exports["./extensibility/gjc-plugins/installer"]).toBeNull();
		expect(manifest.exports["./extensibility/gjc-plugins/registry"]).toBeNull();
		// The block must precede the wildcard, since Node resolves in declaration order.
		const keys = Object.keys(manifest.exports);
		expect(keys.indexOf("./extensibility/gjc-plugins/installer")).toBeLessThan(keys.indexOf("./extensibility/*"));
		expect(keys.indexOf("./extensibility/gjc-plugins/registry")).toBeLessThan(keys.indexOf("./extensibility/*"));
	});
});
