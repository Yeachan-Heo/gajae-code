import { afterEach, expect, test, vi } from "bun:test";
import type { BigIntStats } from "node:fs";
import { renameSync, rmSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type NativeDirectoryTreeSnapshot, snapshotDirectoryTree } from "@gajae-code/natives";
import {
	FileLockTestHooks,
	readFileLockObservationForGc,
	removeFileLockDirForGc,
	withFileLock,
} from "../src/config/file-lock";

const roots: string[] = [];
// A real NTFS lock directory exhibited this signed/unsigned file-ID pair
// under Bun and the native snapshot API. The fixture also models the Windows
// volume-serial representation deterministically.
const ROOT_ID = 15_821_989_915_882_833_371n;
const INFO_ID = 11_529_215_046_068_470_561n;
const DEVICE_ID = 0xf1234567n;
const DEAD_PID = 2_147_483_647;

function sameFixturePath(left: string, right: string): boolean {
	const normalize = (value: string): string => {
		const resolved = path.resolve(value).replace(/^\\\\\?\\/, "");
		return process.platform === "win32" ? resolved.toLowerCase() : resolved;
	};
	return normalize(left) === normalize(right);
}

async function cleanupFixtureRoots() {
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
}

afterEach(async () => {
	vi.restoreAllMocks();
	FileLockTestHooks.nativeQuarantineBindings = undefined;
	FileLockTestHooks.nativeExactRemovalProbe = undefined;
	await cleanupFixtureRoots();
});

async function signedIdentityFixture(component: "root" | "info" | "both", detach = false, tempRoot = os.tmpdir()) {
	const cleanupRoot = await fs.mkdtemp(path.join(tempRoot, "file-lock-signed-id-"));
	// The cleanup guard uses realpathSync, which preserves Windows short names.
	// Retain mkdtemp's spelling for cleanup against that captured temp boundary.
	roots.push(cleanupRoot);
	// Exact removal resolves parent aliases before re-reading stat identity.
	// Keep the fixture's path-matched stat spies on that same canonical path.
	const root = await fs.realpath(cleanupRoot);
	// Acquisition cleans staging paths using the caller's spelling too.
	const file = path.join(cleanupRoot, "index.jsonl");
	const cleanupLock = `${file}.lock`;
	const cleanupParked = `${cleanupLock}.removing`;
	const lock = path.join(root, "index.jsonl.lock");
	const parked = `${lock}.removing`;
	await fs.mkdir(lock);
	await Bun.write(path.join(lock, "info"), JSON.stringify({ pid: DEAD_PID, timestamp: 1000 }));
	let nativeIdentityChanged = false;
	const realLstat = fs.lstat;
	const transformStat = (target: string, stat: BigIntStats): BigIntStats => {
		const isRoot =
			sameFixturePath(target, lock) ||
			sameFixturePath(target, parked) ||
			sameFixturePath(target, cleanupLock) ||
			sameFixturePath(target, cleanupParked) ||
			(detach && (sameFixturePath(target, root) || sameFixturePath(target, cleanupRoot)));
		const isInfo =
			sameFixturePath(target, path.join(lock, "info")) ||
			sameFixturePath(target, path.join(parked, "info")) ||
			sameFixturePath(target, path.join(cleanupLock, "info")) ||
			sameFixturePath(target, path.join(cleanupParked, "info"));
		const id = isRoot && component !== "info" ? ROOT_ID : isInfo && component !== "root" ? INFO_ID : null;
		if (!isRoot && !isInfo) return stat;
		return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, {
			...(process.platform === "win32" ? { dev: BigInt.asIntN(32, DEVICE_ID) } : {}),
			...(id === null ? {} : { ino: BigInt.asIntN(64, id) }),
		});
	};
	vi.spyOn(fs, "lstat").mockImplementation((async (target, options) => {
		const stat = await realLstat(target, options);
		return typeof stat.ino === "bigint" ? transformStat(String(target), stat as BigIntStats) : stat;
	}) as typeof fs.lstat);
	const realOpen = fs.open;
	vi.spyOn(fs, "open").mockImplementation(async (target, flags, mode) => {
		const handle = await realOpen(target, flags, mode);
		if (
			sameFixturePath(String(target), path.join(lock, "info")) ||
			sameFixturePath(String(target), path.join(cleanupLock, "info"))
		) {
			const realStat = handle.stat.bind(handle);
			vi.spyOn(handle, "stat").mockImplementation((async options => {
				const stat = await realStat(options);
				return typeof stat.ino === "bigint" ? transformStat(String(target), stat as BigIntStats) : stat;
			}) as typeof handle.stat);
		}
		return handle;
	});
	const nativeSnapshot = (snapshot: NativeDirectoryTreeSnapshot): NativeDirectoryTreeSnapshot => ({
		...snapshot,
		rootDev: process.platform === "win32" ? DEVICE_ID.toString() : snapshot.rootDev,
		rootIno: component === "info" ? snapshot.rootIno : ROOT_ID.toString(),
		entries: snapshot.entries.map(entry => ({
			...entry,
			dev: process.platform === "win32" ? DEVICE_ID.toString() : entry.dev,
			ino:
				entry.relativePath === "" && component !== "info"
					? ROOT_ID.toString()
					: entry.relativePath === "info" && component !== "root"
						? (INFO_ID + (nativeIdentityChanged ? 1n : 0n)).toString()
						: entry.ino,
		})),
	});
	const originals = new Map<string, NativeDirectoryTreeSnapshot>();
	const remove = vi.fn(
		(
			target: string,
			snapshot: NativeDirectoryTreeSnapshot,
			parentIdentity?: { dev: bigint; ino: bigint },
			_detachOnly?: boolean,
		) => {
			const original = originals.get(target);
			if (!original) throw new Error("Removal without captured authority");
			expect(snapshot).toEqual(nativeSnapshot(original));
			if (detach) {
				expect(parentIdentity?.ino).toBe(ROOT_ID);
				renameSync(target, cleanupParked);
				return { ok: true, detachedPath: cleanupParked };
			}
			// Only simulate the native commit after both the adapted authority and
			// the original filesystem generation match the captured snapshot.
			expect(snapshotDirectoryTree(target).snapshot).toEqual(original);
			rmSync(target, { recursive: true, force: true });
			return { ok: true };
		},
	);
	FileLockTestHooks.nativeExactRemovalProbe = () => !detach;
	FileLockTestHooks.nativeQuarantineBindings = () => ({
		snapshotDirectoryTree: target => {
			const captured = snapshotDirectoryTree(target);
			if (!captured.ok || !captured.snapshot) return captured;
			originals.set(target, captured.snapshot);
			return { ok: true, snapshot: nativeSnapshot(captured.snapshot) };
		},
		exactRemoveDirectoryTree: remove,
	});
	return {
		file,
		lock,
		parked,
		remove,
		changeNativeIdentity: () => {
			nativeIdentityChanged = true;
		},
	};
}

test.each(["root", "info"] as const)("reclaims a dead-owner lock with a signed %s file ID", async component => {
	const fixture = await signedIdentityFixture(component);
	const observed = await readFileLockObservationForGc(fixture.lock);
	if (!observed) throw new Error("Expected a lock observation");
	expect(await removeFileLockDirForGc(fixture.lock, observed.info, observed.identity)).toBe("removed");
	expect(fixture.remove).toHaveBeenCalledTimes(1);
	expect(await fs.exists(fixture.lock)).toBe(false);
});

test("acquires and releases after reclaiming a signed-ID dead-owner lock", async () => {
	const fixture = await signedIdentityFixture("both");
	await expect(withFileLock(fixture.file, async () => "acquired", { retries: 3, retryDelayMs: 1 })).resolves.toBe(
		"acquired",
	);
	expect(await fs.exists(fixture.lock)).toBe(false);
});

test.skipIf(process.platform !== "win32")(
	"reclaims signed IDs and cleans up through a temporary-root case alias when available",
	async () => {
		const tempRoot = os.tmpdir();
		const volumeRoot = path.win32.parse(tempRoot).root;
		const isDriveRoot = /^[a-z]:[\\/]/i.test(volumeRoot);
		const aliasOffset = tempRoot.slice(volumeRoot.length).search(/[a-z]/i);
		const caseableOffset = isDriveRoot ? 0 : aliasOffset < 0 ? -1 : volumeRoot.length + aliasOffset;
		let aliasedTempRoot = tempRoot;
		if (caseableOffset >= 0) {
			const rootCharacter = tempRoot[caseableOffset];
			if (!rootCharacter) throw new Error("Expected a caseable Windows temporary-root character");
			const alternateCase =
				rootCharacter === rootCharacter.toUpperCase() ? rootCharacter.toLowerCase() : rootCharacter.toUpperCase();
			aliasedTempRoot = tempRoot.slice(0, caseableOffset) + alternateCase + tempRoot.slice(caseableOffset + 1);
			expect(aliasedTempRoot).not.toBe(tempRoot);
		}
		const fixture = await signedIdentityFixture("both", false, aliasedTempRoot);
		const observed = await readFileLockObservationForGc(fixture.lock);
		if (!observed) throw new Error("Expected a lock observation");
		expect(await removeFileLockDirForGc(fixture.lock, observed.info, observed.identity)).toBe("removed");
		expect(fixture.remove).toHaveBeenCalledTimes(1);
		expect(await fs.exists(fixture.lock)).toBe(false);
		expect(path.dirname(fixture.lock)).toBe(await fs.realpath(path.dirname(fixture.file)));
		const cleanup = vi.spyOn(fs, "rm");
		await cleanupFixtureRoots();
		expect(cleanup).toHaveBeenCalledTimes(1);
		expect(cleanup).toHaveBeenCalledWith(path.join(aliasedTempRoot, path.basename(path.dirname(fixture.lock))), {
			recursive: true,
			force: true,
		});
		expect(await fs.exists(path.dirname(fixture.file))).toBe(false);
	},
);

test("canonicalizes the parent and detached root in fallback cleanup", async () => {
	const fixture = await signedIdentityFixture("both", true);
	const observed = await readFileLockObservationForGc(fixture.lock);
	if (!observed) throw new Error("Expected a lock observation");
	expect(await removeFileLockDirForGc(fixture.lock, observed.info, observed.identity)).toBe("removed");
	expect(fixture.remove).toHaveBeenCalledTimes(1);
	expect(await fs.exists(fixture.lock)).toBe(false);
	expect(await fs.exists(fixture.parked)).toBe(false);
});

test("still rejects a different native file ID after signed stat normalization", async () => {
	const fixture = await signedIdentityFixture("both");
	const observed = await readFileLockObservationForGc(fixture.lock);
	if (!observed) throw new Error("Expected a lock observation");
	fixture.changeNativeIdentity();
	expect(await removeFileLockDirForGc(fixture.lock, observed.info, observed.identity)).toBe("owner_changed");
	expect(fixture.remove).not.toHaveBeenCalled();
	expect(await fs.exists(fixture.lock)).toBe(true);
});

test("still preserves a successor owner with signed file IDs", async () => {
	const fixture = await signedIdentityFixture("both");
	const observed = await readFileLockObservationForGc(fixture.lock);
	if (!observed) throw new Error("Expected a lock observation");
	const successor = JSON.stringify({ pid: process.pid, timestamp: 2000 });
	await Bun.write(path.join(fixture.lock, "info"), successor);
	expect(await removeFileLockDirForGc(fixture.lock, observed.info, observed.identity)).toBe("owner_changed");
	expect(fixture.remove).not.toHaveBeenCalled();
	expect(await Bun.file(path.join(fixture.lock, "info")).text()).toBe(successor);
});

test("never reclaims a live owner with signed file IDs", async () => {
	const fixture = await signedIdentityFixture("both");
	const owner = JSON.stringify({ pid: process.pid, timestamp: 1000 });
	await Bun.write(path.join(fixture.lock, "info"), owner);
	await expect(
		withFileLock(fixture.file, async () => "unexpected", { retries: 2, retryDelayMs: 1 }),
	).rejects.toMatchObject({
		code: "acquire_timeout",
	});
	expect(fixture.remove).not.toHaveBeenCalled();
	expect(await Bun.file(path.join(fixture.lock, "info")).text()).toBe(owner);
});

test.each([
	-(1n << 63n) - 1n,
	1n << 64n,
])("rejects out-of-range stat identity %s without modulo aliasing", async ino => {
	const previousLstat = fs.lstat;
	const fixture = await signedIdentityFixture("root");
	vi.spyOn(fs, "lstat").mockImplementation((async (target, options) => {
		const stat = await previousLstat(target, options);
		return String(target) === fixture.lock && typeof stat.ino === "bigint"
			? Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { ino })
			: stat;
	}) as typeof fs.lstat);
	await expect(readFileLockObservationForGc(fixture.lock)).rejects.toThrow("file_lock_identity_out_of_range");
	expect(fixture.remove).not.toHaveBeenCalled();
	expect(await fs.exists(fixture.lock)).toBe(true);
});
