import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertCwdInsideWorkspace } from "../../src/tools/restricted-cwd";

describe("assertCwdInsideWorkspace", () => {
	it("allows the workspace and rejects a directory outside it", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "restricted-cwd-"));
		const workspace = path.join(root, "repo");
		const outside = path.join(root, "outside");
		await mkdir(workspace);
		await mkdir(outside);
		await expect(assertCwdInsideWorkspace(workspace, workspace)).resolves.toBeUndefined();
		await expect(assertCwdInsideWorkspace(workspace, outside)).rejects.toThrow(/inside the workspace/);
		await symlink(outside, path.join(workspace, "link"));
		await expect(assertCwdInsideWorkspace(workspace, path.join(workspace, "link"))).rejects.toThrow(
			/inside the workspace/,
		);
	});
});
