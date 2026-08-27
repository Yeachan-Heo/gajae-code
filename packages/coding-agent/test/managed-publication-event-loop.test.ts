import { describe, expect, it, vi } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as native from "@gajae-code/natives";
import { ArtifactManager } from "../src/session/artifacts";
import {
	MANAGED_ARTIFACT_MAX_FILES,
	ManagedSessionDescendantStore,
	managedDirectoryRoot,
	publishManagedFileNoReplace,
	publishManagedFileNoReplaceSync,
	reapScrubbedProtocolRemnants,
	reapScrubbedProtocolRemnantsSync,
} from "../src/session/internal/managed-session-storage";

const REMNANT_PREFIX = ".gjc-exact-unlink-placeholder-";

async function withTempDir<T>(prefix: string, run: (dir: string) => Promise<T>): Promise<T> {
	const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
	try {
		return await run(dir);
	} finally {
		await fsp.rm(dir, { recursive: true, force: true });
	}
}

async function seedRemnant(
	dir: string,
	name: string,
	ageMs: number,
	bytes: Uint8Array = new Uint8Array(),
): Promise<string> {
	const pathname = path.join(dir, name);
	await fsp.writeFile(pathname, bytes, { mode: 0o600 });
	const stamp = new Date(Date.now() - ageMs);
	await fsp.utimes(pathname, stamp, stamp);
	return pathname;
}

async function waitFor(condition: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await condition()) return;
		await Bun.sleep(25);
	}
	throw new Error("condition not met before timeout");
}

describe("async native no-replace publication boundary (issue #4394)", () => {
	it("renameNoReplacePathAsync publishes and never settles from a microtask", async () => {
		await withTempDir("gjc-async-rename-", async dir => {
			const staging = path.join(dir, "staging");
			const destination = path.join(dir, "published");
			await fsp.writeFile(staging, "payload");

			let settled = false;
			const pending = native.renameNoReplacePathAsync(staging, destination).then(result => {
				settled = true;
				return result;
			});
			// A libuv blocking-pool completion is a macrotask: draining microtasks
			// must never observe settlement, which is exactly the property that keeps
			// the resident event loop unblocked during publication.
			await Promise.resolve();
			await Promise.resolve();
			expect(settled).toBe(false);

			const result = await pending;
			expect(result.ok).toBe(true);
			expect(await fsp.readFile(destination, "utf8")).toBe("payload");
			expect(fs.existsSync(staging)).toBe(false);
		});
	});

	it("renameNoReplacePathAsync refuses an existing destination without replacing it", async () => {
		await withTempDir("gjc-async-rename-conflict-", async dir => {
			const staging = path.join(dir, "staging");
			const destination = path.join(dir, "published");
			await fsp.writeFile(staging, "successor");
			await fsp.writeFile(destination, "predecessor");

			const result = await native.renameNoReplacePathAsync(staging, destination);
			expect(result.ok).toBe(false);
			expect(result.mutationState).toBe("not_committed");
			expect(await fsp.readFile(destination, "utf8")).toBe("predecessor");
		});
	});

	it("publishManagedFileNoReplace crosses the threadpool boundary and matches the sync twin", async () => {
		await withTempDir("gjc-async-publish-", async dir => {
			const destination = path.join(dir, "generation.output");
			const bytes = new TextEncoder().encode("managed-output");

			let settled = false;
			const pending = publishManagedFileNoReplace(destination, bytes).then(() => {
				settled = true;
			});
			await Promise.resolve();
			await Promise.resolve();
			expect(settled).toBe(false);
			await pending;

			expect(await fsp.readFile(destination)).toEqual(Buffer.from(bytes));
			// No staging object may survive a committed publication.
			expect((await fsp.readdir(dir)).filter(name => name.includes(".staging"))).toEqual([]);

			// The sync twin publishes identical bytes under the same protocol.
			const syncDestination = path.join(dir, "sync.output");
			publishManagedFileNoReplaceSync(syncDestination, bytes);
			expect(await fsp.readFile(syncDestination)).toEqual(Buffer.from(bytes));
		});
	});

	it("publishManagedFileNoReplace rejects an existing destination as destination_conflict", async () => {
		await withTempDir("gjc-async-publish-conflict-", async dir => {
			const destination = path.join(dir, "generation.output");
			publishManagedFileNoReplaceSync(destination, new TextEncoder().encode("first"));
			await expect(publishManagedFileNoReplace(destination, new TextEncoder().encode("second"))).rejects.toThrow(
				"destination_conflict",
			);
			expect(await fsp.readFile(destination, "utf8")).toBe("first");
		});
	});

	it("yields macrotask turns to the event loop while a publication is in flight", async () => {
		await withTempDir("gjc-async-publish-liveness-", async dir => {
			const bytes = new Uint8Array(4 * 1024 * 1024).fill(0x61);
			let settled = 0;
			const publications = Array.from({ length: 8 }, (_, index) =>
				publishManagedFileNoReplace(path.join(dir, `generation-${index}.output`), bytes).then(() => {
					settled += 1;
				}),
			);
			// Each publication is a chain of sequential threadpool round trips, so a
			// zero-delay timer (one macrotask turn) must fire before any of them can
			// settle. The pre-fix chain ran synchronously and starved exactly these
			// turns, which is what froze await timeouts in issue #4394.
			await Bun.sleep(0);
			expect(settled).toBe(0);
			await Bun.sleep(0);
			await Promise.all(publications);
			expect(settled).toBe(8);
		});
	});
});

describe("scrubbed protocol remnant reaping (issue #4394)", () => {
	it("returns the retained native terminal identity for no-replace publication", async () => {
		await withTempDir("gjc-terminal-publish-identity-", async dir => {
			const store = new ManagedSessionDescendantStore(managedDirectoryRoot(dir), dir);
			const bytes = Buffer.from("terminal-identity\n");
			const returned = store.publishNoReplaceSync("session.jsonl", bytes);
			const observed = store.readExpected("session.jsonl");
			expect(observed).not.toBeNull();
			if (!observed) throw new Error("published identity unavailable");
			expect(returned).toEqual(observed.identity);
			expect(returned.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
		});
	});

	it("reaps aged zero-byte remnants and retains everything else", async () => {
		await withTempDir("gjc-remnant-reap-", async dir => {
			const aged = await seedRemnant(dir, `${REMNANT_PREFIX}aged`, 60 * 60 * 1000);
			const fresh = await seedRemnant(dir, `${REMNANT_PREFIX}fresh`, 0);
			const payload = await seedRemnant(dir, `${REMNANT_PREFIX}payload`, 60 * 60 * 1000, new Uint8Array([1]));
			const ordinary = path.join(dir, "session.jsonl");
			await fsp.writeFile(ordinary, "transcript");

			const result = await reapScrubbedProtocolRemnants(dir);

			expect(result).toEqual({ reaped: 1, failures: 0 });
			expect(fs.existsSync(aged)).toBe(false);
			expect(fs.existsSync(fresh)).toBe(true);
			expect(fs.existsSync(payload)).toBe(true);
			expect(fs.existsSync(ordinary)).toBe(true);
		});
	});

	it("reaps inert fallback exchange debris under the approved recovery directory", async () => {
		await withTempDir("gjc-exchange-remnant-reap-", async dir => {
			const recovery = path.join(dir, ".gjc-recovery");
			await fsp.mkdir(recovery, { mode: 0o700 });
			const aged = await seedRemnant(recovery, ".gjc-managed-exchange-123-456", 60 * 60 * 1000);
			const fresh = await seedRemnant(recovery, ".gjc-managed-exchange-123-457", 0);
			const payload = await seedRemnant(
				recovery,
				".gjc-managed-exchange-123-458",
				60 * 60 * 1000,
				new Uint8Array([1]),
			);

			const result = await reapScrubbedProtocolRemnants(dir);

			expect(result).toEqual({ reaped: 1, failures: 0 });
			expect(fs.existsSync(aged)).toBe(false);
			expect(fs.existsSync(fresh)).toBe(true);
			expect(fs.existsSync(payload)).toBe(true);
		});
	});

	it("reaps bound recovery debris through retained native authority", async () => {
		await withTempDir("gjc-bound-recovery-reap-", async dir => {
			const recovery = path.join(dir, ".gjc-recovery");
			await fsp.mkdir(recovery, { mode: 0o700 });
			const aged = await seedRemnant(recovery, ".gjc-replace-retry-bound", 60 * 60 * 1000);
			const authority = native.openRecoveryFsRoot(dir);
			try {
				const result = authority.reapScrubbedProtocolRemnants(0);

				expect(result).toEqual({ reaped: 1, failures: 0 });
				expect(fs.existsSync(aged)).toBe(false);
			} finally {
				authority.close();
			}
		});
	});

	it("reaps inherited recovery debris for a retained descendant authority", async () => {
		await withTempDir("gjc-inherited-recovery-reap-", async dir => {
			const sessionDir = path.join(dir, "session");
			await fsp.mkdir(sessionDir, { mode: 0o700 });
			const recovery = path.join(dir, ".gjc-recovery");
			await fsp.mkdir(recovery, { mode: 0o700 });
			const aged = await seedRemnant(recovery, ".gjc-replace-retry-inherited", 60 * 60 * 1000);
			const root = native.openRecoveryFsRoot(dir);
			const session = await fsp.lstat(sessionDir, { bigint: true });
			const retained = root.retainManagedDirectory("session", session.dev.toString(), session.ino.toString());
			try {
				expect(retained.reapScrubbedProtocolRemnants(0)).toEqual({ reaped: 1, failures: 0 });
				expect(fs.existsSync(aged)).toBe(false);
			} finally {
				retained.close();
				root.close();
			}
		});
	});

	it("matches the sync reaper's result on the same directory shape", async () => {
		await withTempDir("gjc-remnant-parity-", async dir => {
			for (let index = 0; index < 4; index++) {
				await seedRemnant(dir, `${REMNANT_PREFIX}aged-${index}`, 60 * 60 * 1000);
			}
			await seedRemnant(dir, `${REMNANT_PREFIX}fresh`, 0);
			const asyncResult = await reapScrubbedProtocolRemnants(dir);
			for (let index = 0; index < 4; index++) {
				await seedRemnant(dir, `${REMNANT_PREFIX}aged-${index}`, 60 * 60 * 1000);
			}
			const syncResult = reapScrubbedProtocolRemnantsSync(dir);
			expect(asyncResult).toEqual(syncResult);
			expect(asyncResult).toEqual({ reaped: 4, failures: 0 });
		});
	});

	it("drains a directory larger than the yield batch without missing entries", async () => {
		await withTempDir("gjc-remnant-bounded-", async dir => {
			const count = 600;
			for (let index = 0; index < count; index++) {
				await seedRemnant(dir, `${REMNANT_PREFIX}${index.toString().padStart(4, "0")}`, 60 * 60 * 1000);
			}
			const result = await reapScrubbedProtocolRemnants(dir);
			expect(result).toEqual({ reaped: count, failures: 0 });
			expect((await fsp.readdir(dir)).filter(name => name.startsWith(REMNANT_PREFIX))).toEqual([]);
		});
	});

	it("yields while scanning retained non-remnant evidence", async () => {
		await withTempDir("gjc-remnant-inert-scan-", async dir => {
			const retained = await seedRemnant(dir, ".gjc-managed-exchange-retained", 60 * 60 * 1000, new Uint8Array([1]));
			const inertNames = Array.from(
				{ length: 600 },
				(_, index) => `retained-evidence-${index.toString().padStart(4, "0")}`,
			);
			const readdir = vi.spyOn(fsp, "readdir").mockResolvedValue(inertNames as never);
			let yielded = false;
			const turn = Bun.sleep(0).then(() => {
				yielded = true;
			});

			const result = await reapScrubbedProtocolRemnants(dir);
			await turn;

			expect(result).toEqual({ reaped: 0, failures: 0 });
			expect(yielded).toBe(true);
			expect(fs.existsSync(retained)).toBe(true);
			expect(readdir).toHaveBeenCalledWith(dir);
			readdir.mockRestore();
		});
	});

	it("treats a missing directory as a benign no-op", async () => {
		const missing = path.join(os.tmpdir(), `gjc-remnant-missing-${Date.now()}`);
		expect(await reapScrubbedProtocolRemnants(missing)).toEqual({ reaped: 0, failures: 0 });
	});

	it("store mutations schedule best-effort reaping of the bound per-session directory", async () => {
		await withTempDir("gjc-remnant-store-", async dir => {
			const sessionDir = path.join(dir, "session");
			await fsp.mkdir(sessionDir, { mode: 0o700 });
			const aged = await seedRemnant(sessionDir, `${REMNANT_PREFIX}aged`, 60 * 60 * 1000);
			const fresh = await seedRemnant(sessionDir, `${REMNANT_PREFIX}fresh`, 0);

			const store = new ManagedSessionDescendantStore(managedDirectoryRoot(dir), sessionDir);
			store.publishNoReplaceSync("session.jsonl", Buffer.from("transcript\n"));

			await waitFor(async () => !fs.existsSync(aged));
			// The age gate still protects in-flight protocol steps.
			expect(fs.existsSync(fresh)).toBe(true);
			expect(await fsp.readFile(path.join(sessionDir, "session.jsonl"), "utf8")).toBe("transcript\n");
		});
	});

	// Reduces the observed production deadlock to its semantics: a long-lived
	// session scope accumulated 50,003 dirents of which 47,043 were inert
	// zero-byte write-protocol remnants and 0 were receipts. The per-mutation
	// receipt scan counted every dirent, so it threw
	// `managed_replace_cleanup_receipt_limit_exceeded` before examining a
	// single receipt, and the remnant reaper -- the only thing that could
	// shrink the directory -- was scheduled after that throw and never ran.
	// Every mutation then failed permanently, tool-output eviction could not
	// persist, and the retained originals drove the session into the
	// emergency heap floor. Scale is reduced here; the over-limit dirents
	// case is pinned by the test further below.
	it("keeps mutating a scope saturated with inert remnants and reaps them", async () => {
		await withTempDir("gjc-remnant-saturated-", async dir => {
			const sessionDir = path.join(dir, "session");
			await fsp.mkdir(sessionDir, { mode: 0o700 });

			// Aged zero-byte remnants far beyond the yield batch, with no
			// receipts at all: remnants never count toward the receipt scan
			// limit, and reaping stays reachable on a busy scope.
			const remnantCount = 1200;
			const aged: string[] = [];
			for (let index = 0; index < remnantCount; index++) {
				aged.push(await seedRemnant(sessionDir, `${REMNANT_PREFIX}sat-${index}`, 60 * 60 * 1000));
			}
			expect(fs.readdirSync(sessionDir).length).toBe(remnantCount);

			const store = new ManagedSessionDescendantStore(managedDirectoryRoot(dir), sessionDir);
			// The mutation must succeed rather than throw the receipt-limit error.
			store.publishNoReplaceSync("session.jsonl", Buffer.from("transcript\n"));
			expect(await fsp.readFile(path.join(sessionDir, "session.jsonl"), "utf8")).toBe("transcript\n");

			// Reaping was reachable, so the scope drains instead of staying wedged.
			await waitFor(async () => !fs.existsSync(aged[0] as string));
			await waitFor(async () => !fs.existsSync(aged[remnantCount - 1] as string));

			// A subsequent mutation still works on the drained scope.
			store.publishNoReplaceSync("second.jsonl", Buffer.from("second\n"));
			expect(await fsp.readFile(path.join(sessionDir, "second.jsonl"), "utf8")).toBe("second\n");
		});
	});

	// The pre-fix regression at true scale: more dirents than
	// REPLACEMENT_CLEANUP_RECEIPT_SCAN_LIMIT (= MANAGED_ARTIFACT_MAX_FILES),
	// every one of them an inert remnant and none of them a receipt. Counting
	// dirents instead of receipts aborted the scan before the reaper could
	// ever run, so this is the exact shape that failed every mutation forever.
	it("mutates a scope holding more inert remnants than the receipt scan limit", async () => {
		await withTempDir("gjc-remnant-over-limit-", async dir => {
			const sessionDir = path.join(dir, "session");
			await fsp.mkdir(sessionDir, { mode: 0o700 });

			const remnantCount = MANAGED_ARTIFACT_MAX_FILES + 50;
			const stamp = new Date(Date.now() - 60 * 60 * 1000);
			const remnantPath = (index: number) => path.join(sessionDir, `${REMNANT_PREFIX}limit-${index}`);
			for (let index = 0; index < remnantCount; index++) {
				fs.writeFileSync(remnantPath(index), "", { mode: 0o600 });
				fs.utimesSync(remnantPath(index), stamp, stamp);
			}
			expect(fs.readdirSync(sessionDir).length).toBe(remnantCount);

			const store = new ManagedSessionDescendantStore(managedDirectoryRoot(dir), sessionDir);
			// Under the pre-fix per-dirent counting this throws
			// `managed_replace_cleanup_receipt_limit_exceeded`; the limit
			// must bound receipts, not directory occupancy.
			store.publishNoReplaceSync("session.jsonl", Buffer.from("transcript\n"));
			expect(await fsp.readFile(path.join(sessionDir, "session.jsonl"), "utf8")).toBe("transcript\n");

			// The saturated scope keeps mutating.
			store.publishNoReplaceSync("second.jsonl", Buffer.from("second\n"));
			expect(await fsp.readFile(path.join(sessionDir, "second.jsonl"), "utf8")).toBe("second\n");

			// Reaping stays reachable on the oversize scope and drains it
			// fully (readdir order is not index order, so wait on the count).
			await waitFor(async () => !fs.existsSync(remnantPath(0)), 60_000);
			await waitFor(
				async () => fs.readdirSync(sessionDir).filter(name => name.startsWith(REMNANT_PREFIX)).length === 0,
				180_000,
			);
		});
	}, 300_000);

	it("fails closed on a corrupt replacement-cleanup receipt without deleting it", async () => {
		await withTempDir("gjc-receipt-corrupt-", async dir => {
			const sessionDir = path.join(dir, "session");
			await fsp.mkdir(sessionDir, { mode: 0o700 });
			const receiptPath = path.join(sessionDir, ".gjc-replace-cleanup-1-2-receipt-3-4.json");
			const receiptBytes = Buffer.from("not a receipt");
			await fsp.writeFile(receiptPath, receiptBytes, { mode: 0o600 });

			const store = new ManagedSessionDescendantStore(managedDirectoryRoot(dir), sessionDir);
			expect(() => store.publishNoReplaceSync("session.jsonl", Buffer.from("transcript\n"))).toThrow(
				"managed_replace_cleanup_receipt_invalid",
			);
			// Fail-closed must not eat evidence: the receipt and its payload
			// survive untouched, and nothing was published.
			expect(await fsp.readFile(receiptPath)).toEqual(receiptBytes);
			expect(fs.existsSync(path.join(sessionDir, "session.jsonl"))).toBe(false);
		});
	});

	it("fails closed on an unparseable pending replacement receipt", async () => {
		await withTempDir("gjc-receipt-pending-corrupt-", async dir => {
			const sessionDir = path.join(dir, "session");
			await fsp.mkdir(sessionDir, { mode: 0o700 });
			const pendingPath = path.join(sessionDir, ".gjc-replace-receipt-pending-1");
			await fsp.writeFile(pendingPath, "garbage", { mode: 0o600 });

			const store = new ManagedSessionDescendantStore(managedDirectoryRoot(dir), sessionDir);
			expect(() => store.publishNoReplaceSync("session.jsonl", Buffer.from("transcript\n"))).toThrow(
				"managed_replace_cleanup_receipt_invalid",
			);
			expect(await fsp.readFile(pendingPath, "utf8")).toBe("garbage");
			expect(fs.existsSync(path.join(sessionDir, "session.jsonl"))).toBe(false);
		});
	});

	it("still schedules remnant reaping when reconciliation fails closed", async () => {
		await withTempDir("gjc-receipt-fail-reap-", async dir => {
			const sessionDir = path.join(dir, "session");
			await fsp.mkdir(sessionDir, { mode: 0o700 });
			const remnant = await seedRemnant(sessionDir, `${REMNANT_PREFIX}aged`, 60 * 60 * 1000);
			await fsp.writeFile(path.join(sessionDir, ".gjc-replace-cleanup-1-2-receipt-3-4.json"), "not a receipt", {
				mode: 0o600,
			});

			const store = new ManagedSessionDescendantStore(managedDirectoryRoot(dir), sessionDir);
			expect(() => store.publishNoReplaceSync("session.jsonl", Buffer.from("transcript\n"))).toThrow(
				"managed_replace_cleanup_receipt_invalid",
			);
			// The pre-fix ordering scheduled the reaper only after a successful
			// scan, so a scope whose scan failed could never drain through its
			// own mutations. Reaping must stay reachable even when the
			// mutation itself fails closed.
			await waitFor(async () => !fs.existsSync(remnant));
		});
	});

	it("never reaps symlinks, hardlinks, directories, or non-empty and fresh remnants", async () => {
		await withTempDir("gjc-remnant-refusal-", async dir => {
			const sessionDir = path.join(dir, "session");
			await fsp.mkdir(sessionDir, { mode: 0o700 });

			const control = await seedRemnant(sessionDir, `${REMNANT_PREFIX}aged-control`, 60 * 60 * 1000);
			const fresh = await seedRemnant(sessionDir, `${REMNANT_PREFIX}fresh`, 0);
			const payload = await seedRemnant(sessionDir, `${REMNANT_PREFIX}payload`, 60 * 60 * 1000, new Uint8Array([7]));

			// Aged remnant-named hardlink pair: the single-link capture fence
			// must retain both names.
			const hardlink = path.join(sessionDir, `${REMNANT_PREFIX}hardlink`);
			const alias = path.join(sessionDir, "hardlink-alias");
			await fsp.writeFile(hardlink, "", { mode: 0o600 });
			await fsp.link(hardlink, alias);
			const stamp = new Date(Date.now() - 60 * 60 * 1000);
			await fsp.utimes(hardlink, stamp, stamp);

			// Aged remnant-named directory with user data inside: never
			// unlinked, never recursed into.
			const nestedDir = path.join(sessionDir, `${REMNANT_PREFIX}directory`);
			await fsp.mkdir(nestedDir, { mode: 0o700 });
			await fsp.writeFile(path.join(nestedDir, "user-data"), "kept", { mode: 0o600 });

			// Aged remnant-named symlink pointing outside the store: retained,
			// and its target is never followed or deleted.
			const outside = path.join(dir, "outside-target");
			await fsp.writeFile(outside, "kept", { mode: 0o600 });
			const symlink = path.join(sessionDir, `${REMNANT_PREFIX}symlink`);
			if (process.platform !== "win32") await fsp.symlink(outside, symlink);

			const store = new ManagedSessionDescendantStore(managedDirectoryRoot(dir), sessionDir);
			store.publishNoReplaceSync("session.jsonl", Buffer.from("transcript\n"));

			await waitFor(async () => !fs.existsSync(control));
			expect(fs.existsSync(fresh)).toBe(true);
			expect(fs.existsSync(payload)).toBe(true);
			expect(fs.existsSync(hardlink)).toBe(true);
			expect(fs.existsSync(alias)).toBe(true);
			expect(await fsp.readFile(path.join(nestedDir, "user-data"), "utf8")).toBe("kept");
			if (process.platform !== "win32") {
				expect(fs.existsSync(symlink)).toBe(true);
				expect(await fsp.readFile(outside, "utf8")).toBe("kept");
			}
			expect(await fsp.readFile(path.join(sessionDir, "session.jsonl"), "utf8")).toBe("transcript\n");
		});
	});
});

describe("managed output generation publication over the async boundary", () => {
	it("publishes selector, output, and metadata through the async path", async () => {
		await withTempDir("gjc-managed-generation-", async dir => {
			const artifactsDir = path.join(dir, "artifacts");
			const store = new ManagedSessionDescendantStore(managedDirectoryRoot(dir), artifactsDir);
			const manager = new ArtifactManager(store);

			const output = new TextEncoder().encode("leaf subagent output");
			const metadata = new TextEncoder().encode(JSON.stringify({ tool: "task", status: "complete" }));
			await manager.publishManagedOutputGeneration("task-1.selector", "task-1", output, metadata);

			const selector = JSON.parse(await fsp.readFile(path.join(artifactsDir, "task-1.selector"), "utf8")) as {
				outputFilename: string;
				metadataFilename: string;
			};
			expect(selector.outputFilename.startsWith("task-1.")).toBe(true);
			expect(await fsp.readFile(path.join(artifactsDir, selector.outputFilename))).toEqual(Buffer.from(output));
			expect(await fsp.readFile(path.join(artifactsDir, selector.metadataFilename))).toEqual(Buffer.from(metadata));

			// A second generation replaces the selector and retires the prior pair.
			const secondOutput = new TextEncoder().encode("superseding output");
			await manager.publishManagedOutputGeneration("task-1.selector", "task-1", secondOutput, metadata);
			const secondSelector = JSON.parse(await fsp.readFile(path.join(artifactsDir, "task-1.selector"), "utf8")) as {
				outputFilename: string;
				metadataFilename: string;
			};
			expect(secondSelector.outputFilename).not.toBe(selector.outputFilename);
			expect(await fsp.readFile(path.join(artifactsDir, secondSelector.outputFilename))).toEqual(
				Buffer.from(secondOutput),
			);
			expect(fs.existsSync(path.join(artifactsDir, selector.outputFilename))).toBe(false);
			expect(fs.existsSync(path.join(artifactsDir, selector.metadataFilename))).toBe(false);
		});
	});

	it("keeps an uncoordinated selector successor when a later generation rewrites", async () => {
		await withTempDir("gjc-managed-generation-successor-", async dir => {
			const artifactsDir = path.join(dir, "artifacts");
			const store = new ManagedSessionDescendantStore(managedDirectoryRoot(dir), artifactsDir);
			const manager = new ArtifactManager(store);
			const metadata = new TextEncoder().encode(JSON.stringify({ tool: "task", status: "complete" }));
			await manager.publishManagedOutputGeneration(
				"task-1.selector",
				"task-1",
				new TextEncoder().encode("first generation"),
				metadata,
			);

			const selectorPath = path.join(artifactsDir, "task-1.selector");
			const predecessorPath = path.join(artifactsDir, "selector-predecessor");
			const successor = JSON.stringify({ outputFilename: "task-1.foreign.output" });
			const realReplace = native.RecoveryFsRoot.prototype.replaceManaged;
			const replace = vi.spyOn(native.RecoveryFsRoot.prototype, "replaceManaged").mockImplementation(function (
				this: native.RecoveryFsRoot,
				relativePath,
				bytes,
				expectedDev,
				expectedIno,
				expectedSize,
				expectedMtimeNs,
				expectedCtimeNs,
				expectedSha256,
			) {
				fs.renameSync(selectorPath, predecessorPath);
				fs.writeFileSync(selectorPath, successor);
				return realReplace.call(
					this,
					relativePath,
					bytes,
					expectedDev,
					expectedIno,
					expectedSize,
					expectedMtimeNs,
					expectedCtimeNs,
					expectedSha256,
				);
			});
			try {
				await expect(
					manager.publishManagedOutputGeneration(
						"task-1.selector",
						"task-1",
						new TextEncoder().encode("second generation"),
						metadata,
					),
				).rejects.toThrow("identity_mismatch");
				expect(await fsp.readFile(selectorPath, "utf8")).toBe(successor);
				expect(await fsp.readFile(predecessorPath, "utf8")).not.toBe(successor);
			} finally {
				replace.mockRestore();
			}
		});
	});
});
