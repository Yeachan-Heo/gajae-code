import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { OperationReceiptLedger, operationReceiptDigest } from "../src/sdk/broker/operation-receipt-ledger";

async function fixture(): Promise<{ agentDir: string; ledger: OperationReceiptLedger }> {
	const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-operation-receipts-"));
	const ledger = new OperationReceiptLedger(agentDir);
	await ledger.open();
	return { agentDir, ledger };
}

describe("SDK broker operation receipt ledger", () => {
	it("reserves before dispatch and replays the exact durable response after restart", async () => {
		const { agentDir, ledger } = await fixture();
		const input = { text: "hello", clientRef: "01JSDKRECEIPT0000000000000" };
		const digest = operationReceiptDigest("turn.prompt", input);
		expect(await ledger.reserve(input.clientRef, digest)).toEqual({ status: "reserved" });
		expect(await ledger.reserve(input.clientRef, digest)).toEqual({ status: "in_progress" });
		const response = { ok: true as const, result: { accepted: true, clientRef: input.clientRef } };
		await ledger.complete(input.clientRef, digest, response);
		expect(await ledger.reserve(input.clientRef, digest)).toEqual({ status: "replay", response });

		const reopened = new OperationReceiptLedger(agentDir);
		await reopened.open();
		expect(await reopened.reserve(input.clientRef, digest)).toEqual({ status: "replay", response });
		const mode = (await fs.stat(path.join(agentDir, "sdk", "operation-receipts.jsonl"))).mode & 0o777;
		expect(mode).toBe(0o600);
	});

	it("rejects clientRef substitution and leaves crash-pending rows fail closed", async () => {
		const { agentDir, ledger } = await fixture();
		const clientRef = "01JSDKRECEIPT0000000000001";
		const first = operationReceiptDigest("turn.prompt", { text: "one", clientRef });
		const second = operationReceiptDigest("turn.prompt", { text: "two", clientRef });
		expect(await ledger.reserve(clientRef, first)).toEqual({ status: "reserved" });
		expect(await ledger.reserve(clientRef, second)).toEqual({ status: "conflict" });

		const reopened = new OperationReceiptLedger(agentDir);
		await reopened.open();
		expect(await reopened.reserve(clientRef, first)).toEqual({ status: "in_progress" });
	});
});
