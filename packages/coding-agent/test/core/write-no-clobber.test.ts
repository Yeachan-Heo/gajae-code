import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { applyPatch } from "../../src/edit/modes/patch";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })),
	);
});

async function createWorkspace(): Promise<string> {
	const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-write-no-clobber-"));
	temporaryDirectories.push(workspace);
	return workspace;
}

describe("whole-file creation safety", () => {
	it("rejects apply_patch Add File when the target already exists", async () => {
		const workspace = await createWorkspace();
		const filePath = path.join(workspace, "shared.test.ts");
		await fs.writeFile(filePath, "original\n", "utf8");

		const create = applyPatch(
			{ path: filePath, op: "create", diff: "+replacement" },
			{ cwd: workspace, allowFuzzy: false },
		);

		await expect(create).rejects.toThrow(/already exists.*update/i);
		expect(await fs.readFile(filePath, "utf8")).toBe("original\n");
	});

	it("rejects apply_patch moves when the destination already exists", async () => {
		const workspace = await createWorkspace();
		const sourcePath = path.join(workspace, "source.ts");
		const destinationPath = path.join(workspace, "destination.ts");
		await fs.writeFile(sourcePath, "source\n", "utf8");
		await fs.writeFile(destinationPath, "destination\n", "utf8");

		await expect(
			applyPatch(
				{ path: sourcePath, op: "update", rename: destinationPath, diff: "@@\n-source\n+updated" },
				{ cwd: workspace },
			),
		).rejects.toThrow(/Destination already exists/);
		expect(await fs.readFile(sourcePath, "utf8")).toBe("source\n");
		expect(await fs.readFile(destinationPath, "utf8")).toBe("destination\n");
	});
});
