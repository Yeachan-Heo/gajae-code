import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { ToolChoiceQueue } from "@gajae-code/coding-agent/session/tool-choice-queue";
import { createTools, type ToolSession } from "@gajae-code/coding-agent/tools";

const OUTSIDE_ROOT = "AST edit target resolves outside its root";

const SOURCE = "legacyWrap(x, value)\n";

function session(cwd: string, queue: ToolChoiceQueue): ToolSession {
	return {
		cwd,
		hasUI: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		getToolChoiceQueue: () => queue,
		buildToolChoice: () => ({ type: "tool" as const, name: "resolve" }),
	};
}

async function applyEdit(cwd: string, filePath: string): Promise<void> {
	const queue = new ToolChoiceQueue();
	const tools = await createTools(session(cwd, queue));
	const tool = tools.find(entry => entry.name === "ast_edit");
	expect(tool).toBeDefined();
	const preview = await tool!.execute("ast-edit-symlink-root", {
		ops: [{ pat: "legacyWrap($A, $B)", out: "modernWrap($A, $B)" }],
		paths: [filePath],
	});
	expect((preview.details as { totalReplacements?: number } | undefined)?.totalReplacements).toBe(1);
	queue.nextToolChoice();
	const invoker = queue.peekInFlightInvoker();
	expect(invoker).toBeDefined();
	await invoker!({ action: "apply", reason: "apply in-root ast edit" });
}

async function symlinkSupported(): Promise<boolean> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ast-edit-link-probe-"));
	try {
		const target = path.join(dir, "t.ts");
		await fs.writeFile(target, SOURCE);
		await fs.symlink(target, path.join(dir, "l.ts"));
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "EPERM" || code === "ENOTSUP") return false;
		throw error;
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

const canSymlink = await symlinkSupported();

describe("ast_edit single-file reference root", () => {
	it.skipIf(!canSymlink)("refuses a symlink file whose real path is outside the workspace", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "ast-edit-symlink-out-"));
		try {
			const cwd = path.join(root, "workspace");
			const outside = path.join(root, "outside", "secret.ts");
			await fs.mkdir(cwd, { recursive: true });
			await fs.mkdir(path.dirname(outside), { recursive: true });
			const original = Buffer.from(SOURCE);
			await fs.writeFile(outside, original);
			await fs.symlink(outside, path.join(cwd, "link.ts"));
			const queue = new ToolChoiceQueue();
			const tools = await createTools(session(cwd, queue));
			const tool = tools.find(entry => entry.name === "ast_edit");
			expect(tool).toBeDefined();
			const preview = await tool!.execute("ast-edit-symlink-out", {
				ops: [{ pat: "legacyWrap($A, $B)", out: "modernWrap($A, $B)" }],
				paths: ["link.ts"],
			});
			expect((preview.details as { totalReplacements?: number } | undefined)?.totalReplacements).toBe(1);
			queue.nextToolChoice();
			const invoker = queue.peekInFlightInvoker();
			expect(invoker).toBeDefined();
			await expect(invoker!({ action: "apply", reason: "apply symlink outside root" })).rejects.toThrow(
				OUTSIDE_ROOT,
			);
			expect(Buffer.compare(await fs.readFile(outside), original)).toBe(0);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("still allows an ordinary in-root file edit", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "ast-edit-symlink-in-"));
		try {
			const cwd = path.join(root, "workspace");
			const file = path.join(cwd, "src", "app.ts");
			await fs.mkdir(path.dirname(file), { recursive: true });
			await fs.writeFile(file, SOURCE);
			await applyEdit(cwd, "src/app.ts");
			expect(await fs.readFile(file, "utf8")).toContain("modernWrap(x, value)");
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it.skipIf(!canSymlink)("still allows a symlink whose target stays inside the workspace", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "ast-edit-symlink-alias-"));
		try {
			const cwd = path.join(root, "workspace");
			const file = path.join(cwd, "lib", "app.ts");
			await fs.mkdir(path.dirname(file), { recursive: true });
			await fs.mkdir(path.join(cwd, "src"));
			await fs.writeFile(file, SOURCE);
			await fs.symlink(path.join("..", "lib", "app.ts"), path.join(cwd, "src", "link.ts"));
			await applyEdit(cwd, "src/link.ts");
			expect(await fs.readFile(file, "utf8")).toContain("modernWrap(x, value)");
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("still allows an explicit file outside cwd that is not a symlink", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "ast-edit-symlink-abs-"));
		try {
			const cwd = path.join(root, "workspace");
			const file = path.join(root, "outside", "plain.ts");
			await fs.mkdir(cwd);
			await fs.mkdir(path.dirname(file));
			await fs.writeFile(file, SOURCE);
			await applyEdit(cwd, file);
			expect(await fs.readFile(file, "utf8")).toContain("modernWrap(x, value)");
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});

const INSIDE = "legacyWrap(kept, localToken655)\n";
const OUTSIDE = "legacyWrap(escaped, secretToken655)\n";
const OPS = [{ pat: "legacyWrap($A, $B)", out: "modernWrap($A, $B)" }] as const;

function previewText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find(part => part.type === "text")?.text ?? "";
}

async function previewDir(
	cwd: string,
	paths: string[],
): Promise<{ text: string; total: number; apply: () => Promise<void> }> {
	const queue = new ToolChoiceQueue();
	const tools = await createTools(session(cwd, queue));
	const tool = tools.find(entry => entry.name === "ast_edit");
	expect(tool).toBeDefined();
	const preview = await tool!.execute("ast-edit-dir-root", { ops: [...OPS], paths });
	const total = (preview.details as { totalReplacements?: number } | undefined)?.totalReplacements ?? -1;
	return {
		text: previewText(preview),
		total,
		apply: async () => {
			queue.nextToolChoice();
			const invoker = queue.peekInFlightInvoker();
			expect(invoker).toBeDefined();
			await invoker!({ action: "apply", reason: "apply directory ast edit" });
		},
	};
}

describe("ast_edit directory reference root", () => {
	it.skipIf(!canSymlink)("refuses a symlink directory whose real path is outside the workspace", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "ast-edit-dirlink-"));
		try {
			const cwd = path.join(root, "workspace");
			const outside = path.join(root, "outside");
			const outsideFile = path.join(outside, "escaped.ts");
			await fs.mkdir(cwd);
			await fs.mkdir(outside);
			await fs.writeFile(outsideFile, OUTSIDE);
			await fs.symlink(outside, path.join(cwd, "srclink"));
			const queue = new ToolChoiceQueue();
			const tools = await createTools(session(cwd, queue));
			const tool = tools.find(entry => entry.name === "ast_edit");
			expect(tool).toBeDefined();
			await expect(tool!.execute("ast-edit-dirlink", { ops: [...OPS], paths: ["srclink"] })).rejects.toThrow(
				OUTSIDE_ROOT,
			);
			await expect(
				tool!.execute("ast-edit-dirlink-dot", { ops: [...OPS], paths: ["sub/../srclink"] }),
			).rejects.toThrow(OUTSIDE_ROOT);
			expect(await fs.readFile(outsideFile, "utf8")).toBe(OUTSIDE);
			expect(queue.inspect().some(line => line.startsWith("pending-action:ast_edit"))).toBe(false);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it.skipIf(!canSymlink)("does not follow a trailing-space directory onto a sibling symlink", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "ast-edit-dirspace-"));
		try {
			const cwd = path.join(root, "workspace");
			const spaced = path.join(cwd, "dir ");
			const outside = path.join(root, "outside");
			const outsideFile = path.join(outside, "escaped.ts");
			const insideFile = path.join(spaced, "inside.ts");
			await fs.mkdir(cwd);
			await fs.mkdir(spaced);
			await fs.mkdir(outside);
			await fs.writeFile(insideFile, INSIDE);
			await fs.writeFile(outsideFile, OUTSIDE);
			await fs.symlink(outside, path.join(cwd, "dir"));
			const preview = await previewDir(cwd, ["dir /"]);
			expect(preview.total).toBe(1);
			expect(preview.text).toContain("localToken655");
			expect(preview.text).not.toContain("secretToken655");
			expect(await fs.readFile(outsideFile, "utf8")).toBe(OUTSIDE);
			await preview.apply();
			expect(await fs.readFile(insideFile, "utf8")).toContain("modernWrap(kept, localToken655)");
			expect(await fs.readFile(outsideFile, "utf8")).toBe(OUTSIDE);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it.skipIf(!canSymlink)("does not follow a trailing-space workspace when the path is dot", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "ast-edit-cwdspace-"));
		try {
			const cwd = path.join(root, "workspace ");
			const outside = path.join(root, "outside");
			const outsideFile = path.join(outside, "escaped.ts");
			const insideFile = path.join(cwd, "local.ts");
			await fs.mkdir(cwd);
			await fs.mkdir(outside);
			await fs.writeFile(insideFile, INSIDE);
			await fs.writeFile(outsideFile, OUTSIDE);
			await fs.symlink(outside, path.join(root, "workspace"));
			const preview = await previewDir(cwd, ["."]);
			expect(preview.total).toBe(1);
			expect(preview.text).toContain("localToken655");
			expect(preview.text).not.toContain("secretToken655");
			await preview.apply();
			expect(await fs.readFile(insideFile, "utf8")).toContain("modernWrap(kept, localToken655)");
			expect(await fs.readFile(outsideFile, "utf8")).toBe(OUTSIDE);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it.skipIf(!canSymlink)(
		"native astEdit does not trim a trailing-space directory onto a sibling symlink",
		async () => {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), "ast-edit-native-space-"));
			try {
				const cwd = path.join(root, "workspace");
				const spaced = path.join(cwd, "dir ");
				const outside = path.join(root, "outside");
				const outsideFile = path.join(outside, "escaped.ts");
				await fs.mkdir(cwd);
				await fs.mkdir(spaced);
				await fs.mkdir(outside);
				await fs.writeFile(path.join(spaced, "inside.ts"), INSIDE);
				await fs.writeFile(outsideFile, OUTSIDE);
				await fs.symlink(outside, path.join(cwd, "dir"));
				const { astEdit } = require("@gajae-code/natives") as {
					astEdit: (options: {
						rewrites: Record<string, string>;
						path: string;
						dryRun: boolean;
					}) => Promise<{ totalReplacements: number; changes: Array<{ before: string }> }>;
				};
				const preview = await astEdit({
					rewrites: { "legacyWrap($A, $B)": "modernWrap($A, $B)" },
					path: spaced,
					dryRun: true,
				});
				expect(preview.totalReplacements).toBe(1);
				expect(preview.changes.some(change => change.before.includes("secretToken655"))).toBe(false);
				expect(await fs.readFile(outsideFile, "utf8")).toBe(OUTSIDE);
			} finally {
				await fs.rm(root, { recursive: true, force: true });
			}
		},
	);

	it.skipIf(!canSymlink)("native astEdit does not retarget a missing trailing-space directory", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "ast-edit-native-missing-"));
		try {
			const cwd = path.join(root, "workspace");
			const spaced = path.join(cwd, "dir ");
			const outsideFile = path.join(root, "outside", "escaped.ts");
			await fs.mkdir(spaced, { recursive: true });
			await fs.mkdir(path.dirname(outsideFile), { recursive: true });
			await fs.writeFile(path.join(spaced, "inside.ts"), INSIDE);
			await fs.writeFile(outsideFile, OUTSIDE);
			await fs.symlink(path.dirname(outsideFile), path.join(cwd, "dir"));
			await fs.rename(spaced, path.join(cwd, "dir-moved"));
			const { astEdit } = require("@gajae-code/natives") as {
				astEdit: (options: {
					rewrites: Record<string, string>;
					path: string;
					dryRun: boolean;
				}) => Promise<{ totalReplacements: number }>;
			};
			await expect(
				astEdit({
					rewrites: { "legacyWrap($A, $B)": "modernWrap($A, $B)" },
					path: spaced,
					dryRun: false,
				}),
			).rejects.toThrow();
			expect(await fs.readFile(outsideFile, "utf8")).toBe(OUTSIDE);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it.skipIf(!canSymlink)(
		"rejects apply after the trailing-space directory is renamed away from a sibling symlink",
		async () => {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), "ast-edit-dir-moved-"));
			try {
				const cwd = path.join(root, "workspace");
				const spaced = path.join(cwd, "dir ");
				const outside = path.join(root, "outside");
				const outsideFile = path.join(outside, "escaped.ts");
				await fs.mkdir(cwd);
				await fs.mkdir(spaced);
				await fs.mkdir(outside);
				await fs.writeFile(path.join(spaced, "inside.ts"), INSIDE);
				await fs.writeFile(outsideFile, OUTSIDE);
				await fs.symlink(outside, path.join(cwd, "dir"));
				const preview = await previewDir(cwd, ["dir /"]);
				expect(preview.text).toContain("localToken655");
				expect(preview.text).not.toContain("secretToken655");
				await fs.rename(spaced, path.join(cwd, "dir-moved"));
				await expect(preview.apply()).rejects.toThrow(OUTSIDE_ROOT);
				expect(await fs.readFile(outsideFile, "utf8")).toBe(OUTSIDE);
			} finally {
				await fs.rm(root, { recursive: true, force: true });
			}
		},
	);

	it.skipIf(!canSymlink)(
		"does not edit an unpreviewed sibling after the trailing-space directory is renamed",
		async () => {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), "ast-edit-dir-real-sib-"));
			try {
				const cwd = path.join(root, "workspace");
				const spaced = path.join(cwd, "dir ");
				const sibling = path.join(cwd, "dir");
				const siblingFile = path.join(sibling, "n.ts");
				await fs.mkdir(cwd);
				await fs.mkdir(spaced);
				await fs.mkdir(sibling);
				await fs.writeFile(path.join(spaced, "inside.ts"), INSIDE);
				await fs.writeFile(siblingFile, OUTSIDE);
				const preview = await previewDir(cwd, ["dir /"]);
				expect(preview.text).toContain("localToken655");
				await fs.rename(spaced, path.join(cwd, "dir-moved"));
				await expect(preview.apply()).rejects.toThrow(OUTSIDE_ROOT);
				expect(await fs.readFile(siblingFile, "utf8")).toBe(OUTSIDE);
			} finally {
				await fs.rm(root, { recursive: true, force: true });
			}
		},
	);

	it("still allows a real directory and a path padded with spaces", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "ast-edit-dir-allow-"));
		try {
			const cwd = path.join(root, "workspace");
			const file = path.join(cwd, "src", "app.ts");
			await fs.mkdir(path.dirname(file), { recursive: true });
			await fs.writeFile(file, SOURCE);
			await applyEdit(cwd, "  src/app.ts  ");
			expect(await fs.readFile(file, "utf8")).toContain("modernWrap(x, value)");
			await fs.writeFile(file, SOURCE);
			const preview = await previewDir(cwd, ["src/"]);
			expect(preview.total).toBe(1);
			await preview.apply();
			expect(await fs.readFile(file, "utf8")).toContain("modernWrap(x, value)");
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it.skipIf(!canSymlink)("still allows a symlink directory whose target stays inside the workspace", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "ast-edit-dir-alias-"));
		try {
			const cwd = path.join(root, "workspace");
			const file = path.join(cwd, "real", "app.ts");
			await fs.mkdir(path.dirname(file), { recursive: true });
			await fs.writeFile(file, SOURCE);
			await fs.symlink(path.join(cwd, "real"), path.join(cwd, "alias"));
			const preview = await previewDir(cwd, ["alias"]);
			expect(preview.total).toBe(1);
			await preview.apply();
			expect(await fs.readFile(file, "utf8")).toContain("modernWrap(x, value)");
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("still allows an explicit real directory outside cwd", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "ast-edit-dir-abs-"));
		try {
			const cwd = path.join(root, "workspace");
			const file = path.join(root, "outside", "plain.ts");
			await fs.mkdir(cwd);
			await fs.mkdir(path.dirname(file));
			await fs.writeFile(file, SOURCE);
			const preview = await previewDir(cwd, [path.dirname(file)]);
			expect(preview.total).toBe(1);
			await preview.apply();
			expect(await fs.readFile(file, "utf8")).toContain("modernWrap(x, value)");
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it.skipIf(!canSymlink)("rejects apply after a parent directory is swapped for an outside symlink", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "ast-edit-parent-swap-"));
		try {
			const cwd = path.join(root, "workspace");
			const parent = path.join(cwd, "parent");
			const outside = path.join(root, "outside");
			const outsideFile = path.join(outside, "app.ts");
			await fs.mkdir(parent, { recursive: true });
			await fs.mkdir(outside);
			await fs.writeFile(path.join(parent, "app.ts"), INSIDE);
			await fs.writeFile(outsideFile, OUTSIDE);
			const preview = await previewDir(cwd, ["parent"]);
			expect(preview.text).toContain("localToken655");
			expect(preview.text).not.toContain("secretToken655");
			await fs.rm(parent, { recursive: true });
			await fs.symlink(outside, parent);
			await expect(preview.apply()).rejects.toThrow(OUTSIDE_ROOT);
			expect(await fs.readFile(outsideFile, "utf8")).toBe(OUTSIDE);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it.skipIf(!canSymlink)("rejects apply after a grandparent directory is swapped for an outside symlink", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "ast-edit-grand-swap-"));
		try {
			const cwd = path.join(root, "workspace");
			const grand = path.join(cwd, "grand");
			const outside = path.join(root, "outside");
			const outsideFile = path.join(outside, "parent", "app.ts");
			await fs.mkdir(path.join(grand, "parent"), { recursive: true });
			await fs.mkdir(path.dirname(outsideFile), { recursive: true });
			await fs.writeFile(path.join(grand, "parent", "app.ts"), INSIDE);
			await fs.writeFile(outsideFile, OUTSIDE);
			const preview = await previewDir(cwd, ["grand"]);
			expect(preview.text).not.toContain("secretToken655");
			await fs.rm(grand, { recursive: true });
			await fs.symlink(outside, grand);
			await expect(preview.apply()).rejects.toThrow(OUTSIDE_ROOT);
			expect(await fs.readFile(outsideFile, "utf8")).toBe(OUTSIDE);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
