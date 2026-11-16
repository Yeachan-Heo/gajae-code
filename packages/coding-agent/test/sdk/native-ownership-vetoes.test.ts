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
	const forbidden = [
		vi.spyOn(LifecycleLedger.prototype, "open"),
		vi.spyOn(SessionIndex.prototype, "open"),
		vi.spyOn(SessionIndex.prototype, "replay"),
		vi.spyOn(SessionIndex.prototype, "diagnose"),
		vi.spyOn(SessionIndex.prototype, "repair"),
	];
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
		for (const spy of [...spies, ...forbidden]) expect(spy).not.toHaveBeenCalled();
	} finally {
		open.mockRestore();
		for (const spy of [...spies, ...forbidden]) spy.mockRestore();
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

describe("read-only native ownership vetoes", () => {
	it("leaves a genuinely absent App agentDir absent and returns empty observations, not retirement evidence", async () => {
		await fixture(async dir => {
			const absent = path.join(dir, "not-created");
			await withoutEffects(dir, async () => {
				expect(await LifecycleLedger.inspectOwnershipReadOnly(absent, target(dir))).toMatchObject({
					kind: "clear",
					digest: expect.stringMatching(/^[a-f0-9]{64}$/),
				});
				expect(await SessionIndex.readAuthorityRootsReadOnly(absent, "selected")).toMatchObject({
					kind: "resolved",
					indexSeq: 0,
					roots: [],
					identities: [],
					digest: expect.stringMatching(/^[a-f0-9]{64}$/),
				});
			});
		});
	});

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
					expect((await LifecycleLedger.inspectOwnershipReadOnly(dir, target(dir))).kind).toBe(
						"legacy_lifecycle_ambiguous",
					);
				});
			});
		});
	}

	it("keeps pre-effect refusals clear but retains the first effect witness as a legacy veto", async () => {
		await fixture(async dir => {
			const row = accepted();
			await writeLedger(dir, [row, terminal(row)]);
			await withoutEffects(dir, async () => {
				expect((await LifecycleLedger.inspectOwnershipReadOnly(dir, target(dir))).kind).toBe("clear");
			});
			await writeLedger(dir, [row, { ...row, state: "effect_started" }, terminal(row)]);
			await withoutEffects(dir, async () => {
				expect((await LifecycleLedger.inspectOwnershipReadOnly(dir, target(dir))).kind).toBe(
					"legacy_lifecycle_ambiguous",
				);
			});
		});
	});

	it("excludes only terminal legacy rows naming another session, not active or target rows", async () => {
		await fixture(async dir => {
			const other = accepted({ intendedSessionId: "other" });
			await writeLedger(dir, [other, terminal(other)]);
			await withoutEffects(dir, async () => {
				expect((await LifecycleLedger.inspectOwnershipReadOnly(dir, target(dir))).kind).toBe("clear");
			});
			await writeLedger(dir, [other]);
			await withoutEffects(dir, async () => {
				expect((await LifecycleLedger.inspectOwnershipReadOnly(dir, target(dir))).kind).toBe(
					"legacy_lifecycle_ambiguous",
				);
			});
			const selected = accepted({ intendedSessionId: "selected" });
			await writeLedger(dir, [selected, terminal(selected)]);
			await withoutEffects(dir, async () => {
				expect((await LifecycleLedger.inspectOwnershipReadOnly(dir, target(dir))).kind).toBe(
					"legacy_lifecycle_ambiguous",
				);
			});
		});
	});

	it("shares explicit and attested spawn-anchor exclusions without timestamp provenance", async () => {
		await fixture(async dir => {
			await writeLedger(dir, [accepted({ spawnAnchor: true })]);
			await withoutEffects(dir, async () => {
				expect((await LifecycleLedger.inspectOwnershipReadOnly(dir, target(dir))).kind).toBe("clear");
			});
			await writeLedger(dir, [accepted()]);
			await fs.writeFile(
				path.join(dir, "sdk", "lifecycle-ledger.spawn-anchor-attestation.json"),
				JSON.stringify({ version: 1, identities: ["legacy"] }),
			);
			await withoutEffects(dir, async () => {
				expect((await LifecycleLedger.inspectOwnershipReadOnly(dir, target(dir))).kind).toBe("clear");
			});
			await writeLedger(dir, [accepted({ intendedSessionId: "selected" })]);
			await withoutEffects(dir, async () => {
				expect((await LifecycleLedger.inspectOwnershipReadOnly(dir, target(dir))).kind).toBe(
					"legacy_lifecycle_ambiguous",
				);
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
					expect((await SessionIndex.readAuthorityRootsReadOnly(dir, "selected")).kind).toBe(
						"authority_roots_unresolved",
					);
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
				const result = await SessionIndex.readAuthorityRootsReadOnly(dir, "selected");
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
				expect(await SessionIndex.readAuthorityRootsReadOnly(dir, "selected")).toMatchObject({
					kind: "resolved",
					indexSeq: 2,
					identities: [{ sessionId: "selected" }],
				});
				expect((await SessionIndex.readAuthorityRootsReadOnly(dir, "legacy-other")).kind).toBe(
					"authority_roots_unresolved",
				);
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
				expect(await SessionIndex.readAuthorityRootsReadOnly(dir, "selected")).toMatchObject({
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
				const result = await SessionIndex.readAuthorityRootsReadOnly(dir, "selected");
				expect(result.kind).toBe("resolved");
				if (result.kind === "resolved") expect(result.identities.every(identity => !identity.ambiguous)).toBe(true);
			});
			await writeIndex(dir, [event(dir, 1), registered]);
			await withoutEffects(dir, async () => {
				expect((await SessionIndex.readAuthorityRootsReadOnly(dir, "selected")).kind).toBe(
					"authority_roots_unresolved",
				);
			});
		});
	});

	it("never falls back when a selected authority root is missing", async () => {
		await fixture(async dir => {
			await writeIndex(dir, [
				event(dir, 1, { locator: { cwd: dir, worktreeRoot: null, stateRoot: path.join(dir, "missing") } }),
			]);
			await withoutEffects(dir, async () => {
				expect((await SessionIndex.readAuthorityRootsReadOnly(dir, "selected")).kind).toBe(
					"authority_roots_unresolved",
				);
			});
		});
	});

	it("rejects byte and row bounds without opening recovery writers", async () => {
		await fixture(async dir => {
			await writeLedger(dir, [accepted({ operationKey: "key", fingerprint: "fp" })]);
			await writeIndex(dir, [event(dir, 1)]);
			await withoutEffects(dir, async () => {
				expect((await LifecycleLedger.inspectOwnershipReadOnly(dir, target(dir), { maxBytes: 1 })).kind).toBe(
					"unknown_ownership",
				);
				expect((await LifecycleLedger.inspectOwnershipReadOnly(dir, target(dir), { maxLineBytes: 1 })).kind).toBe(
					"legacy_lifecycle_ambiguous",
				);
				expect(
					(await SessionIndex.readAuthorityRootsReadOnly(dir, "selected", { ...indexLimits, maxLogBytes: 1 }))
						.kind,
				).toBe("authority_roots_unresolved");
				expect(
					(await SessionIndex.readAuthorityRootsReadOnly(dir, "selected", { ...indexLimits, maxRowBytes: 1 }))
						.kind,
				).toBe("authority_roots_unresolved");
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
			await withoutEffects(dir, async () => {
				const lstat = vi.spyOn(fs, "lstat").mockResolvedValue(wrong);
				try {
					expect((await LifecycleLedger.inspectOwnershipReadOnly(dir, target(dir))).kind).toBe(
						"unknown_ownership",
					);
					expect((await SessionIndex.readAuthorityRootsReadOnly(dir, "selected")).kind).toBe("unknown_ownership");
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
				expect((await SessionIndex.readAuthorityRootsReadOnly(dir, "selected")).kind).toBe(
					"authority_roots_unresolved",
				);
			});
		});
	});

	it("keeps request-specific readTerminal behavior for unrelated torn tails", async () => {
		await fixture(async dir => {
			const row = accepted();
			await writeLedger(dir, [row, terminal(row)], '{"identity":"unrelated"');
			await withoutEffects(dir, async () => {
				expect(await new LifecycleLedger(dir).readTerminal(row.identity, row.requestHash)).toMatchObject({
					kind: "terminal",
					entry: { state: "terminal_error" },
				});
				expect((await LifecycleLedger.inspectOwnershipReadOnly(dir, target(dir))).kind).toBe(
					"legacy_lifecycle_ambiguous",
				);
			});
		});
	});
});
