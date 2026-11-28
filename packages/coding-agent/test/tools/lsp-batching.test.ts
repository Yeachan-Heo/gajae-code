import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { LocalProtocolHandler } from "@gajae-code/coding-agent/internal-urls";
import { createLspWritethrough, writethroughNoop } from "@gajae-code/coding-agent/lsp";
import * as lspConfig from "@gajae-code/coding-agent/lsp/config";
import { TempDir } from "@gajae-code/utils";
import type { ServerConfig } from "../../src/lsp/types";
import * as atomicFileWrite from "../../src/tools/atomic-file-write";
import { FileWriteNotPublishedError } from "../../src/tools/atomic-file-write";

describe("createLspWritethrough batching", () => {
	let tempDir: TempDir;

	beforeEach(() => {
		tempDir = TempDir.createSync("@gjc-lsp-batch-");
	});

	afterEach(() => {
		vi.restoreAllMocks();
		tempDir.removeSync();
	});

	it("defers LSP work until the batch flush", async () => {
		const loadConfigSpy = vi
			.spyOn(lspConfig, "loadConfig")
			.mockReturnValue({ servers: {}, idleTimeoutMs: undefined });
		const getServersSpy = vi.spyOn(lspConfig, "getServersForFile").mockReturnValue([]);
		const writethrough = createLspWritethrough(tempDir.path(), { enableFormat: true, enableDiagnostics: true });

		const fileA = path.join(tempDir.path(), "a.ts");
		const fileB = path.join(tempDir.path(), "b.ts");
		const batchId = `batch-${Date.now()}`;

		const firstResult = await writethrough(fileA, "const a = 1;\n", undefined, undefined, {
			id: batchId,
			flush: false,
		});

		expect(firstResult).toBeUndefined();
		expect(getServersSpy).toHaveBeenCalledTimes(0);
		expect(loadConfigSpy).toHaveBeenCalledTimes(0);
		expect(await Bun.file(fileA).text()).toBe("const a = 1;\n");

		const secondResult = await writethrough(fileB, "const b = 2;\n", undefined, undefined, {
			id: batchId,
			flush: true,
		});

		expect(secondResult).toBeUndefined();
		expect(getServersSpy).toHaveBeenCalledTimes(2);
		expect(loadConfigSpy).toHaveBeenCalledTimes(1);
		expect(await Bun.file(fileA).text()).toBe("const a = 1;\n");
		expect(await Bun.file(fileB).text()).toBe("const b = 2;\n");
	});

	it("runs LSP immediately when no batch is provided", async () => {
		const loadConfigSpy = vi
			.spyOn(lspConfig, "loadConfig")
			.mockReturnValue({ servers: {}, idleTimeoutMs: undefined });
		const getServersSpy = vi.spyOn(lspConfig, "getServersForFile").mockReturnValue([]);
		const writethrough = createLspWritethrough(tempDir.path(), { enableFormat: true, enableDiagnostics: true });

		const filePath = path.join(tempDir.path(), "single.ts");
		const result = await writethrough(filePath, "const single = true;\n");

		expect(result).toBeUndefined();
		expect(getServersSpy).toHaveBeenCalledTimes(1);
		expect(loadConfigSpy).toHaveBeenCalledTimes(1);
		expect(await Bun.file(filePath).text()).toBe("const single = true;\n");
	});

	it("honors the exported BunFile writethrough target", async () => {
		const requestedPath = path.join(tempDir.path(), "requested.ts");
		const virtualTargetPath = path.join(tempDir.path(), "virtual-target.ts");
		await writethroughNoop(requestedPath, "virtual content\n", undefined, Bun.file(virtualTargetPath));
		expect(await Bun.file(virtualTargetPath).text()).toBe("virtual content\n");
		expect(await Bun.file(requestedPath).exists()).toBe(false);
	});

	it("propagates a rejecting BunFile write instead of reporting success", async () => {
		const failure = Object.assign(new Error("EIO: simulated device failure"), { code: "EIO" });
		const file = {
			// Rejects on a later microtask so an unawaited call cannot be caught by
			// the caller's synchronous try/catch.
			write: async () => {
				await Bun.sleep(0);
				throw failure;
			},
		} as unknown as Bun.BunFile;

		await expect(
			writethroughNoop(path.join(tempDir.path(), "rejecting.ts"), "content\n", undefined, file),
		).rejects.toMatchObject({ code: "EIO" });

		vi.spyOn(lspConfig, "loadConfig").mockReturnValue({ servers: {}, idleTimeoutMs: undefined });
		vi.spyOn(lspConfig, "getServersForFile").mockReturnValue([]);
		const writethrough = createLspWritethrough(tempDir.path(), { enableFormat: true, enableDiagnostics: true });
		await expect(
			writethrough(path.join(tempDir.path(), "rejecting-lsp.ts"), "content\n", undefined, file),
		).rejects.toMatchObject({ code: "EIO" });
	});

	it("reports a later publication failure as potentially replacing an earlier write", async () => {
		vi.spyOn(lspConfig, "loadConfig").mockReturnValue({ servers: {}, idleTimeoutMs: undefined });
		const client = {
			format: async () => "const formatted = true;\n",
			lint: async () => [],
		};
		const server: ServerConfig = {
			command: "custom-formatter",
			fileTypes: ["ts"],
			rootMarkers: [],
			createClient: () => client,
		};
		vi.spyOn(lspConfig, "getServersForFile").mockReturnValue([["custom", server]]);
		const filePath = path.join(tempDir.path(), "later-failure.ts");
		let writes = 0;
		const atomicFailure = new FileWriteNotPublishedError(
			filePath,
			Object.assign(new Error("EIO: publication failed"), { code: "EIO" }),
		);
		vi.spyOn(atomicFileWrite, "writeFileAtomically").mockImplementation(async () => {
			writes += 1;
			if (writes > 1) throw atomicFailure;
		});

		const writethrough = createLspWritethrough(tempDir.path(), { enableFormat: true });
		await expect(writethrough(filePath, "const original = true;\n")).rejects.toMatchObject({
			destUnchanged: false,
		});
		expect(writes).toBeGreaterThan(1);
	});

	it("keeps a no-server publication failure marked unchanged", async () => {
		vi.spyOn(lspConfig, "loadConfig").mockReturnValue({ servers: {}, idleTimeoutMs: undefined });
		vi.spyOn(lspConfig, "getServersForFile").mockReturnValue([]);
		const filePath = path.join(tempDir.path(), "no-server-failure.ts");
		vi.spyOn(atomicFileWrite, "writeFileAtomically").mockRejectedValue(
			new FileWriteNotPublishedError(filePath, Object.assign(new Error("EIO"), { code: "EIO" })),
		);
		const writethrough = createLspWritethrough(tempDir.path(), { enableFormat: false });
		await expect(writethrough(filePath, "const unchanged = true;\n")).rejects.toMatchObject({
			destUnchanged: true,
			publicationState: "not_published",
		});
	});

	it.skipIf(process.platform === "win32")("keeps each staged entry's own local binding at flush", async () => {
		const artifacts = path.join(tempDir.path(), "explicit-artifacts");
		const globalArtifacts = path.join(tempDir.path(), "global-artifacts");
		const localRoot = path.join(artifacts, "local");
		const outside = path.join(tempDir.path(), "outside.ts");
		const link = path.join(localRoot, "alias.ts");
		await fs.mkdir(localRoot, { recursive: true });
		await fs.mkdir(path.join(globalArtifacts, "local"), { recursive: true });
		await fs.writeFile(outside, "outside\n");
		await fs.symlink(outside, link);
		vi.spyOn(lspConfig, "loadConfig").mockReturnValue({ servers: {}, idleTimeoutMs: undefined });
		vi.spyOn(lspConfig, "getServersForFile").mockReturnValue([]);
		// The batch is seeded by a callback without a binding (the edit tool
		// before its getter was threaded), then a bound writer stages the same
		// id. Flush must publish that entry against its own root, not the
		// seeder's or the process-global one.
		LocalProtocolHandler.setOverride({
			getArtifactsDir: () => globalArtifacts,
			isManagedDestination: () => false,
			getSessionId: () => "global-root",
		});
		try {
			const unbound = createLspWritethrough(tempDir.path(), { enableFormat: true });
			const bound = createLspWritethrough(tempDir.path(), {
				enableFormat: true,
				getLocalProtocolOptions: () => ({
					getArtifactsDir: () => artifacts,
					isManagedDestination: () => false,
					getSessionId: () => "caller-root",
				}),
			});
			const batchId = `batch-authority-${Date.now()}`;
			await unbound(path.join(tempDir.path(), "seed.ts"), "const seed = 1;\n", undefined, undefined, {
				id: batchId,
				flush: false,
			});
			await expect(
				bound(link, "must-not-write\n", undefined, undefined, { id: batchId, flush: true }),
			).rejects.toThrow(/outside trust boundary/);
			expect(await fs.readFile(outside, "utf8")).toBe("outside\n");
		} finally {
			LocalProtocolHandler.setOverride(undefined);
		}
	});
});
