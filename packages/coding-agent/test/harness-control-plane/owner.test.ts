import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { callEndpoint } from "../../src/harness-control-plane/control-endpoint";
import { RuntimeOwner, resolveOwner } from "../../src/harness-control-plane/owner";
import type { HarnessRpc, RpcStateSnapshot } from "../../src/harness-control-plane/rpc-adapter";
import { readEvents, writeSessionState } from "../../src/harness-control-plane/storage";
import { SESSION_SCHEMA_VERSION, type SessionHandle, type SessionState } from "../../src/harness-control-plane/types";

class FakeRpc implements HarnessRpc {
	cursor = 0;
	state: RpcStateSnapshot = { isStreaming: false, steeringQueueDepth: 0, followupQueueDepth: 0 };
	ack = true;
	accept = true;
	agentStarts: number[] = [];
	async getState(): Promise<RpcStateSnapshot> {
		return this.state;
	}
	eventCursor(): number {
		return this.cursor;
	}
	async sendPrompt(): Promise<{ commandId: string; ack: boolean }> {
		if (this.accept) {
			this.cursor += 1;
			this.agentStarts.push(this.cursor);
		}
		return { commandId: "cmd-1", ack: this.ack };
	}
	async waitForAgentStart(afterCursor: number): Promise<{ cursor: number } | null> {
		const found = this.agentStarts.find(c => c > afterCursor);
		return found === undefined ? null : { cursor: found };
	}
	async close(): Promise<void> {}
}

let root: string;
const SID = "o";
let owner: RuntimeOwner | null = null;

function seedState(workspace: string): SessionState {
	const now = new Date().toISOString();
	const handle = { sessionId: SID, harness: "gajae-code", workspace, branch: "feat/x" } as SessionHandle;
	return {
		schemaVersion: SESSION_SCHEMA_VERSION,
		sessionId: SID,
		lifecycle: "started",
		harness: "gajae-code",
		handle,
		retries: {},
		blockers: [],
		createdAt: now,
		updatedAt: now,
	};
}

beforeEach(async () => {
	// Short root keeps the AF_UNIX socket path under the sun_path limit.
	root = await mkdtemp(path.join(tmpdir(), "h"));
	await writeSessionState(root, seedState(root));
	owner = null;
});

afterEach(async () => {
	await owner?.stop();
	await rm(root, { recursive: true, force: true });
});

describe("RuntimeOwner (in-process integration)", () => {
	it("routes submit through the endpoint, accepts via single-flight, and is the single event writer", async () => {
		const rpc = new FakeRpc();
		owner = new RuntimeOwner({ root, sessionId: SID, rpc, acceptanceTimeoutMs: 200 });
		const info = await owner.start();
		expect(info.leaseEpoch).toBe(1);

		const live = await resolveOwner(root, SID);
		expect(live.live).toBe(true);
		expect(live.socketPath).toBe(info.socketPath);

		const res = (await callEndpoint(info.socketPath, { verb: "submit", input: { prompt: "do it" } })) as Record<
			string,
			unknown
		>;
		expect(res.ok).toBe(true);
		expect((res.evidence as Record<string, unknown>).accepted).toBe(true);
		expect((res.state as Record<string, unknown>).lifecycle).toBe("observing");
		expect((res.state as Record<string, unknown>).ownerLive).toBe(true);

		const events = await readEvents(root, SID, 0);
		const kinds = events.map(e => e.kind);
		expect(kinds).toContain("owner_started");
		expect(kinds).toContain("prompt_accepted");
		// Single writer: every event is stamped with this owner + lease epoch, cursors strictly increasing.
		for (const e of events) {
			expect(e.writer.ownerId).toBe(info.ownerId);
			expect(e.writer.leaseEpoch).toBe(1);
		}
		expect(events.map(e => e.cursor)).toEqual([...events.map(e => e.cursor)].sort((a, b) => a - b));
	});

	it("blocks submit when the harness acks but never starts (no false-positive acceptance)", async () => {
		const rpc = new FakeRpc();
		rpc.accept = false; // ack only, no agent_start
		owner = new RuntimeOwner({ root, sessionId: SID, rpc, acceptanceTimeoutMs: 100 });
		const info = await owner.start();
		const res = (await callEndpoint(info.socketPath, { verb: "submit", input: { prompt: "p" } })) as Record<
			string,
			unknown
		>;
		expect(res.ok).toBe(false);
		expect((res.evidence as Record<string, unknown>).accepted).toBe(false);
		expect((res.evidence as Record<string, unknown>).reason).toBe("no-agent-start-within-timeout");
		const events = await readEvents(root, SID, 0);
		expect(events.map(e => e.kind)).toContain("prompt_not_accepted");
		const warn = events.find(e => e.kind === "prompt_not_accepted");
		expect(warn?.severity).toBe("warn");
	});

	it("observe is owner-routed and reports ownerLive; retire releases the lease", async () => {
		const rpc = new FakeRpc();
		owner = new RuntimeOwner({ root, sessionId: SID, rpc, acceptanceTimeoutMs: 200 });
		const info = await owner.start();

		const obs = (await callEndpoint(info.socketPath, { verb: "observe", input: {} })) as Record<string, unknown>;
		expect((obs.evidence as Record<string, unknown>).ownerRouted).toBe(true);
		expect((obs.state as Record<string, unknown>).ownerLive).toBe(true);

		const ret = (await callEndpoint(info.socketPath, { verb: "retire", input: {} })) as Record<string, unknown>;
		expect((ret.evidence as Record<string, unknown>).retired).toBe(true);

		// Poll for the owner to release the lease + close the endpoint (robust under load).
		let after = await resolveOwner(root, SID);
		for (let i = 0; i < 100 && after.live; i++) {
			await new Promise(r => setTimeout(r, 20));
			after = await resolveOwner(root, SID);
		}
		expect(after.live).toBe(false);
	});
});
