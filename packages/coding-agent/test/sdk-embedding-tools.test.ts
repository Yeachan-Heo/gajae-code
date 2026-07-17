import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { BUILTIN_TOOLS } from "../src/tools";

describe("SDK embedding tool docs", () => {
	it("only documents built-in tool names", () => {
		const docs = readFileSync(resolve(import.meta.dir, "../../../docs/sdk-embedding.md"), "utf8");
		const arrays = [...docs.matchAll(/toolNames:\s*\[([^\]]*)]/g)];
		const names = arrays.flatMap(match => match[1]?.match(/"([^"]+)"/g) ?? []);
		expect(names.map(name => name.slice(1, -1)).every(name => name in BUILTIN_TOOLS)).toBe(true);
	});
});
