import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as native from "@gajae-code/natives";
import { ArtifactManager } from "../src/session/artifacts";
import {
	ManagedSessionDescendantStore,
	type ManagedSessionReadLease,
	managedDirectoryRoot,
} from "../src/session/internal/managed-session-storage";

const stores: ManagedSessionDescendantStore[] = [];
const directories: string[] = [];

interface ArtifactFixture {
	manager: ArtifactManager;
	store: ManagedSessionDescendantStore;
	root: string;
	artifactsDir: string;
	artifactPath: string;
	id: string;
}

async function fixture(content: string, pathBacked = false): Promise<ArtifactFixture> {
	const root = await fsp.mkdtemp(path.join(os.tmpdir(), "gjc-artifact-read-identity-"));
	directories.push(root);
	await fsp.chmod(root, 0o700);
	const artifactsDir = path.join(root, "artifacts");
	let store = new ManagedSessionDescendantStore(managedDirectoryRoot(root), artifactsDir);
	stores.push(store);
	let manager = new ArtifactManager(store);
	const id = await manager.save(content, "tool");
	if (pathBacked) {
		store = new ManagedSessionDescendantStore(
			managedDirectoryRoot(root),
			artifactsDir,
			undefined,
			"default",
			root,
			managedDirectoryRoot(artifactsDir),
			"read-only",
		);
		stores.push(store);
		manager = new ArtifactManager(store);
	}
	return { manager, store, root, artifactsDir, artifactPath: path.join(artifactsDir, `${id}.tool.log`), id };
}

function forwardingNativeFileSpies() {
	const openFile = native.RecoveryFsRoot.prototype.openFile;
	const readChunk = native.RecoveryFsFile.prototype.readChunk;
	const close = native.RecoveryFsFile.prototype.close;
	const openFileSpy = vi.spyOn(native.RecoveryFsRoot.prototype, "openFile").mockImplementation(function (
		this: native.RecoveryFsRoot,
		relativePath: string,
	) {
		return openFile.call(this, relativePath);
	});
	const readChunkSpy = vi.spyOn(native.RecoveryFsFile.prototype, "readChunk").mockImplementation(function (
		this: native.RecoveryFsFile,
		offset: number,
		maxBytes: number,
	) {
		return readChunk.call(this, offset, maxBytes);
	});
	const closeSpy = vi.spyOn(native.RecoveryFsFile.prototype, "close").mockImplementation(function (
		this: native.RecoveryFsFile,
	) {
		return close.call(this);
	});
	return { openFileSpy, readChunkSpy, closeSpy };
}

async function readStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const result = await reader.read();
		if (result.done) break;
		chunks.push(result.value);
		size += result.value.byteLength;
	}
	const output = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		output.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return output;
}

afterEach(async () => {
	for (const store of stores.splice(0)) store.close();
	vi.restoreAllMocks();
	await Promise.all(directories.splice(0).map(directory => fsp.rm(directory, { recursive: true, force: true })));
});

describe.skipIf(process.platform === "win32")("retained authority closure", () => {
	async function ownedStoreFixture(close: native.RecoveryFsRoot["close"], constructionFailure?: Error) {
		const original = await fixture("borrowed parent");
		const { root, artifactsDir } = original;
		const directory = managedDirectoryRoot(artifactsDir);
		const stat = fs.statSync(artifactsDir, { bigint: true });
		const identity = (): native.RecoveryFsResult => ({
			ok: true,
			identity: {
				dev: directory.dev.toString(),
				ino: directory.ino.toString(),
				nlink: stat.nlink.toString(),
				size: stat.size.toString(),
				mtimeNs: stat.mtimeNs.toString(),
				ctimeNs: stat.ctimeNs.toString(),
			},
		});
		// Model only the retained-handle boundary here. Native descriptor dispatch
		// has separate Rust and Linux NAPI coverage; these doubles own no FDs.
		const childAuthority = {
			identity: () => {
				if (constructionFailure) throw constructionFailure;
				return identity();
			},
			close,
		} as native.RecoveryFsRoot;
		const parentAuthority = {
			identity,
			retainManagedDirectory: () => childAuthority,
			close: (): native.RecoveryFsResult => {
				throw new Error("Borrowed parent must not be closed");
			},
		} satisfies Pick<native.RecoveryFsRoot, "identity" | "retainManagedDirectory" | "close">;
		const parent = new ManagedSessionDescendantStore(managedDirectoryRoot(root), artifactsDir, {
			authority: parentAuthority as unknown as native.RecoveryFsRoot,
			authorityBaseDir: artifactsDir,
		});
		// The existing directory is borrowed; test ownership of its derived handle,
		// without exercising namespace creation or detached housekeeping.
		vi.spyOn(parent, "ensureDirectory").mockReturnValue(directory);
		const store = parent.deriveSubtree("");
		const closeSpy = vi.spyOn(childAuthority, "close");
		return { store, parent, closeSpy, childAuthority, original };
	}

	for (const kind of ["success", "result", "throw"] as const) {
		it(`retains a derived construction failure with its ${kind} closure outcome`, async () => {
			const constructionFailure = new Error("controlled authority identity failure");
			const closeFailure = new Error("controlled authority closure failure");
			const close = vi.fn(() => {
				if (kind === "throw") throw closeFailure;
				return kind === "success" ? { ok: true } : { ok: false, code: "close_unknown" };
			});
			let observed: unknown;
			try {
				await ownedStoreFixture(close, constructionFailure);
			} catch (error) {
				observed = error;
			}
			if (kind === "success") expect(observed).toBe(constructionFailure);
			else {
				expect(observed).toBeInstanceOf(AggregateError);
				const failure = observed as AggregateError;
				expect(failure.errors[0]).toBe(constructionFailure);
				if (kind === "throw") expect(failure.errors[1]).toBe(closeFailure);
				else expect((failure.errors[1] as Error).message).toBe("close_unknown");
				expect(failure.cause).toMatchObject({ close });
			}
			expect(close).toHaveBeenCalledTimes(1);
		});
	}

	for (const kind of ["result", "throw"] as const) {
		it(`retains a native ${kind} close failure and refuses further owned-store access`, async () => {
			const failure = new Error("controlled retained close failure");
			const { store, parent, closeSpy } = await ownedStoreFixture(() => {
				if (kind === "throw") throw failure;
				return { ok: false, code: "close_unknown" };
			});
			let first: unknown;
			try {
				store.close();
			} catch (error) {
				first = error;
			}
			expect(first).toBeInstanceOf(Error);
			if (kind === "throw") expect(first).toBe(failure);
			else expect((first as Error).message).toBe("close_unknown");
			expect(() => store.close()).toThrow(first as Error);
			expect(closeSpy).toHaveBeenCalledTimes(1);
			expect(() => store.assertBound()).toThrow("managed_store_closed");
			expect(() => store.retainAuthority()).toThrow("managed_store_closed");
			expect(() => store.publishNoReplaceSync("late.txt", Buffer.from("late"))).toThrow("managed_store_closed");
			parent.assertBound();
			parent.close();
			parent.assertBound();
			expect(closeSpy).toHaveBeenCalledTimes(1);
		});
	}

	it("closes a derived authority once without closing its borrowed parent", async () => {
		const { store, parent, closeSpy } = await ownedStoreFixture(() => ({ ok: true }));
		store.close();
		store.close();
		expect(closeSpy).toHaveBeenCalledTimes(1);
		expect(() => store.assertBound()).toThrow("managed_store_closed");
		parent.assertBound();
		parent.close();
		parent.assertBound();
	});

	for (const phase of ["opening", "closing"] as const) {
		it(`preserves both ${phase} validation failure and independent native close uncertainty`, async () => {
			const { store, childAuthority, original } = await ownedStoreFixture(() => ({ ok: true }));
			const relative = `${original.id}.tool.log`;
			const descriptor = original.store.descriptorExpected(relative)!;
			const identity: native.RecoveryFsIdentity = {
				dev: descriptor.dev!.toString(),
				ino: descriptor.ino!.toString(),
				nlink: descriptor.nlink!.toString(),
				size: descriptor.size.toString(),
				mtimeNs: descriptor.mtimeNs!.toString(),
				ctimeNs: descriptor.ctimeNs!.toString(),
			};
			let changed = phase === "opening";
			const file = {
				identity: () => ({ ok: true, identity }),
				close: () => ({ ok: false, code: "close_unknown" }),
			} as native.RecoveryFsFile;
			const close = vi.spyOn(file, "close");
			childAuthority.openFile = () => file;
			childAuthority.stat = () => (changed ? { ok: false, code: "source_changed" } : { ok: true, identity });
			let first: unknown;
			let lease: ManagedSessionReadLease | undefined;
			try {
				lease = store.openReadLease(relative, descriptor);
				changed = true;
				lease.close();
			} catch (error) {
				first = error;
			}
			expect(first).toBeInstanceOf(AggregateError);
			expect((first as AggregateError).errors.map(error => (error as Error).message)).toEqual([
				"source_changed",
				"close_unknown",
			]);
			expect((first as Error).cause).toBe(file);
			if (phase === "closing") {
				expect(lease).toBeDefined();
				let repeated: unknown;
				try {
					lease!.close();
				} catch (error) {
					repeated = error;
				}
				expect(repeated).toBe(first);
				expect(() => lease!.readRange(0, 1)).toThrow("closed");
			}
			expect(close).toHaveBeenCalledTimes(1);
			store.close();
		});
	}

	it("keeps a path-backed lease validation failure sticky without another descriptor operation", async () => {
		const { store, id, artifactPath } = await fixture("original lease bytes", true);
		const relative = `${id}.tool.log`;
		const descriptor = store.descriptorExpected(relative)!;
		const lease = store.openReadLease(relative, descriptor);
		fs.appendFileSync(artifactPath, " changed");
		const read = vi.spyOn(store, "readRangeExpectedSync");
		let first: unknown;
		try {
			lease.close();
		} catch (error) {
			first = error;
		}
		expect(first).toBeInstanceOf(Error);
		expect((first as Error).message).toBe("managed_range_generation_mismatch");
		expect(() => lease.close()).toThrow(first as Error);
		expect(read).toHaveBeenCalledTimes(1);
		expect(() => lease.readRange(0, 1)).toThrow("closed");
	});
});

describe.skipIf(process.platform === "win32")("staged artifact mutation lifetime", () => {
	it("preserves pathname-backed discard after a later write recreates the attempt", async () => {
		const { root } = await fixture("parent");
		const attempt = new ArtifactManager(path.join(root, "explicit-parent")).createAttemptStaging("reused");
		await attempt.save("first write", "tool");
		await attempt.discardAttemptStaging();
		await expect(fsp.lstat(attempt.dir)).rejects.toMatchObject({ code: "ENOENT" });
		const id = await attempt.save("second write", "tool");
		expect(await Bun.file(path.join(attempt.dir, `${id}.tool.log`)).text()).toBe("second write");
		await attempt.discardAttemptStaging();
		await expect(fsp.lstat(attempt.dir)).rejects.toMatchObject({ code: "ENOENT" });
	});

	for (const method of ["save", "exact-text"] as const) {
		it(`joins an admitted ${method} across allocation and publication before retirement`, async () => {
			const { manager, store } = await fixture("parent");
			const attempt = manager.createAttemptStaging(`writer-${method}`);
			const attemptStore = attempt.getManagedStore()!;
			stores.push(attemptStore);
			const entered = Promise.withResolvers<void>();
			const resume = Promise.withResolvers<void>();
			const original = attemptStore.publishNoReplace.bind(attemptStore);
			let published = false;
			const publish = vi.spyOn(attemptStore, "publishNoReplace").mockImplementation(async (filename, bytes) => {
				if (filename.startsWith(".artifact-id-")) {
					entered.resolve();
					await resume.promise;
				}
				await original(filename, bytes);
				if (filename.endsWith(".log")) published = true;
			});
			const cleanupFailure = new Error("controlled post-writer retirement failure");
			const remove = vi.spyOn(store, "removeTreeExpected").mockImplementation(() => {
				expect(published).toBe(true);
				throw cleanupFailure;
			});
			const write =
				method === "save"
					? attempt.save("complete writer bytes", "tool")
					: attempt.publishExactText("complete writer bytes", { toolType: "tool" });
			await entered.promise;
			let settled = false;
			const discard = attempt.discardAttemptStaging().then(
				() => {
					settled = true;
					return undefined;
				},
				error => {
					settled = true;
					return error;
				},
			);
			const concurrentDiscard = attempt.discardAttemptStaging().catch(error => error);
			try {
				await Bun.sleep(0);
				expect(settled).toBe(false);
				expect(remove).not.toHaveBeenCalled();
				await expect(attempt.save("late", "tool")).rejects.toThrow("Artifact staging retirement has started.");
				await expect(attempt.replaceNamed("late.txt", "late")).rejects.toThrow(
					"Artifact staging retirement has started.",
				);
				expect(() => attempt.allocateId()).toThrow("Artifact staging retirement has started.");
				expect(() => attempt.createAttemptStaging("late-child")).toThrow(
					"Artifact staging retirement has started.",
				);
				expect(publish).toHaveBeenCalledTimes(1);
			} finally {
				resume.resolve();
				await write.catch(() => undefined);
				await discard;
			}
			if (method === "save") expect(await write).toBe("0");
			else expect(await write).toMatchObject({ outcome: "saved", handle: { artifactId: "0" } });
			expect(await discard).toBe(cleanupFailure);
			expect(await concurrentDiscard).toBe(cleanupFailure);
			await expect(attempt.discardAttemptStaging()).rejects.toBe(cleanupFailure);
			expect(remove).toHaveBeenCalledTimes(1);
			expect(await Bun.file(path.join(attempt.dir, "0.tool.log")).text()).toBe("complete writer bytes");
		});
	}

	it("joins an unawaited admitted descendant after its parent mutation settles", async () => {
		const { manager, store } = await fixture("parent");
		const attempt = manager.createAttemptStaging("writer-descendant");
		const attemptStore = attempt.getManagedStore()!;
		stores.push(attemptStore);
		const entered = Promise.withResolvers<void>();
		const resume = Promise.withResolvers<void>();
		const replace = attemptStore.replace.bind(attemptStore);
		vi.spyOn(attemptStore, "replace").mockImplementation(async (...args) => {
			entered.resolve();
			await resume.promise;
			await replace(...args);
		});
		const publish = attemptStore.publishNoReplace.bind(attemptStore);
		let descendant: Promise<void> | undefined;
		vi.spyOn(attemptStore, "publishNoReplace").mockImplementation(async (filename, bytes) => {
			if (filename.endsWith(".log")) descendant = attempt.replaceNamed("descendant.txt", "retained descendant");
			await publish(filename, bytes);
		});
		const failure = new Error("controlled descendant retirement failure");
		const remove = vi.spyOn(store, "removeTreeExpected").mockImplementation(() => {
			throw failure;
		});
		expect(await attempt.save("parent completed", "tool")).toBe("0");
		await entered.promise;
		let settled = false;
		const discard = attempt.discardAttemptStaging().then(
			() => {
				settled = true;
				return undefined;
			},
			error => {
				settled = true;
				return error;
			},
		);
		try {
			await Bun.sleep(0);
			expect(settled).toBe(false);
			expect(remove).not.toHaveBeenCalled();
		} finally {
			resume.resolve();
			await descendant;
			await discard;
		}
		expect(await discard).toBe(failure);
		expect(remove).toHaveBeenCalledTimes(1);
		expect(await Bun.file(path.join(attempt.dir, "descendant.txt")).text()).toBe("retained descendant");
	});

	it("rejects a mutation self-join without poisoning the admitted writer", async () => {
		const { manager } = await fixture("parent");
		const attempt = manager.createAttemptStaging("writer-self-join");
		const store = attempt.getManagedStore()!;
		stores.push(store);
		const original = store.publishNoReplace.bind(store);
		vi.spyOn(store, "publishNoReplace").mockImplementation(async (filename, bytes) => {
			await expect(attempt.discardAttemptStaging()).rejects.toThrow(
				"Artifact staging retirement cannot join its own mutation.",
			);
			await original(filename, bytes);
		});
		expect(await attempt.save("self join refused", "tool")).toBe("0");
		expect(await attempt.readRange("0")).toBe("self join refused");
	});
});

describe.skipIf(process.platform === "win32")("staged artifact reader lifetime", () => {
	for (const finish of ["consume", "cancel"] as const) {
		it(`waits for an actual reader to ${finish} before attempting retirement`, async () => {
			const { manager, store } = await fixture("parent");
			const attempt = manager.createAttemptStaging(`reader-${finish}`);
			const attemptStore = attempt.getManagedStore()!;
			stores.push(attemptStore);
			const id = await attempt.save("retained reader bytes", "tool");
			const reader = (await attempt.openReadStream(id)).getReader();
			const cleanupFailure = new Error("controlled retirement endpoint failure");
			const remove = vi.spyOn(store, "removeTreeExpected").mockImplementation(() => {
				throw cleanupFailure;
			});
			let settled = false;
			const discard = attempt.discardAttemptStaging().then(
				() => {
					settled = true;
					return undefined;
				},
				error => {
					settled = true;
					return error;
				},
			);
			await Bun.sleep(0);
			expect(settled).toBe(false);
			expect(remove).not.toHaveBeenCalled();
			await expect(attempt.openReadStream(id)).rejects.toThrow("Artifact staging retirement has started.");
			if (finish === "consume") {
				expect(new TextDecoder().decode((await reader.read()).value)).toBe("retained reader bytes");
				expect((await reader.read()).done).toBe(true);
			} else {
				await reader.cancel();
			}
			expect(await discard).toBe(cleanupFailure);
			expect(remove).toHaveBeenCalledTimes(1);
		});
	}

	for (const trigger of ["cancel", "read-failure"] as const) {
		it(`retains an ambiguous reader close after ${trigger} without retrying or retiring`, async () => {
			const { manager, store } = await fixture("parent");
			const attempt = manager.createAttemptStaging("reader-close-failure");
			const attemptStore = attempt.getManagedStore()!;
			stores.push(attemptStore);
			const id = await attempt.save("reader survives until cancellation", "tool");
			const open = attemptStore.openReadLease.bind(attemptStore);
			const failure = new Error("controlled ambiguous reader close");
			const readFailure = new Error("controlled reader failure");
			let closes = 0;
			vi.spyOn(attemptStore, "openReadLease").mockImplementation((...args) => {
				const lease = open(...args);
				return {
					...lease,
					readRange: (start, length) => {
						if (trigger === "read-failure") throw readFailure;
						return lease.readRange(start, length);
					},
					close: () => {
						closes++;
						lease.close();
						throw failure;
					},
				};
			});
			const remove = vi.spyOn(store, "removeTreeExpected");
			const reader = (await attempt.openReadStream(id)).getReader();
			if (trigger === "cancel") await expect(reader.cancel()).rejects.toBe(failure);
			else await expect(reader.read()).rejects.toBe(readFailure);
			for (let index = 0; index < 2; index++) {
				await expect(attempt.discardAttemptStaging()).rejects.toBe(failure);
			}
			expect(closes).toBe(1);
			expect(remove).not.toHaveBeenCalled();
		});
	}
});

describe.skipIf(process.platform !== "linux")("managed artifact reads stay bound to captured file identity", () => {
	it("preserves an unconfirmed derived root close while leaving its real parent usable", async () => {
		const { store } = await fixture("parent remains open");
		const child = store.deriveSubtree("retained-close-child");
		const nativeClose = native.RecoveryFsRoot.prototype.close;
		const close = vi.spyOn(native.RecoveryFsRoot.prototype, "close").mockImplementation(function (
			this: native.RecoveryFsRoot,
		) {
			const result = nativeClose.call(this);
			expect(result.ok).toBe(true);
			return { ok: false, code: "close_unknown" };
		});
		try {
			let first: unknown;
			try {
				child.close();
			} catch (error) {
				first = error;
			}
			expect(first).toBeInstanceOf(Error);
			expect((first as Error).message).toBe("close_unknown");
			expect(() => child.close()).toThrow(first as Error);
			expect(close).toHaveBeenCalledTimes(1);
			expect(() => child.assertBound()).toThrow("managed_store_closed");
			store.assertBound();
			expect(store.readExpected("0.tool.log")?.bytes.toString()).toBe("parent remains open");
		} finally {
			close.mockRestore();
		}
	});

	it("keeps real retained file closure failure after a hard-link violation is repaired", async () => {
		const { store, id, artifactPath, root } = await fixture("original lease");
		const relative = `${id}.tool.log`;
		const descriptor = store.descriptorExpected(relative)!;
		const spies = forwardingNativeFileSpies();
		const lease = store.openReadLease(relative, descriptor);
		const alias = path.join(root, "extra-link");
		fs.linkSync(artifactPath, alias);
		let first: unknown;
		try {
			lease.close();
		} catch (error) {
			first = error;
		}
		expect(first).toBeInstanceOf(AggregateError);
		expect((first as AggregateError).errors.map(error => (error as Error).message)).toEqual([
			"source_changed",
			"hard_link",
		]);
		fs.unlinkSync(alias);
		let repeated: unknown;
		try {
			lease.close();
		} catch (error) {
			repeated = error;
		}
		expect(repeated).toBe(first);
		expect(spies.closeSpy).toHaveBeenCalledTimes(1);
		expect(() => lease.readRange(0, 1)).toThrow("closed");
		expect(store.readExpected(relative)?.bytes.toString()).toBe("original lease");
	});

	it("preserves Blob text decoding for BOM, split UTF-8, and numeric byte ranges", async () => {
		const { manager, id, artifactPath } = await fixture("﻿hé𐐀tail");
		const file = Bun.file(artifactPath);
		for (const range of [
			{ start: 0, endExclusive: 14 },
			{ start: 0, endExclusive: 3 },
			{ start: 4, endExclusive: 5 },
			{ start: 5, endExclusive: 8 },
			{ start: 0.8, endExclusive: 10.9 },
			{ start: -4, endExclusive: 100 },
			{ start: Number.POSITIVE_INFINITY, endExclusive: Number.POSITIVE_INFINITY },
			{ start: Number.NaN, endExclusive: 8 },
			{ start: 4, endExclusive: Number.NaN },
		]) {
			const start = Math.max(0, Math.min(file.size, range.start));
			const end = Math.max(start, Math.min(file.size, range.endExclusive));
			expect(await manager.readRange(id, range)).toBe(await file.slice(start, end).text());
		}
	});

	it("reads exact bounded ranges and streams through the retained native read object", async () => {
		const text = `${"first-chunk-".repeat(7000)}${"second-chunk-".repeat(7000)}`;
		const { manager, id } = await fixture(text);
		const spies = forwardingNativeFileSpies();

		expect(await manager.readRange(id, { start: 7, endExclusive: 29 })).toBe(text.slice(7, 29));
		const streamed = await readStream(
			await manager.openReadStream(id, { start: 13, endExclusive: text.length - 11 }),
		);
		expect(new TextDecoder().decode(streamed)).toBe(text.slice(13, -11));
		expect(spies.openFileSpy).toHaveBeenCalledTimes(1);
		expect(spies.readChunkSpy.mock.calls.length).toBeGreaterThan(1);
		expect(spies.closeSpy).toHaveBeenCalledTimes(1);
	});

	it("rejects a leaf replaced with an outside symlink after native identity capture", async () => {
		const { manager, id, artifactPath, root } = await fixture("trusted bytes");
		const outside = path.join(root, "outside.txt");
		const displaced = path.join(root, "displaced.txt");
		await fsp.writeFile(outside, "outside secret");
		const stat = native.RecoveryFsRoot.prototype.stat;
		let replaced = false;
		vi.spyOn(native.RecoveryFsRoot.prototype, "stat").mockImplementation(function (
			this: native.RecoveryFsRoot,
			relativePath: string,
		) {
			const result = stat.call(this, relativePath);
			if (!replaced && relativePath === `${id}.tool.log`) {
				replaced = true;
				fs.renameSync(artifactPath, displaced);
				fs.symlinkSync(outside, artifactPath);
			}
			return result;
		});

		await expect(manager.readRange(id)).rejects.toThrow();
		expect(replaced).toBe(true);
		expect(await fsp.readFile(outside, "utf8")).toBe("outside secret");
	});

	it("rejects a same-name new inode rather than returning its bytes", async () => {
		const { manager, id, artifactPath, root } = await fixture("original bytes");
		const replacement = path.join(root, "replacement.txt");
		const displaced = path.join(root, "original.txt");
		await fsp.writeFile(replacement, "replacement bytes");
		const stat = native.RecoveryFsRoot.prototype.stat;
		let replaced = false;
		vi.spyOn(native.RecoveryFsRoot.prototype, "stat").mockImplementation(function (
			this: native.RecoveryFsRoot,
			relativePath: string,
		) {
			const result = stat.call(this, relativePath);
			if (!replaced && relativePath === `${id}.tool.log`) {
				replaced = true;
				fs.renameSync(artifactPath, displaced);
				fs.renameSync(replacement, artifactPath);
			}
			return result;
		});

		await expect(manager.readRange(id)).rejects.toThrow("source_changed");
		expect(replaced).toBe(true);
	});

	it("rejects in-place mutation between stream chunks and closes the actual native handle", async () => {
		const text = "a".repeat(ARTIFACT_TEST_STREAM_BYTES);
		const { manager, id, artifactPath } = await fixture(text);
		const spies = forwardingNativeFileSpies();
		const reader = (await manager.openReadStream(id)).getReader();
		const first = await reader.read();
		expect(first.value?.byteLength).toBe(64 * 1024);
		fs.appendFileSync(artifactPath, "changed after the first chunk");

		await expect(reader.read()).rejects.toThrow("source_changed");
		expect(spies.readChunkSpy.mock.calls.length).toBe(1);
		expect(spies.closeSpy).toHaveBeenCalledTimes(1);
	});

	it("does not switch to a same-name replacement between stream chunks", async () => {
		const { manager, id, artifactPath, root } = await fixture("a".repeat(ARTIFACT_TEST_STREAM_BYTES));
		const replacement = path.join(root, "replacement.log");
		const displaced = path.join(root, "original.log");
		const spies = forwardingNativeFileSpies();
		const reader = (await manager.openReadStream(id)).getReader();
		const first = await reader.read();
		expect(first.value?.byteLength).toBe(64 * 1024);
		await fsp.writeFile(replacement, "B".repeat(ARTIFACT_TEST_STREAM_BYTES));
		await fsp.rename(artifactPath, displaced);
		await fsp.rename(replacement, artifactPath);

		await expect(reader.read()).rejects.toThrow("source_changed");
		expect(spies.readChunkSpy.mock.calls.length).toBe(1);
		expect(spies.closeSpy).toHaveBeenCalledTimes(1);
		expect(await fsp.readFile(artifactPath, "utf8")).toBe("B".repeat(ARTIFACT_TEST_STREAM_BYTES));
	});

	it("closes the retained native handle when a consumer cancels", async () => {
		const { manager, id } = await fixture("x".repeat(ARTIFACT_TEST_STREAM_BYTES));
		const spies = forwardingNativeFileSpies();
		const reader = (await manager.openReadStream(id)).getReader();
		const first = await reader.read();
		expect(first.value?.byteLength).toBe(64 * 1024);
		await reader.cancel("consumer stopped");

		expect(spies.openFileSpy).toHaveBeenCalledTimes(1);
		expect(spies.readChunkSpy).toHaveBeenCalledTimes(1);
		expect(spies.closeSpy).toHaveBeenCalledTimes(1);
	});

	it("rejects a replaced managed root between stream chunks and still releases the file handle", async () => {
		const { manager, id, artifactsDir, root } = await fixture("r".repeat(ARTIFACT_TEST_STREAM_BYTES));
		const moved = path.join(root, "moved-artifacts");
		const spies = forwardingNativeFileSpies();
		const reader = (await manager.openReadStream(id)).getReader();
		const first = await reader.read();
		expect(first.value?.byteLength).toBe(64 * 1024);
		await fsp.rename(artifactsDir, moved);
		await fsp.mkdir(artifactsDir, { mode: 0o700 });
		await fsp.writeFile(path.join(artifactsDir, `${id}.tool.log`), "untrusted replacement");

		await expect(reader.read()).rejects.toThrow("Managed descendant root binding changed");
		expect(spies.closeSpy).toHaveBeenCalledTimes(1);
	});

	it("path-backed range reads reject a symlink swapped in after the leaf descriptor opens", async () => {
		const { manager, id, artifactPath, root } = await fixture("path-backed trusted", true);
		const outside = path.join(root, "outside.txt");
		const displaced = path.join(root, "displaced.txt");
		await fsp.writeFile(outside, "path-backed outside secret");
		expect(await manager.readRange(id, { start: 2, endExclusive: 10 })).toBe("th-backe");
		const openSync = fs.openSync.bind(fs);
		let replaced = false;
		vi.spyOn(fs, "openSync").mockImplementation(((file: fs.PathLike, flags?: fs.OpenMode, mode?: fs.Mode) => {
			const fd = openSync(file, flags as never, mode as never);
			const pathname = typeof file === "string" ? file : file.toString();
			if (!replaced && path.resolve(pathname) === path.resolve(artifactPath)) {
				replaced = true;
				fs.renameSync(artifactPath, displaced);
				fs.symlinkSync(outside, artifactPath);
			}
			return fd;
		}) as typeof fs.openSync);

		// Which source-binding refusal fires first depends on whether this read
		// captures the expected descriptor before or after the swap: a leaf that is
		// re-checked by name reports `source_changed`, and a descriptor bound against
		// the previously retained identity reports
		// `managed_range_generation_mismatch`. Both refuse, and the outside file must
		// never be read either way, so assert the refusal set rather than the winner.
		await expect(manager.readRange(id)).rejects.toThrow(/^(?:source_changed|managed_range_generation_mismatch)$/u);
		expect(replaced).toBe(true);
		expect(await fsp.readFile(outside, "utf8")).toBe("path-backed outside secret");
	});

	it("path-backed streams pin the captured metadata across chunks and close every opened descriptor", async () => {
		const { manager, id, artifactPath } = await fixture("p".repeat(ARTIFACT_TEST_STREAM_BYTES), true);
		const openSync = fs.openSync.bind(fs);
		const closeSync = fs.closeSync.bind(fs);
		const readDescriptors = new Set<number>();
		let openedReadDescriptors = 0;
		let closedReadDescriptors = 0;
		vi.spyOn(fs, "openSync").mockImplementation(((file: fs.PathLike, flags?: fs.OpenMode, mode?: fs.Mode) => {
			const fd = openSync(file, flags as never, mode as never);
			const pathname = typeof file === "string" ? file : file.toString();
			if (
				path.resolve(pathname) === path.resolve(artifactPath) &&
				typeof flags === "number" &&
				(flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR)) === 0
			) {
				openedReadDescriptors++;
				readDescriptors.add(fd);
			}
			return fd;
		}) as typeof fs.openSync);
		vi.spyOn(fs, "closeSync").mockImplementation(((fd: number) => {
			if (readDescriptors.delete(fd)) closedReadDescriptors++;
			return closeSync(fd);
		}) as typeof fs.closeSync);
		const reader = (await manager.openReadStream(id)).getReader();
		const first = await reader.read();
		expect(first.value?.byteLength).toBe(64 * 1024);
		fs.appendFileSync(artifactPath, "changed after the first chunk");

		await expect(reader.read()).rejects.toThrow("managed_range_generation_mismatch");
		expect(openedReadDescriptors).toBeGreaterThan(0);
		expect(closedReadDescriptors).toBe(openedReadDescriptors);
		expect(readDescriptors.size).toBe(0);
	});
});

const ARTIFACT_TEST_STREAM_BYTES = 2 * 64 * 1024 + 17;
