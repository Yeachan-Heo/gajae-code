import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import path from "node:path";
import { LifecycleLedger } from "../src/sdk/broker/lifecycle-ledger";

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

	it("avoids retaining effect witnesses when terminal row cannot be pre-effect refusal", async () => {
		// Regression test for issue with compaction keeping effect witnesses for all unkeyed
		// terminal_errors with effect_started history, even when the terminal row has fields
		// or response that prevent it from being a pre-effect refusal.
		// Before fix: compaction keeps all witnesses, exceeding row cap
		// After fix: compaction filters witnesses by pre-effect refusal qualification
		const agentDir = await temporaryAgentDir("gjc-ledger-retention-effect-witness-");
		try {
			// Minimal fixture to force compaction at boundary:
			// - 2 unkeyed identities with (accepted, effect_started, terminal_error)
			// - maxRows=6 so compaction is triggered when appending to 6th row
			// With old code: snapshot = 2 × 3 = 6 rows (exactly at cap)
			// With new code: snapshot = 2 × 2 = 4 rows (under cap)
			const ledger = await new LifecycleLedger(agentDir, { maxRows: 6 }).open();

			// Create 2 unkeyed identities with non-allowlisted terminal_error
			// (cannot be pre-effect refusals, so witnesses should be filtered)
			for (let index = 1; index <= 2; index += 1) {
				const identity = `ew-${index}`;
				// No operationKey/fingerprint: unkeyed
				await ledger.begin(identity, `${identity}-r`);
				await ledger.transition(identity, "effect_started", {
					response: { ok: false, error: { code: "unknown_error", message: "X" } },
				});
				await ledger.transition(identity, "terminal_error", {
					response: { ok: false, error: { code: "unknown_error", message: "X" } },
				});
			}

			// Appending a new identity's accepted row (7th row total) forces compaction.
			// With old code: compaction snapshot = 6 rows, appending 1 more = 7 > 6 cap → fails
			// With new code: compaction snapshot = 4 rows, appending 1 more = 5 ≤ 6 cap → succeeds
			const { kind: beginKind } = await ledger.begin("keyed-identity", "keyed-r", {
				operationKey: "o",
				fingerprint: "f",
			});
			expect(beginKind).toBe("new");

			// Verify unkeyed entries survived compaction
			expect(ledger.get("ew-1")?.state).toBe("terminal_error");
			expect(ledger.get("ew-2")?.state).toBe("terminal_error");
		} finally {
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});

	it("preserves legacy fence across compaction when response has undefined keys", async () => {
		// Regression test: unkeyed terminal_error with undefined response/error properties
		// should not lose its fence during compaction. If undefined keys are not filtered
		// in the pre-effect-refusal check, the witness is dropped, losing the fence.
		// With fix: Object.entries(...).every(([k,v]) => v===undefined || allowed(k))
		//   filters undefined → witness kept → fence preserved.
		// Without fix: Object.keys sees undefined properties → disqualifies →
		//   witness lost → fence lost on restart.
		const agentDir = await temporaryAgentDir("gjc-ledger-retention-fence-undefined-");
		try {
			const ledger = await new LifecycleLedger(agentDir, { maxRows: 6 }).open();

			// Seed 3 rows: unkeyed identity with undefined fields in response/error
			const unkeyed = "unkeyed-undefined";
			await ledger.begin(unkeyed, `${unkeyed}-req`);
			await ledger.transition(unkeyed, "effect_started", {
				response: {
					ok: false,
					extraField: undefined, // disqualifies if not filtered
					error: {
						code: "unknown_model_profile",
						message: "Not found",
						cleanup: undefined, // disqualifies if not filtered
					},
				},
			});
			await ledger.transition(unkeyed, "terminal_error", {
				response: {
					ok: false,
					extraField: undefined,
					error: {
						code: "unknown_model_profile",
						message: "Not found",
						cleanup: undefined,
					},
				},
			});

			// Seed 3 rows: keyed identity to reach maxRows=6 (unkeyed×3 + keyed×3)
			const keyed = "keyed";
			await ledger.begin(keyed, `${keyed}-req`, { operationKey: "k", fingerprint: "fp" });
			await ledger.transition(keyed, "effect_started", { response: { ok: true } });
			await ledger.transition(keyed, "terminal_ok", { response: { ok: true } });

			// Check fence before compaction: hasLegacyIdentity(undefined, target)
			// queries if ANY unexcluded legacy identity fences the target
			const target = { sessionId: "unrelated", keyReuseIdentities: new Set<string>() };
			const fenceBefore = ledger.hasLegacyIdentity(undefined, { sessionTarget: target });
			expect(fenceBefore).toBe(true); // unkeyed identity fences unrelated target

			// Force compaction: appending 7th row (rowCount=6, +1 > maxRows=6)
			// With fix: snapshot keeps witness → 3 unkeyed + 2 keyed + 1 = 6 rows
			// Without fix: witness lost → 2 unkeyed + 2 keyed + 1 = 5 rows
			const keyed2 = "keyed2";
			await ledger.begin(keyed2, `${keyed2}-req`, { operationKey: "k2", fingerprint: "fp" });

			// Verify fence still present after compaction
			const fenceAfterCompact = ledger.hasLegacyIdentity(undefined, { sessionTarget: target });
			expect(fenceAfterCompact).toBe(true);

			// Verify fence persists after restart
			const reopened = await new LifecycleLedger(agentDir, { maxRows: 6 }).open();
			const fenceAfterReopen = reopened.hasLegacyIdentity(undefined, { sessionTarget: target });
			expect(fenceAfterReopen).toBe(true);
		} finally {
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});
});
