import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import path from "node:path";
import { Broker } from "../src/sdk/broker/broker";
import { readBrokerDiscovery } from "../src/sdk/broker/discovery";
import { LifecycleLedger } from "../src/sdk/broker/lifecycle-ledger";
import { SessionIndex } from "../src/sdk/broker/session-index";

const temp = () => fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-sdk-version-"));

async function expectFailClosed(file: string, reader: () => Promise<unknown>): Promise<void> {
	const before = await fs.readFile(file, "utf8");
	await expect(reader()).rejects.toMatchObject({ code: "unsupported_state_version" });
	expect(await fs.readFile(file, "utf8")).toBe(before);
}

test("newer broker, session-index, and lifecycle state versions fail closed before mutation", async () => {
	const dir = await temp();
	const sdk = path.join(dir, "sdk");
	const sessions = path.join(sdk, "sessions");
	await fs.mkdir(sessions, { recursive: true });

	const broker = path.join(sdk, "broker.json");
	await fs.writeFile(broker, JSON.stringify({ version: 99 }));
	await expectFailClosed(broker, () => readBrokerDiscovery(dir));
	await expectFailClosed(broker, () => new Broker({ agentDir: dir }).start());

	await fs.rm(broker);
	const index = path.join(sessions, "index.jsonl");
	await fs.writeFile(index, `corrupt-prefix\n${JSON.stringify({ version: 99 })}\n`);
	await expectFailClosed(index, () => new SessionIndex(dir).open());

	const ledger = path.join(sdk, "lifecycle-ledger.jsonl");
	await fs.writeFile(ledger, `${JSON.stringify({ version: 99 })}\n`);
	await expectFailClosed(ledger, () => new LifecycleLedger(dir).open());
});
