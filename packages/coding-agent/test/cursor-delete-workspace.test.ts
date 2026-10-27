import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertDeleteInsideWorkspace } from "../src/cursor-delete-path";

describe("assertDeleteInsideWorkspace", () => {
	it("allows a file inside the workspace and rejects one outside", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "cursor-delete-"));
		const workspace = path.join(root, "repo");
		await mkdir(workspace);
		const inside = path.join(workspace, "note.txt");
		const outside = path.join(root, "secret.txt");
		await writeFile(inside, "ok");
		await writeFile(outside, "secret");
		await symlink(outside, path.join(workspace, "leak.txt"));
		await expect(assertDeleteInsideWorkspace(workspace, inside)).resolves.toBeUndefined();
		await expect(assertDeleteInsideWorkspace(workspace, path.join(workspace, "leak.txt"))).rejects.toThrow(
			/escapes the workspace/,
		);
	});
});
