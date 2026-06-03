import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { callEndpoint } from "../../src/harness-control-plane/control-endpoint";
import { RuntimeOwner } from "../../src/harness-control-plane/owner";
import type { HarnessRpc, RpcStateSnapshot } from "../../src/harness-control-plane/rpc-adapter";
import { readEvents, writeSessionState } from "../../src/harness-control-plane/storage";
import { SESSION_SCHEMA_VERSION, type SessionHandle, type SessionState } from "../../src/harness-control-plane/types";

/** In-process RPC that lets a test push event frames through the owner's onEventFrame path. */
class FrameRpc implements HarnessRpc {
	cursor = 0;
	live = true;
	#cb: ((frame: Record<string, unknown>) => void) | null = null;
	#lastAt: string | null = null;
	async getState(): Promise<RpcStateSnapshot> {
		return { isStreaming: false, steeringQueueDepth: 0, followupQueueDepth: 0 };
	}
	eventCursor(): number {
		return this.cursor;
	}
	async sendPrompt(): Promise<{ commandId: string; ack: boolean }> {
		return { commandId: "c", ack: true };
	}
	async waitForAgentStart(): Promise<{ cursor: number } | null> {
		return null;
	}
	async close(): Promise<void> {}
	onEventFrame(cb: (frame: Record<string, unknown>) => void): () => void {
		this.#cb = cb;
		return () => {
			this.#cb = null;
		};
	}
	isLive(): boolean {
		return this.live;
	}
	lastFrameAt(): string | null {
		return this.#lastAt;
	}
	emit(frame: Record<string, unknown>): void {
		this.cursor += 1;
		this.#lastAt = new Date().toISOString();
		this.#cb?.(frame);
	}
}

const flush = (): Promise<void> => new Promise(r => setTimeout(r, 40));

let root: string;
const SID = "fr";
let owner: RuntimeOwner | null = null;

function seed(workspace: string): SessionState {
	const now = new Date().toISOString();
	return {
		schemaVersion: SESSION_SCHEMA_VERSION,
		sessionId: SID,
		lifecycle: "observing",
		harness: "gajae-code",
		handle: { sessionId: SID, harness: "gajae-code", workspace } as SessionHandle,
		retries: {},
		blockers: [],
		createdAt: now,
		updatedAt: now,
	};
}

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), "h"));
	await writeSessionState(root, seed(root));
	owner = null;
});

afterEach(async () => {
	await owner?.stop();
	await rm(root, { recursive: true, force: true });
});

function obsOf(res: any) {
	return res.evidence.observation as { observedSignals: string[]; rpcLive?: boolean; lifecycle: string };
}

describe("owner frame -> observability", () => {
	it("AC-1: a tool turn surfaces tool-call/test-running + completed; single-writer events; lifecycle finalizing", async () => {
		const rpc = new FrameRpc();
		owner = new RuntimeOwner({ root, sessionId: SID, rpc });
		const info = await owner.start();
		rpc.emit({ type: "agent_start" });
		rpc.emit({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", command: "bun test x" });
		rpc.emit({ type: "tool_execution_end", toolCallId: "t1", toolName: "bash", status: "ok" });
		rpc.emit({ type: "agent_end" });
		await flush();

		const events = await readEvents(root, SID, 0);
		const kinds = events.map(e => e.kind);
		expect(kinds).toContain("rpc_tool_started");
		expect(kinds).toContain("rpc_agent_completed");
		// single-writer: every event stamped with the owner's lease identity; cursors strictly increasing.
		expect(events.every(e => e.writer.ownerId === info.ownerId)).toBe(true);
		const cursors = events.map(e => e.cursor);
		expect(cursors).toEqual([...cursors].sort((a, b) => a - b));
		expect(new Set(cursors).size).toBe(cursors.length);

		const res = (await callEndpoint(info.socketPath, { verb: "observe", input: {} })) as Record<string, unknown>;
		const obs = obsOf(res);
		expect(obs.observedSignals).toContain("test-running");
		expect(obs.observedSignals).toContain("completed");
		expect(obs.rpcLive).toBe(true);
		expect(obs.lifecycle).toBe("finalizing");
	});

	it("AC-6: a message_update storm cannot starve agent_end (completed) or bloat the event log", async () => {
		const rpc = new FrameRpc();
		owner = new RuntimeOwner({ root, sessionId: SID, rpc });
		const info = await owner.start();
		rpc.emit({ type: "agent_start" });
		for (let i = 0; i < 500; i++) rpc.emit({ type: "message_update", messageId: "m1", delta: "noise" });
		rpc.emit({ type: "agent_end" });
		await flush();

		const events = await readEvents(root, SID, 0);
		expect(events.map(e => e.kind)).toContain("rpc_agent_completed");
		// 500 message_update frames are coalesced, not emitted 1:1.
		expect(events.length).toBeLessThan(60);
		const obs = obsOf(
			(await callEndpoint(info.socketPath, { verb: "observe", input: {} })) as Record<string, unknown>,
		);
		expect(obs.observedSignals).toContain("completed");
	});

	it("AC-7: transient tool-call/completed survive polling gaps (sticky from the event log)", async () => {
		const rpc = new FrameRpc();
		owner = new RuntimeOwner({ root, sessionId: SID, rpc });
		const info = await owner.start();
		// frames happen BETWEEN observe polls
		rpc.emit({ type: "tool_execution_start", toolCallId: "t1", toolName: "read" });
		rpc.emit({ type: "tool_execution_end", toolCallId: "t1", toolName: "read", status: "ok" });
		rpc.emit({ type: "agent_end" });
		await flush();
		// getState reports idle now, but the later observe still shows the transient signals.
		const obs = obsOf(
			(await callEndpoint(info.socketPath, { verb: "observe", input: {} })) as Record<string, unknown>,
		);
		expect(obs.observedSignals).toContain("tool-call");
		expect(obs.observedSignals).toContain("completed");
		expect(obs.observedSignals).toContain("idle"); // overlay present, did not evict semantic signals
	});

	it("rpcLive is distinct from ownerLive (RPC death does not imply dead owner)", async () => {
		const rpc = new FrameRpc();
		owner = new RuntimeOwner({ root, sessionId: SID, rpc });
		const info = await owner.start();
		rpc.live = false; // RPC subprocess died; owner endpoint still serving
		const res = (await callEndpoint(info.socketPath, { verb: "observe", input: {} })) as Record<string, unknown>;
		expect((res.state as Record<string, unknown>).ownerLive).toBe(true);
		expect(obsOf(res).rpcLive).toBe(false);
	});
});
