import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertInsideWorkspace } from "../src/lsp/workspace-path";

describe("assertInsideWorkspace", () => {
	it("allows a workspace file and rejects a symlink that leaves it", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "lsp-edit-"));
		const workspace = path.join(root, "repo");
		await mkdir(workspace);
		const inside = path.join(workspace, "note.txt");
		const outside = path.join(root, "secret.txt");
		await writeFile(inside, "ok");
		await writeFile(outside, "secret");
		await symlink(outside, path.join(workspace, "leak.txt"));
		await expect(assertInsideWorkspace(workspace, inside)).resolves.toBeUndefined();
		await expect(assertInsideWorkspace(workspace, path.join(workspace, "leak.txt"))).rejects.toThrow(
			/escapes the workspace/,
		);
	});

	it("allows a new file whose parent does not exist yet and rejects one under an outside link", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "lsp-edit-new-"));
		const workspace = path.join(root, "repo");
		await mkdir(path.join(workspace, "src"), { recursive: true });
		const created = path.join(workspace, "src", "newdir", "a.ts");
		await expect(assertInsideWorkspace(workspace, created)).resolves.toBeUndefined();

		const outside = path.join(root, "outside");
		await mkdir(outside);
		await symlink(outside, path.join(workspace, "link"));
		await expect(assertInsideWorkspace(workspace, path.join(workspace, "link", "newdir", "a.ts"))).rejects.toThrow(
			/escapes the workspace/,
		);
	});
});
