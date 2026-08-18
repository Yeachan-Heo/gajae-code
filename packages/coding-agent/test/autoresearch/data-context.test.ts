import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadAutoresearchDataContext } from "../../src/autoresearch/data-context";

const tempRoots: string[] = [];

afterEach(async () => {
	await Promise.all(tempRoots.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-autoresearch-datactx-"));
	tempRoots.push(dir);
	return dir;
}

describe("autoresearch data context (AC-16 consumption gate)", () => {
	it("REFUSES to load any data description in web mode, even when DATA.md exists", async () => {
		const root = await tempDir();
		await fs.writeFile(path.join(root, "DATA.md"), "# dataset description\n", "utf-8");

		const context = await loadAutoresearchDataContext({ cwd: root, mode: "web" });
		expect(context).toBeNull();
	});

	it("REFUSES an explicit data flag in web mode (mode is never inferred)", async () => {
		const root = await tempDir();
		const dataPath = path.join(root, "dataset.md");
		await fs.writeFile(dataPath, "# explicit dataset\n", "utf-8");

		const context = await loadAutoresearchDataContext({ cwd: root, mode: "web", dataFlag: "dataset.md" });
		expect(context).toBeNull();
	});

	it("loads the project DATA.md auto-description in data mode", async () => {
		const root = await tempDir();
		await fs.writeFile(path.join(root, "DATA.md"), "# dataset description\n\ncolumns: a, b\n", "utf-8");

		const context = await loadAutoresearchDataContext({ cwd: root, mode: "data" });
		expect(context).not.toBeNull();
		expect(context!.path).toBe(path.join(root, "DATA.md"));
		expect(context!.content).toContain("columns: a, b");
	});

	it("loads the project DATA.md auto-description in mixed mode too", async () => {
		const root = await tempDir();
		await fs.writeFile(path.join(root, "DATA.md"), "# dataset description\n", "utf-8");

		const context = await loadAutoresearchDataContext({ cwd: root, mode: "mixed" });
		expect(context).not.toBeNull();
		expect(context!.path).toBe(path.join(root, "DATA.md"));
	});

	it("prefers an explicit data path over DATA.md in data mode", async () => {
		const root = await tempDir();
		await fs.writeFile(path.join(root, "DATA.md"), "# auto\n", "utf-8");
		await fs.writeFile(path.join(root, "explicit.md"), "# explicit\n", "utf-8");

		const context = await loadAutoresearchDataContext({ cwd: root, mode: "data", dataFlag: "explicit.md" });
		expect(context).not.toBeNull();
		expect(context!.path).toBe(path.join(root, "explicit.md"));
		expect(context!.content).toBe("# explicit\n");
	});

	it("returns null in data mode when no data description exists anywhere", async () => {
		const root = await tempDir();
		const context = await loadAutoresearchDataContext({ cwd: root, mode: "data" });
		expect(context).toBeNull();
	});

	it("throws when an explicit data path is missing in data mode", async () => {
		const root = await tempDir();
		await expect(loadAutoresearchDataContext({ cwd: root, mode: "data", dataFlag: "missing.md" })).rejects.toThrow(
			/--data file not found/,
		);
	});

	it("does not even stat the filesystem in web mode", async () => {
		const root = await tempDir();
		// A missing DATA.md in web mode must be a silent null, same as any web run.
		const context = await loadAutoresearchDataContext({ cwd: root, mode: "web" });
		expect(context).toBeNull();
	});
});
