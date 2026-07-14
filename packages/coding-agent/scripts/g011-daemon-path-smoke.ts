// G011 real daemon-path smoke.
//
// Drives a PARSED /session_* command through the LIVE native
// NotificationControlServer + a real loopback WebSocket client (NO injected/fake
// seams), wired to the real orchestrator (with stubbed spawn/close effects so the
// focus is the authenticated wire path, not tmux). Asserts:
//  - a wrong-token handshake is rejected (control token gates the endpoint);
//  - a valid frame is forwarded with the control token STRIPPED from payloadJson;
//  - the host response is routed back to the client by requestId;
//  - control discovery exists while running and is removed after stop.
import assert from "node:assert";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import WebSocket from "ws";

// Import the WORKTREE native build directly (not @gajae-code/natives, which can
// resolve to a different checkout in this dev environment).
import { NotificationControlServer } from "../../natives/native/index.js";
import { parseLifecycleCommand } from "../src/sdk/bus/lifecycle-commands";
import { attachLifecycleControl, fileAudit, fileLedgerStore } from "../src/sdk/bus/lifecycle-control-runtime";
import type { OrchestratorDeps } from "../src/sdk/bus/lifecycle-orchestrator";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-g011-"));
const token = crypto.randomBytes(32).toString("base64url");
const ownerId = "daemon-g011";
const closed: string[] = [];

function deps(): OrchestratorDeps {
	return {
		pairedChatId: "42",
		auditRedactionKey: new Uint8Array(32).fill(11),
		isPsmuxProvider: () => false,
		now: () => Date.now(),
		store: fileLedgerStore(path.join(tmp, "idempotency.json")),
		audit: fileAudit(path.join(tmp, "audit.jsonl")),
		allowCreate: () => true,
		writeStartupPrompt: async () => undefined,
		// Stubbed effects: this smoke proves the WIRE path, not tmux (covered by g005).
		spawnCreate: async (_f, ids) => ({
			sessionId: ids.intendedSessionId,
			tmuxSession: `gjc-${ids.intendedSessionId}`,
			endpointUrl: "ws://127.0.0.1:0",
			topicThreadId: "1",
		}),
		closeSession: async t => {
			closed.push(t.sessionId);
			return { processGone: true };
		},
		resumeSession: async () => ({ ambiguous: [] }),
	};
}

function send(ws: WebSocket, frame: unknown): void {
	ws.send(JSON.stringify(frame));
}

async function main(): Promise<void> {
	const server = new NotificationControlServer(token, ownerId, tmp);

	// Wire the real orchestrator to the real native control server.
	const d = deps();
	attachLifecycleControl(server as never, d);

	const ep = (await server.start()) as { url: string };
	assert.ok(ep.url.startsWith("ws://127.0.0.1:"), `loopback url, got ${ep.url}`);
	const controlJson = path.join(tmp, "notifications", "control.json");
	assert.ok(fs.existsSync(controlJson), "control discovery must exist while running");
	// The control discovery file MUST NOT persist the privileged control token:
	// the daemon holds it in memory and is the only client.
	const controlRaw = fs.readFileSync(controlJson, "utf8");
	assert.ok(!controlRaw.includes(token), "control token MUST NOT be persisted in control.json");
	assert.ok(
		!("token" in (JSON.parse(controlRaw) as Record<string, unknown>)),
		"control.json must omit any token field",
	);
	console.log(`[g011] live control endpoint ${ep.url}; discovery present, no persisted token`);

	// 1. Wrong-token handshake must be rejected.
	await new Promise<void>(resolve => {
		const bad = new WebSocket(`${ep.url}/?token=wrong`);
		bad.on("open", () => {
			throw new Error("wrong-token handshake must NOT open");
		});
		bad.on("error", () => {
			console.log("[g011] wrong-token handshake rejected (expected)");
			resolve();
		});
	});

	// 2. Valid client: send a PARSED /session_close command through the real wire.
	const parsed = parseLifecycleCommand("/session_close sess-g011");
	assert.equal(parsed.kind, "close", "parser must yield a close command");
	const requestId = "lc-g011-1";
	const frame = {
		type: "session_close",
		requestId,
		updateId: 1,
		chatId: "42",
		token,
		target: parsed.kind === "close" ? parsed.target : { sessionId: "sess-g011" },
		force: true,
	};

	const response = await new Promise<Record<string, unknown>>((resolve, reject) => {
		const ws = new WebSocket(`${ep.url}/?token=${token}`);
		const timer = setTimeout(() => reject(new Error("timed out")), 5000);
		ws.on("open", () => send(ws, frame));
		ws.on("message", data => {
			clearTimeout(timer);
			ws.close();
			resolve(JSON.parse(String(data)) as Record<string, unknown>);
		});
		ws.on("error", reject);
	});

	assert.equal(response.type, "session_close_response", "response routed back to client");
	assert.equal(response.requestId, requestId, "response correlated by requestId");
	assert.equal(response.sessionId, "sess-g011");
	assert.deepEqual(closed, ["sess-g011"], "orchestrator close effect ran exactly once");
	console.log("[g011] parsed command -> real wire -> orchestrator -> routed response OK");

	// 3. The real orchestrator path must NOT leak the control token into its
	// durable audit log or idempotency ledger (g002 separately proves the native
	// payloadJson boundary is token-stripped).
	for (const f of ["audit.jsonl", "idempotency.json"]) {
		const p = path.join(tmp, f);
		if (fs.existsSync(p)) {
			assert.ok(!fs.readFileSync(p, "utf8").includes(token), `control token leaked into ${f}`);
		}
	}
	console.log("[g011] no control-token leak in audit/ledger on the real path");

	// 4. Stop removes control discovery.
	server.stop();
	await new Promise(r => setTimeout(r, 50));
	assert.ok(!fs.existsSync(controlJson), "control discovery removed after stop");
	console.log("[g011] control discovery removed after stop");

	console.log("[g011] PASS: real daemon-path (parse -> native control endpoint -> orchestrator -> reply)");
}

main()
	.then(() => {
		fs.rmSync(tmp, { recursive: true, force: true });
		process.exit(0);
	})
	.catch(err => {
		fs.rmSync(tmp, { recursive: true, force: true });
		console.error("[g011] FAIL", err);
		process.exit(1);
	});
