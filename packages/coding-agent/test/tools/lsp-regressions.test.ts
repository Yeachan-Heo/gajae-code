import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { RenderResultOptions } from "@gajae-code/agent-core";
import { LspTool } from "@gajae-code/coding-agent/lsp";
import * as lspClient from "@gajae-code/coding-agent/lsp/client";
import * as lspConfig from "@gajae-code/coding-agent/lsp/config";
import { getServersForFile, loadConfig } from "@gajae-code/coding-agent/lsp/config";
import { renderCall, renderResult } from "@gajae-code/coding-agent/lsp/render";
import type {
	CodeAction,
	Diagnostic,
	LspClient,
	ServerConfig,
	SymbolInformation,
} from "@gajae-code/coding-agent/lsp/types";
import {
	applyCodeAction,
	collectGlobMatches,
	dedupeWorkspaceSymbols,
	detectLanguageId,
	fileToUri,
	filterWorkspaceSymbols,
	hasGlobPattern,
	resolveDiagnosticTargets,
	resolveSymbolColumn,
} from "@gajae-code/coding-agent/lsp/utils";
import { getThemeByName } from "@gajae-code/coding-agent/modes/theme/theme";
import type { ToolSession } from "@gajae-code/coding-agent/tools";
import { clampTimeout } from "@gajae-code/coding-agent/tools/tool-timeouts";
import * as piUtils from "@gajae-code/utils";
import { sanitizeText, TempDir } from "@gajae-code/utils";

describe("lsp regressions", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("detects bracket-style glob patterns", () => {
		expect(hasGlobPattern("src/[ab].ts")).toBe(true);
		expect(hasGlobPattern("src/**/*.ts")).toBe(true);
		expect(hasGlobPattern("src/main.ts")).toBe(false);
	});

	it("clamps LSP timeout to configured bounds", () => {
		expect(clampTimeout("lsp")).toBe(20);
		expect(clampTimeout("lsp", 1)).toBe(5);
		expect(clampTimeout("lsp", 1000)).toBe(60);
	});

	it("limits glob collection to avoid large diagnostic stalls", async () => {
		const tempDir = TempDir.createSync("@gjc-lsp-glob-");
		try {
			await Promise.all([
				Bun.write(`${tempDir.path()}/a.ts`, "export const a = 1;\n"),
				Bun.write(`${tempDir.path()}/b.ts`, "export const b = 1;\n"),
				Bun.write(`${tempDir.path()}/c.ts`, "export const c = 1;\n"),
			]);
			const result = await collectGlobMatches("*.ts", tempDir.path(), 2);
			expect(result.matches).toHaveLength(2);
			expect(result.truncated).toBe(true);
		} finally {
			tempDir.removeSync();
		}
	});

	it("treats existing bracket paths as literal diagnostic targets", async () => {
		const tempDir = TempDir.createSync("@gjc-lsp-bracket-path-");
		try {
			const filePath = `${tempDir.path()}/apps/frontend/src/app/runs/[runId]/public/opengraph-image.tsx`;
			await Bun.write(filePath, "export default function OpenGraphImage() {}\n");

			const result = await resolveDiagnosticTargets(
				"apps/frontend/src/app/runs/[runId]/public/opengraph-image.tsx",
				tempDir.path(),
				10,
			);

			expect(result).toEqual({
				matches: ["apps/frontend/src/app/runs/[runId]/public/opengraph-image.tsx"],
				truncated: false,
			});
		} finally {
			tempDir.removeSync();
		}
	});

	it("resolves the requested symbol occurrence on a line", async () => {
		const tempDir = TempDir.createSync("@gjc-lsp-regression-");
		try {
			const filePath = `${tempDir.path()}/symbol.ts`;
			await Bun.write(filePath, "foo(bar(foo));\n");

			expect(await resolveSymbolColumn(filePath, 1, "foo")).toBe(0);
			expect(await resolveSymbolColumn(filePath, 1, "foo#2")).toBe(8);
		} finally {
			tempDir.removeSync();
		}
	});

	it("throws when symbol does not exist on the target line", async () => {
		const tempDir = TempDir.createSync("@gjc-lsp-missing-symbol-");
		try {
			const filePath = `${tempDir.path()}/symbol.ts`;
			await Bun.write(filePath, "winston.info('x');\n");

			await expect(resolveSymbolColumn(filePath, 1, "nonexistent_symbol")).rejects.toThrow(
				'Symbol "nonexistent_symbol" not found on line 1',
			);
		} finally {
			tempDir.removeSync();
		}
	});

	it("throws when occurrence is out of bounds", async () => {
		const tempDir = TempDir.createSync("@gjc-lsp-occurrence-");
		try {
			const filePath = `${tempDir.path()}/symbol.ts`;
			await Bun.write(filePath, "foo();\n");

			await expect(resolveSymbolColumn(filePath, 1, "foo#2")).rejects.toThrow(
				'Symbol "foo" occurrence 2 is out of bounds on line 1 (found 1)',
			);
		} finally {
			tempDir.removeSync();
		}
	});

	it("filters and deduplicates workspace symbols by query", () => {
		const symbols: SymbolInformation[] = [
			{
				name: "DisallowOverwritingRegularFilesViaOutputRedirection",
				kind: 12,
				location: {
					uri: "file:///tmp/rust.rs",
					range: {
						start: { line: 10, character: 2 },
						end: { line: 10, character: 60 },
					},
				},
			},
			{
				name: "logger",
				kind: 13,
				location: {
					uri: "file:///tmp/logger.ts",
					range: {
						start: { line: 5, character: 1 },
						end: { line: 5, character: 7 },
					},
				},
			},
			{
				name: "logger",
				kind: 13,
				location: {
					uri: "file:///tmp/logger.ts",
					range: {
						start: { line: 5, character: 1 },
						end: { line: 5, character: 7 },
					},
				},
			},
		];

		const filtered = filterWorkspaceSymbols(symbols, "logger");
		const unique = dedupeWorkspaceSymbols(filtered);

		expect(filtered).toHaveLength(2);
		expect(unique).toHaveLength(1);
		expect(unique[0]?.name).toBe("logger");
	});

	it("applies command-only code actions by executing workspace commands", async () => {
		const executedCommands: string[] = [];
		const result = await applyCodeAction(
			{ title: "Organize Imports", command: "source.organizeImports" },
			{
				applyWorkspaceEdit: async () => [],
				executeCommand: async command => {
					executedCommands.push(command.command);
				},
			},
		);

		expect(executedCommands).toEqual(["source.organizeImports"]);
		expect(result).toEqual({
			title: "Organize Imports",
			edits: [],
			executedCommands: ["source.organizeImports"],
		});
	});

	it("resolves code actions before applying edits", async () => {
		const unresolvedAction: CodeAction = { title: "Add import" };
		const appliedEdits: string[] = [];
		const result = await applyCodeAction(unresolvedAction, {
			resolveCodeAction: async action => ({
				...action,
				edit: {
					changes: {
						"file:///tmp/example.ts": [
							{
								range: {
									start: { line: 0, character: 0 },
									end: { line: 0, character: 0 },
								},
								newText: "import x from 'y';\n",
							},
						],
					},
				},
			}),
			applyWorkspaceEdit: async () => {
				appliedEdits.push("example.ts: 1 edit");
				return ["example.ts: 1 edit"];
			},
			executeCommand: async () => {},
		});

		expect(appliedEdits).toEqual(["example.ts: 1 edit"]);
		expect(result).toEqual({
			title: "Add import",
			edits: ["example.ts: 1 edit"],
			executedCommands: [],
		});
	});

	it("sanitizes symbol metadata in renderer output", async () => {
		const theme = await getThemeByName("red-claw");
		expect(theme).toBeDefined();
		const uiTheme = theme!;
		const renderOptions: RenderResultOptions = { expanded: false, isPartial: false };

		const call = renderCall(
			{ action: "definition", file: "src/example.ts", line: 10, symbol: "foo\tbar\nbaz" },
			renderOptions,
			uiTheme,
		);
		const callText = sanitizeText(call.render(120).join("\n"));
		const normalizedCallText = callText.replace(/\s+/g, " ");
		expect(normalizedCallText).toContain("foo bar baz");
		expect(callText).not.toContain("\t");
		const result = renderResult(
			{
				content: [{ type: "text", text: "No definition found" }],
				details: {
					action: "definition",
					success: true,
					request: {
						action: "definition",
						file: "src/example.ts",
						line: 10,
						symbol: "foo\tbar\nbaz",
					},
				},
			},
			renderOptions,
			uiTheme,
		);
		const resultText = sanitizeText(result.render(120).join("\n"));
		const normalizedResultText = resultText.replace(/\s+/g, " ");
		expect(normalizedResultText).toContain("symbol: foo bar baz");
		expect(resultText).not.toContain("\t");
	});

	it("sanitizes tabs in rendered diagnostic output", async () => {
		const theme = await getThemeByName("red-claw");
		expect(theme).toBeDefined();
		const uiTheme = theme!;
		const renderOptions: RenderResultOptions = { expanded: false, isPartial: false };

		const result = renderResult(
			{
				content: [
					{
						type: "text",
						text: "Diagnostics: 1 error(s)\nsrc/example.go:183:41 [error] [compiler] too many\targuments in call (WrongArgCount)",
					},
				],
			},
			renderOptions,
			uiTheme,
		);

		const resultText = sanitizeText(result.render(120).join("\n"));
		expect(resultText).not.toContain("\t");
		expect(resultText.replace(/\s+/g, " ")).toContain("too many arguments in call");
	});

	it("does not reuse stale file diagnostics after another URI publishes", async () => {
		const tempDir = TempDir.createSync("@gjc-lsp-stale-diags-");
		try {
			const targetFile = path.join(tempDir.path(), "target.ts");
			const otherFile = path.join(tempDir.path(), "other.ts");
			await Bun.write(targetFile, "export const target = 1;\n");
			await Bun.write(otherFile, "export const other = 1;\n");

			const targetUri = fileToUri(targetFile);
			const otherUri = fileToUri(otherFile);
			const server: ServerConfig = { command: "test-lsp", fileTypes: ["ts"], rootMarkers: [] };
			const staleDiagnostic: Diagnostic = {
				message: "stale target error",
				severity: 1,
				range: {
					start: { line: 0, character: 0 },
					end: { line: 0, character: 1 },
				},
			};
			const otherDiagnostic: Diagnostic = {
				message: "other file warning",
				severity: 2,
				range: {
					start: { line: 0, character: 0 },
					end: { line: 0, character: 1 },
				},
			};
			const client: LspClient = {
				name: "test-lsp",
				cwd: tempDir.path(),
				config: server,
				proc: {
					stdin: {
						write() {},
						flush: async () => {},
					},
				} as unknown as LspClient["proc"],
				requestId: 0,
				diagnostics: new Map([[targetUri, { diagnostics: [staleDiagnostic], version: null }]]),
				diagnosticsVersion: 1,
				openFiles: new Map([[targetUri, { version: 1, languageId: "typescript" }]]),
				pendingRequests: new Map(),
				messageBuffer: new Uint8Array(),
				isReading: false,
				lastActivity: Date.now(),
				writeQueue: Promise.resolve(),
				activeProgressTokens: new Set(),
				projectLoaded: Promise.resolve(),
				resolveProjectLoaded: () => {},
			};

			vi.spyOn(lspConfig, "loadConfig").mockReturnValue({ servers: {}, idleTimeoutMs: undefined });
			vi.spyOn(lspConfig, "getServersForFile").mockReturnValue([["test-lsp", server]]);
			vi.spyOn(lspClient, "getOrCreateClient").mockResolvedValue(client);

			setTimeout(() => {
				client.diagnostics.set(otherUri, { diagnostics: [otherDiagnostic], version: 1 });
				client.diagnosticsVersion += 1;
			}, 20);
			setTimeout(() => {
				client.diagnostics.set(targetUri, {
					diagnostics: [],
					version: client.openFiles.get(targetUri)?.version ?? 2,
				});
				client.diagnosticsVersion += 1;
			}, 80);

			const tool = new LspTool({ cwd: tempDir.path() } as ToolSession);
			const result = await tool.execute("diag-stale", {
				action: "diagnostics",
				file: targetFile,
				timeout: 5,
			});
			const output = result.content
				.filter(block => block.type === "text")
				.map(block => block.text)
				.join("\n");

			expect(output).toBe("OK");
		} finally {
			vi.restoreAllMocks();
			tempDir.removeSync();
		}
	});

	it("detects Windows local .exe LSP shims in node_modules/.bin", async () => {
		if (process.platform !== "win32") {
			return;
		}

		const tempDir = TempDir.createSync("@gjc-lsp-win32-bin-");
		const whichSpy = vi.spyOn(Bun, "which").mockReturnValue(null);

		try {
			await Bun.write(path.join(tempDir.path(), "package.json"), "{}");
			const binDir = path.join(tempDir.path(), "node_modules", ".bin");
			await fs.promises.mkdir(binDir, { recursive: true });
			const localTsServer = path.join(binDir, "typescript-language-server.exe");
			await Bun.write(localTsServer, "");

			const config = loadConfig(tempDir.path());
			expect(config.servers["typescript-language-server"]?.resolvedCommand).toBe(localTsServer);
			expect(whichSpy).not.toHaveBeenCalledWith("typescript-language-server");
		} finally {
			vi.restoreAllMocks();
			tempDir.removeSync();
		}
	});

	it("detects tlaplus files for LSP startup and language ids", async () => {
		const tempDir = TempDir.createSync("@gjc-lsp-tlaplus-");
		const specPath = path.join(tempDir.path(), "Spec.tla");
		const aliasPath = path.join(tempDir.path(), "Spec.tlaplus");

		await Bun.write(specPath, "---- MODULE Spec ----\n====\n");

		const whichSpy = vi
			.spyOn(piUtils, "$which")
			.mockImplementation(command => (command === "tlapm_lsp" ? "/usr/local/bin/tlapm_lsp" : null));
		const existsSpy = vi
			.spyOn(fs, "existsSync")
			.mockImplementation(candidate => typeof candidate === "string" && candidate === specPath);

		try {
			const config = loadConfig(tempDir.path());
			expect(getServersForFile(config, specPath).map(([name]) => name)).toEqual(["tlaplus"]);
			expect(whichSpy).toHaveBeenCalledWith("tlapm_lsp");
			expect(existsSpy).toHaveBeenCalled();
			expect(detectLanguageId(specPath)).toBe("tlaplus");
			expect(detectLanguageId(aliasPath)).toBe("tlaplus");
		} finally {
			tempDir.removeSync();
		}
	});

	it("detects csharp-ls as the preferred C# LSP when installed", async () => {
		const tempDir = TempDir.createSync("@gjc-lsp-csharp-ls-");
		const cwd = path.join(tempDir.path(), "repo");
		try {
			await fs.promises.mkdir(cwd, { recursive: true });
			await Bun.write(path.join(cwd, "Example.csproj"), "<Project />\n");

			const whichSpy = vi.spyOn(piUtils, "$which").mockImplementation(command => {
				if (command === "csharp-ls") return "/usr/local/bin/csharp-ls";
				if (command === "omnisharp") return "/usr/local/bin/omnisharp";
				return null;
			});

			const config = loadConfig(cwd);

			expect(config.servers["csharp-ls"]?.resolvedCommand).toBe("/usr/local/bin/csharp-ls");
			expect(config.servers.omnisharp).toBeUndefined();
			expect(getServersForFile(config, path.join(cwd, "Program.cs")).map(([name]) => name)).toEqual(["csharp-ls"]);
			expect(whichSpy).toHaveBeenCalledWith("csharp-ls");
			expect(whichSpy).toHaveBeenCalledWith("omnisharp");
		} finally {
			tempDir.removeSync();
		}
	});

	it("keeps omnisharp as the C# fallback when csharp-ls is unavailable", async () => {
		const tempDir = TempDir.createSync("@gjc-lsp-omnisharp-fallback-");
		const cwd = path.join(tempDir.path(), "repo");
		try {
			await fs.promises.mkdir(cwd, { recursive: true });
			await Bun.write(path.join(cwd, "Example.csproj"), "<Project />\n");

			vi.spyOn(piUtils, "$which").mockImplementation(command =>
				command === "omnisharp" ? "/usr/local/bin/omnisharp" : null,
			);

			const config = loadConfig(cwd);

			expect(config.servers["csharp-ls"]).toBeUndefined();
			expect(config.servers.omnisharp?.resolvedCommand).toBe("/usr/local/bin/omnisharp");
			expect(getServersForFile(config, path.join(cwd, "Program.cs")).map(([name]) => name)).toEqual(["omnisharp"]);
		} finally {
			tempDir.removeSync();
		}
	});
	it("rename_file applies LSP willRenameFiles edits and renames the file", async () => {
		const tempDir = TempDir.createSync("@gjc-lsp-rename-file-");
		try {
			const sourceFile = path.join(tempDir.path(), "src", "old.ts");
			const destFile = path.join(tempDir.path(), "src", "new.ts");
			const referencingFile = path.join(tempDir.path(), "src", "consumer.ts");
			await Bun.write(sourceFile, "export const value = 42;\n");
			await Bun.write(referencingFile, "import { value } from './old';\nconsole.log(value);\n");

			const sourceUri = fileToUri(sourceFile);
			const destUri = fileToUri(destFile);
			const referencingUri = fileToUri(referencingFile);

			const server: ServerConfig = { command: "test-lsp", fileTypes: ["ts"], rootMarkers: [] };
			const client: LspClient = {
				name: "test-lsp",
				cwd: tempDir.path(),
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

			vi.spyOn(lspConfig, "loadConfig").mockReturnValue({
				servers: { "test-lsp": server },
				idleTimeoutMs: undefined,
			});
			vi.spyOn(lspClient, "getOrCreateClient").mockResolvedValue(client);

			const willRenameRequests: Array<{ method: string; params: unknown }> = [];
			vi.spyOn(lspClient, "sendRequest").mockImplementation(async (_client, method, params) => {
				willRenameRequests.push({ method, params });
				if (method === "workspace/willRenameFiles") {
					return {
						changes: {
							[referencingUri]: [
								{
									range: {
										start: { line: 0, character: 22 },
										end: { line: 0, character: 29 },
									},
									newText: "'./new'",
								},
							],
						},
					};
				}
				return null;
			});

			const notifications: Array<{ method: string; params: unknown }> = [];
			vi.spyOn(lspClient, "sendNotification").mockImplementation(async (_client, method, params) => {
				notifications.push({ method, params });
			});

			const tool = new LspTool({ cwd: tempDir.path() } as ToolSession);
			const result = await tool.execute("rename-file-test", {
				action: "rename_file",
				file: sourceFile,
				new_name: destFile,
				timeout: 5,
			});

			expect(willRenameRequests).toHaveLength(1);
			expect(willRenameRequests[0]?.method).toBe("workspace/willRenameFiles");
			expect(willRenameRequests[0]?.params).toEqual({
				files: [{ oldUri: sourceUri, newUri: destUri }],
			});

			// Filesystem actually moved
			expect(fs.existsSync(sourceFile)).toBe(false);
			expect(fs.existsSync(destFile)).toBe(true);

			// Importer file got the LSP-provided edit
			const updatedConsumer = await Bun.file(referencingFile).text();
			expect(updatedConsumer).toBe("import { value } from './new';\nconsole.log(value);\n");

			// didRenameFiles notification fired with the same pair list
			const didRename = notifications.find(n => n.method === "workspace/didRenameFiles");
			expect(didRename).toBeDefined();
			expect(didRename?.params).toEqual({
				files: [{ oldUri: sourceUri, newUri: destUri }],
			});

			const output = result.content
				.filter(block => block.type === "text")
				.map(block => block.text)
				.join("\n");
			expect(output).toContain("Renamed");
		} finally {
			vi.restoreAllMocks();
			tempDir.removeSync();
		}
	});

	it("rename_file with apply:false previews edits without filesystem changes", async () => {
		const tempDir = TempDir.createSync("@gjc-lsp-rename-file-preview-");
		try {
			const sourceFile = path.join(tempDir.path(), "old.ts");
			const destFile = path.join(tempDir.path(), "new.ts");
			await Bun.write(sourceFile, "export const value = 42;\n");

			const server: ServerConfig = { command: "test-lsp", fileTypes: ["ts"], rootMarkers: [] };
			const client: LspClient = {
				name: "test-lsp",
				cwd: tempDir.path(),
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

			vi.spyOn(lspConfig, "loadConfig").mockReturnValue({
				servers: { "test-lsp": server },
				idleTimeoutMs: undefined,
			});
			vi.spyOn(lspClient, "getOrCreateClient").mockResolvedValue(client);
			vi.spyOn(lspClient, "sendRequest").mockResolvedValue({
				documentChanges: [],
			});
			const notifySpy = vi.spyOn(lspClient, "sendNotification").mockResolvedValue();

			const tool = new LspTool({ cwd: tempDir.path() } as ToolSession);
			await tool.execute("rename-file-preview", {
				action: "rename_file",
				file: sourceFile,
				new_name: destFile,
				apply: false,
				timeout: 5,
			});

			expect(fs.existsSync(sourceFile)).toBe(true);
			expect(fs.existsSync(destFile)).toBe(false);
			expect(notifySpy).not.toHaveBeenCalledWith(expect.anything(), "workspace/didRenameFiles", expect.anything());
		} finally {
			vi.restoreAllMocks();
			tempDir.removeSync();
		}
	});

	it("rename_file enumerates every file inside a directory rename", async () => {
		const tempDir = TempDir.createSync("@gjc-lsp-rename-dir-");
		try {
			const srcDir = path.join(tempDir.path(), "old");
			const dstDir = path.join(tempDir.path(), "new");
			const fileA = path.join(srcDir, "a.ts");
			const fileB = path.join(srcDir, "nested", "b.ts");
			await Bun.write(fileA, "export const a = 1;\n");
			await Bun.write(fileB, "export const b = 2;\n");

			const server: ServerConfig = { command: "test-lsp", fileTypes: ["ts"], rootMarkers: [] };
			const client: LspClient = {
				name: "test-lsp",
				cwd: tempDir.path(),
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

			vi.spyOn(lspConfig, "loadConfig").mockReturnValue({
				servers: { "test-lsp": server },
				idleTimeoutMs: undefined,
			});
			vi.spyOn(lspClient, "getOrCreateClient").mockResolvedValue(client);

			const requests: Array<{ method: string; params: unknown }> = [];
			vi.spyOn(lspClient, "sendRequest").mockImplementation(async (_c, method, params) => {
				requests.push({ method, params });
				return null;
			});
			vi.spyOn(lspClient, "sendNotification").mockResolvedValue();

			const tool = new LspTool({ cwd: tempDir.path() } as ToolSession);
			await tool.execute("rename-dir-test", {
				action: "rename_file",
				file: srcDir,
				new_name: dstDir,
				timeout: 5,
			});

			expect(requests).toHaveLength(1);
			const params = requests[0]?.params as { files: Array<{ oldUri: string; newUri: string }> };
			expect(params.files).toHaveLength(2);
			const oldUris = params.files.map(f => f.oldUri).sort();
			const newUris = params.files.map(f => f.newUri).sort();
			expect(oldUris).toEqual([fileToUri(fileA), fileToUri(fileB)].sort());
			expect(newUris).toEqual(
				[fileToUri(path.join(dstDir, "a.ts")), fileToUri(path.join(dstDir, "nested", "b.ts"))].sort(),
			);

			// Directory was actually moved
			expect(fs.existsSync(srcDir)).toBe(false);
			expect(fs.existsSync(path.join(dstDir, "a.ts"))).toBe(true);
			expect(fs.existsSync(path.join(dstDir, "nested", "b.ts"))).toBe(true);
		} finally {
			vi.restoreAllMocks();
			tempDir.removeSync();
		}
	});

	it("request action sends raw LSP method with auto-built textDocument/position params", async () => {
		const tempDir = TempDir.createSync("@gjc-lsp-request-");
		try {
			const filePath = path.join(tempDir.path(), "src", "lib.rs");
			await Bun.write(filePath, 'fn main() {\n    println!("hi");\n}\n');

			const server: ServerConfig = { command: "test-rs", fileTypes: ["rs"], rootMarkers: [] };
			const client: LspClient = {
				name: "test-rs",
				cwd: tempDir.path(),
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

			vi.spyOn(lspConfig, "loadConfig").mockReturnValue({
				servers: { "test-rs": server },
				idleTimeoutMs: undefined,
			});
			vi.spyOn(lspConfig, "getServersForFile").mockReturnValue([["test-rs", server]]);
			vi.spyOn(lspClient, "getOrCreateClient").mockResolvedValue(client);
			vi.spyOn(lspClient, "ensureFileOpen").mockResolvedValue();
			vi.spyOn(lspClient, "sendNotification").mockResolvedValue();

			const captured: Array<{ method: string; params: unknown }> = [];
			vi.spyOn(lspClient, "sendRequest").mockImplementation(async (_c, method, requestParams) => {
				captured.push({ method, params: requestParams });
				return { expansion: "macro_rules!" };
			});

			const tool = new LspTool({ cwd: tempDir.path() } as ToolSession);
			const result = await tool.execute("request-test", {
				action: "request",
				file: filePath,
				line: 2,
				query: "rust-analyzer/expandMacro",
				timeout: 5,
			});

			expect(captured).toHaveLength(1);
			expect(captured[0]?.method).toBe("rust-analyzer/expandMacro");
			expect(captured[0]?.params).toEqual({
				textDocument: { uri: fileToUri(filePath) },
				position: { line: 1, character: 4 },
			});

			const output = result.content
				.filter(block => block.type === "text")
				.map(block => block.text)
				.join("\n");
			expect(output).toContain("rust-analyzer/expandMacro");
			expect(output).toContain('"expansion"');
			expect(output).toContain("macro_rules!");
		} finally {
			vi.restoreAllMocks();
			tempDir.removeSync();
		}
	});

	it("request action forwards explicit JSON payload verbatim", async () => {
		const tempDir = TempDir.createSync("@gjc-lsp-request-payload-");
		try {
			const server: ServerConfig = { command: "test-lsp", fileTypes: ["ts"], rootMarkers: [] };
			const client: LspClient = {
				name: "test-lsp",
				cwd: tempDir.path(),
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

			vi.spyOn(lspConfig, "loadConfig").mockReturnValue({
				servers: { "test-lsp": server },
				idleTimeoutMs: undefined,
			});
			vi.spyOn(lspClient, "getOrCreateClient").mockResolvedValue(client);

			const captured: Array<{ method: string; params: unknown }> = [];
			vi.spyOn(lspClient, "sendRequest").mockImplementation(async (_c, method, requestParams) => {
				captured.push({ method, params: requestParams });
				return null;
			});

			const tool = new LspTool({ cwd: tempDir.path() } as ToolSession);
			await tool.execute("request-payload", {
				action: "request",
				query: "workspace/executeCommand",
				payload: JSON.stringify({ command: "_typescript.organizeImports", arguments: ["a.ts"] }),
				timeout: 5,
			});

			expect(captured).toHaveLength(1);
			expect(captured[0]?.method).toBe("workspace/executeCommand");
			expect(captured[0]?.params).toEqual({
				command: "_typescript.organizeImports",
				arguments: ["a.ts"],
			});
		} finally {
			vi.restoreAllMocks();
			tempDir.removeSync();
		}
	});

	it("capabilities action dumps server capabilities", async () => {
		const tempDir = TempDir.createSync("@gjc-lsp-caps-");
		try {
			const server: ServerConfig = { command: "test-lsp", fileTypes: ["ts"], rootMarkers: [] };
			const client: LspClient = {
				name: "test-lsp",
				cwd: tempDir.path(),
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
				serverCapabilities: {
					hoverProvider: true,
					definitionProvider: true,
					executeCommandProvider: { commands: ["_typescript.organizeImports"] },
					experimental: { "rust-analyzer/expandMacro": true },
				},
			};

			vi.spyOn(lspConfig, "loadConfig").mockReturnValue({
				servers: { "test-lsp": server },
				idleTimeoutMs: undefined,
			});
			vi.spyOn(lspClient, "getOrCreateClient").mockResolvedValue(client);

			const tool = new LspTool({ cwd: tempDir.path() } as ToolSession);
			const result = await tool.execute("caps-test", {
				action: "capabilities",
				timeout: 5,
			});

			const output = result.content
				.filter(block => block.type === "text")
				.map(block => block.text)
				.join("\n");
			expect(output).toContain("test-lsp:");
			expect(output).toContain("hoverProvider");
			expect(output).toContain("_typescript.organizeImports");
			expect(output).toContain("rust-analyzer/expandMacro");
		} finally {
			vi.restoreAllMocks();
			tempDir.removeSync();
		}
	});
});
