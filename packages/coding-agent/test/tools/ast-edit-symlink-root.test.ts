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
