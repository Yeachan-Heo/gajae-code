import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCache, readFile } from "../src/capability/fs";
import { invalidateFsScanAfterWrite } from "../src/tools/fs-cache-invalidation";

let tempDir: string;

beforeEach(async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-fs-cache-invalidation-"));
	clearCache();
});

afterEach(async () => {
	clearCache();
	await fs.rm(tempDir, { recursive: true, force: true });
});

test("invalidating a discovered rule path refreshes bounded reads", async () => {
	const filePath = path.join(tempDir, ".gjc", "rules", "x.md");
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, "old\n");

	expect(await readFile(filePath, { containmentRoot: tempDir, scope: "project" })).toBe("old\n");
	await fs.writeFile(filePath, "new\n");
	invalidateFsScanAfterWrite(filePath);

	expect(await readFile(filePath, { containmentRoot: tempDir, scope: "project" })).toBe("new\n");
});

test("an in-flight read cannot repopulate the cache after invalidation", async () => {
	const filePath = path.join(tempDir, "large.txt");
	await fs.writeFile(filePath, "value\n".repeat(1024 * 1024));

	const pendingRead = readFile(filePath);
	await new Promise(resolve => setTimeout(resolve, 0));
	clearCache();
	await pendingRead;

	await fs.writeFile(filePath, "fresh\n");
	expect(await readFile(filePath)).toBe("fresh\n");
});
