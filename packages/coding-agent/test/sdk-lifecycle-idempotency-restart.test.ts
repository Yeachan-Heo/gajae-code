import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import { LifecycleLedger } from "../src/sdk/broker/lifecycle-ledger";

describe("SDK lifecycle ledger", () => {
	it("replays terminal responses and rejects conflicts across restarts", async () => {
		const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-ledger-"));
		const ledger = await new LifecycleLedger(dir).open();
		const begun = await ledger.begin("i", "a");
		if (begun.kind !== "new") throw new Error("expected new");
		await ledger.transition("i", "terminal_ok", { response: { sessionId: "s" } });
		const resumed = await new LifecycleLedger(dir).open();
		expect((await resumed.begin("i", "a")).kind).toBe("replay");
		expect((await resumed.begin("i", "b")).kind).toBe("idempotency_conflict");
	});
	it("retries a clean accepted row after restart", async () => {
		const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-ledger-accepted-"));
		const ledger = await new LifecycleLedger(dir).open();
		await ledger.begin("i", "a");

		const resumed = await new LifecycleLedger(dir).open();
		expect((await resumed.begin("i", "a")).kind).toBe("new");
		expect((await resumed.begin("i", "b")).kind).toBe("idempotency_conflict");
		await resumed.transition("i", "terminal_ok", { response: { sessionId: "s" } });
		expect((await new LifecycleLedger(dir).open()).get("i")?.state).toBe("terminal_ok");
	});
	it("seals a valid row missing its final newline before appending", async () => {
		const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-ledger-unsealed-"));
		const ledgerPath = path.join(dir, "sdk", "lifecycle-ledger.jsonl");
		const ledger = await new LifecycleLedger(dir).open();
		await ledger.begin("i", "a");
		const source = await fs.readFile(ledgerPath, "utf8");
		await fs.writeFile(ledgerPath, source.slice(0, -1));

		const resumed = await new LifecycleLedger(dir).open();
		expect((await resumed.begin("i", "a")).kind).toBe("new");
		await resumed.transition("i", "terminal_ok", { response: { sessionId: "s" } });
		const lines = (await fs.readFile(ledgerPath, "utf8")).trimEnd().split("\n");
		expect(lines.map(line => JSON.parse(line))).toHaveLength(2);
	});
	it("quarantines corrupt middle rows and replays later valid rows", async () => {
		const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-ledger-"));
		const ledger = await new LifecycleLedger(dir).open();
		await ledger.begin("first", "a");
		await fs.appendFile(path.join(dir, "sdk", "lifecycle-ledger.jsonl"), "not json\n");
		const resumed = await new LifecycleLedger(dir).open();
		expect((await resumed.begin("first", "a")).kind).toBe("terminal_uncertain");
		await resumed.begin("later", "b");
		expect(resumed.get("first")).toBeDefined();
		expect(resumed.get("later")).toBeDefined();
		expect(resumed.warnings).not.toHaveLength(0);
		expect(await fs.readFile(path.join(dir, "sdk", "lifecycle-ledger.jsonl.corrupt"), "utf8")).toContain("not json");
	});
	it("fails closed when a torn row may hide side-effect authority", async () => {
		const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-ledger-torn-"));
		const ledgerPath = path.join(dir, "sdk", "lifecycle-ledger.jsonl");
		const ledger = await new LifecycleLedger(dir).open();
		await ledger.begin("i", "a");
		await fs.appendFile(
			ledgerPath,
			`${JSON.stringify({ version: 1, identity: "i", requestHash: "a", state: "effect_started" }).slice(0, -1)}`,
		);

		const resumed = await new LifecycleLedger(dir).open();
		expect((await resumed.begin("i", "a")).kind).toBe("terminal_uncertain");
		expect(resumed.get("i")?.state).toBe("terminal_uncertain");
		const recoveredLines = (await fs.readFile(ledgerPath, "utf8")).trimEnd().split("\n");
		expect(() => JSON.parse(recoveredLines.at(-2)!)).toThrow();
		expect(JSON.parse(recoveredLines.at(-1)!)).toMatchObject({ identity: "i", state: "terminal_uncertain" });
		expect((await new LifecycleLedger(dir).open()).get("i")?.state).toBe("terminal_uncertain");
	});
	it("does not let a later terminal row clear uncertainty from corrupt middle history", async () => {
		const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-ledger-corrupt-"));
		const ledgerPath = path.join(dir, "sdk", "lifecycle-ledger.jsonl");
		const ledger = await new LifecycleLedger(dir).open();
		await ledger.begin("i", "a");
		await fs.appendFile(ledgerPath, "not json\n");
		await fs.appendFile(
			ledgerPath,
			`${JSON.stringify({
				version: 1,
				identity: "i",
				requestHash: "a",
				state: "terminal_ok",
				response: { sessionId: "s" },
				responseDigest: createHash("sha256").update('{"sessionId":"s"}').digest("hex"),
				ts: Date.now(),
			})}\n`,
		);

		const resumed = await new LifecycleLedger(dir).open();
		expect((await resumed.begin("i", "a")).kind).toBe("terminal_uncertain");
		expect(resumed.get("i")?.state).toBe("terminal_uncertain");
		const quarantined = await fs.readFile(`${ledgerPath}.corrupt`, "utf8");
		expect(quarantined).toContain('"state":"terminal_ok"');
	});
	it("persists complete multibyte rows through durable appends", async () => {
		const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-ledger-large-"));
		const ledgerPath = path.join(dir, "sdk", "lifecycle-ledger.jsonl");
		const response = { payload: "界".repeat(128 * 1024) };
		const ledger = await new LifecycleLedger(dir).open();
		await ledger.begin("i", "a");
		await ledger.transition("i", "terminal_ok", { response });

		const lines = (await fs.readFile(ledgerPath, "utf8")).trimEnd().split("\n");
		expect(lines.map(line => JSON.parse(line))).toHaveLength(2);
		expect((await new LifecycleLedger(dir).open()).get("i")?.response).toEqual(response);
	});
	it("reads concurrent terminal proof without mutating an unrelated torn append", async () => {
		const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-ledger-read-terminal-"));
		const ledgerPath = path.join(dir, "sdk", "lifecycle-ledger.jsonl");
		const ledger = await new LifecycleLedger(dir).open();
		await Promise.all([ledger.begin("first", "first-request"), ledger.begin("second", "second-request")]);
		await Promise.all([
			ledger.transition("first", "terminal_ok", { response: { sessionId: "first" } }),
			ledger.transition("second", "terminal_ok", { response: { sessionId: "second" } }),
		]);
		await fs.appendFile(
			ledgerPath,
			JSON.stringify(lifecycleRow("unrelated", "unrelated-request", "effect_started", Date.now())).slice(0, -1),
		);
		const before = await fs.readFile(ledgerPath, "utf8");
		const verifier = new LifecycleLedger(dir);

		await expect(verifier.readTerminal("first", "first-request")).resolves.toMatchObject({
			state: "terminal_ok",
			response: { sessionId: "first" },
		});
		await expect(verifier.readTerminal("second", "second-request")).resolves.toMatchObject({
			state: "terminal_ok",
			response: { sessionId: "second" },
		});
		expect(await fs.readFile(ledgerPath, "utf8")).toBe(before);
		expect(await fs.stat(`${ledgerPath}.corrupt`).catch(() => undefined)).toBeUndefined();
	});

	it("withholds terminal proof for incomplete or conflicting target history", async () => {
		const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-ledger-read-terminal-target-"));
		const ledgerPath = path.join(dir, "sdk", "lifecycle-ledger.jsonl");
		const ledger = await new LifecycleLedger(dir).open();
		await ledger.begin("target", "request");
		await ledger.transition("target", "terminal_ok", { response: { sessionId: "target" } });
		const terminalSource = await fs.readFile(ledgerPath, "utf8");
		await fs.writeFile(ledgerPath, terminalSource.slice(0, -1));
		await expect(new LifecycleLedger(dir).readTerminal("target", "request")).resolves.toBeUndefined();

		const conflictingDir = await fs.mkdtemp(
			path.join(process.env.TMPDIR ?? "/tmp", "gjc-ledger-read-terminal-conflict-"),
		);
		const conflictingPath = path.join(conflictingDir, "sdk", "lifecycle-ledger.jsonl");
		await fs.mkdir(path.dirname(conflictingPath), { recursive: true });
		await fs.writeFile(
			conflictingPath,
			[
				lifecycleRow("target", "request", "accepted", 1),
				lifecycleRow("target", "request", "terminal_ok", 2, {
					response: { sessionId: "target" },
					responseDigest: "invalid",
				}),
			]
				.map(row => `${JSON.stringify(row)}\n`)
				.join(""),
		);
		await expect(new LifecycleLedger(conflictingDir).readTerminal("target", "request")).resolves.toBeUndefined();
	});
});

function lifecycleRow(
	identity: string,
	requestHash: string,
	state: "accepted" | "effect_started" | "awaiting_ready" | "terminal_ok" | "terminal_error",
	ts: number,
	fields: Record<string, unknown> = {},
): Record<string, unknown> {
	return { version: 1, identity, requestHash, state, ts, ...fields };
}

describe("SDK lifecycle ledger history validation", () => {
	it("quarantines a request hash substitution without exposing its effect intent", async () => {
		const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-ledger-history-"));
		const ledgerPath = path.join(dir, "sdk", "lifecycle-ledger.jsonl");
		await fs.mkdir(path.dirname(ledgerPath), { recursive: true });
		await fs.writeFile(
			ledgerPath,
			[
				lifecycleRow("i", "original", "accepted", 1),
				lifecycleRow("i", "substituted", "effect_started", 2, {
					effectIntent: { sessionId: "untrusted", stateRoot: "/untrusted" },
				}),
			]
				.map(row => `${JSON.stringify(row)}\n`)
				.join(""),
		);

		const ledger = await new LifecycleLedger(dir).open();
		expect(await ledger.begin("i", "original")).toMatchObject({ kind: "terminal_uncertain" });
		expect(ledger.get("i")).toMatchObject({ state: "terminal_uncertain", requestHash: "original" });
		expect(ledger.get("i")?.effectIntent).toBeUndefined();
		expect(await fs.readFile(`${ledgerPath}.corrupt`, "utf8")).toContain("substituted");
	});

	it("quarantines every row after a terminal entry for the same identity", async () => {
		const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-ledger-history-"));
		const ledgerPath = path.join(dir, "sdk", "lifecycle-ledger.jsonl");
		const response = { sessionId: "s" };
		const responseDigest = createHash("sha256").update(JSON.stringify(response)).digest("hex");
		await fs.mkdir(path.dirname(ledgerPath), { recursive: true });
		await fs.writeFile(
			ledgerPath,
			[
				lifecycleRow("i", "request", "accepted", 1),
				lifecycleRow("i", "request", "terminal_ok", 2, { response, responseDigest }),
				lifecycleRow("i", "request", "accepted", 3),
				lifecycleRow("i", "request", "terminal_error", 4, { response, responseDigest }),
			]
				.map(row => `${JSON.stringify(row)}\n`)
				.join(""),
		);

		const ledger = await new LifecycleLedger(dir).open();
		expect(await ledger.begin("i", "request")).toMatchObject({ kind: "terminal_uncertain" });
		expect(ledger.get("i")?.response).toEqual(response);
		const quarantined = await fs.readFile(`${ledgerPath}.corrupt`, "utf8");
		expect(quarantined).toContain('"state":"accepted"');
		expect(quarantined).toContain('"state":"terminal_error"');
	});

	it("accepts repeated and interleaved durable effect markers before a terminal entry", async () => {
		const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-ledger-history-"));
		const ledgerPath = path.join(dir, "sdk", "lifecycle-ledger.jsonl");
		const response = { sessionId: "s" };
		await fs.mkdir(path.dirname(ledgerPath), { recursive: true });
		await fs.writeFile(
			ledgerPath,
			[
				lifecycleRow("i", "request", "accepted", 1),
				lifecycleRow("i", "request", "accepted", 2),
				lifecycleRow("i", "request", "effect_started", 3),
				lifecycleRow("i", "request", "awaiting_ready", 4),
				lifecycleRow("i", "request", "effect_started", 5),
				lifecycleRow("i", "request", "awaiting_ready", 6),
				lifecycleRow("i", "request", "terminal_ok", 7, {
					response,
					responseDigest: createHash("sha256").update(JSON.stringify(response)).digest("hex"),
				}),
			]
				.map(row => `${JSON.stringify(row)}\n`)
				.join(""),
		);

		const ledger = await new LifecycleLedger(dir).open();
		expect(await ledger.begin("i", "request")).toMatchObject({ kind: "replay", entry: { response } });
		expect(await fs.stat(`${ledgerPath}.corrupt`).catch(() => undefined)).toBeUndefined();
	});

	it("quarantines standalone cleanup authority without appending lifecycle authority", async () => {
		const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-ledger-unanchored-cleanup-"));
		const ledgerPath = path.join(dir, "sdk", "lifecycle-ledger.jsonl");
		await fs.mkdir(path.dirname(ledgerPath), { recursive: true });
		const cleanupOnly = lifecycleRow("cleanup", "request", "effect_started", 1, {
			response: { ok: false, error: { code: "cleanup_pending", cleanup: { target: "outside" } } },
		});
		const terminalOnly = lifecycleRow("terminal", "request", "terminal_ok", 2, {
			response: { sessionId: "untrusted" },
			responseDigest: createHash("sha256").update('{"sessionId":"untrusted"}').digest("hex"),
		});
		const source = [cleanupOnly, terminalOnly].map(row => `${JSON.stringify(row)}\n`).join("");
		await fs.writeFile(ledgerPath, source);

		const ledger = await new LifecycleLedger(dir).open();
		expect(await ledger.begin("cleanup", "request")).toMatchObject({ kind: "terminal_uncertain" });
		expect(await ledger.begin("terminal", "request")).toMatchObject({ kind: "terminal_uncertain" });
		await expect(new LifecycleLedger(dir).readTerminal("cleanup", "request")).resolves.toBeUndefined();
		await expect(new LifecycleLedger(dir).readTerminal("terminal", "request")).resolves.toBeUndefined();
		expect(await fs.readFile(ledgerPath, "utf8")).toBe(source);
		expect(await fs.readFile(`${ledgerPath}.corrupt`, "utf8")).toContain('"effect_started"');
	});

	it("rejects ledger and corrupt-sidecar symlink swaps without modifying their targets", async () => {
		const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-ledger-symlink-write-"));
		const sdkDir = path.join(dir, "sdk");
		const ledgerPath = path.join(sdkDir, "lifecycle-ledger.jsonl");
		const outside = path.join(dir, "outside");
		await new LifecycleLedger(dir).open();
		await fs.writeFile(outside, "outside-ledger");
		await fs.symlink(outside, ledgerPath);
		await expect(new LifecycleLedger(dir).begin("swap", "request")).rejects.toThrow();
		expect(await fs.readFile(outside, "utf8")).toBe("outside-ledger");

		await fs.unlink(ledgerPath);
		await fs.writeFile(ledgerPath, "not json\n");
		const corruptOutside = path.join(dir, "outside-corrupt");
		await fs.writeFile(corruptOutside, "outside-corrupt");
		await fs.symlink(corruptOutside, `${ledgerPath}.corrupt`);
		await expect(new LifecycleLedger(dir).open()).rejects.toThrow();
		expect(await fs.readFile(corruptOutside, "utf8")).toBe("outside-corrupt");
	});
});

describe("SDK lifecycle ledger bounded writer", () => {
	it("compacts before a writer-generated row threshold and reopens the terminal authority", async () => {
		const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-ledger-compact-"));
		const ledger = await new LifecycleLedger(dir, { maxRows: 2 }).open();
		await ledger.begin("i", "request");
		await ledger.transition("i", "effect_started");
		const response = { sessionId: "survives-compaction" };
		await ledger.transition("i", "terminal_ok", { response });

		const resumed = await new LifecycleLedger(dir, { maxRows: 2 }).open();
		expect(await resumed.begin("i", "request")).toMatchObject({ kind: "replay", entry: { response } });
		const rows = (await fs.readFile(path.join(dir, "sdk", "lifecycle-ledger.jsonl"), "utf8"))
			.trimEnd()
			.split("\n")
			.map(line => JSON.parse(line));
		expect(rows).toHaveLength(2);
		expect(rows.at(-1)).toMatchObject({ state: "terminal_ok", response });
		expect(rows.at(0)).toMatchObject({ identity: "i", requestHash: "request", state: "accepted" });
	});

	it("compacts an accepted anchor with its latest nonterminal authority", async () => {
		const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-ledger-compact-effect-"));
		const ledgerPath = path.join(dir, "sdk", "lifecycle-ledger.jsonl");
		const ledger = await new LifecycleLedger(dir, { maxRows: 3 }).open();
		await ledger.begin("first", "request");
		await ledger.transition("first", "accepted");
		await ledger.transition("first", "effect_started");
		await ledger.begin("second", "request");

		const rows = (await fs.readFile(ledgerPath, "utf8"))
			.trimEnd()
			.split("\n")
			.map(line => JSON.parse(line));
		expect(rows).toMatchObject([
			{ identity: "first", requestHash: "request", state: "accepted" },
			{ identity: "first", requestHash: "request", state: "effect_started" },
			{ identity: "second", requestHash: "request", state: "accepted" },
		]);
		expect((await new LifecycleLedger(dir, { maxRows: 3 }).open()).get("first")?.state).toBe("terminal_uncertain");
	});

	it("rejects before writing when compaction cannot make room for the next identity transition", async () => {
		const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-ledger-compact-full-"));
		const ledgerPath = path.join(dir, "sdk", "lifecycle-ledger.jsonl");
		const ledger = await new LifecycleLedger(dir, { maxRows: 2 }).open();
		await ledger.begin("first", "a");
		await ledger.begin("second", "b");
		const before = await fs.readFile(ledgerPath, "utf8");

		await expect(ledger.transition("first", "terminal_ok", { response: { sessionId: "first" } })).rejects.toThrow(
			"Lifecycle ledger compaction exceeds configured bounds.",
		);
		expect(await fs.readFile(ledgerPath, "utf8")).toBe(before);
	});

	it("leaves the prior ledger authoritative when a torn compaction temporary file exists", async () => {
		const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-ledger-compact-temp-"));
		const ledger = await new LifecycleLedger(dir).open();
		await ledger.begin("i", "request");
		await ledger.transition("i", "terminal_ok", { response: { sessionId: "stable" } });
		const sdkDir = path.join(dir, "sdk");
		await fs.writeFile(path.join(sdkDir, ".lifecycle-ledger.crash.tmp"), "{torn");

		const resumed = await new LifecycleLedger(dir).open();
		expect(await resumed.begin("i", "request")).toMatchObject({
			kind: "replay",
			entry: { response: { sessionId: "stable" } },
		});
	});
});

it("serializes concurrent distinct-identity compactions and reopens both terminal responses", async () => {
	const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-ledger-compact-fifo-"));
	const ledger = await new LifecycleLedger(dir, { maxRows: 4 }).open();
	await Promise.all([ledger.begin("first", "first-request"), ledger.begin("second", "second-request")]);
	await Promise.all([ledger.transition("first", "effect_started"), ledger.transition("second", "effect_started")]);
	await Promise.all([
		ledger.transition("first", "terminal_ok", { response: { sessionId: "first" } }),
		ledger.transition("second", "terminal_ok", { response: { sessionId: "second" } }),
	]);

	const reopened = await new LifecycleLedger(dir, { maxRows: 4 }).open();
	expect(await reopened.begin("first", "first-request")).toMatchObject({
		kind: "replay",
		entry: { response: { sessionId: "first" } },
	});
	expect(await reopened.begin("second", "second-request")).toMatchObject({
		kind: "replay",
		entry: { response: { sessionId: "second" } },
	});
});
it("quarantines terminal-uncertain replay rows with corrupt response or durable-effect digests", async () => {
	const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-ledger-uncertain-digest-"));
	const ledger = await new LifecycleLedger(dir).open();
	const response = { ok: false, error: { code: "terminal_uncertain" } };
	await ledger.begin("response", "request-response");
	await ledger.transition("response", "terminal_uncertain", { response, responseDigest: "corrupt" });
	await ledger.begin("effects", "request-effects");
	await ledger.transition("effects", "terminal_uncertain", {
		response,
		responseDigest: createHash("sha256").update(JSON.stringify(response)).digest("hex"),
		durableEffects: {
			worktree: { cwdDigest: "worktree", created: true, reused: false },
			digest: "corrupt",
		},
	});

	const reopened = await new LifecycleLedger(dir).open();
	expect((await reopened.begin("response", "request-response")).kind).toBe("terminal_uncertain");
	expect((await reopened.begin("effects", "request-effects")).kind).toBe("terminal_uncertain");
	expect(await fs.readFile(path.join(dir, "sdk", "lifecycle-ledger.jsonl.corrupt"), "utf8")).toContain("corrupt");
});
