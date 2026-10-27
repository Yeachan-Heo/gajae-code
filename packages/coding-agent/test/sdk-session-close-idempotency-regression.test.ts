import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Broker } from "../src/sdk/broker/broker";
import { endpointIncarnation } from "../src/sdk/broker/endpoint-authority";
import { deriveIdempotencyIdentity } from "../src/sdk/broker/identity";
import { LifecycleLedger } from "../src/sdk/broker/lifecycle-ledger";
import { processIncarnation } from "../src/sdk/broker/process-incarnation";

type HostFixture = {
	child: ReturnType<typeof Bun.spawn>;
	authority: { sessionId: string; endpointGeneration: number; endpointIncarnation: string };
};

const brokers: Broker[] = [];
const roots: string[] = [];
const children: Array<ReturnType<typeof Bun.spawn>> = [];

afterEach(async () => {
	for (const child of children.splice(0)) {
		if (child.exitCode === null) child.kill("SIGKILL");
		await child.exited;
	}
	for (const broker of brokers.splice(0)) await broker.stop();
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.filter(key => record[key] !== undefined)
		.sort()
		.map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
		.join(",")}}`;
}

function targetHash(target: Record<string, unknown>): string {
	return createHash("sha256").update(canonicalJson(target)).digest("hex");
}

async function registerHost(
	broker: Broker,
	root: string,
	stateRoot: string,
	sessionId: string,
	endpointGeneration: number,
): Promise<HostFixture> {
	const child = Bun.spawn(["/bin/sleep", "60"], { stdio: ["ignore", "ignore", "ignore"] });
	if (!child.pid) throw new Error("fixture host has no pid");
	children.push(child);
	const processIdentity = processIncarnation(child.pid);
	if (!processIdentity) throw new Error("fixture host has no process incarnation");
	const endpointPath = path.join(stateRoot, "sdk", `${sessionId}.json`);
	await fs.mkdir(path.dirname(endpointPath), { recursive: true });
	await fs.writeFile(
		endpointPath,
		JSON.stringify({ sessionId, pid: child.pid, url: "ws://127.0.0.1:1", token: "fixture" }),
	);
	await fs.utimes(endpointPath, 1_700_000_000 + endpointGeneration, 1_700_000_000 + endpointGeneration);
	const endpointMtimeMs = (await fs.stat(endpointPath)).mtimeMs;
	await broker.index.append({
		type: "host_registered",
		sessionId,
		locator: { cwd: root, worktreeRoot: null, stateRoot },
		endpointGeneration,
		pid: child.pid,
		endpointMtimeMs,
		processIncarnation: processIdentity,
		lifecycleRequestId: `fixture-${sessionId}-${endpointGeneration}`,
	});
	const row = broker.index.listSessions().sessions.find(session => session.sessionId === sessionId);
	if (!row) throw new Error("fixture host was not indexed");
	const incarnation = endpointIncarnation(row, sessionId);
	if (!incarnation) throw new Error("fixture host lacks endpoint authority");
	return { child, authority: { sessionId, endpointGeneration, endpointIncarnation: incarnation } };
}

async function waitForExit(child: ReturnType<typeof Bun.spawn>): Promise<void> {
	await child.exited;
}

test("close does not replay a terminal result across a same-id resumed host generation", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-close-generation-"));
	roots.push(root);
	const agentDir = path.join(root, "agent");
	const stateRoot = path.join(root, ".gjc", "state");
	const sessionId = "resumed-close-generation";
	const broker = new Broker({ agentDir });
	brokers.push(broker);
	await broker.start();

	const first = await registerHost(broker, root, stateRoot, sessionId, 1);
	const closeKey = `sdk:session-cli:session.close:${sessionId}`;
	await expect(broker.handleRequest("session.close", first.authority, closeKey)).resolves.toMatchObject({
		ok: true,
		result: { sessionId },
	});
	await waitForExit(first.child);

	// A resume creates a new live host generation while retaining the session id.
	const second = await registerHost(broker, root, stateRoot, sessionId, 2);
	const secondClose = await broker.handleRequest("session.close", second.authority, closeKey);
	expect(secondClose).toMatchObject({ ok: true, result: { sessionId } });
	await waitForExit(second.child);

	const firstIdentity = await deriveIdempotencyIdentity(
		agentDir,
		"session.close",
		closeKey,
		targetHash(first.authority),
	);
	const secondIdentity = await deriveIdempotencyIdentity(
		agentDir,
		"session.close",
		closeKey,
		targetHash(second.authority),
	);
	const ledger = await new LifecycleLedger(agentDir).open();
	expect(firstIdentity).not.toBe(secondIdentity);
	expect(ledger.get(firstIdentity)?.state).toBe("terminal_ok");
	expect(ledger.get(secondIdentity)?.state).toBe("terminal_ok");
});

test("a terminal close error can be retried for the current authority without replaying the error", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-close-terminal-error-"));
	roots.push(root);
	const agentDir = path.join(root, "agent");
	const stateRoot = path.join(root, ".gjc", "state");
	const sessionId = "terminal-error-close";
	const broker = new Broker({ agentDir });
	brokers.push(broker);
	await broker.start();

	const host = await registerHost(broker, root, stateRoot, sessionId, 1);
	const closeKey = `sdk:session-cli:session.close:${sessionId}`;
	const stale = { ...host.authority, endpointIncarnation: "0".repeat(64) };
	await expect(broker.handleRequest("session.close", stale, closeKey)).resolves.toMatchObject({
		ok: false,
		error: { code: "endpoint_stale" },
	});
	expect(broker.ledger.findAnyByOperationKey(`session.close\0${closeKey}`)).toMatchObject({
		intendedSessionId: "terminal-error-close",
	});
	await expect(broker.handleRequest("session.close", host.authority, closeKey)).resolves.toMatchObject({
		ok: true,
		result: { sessionId },
	});
	await waitForExit(host.child);
});

test("a repeated close for one host generation remains idempotent", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-close-duplicate-"));
	roots.push(root);
	const agentDir = path.join(root, "agent");
	const stateRoot = path.join(root, ".gjc", "state");
	const sessionId = "duplicate-close-generation";
	const broker = new Broker({ agentDir });
	brokers.push(broker);
	await broker.start();

	const host = await registerHost(broker, root, stateRoot, sessionId, 1);
	const closeKey = `sdk:session-cli:session.close:${sessionId}`;
	const first = await broker.handleRequest("session.close", host.authority, closeKey);
	const duplicate = await broker.handleRequest("session.close", host.authority, closeKey);
	expect(first).toMatchObject({ ok: true, result: { sessionId } });
	expect(duplicate).toEqual(first);
	await waitForExit(host.child);
});

test("an explicit close key cannot be reused for a different target authority", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-close-cross-target-"));
	roots.push(root);
	const agentDir = path.join(root, "agent");
	const stateRoot = path.join(root, ".gjc", "state");
	const broker = new Broker({ agentDir });
	brokers.push(broker);
	await broker.start();

	const first = await registerHost(broker, root, stateRoot, "cross-target-first", 1);
	const second = await registerHost(broker, root, stateRoot, "cross-target-second", 1);
	const closeKey = "explicit-cross-target-close-key";
	await expect(broker.handleRequest("session.close", first.authority, closeKey)).resolves.toMatchObject({
		ok: true,
		result: { sessionId: "cross-target-first" },
	});
	await waitForExit(first.child);

	await expect(broker.handleRequest("session.close", second.authority, closeKey)).resolves.toMatchObject({
		ok: false,
		error: { code: "idempotency_conflict" },
	});
});
