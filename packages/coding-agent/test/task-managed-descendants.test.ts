import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as native from "@gajae-code/natives";
import { ArtifactManager } from "../src/session/artifacts";
import { ManagedSessionDescendantStore, managedDirectoryRoot } from "../src/session/internal/managed-session-storage";
import { createManagedTaskPersistence } from "../src/task/executor";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })),
	);
});

async function readSelected(artifactsDir: string, taskId: string): Promise<{ output: string; metadata: string }> {
	const selector = JSON.parse(await fs.readFile(path.join(artifactsDir, `${taskId}.md.selector.json`), "utf8")) as {
		outputFilename: string;
		metadataFilename: string;
	};
	return {
		output: await fs.readFile(path.join(artifactsDir, selector.outputFilename), "utf8"),
		metadata: await fs.readFile(path.join(artifactsDir, selector.metadataFilename), "utf8"),
	};
}

describe("explicit artifact path allocation", () => {
	it("preserves writable paths for explicit persistent destinations", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-task-explicit-artifact-"));
		temporaryDirectories.push(root);
		const artifacts = new ArtifactManager(path.join(root, "artifacts"));
		const allocated = await artifacts.allocatePath("bash");
		expect(allocated.path).toBe(path.join(root, "artifacts", `${allocated.id}.bash.log`));
		if (!allocated.path) throw new Error("Expected explicit artifact path");
		await Bun.write(allocated.path, "full output");
		expect(await fs.readFile(allocated.path, "utf8")).toBe("full output");
	});
});

describe.skipIf(process.platform !== "linux")("managed task descendant persistence", () => {
	it("publishes output and metadata through one retained parent capability", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-task-managed-descendants-"));
		temporaryDirectories.push(root);
		const artifactsDir = path.join(root, "artifacts");
		const artifacts = new ArtifactManager(
			new ManagedSessionDescendantStore(managedDirectoryRoot(root), artifactsDir),
		);
		const persistence = createManagedTaskPersistence(artifacts, "0-task-1");
		const metadata = Buffer.from('{"id":"0-task-1"}', "utf8");

		await persistence.publishOutput("verified output", metadata);
		await persistence.publishOutput("resumed output", Buffer.from('{"id":"0-task-1","attempt":2}', "utf8"));

		expect(await readSelected(artifactsDir, "0-task-1")).toEqual({
			output: "resumed output",
			metadata: '{"id":"0-task-1","attempt":2}',
		});
	});

	it("keeps the prior output and metadata when retained replacement creation fails", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-task-managed-no-loss-"));
		temporaryDirectories.push(root);
		const artifactsDir = path.join(root, "artifacts");
		const artifacts = new ArtifactManager(
			new ManagedSessionDescendantStore(managedDirectoryRoot(root), artifactsDir),
		);
		const persistence = createManagedTaskPersistence(artifacts, "0-task-no-loss");
		await persistence.publishOutput("old output", Buffer.from('{"generation":1}', "utf8"));
		const spy = vi
			.spyOn(native.RecoveryFsRoot.prototype as unknown as { replaceManaged: () => unknown }, "replaceManaged")
			.mockReturnValueOnce({ ok: false, code: "io_error" });
		try {
			await expect(persistence.publishOutput("new output", Buffer.from('{"generation":2}', "utf8"))).rejects.toThrow(
				"io_error",
			);
			expect(await readSelected(artifactsDir, "0-task-no-loss")).toEqual({
				output: "old output",
				metadata: '{"generation":1}',
			});
		} finally {
			spy.mockRestore();
		}
	});

	it("keeps the selected generation when staging metadata fails", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-task-managed-generation-staging-"));
		temporaryDirectories.push(root);
		const artifactsDir = path.join(root, "artifacts");
		const artifacts = new ArtifactManager(
			new ManagedSessionDescendantStore(managedDirectoryRoot(root), artifactsDir),
		);
		const persistence = createManagedTaskPersistence(artifacts, "0-task-generation");
		await persistence.publishOutput("old output", Buffer.from('{"generation":1}', "utf8"));
		const prototype = native.RecoveryFsRoot.prototype as unknown as {
			createManaged: (...args: unknown[]) => { ok: boolean; code?: string };
		};
		const realCreateManaged = prototype.createManaged;
		let calls = 0;
		const spy = vi.spyOn(prototype, "createManaged").mockImplementation(function (this: unknown, ...args: unknown[]) {
			calls += 1;
			if (calls === 2) return { ok: false, code: "io_error" };
			return realCreateManaged.apply(this, args);
		});
		try {
			await expect(persistence.publishOutput("new output", Buffer.from('{"generation":2}', "utf8"))).rejects.toThrow(
				"io_error",
			);
			expect(await readSelected(artifactsDir, "0-task-generation")).toEqual({
				output: "old output",
				metadata: '{"generation":1}',
			});
		} finally {
			spy.mockRestore();
		}
	});

	it("rejects output after the retained artifacts directory is replaced", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-task-managed-replacement-"));
		temporaryDirectories.push(root);
		const artifactsDir = path.join(root, "artifacts");
		const artifacts = new ArtifactManager(
			new ManagedSessionDescendantStore(managedDirectoryRoot(root), artifactsDir),
		);
		const persistence = createManagedTaskPersistence(artifacts, "0-task-2");
		await fs.rename(artifactsDir, path.join(root, "detached"));
		await fs.mkdir(artifactsDir, { mode: 0o700 });
		await expect(persistence.openSession()).rejects.toThrow("root binding changed");

		await expect(persistence.publishOutput("blocked", Buffer.from("{}", "utf8"))).rejects.toThrow(
			"root binding changed",
		);
		expect(await fs.readdir(artifactsDir)).toEqual([]);
	});

	it("never writes output bytes into a subtree swapped during replacement", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-task-managed-boundary-"));
		temporaryDirectories.push(root);
		const artifactsDir = path.join(root, "artifacts");
		const artifacts = new ArtifactManager(
			new ManagedSessionDescendantStore(managedDirectoryRoot(root), artifactsDir),
		);
		const persistence = createManagedTaskPersistence(artifacts, "0-task-3");
		await persistence.publishOutput("initial", Buffer.from("{}", "utf8"));
		const replacementPrototype = native.RecoveryFsRoot.prototype as unknown as {
			replaceManaged: (...args: unknown[]) => { ok: boolean; code?: string };
		};
		const realReplaceManaged = replacementPrototype.replaceManaged;
		let swapped = false;
		const spy = vi.spyOn(replacementPrototype, "replaceManaged").mockImplementation(function (
			this: unknown,
			...args: unknown[]
		) {
			const result = realReplaceManaged.apply(this, args);
			if (result.ok && !swapped) {
				swapped = true;
				fsSync.renameSync(artifactsDir, path.join(root, "detached"));
				fsSync.mkdirSync(artifactsDir, { mode: 0o700 });
			}
			return result;
		});
		try {
			await expect(persistence.publishOutput("blocked", Buffer.from('{"attempt":2}', "utf8"))).rejects.toThrow(
				"root binding changed",
			);
			expect(await fs.readdir(artifactsDir)).toEqual([]);
			expect(await readSelected(path.join(root, "detached"), "0-task-3")).toEqual({
				output: "blocked",
				metadata: '{"attempt":2}',
			});
		} finally {
			spy.mockRestore();
		}
	});

	it("does not issue a fallible root fsync after native publication commits", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-task-managed-fsync-"));
		temporaryDirectories.push(root);
		const artifactsDir = path.join(root, "artifacts");
		const artifacts = new ArtifactManager(
			new ManagedSessionDescendantStore(managedDirectoryRoot(root), artifactsDir),
		);
		const persistence = createManagedTaskPersistence(artifacts, "0-task-4");
		const spy = vi
			.spyOn(native.RecoveryFsRoot.prototype, "fsync")
			.mockReturnValue({ ok: false, code: "fsync_failed" });
		try {
			await persistence.publishOutput("committed", Buffer.from("{}", "utf8"));
			expect(await readSelected(artifactsDir, "0-task-4")).toEqual({ output: "committed", metadata: "{}" });
			expect(spy).not.toHaveBeenCalled();
		} finally {
			spy.mockRestore();
		}
	});

	it("supports managed output replacement above the recovery-state size cap", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-task-managed-large-"));
		temporaryDirectories.push(root);
		const artifactsDir = path.join(root, "artifacts");
		const artifacts = new ArtifactManager(
			new ManagedSessionDescendantStore(managedDirectoryRoot(root), artifactsDir),
		);
		const persistence = createManagedTaskPersistence(artifacts, "0-task-5");
		const initial = "a".repeat(2 * 1024 * 1024);
		const resumed = "b".repeat(2 * 1024 * 1024);
		await persistence.publishOutput(initial, Buffer.from("{}", "utf8"));
		await persistence.publishOutput(resumed, Buffer.from('{"attempt":2}', "utf8"));
		const selected = await readSelected(artifactsDir, "0-task-5");
		expect(Buffer.byteLength(selected.output)).toBe(Buffer.byteLength(resumed));
		expect(selected.output.slice(0, 1)).toBe("b");
	});
});
