import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { planPermissionFileChanges, planPermissionFileChangesWithGuard } from "../src/session/permission-file-changes";

let cwd: string;

beforeEach(async () => {
	cwd = await mkdtemp(path.join(os.tmpdir(), "permission-file-changes-"));
});

afterEach(async () => {
	await rm(cwd, { recursive: true, force: true });
});

describe("planPermissionFileChanges", () => {
	test("write to a new file produces an add change", async () => {
		const result = await planPermissionFileChanges("write", { path: "new.txt", content: "new content\n" }, cwd);

		expect(result).toEqual({
			[path.join(cwd, "new.txt")]: { type: "add", content: "new content\n" },
		});
	});

	test("write over an existing file produces a real unified diff", async () => {
		await Bun.write(path.join(cwd, "existing.txt"), "old line\nunchanged\n");

		const result = await planPermissionFileChanges(
			"write",
			{ path: "existing.txt", content: "new line\nunchanged\n" },
			cwd,
		);

		const change = result?.[path.join(cwd, "existing.txt")];
		expect(change?.type).toBe("update");
		if (change?.type !== "update") return;

		expect(change.unified_diff).toContain("-1|old line");
		expect(change.unified_diff).toContain("+1|new line");
	});

	test("delete carries the real preimage and refuses a missing file", async () => {
		await Bun.write(path.join(cwd, "delete.txt"), "keep this preimage\n");

		const result = await planPermissionFileChanges("delete", { path: "delete.txt" }, cwd);
		expect(result).toEqual({
			[path.join(cwd, "delete.txt")]: { type: "delete", content: "keep this preimage\n" },
		});

		expect(await planPermissionFileChanges("delete", { path: "missing.txt" }, cwd)).toBeUndefined();
	});

	test("move produces an update with an absolute move destination", async () => {
		const result = await planPermissionFileChanges("move", { oldPath: "from.txt", newPath: "to.txt" }, cwd);

		expect(result).toEqual({
			[path.join(cwd, "from.txt")]: {
				type: "update",
				unified_diff: "",
				move_path: path.join(cwd, "to.txt"),
			},
		});
	});

	test("edit patch mode projects a destructive delete with the real preimage", async () => {
		await Bun.write(path.join(cwd, "patch-delete.txt"), "delete me\n");

		expect(
			await planPermissionFileChanges("edit", { path: "patch-delete.txt", edits: [{ op: "delete" }] }, cwd),
		).toEqual({
			[path.join(cwd, "patch-delete.txt")]: { type: "delete", content: "delete me\n" },
		});
	});

	test("edit patch mode projects a destructive rename with a real diff", async () => {
		await Bun.write(path.join(cwd, "patch-rename.txt"), "before\n");

		const result = await planPermissionFileChanges(
			"edit",
			{
				path: "patch-rename.txt",
				edits: [{ op: "update", rename: "patch-renamed.txt", diff: "@@ -1 +1 @@\n-before\n+after\n" }],
			},
			cwd,
		);
		const change = result?.[path.join(cwd, "patch-rename.txt")];
		expect(change).toEqual({
			type: "update",
			unified_diff: expect.stringContaining("+1|after"),
			move_path: path.join(cwd, "patch-renamed.txt"),
		});
	});

	test("edit applies a matching old_text and emits a real diff", async () => {
		await Bun.write(path.join(cwd, "edit.txt"), "before\nafter\n");

		const result = await planPermissionFileChanges(
			"edit",
			{ path: "edit.txt", edits: [{ old_text: "before", new_text: "changed" }] },
			cwd,
		);

		const change = result?.[path.join(cwd, "edit.txt")];
		expect(change?.type).toBe("update");
		if (change?.type !== "update") return;
		expect(change.unified_diff).toContain("-1|before");
		expect(change.unified_diff).toContain("+1|changed");
		expect(change.move_path).toBeNull();
	});

	test("edit refuses a non-matching old_text", async () => {
		await Bun.write(path.join(cwd, "edit.txt"), "actual\n");

		expect(
			await planPermissionFileChanges(
				"edit",
				{ path: "edit.txt", edits: [{ old_text: "not present", new_text: "changed" }] },
				cwd,
			),
		).toBeUndefined();
	});

	test("apply_patch projects an add entry", async () => {
		const input = ["*** Begin Patch", "*** Add File: patch-new.txt", "+from apply_patch", "*** End Patch"].join("\n");

		expect(await planPermissionFileChanges("apply_patch", { input }, cwd)).toEqual({
			[path.join(cwd, "patch-new.txt")]: { type: "add", content: "from apply_patch\n" },
		});
	});

	test("mixed patch entries refuse before execution planning", async () => {
		await Bun.write(path.join(cwd, "mixed.txt"), "before\n");
		expect(
			await planPermissionFileChanges(
				"edit",
				{
					path: "mixed.txt",
					edits: [
						{ op: "update", diff: "@@ -1 +1 @@\n-before\n+one\n" },
						{ op: "update", diff: "@@ -1 +1 @@\n-one\n+two\n" },
					],
				},
				cwd,
			),
		).toBeUndefined();
		expect(await Bun.file(path.join(cwd, "mixed.txt")).text()).toBe("before\n");
	});

	test("reverse planning refuses an existing symlink target", async () => {
		const one = path.join(cwd, "one.txt");
		const two = path.join(cwd, "two.txt");
		const link = path.join(cwd, "link.txt");
		await Bun.write(one, "one\n");
		await Bun.write(two, "two\n");
		await symlink(one, link);
		expect(
			await planPermissionFileChangesWithGuard("write", { path: link, content: "changed\n" }, cwd),
		).toBeUndefined();
		expect(await Bun.file(two).text()).toBe("two\n");
	});

	test("guard rejects a regular target replaced by a symlink before execution", async () => {
		const target = path.join(cwd, "target.txt");
		const outside = path.join(cwd, "outside.txt");
		await Bun.write(target, "before\n");
		await Bun.write(outside, "outside\n");
		const planned = await planPermissionFileChangesWithGuard("write", { path: target, content: "after\n" }, cwd);
		expect(planned).toBeDefined();
		if (!planned) return;
		await rm(target);
		await symlink(outside, target);
		await expect(planned.guard.validate()).rejects.toThrow("Approved mutation target changed before execution");
		expect(await Bun.file(outside).text()).toBe("outside\n");
		expect(await Bun.file(target).text()).toBe("outside\n");
	});

	test("unrelated tools have no file-change representation", async () => {
		expect(await planPermissionFileChanges("bash", { command: "rm file" }, cwd)).toBeUndefined();
	});
});
