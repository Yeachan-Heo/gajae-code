import { afterEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { applyAtomicYamlPatches } from "../src/config/atomic-yaml-patch";

const realDirectorySync = { ...(await import("../src/utils/directory-sync")) };
const tempDirs: string[] = [];

function tempDir(): string {
	const directory = mkdtempSync(path.join(tmpdir(), "gjc-config-sync-"));
	tempDirs.push(directory);
	return directory;
}

function error(code: string): NodeJS.ErrnoException {
	const value = new Error(code) as NodeJS.ErrnoException;
	value.code = code;
	return value;
}

function installFullyBestEffortBarrierFailure(): void {
	mock.module("../src/utils/directory-sync", () => ({
		...realDirectorySync,
		syncDirectoryFullyBestEffort: (directory: string) =>
			realDirectorySync.syncDirectoryFullyBestEffort(directory, {
				open: async () => {
					throw error("EIO");
				},
			}),
		syncDirectoryFullyBestEffortSync: (directory: string) =>
			realDirectorySync.syncDirectoryFullyBestEffortSync(directory, {
				open: () => {
					throw error("EIO");
				},
			}),
	}));
}

afterEach(() => {
	mock.module("../src/utils/directory-sync", () => realDirectorySync);
	mock.restore();
	for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("atomic YAML fully best-effort directory barrier", () => {
	it("retains the renamed YAML when the optional barrier fails", async () => {
		installFullyBestEffortBarrierFailure();
		const file = path.join(tempDir(), "config.yml");
		await applyAtomicYamlPatches(file, [{ op: "set", path: "provider.name", value: "test" }]);
		expect(readFileSync(file, "utf8")).toContain("name: test");
	});

	it("still propagates replacement failures", async () => {
		const file = path.join(tempDir(), "config.yml");
		await expect(
			applyAtomicYamlPatches(file, [{ op: "set", path: "provider.name", value: "test" }], {
				rename: async () => {
					throw error("EIO");
				},
			}),
		).rejects.toMatchObject({ code: "EIO" });
	});
});

describe("provider and blob fully best-effort directory barriers", () => {
	it("provider onboarding retains its published config when the barrier fails", async () => {
		installFullyBestEffortBarrierFailure();
		const { addApiCompatibleProvider } = await import("../src/setup/provider-onboarding");
		const modelsPath = path.join(tempDir(), "models.yml");
		await expect(
			addApiCompatibleProvider({
				compatibility: "openai",
				providerId: "example",
				baseUrl: "https://example.test/v1",
				apiKeyEnv: "EXAMPLE_KEY",
				models: ["example-model"],
				modelsPath,
			}),
		).resolves.toMatchObject({ modelsPath, providerId: "example" });
		expect(readFileSync(modelsPath, "utf8")).toContain("example-model");
	});

	it("provider onboarding propagates write failures before the barrier", async () => {
		const directory = tempDir();
		const blockedDirectory = path.join(directory, "not-a-directory");
		const modelsPath = path.join(blockedDirectory, "models.yml");
		writeFileSync(blockedDirectory, "not a directory");
		const { addApiCompatibleProvider } = await import("../src/setup/provider-onboarding");
		await expect(
			addApiCompatibleProvider({
				compatibility: "openai",
				providerId: "example",
				baseUrl: "https://example.test/v1",
				apiKeyEnv: "EXAMPLE_KEY",
				models: ["example-model"],
				modelsPath,
			}),
		).rejects.toMatchObject({ code: "EEXIST" });
	});

	it("blob store retains an immutable blob when the barrier fails", async () => {
		installFullyBestEffortBarrierFailure();
		const { BlobStore } = await import("../src/session/blob-store");
		const store = new BlobStore(path.join(tempDir(), "blobs"));
		expect(store.putImmutableSync(Buffer.from("blob"))).toMatchObject({ bytes: 4 });
	});

	it("blob store propagates install failures before the barrier", async () => {
		const directory = tempDir();
		const blobPath = path.join(directory, "blobs");
		writeFileSync(blobPath, "not a directory");
		const { BlobStore } = await import("../src/session/blob-store");
		expect(() => new BlobStore(blobPath).putImmutableSync(Buffer.from("blob"))).toThrow();
	});
});
