import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");

interface PackageJson {
	bin?: Record<string, string> | string;
}

function readPackageJson(pkgRel: string): PackageJson {
	const file = path.join(repoRoot, pkgRel, "package.json");
	return JSON.parse(fs.readFileSync(file, "utf8")) as PackageJson;
}

function readBin(rel: string): string {
	return fs.readFileSync(path.join(repoRoot, rel), "utf8");
}

describe("가재씨 launcher alias", () => {
	const packages = [
		{ name: "gajae-code", rel: "packages/gajae-code" },
		{ name: "@gajae-code/coding-agent", rel: "packages/coding-agent" },
	];

	for (const { name, rel } of packages) {
		describe(`${name} bin`, () => {
			it("declares 가재씨 as a bin key alongside gjc", () => {
				const pkg = readPackageJson(rel);
				expect(typeof pkg.bin).toBe("object");
				expect(pkg.bin).not.toBeNull();
				const bin = pkg.bin as Record<string, string>;
				expect(bin.gjc).toBeDefined();
				expect(bin["가재씨"]).toBeDefined();
			});

			it("maps 가재씨 to the gajaessi.js wrapper", () => {
				const pkg = readPackageJson(rel);
				const bin = pkg.bin as Record<string, string>;
				expect(bin["가재씨"]).toBe("bin/gajaessi.js");
				expect(fs.existsSync(path.join(repoRoot, rel, "bin", "gajaessi.js"))).toBe(true);
			});

			it("ships a gajaessi.js wrapper byte-identical to the canonical gjc.js", () => {
				const gjcContent = readBin(path.join(rel, "bin/gjc.js"));
				const aliasContent = readBin(path.join(rel, "bin/gajaessi.js"));
				expect(aliasContent).toBe(gjcContent);
			});
		});
	}

	it("both packages share one canonical wrapper text", () => {
		const texts = [
			readBin("packages/gajae-code/bin/gjc.js"),
			readBin("packages/gajae-code/bin/gajaessi.js"),
			readBin("packages/coding-agent/bin/gjc.js"),
			readBin("packages/coding-agent/bin/gajaessi.js"),
		];
		expect(new Set(texts).size).toBe(1);
	});
});
