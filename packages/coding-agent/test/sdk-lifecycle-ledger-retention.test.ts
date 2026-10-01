import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import path from "node:path";
import { LifecycleLedger } from "../src/sdk/broker/lifecycle-ledger";

async function temporaryAgentDir(prefix: string): Promise<string> {
	return fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", prefix));
}

async function recordTerminalOk(ledger: LifecycleLedger, identity: string): Promise<void> {
	await ledger.begin(identity, `${identity}-request`);
	await ledger.transition(identity, "terminal_ok", { response: { ok: true, identity } });
}

async function recordTerminalError(ledger: LifecycleLedger, identity: string): Promise<void> {
	await ledger.begin(identity, `${identity}-request`);
	await ledger.transition(identity, "terminal_error", { response: { ok: false, identity } });
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

	it("evicts settled generation-bound closes under capacity pressure", async () => {
		const agentDir = await temporaryAgentDir("gjc-ledger-retention-bound-close-");
		try {
			const ledger = await new LifecycleLedger(agentDir, { maxRows: 4 }).open();
			await ledger.begin("bound-close", "close-request", {
				operationKey: "session.close\u0000close-key",
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
			expect(recordTerminalOk(ledger, "failing-3")).rejects.toThrow("simulated compaction write failure");
			renameSpy.mockRestore();

			const reopened = await new LifecycleLedger(agentDir, { maxRows: 4 }).open();
			expect(reopened.get("original-1")?.state).toBe("terminal_ok");
			expect(reopened.get("original-2")?.state).toBe("terminal_ok");
			expect(reopened.get("failing-3")).toBeUndefined();
		} finally {
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});
});
