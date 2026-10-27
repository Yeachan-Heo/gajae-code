import { describe, expect, it } from "bun:test";
import { lstat, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeCachedRegularFile } from "../src/extensibility/plugins/marketplace/cache";

describe("writeCachedRegularFile", () => {
	it("replaces a symlink with a regular file and leaves the old target untouched", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "lsp-symlink-"));
		const secret = path.join(dir, "secret.txt");
		await writeFile(secret, "keep");
		const link = path.join(dir, ".lsp.json");
		await symlink(secret, link);
		await writeCachedRegularFile(link, '{"servers":{}}\n');
		expect(await readFile(secret, "utf8")).toBe("keep");
		expect((await lstat(link)).isSymbolicLink()).toBe(false);
		expect(await readFile(link, "utf8")).toBe('{"servers":{}}\n');
	});
});
