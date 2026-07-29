/**
 * Platform-aware failure injection for managed session durability tests.
 *
 * Retained RecoveryFsRoot authority is Linux-only
 * (`retainManagedDirectoryAuthority` returns undefined off Linux, and
 * `ManagedSessionDescendantStore` only opens RecoveryFsRoot on Linux).
 * On other hosts production uses direct native rename/snapshot/fs paths, so
 * `RecoveryFsRoot.prototype` spies never intercept.
 *
 * These helpers install injection on the production call path for the host and
 * require at least one hit so a dead seam fails closed instead of silently succeeding.
 */
import { vi } from "bun:test";
import * as fs from "node:fs";
import * as native from "@gajae-code/natives";

export function publishFailure(code: string, reason: "io_failure" | "identity_violation") {
	return {
		ok: false as const,
		code,
		mutationState: "not_committed" as const,
		durabilityState: "not_attempted" as const,
		reason,
		primitive: "renameat2_noreplace" as const,
		phase: "preflight" as const,
		diagnostic: { schemaVersion: 1 as const, collectionState: "complete" as const },
	};
}

export type ManagedInjectionHandle = {
	restore: () => void;
	hits: () => number;
	/** Throws if the injection never ran (dead spy / wrong seam). */
	assertHit: () => void;
};

function handle(hits: { n: number }, restore: () => void): ManagedInjectionHandle {
	return {
		restore,
		hits: () => hits.n,
		assertHit: () => {
			if (hits.n < 1) {
				throw new Error(
					`managed failure-injection seam never ran (platform=${process.platform}); production path bypassed the spy`,
				);
			}
		},
	};
}

/** Inject tree rename failures (fork artifact publish / rename boundary). */
export function injectManagedTreeRename(
	impl: (source: string, destination: string) => ReturnType<typeof publishFailure> | "passthrough",
): ManagedInjectionHandle {
	const hits = { n: 0 };
	if (process.platform === "linux") {
		const real = native.RecoveryFsRoot.prototype.renameManagedTreeNoReplace;
		const spy = vi.spyOn(native.RecoveryFsRoot.prototype, "renameManagedTreeNoReplace").mockImplementation(function (
			this: native.RecoveryFsRoot,
			source,
			destination,
			expected,
		) {
			const result = impl(String(source), String(destination));
			if (result === "passthrough") return real.call(this, source, destination, expected);
			hits.n += 1;
			return result;
		});
		return handle(hits, () => spy.mockRestore());
	}
	const real = native.renameNoReplacePath;
	const spy = vi.spyOn(native, "renameNoReplacePath").mockImplementation((source, destination) => {
		const result = impl(String(source), String(destination));
		if (result === "passthrough") return real(source, destination);
		hits.n += 1;
		return result;
	});
	return handle(hits, () => spy.mockRestore());
}

/** Inject managed tree snapshot failures (post-publish retained capture). */
export function injectManagedTreeSnapshot(failure: { ok: false; code: string }): ManagedInjectionHandle {
	const hits = { n: 0 };
	if (process.platform === "linux") {
		const spy = vi.spyOn(native.RecoveryFsRoot.prototype, "snapshotManagedTree").mockImplementation(() => {
			hits.n += 1;
			return failure as never;
		});
		return handle(hits, () => spy.mockRestore());
	}
	const spy = vi.spyOn(native, "snapshotDirectoryTree").mockImplementation(() => {
		hits.n += 1;
		return failure as never;
	});
	return handle(hits, () => spy.mockRestore());
}

/**
 * Inject managed tree REMOVE failures (fork publication cleanup boundary).
 *
 * Used to separate an authorized POSIX quarantine (`cleanup_pending`, which is a
 * successful cleanup and must NOT supersede the primary error) from an
 * independently real cleanup failure (which must supersede it, with the primary
 * failure attached as `cause`).
 */
export function injectManagedTreeRemove(failure: { ok: false; code: string }): ManagedInjectionHandle {
	const hits = { n: 0 };
	if (process.platform === "linux") {
		const spy = vi.spyOn(native.RecoveryFsRoot.prototype, "removeManagedTree").mockImplementation(() => {
			hits.n += 1;
			return failure as never;
		});
		return handle(hits, () => spy.mockRestore());
	}
	const spy = vi.spyOn(native, "exactRemoveDirectoryTree").mockImplementation(() => {
		hits.n += 1;
		return failure as never;
	});
	return handle(hits, () => spy.mockRestore());
}

/**
 * Inject retained-tree fsync identity failures.
 * Linux: RecoveryFsRoot.fsyncExpected. Other hosts: fs.fsyncSync during tree fsync.
 */
export function injectManagedTreeFsync(options: {
	shouldFail: (pathOrRelative: string) => boolean;
	code: string;
}): ManagedInjectionHandle {
	const hits = { n: 0 };
	if (process.platform === "linux") {
		const real = native.RecoveryFsRoot.prototype.fsyncExpected;
		const spy = vi.spyOn(native.RecoveryFsRoot.prototype, "fsyncExpected").mockImplementation(function (
			this: native.RecoveryFsRoot,
			relativePath,
			directory,
			expectedDev,
			expectedIno,
			expectedSize,
			expectedMtimeNs,
			expectedSha256,
		) {
			if (options.shouldFail(String(relativePath))) {
				hits.n += 1;
				return { ok: false, code: options.code };
			}
			return real.call(
				this,
				relativePath,
				directory,
				expectedDev,
				expectedIno,
				expectedSize,
				expectedMtimeNs,
				expectedSha256,
			);
		});
		return handle(hits, () => spy.mockRestore());
	}
	// Non-Linux fsyncTree walks files with open+fsync. Force the first fsync to
	// surface the expected code; production maps the throw into the fork failure.
	const spy = vi.spyOn(fs, "fsyncSync").mockImplementation((() => {
		hits.n += 1;
		throw new Error(options.code);
	}) as typeof fs.fsyncSync);
	return handle(hits, () => spy.mockRestore());
}

/** Inject managed file rename failures (transcript publication). */
export function injectManagedFileRename(
	impl: (source: string, destination: string) => ReturnType<typeof publishFailure> | "passthrough",
): ManagedInjectionHandle {
	const hits = { n: 0 };
	if (process.platform === "linux") {
		const real = native.RecoveryFsRoot.prototype.renameManagedFileNoReplace;
		const spy = vi.spyOn(native.RecoveryFsRoot.prototype, "renameManagedFileNoReplace").mockImplementation(function (
			this: native.RecoveryFsRoot,
			sourceRelativePath,
			destinationRelativePath,
			expectedDev,
			expectedIno,
			expectedSize,
			expectedMtimeNs,
			expectedCtimeNs,
			expectedSha256,
		) {
			const result = impl(String(sourceRelativePath), String(destinationRelativePath));
			if (result === "passthrough") {
				return real.call(
					this,
					sourceRelativePath,
					destinationRelativePath,
					expectedDev,
					expectedIno,
					expectedSize,
					expectedMtimeNs,
					expectedCtimeNs,
					expectedSha256,
				);
			}
			hits.n += 1;
			return result;
		});
		return handle(hits, () => spy.mockRestore());
	}
	const real = native.renameNoReplacePath;
	const spy = vi.spyOn(native, "renameNoReplacePath").mockImplementation((source, destination) => {
		const result = impl(String(source), String(destination));
		if (result === "passthrough") return real(source, destination);
		hits.n += 1;
		return result;
	});
	return handle(hits, () => spy.mockRestore());
}

/** Inject managed append failures (moveTo cwd header_patch). */
export function injectManagedAppend(
	impl: (relativePath: string, data: Uint8Array) => { ok: false; code: string } | "passthrough",
): ManagedInjectionHandle {
	const hits = { n: 0 };
	if (process.platform === "linux") {
		const real = native.RecoveryFsRoot.prototype.appendManaged;
		const spy = vi.spyOn(native.RecoveryFsRoot.prototype, "appendManaged").mockImplementation(function (
			this: native.RecoveryFsRoot,
			relativePath,
			data,
			expectedDev,
			expectedIno,
			expectedSize,
			expectedMtimeNs,
			expectedCtimeNs,
			expectedSha256,
		) {
			const bytes = data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer);
			const result = impl(String(relativePath), bytes);
			if (result === "passthrough") {
				return real.call(
					this,
					relativePath,
					data,
					expectedDev,
					expectedIno,
					expectedSize,
					expectedMtimeNs,
					expectedCtimeNs,
					expectedSha256,
				);
			}
			hits.n += 1;
			return result;
		});
		return handle(hits, () => spy.mockRestore());
	}
	const realWrite = fs.writeSync.bind(fs);
	const spy = vi.spyOn(fs, "writeSync").mockImplementation(function (
		this: unknown,
		...args: Parameters<typeof fs.writeSync>
	) {
		const buffer = args[1];
		const bytes = Buffer.isBuffer(buffer)
			? buffer
			: typeof buffer === "string"
				? Buffer.from(buffer)
				: Buffer.from(String(buffer ?? ""));
		const result = impl("", bytes);
		if (result !== "passthrough") {
			hits.n += 1;
			throw new Error(result.code);
		}
		return realWrite(...args);
	} as typeof fs.writeSync);
	return handle(hits, () => spy.mockRestore());
}
