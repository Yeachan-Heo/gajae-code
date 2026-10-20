import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { cacheStats, clearCache, invalidate, readFile } from "../src/capability/fs";
import { invalidateFsScanAfterWrite } from "../src/tools/fs-cache-invalidation";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-fs-cache-"));
	tempRoots.push(root);
	return root;
}

afterEach(async () => {
	clearCache();
	await Promise.all(tempRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe("filesystem cache invalidation", () => {
	it("refreshes a bounded read after a discovered rule is edited", async () => {
		const root = await makeTempRoot();
		const rulePath = path.join(root, ".gjc", "rules", "x.md");
		await fs.mkdir(path.dirname(rulePath), { recursive: true });
		await fs.writeFile(rulePath, "old rule", "utf8");

		expect(await readFile(rulePath, { containmentRoot: root, scope: "project" })).toBe("old rule");
		await fs.writeFile(rulePath, "new rule", "utf8");
		invalidateFsScanAfterWrite(rulePath);

		expect(await readFile(rulePath, { containmentRoot: root, scope: "project" })).toBe("new rule");
	});

	it("does not cache a stale value when a read races invalidation", async () => {
		const root = await makeTempRoot();
		const filePath = path.join(root, "pending.md");
		await fs.writeFile(filePath, "old value", "utf8");
		clearCache();

		const originalFile = Bun.file;
		let releaseRead: (() => void) | undefined;
		const readPaused = new Promise<void>(resolve => {
			releaseRead = resolve;
		});
		let markReadStarted: (() => void) | undefined;
		const readStarted = new Promise<void>(resolve => {
			markReadStarted = resolve;
		});
		let shouldPause = true;
		const fileSpy = spyOn(Bun, "file").mockImplementation(value => {
			const file = originalFile(value as string);
			const originalText = file.text.bind(file);
			file.text = async () => {
				const content = await originalText();
				if (!shouldPause) return content;
				shouldPause = false;
				markReadStarted?.();
				await readPaused;
				return content;
			};
			return file;
		});

		try {
			const pending = readFile(filePath);
			await readStarted;
			invalidate(filePath);
			releaseRead?.();
			expect(await pending).toBe("old value");
			expect(cacheStats().content).toBe(0);
			await fs.writeFile(filePath, "new value", "utf8");
			expect(await readFile(filePath)).toBe("new value");
		} finally {
			fileSpy.mockRestore();
		}
	});
});
