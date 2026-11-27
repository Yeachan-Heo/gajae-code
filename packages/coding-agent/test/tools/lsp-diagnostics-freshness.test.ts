import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { createLspWritethrough } from "@gajae-code/coding-agent/lsp";
import * as lspClient from "@gajae-code/coding-agent/lsp/client";
import * as lspConfig from "@gajae-code/coding-agent/lsp/config";
import type { Diagnostic, LspClient, ServerConfig } from "@gajae-code/coding-agent/lsp/types";
import { fileToUri } from "@gajae-code/coding-agent/lsp/utils";
import { type ptree, TempDir } from "@gajae-code/utils";

const TEST_SERVER: ServerConfig = {
	command: "test-lsp",
	fileTypes: ["ts"],
	rootMarkers: [],
};

function createDiagnostic(message: string): Diagnostic {
	return {
		message,
		severity: 1,
		range: {
			start: { line: 0, character: 0 },
			end: { line: 0, character: 1 },
		},
	};
}

function createClient(cwd: string, config: ServerConfig): LspClient {
	return {
		name: "test-lsp",
		cwd,
		config,
		proc: {} as ptree.ChildProcess<"pipe">,
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

function publishDiagnostics(client: LspClient, uri: string, diagnostics: Diagnostic[], version: number | null): void {
	client.diagnostics.set(uri, { diagnostics, version });
	client.diagnosticsVersion += 1;
}

describe("LSP diagnostics freshness", () => {
	let tempDir: TempDir;

	beforeEach(() => {
		tempDir = TempDir.createSync("@gjc-lsp-freshness-");
	});

	afterEach(() => {
		vi.restoreAllMocks();
		tempDir.removeSync();
	});

	it("suppresses stale write diagnostics until the matching document version arrives", async () => {
		const filePath = path.join(tempDir.path(), "example.ts");
		const uri = fileToUri(filePath);
		const client = createClient(tempDir.path(), TEST_SERVER);
		client.openFiles.set(uri, { version: 1, languageId: "typescript", lastUsedAt: Date.now() });

		vi.spyOn(lspConfig, "loadConfig").mockReturnValue({ servers: {}, idleTimeoutMs: undefined });
		vi.spyOn(lspConfig, "getServersForFile").mockReturnValue([["test-lsp", TEST_SERVER]]);
		vi.spyOn(lspClient, "getOrCreateClient").mockResolvedValue(client);
		vi.spyOn(lspClient, "syncContent").mockImplementation(async (mockClient, syncedFilePath) => {
			const syncedUri = fileToUri(syncedFilePath);
			mockClient.diagnostics.delete(syncedUri);
			const openFile = mockClient.openFiles.get(syncedUri);
			if (openFile) {
				openFile.version += 1;
			} else {
				mockClient.openFiles.set(syncedUri, { version: 1, languageId: "typescript", lastUsedAt: Date.now() });
			}
		});
		vi.spyOn(lspClient, "notifySaved").mockImplementation(async (mockClient, savedFilePath) => {
			const savedUri = fileToUri(savedFilePath);
			setTimeout(() => {
				publishDiagnostics(mockClient, savedUri, [createDiagnostic("stale error")], null);
			}, 10);
			setTimeout(() => {
				publishDiagnostics(mockClient, savedUri, [], mockClient.openFiles.get(savedUri)?.version ?? null);
			}, 150);
		});

		const writethrough = createLspWritethrough(tempDir.path(), {
			enableFormat: false,
			enableDiagnostics: true,
		});
		const result = await writethrough(filePath, "export const value = 2;\n");

		expect(result).toBeDefined();
		expect(result?.messages).toEqual([]);
		expect(result?.summary).toBe("OK");
		expect(result?.errored).toBe(false);
		expect(await Bun.file(filePath).text()).toBe("export const value = 2;\n");
	});
});
