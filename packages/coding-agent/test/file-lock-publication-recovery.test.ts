import { afterEach, describe, expect, test, vi } from "bun:test";
import * as crypto from "node:crypto";
import * as syncFs from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	acquireFileLock,
	FileLockAcquireError,
	FileLockTestHooks,
	withFileLock,
} from "@gajae-code/coding-agent/config/file-lock";
import {
	exactRemoveDirectoryTree,
	type NativeDirectoryTreeSnapshot,
	type NativeExactUnlinkResult,
	type NativeNoReplaceResult,
	renameDirectoryNoReplacePathAsync,
	renameNoReplacePathAsync,
	snapshotDirectoryTree,
} from "@gajae-code/natives";
import { registerOwnedDeletionRoot } from "../../../scripts/safe-cleanup";

const tempDirs: { directory: string; forgetGrant: () => void }[] = [];
const quickAcquire = { retries: 3, retryDelayMs: 1 };

interface Fixture {
	root: string;
	file: string;
	lock: string;
}

interface PublicationCalls {
	primary: number;
	fallback: number;
	source: string;
	originalInfo: string;
}

interface RemovalCall {
	path: string;
	snapshot: NativeDirectoryTreeSnapshot;
}

afterEach(async () => {
	vi.restoreAllMocks();
	FileLockTestHooks.nativePublicationBindings = undefined;
	FileLockTestHooks.nativeQuarantineBindings = undefined;
	for (const { directory, forgetGrant } of tempDirs.splice(0)) {
		try {
			await fs.rm(directory, { recursive: true, force: true });
		} finally {
			forgetGrant();
		}
	}
});

async function makeFixture(parent = os.tmpdir()): Promise<Fixture> {
	const root = path.join(await fs.realpath(parent), `file-lock-publication-recovery-${crypto.randomUUID()}`);
	// External filesystem fixtures must use the existing deletion guard's exact,
	// pre-creation grant; never authorize the whole supplied mount or temp parent.
	const forgetGrant = registerOwnedDeletionRoot(root);
	try {
		await fs.mkdir(root, { mode: 0o700 });
	} catch (error) {
		forgetGrant();
		throw error;
	}
	tempDirs.push({ directory: root, forgetGrant });
	const file = path.join(root, "state.json");
	return { root, file, lock: `${file}.lock` };
}

function treeSnapshot(directory: string): NativeDirectoryTreeSnapshot {
	const captured = snapshotDirectoryTree(directory);
	expect(captured.ok).toBe(true);
	if (!captured.snapshot) throw new Error(`Fixture snapshot failed: ${captured.code ?? "missing snapshot"}`);
	return captured.snapshot;
}

function recordedSnapshot(snapshot: NativeDirectoryTreeSnapshot | undefined): NativeDirectoryTreeSnapshot {
	if (!snapshot) throw new Error("Expected the native hook to record a tree snapshot");
	return snapshot;
}

function unsupportedRename(): NativeNoReplaceResult {
	return {
		ok: false,
		code: "invalid_request",
		mutationState: "not_committed",
		durabilityState: "not_attempted",
		reason: "invalid_request",
		primitive: "renameat2_noreplace",
		phase: "preflight",
		diagnostic: { schemaVersion: 1, collectionState: "unavailable" },
	};
}

function committedIdentityFailure(): NativeNoReplaceResult {
	return {
		ok: false,
		code: "destination_identity_changed",
		mutationState: "committed",
		durabilityState: "not_provable",
		reason: "identity_violation",
		primitive: "mkdirat_renameat_noreplace",
		phase: "terminal_identity",
		diagnostic: { schemaVersion: 1, collectionState: "unavailable" },
	};
}

function installPublicationFailure(
	afterRename?: (source: string, destination: string) => Promise<void>,
	result: unknown = committedIdentityFailure(),
): PublicationCalls {
	const calls: PublicationCalls = { primary: 0, fallback: 0, source: "", originalInfo: "" };
	FileLockTestHooks.nativePublicationBindings = () => ({
		renameNoReplacePathAsync: async source => {
			calls.primary++;
			calls.source = source;
			calls.originalInfo = await Bun.file(path.join(source, "info")).text();
			return unsupportedRename();
		},
		renameDirectoryNoReplacePathAsync: async (source, destination) => {
			calls.fallback++;
			await fs.rename(source, destination);
			await afterRename?.(source, destination);
			// Invalid envelopes intentionally exercise the runtime/native trust boundary.
			return result as NativeNoReplaceResult;
		},
	});
	return calls;
}

function retainedIdentityFailure(retainedPath: string): NativeExactUnlinkResult {
	return { ok: false, code: "identity_mismatch", retainedSuccessorPath: retainedPath };
}

function installRetainedRelease(afterDetach?: (retainedPath: string) => NativeExactUnlinkResult): RemovalCall[] {
	const calls: RemovalCall[] = [];
	FileLockTestHooks.nativeQuarantineBindings = () => ({
		snapshotDirectoryTree,
		exactRemoveDirectoryTree: (target, snapshot) => {
			calls.push({ path: target, snapshot });
			if (calls.length === 1) {
				const retainedPath = `${target}.removing`;
				// This hook is synchronous, just like the native removal binding.
				syncFs.renameSync(target, retainedPath);
				return afterDetach?.(retainedPath) ?? retainedIdentityFailure(retainedPath);
			}
			return exactRemoveDirectoryTree(target, snapshot);
		},
	});
	return calls;
}

function successfulPublication(primitive: NativeNoReplaceResult["primitive"]): NativeNoReplaceResult {
	return {
		ok: true,
		mutationState: "committed",
		durabilityState: "not_attempted",
		reason: "none",
		primitive,
		phase: "complete",
		diagnostic: { schemaVersion: 1, collectionState: "unavailable" },
	};
}

const primaryPrimitive =
	process.platform === "linux"
		? "renameat2_noreplace"
		: process.platform === "darwin"
			? "renameatx_np_excl"
			: process.platform === "win32"
				? "windows_rename_noreplace"
				: undefined;

describe.skipIf(primaryPrimitive === undefined)("file lock operation-specific success receipts", () => {
	for (const operation of ["primary", "directory"] as const) {
		const expected = operation === "primary" ? primaryPrimitive : "mkdirat_renameat_noreplace";
		const primitives: NativeNoReplaceResult["primitive"][] = [
			"renameat2_noreplace",
			"renameatx_np_excl",
			"windows_rename_noreplace",
			"mkdirat_renameat_noreplace",
			"linkat_noreplace",
			"unsupported",
			"unknown",
		];
		const invalidResults: [string, NativeNoReplaceResult][] = primitives
			.filter(primitive => primitive !== expected)
			.map(primitive => [`wrong primitive ${primitive}`, successfulPublication(primitive)]);
		const valid = successfulPublication(expected ?? "unsupported");
		invalidResults.push(
			["failure code", { ...valid, code: "destination_identity_changed" }],
			["wrong mutation", { ...valid, mutationState: "not_committed" }],
			["wrong durability", { ...valid, durabilityState: "proven" }],
			["wrong phase", { ...valid, phase: "rename" }],
			["wrong reason", { ...valid, reason: "io_failure" }],
			["contradictory contention", { ...valid, reason: "destination_exists" }],
			["partial diagnostic", { ...valid, diagnostic: { schemaVersion: 1, collectionState: "partial" } }],
			[
				"extra diagnostic field",
				{ ...valid, diagnostic: { schemaVersion: 1, collectionState: "unavailable", osCode: 7 } },
			],
		);
		test.each(
			invalidResults,
		)(`${operation} refuses %s even when a second call would publish`, async (_label, result) => {
			const { root, file, lock } = await makeFixture();
			let primary = 0;
			let fallback = 0;
			let entered = 0;
			let acquired = 0;
			FileLockTestHooks.nativePublicationBindings = () => ({
				renameNoReplacePathAsync: async (source, destination) => {
					primary++;
					if (primary > 1) {
						await fs.rename(source, destination);
						return successfulPublication(primaryPrimitive ?? "unsupported");
					}
					return operation === "primary" ? result : unsupportedRename();
				},
				renameDirectoryNoReplacePathAsync: async (source, destination) => {
					fallback++;
					if (fallback > 1) {
						await fs.rename(source, destination);
						return successfulPublication("mkdirat_renameat_noreplace");
					}
					return result;
				},
			});
			const failure = await withFileLock(file, async () => entered++, {
				...quickAcquire,
				onAcquired: () => acquired++,
			}).then(
				() => undefined,
				(error: unknown) => error,
			);
			expect(failure).toBeInstanceOf(Error);
			expect(failure).not.toBeInstanceOf(FileLockAcquireError);
			expect((failure as Error).message).toBe(`Failed to publish file lock: invalid ${operation} success receipt.`);
			expect(primary).toBe(1);
			expect(fallback).toBe(operation === "directory" ? 1 : 0);
			expect(entered).toBe(0);
			expect(acquired).toBe(0);
			await expect(fs.lstat(lock)).rejects.toMatchObject({ code: "ENOENT" });
			expect(await fs.readdir(root)).toEqual([]);
		});

		test(`${operation} admits exact success after publication and reacquires`, async () => {
			const { root, file, lock } = await makeFixture();
			let primary = 0;
			let fallback = 0;
			let entered = 0;
			let acquired = 0;
			const owners: string[] = [];
			FileLockTestHooks.nativePublicationBindings = () => ({
				renameNoReplacePathAsync: async (source, destination) => {
					primary++;
					if (operation === "directory") return unsupportedRename();
					await fs.rename(source, destination);
					return valid;
				},
				renameDirectoryNoReplacePathAsync: async (source, destination) => {
					fallback++;
					await fs.rename(source, destination);
					return valid;
				},
			});
			for (let generation = 1; generation <= 2; generation++) {
				await expect(
					withFileLock(
						file,
						async () => {
							entered++;
							owners.push(await Bun.file(path.join(lock, "info")).text());
							await Bun.write(file, `generation ${generation}`);
							return generation;
						},
						{ ...quickAcquire, onAcquired: () => acquired++ },
					),
				).resolves.toBe(generation);
				await expect(fs.lstat(lock)).rejects.toMatchObject({ code: "ENOENT" });
				expect(entered).toBe(generation);
				expect(acquired).toBe(generation);
			}
			expect(primary).toBe(2);
			expect(fallback).toBe(operation === "directory" ? 2 : 0);
			expect(owners[0]).not.toBe(owners[1]);
			expect(await Bun.file(file).text()).toBe("generation 2");
			expect(await fs.readdir(root)).toEqual(["state.json"]);
		});
	}
});

describe.skipIf(process.platform !== "linux")("file lock committed publication reconciliation", () => {
	test("enters once, releases the real tree, and reacquires a new generation", async () => {
		const { root, file, lock } = await makeFixture();
		const publication = installPublicationFailure();
		const removals: string[] = [];
		FileLockTestHooks.nativeQuarantineBindings = () => ({
			snapshotDirectoryTree,
			exactRemoveDirectoryTree: (target, snapshot) => {
				removals.push(target);
				return exactRemoveDirectoryTree(target, snapshot);
			},
		});
		let entered = 0;
		let acquired = 0;
		const owners: string[] = [];
		for (let generation = 1; generation <= 2; generation++) {
			await expect(
				withFileLock(
					file,
					async () => {
						entered++;
						owners.push(await Bun.file(path.join(lock, "info")).text());
						await expect(fs.lstat(publication.source)).rejects.toMatchObject({ code: "ENOENT" });
						await Bun.write(file, `generation ${generation}`);
						return generation;
					},
					{ ...quickAcquire, onAcquired: () => acquired++ },
				),
			).resolves.toBe(generation);
			await expect(fs.lstat(lock)).rejects.toMatchObject({ code: "ENOENT" });
			await expect(fs.lstat(`${lock}.removing`)).rejects.toMatchObject({ code: "ENOENT" });
			expect(entered).toBe(generation);
			expect(acquired).toBe(generation);
		}
		expect(owners[0]).not.toBe(owners[1]);
		expect(publication.primary).toBe(2);
		expect(publication.fallback).toBe(2);
		expect(removals).toEqual([lock, lock]);
		expect(await Bun.file(file).text()).toBe("generation 2");
		expect(await fs.readdir(root)).toEqual(["state.json"]);
	});

	test.each([
		"cloned destination",
		"replaced info inode",
		"changed content",
		"extra entry",
		"missing destination",
	])("refuses and preserves a %s after the committed failure", async mutation => {
		const { root, file, lock } = await makeFixture();
		const displaced = path.join(root, "original-tree");
		let before: NativeDirectoryTreeSnapshot | undefined;
		let retained: NativeDirectoryTreeSnapshot | undefined;
		const publication = installPublicationFailure(async (_source, destination) => {
			before = treeSnapshot(destination);
			if (mutation === "cloned destination") {
				await fs.rename(destination, displaced);
				await fs.cp(displaced, destination, { recursive: true, preserveTimestamps: true });
			} else if (mutation === "replaced info inode") {
				await fs.rename(path.join(destination, "info"), path.join(root, "original-info"));
				await fs.copyFile(path.join(root, "original-info"), path.join(destination, "info"));
			} else if (mutation === "changed content") {
				await Bun.write(path.join(destination, "info"), "changed owner content");
			} else if (mutation === "extra entry") {
				await Bun.write(path.join(destination, "foreign"), "preserve foreign entry");
			} else {
				await fs.rename(destination, displaced);
			}
			retained = treeSnapshot(mutation === "missing destination" ? displaced : destination);
		});
		let entered = 0;
		let acquired = 0;
		await expect(
			withFileLock(file, async () => entered++, { ...quickAcquire, onAcquired: () => acquired++ }),
		).rejects.toThrow();
		expect(entered).toBe(0);
		expect(acquired).toBe(0);
		expect(publication.primary).toBe(1);
		expect(publication.fallback).toBe(1);
		const retainedPath = mutation === "missing destination" ? displaced : lock;
		expect(treeSnapshot(retainedPath)).toEqual(recordedSnapshot(retained));
		expect(await Bun.file(path.join(retainedPath, "info")).text()).toBe(
			mutation === "changed content" ? "changed owner content" : publication.originalInfo,
		);
		if (mutation === "cloned destination") {
			expect(retained?.rootIno).not.toBe(before?.rootIno);
			expect(treeSnapshot(displaced).rootIno).toBe(recordedSnapshot(before).rootIno);
		} else if (mutation === "replaced info inode") {
			expect(retained?.entries.find(entry => entry.relativePath === "info")?.ino).not.toBe(
				before?.entries.find(entry => entry.relativePath === "info")?.ino,
			);
			expect(await Bun.file(path.join(root, "original-info")).text()).toBe(publication.originalInfo);
		} else if (mutation === "extra entry") {
			expect(await Bun.file(path.join(lock, "foreign")).text()).toBe("preserve foreign entry");
		} else if (mutation === "missing destination") {
			await expect(fs.lstat(lock)).rejects.toMatchObject({ code: "ENOENT" });
		}
	});

	test.each([
		"directory",
		"file",
		"dangling symlink",
	])("does not remove a recreated staging %s or enter the callback", async kind => {
		const { root, file, lock } = await makeFixture();
		const absentTarget = path.join(root, "absent-symlink-target");
		let retainedTree: NativeDirectoryTreeSnapshot | undefined;
		let sourceIno = 0n;
		let sourceCtime = 0n;
		const publication = installPublicationFailure(async (source, destination) => {
			if (kind === "directory") {
				await fs.mkdir(source);
				await Bun.write(path.join(source, "foreign"), "recreated staging directory");
			} else if (kind === "file") {
				await Bun.write(source, "recreated staging file");
			} else {
				await fs.symlink(absentTarget, source);
			}
			const sourceState = await fs.lstat(source, { bigint: true });
			sourceIno = sourceState.ino;
			sourceCtime = sourceState.ctimeNs;
			retainedTree = treeSnapshot(destination);
		});
		let entered = 0;
		let acquired = 0;
		await expect(
			withFileLock(file, async () => entered++, { ...quickAcquire, onAcquired: () => acquired++ }),
		).rejects.toThrow();
		expect(entered).toBe(0);
		expect(acquired).toBe(0);
		expect(publication.primary).toBe(1);
		expect(publication.fallback).toBe(1);
		const retainedSource = await fs.lstat(publication.source, { bigint: true });
		expect(retainedSource.ino).toBe(sourceIno);
		expect(retainedSource.ctimeNs).toBe(sourceCtime);
		expect(treeSnapshot(lock)).toEqual(recordedSnapshot(retainedTree));
		expect(await Bun.file(path.join(lock, "info")).text()).toBe(publication.originalInfo);
		if (kind === "directory") {
			expect(retainedSource.isDirectory()).toBe(true);
			expect(await fs.readdir(publication.source)).toEqual(["foreign"]);
			expect(await Bun.file(path.join(publication.source, "foreign")).text()).toBe("recreated staging directory");
		} else if (kind === "file") {
			expect(retainedSource.isFile()).toBe(true);
			expect(await Bun.file(publication.source).text()).toBe("recreated staging file");
		} else {
			expect(retainedSource.isSymbolicLink()).toBe(true);
			expect(await fs.readlink(publication.source)).toBe(absentTarget);
			await expect(fs.lstat(absentTarget)).rejects.toMatchObject({ code: "ENOENT" });
		}
	});

	const invalidCommittedResults: [string, unknown][] = [
		["missing fields", { ok: false, code: "destination_identity_changed" }],
		["contradictory success", { ...committedIdentityFailure(), ok: true }],
		["wrong code", { ...committedIdentityFailure(), code: "identity_mismatch" }],
		["unknown mutation", { ...committedIdentityFailure(), mutationState: "unknown" }],
		["uncommitted mutation", { ...committedIdentityFailure(), mutationState: "not_committed" }],
		["wrong durability", { ...committedIdentityFailure(), durabilityState: "not_attempted" }],
		["wrong reason", { ...committedIdentityFailure(), reason: "io_failure" }],
		["wrong primitive", { ...committedIdentityFailure(), primitive: "renameat2_noreplace" }],
		["wrong phase", { ...committedIdentityFailure(), phase: "rename" }],
		["missing diagnostic", { ...committedIdentityFailure(), diagnostic: undefined }],
		[
			"wrong diagnostic schema",
			{ ...committedIdentityFailure(), diagnostic: { schemaVersion: 2, collectionState: "unavailable" } },
		],
		["extra receipt field", { ...committedIdentityFailure(), retainedSuccessorPath: "foreign" }],
	];
	test.each(invalidCommittedResults)("does not reconcile or republish a fallback with %s", async (_label, result) => {
		const { file, lock } = await makeFixture();
		let retained: NativeDirectoryTreeSnapshot | undefined;
		const publication = installPublicationFailure(async (_source, destination) => {
			retained = treeSnapshot(destination);
		}, result);
		let entered = 0;
		let acquired = 0;
		await expect(
			withFileLock(file, async () => entered++, { ...quickAcquire, onAcquired: () => acquired++ }),
		).rejects.toThrow();
		expect(entered).toBe(0);
		expect(acquired).toBe(0);
		expect(publication.primary).toBe(1);
		expect(publication.fallback).toBe(1);
		expect(treeSnapshot(lock)).toEqual(recordedSnapshot(retained));
		expect(await Bun.file(path.join(lock, "info")).text()).toBe(publication.originalInfo);
	});

	const successShapedResults: [string, unknown][] = [
		[
			"failure-coded",
			{
				...committedIdentityFailure(),
				ok: true,
				code: "destination_identity_changed",
				reason: "none",
				phase: "complete",
			},
		],
		[
			"unsupported-primitive",
			{ ...committedIdentityFailure(), ok: true, primitive: "unsupported", reason: "none", phase: "complete" },
		],
		[
			"unknown-primitive",
			{ ...committedIdentityFailure(), ok: true, primitive: "unknown", reason: "none", phase: "complete" },
		],
		[
			"partial-diagnostic",
			{
				...committedIdentityFailure(),
				ok: true,
				reason: "none",
				phase: "complete",
				diagnostic: { schemaVersion: 1, collectionState: "partial" },
			},
		],
		[
			"extended-diagnostic",
			{
				...committedIdentityFailure(),
				ok: true,
				reason: "none",
				phase: "complete",
				diagnostic: { schemaVersion: 1, collectionState: "complete", osCode: 7 },
			},
		],
	];
	test.each(
		successShapedResults,
	)("does not enter after a fallback success-shaped %s receipt", async (_label, result) => {
		const { file, lock } = await makeFixture();
		let retained: NativeDirectoryTreeSnapshot | undefined;
		const publication = installPublicationFailure(async (_source, destination) => {
			retained = treeSnapshot(destination);
		}, result);
		let entered = 0;
		let acquired = 0;
		await expect(
			withFileLock(file, async () => entered++, { ...quickAcquire, onAcquired: () => acquired++ }),
		).rejects.toThrow();
		expect(entered).toBe(0);
		expect(acquired).toBe(0);
		expect(publication.primary).toBe(1);
		expect(publication.fallback).toBe(1);
		expect(treeSnapshot(lock)).toEqual(recordedSnapshot(retained));
		expect(await Bun.file(path.join(lock, "info")).text()).toBe(publication.originalInfo);
	});

	test.each(
		successShapedResults,
	)("does not enter after a primary success-shaped %s receipt", async (_label, result) => {
		const { root, file, lock } = await makeFixture();
		let primary = 0;
		let fallback = 0;
		let entered = 0;
		let acquired = 0;
		FileLockTestHooks.nativePublicationBindings = () => ({
			renameNoReplacePathAsync: async () => {
				primary++;
				return result as NativeNoReplaceResult;
			},
			renameDirectoryNoReplacePathAsync: async (source, destination) => {
				fallback++;
				return await renameDirectoryNoReplacePathAsync(source, destination);
			},
		});
		await expect(
			withFileLock(file, async () => entered++, { ...quickAcquire, onAcquired: () => acquired++ }),
		).rejects.toThrow();
		expect(primary).toBe(1);
		expect(fallback).toBe(0);
		expect(entered).toBe(0);
		expect(acquired).toBe(0);
		await expect(fs.lstat(lock)).rejects.toMatchObject({ code: "ENOENT" });
		expect(await fs.readdir(root)).toEqual([]);
	});

	const invalidPrimaryResults: [string, unknown][] = [
		["incomplete failure", { ok: false, code: "invalid_request" }],
		["contradictory success", { ...unsupportedRename(), ok: true }],
		["committed failure", { ...unsupportedRename(), mutationState: "committed" }],
		["wrong code", { ...unsupportedRename(), code: "identity_mismatch" }],
		["wrong phase", { ...unsupportedRename(), phase: "terminal_identity" }],
		["wrong primitive", { ...unsupportedRename(), primitive: "mkdirat_renameat_noreplace" }],
		["missing diagnostic", { ...unsupportedRename(), diagnostic: undefined }],
	];
	test.each(invalidPrimaryResults)("does not fall back or enter after a primary %s", async (_label, result) => {
		const { root, file, lock } = await makeFixture();
		let primary = 0;
		let fallback = 0;
		let entered = 0;
		let acquired = 0;
		FileLockTestHooks.nativePublicationBindings = () => ({
			renameNoReplacePathAsync: async () => {
				primary++;
				return result as NativeNoReplaceResult;
			},
			renameDirectoryNoReplacePathAsync: async (source, destination) => {
				fallback++;
				return await renameDirectoryNoReplacePathAsync(source, destination);
			},
		});
		await expect(
			withFileLock(file, async () => entered++, { ...quickAcquire, onAcquired: () => acquired++ }),
		).rejects.toThrow();
		expect(primary).toBe(1);
		expect(fallback).toBe(0);
		expect(entered).toBe(0);
		expect(acquired).toBe(0);
		await expect(fs.lstat(lock)).rejects.toMatchObject({ code: "ENOENT" });
		expect(await fs.readdir(root)).toEqual([]);
	});

	test("propagates a protected callback failure after recovery and still releases", async () => {
		const { root, file } = await makeFixture();
		const publication = installPublicationFailure();
		const failure = new Error("protected operation failed");
		let entered = 0;
		await expect(
			withFileLock(
				file,
				async () => {
					entered++;
					throw failure;
				},
				quickAcquire,
			),
		).rejects.toBe(failure);
		expect(entered).toBe(1);
		expect(publication.primary).toBe(1);
		expect(publication.fallback).toBe(1);
		expect(await fs.readdir(root)).toEqual([]);
		await withFileLock(file, async () => entered++, quickAcquire);
		expect(entered).toBe(2);
		expect(await fs.readdir(root)).toEqual([]);
	});

	test("propagates onAcquired failure without retrying or entering protected work", async () => {
		const { file, lock } = await makeFixture();
		const publication = installPublicationFailure();
		const failure = Object.assign(new Error("acquisition callback failed"), { code: "EACCES" });
		let acquired = 0;
		let entered = 0;
		await expect(
			withFileLock(file, async () => entered++, {
				...quickAcquire,
				onAcquired: () => {
					acquired++;
					throw failure;
				},
			}),
		).rejects.toBe(failure);
		expect(acquired).toBe(1);
		expect(entered).toBe(0);
		expect(publication.primary).toBe(1);
		expect(publication.fallback).toBe(1);
		expect(await fs.readdir(lock)).toEqual(["info"]);
		expect(await Bun.file(path.join(lock, "info")).text()).toBe(publication.originalInfo);
	});

	test("preserves a preexisting removal transition without invoking publication", async () => {
		const { file, lock } = await makeFixture();
		await fs.mkdir(`${lock}.removing`);
		await Bun.write(path.join(`${lock}.removing`, "info"), "foreign predecessor");
		const retained = treeSnapshot(`${lock}.removing`);
		const publication = installPublicationFailure();
		let entered = 0;
		await expect(withFileLock(file, async () => entered++, quickAcquire)).rejects.toBeInstanceOf(
			FileLockAcquireError,
		);
		expect(entered).toBe(0);
		expect(publication.primary).toBe(0);
		expect(publication.fallback).toBe(0);
		expect(treeSnapshot(`${lock}.removing`)).toEqual(retained);
		expect(await Bun.file(path.join(`${lock}.removing`, "info")).text()).toBe("foreign predecessor");
	});

	test("rolls back a reconciled publication when a removal transition appeared during fallback", async () => {
		const { root, file, lock } = await makeFixture();
		let retained: NativeDirectoryTreeSnapshot | undefined;
		const publication = installPublicationFailure(async (_source, destination) => {
			await fs.mkdir(`${destination}.removing`);
			await Bun.write(path.join(`${destination}.removing`, "info"), "foreign predecessor");
			retained = treeSnapshot(`${destination}.removing`);
		});
		let entered = 0;
		let acquired = 0;
		await expect(
			withFileLock(file, async () => entered++, { ...quickAcquire, onAcquired: () => acquired++ }),
		).rejects.toBeInstanceOf(FileLockAcquireError);
		expect(entered).toBe(0);
		expect(acquired).toBe(0);
		expect(publication.primary).toBe(1);
		expect(publication.fallback).toBe(1);
		await expect(fs.lstat(lock)).rejects.toMatchObject({ code: "ENOENT" });
		await expect(fs.lstat(publication.source)).rejects.toMatchObject({ code: "ENOENT" });
		expect(treeSnapshot(`${lock}.removing`)).toEqual(recordedSnapshot(retained));
		expect(await Bun.file(path.join(`${lock}.removing`, "info")).text()).toBe("foreign predecessor");
		expect(await fs.readdir(root)).toEqual([path.basename(`${lock}.removing`)]);
	});
});

describe.skipIf(process.platform !== "linux")("file lock retained removal reconciliation", () => {
	test("verifies the original full tree, removes the sibling once, and reacquires", async () => {
		const { root, file, lock } = await makeFixture();
		const publication = installPublicationFailure();
		const calls: RemovalCall[] = [];
		FileLockTestHooks.nativeQuarantineBindings = () => ({
			snapshotDirectoryTree,
			exactRemoveDirectoryTree: (target, snapshot) => {
				calls.push({ path: target, snapshot });
				if (target === lock) {
					syncFs.renameSync(target, `${target}.removing`);
					return retainedIdentityFailure(`${target}.removing`);
				}
				expect(target).toBe(`${lock}.removing`);
				expect(snapshot).toEqual(treeSnapshot(target));
				const original = calls[calls.length - 2]?.snapshot;
				expect(snapshot.rootDev).toBe(original?.rootDev);
				expect(snapshot.rootIno).toBe(original?.rootIno);
				expect(snapshot.entries.filter(entry => entry.relativePath !== "")).toEqual(
					original?.entries.filter(entry => entry.relativePath !== ""),
				);
				const result = exactRemoveDirectoryTree(target, snapshot);
				expect(result).toEqual({
					ok: false,
					code: "cleanup_pending",
					payloadDurable: true,
					detachedPath: target,
				});
				return result;
			},
		});
		let entered = 0;
		for (let generation = 1; generation <= 2; generation++) {
			await withFileLock(file, async () => entered++, quickAcquire);
			expect(entered).toBe(generation);
			expect(calls.length).toBe(generation * 2);
			expect(await fs.readdir(root)).toEqual([]);
		}
		expect(calls.map(call => call.path)).toEqual([lock, `${lock}.removing`, lock, `${lock}.removing`]);
		expect(publication.primary).toBe(2);
		expect(publication.fallback).toBe(2);
	});

	test.each([
		"cloned tree",
		"replaced info inode",
		"changed content",
		"extra entry",
	])("preserves a retained sibling with a %s and never retries removal", async mutation => {
		const { root, file, lock } = await makeFixture();
		const displaced = path.join(root, "original-tree");
		let retained: NativeDirectoryTreeSnapshot | undefined;
		const publication = installPublicationFailure();
		const calls = installRetainedRelease(retainedPath => {
			if (mutation === "cloned tree") {
				syncFs.renameSync(retainedPath, displaced);
				syncFs.cpSync(displaced, retainedPath, { recursive: true, preserveTimestamps: true });
			} else if (mutation === "replaced info inode") {
				syncFs.renameSync(path.join(retainedPath, "info"), path.join(root, "original-info"));
				syncFs.copyFileSync(path.join(root, "original-info"), path.join(retainedPath, "info"));
			} else if (mutation === "changed content") {
				syncFs.writeFileSync(path.join(retainedPath, "info"), "changed retained owner");
			} else {
				syncFs.writeFileSync(path.join(retainedPath, "foreign"), "preserve retained entry");
			}
			retained = treeSnapshot(retainedPath);
			return retainedIdentityFailure(retainedPath);
		});
		let entered = 0;
		await expect(withFileLock(file, async () => entered++, quickAcquire)).rejects.toThrow();
		expect(entered).toBe(1);
		expect(calls.map(call => call.path)).toEqual([lock]);
		expect(publication.primary).toBe(1);
		expect(publication.fallback).toBe(1);
		expect(treeSnapshot(`${lock}.removing`)).toEqual(recordedSnapshot(retained));
		expect(await Bun.file(path.join(`${lock}.removing`, "info")).text()).toBe(
			mutation === "changed content" ? "changed retained owner" : publication.originalInfo,
		);
		if (mutation === "cloned tree") {
			expect(retained?.rootIno).not.toBe(calls[0]?.snapshot.rootIno);
			expect(await Bun.file(path.join(displaced, "info")).text()).toBe(publication.originalInfo);
		} else if (mutation === "replaced info inode") {
			expect(retained?.entries.find(entry => entry.relativePath === "info")?.ino).not.toBe(
				calls[0]?.snapshot.entries.find(entry => entry.relativePath === "info")?.ino,
			);
		} else if (mutation === "extra entry") {
			expect(await Bun.file(path.join(`${lock}.removing`, "foreign")).text()).toBe("preserve retained entry");
		}
	});

	test.each([
		"different retained path",
		"detachedPath",
		"retainedUnknownPath",
		"retainedPlaceholderPath",
		"payloadDurable",
		"wrong code",
	])("refuses an ambiguous release receipt with %s without touching either tree", async field => {
		const { root, file, lock } = await makeFixture();
		const foreign = path.join(root, "foreign-tree");
		await fs.mkdir(foreign);
		await Bun.write(path.join(foreign, "info"), "foreign tree must survive");
		const foreignBefore = treeSnapshot(foreign);
		let retained: NativeDirectoryTreeSnapshot | undefined;
		const publication = installPublicationFailure();
		const calls = installRetainedRelease(retainedPath => {
			retained = treeSnapshot(retainedPath);
			const receipt = retainedIdentityFailure(retainedPath);
			if (field === "different retained path") return { ...receipt, retainedSuccessorPath: foreign };
			if (field === "payloadDurable") return { ...receipt, payloadDurable: true };
			if (field === "wrong code") return { ...receipt, code: "detached_failure" };
			return { ...receipt, [field]: foreign };
		});
		let entered = 0;
		await expect(withFileLock(file, async () => entered++, quickAcquire)).rejects.toThrow();
		expect(entered).toBe(1);
		expect(calls.map(call => call.path)).toEqual([lock]);
		expect(publication.primary).toBe(1);
		expect(publication.fallback).toBe(1);
		expect(treeSnapshot(`${lock}.removing`)).toEqual(recordedSnapshot(retained));
		expect(await Bun.file(path.join(`${lock}.removing`, "info")).text()).toBe(publication.originalInfo);
		expect(treeSnapshot(foreign)).toEqual(foreignBefore);
		expect(await Bun.file(path.join(foreign, "info")).text()).toBe("foreign tree must survive");
	});

	test.each([
		"identity mismatch",
		"I/O error",
		"missing durable evidence",
		"false durable evidence",
		"missing detached path",
		"foreign detached path",
		"canonical detached path",
		"retained successor",
		"retained placeholder",
		"retained unknown",
		"undefined extra field",
		"contradictory success",
	])("preserves all trees when the single removal replay reports %s", async failure => {
		const { root, file, lock } = await makeFixture();
		const retainedPath = `${lock}.removing`;
		const foreign = path.join(root, "foreign-tree");
		const successor = path.join(root, "successor-staging");
		await fs.mkdir(foreign);
		await Bun.write(path.join(foreign, "info"), "foreign detached path");
		await fs.mkdir(successor);
		await Bun.write(path.join(successor, "info"), "canonical successor must survive");
		const foreignBefore = treeSnapshot(foreign);
		let retainedBefore: NativeDirectoryTreeSnapshot | undefined;
		let successorBefore: NativeDirectoryTreeSnapshot | undefined;
		const publication = installPublicationFailure();
		const calls: string[] = [];
		FileLockTestHooks.nativeQuarantineBindings = () => ({
			snapshotDirectoryTree,
			exactRemoveDirectoryTree: (target, snapshot) => {
				calls.push(target);
				if (calls.length === 1) {
					syncFs.renameSync(target, retainedPath);
					retainedBefore = treeSnapshot(retainedPath);
					return retainedIdentityFailure(retainedPath);
				}
				expect(target).toBe(retainedPath);
				expect(snapshot).toEqual(recordedSnapshot(retainedBefore));
				// A newer canonical generation exists before the failed replay returns.
				syncFs.renameSync(successor, lock);
				successorBefore = treeSnapshot(lock);
				const receipt: NativeExactUnlinkResult = {
					ok: false,
					code: "cleanup_pending",
					payloadDurable: true,
					detachedPath: retainedPath,
				};
				switch (failure) {
					case "identity mismatch":
						receipt.code = "identity_mismatch";
						break;
					case "I/O error":
						receipt.code = "io_error";
						break;
					case "missing durable evidence":
						delete receipt.payloadDurable;
						break;
					case "false durable evidence":
						receipt.payloadDurable = false;
						break;
					case "missing detached path":
						delete receipt.detachedPath;
						break;
					case "foreign detached path":
						receipt.detachedPath = foreign;
						break;
					case "canonical detached path":
						receipt.detachedPath = lock;
						break;
					case "retained successor":
						receipt.retainedSuccessorPath = lock;
						break;
					case "retained placeholder":
						receipt.retainedPlaceholderPath = foreign;
						break;
					case "retained unknown":
						receipt.retainedUnknownPath = foreign;
						break;
					case "undefined extra field":
						receipt.retainedUnknownPath = undefined;
						break;
					case "contradictory success":
						receipt.ok = true;
						break;
				}
				return receipt;
			},
		});
		let entered = 0;
		await expect(withFileLock(file, async () => entered++, quickAcquire)).rejects.toThrow();
		expect(entered).toBe(1);
		expect(calls).toEqual([lock, retainedPath]);
		expect(publication.primary).toBe(1);
		expect(publication.fallback).toBe(1);
		expect(treeSnapshot(retainedPath)).toEqual(recordedSnapshot(retainedBefore));
		expect(await Bun.file(path.join(retainedPath, "info")).text()).toBe(publication.originalInfo);
		expect(treeSnapshot(lock)).toEqual(recordedSnapshot(successorBefore));
		expect(await Bun.file(path.join(lock, "info")).text()).toBe("canonical successor must survive");
		expect(treeSnapshot(foreign)).toEqual(foreignBefore);
		expect(await Bun.file(path.join(foreign, "info")).text()).toBe("foreign detached path");
	});

	test("does not recursively reconcile a second retained-successor failure", async () => {
		const { file, lock } = await makeFixture();
		const publication = installPublicationFailure();
		const calls: string[] = [];
		let retained: NativeDirectoryTreeSnapshot | undefined;
		FileLockTestHooks.nativeQuarantineBindings = () => ({
			snapshotDirectoryTree,
			exactRemoveDirectoryTree: (target, snapshot) => {
				calls.push(target);
				if (calls.length > 2) return exactRemoveDirectoryTree(target, snapshot);
				const retainedPath = `${target}.removing`;
				syncFs.renameSync(target, retainedPath);
				if (calls.length === 2) retained = treeSnapshot(retainedPath);
				return retainedIdentityFailure(retainedPath);
			},
		});
		let entered = 0;
		await expect(withFileLock(file, async () => entered++, quickAcquire)).rejects.toThrow();
		expect(entered).toBe(1);
		expect(calls).toEqual([lock, `${lock}.removing`]);
		expect(publication.primary).toBe(1);
		expect(publication.fallback).toBe(1);
		expect(treeSnapshot(`${lock}.removing.removing`)).toEqual(recordedSnapshot(retained));
		expect(await Bun.file(path.join(`${lock}.removing.removing`, "info")).text()).toBe(publication.originalInfo);
	});
});

const drvfsRoot = process.env.GJC_TEST_DRVFS_ROOT;
test.skipIf(process.platform !== "linux" || !drvfsRoot)(
	"real DrvFS filesystem acquires, writes, releases, and reacquires without lock remnants",
	async () => {
		if (!drvfsRoot) throw new Error("GJC_TEST_DRVFS_ROOT must name a disposable fixture parent");
		const { root, file, lock } = await makeFixture(drvfsRoot);
		const calls = { primary: 0, fallback: 0, snapshot: 0, removal: 0 };
		FileLockTestHooks.nativePublicationBindings = () => ({
			renameNoReplacePathAsync: async (source, destination) => {
				calls.primary++;
				return await renameNoReplacePathAsync(source, destination);
			},
			renameDirectoryNoReplacePathAsync: async (source, destination) => {
				calls.fallback++;
				return await renameDirectoryNoReplacePathAsync(source, destination);
			},
		});
		FileLockTestHooks.nativeQuarantineBindings = () => ({
			snapshotDirectoryTree: target => {
				calls.snapshot++;
				return snapshotDirectoryTree(target);
			},
			exactRemoveDirectoryTree: (target, snapshot) => {
				calls.removal++;
				return exactRemoveDirectoryTree(target, snapshot);
			},
		});
		let acquired = 0;
		const owners: string[] = [];
		for (let generation = 1; generation <= 2; generation++) {
			const release = await acquireFileLock(file, { ...quickAcquire, onAcquired: () => acquired++ });
			try {
				owners.push(await Bun.file(path.join(lock, "info")).text());
				await Bun.write(file, `real filesystem generation ${generation}`);
				expect(await Bun.file(file).text()).toBe(`real filesystem generation ${generation}`);
			} finally {
				await release();
			}
			expect(acquired).toBe(generation);
			await expect(fs.lstat(lock)).rejects.toMatchObject({ code: "ENOENT" });
			await expect(fs.lstat(`${lock}.removing`)).rejects.toMatchObject({ code: "ENOENT" });
			expect(await fs.readdir(root)).toEqual(["state.json"]);
		}
		expect(owners[0]).not.toBe(owners[1]);
		expect(calls.primary).toBe(2);
		expect(calls.fallback).toBeLessThanOrEqual(2);
		expect(calls.snapshot).toBeGreaterThanOrEqual(2);
		expect(calls.removal).toBeGreaterThanOrEqual(2);
	},
	15_000,
);
