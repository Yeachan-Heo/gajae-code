import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import path from "node:path";
import fc from "fast-check";

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
			kind: "terminal",
			entry: { state: "terminal_ok", response },
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
			kind: "terminal",
			entry: { state: "terminal_uncertain", response },
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

		expect(await new LifecycleLedger(agentDir).readTerminal("tampered", "request-hash")).toEqual({
			kind: "rejected",
			reason: "row-not-attributable",
		});
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

		expect(await new LifecycleLedger(agentDir).readTerminal("successor", "request-hash")).toEqual({
			kind: "rejected",
			reason: "row-not-attributable",
		});
	} finally {
		await fs.rm(agentDir, { recursive: true, force: true });
	}
});

it("reads its own terminal row when another identity's row exceeds the JSON bounds", async () => {
	const agentDir = await temp();
	try {
		const ledger = await new LifecycleLedger(agentDir).open();
		await ledger.begin("target", "request-hash");
		const response = { ok: true, result: { sessionId: "s" } };
		await ledger.transition("target", "terminal_ok", { response });

		// A cleanup receipt GJC itself writes can carry an artifact snapshot over the
		// 1024-element JSON bound. It must not make this identity's proof unreadable.
		const rows = await ledgerRows(agentDir);
		const foreign = {
			version: rows[0]!.version,
			identity: "foreign",
			requestHash: "foreign-request",
			state: "effect_started",
			ts: rows[0]!.ts,
			operationKey: "session.delete\u0000foreign",
			response: {
				ok: false,
				error: {
					code: "cleanup_pending",
					cleanup: {
						sessionId: "s",
						artifactTree: {
							snapshot: { entries: Array.from({ length: 1066 }, (_, index) => ({ index })) },
						},
					},
				},
			},
		};
		await fs.appendFile(ledgerFile(agentDir), `${JSON.stringify(foreign)}\n`);

		expect(await new LifecycleLedger(agentDir).readTerminal("target", "request-hash")).toMatchObject({
			kind: "terminal",
			entry: { state: "terminal_ok", response },
		});
	} finally {
		await fs.rm(agentDir, { recursive: true, force: true });
	}
});

it("withholds proof when the requested identity's own row exceeds the JSON bounds", async () => {
	const agentDir = await temp();
	try {
		const ledger = await new LifecycleLedger(agentDir).open();
		await ledger.begin("target", "request-hash");
		await ledger.transition("target", "terminal_ok", { response: { ok: true } });

		const rows = await ledgerRows(agentDir);
		await fs.appendFile(
			ledgerFile(agentDir),
			`${JSON.stringify({
				...rows[rows.length - 1],
				state: "terminal_error",
				ts: rows[rows.length - 1]!.ts + 1,
				response: { entries: Array.from({ length: 1066 }, (_, index) => ({ index })) },
				responseDigest: undefined,
			})}\n`,
		);

		expect(await new LifecycleLedger(agentDir).readTerminal("target", "request-hash")).toEqual({
			kind: "rejected",
			reason: "shape",
		});
	} finally {
		await fs.rm(agentDir, { recursive: true, force: true });
	}
});

it("scopes read-back to the requested identity for arbitrary decodable rows", async () => {
	await fc.assert(
		fc.asyncProperty(
			fc.constantFrom("foreign" as const, "target" as const),
			fc.boolean(),
			fc.jsonValue(),
			async (rowIdentity, oversized, payload) => {
				const agentDir = await temp();
				try {
					const ledger = await new LifecycleLedger(agentDir).open();
					await ledger.begin("target", "request-hash");
					const response = { ok: true, result: { sessionId: "s" } };
					await ledger.transition("target", "terminal_ok", { response });
					const rows = await ledgerRows(agentDir);
					const row = {
						version: rows[0]!.version,
						identity: rowIdentity,
						requestHash: rowIdentity === "target" ? "request-hash" : "foreign-hash",
						state: "effect_started",
						ts: Date.now(),
						response: oversized ? { entries: Array.from({ length: 1066 }, (_, index) => ({ index })) } : payload,
					};
					await fs.appendFile(ledgerFile(agentDir), `${JSON.stringify(row)}\n`);

					const read = await new LifecycleLedger(agentDir).readTerminal("target", "request-hash");
					if (rowIdentity === "foreign") {
						// An unrelated decodable row cannot withhold the target's proof, even
						// when its payload exceeds the ledger JSON bounds.
						expect(read).toMatchObject({ kind: "terminal", entry: { state: "terminal_ok", response } });
					} else {
						// The proven terminal row admits no successor: the same identity stays strict.
						expect(read).toMatchObject({ kind: "rejected" });
					}
				} finally {
					await fs.rm(agentDir, { recursive: true, force: true });
				}
			},
		),
		{ numRuns: 24 },
	);
}, 20_000);

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

		const response = await lifecycle;
		expect(structuredClone(response)).toMatchObject({
			ok: false,
			error: {
				code: "terminal_uncertain",
				message: expect.stringContaining(
					"Lifecycle startup cleanup could not be proven; retained artifacts require reconciliation. Original launch failure: Session ",
				),
			},
		});
		if (response.ok) throw new Error("Expected uncertain startup cleanup");
		expect(response.error.message).toContain(
			"did not become ready and its spawned process could not be verified dead. [lifecycle-diagnostic-v1] stage=readiness waiting_for=session_ready",
		);
		expect(await recovery.readTerminal(inFlight.identity, inFlight.requestHash)).toMatchObject({
			kind: "terminal",
			entry: { state: "terminal_uncertain", response },
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
