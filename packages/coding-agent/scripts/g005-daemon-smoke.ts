// G005 real end-to-end daemon-orchestration smoke.
//
// Drives the lifecycle orchestrator's create -> close path with REAL effects:
// a real fsynced file-backed idempotency ledger, a real audit JSONL, and a real
// tmux session spawned/closed via the actual tmux helpers. Proves the daemon
// orchestration turns a `session_create` frame into a genuinely-spawned,
// GJC-tagged tmux session and a `session_close` frame into a real hard-close,
// with idempotent re-ack. Not part of the unit suite.
import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	buildGjcTmuxExactOptionTarget,
	buildGjcTmuxProfileCommands,
	resolveGjcTmuxCommand,
} from "../src/gjc-runtime/tmux-common";
import { forceCloseGjcTmuxSession, statusGjcTmuxSession } from "../src/gjc-runtime/tmux-sessions";
import type { SessionCloseFrame, SessionCreateFrame } from "../src/sdk/bus/index";
import {
	type AuditEvent,
	handleLifecycleRequest,
	type LedgerDoc,
	type LedgerStore,
	type OrchestratorDeps,
} from "../src/sdk/bus/lifecycle-orchestrator";

const tmux = resolveGjcTmuxCommand(process.env);
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-g005-"));
const ledgerPath = path.join(tmpRoot, "idempotency.json");
const auditPath = path.join(tmpRoot, "audit.jsonl");
const created: string[] = [];

function sh(args: string[]): number {
	return Bun.spawnSync([tmux, ...args], { stdout: "pipe", stderr: "pipe" }).exitCode;
}
function exists(name: string): boolean {
	return sh(["has-session", "-t", `=${name}`]) === 0;
}

// Real fsynced + atomic file ledger store.
const store: LedgerStore = {
	async read(): Promise<LedgerDoc> {
		try {
			return JSON.parse(fs.readFileSync(ledgerPath, "utf8")) as LedgerDoc;
		} catch {
			return { version: 1, entries: {} };
		}
	},
	async write(doc: LedgerDoc): Promise<void> {
		const tmp = `${ledgerPath}.${process.pid}.tmp`;
		const fd = fs.openSync(tmp, "w", 0o600);
		fs.writeSync(fd, JSON.stringify(doc));
		fs.fsyncSync(fd);
		fs.closeSync(fd);
		fs.renameSync(tmp, ledgerPath);
	},
};

const auditLines: AuditEvent[] = [];
const deps: OrchestratorDeps = {
	pairedChatId: "42",
	auditRedactionKey: new Uint8Array(32).fill(5),
	isPsmuxProvider: () => false,
	now: () => Date.now(),
	store,
	audit: e => {
		auditLines.push(e);
		fs.appendFileSync(auditPath, `${JSON.stringify(e)}\n`, { mode: 0o600 });
	},
	allowCreate: () => true,
	writeStartupPrompt: async (requestId, prompt) => {
		if (prompt === undefined) return undefined;
		const ref = path.join(tmpRoot, `prompt-${requestId}`);
		const fd = fs.openSync(ref, "w", 0o600);
		fs.writeSync(fd, prompt);
		fs.fsyncSync(fd);
		fs.closeSync(fd);
		return ref;
	},
	// REAL spawn: create a GJC-tagged tmux session carrying the authoritative id.
	spawnCreate: async (_frame, ids) => {
		const name = `gjc_g005_${ids.intendedSessionId}`;
		created.push(name);
		if (sh(["new-session", "-d", "-s", name, "sleep 600"]) !== 0) {
			throw new Error(`tmux spawn failed for ${name}`);
		}
		const target = buildGjcTmuxExactOptionTarget(name);
		for (const cmd of buildGjcTmuxProfileCommands(target, process.env, {
			sessionId: ids.intendedSessionId,
		})) {
			if (sh(cmd.args) !== 0) throw new Error(`tag failed for ${name}`);
		}
		return {
			sessionId: ids.intendedSessionId,
			tmuxSession: name,
			endpointUrl: "ws://127.0.0.1:0",
			topicThreadId: "1",
		};
	},
	// REAL close: hard-close the GJC-managed tmux session, id-matched.
	closeSession: async target => {
		forceCloseGjcTmuxSession(target.tmuxSession ?? "", process.env, target.sessionId);
		return { processGone: !exists(target.tmuxSession ?? "") };
	},
	resumeSession: async () => ({ ambiguous: [] }),
};

const createFrame: SessionCreateFrame = {
	type: "session_create",
	requestId: "lc_g005",
	lifecycleRequestId: "lc_g005",
	intendedSessionId: `g005${Date.now().toString(36)}`,
	updateId: 100,
	chatId: "42",
	token: "control-token",
	target: { kind: "existing_path", path: tmpRoot },
};

async function main(): Promise<void> {
	// 1. CREATE -> real tmux session spawned + GJC-tagged with the authoritative id.
	const createOut = await handleLifecycleRequest(createFrame, deps);
	assert.equal(createOut.status, "ok", "create must succeed");
	const session = createOut.status === "ok" ? createOut.entry.tmuxSession! : "";
	assert.ok(exists(session), "real tmux session must exist after create");
	const status = statusGjcTmuxSession(session);
	assert.equal(status.profile, "1", "spawned session must be GJC-managed");
	assert.equal(status.sessionId, createFrame.intendedSessionId, "authoritative session id propagated to tmux tag");
	console.log(`[g005] CREATE -> live tmux session ${session} (id=${status.sessionId})`);

	// 2. Idempotent re-ack: same updateId+body must NOT spawn a second session.
	const before = created.length;
	const dupOut = await handleLifecycleRequest(createFrame, deps);
	assert.equal(dupOut.status, "ok", "duplicate create re-acks ok");
	assert.equal(created.length, before, "duplicate create must NOT spawn a second session");
	console.log("[g005] DUPLICATE create re-acked, no second spawn (idempotent)");

	// 3. CLOSE -> real hard-close of the GJC-managed session, id-matched.
	const closeFrame: SessionCloseFrame = {
		type: "session_close",
		requestId: "lc_g005_close",
		updateId: 101,
		chatId: "42",
		token: "control-token",
		target: { sessionId: createFrame.intendedSessionId, tmuxSession: session },
		force: true,
	};
	const closeOut = await handleLifecycleRequest(closeFrame, deps);
	assert.equal(closeOut.status, "ok", "close must succeed");
	assert.ok(!exists(session), "real tmux session must be gone after close");
	console.log(`[g005] CLOSE -> hard-closed ${session} (id-matched)`);

	// 4. Durable ledger + audit redaction.
	const doc = JSON.parse(fs.readFileSync(ledgerPath, "utf8")) as LedgerDoc;
	assert.equal(doc.entries["42:100"]?.state, "success");
	assert.equal(doc.entries["42:101"]?.state, "success");
	const auditBlob = fs.readFileSync(auditPath, "utf8");
	assert.ok(!auditBlob.includes("control-token"), "audit must never contain the control token");
	assert.ok(
		auditLines.some(a => a.event === "spawn_started"),
		"audit records spawn_started",
	);
	console.log("[g005] durable fsynced ledger + token-redacted audit verified");

	console.log("[g005] PASS: real create->close daemon orchestration over live tmux");
}

main()
	.then(() => {
		for (const n of created) sh(["kill-session", "-t", `=${n}`]);
		fs.rmSync(tmpRoot, { recursive: true, force: true });
		process.exit(0);
	})
	.catch(err => {
		for (const n of created) sh(["kill-session", "-t", `=${n}`]);
		fs.rmSync(tmpRoot, { recursive: true, force: true });
		console.error("[g005] FAIL", err);
		process.exit(1);
	});
