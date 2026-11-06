import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import path from "node:path";
import { LifecycleLedger, SESSION_FAMILY_FORK_OPERATION } from "../src/sdk/broker/lifecycle-ledger";

async function temporaryAgentDir(prefix: string): Promise<string> {
	return fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", prefix));
}

async function recordTerminalOk(ledger: LifecycleLedger, identity: string): Promise<void> {
	await ledger.begin(identity, `${identity}-request`, {
		operationKey: `test.operation\u0000${identity}`,
		fingerprint: `${identity}-fingerprint`,
	});
	await ledger.transition(identity, "terminal_ok", { response: { ok: true, identity } });
}

async function recordTerminalError(ledger: LifecycleLedger, identity: string): Promise<void> {
	await ledger.begin(identity, `${identity}-request`, {
		operationKey: `test.operation\u0000${identity}`,
		fingerprint: `${identity}-fingerprint`,
	});
	await ledger.transition(identity, "terminal_error", { response: { ok: false, identity } });
}

async function recordLegacyTerminalOk(ledger: LifecycleLedger, identity: string): Promise<void> {
	await ledger.begin(identity, `${identity}-request`);
	await ledger.transition(identity, "terminal_ok", { response: { ok: true, identity } });
}

async function ledgerBytes(agentDir: string): Promise<number> {
	try {
		return (await fs.readFile(path.join(agentDir, "sdk", "lifecycle-ledger.jsonl"))).byteLength;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return 0;
		throw error;
	}
}

async function recordShortTerminal(ledger: LifecycleLedger, identity: string): Promise<void> {
	await ledger.begin(identity, "r", { operationKey: "o", fingerprint: "f" });
	await ledger.transition(identity, "terminal_ok", { response: { ok: true } });
}

function useExplicitClock(): { advance: () => void; restore: () => void } {
	let timestamp = 1_000;
	const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => timestamp);
	return {
		advance: () => {
			timestamp += 1;
		},
		restore: () => nowSpy.mockRestore(),
	};
}

function retirementResponse(createIdentity: string): {
	ok: false;
	error: {
		code: "cleanup_pending";
		cleanup: { sessionId: string; uncertainRetirement: { identity: { createIdentity: string } } };
	};
} {
	return {
		ok: false,
		error: {
			code: "cleanup_pending",
			cleanup: { sessionId: "session", uncertainRetirement: { identity: { createIdentity } } },
		},
	};
}

describe("LifecycleLedger retention", () => {
	it.each([
		"accepted",
		"terminal_ok",
		"terminal_error",
	] as const)("preserves the original family fork reservation in %s through compaction and restart", async state => {
		const agentDir = await temporaryAgentDir("gjc-family-fork-key-retention-");
		try {
			const metadata = {
				operationKey: `${SESSION_FAMILY_FORK_OPERATION}\u0000original-key`,
				fingerprint: "source-head-destination",
				intendedSessionId: "reserved-child",
			};
			const ledger = await new LifecycleLedger(agentDir, { maxRows: 6 }).open();
			await ledger.begin("family-fork", "original-request", metadata);
			if (state !== "accepted") {
				await ledger.transition("family-fork", state, {
					...(state === "terminal_ok" ? { resultSessionId: "reserved-child" } : {}),
					response: { ok: state === "terminal_ok" },
				});
			}
			const reservation = ledger.get("family-fork");
			if (!reservation) throw new Error("Missing original reservation");
			for (let index = 0; index < 12; index += 1) {
				await recordTerminalOk(ledger, `ordinary-${index}`);
			}
			expect(ledger.get("ordinary-0")).toBeUndefined();
			expect(ledger.get("family-fork")).toEqual(reservation);

			const reopened = await new LifecycleLedger(agentDir, { maxRows: 6 }).open();
			expect(reopened.findAnyByOperationKey(metadata.operationKey)).toEqual(reservation);
			const before = await Bun.file(path.join(agentDir, "sdk", "lifecycle-ledger.jsonl")).text();
			const retry = await reopened.begin("family-fork", "original-request", {
				...metadata,
				intendedSessionId: "unused-retry-allocation",
			});
			expect(retry.kind).toBe(state === "accepted" ? "new" : "replay");
			if (retry.kind !== "new" && retry.kind !== "replay") throw new Error("Missing retained reservation");
			expect(retry.entry).toEqual(reservation);
			expect(retry.entry.intendedSessionId).toBe("reserved-child");
			expect(await reopened.begin("family-fork", "changed-head-or-destination", metadata)).toEqual({
				kind: "idempotency_conflict",
			});
			expect(await Bun.file(path.join(agentDir, "sdk", "lifecycle-ledger.jsonl")).text()).toBe(before);
		} finally {
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});

	it("re-establishes file and directory durability for an unacknowledged reservation", async () => {
		const agentDir = await temporaryAgentDir("gjc-family-fork-reservation-sync-");
		const directory = path.join(agentDir, "sdk");
		const filePath = path.join(directory, "lifecycle-ledger.jsonl");
		const originalOpen = fs.open;
		let rejectDirectorySync = true;
		let directorySyncs = 0;
		let fileSyncs = 0;
		const failure = new Error("controlled family reservation directory sync failure");
		const open = vi.spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
			const handle = await originalOpen(file, flags, mode);
			const sync = handle.sync.bind(handle);
			if (file === directory) {
				handle.sync = async () => {
					directorySyncs += 1;
					if (rejectDirectorySync) throw failure;
					await sync();
				};
			} else if (file === filePath) {
				handle.sync = async () => {
					fileSyncs += 1;
					await sync();
				};
			}
			return handle;
		});
		try {
			const ledger = await new LifecycleLedger(agentDir).open();
			await ledger.begin("ordinary", "ordinary-request");
			expect(directorySyncs).toBe(0);
			const metadata = {
				operationKey: `${SESSION_FAMILY_FORK_OPERATION}\u0000original-key`,
				fingerprint: "original-fingerprint",
				intendedSessionId: "reserved-child",
			};
			await expect(ledger.begin("fork", "original-request", metadata)).rejects.toBe(failure);
			expect(directorySyncs).toBe(1);
			await expect(ledger.begin("fork", "original-request", metadata)).rejects.toThrow(
				"Lifecycle journal must be reloaded after an unconfirmed family write.",
			);
			await expect(ledger.begin("unrelated", "ordinary-request")).rejects.toThrow(
				"Lifecycle journal must be reloaded after an unconfirmed family write.",
			);
			const unacknowledged = await Bun.file(filePath).text();
			rejectDirectorySync = false;
			const beforeRetry = fileSyncs;
			const reopened = await new LifecycleLedger(agentDir).open({ recoverInterrupted: false });
			expect(
				await reopened.begin("fork", "original-request", { ...metadata, intendedSessionId: "unused-child" }),
			).toMatchObject({ kind: "new", entry: { intendedSessionId: "reserved-child" } });
			expect(fileSyncs).toBe(beforeRetry + 1);
			expect(directorySyncs).toBe(2);
			expect(await Bun.file(filePath).text()).toBe(unacknowledged);
		} finally {
			open.mockRestore();
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});

	it("cannot turn quarantine history into a fresh family fork key", async () => {
		const agentDir = await temporaryAgentDir("gjc-family-fork-quarantine-");
		try {
			await new LifecycleLedger(agentDir).open();
			const filePath = path.join(agentDir, "sdk", "lifecycle-ledger.jsonl");
			await Bun.write(`${filePath}.corrupt.1`, "retained unattributable operation evidence\n");
			const ledger = await new LifecycleLedger(agentDir).open({ recoverInterrupted: false });
			expect(ledger.warnings).toEqual([]);
			await expect(
				ledger.begin("new", "request", {
					operationKey: `${SESSION_FAMILY_FORK_OPERATION}\u0000original-key`,
					fingerprint: "fingerprint",
					intendedSessionId: "child",
				}),
			).rejects.toThrow("Family fork journal contains unresolved corruption.");
			expect(ledger.get("new")).toBeUndefined();
			expect(await Bun.file(filePath).exists()).toBe(false);
		} finally {
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});

	it("rejects key reuse, reservation aliasing and changed fingerprints before appending", async () => {
		const agentDir = await temporaryAgentDir("gjc-family-fork-key-conflicts-");
		try {
			const ledger = await new LifecycleLedger(agentDir).open();
			const metadata = {
				operationKey: `${SESSION_FAMILY_FORK_OPERATION}\u0000original-key`,
				fingerprint: "original-fingerprint",
				intendedSessionId: "reserved-child",
			};
			await ledger.begin("original-identity", "request", metadata);
			const file = Bun.file(path.join(agentDir, "sdk", "lifecycle-ledger.jsonl"));
			const before = await file.text();
			for (const [identity, changed] of [
				["another-identity", { ...metadata, intendedSessionId: "another-child" }],
				["another-identity", { ...metadata, operationKey: `${SESSION_FAMILY_FORK_OPERATION}\u0000another-key` }],
				["original-identity", { ...metadata, fingerprint: "changed-fingerprint" }],
				["original-identity", {}],
			] as const) {
				expect(await ledger.begin(identity, "request", changed)).toEqual({ kind: "idempotency_conflict" });
			}
			expect(await file.text()).toBe(before);
			expect(ledger.get("another-identity")).toBeUndefined();
			await expect(
				ledger.migrateIdentity("original-identity", "replacement-identity", {
					operationKey: "ordinary\u0000replacement",
					fingerprint: "replacement",
				}),
			).rejects.toThrow("Family fork reservations cannot be migrated.");
			expect(await file.text()).toBe(before);
		} finally {
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});

	it.each([
		"key",
		"child",
	] as const)("refuses persisted cross-identity %s aliases instead of selecting a reservation owner", async alias => {
		const agentDir = await temporaryAgentDir("gjc-family-fork-persisted-alias-");
		try {
			const ledger = await new LifecycleLedger(agentDir).open();
			const metadata = {
				operationKey: `${SESSION_FAMILY_FORK_OPERATION}\u0000original-key`,
				fingerprint: "original-fingerprint",
				intendedSessionId: "reserved-child",
			};
			const admitted = await ledger.begin("original", "original-request", metadata);
			if (admitted.kind !== "new") throw new Error("Missing reservation");
			await ledger.transition("original", "terminal_ok", {
				resultSessionId: "reserved-child",
				response: { ok: true, sessionId: "reserved-child" },
			});
			await ledger.begin("ordinary", "ordinary-request");
			await ledger.transition("ordinary", "terminal_ok", { response: { ok: true } });
			const conflicting = {
				...admitted.entry,
				identity: "conflicting-identity",
				requestHash: "conflicting-request",
				fingerprint: "conflicting-fingerprint",
				operationKey: alias === "key" ? metadata.operationKey : `${SESSION_FAMILY_FORK_OPERATION}\u0000other-key`,
				intendedSessionId: alias === "child" ? metadata.intendedSessionId : "other-child",
			};
			const file = path.join(agentDir, "sdk", "lifecycle-ledger.jsonl");
			await fs.appendFile(file, `${JSON.stringify(conflicting)}\n`);
			const before = await Bun.file(file).text();
			const reopened = new LifecycleLedger(agentDir);
			await expect(reopened.open({ recoverInterrupted: false })).rejects.toThrow(
				"Family fork reservation ownership is ambiguous.",
			);
			await expect(reopened.begin("original", "original-request", metadata)).rejects.toThrow(
				"Lifecycle journal must be reloaded after an unconfirmed family write.",
			);
			expect(await reopened.readTerminal("original", "original-request")).toEqual({
				kind: "rejected",
				reason: "row-not-attributable",
			});
			expect(await reopened.readTerminal("ordinary", "ordinary-request")).toMatchObject({
				kind: "terminal",
				entry: { state: "terminal_ok", response: { ok: true } },
			});
			expect(await Bun.file(file).text()).toBe(before);
			expect(await Bun.file(`${file}.corrupt`).text()).toContain(JSON.stringify(conflicting));
		} finally {
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});

	it.each([
		{ operationKey: "ordinary\u0000replacement" },
		{ fingerprint: "changed-fingerprint" },
		{ intendedSessionId: "replacement-child" },
		{ resultSessionId: "replacement-child" },
	])("rejects a retargeted family fork transition and fences the same persisted corruption: %j", async fields => {
		const agentDir = await temporaryAgentDir("gjc-family-fork-immutable-");
		try {
			const ledger = await new LifecycleLedger(agentDir).open();
			const metadata = {
				operationKey: `${SESSION_FAMILY_FORK_OPERATION}\u0000original-key`,
				fingerprint: "original-fingerprint",
				intendedSessionId: "reserved-child",
			};
			const admitted = await ledger.begin("original", "request", metadata);
			if (admitted.kind !== "new") throw new Error("Missing original reservation");
			const filePath = path.join(agentDir, "sdk", "lifecycle-ledger.jsonl");
			const before = await Bun.file(filePath).text();
			await expect(ledger.transition("original", "effect_started", fields)).rejects.toThrow(
				"Family fork reservation identity is immutable.",
			);
			expect(await Bun.file(filePath).text()).toBe(before);
			expect(() => {
				admitted.entry.intendedSessionId = "mutated-receipt";
			}).toThrow(TypeError);
			const changed = { ...admitted.entry, ...fields, state: "effect_started", ts: Date.now() };
			await fs.appendFile(filePath, `${JSON.stringify(changed)}\n`);
			const reopened = await new LifecycleLedger(agentDir).open({ recoverInterrupted: false });
			expect(await reopened.begin("original", "request", metadata)).toMatchObject({
				kind: "terminal_uncertain",
				entry: { ...metadata, state: "terminal_uncertain" },
			});
			expect(reopened.findAnyByOperationKey(metadata.operationKey)?.intendedSessionId).toBe("reserved-child");
		} finally {
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});

	it.each([
		"rows",
		"bytes",
	] as const)("refuses %s pressure instead of forgetting a completed family fork key", async bound => {
		const agentDir = await temporaryAgentDir("gjc-family-fork-key-capacity-");
		try {
			const initial = await new LifecycleLedger(agentDir).open();
			const metadata = {
				operationKey: `${SESSION_FAMILY_FORK_OPERATION}\u0000original-key`,
				fingerprint: "source-head-destination",
				intendedSessionId: "reserved-child",
			};
			await initial.begin("family-fork", "original-request", metadata);
			await initial.transition("family-fork", "terminal_ok", {
				resultSessionId: "reserved-child",
				response: { ok: true, sessionId: "reserved-child" },
			});
			const before = await Bun.file(path.join(agentDir, "sdk", "lifecycle-ledger.jsonl")).text();
			const ledger = await new LifecycleLedger(agentDir, {
				maxRows: bound === "rows" ? 2 : 100,
				maxBytes: bound === "bytes" ? Buffer.byteLength(before) + 1 : 64 * 1024,
			}).open();
			await expect(
				ledger.begin("incoming", "new-request", { operationKey: "ordinary\u0000new", fingerprint: "new" }),
			).rejects.toThrow("Lifecycle ledger append exceeds configured bounds.");
			expect(ledger.get("incoming")).toBeUndefined();
			expect(await Bun.file(path.join(agentDir, "sdk", "lifecycle-ledger.jsonl")).text()).toBe(before);
			const reopened = await new LifecycleLedger(agentDir).open();
			expect(await reopened.begin("family-fork", "original-request", metadata)).toMatchObject({
				kind: "replay",
				entry: { intendedSessionId: "reserved-child", resultSessionId: "reserved-child", state: "terminal_ok" },
			});
		} finally {
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});

	it.each([
		{
			name: "cleanup",
			protectedIdentity: "cleanup",
			maxBytes: 750,
			incomingSize: 350,
			seed: async (ledger: LifecycleLedger) => {
				await ledger.begin("cleanup", "r", { operationKey: "o", fingerprint: "f" });
				await ledger.transition("cleanup", "terminal_error", {
					response: { ok: false, error: { code: "cleanup_pending", cleanup: { sessionId: "s" } } },
				});
			},
		},
		{
			name: "legacy",
			protectedIdentity: "legacy",
			maxBytes: 750,
			incomingSize: 350,
			seed: async (ledger: LifecycleLedger) => {
				await recordLegacyTerminalOk(ledger, "legacy");
			},
		},
		{
			name: "close authority",
			protectedIdentity: "close",
			maxBytes: 750,
			incomingSize: 350,
			seed: async (ledger: LifecycleLedger) => {
				await ledger.begin("close", "r", { operationKey: "session.close\u0000k", fingerprint: "f" });
				await ledger.transition("close", "terminal_ok", { response: { ok: true } });
			},
		},
		{
			name: "retirement",
			protectedIdentity: "create",
			maxBytes: 2_000,
			incomingSize: 1_500,
			seed: async (ledger: LifecycleLedger) => {
				await recordTerminalError(ledger, "create");
				await ledger.begin("retirement", "r", { operationKey: "o", fingerprint: "f" });
				await ledger.transition("retirement", "effect_started", {
					response: retirementResponse("create"),
				});
			},
		},
	] as const)("rejects byte-pressure admission when only $name entries remain", async ({
		seed,
		protectedIdentity,
		maxBytes,
		incomingSize,
	}) => {
		const agentDir = await temporaryAgentDir("gjc-ledger-retention-byte-protected-");
		try {
			const ledger = await new LifecycleLedger(agentDir, {
				maxBytes,
				maxRows: 100,
				maxLineBytes: 2_000,
			}).open();
			await seed(ledger);
			const beforeBytes = await ledgerBytes(agentDir);
			const beforeEntry = ledger.get(protectedIdentity);

			await expect(
				ledger.begin("incoming", "r", { operationKey: "o", fingerprint: "x".repeat(incomingSize) }),
			).rejects.toThrow("Lifecycle ledger append exceeds configured bounds.");
			expect(await ledgerBytes(agentDir)).toBe(beforeBytes);
			expect(ledger.get(protectedIdentity)).toEqual(beforeEntry);
			expect(ledger.get("incoming")).toBeUndefined();
		} finally {
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});

	it("evicts old final identities so bounded appends continue succeeding", async () => {
		const agentDir = await temporaryAgentDir("gjc-ledger-retention-");
		try {
			const ledger = await new LifecycleLedger(agentDir, { maxRows: 4 }).open();
			await recordTerminalOk(ledger, "identity-1");
			await recordTerminalOk(ledger, "identity-2");
			await recordTerminalOk(ledger, "identity-3");
			for (let index = 4; index <= 10; index += 1) await recordTerminalOk(ledger, `identity-${index}`);

			const reopened = await new LifecycleLedger(agentDir, { maxRows: 4 }).open();
			expect(reopened.get("identity-10")?.state).toBe("terminal_ok");
			expect(reopened.get("identity-1")).toBeUndefined();
		} finally {
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});

	it("admits a new identity by evicting the oldest settled row under byte pressure", async () => {
		const agentDir = await temporaryAgentDir("gjc-ledger-retention-byte-admission-");
		const clock = useExplicitClock();
		try {
			const ledger = await new LifecycleLedger(agentDir, { maxBytes: 750, maxRows: 100 }).open();
			await recordShortTerminal(ledger, "a");
			clock.advance();
			await recordShortTerminal(ledger, "b");
			clock.advance();

			await expect(ledger.begin("c", "r", { operationKey: "o", fingerprint: "f" })).resolves.toMatchObject({
				kind: "new",
				entry: { identity: "c", state: "accepted" },
			});
			expect(ledger.get("a")).toBeUndefined();
			expect(ledger.get("b")?.state).toBe("terminal_ok");
			expect(ledger.get("c")?.state).toBe("accepted");
		} finally {
			clock.restore();
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});

	it("continues admitting settled identities under a fixed byte cap", async () => {
		const agentDir = await temporaryAgentDir("gjc-ledger-retention-byte-repeat-");
		const clock = useExplicitClock();
		try {
			const ledger = await new LifecycleLedger(agentDir, { maxBytes: 750, maxRows: 100 }).open();
			await recordShortTerminal(ledger, "a");
			clock.advance();
			await recordShortTerminal(ledger, "b");
			for (const identity of ["c", "d", "e", "f", "g"]) {
				clock.advance();
				await recordShortTerminal(ledger, identity);
				expect(ledger.get(identity)?.state).toBe("terminal_ok");
			}
		} finally {
			clock.restore();
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});

	it("reopens consistently after byte-pressure eviction and admits again", async () => {
		const agentDir = await temporaryAgentDir("gjc-ledger-retention-byte-reopen-");
		const clock = useExplicitClock();
		try {
			const ledger = await new LifecycleLedger(agentDir, { maxBytes: 750, maxRows: 100 }).open();
			await recordShortTerminal(ledger, "a");
			clock.advance();
			await recordShortTerminal(ledger, "b");
			clock.advance();
			await ledger.begin("c", "r", { operationKey: "o", fingerprint: "f" });
			expect(ledger.get("a")).toBeUndefined();

			const reopened = await new LifecycleLedger(agentDir, { maxBytes: 750, maxRows: 100 }).open();
			expect(reopened.get("a")).toBeUndefined();
			expect(reopened.get("b")?.state).toBe("terminal_ok");
			expect(reopened.get("c")?.state).toBe("accepted");
			await recordShortTerminal(reopened, "d");
			expect(reopened.get("d")?.state).toBe("terminal_ok");
		} finally {
			clock.restore();
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});

	it("rejects an oversized incoming row without writing it", async () => {
		const agentDir = await temporaryAgentDir("gjc-ledger-retention-byte-oversized-");
		try {
			const ledger = await new LifecycleLedger(agentDir, { maxBytes: 100, maxRows: 100 }).open();
			await expect(ledger.begin("oversized", "request", { operationKey: "o", fingerprint: "f" })).rejects.toThrow(
				"Lifecycle ledger append exceeds configured bounds.",
			);
			expect(await ledgerBytes(agentDir)).toBe(0);
			expect(ledger.get("oversized")).toBeUndefined();
		} finally {
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});

	it("retains terminal_uncertain identities during compaction and restart", async () => {
		const agentDir = await temporaryAgentDir("gjc-ledger-retention-uncertain-");
		try {
			const ledger = await new LifecycleLedger(agentDir, { maxRows: 4 }).open();
			await ledger.begin("uncertain", "uncertain-request");
			await ledger.transition("uncertain", "terminal_uncertain");
			await recordTerminalOk(ledger, "final-1");
			await recordTerminalOk(ledger, "final-2");
			await recordTerminalOk(ledger, "final-3");

			const reopened = await new LifecycleLedger(agentDir, { maxRows: 4 }).open();
			expect(reopened.get("uncertain")?.state).toBe("terminal_uncertain");
			expect(reopened.get("final-3")?.state).toBe("terminal_ok");
		} finally {
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});

	it("retains settled unbound closes so duplicate requests replay", async () => {
		const agentDir = await temporaryAgentDir("gjc-ledger-retention-unbound-close-");
		try {
			const ledger = await new LifecycleLedger(agentDir, { maxRows: 4 }).open();
			await ledger.begin("unbound-close", "close-request", {
				operationKey: "session.close\u0000close-key",
			});
			const response = { ok: true, result: { sessionId: "session" } };
			await ledger.transition("unbound-close", "terminal_ok", { response });
			for (let index = 1; index <= 8; index += 1) await recordTerminalOk(ledger, `traffic-${index}`);

			const reopened = await new LifecycleLedger(agentDir, { maxRows: 4 }).open();
			expect(reopened.get("unbound-close")?.response).toEqual(response);
			expect(await reopened.begin("unbound-close", "close-request")).toMatchObject({
				kind: "replay",
				entry: { response },
			});
		} finally {
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});

	it("retains metadata-free terminal legacy identities under pressure", async () => {
		const agentDir = await temporaryAgentDir("gjc-ledger-retention-legacy-terminal-");
		try {
			const ledger = await new LifecycleLedger(agentDir, { maxRows: 4 }).open();
			await recordLegacyTerminalOk(ledger, "legacy-terminal");
			for (let index = 1; index <= 8; index += 1) await recordTerminalOk(ledger, `traffic-${index}`);

			const reopened = await new LifecycleLedger(agentDir, { maxRows: 4 }).open();
			expect(reopened.get("legacy-terminal")?.state).toBe("terminal_ok");
		} finally {
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});

	it("retains partial metadata terminal identities under pressure", async () => {
		const agentDir = await temporaryAgentDir("gjc-ledger-retention-partial-metadata-");
		try {
			const ledger = await new LifecycleLedger(agentDir, { maxRows: 4 }).open();
			await ledger.begin("partial-metadata", "partial-request", { operationKey: "test.operation\u0000partial" });
			await ledger.transition("partial-metadata", "terminal_ok", { response: { ok: true } });
			for (let index = 1; index <= 8; index += 1) await recordTerminalOk(ledger, `traffic-${index}`);

			const reopened = await new LifecycleLedger(agentDir, { maxRows: 4 }).open();
			expect(reopened.get("partial-metadata")?.state).toBe("terminal_ok");
		} finally {
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});

	it("keeps a legacy close fence through successor admission and delayed retry", async () => {
		const agentDir = await temporaryAgentDir("gjc-ledger-retention-legacy-close-retry-");
		try {
			const ledger = await new LifecycleLedger(agentDir, { maxRows: 4 }).open();
			const closeResponse = { ok: true, result: { sessionId: "S" } };
			await ledger.begin("legacy-close-S", "legacy-close-S-request");
			await ledger.transition("legacy-close-S", "terminal_ok", { response: closeResponse });
			for (let index = 1; index <= 8; index += 1) await recordTerminalOk(ledger, `traffic-${index}`);

			expect(ledger.hasLegacyIdentity()).toBe(true);
			await ledger.begin("successor-create-S", "successor-create-request", {
				operationKey: "session.create\u0000successor",
				fingerprint: "successor-fingerprint",
			});
			expect(await ledger.begin("legacy-close-S", "legacy-close-S-request")).toMatchObject({ kind: "replay" });
			expect(ledger.get("legacy-close-S")?.response).toEqual(closeResponse);
		} finally {
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});

	it("evicts settled generation-bound closes under capacity pressure", async () => {
		const agentDir = await temporaryAgentDir("gjc-ledger-retention-bound-close-");
		try {
			const ledger = await new LifecycleLedger(agentDir, { maxRows: 4 }).open();
			await ledger.begin("bound-close", "close-request", {
				operationKey: "session.close\u0000close-key",
				fingerprint: "close-fingerprint",
				closeAuthorityBound: true,
			});
			await ledger.transition("bound-close", "terminal_ok", { response: { ok: true } });
			for (let index = 1; index <= 8; index += 1) await recordTerminalOk(ledger, `traffic-${index}`);

			const reopened = await new LifecycleLedger(agentDir, { maxRows: 4 }).open();
			expect(reopened.get("bound-close")).toBeUndefined();
		} finally {
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});

	it("retains a terminal create referenced by a pending retirement receipt", async () => {
		const agentDir = await temporaryAgentDir("gjc-ledger-retention-retirement-pending-");
		try {
			const ledger = await new LifecycleLedger(agentDir, { maxRows: 6 }).open();
			await recordTerminalError(ledger, "create-c");
			await ledger.begin("retirement", "retirement-request", {
				operationKey: "session.reconcile_uncertain\u0000retirement-key",
			});
			await ledger.transition("retirement", "effect_started", {
				response: retirementResponse("create-c"),
			});
			for (let index = 1; index <= 8; index += 1) await recordTerminalOk(ledger, `traffic-${index}`);

			expect(ledger.get("create-c")?.state).toBe("terminal_error");
			await ledger.transition("retirement", "terminal_ok", { response: { ok: true } });
			for (let index = 9; index <= 16; index += 1) await recordTerminalOk(ledger, `traffic-${index}`);
			expect(ledger.get("create-c")).toBeUndefined();
		} finally {
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});

	it("retains retirement sources from unresolved receipts across reopen", async () => {
		const agentDir = await temporaryAgentDir("gjc-ledger-retention-retirement-restart-");
		try {
			const ledger = await new LifecycleLedger(agentDir, { maxRows: 6 }).open();
			await recordTerminalError(ledger, "restart-create");
			await ledger.begin("restart-retirement", "retirement-request", {
				operationKey: "session.reconcile_uncertain\u0000restart-retirement",
			});
			await ledger.transition("restart-retirement", "effect_started", {
				response: retirementResponse("restart-create"),
			});
			await ledger.transition("restart-retirement", "terminal_error", {
				response: { ok: false, error: { code: "terminal_uncertain" } },
			});
			for (let index = 1; index <= 8; index += 1) await recordTerminalOk(ledger, `traffic-${index}`);

			const reopened = await new LifecycleLedger(agentDir, { maxRows: 6 }).open();
			expect(reopened.get("restart-create")?.state).toBe("terminal_error");
		} finally {
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});

	it("retains retirement sources for cancelled or teardown receipts", async () => {
		const agentDir = await temporaryAgentDir("gjc-ledger-retention-retirement-teardown-");
		try {
			const ledger = await new LifecycleLedger(agentDir, { maxRows: 6 }).open();
			await recordTerminalError(ledger, "teardown-create");
			await ledger.begin("teardown-retirement", "retirement-request", {
				operationKey: "session.reconcile_uncertain\u0000teardown-retirement",
			});
			await ledger.transition("teardown-retirement", "terminal_error", {
				response: retirementResponse("teardown-create"),
			});
			for (let index = 1; index <= 8; index += 1) await recordTerminalOk(ledger, `traffic-${index}`);

			expect(ledger.get("teardown-create")?.state).toBe("terminal_error");
		} finally {
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});

	it("serializes one surviving snapshot after selecting all victims", async () => {
		const agentDir = await temporaryAgentDir("gjc-ledger-retention-one-pass-");
		const openSpy = vi.spyOn(fs, "open");
		try {
			const ledger = await new LifecycleLedger(agentDir, { maxRows: 6 }).open();
			for (let index = 1; index <= 3; index += 1) await recordTerminalOk(ledger, `identity-${index}`);
			const temporaryOpenCount = () =>
				openSpy.mock.calls.filter(([file]) => String(file).includes(".lifecycle-ledger.")).length;
			const before = temporaryOpenCount();
			await ledger.begin("identity-4", "identity-4-request");
			expect(temporaryOpenCount() - before).toBe(1);
			const reopened = await new LifecycleLedger(agentDir, { maxRows: 6 }).open();
			expect(reopened.get("identity-1")).toBeUndefined();
			expect(reopened.get("identity-2")).toBeUndefined();
			expect(reopened.get("identity-3")?.state).toBe("terminal_ok");
			expect(reopened.get("identity-4")?.state).toBe("accepted");
		} finally {
			openSpy.mockRestore();
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});

	it("leaves the ledger unchanged when compaction write fails", async () => {
		const agentDir = await temporaryAgentDir("gjc-ledger-retention-write-failure-");
		try {
			const ledger = await new LifecycleLedger(agentDir, { maxRows: 4 }).open();
			await recordTerminalOk(ledger, "original-1");
			await recordTerminalOk(ledger, "original-2");
			const renameSpy = vi
				.spyOn(fs, "rename")
				.mockRejectedValueOnce(new Error("simulated compaction write failure"));
			await expect(recordTerminalOk(ledger, "failing-3")).rejects.toThrow("simulated compaction write failure");
			renameSpy.mockRestore();

			const reopened = await new LifecycleLedger(agentDir, { maxRows: 4 }).open();
			expect(reopened.get("original-1")?.state).toBe("terminal_ok");
			expect(reopened.get("original-2")?.state).toBe("terminal_ok");
			expect(reopened.get("failing-3")).toBeUndefined();
		} finally {
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});

	it("retains legacy fences when capacity has no evictable rows", async () => {
		const agentDir = await temporaryAgentDir("gjc-ledger-retention-capacity-fail-closed-");
		try {
			const ledger = await new LifecycleLedger(agentDir, { maxRows: 4 }).open();
			await recordLegacyTerminalOk(ledger, "legacy-1");
			await recordLegacyTerminalOk(ledger, "legacy-2");
			await expect(recordLegacyTerminalOk(ledger, "legacy-3")).rejects.toThrow(
				"Lifecycle ledger append exceeds configured bounds.",
			);
			expect(ledger.get("legacy-1")?.state).toBe("terminal_ok");
			expect(ledger.get("legacy-2")?.state).toBe("terminal_ok");
		} finally {
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});

	it("replays a retained legacy fence instead of duplicating a late terminal result", async () => {
		const agentDir = await temporaryAgentDir("gjc-ledger-retention-late-legacy-result-");
		try {
			const ledger = await new LifecycleLedger(agentDir, { maxRows: 4 }).open();
			await recordLegacyTerminalOk(ledger, "late-legacy");
			for (let index = 1; index <= 8; index += 1) await recordTerminalOk(ledger, `traffic-${index}`);
			expect(await ledger.begin("late-legacy", "late-legacy-request")).toMatchObject({ kind: "replay" });

			const reopened = await new LifecycleLedger(agentDir, { maxRows: 4 }).open();
			expect(reopened.get("late-legacy")?.state).toBe("terminal_ok");
		} finally {
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});
});
