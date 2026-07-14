import { describe, expect, it, test } from "bun:test";
import * as fs from "node:fs/promises";
import path from "node:path";
import { Broker } from "../src/sdk/broker/broker";
import { LifecycleLedger } from "../src/sdk/broker/lifecycle-ledger";
import { SessionManager } from "../src/session/session-manager";

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
	it("lets a later valid terminal row supersede earlier corruption", async () => {
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
				ts: Date.now(),
			})}\n`,
		);

		const resumed = await new LifecycleLedger(dir).open();
		expect((await resumed.begin("i", "a")).kind).toBe("replay");
		expect(resumed.get("i")?.state).toBe("terminal_ok");
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
});
test("restart seals awaiting_ready as terminal_uncertain", async () => {
	const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-ledger-awaiting-ready-"));
	const ledger = await new LifecycleLedger(dir).open();
	await ledger.begin("awaiting", "request");
	await ledger.transition("awaiting", "effect_started", {
		intendedSessionId: "session",
		effectMarker: "effect",
	});
	await ledger.transition("awaiting", "awaiting_ready");
	const restarted = await new LifecycleLedger(dir).open();
	expect((await restarted.begin("awaiting", "request")).kind).toBe("terminal_uncertain");
	expect(restarted.get("awaiting")?.state).toBe("terminal_uncertain");
});

const workspaceGrantOf = async (broker: Broker, cwd: string) => {
	const response = await broker.handleRequest("session.list", {
		brokerOwnerId: broker.ownerId,
		cwd,
	});
	if (!response.ok) throw new Error("Expected workspace grant issuance.");
	const result = response.result as {
		workspaceGrantId?: unknown;
		workspaceIdentity?: unknown;
	};
	if (typeof result.workspaceGrantId !== "string" || typeof result.workspaceIdentity !== "object")
		throw new Error("Workspace grant response is incomplete.");
	return {
		workspaceGrantId: result.workspaceGrantId,
		workspaceIdentity: result.workspaceIdentity,
	};
};

test("owner rotation does not make a durable lifecycle idempotency row unreachable", async () => {
	const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-owner-rotation-"));
	const workspace = path.join(dir, "workspace");
	const transcriptPath = path.join(workspace, "saved.jsonl");
	await fs.mkdir(workspace, { recursive: true });
	const baseInput = {
		sessionId: "saved",
		sessionPath: transcriptPath,
		sessionIdentity: { dev: "1", ino: "2", size: 3, mtimeMs: 4, mtimeNs: "5", sha256: "0".repeat(64) },
		cwd: workspace,
		target: { path: workspace },
	};

	const brokerOne = new Broker({ agentDir: dir });
	await Promise.all([brokerOne.index.open(), brokerOne.ledger.open()]);
	const ownerOne = brokerOne.ownerId;
	const grantOne = await workspaceGrantOf(brokerOne, workspace);
	const first = await brokerOne.handleRequest(
		"session.delete",
		{ ...baseInput, ...grantOne, brokerOwnerId: ownerOne },
		"rotate-key",
	);
	await brokerOne.stop();

	// A fresh broker boot mints a new owner proof; only brokerOwnerId differs.
	const brokerTwo = new Broker({ agentDir: dir });
	await Promise.all([brokerTwo.index.open(), brokerTwo.ledger.open()]);
	const ownerTwo = brokerTwo.ownerId;
	expect(ownerTwo).not.toBe(ownerOne);
	const grantTwo = await workspaceGrantOf(brokerTwo, workspace);
	const retried = await brokerTwo.handleRequest(
		"session.delete",
		{ ...baseInput, ...grantTwo, brokerOwnerId: ownerTwo },
		"rotate-key",
	);
	await brokerTwo.stop();

	// Same semantic request, different owner, same durable row -> replayed verbatim.
	expect(retried).toEqual(first);
	const entries = (await fs.readFile(path.join(dir, "sdk", "lifecycle-ledger.jsonl"), "utf8"))
		.split("\n")
		.filter(Boolean);
	// The retried request replayed the terminal row instead of appending a new attempt.
	expect(entries.filter(line => JSON.parse(line).state === "accepted")).toHaveLength(1);
});

test("production broker retries an accepted row after owner and grant rotation", async () => {
	const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-owner-accepted-retry-"));
	const workspace = path.join(dir, "workspace");
	await fs.mkdir(workspace, { recursive: true });
	const request = {
		sessionId: "missing",
		sessionPath: path.join(workspace, "missing.jsonl"),
		cwd: workspace,
		target: { path: workspace },
	};
	const brokerOne = new Broker({ agentDir: dir });
	await Promise.all([brokerOne.index.open(), brokerOne.ledger.open()]);
	const grantOne = await workspaceGrantOf(brokerOne, workspace);
	const originalBegin = brokerOne.ledger.begin.bind(brokerOne.ledger);
	let interrupted = false;
	brokerOne.ledger.begin = async (identity, requestHash) => {
		const begun = await originalBegin(identity, requestHash);
		if (!interrupted) {
			interrupted = true;
			throw new Error("simulated broker crash after accepted");
		}
		return begun;
	};
	await expect(
		brokerOne.handleRequest(
			"session.delete",
			{ ...request, ...grantOne, brokerOwnerId: brokerOne.ownerId },
			"accepted-retry-key",
		),
	).rejects.toThrow("simulated broker crash");
	await brokerOne.stop();

	const brokerTwo = new Broker({ agentDir: dir });
	await Promise.all([brokerTwo.index.open(), brokerTwo.ledger.open()]);
	const grantTwo = await workspaceGrantOf(brokerTwo, workspace);
	const retried = await brokerTwo.handleRequest(
		"session.delete",
		{ ...request, ...grantTwo, brokerOwnerId: brokerTwo.ownerId },
		"accepted-retry-key",
	);
	expect(retried).toMatchObject({ ok: false, error: { code: "invalid_input" } });
	await brokerTwo.stop();

	const entries = (await fs.readFile(path.join(dir, "sdk", "lifecycle-ledger.jsonl"), "utf8"))
		.split("\n")
		.filter(Boolean)
		.map(line => JSON.parse(line));
	expect(entries.filter(entry => entry.state === "accepted")).toHaveLength(1);
	expect(entries.at(-1)?.state).toBe("terminal_error");
});

test("production broker retry reaches effect_started uncertainty after owner and grant rotation", async () => {
	const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-owner-effect-retry-"));
	const workspace = path.join(dir, "workspace");
	await fs.mkdir(workspace, { recursive: true });
	const session = SessionManager.create(workspace, SessionManager.getDefaultSessionDir(workspace, dir));
	await session.ensureOnDisk();
	const sessionId = session.getSessionId();
	const sessionPath = session.getSessionFile();
	if (!sessionPath) throw new Error("Expected saved session transcript.");
	await session.close();
	const captured = SessionManager.captureTranscriptStrict(sessionPath);
	if (captured.kind !== "captured") throw new Error("Expected strict transcript capture.");
	const identity = captured.snapshot.identity;
	const request = {
		sessionId,
		sessionPath,
		sessionIdentity: {
			dev: identity.dev.toString(),
			ino: identity.ino.toString(),
			size: identity.size,
			mtimeMs: identity.mtimeMs,
			mtimeNs: identity.mtimeNs.toString(),
			sha256: identity.sha256,
		},
		cwd: workspace,
		target: { path: workspace },
	};

	const brokerOne = new Broker({ agentDir: dir });
	await Promise.all([brokerOne.index.open(), brokerOne.ledger.open()]);
	const grantOne = await workspaceGrantOf(brokerOne, workspace);
	const originalTransition = brokerOne.ledger.transition.bind(brokerOne.ledger);
	brokerOne.ledger.transition = async (ledgerIdentity, state, fields) => {
		const transitioned = await originalTransition(ledgerIdentity, state, fields);
		if (state === "effect_started") throw new Error("simulated broker crash after effect_started");
		return transitioned;
	};
	await expect(
		brokerOne.handleRequest(
			"session.delete",
			{ ...request, ...grantOne, brokerOwnerId: brokerOne.ownerId },
			"effect-retry-key",
		),
	).rejects.toThrow("simulated broker crash");
	expect(JSON.parse((await fs.readFile(sessionPath, "utf8")).split("\n")[0]!).type).toBe("session");
	await brokerOne.stop();

	const brokerTwo = new Broker({ agentDir: dir });
	await Promise.all([brokerTwo.index.open(), brokerTwo.ledger.open()]);
	const grantTwo = await workspaceGrantOf(brokerTwo, workspace);
	const retried = await brokerTwo.handleRequest(
		"session.delete",
		{ ...request, ...grantTwo, brokerOwnerId: brokerTwo.ownerId },
		"effect-retry-key",
	);
	expect(retried).toEqual({
		ok: false,
		error: { code: "terminal_uncertain", message: "prior lifecycle operation outcome is uncertain" },
	});
	expect(JSON.parse((await fs.readFile(sessionPath, "utf8")).split("\n")[0]!).type).toBe("session");
	await brokerTwo.stop();
});
