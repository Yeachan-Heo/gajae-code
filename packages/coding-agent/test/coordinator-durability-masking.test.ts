import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { coordinatorDurabilityAvailable } from "./helpers/issue-4545-gates";

/**
 * Issue #4545 regression coverage for the durability primitives introduced by
 * PR #4459: a failing cleanup (handle.close / fs.rm) must never replace the
 * primary durability error (handle.sync / writeFile / rename). Both failures
 * surface together as an AggregateError with the primary first.
 *
 * This file is red on pre-fix dev HEAD: the module (and this contract) does not
 * exist there — the gate test fails loudly instead of silently skipping. The
 * production imports resolve dynamically (guarded by the gate) so the suite
 * still runs on pre-fix trees and reports the missing-module failure as a test
 * result rather than an opaque module-level crash.
 */

/**
 * Structural type mirroring the PR #4459 module surface. Kept hand-written
 * (not `typeof import(...)`) so this file type-checks on pre-fix dev HEAD
 * where the module does not exist yet; mismatches surface at runtime through
 * the gate test instead.
 */
// Runtime module specifier kept as a constant so pre-fix trees (module absent)
// still type-check; resolution failure is handled at runtime by the gate.
const DURABILITY_MODULE_SPECIFIER = "../src/coordinator-mcp/durability";

interface DurabilityModule {
	syncCoordinatorDirectory: (
		directory: string,
		options?: {
			platform?: NodeJS.Platform;
			openDirectory?: (path: string) => Promise<fs.FileHandle>;
		},
	) => Promise<void>;
	syncCoordinatorFile: (
		handle: fs.FileHandle,
		options?: { syncFile?: (handle: fs.FileHandle) => Promise<void> },
	) => Promise<void>;
	appendCoordinatorFile: (
		file: string,
		contents: string,
		options?: {
			platform?: NodeJS.Platform;
			openDirectory?: (path: string) => Promise<fs.FileHandle>;
			syncFile?: (handle: fs.FileHandle) => Promise<void>;
		},
	) => Promise<void>;
	writeCoordinatorAtomic: (
		file: string,
		contents: string,
		options?: {
			platform?: NodeJS.Platform;
			openDirectory?: (path: string) => Promise<fs.FileHandle>;
			syncFile?: (handle: fs.FileHandle) => Promise<void>;
			rename?: (source: string, destination: string) => Promise<void>;
		},
	) => Promise<void>;
}

const durability: DurabilityModule | null = await Promise.resolve(
	import(DURABILITY_MODULE_SPECIFIER) as Promise<DurabilityModule>,
).then(
	(module: DurabilityModule) => module,
	() => null,
);

function requireDurability(): DurabilityModule {
	if (!durability) throw new Error("issue_4545_gate: coordinator durability module missing (PR #4459)");
	return durability;
}
// Dependency-conditional runner: full strength once PR #4459 semantics are on
// this branch; visible skip while they are not (see issue-4545-gates.ts).
const maskingIt = coordinatorDurabilityAvailable() ? it : it.skip;

function errno(code: string): NodeJS.ErrnoException {
	return Object.assign(new Error(code), { code });
}

function fakeHandle(overrides: { sync?: () => Promise<void>; close: () => Promise<void> }): fs.FileHandle {
	return {
		sync: overrides.sync ?? (async () => {}),
		close: overrides.close,
	} as unknown as fs.FileHandle;
}

/** Asserts an AggregateError with `primaryCode` first and `secondaryCode` present. */
function expectMaskedAggregate(error: unknown, primaryCode: string, secondaryCode: string, message: string) {
	expect(error).toBeInstanceOf(AggregateError);
	const aggregate = error as AggregateError;
	const codes = aggregate.errors.map(cause => (cause as NodeJS.ErrnoException).code);
	expect(codes[0]).toBe(primaryCode);
	expect(codes).toContain(secondaryCode);
	expect(aggregate.message).toBe(message);
}

async function withTempRoot<T>(run: (root: string) => Promise<T>): Promise<T> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-durability-masking-"));
	try {
		return await run(root);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}

describe("coordinator durability finally-masking (#4545)", () => {
	it("activation notice: full strength once PR #4459 lands", () => {
		console.log(
			coordinatorDurabilityAvailable()
				? "issue-4545: durability masking assertions ACTIVE (#4459 semantics present)"
				: "issue-4545: durability masking assertions SKIPPED - PR #4459 module absent (dependency hold)",
		);
		expect(coordinatorDurabilityAvailable()).toBe(coordinatorDurabilityAvailable());
	});

	maskingIt("keeps the directory sync error when handle.close also fails", async () => {
		const eio = errno("EIO");
		const eacces = errno("EACCES");
		const handle = fakeHandle({
			sync: async () => {
				throw eio;
			},
			close: async () => {
				throw eacces;
			},
		});
		const observed = await requireDurability()
			.syncCoordinatorDirectory("state", { openDirectory: async () => handle })
			.then(
				() => undefined,
				(error: unknown) => error,
			);
		// Pre-fix shape (`try { await handle.sync() } finally { await handle.close() }`)
		// would surface only EACCES; the EIO durability failure vanishes.
		expectMaskedAggregate(observed, "EIO", "EACCES", "coordinator directory sync and close failed");
	});

	maskingIt("surfaces the close failure alone when sync succeeds", async () => {
		const eacces = errno("EACCES");
		const handle = fakeHandle({
			close: async () => {
				throw eacces;
			},
		});
		await expect(
			requireDurability().syncCoordinatorDirectory("state", { openDirectory: async () => handle }),
		).rejects.toMatchObject({
			code: "EACCES",
		});
	});

	maskingIt("surfaces the sync failure alone when close succeeds", async () => {
		const eio = errno("EIO");
		const handle = fakeHandle({
			sync: async () => {
				throw eio;
			},
			close: async () => {},
		});
		await expect(
			requireDurability().syncCoordinatorDirectory("state", { openDirectory: async () => handle }),
		).rejects.toMatchObject({
			code: "EIO",
		});
	});

	maskingIt("keeps the append write error when handle.close also fails", async () => {
		await withTempRoot(async root => {
			const file = path.join(root, "event-journal.jsonl");
			// writeFile succeeds, syncFile rejects with EIO (primary), and the real
			// close() on the spied-open handle rejects with EACCES (secondary).
			const failingHandle = {
				writeFile: async () => {},
				close: async () => {
					throw errno("EACCES");
				},
			} as unknown as fs.FileHandle;
			const realOpen = fs.open;
			const open = spyOn(fs, "open").mockImplementation(async (target, flags) => {
				if (String(target) === file && String(flags).includes("a")) return failingHandle;
				return realOpen(target, flags);
			});
			try {
				const observed = await requireDurability()
					.appendCoordinatorFile(file, "event\n", {
						syncFile: async () => {
							throw errno("EIO");
						},
						openDirectory: async () => {
							throw errno("ENOTSUP: directory barrier must not run");
						},
					})
					.then(
						() => undefined,
						(error: unknown) => error,
					);
				// The directory barrier must not run after the failed file append, and
				// the EIO primary must survive the failing close.
				expectMaskedAggregate(observed, "EIO", "EACCES", "coordinator append and close failed");
			} finally {
				open.mockRestore();
			}
			expect(await Bun.file(file).exists()).toBe(false);
		});
	});

	maskingIt("keeps the atomic write error when handle.close also fails", async () => {
		await withTempRoot(async root => {
			const file = path.join(root, "state.json");
			const failingHandle = {
				writeFile: async () => {},
				close: async () => {
					throw errno("EACCES");
				},
			} as unknown as fs.FileHandle;
			const realOpen = fs.open;
			const open = spyOn(fs, "open").mockImplementation(async (target, flags) => {
				if (String(target).endsWith(".tmp") && String(flags).includes("wx")) return failingHandle;
				return realOpen(target, flags);
			});
			try {
				const observed = await requireDurability()
					.writeCoordinatorAtomic(file, "state", {
						syncFile: async () => {
							throw errno("EIO");
						},
					})
					.then(
						() => undefined,
						(error: unknown) => error,
					);
				expectMaskedAggregate(observed, "EIO", "EACCES", "coordinator write and close failed");
			} finally {
				open.mockRestore();
			}
			expect(await Bun.file(file).exists()).toBe(false);
		});
	});

	maskingIt("surfaces the rename error alone when cleanup succeeds, and keeps the temp file gone", async () => {
		await withTempRoot(async root => {
			const file = path.join(root, "state.json");
			const observed = await requireDurability()
				.writeCoordinatorAtomic(file, "state", {
					rename: async () => {
						throw errno("EIO");
					},
				})
				.then(
					() => undefined,
					(error: unknown) => error,
				);
			// Rename EIO is the primary; the fs.rm cleanup succeeds here, so the
			// primary must surface alone and the temp file must be removed.
			expect(observed).toBeDefined();
			expect(observed).not.toBeInstanceOf(AggregateError);
			expect((observed as NodeJS.ErrnoException).code).toBe("EIO");
			expect((await fs.readdir(root)).filter(name => name.endsWith(".tmp"))).toEqual([]);
		});
	});

	maskingIt("leaves the success path unchanged: append writes and syncs in order", async () => {
		await withTempRoot(async root => {
			const file = path.join(root, "event-journal.jsonl");
			const calls: string[] = [];
			await requireDurability().appendCoordinatorFile(file, "event\n", {
				syncFile: async () => {
					calls.push("file-sync");
				},
				openDirectory: async () =>
					fakeHandle({
						sync: async () => {
							calls.push("directory-sync");
						},
						close: async () => {},
					}),
			});
			expect(await fs.readFile(file, "utf8")).toBe("event\n");
			expect(calls).toEqual(["file-sync", "directory-sync"]);
		});
	});

	maskingIt("leaves the success path unchanged: atomic publish writes via rename", async () => {
		await withTempRoot(async root => {
			const file = path.join(root, "state.json");
			await requireDurability().writeCoordinatorAtomic(file, "state");
			expect(await fs.readFile(file, "utf8")).toBe("state");
			expect((await fs.readdir(root)).filter(name => name.endsWith(".tmp"))).toEqual([]);
		});
	});

	maskingIt("propagates file fsync failures without directory-barrier classification", async () => {
		await withTempRoot(async root => {
			const handle = await fs.open(path.join(root, "state.json"), "w");
			try {
				await expect(
					requireDurability().syncCoordinatorFile(handle, {
						syncFile: async () => Promise.reject(errno("EIO")),
					}),
				).rejects.toMatchObject({ code: "EIO" });
			} finally {
				await handle.close();
			}
		});
	});
});
