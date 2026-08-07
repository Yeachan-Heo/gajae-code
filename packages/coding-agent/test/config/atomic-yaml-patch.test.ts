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
	atomicYamlPathHash,
	withAtomicYamlConfigTransaction,
} from "../../src/config/atomic-yaml-patch";

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

	test("reclaims a stale lock with malformed owner metadata", async () => {
		const configPath = await configPathForTest();
		const lockPath = `${configPath}.lock`;
		await fs.mkdir(lockPath);
		await fs.writeFile(path.join(lockPath, "info"), JSON.stringify({ pid: 0, timestamp: "invalid" }));
		const staleAt = new Date(Date.now() - 20_000);
		await fs.utimes(lockPath, staleAt, staleAt);

		await applyAtomicYamlPatches(configPath, [{ path: "feature.enabled", op: "set", value: true }]);
		expect(await readYaml(configPath)).toEqual({ feature: { enabled: true } });
	});

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

	test("keeps the old complete file and removes the temp file when rename exhausts", async () => {
		const configPath = await configPathForTest();
		await fs.writeFile(configPath, YAML.stringify({ durable: { value: "old" } }, null, 2));
		const sharingViolation = Object.assign(new Error("sharing violation"), { code: "EPERM" });

		await expect(
			applyAtomicYamlPatches(configPath, [{ path: "durable.value", op: "set", value: "new" }], {
				platform: "win32",
				rename: async () => {
					throw sharingViolation;
				},
				sleep: async () => {},
			}),
		).rejects.toBeInstanceOf(AtomicYamlReplaceError);

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
});
