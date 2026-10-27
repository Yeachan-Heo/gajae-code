import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { exactReplacePath } from "@gajae-code/natives";
import { YAML } from "bun";
import {
	AtomicYamlConflictError,
	type AtomicYamlPatch,
	AtomicYamlReplaceError,
	applyAtomicYamlPatches,
	applyAtomicYamlPatchesWithCurrent,
	atomicYamlPathHash,
	deleteByPath,
	enqueueAtomicYamlOperation,
	reserveAtomicYamlPatchSlot,
	reserveAtomicYamlUpdateSlot,
	setByPath,
	withAtomicYamlConfigTransaction,
} from "../../src/config/atomic-yaml-patch";
import { FileLockAcquireError, FileLockTestHooks } from "../../src/config/file-lock";

const temporaryDirectories: string[] = [];

async function configPathForTest(): Promise<string> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-atomic-yaml-"));
	temporaryDirectories.push(directory);
	return path.join(directory, "config.yml");
}

async function readYaml(configPath: string): Promise<Record<string, unknown>> {
	const parsed = YAML.parse(await fs.readFile(configPath, "utf8"));
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
	return parsed as Record<string, unknown>;
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })),
	);
});

describe("atomic YAML patches", () => {
	for (const writer of ["direct", "supplier", "builder", "transaction", "combined"] as const) {
		test(`snapshots getter-backed patches and preserves stale CAS in ${writer}`, async () => {
			const configPath = await configPathForTest();
			const before = "feature:\n  keep: true\n";
			await Bun.write(configPath, before);
			let pathReads = 0,
				opReads = 0,
				expectedReads = 0,
				expectedPathReads = 0,
				hashReads = 0;
			const patch = {
				get path() {
					return ++pathReads === 1 ? "feature.keep" : "";
				},
				get op() {
					return ++opReads === 1 ? ("set" as const) : ("invalid" as const);
				},
				value: false,
				get expected() {
					expectedReads++;
					return {
						get path() {
							return ++expectedPathReads === 1 ? "feature.keep" : "";
						},
						get hash() {
							return ++hashReads === 1 ? "stale" : "";
						},
					};
				},
			} as unknown as AtomicYamlPatch;
			const patches: AtomicYamlPatch[] = [{ path: "sibling", op: "set", value: 1 }, patch];
			const run = () =>
				writer === "direct"
					? applyAtomicYamlPatches(configPath, patches)
					: writer === "supplier"
						? reserveAtomicYamlPatchSlot(configPath, async () => patches)
						: writer === "builder"
							? applyAtomicYamlPatchesWithCurrent(configPath, async () => patches)
							: withAtomicYamlConfigTransaction(configPath, async tx =>
									writer === "transaction"
										? tx.applyPatches(patches)
										: tx.applyPatchesAndRemoveTopLevelKeys(patches, []),
								);
			await expect(run()).rejects.toBeInstanceOf(AtomicYamlConflictError);
			expect([pathReads, opReads, expectedReads, expectedPathReads, hashReads]).toEqual([1, 1, 1, 1, 1]);
			expect(await Bun.file(configPath).text()).toBe(before);
		});
	}

	test("uses the first valid getter values even when later reads would be malformed", async () => {
		const configPath = await configPathForTest();
		await Bun.write(configPath, "feature: old\n");
		let pathReads = 0,
			opReads = 0,
			expectedReads = 0;
		const expected = { path: "feature", hash: atomicYamlPathHash({ feature: "old" }, "feature") };
		const patch = {
			get path() {
				return ++pathReads === 1 ? "feature" : "";
			},
			get op() {
				return ++opReads === 1 ? "set" : "invalid";
			},
			get expected() {
				return ++expectedReads === 1 ? expected : false;
			},
			value: "new",
		} as unknown as AtomicYamlPatch;
		const receipt = await applyAtomicYamlPatchesWithCurrent(configPath, () => [patch], {
			validateRoot: (_root, supplied) => {
				(supplied[0] as { path: string }).path = "other";
			},
		});
		expect([pathReads, opReads, expectedReads]).toEqual([1, 1, 1]);
		expect(await readYaml(configPath)).toEqual({ feature: "new" });
		expect((await receipt.restore()).status).toBe("restored");
		expect(await readYaml(configPath)).toEqual({ feature: "old" });
	});

	test("snapshots before queue wait, sanitizes clone errors, and leaves the queue usable", async () => {
		const configPath = await configPathForTest();
		const gate = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		const pending = enqueueAtomicYamlOperation(configPath, async () => {
			entered.resolve();
			await gate.promise;
		});
		await entered.promise;
		const value = { nested: { keep: true } };
		const write = applyAtomicYamlPatches(configPath, [{ path: "feature", op: "set", value }]);
		value.nested.keep = false;
		expect(() =>
			applyAtomicYamlPatches(configPath, [
				{
					path: "bad",
					op: "set",
					value: {
						get secret() {
							throw new Error("private-secret");
						},
					},
				},
			]),
		).toThrow("could not be read or cloned");
		gate.resolve();
		await pending;
		const receipt = await write;
		expect(await readYaml(configPath)).toEqual({ feature: { nested: { keep: true } } });
		expect((await receipt.restore()).status).toBe("restored");
	});

	test("rejects reentrant transaction mutation during input cloning", async () => {
		const configPath = await configPathForTest();
		await Bun.write(configPath, "feature: old\n");
		let writes = 0;
		await withAtomicYamlConfigTransaction(configPath, async tx => {
			const attempts: Promise<PromiseSettledResult<unknown>>[] = [];
			const value = {
				get nested() {
					attempts.push(
						tx.applyPatches([{ path: "other", op: "set", value: "private" }]).then(
							result => ({ status: "fulfilled" as const, value: result }),
							reason => ({ status: "rejected" as const, reason }),
						),
					);
					return true;
				},
			};
			const [outer] = await Promise.allSettled([
				tx.applyPatches([{ path: "feature", op: "set", value }], {
					exactReplace: (source, destination, expectedSource, expectedDestination) => {
						writes++;
						return exactReplacePath(source, destination, expectedSource, expectedDestination);
					},
				}),
			]);
			const results = await Promise.all(attempts);
			expect(results).toHaveLength(1);
			expect(results[0]?.status).toBe("rejected");
			if (results[0]?.status === "rejected") {
				expect(results[0].reason).toBeInstanceOf(Error);
				expect(results[0].reason.message).toContain("cannot mutate while patch input is being read");
			}
			if (outer!.status === "rejected") throw outer!.reason;
			expect(outer!.value.revisions.map(revision => revision.path)).toEqual(["feature"]);
			expect(tx.written).toBe(true);
		});
		expect(writes).toBe(1);
		expect(await readYaml(configPath)).toEqual({ feature: { nested: true } });
		const remaining = (await fs.readdir(path.dirname(configPath))).filter(name => name !== path.basename(configPath));
		for (const name of remaining) {
			expect(name).toMatch(/^\.gjc-exact-replace-destination-[0-9a-f]+-[0-9a-f]+$/);
			expect((await fs.stat(path.join(path.dirname(configPath), name))).size).toBe(0);
		}
	});

	test("builder and transaction inspection cannot mutate writer-owned YAML", async () => {
		const configPath = await configPathForTest();
		await Bun.write(configPath, "feature:\n  nested:\n    keep: true\nother: old\n");
		const receipt = await applyAtomicYamlPatchesWithCurrent(configPath, async current => {
			(current.feature as { nested: { keep: boolean } }).nested.keep = false;
			return [{ path: "other", op: "set", value: "new" }];
		});
		expect(await readYaml(configPath)).toEqual({ feature: { nested: { keep: true } }, other: "new" });
		expect((await receipt.restore()).status).toBe("restored");
		await withAtomicYamlConfigTransaction(configPath, async tx => {
			(tx.current.feature as { nested: { keep: boolean } }).nested.keep = false;
			(tx.root as { feature: { nested: { keep: boolean } } }).feature.nested.keep = false;
			await tx.applyPatches([{ path: "other", op: "set", value: "transaction" }]);
		});
		expect(await readYaml(configPath)).toEqual({ feature: { nested: { keep: true } }, other: "transaction" });
	});

	for (const ancestor of ["selector", null, ["selector"]]) {
		test(`rejects set across non-record ancestor ${JSON.stringify(ancestor)} without partial state`, async () => {
			const configPath = await configPathForTest();
			await Bun.write(configPath, YAML.stringify({ modelRoles: { custom: ancestor }, sibling: "old" }));
			const before = await Bun.file(configPath).text();
			const patches: AtomicYamlPatch[] = [
				{ path: "sibling", op: "set", value: "new" },
				{ path: "modelRoles.custom.child", op: "set", value: "new" },
			];
			await expect(applyAtomicYamlPatches(configPath, patches)).rejects.toThrow("non-record ancestor");
			await withAtomicYamlConfigTransaction(configPath, async tx => {
				await expect(tx.applyPatches(patches)).rejects.toThrow("non-record ancestor");
				expect(tx.current).toEqual({ modelRoles: { custom: ancestor }, sibling: "old" });
				expect(tx.written).toBe(false);
			});
			expect(await Bun.file(configPath).text()).toBe(before);
			await expect(
				applyAtomicYamlPatches(configPath, [{ ...patches[1]!, expected: { path: "sibling", hash: "stale" } }]),
			).rejects.toBeInstanceOf(AtomicYamlConflictError);
			const receipt = await applyAtomicYamlPatches(configPath, [{ path: "new.parent.child", op: "set", value: 1 }]);
			expect((await receipt.restore()).status).toBe("restored");
			expect((await readYaml(configPath)).modelRoles).toEqual({ custom: ancestor });
		});
	}
	test("rejects malformed present preconditions before any batch write", async () => {
		const configPath = await configPathForTest();
		const before = "feature:\n  keep: true\n";
		await Bun.write(configPath, before);
		for (const expected of [false, 0, "", null, {}, { path: "feature.keep", hash: "" }]) {
			const invalid = {
				path: "feature.keep",
				op: "set",
				value: "private-payload",
				expected,
			} as unknown as AtomicYamlPatch;
			try {
				applyAtomicYamlPatches(configPath, [{ path: "other", op: "set", value: 1 }, invalid]);
				throw new Error("Expected invalid precondition rejection");
			} catch (error) {
				expect(String(error)).toContain("preconditions");
				expect(String(error)).not.toContain("private-payload");
			}
			expect(await Bun.file(configPath).text()).toBe(before);
		}
		await applyAtomicYamlPatches(configPath, [
			{
				path: "feature.keep",
				op: "set",
				value: false,
				expected: { path: "feature.keep", hash: atomicYamlPathHash({ feature: { keep: true } }, "feature.keep") },
			},
		]);
		expect(await readYaml(configPath)).toEqual({ feature: { keep: false } });
		await expect(
			applyAtomicYamlPatches(configPath, [
				{ path: "feature.keep", op: "set", value: true, expected: { path: "feature.keep", hash: "wrong" } },
			]),
		).rejects.toBeInstanceOf(AtomicYamlConflictError);
		expect(await readYaml(configPath)).toEqual({ feature: { keep: false } });
		await applyAtomicYamlPatches(configPath, [{ path: "feature.keep", op: "set", value: true, expected: undefined }]);
		expect(await readYaml(configPath)).toEqual({ feature: { keep: true } });
	});
	test("rejects unsafe patch and precondition segments before writing any sibling", async () => {
		const configPath = await configPathForTest();
		const before = "feature:\n  keep: true\n";
		await Bun.write(configPath, before);
		const marker = "gjcAtomicPathMarker";
		const original = Object.getOwnPropertyDescriptor(Object.prototype, marker);
		try {
			for (const segment of ["__proto__", "constructor", "prototype"]) {
				for (const op of ["set", "unset"] as const) {
					const unsafe: AtomicYamlPatch =
						op === "set"
							? { path: `feature.${segment}.${marker}`, op, value: "private-patch-value" }
							: { path: `feature.${segment}.${marker}`, op };
					try {
						applyAtomicYamlPatches(configPath, [{ path: "feature.keep", op: "set", value: false }, unsafe]);
						throw new Error("Expected unsafe path rejection");
					} catch (error) {
						expect(String(error)).toContain("safe dotted path");
						expect(String(error)).not.toContain("private-patch-value");
					}
					expect(() =>
						applyAtomicYamlPatches(configPath, [
							{
								path: "feature.keep",
								op: "set",
								value: false,
								expected: { path: `feature.${segment}.${marker}`, hash: "hash" },
							},
						]),
					).toThrow("preconditions");
					expect(await Bun.file(configPath).text()).toBe(before);
					expect(Object.getOwnPropertyDescriptor(Object.prototype, marker)).toEqual(original);
				}
			}
		} finally {
			if (original) Object.defineProperty(Object.prototype, marker, original);
			else delete (Object.prototype as Record<string, unknown>)[marker];
		}
	});

	test("direct path helpers reject unsafe segments and ignore inherited properties", () => {
		const inherited = { branch: { keep: true } };
		const root = Object.create(inherited) as Record<string, unknown>;
		const marker = "gjcAtomicPathMarker";
		const original = Object.getOwnPropertyDescriptor(Object.prototype, marker);
		try {
			for (const segment of ["__proto__", "constructor", "prototype"]) {
				const segments = ["branch", segment, marker];
				expect(() => setByPath(root, segments, true)).toThrow("safe dotted path");
				expect(() => deleteByPath(root, segments)).toThrow("safe dotted path");
				expect(() => atomicYamlPathHash(root, segments.join("."))).toThrow("safe dotted path");
				expect(Object.getOwnPropertyDescriptor(Object.prototype, marker)).toEqual(original);
			}
			expect(atomicYamlPathHash(root, "branch.keep")).toBe(atomicYamlPathHash({}, "branch.keep"));
			deleteByPath(root, ["branch", "keep"]);
			expect(inherited.branch.keep).toBe(true);
			setByPath(root, ["branch", "added"], 1);
			expect(root.branch).toEqual({ added: 1 });
			expect(inherited.branch).toEqual({ keep: true });
			setByPath(root, ["toString", "value"], 1);
			expect(Object.getOwnPropertyDescriptor(root, "toString")?.value as unknown).toEqual({ value: 1 });
			expect(() => setByPath({ alias: Object.prototype }, ["alias", marker], true)).toThrow("Object.prototype");
			expect(() => deleteByPath({ alias: Object.prototype }, ["alias", marker])).toThrow("Object.prototype");
		} finally {
			if (original) Object.defineProperty(Object.prototype, marker, original);
			else delete (Object.prototype as Record<string, unknown>)[marker];
		}
	});
	test("rejects ancestor and descendant batches without consuming prior receipt ownership", async () => {
		const configPath = await configPathForTest();
		const prior = await applyAtomicYamlPatches(configPath, [
			{ path: "feature", op: "set", value: { enabled: false } },
		]);
		const before = await Bun.file(configPath).text();
		const patches: AtomicYamlPatch[] = [
			{ path: "feature", op: "set", value: { enabled: true, other: "new" } },
			{ path: "feature.enabled", op: "set", value: false },
		];
		for (const ordered of [patches, [...patches].reverse()]) {
			await expect(applyAtomicYamlPatches(configPath, ordered)).rejects.toThrow("overlapping paths");
			expect(await Bun.file(configPath).text()).toBe(before);
		}
		expect((await prior.restore()).status).toBe("restored");
		expect(await readYaml(configPath)).toEqual({});
	});

	test("retains ordered same-path writes in a restorable batch", async () => {
		const configPath = await configPathForTest();
		await Bun.write(configPath, "feature:\n  enabled: false\n");
		const receipt = await applyAtomicYamlPatches(configPath, [
			{ path: "feature.enabled", op: "set", value: false },
			{ path: "feature.enabled", op: "set", value: true },
		]);
		expect(await readYaml(configPath)).toEqual({ feature: { enabled: true } });
		expect((await receipt.restore()).status).toBe("restored");
		expect(await readYaml(configPath)).toEqual({ feature: { enabled: false } });
	});
	for (const writer of ["patch", "update"] as const) {
		for (const values of [[true], [false, true]]) {
			test(`fences receipt ownership through a symlink with ${writer} writes ${values.join("/")}`, async () => {
				const configPath = await configPathForTest();
				const receipt = await applyAtomicYamlPatches(configPath, [
					{ path: "feature.enabled", op: "set", value: true },
				]);
				const alias = path.join(path.dirname(configPath), "alias.yml");
				await fs.symlink(configPath, alias);
				for (const enabled of values) {
					if (writer === "patch") {
						await applyAtomicYamlPatches(alias, [{ path: "feature", op: "set", value: { enabled } }]);
					} else {
						await reserveAtomicYamlUpdateSlot(alias, () => ({
							apply: current => {
								current.feature = { enabled };
							},
							mutationPaths: () => ["feature"],
						}));
					}
				}
				expect(await receipt.restore()).toEqual({ status: "conflict", paths: ["feature.enabled"] });
				expect(await readYaml(configPath)).toEqual({ feature: { enabled: true } });
			});
		}
	}

	test("ordinary update ownership preserves unrelated receipt restoration", async () => {
		const configPath = await configPathForTest();
		const receipt = await applyAtomicYamlPatches(configPath, [{ path: "feature.enabled", op: "set", value: true }]);
		await reserveAtomicYamlUpdateSlot(configPath, () => ({
			apply: current => {
				current.unrelated = "keep";
			},
			mutationPaths: () => ["unrelated"],
		}));
		expect((await receipt.restore()).status).toBe("restored");
		expect(await readYaml(configPath)).toMatchObject({ unrelated: "keep" });
	});

	test("serializes concurrent writers and preserves unrelated keys", async () => {
		const configPath = await configPathForTest();
		await fs.writeFile(configPath, YAML.stringify({ external: { keep: true } }, null, 2));

		await Promise.all([
			applyAtomicYamlPatches(configPath, [{ path: "settings.first", op: "set", value: "A" }]),
			applyAtomicYamlPatches(configPath, [{ path: "settings.second", op: "set", value: "B" }]),
		]);

		expect(await readYaml(configPath)).toEqual({
			external: { keep: true },
			settings: { first: "A", second: "B" },
		});
	});

	test("clones caller-owned patch values before the queued write runs", async () => {
		const configPath = await configPathForTest();
		const callerValue = { enabled: false };
		const write = applyAtomicYamlPatches(configPath, [{ path: "feature", op: "set", value: callerValue }]);
		callerValue.enabled = true;

		await write;
		expect(await readYaml(configPath)).toEqual({ feature: { enabled: false } });
	});

	test("returns a hash-only CAS receipt that restores only an unchanged after-state", async () => {
		const configPath = await configPathForTest();
		await fs.writeFile(configPath, YAML.stringify({ feature: { enabled: false } }, null, 2));

		const receipt = await applyAtomicYamlPatches(configPath, [{ path: "feature.enabled", op: "set", value: true }]);
		expect(receipt.revisions).toEqual([
			expect.objectContaining({
				path: "feature.enabled",
				beforeHash: expect.any(String),
				afterHash: expect.any(String),
			}),
		]);
		expect(await receipt.restore()).toMatchObject({ status: "restored" });
		expect(await readYaml(configPath)).toEqual({ feature: { enabled: false } });

		await applyAtomicYamlPatches(configPath, [{ path: "feature.enabled", op: "set", value: "newer" }]);
		expect(await receipt.restore()).toEqual({ status: "conflict", paths: ["feature.enabled"] });
	});

	test("does not restore when its receipt is discarded after restore is queued", async () => {
		const configPath = await configPathForTest();
		await fs.writeFile(configPath, YAML.stringify({ feature: { enabled: false } }, null, 2));
		const receipt = await applyAtomicYamlPatches(configPath, [{ path: "feature.enabled", op: "set", value: true }]);

		const restore = receipt.restore();
		receipt.discard();

		expect(await restore).toEqual({ status: "discarded" });
		expect(await readYaml(configPath)).toEqual({ feature: { enabled: true } });
	});

	test(
		"fails closed on a stale lock with malformed owner metadata",
		async () => {
			const configPath = await configPathForTest();
			const lockPath = `${configPath}.lock`;
			await fs.mkdir(lockPath);
			await fs.writeFile(path.join(lockPath, "info"), JSON.stringify({ pid: 0, timestamp: "invalid" }));
			const staleAt = new Date(Date.now() - 20_000);
			await fs.utimes(lockPath, staleAt, staleAt);

			await expect(
				applyAtomicYamlPatches(configPath, [{ path: "feature.enabled", op: "set", value: true }]),
			).rejects.toThrow(FileLockAcquireError);
			expect(await fs.readFile(path.join(lockPath, "info"), "utf8")).toBe(
				JSON.stringify({ pid: 0, timestamp: "invalid" }),
			);
		},
		{ timeout: 10_000 },
	);

	test("rejects an expected-hash write after another writer wins", async () => {
		const configPath = await configPathForTest();
		const initial = { modelRoles: { default: "provider/original" } };
		await fs.writeFile(configPath, YAML.stringify(initial, null, 2));
		const expected = { path: "modelRoles.default", hash: atomicYamlPathHash(initial, "modelRoles.default") };
		await applyAtomicYamlPatches(configPath, [
			{ path: "modelRoles.default", op: "set", value: "provider/winner", expected },
		]);
		await expect(
			applyAtomicYamlPatches(configPath, [
				{ path: "modelRoles.default", op: "set", value: "provider/loser", expected },
			]),
		).rejects.toBeInstanceOf(AtomicYamlConflictError);
		expect(await readYaml(configPath)).toEqual({ modelRoles: { default: "provider/winner" } });
	});

	test("does not conflate special numeric values with null in expected hashes", async () => {
		const configPath = await configPathForTest();
		await fs.writeFile(configPath, YAML.stringify({ feature: { value: null } }, null, 2));
		const expected = {
			path: "feature.value",
			hash: atomicYamlPathHash({ feature: { value: Number.NaN } }, "feature.value"),
		};

		await expect(
			applyAtomicYamlPatches(configPath, [{ path: "feature.value", op: "set", value: "winner", expected }]),
		).rejects.toBeInstanceOf(AtomicYamlConflictError);
		expect(await readYaml(configPath)).toEqual({ feature: { value: null } });
	});

	test("rejects ambiguous undefined set patches", () => {
		const patch = { path: "feature.enabled", op: "set", value: undefined } as unknown as AtomicYamlPatch;
		expect(() => applyAtomicYamlPatches("/tmp/gjc-atomic-invalid.yml", [patch])).toThrow(TypeError);
	});

	test("keeps the old complete file and removes the temp file when the exchange fails", async () => {
		const configPath = await configPathForTest();
		await fs.writeFile(configPath, YAML.stringify({ durable: { value: "old" } }, null, 2));
		const sharingViolation = Object.assign(new Error("sharing violation"), { code: "EPERM" });

		await expect(
			applyAtomicYamlPatches(configPath, [{ path: "durable.value", op: "set", value: "new" }], {
				exactReplace: async () => {
					throw sharingViolation;
				},
			}),
		).rejects.toBe(sharingViolation);

		expect(await readYaml(configPath)).toEqual({ durable: { value: "old" } });
		const directoryEntries = await fs.readdir(path.dirname(configPath));
		expect(directoryEntries.filter(entry => entry.endsWith(".tmp"))).toEqual([]);
	});

	test("rejects and removes listeners when the native worker closes or exits before responding", async () => {
		const configPath = await configPathForTest();
		const originalWorker = globalThis.Worker;
		type TerminalEvent = "close" | "exit";
		class TerminalWorker {
			#handlers = new Map<string, Set<EventListener>>();

			constructor(private readonly terminalEvent: TerminalEvent) {}

			postMessage(): void {
				queueMicrotask(() => {
					for (const handler of this.#handlers.get(this.terminalEvent) ?? [])
						handler(new Event(this.terminalEvent));
				});
			}

			addEventListener(type: string, listener: EventListener): void {
				let handlers = this.#handlers.get(type);
				if (!handlers) {
					handlers = new Set();
					this.#handlers.set(type, handlers);
				}
				handlers.add(listener);
			}

			removeEventListener(type: string, listener: EventListener): void {
				this.#handlers.get(type)?.delete(listener);
			}

			terminate(): void {}

			listenerCount(): number {
				return [...this.#handlers.values()].reduce((count, handlers) => count + handlers.size, 0);
			}
		}

		try {
			let iteration = 0;
			for (const terminalEvent of ["close", "exit"] as const) {
				iteration++;
				const worker = new TerminalWorker(terminalEvent);
				(globalThis as unknown as { Worker: typeof Worker }).Worker = class {
					constructor() {
						// biome-ignore lint/correctness/noConstructorReturn: new Worker() is intercepted so the constructor must return the pre-built TerminalWorker that tracks listener registration.
						return worker as unknown as Worker;
					}
				} as unknown as typeof Worker;

				await expect(
					withAtomicYamlConfigTransaction(configPath, async tx => {
						await tx.applyPatches([{ path: "feature.enabled", op: "set", value: true }]);
					}),
				).rejects.toBeInstanceOf(AtomicYamlReplaceError);
				expect(worker.listenerCount()).toBe(0);
				// The native op was already dispatched: its outcome is unknown, so
				// the staged path must be retained for recovery, never unlinked.
				expect((await fs.readdir(path.dirname(configPath))).filter(entry => entry.endsWith(".tmp"))).toHaveLength(
					iteration,
				);
			}
		} finally {
			(globalThis as unknown as { Worker: typeof Worker }).Worker = originalWorker;
		}
	});
	test("transaction exposes root/current and applies patches under the lock", async () => {
		const configPath = await configPathForTest();
		await fs.writeFile(configPath, YAML.stringify({ external: { keep: true } }, null, 2));

		let observedRoot: unknown;
		let observedCurrent: Record<string, unknown> | undefined;
		const result = await withAtomicYamlConfigTransaction(configPath, async tx => {
			observedRoot = structuredClone(tx.root);
			observedCurrent = structuredClone(tx.current);
			await tx.applyPatches([{ path: "settings.first", op: "set", value: "A" }]);
			await tx.applyPatches([{ path: "settings.second", op: "set", value: "B" }]);
			return "done";
		});

		expect(result).toBe("done");
		expect(observedRoot).toEqual({ external: { keep: true } });
		expect(observedCurrent).toEqual({ external: { keep: true } });
		expect(await readYaml(configPath)).toEqual({
			external: { keep: true },
			settings: { first: "A", second: "B" },
		});
	});

	test("transaction surfaces a parse failure before the callback runs", async () => {
		const configPath = await configPathForTest();
		await fs.writeFile(configPath, "broken: [unclosed", "utf8");

		let callbackRan = false;
		await expect(
			withAtomicYamlConfigTransaction(configPath, async () => {
				callbackRan = true;
				return "unreachable";
			}),
		).rejects.toThrow();
		expect(callbackRan).toBe(false);
	});

	test("transaction exposes a scalar/array root without writing", async () => {
		const configPath = await configPathForTest();
		await fs.writeFile(configPath, YAML.stringify(["a", "b"], null, 2));

		let observedRoot: unknown = "unset";
		await withAtomicYamlConfigTransaction(configPath, async tx => {
			observedRoot = tx.root;
			return "noop";
		});

		expect(observedRoot).toEqual(["a", "b"]);
		expect(YAML.parse(await fs.readFile(configPath, "utf8"))).toEqual(["a", "b"]);
	});
	test("transaction removes dotted top-level keys verbatim", async () => {
		const configPath = await configPathForTest();
		await fs.writeFile(
			configPath,
			YAML.stringify({ "gjc.ralplan.maxIterations": "bad", gjc: { ralplan: { maxIterations: 7 } } }, null, 2),
		);

		await withAtomicYamlConfigTransaction(configPath, async tx => {
			const receipt = await tx.removeTopLevelKeys(["gjc.ralplan.maxIterations"]);
			expect((await receipt.restore()).status).toBe("not-restorable");
			return "done";
		});

		expect(YAML.parse(await fs.readFile(configPath, "utf8"))).toEqual({ gjc: { ralplan: { maxIterations: 7 } } });
	});
	test("transaction replaces the whole document atomically", async () => {
		const configPath = await configPathForTest();
		await fs.writeFile(configPath, YAML.stringify({ old: { keep: false }, theme: { dark: "red" } }, null, 2));

		await withAtomicYamlConfigTransaction(configPath, async tx => {
			await tx.replaceCurrent({ theme: { dark: "blue" } });
			return "done";
		});

		expect(YAML.parse(await fs.readFile(configPath, "utf8"))).toEqual({ theme: { dark: "blue" } });
	});
	test("an empty file deleted between the transaction read and write is a conflict", async () => {
		const target = await configPathForTest();
		await fs.writeFile(target, "", "utf8");

		await expect(
			withAtomicYamlConfigTransaction(target, async tx => {
				await fs.rm(target);
				await tx.applyPatches([{ path: "b", op: "set", value: 2 }]);
			}),
		).rejects.toBeInstanceOf(AtomicYamlConflictError);
		expect(await fs.stat(target).catch((error: NodeJS.ErrnoException) => error.code)).toBe("ENOENT");
	});

	test("an empty file created at an absent path between the transaction read and write is a conflict", async () => {
		const target = await configPathForTest();

		await expect(
			withAtomicYamlConfigTransaction(target, async tx => {
				await fs.writeFile(target, "", "utf8");
				await tx.applyPatches([{ path: "b", op: "set", value: 2 }]);
			}),
		).rejects.toBeInstanceOf(AtomicYamlConflictError);
		expect(await fs.readFile(target, "utf8")).toBe("");
	});

	test("an external edit between the transaction read and write is not overwritten", async () => {
		const target = await configPathForTest();
		await fs.writeFile(target, YAML.stringify({ a: 1 }, null, 2));

		await expect(
			withAtomicYamlConfigTransaction(target, async tx => {
				// Simulate an external editor saving config.yml after the
				// transaction read it (external editors do not take the lock).
				await fs.writeFile(target, YAML.stringify({ a: 99 }, null, 2));
				await tx.applyPatches([{ path: "b", op: "set", value: 2 }]);
			}),
		).rejects.toThrow(/precondition failed/i);

		// The external edit is preserved, not overwritten by the stale snapshot.
		const after = YAML.parse(await fs.readFile(target, "utf8")) as Record<string, unknown>;
		expect(after.a).toBe(99);
		expect(after.b).toBeUndefined();
	});

	test("builder rejects an external edit after its read and retains the editor's file", async () => {
		const configPath = await configPathForTest();
		await Bun.write(configPath, "feature: old\nsibling: old\n");
		await expect(
			applyAtomicYamlPatchesWithCurrent(configPath, async () => {
				await Bun.write(configPath, "feature: old\nsibling: external\n");
				return [{ path: "feature", op: "set", value: "new" }];
			}),
		).rejects.toBeInstanceOf(AtomicYamlConflictError);
		expect(await readYaml(configPath)).toEqual({ feature: "old", sibling: "external" });
	});

	for (const writer of ["builder", "restore"] as const) {
		test(`${writer} preserves an external save at the exact identity exchange`, async () => {
			const configPath = await configPathForTest();
			await Bun.write(configPath, "feature: old\nsibling: old\n");
			let inject = writer === "builder";
			const options = {
				exactReplace: async (
					source: string,
					destination: string,
					expectedSource: Parameters<typeof exactReplacePath>[2],
					expectedDestination: Parameters<typeof exactReplacePath>[3],
				) => {
					if (inject) {
						inject = false;
						await Bun.write(
							destination,
							writer === "builder" ? "feature: old\nsibling: external\n" : "feature: new\nsibling: external\n",
						);
					}
					return exactReplacePath(source, destination, expectedSource, expectedDestination);
				},
			};
			if (writer === "builder") {
				await expect(
					applyAtomicYamlPatchesWithCurrent(
						configPath,
						() => [{ path: "feature", op: "set", value: "new" }],
						options,
					),
				).rejects.toBeInstanceOf(AtomicYamlConflictError);
				expect(await readYaml(configPath)).toEqual({ feature: "old", sibling: "external" });
			} else {
				const receipt = await applyAtomicYamlPatches(
					configPath,
					[{ path: "feature", op: "set", value: "new" }],
					options,
				);
				inject = true;
				await expect(receipt.restore()).rejects.toBeInstanceOf(AtomicYamlConflictError);
				expect(await readYaml(configPath)).toEqual({ feature: "new", sibling: "external" });
				expect((await receipt.restore()).status).toBe("restored");
				expect(await readYaml(configPath)).toEqual({ feature: "old", sibling: "external" });
			}
			expect((await fs.readdir(path.dirname(configPath))).filter(entry => entry.endsWith(".tmp"))).toEqual([]);
		});
	}

	test("restore detects an external edit during validation without consuming its receipt", async () => {
		const configPath = await configPathForTest();
		await Bun.write(configPath, "feature: old\nsibling: old\n");
		let inject = false;
		const receipt = await applyAtomicYamlPatches(configPath, [{ path: "feature", op: "set", value: "new" }], {
			validateRoot: async () => {
				if (inject) {
					inject = false;
					await Bun.write(configPath, "feature: external\nsibling: old\n");
				}
			},
		});
		inject = true;
		await expect(receipt.restore()).rejects.toBeInstanceOf(AtomicYamlConflictError);
		expect(await readYaml(configPath)).toEqual({ feature: "external", sibling: "old" });
		expect(await receipt.restore()).toEqual({ status: "conflict", paths: ["feature"] });
	});

	test("preserves an editor save injected at the final identity-checked exchange", async () => {
		const configPath = await configPathForTest();
		await fs.writeFile(configPath, YAML.stringify({ durable: { value: "old" } }, null, 2));

		await expect(
			withAtomicYamlConfigTransaction(configPath, async tx => {
				await tx.applyPatches([{ path: "durable.value", op: "set", value: "new" }], {
					exactReplace: async (sourcePath, destinationPath, expectedSource, expectedDestination) => {
						// This is the formerly unsafe final check-to-rename window.
						await fs.writeFile(destinationPath, YAML.stringify({ durable: { value: "edited" } }, null, 2));
						return exactReplacePath(sourcePath, destinationPath, expectedSource, expectedDestination);
					},
				});
			}),
		).rejects.toBeInstanceOf(AtomicYamlConflictError);

		// The native exchange validates the destination identity in the same
		// operation, so the injected editor save is never replaced.
		expect(await readYaml(configPath)).toEqual({ durable: { value: "edited" } });
		expect((await fs.readdir(path.dirname(configPath))).filter(entry => entry.endsWith(".tmp"))).toEqual([]);
	});

	test("retains recovery state after a post-exchange native failure", async () => {
		const configPath = await configPathForTest();
		await fs.writeFile(configPath, YAML.stringify({ durable: { value: "old" } }, null, 2));

		await expect(
			withAtomicYamlConfigTransaction(configPath, async tx => {
				await tx.applyPatches([{ path: "durable.value", op: "set", value: "new" }], {
					exactReplace: async (sourcePath, destinationPath) => {
						// Model an exchange that published the successor but left the
						// predecessor at the staged path for recovery.
						const predecessorPath = `${sourcePath}.predecessor`;
						await fs.rename(destinationPath, predecessorPath);
						await fs.rename(sourcePath, destinationPath);
						await fs.rename(predecessorPath, sourcePath);
						return {
							ok: false,
							code: "identity_mismatch",
							detachedPath: sourcePath,
							retainedUnknownPath: destinationPath,
						};
					},
				});
			}),
		).rejects.toBeInstanceOf(AtomicYamlReplaceError);

		expect(await readYaml(configPath)).toEqual({ durable: { value: "new" } });
		expect((await fs.readdir(path.dirname(configPath))).filter(entry => entry.endsWith(".tmp"))).toHaveLength(1);
	});

	test("retries an unsupported no-replace publish with the link fallback", async () => {
		const configPath = await configPathForTest();
		let calls = 0;

		await withAtomicYamlConfigTransaction(configPath, async tx => {
			await tx.applyPatches([{ path: "durable.value", op: "set", value: "new" }], {
				noReplace: async (_sourcePath, destinationPath) => {
					calls++;
					if (calls === 1) {
						// RENAME_NOREPLACE unsupported (NFS / kernel < 3.15): a clean
						// pre-mutation refusal that permits the linkat fallback.
						return {
							ok: false,
							reason: "atomic_unavailable",
							code: "ENOSYS",
							mutationState: "not_committed",
							durabilityState: "not_attempted",
							primitive: "renameat2",
							phase: "publish",
							diagnostic: { schemaVersion: 1, collectionState: "not_committed" },
						};
					}
					// linkat publishes without consuming the staging name.
					await fs.writeFile(destinationPath, YAML.stringify({ durable: { value: "new" } }, null, 2));
					return {
						ok: true,
						reason: "ok",
						mutationState: "committed",
						durabilityState: "proven",
						primitive: "linkat_noreplace",
						phase: "complete",
						diagnostic: { schemaVersion: 1, collectionState: "committed" },
					};
				},
			});
		});

		expect(calls).toBe(2);
		expect(await readYaml(configPath)).toEqual({ durable: { value: "new" } });
	});

	test("retains staging after an ambiguous no-replace publication", async () => {
		const configPath = await configPathForTest();

		await expect(
			withAtomicYamlConfigTransaction(configPath, async tx => {
				await tx.applyPatches([{ path: "durable.value", op: "set", value: "new" }], {
					noReplace: async (_sourcePath, destinationPath) => {
						await fs.writeFile(destinationPath, YAML.stringify({ durable: { value: "new" } }, null, 2));
						return {
							ok: false,
							mutationState: "unknown",
							durabilityState: "unknown",
							reason: "native failure",
							primitive: "renameat2",
							phase: "publish",
							diagnostic: { schemaVersion: 1, collectionState: "unknown" },
						};
					},
				});
			}),
		).rejects.toBeInstanceOf(AtomicYamlReplaceError);

		expect(await readYaml(configPath)).toEqual({ durable: { value: "new" } });
		expect((await fs.readdir(path.dirname(configPath))).filter(entry => entry.endsWith(".tmp"))).toHaveLength(1);
	});

	test("follows a symlinked config.yml during exact replacement", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-atomic-yaml-symlink-"));
		temporaryDirectories.push(directory);
		const realTarget = path.join(directory, "real-config.yml");
		const configPath = path.join(directory, "config.yml");
		await fs.writeFile(realTarget, YAML.stringify({ durable: { value: "old" } }, null, 2));
		await fs.symlink(realTarget, configPath);

		await withAtomicYamlConfigTransaction(configPath, async tx => {
			await tx.applyPatches([{ path: "durable.value", op: "set", value: "new" }]);
			return "done";
		});

		// The identity-checked exchange operated on the REAL target through the
		// symlink (the native replace opens the destination with no-follow
		// semantics); the link entry itself is preserved and still resolves to
		// the new content.
		expect(await readYaml(realTarget)).toEqual({ durable: { value: "new" } });
		expect(await readYaml(configPath)).toEqual({ durable: { value: "new" } });
		expect((await fs.lstat(configPath)).isSymbolicLink()).toBe(true);
	});

	test("publishes a first write through a dangling config.yml symlink", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-atomic-yaml-dangling-"));
		temporaryDirectories.push(directory);
		const realTarget = path.join(directory, "real-config.yml");
		const configPath = path.join(directory, "config.yml");
		// The symlink target does not exist yet (dangling link): realpathSync
		// fails, so the canonical path must resolve the link target lexically
		// instead of treating the symlink entry itself as the config (the native
		// no-replace would reject the existing symlink as destination_exists).
		await fs.symlink(realTarget, configPath);

		await withAtomicYamlConfigTransaction(configPath, async tx => {
			await tx.applyPatches([{ path: "durable.value", op: "set", value: "new" }]);
			return "done";
		});

		// The no-replace publication created the REAL target; the link resolves.
		expect(await readYaml(realTarget)).toEqual({ durable: { value: "new" } });
		expect(await readYaml(configPath)).toEqual({ durable: { value: "new" } });
		expect((await fs.lstat(configPath)).isSymbolicLink()).toBe(true);
	});

	test("fails closed when the native exchange is unavailable", async () => {
		const configPath = await configPathForTest();
		const initial = YAML.stringify({ original: { keep: true } }, null, 2);
		await fs.writeFile(configPath, initial);

		// NFS / old-kernel hosts have no RENAME_EXCHANGE: the native exact
		// replacement reports atomic_unavailable. A detached-swap fallback would
		// briefly expose an ABSENT config.yml to concurrent readers (workflow
		// resolvers do not take the config lock), so the write must FAIL CLOSED
		// and leave the existing destination untouched.
		let failure: { cause?: { message?: string } } | null = null;
		failure = await withAtomicYamlConfigTransaction(configPath, async tx => {
			await tx.applyPatches([{ path: "updated.value", op: "set", value: true }], {
				exactReplace: async () => ({ ok: false, code: "atomic_unavailable" }),
			});
			return "done";
		}).then(
			() => null,
			(err: unknown) => err as { cause?: { message?: string } },
		);
		// The AtomicYamlReplaceError message is a fixed template; the
		// atomic_unavailable detail lives on the cause.
		expect(failure?.cause?.message).toContain("atomic_unavailable");

		// The pre-existing config.yml survives byte for byte, and no swap
		// artifacts are created.
		expect(await readYaml(configPath)).toEqual({ original: { keep: true } });
		const leftovers = (await fs.readdir(path.dirname(configPath))).filter(name => name.includes(".swap"));
		expect(leftovers).toEqual([]);
	});

	test("rejects a config.yml symlink retarget before publication", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-atomic-yaml-retarget-"));
		temporaryDirectories.push(directory);
		const realTarget = path.join(directory, "real-config.yml");
		const otherTarget = path.join(directory, "other-config.yml");
		const configPath = path.join(directory, "config.yml");
		await fs.writeFile(realTarget, YAML.stringify({ theme: { dark: "red" } }, null, 2));
		await fs.writeFile(otherTarget, YAML.stringify({ other: true }, null, 2));
		await fs.symlink(realTarget, configPath);

		const originalHook = FileLockTestHooks.afterParentMkdir;
		let retargeted = false;
		FileLockTestHooks.afterParentMkdir = async lockPath => {
			if (retargeted || !lockPath.endsWith("real-config.yml.lock")) return;
			retargeted = true;
			// Repoint the symlink while the operation waits in the queue / holds
			// the lock: the write must reject instead of modifying the OLD target
			// and reporting success while the now-active config points elsewhere.
			await fs.rm(configPath, { force: true });
			await fs.symlink(otherTarget, configPath);
		};
		try {
			await expect(
				applyAtomicYamlPatches(configPath, [{ path: "theme.dark", op: "set", value: "blue" }]),
			).rejects.toThrow("Atomic YAML target retargeted");
		} finally {
			FileLockTestHooks.afterParentMkdir = originalHook;
		}
		// Neither the old target nor the newly-active target was modified.
		expect(await readYaml(realTarget)).toEqual({ theme: { dark: "red" } });
		expect(await readYaml(otherTarget)).toEqual({ other: true });
	});

	test("publishes a first write beneath a symlinked parent directory", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-atomic-yaml-parent-link-"));
		temporaryDirectories.push(directory);
		const realDir = path.join(directory, "realdir");
		await fs.mkdir(realDir);
		const linkParent = path.join(directory, "linkparent");
		await fs.symlink(realDir, linkParent, "dir");
		// config.yml does not exist yet beneath a symlinked parent: the canonical
		// target must resolve the existing PARENT, so the write lands in the real
		// directory and a later parent repoint is detectable.
		const configPath = path.join(linkParent, "config.yml");

		await withAtomicYamlConfigTransaction(configPath, async tx => {
			await tx.applyPatches([{ path: "durable.value", op: "set", value: "new" }]);
			return "done";
		});

		expect(await readYaml(path.join(realDir, "config.yml"))).toEqual({ durable: { value: "new" } });
		expect((await fs.lstat(linkParent)).isSymbolicLink()).toBe(true);
	});

	test("rejects a repointed parent symlink for an absent config.yml", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-atomic-yaml-parent-retarget-"));
		temporaryDirectories.push(directory);
		const realDir = path.join(directory, "realdir");
		const otherDir = path.join(directory, "otherdir");
		await fs.mkdir(realDir);
		await fs.mkdir(otherDir);
		const linkParent = path.join(directory, "linkparent");
		await fs.symlink(realDir, linkParent, "dir");
		// config.yml is ABSENT beneath the symlinked parent: the canonical target
		// resolves the existing parent, so repointing it while the operation waits
		// must reject instead of publishing into the new directory.
		const configPath = path.join(linkParent, "config.yml");

		const originalHook = FileLockTestHooks.afterParentMkdir;
		let repointed = false;
		FileLockTestHooks.afterParentMkdir = async lockPath => {
			if (repointed || !lockPath.endsWith("config.yml.lock")) return;
			repointed = true;
			await fs.rm(linkParent, { force: true });
			await fs.symlink(otherDir, linkParent, "dir");
		};
		try {
			await expect(
				applyAtomicYamlPatches(configPath, [{ path: "theme.dark", op: "set", value: "blue" }]),
			).rejects.toThrow("Atomic YAML target retargeted");
		} finally {
			FileLockTestHooks.afterParentMkdir = originalHook;
		}
		// Neither the original nor the repointed target received the write.
		expect(await fs.readdir(realDir)).toEqual([]);
		expect(await fs.readdir(otherDir)).toEqual([]);
	});
	test("rejects a repointed parent symlink for a dangling config.yml symlink", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-atomic-yaml-dangling-parent-retarget-"));
		temporaryDirectories.push(directory);
		const realDir = path.join(directory, "realdir");
		const otherDir = path.join(directory, "otherdir");
		await fs.mkdir(realDir);
		await fs.mkdir(otherDir);
		const linkParent = path.join(directory, "linkparent");
		await fs.symlink(realDir, linkParent, "dir");
		// config.yml is a DANGLING symlink whose absent target lies beneath the
		// symlinked parent: the canonical target must realpath-resolve the
		// deepest existing ancestor (the parent), so repointing the parent while
		// the operation waits must reject instead of publishing into the newly
		// pointed directory (the unresolved lexical target would make the
		// retarget check compare two identical strings and the CAS pass).
		const configPath = path.join(directory, "config.yml");
		await fs.symlink(path.join(linkParent, "real-config.yml"), configPath);

		const originalHook = FileLockTestHooks.afterParentMkdir;
		let repointed = false;
		FileLockTestHooks.afterParentMkdir = async lockPath => {
			if (repointed || !lockPath.endsWith("real-config.yml.lock")) return;
			repointed = true;
			await fs.rm(linkParent, { force: true });
			await fs.symlink(otherDir, linkParent, "dir");
		};
		try {
			await expect(
				applyAtomicYamlPatches(configPath, [{ path: "theme.dark", op: "set", value: "blue" }]),
			).rejects.toThrow("Atomic YAML target retargeted");
		} finally {
			FileLockTestHooks.afterParentMkdir = originalHook;
		}
		// Neither the original nor the repointed target received the write.
		expect(await fs.readdir(realDir)).toEqual([]);
		expect(await fs.readdir(otherDir)).toEqual([]);
	});
	test("rejects a config.yml symlink repointed during the native exchange", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-atomic-yaml-post-exchange-retarget-"));
		temporaryDirectories.push(directory);
		const realTarget = path.join(directory, "real-config.yml");
		const otherTarget = path.join(directory, "other-config.yml");
		await fs.writeFile(realTarget, YAML.stringify({ theme: { dark: "red" } }, null, 2));
		await fs.writeFile(otherTarget, YAML.stringify({ other: true }, null, 2));
		const configPath = path.join(directory, "config.yml");
		await fs.symlink(realTarget, configPath);

		// The native exchange repoints the symlink while the publication runs:
		// the pre-publication retarget check has already passed and the
		// exchange validates only the previously resolved canonical
		// destination, so the post-publication revalidation must reject
		// instead of reporting success while the lexical config.yml points at
		// an unchanged file.
		let repointed = false;
		await expect(
			withAtomicYamlConfigTransaction(configPath, async tx => {
				await tx.applyPatches([{ path: "theme.dark", op: "set", value: "blue" }], {
					exactReplace: async (tempPath: string, destinationPath: string) => {
						// Faithfully simulate the namespace exchange with IDENTITY
						// preservation (the destination ends with the staged
						// inode): a rename dance swaps the two live files.
						const swapPath = `${destinationPath}.swap.${process.pid}.${Math.random().toString(36).slice(2)}`;
						await fs.rename(destinationPath, swapPath);
						await fs.rename(tempPath, destinationPath);
						await fs.rename(swapPath, tempPath);
						if (!repointed) {
							repointed = true;
							await fs.rm(configPath, { force: true });
							await fs.symlink(otherTarget, configPath);
						}
						return { ok: true };
					},
				});
				return "done";
			}),
		).rejects.toThrow("Atomic YAML target retargeted");

		// The operation failed closed with the OLD canonical target restored
		// (the exchange had replaced it before the revalidation detected the
		// repoint): retrying updates the new target without leaving the
		// now-inactive profile modified. The lexical config.yml still resolves
		// through the (repointed) symlink and the other target is untouched.
		expect(await readYaml(realTarget)).toEqual({ theme: { dark: "red" } });
		expect((await fs.lstat(configPath)).isSymbolicLink()).toBe(true);
		expect(await readYaml(otherTarget)).toEqual({ other: true });
	});
	test("removes a retargeted first-write publication from the inactive target", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-atomic-yaml-first-write-retarget-"));
		temporaryDirectories.push(directory);
		const realTarget = path.join(directory, "real-config.yml");
		const otherTarget = path.join(directory, "other-config.yml");
		await fs.writeFile(otherTarget, YAML.stringify({ other: true }, null, 2));
		const configPath = path.join(directory, "config.yml");
		// The canonical target is ABSENT (dangling config.yml symlink): the
		// publication uses the no-replace path, which consumes the temp path.
		// If the symlink is retargeted before the post-check, restoring absence
		// must REMOVE the created file rather than renaming the (gone) temp.
		await fs.symlink(realTarget, configPath);

		let repointed = false;
		await expect(
			applyAtomicYamlPatches(configPath, [{ path: "theme.dark", op: "set", value: "blue" }], {
				// The NONTRANSACTIONAL writer path (reserveAtomicYamlPatchSlot)
				// publishes an absent target through the no-replace path, which
				// consumes the temp path; repoint the symlink right after the
				// publication so the post-publication retarget check fires.
				noReplace: async (tempPath: string, destinationPath: string) => {
					// A hard link preserves the temp inode (like the native
					// no-replace-link): the rollback identity check relies on it.
					await fs.link(tempPath, destinationPath);
					await fs.rm(tempPath, { force: true });
					if (!repointed) {
						repointed = true;
						await fs.rm(configPath, { force: true });
						await fs.symlink(otherTarget, configPath);
					}
					return {
						ok: true,
						reason: "committed",
						code: "SUCCESS",
						mutationState: "committed",
						durabilityState: "durable",
						primitive: "no-replace",
						phase: "published",
						diagnostic: { schemaVersion: 1, collectionState: "committed" },
					};
				},
			}),
		).rejects.toThrow("Atomic YAML target retargeted");

		// The first-write publication was rolled back: the old canonical target
		// is absent again, and the lexical config.yml resolves to the repointed
		// target. This exercises the NONTRANSACTIONAL writer path
		// (reserveAtomicYamlPatchSlot passes no expectedState).
		await expect(fs.stat(realTarget)).rejects.toMatchObject({ code: "ENOENT" });
		expect(await readYaml(otherTarget)).toEqual({ other: true });
	});

	test("preserves a concurrent replacement when the first-write rollback conflicts", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-atomic-yaml-first-write-conflict-"));
		temporaryDirectories.push(directory);
		const realTarget = path.join(directory, "real-config.yml");
		const otherTarget = path.join(directory, "other-config.yml");
		await fs.writeFile(otherTarget, YAML.stringify({ other: true }, null, 2));
		const configPath = path.join(directory, "config.yml");
		await fs.symlink(realTarget, configPath);

		// After the first-write publication, ANOTHER writer replaces the old
		// canonical target (new inode) before the retarget rollback: the
		// identity-checked removal must NOT delete that writer's file - the
		// rollback reports a conflict and the replacement survives.
		let replaced = false;
		await expect(
			applyAtomicYamlPatches(configPath, [{ path: "theme.dark", op: "set", value: "blue" }], {
				noReplace: async (tempPath: string, destinationPath: string) => {
					// A hard link preserves the temp inode (like the native
					// no-replace-link): the rollback identity check relies on it.
					await fs.link(tempPath, destinationPath);
					await fs.rm(tempPath, { force: true });
					if (!replaced) {
						replaced = true;
						// A concurrent writer replaces the created target and
						// the symlink is repointed.
						await fs.rm(destinationPath, { force: true });
						await fs.writeFile(destinationPath, YAML.stringify({ otherWriter: true }, null, 2));
						await fs.rm(configPath, { force: true });
						await fs.symlink(otherTarget, configPath);
					}
					return {
						ok: true,
						reason: "committed",
						code: "SUCCESS",
						mutationState: "committed",
						durabilityState: "durable",
						primitive: "no-replace",
						phase: "published",
						diagnostic: { schemaVersion: 1, collectionState: "committed" },
					};
				},
			}),
			// The rollback reports the identity conflict (the AtomicYamlReplaceError
			// message is a fixed template; the detail lives on the cause).
		).rejects.toMatchObject({
			cause: expect.objectContaining({ message: expect.stringContaining("rollback failed") }),
		});

		// The other writer's replacement is preserved.
		expect(await readYaml(realTarget)).toEqual({ otherWriter: true });
	});

	test("preserves a concurrent replacement when the exchange rollback conflicts", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-atomic-yaml-exchange-conflict-"));
		temporaryDirectories.push(directory);
		const realTarget = path.join(directory, "real-config.yml");
		const otherTarget = path.join(directory, "other-config.yml");
		await fs.writeFile(realTarget, YAML.stringify({ theme: { dark: "red" } }, null, 2));
		await fs.writeFile(otherTarget, YAML.stringify({ other: true }, null, 2));
		const configPath = path.join(directory, "config.yml");
		await fs.symlink(realTarget, configPath);

		// After the exchange, ANOTHER writer replaces the old canonical target
		// before the retarget rollback: the restore must NOT clobber that
		// writer's newer file with the stale pre-publication bytes.
		let replaced = false;
		await expect(
			withAtomicYamlConfigTransaction(configPath, async tx => {
				await tx.applyPatches([{ path: "theme.dark", op: "set", value: "blue" }], {
					exactReplace: async (tempPath: string, destinationPath: string) => {
						// Faithfully simulate the namespace exchange: staged -> dest,
						// dest old content -> temp.
						const staged = await fs.readFile(tempPath, "utf8");
						const old = await fs.readFile(destinationPath, "utf8");
						await fs.writeFile(destinationPath, staged);
						await fs.writeFile(tempPath, old);
						if (!replaced) {
							replaced = true;
							await fs.rm(destinationPath, { force: true });
							await fs.writeFile(destinationPath, YAML.stringify({ otherWriter: true }, null, 2));
							await fs.rm(configPath, { force: true });
							await fs.symlink(otherTarget, configPath);
						}
						return { ok: true };
					},
				});
				return "done";
			}),
		).rejects.toMatchObject({
			cause: expect.objectContaining({ message: expect.stringContaining("rollback failed") }),
		});

		// The concurrent writer's replacement is preserved.
		expect(await readYaml(realTarget)).toEqual({ otherWriter: true });
	});
});
