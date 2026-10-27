import { afterEach, describe, expect, test, vi } from "bun:test";
import * as crypto from "node:crypto";
import * as syncFs from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	acquireFileLock,
	describeRetainedLockTransition,
	FileLockAcquireError,
	FileLockTestHooks,
	fileLockStagingOwnerPid,
	isFileLockAcquireTimeout,
	reapOrphanedLockStagingDirs,
	withFileLock,
} from "@gajae-code/coding-agent/config/file-lock";
import {
	exactRemoveDirectoryTree,
	exactUnlinkOpenFile,
	type NativeDirectoryTreeSnapshot,
	type NativeExactUnlinkResult,
	type NativeNoReplaceResult,
	RecoveryFsRoot,
	renameDirectoryNoReplacePathAsync,
	renameNoReplacePathAsync,
	snapshotDirectoryTree,
} from "@gajae-code/natives";
import { registerOwnedDeletionRoot } from "../../../scripts/safe-cleanup";
import { sessionIndexStartupLockOptions } from "../src/sdk/broker/session-index";

const tempDirs: { directory: string; forgetGrant: () => void }[] = [];
const quickAcquire = { retries: 3, retryDelayMs: 1 };
const expectedBoundedPublicationCalls = 3;

function sessionIndexRetryBudget() {
	return sessionIndexStartupLockOptions(performance.now() + 60_000, undefined, "authorized-successor");
}

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
	FileLockTestHooks.afterRemovalTransitionMissing = undefined;
	FileLockTestHooks.afterRemovalOwnerPublish = undefined;
	FileLockTestHooks.beforeRemovalRecordUnlink = undefined;
	FileLockTestHooks.nativePublicationBindings = undefined;
	FileLockTestHooks.stagingIdentityEvidence = undefined;
	FileLockTestHooks.stagingRootIdentity = undefined;
	FileLockTestHooks.processIncarnation = undefined;
	FileLockTestHooks.nativeQuarantineBindings = undefined;
	FileLockTestHooks.cleanupPendingStaging = undefined;
	FileLockTestHooks.afterStagingInfoWrite = undefined;
	FileLockTestHooks.stagingInfoIdentity = undefined;
	FileLockTestHooks.stagingInfoCleanup = undefined;
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

function exactRemoveStagingSnapshotForTest(
	target: string,
	expected: NativeDirectoryTreeSnapshot,
	_parentIdentity?: { dev: bigint; ino: bigint },
	detachOnly?: boolean,
): NativeExactUnlinkResult {
	const current = snapshotDirectoryTree(target);
	// Renaming a tree updates ctime; compare the identity-bearing fields only.
	const normalize = (snapshot: NativeDirectoryTreeSnapshot) => ({
		rootDev: snapshot.rootDev,
		rootIno: snapshot.rootIno,
		entries: snapshot.entries.map(entry => ({
			relativePath: entry.relativePath,
			kind: entry.kind,
			dev: entry.dev,
			ino: entry.ino,
			nlink: entry.nlink,
			size: entry.size,
			sha256: entry.sha256,
		})),
	});
	if (
		!current.ok ||
		!current.snapshot ||
		JSON.stringify(normalize(current.snapshot)) !== JSON.stringify(normalize(expected))
	)
		return { ok: false, code: "identity_mismatch" };
	if (detachOnly && !target.endsWith(".removing")) {
		const detachedPath = `${target}.removing`;
		syncFs.renameSync(target, detachedPath);
		return { ok: true, detachedPath };
	}
	syncFs.rmSync(target, { recursive: true, force: true });
	return { ok: true };
}

async function deadPid(): Promise<number> {
	const child = Bun.spawn(["sh", "-c", "exit 0"], { stdout: "ignore", stderr: "ignore" });
	await child.exited;
	return child.pid;
}

async function waitForAbsence(target: string, timeoutMs = 5_000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!(await fs.exists(target))) return true;
		await Bun.sleep(10);
	}
	return !(await fs.exists(target));
}

function removalInfo(
	pid: number,
	ownerHostId?: string,
	identity: { process_incarnation?: string; start_time?: string; start_time_format?: string } = {},
): string {
	return JSON.stringify({
		pid,
		timestamp: Date.now(),
		owner_token: crypto.randomUUID(),
		...(ownerHostId === undefined ? {} : { owner_host_id: ownerHostId }),
		...identity,
	});
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

function sharingViolationPublication(): NativeNoReplaceResult {
	return {
		ok: false,
		code: "sharing_violation",
		mutationState: "not_committed",
		durabilityState: "not_attempted",
		reason: "sharing_violation",
		primitive: "windows_rename_noreplace",
		phase: "rename",
		diagnostic: { schemaVersion: 1, collectionState: "unavailable" },
	};
}

function accessDeniedPublication(): NativeNoReplaceResult {
	return {
		ok: false,
		code: "access_denied",
		mutationState: "not_committed",
		durabilityState: "not_attempted",
		reason: "access_denied",
		primitive: "windows_rename_noreplace",
		phase: "rename",
		diagnostic: { schemaVersion: 1, collectionState: "unavailable" },
	};
}

function destinationExistsPublication(): NativeNoReplaceResult {
	return {
		ok: false,
		code: "quarantine_collision",
		mutationState: "not_committed",
		durabilityState: "not_attempted",
		reason: "destination_exists",
		primitive: "windows_rename_noreplace",
		phase: "rename",
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

describe.skipIf(process.platform !== "linux")("file lock receipt producer validation", () => {
	test("accepts the native receipt when ambient platform metadata is spoofed", async () => {
		const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
		if (!descriptor?.configurable) throw new Error("process_platform_not_configurable");
		const { file, lock } = await makeFixture();
		FileLockTestHooks.nativePublicationBindings = () => ({
			renameNoReplacePathAsync: async (source, destination) => {
				await fs.rename(source, destination);
				return successfulPublication("renameat2_noreplace");
			},
			renameDirectoryNoReplacePathAsync: async () => {
				throw new Error("unexpected directory publication fallback");
			},
		});
		try {
			Object.defineProperty(process, "platform", { ...descriptor, value: "darwin" });
			await expect(withFileLock(file, async () => "entered", quickAcquire)).resolves.toBe("entered");
		} finally {
			Object.defineProperty(process, "platform", descriptor);
		}
		await expect(fs.lstat(lock)).rejects.toMatchObject({ code: "ENOENT" });
	});

	test("rejects a receipt whose primitive does not match the requested operation", async () => {
		const { file, lock } = await makeFixture();
		FileLockTestHooks.nativePublicationBindings = () => ({
			renameNoReplacePathAsync: async (source, destination) => {
				await fs.rename(source, destination);
				return successfulPublication("mkdirat_renameat_noreplace");
			},
			renameDirectoryNoReplacePathAsync: async () => {
				throw new Error("unexpected directory publication fallback");
			},
		});
		await expect(withFileLock(file, async () => "entered", quickAcquire)).rejects.toThrow(
			"invalid primary success receipt",
		);
		await expect(fs.lstat(lock)).resolves.toBeTruthy();
	});

	test("drains a failed rollback release before same-process reacquisition replaces its state", async () => {
		vi.useFakeTimers();
		try {
			const { file, lock } = await makeFixture();
			const transition = `${lock}.removing`;
			const publication = installPublicationFailure(async (_source, destination) => {
				await fs.mkdir(`${destination}.removing`);
				await Bun.write(path.join(`${destination}.removing`, "info"), "foreign predecessor");
			});
			const closeAuthority = RecoveryFsRoot.prototype.close;
			const closeSpy = vi.spyOn(RecoveryFsRoot.prototype, "close").mockImplementation(function (
				this: RecoveryFsRoot,
			) {
				closeAuthority.call(this);
				throw new Error("injected close failure after committed rollback");
			});

			await expect(withFileLock(file, async () => undefined, quickAcquire)).rejects.toThrow(
				"File lock rollback authority failed",
			);
			expect(closeSpy).toHaveBeenCalledTimes(1);
			expect(publication.source).not.toBe("");

			closeSpy.mockRestore();
			FileLockTestHooks.nativePublicationBindings = undefined;
			await fs.rm(transition, { recursive: true, force: true });

			const release = await acquireFileLock(file, quickAcquire);
			try {
				await expect(fs.lstat(publication.source)).rejects.toMatchObject({ code: "ENOENT" });
			} finally {
				await release();
			}
		} finally {
			vi.useRealTimers();
		}
	});
});

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
		const primaryPrimitives = new Set<NativeNoReplaceResult["primitive"]>([
			"renameat2_noreplace",
			"renameatx_np_excl",
			"windows_rename_noreplace",
		]);
		const invalidResults: [string, NativeNoReplaceResult][] = primitives
			.filter(primitive => (operation === "primary" ? !primaryPrimitives.has(primitive) : primitive !== expected))
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
		test.each(invalidResults)(
			`${operation} refuses %s even when a second call would publish`,
			async (_label, result) => {
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
				expect((failure as Error).message).toBe(
					`Failed to publish file lock: invalid ${operation} success receipt.`,
				);
				expect(primary).toBe(1);
				expect(fallback).toBe(operation === "directory" ? 1 : 0);
				expect(entered).toBe(0);
				expect(acquired).toBe(0);
				await expect(fs.lstat(lock)).rejects.toMatchObject({ code: "ENOENT" });
				expect(await fs.readdir(root)).toEqual([]);
			},
		);

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

test("retries a pre-mutation sharing violation and publishes the file lock", async () => {
	const { root, file, lock } = await makeFixture();
	let attempts = 0;
	FileLockTestHooks.nativePublicationBindings = () => ({
		renameNoReplacePathAsync: async (source, destination) => {
			attempts++;
			if (attempts < 3) return sharingViolationPublication();
			await fs.rename(source, destination);
			return successfulPublication(primaryPrimitive ?? "windows_rename_noreplace");
		},
		renameDirectoryNoReplacePathAsync,
	});

	await expect(
		withFileLock(file, async () => await Bun.file(path.join(lock, "info")).text(), quickAcquire),
	).resolves.toContain('"pid"');
	expect(attempts).toBe(3);
	await expect(fs.lstat(lock)).rejects.toMatchObject({ code: "ENOENT" });
	expect(await fs.readdir(root)).toEqual([]);
});

test("retries a transient pre-mutation access denial and publishes the file lock", async () => {
	const { root, file, lock } = await makeFixture();
	let attempts = 0;
	FileLockTestHooks.nativePublicationBindings = () => ({
		renameNoReplacePathAsync: async (source, destination) => {
			attempts++;
			if (attempts < 3) return accessDeniedPublication();
			await fs.rename(source, destination);
			return successfulPublication(primaryPrimitive ?? "windows_rename_noreplace");
		},
		renameDirectoryNoReplacePathAsync,
	});

	await expect(
		withFileLock(file, async () => await Bun.file(path.join(lock, "info")).text(), quickAcquire),
	).resolves.toContain('"pid"');
	expect(attempts).toBe(3);
	await expect(fs.lstat(lock)).rejects.toMatchObject({ code: "ENOENT" });
	expect(await fs.readdir(root)).toEqual([]);
});

test("does not retry access-denied receipts without Windows rename provenance", async () => {
	const { root, file, lock } = await makeFixture();
	let attempts = 0;
	FileLockTestHooks.nativePublicationBindings = () => ({
		renameNoReplacePathAsync: async () => {
			attempts++;
			return { ...accessDeniedPublication(), primitive: "renameat2_noreplace" };
		},
		renameDirectoryNoReplacePathAsync,
	});

	await expect(withFileLock(file, async () => "entered", quickAcquire)).rejects.toMatchObject({
		message: "Failed to publish file lock: access_denied.",
		code: "access_denied",
	});
	expect(attempts).toBe(1);
	await expect(fs.lstat(lock)).rejects.toMatchObject({ code: "ENOENT" });
	expect(await fs.readdir(root)).toEqual([]);
});

test("bounds persistent access-denied retries independently of the session-index acquisition budget", async () => {
	const { root, file, lock } = await makeFixture();
	let attempts = 0;
	let contentionNotifications = 0;
	const retryBudget = sessionIndexRetryBudget();
	expect(retryBudget.retries).toBe(600);
	expect(retryBudget.retryDelayMs).toBe(100);
	FileLockTestHooks.nativePublicationBindings = () => ({
		renameNoReplacePathAsync: async () => {
			attempts++;
			return accessDeniedPublication();
		},
		renameDirectoryNoReplacePathAsync,
	});

	const failure = await acquireFileLock(file, {
		...retryBudget,
		onContended: () => contentionNotifications++,
	}).then(
		() => undefined,
		(error: unknown) => error,
	);
	expect(failure).toBeInstanceOf(FileLockAcquireError);
	if (!(failure instanceof FileLockAcquireError)) throw new Error("expected file lock acquisition failure");
	expect(failure.publicationFailureCode).toBe("access_denied");
	expect(isFileLockAcquireTimeout(failure)).toBe(false);
	expect(failure.holderIsLive).toBe(false);
	expect(failure.message).not.toContain("SDK broker");
	expect(failure.attempts).toBe(2);
	expect(attempts).toBe(expectedBoundedPublicationCalls * 2);
	expect(contentionNotifications).toBe(0);
	await expect(fs.lstat(lock)).rejects.toMatchObject({ code: "ENOENT" });
	expect(await fs.readdir(root)).toEqual([]);
});

test("recovers when access-denied publication clears within the outer acquisition budget", async () => {
	const { root, file, lock } = await makeFixture();
	let attempts = 0;
	let contentionNotifications = 0;
	const retryBudget = sessionIndexRetryBudget();
	FileLockTestHooks.nativePublicationBindings = () => ({
		renameNoReplacePathAsync: async (source, destination) => {
			attempts++;
			if (attempts <= expectedBoundedPublicationCalls) return accessDeniedPublication();
			await fs.rename(source, destination);
			return successfulPublication(primaryPrimitive ?? "windows_rename_noreplace");
		},
		renameDirectoryNoReplacePathAsync,
	});

	await expect(
		withFileLock(file, async () => "entered", {
			...retryBudget,
			onContended: () => contentionNotifications++,
		}),
	).resolves.toBe("entered");
	expect(attempts).toBe(expectedBoundedPublicationCalls + 1);
	expect(contentionNotifications).toBe(0);
	await expect(fs.lstat(lock)).rejects.toMatchObject({ code: "ENOENT" });
	expect(await fs.readdir(root)).toEqual([]);
});

test("classifies access-denied exhaustion as timeout when a holder is proven live", async () => {
	const { file, lock } = await makeFixture();
	const liveIncarnation = "current-live-incarnation";
	FileLockTestHooks.processIncarnation = () => liveIncarnation;
	await fs.mkdir(lock);
	await Bun.write(
		path.join(lock, "info"),
		removalInfo(process.pid, undefined, { process_incarnation: liveIncarnation }),
	);
	FileLockTestHooks.nativePublicationBindings = () => ({
		renameNoReplacePathAsync: async () => accessDeniedPublication(),
		renameDirectoryNoReplacePathAsync,
	});

	const failure = await acquireFileLock(file, { retries: 1, retryDelayMs: 1 }).then(
		() => undefined,
		(error: unknown) => error,
	);
	expect(failure).toBeInstanceOf(FileLockAcquireError);
	if (!(failure instanceof FileLockAcquireError)) throw new Error("expected file lock acquisition failure");
	expect(failure.publicationFailureCode).toBe("access_denied");
	expect(failure.holderIsLive).toBe(true);
	expect(isFileLockAcquireTimeout(failure)).toBe(true);
});

test("acquisition reports live-holder evidence separately from ambiguous lock records", async () => {
	const liveIncarnation = "known-live-incarnation";
	const unavailableIncarnation = "unavailable-incarnation";
	const cases = [
		{
			info: removalInfo(process.pid, undefined, { process_incarnation: liveIncarnation }),
			currentIncarnation: liveIncarnation,
			isLive: true,
			description: `held by pid ${process.pid} (live)`,
		},
		{
			info: removalInfo(process.pid, undefined, {
				process_incarnation: unavailableIncarnation,
				start_time: "unknown",
				start_time_format: "utc-v1",
			}),
			currentIncarnation: null,
			isLive: false,
			description: `held by pid ${process.pid} (liveness unknown)`,
		},
		{
			info: "malformed owner metadata",
			currentIncarnation: null,
			isLive: false,
			description: "held by an owner record that never became readable",
		},
	] as const;

	for (const scenario of cases) {
		FileLockTestHooks.processIncarnation = () => scenario.currentIncarnation;
		const { file, lock } = await makeFixture();
		await fs.mkdir(lock);
		await Bun.write(path.join(lock, "info"), scenario.info);
		const failure = await acquireFileLock(file, { retries: 1, retryDelayMs: 1, staleMs: 10_000 }).then(
			() => undefined,
			(error: unknown) => error,
		);
		expect(failure).toBeInstanceOf(FileLockAcquireError);
		if (!(failure instanceof FileLockAcquireError)) throw new Error("expected file lock acquisition failure");
		if (scenario.description) expect(failure.holder).toContain(scenario.description);
		if (!scenario.isLive) expect(failure.holder).not.toContain("(live)");
		expect(failure.holderIsLive).toBe(scenario.isLive);
	}

	// A proven-dead owner is reclaimed by the bounded recovery extension in the same call.
	FileLockTestHooks.processIncarnation = () => null;
	const deadFixture = await makeFixture();
	await fs.mkdir(deadFixture.lock);
	await Bun.write(path.join(deadFixture.lock, "info"), removalInfo(await deadPid()));
	const deadRelease = await acquireFileLock(deadFixture.file, { retries: 1, retryDelayMs: 1, staleMs: 10_000 });
	await deadRelease();
	await expect(fs.lstat(deadFixture.lock)).rejects.toMatchObject({ code: "ENOENT" });
});

test("keeps the staging component within filesystem limits for long target names", async () => {
	const { root } = await makeFixture();
	const file = path.join(root, "x".repeat(196));
	const lock = `${file}.lock`;
	const transitionPath = `${lock}.removing`;
	const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
	if (!originalPlatform?.configurable) throw new Error("process_platform_not_configurable");
	let stagingComponentLength = 0;
	FileLockTestHooks.nativePublicationBindings = () => ({
		renameNoReplacePathAsync: async (source, destination) => {
			stagingComponentLength = path.basename(source).length;
			await fs.rename(source, destination);
			return successfulPublication(primaryPrimitive ?? "windows_rename_noreplace");
		},
		renameDirectoryNoReplacePathAsync,
	});
	FileLockTestHooks.nativeQuarantineBindings = () => ({
		snapshotDirectoryTree,
		exactRemoveDirectoryTree: (target, _snapshot, _parentIdentity, detachOnly) => {
			if (target === lock && detachOnly) {
				syncFs.renameSync(target, transitionPath);
				return { ok: true, detachedPath: transitionPath };
			}
			syncFs.rmSync(target, { recursive: true, force: true });
			return { ok: true };
		},
	});

	try {
		Object.defineProperty(process, "platform", { ...originalPlatform, value: "win32" });
		await expect(withFileLock(file, async () => "acquired", quickAcquire)).resolves.toBe("acquired");
	} finally {
		Object.defineProperty(process, "platform", originalPlatform);
	}
	expect(stagingComponentLength).toBeLessThanOrEqual(255);
	const legacyComponentLength =
		path.basename(file).length + ".lock.pending.".length + String(process.pid).length + 1 + 36;
	expect(stagingComponentLength).toBeLessThanOrEqual(legacyComponentLength);
});

test("retries sharing-violation publication after transient staging cleanup refusal", async () => {
	const { root, file, lock } = await makeFixture();
	let publicationAttempts = 0;
	let cleanupAttempts = 0;
	let infoHandle: fs.FileHandle | undefined;
	const stagedPaths: string[] = [];
	const cleanupPaths: string[] = [];
	FileLockTestHooks.nativePublicationBindings = () => ({
		renameNoReplacePathAsync: async (source, destination) => {
			publicationAttempts++;
			stagedPaths.push(source);
			if (publicationAttempts === 1) infoHandle = await fs.open(path.join(source, "info"), "r");
			if (publicationAttempts <= expectedBoundedPublicationCalls) return sharingViolationPublication();
			await fs.rename(source, destination);
			return successfulPublication(primaryPrimitive ?? "windows_rename_noreplace");
		},
		renameDirectoryNoReplacePathAsync,
	});
	FileLockTestHooks.cleanupPendingStaging = async stagingPath => {
		cleanupAttempts++;
		cleanupPaths.push(stagingPath);
		if (cleanupAttempts === 1) {
			await infoHandle?.close();
			infoHandle = undefined;
			throw Object.assign(new Error("transient staging cleanup denial"), { code: "EACCES" });
		}
		await fs.rm(stagingPath, { recursive: true, force: true });
	};

	try {
		await expect(withFileLock(file, async () => "entered", { retries: 3, retryDelayMs: 1 })).resolves.toBe("entered");
	} finally {
		await infoHandle?.close();
	}

	expect(publicationAttempts).toBe(expectedBoundedPublicationCalls + 1);
	expect(new Set(stagedPaths.slice(0, expectedBoundedPublicationCalls)).size).toBe(1);
	expect(stagedPaths[expectedBoundedPublicationCalls]).not.toBe(stagedPaths[0]);
	expect(cleanupAttempts).toBe(2);
	expect(cleanupPaths).toEqual([stagedPaths[0], stagedPaths[0]]);
	await expect(fs.lstat(lock)).rejects.toMatchObject({ code: "ENOENT" });
	expect(await fs.readdir(root)).toEqual([]);
});

test("retries native access-denied staging cleanup within the shared acquisition budget", async () => {
	const { root, file, lock } = await makeFixture();
	const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
	if (!originalPlatform?.configurable) throw new Error("process_platform_not_configurable");
	let publicationAttempts = 0;
	let cleanupAttempts = 0;
	FileLockTestHooks.nativePublicationBindings = () => ({
		renameNoReplacePathAsync: async () => {
			publicationAttempts++;
			return accessDeniedPublication();
		},
		renameDirectoryNoReplacePathAsync,
	});
	FileLockTestHooks.nativeQuarantineBindings = () => ({
		snapshotDirectoryTree,
		exactRemoveDirectoryTree: target => {
			cleanupAttempts++;
			if (cleanupAttempts === 1) return { ok: false, code: "access_denied" };
			syncFs.rmSync(target, { recursive: true, force: true });
			return { ok: true };
		},
	});

	try {
		Object.defineProperty(process, "platform", { ...originalPlatform, value: "win32" });
		await expect(
			acquireFileLock(file, { retries: 2, retryDelayMs: 1, ownerHostId: "staging-owner-host" }),
		).rejects.toMatchObject({
			name: "FileLockAcquireError",
			code: "acquire_timeout",
			publicationFailureCode: "access_denied",
		});
	} finally {
		Object.defineProperty(process, "platform", originalPlatform);
	}

	expect(publicationAttempts).toBe(expectedBoundedPublicationCalls * 2);
	expect(cleanupAttempts).toBe(3);
	await expect(fs.lstat(lock)).rejects.toMatchObject({ code: "ENOENT" });
	expect(await fs.readdir(root)).toEqual([]);
});

test("reaps a detached staging tree after its publisher exits", async () => {
	const { root, file, lock } = await makeFixture();
	const fileLockModule = path.resolve(import.meta.dir, "../src/config/file-lock.ts");
	const source = `
		import * as fs from "node:fs/promises";
		import * as syncFs from "node:fs";
		import { acquireFileLock, FileLockStagingCleanupError, FileLockTestHooks } from ${JSON.stringify(fileLockModule)};
		import { snapshotDirectoryTree } from "@gajae-code/natives";
		const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
		Object.defineProperty(process, "platform", { ...descriptor, value: "win32" });
		FileLockTestHooks.stagingIdentityEvidence = () => ({ processIncarnation: "detached-staging-reaper-child", startTime: null });
		FileLockTestHooks.nativePublicationBindings = () => ({
			renameNoReplacePathAsync: async () => ({
				ok: false,
				code: "access_denied",
				mutationState: "not_committed",
				durabilityState: "not_attempted",
				reason: "access_denied",
				primitive: "windows_rename_noreplace",
				phase: "rename",
				diagnostic: { schemaVersion: 1, collectionState: "unavailable" },
			}),
			renameDirectoryNoReplacePathAsync: async () => { throw new Error("unexpected fallback"); },
		});
		FileLockTestHooks.nativeQuarantineBindings = () => ({
			snapshotDirectoryTree,
			exactRemoveDirectoryTree: (target) => {
				const detachedPath = target.endsWith(".removing") ? target : target + ".removing";
				if (detachedPath !== target) syncFs.renameSync(target, detachedPath);
				return { ok: false, code: "access_denied", detachedPath };
			},
		});
		let failure;
		try {
			await acquireFileLock(${JSON.stringify(file)}, { retries: 1, retryDelayMs: 1 });
		} catch (error) {
			failure = error;
		}
		if (!(failure instanceof FileLockStagingCleanupError)) process.exitCode = 1;
		await fs.writeFile(${JSON.stringify(path.join(root, "publisher-result"))}, failure?.name ?? "missing failure");
	`;
	const child = Bun.spawn([process.execPath, "-e", source], {
		cwd: path.resolve(import.meta.dir, "../../.."),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...process.env,
			GJC_CODING_AGENT_DIR: path.join(root, "isolated-agent-dir"),
		},
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	expect({ exitCode, stdout, stderr }).toMatchObject({ exitCode: 0, stdout: "", stderr: "" });
	expect(await Bun.file(path.join(root, "publisher-result")).text()).toBe("FileLockStagingCleanupError");
	const detached = (await fs.readdir(root)).find(name => name.endsWith(".removing"));
	expect(detached).toBeDefined();
	if (!detached) throw new Error("Expected detached staging tree after publisher exit");
	const reaped = await reapOrphanedLockStagingDirs(lock);
	expect(reaped.removed).toContain(path.join(root, detached));
	await expect(fs.lstat(path.join(root, detached))).rejects.toMatchObject({ code: "ENOENT" });
});

test("stops retrying when failed publication staging cannot be cleaned", async () => {
	const { root, file, lock } = await makeFixture();
	let publicationAttempts = 0;
	let cleanupAttempts = 0;
	FileLockTestHooks.nativePublicationBindings = () => ({
		renameNoReplacePathAsync: async () => {
			publicationAttempts++;
			return sharingViolationPublication();
		},
		renameDirectoryNoReplacePathAsync,
	});
	FileLockTestHooks.cleanupPendingStaging = async () => {
		cleanupAttempts++;
		throw Object.assign(new Error("staging cleanup denied"), { code: "EACCES" });
	};

	await expect(withFileLock(file, async () => "entered", { retries: 5, retryDelayMs: 1 })).rejects.toMatchObject({
		name: "FileLockStagingCleanupError",
		lockPath: lock,
		code: "EACCES",
	});
	expect(publicationAttempts).toBe(3); // 1 initial + 2 bounded retries
	expect(cleanupAttempts).toBe(5);
	expect((await fs.readdir(root)).filter(name => name.includes(".pending."))).toHaveLength(1);
	FileLockTestHooks.nativePublicationBindings = () => ({
		renameNoReplacePathAsync: async (source, destination) => {
			publicationAttempts++;
			await fs.rename(source, destination);
			return successfulPublication(primaryPrimitive ?? "windows_rename_noreplace");
		},
		renameDirectoryNoReplacePathAsync,
	});
	FileLockTestHooks.cleanupPendingStaging = async stagingPath => {
		cleanupAttempts++;
		await fs.rm(stagingPath, { recursive: true, force: true });
	};
	const release = await acquireFileLock(file, { retries: 1, retryDelayMs: 1 });
	expect(cleanupAttempts).toBe(6);
	expect(publicationAttempts).toBe(4);
	expect((await fs.readdir(root)).filter(name => name.includes(".pending."))).toHaveLength(0);
	await release();
	await expect(fs.lstat(lock)).rejects.toMatchObject({ code: "ENOENT" });
	expect(await fs.readdir(root)).toEqual([]);
});

test("rejects a zero retry budget before replaying retained staging cleanup", async () => {
	const { root, file, lock } = await makeFixture();
	let cleanupAttempts = 0;
	FileLockTestHooks.nativePublicationBindings = () => ({
		renameNoReplacePathAsync: async () => destinationExistsPublication(),
		renameDirectoryNoReplacePathAsync,
	});
	FileLockTestHooks.cleanupPendingStaging = async stagingPath => {
		cleanupAttempts++;
		if (cleanupAttempts === 1) throw Object.assign(new Error("staging cleanup denied"), { code: "EACCES" });
		await fs.rm(stagingPath, { recursive: true, force: true });
	};

	await expect(acquireFileLock(file, { retries: 1, retryDelayMs: 1 })).rejects.toMatchObject({
		name: "FileLockAcquireError",
		code: "acquire_timeout",
	});
	await expect(acquireFileLock(file, { retries: 0, retryDelayMs: 1 })).rejects.toThrow(
		"retries must be a positive safe integer",
	);
	expect(cleanupAttempts).toBe(1);
	expect((await fs.readdir(root)).filter(name => name.includes(".pending."))).toHaveLength(1);

	FileLockTestHooks.nativePublicationBindings = () => ({
		renameNoReplacePathAsync: async (source, destination) => {
			await fs.rename(source, destination);
			return successfulPublication(primaryPrimitive ?? "windows_rename_noreplace");
		},
		renameDirectoryNoReplacePathAsync,
	});
	const release = await acquireFileLock(file, { retries: 1, retryDelayMs: 1 });
	expect(cleanupAttempts).toBe(2);
	expect((await fs.readdir(root)).filter(name => name.includes(".pending."))).toHaveLength(0);
	await release();
	await expect(fs.lstat(lock)).rejects.toMatchObject({ code: "ENOENT" });
	await expect(fs.readdir(root)).resolves.toEqual([]);
});

test("allows an infinite retry budget while honoring cancellation", async () => {
	const { root, file, lock } = await makeFixture();
	const controller = new AbortController();
	const reason = new Error("cancelled infinite lock retry");
	let publicationAttempts = 0;
	FileLockTestHooks.nativePublicationBindings = () => ({
		renameNoReplacePathAsync: async () => {
			publicationAttempts++;
			controller.abort(reason);
			return destinationExistsPublication();
		},
		renameDirectoryNoReplacePathAsync,
	});

	await expect(
		acquireFileLock(file, {
			retries: Number.POSITIVE_INFINITY,
			retryDelayMs: 1,
			signal: controller.signal,
		}),
	).rejects.toBe(reason);
	expect(publicationAttempts).toBe(1);
	await expect(fs.lstat(lock)).rejects.toMatchObject({ code: "ENOENT" });
	expect(await fs.readdir(root)).toEqual([]);
});

test("drains destination-exists cleanup before creating another staging directory", async () => {
	const { root, file, lock } = await makeFixture();
	let publicationAttempts = 0;
	let cleanupAttempts = 0;
	FileLockTestHooks.nativePublicationBindings = () => ({
		renameNoReplacePathAsync: async (source, destination) => {
			publicationAttempts++;
			if (publicationAttempts === 1) return destinationExistsPublication();
			await fs.rename(source, destination);
			return successfulPublication(primaryPrimitive ?? "windows_rename_noreplace");
		},
		renameDirectoryNoReplacePathAsync,
	});
	FileLockTestHooks.cleanupPendingStaging = async stagingPath => {
		cleanupAttempts++;
		if (cleanupAttempts === 1) throw Object.assign(new Error("staging cleanup denied"), { code: "EACCES" });
		await fs.rm(stagingPath, { recursive: true, force: true });
	};

	const release = await acquireFileLock(file, { retries: 2, retryDelayMs: 1 });
	expect(publicationAttempts).toBe(2);
	expect(cleanupAttempts).toBe(2);
	expect((await fs.readdir(root)).filter(name => name.includes(".pending."))).toHaveLength(0);
	await release();
	await expect(fs.lstat(lock)).rejects.toMatchObject({ code: "ENOENT" });
	expect(await fs.readdir(root)).toEqual([]);
});

test("blocks future acquisition when staging root identity cannot be captured", async () => {
	const { root, file, lock } = await makeFixture();
	let publicationAttempts = 0;
	let identityAttempts = 0;
	FileLockTestHooks.nativePublicationBindings = () => ({
		renameNoReplacePathAsync: async () => {
			publicationAttempts++;
			return destinationExistsPublication();
		},
		renameDirectoryNoReplacePathAsync,
	});
	FileLockTestHooks.stagingRootIdentity = async () => {
		identityAttempts++;
		throw Object.assign(new Error("staging identity unavailable"), { code: "EACCES" });
	};

	await expect(acquireFileLock(file, { retries: 2, retryDelayMs: 1 })).rejects.toMatchObject({
		name: "FileLockStagingCleanupError",
		lockPath: lock,
		code: "EACCES",
	});
	await expect(acquireFileLock(file, { retries: 2, retryDelayMs: 1 })).rejects.toMatchObject({
		name: "FileLockStagingCleanupError",
		lockPath: lock,
		code: "identity_unavailable",
	});
	expect(identityAttempts).toBe(1);
	expect(publicationAttempts).toBe(0);
	const pendingName = (await fs.readdir(root)).find(name => name.includes(".pending."));
	if (!pendingName) throw new Error("expected identityless staging directory to remain pending");
	expect((await fs.readdir(root)).filter(name => name.includes(".pending."))).toEqual([pendingName]);

	await fs.rm(path.join(root, pendingName), { recursive: true, force: true });
	FileLockTestHooks.stagingRootIdentity = undefined;
	FileLockTestHooks.nativePublicationBindings = () => ({
		renameNoReplacePathAsync: async (source, destination) => {
			publicationAttempts++;
			await fs.rename(source, destination);
			return successfulPublication(primaryPrimitive ?? "windows_rename_noreplace");
		},
		renameDirectoryNoReplacePathAsync,
	});
	const release = await acquireFileLock(file, { retries: 1, retryDelayMs: 1 });
	expect(publicationAttempts).toBe(1);
	expect((await fs.readdir(root)).filter(name => name.includes(".pending."))).toHaveLength(0);
	await release();
	await expect(fs.lstat(lock)).rejects.toMatchObject({ code: "ENOENT" });
});

test("revalidates expected Windows staging contents after a snapshot failure", async () => {
	const { root, file, lock } = await makeFixture();
	const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
	if (!originalPlatform?.configurable) throw new Error("process_platform_not_configurable");
	let snapshotAttempts = 0;
	let publicationAttempts = 0;
	FileLockTestHooks.nativeQuarantineBindings = () => ({
		snapshotDirectoryTree: stagingPath => {
			snapshotAttempts++;
			if (snapshotAttempts <= 2) return { ok: false, code: "io_error" };
			return snapshotDirectoryTree(stagingPath);
		},
		exactRemoveDirectoryTree: exactRemoveStagingSnapshotForTest,
	});
	FileLockTestHooks.nativePublicationBindings = () => ({
		renameNoReplacePathAsync: async (source, destination) => {
			publicationAttempts++;
			await fs.rename(source, destination);
			return successfulPublication("windows_rename_noreplace");
		},
		renameDirectoryNoReplacePathAsync,
	});
	let release: (() => Promise<void>) | undefined;
	try {
		Object.defineProperty(process, "platform", { ...originalPlatform, value: "win32" });
		await expect(acquireFileLock(file, { retries: 1, retryDelayMs: 1 })).rejects.toMatchObject({
			name: "FileLockStagingCleanupError",
			lockPath: lock,
			code: "io_error",
		});
		const pendingName = (await fs.readdir(root)).find(name => name.includes(".pending."));
		if (!pendingName) throw new Error("expected stage with unavailable snapshot to remain pending");
		const pendingPath = path.join(root, pendingName);
		await Bun.write(path.join(pendingPath, "foreign"), "preserve unproven staged content");
		await expect(acquireFileLock(file, { retries: 2, retryDelayMs: 1 })).rejects.toMatchObject({
			name: "FileLockStagingCleanupError",
			lockPath: lock,
			code: "identity_unavailable",
		});
		expect(snapshotAttempts).toBe(3);
		expect(publicationAttempts).toBe(0);
		expect(await Bun.file(path.join(pendingPath, "foreign")).text()).toBe("preserve unproven staged content");

		await fs.rm(path.join(pendingPath, "foreign"));
		release = await acquireFileLock(file, { retries: 2, retryDelayMs: 1 });
		expect(snapshotAttempts).toBe(5);
		expect(publicationAttempts).toBe(1);
		expect((await fs.readdir(root)).filter(name => name.includes(".pending."))).toHaveLength(0);
	} finally {
		Object.defineProperty(process, "platform", originalPlatform);
		FileLockTestHooks.nativeQuarantineBindings = undefined;
	}
	if (!release) throw new Error("Expected acquisition to succeed after the unproven stage was removed");
	await release();
	expect(await fs.readdir(root)).toEqual([]);
});

test("cleans a Windows staging setup failure using the created info identity", async () => {
	const { root, file, lock } = await makeFixture();
	const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
	if (!originalPlatform?.configurable) throw new Error("process_platform_not_configurable");
	let setupAttempts = 0;
	let snapshotAttempts = 0;
	FileLockTestHooks.nativeQuarantineBindings = () => ({
		snapshotDirectoryTree: stagingPath => {
			snapshotAttempts++;
			return snapshotDirectoryTree(stagingPath);
		},
		exactRemoveDirectoryTree: exactRemoveStagingSnapshotForTest,
	});
	FileLockTestHooks.nativePublicationBindings = () => ({
		renameNoReplacePathAsync: async (source, destination) => {
			await fs.rename(source, destination);
			return successfulPublication("windows_rename_noreplace");
		},
		renameDirectoryNoReplacePathAsync,
	});
	FileLockTestHooks.afterStagingInfoWrite = async () => {
		setupAttempts++;
		if (setupAttempts === 1) throw Object.assign(new Error("transient staging setup denial"), { code: "EACCES" });
	};

	try {
		Object.defineProperty(process, "platform", { ...originalPlatform, value: "win32" });
		await expect(acquireFileLock(file, { retries: 1, retryDelayMs: 1 })).rejects.toMatchObject({
			message: "transient staging setup denial",
			code: "EACCES",
		});
		expect((await fs.readdir(root)).filter(name => name.includes(".pending."))).toHaveLength(0);
		const release = await acquireFileLock(file, { retries: 1, retryDelayMs: 1 });
		expect(setupAttempts).toBe(2);
		expect(snapshotAttempts).toBe(2);
		await release();
		await expect(fs.lstat(lock)).rejects.toMatchObject({ code: "ENOENT" });
	} finally {
		Object.defineProperty(process, "platform", originalPlatform);
		FileLockTestHooks.nativeQuarantineBindings = undefined;
	}
	expect(await fs.readdir(root)).toEqual([]);
});

test("retries a transient staging info identity stat failure", async () => {
	const { root, file, lock } = await makeFixture();
	const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
	if (!originalPlatform?.configurable) throw new Error("process_platform_not_configurable");
	let statAttempts = 0;
	let release: (() => Promise<void>) | undefined;
	FileLockTestHooks.nativeQuarantineBindings = () => ({
		snapshotDirectoryTree: snapshotDirectoryTree,
		exactRemoveDirectoryTree: exactRemoveStagingSnapshotForTest,
	});
	FileLockTestHooks.nativePublicationBindings = () => ({
		renameNoReplacePathAsync: async (source, destination) => {
			await fs.rename(source, destination);
			return successfulPublication("windows_rename_noreplace");
		},
		renameDirectoryNoReplacePathAsync,
	});
	FileLockTestHooks.stagingInfoIdentity = async (infoPath, capture) => {
		statAttempts++;
		expect((await fs.lstat(infoPath)).isFile()).toBe(true);
		if (statAttempts === 1) throw Object.assign(new Error("transient staging info stat denial"), { code: "EACCES" });
		return await capture();
	};

	try {
		Object.defineProperty(process, "platform", { ...originalPlatform, value: "win32" });
		release = await acquireFileLock(file, { retries: 2, retryDelayMs: 1 });
		expect(statAttempts).toBe(2);
		expect((await fs.readdir(root)).filter(name => name.includes(".pending."))).toHaveLength(0);
		await release();
		release = undefined;
		await expect(fs.lstat(lock)).rejects.toMatchObject({ code: "ENOENT" });
	} finally {
		try {
			if (release) await release();
		} finally {
			Object.defineProperty(process, "platform", originalPlatform);
			FileLockTestHooks.nativeQuarantineBindings = undefined;
			FileLockTestHooks.nativePublicationBindings = undefined;
			FileLockTestHooks.stagingInfoIdentity = undefined;
		}
	}
	expect(await fs.readdir(root)).toEqual([]);
});

test("reaps an empty staging directory after info identity retries exhaust", async () => {
	const { root, file, lock } = await makeFixture();
	const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
	if (!originalPlatform?.configurable) throw new Error("process_platform_not_configurable");
	let statAttempts = 0;
	let cleanupAttempts = 0;
	FileLockTestHooks.stagingIdentityEvidence = () => ({
		processIncarnation: "staging-owner-before-exit",
		startTime: null,
	});
	FileLockTestHooks.stagingInfoIdentity = async infoPath => {
		statAttempts++;
		expect((await fs.lstat(infoPath)).isFile()).toBe(true);
		throw Object.assign(new Error("persistent staging info stat denial"), { code: "EACCES" });
	};
	FileLockTestHooks.cleanupPendingStaging = async () => {
		cleanupAttempts++;
		throw Object.assign(new Error("staging cleanup denied"), { code: "EACCES" });
	};
	FileLockTestHooks.nativeQuarantineBindings = () => ({
		snapshotDirectoryTree,
		exactRemoveDirectoryTree: exactRemoveStagingSnapshotForTest,
	});

	try {
		Object.defineProperty(process, "platform", { ...originalPlatform, value: "win32" });
		await expect(
			acquireFileLock(file, { retries: 2, retryDelayMs: 1, ownerHostId: "staging-owner-host" }),
		).rejects.toMatchObject({
			message: "persistent staging info stat denial",
			code: "EACCES",
		});
		expect(statAttempts).toBe(2);
		expect(cleanupAttempts).toBeGreaterThan(0);
		const pendingName = (await fs.readdir(root)).find(name => name.includes(".pending."));
		if (!pendingName) throw new Error("expected the staging root to remain after transient cleanup denial");
		const pendingPath = path.join(root, pendingName);
		expect(await fs.readdir(pendingPath)).toEqual([]);
		const expiredAt = new Date(Date.now() - 61_000);
		await fs.utimes(pendingPath, expiredAt, expiredAt);

		FileLockTestHooks.cleanupPendingStaging = undefined;
		FileLockTestHooks.processIncarnation = () => "staging-owner-after-exit";
		const reaped = await reapOrphanedLockStagingDirs(lock, { ownerHostId: "staging-owner-host" });
		expect(reaped.removed).toContain(pendingPath);
		await expect(fs.lstat(pendingPath)).rejects.toMatchObject({ code: "ENOENT" });
	} finally {
		Object.defineProperty(process, "platform", originalPlatform);
		FileLockTestHooks.stagingIdentityEvidence = undefined;
		FileLockTestHooks.processIncarnation = undefined;
		FileLockTestHooks.nativeQuarantineBindings = undefined;
		FileLockTestHooks.cleanupPendingStaging = undefined;
		FileLockTestHooks.stagingInfoIdentity = undefined;
	}
	const release = await acquireFileLock(file, { retries: 1, retryDelayMs: 1 });
	await release();
	expect(await fs.readdir(root)).toEqual([]);
});

test("does not unlink a replacement staged info path when identity capture fails", async () => {
	const { root, file } = await makeFixture();
	let movedInfoPath: string | undefined;
	FileLockTestHooks.nativeQuarantineBindings = () => ({
		snapshotDirectoryTree,
		exactRemoveDirectoryTree: exactRemoveStagingSnapshotForTest,
	});
	FileLockTestHooks.stagingInfoIdentity = async infoPath => {
		movedInfoPath = `${infoPath}.moved`;
		await fs.rename(infoPath, movedInfoPath);
		await fs.writeFile(infoPath, "replacement info", { mode: 0o600 });
		throw Object.assign(new Error("staging info identity denied"), { code: "EACCES" });
	};
	FileLockTestHooks.stagingInfoCleanup = (infoPath, callerFd, quarantineName) =>
		exactUnlinkOpenFile(infoPath, callerFd, quarantineName);

	try {
		await expect(acquireFileLock(file, { retries: 1, retryDelayMs: 1 })).rejects.toBeInstanceOf(AggregateError);
		if (!movedInfoPath) throw new Error("expected staging info path to be moved");
		expect(await fs.readFile(movedInfoPath, "utf8")).toBe("");
		expect(await fs.readFile(movedInfoPath.replace(/\.moved$/, ""), "utf8")).toBe("replacement info");
	} finally {
		FileLockTestHooks.nativeQuarantineBindings = undefined;
		FileLockTestHooks.stagingInfoIdentity = undefined;
		FileLockTestHooks.stagingInfoCleanup = undefined;
	}
	const pendingName = (await fs.readdir(root)).find(name => name.includes(".pending."));
	if (!pendingName) throw new Error("expected unverified staging directory to remain for safe recovery");
	expect(await fs.readFile(path.join(root, pendingName, "info"), "utf8")).toBe("replacement info");
});

test("aborts a transient publication retry before another publish attempt", async () => {
	const { root, file } = await makeFixture();
	const firstAttempt = Promise.withResolvers<void>();
	const controller = new AbortController();
	const reason = new Error("cancelled during publication retry");
	let publicationAttempts = 0;
	FileLockTestHooks.nativePublicationBindings = () => ({
		renameNoReplacePathAsync: async (source, destination) => {
			publicationAttempts++;
			if (publicationAttempts === 1) {
				firstAttempt.resolve();
				return accessDeniedPublication();
			}
			await fs.rename(source, destination);
			return successfulPublication(primaryPrimitive ?? "windows_rename_noreplace");
		},
		renameDirectoryNoReplacePathAsync,
	});

	const acquisition = acquireFileLock(file, { retries: 5, retryDelayMs: 1, signal: controller.signal });
	await firstAttempt.promise;
	await Bun.sleep(1);
	controller.abort(reason);
	await expect(acquisition).rejects.toBe(reason);
	expect(publicationAttempts).toBe(1);
	expect(await fs.readdir(root)).toEqual([]);
});

test("retains staging cleanup ownership after abort and blocks acquisition until cleanup succeeds", async () => {
	const { root, file, lock } = await makeFixture();
	const cleanupStarted = Promise.withResolvers<void>();
	const controller = new AbortController();
	const reason = new Error("cancelled during staging cleanup");
	let publicationAttempts = 0;
	let cleanupAttempts = 0;
	FileLockTestHooks.nativePublicationBindings = () => ({
		renameNoReplacePathAsync: async (source, destination) => {
			publicationAttempts++;
			if (publicationAttempts <= expectedBoundedPublicationCalls) return accessDeniedPublication();
			await fs.rename(source, destination);
			return successfulPublication(primaryPrimitive ?? "windows_rename_noreplace");
		},
		renameDirectoryNoReplacePathAsync,
	});
	FileLockTestHooks.cleanupPendingStaging = async stagingPath => {
		cleanupAttempts++;
		if (cleanupAttempts <= 2) {
			if (cleanupAttempts === 1) cleanupStarted.resolve();
			throw Object.assign(new Error("staging cleanup denied"), { code: "EACCES" });
		}
		await fs.rm(stagingPath, { recursive: true, force: true });
	};

	const cancelledAcquisition = acquireFileLock(file, {
		retries: 5,
		retryDelayMs: 500,
		signal: controller.signal,
	});
	await cleanupStarted.promise;
	await Bun.sleep(5);
	controller.abort(reason);
	await expect(cancelledAcquisition).rejects.toBe(reason);
	expect(cleanupAttempts).toBe(2);
	const retainedName = (await fs.readdir(root)).find(name => name.includes(".pending."));
	if (!retainedName) throw new Error("expected aborted staging directory to remain pending");
	const retainedPath = path.join(root, retainedName);

	FileLockTestHooks.cleanupPendingStaging = async () => {
		cleanupAttempts++;
		throw Object.assign(new Error("staging cleanup still denied"), { code: "EACCES" });
	};
	await expect(acquireFileLock(file, { retries: 2, retryDelayMs: 1 })).rejects.toMatchObject({
		name: "FileLockStagingCleanupError",
		lockPath: lock,
		code: "EACCES",
	});
	expect(cleanupAttempts).toBe(4);
	expect(publicationAttempts).toBe(expectedBoundedPublicationCalls);
	expect((await fs.readdir(root)).filter(name => name.includes(".pending."))).toEqual([retainedName]);
	const originalStagingPath = `${retainedPath}.preserved`;
	await fs.rename(retainedPath, originalStagingPath);
	await fs.mkdir(retainedPath);
	await Bun.write(path.join(retainedPath, "info"), "replacement staging tree");
	await expect(acquireFileLock(file, { retries: 2, retryDelayMs: 1 })).rejects.toMatchObject({
		name: "FileLockStagingCleanupError",
		lockPath: lock,
		code: "identity_mismatch",
	});
	expect(cleanupAttempts).toBe(4);
	expect(publicationAttempts).toBe(expectedBoundedPublicationCalls);
	expect(await Bun.file(path.join(retainedPath, "info")).text()).toBe("replacement staging tree");
	await fs.rm(retainedPath, { recursive: true, force: true });
	await fs.rename(originalStagingPath, retainedPath);

	FileLockTestHooks.cleanupPendingStaging = async stagingPath => {
		cleanupAttempts++;
		await fs.rm(stagingPath, { recursive: true, force: true });
	};
	const release = await acquireFileLock(file, { retries: 1, retryDelayMs: 1 });
	expect(cleanupAttempts).toBe(5);
	await expect(fs.lstat(retainedPath)).rejects.toMatchObject({ code: "ENOENT" });
	expect(publicationAttempts).toBe(expectedBoundedPublicationCalls + 1);
	await release();
	await expect(fs.lstat(lock)).rejects.toMatchObject({ code: "ENOENT" });
	expect((await fs.readdir(root)).filter(name => name.includes(".pending."))).toHaveLength(0);
});

test.each(["x".repeat(196), "x".repeat(240), "x".repeat(250), "é".repeat(125)])(
	"acquires and releases a long canonical target without overflowing derived components: %s",
	async name => {
		const { root } = await makeFixture();
		const file = path.join(root, name);
		const lock = `${file}.lock`;
		const transitions: string[] = [];
		FileLockTestHooks.beforeRemovalOwnerPublish = async transition => {
			transitions.push(transition);
			expect(Buffer.byteLength(path.basename(transition), "utf8")).toBeLessThanOrEqual(255);
			for (const entry of await fs.readdir(root)) {
				expect(Buffer.byteLength(entry, "utf8")).toBeLessThanOrEqual(255);
			}
		};
		try {
			await expect(
				withFileLock(
					file,
					async () => {
						const info = JSON.parse(await Bun.file(path.join(lock, "info")).text());
						expect(info.pid).toBe(process.pid);
						expect((await fs.lstat(lock)).isDirectory()).toBe(true);
						return "released";
					},
					quickAcquire,
				),
			).resolves.toBe("released");
			expect(transitions.length).toBeGreaterThan(0);
			expect(await fs.readdir(root)).toEqual([]);
		} finally {
			FileLockTestHooks.beforeRemovalOwnerPublish = undefined;
		}
	},
);

test("uses a liveness-probed legacy staging name when process identity is unavailable", async () => {
	const { file } = await makeFixture();
	FileLockTestHooks.stagingIdentityEvidence = () => ({ processIncarnation: null, startTime: null });
	let stagingPath = "";
	FileLockTestHooks.nativePublicationBindings = () => ({
		renameNoReplacePathAsync: async (source, destination) => {
			stagingPath = source;
			await fs.rename(source, destination);
			return successfulPublication(primaryPrimitive ?? "windows_rename_noreplace");
		},
		renameDirectoryNoReplacePathAsync: async () => {
			throw new Error("unexpected directory publication fallback");
		},
	});

	expect(await withFileLock(file, async () => "acquired", quickAcquire)).toBe("acquired");
	const stagingName = path.basename(stagingPath);
	expect(stagingName).toMatch(
		new RegExp(`\\.pending\\.${process.pid}\\.[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$`),
	);
	expect(fileLockStagingOwnerPid(stagingName)).toBe(process.pid);
	expect(fileLockStagingOwnerPid(`${stagingName}.removing`)).toBe(process.pid);
});

describe.skipIf(process.platform !== "linux")("file lock committed publication reconciliation", () => {
	test("accepts a committed fallback receipt when ambient platform metadata is spoofed", async () => {
		const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
		if (!descriptor?.configurable) throw new Error("process_platform_not_configurable");
		const { file, lock } = await makeFixture();
		const publication = installPublicationFailure();
		let entered = 0;
		try {
			Object.defineProperty(process, "platform", { ...descriptor, value: "darwin" });
			await expect(withFileLock(file, async () => ++entered, quickAcquire)).resolves.toBe(1);
		} finally {
			Object.defineProperty(process, "platform", descriptor);
		}
		expect(entered).toBe(1);
		expect(publication.primary).toBe(1);
		expect(publication.fallback).toBe(1);
		await expect(fs.lstat(lock)).rejects.toMatchObject({ code: "ENOENT" });
	});

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

	test.each(["cloned destination", "replaced info inode", "changed content", "extra entry", "missing destination"])(
		"refuses and preserves a %s after the committed failure",
		async mutation => {
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
		},
	);

	test.each(["directory", "file", "dangling symlink"])(
		"does not remove a recreated staging %s or enter the callback",
		async kind => {
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
		},
	);

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
	test.each(successShapedResults)(
		"does not enter after a fallback success-shaped %s receipt",
		async (_label, result) => {
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
		},
	);

	test.each(successShapedResults)(
		"does not enter after a primary success-shaped %s receipt",
		async (_label, result) => {
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
		},
	);

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

	test("retains release authority when post-publication transition validation throws", async () => {
		const { root, file, lock } = await makeFixture();
		const failure = new Error("post-publication transition check failed");
		let transitionChecks = 0;
		let acquired = 0;
		FileLockTestHooks.afterRemovalTransitionMissing = () => {
			transitionChecks++;
			if (transitionChecks === 2) throw failure;
		};

		await expect(
			withFileLock(file, async () => "unexpected", {
				...quickAcquire,
				onAcquired: () => acquired++,
			}),
		).rejects.toBe(failure);
		expect(transitionChecks).toBe(2);
		expect(acquired).toBe(0);
		expect(await fs.readdir(lock)).toEqual(["info"]);

		FileLockTestHooks.afterRemovalTransitionMissing = undefined;
		let entered = 0;
		await expect(
			withFileLock(
				file,
				async () => {
					entered++;
					return "recovered";
				},
				quickAcquire,
			),
		).resolves.toBe("recovered");
		expect(entered).toBe(1);
		expect(await fs.readdir(root)).toEqual([]);
	});

	test("retains release authority when onAcquired throws", async () => {
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
		FileLockTestHooks.nativePublicationBindings = undefined;
		await expect(withFileLock(file, async () => "recovered", quickAcquire)).resolves.toBe("recovered");
		expect(entered).toBe(0);
		expect(publication.primary).toBe(1);
		expect(publication.fallback).toBe(1);
		expect(await fs.readdir(path.dirname(lock))).toEqual([]);
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

	test("releases a staged generation when rollback commits before authority close fails", async () => {
		const { file, lock } = await makeFixture();
		const transition = `${lock}.removing`;
		const publication = installPublicationFailure(async (_source, destination) => {
			await fs.mkdir(`${destination}.removing`);
			await Bun.write(path.join(`${destination}.removing`, "info"), "foreign predecessor");
		});
		const closeAuthority = RecoveryFsRoot.prototype.close;
		let stagingExistsAtClose = false;
		const closeSpy = vi.spyOn(RecoveryFsRoot.prototype, "close").mockImplementation(function (this: RecoveryFsRoot) {
			closeAuthority.call(this);
			stagingExistsAtClose = syncFs.existsSync(publication.source);
			throw new Error("injected close failure after committed rollback");
		});
		const removalRecordUnlinks: string[] = [];
		FileLockTestHooks.beforeRemovalRecordUnlink = recordPath => {
			removalRecordUnlinks.push(recordPath);
			return true;
		};
		const publishedRemovalRecords: string[] = [];
		FileLockTestHooks.afterRemovalOwnerPublish = transitionPath => {
			publishedRemovalRecords.push(transitionPath);
		};
		let entered = 0;
		let acquired = 0;

		await expect(
			withFileLock(file, async () => entered++, { ...quickAcquire, onAcquired: () => acquired++ }),
		).rejects.toThrow("File lock rollback authority failed");

		expect(entered).toBe(0);
		expect(acquired).toBe(0);
		expect(closeSpy).toHaveBeenCalledTimes(1);
		expect(stagingExistsAtClose).toBe(true);
		expect(publication.source).not.toBe("");
		expect(await waitForAbsence(publication.source)).toBe(true);
		expect(publishedRemovalRecords).toContain(`${publication.source}.removing`);
		expect(await waitForAbsence(`${publication.source}.removing`)).toBe(true);
		expect(await waitForAbsence(`${publication.source}.removing.owner`)).toBe(true);
		expect(removalRecordUnlinks).toContain(`${publication.source}.removing.owner`);
		await expect(fs.lstat(lock)).rejects.toMatchObject({ code: "ENOENT" });
		expect(await Bun.file(path.join(transition, "info")).text()).toBe("foreign predecessor");
		expect(await fs.readdir(path.dirname(lock))).toEqual([path.basename(transition)]);
	});
});

describe.skipIf(process.platform === "win32")("file lock abandoned removal recovery", () => {
	test("adopts an abandoned parseable removal transition and acquires", async () => {
		const { file, lock } = await makeFixture();
		const transition = `${lock}.removing`;
		await fs.mkdir(transition);
		await Bun.write(path.join(transition, "info"), removalInfo(await deadPid(), "host-a"));

		const release = await acquireFileLock(file, { ...quickAcquire, ownerHostId: "host-a" });
		try {
			await expect(fs.lstat(transition)).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			await release();
		}
		await expect(fs.lstat(lock)).rejects.toMatchObject({ code: "ENOENT" });
	});

	test("hostless dead transition removed in a single acquire, info not left truncated", async () => {
		const { file, lock } = await makeFixture();
		const transition = `${lock}.removing`;
		const infoPath = path.join(transition, "info");
		await fs.mkdir(transition);
		await Bun.write(infoPath, removalInfo(await deadPid()));

		let release: (() => Promise<void>) | undefined;
		try {
			release = await acquireFileLock(file, { ...quickAcquire, ownerHostId: "host-a" });
		} catch (error) {
			if (await fs.exists(infoPath)) expect(await Bun.file(infoPath).size).not.toBe(0);
			throw error;
		}
		try {
			await expect(fs.lstat(transition)).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			await release();
		}
	});

	test("preserves a hostless live transition for a host-qualified acquirer", async () => {
		const { file, lock } = await makeFixture();
		const transition = `${lock}.removing`;
		await fs.mkdir(transition);
		await Bun.write(path.join(transition, "info"), removalInfo(process.pid));
		const retained = treeSnapshot(transition);

		await expect(acquireFileLock(file, { ...quickAcquire, ownerHostId: "host-a" })).rejects.toMatchObject({
			code: "acquire_timeout",
		});
		expect(treeSnapshot(transition)).toEqual(retained);
	});

	test("preserves a removal transition held by a live owner", async () => {
		const { file, lock } = await makeFixture();
		const transition = `${lock}.removing`;
		await fs.mkdir(transition);
		await Bun.write(path.join(transition, "info"), removalInfo(process.pid, "host-a"));
		const retained = treeSnapshot(transition);

		await expect(acquireFileLock(file, { ...quickAcquire, ownerHostId: "host-a" })).rejects.toMatchObject({
			code: "acquire_timeout",
		});
		expect(treeSnapshot(transition)).toEqual(retained);
	});

	test("preserves a removal transition owned by a foreign host", async () => {
		const { file, lock } = await makeFixture();
		const transition = `${lock}.removing`;
		await fs.mkdir(transition);
		await Bun.write(path.join(transition, "info"), removalInfo(await deadPid(), "foreign-host"));
		const retained = treeSnapshot(transition);

		await expect(acquireFileLock(file, { ...quickAcquire, ownerHostId: "host-a" })).rejects.toMatchObject({
			code: "acquire_timeout",
		});
		expect(treeSnapshot(transition)).toEqual(retained);
	});

	test("preserves an abandoned transition containing an unproven payload", async () => {
		const { file, lock } = await makeFixture();
		const transition = `${lock}.removing`;
		await fs.mkdir(transition);
		await Bun.write(path.join(transition, "info"), removalInfo(await deadPid(), "host-a"));
		await Bun.write(path.join(transition, "payload"), "must survive");
		const retained = treeSnapshot(transition);

		await expect(acquireFileLock(file, { ...quickAcquire, ownerHostId: "host-a" })).rejects.toMatchObject({
			code: "acquire_timeout",
		});
		expect(treeSnapshot(transition)).toEqual(retained);
		expect(await Bun.file(path.join(transition, "payload")).text()).toBe("must survive");
	});
	test("reports an abandoned transition whose payload adoption refuses", async () => {
		const { file, lock } = await makeFixture();
		const transition = `${lock}.removing`;
		await fs.mkdir(transition);
		await Bun.write(path.join(transition, "info"), removalInfo(await deadPid(), "host-a"));
		await Bun.write(path.join(transition, "payload"), "must survive");

		const blocked = await describeRetainedLockTransition(file, { ownerHostId: "host-a" });
		expect(blocked).toBeInstanceOf(FileLockAcquireError);
		expect(blocked).toMatchObject({ code: "orphan_transition", orphanPath: transition });
	});

	test("does not report an adoptable abandoned transition as blocked", async () => {
		const { file, lock } = await makeFixture();
		const transition = `${lock}.removing`;
		await fs.mkdir(transition);
		await Bun.write(path.join(transition, "info"), removalInfo(await deadPid(), "host-a"));

		await expect(describeRetainedLockTransition(file, { ownerHostId: "host-a" })).resolves.toBeUndefined();
	});

	test("adopts a host-less abandoned transition and acquires", async () => {
		const { file, lock } = await makeFixture();
		const transition = `${lock}.removing`;
		await fs.mkdir(transition);
		await Bun.write(path.join(transition, "info"), removalInfo(await deadPid()));

		const release = await acquireFileLock(file, quickAcquire);
		try {
			await expect(fs.lstat(transition)).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			await release();
		}
	});

	test("preserves a host-qualified abandoned transition for a host-less acquirer", async () => {
		const { file, lock } = await makeFixture();
		const transition = `${lock}.removing`;
		await fs.mkdir(transition);
		await Bun.write(path.join(transition, "info"), removalInfo(await deadPid(), "host-a"));
		const retained = treeSnapshot(transition);

		await expect(acquireFileLock(file, quickAcquire)).rejects.toMatchObject({ code: "acquire_timeout" });
		expect(treeSnapshot(transition)).toEqual(retained);
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

	test.each(["cloned tree", "replaced info inode", "changed content", "extra entry"])(
		"preserves a retained sibling with a %s and never retries removal",
		async mutation => {
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
		},
	);

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
