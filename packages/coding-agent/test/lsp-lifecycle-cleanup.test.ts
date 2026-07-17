import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { type ptree, TempDir } from "@gajae-code/utils";
import { createLspWritethrough } from "../src/lsp";
import * as lspClient from "../src/lsp/client";
import { getActiveClients, isIdleCheckerActiveForTests, setIdleTimeout, shutdownAll } from "../src/lsp/client";
import * as lspConfig from "../src/lsp/config";
import DEFAULT_LSP_SERVERS from "../src/lsp/defaults.json" with { type: "json" };
import type { LspClient, ServerConfig } from "../src/lsp/types";

const TEST_SERVER: ServerConfig = {
	command: "test-lsp",
	fileTypes: ["ts"],
	rootMarkers: [],
};

function createClient(cwd: string): LspClient {
	return {
		name: "test-lsp",
		cwd,
		config: TEST_SERVER,
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

describe("LSP lifecycle cleanup", () => {
	afterEach(async () => {
		await shutdownAll();
		vi.restoreAllMocks();
	});

	it("shutdownAll stops the idle checker when no clients remain", async () => {
		setIdleTimeout(60_000);
		expect(isIdleCheckerActiveForTests()).toBe(true);

		await shutdownAll();

		expect(getActiveClients()).toEqual([]);
		expect(isIdleCheckerActiveForTests()).toBe(false);
	});

	it("starts an LSP client lazily on the first LSP-backed write", async () => {
		const tempDir = TempDir.createSync("@gjc-lsp-lazy-write-");
		try {
			const filePath = path.join(tempDir.path(), "example.ts");
			const client = createClient(tempDir.path());
			const getClientSpy = vi.spyOn(lspClient, "getOrCreateClient").mockResolvedValue(client);
			vi.spyOn(lspConfig, "loadConfig").mockReturnValue({ servers: {}, idleTimeoutMs: undefined });
			vi.spyOn(lspConfig, "getServersForFile").mockReturnValue([["test-lsp", TEST_SERVER]]);
			vi.spyOn(lspClient, "syncContent").mockResolvedValue();
			vi.spyOn(lspClient, "notifySaved").mockResolvedValue();

			const writethrough = createLspWritethrough(tempDir.path(), {
				enableFormat: false,
				enableDiagnostics: true,
			});
			await writethrough(filePath, "export const value = 1;\n");

			expect(getClientSpy).toHaveBeenCalledWith(TEST_SERVER, tempDir.path());
			expect(await Bun.file(filePath).text()).toBe("export const value = 1;\n");
		} finally {
			tempDir.removeSync();
		}
	});
	it("gives rust-analyzer a longer startup warmup window than the generic LSP default", () => {
		expect(DEFAULT_LSP_SERVERS["rust-analyzer"].warmupTimeoutMs).toBeGreaterThan(5000);
	});
});
