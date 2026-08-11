import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import path from "node:path";

import { Broker } from "../src/sdk/broker/broker";
import { LifecycleLedger, type LifecycleLedgerEntry } from "../src/sdk/broker/lifecycle-ledger";

const temp = () => fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-terminal-evidence-"));
const ledgerFile = (agentDir: string) => path.join(agentDir, "sdk", "lifecycle-ledger.jsonl");

async function ledgerRows(agentDir: string): Promise<LifecycleLedgerEntry[]> {
	return (await fs.readFile(ledgerFile(agentDir), "utf8"))
		.split("\n")
		.filter(Boolean)
		.map(line => JSON.parse(line) as LifecycleLedgerEntry);
}

/**
 * A slow session host keeps its lifecycle row in `awaiting_ready` for as long as the child
 * takes to start. Any other broker recovering the shared ledger inside that window stamps the
 * row `terminal_uncertain`, and the owner still owns the operation and writes its own terminal
 * row afterwards. The owner's row is the authoritative outcome.
 */
it("reads the owner's terminal record after a concurrent recovery stamps its in-flight row", async () => {
	const agentDir = await temp();
	try {
		const owner = await new LifecycleLedger(agentDir).open();
		await owner.begin("create", "request-hash");
		await owner.transition("create", "effect_started", {
			effectIntent: { sessionId: "slow-session", stateRoot: path.join(agentDir, "state") },
		});
		await owner.transition("create", "awaiting_ready", {
			intendedSessionId: "slow-session",
			effectMarker: "marker",
		});

		const recovery = await new LifecycleLedger(agentDir).open();
		expect(recovery.get("create")?.state).toBe("terminal_uncertain");

		const response = { ok: true, result: { sessionId: "slow-session" } };
		await owner.transition("create", "terminal_ok", { response, resultSessionId: "slow-session" });

		expect(await owner.readTerminal("create", "request-hash")).toMatchObject({
			state: "terminal_ok",
			response,
		});
	} finally {
		await fs.rm(agentDir, { recursive: true, force: true });
	}
});

it("reads back a durable terminal_uncertain record instead of reporting it unpersisted", async () => {
	const agentDir = await temp();
	try {
		const ledger = await new LifecycleLedger(agentDir).open();
		await ledger.begin("uncertain", "request-hash");
		const response = {
			ok: false,
			error: { code: "terminal_uncertain", message: "Lifecycle startup cleanup could not be proven." },
		};
		await ledger.transition("uncertain", "terminal_uncertain", { response });

		expect(await ledger.readTerminal("uncertain", "request-hash")).toMatchObject({
			state: "terminal_uncertain",
			response,
		});
	} finally {
		await fs.rm(agentDir, { recursive: true, force: true });
	}
});

it("withholds proof when a persisted terminal row cannot be reproduced", async () => {
	const agentDir = await temp();
	try {
		const ledger = await new LifecycleLedger(agentDir).open();
		await ledger.begin("tampered", "request-hash");
		await ledger.transition("tampered", "terminal_ok", { response: { ok: true, result: { sessionId: "s" } } });

		const rows = await ledgerRows(agentDir);
		rows[rows.length - 1]!.responseDigest = "0".repeat(64);
		await fs.writeFile(ledgerFile(agentDir), `${rows.map(row => JSON.stringify(row)).join("\n")}\n`);

		expect(await new LifecycleLedger(agentDir).readTerminal("tampered", "request-hash")).toBeUndefined();
	} finally {
		await fs.rm(agentDir, { recursive: true, force: true });
	}
});

it("withholds proof when a row follows a proven terminal outcome", async () => {
	const agentDir = await temp();
	try {
		const ledger = await new LifecycleLedger(agentDir).open();
		await ledger.begin("successor", "request-hash");
		const terminal = await ledger.transition("successor", "terminal_ok", {
			response: { ok: true, result: { sessionId: "s" } },
		});
		await fs.appendFile(ledgerFile(agentDir), `${JSON.stringify({ ...terminal, ts: terminal.ts + 1 })}\n`);

		expect(await new LifecycleLedger(agentDir).readTerminal("successor", "request-hash")).toBeUndefined();
	} finally {
		await fs.rm(agentDir, { recursive: true, force: true });
	}
});

it("returns the real terminal outcome when a slow spawn is stamped by a concurrent recovery", async () => {
	const agentDir = await temp();
	const previousCommand = process.env.GJC_SDK_SESSION_COMMAND;
	process.env.GJC_SDK_SESSION_COMMAND = "/bin/sleep 60";
	const broker = new Broker({ agentDir });
	await broker.start();
	try {
		const lifecycle = broker.handleRequest(
			"session.create",
			{ cwd: agentDir, readinessTimeoutMs: 4_000 },
			"slow-spawn-recovery",
		);

		const deadline = Date.now() + 10_000;
		let inFlight: LifecycleLedgerEntry | undefined;
		while (Date.now() < deadline) {
			const rows = await ledgerRows(agentDir).catch(() => []);
			inFlight = rows.find(row => row.state === "awaiting_ready");
			if (inFlight) break;
			await Bun.sleep(10);
		}
		if (!inFlight) throw new Error("Expected the slow spawn to reach awaiting_ready");
		// A concurrent broker recovering the shared ledger stamps the in-flight row uncertain.
		const recovery = await new LifecycleLedger(agentDir).open();
		expect(recovery.get(inFlight.identity)?.state).toBe("terminal_uncertain");

		expect(await lifecycle).toMatchObject({
			ok: false,
			error: {
				code: "terminal_uncertain",
				message: "Lifecycle startup cleanup could not be proven; retained artifacts require reconciliation.",
			},
		});
		const rows = await ledgerRows(agentDir);
		expect(
			rows.filter(row => JSON.stringify(row.response ?? "").includes("terminal evidence could not be verified")),
		).toHaveLength(0);
	} finally {
		if (previousCommand === undefined) delete process.env.GJC_SDK_SESSION_COMMAND;
		else process.env.GJC_SDK_SESSION_COMMAND = previousCommand;
		await broker.stop();
		await fs.rm(agentDir, { recursive: true, force: true });
	}
}, 20_000);
