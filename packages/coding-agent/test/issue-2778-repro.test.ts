import { describe, expect, test } from "bun:test";
import * as path from "node:path";

const mainPath = path.resolve(import.meta.dir, "../src/main.ts");

describe("issue #2778 — compiled startup entrypoint", () => {
	test("keeps the cli import out of main's static module graph", async () => {
		const source = await Bun.file(mainPath).text();

		// cli.ts registers commands that import main.ts. A static main -> cli edge
		// closes that cycle; Bun 1.3.14 standalone binaries spin in the cycle before
		// request/session startup, even though source-mode ESM happens to complete.
		expect(source).not.toMatch(/import\s+\{\s*runCli\s*\}\s+from\s+["']\.\/cli["']/);
		expect(source).toContain('const { runCli } = await import("./cli");');
	});
});
