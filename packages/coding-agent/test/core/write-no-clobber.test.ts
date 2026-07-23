import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../../src/config/settings";
import { applyPatch } from "../../src/edit/modes/patch";
import type { ToolSession } from "../../src/tools";
import { WriteTool } from "../../src/tools/write";

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

function createSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		enableLsp: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
	};
}

describe("whole-file creation safety", () => {
	it("rejects write when the regular file already exists", async () => {
		const workspace = await createWorkspace();
		const filePath = path.join(workspace, "shared.test.ts");
		await fs.writeFile(filePath, "original\n", "utf8");

		const tool = new WriteTool(createSession(workspace));
		const overwrite = tool.execute("write-existing", { path: filePath, content: "replacement\n" });

		await expect(overwrite).rejects.toThrow(/already exists.*edit/i);
		expect(await fs.readFile(filePath, "utf8")).toBe("original\n");
	});

	it("allows exactly one concurrent write creator for a shared path", async () => {
		const workspace = await createWorkspace();
		const filePath = path.join(workspace, "shared.test.ts");
		const firstTool = new WriteTool(createSession(workspace));
		const secondTool = new WriteTool(createSession(workspace));

		const outcomes = await Promise.allSettled([
			firstTool.execute("write-first", { path: filePath, content: "first\n" }),
			secondTool.execute("write-second", { path: filePath, content: "second\n" }),
		]);

		expect(outcomes.filter(outcome => outcome.status === "fulfilled")).toHaveLength(1);
		expect(outcomes.filter(outcome => outcome.status === "rejected")).toHaveLength(1);
		expect(["first\n", "second\n"]).toContain(await fs.readFile(filePath, "utf8"));
	});

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
});
