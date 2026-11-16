import { describe, expect, it, vi } from "bun:test";
import { createHash } from "node:crypto";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { LifecycleLedger, type LifecycleLedgerEntry } from "../../src/sdk/broker/lifecycle-ledger";
import { SessionIndex, type SessionIndexEvent, sessionIndexChecksum } from "../../src/sdk/broker/session-index";
import {
	SDK_STATE_VERSION,
	SESSION_INDEX_EVENT_VERSION,
	SESSION_INDEX_SNAPSHOT_VERSION,
} from "../../src/sdk/broker/state-version";

const ledgerFile = (dir: string) => path.join(dir, "sdk", "lifecycle-ledger.jsonl");
const logFile = (dir: string) => path.join(dir, "sdk", "sessions", "index.jsonl");
const snapshotFile = (dir: string) => path.join(dir, "sdk", "sessions", "index.snapshot.json");
const target = (dir: string) => ({ sessionId: "selected", transcriptPath: path.join(dir, "selected.jsonl"), cwd: dir });
const indexLimits = { maxSnapshotBytes: 1024 * 1024, maxLogBytes: 1024 * 1024, maxRowBytes: 64 * 1024, maxRows: 100 };

async function fixture(run: (dir: string) => Promise<void>): Promise<void> {
	const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-readonly-veto-"));
	try {
		await run(dir);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

async function tree(dir: string): Promise<string[]> {
	const rows: string[] = [];
	for (const entry of (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
		const file = path.join(dir, entry.name);
		if (entry.isDirectory()) rows.push(`${entry.name}/`, ...(await tree(file)).map(row => `${entry.name}/${row}`));
		else if (entry.isSymbolicLink()) rows.push(`${entry.name}->${await fs.readlink(file)}`);
		else
			rows.push(
				`${entry.name}:${createHash("sha256")
					.update(await fs.readFile(file))
					.digest("hex")}`,
			);
	}
	return rows;
}

/** Observe both attempted mutations and persisted effects, including accidental recovery calls. */
async function withoutEffects(
	dir: string,
	run: () => Promise<void>,
	afterOpen?: (handle: fs.FileHandle, file: string) => Promise<void>,
): Promise<void> {
	const before = await tree(dir);
	const mutators = [
		"mkdir",
		"mkdtemp",
		"chmod",
		"rename",
		"unlink",
		"rm",
		"rmdir",
		"writeFile",
		"appendFile",
		"truncate",
		"copyFile",
		"link",
		"symlink",
	] as const;
	const spies = mutators.map(name =>
		vi.spyOn(fs, name).mockImplementation(async () => {
			throw new Error(`Forbidden mutation: ${name}`);
		}),
	);
	const syncMutators = [
		"mkdirSync",
		"mkdtempSync",
		"chmodSync",
		"renameSync",
		"unlinkSync",
		"rmSync",
		"rmdirSync",
		"writeFileSync",
		"appendFileSync",
		"truncateSync",
		"copyFileSync",
		"linkSync",
		"symlinkSync",
	] as const;
	const syncSpies = syncMutators.map(name =>
		vi.spyOn(fsSync, name).mockImplementation(() => {
			throw new Error(`Forbidden mutation: ${name}`);
		}),
	);
	const forbidden = [
		vi.spyOn(LifecycleLedger.prototype, "open"),
		vi.spyOn(SessionIndex.prototype, "open"),
		vi.spyOn(SessionIndex.prototype, "replay"),
		vi.spyOn(SessionIndex.prototype, "diagnose"),
		vi.spyOn(SessionIndex.prototype, "repair"),
	];
	const originalOpenSync = fsSync.openSync;
	const openSync = vi.spyOn(fsSync, "openSync").mockImplementation((file, flags, mode) => {
		expect(typeof flags).toBe("number");
		if (typeof flags !== "number") throw new Error("Non-numeric observation flags");
		expect(
			flags &
				(fsSync.constants.O_WRONLY |
					fsSync.constants.O_RDWR |
					fsSync.constants.O_CREAT |
					fsSync.constants.O_TRUNC |
					fsSync.constants.O_APPEND),
		).toBe(0);
		return originalOpenSync(file, flags, mode);
	});
	const originalOpen = fs.open;
	const open = vi.spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
		expect(typeof flags).toBe("number");
		if (typeof flags !== "number") throw new Error("Non-numeric observation flags");
		expect(
			flags &
				(fsSync.constants.O_WRONLY |
					fsSync.constants.O_RDWR |
					fsSync.constants.O_CREAT |
					fsSync.constants.O_TRUNC |
					fsSync.constants.O_APPEND),
		).toBe(0);
		const handle = await originalOpen(file, flags, mode);
		await afterOpen?.(handle, String(file));
		return handle;
	});
	try {
		await run();
		for (const spy of [...spies, ...syncSpies, ...forbidden]) expect(spy).not.toHaveBeenCalled();
	} finally {
		open.mockRestore();
		openSync.mockRestore();
		for (const spy of [...spies, ...syncSpies, ...forbidden]) spy.mockRestore();
	}
	expect(await tree(dir)).toEqual(before);
}

async function writeLedger(dir: string, rows: readonly LifecycleLedgerEntry[], tail = ""): Promise<void> {
	await fs.mkdir(path.dirname(ledgerFile(dir)), { recursive: true });
	await fs.writeFile(ledgerFile(dir), rows.map(row => `${JSON.stringify(row)}\n`).join("") + tail);
}

function accepted(overrides: Partial<LifecycleLedgerEntry> = {}): LifecycleLedgerEntry {
	return {
		version: SDK_STATE_VERSION,
		identity: "legacy",
		requestHash: "request",
		state: "accepted",
		ts: 1,
		...overrides,
	};
}

function terminal(entry: LifecycleLedgerEntry, overrides: Partial<LifecycleLedgerEntry> = {}): LifecycleLedgerEntry {
	const response = { ok: false, error: { code: "unknown_model_profile", message: "Rejected before launch" } };
	// This exact field order is the canonical order for this refusal response.
	const canonical = '{"error":{"code":"unknown_model_profile","message":"Rejected before launch"},"ok":false}';
	return {
		...entry,
		state: "terminal_error",
		response,
		responseDigest: createHash("sha256").update(canonical).digest("hex"),
		ts: 2,
		...overrides,
	};
}

function event(dir: string, indexSeq: number, overrides: Partial<SessionIndexEvent> = {}): SessionIndexEvent {
	const unsigned: Omit<SessionIndexEvent, "checksum"> = {
		version: SESSION_INDEX_EVENT_VERSION,
		indexSeq,
		type: "host_registered",
		sessionId: "selected",
		locator: { cwd: dir, worktreeRoot: null, stateRoot: dir },
		endpointGeneration: 1,
		pid: process.pid,
		processIncarnation: "recorded-owner-incarnation",
		hostIncarnation: "recorded-owner-incarnation",
		endpointMtimeMs: 123,
		endpointFileId: "endpoint-file-identity",
		ts: 1,
		...overrides,
	};
	return { ...unsigned, checksum: sessionIndexChecksum(unsigned) };
}

async function writeIndex(dir: string, events: readonly SessionIndexEvent[], tail = ""): Promise<void> {
	await fs.mkdir(path.dirname(logFile(dir)), { recursive: true });
	await fs.writeFile(logFile(dir), events.map(row => `${JSON.stringify(row)}\n`).join("") + tail);
}

async function lifecycleParity(dir: string, limits?: { maxBytes?: number; maxLineBytes?: number; maxRows?: number }) {
	const result = await LifecycleLedger.inspectOwnershipReadOnly(dir, target(dir), limits);
	expect(LifecycleLedger.inspectOwnershipReadOnlySync(dir, target(dir), limits)).toEqual(result);
	return result;
}

async function indexParity(dir: string, sessionId = "selected", limits = indexLimits) {
	const result = await SessionIndex.readAuthorityRootsReadOnly(dir, sessionId, limits);
	expect(SessionIndex.readAuthorityRootsReadOnlySync(dir, sessionId, limits)).toEqual(result);
	return result;
}

describe("read-only native ownership vetoes", () => {
	it("leaves a genuinely absent App agentDir absent and returns empty observations, not retirement evidence", async () => {
		await fixture(async dir => {
			const absent = path.join(dir, "not-created");
			await withoutEffects(dir, async () => {
				expect(await lifecycleParity(absent)).toMatchObject({
					kind: "clear",
					digest: expect.stringMatching(/^[a-f0-9]{64}$/),
				});
				expect(await indexParity(absent)).toMatchObject({
					kind: "resolved",
					indexSeq: 0,
					roots: [],
					identities: [],
					digest: expect.stringMatching(/^[a-f0-9]{64}$/),
				});
			});
		});
	});

	it("accepts genuinely absent SDK children beneath a stable existing agent directory", async () => {
		await fixture(async dir => {
			await withoutEffects(dir, async () => {
				expect((await lifecycleParity(dir)).kind).toBe("clear");
				expect(await indexParity(dir)).toMatchObject({ kind: "resolved", indexSeq: 0, roots: [], identities: [] });
			});
		});
	});

	for (const ancestor of ["agentDir", "sdk"] as const) {
		it(`rejects a dangling ${ancestor} ancestor instead of certifying absent ownership`, async () => {
			await fixture(async dir => {
				const agentDir = ancestor === "agentDir" ? path.join(dir, "agent-alias") : dir;
				await fs.symlink(
					path.join(dir, "missing-target"),
					ancestor === "agentDir" ? agentDir : path.join(dir, "sdk"),
				);
				await withoutEffects(dir, async () => {
					expect((await lifecycleParity(agentDir)).kind).toBe("unknown_ownership");
					expect((await indexParity(agentDir)).kind).toBe("unknown_ownership");
				});
			});
		});

		it(`allows a stable ${ancestor} directory alias without mistaking its files for absence`, async () => {
			await fixture(async dir => {
				const agentDir = ancestor === "agentDir" ? path.join(dir, "agent-alias") : dir;
				const destination = path.join(dir, "alias-target");
				await fs.mkdir(destination);
				await fs.symlink(destination, ancestor === "agentDir" ? agentDir : path.join(dir, "sdk"));
				await writeLedger(agentDir, [accepted({ operationKey: "key", fingerprint: "fp" })]);
				await writeIndex(agentDir, [event(agentDir, 1)]);
				await withoutEffects(dir, async () => {
					expect((await lifecycleParity(agentDir)).kind).toBe("clear");
					expect(await indexParity(agentDir)).toMatchObject({
						kind: "resolved",
						indexSeq: 1,
						roots: [await fs.realpath(agentDir)],
						identities: [{ sessionId: "selected", endpointGeneration: 1 }],
					});
				});
			});
		});
	}

	for (const mode of ["async", "sync"] as const) {
		for (const source of ["ledger", "index"] as const) {
			it(`rechecks the existing prefix of genuinely absent ${mode} ${source} files`, async () => {
				await fixture(async dir => {
					const agentDir = path.join(dir, "existing-prefix");
					const retired = path.join(dir, "retired-prefix");
					await fs.mkdir(agentDir);
					const resolvedPrefix = await fs.realpath(agentDir);
					const originalStat = fs.stat;
					const originalStatSync = fsSync.statSync;
					const rename = fsSync.renameSync;
					const mkdir = fsSync.mkdirSync;
					const rmdir = fsSync.rmdirSync;
					let changed = false;
					const replacePrefix = () => {
						rename(agentDir, retired);
						mkdir(agentDir);
						changed = true;
					};
					await withoutEffects(dir, async () => {
						// Only the test changes the namespace; product mutation spies stay installed.
						const observed =
							mode === "async"
								? vi.spyOn(fs, "stat").mockImplementation(
										new Proxy(originalStat, {
											async apply(fn, receiver, args) {
												const result = await Reflect.apply(fn, receiver, args);
												if (!changed && String(args[0]) === resolvedPrefix) replacePrefix();
												return result;
											},
										}),
									)
								: undefined;
						const observedSync =
							mode === "sync"
								? vi.spyOn(fsSync, "statSync").mockImplementation(
										new Proxy(originalStatSync, {
											apply(fn, receiver, args) {
												const result = Reflect.apply(fn, receiver, args);
												if (!changed && String(args[0]) === resolvedPrefix) replacePrefix();
												return result;
											},
										}),
									)
								: undefined;
						try {
							const result =
								source === "ledger"
									? mode === "async"
										? await LifecycleLedger.inspectOwnershipReadOnly(agentDir, target(agentDir))
										: LifecycleLedger.inspectOwnershipReadOnlySync(agentDir, target(agentDir))
									: mode === "async"
										? await SessionIndex.readAuthorityRootsReadOnly(agentDir, "selected")
										: SessionIndex.readAuthorityRootsReadOnlySync(agentDir, "selected");
							expect(changed).toBe(true);
							expect(result.kind).toBe("unknown_ownership");
						} finally {
							observed?.mockRestore();
							observedSync?.mockRestore();
							if (changed) {
								rmdir(agentDir);
								rename(retired, agentDir);
							}
						}
					});
				});
			});
		}
	}

	for (const damage of ["undecodable", "torn", "invalid-hash", "invalid-history", "unsupported"] as const) {
		it(`refuses ${damage} lifecycle history without quarantine, sealing, or recovery`, async () => {
			await fixture(async dir => {
				const row = accepted();
				const rows =
					damage === "invalid-hash"
						? [row, terminal(row, { responseDigest: "0".repeat(64) })]
						: damage === "invalid-history"
							? [terminal(row)]
							: damage === "unsupported"
								? [accepted({ version: 999 as typeof SDK_STATE_VERSION })]
								: [row];
				await writeLedger(
					dir,
					rows,
					damage === "undecodable" ? "{broken}\n" : damage === "torn" ? '{"identity":"other"' : "",
				);
				await withoutEffects(dir, async () => {
					expect((await lifecycleParity(dir)).kind).toBe("legacy_lifecycle_ambiguous");
				});
			});
		});
	}

	it("keeps pre-effect refusals clear but retains the first effect witness as a legacy veto", async () => {
		await fixture(async dir => {
			const row = accepted();
			await writeLedger(dir, [row, terminal(row)]);
			await withoutEffects(dir, async () => {
				expect((await lifecycleParity(dir)).kind).toBe("clear");
			});
			await writeLedger(dir, [row, { ...row, state: "effect_started" }, terminal(row)]);
			await withoutEffects(dir, async () => {
				expect((await lifecycleParity(dir)).kind).toBe("legacy_lifecycle_ambiguous");
			});
		});
	});

	it("excludes only terminal legacy rows naming another session, not active or target rows", async () => {
		await fixture(async dir => {
			const other = accepted({ intendedSessionId: "other" });
			await writeLedger(dir, [other, terminal(other)]);
			await withoutEffects(dir, async () => {
				expect((await lifecycleParity(dir)).kind).toBe("clear");
			});
			await writeLedger(dir, [other]);
			await withoutEffects(dir, async () => {
				expect((await lifecycleParity(dir)).kind).toBe("legacy_lifecycle_ambiguous");
			});
			const selected = accepted({ intendedSessionId: "selected" });
			await writeLedger(dir, [selected, terminal(selected)]);
			await withoutEffects(dir, async () => {
				expect((await lifecycleParity(dir)).kind).toBe("legacy_lifecycle_ambiguous");
			});
		});
	});

	for (const binding of ["accepted-target", "effect-target", "inconsistent-unrelated"] as const) {
		it(`retains ${binding} history when a valid terminal digest names another target`, async () => {
			await fixture(async dir => {
				const row = accepted({ intendedSessionId: binding === "accepted-target" ? "selected" : "other" });
				const effect = {
					...row,
					state: "effect_started" as const,
					intendedSessionId: binding === "inconsistent-unrelated" ? "third" : "selected",
				};
				await writeLedger(dir, [row, effect, terminal(row, { intendedSessionId: "other" })]);
				await withoutEffects(dir, async () => {
					expect(await lifecycleParity(dir)).toMatchObject({
						kind: "legacy_lifecycle_ambiguous",
						reason: "Legacy lifecycle history cannot exclude the selected session target.",
					});
				});
			});
		});
	}

	it("keeps genuinely unrelated effect history clear rather than fencing every terminal legacy identity", async () => {
		await fixture(async dir => {
			const row = accepted({ intendedSessionId: "other" });
			await writeLedger(dir, [row, { ...row, state: "effect_started" }, terminal(row)]);
			await withoutEffects(dir, async () => {
				expect((await lifecycleParity(dir)).kind).toBe("clear");
			});
		});
	});

	it("shares explicit and attested spawn-anchor exclusions without timestamp provenance", async () => {
		await fixture(async dir => {
			await writeLedger(dir, [accepted({ spawnAnchor: true })]);
			await withoutEffects(dir, async () => {
				expect((await lifecycleParity(dir)).kind).toBe("clear");
			});
			await writeLedger(dir, [accepted()]);
			await fs.writeFile(
				path.join(dir, "sdk", "lifecycle-ledger.spawn-anchor-attestation.json"),
				JSON.stringify({ version: 1, identities: ["legacy"] }),
			);
			await withoutEffects(dir, async () => {
				expect((await lifecycleParity(dir)).kind).toBe("clear");
			});
			await writeLedger(dir, [accepted({ intendedSessionId: "selected" })]);
			await withoutEffects(dir, async () => {
				expect((await lifecycleParity(dir)).kind).toBe("legacy_lifecycle_ambiguous");
			});
		});
	});

	for (const damage of ["corrupt", "torn", "checksum", "sequence", "snapshot", "unsupported"] as const) {
		it(`refuses ${damage} index data without audit, locks, or repair`, async () => {
			await fixture(async dir => {
				const first = event(dir, 1);
				await writeIndex(
					dir,
					damage === "checksum"
						? [{ ...first, checksum: "bad" }]
						: damage === "sequence"
							? [event(dir, 2)]
							: damage === "unsupported"
								? [event(dir, 1, { version: 999 as typeof SESSION_INDEX_EVENT_VERSION })]
								: [first],
					damage === "corrupt" ? "{bad}\n" : damage === "torn" ? '{"indexSeq":2' : "",
				);
				if (damage === "snapshot") await fs.writeFile(snapshotFile(dir), "{bad}");
				await withoutEffects(dir, async () => {
					expect((await indexParity(dir)).kind).toBe("authority_roots_unresolved");
				});
			});
		});
	}

	it("projects only the selected target and retains stale endpoint identity for independent verification", async () => {
		await fixture(async dir => {
			const unrelatedMissing = path.join(dir, "unrelated-missing-root");
			await writeIndex(dir, [
				event(dir, 1),
				event(dir, 2, {
					sessionId: "other",
					locator: { cwd: dir, worktreeRoot: null, stateRoot: unrelatedMissing },
				}),
			]);
			await withoutEffects(dir, async () => {
				const result = await indexParity(dir);
				expect(result).toMatchObject({
					kind: "resolved",
					indexSeq: 2,
					roots: [await fs.realpath(dir)],
					identities: [
						{
							sessionId: "selected",
							pid: process.pid,
							processIncarnation: "recorded-owner-incarnation",
							hostIncarnation: "recorded-owner-incarnation",
							endpointGeneration: 1,
							endpointFileId: "endpoint-file-identity",
							endpointMtimeMs: 123,
							terminal: false,
							identityProvenance: "composite",
						},
					],
				});
				if (result.kind === "resolved") expect(result.identities[0]).not.toHaveProperty("live");
			});
		});
	});

	it("does not turn another session's rejected legacy locator into selected-target authority", async () => {
		await fixture(async dir => {
			await writeIndex(dir, [
				event(dir, 1),
				event(dir, 2, {
					sessionId: "legacy-other",
					locator: { stateRoot: path.join(dir, "not-observed") } as SessionIndexEvent["locator"],
				}),
			]);
			await withoutEffects(dir, async () => {
				expect(await indexParity(dir)).toMatchObject({
					kind: "resolved",
					indexSeq: 2,
					identities: [{ sessionId: "selected" }],
				});
				expect((await indexParity(dir, "legacy-other")).kind).toBe("authority_roots_unresolved");
			});
		});
	});

	it("preserves snapshot anchors, overlapping log validation, and admission fencing", async () => {
		await fixture(async dir => {
			const old = event(dir, 1);
			const replacement = event(dir, 2, { hostIncarnation: "replacement", processIncarnation: "replacement" });
			await writeIndex(dir, [old, replacement, event(dir, 3, { type: "host_heartbeat" })]);
			await fs.writeFile(
				snapshotFile(dir),
				JSON.stringify({ version: SESSION_INDEX_SNAPSHOT_VERSION, indexSeq: 2, events: [old, replacement] }),
			);
			await withoutEffects(dir, async () => {
				expect(await indexParity(dir)).toMatchObject({
					kind: "resolved",
					indexSeq: 3,
					identities: [{ hostIncarnation: "replacement", indexSeq: 2 }],
				});
			});
		});
	});

	it("preserves the direct-session generation-zero fence exception but rejects two real roots", async () => {
		await fixture(async dir => {
			const root = path.join(dir, "endpoint-root");
			await fs.mkdir(root);
			const registered = event(dir, 2, { locator: { cwd: dir, worktreeRoot: null, stateRoot: root } });
			await writeIndex(dir, [event(dir, 1, { endpointGeneration: 0 }), registered]);
			await withoutEffects(dir, async () => {
				const result = await indexParity(dir);
				expect(result.kind).toBe("resolved");
				if (result.kind === "resolved") expect(result.identities.every(identity => !identity.ambiguous)).toBe(true);
			});
			await writeIndex(dir, [event(dir, 1), registered]);
			await withoutEffects(dir, async () => {
				expect((await indexParity(dir)).kind).toBe("authority_roots_unresolved");
			});
		});
	});

	for (const mode of ["async", "sync"] as const) {
		it(`rejects a ${mode} generation-zero authority alias retarget after its realpath/stat capture`, async () => {
			await fixture(async dir => {
				const alias = path.join(dir, "generation-zero-root");
				const other = path.join(dir, "other-root");
				const retarget = path.join(dir, "retarget-root");
				await fs.mkdir(other);
				await fs.mkdir(retarget);
				await fs.symlink(dir, alias);
				await writeIndex(dir, [
					event(dir, 1, { endpointGeneration: 0, locator: { cwd: dir, worktreeRoot: null, stateRoot: alias } }),
					event(dir, 2, { locator: { cwd: dir, worktreeRoot: null, stateRoot: other } }),
				]);
				await fs.writeFile(
					snapshotFile(dir),
					JSON.stringify({
						version: SESSION_INDEX_SNAPSHOT_VERSION,
						indexSeq: 0,
						events: [],
					}),
				);
				const bytes = await fs.readFile(logFile(dir));
				const snapshotBytes = await fs.readFile(snapshotFile(dir));
				const resolvedAgentDir = await fs.realpath(dir);
				const originalRealpath = fs.realpath;
				const originalRealpathSync = fsSync.realpathSync;
				const originalStat = fs.stat;
				const originalStatSync = fsSync.statSync;
				const unlink = fsSync.unlinkSync;
				const symlink = fsSync.symlinkSync;
				let armed = false;
				let changed = false;
				const retargetAlias = () => {
					unlink(alias);
					symlink(retarget, alias);
					changed = true;
				};
				await withoutEffects(dir, async () => {
					// Stable aliases preserve the real direct-session GC exception.
					const stable = await indexParity(dir);
					expect(stable.kind).toBe("resolved");
					if (stable.kind === "resolved") {
						expect(stable.identities.some(identity => identity.endpointGeneration === 0)).toBe(true);
						expect(stable.identities.every(identity => !identity.ambiguous)).toBe(true);
					}
					const resolved =
						mode === "async"
							? vi.spyOn(fs, "realpath").mockImplementation(
									new Proxy(originalRealpath, {
										async apply(fn, receiver, args) {
											const result = await Reflect.apply(fn, receiver, args);
											if (String(args[0]) === alias) armed = true;
											return result;
										},
									}),
								)
							: undefined;
					const resolvedSync =
						mode === "sync"
							? vi.spyOn(fsSync, "realpathSync").mockImplementation(
									new Proxy(originalRealpathSync, {
										apply(fn, receiver, args) {
											const result = Reflect.apply(fn, receiver, args);
											if (String(args[0]) === alias) armed = true;
											return result;
										},
									}),
								)
							: undefined;
					const observed =
						mode === "async"
							? vi.spyOn(fs, "stat").mockImplementation(
									new Proxy(originalStat, {
										async apply(fn, receiver, args) {
											const result = await Reflect.apply(fn, receiver, args);
											if (armed && !changed && String(args[0]) === resolvedAgentDir) retargetAlias();
											return result;
										},
									}),
								)
							: undefined;
					const observedSync =
						mode === "sync"
							? vi.spyOn(fsSync, "statSync").mockImplementation(
									new Proxy(originalStatSync, {
										apply(fn, receiver, args) {
											const result = Reflect.apply(fn, receiver, args);
											if (armed && !changed && String(args[0]) === resolvedAgentDir) retargetAlias();
											return result;
										},
									}),
								)
							: undefined;
					try {
						const result =
							mode === "async"
								? await SessionIndex.readAuthorityRootsReadOnly(dir, "selected")
								: SessionIndex.readAuthorityRootsReadOnlySync(dir, "selected");
						expect(armed).toBe(true);
						expect(changed).toBe(true);
						expect(result).toMatchObject({
							kind: "unknown_ownership",
							reason: "Authority roots changed during observation.",
						});
						expect(await fs.readFile(logFile(dir))).toEqual(bytes);
						expect(await fs.readFile(snapshotFile(dir))).toEqual(snapshotBytes);
					} finally {
						resolved?.mockRestore();
						resolvedSync?.mockRestore();
						observed?.mockRestore();
						observedSync?.mockRestore();
						if (changed) {
							unlink(alias);
							symlink(dir, alias);
						}
					}
				});
			});
		});
	}

	for (const replacement of ["alias", "directory"] as const) {
		it(`binds the authority ${replacement} dev/inode identity into both digests even at the same realpath`, async () => {
			await fixture(async dir => {
				const root = path.join(dir, "authority-root");
				const alias = path.join(dir, "authority-alias");
				await fs.mkdir(root);
				await fs.symlink(root, alias);
				await writeIndex(dir, [event(dir, 1, { locator: { cwd: dir, worktreeRoot: null, stateRoot: alias } })]);
				const bytes = await fs.readFile(logFile(dir));
				let digest: string | undefined;
				await withoutEffects(dir, async () => {
					const result = await indexParity(dir);
					expect(result.kind).toBe("resolved");
					if (result.kind === "resolved") digest = result.digest;
				});
				// Keep the old inode allocated so replacement cannot recycle its identity.
				await fs.rename(replacement === "alias" ? alias : root, path.join(dir, "retired-identity"));
				if (replacement === "alias") await fs.symlink(root, alias);
				else await fs.mkdir(root);
				await withoutEffects(dir, async () => {
					const result = await indexParity(dir);
					expect(result).toMatchObject({ kind: "resolved", roots: [await fs.realpath(root)] });
					if (result.kind === "resolved") expect(result.digest).not.toBe(digest);
					expect(await fs.readFile(logFile(dir))).toEqual(bytes);
				});
			});
		});
	}

	it("never falls back when a selected authority root is missing", async () => {
		await fixture(async dir => {
			await writeIndex(dir, [
				event(dir, 1, { locator: { cwd: dir, worktreeRoot: null, stateRoot: path.join(dir, "missing") } }),
			]);
			await withoutEffects(dir, async () => {
				expect((await indexParity(dir)).kind).toBe("authority_roots_unresolved");
			});
		});
	});

	it("rejects byte and row bounds without opening recovery writers", async () => {
		await fixture(async dir => {
			await writeLedger(dir, [accepted({ operationKey: "key", fingerprint: "fp" })]);
			await writeIndex(dir, [event(dir, 1)]);
			await withoutEffects(dir, async () => {
				expect((await lifecycleParity(dir, { maxBytes: 1 })).kind).toBe("unknown_ownership");
				expect((await lifecycleParity(dir, { maxLineBytes: 1 })).kind).toBe("legacy_lifecycle_ambiguous");
				expect((await indexParity(dir, "selected", { ...indexLimits, maxLogBytes: 1 })).kind).toBe(
					"authority_roots_unresolved",
				);
				expect((await indexParity(dir, "selected", { ...indexLimits, maxRowBytes: 1 })).kind).toBe(
					"authority_roots_unresolved",
				);
			});
		});
	});

	for (const failure of ["read-failed", "short-read"] as const) {
		it(`maps ${failure} descriptor observations to unknown without effects`, async () => {
			await fixture(async dir => {
				await writeLedger(dir, [accepted({ operationKey: "key" })]);
				await writeIndex(dir, [event(dir, 1)]);
				await withoutEffects(
					dir,
					async () => {
						expect((await LifecycleLedger.inspectOwnershipReadOnly(dir, target(dir))).kind).toBe(
							"unknown_ownership",
						);
						expect((await SessionIndex.readAuthorityRootsReadOnly(dir, "selected")).kind).toBe(
							"unknown_ownership",
						);
					},
					async handle => {
						if (failure === "read-failed")
							vi.spyOn(handle, "read").mockRejectedValue(new Error("Injected read failure"));
						else vi.spyOn(handle, "read").mockResolvedValue({ bytesRead: 0, buffer: Buffer.alloc(0) });
					},
				);
			});
		});
	}

	it("rejects descriptor/named identity mismatch before trusting ownership bytes", async () => {
		await fixture(async dir => {
			await writeLedger(dir, [accepted({ operationKey: "key" })]);
			await writeIndex(dir, [event(dir, 1)]);
			const wrong = await fs.lstat(ledgerFile(dir), { bigint: true });
			wrong.ino += 1n;
			const originalLstat = fs.lstat;
			let mismatches = 0;
			await withoutEffects(dir, async () => {
				const lstat = vi.spyOn(fs, "lstat").mockImplementation(
					new Proxy(originalLstat, {
						apply(fn, receiver, args) {
							if ([ledgerFile(dir), logFile(dir)].includes(String(args[0]))) {
								mismatches += 1;
								return Promise.resolve(wrong);
							}
							return Reflect.apply(fn, receiver, args);
						},
					}),
				);
				try {
					expect((await LifecycleLedger.inspectOwnershipReadOnly(dir, target(dir))).kind).toBe(
						"unknown_ownership",
					);
					expect((await SessionIndex.readAuthorityRootsReadOnly(dir, "selected")).kind).toBe("unknown_ownership");
					expect(mismatches).toBe(2);
				} finally {
					lstat.mockRestore();
				}
			});
		});
	});

	it("refuses descriptor identity changes after complete reads", async () => {
		await fixture(async dir => {
			await writeLedger(dir, [accepted({ operationKey: "key" })]);
			await writeIndex(dir, [event(dir, 1)]);
			await withoutEffects(
				dir,
				async () => {
					expect((await LifecycleLedger.inspectOwnershipReadOnly(dir, target(dir))).kind).toBe(
						"unknown_ownership",
					);
					expect((await SessionIndex.readAuthorityRootsReadOnly(dir, "selected")).kind).toBe("unknown_ownership");
				},
				async handle => {
					const initial = await handle.stat({ bigint: true });
					const changed = await handle.stat({ bigint: true });
					changed.ino += 1n;
					vi.spyOn(handle, "stat").mockResolvedValueOnce(initial).mockResolvedValue(changed);
				},
			);
		});
	});

	it("never grants authority from multiply linked source files", async () => {
		await fixture(async dir => {
			await writeLedger(dir, [accepted({ operationKey: "key" })]);
			await writeIndex(dir, [event(dir, 1)]);
			await fs.link(ledgerFile(dir), path.join(dir, "ledger-alias"));
			await fs.link(logFile(dir), path.join(dir, "index-alias"));
			await withoutEffects(dir, async () => {
				expect((await LifecycleLedger.inspectOwnershipReadOnly(dir, target(dir))).kind).toBe("unknown_ownership");
				expect((await indexParity(dir)).kind).toBe("authority_roots_unresolved");
			});
		});
	});

	for (const failure of ["read-failed", "short-read", "post-open-enoent", "final-name-change"] as const) {
		it(`fails closed on synchronous ${failure} without persistent or attempted effects`, async () => {
			await fixture(async dir => {
				await writeLedger(dir, [accepted({ operationKey: "key", fingerprint: "fp" })]);
				await writeIndex(dir, [event(dir, 1)]);
				await withoutEffects(dir, async () => {
					for (const source of ["ledger", "index"] as const) {
						const file = source === "ledger" ? ledgerFile(dir) : logFile(dir);
						const initial = fsSync.lstatSync(file, { bigint: true });
						const changed = fsSync.lstatSync(file, { bigint: true });
						changed.ino += 1n;
						const read =
							failure === "read-failed"
								? vi.spyOn(fsSync, "readSync").mockImplementation(() => {
										throw new Error("Injected read failure");
									})
								: failure === "short-read"
									? vi.spyOn(fsSync, "readSync").mockReturnValue(0)
									: undefined;
						const originalLstat = fsSync.lstatSync;
						let namedChecks = 0;
						const named =
							failure === "post-open-enoent" || failure === "final-name-change"
								? vi.spyOn(fsSync, "lstatSync").mockImplementation(
										new Proxy(originalLstat, {
											apply(fn, receiver, args) {
												if (String(args[0]) !== file) return Reflect.apply(fn, receiver, args);
												namedChecks += 1;
												if (failure === "post-open-enoent")
													throw Object.assign(new Error("Removed after open"), { code: "ENOENT" });
												return namedChecks === 1 ? initial : changed;
											},
										}),
									)
								: undefined;
						try {
							const result =
								source === "ledger"
									? LifecycleLedger.inspectOwnershipReadOnlySync(dir, target(dir))
									: SessionIndex.readAuthorityRootsReadOnlySync(dir, "selected");
							expect(result.kind).toBe("unknown_ownership");
							if (named) expect(namedChecks).toBe(failure === "final-name-change" ? 2 : 1);
						} finally {
							read?.mockRestore();
							named?.mockRestore();
						}
					}
				});
			});
		});
	}

	it("rechecks complete synchronous content hashes even when descriptor metadata stays unchanged", async () => {
		await fixture(async dir => {
			await writeLedger(dir, [accepted({ operationKey: "key", fingerprint: "fp" })]);
			await writeIndex(dir, [event(dir, 1)]);
			await withoutEffects(dir, async () => {
				for (const source of ["ledger", "index"] as const) {
					const originalRead = fsSync.readSync;
					let reads = 0;
					const read = vi
						.spyOn(fsSync, "readSync")
						.mockImplementation(
							(
								fd: number,
								buffer: NodeJS.ArrayBufferView,
								offsetOrOptions?: number | fsSync.ReadOptions,
								length?: number,
								position?: fsSync.ReadPosition | null,
							) => {
								const count =
									typeof offsetOrOptions === "number"
										? originalRead(fd, buffer, offsetOrOptions, length!, position ?? null)
										: originalRead(fd, buffer, offsetOrOptions);
								if (++reads === 2 && count > 0)
									new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)[0] ^= 1;
								return count;
							},
						);
					try {
						const result =
							source === "ledger"
								? LifecycleLedger.inspectOwnershipReadOnlySync(dir, target(dir))
								: SessionIndex.readAuthorityRootsReadOnlySync(dir, "selected");
						expect(result.kind).toBe("unknown_ownership");
						expect(reads).toBe(2);
					} finally {
						read.mockRestore();
					}
				}
			});
		});
	});

	it("does not treat initial absence as clear when a source name appears before final revalidation", async () => {
		await fixture(async dir => {
			const existing = await fs.lstat(dir, { bigint: true });
			const originalLstat = fs.lstat;
			const originalLstatSync = fsSync.lstatSync;
			const sourceNames = new Set([ledgerFile(dir), snapshotFile(dir), logFile(dir)]);
			await withoutEffects(dir, async () => {
				const asyncNamed = vi.spyOn(fs, "lstat").mockImplementation(
					new Proxy(originalLstat, {
						apply(fn, receiver, args) {
							return sourceNames.has(String(args[0]))
								? Promise.resolve(existing)
								: Reflect.apply(fn, receiver, args);
						},
					}),
				);
				const syncNamed = vi.spyOn(fsSync, "lstatSync").mockImplementation(
					new Proxy(originalLstatSync, {
						apply(fn, receiver, args) {
							return sourceNames.has(String(args[0])) ? existing : Reflect.apply(fn, receiver, args);
						},
					}),
				);
				try {
					expect((await lifecycleParity(dir)).kind).toBe("unknown_ownership");
					expect((await indexParity(dir)).kind).toBe("unknown_ownership");
				} finally {
					asyncNamed.mockRestore();
					syncNamed.mockRestore();
				}
			});
		});
	});

	it("shares snapshot byte and cumulative row bounds rather than a permissive sync projection", async () => {
		await fixture(async dir => {
			const first = event(dir, 1);
			await writeIndex(dir, [event(dir, 2, { type: "host_heartbeat" })]);
			await fs.writeFile(
				snapshotFile(dir),
				JSON.stringify({
					version: SESSION_INDEX_SNAPSHOT_VERSION,
					indexSeq: 1,
					events: [first],
				}),
			);
			await withoutEffects(dir, async () => {
				expect((await indexParity(dir, "selected", { ...indexLimits, maxSnapshotBytes: 1 })).kind).toBe(
					"authority_roots_unresolved",
				);
				expect((await indexParity(dir, "selected", { ...indexLimits, maxRows: 1 })).kind).toBe(
					"authority_roots_unresolved",
				);
				expect((await indexParity(dir)).kind).toBe("resolved");
			});
		});
	});

	for (const source of ["symlink", "directory"] as const) {
		it(`rejects ${source} sources in both readers without recovery`, async () => {
			await fixture(async dir => {
				await fs.mkdir(path.dirname(logFile(dir)), { recursive: true });
				if (source === "symlink") {
					const bytes = path.join(dir, "external");
					await fs.writeFile(bytes, "");
					await fs.symlink(bytes, ledgerFile(dir));
					await fs.symlink(bytes, logFile(dir));
				} else {
					await fs.mkdir(ledgerFile(dir));
					await fs.mkdir(logFile(dir));
				}
				await withoutEffects(dir, async () => {
					expect((await lifecycleParity(dir)).kind).toBe("unknown_ownership");
					expect((await indexParity(dir)).kind).toBe(
						source === "directory" ? "authority_roots_unresolved" : "unknown_ownership",
					);
				});
			});
		});
	}

	it("keeps request-specific readTerminal behavior for unrelated torn tails", async () => {
		await fixture(async dir => {
			const row = accepted();
			await writeLedger(dir, [row, terminal(row)], '{"identity":"unrelated"');
			await withoutEffects(dir, async () => {
				expect(await new LifecycleLedger(dir).readTerminal(row.identity, row.requestHash)).toMatchObject({
					kind: "terminal",
					entry: { state: "terminal_error" },
				});
				expect((await lifecycleParity(dir)).kind).toBe("legacy_lifecycle_ambiguous");
			});
		});
	});
});
