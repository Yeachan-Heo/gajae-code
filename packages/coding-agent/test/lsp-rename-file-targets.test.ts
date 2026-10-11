import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import { LspTool } from "@gajae-code/coding-agent/lsp";
import * as lspClient from "@gajae-code/coding-agent/lsp/client";
import * as lspConfig from "@gajae-code/coding-agent/lsp/config";
import type { LspClient, ServerConfig } from "@gajae-code/coding-agent/lsp/types";
import { fileToUri } from "@gajae-code/coding-agent/lsp/utils";
import type { ToolSession } from "@gajae-code/coding-agent/tools";
import { ToolAbortError } from "@gajae-code/coding-agent/tools/tool-errors";
import { TempDir } from "@gajae-code/utils";

const textEdit = (newText: string) => ({
	range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
	newText,
});

function fakeClient(cwd: string): LspClient {
	const server: ServerConfig = { command: "test-lsp", fileTypes: ["ts"], rootMarkers: [] };
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

function mockDriveRealpath(mapped: Record<string, string>): void {
	const realpath = fsPromises.realpath;
	vi.spyOn(fsPromises, "realpath").mockImplementation((async (target: string) => {
		const text = String(target);
		if (Object.hasOwn(mapped, text)) return mapped[text];
		return realpath(target);
	}) as typeof realpath);
}

function mockEmptyConfig(): void {
	vi.spyOn(lspConfig, "loadConfig").mockReturnValue({ servers: {}, idleTimeoutMs: undefined });
}

function mockServer(cwd: string, respond: () => unknown): void {
	const server: ServerConfig = { command: "test-lsp", fileTypes: ["ts"], rootMarkers: [] };
	vi.spyOn(lspConfig, "loadConfig").mockReturnValue({
		servers: { "test-lsp": server },
		idleTimeoutMs: undefined,
	});
	vi.spyOn(lspClient, "getOrCreateClient").mockResolvedValue(fakeClient(cwd));
	vi.spyOn(lspClient, "sendRequest").mockImplementation(async () => respond());
	vi.spyOn(lspClient, "sendNotification").mockResolvedValue(undefined);
}

describe("rename_file target checks", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("still moves a file into a new directory inside the workspace", async () => {
		const tempDir = TempDir.createSync("@gjc-lsp-rename-allow-");
		try {
			const cwd = path.join(tempDir.path(), "repo");
			const source = path.join(cwd, "old.ts");
			const dest = path.join(cwd, "fresh", "moved.ts");
			await Bun.write(source, "export const value = 1;\n");
			mockEmptyConfig();

			const tool = new LspTool({ cwd } as ToolSession);
			const result = await tool.execute("rename-allow", {
				action: "rename_file",
				file: source,
				new_name: dest,
				timeout: 5,
			});

			expect(fs.existsSync(source)).toBe(false);
			expect(await Bun.file(dest).text()).toBe("export const value = 1;\n");
			const output = result.content.map(block => (block.type === "text" ? block.text : "")).join("\n");
			expect(output).toContain("Renamed");
		} finally {
			tempDir.removeSync();
		}
	});

	it.skipIf(process.platform === "win32")(
		"still renames a normal file when the workspace is the filesystem root",
		async () => {
			const tempDir = TempDir.createSync("@gjc-lsp-rename-root-");
			try {
				const source = path.join(tempDir.path(), "old.ts");
				const dest = path.join(tempDir.path(), "fresh", "moved.ts");
				await Bun.write(source, "export const value = 1;\n");
				mockEmptyConfig();

				const tool = new LspTool({ cwd: "/" } as ToolSession);
				const result = await tool.execute("rename-root", {
					action: "rename_file",
					file: source,
					new_name: dest,
					timeout: 5,
				});

				expect(fs.existsSync(source)).toBe(false);
				expect(await Bun.file(dest).text()).toBe("export const value = 1;\n");
				const output = result.content.map(block => (block.type === "text" ? block.text : "")).join("\n");
				expect(output).toContain("Renamed");
			} finally {
				tempDir.removeSync();
			}
		},
	);

	it("still previews an outside destination without writing", async () => {
		const tempDir = TempDir.createSync("@gjc-lsp-rename-preview-");
		try {
			const cwd = path.join(tempDir.path(), "repo");
			const source = path.join(cwd, "old.ts");
			const dest = path.join(tempDir.path(), "outside.ts");
			await Bun.write(source, "export const value = 1;\n");
			mockEmptyConfig();

			const tool = new LspTool({ cwd } as ToolSession);
			const result = await tool.execute("rename-preview", {
				action: "rename_file",
				file: source,
				new_name: dest,
				apply: false,
				timeout: 5,
			});

			expect(fs.existsSync(source)).toBe(true);
			expect(fs.existsSync(dest)).toBe(false);
			const output = result.content.map(block => (block.type === "text" ? block.text : "")).join("\n");
			expect(output).toContain("Rename preview");
		} finally {
			tempDir.removeSync();
		}
	});

	it("refuses an outside destination before creating it", async () => {
		const tempDir = TempDir.createSync("@gjc-lsp-rename-outside-");
		try {
			const cwd = path.join(tempDir.path(), "repo");
			const source = path.join(cwd, "old.ts");
			const outsideDir = path.join(tempDir.path(), "missing-outside");
			const dest = path.join(outsideDir, "moved.ts");
			await Bun.write(source, "export const value = 1;\n");
			mockEmptyConfig();

			const tool = new LspTool({ cwd } as ToolSession);
			await expect(
				tool.execute("rename-outside", {
					action: "rename_file",
					file: source,
					new_name: dest,
					timeout: 5,
				}),
			).rejects.toThrow(/LSP edit escapes the workspace/);

			expect(fs.existsSync(source)).toBe(true);
			expect(fs.existsSync(outsideDir)).toBe(false);
			expect(await Bun.file(source).text()).toBe("export const value = 1;\n");
		} finally {
			tempDir.removeSync();
		}
	});

	it("does not apply an earlier willRenameFiles edit when a later target leaves the workspace", async () => {
		const tempDir = TempDir.createSync("@gjc-lsp-rename-partial-");
		try {
			const cwd = path.join(tempDir.path(), "repo");
			const source = path.join(cwd, "old.ts");
			const dest = path.join(cwd, "new.ts");
			const inside = path.join(cwd, "consumer.ts");
			const outside = path.join(tempDir.path(), "outside.ts");
			const insideText = "export const inside = 1;\n";
			const outsideText = "export const outside = 1;\n";
			await Bun.write(source, "export const value = 1;\n");
			await Bun.write(inside, insideText);
			await Bun.write(outside, outsideText);
			mockServer(cwd, () => ({
				changes: {
					[fileToUri(inside)]: [textEdit("MUTATED")],
					[fileToUri(outside)]: [textEdit("LEAKED")],
				},
			}));

			const tool = new LspTool({ cwd } as ToolSession);
			await expect(
				tool.execute("rename-partial", {
					action: "rename_file",
					file: source,
					new_name: dest,
					timeout: 5,
				}),
			).rejects.toThrow(/LSP edit escapes the workspace/);

			expect(fs.existsSync(source)).toBe(true);
			expect(fs.existsSync(dest)).toBe(false);
			expect(await Bun.file(inside).text()).toBe(insideText);
			expect(await Bun.file(outside).text()).toBe(outsideText);
			expect(lspClient.sendNotification).not.toHaveBeenCalled();
		} finally {
			tempDir.removeSync();
		}
	});

	it.skipIf(process.platform === "win32")(
		"refuses a destination under a symlink that leaves the workspace",
		async () => {
			const tempDir = TempDir.createSync("@gjc-lsp-rename-link-");
			try {
				const cwd = path.join(tempDir.path(), "repo");
				const source = path.join(cwd, "old.ts");
				const outside = path.join(tempDir.path(), "outside");
				await Bun.write(source, "export const value = 1;\n");
				await fsPromises.mkdir(outside);
				await fsPromises.symlink(outside, path.join(cwd, "link"));
				const dest = path.join(cwd, "link", "moved.ts");
				mockEmptyConfig();

				const tool = new LspTool({ cwd } as ToolSession);
				await expect(
					tool.execute("rename-link", {
						action: "rename_file",
						file: source,
						new_name: dest,
						timeout: 5,
					}),
				).rejects.toThrow(/LSP edit escapes the workspace/);

				expect(fs.existsSync(source)).toBe(true);
				expect(fs.existsSync(path.join(outside, "moved.ts"))).toBe(false);
			} finally {
				tempDir.removeSync();
			}
		},
	);

	it.skipIf(process.platform === "win32")(
		"refuses a source symlink whose real file is outside the workspace",
		async () => {
			const tempDir = TempDir.createSync("@gjc-lsp-rename-source-link-");
			try {
				const cwd = path.join(tempDir.path(), "repo");
				const outside = path.join(tempDir.path(), "secret.ts");
				const source = path.join(cwd, "alias.ts");
				const dest = path.join(cwd, "renamed.ts");
				await Bun.write(outside, "export const secret = 1;\n");
				await fsPromises.mkdir(cwd, { recursive: true });
				await fsPromises.symlink(outside, source);
				mockEmptyConfig();

				const tool = new LspTool({ cwd } as ToolSession);
				await expect(
					tool.execute("rename-source-link", {
						action: "rename_file",
						file: source,
						new_name: dest,
						timeout: 5,
					}),
				).rejects.toThrow(/LSP edit escapes the workspace/);

				expect(fs.existsSync(source)).toBe(true);
				expect(fs.existsSync(dest)).toBe(false);
				expect(await Bun.file(outside).text()).toBe("export const secret = 1;\n");
			} finally {
				tempDir.removeSync();
			}
		},
	);

	it("does not write when the caller aborts during the last target check", async () => {
		const tempDir = TempDir.createSync("@gjc-lsp-rename-abort-");
		try {
			const cwd = path.join(tempDir.path(), "repo");
			const source = path.join(cwd, "old.ts");
			const dest = path.join(cwd, "fresh", "moved.ts");
			const inside = path.join(cwd, "consumer.ts");
			const insideText = "export const inside = 1;\n";
			await Bun.write(source, "export const value = 1;\n");
			await Bun.write(inside, insideText);
			const controller = new AbortController();
			const realpath = fsPromises.realpath;
			let armed = false;
			vi.spyOn(fsPromises, "realpath").mockImplementation((async (target: string) => {
				const resolved = await realpath(target);
				if (!armed && typeof resolved === "string" && resolved.endsWith(`${path.sep}consumer.ts`)) {
					armed = true;
					controller.abort();
				}
				return resolved;
			}) as typeof realpath);
			mockServer(cwd, () => ({
				changes: { [fileToUri(inside)]: [textEdit("MUTATED")] },
			}));

			const tool = new LspTool({ cwd } as ToolSession);
			await expect(
				tool.execute(
					"rename-abort",
					{ action: "rename_file", file: source, new_name: dest, timeout: 5 },
					controller.signal,
				),
			).rejects.toBeInstanceOf(ToolAbortError);

			expect(fs.existsSync(source)).toBe(true);
			expect(fs.existsSync(dest)).toBe(false);
			expect(await Bun.file(inside).text()).toBe(insideText);
		} finally {
			tempDir.removeSync();
		}
	});

	it("still allows a same-volume path when the workspace is a Windows drive root", async () => {
		const tempDir = TempDir.createSync("@gjc-lsp-rename-drive-allow-");
		try {
			const cwd = path.join(tempDir.path(), "repo");
			const source = path.join(cwd, "old.ts");
			const dest = path.join(cwd, "fresh", "moved.ts");
			await Bun.write(source, "export const value = 1;\n");
			mockEmptyConfig();
			mockDriveRealpath({
				[cwd]: "C:\\",
				[source]: "C:\\repo\\old.ts",
				[dest]: "C:\\repo\\fresh\\moved.ts",
			});

			const tool = new LspTool({ cwd } as ToolSession);
			const result = await tool.execute("rename-drive-allow", {
				action: "rename_file",
				file: source,
				new_name: dest,
				timeout: 5,
			});

			expect(fs.existsSync(source)).toBe(false);
			expect(await Bun.file(dest).text()).toBe("export const value = 1;\n");
			const output = result.content.map(block => (block.type === "text" ? block.text : "")).join("\n");
			expect(output).toContain("Renamed");
		} finally {
			tempDir.removeSync();
		}
	});

	it("refuses a willRenameFiles edit on another drive when the workspace is a Windows drive root", async () => {
		const tempDir = TempDir.createSync("@gjc-lsp-rename-drive-deny-");
		try {
			const cwd = path.join(tempDir.path(), "repo");
			const source = path.join(cwd, "old.ts");
			const dest = path.join(cwd, "new.ts");
			const outside = path.join(tempDir.path(), "outside.ts");
			const outsideText = "export const outside = 1;\n";
			await Bun.write(source, "export const value = 1;\n");
			await Bun.write(outside, outsideText);
			mockDriveRealpath({
				[cwd]: "C:\\",
				[source]: "C:\\repo\\old.ts",
				[dest]: "C:\\repo\\new.ts",
				[outside]: "D:\\outside.ts",
			});
			mockServer(cwd, () => ({
				changes: { [fileToUri(outside)]: [textEdit("LEAKED")] },
			}));

			const tool = new LspTool({ cwd } as ToolSession);
			await expect(
				tool.execute("rename-drive-deny", {
					action: "rename_file",
					file: source,
					new_name: dest,
					timeout: 5,
				}),
			).rejects.toThrow(/LSP edit escapes the workspace:.*outside\.ts/);

			expect(fs.existsSync(source)).toBe(true);
			expect(fs.existsSync(dest)).toBe(false);
			expect(await Bun.file(outside).text()).toBe(outsideText);
			expect(lspClient.sendNotification).not.toHaveBeenCalled();
		} finally {
			tempDir.removeSync();
		}
	});

	it("refuses a willRenameFiles edit on a UNC share when the workspace is a Windows drive root", async () => {
		const tempDir = TempDir.createSync("@gjc-lsp-rename-share-deny-");
		try {
			const cwd = path.join(tempDir.path(), "repo");
			const source = path.join(cwd, "old.ts");
			const dest = path.join(cwd, "new.ts");
			const outside = path.join(tempDir.path(), "share.ts");
			const outsideText = "export const share = 1;\n";
			await Bun.write(source, "export const value = 1;\n");
			await Bun.write(outside, outsideText);
			mockDriveRealpath({
				[cwd]: "C:\\",
				[source]: "C:\\repo\\old.ts",
				[dest]: "C:\\repo\\new.ts",
				[outside]: "\\\\server\\share\\share.ts",
			});
			mockServer(cwd, () => ({
				changes: { [fileToUri(outside)]: [textEdit("LEAKED")] },
			}));

			const tool = new LspTool({ cwd } as ToolSession);
			await expect(
				tool.execute("rename-share-deny", {
					action: "rename_file",
					file: source,
					new_name: dest,
					timeout: 5,
				}),
			).rejects.toThrow(/LSP edit escapes the workspace:.*share\.ts/);

			expect(fs.existsSync(source)).toBe(true);
			expect(fs.existsSync(dest)).toBe(false);
			expect(await Bun.file(outside).text()).toBe(outsideText);
			expect(lspClient.sendNotification).not.toHaveBeenCalled();
		} finally {
			tempDir.removeSync();
		}
	});
});
