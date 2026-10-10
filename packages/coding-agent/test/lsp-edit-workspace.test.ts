import { describe, expect, it, vi } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { LspTool } from "../src/lsp";
import * as lspClient from "../src/lsp/client";
import * as lspConfig from "../src/lsp/config";
import { applyWorkspaceEdit } from "../src/lsp/edits";
import type { LspClient, ServerConfig } from "../src/lsp/types";
import { fileToUri } from "../src/lsp/utils";
import {
	assertDirectoryEntryInsideWorkspace,
	assertInsideWorkspace,
	renameInsideWorkspace,
	splitAbsolute,
} from "../src/lsp/workspace-path";
import type { ToolSession } from "../src/tools";

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

	it("renames inside the workspace and refuses a destination or symlink that leaves it", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "lsp-rename-"));
		const workspace = path.join(root, "repo");
		await mkdir(workspace);
		const source = path.join(workspace, "note.txt");
		const outside = path.join(root, "secret.txt");
		await writeFile(source, "ok");
		await writeFile(outside, "secret");
		await symlink(outside, path.join(workspace, "leak.txt"));

		await expect(
			renameInsideWorkspace(workspace, source, path.join(workspace, "moved.txt")),
		).resolves.toBeUndefined();
		expect(await readFile(path.join(workspace, "moved.txt"), "utf8")).toBe("ok");
		await expect(lstat(source)).rejects.toMatchObject({ code: "ENOENT" });

		await expect(renameInsideWorkspace(workspace, path.join(workspace, "moved.txt"), outside)).rejects.toThrow(
			/escapes the workspace/,
		);
		expect(await readFile(path.join(workspace, "moved.txt"), "utf8")).toBe("ok");
		expect(await readFile(outside, "utf8")).toBe("secret");

		await expect(
			renameInsideWorkspace(workspace, path.join(workspace, "leak.txt"), path.join(workspace, "stolen.txt")),
		).rejects.toThrow(/escapes the workspace/);
		expect(await readFile(outside, "utf8")).toBe("secret");
		await expect(lstat(path.join(workspace, "stolen.txt"))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it.skipIf(process.platform === "win32")(
		"rename_file refuses a symlink source that leaves the workspace",
		async () => {
			const root = await mkdtemp(path.join(tmpdir(), "lsp-rename-tool-"));
			const workspace = path.join(root, "repo");
			await mkdir(workspace);
			const outside = path.join(root, "secret.txt");
			await writeFile(path.join(workspace, "note.txt"), "ok");
			await writeFile(outside, "secret");
			await symlink(outside, path.join(workspace, "leak.txt"));
			const tool = new LspTool({ cwd: workspace } as ToolSession);
			await expect(
				tool.execute("rename-escape", {
					action: "rename_file",
					file: "leak.txt",
					new_name: "stolen.txt",
				}),
			).rejects.toThrow(/escapes the workspace/);
			expect(await readFile(outside, "utf8")).toBe("secret");
			expect(await readFile(path.join(workspace, "note.txt"), "utf8")).toBe("ok");
			expect((await lstat(path.join(workspace, "leak.txt"))).isSymbolicLink()).toBe(true);
			await expect(lstat(path.join(workspace, "stolen.txt"))).rejects.toMatchObject({ code: "ENOENT" });
		},
	);

	it("refuses to move an outside symlink whose target is inside the workspace", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "lsp-inward-link-"));
		const workspace = path.join(root, "repo");
		await mkdir(workspace);
		const inside = path.join(workspace, "a.ts");
		await writeFile(inside, "ok");
		const outsideLink = path.join(root, "link.ts");
		await symlink(inside, outsideLink);
		await expect(renameInsideWorkspace(workspace, outsideLink, path.join(workspace, "new.ts"))).rejects.toThrow(
			/escapes the workspace/,
		);
		await expect(assertDirectoryEntryInsideWorkspace(workspace, outsideLink)).rejects.toThrow(
			/escapes the workspace/,
		);
		expect((await lstat(outsideLink)).isSymbolicLink()).toBe(true);
		expect(await readFile(inside, "utf8")).toBe("ok");
		await expect(lstat(path.join(workspace, "new.ts"))).rejects.toMatchObject({ code: "ENOENT" });

		const tool = new LspTool({ cwd: workspace } as ToolSession);
		await expect(
			tool.execute("rename-inward", { action: "rename_file", file: outsideLink, new_name: "new.ts" }),
		).rejects.toThrow(/escapes the workspace/);
		expect((await lstat(outsideLink)).isSymbolicLink()).toBe(true);
		expect(await readFile(inside, "utf8")).toBe("ok");
	});

	it("refuses hop/.. that resolves through a symlink to an outside directory entry", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "lsp-hop-"));
		const workspace = path.join(root, "ws");
		const outside = path.join(root, "outside");
		await mkdir(path.join(outside, "subdir"), { recursive: true });
		await mkdir(workspace);
		const inside = path.join(workspace, "a.ts");
		await writeFile(inside, "ok");
		const outsideLink = path.join(outside, "link.ts");
		await symlink(inside, outsideLink);
		await symlink(path.join(outside, "subdir"), path.join(workspace, "hop"));
		const source = `${workspace}/hop/../link.ts`;
		await expect(renameInsideWorkspace(workspace, source, path.join(workspace, "new.ts"))).rejects.toThrow(
			/escapes the workspace/,
		);
		expect((await lstat(outsideLink)).isSymbolicLink()).toBe(true);
		expect(await readFile(inside, "utf8")).toBe("ok");
		await expect(lstat(path.join(workspace, "new.ts"))).rejects.toMatchObject({ code: "ENOENT" });
		const tool = new LspTool({ cwd: workspace } as ToolSession);
		await expect(
			tool.execute("rename-hop", { action: "rename_file", file: source, new_name: "new.ts" }),
		).rejects.toThrow(/escapes the workspace/);
		expect((await lstat(outsideLink)).isSymbolicLink()).toBe(true);
	});

	it("allows a normal file when the workspace is the filesystem root", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "lsp-root-"));
		const file = path.join(dir, "a.txt");
		await writeFile(file, "ok");
		await expect(assertInsideWorkspace(path.parse(file).root, file)).resolves.toBeUndefined();
	});

	it("rejects an empty path", async () => {
		const workspace = await mkdtemp(path.join(tmpdir(), "lsp-empty-"));
		await expect(assertInsideWorkspace(workspace, "")).rejects.toThrow(/escapes the workspace/);
		await expect(assertInsideWorkspace("", path.join(workspace, "a.txt"))).rejects.toThrow(/escapes the workspace/);
	});

	it("renames a path whose .. walks through a missing directory", async () => {
		const workspace = await mkdtemp(path.join(tmpdir(), "lsp-dotdot-"));
		const source = path.join(workspace, "a.ts");
		await writeFile(source, "ok");
		const viaMissing = `${workspace}${path.sep}missing${path.sep}..${path.sep}a.ts`;
		expect(viaMissing.includes(`${path.sep}missing${path.sep}..${path.sep}`)).toBe(true);
		const dest = path.join(workspace, "b.ts");
		await expect(renameInsideWorkspace(workspace, viaMissing, dest)).resolves.toBeUndefined();
		expect(await readFile(dest, "utf8")).toBe("ok");
		await expect(lstat(source)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("treats a Windows slash file path as inside its drive directory", () => {
		const split = splitAbsolute("C:/ws/a.ts", path.win32);
		expect(split.root).toBe("C:/");
		expect(split.parts.slice(0, -1)).toEqual(["ws"]);
	});

	it("renames into a directory that does not exist yet", async () => {
		const workspace = await mkdtemp(path.join(tmpdir(), "lsp-nested-"));
		const source = path.join(workspace, "a.ts");
		await writeFile(source, "ok");
		const dest = path.join(workspace, "nested", "b.ts");
		await expect(renameInsideWorkspace(workspace, source, dest)).resolves.toBeUndefined();
		expect(await readFile(dest, "utf8")).toBe("ok");
	});
});

function stubLspClient(cwd: string, server: ServerConfig): LspClient {
	return {
		name: "test-lsp",
		cwd,
		config: server,
		proc: {
			stdin: { write() {}, flush: async () => {} },
		} as unknown as LspClient["proc"],
		requestId: 0,
		diagnostics: new Map(),
		diagnosticsVersion: 0,
		openFiles: new Map(),
		pendingRequests: new Map(),
		messageBuffer: new Uint8Array(),
		isReading: false,
		lastActivity: Date.now(),
		writeQueue: Promise.resolve(),
		activeProgressTokens: new Set(),
		projectLoaded: Promise.resolve(),
		resolveProjectLoaded: () => {},
	};
}

async function withRenameServer(workspace: string, edit: unknown, run: (tool: LspTool) => Promise<void>) {
	const server: ServerConfig = { command: "test-lsp", fileTypes: ["ts"], rootMarkers: [] };
	vi.spyOn(lspConfig, "loadConfig").mockReturnValue({
		servers: { "test-lsp": server },
		idleTimeoutMs: undefined,
	});
	vi.spyOn(lspClient, "getOrCreateClient").mockResolvedValue(stubLspClient(workspace, server));
	vi.spyOn(lspClient, "sendRequest").mockResolvedValue(edit);
	vi.spyOn(lspClient, "sendNotification").mockResolvedValue();
	try {
		await run(new LspTool({ cwd: workspace } as ToolSession));
	} finally {
		vi.restoreAllMocks();
	}
}

describe("rename_file server edits", () => {
	it("does not write an earlier edit when a later willRenameFiles target leaves the workspace", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "lsp-preflight-"));
		const workspace = path.join(root, "repo");
		await mkdir(workspace);
		const source = path.join(workspace, "old.ts");
		const dest = path.join(workspace, "new.ts");
		const inside = path.join(workspace, "consumer.ts");
		const outside = path.join(root, "secret.ts");
		await writeFile(source, "export const value = 1;\n");
		await writeFile(inside, "alpha\n");
		await writeFile(outside, "secret\n");
		const server: ServerConfig = { command: "test-lsp", fileTypes: ["ts"], rootMarkers: [] };
		vi.spyOn(lspConfig, "loadConfig").mockReturnValue({
			servers: { "test-lsp": server },
			idleTimeoutMs: undefined,
		});
		vi.spyOn(lspClient, "getOrCreateClient").mockResolvedValue(stubLspClient(workspace, server));
		vi.spyOn(lspClient, "sendRequest").mockResolvedValue({
			changes: {
				[fileToUri(inside)]: [
					{
						range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
						newText: "betaX",
					},
				],
				[fileToUri(outside)]: [
					{
						range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } },
						newText: "pwnedX",
					},
				],
			},
		});
		vi.spyOn(lspClient, "sendNotification").mockResolvedValue();
		try {
			const tool = new LspTool({ cwd: workspace } as ToolSession);
			await expect(
				tool.execute("rename-preflight", {
					action: "rename_file",
					file: source,
					new_name: dest,
					timeout: 5,
				}),
			).rejects.toThrow(/escapes the workspace/);
			expect(await readFile(inside, "utf8")).toBe("alpha\n");
			expect(await readFile(outside, "utf8")).toBe("secret\n");
			expect(await readFile(source, "utf8")).toBe("export const value = 1;\n");
			await expect(lstat(dest)).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			vi.restoreAllMocks();
		}
	});

	it("applies every in-workspace willRenameFiles edit after all targets pass", async () => {
		const workspace = await mkdtemp(path.join(tmpdir(), "lsp-preflight-ok-"));
		const source = path.join(workspace, "old.ts");
		const dest = path.join(workspace, "new.ts");
		const first = path.join(workspace, "a.ts");
		const second = path.join(workspace, "b.ts");
		await writeFile(source, "export const value = 1;\n");
		await writeFile(first, "alpha\n");
		await writeFile(second, "gamma\n");
		const server: ServerConfig = { command: "test-lsp", fileTypes: ["ts"], rootMarkers: [] };
		vi.spyOn(lspConfig, "loadConfig").mockReturnValue({
			servers: { "test-lsp": server },
			idleTimeoutMs: undefined,
		});
		vi.spyOn(lspClient, "getOrCreateClient").mockResolvedValue(stubLspClient(workspace, server));
		vi.spyOn(lspClient, "sendRequest").mockResolvedValue({
			changes: {
				[fileToUri(first)]: [
					{
						range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
						newText: "betaX",
					},
				],
				[fileToUri(second)]: [
					{
						range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
						newText: "delta",
					},
				],
			},
		});
		vi.spyOn(lspClient, "sendNotification").mockResolvedValue();
		try {
			const tool = new LspTool({ cwd: workspace } as ToolSession);
			await tool.execute("rename-preflight-ok", {
				action: "rename_file",
				file: source,
				new_name: dest,
				timeout: 5,
			});
			expect(await readFile(first, "utf8")).toBe("betaX\n");
			expect(await readFile(second, "utf8")).toBe("delta\n");
			await expect(lstat(source)).rejects.toMatchObject({ code: "ENOENT" });
			expect(await readFile(dest, "utf8")).toBe("export const value = 1;\n");
		} finally {
			vi.restoreAllMocks();
		}
	});

	it.skipIf(process.platform === "win32")(
		"rename_file does not delete an outside entry through a symlink an earlier rename retargets",
		async () => {
			const root = await mkdtemp(path.join(tmpdir(), "lsp-entry-del-"));
			const workspace = path.join(root, "ws");
			await mkdir(path.join(workspace, "deep"), { recursive: true });
			await mkdir(path.join(workspace, "safe"), { recursive: true });
			const outside = path.join(root, "safe");
			await mkdir(outside);
			await writeFile(path.join(workspace, "a.ts"), "ok");
			await writeFile(path.join(workspace, "note.txt"), "keep");
			const link = path.join(workspace, "deep", "link");
			await symlink("../safe", link);
			const outsideInward = path.join(outside, "inward");
			await symlink(path.join(workspace, "a.ts"), outsideInward);
			const moved = path.join(workspace, "link");
			await withRenameServer(
				workspace,
				{
					documentChanges: [
						{ kind: "rename", oldUri: fileToUri(link), newUri: fileToUri(moved) },
						{ kind: "delete", uri: fileToUri(path.join(moved, "inward")) },
					],
				},
				async tool => {
					await expect(
						tool.execute("rename-entry", {
							action: "rename_file",
							file: path.join(workspace, "note.txt"),
							new_name: path.join(workspace, "note2.txt"),
							timeout: 5,
						}),
					).rejects.toThrow(/escapes the workspace/);
				},
			);
			expect(await readFile(path.join(workspace, "note.txt"), "utf8")).toBe("keep");
			expect((await lstat(link)).isSymbolicLink()).toBe(true);
			expect((await lstat(outsideInward)).isSymbolicLink()).toBe(true);
			await expect(lstat(moved)).rejects.toMatchObject({ code: "ENOENT" });
			await expect(lstat(path.join(workspace, "note2.txt"))).rejects.toMatchObject({ code: "ENOENT" });
		},
	);

	it.skipIf(process.platform === "win32")(
		"rename_file does not follow a symlink when the rename destination is spelled with ./",
		async () => {
			const root = await mkdtemp(path.join(tmpdir(), "lsp-dot-dest-"));
			const workspace = path.join(root, "ws");
			await mkdir(path.join(workspace, "deep"), { recursive: true });
			await mkdir(path.join(workspace, "safe"), { recursive: true });
			const outside = path.join(root, "safe");
			await mkdir(outside);
			await writeFile(path.join(workspace, "note.txt"), "keep");
			const link = path.join(workspace, "deep", "link");
			await symlink("../safe", link);
			const dotUri = `file://${workspace}/./link`;
			expect(dotUri).toContain("/./");
			await withRenameServer(
				workspace,
				{
					documentChanges: [
						{ kind: "rename", oldUri: fileToUri(link), newUri: dotUri },
						{ kind: "create", uri: fileToUri(path.join(workspace, "link", "new.txt")) },
					],
				},
				async tool => {
					await expect(
						tool.execute("rename-dot", {
							action: "rename_file",
							file: path.join(workspace, "note.txt"),
							new_name: path.join(workspace, "note2.txt"),
							timeout: 5,
						}),
					).rejects.toThrow(/escapes the workspace/);
				},
			);
			expect((await lstat(link)).isSymbolicLink()).toBe(true);
			await expect(lstat(path.join(workspace, "link"))).rejects.toMatchObject({ code: "ENOENT" });
			await expect(lstat(path.join(outside, "new.txt"))).rejects.toMatchObject({ code: "ENOENT" });
			expect(await readFile(path.join(workspace, "note.txt"), "utf8")).toBe("keep");
		},
	);

	it("rename_file writes a relative server path in the workspace, not process.cwd()", async () => {
		const workspace = await mkdtemp(path.join(tmpdir(), "lsp-rel-cwd-"));
		const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
		const marker = `marker-${id}.txt`;
		const victim = `victim-${id}.txt`;
		const source = path.join(workspace, "note.txt");
		await writeFile(source, "keep\n");
		await writeFile(path.join(workspace, marker), "alpha\n");
		const cwdMarker = path.join(process.cwd(), marker);
		const cwdVictim = path.join(process.cwd(), victim);
		try {
			await withRenameServer(
				workspace,
				{
					changes: {
						[marker]: [
							{
								range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
								newText: "betaX",
							},
						],
					},
					documentChanges: [{ kind: "create", uri: victim }],
				},
				async tool => {
					await tool.execute("rename-rel", {
						action: "rename_file",
						file: source,
						new_name: path.join(workspace, "note2.txt"),
						timeout: 5,
					});
				},
			);
			expect(await readFile(path.join(workspace, marker), "utf8")).toBe("betaX\n");
			expect(await readFile(path.join(workspace, victim), "utf8")).toBe("");
			await expect(lstat(cwdMarker)).rejects.toMatchObject({ code: "ENOENT" });
			await expect(lstat(cwdVictim)).rejects.toMatchObject({ code: "ENOENT" });
			expect(await readFile(path.join(workspace, "note2.txt"), "utf8")).toBe("keep\n");
		} finally {
			await unlink(cwdMarker).catch(() => {});
			await unlink(cwdVictim).catch(() => {});
		}
	});

	it.skipIf(process.platform === "win32")(
		"rename_file refuses a POSIX backslash entry whose target is inside the workspace",
		async () => {
			const root = await mkdtemp(path.join(tmpdir(), "lsp-backslash-"));
			const workspace = path.join(root, "ws");
			await mkdir(workspace);
			const inside = path.join(workspace, "a.ts");
			await writeFile(inside, "ok");
			const outside = path.join(root, "out");
			await mkdir(outside);
			await symlink(outside, path.join(root, "ws\\other"));
			const inward = path.join(outside, "inward");
			await symlink(inside, inward);
			const source = path.join(root, "ws\\other", "inward");
			expect(splitAbsolute(source).parts.some(part => part.includes("\\"))).toBe(true);
			const tool = new LspTool({ cwd: workspace } as ToolSession);
			await expect(
				tool.execute("rename-backslash", {
					action: "rename_file",
					file: source,
					new_name: path.join(workspace, "moved.ts"),
				}),
			).rejects.toThrow(/escapes the workspace/);
			expect((await lstat(inward)).isSymbolicLink()).toBe(true);
			expect(await readFile(inside, "utf8")).toBe("ok");
			await expect(lstat(path.join(workspace, "moved.ts"))).rejects.toMatchObject({ code: "ENOENT" });
		},
	);

	it("rename_file renames a path whose .. walks through a missing directory", async () => {
		const workspace = await mkdtemp(path.join(tmpdir(), "lsp-tool-dotdot-"));
		const source = path.join(workspace, "a.ts");
		await writeFile(source, "ok");
		const viaMissing = `${workspace}${path.sep}missing${path.sep}..${path.sep}a.ts`;
		expect(viaMissing.includes(`${path.sep}missing${path.sep}..${path.sep}`)).toBe(true);
		const dest = path.join(workspace, "b.ts");
		await withRenameServer(workspace, null, async tool => {
			await tool.execute("rename-dotdot", {
				action: "rename_file",
				file: viaMissing,
				new_name: dest,
				timeout: 5,
			});
		});
		expect(await readFile(dest, "utf8")).toBe("ok");
		await expect(lstat(source)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it.skipIf(process.platform === "win32")(
		"rename_file does not write through a symlink hidden by a missing .. segment",
		async () => {
			const root = await mkdtemp(path.join(tmpdir(), "lsp-collapsed-link-"));
			const workspace = path.join(root, "ws");
			await mkdir(workspace);
			const outside = path.join(root, "secret.txt");
			await writeFile(outside, "secret");
			await writeFile(path.join(workspace, "note.txt"), "keep");
			await symlink(outside, path.join(workspace, "link"));
			const uri = `file://${workspace}/missing/../link`;
			expect(uri).toContain("/missing/../");
			await withRenameServer(
				workspace,
				{
					changes: {
						[uri]: [
							{
								range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } },
								newText: "pwnedX",
							},
						],
					},
				},
				async tool => {
					await expect(
						tool.execute("rename-collapsed", {
							action: "rename_file",
							file: path.join(workspace, "note.txt"),
							new_name: path.join(workspace, "note2.txt"),
							timeout: 5,
						}),
					).rejects.toThrow(/escapes the workspace/);
				},
			);
			expect(await readFile(outside, "utf8")).toBe("secret");
			expect((await lstat(path.join(workspace, "link"))).isSymbolicLink()).toBe(true);
			expect(await readFile(path.join(workspace, "note.txt"), "utf8")).toBe("keep");
		},
	);

	it.skipIf(process.platform === "win32")(
		"rename_file treats an ancestor symlink as the same path as its target",
		async () => {
			const root = await mkdtemp(path.join(tmpdir(), "lsp-alias-move-"));
			const workspace = path.join(root, "ws");
			await mkdir(path.join(workspace, "deep"), { recursive: true });
			await mkdir(path.join(workspace, "safe"), { recursive: true });
			const outside = path.join(root, "safe");
			await mkdir(outside);
			await writeFile(path.join(workspace, "note.txt"), "keep");
			const link = path.join(workspace, "deep", "link");
			await symlink("../safe", link);
			await symlink(workspace, path.join(workspace, "alias"));
			await withRenameServer(
				workspace,
				{
					documentChanges: [
						{ kind: "rename", oldUri: fileToUri(link), newUri: fileToUri(path.join(workspace, "alias", "link")) },
						{ kind: "create", uri: fileToUri(path.join(workspace, "link", "new.txt")) },
					],
				},
				async tool => {
					await expect(
						tool.execute("rename-alias", {
							action: "rename_file",
							file: path.join(workspace, "note.txt"),
							new_name: path.join(workspace, "note2.txt"),
							timeout: 5,
						}),
					).rejects.toThrow(/escapes the workspace/);
				},
			);
			expect((await lstat(link)).isSymbolicLink()).toBe(true);
			await expect(lstat(path.join(outside, "new.txt"))).rejects.toMatchObject({ code: "ENOENT" });
			expect(await readFile(path.join(workspace, "note.txt"), "utf8")).toBe("keep");
		},
	);

	it.skipIf(process.platform === "win32")(
		"rename_file does not reuse a symlink after a later rename replaces its directory",
		async () => {
			const root = await mkdtemp(path.join(tmpdir(), "lsp-stale-move-"));
			const workspace = path.join(root, "ws");
			const outside = path.join(root, "out");
			await mkdir(path.join(workspace, "a"), { recursive: true });
			await mkdir(path.join(workspace, "b"), { recursive: true });
			await mkdir(path.join(workspace, "c"), { recursive: true });
			await mkdir(path.join(workspace, "d"), { recursive: true });
			await mkdir(path.join(workspace, "safe"), { recursive: true });
			await mkdir(outside);
			await writeFile(path.join(workspace, "note.txt"), "keep");
			const original = path.join(workspace, "a", "link");
			await symlink(path.join(workspace, "safe"), original);
			await symlink(outside, path.join(workspace, "d", "link"));
			await withRenameServer(
				workspace,
				{
					documentChanges: [
						{
							kind: "rename",
							oldUri: fileToUri(original),
							newUri: fileToUri(path.join(workspace, "b", "link")),
						},
						{
							kind: "rename",
							oldUri: fileToUri(path.join(workspace, "b", "link")),
							newUri: fileToUri(path.join(workspace, "c", "link")),
						},
						{
							kind: "rename",
							oldUri: fileToUri(path.join(workspace, "d")),
							newUri: fileToUri(path.join(workspace, "b")),
						},
						{ kind: "create", uri: fileToUri(path.join(workspace, "b", "link", "new.txt")) },
					],
				},
				async tool => {
					await expect(
						tool.execute("rename-stale", {
							action: "rename_file",
							file: path.join(workspace, "note.txt"),
							new_name: path.join(workspace, "note2.txt"),
							timeout: 5,
						}),
					).rejects.toThrow(/escapes the workspace/);
				},
			);
			expect((await lstat(original)).isSymbolicLink()).toBe(true);
			await expect(lstat(path.join(outside, "new.txt"))).rejects.toMatchObject({ code: "ENOENT" });
			expect(await readFile(path.join(workspace, "note.txt"), "utf8")).toBe("keep");
		},
	);

	it.skipIf(process.platform === "win32")(
		"rename_file refuses a directory whose name ends with a backslash",
		async () => {
			const root = await mkdtemp(path.join(tmpdir(), "lsp-box-"));
			const workspace = path.join(root, "ws");
			await mkdir(workspace);
			const inside = path.join(workspace, "ok.txt");
			await writeFile(inside, "ok");
			const outside = path.join(root, "out");
			await mkdir(outside);
			const box = path.join(workspace, "box\\");
			await mkdir(box);
			await symlink(outside, path.join(box, "hop"));
			const inward = path.join(outside, "inward");
			await symlink(inside, inward);
			const source = path.join(box, "hop", "inward");
			expect(splitAbsolute(source).parts.some(part => part.endsWith("\\"))).toBe(true);
			const tool = new LspTool({ cwd: workspace } as ToolSession);
			await expect(
				tool.execute("rename-box", {
					action: "rename_file",
					file: source,
					new_name: path.join(workspace, "moved.txt"),
				}),
			).rejects.toThrow(/escapes the workspace/);
			expect((await lstat(inward)).isSymbolicLink()).toBe(true);
			expect(await readFile(inside, "utf8")).toBe("ok");
			await expect(lstat(path.join(workspace, "moved.txt"))).rejects.toMatchObject({ code: "ENOENT" });
		},
	);

	it.skipIf(process.platform === "win32")(
		"rename_file rejects its own destination when an earlier server rename retargets it",
		async () => {
			const root = await mkdtemp(path.join(tmpdir(), "lsp-user-dest-"));
			const workspace = path.join(root, "ws");
			await mkdir(path.join(workspace, "deep"), { recursive: true });
			await mkdir(path.join(workspace, "safe"), { recursive: true });
			const outside = path.join(root, "safe");
			await mkdir(outside);
			await writeFile(path.join(workspace, "note.txt"), "keep");
			const link = path.join(workspace, "deep", "link");
			await symlink("../safe", link);
			await withRenameServer(
				workspace,
				{
					documentChanges: [
						{
							kind: "rename",
							oldUri: fileToUri(link),
							newUri: fileToUri(path.join(workspace, "link")),
						},
					],
				},
				async tool => {
					await expect(
						tool.execute("rename-user-dest", {
							action: "rename_file",
							file: path.join(workspace, "note.txt"),
							new_name: path.join(workspace, "link", "new.txt"),
							timeout: 5,
						}),
					).rejects.toThrow(/escapes the workspace/);
				},
			);
			expect(await readFile(path.join(workspace, "note.txt"), "utf8")).toBe("keep");
			expect((await lstat(link)).isSymbolicLink()).toBe(true);
			await expect(lstat(path.join(workspace, "link"))).rejects.toMatchObject({ code: "ENOENT" });
			await expect(lstat(path.join(outside, "new.txt"))).rejects.toMatchObject({ code: "ENOENT" });
		},
	);

	it.skipIf(process.platform === "win32")(
		"rename_file does not follow an alias after an earlier delete removes it",
		async () => {
			const root = await mkdtemp(path.join(tmpdir(), "lsp-del-alias-"));
			const workspace = path.join(root, "ws");
			await mkdir(path.join(workspace, "deep", "safe"), { recursive: true });
			await mkdir(path.join(workspace, "deep", "src"), { recursive: true });
			await mkdir(path.join(workspace, "safe"), { recursive: true });
			const outside = path.join(root, "safe");
			await mkdir(outside);
			await writeFile(path.join(workspace, "note.txt"), "keep");
			const alias = path.join(workspace, "alias");
			await symlink(path.join(workspace, "deep", "safe"), alias);
			const link = path.join(workspace, "deep", "src", "link");
			await symlink("../../safe", link);
			await withRenameServer(
				workspace,
				{
					documentChanges: [
						{ kind: "delete", uri: fileToUri(alias) },
						{ kind: "rename", oldUri: fileToUri(link), newUri: fileToUri(path.join(workspace, "alias", "link")) },
						{ kind: "create", uri: fileToUri(path.join(workspace, "alias", "link", "new.txt")) },
					],
				},
				async tool => {
					await expect(
						tool.execute("rename-del-alias", {
							action: "rename_file",
							file: path.join(workspace, "note.txt"),
							new_name: path.join(workspace, "note2.txt"),
							timeout: 5,
						}),
					).rejects.toThrow(/escapes the workspace/);
				},
			);
			expect((await lstat(alias)).isSymbolicLink()).toBe(true);
			expect((await lstat(link)).isSymbolicLink()).toBe(true);
			await expect(lstat(path.join(outside, "new.txt"))).rejects.toMatchObject({ code: "ENOENT" });
			expect(await readFile(path.join(workspace, "note.txt"), "utf8")).toBe("keep");
		},
	);

	it.skipIf(process.platform === "win32")(
		"rename_file moves the symlink entry when missing/.. names an alias",
		async () => {
			const root = await mkdtemp(path.join(tmpdir(), "lsp-alias-operand-"));
			const workspace = path.join(root, "ws");
			const dir = path.join(workspace, "deep", "dir");
			await mkdir(dir, { recursive: true });
			await mkdir(path.join(workspace, "safe"), { recursive: true });
			const outside = path.join(root, "safe");
			await mkdir(outside);
			await writeFile(path.join(workspace, "note.txt"), "keep");
			const alias = path.join(workspace, "alias");
			await symlink(dir, alias);
			await symlink("../../safe", path.join(dir, "hop"));
			const viaMissing = `${workspace}${path.sep}missing${path.sep}..${path.sep}alias`;
			expect(viaMissing.includes(`${path.sep}missing${path.sep}..${path.sep}`)).toBe(true);
			await withRenameServer(
				workspace,
				{
					documentChanges: [
						{ kind: "rename", oldUri: viaMissing, newUri: fileToUri(path.join(workspace, "moved")) },
						{ kind: "create", uri: fileToUri(path.join(workspace, "moved", "hop", "new.txt")) },
					],
				},
				async tool => {
					await tool.execute("rename-alias-operand", {
						action: "rename_file",
						file: path.join(workspace, "note.txt"),
						new_name: path.join(workspace, "note2.txt"),
						timeout: 5,
					});
				},
			);
			expect((await lstat(dir)).isDirectory()).toBe(true);
			expect((await lstat(path.join(workspace, "moved"))).isSymbolicLink()).toBe(true);
			await expect(lstat(alias)).rejects.toMatchObject({ code: "ENOENT" });
			await expect(lstat(path.join(outside, "new.txt"))).rejects.toMatchObject({ code: "ENOENT" });
			expect(await readFile(path.join(workspace, "safe", "new.txt"), "utf8")).toBe("");
		},
	);

	it.skipIf(process.platform === "win32")(
		"rename_file does not read an alias from a directory after that alias was moved away",
		async () => {
			const root = await mkdtemp(path.join(tmpdir(), "lsp-stale-ancestor-"));
			const workspace = path.join(root, "ws");
			await mkdir(path.join(workspace, "a"), { recursive: true });
			await mkdir(path.join(workspace, "x", "y", "z"), { recursive: true });
			await mkdir(path.join(workspace, "src", "deep", "more"), { recursive: true });
			await mkdir(path.join(workspace, "safe"), { recursive: true });
			const outside = path.join(root, "safe");
			await mkdir(outside);
			await writeFile(path.join(workspace, "note.txt"), "keep");
			const alias = path.join(workspace, "a", "alias");
			await symlink(path.join(workspace, "x", "y", "z"), alias);
			const link = path.join(workspace, "src", "deep", "more", "link");
			await symlink("../../../safe", link);
			await withRenameServer(
				workspace,
				{
					documentChanges: [
						{ kind: "rename", oldUri: fileToUri(alias), newUri: fileToUri(path.join(workspace, "park")) },
						{
							kind: "rename",
							oldUri: fileToUri(path.join(workspace, "a")),
							newUri: fileToUri(path.join(workspace, "b")),
						},
						{
							kind: "rename",
							oldUri: fileToUri(link),
							newUri: fileToUri(path.join(workspace, "b", "alias", "link")),
						},
						{ kind: "create", uri: fileToUri(path.join(workspace, "b", "alias", "link", "new.txt")) },
					],
				},
				async tool => {
					await expect(
						tool.execute("rename-stale-ancestor", {
							action: "rename_file",
							file: path.join(workspace, "note.txt"),
							new_name: path.join(workspace, "note2.txt"),
							timeout: 5,
						}),
					).rejects.toThrow(/escapes the workspace/);
				},
			);
			expect((await lstat(alias)).isSymbolicLink()).toBe(true);
			await expect(lstat(path.join(outside, "new.txt"))).rejects.toMatchObject({ code: "ENOENT" });
			expect(await readFile(path.join(workspace, "note.txt"), "utf8")).toBe("keep");
		},
	);

	it.skipIf(process.platform === "win32")(
		"rename_file creates hop/../file inside the walked directory, not the lexical collapse",
		async () => {
			const root = await mkdtemp(path.join(tmpdir(), "lsp-hop-create-"));
			const workspace = path.join(root, "ws");
			const deep = path.join(workspace, "deep", "dir");
			await mkdir(deep, { recursive: true });
			const outside = path.join(root, "outside");
			await mkdir(outside);
			const secret = path.join(outside, "secret.txt");
			await writeFile(secret, "secret");
			await writeFile(path.join(workspace, "note.txt"), "keep");
			await symlink(deep, path.join(workspace, "hop"));
			await symlink(secret, path.join(workspace, "file"));
			const via = `file://${workspace}/hop/../file`;
			expect(via.includes("/hop/../file")).toBe(true);
			await withRenameServer(workspace, { documentChanges: [{ kind: "create", uri: via }] }, async tool => {
				await tool.execute("rename-hop-create", {
					action: "rename_file",
					file: path.join(workspace, "note.txt"),
					new_name: path.join(workspace, "note2.txt"),
					timeout: 5,
				});
			});
			expect(await readFile(secret, "utf8")).toBe("secret");
			expect((await lstat(path.join(workspace, "file"))).isSymbolicLink()).toBe(true);
			expect(await readFile(path.join(workspace, "deep", "file"), "utf8")).toBe("");
			await expect(lstat(path.join(workspace, "note.txt"))).rejects.toMatchObject({ code: "ENOENT" });
			expect(await readFile(path.join(workspace, "note2.txt"), "utf8")).toBe("keep");
		},
	);

	it.skipIf(process.platform === "win32")(
		"rename_file does not text-edit the file named by lexically collapsing hop/..",
		async () => {
			const root = await mkdtemp(path.join(tmpdir(), "lsp-hop-text-"));
			const workspace = path.join(root, "ws");
			const deep = path.join(workspace, "deep", "dir");
			await mkdir(deep, { recursive: true });
			const outside = path.join(root, "outside");
			await mkdir(outside);
			const secret = path.join(outside, "secret.txt");
			await writeFile(secret, "secret");
			await writeFile(path.join(workspace, "note.txt"), "keep");
			await symlink(deep, path.join(workspace, "hop"));
			await symlink(secret, path.join(workspace, "file"));
			const via = `file://${workspace}/hop/../file`;
			expect(via.includes("/hop/../file")).toBe(true);
			await withRenameServer(
				workspace,
				{
					changes: {
						[via]: [
							{
								range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } },
								newText: "pwnedX",
							},
						],
					},
				},
				async tool => {
					await expect(
						tool.execute("rename-hop-text", {
							action: "rename_file",
							file: path.join(workspace, "note.txt"),
							new_name: path.join(workspace, "note2.txt"),
							timeout: 5,
						}),
					).rejects.toThrow();
				},
			);
			expect(await readFile(secret, "utf8")).toBe("secret");
			expect((await lstat(path.join(workspace, "file"))).isSymbolicLink()).toBe(true);
			await expect(lstat(path.join(workspace, "deep", "file"))).rejects.toMatchObject({ code: "ENOENT" });
			expect(await readFile(path.join(workspace, "note.txt"), "utf8")).toBe("keep");
		},
	);

	it.skipIf(process.platform === "win32")(
		"rename_file does not delete an outside tree named by lexically collapsing hop/..",
		async () => {
			const root = await mkdtemp(path.join(tmpdir(), "lsp-hop-delete-"));
			const workspace = path.join(root, "ws");
			const deep = path.join(workspace, "deep", "dir");
			await mkdir(deep, { recursive: true });
			const outside = path.join(root, "outside");
			await mkdir(outside);
			const victim = path.join(outside, "x");
			await writeFile(victim, "secret");
			await writeFile(path.join(workspace, "note.txt"), "keep");
			await symlink(deep, path.join(workspace, "hop"));
			await symlink(outside, path.join(workspace, "alias4"));
			const via = `file://${workspace}/hop/../alias4/x`;
			expect(via.includes("/hop/../alias4/x")).toBe(true);
			await withRenameServer(workspace, { documentChanges: [{ kind: "delete", uri: via }] }, async tool => {
				await expect(
					tool.execute("rename-hop-delete", {
						action: "rename_file",
						file: path.join(workspace, "note.txt"),
						new_name: path.join(workspace, "note2.txt"),
						timeout: 5,
					}),
				).rejects.toThrow();
			});
			expect(await readFile(victim, "utf8")).toBe("secret");
			expect((await lstat(path.join(workspace, "alias4"))).isSymbolicLink()).toBe(true);
			expect(await readFile(path.join(workspace, "note.txt"), "utf8")).toBe("keep");
		},
	);
});

describe("applyWorkspaceEdit containment", () => {
	it("does not apply an earlier text edit when a later target leaves the workspace", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "lsp-ws-edit-"));
		const workspace = path.join(root, "repo");
		await mkdir(workspace);
		const inside = path.join(workspace, "a.ts");
		const outside = path.join(root, "secret.ts");
		await writeFile(inside, "alpha\n");
		await writeFile(outside, "secret\n");
		await expect(
			applyWorkspaceEdit(
				{
					changes: {
						[fileToUri(inside)]: [
							{
								range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
								newText: "betaX",
							},
						],
						[fileToUri(outside)]: [
							{
								range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } },
								newText: "pwnedX",
							},
						],
					},
				},
				workspace,
			),
		).rejects.toThrow(/escapes the workspace/);
		expect(await readFile(inside, "utf8")).toBe("alpha\n");
		expect(await readFile(outside, "utf8")).toBe("secret\n");
	});

	it("does not create an earlier file when a later delete leaves the workspace", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "lsp-ws-res-"));
		const workspace = path.join(root, "repo");
		await mkdir(workspace);
		const created = path.join(workspace, "created.ts");
		const outside = path.join(root, "secret.ts");
		await writeFile(outside, "secret\n");
		await expect(
			applyWorkspaceEdit(
				{
					documentChanges: [
						{ kind: "create", uri: fileToUri(created) },
						{ kind: "delete", uri: fileToUri(outside) },
					],
				},
				workspace,
			),
		).rejects.toThrow(/escapes the workspace/);
		await expect(lstat(created)).rejects.toMatchObject({ code: "ENOENT" });
		expect(await readFile(outside, "utf8")).toBe("secret\n");
	});

	it.skipIf(process.platform === "win32")(
		"does not create an earlier file when a later rename leaves the workspace",
		async () => {
			const root = await mkdtemp(path.join(tmpdir(), "lsp-ws-rename-"));
			const workspace = path.join(root, "repo");
			await mkdir(workspace);
			const created = path.join(workspace, "created.ts");
			const inside = path.join(workspace, "a.ts");
			await writeFile(inside, "ok");
			const outsideLink = path.join(root, "link.ts");
			await symlink(inside, outsideLink);
			await expect(
				applyWorkspaceEdit(
					{
						documentChanges: [
							{ kind: "create", uri: fileToUri(created) },
							{
								kind: "rename",
								oldUri: fileToUri(outsideLink),
								newUri: fileToUri(path.join(workspace, "moved.ts")),
							},
						],
					},
					workspace,
				),
			).rejects.toThrow(/escapes the workspace/);
			await expect(lstat(created)).rejects.toMatchObject({ code: "ENOENT" });
			expect((await lstat(outsideLink)).isSymbolicLink()).toBe(true);
			expect(await readFile(inside, "utf8")).toBe("ok");
		},
	);

	it("creates and renames inside the workspace after every target passes", async () => {
		const workspace = await mkdtemp(path.join(tmpdir(), "lsp-ws-rename-ok-"));
		const source = path.join(workspace, "a.ts");
		await writeFile(source, "ok");
		const dest = path.join(workspace, "nested", "b.ts");
		const created = path.join(workspace, "c.ts");
		const applied = await applyWorkspaceEdit(
			{
				documentChanges: [
					{ kind: "create", uri: fileToUri(created) },
					{ kind: "rename", oldUri: fileToUri(source), newUri: fileToUri(dest) },
				],
			},
			workspace,
		);
		expect(await readFile(created, "utf8")).toBe("");
		expect(await readFile(dest, "utf8")).toBe("ok");
		await expect(lstat(source)).rejects.toMatchObject({ code: "ENOENT" });
		expect(applied).toHaveLength(2);
	});

	it("applies every in-workspace text edit after all targets pass", async () => {
		const workspace = await mkdtemp(path.join(tmpdir(), "lsp-ws-ok-"));
		const first = path.join(workspace, "a.ts");
		const second = path.join(workspace, "b.ts");
		await writeFile(first, "alpha\n");
		await writeFile(second, "gamma\n");
		const applied = await applyWorkspaceEdit(
			{
				changes: {
					[fileToUri(first)]: [
						{
							range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
							newText: "betaX",
						},
					],
					[fileToUri(second)]: [
						{
							range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
							newText: "delta",
						},
					],
				},
			},
			workspace,
		);
		expect(await readFile(first, "utf8")).toBe("betaX\n");
		expect(await readFile(second, "utf8")).toBe("delta\n");
		expect(applied).toHaveLength(2);
	});

	it("applies both edits when two URI spellings name the same file", async () => {
		const workspace = await mkdtemp(path.join(tmpdir(), "lsp-alias-"));
		const file = path.join(workspace, "a.ts");
		await writeFile(file, "ab\n");
		const plain = fileToUri(file);
		const encoded = plain.replace(/a\.ts$/, "%61.ts");
		expect(encoded).not.toBe(plain);
		const applied = await applyWorkspaceEdit(
			{
				changes: {
					[plain]: [
						{
							range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
							newText: "A",
						},
					],
					[encoded]: [
						{
							range: { start: { line: 0, character: 1 }, end: { line: 0, character: 2 } },
							newText: "B",
						},
					],
				},
			},
			workspace,
		);
		expect(await readFile(file, "utf8")).toBe("AB\n");
		expect(applied).toHaveLength(1);
	});

	it.skipIf(process.platform === "win32")(
		"does not follow a relative symlink that an earlier rename points outside",
		async () => {
			const root = await mkdtemp(path.join(tmpdir(), "lsp-relink-"));
			const workspace = path.join(root, "ws");
			const outside = path.join(root, "safe");
			await mkdir(path.join(workspace, "deep"), { recursive: true });
			await mkdir(path.join(workspace, "safe"), { recursive: true });
			await mkdir(outside);
			await symlink("../safe", path.join(workspace, "deep", "link"));
			const link = path.join(workspace, "deep", "link");
			const moved = path.join(workspace, "link");
			await expect(
				applyWorkspaceEdit(
					{
						documentChanges: [
							{ kind: "rename", oldUri: fileToUri(link), newUri: fileToUri(moved) },
							{ kind: "create", uri: fileToUri(path.join(moved, "new.txt")) },
						],
					},
					workspace,
				),
			).rejects.toThrow(/escapes the workspace/);
			expect((await lstat(link)).isSymbolicLink()).toBe(true);
			await expect(lstat(moved)).rejects.toMatchObject({ code: "ENOENT" });
			await expect(lstat(path.join(outside, "new.txt"))).rejects.toMatchObject({ code: "ENOENT" });
		},
	);

	it.skipIf(process.platform === "win32")(
		"does not follow a relative symlink inside a directory renamed by the same edit",
		async () => {
			const root = await mkdtemp(path.join(tmpdir(), "lsp-nested-link-"));
			const workspace = path.join(root, "ws");
			const outside = path.join(root, "data");
			await mkdir(path.join(workspace, "a", "deep"), { recursive: true });
			await mkdir(path.join(workspace, "data"), { recursive: true });
			await mkdir(outside);
			const sourceDir = path.join(workspace, "a", "deep");
			await symlink("../../data", path.join(sourceDir, "inner"));
			const destDir = path.join(workspace, "deep");
			await expect(
				applyWorkspaceEdit(
					{
						documentChanges: [
							{ kind: "rename", oldUri: fileToUri(sourceDir), newUri: fileToUri(destDir) },
							{ kind: "create", uri: fileToUri(path.join(destDir, "inner", "new.txt")) },
						],
					},
					workspace,
				),
			).rejects.toThrow(/escapes the workspace/);
			expect((await lstat(path.join(sourceDir, "inner"))).isSymbolicLink()).toBe(true);
			await expect(lstat(destDir)).rejects.toMatchObject({ code: "ENOENT" });
			await expect(lstat(path.join(outside, "new.txt"))).rejects.toMatchObject({ code: "ENOENT" });
		},
	);

	it.skipIf(process.platform === "win32")(
		"writes through a relative symlink when the rename keeps the target inside",
		async () => {
			const workspace = await mkdtemp(path.join(tmpdir(), "lsp-relink-ok-"));
			await mkdir(path.join(workspace, "sub"));
			await mkdir(path.join(workspace, "data"));
			const link = path.join(workspace, "sub", "link");
			await symlink("../data", link);
			const moved = path.join(workspace, "sub2", "link");
			await applyWorkspaceEdit(
				{
					documentChanges: [
						{ kind: "rename", oldUri: fileToUri(link), newUri: fileToUri(moved) },
						{ kind: "create", uri: fileToUri(path.join(moved, "new.txt")) },
					],
				},
				workspace,
			);
			expect(await readFile(path.join(workspace, "data", "new.txt"), "utf8")).toBe("");
			expect((await lstat(moved)).isSymbolicLink()).toBe(true);
			await expect(lstat(link)).rejects.toMatchObject({ code: "ENOENT" });
		},
	);

	it.skipIf(process.platform === "win32")(
		"refuses a relative hop/.. rename source from applyWorkspaceEdit",
		async () => {
			const root = await mkdtemp(path.join(tmpdir(), "lsp-rel-hop-"));
			const workspace = path.join(root, "ws");
			const outside = path.join(root, "outside");
			await mkdir(path.join(outside, "subdir"), { recursive: true });
			await mkdir(workspace);
			const inside = path.join(workspace, "a.ts");
			await writeFile(inside, "ok");
			const outsideLink = path.join(outside, "link.ts");
			await symlink(inside, outsideLink);
			await symlink(path.join(outside, "subdir"), path.join(workspace, "hop"));
			await expect(
				applyWorkspaceEdit(
					{
						documentChanges: [
							{
								kind: "rename",
								oldUri: `hop${path.sep}..${path.sep}link.ts`,
								newUri: "new.ts",
							},
						],
					},
					workspace,
				),
			).rejects.toThrow(/escapes the workspace/);
			expect((await lstat(outsideLink)).isSymbolicLink()).toBe(true);
			await expect(lstat(path.join(workspace, "new.ts"))).rejects.toMatchObject({ code: "ENOENT" });
		},
	);
});
