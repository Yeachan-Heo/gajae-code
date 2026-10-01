import { describe, expect, it } from "bun:test";
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
});
