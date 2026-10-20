import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCache, invalidate, readFile } from "../src/capability/fs";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-capability-fs-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	clearCache();
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("capability filesystem content cache", () => {
	it("invalidates content cached under every containment boundary", async () => {
		const root = await tempDir();
		const file = path.join(root, "rules.md");
		await fs.writeFile(file, "old");

		const options = { containmentRoot: root };
		expect(await readFile(file, options)).toBe("old");
		await fs.writeFile(file, "new");
		invalidate(file);

		expect(await readFile(file, options)).toBe("new");
	});

	it("does not repopulate a stale value after invalidation during an in-flight read", async () => {
		const root = await tempDir();
		const file = path.join(root, "rules.md");
		await fs.writeFile(file, "old");

		const originalFile = Bun.file;
		let releaseRead: (() => void) | undefined;
		const readBlocked = new Promise<void>(resolve => {
			releaseRead = resolve;
		});
		Bun.file = ((filePath: string) => {
			const fileHandle = originalFile(filePath);
			return {
				...fileHandle,
				text: async () => {
					await readBlocked;
					return fileHandle.text();
				},
			} as ReturnType<typeof Bun.file>;
		}) as typeof Bun.file;
		try {
			const options = { containmentRoot: root };
			const pending = readFile(file, options);
			await Promise.resolve();
			await fs.writeFile(file, "new");
			invalidate(file);
			releaseRead?.();
			await pending;

			expect(await readFile(file, options)).toBe("new");
		} finally {
			Bun.file = originalFile;
		}
	});

	it("refreshes bounded reads after an external edit clears the discovery cache", async () => {
		const root = await tempDir();
		const file = path.join(root, "command.md");
		await fs.writeFile(file, "old");
		const options = { containmentRoot: root };

		expect(await readFile(file, options)).toBe("old");
		await fs.writeFile(file, "new");
		clearCache();

		expect(await readFile(file, options)).toBe("new");
	});

	it("invalidates bounded reads cached through symlink aliases", async () => {
		const root = await tempDir();
		const target = path.join(root, "shared.md");
		const firstAlias = path.join(root, "first.md");
		const secondAlias = path.join(root, "second.md");
		await fs.writeFile(target, "old");
		await fs.symlink(target, firstAlias);
		await fs.symlink(target, secondAlias);
		const options = { containmentRoot: root };

		expect(await readFile(firstAlias, options)).toBe("old");
		expect(await readFile(secondAlias, options)).toBe("old");
		await fs.writeFile(target, "new");
		invalidate(firstAlias);

		expect(await readFile(secondAlias, options)).toBe("new");
	});
});
