import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import * as net from "node:net";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { FinalizeChecks } from "../../src/harness-control-plane/finalize";
import { RuntimeOwner } from "../../src/harness-control-plane/owner";
import {
	RECEIPT_SPOOL_DIR_ENV,
	RECEIPT_SPOOL_FILENAME,
	type ReceiptSpoolRecord,
} from "../../src/harness-control-plane/receipt-spool";
import { type CompletionEvidence, validateReceipt } from "../../src/harness-control-plane/receipts";
import { acquireLease } from "../../src/harness-control-plane/session-lease";
import type { HarnessSessionTransport, SessionStateSnapshot } from "../../src/harness-control-plane/session-transport";
import { controlSocketPath, sessionPaths, writeSessionState } from "../../src/harness-control-plane/storage";
import { SESSION_SCHEMA_VERSION, type SessionHandle, type SessionState } from "../../src/harness-control-plane/types";
import { createHarnessCliEnv, type HarnessCliEnv } from "./cli-workspace-env";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..", "..");
const cliEntry = path.join(repoRoot, "packages", "coding-agent", "src", "cli.ts");
const SID = "o";

class FakeTransport implements HarnessSessionTransport {
	cursor = 0;
	state: SessionStateSnapshot = { isStreaming: false, steeringQueueDepth: 0, followupQueueDepth: 0 };
	async getState(): Promise<SessionStateSnapshot> {
		return this.state;
	}
	eventCursor(): number {
		return this.cursor;
	}
	async sendPrompt(): Promise<{ commandId: string; ack: boolean }> {
		this.cursor += 1; // emit agent_start
		return { commandId: "cmd-1", ack: true };
	}
	async waitForAgentStart(afterCursor: number): Promise<{ cursor: number } | null> {
		return this.cursor > afterCursor ? { cursor: this.cursor } : null;
	}
	async close(): Promise<void> {}
}

let root: string;
let owner: RuntimeOwner | null = null;
let hungServer: net.Server | null = null;
/**
 * Server-side sockets of the degraded-owner fixture. `close()` only resolves
 * once every accepted connection is gone, and a connection this fixture
 * half-closed stays open after the peer goes away.
 */
const hungSockets = new Set<net.Socket>();
let cliEnv: HarnessCliEnv;

function seed(workspace: string): SessionState {
	const now = new Date().toISOString();
	return {
		schemaVersion: SESSION_SCHEMA_VERSION,
		sessionId: SID,
		lifecycle: "started",
		harness: "gajae-code",
		handle: { sessionId: SID, harness: "gajae-code", workspace, branch: "feat/x" } as SessionHandle,
		retries: {},
		blockers: [],
		createdAt: now,
		updatedAt: now,
	};
}

// IMPORTANT: spawn ASYNC. The owner runs in THIS process; a blocking spawnSync would
// freeze the owner's event loop and deadlock the socket round-trip.
async function runHarness(args: string[]): Promise<{ code: number; json: Record<string, unknown> | null }> {
	const proc = Bun.spawn(["bun", cliEntry, "harness", ...args], {
		cwd: root,
		env: { ...cliEnv.env, GJC_HARNESS_STATE_ROOT: root },
		stdout: "pipe",
		stderr: "pipe",
	});
	const out = await new Response(proc.stdout).text();
	const code = await proc.exited;
	let json: Record<string, unknown> | null = null;
	try {
		json = JSON.parse(out.trim()) as Record<string, unknown>;
	} catch {
		json = null;
	}
	return { code, json };
}

const passingFinalizeChecks: FinalizeChecks = {
	async runValidation(spec) {
		return { exactCommand: spec.command, cwd: ".", exitStatus: 0, pass: true };
	},
	async resolveCommit() {
		return "abc123";
	},
	async commitOnBranch() {
		return true;
	},
	async prOrIssue() {
		return { prUrl: "https://x/pr/1", issueArtifact: null };
	},
};

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), "h"));
	cliEnv = createHarnessCliEnv(repoRoot);
	await writeSessionState(root, seed(root));
	owner = new RuntimeOwner({
		root,
		sessionId: SID,
		transport: new FakeTransport(),
		acceptanceTimeoutMs: 200,
		finalizeChecks: passingFinalizeChecks,
		validationCommands: [{ name: "test", command: "bun test" }],
	});
	await owner.start();
});

afterEach(async () => {
	cliEnv.cleanup();
	await owner?.stop();
	for (const socket of hungSockets) socket.destroy();
	hungSockets.clear();
	await new Promise<void>(resolve => hungServer?.close(() => resolve()) ?? resolve());
	hungServer = null;
	await rm(root, { recursive: true, force: true });
});

describe("gjc harness CLI -> live owner routing", () => {
	it("submit routes to the live owner and is accepted via single-flight", async () => {
		const res = await runHarness(["submit", "--session", SID, "--input", JSON.stringify({ prompt: "do it" })]);
		expect(res.code).toBe(0);
		expect(res.json?.ok).toBe(true);
		const evidence = res.json?.evidence as Record<string, unknown>;
		const state = res.json?.state as Record<string, unknown>;
		expect(evidence.accepted).toBe(true);
		expect(state.ownerLive).toBe(true);
		expect(state.lifecycle).toBe("observing");
	}, 30_000);

	it("observe routes to the live owner (ownerRouted + ownerLive)", async () => {
		const res = await runHarness(["observe", "--session", SID]);
		expect(res.code).toBe(0);
		const evidence = res.json?.evidence as Record<string, unknown>;
		const state = res.json?.state as Record<string, unknown>;
		expect(evidence.ownerRouted).toBe(true);
		expect(state.ownerLive).toBe(true);
	}, 30_000);

	it("finalize routes to the live owner and completes the evidence gate", async () => {
		const res = await runHarness(["finalize", "--session", SID, "--input", "{}"]);
		expect(res.code).toBe(0);
		expect(res.json?.ok).toBe(true);
		const evidence = res.json?.evidence as Record<string, unknown>;
		const state = res.json?.state as Record<string, unknown>;
		expect((evidence.finalize as Record<string, unknown>).completed).toBe(true);
		expect(state.lifecycle).toBe("completed");
	}, 30_000);

	async function finalizeFromProject(
		repo: string,
		extra: Record<string, string | undefined> = {},
		input: Record<string, unknown> = {},
	): Promise<{ code: number; json: Record<string, unknown> | null; stderr: string }> {
		const env: Record<string, string> = {};
		for (const [name, value] of Object.entries(cliEnv.env)) {
			if (value !== undefined) env[name] = value;
		}
		delete env.NODE_ENV;
		delete env[RECEIPT_SPOOL_DIR_ENV];
		env.GJC_HARNESS_STATE_ROOT = root;
		for (const [name, value] of Object.entries(extra)) {
			if (value === undefined) delete env[name];
			else env[name] = value;
		}
		const proc = Bun.spawn(
			["bun", cliEntry, "harness", "finalize", "--session", SID, "--input", JSON.stringify(input)],
			{
				cwd: repo,
				env,
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
		const code = await proc.exited;
		let json: Record<string, unknown> | null = null;
		try {
			json = JSON.parse(stdout.trim()) as Record<string, unknown>;
		} catch {
			json = null;
		}
		if (code !== 0 || !json) throw new Error(`harness finalize failed (${code}): ${stderr || stdout}`);
		return { code, json, stderr };
	}

	it("does not forward a project dotenv spool directory to an owner started elsewhere", async () => {
		const repo = await mkdtemp(path.join(tmpdir(), "harness-owner-repo-"));
		const attacker = await mkdtemp(path.join(tmpdir(), "harness-owner-attacker-"));
		try {
			await writeFile(path.join(repo, ".env"), `${RECEIPT_SPOOL_DIR_ENV}=${attacker}\n`);
			const res = await finalizeFromProject(repo);
			expect(res.code).toBe(0);
			expect(res.json?.ok).toBe(true);
			expect(await Bun.file(path.join(attacker, RECEIPT_SPOOL_FILENAME)).exists()).toBe(false);
		} finally {
			await rm(repo, { recursive: true, force: true });
			await rm(attacker, { recursive: true, force: true });
		}
	}, 30_000);

	it("does not forward a project dotenv spool directory supplied in the command input", async () => {
		const repo = await mkdtemp(path.join(tmpdir(), "harness-owner-repo-"));
		const attacker = await mkdtemp(path.join(tmpdir(), "harness-owner-attacker-"));
		try {
			await writeFile(path.join(repo, ".env"), `${RECEIPT_SPOOL_DIR_ENV}=${attacker}\n`);
			const res = await finalizeFromProject(repo, {}, { [RECEIPT_SPOOL_DIR_ENV]: attacker });
			expect(res.code).toBe(0);
			expect(res.json?.ok).toBe(true);
			expect(await Bun.file(path.join(attacker, RECEIPT_SPOOL_FILENAME)).exists()).toBe(false);
		} finally {
			await rm(repo, { recursive: true, force: true });
			await rm(attacker, { recursive: true, force: true });
		}
	}, 30_000);

	it("keeps an explicit spool directory when the project declares none", async () => {
		const repo = await mkdtemp(path.join(tmpdir(), "harness-owner-repo-"));
		const operator = await mkdtemp(path.join(tmpdir(), "harness-owner-operator-"));
		try {
			const res = await finalizeFromProject(repo, {}, { [RECEIPT_SPOOL_DIR_ENV]: operator });
			expect(res.code).toBe(0);
			expect(res.json?.ok).toBe(true);
			expect(await Bun.file(path.join(operator, RECEIPT_SPOOL_FILENAME)).exists()).toBe(true);
		} finally {
			await rm(repo, { recursive: true, force: true });
			await rm(operator, { recursive: true, force: true });
		}
	}, 30_000);

	it("uses an explicit spool directory instead of a project dotenv value", async () => {
		const repo = await mkdtemp(path.join(tmpdir(), "harness-owner-repo-"));
		const attacker = await mkdtemp(path.join(tmpdir(), "harness-owner-attacker-"));
		const operator = await mkdtemp(path.join(tmpdir(), "harness-owner-operator-"));
		try {
			await writeFile(path.join(repo, ".env"), `${RECEIPT_SPOOL_DIR_ENV}=${attacker}\n`);
			const res = await finalizeFromProject(repo, {}, { [RECEIPT_SPOOL_DIR_ENV]: operator });
			expect(res.code).toBe(0);
			expect(res.json?.ok).toBe(true);
			expect(await Bun.file(path.join(operator, RECEIPT_SPOOL_FILENAME)).exists()).toBe(true);
			expect(await Bun.file(path.join(attacker, RECEIPT_SPOOL_FILENAME)).exists()).toBe(false);
		} finally {
			await rm(repo, { recursive: true, force: true });
			await rm(attacker, { recursive: true, force: true });
			await rm(operator, { recursive: true, force: true });
		}
	}, 30_000);

	it("keeps a shell spool directory for an owner started outside the project", async () => {
		const repo = await mkdtemp(path.join(tmpdir(), "harness-owner-repo-"));
		const attacker = await mkdtemp(path.join(tmpdir(), "harness-owner-attacker-"));
		const operator = await mkdtemp(path.join(tmpdir(), "harness-owner-operator-"));
		try {
			await writeFile(path.join(repo, ".env"), `${RECEIPT_SPOOL_DIR_ENV}=${attacker}\n`);
			const res = await finalizeFromProject(repo, { [RECEIPT_SPOOL_DIR_ENV]: operator });
			expect(res.code).toBe(0);
			expect(res.json?.ok).toBe(true);
			expect(await Bun.file(path.join(operator, RECEIPT_SPOOL_FILENAME)).exists()).toBe(true);
			expect(await Bun.file(path.join(attacker, RECEIPT_SPOOL_FILENAME)).exists()).toBe(false);
		} finally {
			await rm(repo, { recursive: true, force: true });
			await rm(attacker, { recursive: true, force: true });
			await rm(operator, { recursive: true, force: true });
		}
	}, 30_000);

	it("passes --receipt-spool-dir through live owner routing", async () => {
		const spoolDir = await mkdtemp(path.join(tmpdir(), "harness-owner-spool-"));
		try {
			const res = await runHarness(["finalize", "--session", SID, "--receipt-spool-dir", spoolDir, "--input", "{}"]);
			expect(res.code).toBe(0);
			expect(res.json?.ok).toBe(true);

			const raw = await Bun.file(path.join(spoolDir, RECEIPT_SPOOL_FILENAME)).text();
			const records = raw
				.trim()
				.split("\n")
				.map(line => JSON.parse(line) as ReceiptSpoolRecord);
			expect(records.map(record => record.cursor)).toEqual(["000000000001", "000000000002"]);
			expect(records.map(record => record.envelope.family)).toEqual(["validation", "completion"]);
			expect(records.every(record => validateReceipt(record.envelope).valid)).toBe(true);
			expect((records.at(-1)?.envelope.evidence as CompletionEvidence).finalLifecycle).toBe("completed");
		} finally {
			await rm(spoolDir, { recursive: true, force: true });
		}
	}, 30_000);

	it("falls back to bounded observe when a live owner endpoint accepts but never responds", async () => {
		await owner?.stop();
		owner = null;
		const socketPath = controlSocketPath(root, SID);
		hungServer = net.createServer(socket => {
			hungSockets.add(socket);
			socket.on("data", () => {});
		});
		await new Promise<void>((resolve, reject) => {
			hungServer?.once("error", reject);
			hungServer?.listen(socketPath, () => {
				hungServer?.removeListener("error", reject);
				resolve();
			});
		});
		await acquireLease(root, SID, {
			ownerId: "hung-owner",
			pid: process.pid,
			endpoint: { kind: "unix-socket", path: socketPath },
			eventsPath: sessionPaths(root, SID).events,
			ttlMs: 30_000,
		});

		const res = await runHarness(["observe", "--session", SID]);

		expect(res.code).toBe(0);
		expect(res.json?.ok).toBe(true);
		expect(res.json).toHaveProperty("state");
		expect(res.json).toHaveProperty("evidence");
		expect(res.json).toHaveProperty("nextAllowedActions");
		expect((res.json?.state as Record<string, unknown>).ownerLive).toBe(false);
		expect((res.json?.evidence as Record<string, unknown>).ownerRouted).toBeUndefined();
	}, 10_000);

	it("does not accept or advertise submit when the owner endpoint degrades", async () => {
		await owner?.stop();
		owner = null;
		const socketPath = controlSocketPath(root, SID);
		hungServer = net.createServer(socket => {
			hungSockets.add(socket);
			socket.end("not-json\n");
		});
		await new Promise<void>((resolve, reject) => {
			hungServer?.once("error", reject);
			hungServer?.listen(socketPath, () => {
				hungServer?.removeListener("error", reject);
				resolve();
			});
		});
		await acquireLease(root, SID, {
			ownerId: "bad-frame-owner",
			pid: process.pid,
			endpoint: { kind: "unix-socket", path: socketPath },
			eventsPath: sessionPaths(root, SID).events,
			ttlMs: 30_000,
		});

		const res = await runHarness(["submit", "--session", SID, "--input", JSON.stringify({ prompt: "do it" })]);

		expect(res.code).toBe(1);
		expect(res.json?.ok).toBe(false);
		expect((res.json?.state as Record<string, unknown>).ownerLive).toBe(false);
		expect((res.json?.evidence as Record<string, unknown>).accepted).toBe(false);
		expect((res.json?.evidence as Record<string, unknown>).submitted).toBe(false);
		expect((res.json?.evidence as Record<string, unknown>).reason).toBe("owner-not-live");
		expect(res.json?.nextAllowedActions).toContainEqual({
			verb: "submit",
			available: false,
			reason: "owner-not-live",
		});
	}, 10_000);
});
